/**
 * Task 5 — PROPERTIES upsert.
 * Task 6 — AVAILABILITY write-back to the Ops workbook.
 *
 * Both are writes to tabs that were previously protected, so the tests care as
 * much about what is NOT written as what is. Sheets are simulated with an audit
 * trail so a test can assert how many writes happened and to which cells.
 */
const REPO_ROOT = require('path').resolve(__dirname, '..');
const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const SRC       = fs.readFileSync(path.join(REPO_ROOT, 'apps-script', 'webhook.gs'), 'utf8');
const AVAIL_SRC = fs.readFileSync(path.join(REPO_ROOT, 'apps-script', 'availability.gs'), 'utf8');

let bad = 0;
const t = (label, cond, extra) => {
  console.log((cond ? '  ok    ' : '  FAIL  ') + label + (extra !== undefined ? '  ->  ' + JSON.stringify(extra) : ''));
  if (!cond) bad++;
};

/* ---- live header rows, confirmed against the real workbooks 2026-07-28 ---- */
const JOBS_36 = ['job_id','lead_id','source','property_key','service_type','frequency',
  'condition','beds','baths','quoted_price','add_ons','add_on_rev','final_price','scheduled_date',
  'completed_date','cleaner','start_time','duration_min','photos_passed','payment_status','job_status','notes',
  'submission_id','received_at','name','email','phone','segment','src_chain','customer_notes','pets_flag',
  'scheduling_type','address','unit','zip','quote_meta'];

const LEADS_19 = ['lead_id','name','email','phone','service_address','unit','zip','source',
  'source_detail','contacted_via','source_history','status','first_variant','dnc_scrub',
  'first_touch','last_touch','ltv','notes','segment'];

const PROPERTIES_17 = ['property_key','service_address','unit','neighborhood','zip','property_type',
  'beds','baths','deed_date','sale_price','deed_type','buyer_name','first_clean_min',
  'last_service_date','photo_folder','known_issues','notes'];

const AVAIL_7 = ['date','start_time','cleaner_id','status','job_id','week_of','notes'];

const OPS_ID = '1MhaQGxwTZvg7HF94WWpeof5A6P9GCa8Fq7hkZKqxwW4';
const RealDate = Date;
const NOW = new RealDate('2026-07-28T14:00:00Z');

function makeSheet(name, headers, audit, seed) {
  const rows = headers === null ? [] : [headers.slice()].concat(seed || []);
  return { _name: name, _rows: rows,
    getName: () => name,
    getLastColumn: () => (rows[0] ? rows[0].length : 0),
    getLastRow: () => rows.length,
    appendRow: r => { audit.push({ tab: name, op: 'appendRow' }); rows.push(r.slice()); },
    setFrozenRows: () => {},
    getDataRange: () => ({ getValues: () => rows.map(r => r.slice()) }),
    getRange: (r, c, nr, nc) => ({
      getValues: () => { const o=[]; for (let i=0;i<nr;i++){ const row=rows[r-1+i]||[]; o.push(row.slice(c-1,c-1+nc)); } return o; },
      getNumberFormats: () => Array.from({length: nr}, () => new Array(nc).fill('')),
      setValue: v => { audit.push({ tab: name, op: 'setValue', row: r, col: c - 1, value: v });
                       while (rows.length < r) rows.push([]);
                       while (rows[r-1].length < c) rows[r-1].push('');
                       rows[r-1][c-1] = v; },
    }) };
}

/* Sheets builds a date cell's instant from the SPREADSHEET's timezone — not the
   project's, which is what this file used to say. cellDate() keeps building
   host-local instants because the Ops stub reports the host's zone, so the two
   still line up; cellDateIn() is for the cases that must not depend on that. */
const cellDate = (y, m, d) => new RealDate(y, m - 1, d);
const cellDateIn = (tz, y, m, d) =>
  new RealDate(RealDate.UTC(y, m - 1, d) - (tz === 'Australia/Sydney' ? 600 : -240) * 60000);

function build(opts) {
  const o = opts || {};
  const audit = [], mails = [], logs = [];

  class ClockDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(NOW.getTime()); else super(...a); }
    static now() { return NOW.getTime(); }
    static [Symbol.hasInstance](x) { return x instanceof RealDate; }
  }

  const leadsTabs = {
    JOBS:       makeSheet('JOBS', JOBS_36, audit),
    LEADS:      makeSheet('LEADS', LEADS_19, audit),
    PROPERTIES: makeSheet('PROPERTIES',
      o.propertiesNoHeaders ? null : (o.propertiesHeaders || PROPERTIES_17), audit, o.propertiesSeed),
    RAW_INTAKE: makeSheet('RAW_INTAKE', ['a'], audit),
    OUTREACH_LOG: makeSheet('OUTREACH_LOG', ['a'], audit),
    DASHBOARD:  makeSheet('DASHBOARD', ['a'], audit),
  };

  const availSeed = o.availSeed !== undefined ? o.availSeed : [
    [cellDate(2026, 8, 14), '9:00 AM',  'C-01', 'open',   '', '', ''],
    [cellDate(2026, 8, 14), '9:00 AM',  'C-02', 'held',   '', '', ''],   // must never be touched
    [cellDate(2026, 8, 14), '1:00 PM',  'C-01', 'open',   '', '', ''],
    [cellDate(2026, 8, 15), '9:00 AM',  'C-01', 'booked', 'SRV-OLD', '', ''],
  ];
  const opsTabs = {
    CLEANERS:      makeSheet('CLEANERS', ['cleaner_id'], audit),
    AVAILABILITY:  makeSheet('AVAILABILITY', o.availHeaders || AVAIL_7, audit, availSeed),
    SCHEDULE:      makeSheet('SCHEDULE', ['a'], audit),
    OPS_DASHBOARD: makeSheet('OPS_DASHBOARD', ['a'], audit),
  };

  const leadsSs = { getSheetByName: n => leadsTabs[n] || null,
                    insertSheet: n => (leadsTabs[n] = makeSheet(n, null, audit)),
                    getSheets: () => Object.values(leadsTabs), getName: () => 'Leads MASTER' };
  const opsSs   = { getSheetByName: n => opsTabs[n] || null,
                    /* r33: the Ops workbook reports its own timezone, and the
                       slot keys are read through it rather than this project's. */
                    getSpreadsheetTimeZone: () => o.opsTz || 'America/New_York',
                    getSheets: () => Object.values(opsTabs), getName: () => 'Ops MASTER' };

  const sandbox = {
    console: { log: m => logs.push(String(m)), warn: m => logs.push(String(m)), error: m => logs.push('ERR ' + m) },
    Date: ClockDate,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => leadsSs,
      openById: id => {
        if (o.opsUnreachable) throw new Error('simulated: no permission to open ' + id);
        if (id === OPS_ID) return opsSs;
        return leadsSs;
      },
    },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: s => ({ getContent: () => s, setMimeType() { return this; } }) },
    MailApp: { sendEmail: (to, subject, body) => mails.push({ to, subject, body }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Session: { getScriptTimeZone: () => 'America/New_York', getEffectiveUser: () => ({ getEmail: () => 'ops@example.com' }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
    Utilities: { formatDate: (d, tz, fmt) => {
      const off = tz === 'Australia/Sydney' ? 600 : -240;
      const s = new RealDate(d.getTime() + off * 60000), p = n => String(n).padStart(2, '0');
      if (fmt === 'yyyyMMdd') return '' + s.getUTCFullYear() + p(s.getUTCMonth() + 1) + p(s.getUTCDate());
      if (fmt === 'yyyy-MM-dd') return s.getUTCFullYear() + '-' + p(s.getUTCMonth()+1) + '-' + p(s.getUTCDate());
      if (fmt === 'H') return String(s.getUTCHours());
      if (fmt === 'm') return String(s.getUTCMinutes());
      if (fmt === "yyyy-MM-dd'T'HH:mm:ssXXX")
        return s.getUTCFullYear() + '-' + p(s.getUTCMonth()+1) + '-' + p(s.getUTCDate()) + 'T' +
               p(s.getUTCHours()) + ':' + p(s.getUTCMinutes()) + ':' + p(s.getUTCSeconds()) + '-04:00';
      throw new Error('harness: unhandled pattern ' + fmt);
    } },
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  /* THE OPERATOR'S MAIL, PICKED BY RECIPIENT, NEVER BY POSITION. Every
     assertion below is about the notification an operator reads. Indexing
     `mails` directly made those assertions depend on how many OTHER messages a
     booking happens to send, and r58 — the customer's own confirmation, which
     goes out first — silently shifted every one of them: the slot-conflict
     checks started reading the customer's email and failing on its subject. */
  return { leadsTabs, opsTabs, audit, mails, logs, sandbox,
    opsMails: () => mails.filter(m => m.to === 'ops@example.com'),
    evalIn: expr => vm.runInContext(expr, sandbox),
    post: p => JSON.parse(sandbox.doPost({ postData: { contents: JSON.stringify(p) } }).getContent()) };
}

const BASE = {
  event: 'quote_reserved', event_type: 'reservation',
  timestamp: '2026-07-28T14:00:00.000Z', submitted_at: '2026-07-28T14:00:00.000Z',
  zip: '02134', zip_tier: 'core', bedrooms: 2, bathrooms: 1,
  service: 'first_clean', service_type: 'first_clean', condition: 'standard',
  addon_total: 45, frequency_selected: 'biweekly',
  quote_price: 214, first_visit_total: 214,
  name: 'Test Customer', email: 'test.customer@example.com', phone: '(617) 555-0100',
  address: '123 Beacon St', unit: '4B',
  src: 'dh-bh-01', src_first: 'dh-bh-01', segment: 'pro',
  slot_date: '2026-08-14', slot_time: '9:00 AM',
  customer_notes: 'Friendly dog.', pets_flag: true,
};

/* ============================================================
   1. PROPERTIES upsert
   ============================================================ */
console.log('=== 1. PROPERTIES: create, then blank-fill only ===');
const A = build();
const r1 = A.post(Object.assign({}, BASE, { submission_id: 'p-1' }));
const P = A.leadsTabs.PROPERTIES, pi = n => PROPERTIES_17.indexOf(n);
console.log('  ' + JSON.stringify(P._rows[1]));

t('property_action created', r1.property_action === 'created', r1.property_action);
t('one PROPERTIES row', P._rows.length - 1 === 1);
t('property_key matches the JOBS join key',
  P._rows[1][pi('property_key')] === A.leadsTabs.JOBS._rows[1][JOBS_36.indexOf('property_key')],
  P._rows[1][pi('property_key')]);
t('address -> service_address', P._rows[1][pi('service_address')] === '123 Beacon St');
t('unit', P._rows[1][pi('unit')] === '4B');
t('zip',  P._rows[1][pi('zip')] === '02134');
t('bedrooms -> beds', P._rows[1][pi('beds')] === 2);
t('bathrooms -> baths', P._rows[1][pi('baths')] === 1);
t('still 17 columns — nothing appended', P._rows.every(r => r.length <= 17));

const OPERATOR_OWNED = ['neighborhood','property_type','deed_date','sale_price','deed_type',
  'buyer_name','first_clean_min','last_service_date','photo_folder','known_issues','notes'];
t('all 11 operator/deed columns left blank',
  OPERATOR_OWNED.every(c => P._rows[1][pi(c)] === ''),
  OPERATOR_OWNED.filter(c => P._rows[1][pi(c)] !== ''));
t('last_service_date NOT set — a booking is not a completed service',
  P._rows[1][pi('last_service_date')] === '');

/* Second booking at the SAME home, after the operator has enriched the row.
   Same unit matters: unit is part of property_key, so a different unit is a
   different property by definition — see the assertion further down. */
P._rows[1][pi('neighborhood')]  = 'Beacon Hill';
P._rows[1][pi('property_type')] = 'condo';
P._rows[1][pi('known_issues')]  = 'steep stairs';
const r2 = A.post(Object.assign({}, BASE, { submission_id: 'p-2',
  address: '123 Beacon St', unit: '4B', bedrooms: 9 }));   // 9 beds is a typo we must ignore
t('second booking at the same home matches', r2.property_action === 'matched', r2.property_action);
t('still ONE property row', P._rows.length - 1 === 1, P._rows.length - 1);
t("operator's neighborhood survives", P._rows[1][pi('neighborhood')] === 'Beacon Hill');
t("operator's property_type survives", P._rows[1][pi('property_type')] === 'condo');
t("operator's known_issues survives", P._rows[1][pi('known_issues')] === 'steep stairs');
t('populated beds not overwritten by a later typo', P._rows[1][pi('beds')] === 2, P._rows[1][pi('beds')]);

/* A different unit at the same street address IS a different property — unit is
   part of property_key. Apt 4B and Apt 5C are separate homes with separate
   access notes and separate histories. */
A.post(Object.assign({}, BASE, { submission_id: 'p-3', address: '123 Beacon St', unit: '5C' }));
t('a different unit is a different property', P._rows.length - 1 === 2, P._rows.length - 1);
t('the new row has its own key',
  P._rows[2][pi('property_key')] !== P._rows[1][pi('property_key')],
  [P._rows[1][pi('property_key')], P._rows[2][pi('property_key')]]);

/* A different street entirely. */
A.post(Object.assign({}, BASE, { submission_id: 'p-4', address: '9 Marlborough St', unit: '' }));
t('a different address creates a third row', P._rows.length - 1 === 3, P._rows.length - 1);

/* No address at all — nothing to key on, so nothing is written. */
const noAddr = A.post(Object.assign({}, BASE, { submission_id: 'p-5', address: '', unit: '', zip: '' }));
t('a booking with no address skips PROPERTIES', noAddr.property_action === 'skipped', noAddr.property_action);
t('and adds no row', P._rows.length - 1 === 3, P._rows.length - 1);

console.log('\n=== 1b. PROPERTIES failure is never fatal ===');
const B = build({ propertiesNoHeaders: true });        // tab exists but row 1 is empty
const rb = B.post(Object.assign({}, BASE, { submission_id: 'p-fail' }));
t('booking still written', B.leadsTabs.JOBS._rows.length - 1 === 1);
t('property_action failed', rb.property_action === 'failed', rb.property_action);
t('status still ok to the customer', rb.status === 'ok');
t('notification flags it', /PROPERTIES UPSERT FAILED/.test(B.opsMails()[0].body));

/* ============================================================
   2. AVAILABILITY write-back
   ============================================================ */
console.log('\n=== 2. slot flips open -> booked, and links the job ===');
const C = build();
const rc = C.post(Object.assign({}, BASE, { submission_id: 's-1' }));
const AV = C.opsTabs.AVAILABILITY, ai = n => AVAIL_7.indexOf(n);
AV._rows.slice(1).forEach((r, i) => console.log('  row' + (i + 2) + ': ' +
  [r[ai('date')] instanceof RealDate ? r[ai('date')].toDateString() : r[ai('date')],
   r[ai('start_time')], r[ai('cleaner_id')], r[ai('status')], r[ai('job_id')]].join(' | ')));

t('slot_action booked', rc.slot_action === 'booked', rc.slot_action);
t('the matching row is now booked', AV._rows[1][ai('status')] === 'booked');
t('job_id written back, linking the two workbooks',
  AV._rows[1][ai('job_id')] === rc.job_id, AV._rows[1][ai('job_id')]);
t('the HELD row was NOT touched', AV._rows[2][ai('status')] === 'held');
t('the other open time is untouched', AV._rows[3][ai('status')] === 'open');
t('the already-booked row keeps its original job_id', AV._rows[4][ai('job_id')] === 'SRV-OLD');
t('exactly two cells written on AVAILABILITY',
  C.audit.filter(a => a.tab === 'AVAILABILITY').length === 2,
  C.audit.filter(a => a.tab === 'AVAILABILITY').map(a => a.op + ':col' + a.col));
t('no protected Ops tab was written',
  !C.audit.some(a => ['CLEANERS','SCHEDULE','OPS_DASHBOARD'].indexOf(a.tab) !== -1));

console.log('\n=== 2b. second booking of the same slot = conflict, not an error ===');
const rc2 = C.post(Object.assign({}, BASE, { submission_id: 's-2', email: 'other@example.com' }));
t('slot_action conflict', rc2.slot_action === 'conflict', rc2.slot_action);
t('the booking is STILL written', C.leadsTabs.JOBS._rows.length - 1 === 2);
t('customer sees success', rc2.status === 'ok');
t('subject flags SLOT CONFLICT', /SLOT CONFLICT/.test(C.opsMails()[1].subject), C.opsMails()[1].subject);
t('body says the booking is recorded', /booking IS recorded/.test(C.opsMails()[1].body));
t('no extra AVAILABILITY write on the conflict',
  C.audit.filter(a => a.tab === 'AVAILABILITY').length === 2);

console.log('\n=== 2c. preference bookings have no slot to flip ===');
const D = build();
const rd = D.post(Object.assign({}, BASE, { submission_id: 's-pref',
  slot_date: null, slot_time: null, time_preference: 'earlier' }));
t('slot_action skipped', rd.slot_action === 'skipped', rd.slot_action);
t('AVAILABILITY untouched', !D.audit.some(a => a.tab === 'AVAILABILITY'));
t('booking written normally', D.leadsTabs.JOBS._rows.length - 1 === 1);

console.log('\n=== 2d. Ops unreachable still completes the booking ===');
const E = build({ opsUnreachable: true });
const re = E.post(Object.assign({}, BASE, { submission_id: 's-down' }));
t('slot_action failed', re.slot_action === 'failed', re.slot_action);
t('booking still written', E.leadsTabs.JOBS._rows.length - 1 === 1);
t('customer still sees success', re.status === 'ok');
t('subject flags SLOT NOT MARKED', /SLOT NOT MARKED/.test(E.opsMails()[0].subject), E.opsMails()[0].subject);
t('body tells the operator to mark it by hand', /Mark it booked by hand/.test(E.opsMails()[0].body));

console.log('\n=== 2e. a missing AVAILABILITY header fails loudly, not silently ===');
const F = build({ availHeaders: ['date','start_time','cleaner_id','state','job_id','week_of','notes'] });
const rf = F.post(Object.assign({}, BASE, { submission_id: 's-hdr' }));
t('slot_action failed', rf.slot_action === 'failed', rf.slot_action);
t('names the missing header', F.logs.some(l => /missing header\(s\): status/.test(l)),
  F.logs.filter(l => /missing header/.test(l))[0]);
t('booking still written', F.leadsTabs.JOBS._rows.length - 1 === 1);

console.log('\n=== 2f. an Ops workbook in another timezone still matches ===');
/* THE CASE THAT COULD NOT FAIL BEFORE r33. availability.gs publishes the day
   the OPS WORKBOOK says, and the customer books that day. This file then has to
   find the same row — from a DIFFERENT Apps Script project, with a timezone of
   its own. While both sides used local getters they agreed only because Ops'
   workbook, Ops' project and this project were all America/New_York.

   Here the workbook is Sydney and this project is not. The cell below is the
   instant Sheets hands back for a date typed as 2026-08-14 in a Sydney
   workbook, which is 2026-08-13 by local getters — so a reader that ignores the
   workbook's timezone looks for the wrong day and reports a conflict, leaving a
   sold slot still marked open. */
const G = build({
  opsTz: 'Australia/Sydney',
  availSeed: [
    [cellDateIn('Australia/Sydney', 2026, 8, 14), '9:00 AM', 'C-01', 'open', '', '', ''],
  ],
});
const rg = G.post(Object.assign({}, BASE, { submission_id: 's-syd' }));
t('a Sydney Ops workbook still matches the slot the feed published',
  rg.slot_action === 'booked', rg.slot_action);
t('and flips that row, not another', G.opsTabs.AVAILABILITY._rows[1][ai('status')] === 'booked',
  G.opsTabs.AVAILABILITY._rows[1][ai('status')]);

/* ============================================================
   3. the two scripts must agree on how a slot is identified
   ============================================================ */
console.log('\n=== 3. webhook and availability.gs derive identical keys ===');
/* These run in two different Apps Script projects against the SAME Ops cells.
   If they ever disagree the match silently fails and every booking reports a
   conflict, so the agreement is asserted directly.

   Both are now keyed to the OPS WORKBOOK's timezone. That is the point of r33:
   while both used local getters they agreed only because Ops' workbook, Ops'
   project and the Leads project all happened to be America/New_York. */
const availFormat = (d, tz, fmt) => {
  const off = tz === 'Australia/Sydney' ? 600 : -240;
  const s = new RealDate(d.getTime() + off * 60000), p = n => String(n).padStart(2, '0');
  if (fmt === 'yyyy-MM-dd') return s.getUTCFullYear() + '-' + p(s.getUTCMonth()+1) + '-' + p(s.getUTCDate());
  if (fmt === 'H') return String(s.getUTCHours());
  if (fmt === 'm') return String(s.getUTCMinutes());
  throw new Error('harness: unhandled pattern ' + fmt);
};
const availBox = { console: { log(){}, warn(){}, error(){} }, Date: RealDate,
  Session: { getScriptTimeZone: () => 'America/New_York' },
  SpreadsheetApp: {}, CacheService: {}, ContentService: {},
  Utilities: { formatDate: availFormat } };
vm.createContext(availBox);
vm.runInContext(AVAIL_SRC, availBox);

const NY = 'America/New_York', SYD = 'Australia/Sydney';
const samples = [[9,0],[12,0],[0,5],[13,30],[15,30],[17,30],[23,59],[12,30]];
const mismatchT = samples.filter(([h, m]) =>
  availBox.clockLabel(h, m) !== C.sandbox.clockLabelFor(h, m));
t('time labels identical across both scripts', mismatchT.length === 0,
  mismatchT.map(([h,m]) => h + ':' + m + ' avail=' + availBox.clockLabel(h,m) + ' hook=' + C.sandbox.clockLabelFor(h,m)));

const dates = [cellDate(2026,8,14), cellDate(2026,1,1), cellDate(2026,12,31), cellDate(2026,3,8)];
const mismatchD = dates.filter(d => availBox.ymd(d, NY) !== C.sandbox.slotDateKey(d, NY));
t('date keys identical across both scripts', mismatchD.length === 0,
  mismatchD.map(d => 'avail=' + availBox.ymd(d, NY) + ' hook=' + C.sandbox.slotDateKey(d, NY)));
t('a real Sheets time value parses the same',
  C.sandbox.slotTimeLabel(new RealDate(1899, 11, 30, 15, 30), NY) ===
  availBox.parseTime(new RealDate(1899, 11, 30, 15, 30), NY).label);

/* Instants where the two zones fall on DIFFERENT days. A local midnight never
   does — +10:00 from a New York midnight is still the same date — so a fixture
   built from cellDate() cannot tell the two readings apart, and an assertion
   that cannot fail proves nothing. */
const crossing = [
  new RealDate(RealDate.UTC(2026, 7, 14, 20, 0)),   // NY Aug 14 16:00, Sydney Aug 15 06:00
  new RealDate(RealDate.UTC(2026, 0, 1, 23, 30)),   // NY Jan 1 18:30, Sydney Jan 2 10:30
];
t('the workbook timezone genuinely changes the day read',
  crossing.every(d => availBox.ymd(d, SYD) !== availBox.ymd(d, NY)),
  crossing.map(d => [availBox.ymd(d, NY), availBox.ymd(d, SYD)]));

const mismatchSyd = crossing.filter(d => availBox.ymd(d, SYD) !== C.sandbox.slotDateKey(d, SYD));
t('and they still agree when the workbook is in neither project timezone',
  mismatchSyd.length === 0,
  mismatchSyd.map(d => 'avail=' + availBox.ymd(d, SYD) + ' hook=' + C.sandbox.slotDateKey(d, SYD)));
t('including the time label',
  C.sandbox.slotTimeLabel(new RealDate(1899, 11, 30, 15, 30), SYD) ===
  availBox.parseTime(new RealDate(1899, 11, 30, 15, 30), SYD).label);

console.log('\n' + (bad ? 'FAILURES: ' + bad : 'ALL CHECKS PASSED'));
process.exit(bad ? 1 : 0);
