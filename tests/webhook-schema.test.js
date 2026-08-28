/* SCHEMA.md reconciliation: underscore tab guard, LEADS service_address/unit/zip,
   received_at in America/New_York, start_time on non-slot bookings. */
/* Repo-relative so this runs from a clean clone on any machine. */
const REPO_ROOT = require('path').resolve(__dirname, '..');
const fs = require('fs');
const vm = require('vm');

const SRC = fs.readFileSync(require('path').join(REPO_ROOT, 'apps-script', 'webhook.gs'), 'utf8');

const JOBS_36 = ['job_id','lead_id','source','property_key','service_type','frequency',
  'condition','beds','baths','quoted_price','add_ons','add_on_rev','final_price','scheduled_date',
  'completed_date','cleaner','start_time','duration_min','photos_passed','payment_status','job_status','notes',
  'submission_id','received_at','name','email','phone','segment','src_chain','customer_notes','pets_flag',
  'scheduling_type','address','unit','zip','quote_meta'];

/* LEADS exactly as SCHEMA.md documents it, segment header included. */
const LEADS_LIVE = ['lead_id','contact_id','name','email','phone','phone_e164','service_address','unit','zip','source',
  'source_detail','contacted_via','source_history','status','first_variant','dnc_scrub',
  'first_touch','last_touch','ltv','notes','segment'];

let bad = 0;
const t = (label, cond, extra) => {
  console.log((cond ? '  ok    ' : '  FAIL  ') + label + (extra !== undefined ? '  ->  ' + JSON.stringify(extra) : ''));
  if (!cond) bad++;
};

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

function makeSheet(name, headers, audit) {
  const rows = headers === null ? [] : [headers.slice()];
  return { _name: name, _rows: rows,
    getName: () => name,
    getLastColumn: () => (rows[0] ? rows[0].length : 0),
    getLastRow: () => rows.length,
    appendRow: r => { audit.push({ tab: name, op: 'appendRow' }); rows.push(r.slice()); },
    setFrozenRows: () => {},
    getRange: (r, c, nr, nc) => ({
      getValues: () => { const o = []; for (let i = 0; i < nr; i++) { const row = rows[r-1+i] || []; o.push(row.slice(c-1, c-1+nc)); } return o; },
      setValue: v => { audit.push({ tab: name, op: 'setValue', r, c, v });
                       while (rows[r-1].length < c) rows[r-1].push(''); rows[r-1][c-1] = v; },
    }) };
}

/** Emulates Utilities.formatDate for the patterns this script uses. */
function formatDate(d, tz, fmt) {
  if (fmt === 'yyyyMMdd') {
    return d.getFullYear() + String(d.getMonth()+1).padStart(2,'0') + String(d.getDate()).padStart(2,'0');
  }
  if (fmt === "EEEE, MMM d") return DAYS[d.getDay()] + ', ' + MONTHS[d.getMonth()] + ' ' + d.getDate();
  if (fmt === "yyyy-MM-dd'T'HH:mm:ssXXX") {
    // Render in the requested zone. New York is UTC-4 in July (EDT).
    const offsetMin = (tz === 'America/New_York') ? -240 : 0;
    const shifted = new Date(d.getTime() + offsetMin * 60000);
    const p = n => String(n).padStart(2, '0');
    const sign = offsetMin <= 0 ? '-' : '+';
    const abs = Math.abs(offsetMin);
    return shifted.getUTCFullYear() + '-' + p(shifted.getUTCMonth()+1) + '-' + p(shifted.getUTCDate()) +
           'T' + p(shifted.getUTCHours()) + ':' + p(shifted.getUTCMinutes()) + ':' + p(shifted.getUTCSeconds()) +
           sign + p(Math.floor(abs/60)) + ':' + p(abs%60);
  }
  throw new Error('harness: unhandled formatDate pattern ' + JSON.stringify(fmt));
}

function build(tabNames) {
  const audit = [], mails = [], logs = [];
  const tabs = { JOBS: makeSheet('JOBS', JOBS_36, audit), LEADS: makeSheet('LEADS', LEADS_LIVE, audit) };
  (tabNames || []).forEach(n => { tabs[n] = makeSheet(n, ['a','b'], audit); });
  const ssObj = { getSheetByName: n => tabs[n] || null,
                  insertSheet: n => (tabs[n] = makeSheet(n, null, audit)),
                  getSheets: () => Object.values(tabs) };
  const sandbox = {
    console: { log: m => logs.push(String(m)), error: m => logs.push('ERR ' + m) },
    SpreadsheetApp: { openById: () => ssObj, getActiveSpreadsheet: () => ssObj },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: s => ({ getContent: () => s, setMimeType() { return this; } }) },
    MailApp: { sendEmail: (to, subject, body) => mails.push({ to, subject, body }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Session: { getScriptTimeZone: () => 'America/New_York', getEffectiveUser: () => ({ getEmail: () => 'ops@example.com' }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
    Utilities: { formatDate },
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  return { tabs, audit, mails, logs, sandbox,
    post: p => JSON.parse(sandbox.doPost({ postData: { contents: JSON.stringify(p) } }).getContent()) };
}

const BASE = {
  event: 'quote_reserved', event_type: 'reservation',
  timestamp: '2026-07-27T15:00:00.000Z', submitted_at: '2026-07-27T15:00:00.000Z',
  zip: '02134', zip_tier: 'core', bedrooms: 2, bathrooms: 1,
  service: 'first_clean', service_type: 'first_clean', condition: 'standard',
  addon_fridge: true, addon_oven: false, modifiers_applied: ['Inside the fridge'],
  addon_total: 45, frequency_selected: 'biweekly',
  quote_price: 214, first_visit_total: 214, original_price: 383,
  discount_applied: 'First clean 50% off', steady_state_price: 122,
  recurring_weekly: 111, recurring_biweekly: 122, recurring_monthly: 142,
  name: 'Test Customer', email: 'test.customer@example.com', phone: '(617) 555-0100',
  address: '123 Beacon St', unit: '4B', unit_label: '2 BR / 1 BA',
  src: 'dh-bh-01', src_first: 'dh-bh-01', src_chain: 'dh-bh-01',
  segment: 'movein', utm_source: 'poster', utm_medium: 'print', page_path: '/',
};

/* ============================================================
   1. Protected-tab guard survives underscores  (was a live bug)
   ============================================================ */
console.log('=== 1. protected-tab guard, underscore names ===');
const A = build(['PROPERTIES','RAW_INTAKE','OUTREACH_LOG','DASHBOARD']);
const aw = A.sandbox.assertWritable;

[['PROPERTIES',1],['RAW_INTAKE',1],['OUTREACH_LOG',1],['DASHBOARD',1],
 ['RAW INTAKE',1],['OUTREACH LOG',1],['raw_intake',1],['raw-intake',1],
 ['  Outreach_Log  ',1],['Properties',1]].forEach(([name]) => {
  let blocked = false;
  try { aw(name); } catch (e) { blocked = /Refusing to write/.test(e.message); }
  t('BLOCKS ' + JSON.stringify(name), blocked);
});
[['JOBS'],['LEADS'],['EVENTS']].forEach(([name]) => {
  let ok = true;
  try { aw(name); } catch (e) { ok = false; }
  t('ALLOWS ' + name, ok);
});
t('normalizeTabName collapses punctuation',
  A.sandbox.normalizeTabName('  raw - intake ') === 'RAW_INTAKE',
  A.sandbox.normalizeTabName('  raw - intake '));

/* Prove the old constant really was inert, so the fix is load-bearing. */
const oldStyle = ['PROPERTIES','RAW INTAKE','OUTREACH LOG','DASHBOARD'];
t('regression proof: the old space-separated list would NOT have matched RAW_INTAKE',
  oldStyle.indexOf('RAW_INTAKE'.toUpperCase()) === -1);

/* ============================================================
   2. LEADS gets service_address / unit / zip
   ============================================================ */
console.log('\n=== 2. LEADS upsert against the documented 19-column tab ===');
const B = build([]);
console.log('  ' + JSON.stringify(B.post(Object.assign({}, BASE, { submission_id: 'u-1' }))));
const L = B.tabs.LEADS, li = n => LEADS_LIVE.indexOf(n);
console.log('  LEADS row -> ' + JSON.stringify(L._rows[1]));

t('service_address populated from payload `address`', L._rows[1][li('service_address')] === '123 Beacon St', L._rows[1][li('service_address')]);
t('unit populated', L._rows[1][li('unit')] === '4B');
t('zip populated',  L._rows[1][li('zip')] === '02134');
t('lead_id normalized email', L._rows[1][li('lead_id')] === 'test.customer@example.com');
t('source = first touch', L._rows[1][li('source')] === 'dh-bh-01');
t('segment written now the header exists', L._rows[1][li('segment')] === 'movein');
t('source_history seeded', L._rows[1][li('source_history')] === 'dh-bh-01');
t('no LEADS column named plain "address" was invented', LEADS_LIVE.indexOf('address') === -1 && L._rows[0].length === LEADS_LIVE.length);

// first_touch / last_touch moved OPS -> WH: they are record-activity stamps now.
const OPERATOR_ONLY = ['source_detail','contacted_via','status','first_variant','dnc_scrub','ltv','notes'];
t('every operator-owned column left blank', OPERATOR_ONLY.every(c => L._rows[1][li(c)] === ''),
  OPERATOR_ONLY.filter(c => L._rows[1][li(c)] !== ''));
t('first_touch / last_touch stamped as Dates, not strings',
  ['first_touch','last_touch'].every(c =>
    Object.prototype.toString.call(L._rows[1][li(c)]) === '[object Date]'));
t('no columns appended to LEADS', L._rows.every(r => r.length <= LEADS_LIVE.length));
/* The consent columns (SCHEMA.md 20-22) are NOT on the live tab yet, so the
   upsert is expected to report and skip exactly those three and nothing else.
   Narrow the expected set the moment the operator adds the headers. */
const missingReport = B.logs.filter(l => /LEADS has no column for/.test(l)).join(' ');
t('the only columns reported missing are the three pending consent ones',
  !missingReport || /^LEADS has no column for: sms_transactional, sms_promotional, sms_consent_at — skipped\.$/.test(missingReport.trim()),
  missingReport);
t('nothing else reported missing', !B.logs.some(l => /LEADS has no column for/.test(l) && !/sms_/.test(l)),
  B.logs.filter(l => /LEADS has no column/.test(l)));

/* Repeat visit must not overwrite the address, and must append the tag. */
B.post(Object.assign({}, BASE, { submission_id: 'u-2', address: 'WRONG ADDRESS',
  src: 'ref-jordan', name: 'Different Name' }));
t('repeat booking did NOT overwrite service_address', L._rows[1][li('service_address')] === '123 Beacon St', L._rows[1][li('service_address')]);
t('repeat booking did NOT overwrite name', L._rows[1][li('name')] === 'Test Customer');
t('source_history appended', L._rows[1][li('source_history')] === 'dh-bh-01, ref-jordan', L._rows[1][li('source_history')]);
t('still one LEADS row', L._rows.length - 1 === 1);
t('two JOBS rows', B.tabs.JOBS._rows.length - 1 === 2);

/* ============================================================
   3. received_at in America/New_York
   ============================================================ */
console.log('\n=== 3. received_at timezone ===');
const C = build([]);
C.post(Object.assign({}, BASE, { submission_id: 'u-tz' }));
const rec = String(C.tabs.JOBS._rows[1][JOBS_36.indexOf('received_at')]);
console.log('  received_at -> ' + rec);
t('ISO 8601 with a numeric offset', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(rec), rec);
t('offset is Eastern, not UTC (Z / +00:00)', /-0[45]:00$/.test(rec), rec.slice(-6));

/* ============================================================
   4. start_time carries the preference label
   ============================================================ */
console.log('\n=== 4. start_time / scheduled_date per scheduling shape ===');
const D = build([]);
const st = n => D.tabs.JOBS._rows[n][JOBS_36.indexOf('start_time')];
const sd = n => D.tabs.JOBS._rows[n][JOBS_36.indexOf('scheduled_date')];
const nt = n => D.tabs.JOBS._rows[n][JOBS_36.indexOf('notes')];
const sc = n => D.tabs.JOBS._rows[n][JOBS_36.indexOf('scheduling_type')];

D.post(Object.assign({}, BASE, { submission_id: 's-slot', email: 'a@example.com',
  slot_date: '2026-08-14', slot_time: '9-11 AM' }));
D.post(Object.assign({}, BASE, { submission_id: 's-pref', email: 'b@example.com',
  time_preference: 'earlier', schedule_preference: 'earlier',
  schedule_preference_label: 'Earlier in the Day' }));
D.post(Object.assign({}, BASE, { submission_id: 's-label', email: 'c@example.com',
  schedule_preference_label: 'Sometime next week' }));
D.post(Object.assign({}, BASE, { submission_id: 's-none', email: 'd@example.com' }));

[1,2,3,4].forEach(r => console.log('  row' + r + ': type=' + sc(r) +
  ' | scheduled_date=' + JSON.stringify(sd(r)) + ' | start_time=' + JSON.stringify(st(r))));

t('slot: scheduled_date + window', sd(1) === '2026-08-14' && st(1) === '9-11 AM');
t('preference: date blank, start_time holds the LABEL', sd(2) === '' && /Earlier in the day/.test(String(st(2))), st(2));
t('label: start_time holds the label', sd(3) === '' && st(3) === 'Sometime next week', st(3));
t('none: start_time blank', sd(4) === '' && st(4) === '', st(4));
t('notes never empty on any shape', [1,2,3,4].every(r => String(nt(r)).trim() !== ''),
  [1,2,3,4].map(nt));
t('notes still schedule-summary only (no customer text)',
  [1,2,3,4].every(r => !/dog|driveway|Contact:/i.test(String(nt(r)))));

/* ============================================================
   The site and the webhook deploy SEPARATELY, so the site can always be
   running ahead of the script — a push reaches Cloudflare in minutes while the
   Apps Script deployment is a manual step someone has to remember.

   That makes one property load-bearing: a payload key the deployed webhook has
   never heard of must be ignored, not fatal. Verified against the real thing on
   2026-08-21 by running the pre-r8 script against an r8 payload — the booking
   landed intact and the three new fields were simply dropped. This pins the
   general rule so the next field added cannot break a live booking.
   ============================================================ */
console.log('\n=== 9. an unknown payload key never breaks a booking ===');
const FWD = build();
const withJunk = Object.assign({}, BASE, {
  submission_id: 'fwd-1', email: 'fwd@example.com',
  some_field_from_a_newer_site: 'hello',
  another_new_one: 42,
  nested_thing: { a: 1 },
});
let fwdThrew = null, fwdRes = null;
try { fwdRes = FWD.post(withJunk); } catch (e) { fwdThrew = e; }
t('a payload carrying unknown keys does not throw', !fwdThrew, fwdThrew && fwdThrew.message);
t('and still reports ok', fwdRes && fwdRes.status === 'ok', fwdRes && fwdRes.status);
t('the JOBS row is still written', FWD.tabs.JOBS._rows.length === 2);
const fwdRow = FWD.tabs.JOBS._rows[1] || [];
const fwdCol = n => fwdRow[JOBS_36.indexOf(n)];
t('known fields are unaffected by the unknown ones',
  fwdCol('beds') === 2 && fwdCol('quoted_price') === 214 && fwdCol('zip') === '02134',
  [fwdCol('beds'), fwdCol('quoted_price'), fwdCol('zip')]);
t('no unknown key leaked into quote_meta',
  !/some_field_from_a_newer_site|another_new_one|nested_thing/.test(String(fwdCol('quote_meta'))));
/* Half-baths reach the sheet as a decimal — the `baths` column has always been
   numeric, but nothing had ever sent it a fraction before 2026-08-21. */
const HALF = build();
HALF.post(Object.assign({}, BASE, { submission_id: 'half-1', email: 'h@example.com', bathrooms: 2.5 }));
t('a half-bath rides through to the sheet as 2.5, not truncated',
  HALF.tabs.JOBS._rows[1][JOBS_36.indexOf('baths')] === 2.5,
  HALF.tabs.JOBS._rows[1][JOBS_36.indexOf('baths')]);

console.log('\n' + (bad ? 'FAILURES: ' + bad : 'ALL ASSERTIONS PASSED'));
process.exit(bad ? 1 : 0);
