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
  return { order, logs, tabs, sandbox,
    post: p => JSON.parse(sandbox.doPost({ postData: { contents: JSON.stringify(p) } }).getContent()) };
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
t('and the early release is called before sendBookingSms in the source',
  at !== -1 && at < SRC.indexOf('sendBookingSms(data'), [at, SRC.indexOf('sendBookingSms(data')]);

console.log('\n' + (bad ? bad + ' FAILED' : 'all passed'));
process.exit(bad ? 1 : 0);
