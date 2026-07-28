/* LEADS upsert r3, against the LIVE 19-column tab confirmed 2026-07-27:
   underscore tab names, address -> service_address, first_touch/last_touch as
   real Dates, first_touch immutability. Section 7 keeps the pre-segment shape
   as a degradation regression. */
/* Repo-relative so this runs from a clean clone on any machine. */
const REPO_ROOT = require('path').resolve(__dirname, '..');
const fs = require('fs');
const vm = require('vm');

const SRC = fs.readFileSync(require('path').join(REPO_ROOT, 'apps-script', 'webhook.gs'), 'utf8');

/* LIVE shape, verified by reportLeadsSchema() on 2026-07-27: 19 columns. */
const LEADS_LIVE = ['lead_id','name','email','phone','service_address','unit','zip','source',
  'source_detail','contacted_via','source_history','status','first_variant','dnc_scrub',
  'first_touch','last_touch','ltv','notes','segment'];

/* Pre-segment shape, kept as a degradation regression: a missing header must be
   reported and skipped, never invented. */
const LEADS_18 = LEADS_LIVE.slice(0, 18);

const JOBS_36 = ['job_id','lead_id','source','property_key','service_type','frequency',
  'condition','beds','baths','quoted_price','add_ons','add_on_rev','final_price','scheduled_date',
  'completed_date','cleaner','start_time','duration_min','photos_passed','payment_status','job_status','notes',
  'submission_id','received_at','name','email','phone','segment','src_chain','customer_notes','pets_flag',
  'scheduling_type','address','unit','zip','quote_meta'];

/* The real tab list. */
const REAL_TABS = ['PROPERTIES','LEADS','JOBS','OUTREACH_LOG','RAW_INTAKE','DASHBOARD'];

let bad = 0;
const t = (label, cond, extra) => {
  console.log((cond ? '  ok    ' : '  FAIL  ') + label + (extra !== undefined ? '  ->  ' + JSON.stringify(extra) : ''));
  if (!cond) bad++;
};

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const RealDate = Date;

/* Every Utilities.formatDate call is recorded so we can prove which timezone
   the script asks for. */
const FORMAT_CALLS = [];

/* Fixed offsets, valid for the July test dates (EDT / AEST). The host machine
   is UTC+10, so every branch MUST honour `tz` — a mock that quietly uses
   host-local time would make the timezone assertions meaningless. */
const TZ_OFFSET_MIN = { 'America/New_York': -240, 'Australia/Sydney': 600, 'UTC': 0 };

function zoned(d, tz) {
  const off = TZ_OFFSET_MIN[tz];
  if (off === undefined) throw new Error('harness: unknown timezone ' + tz);
  const s = new RealDate(d.getTime() + off * 60000);
  return { y: s.getUTCFullYear(), mo: s.getUTCMonth() + 1, da: s.getUTCDate(),
           h: s.getUTCHours(), mi: s.getUTCMinutes(), se: s.getUTCSeconds(),
           dow: s.getUTCDay(), off: off };
}

function formatDate(d, tz, fmt) {
  FORMAT_CALLS.push({ tz: tz, fmt: fmt });
  const p = n => String(n).padStart(2, '0');
  const z = zoned(d, tz);

  if (fmt === 'yyyyMMdd')     return '' + z.y + p(z.mo) + p(z.da);
  if (fmt === 'EEEE, MMM d')  return DAYS[z.dow] + ', ' + MONTHS[z.mo - 1] + ' ' + z.da;
  if (fmt === "yyyy-MM-dd'T'HH:mm:ssXXX") {
    const a = Math.abs(z.off);
    return z.y + '-' + p(z.mo) + '-' + p(z.da) + 'T' + p(z.h) + ':' + p(z.mi) + ':' + p(z.se) +
           (z.off <= 0 ? '-' : '+') + p(Math.floor(a / 60)) + ':' + p(a % 60);
  }
  throw new Error('harness: unhandled formatDate pattern ' + JSON.stringify(fmt));
}

function makeSheet(name, headers, audit, seedRows) {
  const rows = headers === null ? [] : [headers.slice()].concat(seedRows || []);
  return { _name: name, _rows: rows,
    getName: () => name,
    getLastColumn: () => (rows[0] ? rows[0].length : 0),
    getLastRow: () => rows.length,
    appendRow: r => { audit.push({ tab: name, op: 'appendRow' }); rows.push(r.slice()); },
    setFrozenRows: () => {},
    getRange: (r, c, nr, nc) => ({
      getValues: () => { const o=[]; for (let i=0;i<nr;i++){ const row=rows[r-1+i]||[]; o.push(row.slice(c-1,c-1+nc)); } return o; },
      getNumberFormats: () => { const o=[]; for (let i=0;i<nr;i++){ o.push(new Array(nc).fill('yyyy-mm-dd hh:mm:ss')); } return o; },
      setValue: v => { audit.push({ tab: name, op: 'setValue', col: c - 1, value: v });
                       // real sheets have blank rows waiting; materialize them
                       while (rows.length < r) rows.push([]);
                       while (rows[r-1].length < c) rows[r-1].push('');
                       rows[r-1][c-1] = v; },
    }) };
}

function build(leadsHeaders, seedLeads) {
  const audit = [], mails = [], logs = [];
  let now = new RealDate('2026-07-27T14:00:00Z').getTime();
  class ClockDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(now); else super(...a); }
    static now() { return now; }
  }

  const tabs = {
    JOBS:  makeSheet('JOBS', JOBS_36, audit),
    LEADS: makeSheet('LEADS', leadsHeaders, audit, seedLeads),
  };
  REAL_TABS.filter(n => n !== 'JOBS' && n !== 'LEADS')
           .forEach(n => { tabs[n] = makeSheet(n, ['a','b'], audit); });

  const ssObj = { getSheetByName: n => tabs[n] || null,
                  insertSheet: n => (tabs[n] = makeSheet(n, null, audit)),
                  getSheets: () => Object.values(tabs) };
  const sandbox = {
    console: { log: m => logs.push(String(m)), error: m => logs.push('ERR ' + m) },
    Date: ClockDate,
    SpreadsheetApp: { openById: () => ssObj, getActiveSpreadsheet: () => ssObj },
    ContentService: { MimeType:{JSON:'json'}, createTextOutput: s => ({ getContent:()=>s, setMimeType(){return this;} }) },
    MailApp: { sendEmail: (to,subject,body) => mails.push({to,subject,body}) },
    LockService: { getScriptLock: () => ({ waitLock(){}, releaseLock(){} }) },
    Session: { getScriptTimeZone: () => 'America/New_York' },
    Utilities: { formatDate },
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  return { tabs, audit, mails, logs, sandbox,
    advance: ms => { now += ms; },
    // top-level `const` lives in the script's lexical scope, not on the global
    // object, so reach it by evaluating inside the context
    evalIn: expr => vm.runInContext(expr, sandbox),
    post: p => JSON.parse(sandbox.doPost({ postData: { contents: JSON.stringify(p) } }).getContent()) };
}

const BASE = {
  event: 'quote_reserved', event_type: 'reservation',
  timestamp: '2026-07-27T14:00:00.000Z', submitted_at: '2026-07-27T14:00:00.000Z',
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
  segment: 'movein', utm_source: 'poster', page_path: '/',
  slot_date: '2026-08-14', slot_time: '9-11 AM',
  customer_notes: 'Friendly dog.', pets_flag: true,
};

const isDate = v => Object.prototype.toString.call(v) === '[object Date]';

/* ============================================================
   1. Protected tabs â€” the REAL underscore names
   ============================================================ */
console.log('=== 1. assertWritable against the real tab list ===');
const A = build(LEADS_LIVE);
const aw = A.sandbox.assertWritable;
console.log('  real tabs: ' + REAL_TABS.join(' | '));

['PROPERTIES','OUTREACH_LOG','RAW_INTAKE','DASHBOARD'].forEach(n => {
  let blocked = false;
  try { aw(n); } catch (e) { blocked = /Refusing to write/.test(e.message); }
  t('BLOCKS ' + n, blocked);
});
['JOBS','LEADS','EVENTS'].forEach(n => {
  let ok = true; try { aw(n); } catch (e) { ok = false; }
  t('ALLOWS ' + n, ok);
});
// Rename-resilience: the reason for normalizing rather than fixing two strings.
[['RAW INTAKE'],['Raw_Intake'],['raw-intake'],['OUTREACH LOG'],['outreach log'],['  DASHBOARD ']].forEach(([n]) => {
  let blocked = false; try { aw(n); } catch (e) { blocked = true; }
  t('BLOCKS variant ' + JSON.stringify(n), blocked);
});
t('all six real tabs classified correctly', true);

/* ============================================================
   2. CREATE path â€” address mapping + both timestamps
   ============================================================ */
console.log('\n=== 2. CREATE: address -> service_address, both timestamps ===');
const B = build(LEADS_LIVE);
console.log('  ' + JSON.stringify(B.post(Object.assign({}, BASE, { submission_id: 'u-1' }))));
const L = B.tabs.LEADS, li = n => LEADS_LIVE.indexOf(n);
const created = L._rows[1];
console.log('  LEADS row -> ' + JSON.stringify(created.map(v => isDate(v) ? '<Date ' + v.toISOString() + '>' : v)));

t('service_address from payload `address`', created[li('service_address')] === '123 Beacon St');
t('unit', created[li('unit')] === '4B');
t('zip',  created[li('zip')] === '02134');
t('no plain "address" column invented', LEADS_LIVE.indexOf('address') === -1 && created.length === 19);
t('first_touch is a real Date object', isDate(created[li('first_touch')]), String(created[li('first_touch')]));
t('last_touch is a real Date object',  isDate(created[li('last_touch')]));
t('first_touch is NOT a string', typeof created[li('first_touch')] !== 'string');
t('both stamped identically on create',
  +created[li('first_touch')] === +created[li('last_touch')]);
t('segment written to the live tab', created[li('segment')] === 'movein', created[li('segment')]);
t('full coverage - nothing reported missing', !B.logs.some(l => /LEADS has no column for/.test(l)),
  B.logs.filter(l => /no column for/.test(l)));

const OPERATOR_ONLY = ['source_detail','contacted_via','status','first_variant','dnc_scrub','ltv','notes'];
t('all 7 operator-owned columns blank', OPERATOR_ONLY.every(c => created[li(c)] === ''),
  OPERATOR_ONLY.filter(c => created[li(c)] !== ''));

/* ============================================================
   3. MATCH path â€” last_touch bumps, first_touch frozen
   ============================================================ */
console.log('\n=== 3. MATCH: bump last_touch, never first_touch ===');
const firstTouchBefore = created[li('first_touch')];
const lastTouchBefore  = created[li('last_touch')];

B.advance(3 * 24 * 3600 * 1000);          // three days later
B.post(Object.assign({}, BASE, { submission_id: 'u-2', src: 'ref-jordan',
  name: 'Different Name', address: 'WRONG ADDRESS' }));

const after = B.tabs.LEADS._rows[1];
console.log('  first_touch: ' + firstTouchBefore.toISOString() + '  ->  ' + after[li('first_touch')].toISOString());
console.log('  last_touch:  ' + lastTouchBefore.toISOString()  + '  ->  ' + after[li('last_touch')].toISOString());

t('first_touch UNCHANGED', +after[li('first_touch')] === +firstTouchBefore);
t('first_touch is the same object identity', after[li('first_touch')] === firstTouchBefore);
t('last_touch MOVED FORWARD', +after[li('last_touch')] > +lastTouchBefore);
t('last_touch is still a real Date', isDate(after[li('last_touch')]));
t('last_touch advanced by exactly 3 days',
  +after[li('last_touch')] - +lastTouchBefore === 3*24*3600*1000);

const leadSets = B.audit.filter(a => a.tab === 'LEADS' && a.op === 'setValue');
console.log('  setValue targets: ' + JSON.stringify(leadSets.map(s => LEADS_LIVE[s.col])));
t('NO setValue ever targeted first_touch', !leadSets.some(s => LEADS_LIVE[s.col] === 'first_touch'));
t('a setValue did target last_touch', leadSets.some(s => LEADS_LIVE[s.col] === 'last_touch'));
t('service_address not overwritten', after[li('service_address')] === '123 Beacon St');
t('name not overwritten', after[li('name')] === 'Test Customer');
t('source_history appended', after[li('source_history')] === 'dh-bh-01, ref-jordan');
t('still one LEADS row', B.tabs.LEADS._rows.length - 1 === 1);
t('two JOBS rows', B.tabs.JOBS._rows.length - 1 === 2);

/* ============================================================
   4. Immutability is ENFORCED, not merely observed
   ============================================================ */
console.log('\n=== 4. setLeadCell() refuses first_touch ===');
const C = build(LEADS_LIVE);
const sheet = C.tabs.LEADS;
let threw = null;
try { C.sandbox.setLeadCell(sheet, 2, LEADS_LIVE.indexOf('first_touch'), 'first_touch', new Date()); }
catch (e) { threw = e.message; }
t('throws when asked to write first_touch', threw !== null && /Refusing to modify/.test(threw), threw);
t('LEADS_IMMUTABLE_ON_MATCH contains first_touch',
  C.evalIn('LEADS_IMMUTABLE_ON_MATCH').indexOf('first_touch') !== -1,
  C.evalIn('LEADS_IMMUTABLE_ON_MATCH'));
t('LEADS_FIELDS carries payload keys, not header names',
  C.evalIn('LEADS_FIELDS').indexOf('address') !== -1 &&
  C.evalIn('LEADS_FIELDS').indexOf('service_address') === -1,
  C.evalIn('LEADS_FIELDS'));
t('leadsHeaderFor maps address -> service_address',
  C.sandbox.leadsHeaderFor('address') === 'service_address' &&
  C.sandbox.leadsHeaderFor('unit') === 'unit' &&
  C.sandbox.leadsHeaderFor('zip') === 'zip');
t('operator-owned columns absent from LEADS_FIELDS',
  OPERATOR_ONLY.every(c => C.evalIn('LEADS_FIELDS').indexOf(c) === -1),
  OPERATOR_ONLY.filter(c => C.evalIn('LEADS_FIELDS').indexOf(c) !== -1));

let ok2 = true;
try { C.sandbox.setLeadCell(sheet, 2, LEADS_LIVE.indexOf('last_touch'), 'last_touch', new Date()); }
catch (e) { ok2 = false; }
t('permits last_touch', ok2);

/* ============================================================
   5. Blank first_touch on a manually imported row stays blank
   ============================================================ */
console.log('\n=== 5. MAN-imported row with blank timestamps ===');
const seed = new Array(LEADS_LIVE.length).fill('');
seed[LEADS_LIVE.indexOf('lead_id')] = 'test.customer@example.com';
seed[LEADS_LIVE.indexOf('email')]   = 'test.customer@example.com';
seed[LEADS_LIVE.indexOf('name')]    = 'Imported Person';
seed[LEADS_LIVE.indexOf('source')]  = 'deed-batch-04';
const D = build(LEADS_LIVE, [seed]);
D.post(Object.assign({}, BASE, { submission_id: 'u-seed' }));
const srow = D.tabs.LEADS._rows[1];
t('matched the imported row, no new row', D.tabs.LEADS._rows.length - 1 === 1);
t('first_touch left BLANK â€” today is not when they first appeared',
  srow[LEADS_LIVE.indexOf('first_touch')] === '', srow[LEADS_LIVE.indexOf('first_touch')]);
t('last_touch stamped as a Date', isDate(srow[LEADS_LIVE.indexOf('last_touch')]));
t('blank service_address filled in', srow[LEADS_LIVE.indexOf('service_address')] === '123 Beacon St');
t('populated name preserved', srow[LEADS_LIVE.indexOf('name')] === 'Imported Person');
t('populated source preserved', srow[LEADS_LIVE.indexOf('source')] === 'deed-batch-04');

/* ============================================================
   6. Text-in-a-date-column warning
   ============================================================ */
console.log('\n=== 6. text in last_touch triggers a warning ===');
const seed2 = seed.slice();
seed2[LEADS_LIVE.indexOf('last_touch')] = '2026-07-01';   // a STRING, not a Date
const E = build(LEADS_LIVE, [seed2]);
E.post(Object.assign({}, BASE, { submission_id: 'u-text' }));
t('warns that the column holds TEXT', E.logs.some(l => /currently holds TEXT/.test(l)),
  E.logs.filter(l => /TEXT/.test(l))[0]);
t('still wrote a real Date over it', isDate(E.tabs.LEADS._rows[1][LEADS_LIVE.indexOf('last_touch')]));

/* ============================================================
   7. Degradation: a tab MISSING the segment header
   Guards the general rule — a header we cannot find is reported and
   skipped, never invented, and the booking still lands.
   ============================================================ */
console.log('\n=== 7. pre-segment tab (18 cols) must degrade, not invent ===');
const F = build(LEADS_18);
F.post(Object.assign({}, BASE, { submission_id: 'u-seg' }));
t('segment reported as missing', F.logs.some(l => /LEADS has no column for: segment/.test(l)),
  F.logs.filter(l => /no column for/.test(l))[0]);
t('no column appended to LEADS', F.tabs.LEADS._rows.every(r => r.length <= 18),
  F.tabs.LEADS._rows.map(r => r.length));
t('booking still written', F.tabs.JOBS._rows.length - 1 === 1);
t('everything else still populated', F.tabs.LEADS._rows[1][LEADS_18.indexOf('service_address')] === '123 Beacon St');

/* ============================================================
   8. Timezone pinning
   received_at and the makeJobId fallback must agree about what day it is,
   and a calendar date must render the same weekday everywhere.
   ============================================================ */
console.log('\n=== 8. timezone consistency ===');

FORMAT_CALLS.length = 0;
const G = build(LEADS_LIVE);
// No slot_date, so makeJobId takes the "today" fallback branch.
G.post(Object.assign({}, BASE, { submission_id: 'u-tz2', email: 'tz@x.com',
  slot_date: null, slot_time: null, time_preference: 'earlier' }));

const zones = [...new Set(FORMAT_CALLS.map(c => c.tz))];
console.log('  timezones requested: ' + JSON.stringify(zones));
console.log('  patterns requested:  ' + JSON.stringify([...new Set(FORMAT_CALLS.map(c => c.fmt))]));
t('every formatDate call pins America/New_York',
  zones.length === 1 && zones[0] === 'America/New_York', zones);

const gJobId  = G.tabs.JOBS._rows[1][JOBS_36.indexOf('job_id')];
const gRecvd  = String(G.tabs.JOBS._rows[1][JOBS_36.indexOf('received_at')]);
console.log('  job_id      -> ' + gJobId);
console.log('  received_at -> ' + gRecvd);
t('undated booking: job_id date matches received_at date',
  gJobId.split('-')[1] === gRecvd.slice(0, 10).replace(/-/g, ''),
  { job_id: gJobId.split('-')[1], received_at: gRecvd.slice(0, 10) });

/* prettyDate must not depend on the script timezone at all. */
const tzA = build(LEADS_LIVE);
const tzB = build(LEADS_LIVE);
tzB.sandbox.Session.getScriptTimeZone = () => 'Australia/Sydney';   // deliberately wrong
const samples = ['2026-08-14', '2026-01-01', '2026-12-31', '2026-03-08', '2026-11-01'];
const outA = samples.map(s => tzA.sandbox.prettyDate(s));
const outB = samples.map(s => tzB.sandbox.prettyDate(s));
samples.forEach((s, i) => console.log('  ' + s + ' -> ' + outA[i]));
t('prettyDate identical under a different script timezone',
  JSON.stringify(outA) === JSON.stringify(outB), { ny: outA, sydney: outB });

// Cross-check the weekdays against Node's own UTC calendar.
const refDay = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const refOK = samples.every((s, i) => {
  const p = s.split('-').map(Number);
  const want = refDay[new RealDate(RealDate.UTC(p[0], p[1]-1, p[2])).getUTCDay()];
  return outA[i].indexOf(want) === 0;
});
t('weekdays are calendrically correct', refOK, outA);
t('2026-08-14 is a Friday', outA[0] === 'Friday, Aug 14', outA[0]);

console.log('\n' + (bad ? 'FAILURES: ' + bad : 'ALL ASSERTIONS PASSED'));
process.exit(bad ? 1 : 0);

