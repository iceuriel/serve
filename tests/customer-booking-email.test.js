/**
 * THE CUSTOMER'S OWN CONFIRMATION EMAIL  —  webhook.gs r58
 *
 * Before r58 Serve sent the customer nothing by email. Every MailApp.sendEmail
 * in the script went to the operator, and the only automatic thing a customer
 * ever received was the r26 text — which is gated on `sms_transactional`, a box
 * that may not be pre-ticked and mostly is not. The default outcome of a real
 * booking was silence, and the portal link never arrived.
 *
 * Two promises on the site now depend on this send:
 *   · the confirmation screen — "a confirmation email within 15 minutes",
 *     carrying a link to their booking page
 *   · the consent block — "your booking page link is emailed to you either way"
 * Both are false if this stops going out, and both are read by a customer who
 * has already paid, so the failure is silent and expensive.
 *
 * THE ONE THAT MATTERS MOST is section 2: no consent, still emailed. That is
 * the entire reason this exists, and it is the assertion to check first if this
 * file ever goes red.
 */
const REPO_ROOT = require('path').resolve(__dirname, '..');
const fs = require('fs');
const vm = require('vm');

const SRC = fs.readFileSync(require('path').join(REPO_ROOT, 'apps-script', 'webhook.gs'), 'utf8');

const JOBS_HEADERS = ['job_id','lead_id','source','property_key','service_type','frequency',
  'condition','beds','baths','quoted_price','add_ons','add_on_rev','final_price','scheduled_date',
  'completed_date','cleaner','start_time','duration_min','photos_passed','payment_status','job_status','notes',
  'submission_id','received_at','name','email','phone','segment','src_chain','customer_notes','pets_flag','scheduling_type'];

/* contact_id is what mints the portal link. A LEADS tab without it is the
   degraded case section 6 covers. */
const LEADS_LIVE = ['lead_id','contact_id','name','email','phone','phone_e164','service_address','unit','zip','source',
  'source_detail','contacted_via','source_history','status','first_variant','dnc_scrub',
  'first_touch','last_touch','ltv','notes','segment'];

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

function makeSheet(name, headers) {
  const rows = headers === null ? [] : [headers.slice()];
  return { _name: name, _rows: rows,
    getName: () => name,
    getLastColumn: () => (rows[0] ? rows[0].length : 0),
    getLastRow: () => rows.length,
    appendRow: (r) => rows.push(r.slice()),
    setFrozenRows: () => {},
    getDataRange: () => ({ getValues: () => rows.map(r => r.slice()) }),
    getRange: (r, c, nr, nc) => ({
      getValues: () => { const o = []; for (let i = 0; i < nr; i++) { const row = rows[r-1+i] || []; o.push(row.slice(c-1, c-1+nc)); } return o; },
      getValue: () => { const row = rows[r-1] || []; return row[c-1] === undefined ? '' : row[c-1]; },
      setValue: (v) => { while (rows[r-1].length < c) rows[r-1].push(''); rows[r-1][c-1] = v; },
    }) };
}

function formatDate(d, tz, fmt) {
  if (fmt === 'yyyyMMdd') {
    return d.getFullYear() + String(d.getMonth()+1).padStart(2,'0') + String(d.getDate()).padStart(2,'0');
  }
  if (fmt === 'EEEE, MMM d') return DAYS[d.getDay()] + ', ' + MONTHS[d.getMonth()] + ' ' + d.getDate();
  if (fmt === "yyyy-MM-dd'T'HH:mm:ssXXX") {
    const offsetMin = (tz === 'America/New_York') ? -240 : 0;
    const s = new Date(d.getTime() + offsetMin * 60000);
    const p = n => String(n).padStart(2, '0');
    const abs = Math.abs(offsetMin);
    return s.getUTCFullYear() + '-' + p(s.getUTCMonth()+1) + '-' + p(s.getUTCDate()) + 'T' +
           p(s.getUTCHours()) + ':' + p(s.getUTCMinutes()) + ':' + p(s.getUTCSeconds()) +
           (offsetMin <= 0 ? '-' : '+') + p(Math.floor(abs/60)) + ':' + p(abs%60);
  }
  throw new Error('harness: unhandled formatDate pattern ' + JSON.stringify(fmt));
}

/**
 * opts.leadsHeaders  — swap the LEADS shape (drop contact_id, etc.)
 * opts.failMailTo    — a recipient whose send throws, to prove the booking and
 *                      the operator's copy survive it.
 */
function build(opts) {
  opts = opts || {};
  const tabs = {
    JOBS:  makeSheet('JOBS', JOBS_HEADERS),
    LEADS: makeSheet('LEADS', opts.leadsHeaders || LEADS_LIVE),
    PROPERTIES: makeSheet('PROPERTIES', ['property_key','beds']),
  };
  const mails = [], logs = [], fetches = [];
  const ssObj = {
    getSheetByName: (n) => tabs[n] || null,
    insertSheet: (n) => (tabs[n] = makeSheet(n, null)),
    getSheets: () => Object.values(tabs),
    getSpreadsheetTimeZone: () => 'America/New_York',
    getId: () => 'leads-book',
    getName: () => 'Leads MASTER',
  };
  const sandbox = {
    console: { log: m => logs.push(String(m)), warn: m => logs.push('WARN ' + m), error: m => logs.push('ERR ' + m) },
    SpreadsheetApp: { openById: () => ssObj, getActiveSpreadsheet: () => ssObj, flush: () => {} },
    ContentService: { MimeType: { JSON: 'json' },
      createTextOutput: s => ({ getContent: () => s, setMimeType() { return this; } }) },
    MailApp: { sendEmail: (to, subject, body, options) => {
      if (opts.failMailTo && to === opts.failMailTo) throw new Error('mail quota exceeded for ' + to);
      mails.push({ to, subject, body, options });
    } },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Session: { getScriptTimeZone: () => 'America/New_York', getEffectiveUser: () => ({ getEmail: () => 'ops@example.com' }) },
    PropertiesService: (() => {
      const store = {};
      return { getScriptProperties: () => ({
        getProperty: k => (k in store ? store[k] : null),
        setProperty: (k, v) => { store[k] = String(v); },
        deleteProperty: k => { delete store[k]; },
        getProperties: () => Object.assign({}, store),
        getKeys: () => Object.keys(store),
      }) };
    })(),
    /* Twilio is never configured here, so the SMS path always short-circuits.
       That is deliberate: this file is about the email that goes out when the
       text does not. */
    UrlFetchApp: { fetch: (url, o) => { fetches.push({ url, opts: o });
      return { getResponseCode: () => 201, getContentText: () => '{"sid":"SM1"}' }; } },
    Utilities: {
      formatDate,
      getUuid: () => require('crypto').randomUUID(),
      base64Encode: (s) => Buffer.from(String(s), 'utf8').toString('base64'),
      computeHmacSha256Signature: (value, key) =>
        [...require('crypto').createHmac('sha256', String(key))
          .update(String(value)).digest()]
          .map(b => (b > 127 ? b - 256 : b)),
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  return { tabs, mails, logs, fetches, sandbox,
    /* Picked by recipient, never by position — the lesson r58 taught the other
       two webhook suites when it shifted every index they relied on. */
    toCustomer: () => mails.filter(m => m.to !== 'ops@example.com'),
    toOps:      () => mails.filter(m => m.to === 'ops@example.com'),
    post: p => JSON.parse(sandbox.doPost({ postData: { contents: JSON.stringify(p) } }).getContent()) };
}

let bad = 0;
const t = (label, cond, extra) => {
  console.log((cond ? '  ok    ' : '  FAIL  ') + label + (extra !== undefined ? '  ->  ' + JSON.stringify(extra) : ''));
  if (!cond) bad++;
};

const BASE = {
  event: 'quote_reserved', event_type: 'reservation',
  timestamp: '2026-07-26T15:00:00.000Z', submitted_at: '2026-07-26T15:00:00.000Z',
  zip: '02134', zip_tier: 'core', bedrooms: 2, bathrooms: 1, levels: 1,
  service: 'first_clean', service_type: 'first_clean', condition: 'standard',
  quote_price: 214, first_visit_total: 214, frequency_selected: 'biweekly',
  steady_state_price: 122,
  /* Mixed case and trailing spaces on purpose: a real form sends exactly this,
     and an untrimmed recipient is a bounced confirmation. */
  name: 'Test Customer', email: 'Test.Customer@Example.com  ', phone: '(617) 555-0100',
  address: '123 Beacon St', unit: '4B', unit_label: '2 BR / 1 BA',
  slot_date: '2026-08-14', slot_time: '9:00 AM',
  segment: 'qr_code',
};
const booking = extra => Object.assign({}, BASE, extra);

/* ============================================================ */
console.log('=== 1. every booking emails the customer ===');
const A = build();
A.post(booking({ submission_id: 'cust-1' }));

t('exactly one email to the customer', A.toCustomer().length === 1, A.toCustomer().length);
t('the operator still gets their own copy', A.toOps().length === 1, A.toOps().length);
t('addressed to the customer, trimmed', A.toCustomer()[0] && A.toCustomer()[0].to === 'Test.Customer@Example.com',
  A.toCustomer()[0] && A.toCustomer()[0].to);
t('not addressed to the operator', A.toCustomer()[0].to !== 'ops@example.com');
t('sent under the Serve name', (A.toCustomer()[0].options || {}).name === 'Serve');
t('replies reach a monitored address',
  (A.toCustomer()[0].options || {}).replyTo === 'management@servecos.com');

const body = A.toCustomer()[0].body;
const subject = A.toCustomer()[0].subject;
console.log('\n  --- the email as sent ---\n' + body.split('\n').map(l => '  | ' + l).join('\n') + '\n');

t('subject says the booking is made', /booked/i.test(subject), subject);
t('subject carries the date for a slot booking', /Aug 14/.test(subject), subject);
t('greets them by first name only', /^Hi Test,/.test(body));
t('confirms they are on the schedule', /on the schedule/i.test(body));
t('states when the clean is', /Friday, Aug 14 at 9:00 AM/.test(body));
t('states the price they were quoted', /\$214/.test(body));

console.log('\n=== 2. THE POINT: no SMS consent, and they are still emailed ===');
/* If this ever fails, somebody has gated the email the way sendBookingSms is
   gated. That is the exact hole r58 closed: consent governs TEXTS. */
const N = build();
N.post(booking({ submission_id: 'cust-noconsent' }));   // no sms_transactional at all
t('an unticked consent box does not suppress the email', N.toCustomer().length === 1);
t('and the link is still in it', /\/h\?id=/.test(N.toCustomer()[0].body));

const Y = build();
Y.post(booking({ submission_id: 'cust-consent', sms_transactional: 'yes' }));
t('ticking it does not produce a second email', Y.toCustomer().length === 1, Y.toCustomer().length);

console.log('\n=== 3. the portal link, and what it is for ===');
t('carries the portal link', /https:\/\/servecleaning\.com\/h\?id=[^&\s]+&t=[a-f0-9]{20}/.test(body),
  (body.match(/https:\/\/servecleaning\.com\/h[^\s]*/) || [])[0]);
t('explains what the link opens', /booking page/i.test(body));
t('says the link is permanent', /stays the same/i.test(body));
t('says they can change or cancel there', /change or cancel/i.test(body));

/* THE THREE SURFACES ARE NOT INTERCHANGEABLE. A customer must never be handed
   the cleaner's ticket or a vendor's portal — each opens a view of somebody
   else's business, and /j carries the payout. */
t('no cleaner ticket link', !/\/j\?/.test(body));
t('no vendor portal link',  !/\/v\?/.test(body));

console.log('\n=== 4. sent once per booking, never twice ===');
/* A replay is the customer pressing Reserve again, or the Worker retrying a
   request that overran its budget. Either must not re-send. */
const D = build();
D.post(booking({ submission_id: 'cust-dupe' }));
const dupe = D.post(booking({ submission_id: 'cust-dupe' }));
t('the replay is reported as a duplicate', dupe.duplicate === true, dupe.duplicate);
t('and sends no second email', D.toCustomer().length === 1, D.toCustomer().length);

console.log('\n=== 5. it can never cost a booking ===');
/* MailApp throws for real — a daily quota is 100 messages on a consumer
   account, and hitting it must not turn a written booking into an error. */
const F = build({ failMailTo: 'Test.Customer@Example.com' });
const rf = F.post(booking({ submission_id: 'cust-mailfail' }));
t('the booking still succeeds', rf.status === 'ok', rf.status);
t('the JOBS row is still written', F.tabs.JOBS._rows.length - 1 === 1);
t('no customer email went out', F.toCustomer().length === 0);
t('and the OPERATOR still hears about the booking', F.toOps().length === 1, F.toOps().length);

console.log('\n=== 6. degraded inputs are handled, not crashed on ===');
const NOEMAIL = build();
const rn = NOEMAIL.post(booking({ submission_id: 'cust-noemail', email: '' }));
t('a booking with no email address still succeeds', rn.status === 'ok', rn.status);
t('and nothing is sent to nobody', NOEMAIL.toCustomer().length === 0);

const JUNK = build();
JUNK.post(booking({ submission_id: 'cust-junk', email: 'not an address' }));
t('an address with no @ is refused rather than sent', JUNK.toCustomer().length === 0);

/* No contact_id column means the portal does not exist yet. The confirmation
   must still go — the booking is what they are waiting to hear about. */
const NOPORTAL = build({ leadsHeaders: LEADS_LIVE.filter(h => h !== 'contact_id') });
NOPORTAL.post(booking({ submission_id: 'cust-noportal' }));
t('still emailed when there is no portal to link to', NOPORTAL.toCustomer().length === 1);
t('and it promises a follow-up instead of printing a broken link',
  NOPORTAL.toCustomer().length === 1 && !/\/h\?id=/.test(NOPORTAL.toCustomer()[0].body) &&
  /follow up/i.test(NOPORTAL.toCustomer()[0].body));

console.log('\n=== 6b. a preference booking is not described as a confirmed time ===');
/* Nothing is on the calendar for these. Wording them like a slot booking would
   confirm an appointment that does not exist, which is the failure this whole
   system treats as the worst one available. */
const PREF = build();
const pref = booking({ submission_id: 'cust-pref', time_preference: 'earlier' });
delete pref.slot_date; delete pref.slot_time;
PREF.post(pref);
const pbody = PREF.toCustomer()[0].body;
t('still emailed', PREF.toCustomer().length === 1);
t('does not print a date it does not have', !/Aug 14|at 9:00 AM/.test(pbody));
t('frames it as what they asked for', /WHEN YOU ASKED FOR/.test(pbody));
t('and says the real time is still to come', /confirm the exact day/i.test(pbody));
t('subject makes no date claim either', !/—\s*\w+day/.test(PREF.toCustomer()[0].subject),
  PREF.toCustomer()[0].subject);
t('the portal link is still there', /\/h\?id=/.test(pbody));

console.log('\n=== 7. nothing personal reaches the log ===');
/* The project rule, and the reason the SMS logs a job id and an outcome. A log
   line is read by anyone with the Executions view. */
const allLogs = A.logs.join('\n');
t('the log names the job and the outcome', /customer booking email SRV-[^:]+: sent/.test(allLogs),
  (allLogs.match(/customer booking email[^\n]*/) || [])[0]);
t('no email address in the log', !/Test\.Customer@Example\.com/i.test(allLogs));
t('no street address in the log', !/123 Beacon/.test(allLogs));
t('no signed portal link in the log', !/\/h\?id=/.test(allLogs));

/* A send that throws must not spill the recipient either — the exception text
   quotes it, which is why the catch logs err.name and not err. */
const failLogs = F.logs.join('\n');
t('a failed send logs the failure', /customer booking email[^\n]*failed/i.test(failLogs),
  (failLogs.match(/ERR[^\n]*customer[^\n]*/) || [])[0]);
t('and still no address in the log', !/Test\.Customer@Example\.com/i.test(failLogs));

console.log('\n' + (bad ? bad + ' check(s) FAILED' : 'customer-booking-email: all checks passed'));
process.exit(bad ? 1 : 0);
