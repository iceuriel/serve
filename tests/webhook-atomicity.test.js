/* Part 8: address/unit/zip real columns + the two confirmations.
   Confirmation 1 — reportLeadsSchema() is read-only: proven with a mock that
   THROWS on every mutating Sheets method.
   Confirmation 2 — the JOBS write is atomic: proven by counting appendRow calls,
   asserting the row is complete before the single call, and forcing failures. */
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

const LEADS_FULL = ['lead_id','name','email','phone','source','segment','source_history','created_at'];

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

/** Strict Utilities.formatDate stand-in — throws on an unknown pattern. */
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

let bad = 0;
const t = (label, cond, extra) => {
  console.log((cond ? '  ok    ' : '  FAIL  ') + label + (extra !== undefined ? '  ->  ' + JSON.stringify(extra) : ''));
  if (!cond) bad++;
};

/* ---------- sheet mock with an audit trail ---------- */
function makeSheet(name, headers, audit, opts) {
  const o = opts || {};
  const rows = headers === null ? [] : [headers.slice()];
  return { _name: name, _rows: rows,
    getName: () => name,
    getLastColumn: () => (rows[0] ? rows[0].length : 0),
    getLastRow: () => rows.length,
    appendRow: (r) => {
      audit.push({ tab: name, op: 'appendRow', len: r.length, row: r.slice() });
      if (o.appendThrows) throw new Error('simulated Sheets outage during appendRow');
      rows.push(r.slice());
    },
    setFrozenRows: () => audit.push({ tab: name, op: 'setFrozenRows' }),
    /* r44: readTable/sheetValues read a whole tab in one call, the way real
       Sheets does. Without this stub the booking path threw inside the
       harness only — and reported LEADS as failed rather than the stub. */
    getDataRange: () => ({ getValues: () => rows.map(r => r.slice()) }),
    getRange: (r, c, nr, nc) => ({
      getValues: () => { const out = []; for (let i = 0; i < nr; i++) { const row = rows[r-1+i] || []; out.push(row.slice(c-1, c-1+nc)); } return out; },
      setValue: (v) => {
        audit.push({ tab: name, op: 'setValue', r, c, v });
        while (rows[r-1].length < c) rows[r-1].push('');
        rows[r-1][c-1] = v;
      },
    }) };
}

function build(cfg) {
  const c = cfg || {};
  const audit = [], mails = [], logs = [];
  // Held by reference so a test can clear the simulated outage mid-run.
  const jobsOpts = { appendThrows: c.jobsAppendThrows };
  const tabs = {
    JOBS:  makeSheet('JOBS', c.jobsHeaders || JOBS_36, audit, jobsOpts),
    LEADS: makeSheet('LEADS', LEADS_FULL, audit),
  };
  const ssObj = {
    getSheetByName: n => tabs[n] || null,
    insertSheet: n => (tabs[n] = makeSheet(n, null, audit)),
    getSheets: () => Object.values(tabs),
  };
  const sandbox = {
    console: { log: m => logs.push(String(m)), warn: m => logs.push('WARN ' + m), error: m => logs.push('ERR ' + m) },
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
  return { tabs, audit, mails, logs, sandbox, jobsOpts,
    post: p => JSON.parse(sandbox.doPost({ postData: { contents: JSON.stringify(p) } }).getContent()) };
}

const BOOKING = {
  event: 'quote_reserved', event_type: 'reservation',
  timestamp: '2026-07-27T15:00:00.000Z', submitted_at: '2026-07-27T15:00:00.000Z',
  submission_id: 'uuid-addr-1',
  zip: '02134', zip_tier: 'core', bedrooms: 2, bathrooms: 1,
  service: 'first_clean', service_type: 'first_clean', condition: 'standard',
  addon_fridge: true, addon_oven: false, modifiers_applied: ['Inside the fridge'],
  addon_total: 45, frequency_selected: 'biweekly',
  quote_price: 214, first_visit_total: 214, original_price: 383,
  discount_applied: 'First clean 50% off', steady_state_price: 122,
  recurring_weekly: 111, recurring_biweekly: 122, recurring_monthly: 142,
  name: 'Test Customer', email: 'test.customer@example.com', phone: '(617) 555-0100',
  address: '123 Beacon St', unit: '4B', unit_label: '2 BR / 1 BA',
  src: 'qr-allston-01', src_first: 'qr-allston-01', src_chain: 'qr-allston-01',
  segment: 'qr_code', utm_source: 'poster', utm_medium: 'print', page_path: '/',
  slot_date: '2026-08-14', slot_time: '9-11 AM',
  schedule_preference_label: 'Friday, Aug 14 at 9-11 AM',
  customer_notes: 'Friendly dog. Park in the driveway.', pets_flag: true,
};

/* ============================================================
   1. address / unit / zip get REAL COLUMNS
   ============================================================ */
console.log('=== 1. address / unit / zip -> real columns (36-col JOBS) ===');
const A = build({});
console.log('  ' + JSON.stringify(A.post(BOOKING)));
const J = A.tabs.JOBS, h = n => JOBS_36.indexOf(n);
const row = J._rows[1];

t('still 36 columns', J._rows[0].length === 36, J._rows[0].length);
t('header row byte-identical', J._rows[0].join('|') === JOBS_36.join('|'));
t('address in its own column', row[h('address')] === '123 Beacon St', row[h('address')]);
t('unit in its own column',    row[h('unit')] === '4B', row[h('unit')]);
t('zip in its own column',     row[h('zip')] === '02134', row[h('zip')]);

const meta = JSON.parse(row[h('quote_meta')]);
console.log('  quote_meta -> ' + JSON.stringify(meta, null, 0));
t('quote_meta EXCLUDES address', !('address' in meta));
t('quote_meta EXCLUDES unit',    !('unit'    in meta));
t('quote_meta EXCLUDES zip',     !('zip'     in meta));
const WANT_META = ['original_price','discount_applied','steady_state_price','recurring_weekly',
  'recurring_biweekly','recurring_monthly','zip_tier','page_path','utm_source','utm_medium',
  'unit_label','src','submitted_at'];
t('quote_meta carries every secondary field present', WANT_META.every(k => k in meta),
  WANT_META.filter(k => !(k in meta)));
/* `payout_rate` is stamped by the server, not sent by the browser, so it is
   here rather than in WANT_META — that list is what a payload carries in. */
const ALSO_META = ['utm_campaign', 'payout_rate'];
t('quote_meta has nothing unexpected',
  Object.keys(meta).every(k => WANT_META.concat(ALSO_META).includes(k)),
  Object.keys(meta).filter(k => !WANT_META.concat(ALSO_META).includes(k)));

/* r24 — THE SHARE IS STAMPED, AND THE BROWSER DOES NOT GET A VOTE.
   Every partner surface reads the stamped value rather than the live setting,
   so changing the rate tomorrow cannot reprice a job already accepted. That
   only holds if what lands here came from the server. */
/* 2026-09-16 — AND WHICH OF THE TWO SHARES IS STAMPED DEPENDS ON THE HOME.
   BOOKING is a 2BR standard first clean, so it takes the half price and the
   partner is paid the passthrough share: a 50% discount cannot be funded out
   of a 15% margin, so Serve keeps 2% on that visit and earns on the recurring
   ones. See payoutRateFor() in webhook.gs, and payout-discount-parity.test.js
   for the rule locked against the pricing engine. */
t('a half-price first clean stamps the passthrough share',
  meta.payout_rate === 0.98, meta.payout_rate);
{
  const move = A.post(Object.assign({}, BOOKING, {
    submission_id: 'payout-move-1', service: 'move_out', service_type: 'move_out',
  }));
  const moveRow  = A.tabs.JOBS._rows.find(r => r[h('submission_id')] === 'payout-move-1');
  const moveMeta = JSON.parse(moveRow[h('quote_meta')]);
  /* A move clean is discounted 15%, not 50%, so the ordinary share already
     leaves the partner above cost. Asserted through doPost rather than by
     calling payoutRateFor directly — the wiring is the part that broke last
     time, not the rule. */
  t('a move clean stamps the ORDINARY share', moveMeta.payout_rate === 0.85,
    moveMeta.payout_rate);
  t('and the two really are different end to end, or neither assertion means '
    + 'anything', meta.payout_rate !== moveMeta.payout_rate,
    [meta.payout_rate, moveMeta.payout_rate]);
}
{
  const sneaky = A.post(Object.assign({}, BOOKING,
    { submission_id: 'payout-forge-1', payout_rate: 0.99 }));
  const forged = A.tabs.JOBS._rows.find(r => r[h('submission_id')] === 'payout-forge-1');
  const forgedMeta = JSON.parse(forged[h('quote_meta')]);
  t('a payload cannot set its own payout rate', forgedMeta.payout_rate === 0.98,
    forgedMeta.payout_rate);

  /* THE FORGERY THAT PAYS: claim the half-price discount on a move clean and
     collect the passthrough share on an undiscounted ticket. The rate is
     re-derived from the home, so the claim is ignored. */
  A.post(Object.assign({}, BOOKING, {
    submission_id: 'payout-forge-2', service: 'move_out', service_type: 'move_out',
    discount_applied: 'First clean 50% off', payout_rate: 0.98,
  }));
  const forged2 = A.tabs.JOBS._rows.find(r => r[h('submission_id')] === 'payout-forge-2');
  const meta2   = JSON.parse(forged2[h('quote_meta')]);
  t('nor talk its way onto the passthrough share by claiming a discount',
    meta2.payout_rate === 0.85, meta2.payout_rate);
}
t('property_key still populated alongside the address',
  row[h('property_key')] === '02134-123-BEACON-ST-4B', row[h('property_key')]);
t('nothing dropped', A.post(Object.assign({}, BOOKING, { submission_id: 'x2' })).dropped_fields.length === 0);

/* fallback: address column missing but quote_meta present */
console.log('\n--- fallback: no address column, quote_meta present ---');
const noAddr = JOBS_36.filter(x => x !== 'address');
const B = build({ jobsHeaders: noAddr });
B.post(BOOKING);
const bMeta = JSON.parse(B.tabs.JOBS._rows[1][noAddr.indexOf('quote_meta')]);
t('address falls back into quote_meta rather than vanishing', bMeta.address === '123 Beacon St', bMeta.address);
t('fallback is logged', B.logs.some(l => /No "address" column/.test(l)));
t('unit and zip still in their own columns',
  B.tabs.JOBS._rows[1][noAddr.indexOf('unit')] === '4B' && B.tabs.JOBS._rows[1][noAddr.indexOf('zip')] === '02134');

/* neither column: must be reported, not silent */
console.log('\n--- neither address nor quote_meta column ---');
const bare = JOBS_36.filter(x => x !== 'address' && x !== 'quote_meta');
const C = build({ jobsHeaders: bare });
C.post(BOOKING);
t('drop is logged explicitly', C.logs.some(l => /No quote_meta column — DROPPED: address/.test(l)),
  C.logs.filter(l => /DROPPED/.test(l))[0]);
t('booking still written', C.tabs.JOBS._rows.length - 1 === 1);

/* ============================================================
   2. CONFIRMATION 1 — reportLeadsSchema() is READ-ONLY
   Hostile mock: every mutating method throws.
   ============================================================ */
console.log('\n=== 2. CONFIRMATION 1 — reportLeadsSchema() read-only ===');
const violations = [];
function readOnlySheet(name, headers) {
  const rows = [headers.slice()];
  const boom = (op) => () => { violations.push(name + '.' + op); throw new Error('MUTATION ATTEMPTED: ' + name + '.' + op); };
  return {
    getName: () => name,
    getLastColumn: () => rows[0].length,
    getLastRow: () => rows.length,
    getRange: () => ({
      getValues: () => [rows[0].slice()],
      setValue: boom('setValue'), setValues: boom('setValues'),
      clear: boom('clear'), clearContent: boom('clearContent'),
    }),
    appendRow: boom('appendRow'),
    insertColumns: boom('insertColumns'), insertColumnAfter: boom('insertColumnAfter'),
    deleteColumn: boom('deleteColumn'), deleteRow: boom('deleteRow'),
    setFrozenRows: boom('setFrozenRows'), clear: boom('clear'),
    setName: boom('setName'), hideColumn: boom('hideColumn'),
  };
}
const roTabs = {
  JOBS:  readOnlySheet('JOBS', JOBS_36),
  LEADS: readOnlySheet('LEADS', LEADS_FULL),
};
const roLogs = [];
const roSs = {
  getSheetByName: n => roTabs[n] || null,
  getSheets: () => Object.values(roTabs),
  insertSheet: n => { violations.push('ss.insertSheet(' + n + ')'); throw new Error('MUTATION ATTEMPTED: insertSheet'); },
};
const roSandbox = {
  console: { log: m => roLogs.push(String(m)), warn: m => roLogs.push('WARN ' + m), error: m => roLogs.push('ERR ' + m) },
  SpreadsheetApp: { openById: () => roSs, getActiveSpreadsheet: () => roSs },
  ContentService: { MimeType: { JSON: 'json' }, createTextOutput: s => ({ getContent: () => s, setMimeType() { return this; } }) },
  MailApp: { sendEmail: () => { violations.push('MailApp.sendEmail'); } },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  Session: { getScriptTimeZone: () => 'America/New_York', getEffectiveUser: () => ({ getEmail: () => 'ops@example.com' }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
  Utilities: { formatDate: () => '' },
};
vm.createContext(roSandbox);
vm.runInContext(SRC, roSandbox);

let threw = null;
try { roSandbox.reportLeadsSchema(); } catch (e) { threw = e.message; }
console.log('  --- its output ---');
roLogs.forEach(l => l.split('\n').forEach(x => console.log('    ' + x)));
t('completed without throwing', threw === null, threw);
t('ZERO mutation attempts', violations.length === 0, violations);
t('no email sent', !violations.includes('MailApp.sendEmail'));
t('it did report the LEADS header row', roLogs.some(l => /LEADS row 1/.test(l)));

/* ============================================================
   3. CONFIRMATION 2 — the JOBS write is ATOMIC
   ============================================================ */
console.log('\n=== 3. CONFIRMATION 2 — JOBS write atomicity ===');
const D = build({});
D.post(BOOKING);
const jobsOps = D.audit.filter(a => a.tab === 'JOBS');
console.log('  JOBS operations for one submission: ' + JSON.stringify(jobsOps.map(o => o.op)));
t('exactly ONE write op on JOBS', jobsOps.length === 1, jobsOps.map(o => o.op));
t('that op is appendRow (never per-cell setValue)', jobsOps[0].op === 'appendRow');
t('the row handed to appendRow is already COMPLETE (36 cells)', jobsOps[0].len === 36, jobsOps[0].len);
t('no setValue on JOBS at any point', !D.audit.some(a => a.tab === 'JOBS' && a.op === 'setValue'));

/* Force appendRow to fail: must be all-or-nothing. Then clear the outage on the
   SAME sheet and retry, which is what really happens in production. */
console.log('\n--- forced Sheets outage during the JOBS append ---');
const E = build({ jobsAppendThrows: true });
const eRes = E.post(BOOKING);
console.log('  response -> ' + JSON.stringify(eRes));
t('returns status error, not a false ok', eRes.status === 'error');
t('NO row written — not even a partial one', E.tabs.JOBS._rows.length === 1, E.tabs.JOBS._rows.length - 1);
t('appendRow was attempted exactly once', E.audit.filter(a => a.tab === 'JOBS' && a.op === 'appendRow').length === 1);
t('the attempted row was still a complete 36-cell array',
  E.audit.find(a => a.tab === 'JOBS').len === 36);

console.log('\n--- retry on the SAME sheet once the outage clears ---');
E.jobsOpts.appendThrows = false;
const fRes = E.post(BOOKING);
console.log('  response -> ' + JSON.stringify(fRes));
t('same submission_id now writes cleanly (dedupe did not block it)',
  fRes.status === 'ok' && fRes.duplicate === false);
t('exactly one row after the retry', E.tabs.JOBS._rows.length - 1 === 1, E.tabs.JOBS._rows.length - 1);
t('that row is complete', E.tabs.JOBS._rows[1].length === 36);
t('a further replay IS deduped', E.post(BOOKING).duplicate === true);
t('still exactly one row', E.tabs.JOBS._rows.length - 1 === 1);

/* LEADS is multi-setValue by nature — state that honestly. */
console.log('\n--- LEADS write shape (for the record) ---');
const G = build({});
G.post(BOOKING);
const created = G.audit.filter(a => a.tab === 'LEADS').map(o => o.op);
G.post(Object.assign({}, BOOKING, { submission_id: 'uuid-2', src: 'ig-story-07', phone: '' }));
const afterMatch = G.audit.filter(a => a.tab === 'LEADS').map(o => o.op);
console.log('  create path: ' + JSON.stringify(created));
console.log('  match path:  ' + JSON.stringify(afterMatch.slice(created.length)));
t('LEADS create is a single appendRow (atomic)', created.length === 1 && created[0] === 'appendRow');
t('LEADS match path uses setValue (NOT atomic — documented)',
  afterMatch.slice(created.length).every(o => o === 'setValue'));

console.log('\n' + (bad ? 'FAILURES: ' + bad : 'ALL ASSERTIONS PASSED'));
process.exit(bad ? 1 : 0);
