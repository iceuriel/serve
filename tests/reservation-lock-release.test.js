/* ============================================================
   THE RESERVATION LETS GO OF THE SCRIPT LOCK BEFORE IT TEXTS ANYBODY
   Added 2026-09-16 (webhook.gs r53)
   ============================================================

   THE LIVE BUG. A founder test booking showed the yellow "we couldn't confirm
   your booking" panel on a booking that had entirely succeeded — JOBS row
   written, customer text delivered, portal link delivered, everything logged.

   The Twilio call and the Gmail send ran INSIDE the script lock, and the
   response is only returned after both:

     1. Attempt 1 overran the Worker's 12s submit budget. The Worker answered
        its own 502; the browser saw a failure. Apps Script kept running and
        finished the booking.
     2. The browser retried 1.2s later and BLOCKED ON waitLock(), behind
        attempt 1's still-running execution. It could not answer sooner than
        attempt 1 finished, burned its own 12s, and got a second 502.

   So the retry — the documented fix for a slow upstream — was structurally
   unable to help, because on a reservation it queued behind the exact
   execution it was retrying.

   WHAT THIS FILE PINS. Not the timing, which no harness can reproduce: the
   ORDER. The lock must be released before the SMS and before the email, so a
   concurrent retry can reach the dedupe and answer `duplicate:true` while the
   first execution is still talking to Twilio and Gmail.

   AND IT PINS THE SAFETY CONDITION TOO — that nothing after the release writes
   to a sheet. That is the part a future edit is most likely to break: adding
   one appendRow below the release turns this fix into a race between two
   bookings, silently. Section 3 fails if a sheet write appears after the
   release line.
   ============================================================ */

const path = require('path');
const fs   = require('fs');
const vm   = require('vm');

const REPO_ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(REPO_ROOT, 'apps-script', 'webhook.gs'), 'utf8');

let bad = 0;
function t(label, ok, detail) {
  if (!ok) bad++;
  console.log((ok ? '  ok   ' : '  FAIL ') + label +
              (detail !== undefined ? '   ' + JSON.stringify(detail) : ''));
}

const JOBS_HEADERS = ['job_id','lead_id','source','property_key','service_type','frequency',
  'condition','beds','baths','quoted_price','add_ons','add_on_rev','final_price','scheduled_date',
  'completed_date','cleaner','start_time','duration_min','photos_passed','payment_status','job_status','notes',
  'submission_id','received_at','name','email','phone','segment','src_chain','customer_notes','pets_flag',
  'scheduling_type','quote_meta'];
/* The LIVE shape, copied from leads-upsert.test.js. `contact_id` is the load
   bearing one here: sendBookingSms returns early without it, and the whole
   ordering assertion below would then pass vacuously. */
const LEADS_HEADERS = ['lead_id','contact_id','name','email','phone','phone_e164','service_address',
  'unit','zip','source','source_detail','contacted_via','source_history','status','first_variant',
  'dnc_scrub','first_touch','last_touch','ltv','notes','segment'];

/* ------------------------------------------------------------
   A harness that records WHEN things happen, not just whether.
   ------------------------------------------------------------ */
function build() {
  const order = [];          // the sequence under test
  const logs  = [];

  function makeSheet(name, headers) {
    const rows = [headers.slice()];
    return { _name: name, _rows: rows,
      getName: () => name,
      getLastColumn: () => (rows[0] ? rows[0].length : 0),
      getLastRow: () => rows.length,
      appendRow: (r) => { order.push('sheet_write:' + name); rows.push(r.slice()); },
      setFrozenRows: () => {},
      getDataRange: () => ({ getValues: () => rows.map(r => r.slice()) }),
      getRange: (r, c, nr, nc) => ({
        getValues: () => { const o = []; for (let i = 0; i < nr; i++) { const row = rows[r-1+i] || []; o.push(row.slice(c-1, c-1+nc)); } return o; },
        getValue: () => { const row = rows[r-1] || []; return row[c-1] === undefined ? '' : row[c-1]; },
        setValue: (v) => { order.push('sheet_write:' + name); while (rows[r-1].length < c) rows[r-1].push(''); rows[r-1][c-1] = v; },
      }) };
  }

  const tabs = { JOBS: makeSheet('JOBS', JOBS_HEADERS), LEADS: makeSheet('LEADS', LEADS_HEADERS) };
  const ssObj = {
    getSheetByName: (n) => tabs[n] || null,
    insertSheet: (n) => (tabs[n] = makeSheet(n, [])),
    getSheets: () => Object.keys(tabs).map(k => tabs[k]),
    getId: () => 'leads-book',
  };

  const props = {
    TWILIO_ACCOUNT_SID: 'AC_test', TWILIO_AUTH_TOKEN: 'tok_test', TWILIO_FROM: '16175550000',
  };

  const sandbox = {
    console: { log: m => logs.push(String(m)),
               warn: m => logs.push('WARN ' + m),
               error: m => logs.push('ERR ' + m) },
    SpreadsheetApp: { openById: () => ssObj, getActiveSpreadsheet: () => ssObj },
    ContentService: { MimeType: { JSON: 'json' },
      createTextOutput: s => ({ getContent: () => s, setMimeType() { return this; } }) },
    MailApp: { sendEmail: () => { order.push('email'); } },
    /* THE INSTRUMENT. A real Apps Script lock cannot be modelled here — what
       matters is only that release is called, and when. */
    LockService: { getScriptLock: () => ({
      waitLock() { order.push('lock_acquired'); },
      releaseLock() { order.push('lock_released'); },
    }) },
    UrlFetchApp: { fetch: () => { order.push('sms'); return {
      getResponseCode: () => 201, getContentText: () => '{}' }; } },
    Session: { getScriptTimeZone: () => 'America/New_York',
               getEffectiveUser: () => ({ getEmail: () => 'ops@example.com' }) },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: k => (k in props ? props[k] : null),
      setProperty: (k, v) => { props[k] = String(v); },
      deleteProperty: (k) => { delete props[k]; },
      getProperties: () => Object.assign({}, props),
    }) },
    Utilities: {
      formatDate: (d, tz, fmt) => (fmt === 'yyyyMMdd'
        ? d.getFullYear() + String(d.getMonth()+1).padStart(2,'0') + String(d.getDate()).padStart(2,'0')
        : String(d)),
      getUuid: () => require('crypto').randomUUID(),
      base64Encode: (s) => Buffer.from(String(s)).toString('base64'),
      computeHmacSha256Signature: (value, key) =>
        [...require('crypto').createHmac('sha256', String(key)).update(String(value)).digest()]
          .map(b => (b > 127 ? b - 256 : b)),
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  return { order, logs, tabs, sandbox, props,
    post: p => JSON.parse(sandbox.doPost({ postData: { contents: JSON.stringify(p) } }).getContent()),
    get:  p => JSON.parse(sandbox.doGet({ parameter: p }).getContent()) };
}

const BOOKING = {
  event: 'quote_reserved', event_type: 'reservation',
  submitted_at: '2026-09-16T15:00:00.000Z', submission_id: 'lock-order-1',
  zip: '02134', zip_tier: 'core', bedrooms: 2, bathrooms: 1,
  service: 'first_clean', service_type: 'first_clean', condition: 'standard',
  frequency_selected: 'biweekly', quote_price: 183, first_visit_total: 183,
  name: 'Test Customer', email: 'test@example.com', phone: '(617) 555-0100',
  address: '123 Beacon St', unit: '4B', unit_label: '2 BR / 1 BA',
  /* Consent present and Twilio configured, so the SMS genuinely attempts —
     without both, sendBookingSms returns early and this file would pass while
     proving nothing about the order. */
  sms_transactional: 'yes',
  slot_date: '2026-10-02', slot_time: '9-11 AM',
};

/* ------------------------------------------------------------
   1. The booking still works.
   ------------------------------------------------------------ */
console.log('=== 1. the booking itself is unaffected ===');
const R = build();
const res = R.post(BOOKING);
t('the reservation is accepted', res.status === 'ok', res.status);
t('a JOBS row was written', R.tabs.JOBS._rows.length === 2, R.tabs.JOBS._rows.length);

/* ------------------------------------------------------------
   2. THE ORDER — the fix itself.
   ------------------------------------------------------------ */
console.log('\n=== 2. the lock is released before the slow external calls ===');

const iRelease = R.order.indexOf('lock_released');
const iSms     = R.order.indexOf('sms');
const iEmail   = R.order.indexOf('email');

t('the lock was acquired', R.order.indexOf('lock_acquired') === 0, R.order.slice(0, 3));
t('the lock was released', iRelease !== -1, R.order);
/* If either of these is -1 the comparisons below would pass vacuously — a
   sendBookingSms that returned "no consent" would make iSms -1, and -1 is
   less than everything. */
t('the SMS was actually attempted, so the next assertion is not vacuous',
  iSms !== -1, R.order);
t('the email was actually sent, same reason', iEmail !== -1, R.order);

t('THE LOCK IS RELEASED BEFORE THE TWILIO CALL', iRelease < iSms, R.order);
t('AND BEFORE THE GMAIL SEND', iRelease < iEmail, R.order);

/* The whole point: a retry arriving while Twilio is still in flight must be
   able to take the lock. Modelled by asserting the release precedes them. */
t('released exactly once, not twice — the finally must not double-release',
  R.order.filter(x => x === 'lock_released').length === 1,
  R.order.filter(x => x === 'lock_released').length);

/* ------------------------------------------------------------
   3. EVERY SHEET WRITE HAPPENED WHILE THE LOCK WAS HELD.
   This is the safety condition, and the thing most likely to be broken later.
   ------------------------------------------------------------ */
console.log('\n=== 3. nothing writes to a sheet after the release ===');

const writesAfter = R.order
  .map((x, i) => ({ x, i }))
  .filter(o => o.x.indexOf('sheet_write:') === 0 && o.i > iRelease);

t('at least one sheet write happened at all', R.order.some(x => x.indexOf('sheet_write:') === 0));
t('and every one of them was BEFORE the release — a write after it races '
  + 'another booking', writesAfter.length === 0, writesAfter);

/* ------------------------------------------------------------
   4. The retry still dedupes, which is what the customer actually sees.
   ------------------------------------------------------------ */
console.log('\n=== 4. the retry the fix exists to rescue ===');
const again = R.post(BOOKING);          // same submission_id
t('a replay answers ok', again.status === 'ok', again.status);
t('and says duplicate rather than booking twice', again.duplicate === true, again);
t('no second JOBS row', R.tabs.JOBS._rows.length === 2, R.tabs.JOBS._rows.length);
/* The browser treats {status:"ok"} as confirmed regardless of `duplicate`,
   which is what turns the rescued retry into a confirmation screen. */
const SCRIPT = fs.readFileSync(path.join(REPO_ROOT, 'script.js'), 'utf8');
t('and the browser counts that as confirmed',
  /body\.status\s*!==\s*'ok'/.test(SCRIPT) && /resolve\(\{\s*confirmed:\s*true/.test(SCRIPT));

/* ------------------------------------------------------------
   5. The release is positioned deliberately, not incidentally.
   ------------------------------------------------------------ */
console.log('\n=== 5. the source says why ===');
const at = SRC.indexOf('releaseWriteLock();');
t('releaseWriteLock exists', /function releaseWriteLock\(\)/.test(SRC));
t('it is idempotent, so the finally is safe',
  /if \(lockReleased\) return;/.test(SRC));
/* r55 moved the inline sends into deliverBookingNotify. Anchored on the CALL
   inside routePost, not the function name, which also appears in its own
   definition further down and would make this pass whatever the order. */
const inlineSend = SRC.indexOf('if (!notifyPending) deliverBookingNotify(notice);');
t('and the early release is called before the inline send in the source',
  at !== -1 && inlineSend !== -1 && at < inlineSend, [at, inlineSend]);

/* ------------------------------------------------------------
   6. r55 — DEFERRED: the booking answers before the text and email.
   ------------------------------------------------------------ */
console.log('\n=== 6. r55: the Worker asked to defer — answer first, send on the follow-up ===');
{
  const D = build();
  const ID = 'deferred-55';
  const booking = Object.assign({}, BOOKING, { submission_id: ID, notify_deferred: true });
  const r = D.post(booking);
  const KEY = 'notify:' + ID;

  t('the reservation is accepted', r.status === 'ok' && r.duplicate === false, r);
  t('and says a notice is pending', r.notify_pending === true, r);
  t('a JOBS row was written', D.tabs.JOBS._rows.length === 2);
  t('NO text was sent before answering', D.order.indexOf('sms') === -1, D.order);
  t('NO email was sent before answering', D.order.indexOf('email') === -1, D.order);
  t('the notice is parked under its submission_id', typeof D.props[KEY] === 'string');
  t('the delivery flag never reaches a row or the dropped-fields list',
    !(r.dropped_fields || []).includes('notify_deferred') &&
    !JSON.stringify(D.tabs.JOBS._rows).includes('notify_deferred'), r.dropped_fields);
  t('nor the parked notice', !String(D.props[KEY] || '').includes('notify_deferred'));
  t('no sheet write after the release on this path either',
    D.order.slice(D.order.indexOf('lock_released')).every(x => x.indexOf('sheet_write:') !== 0),
    D.order);

  /* The retry whose first attempt ran past the Worker's budget. */
  const replay = D.post(booking);
  t('a replay still dedupes', replay.duplicate === true, replay);
  t('and reports the notice still pending, so its Worker sends it',
    replay.notify_pending === true, replay);

  D.order.length = 0;
  const n1 = D.post({ event_type: 'booking_notify', submission_id: ID });
  t('the follow-up answers ok and sent 1', n1.ok === true && n1.sent === 1, n1);
  t('THE TEXT GOES OUT ON THE FOLLOW-UP', D.order.includes('sms'), D.order);
  t('AND THE EMAIL', D.order.includes('email'), D.order);
  t('claimed and released before sending, so a booking is never held up',
    D.order.indexOf('lock_released') !== -1 &&
    D.order.indexOf('lock_released') < D.order.indexOf('sms'), D.order);
  t('the parked notice is gone', !(KEY in D.props));
  t('the follow-up answer names nobody', !/Test|555|Beacon|example\.com|http/.test(JSON.stringify(n1)), n1);

  D.order.length = 0;
  const n2 = D.post({ event_type: 'booking_notify', submission_id: ID });
  t('a second follow-up sends NOTHING — at most once', n2.sent === 0 &&
    !D.order.includes('sms') && !D.order.includes('email'), { n2, order: D.order });
  t('and a replay now reports nothing pending', D.post(booking).notify_pending === false);

  const junk = D.post({ event_type: 'booking_notify', submission_id: '../../x' });
  t('an unusable submission_id is refused', junk.ok === false, junk);
}

console.log('\n=== 7. r55: the sweep sends only what is overdue, once ===');
{
  const S = build();
  S.post(Object.assign({}, BOOKING, { submission_id: 'young', notify_deferred: true }));
  S.post(Object.assign({}, BOOKING, { submission_id: 'old', notify_deferred: true,
    email: 'other@example.com', phone: '(617) 555-0199' }));
  const oldNotice = JSON.parse(S.props['notify:old']);
  oldNotice.queuedAt = Date.now() - 5 * 60 * 1000;
  S.props['notify:old'] = JSON.stringify(oldNotice);
  S.props.UNRELATED = 'keep me';

  S.order.length = 0;
  const sw = S.post({ event_type: 'booking_notify', action: 'sweep' });
  t('the sweep sent exactly the overdue one', sw.ok === true && sw.sent === 1, sw);
  t('it texted and emailed', S.order.includes('sms') && S.order.includes('email'), S.order);
  t('the overdue notice is gone', !('notify:old' in S.props));
  t('a fresh one is left for its own Worker', 'notify:young' in S.props);
  t('and other script properties are untouched', S.props.UNRELATED === 'keep me');

  S.order.length = 0;
  const again2 = S.post({ event_type: 'booking_notify', action: 'sweep' });
  t('sweeping again sends nothing', again2.sent === 0 && !S.order.includes('sms'), again2);
}

console.log('\n=== 8. r55: a notice too large to park is sent inline, as before ===');
{
  const L = build();
  const big = L.post(Object.assign({}, BOOKING, { submission_id: 'big', notify_deferred: true,
    customer_notes: 'x'.repeat(9000) }));
  t('it still books', big.status === 'ok', big);
  t('and reports nothing pending', big.notify_pending === false, big);
  t('because it already texted and emailed', L.order.includes('sms') && L.order.includes('email'), L.order);
  t('and parked nothing', !Object.keys(L.props).some(k => k.indexOf('notify:') === 0));
}

/* ------------------------------------------------------------
   9. r56 — THE CHEAP QUESTION THE BROWSER CAN ACTUALLY AFFORD TO ASK.
   ------------------------------------------------------------

   r53 and r55 both went after the WAIT. This goes after the SCREEN, and it is
   the one that closes the hole, because no latency budget is right every time.

   On 2026-09-17, with r53 live, a booking completed in full — row, text, email
   — and the customer was shown "your booking could not be confirmed". Both
   POSTs had run past the Worker's 12s budget, and a POST that does not come
   back says NOTHING about whether the booking happened. The browser had no
   other way to ask, so it guessed, and guessed wrong.

   WHAT THIS SECTION PINS: that the answer is right, that it costs no lock and
   no write (the two properties that let it be polled WHILE the slow write is
   still running), and that it agrees with the dedupe.
   ------------------------------------------------------------ */
console.log('\n=== 9. r56: "is this booking in the sheet yet?" ===');
{
  const Q = build();
  const ID = 'watch-56';

  const before = Q.get({ booking: ID });
  t('a booking that was never made answers found:false',
    before.ok === true && before.found === false, before);

  /* THE TWO PROPERTIES THAT MAKE IT POLLABLE. routePost waits up to 20s for
     the script lock before it routes anything, so a status check sent through
     doPost would queue behind the very booking it is asking about — exactly
     the trap this file's section 2 found in the retry. */
  t('it took no lock', !Q.order.includes('lock_acquired'), Q.order);
  t('and wrote nothing', !Q.order.some(x => x.indexOf('sheet_write:') === 0), Q.order);

  const booked = Q.post(Object.assign({}, BOOKING, { submission_id: ID, notify_deferred: true }));
  t('the booking itself still works', booked.status === 'ok', booked.status);

  Q.order.length = 0;
  const after = Q.get({ booking: ID });
  t('THE SAME QUESTION NOW ANSWERS found:true', after.ok === true && after.found === true, after);
  t('still no lock', !Q.order.includes('lock_acquired'), Q.order);
  t('still no write', !Q.order.some(x => x.indexOf('sheet_write:') === 0), Q.order);

  /* The property that stops the confirmation screen and the dedupe drifting
     apart. Both read alreadyWritten(), so "the screen says confirmed" and "a
     replay says duplicate" are the same fact — two opinions about whether a
     booking exists would be two different screens for one customer. */
  t('and agrees with what a replay would say',
    after.found === (Q.post(Object.assign({}, BOOKING, { submission_id: ID })).duplicate === true));

  /* r55's parked notice, reported so the polling Worker can send it — it may
     be the only caller that ever learns one is waiting, because the Worker
     that took the booking gave up before it was answered. */
  t('it reports r55\'s parked text and email as pending', after.notify_pending === true, after);
  Q.post({ event_type: 'booking_notify', submission_id: ID });
  t('and reports nothing pending once that notice is claimed',
    Q.get({ booking: ID }).notify_pending === false);

  /* Nothing about the customer crosses this boundary — not a name, number,
     address, price or job_id. A submission_id is a random id the browser
     minted for itself; the answer is one boolean about that id. */
  const answer = Q.get({ booking: ID });
  t('the answer is three booleans and nothing else',
    Object.keys(answer).sort().join() === 'found,notify_pending,ok', answer);
  t('and names nobody',
    !/Test|555|Beacon|example\.com|SRV-|02134/.test(JSON.stringify(answer)), answer);

  /* REFUSED, not merely "not found" — and the difference is the whole guard.
     Without the shape check a junk id falls through to a full column read and
     comes back a cheerful found:false, so the check reads as working while
     doing nothing. `ok:false` is the only answer that proves it fired. */
  /* An EMPTY ?booking= is deliberately not in this list: it is not a malformed
     status request, it is not a status request at all, and it falls through to
     the health stamp below. The Worker refuses an empty id before it ever
     relays one — see worker-proxy.test.js §4c. */
  for (const junk of ['../../x', 'has space', 'x'.repeat(101)]) {
    const r = Q.get({ booking: junk });
    t('an unusable id (' + JSON.stringify(junk.slice(0, 10)) + ') is REFUSED, never found',
      r.ok === false && r.found !== true, r);
  }

  /* An older deployment has no ?booking route. It must fall through to the
     health stamp — no `found`, nothing written — so a site pushed before the
     paste behaves exactly as it does today rather than creating rows. */
  const health = Q.get({});
  t('a GET with no booking is still the health stamp', health.service === 'serve-booking-webhook', health);
  t('and the stamp carries no `found` for a stale script to be mistaken for',
    !('found' in health), health);
}

console.log('\n' + (bad ? bad + ' FAILED' : 'all passed'));
process.exit(bad ? 1 : 0);
