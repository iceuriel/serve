/**
 * r16 — the AVAILABILITY row a booking consumes decides the assignment.
 *
 * The 22 files that existed before this one all pass against r16 unchanged,
 * which proves only that the absent-data path is safe: none of them has a
 * VENDOR_SERVICES tab or a vendor_id column, so none of them ever reaches the
 * new code. This file supplies that data and checks the choice actually made.
 *
 * The rules under test, in order of how much damage getting them wrong does:
 *
 *   1. A vendor who has declared nothing is ORDINARY, not disqualified — so an
 *      empty VENDOR_SERVICES tab must leave booking behaving exactly as r15.
 *   2. A vendor who declared their services and left this one out is skipped
 *      when somebody else is open, and merely FLAGGED when nobody is. The
 *      booking is never refused: the customer would be paying for our data.
 *   3. The column is read as vendor_id OR cleaner_id, so the sheet rename is
 *      not a flag day in either direction.
 *   4. The stamp onto JOBS fills a blank and never argues with a dispatcher.
 */
const REPO_ROOT = require('path').resolve(__dirname, '..');
const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const SRC = fs.readFileSync(path.join(REPO_ROOT, 'apps-script', 'webhook.gs'), 'utf8');

let bad = 0;
const t = (label, cond, extra) => {
  console.log((cond ? '  ok    ' : '  FAIL  ') + label + (extra !== undefined ? '  ->  ' + JSON.stringify(extra) : ''));
  if (!cond) bad++;
};

/* JOBS as it will read once the two r16 columns are added. */
const JOBS_H = ['job_id','lead_id','source','property_key','service_type','frequency',
  'condition','beds','baths','partner_payout','quoted_price','add_ons','add_on_rev','final_price',
  'scheduled_date','completed_date','cleaner','vendor_id','operator_id','start_time','duration_min',
  'photos_passed','payment_status','job_status','notes','submission_id','received_at','name','email',
  'phone','segment','src_chain','customer_notes','pets_flag','scheduling_type','address','unit','zip',
  'quote_meta'];

const LEADS_H = ['lead_id','contact_id','name','email','phone','service_address','unit','zip','source',
  'source_detail','contacted_via','source_history','status','first_variant','dnc_scrub',
  'first_touch','last_touch','ltv','notes','segment'];

const AVAIL_VEN = ['date','start_time','vendor_id','status','job_id','week_of','notes'];
const AVAIL_CLN = ['date','start_time','cleaner_id','status','job_id','week_of','notes'];
const VSVC_H    = ['vendor_id','service_code','offers','preference','active','notes'];

const OPS_ID = '1MhaQGxwTZvg7HF94WWpeof5A6P9GCa8Fq7hkZKqxwW4';
const RealDate = Date;
const NOW = new RealDate('2026-07-28T14:00:00Z');
const cellDate = (y, m, d) => new RealDate(y, m - 1, d);

function makeSheet(name, headers, audit, seed) {
  /* Deep-copy the seed. setValue mutates rows in place, so sharing row arrays
     between builds lets one scenario book a slot the next one then finds
     already taken — which reads as eight code failures and is one harness bug. */
  const rows = headers === null ? [] : [headers.slice()].concat((seed || []).map(r => r.slice()));
  return { _name: name, _rows: rows,
    getName: () => name,
    getLastColumn: () => (rows[0] ? rows[0].length : 0),
    getLastRow: () => rows.length,
    appendRow: r => { audit.push({ tab: name, op: 'appendRow' }); rows.push(r.slice()); },
    setFrozenRows: () => {},
    getDataRange: () => ({ getValues: () => rows.map(r => r.slice()) }),
    getRange: (r, c, nr, nc) => ({
      getValue: () => (rows[r-1] || [])[c-1],
      getValues: () => { const o=[]; for (let i=0;i<nr;i++){ const row=rows[r-1+i]||[]; o.push(row.slice(c-1,c-1+nc)); } return o; },
      getNumberFormats: () => Array.from({length: nr}, () => new Array(nc).fill('')),
      setValue: v => { audit.push({ tab: name, op: 'setValue', row: r, col: c - 1, value: v });
                       while (rows.length < r) rows.push([]);
                       while (rows[r-1].length < c) rows[r-1].push('');
                       rows[r-1][c-1] = v; },
    }) };
}

/* Two vendors open at the same date and time. Which one gets it is the
   entire question this file exists to answer. */
const TWO_OPEN = [
  [cellDate(2026, 8, 14), '9:00 AM', 'VEN-0001', 'open', '', '', ''],
  [cellDate(2026, 8, 14), '9:00 AM', 'VEN-0002', 'open', '', '', ''],
  [cellDate(2026, 8, 14), '9:00 AM', 'VEN-0003', 'held', '', '', ''],   // never touched
];

function build(o) {
  o = o || {};
  const audit = [], mails = [], logs = [];

  class ClockDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(NOW.getTime()); else super(...a); }
    static now() { return NOW.getTime(); }
    static [Symbol.hasInstance](x) { return x instanceof RealDate; }
  }

  const leadsTabs = {
    JOBS:       makeSheet('JOBS', o.jobsHeaders || JOBS_H, audit, o.jobsSeed),
    LEADS:      makeSheet('LEADS', LEADS_H, audit),
    PROPERTIES: makeSheet('PROPERTIES', ['property_id','property_key','service_address','unit','zip','beds','baths'], audit),
    RAW_INTAKE: makeSheet('RAW_INTAKE', ['a'], audit),
    DASHBOARD:  makeSheet('DASHBOARD', ['a'], audit),
  };

  const opsTabs = {
    CLEANERS:        makeSheet('CLEANERS', ['cleaner_id'], audit),
    AVAILABILITY:    makeSheet('AVAILABILITY', o.availHeaders || AVAIL_VEN, audit,
                               o.availSeed !== undefined ? o.availSeed : TWO_OPEN),
    VENDORS:         makeSheet('VENDORS', ['vendor_id','display_name','client_visible'], audit,
                               [['VEN-0001','Beacon Hill Home Care','TRUE'],
                                ['VEN-0002','Charles River Cleaning','TRUE']]),
    VENDOR_SERVICES: makeSheet('VENDOR_SERVICES', VSVC_H, audit, o.services || []),
    OPERATORS:       makeSheet('OPERATORS', ['operator_id','vendor_id'], audit),
    SCHEDULE:        makeSheet('SCHEDULE', ['a'], audit),
    OPS_DASHBOARD:   makeSheet('OPS_DASHBOARD', ['a'], audit),
  };

  const leadsSs = { getSheetByName: n => leadsTabs[n] || null,
                    insertSheet: n => (leadsTabs[n] = makeSheet(n, null, audit)),
                    getSheets: () => Object.values(leadsTabs), getName: () => 'Leads MASTER' };
  const opsSs   = { getSheetByName: n => opsTabs[n] || null,
                    getSheets: () => Object.values(opsTabs), getName: () => 'Ops MASTER' };

  const sandbox = {
    console: { log: m => logs.push(String(m)), warn: m => logs.push(String(m)), error: m => logs.push('ERR ' + m) },
    Date: ClockDate,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => leadsSs,
      openById: id => (id === OPS_ID ? opsSs : leadsSs),
    },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: s => ({ getContent: () => s, setMimeType() { return this; } }) },
    MailApp: { sendEmail: (to, subject, body) => mails.push({ to, subject, body }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Session: { getScriptTimeZone: () => 'America/New_York', getEffectiveUser: () => ({ getEmail: () => 'ops@example.com' }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
    Utilities: { getUuid: () => 'test-uuid-0000', formatDate: (d, tz, fmt) => {
      const off = -240, s = new RealDate(d.getTime() + off * 60000), p = n => String(n).padStart(2, '0');
      if (fmt === 'yyyyMMdd') return '' + s.getUTCFullYear() + p(s.getUTCMonth() + 1) + p(s.getUTCDate());
      if (fmt === "yyyy-MM-dd'T'HH:mm:ssXXX")
        return s.getUTCFullYear() + '-' + p(s.getUTCMonth()+1) + '-' + p(s.getUTCDate()) + 'T' +
               p(s.getUTCHours()) + ':' + p(s.getUTCMinutes()) + ':' + p(s.getUTCSeconds()) + '-04:00';
      throw new Error('harness: unhandled pattern ' + fmt);
    } },
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  return { leadsTabs, opsTabs, audit, mails, logs,
    evalIn: expr => vm.runInContext(expr, sandbox),
    post: p => JSON.parse(sandbox.doPost({ postData: { contents: JSON.stringify(p) } }).getContent()) };
}

/* frequency biweekly + "First Clean" => CLEAN_STANDARD. */
const BASE = {
  event: 'quote_reserved', event_type: 'reservation',
  timestamp: '2026-07-28T14:00:00.000Z', submitted_at: '2026-07-28T14:00:00.000Z',
  zip: '02134', zip_tier: 'core', bedrooms: 2, bathrooms: 1,
  service: 'first_clean', service_type: 'first_clean', condition: 'standard',
  addon_total: 0, frequency_selected: 'biweekly',
  quote_price: 214, first_visit_total: 214,
  name: 'Test Customer', email: 'test.customer@example.com', phone: '(617) 555-0100',
  address: '123 Beacon St', unit: '4B',
  slot_date: '2026-08-14', slot_time: '9:00 AM',
};
let n = 0;
const post = (C, extra) => C.post(Object.assign({}, BASE, { submission_id: 'sd-' + (++n) }, extra || {}));

const bookedVendor = C => {
  const rows = C.opsTabs.AVAILABILITY._rows;
  for (let i = 1; i < rows.length; i++) if (rows[i][3] === 'booked') return rows[i][2];
  return null;
};
const jobsVendor = C => C.leadsTabs.JOBS._rows[1][JOBS_H.indexOf('vendor_id')];

/* ============================================================
   1. Nothing declared must behave exactly as it did before r16
   ============================================================ */
console.log('=== 1. an empty VENDOR_SERVICES tab changes nothing ===');
{
  const C = build({ services: [] });
  const r = post(C);
  t('slot booked', r.slot_action === 'booked', r.slot_action);
  t('first open row still wins', bookedVendor(C) === 'VEN-0001', bookedVendor(C));
  t('held row untouched', C.opsTabs.AVAILABILITY._rows[3][3] === 'held');
  t('no NEEDS A HUMAN flag on the notification',
    !/NEEDS A HUMAN/.test(C.mails.map(m => m.body).join('')));
}

console.log('\n=== 1b. a row with no vendor at all is ordinary, not broken ===');
{
  /* The common case on a sheet nobody has migrated yet, and the one that must
     not start nagging: an unassigned slot is missing information, not a
     mismatch. Ranking it as disqualified would flag every booking. */
  const C = build({ availSeed: [[cellDate(2026, 8, 14), '9:00 AM', '', 'open', '', '', '']] });
  const r = post(C);
  t('an unassigned slot still books', r.slot_action === 'booked', r.slot_action);
  t('and raises no flag', !/NEEDS A HUMAN/.test(C.mails.map(m => m.body).join('')));
  t('and stamps nothing onto JOBS', jobsVendor(C) === '', jobsVendor(C));
}

/* ============================================================
   2. Declaring services actually steers the choice
   ============================================================ */
console.log('\n=== 2a. a vendor who declared other work is skipped ===');
{
  const C = build({ services: [['VEN-0001','CLEAN_MOVEOUT','TRUE','preferred','TRUE','']] });
  post(C);
  t('VEN-0001 declared move-outs only, so VEN-0002 takes it',
    bookedVendor(C) === 'VEN-0002', bookedVendor(C));
}

console.log('\n=== 2b. preferred outranks an undeclared vendor ===');
{
  const C = build({ services: [['VEN-0002','CLEAN_STANDARD','TRUE','preferred','TRUE','']] });
  post(C);
  t('VEN-0002 wins on preference despite being second in the sheet',
    bookedVendor(C) === 'VEN-0002', bookedVendor(C));
}

console.log('\n=== 2c. avoid loses to neutral ===');
{
  const C = build({ services: [
    ['VEN-0001','CLEAN_STANDARD','TRUE','avoid','TRUE',''],
    ['VEN-0002','CLEAN_STANDARD','TRUE','neutral','TRUE',''],
  ] });
  post(C);
  t('neutral VEN-0002 beats avoid VEN-0001', bookedVendor(C) === 'VEN-0002', bookedVendor(C));
}

console.log('\n=== 2d. an inactive declaration does not count ===');
{
  const C = build({ services: [['VEN-0002','CLEAN_STANDARD','TRUE','preferred','FALSE','']] });
  post(C);
  t('inactive row ignored, sheet order stands', bookedVendor(C) === 'VEN-0001', bookedVendor(C));
}

/* ============================================================
   2f. r25 — UNASSIGNED CAPACITY
   ------------------------------------------------------------
   A row with an empty vendor_id is a time Serve is willing to promise before
   anybody is booked to work it. The customer picks it, the slot is held, and
   the search for a partner starts from a time they have already chosen.

   The rule that matters: it must LOSE to any real vendor who is free at that
   hour, and WIN over nobody at all. Until r25 it tied with an ordinary vendor
   and ties keep sheet order, so an empty row could beat a company sitting free
   purely for being higher up the tab. */
console.log('\n=== 2f. unassigned capacity ===');
{
  /* Unassigned first in the sheet, a real vendor second. Sheet order would
     give it to nobody; rank has to give it to the vendor. */
  const C = build({ availSeed: [
    [cellDate(2026, 8, 14), '9:00 AM', '',          'open', '', '', ''],
    [cellDate(2026, 8, 14), '9:00 AM', 'VEN-0001',  'open', '', '', ''],
  ] });
  post(C);
  t('a real vendor beats an unassigned row even from lower in the sheet',
    bookedVendor(C) === 'VEN-0001', bookedVendor(C));
}
{
  /* The case the feature exists for: nobody is free, but the time is offered
     anyway and the customer's slot is still secured. */
  const C = build({ availSeed: [
    [cellDate(2026, 8, 14), '9:00 AM', '', 'open', '', '', ''],
  ] });
  const res = post(C);
  t('an unassigned row still takes the booking', res.slot_action === 'booked',
    res.slot_action);
  t('and the slot is marked booked, so the time is genuinely held',
    C.opsTabs.AVAILABILITY._rows[1][3] === 'booked',
    C.opsTabs.AVAILABILITY._rows[1][3]);
  t('the job carries no vendor, which is what shows "coordinating"',
    !jobsVendor(C), jobsVendor(C));

  /* The operator notification for this case is asserted in portal.test.js,
     "ticketBlock tells three stories": this harness stubs TICKET_SECRET as
     null, so ticketBlock throws, is caught, and contributes nothing to the
     email at all. Asserting it here would have tested the stub. */
}
{
  /* An unassigned row is still better than sending work to a company that
     declared it does not do this service. */
  const C = build({
    availSeed: [
      [cellDate(2026, 8, 14), '9:00 AM', 'VEN-0001', 'open', '', '', ''],
      [cellDate(2026, 8, 14), '9:00 AM', '',         'open', '', '', ''],
    ],
    services: [['VEN-0001','CLEAN_STANDARD','FALSE','neutral','TRUE','']],
  });
  post(C);
  t('unassigned beats a vendor who does not offer the service',
    bookedVendor(C) === '', JSON.stringify(bookedVendor(C)));
}

console.log('\n=== 2e. ties keep sheet order ===');
{
  const C = build({ services: [
    ['VEN-0001','CLEAN_STANDARD','TRUE','preferred','TRUE',''],
    ['VEN-0002','CLEAN_STANDARD','TRUE','preferred','TRUE',''],
  ] });
  post(C);
  t('first row wins among equals', bookedVendor(C) === 'VEN-0001', bookedVendor(C));
}

/* ============================================================
   3. Nobody qualified: take the booking, flag it, never refuse
   ============================================================ */
console.log('\n=== 3. no qualified vendor is a flag, not a refusal ===');
{
  const C = build({
    availSeed: [[cellDate(2026, 8, 14), '9:00 AM', 'VEN-0001', 'open', '', '', '']],
    services:  [['VEN-0001','CLEAN_MOVEOUT','TRUE','preferred','TRUE','']],
  });
  const r = post(C);
  t('booking still succeeds', r.slot_action === 'booked', r.slot_action);
  t('slot still marked booked', bookedVendor(C) === 'VEN-0001');
  const body = C.mails.map(m => m.body).join('');
  t('notification says it needs a human', /NEEDS A HUMAN/.test(body));
  t('and names the service it cannot do', /CLEAN_STANDARD/.test(body));
  t('JOBS still records who is holding it', jobsVendor(C) === 'VEN-0001', jobsVendor(C));
}

/* ============================================================
   4. The rename is not a flag day
   ============================================================ */
console.log('\n=== 4. the column is read under either name ===');
{
  const C = build({ availHeaders: AVAIL_CLN,
    availSeed: [[cellDate(2026, 8, 14), '9:00 AM', 'VEN-0007', 'open', '', '', '']] });
  const r = post(C);
  t('a sheet still headed cleaner_id books fine', r.slot_action === 'booked', r.slot_action);
  t('and its value reaches JOBS.vendor_id', jobsVendor(C) === 'VEN-0007', jobsVendor(C));
}
{
  const C = build({ availSeed: [[cellDate(2026, 8, 14), '9:00 AM', 'VEN-0008', 'open', '', '', '']] });
  post(C);
  t('a sheet headed vendor_id books fine too', jobsVendor(C) === 'VEN-0008', jobsVendor(C));
}

/* ============================================================
   5. The stamp fills a blank and never argues
   ============================================================ */
console.log('\n=== 5. stampJobVendor ===');
{
  const C = build();
  post(C);
  t('vendor_id written onto the new JOBS row', jobsVendor(C) === 'VEN-0001', jobsVendor(C));
  t('operator_id deliberately left blank — the vendor picks the person',
    C.leadsTabs.JOBS._rows[1][JOBS_H.indexOf('operator_id')] === '');
}
{
  /* A dispatcher already decided. An inference from the schedule must not win. */
  const C = build();
  post(C);
  const before = jobsVendor(C);
  const changed = C.evalIn('stampJobVendor(SpreadsheetApp.getActiveSpreadsheet()' +
                           '.getSheetByName("JOBS"), 2, "VEN-9999")');
  t('a second stamp is refused', changed === false, changed);
  t('the existing value stands', jobsVendor(C) === before, jobsVendor(C));
}
{
  /* Every JOBS tab is in this state until the column is added. */
  const noCol = JOBS_H.filter(h => h !== 'vendor_id');
  const C = build({ jobsHeaders: noCol });
  const r = post(C);
  t('a JOBS tab with no vendor_id column still books', r.slot_action === 'booked', r.slot_action);
  t('and logs no error', !C.logs.some(l => /stamp failed/.test(l)), C.logs.filter(l => /ERR/.test(l)));
}

/* ============================================================
   6. A broken VENDOR_SERVICES tab must never cost a booking
   ============================================================ */
console.log('\n=== 6. missing supply data degrades, never blocks ===');
{
  const C = build({ services: [['VEN-0001','NOT_A_SERVICE','TRUE','preferred','TRUE','']] });
  const r = post(C);
  t('an unknown service_code is ignored, not obeyed', r.slot_action === 'booked', r.slot_action);
  t('vendor treated as undeclared, sheet order stands', bookedVendor(C) === 'VEN-0001', bookedVendor(C));
}

console.log(bad ? '\n' + bad + ' FAILED' : '\nall slot-dispatch checks passed');
process.exit(bad ? 1 : 0);
