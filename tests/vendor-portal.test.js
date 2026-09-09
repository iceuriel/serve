/* The vendor portal — one partner company, their jobs and their profile.
   ==================================================================
   What this file exists to prove, in order of how badly it would hurt:

     1. A VENDOR MAY DESCRIBE THEMSELVES, NOT PROMOTE THEMSELVES. Rating,
        review count, insurance_verified, client_visible, status, partner_since
        and anything internal are Serve's. The write path is a WHITELIST, so a
        column added to VENDORS next month is not editable by accident.

     2. ONE VENDOR SEES AND TOUCHES ONLY THEIR OWN. Their jobs, their team.
        Two vendors are seeded so that is tested rather than assumed.

     3. NO CUSTOMER PRICE AND NO CUSTOMER CONTACT reaches a vendor. They see
        their payout; the margin is the model and the contact routes through
        Serve.

   The vendor tabs live in the OPS workbook, so the harness gives openById two
   different books and asserts the code reaches the right one. */

const REPO_ROOT = require('path').resolve(__dirname, '..');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(REPO_ROOT, 'apps-script', 'webhook.gs'), 'utf8');
const OPS_ID = (SRC.match(/OPS_SPREADSHEET_ID\s*=\s*"([^"]+)"/) || [])[1];

let bad = 0;
const t = (label, cond, extra) => {
  console.log((cond ? '  ok    ' : '  FAIL  ') + label +
              (extra !== undefined ? '  ->  ' + JSON.stringify(extra) : ''));
  if (!cond) bad++;
};
const head = (m) => console.log('\n=== ' + m + ' ===');

const JOBS_HEADERS = ['job_id','lead_id','service_type','frequency','condition','beds','baths',
  'quoted_price','add_ons','add_on_rev','final_price','scheduled_date','completed_date','cleaner',
  'start_time','payment_status','job_status','notes','submission_id','name','email','phone',
  'customer_notes','pets_flag','address','unit','zip','quote_meta','property_id','contact_id',
  'partner_payout','vendor_id','operator_id'];

const VENDORS_HEADERS = ['vendor_id','status','legal_name','display_name','internal_contact_name',
  'internal_phone','internal_email','logo_url','public_description','partner_since',
  'insurance_verified','service_area','capabilities','public_rating','public_review_count',
  'rating_source','client_visible','default_payout_rate','created_at','updated_at'];

const VS_HEADERS = ['vendor_id','service_code','offers','preference','active','notes'];
const OP_HEADERS = ['operator_id','vendor_id','public_display_name','first_name','last_initial',
  'photo_url','role','years_experience','specialties','active','show_to_customer',
  'serve_rating','serve_jobs_completed'];

function makeSheet(name, headers) {
  const rows = headers ? [headers.slice()] : [];
  return {
    _name: name, _rows: rows,
    getName: () => name,
    getLastColumn: () => (rows[0] ? rows[0].length : 0),
    getLastRow: () => rows.length,
    appendRow: r => rows.push(r.slice()),
    setFrozenRows: () => {},
    getDataRange: () => ({ getValues: () => rows.map(r => r.slice()) }),
    getRange: (r, c, nr, nc) => ({
      getValues: () => {
        const o = [];
        for (let i = 0; i < (nr || 1); i++) {
          const row = rows[r - 1 + i] || [];
          o.push(row.slice(c - 1, c - 1 + (nc || 1)));
        }
        return o;
      },
      getNumberFormats: () => Array.from({ length: nr || 1 }, () => new Array(nc || 1).fill('')),
      setValue: v => {
        while (rows.length < r) rows.push([]);
        while (rows[r - 1].length < c) rows[r - 1].push('');
        rows[r - 1][c - 1] = v;
      },
    }),
  };
}

const leadsTabs = { JOBS: makeSheet('JOBS', JOBS_HEADERS) };
const opsTabs = {
  VENDORS:         makeSheet('VENDORS', VENDORS_HEADERS),
  VENDOR_SERVICES: makeSheet('VENDOR_SERVICES', VS_HEADERS),
  OPERATORS:       makeSheet('OPERATORS', OP_HEADERS),
};
const logs = [];
const leadsBook = { getSheetByName: n => leadsTabs[n] || null,
                    insertSheet: n => (leadsTabs[n] = makeSheet(n, null)) };
const opsBookStub = { getSheetByName: n => opsTabs[n] || null,
                      insertSheet: n => (opsTabs[n] = makeSheet(n, null)) };

const box = {
  console: { log: m => logs.push(String(m)), warn: m => logs.push(String(m)),
             error: m => logs.push(String(m)), info: () => {} },
  JSON, Date, Math, String, Number, Boolean, Array, Object, RegExp, isNaN, parseInt, parseFloat,
  /* The vendor tabs are in a DIFFERENT workbook. Handing back the wrong book
     for the wrong id is how this test proves the code opens Ops rather than
     reading Leads. */
  SpreadsheetApp: {
    openById: (idArg) => (idArg === OPS_ID ? opsBookStub : leadsBook),
    getActiveSpreadsheet: () => leadsBook,
  },
  PropertiesService: {
    getScriptProperties: () => {
      const store = { TICKET_SECRET: 'test-secret' };
      return { getProperty: k => store[k] || null, setProperty: (k, v) => { store[k] = v; } };
    },
  },
  Utilities: {
    computeHmacSha256Signature: (msg) => {
      const h = require('crypto').createHmac('sha256', 'test').update(String(msg)).digest();
      return [...h].map(b => (b > 127 ? b - 256 : b));
    },
    getUuid: () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    formatDate: (d) => String(d),
  },
  MailApp: { sendEmail: () => {} },
  ContentService: {
    createTextOutput: (s) => ({ _s: s, setMimeType() { return this; }, getContent() { return this._s; } }),
    MimeType: { JSON: 'application/json' },
  },
  LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
};
box.globalThis = box;
vm.createContext(box);
vm.runInContext(SRC, box);
const S = box;

/* ---- seed two vendors, so isolation is tested rather than assumed ---- */
function seedVendor(id, name, over) {
  const row = new Array(VENDORS_HEADERS.length).fill('');
  const set = (k, v) => { row[VENDORS_HEADERS.indexOf(k)] = v; };
  set('vendor_id', id); set('status', 'active'); set('display_name', name);
  set('legal_name', name + ' LLC'); set('internal_phone', '617-555-0199');
  /* example.com is RFC-reserved and is what privacy.test.js allows in
     fixtures. A .test domain trips that guard, and the guard is right to trip:
     it exists so a real customer address cannot hide in the repo, including in
     a test file. */
  set('internal_email', 'ops-' + id.toLowerCase() + '@example.com');
  set('public_rating', 4.8); set('public_review_count', 31);
  set('insurance_verified', true); set('client_visible', true);
  set('default_payout_rate', 45); set('partner_since', '2024');
  Object.keys(over || {}).forEach(k => set(k, over[k]));
  opsTabs.VENDORS.appendRow(row);
}
function seedJob(jobId, vendorId, over) {
  const row = new Array(JOBS_HEADERS.length).fill('');
  const set = (k, v) => { row[JOBS_HEADERS.indexOf(k)] = v; };
  set('job_id', jobId); set('vendor_id', vendorId); set('lead_id', 'cust@example.com');
  set('service_type', 'First Clean'); set('frequency', 'once');
  set('beds', 2); set('baths', 1);
  set('quoted_price', 279); set('partner_payout', 150);
  set('scheduled_date', '2026-09-20'); set('start_time', '9-11 AM');
  set('address', '123 Beacon St'); set('unit', '4B'); set('zip', '02116');
  set('name', 'Uriel Lopez'); set('email', 'cust@example.com'); set('phone', '6175550100');
  Object.keys(over || {}).forEach(k => set(k, over[k]));
  leadsTabs.JOBS.appendRow(row);
}
function seedOperator(opId, vendorId, name) {
  const row = new Array(OP_HEADERS.length).fill('');
  const set = (k, v) => { row[OP_HEADERS.indexOf(k)] = v; };
  set('operator_id', opId); set('vendor_id', vendorId);
  set('public_display_name', name); set('active', true);
  set('serve_rating', 4.9); set('serve_jobs_completed', 12);
  opsTabs.OPERATORS.appendRow(row);
}

seedVendor('VEN-0001', 'Beacon Hill Cleaning Co.');
seedVendor('VEN-0002', 'Rival Cleaners');
seedJob('SRV-20260920-AAAAAA', 'VEN-0001');
seedJob('SRV-20260810-BBBBBB', 'VEN-0001', { completed_date: '2026-08-11', scheduled_date: '2026-08-10' });
seedJob('SRV-20260915-CCCCCC', 'VEN-0002');
seedOperator('OPR-0001', 'VEN-0001', 'Maria R.');
seedOperator('OPR-0099', 'VEN-0002', 'Someone Else');

const MINE   = S.vendorToken('VEN-0001');
const THEIRS = S.vendorToken('VEN-0002');
const get  = (q) => JSON.parse(S.doGet({ parameter: q }).getContent());
const post = (o) => JSON.parse(S.doPost({ postData: { contents: JSON.stringify(o) } }).getContent());
const write = (o, tok, vid) => post(Object.assign(
  { event_type: 'vendor_write', vendor_id: vid || 'VEN-0001', t: tok || MINE }, o));

/* ------------------------------------------------------------------ */
head('1. A fourth audience, a fourth scope');
t('a vendor token is produced', typeof MINE === 'string' && MINE.length === 20, MINE);
t('two vendors get different tokens', MINE !== THEIRS);
t('it is not a portal token', MINE !== S.portalToken('VEN-0001'));
t('it is not a ticket token',
  MINE !== S.ticketToken('VEN-0001', 'client') && MINE !== S.ticketToken('VEN-0001', 'partner'));
t('the id alone opens nothing', get({ vendor: 'VEN-0001' }).ok === false);
t('a wrong token opens nothing', get({ vendor: 'VEN-0001', t: 'f'.repeat(20) }).ok === false);
t('an unknown vendor looks identical to a bad token',
  get({ vendor: 'VEN-9999', t: S.vendorToken('VEN-9999') }).error ===
  get({ vendor: 'VEN-0001', t: 'f'.repeat(20) }).error);

/* ------------------------------------------------------------------ */
head('2. It reads the OPS workbook, not Leads MASTER');
const V = get({ vendor: 'VEN-0001', t: MINE });
t('the portal opens', V.ok === true, V.error);
t('and found the company in Ops', V.company.displayName === 'Beacon Hill Cleaning Co.',
  V.company.displayName);
t('VENDORS is not in Leads MASTER', !leadsTabs.VENDORS);

/* ------------------------------------------------------------------ */
head('3. One vendor, their own jobs and team only');
t('two jobs, both theirs', (V.bookings || []).length === 2,
  (V.bookings || []).map(b => b.bookingId));
t('none of the other vendor\'s', !JSON.stringify(V).includes('CCCCCC'));
t('their team only', (V.team || []).length === 1 && V.team[0].operatorId === 'OPR-0001',
  (V.team || []).map(o => o.operatorId));
t('the rival sees only theirs',
  JSON.stringify(get({ vendor: 'VEN-0002', t: THEIRS }).bookings).includes('CCCCCC'));

/* ------------------------------------------------------------------ */
head('4. NO CUSTOMER PRICE, NO CUSTOMER CONTACT');
const vJson = JSON.stringify(V);
t('the vendor sees their payout', V.bookings[0].payout === 150, V.bookings[0].payout);
t('and NOT the customer price', !vJson.includes('279'), vJson.slice(0, 160));
t('no customer name', !vJson.includes('Uriel'));
t('no customer email', !vJson.includes('cust@example.com'));
t('no customer phone', !vJson.includes('6175550100'));
t('and not their own internal contact details either',
  !vJson.includes('617-555-0199') && !vJson.includes('ops-ven-0001@example.com'));
t('nor the payout rate Serve negotiated', !vJson.includes('"defaultPayoutRate"'));

/* ------------------------------------------------------------------ */
head('5. THE WRITE WHITELIST');
t('they can set their display name',
  write({ kind: 'profile', field: 'display_name', value: 'Beacon Hill Cleaning' }).ok === true);
t('and their description',
  write({ kind: 'profile', field: 'public_description', value: 'Back Bay specialists.' }).ok === true);
t('and what they specialise in',
  write({ kind: 'profile', field: 'capabilities', value: 'luxury, pet-safe' }).ok === true);

/* The ones that would let a partner promote themselves. */
[['public_rating', '5'], ['public_review_count', '999'], ['insurance_verified', 'TRUE'],
 ['client_visible', 'TRUE'], ['status', 'active'], ['partner_since', '2010'],
 ['logo_url', '/images/x.png'], ['default_payout_rate', '999'],
 ['internal_email', 'x@y.z'], ['legal_name', 'Something Else LLC']].forEach(pair => {
  t('CANNOT set ' + pair[0],
    write({ kind: 'profile', field: pair[0], value: pair[1] }).error === 'not_editable');
});

const vRow = opsTabs.VENDORS._rows[1];
t('and the rating on the row is untouched',
  vRow[VENDORS_HEADERS.indexOf('public_rating')] === 4.8,
  vRow[VENDORS_HEADERS.indexOf('public_rating')]);
t('the display name did change',
  vRow[VENDORS_HEADERS.indexOf('display_name')] === 'Beacon Hill Cleaning');

/* ------------------------------------------------------------------ */
head('6. Services are Serve\'s codes, never free text');
t('a real code saves',
  write({ kind: 'service', service_code: 'CLEAN_DEEP',
          offers: true, preference: 'preferred' }).ok === true);
t('an invented service is refused',
  write({ kind: 'service', service_code: 'CLEAN_LUXURY',
          offers: true }).error === 'unknown_service');
t('a nonsense preference falls back to neutral rather than storing itself',
  write({ kind: 'service', service_code: 'CLEAN_MOVEOUT',
          offers: true, preference: 'only-on-tuesdays' }).ok === true);

const V2 = get({ vendor: 'VEN-0001', t: MINE });
const svc = (c) => (V2.services || []).filter(s => s.serviceCode === c)[0] || {};
t('all three Serve services are offered to the form', (V2.services || []).length === 3,
  (V2.services || []).map(s => s.serviceCode));
t('the saved preference reads back', svc('CLEAN_DEEP').preference === 'preferred');
t('the nonsense one became neutral', svc('CLEAN_MOVEOUT').preference === 'neutral');

/* ------------------------------------------------------------------ */
head('7. THE OWNERSHIP CHECK ON TEAM MEMBERS');
t('they can edit their own operator',
  write({ kind: 'operator', operator_id: 'OPR-0001', role: 'Lead cleaner' }).ok === true);
t('CANNOT edit a rival\'s operator',
  write({ kind: 'operator', operator_id: 'OPR-0099', role: 'Hijacked' }).ok === false);
t('and the rival\'s row is untouched',
  opsTabs.OPERATORS._rows[2][OP_HEADERS.indexOf('role')] !== 'Hijacked',
  opsTabs.OPERATORS._rows[2][OP_HEADERS.indexOf('role')]);
t('an unknown operator id is refused',
  write({ kind: 'operator', operator_id: 'OPR-7777', role: 'x' }).ok === false);
t('serve_rating is not writable through the operator path',
  (write({ kind: 'operator', operator_id: 'OPR-0001', serve_rating: 5 }).fields || [])
    .indexOf('serve_rating') === -1);
t('and the rating on the row is untouched',
  opsTabs.OPERATORS._rows[1][OP_HEADERS.indexOf('serve_rating')] === 4.9);

/* ------------------------------------------------------------------ */
head('8. The customer still never sees an individual');
/* The decision of 2026-09-08: Serve introduces a company, not a person. The
   roster exists for dispatch and for the vendor's own view. */
seedJob('SRV-20260925-DDDDDD', 'VEN-0001', { operator_id: 'OPR-0001' });
const clientTicket = get({ job: 'SRV-20260925-DDDDDD',
  t: S.ticketToken('SRV-20260925-DDDDDD', 'client'), view: 'client' });
const ctJson = JSON.stringify(clientTicket);
t('the client ticket opens', clientTicket.ok === true, clientTicket.error);
t('it names the COMPANY',
  clientTicket.partner && clientTicket.partner.displayName === 'Beacon Hill Cleaning',
  clientTicket.partner);
t('and never the individual', !ctJson.includes('Maria'), ctJson.slice(0, 200));
t('nor the vendor\'s internal phone', !ctJson.includes('617-555-0199'));

console.log('\n' + (bad ? bad + ' FAILURES' : 'ALL ASSERTIONS PASSED'));
process.exit(bad ? 1 : 0);
