/* Part 7 harness: 32-column JOBS, LEADS upsert, EVENTS routing, protected tabs. */
/* Repo-relative so this runs from a clean clone on any machine. */
const REPO_ROOT = require('path').resolve(__dirname, '..');
const fs = require('fs');
const vm = require('vm');

const SRC = fs.readFileSync(require('path').join(REPO_ROOT, 'apps-script', 'webhook.gs'), 'utf8');

const JOBS_HEADERS = ['job_id','lead_id','source','property_key','service_type','frequency',
  'condition','beds','baths','quoted_price','add_ons','add_on_rev','final_price','scheduled_date',
  'completed_date','cleaner','start_time','duration_min','photos_passed','payment_status','job_status','notes',
  'submission_id','received_at','name','email','phone','segment','src_chain','customer_notes','pets_flag','scheduling_type'];

// SIMULATED — the real LEADS schema is unknown to me; reportLeadsSchema() prints the truth.
const LEADS_FULL    = ['lead_id','name','email','phone','source','segment','source_history','created_at'];
const LEADS_PARTIAL = ['name','email','phone','source','source_history'];   // no lead_id, no segment

function makeSheet(name, headers) {
  // insertSheet() in Apps Script yields a truly empty sheet: no rows at all, so
  // the first appendRow lands on row 1. Pass null to model that.
  const rows = headers === null ? [] : [headers.slice()];
  return { _name: name, _rows: rows,
    getName: () => name,
    getLastColumn: () => (rows[0] ? rows[0].length : 0),
    getLastRow: () => rows.length,
    appendRow: (r) => rows.push(r.slice()),
    setFrozenRows: () => {},
    getRange: (r, c, nr, nc) => ({
      getValues: () => { const o = []; for (let i = 0; i < nr; i++) { const row = rows[r-1+i] || []; o.push(row.slice(c-1, c-1+nc)); } return o; },
      setValue: (v) => { while (rows[r-1].length < c) rows[r-1].push(''); rows[r-1][c-1] = v; },
    }) };
}

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

/** Strict Utilities.formatDate stand-in — throws rather than silently
    returning the wrong shape when the script starts using a new pattern. */
function formatDate(d, tz, fmt) {
  if (fmt === 'yyyyMMdd') {
    return d.getFullYear() + String(d.getMonth()+1).padStart(2,'0') + String(d.getDate()).padStart(2,'0');
  }
  if (fmt === 'EEEE, MMM d') return DAYS[d.getDay()] + ', ' + MONTHS[d.getMonth()] + ' ' + d.getDate();
  if (fmt === "yyyy-MM-dd'T'HH:mm:ssXXX") {
    const offsetMin = (tz === 'America/New_York') ? -240 : 0;   // EDT in July
    const s = new Date(d.getTime() + offsetMin * 60000);
    const p = n => String(n).padStart(2, '0');
    const abs = Math.abs(offsetMin);
    return s.getUTCFullYear() + '-' + p(s.getUTCMonth()+1) + '-' + p(s.getUTCDate()) + 'T' +
           p(s.getUTCHours()) + ':' + p(s.getUTCMinutes()) + ':' + p(s.getUTCSeconds()) +
           (offsetMin <= 0 ? '-' : '+') + p(Math.floor(abs/60)) + ':' + p(abs%60);
  }
  throw new Error('harness: unhandled formatDate pattern ' + JSON.stringify(fmt));
}

function build(leadsHeaders) {
  const tabs = {
    JOBS:  makeSheet('JOBS', JOBS_HEADERS),
    LEADS: makeSheet('LEADS', leadsHeaders),
    PROPERTIES:    makeSheet('PROPERTIES', ['property_key','beds']),
    'RAW INTAKE':  makeSheet('RAW INTAKE', ['deed_id','owner']),
    'OUTREACH LOG':makeSheet('OUTREACH LOG', ['when','who']),
    DASHBOARD:     makeSheet('DASHBOARD', ['metric','value']),
  };
  const mails = [], logs = [];
  const ssObj = {
    getSheetByName: (n) => tabs[n] || null,
    insertSheet: (n) => (tabs[n] = makeSheet(n, null)),
    getSheets: () => Object.values(tabs),
  };
  const sandbox = {
    console: { log: m => logs.push(String(m)), error: m => logs.push('ERR ' + m) },
    SpreadsheetApp: { openById: () => ssObj, getActiveSpreadsheet: () => ssObj },
    ContentService: { MimeType: { JSON: 'json' },
      createTextOutput: s => ({ getContent: () => s, setMimeType() { return this; } }) },
    MailApp: { sendEmail: (to, subject, body) => mails.push({ to, subject, body }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Session: { getScriptTimeZone: () => 'America/New_York', getEffectiveUser: () => ({ getEmail: () => 'ops@example.com' }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
    Utilities: { formatDate },
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  return { tabs, mails, logs, sandbox,
    post: p => JSON.parse(sandbox.doPost({ postData: { contents: JSON.stringify(p) } }).getContent()) };
}

let bad = 0;
const t = (label, cond, extra) => { console.log((cond ? '  ok    ' : '  FAIL  ') + label + (extra !== undefined ? '  ->  ' + JSON.stringify(extra) : '')); if (!cond) bad++; };

const BASE = {
  event: 'quote_reserved', event_type: 'reservation',
  timestamp: '2026-07-26T15:00:00.000Z', submitted_at: '2026-07-26T15:00:00.000Z',
  zip: '02134', zip_tier: 'core', bedrooms: 2, bathrooms: 1,
  service: 'first_clean', service_type: 'first_clean', condition: 'standard',
  addon_fridge: true, addon_oven: false, modifiers_applied: ['Inside the fridge'],
  addon_total: 45, frequency_selected: 'biweekly',
  quote_price: 214, first_visit_total: 214, original_price: 383,
  discount_applied: 'First clean 50% off', steady_state_price: 122,
  recurring_weekly: 111, recurring_biweekly: 122, recurring_monthly: 142,
  name: 'Test Customer', email: 'Test.Customer@Example.com  ', phone: '(617) 555-0100',
  address: '123 Beacon St', unit: '4B', unit_label: '2 BR / 1 BA',
  src: 'qr-allston-01', src_first: 'qr-allston-01', src_chain: 'qr-allston-01',
  segment: 'qr_code', utm_source: 'poster', utm_medium: 'print', page_path: '/',
};

/* ============ SCENARIO 1: full LEADS schema ============ */
console.log('=== SCENARIO 1 — LEADS has all 7 canonical fields ===');
const S = build(LEADS_FULL);

const slot = Object.assign({}, BASE, { submission_id: 'uuid-slot-1',
  slot_date: '2026-08-14', slot_time: '9-11 AM',
  schedule_preference_label: 'Friday, Aug 14 at 9-11 AM',
  customer_notes: 'We have a friendly dog, keep the back door shut.', pets_flag: true });

const pref = Object.assign({}, BASE, { submission_id: 'uuid-pref-2',
  email: 'someone.else@example.com', name: 'Other Person',
  schedule_preference: 'earlier', time_preference: 'earlier',
  schedule_preference_label: 'Earlier in the Day',
  customer_notes: 'No pets. New carpet in the den.', pets_flag: false });

const repeat = Object.assign({}, BASE, { submission_id: 'uuid-repeat-3',
  email: 'TEST.CUSTOMER@example.com', phone: '', name: 'Test C.',
  src: 'ig-story-07', src_chain: 'qr-allston-01>ig-story-07',
  slot_date: '2026-09-02', slot_time: '1-3 PM', customer_notes: 'Same dog.' });

const moveOut = Object.assign({}, BASE, { submission_id: 'uuid-moveout-4',
  email: 'moveout@example.com', service: 'move_out', service_type: 'move_out',
  modifiers_applied: [], addon_total: 0, addon_fridge: false, addon_oven: false,
  quote_price: 536, first_visit_total: 536, slot_date: '2026-09-10', slot_time: '8-10 AM' });

[slot, pref, repeat, moveOut].forEach(p => console.log('  ' + p.submission_id + ' -> ' + JSON.stringify(S.post(p))));
console.log('  REPLAY -> ' + JSON.stringify(S.post(slot)));
console.log('  EVENT  -> ' + JSON.stringify(S.post({ event_type: 'quote_emailed', event: 'quote_emailed',
  submission_id: 'uuid-evt-5', email: 'lurker@example.com', zip: '02139', bedrooms: 1, bathrooms: 1,
  service: 'first_clean', quote_price: 180, src: 'ig-story-07', segment: 'social' })));

const J = S.tabs.JOBS, L = S.tabs.LEADS;
const jh = h => JOBS_HEADERS.indexOf(h);
const lh = h => LEADS_FULL.indexOf(h);

console.log('\n--- JOBS ---');
t('4 job rows (replay added none)', J._rows.length - 1 === 4, J._rows.length - 1);
t('still 32 columns', J._rows[0].length === 32, J._rows[0].length);
t('header row byte-identical', J._rows[0].join('|') === JOBS_HEADERS.join('|'));
t('submission_id has its own column', J._rows[1][jh('submission_id')] === 'uuid-slot-1');
t('lead_id is the normalized email, NOT the uuid', J._rows[1][jh('lead_id')] === 'test.customer@example.com', J._rows[1][jh('lead_id')]);
t('repeat booking reuses the same lead_id', J._rows[3][jh('lead_id')] === J._rows[1][jh('lead_id')]);
t('repeat booking has a DISTINCT submission_id', J._rows[3][jh('submission_id')] !== J._rows[1][jh('submission_id')]);
t('repeat booking has a distinct job_id', J._rows[3][jh('job_id')] !== J._rows[1][jh('job_id')]);
t('notes = schedule summary only', J._rows[1][jh('notes')] === 'Friday, Aug 14 at 9-11 AM');
t('notes never empty on preference row', /Earlier in the day/.test(J._rows[2][jh('notes')]), J._rows[2][jh('notes')]);
t('customer_notes holds free text only', J._rows[1][jh('customer_notes')] === 'We have a friendly dog, keep the back door shut.');
t('customer_notes not mixed into notes', !/dog/i.test(String(J._rows[1][jh('notes')])));
t('scheduling_type slot', J._rows[1][jh('scheduling_type')] === 'slot');
t('scheduling_type preference', J._rows[2][jh('scheduling_type')] === 'preference');
t('name/email/phone in their own columns',
  J._rows[1][jh('name')] === 'Test Customer' && J._rows[1][jh('phone')] === '(617) 555-0100');
t('segment column populated', J._rows[1][jh('segment')] === 'qr_code');
t('src_chain column populated', J._rows[3][jh('src_chain')] === 'qr-allston-01>ig-story-07');
t('pets_flag TRUE on dog row', J._rows[1][jh('pets_flag')] === 'TRUE');
t('pets_flag FALSE on "new carpet" row', J._rows[2][jh('pets_flag')] === 'FALSE');
t('received_at populated', /^\d{4}-\d{2}-\d{2}T/.test(String(J._rows[1][jh('received_at')])));
t('move-out add_on_rev is 0, not 85', J._rows[4][jh('add_on_rev')] === 0, J._rows[4][jh('add_on_rev')]);
t('move-out add_ons blank', J._rows[4][jh('add_ons')] === '');
t('ops columns blank on every row', J._rows.slice(1).every(r =>
  ['completed_date','cleaner','duration_min','photos_passed','payment_status'].every(h => r[jh(h)] === '')));
t('job_status = new', J._rows[1][jh('job_status')] === 'new');

console.log('\n--- LEADS ---');
L._rows.forEach((r, i) => console.log('  ' + (i === 0 ? 'HDR ' : 'row' + i + ' ') + JSON.stringify(r)));
t('3 lead rows for 4 bookings (repeat matched)', L._rows.length - 1 === 3, L._rows.length - 1);
t('source_history appended, not replaced',
  L._rows[1][lh('source_history')] === 'qr-allston-01, ig-story-07', L._rows[1][lh('source_history')]);
t('existing non-empty name NOT overwritten', L._rows[1][lh('name')] === 'Test Customer');
t('existing non-empty phone NOT overwritten', L._rows[1][lh('phone')] === '(617) 555-0100');
t('email stored normalized', L._rows[1][lh('email')] === 'test.customer@example.com');
t('source = first touch', L._rows[1][lh('source')] === 'qr-allston-01');
t('no columns appended to LEADS', L._rows.every(r => r.length <= LEADS_FULL.length));

console.log('\n--- EVENTS / PROTECTED ---');
t('EVENTS tab created', !!S.tabs.EVENTS);
const EV = S.tabs.EVENTS;
console.log('  HDR ' + JSON.stringify(EV._rows[0]));
console.log('  row1 ' + JSON.stringify(EV._rows[1]));
t('EVENTS headers on row 1', EV._rows[0] && EV._rows[0][0] === 'received_at');
t('exactly one event row', EV._rows.length === 2, EV._rows.length - 1);
t('event email captured', EV._rows[1][EV._rows[0].indexOf('email')] === 'lurker@example.com');
t('event submission_id captured', EV._rows[1][EV._rows[0].indexOf('submission_id')] === 'uuid-evt-5');
t('event received_at stamped', /^\d{4}-\d{2}-\d{2}T/.test(String(EV._rows[1][0])));
t('event did NOT touch LEADS', L._rows.length - 1 === 3);
t('event did NOT touch JOBS', J._rows.length - 1 === 4);
['PROPERTIES','RAW INTAKE','OUTREACH LOG','DASHBOARD'].forEach(n =>
  t(n + ' untouched (header only)', S.tabs[n]._rows.length === 1));

console.log('\n--- dropped fields (must be the 7d list, nothing else) ---');
const dropLines = [...new Set(S.logs.filter(l => /^Dropped/.test(l)))];
dropLines.forEach(l => console.log('  ' + l));
const dropped = [...new Set(dropLines.join(',').replace(/Dropped \(no column\): /g, '').split(',').map(s => s.trim()).filter(Boolean))];
t('nothing folds into notes any more', !/Customer said|Attribution:|Contact:/.test(String(J._rows[1][jh('notes')])));

console.log('\n--- replay integrity ---');
const before = JSON.stringify({ j: J._rows, l: L._rows });
S.post(slot);
t('second replay mutates NOTHING', JSON.stringify({ j: J._rows, l: L._rows }) === before);

/* ============ SCENARIO 2: partial LEADS schema ============ */
console.log('\n\n=== SCENARIO 2 — LEADS missing lead_id and segment ===');
const P = build(LEADS_PARTIAL);
console.log('  ' + JSON.stringify(P.post(slot)));
console.log('  ' + JSON.stringify(P.post(repeat)));
const PL = P.tabs.LEADS;
PL._rows.forEach((r, i) => console.log('  ' + (i === 0 ? 'HDR ' : 'row' + i + ' ') + JSON.stringify(r)));
t('matched on email despite no lead_id column', PL._rows.length - 1 === 1, PL._rows.length - 1);
t('source_history still appended',
  PL._rows[1][LEADS_PARTIAL.indexOf('source_history')] === 'qr-allston-01, ig-story-07');
t('no columns invented on LEADS', PL._rows.every(r => r.length <= LEADS_PARTIAL.length));
t('missing fields reported', P.logs.some(l => /LEADS has no column for: .*lead_id.*segment/.test(l)),
  P.logs.filter(l => /LEADS has no column/.test(l))[0]);
t('JOBS still written', P.tabs.JOBS._rows.length - 1 === 2);

/* ============ SCENARIO 3: LEADS missing entirely ============ */
console.log('\n\n=== SCENARIO 3 — LEADS tab absent (booking must survive) ===');
const M = build(LEADS_FULL);
delete M.tabs.LEADS;
const r3 = M.post(slot);
console.log('  ' + JSON.stringify(r3));
t('JOBS row still written', M.tabs.JOBS._rows.length - 1 === 1);
t('lead_action reports failure', r3.lead_action === 'failed', r3.lead_action);
t('email subject flags the failure', /LEADS WRITE FAILED/.test(M.mails[0].subject));
t('email body explains it', /LEADS UPSERT FAILED/.test(M.mails[0].body));

/* ============ SCENARIO 4: quote_meta column present ============ */
console.log('\n\n=== SCENARIO 4 — quote_meta column added ===');
const Q = build(LEADS_FULL);
Q.tabs.JOBS._rows[0].push('quote_meta');
Q.post(slot);
const meta = Q.tabs.JOBS._rows[1][32];
t('quote_meta populated', isJson(meta), meta);
if (isJson(meta)) {
  const m = JSON.parse(meta);
  t('carries the 7d overflow fields', ['original_price','discount_applied','steady_state_price',
    'recurring_weekly','zip_tier','page_path','utm_source','unit_label'].every(k => k in m));
  t('carries address/unit/zip too', ['address','unit','zip'].every(k => k in m));
}
function isJson(s) { try { JSON.parse(s); return true; } catch (e) { return false; } }

console.log('\n' + (bad ? 'FAILURES: ' + bad : 'ALL ASSERTIONS PASSED'));
process.exit(bad ? 1 : 0);
