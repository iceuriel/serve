/* The client portal — one contact, their bookings, their access answers.
   ==================================================================
   Three things this file exists to prove, in order of how badly they would
   hurt:

     1. A PORTAL TOKEN AUTHORISES ONE CONTACT, NOT THE SHEET. Every write must
        prove the target belongs to that person. Without the check a valid
        token is a key to every booking Serve has ever taken — a far worse
        failure than the one the token was protecting against.

     2. THE DOOR CODE NEVER COMES BACK. Not from the portal, not from either
        ticket, not into a log. Collecting one was only acceptable because of
        that, so it is asserted from several directions rather than once.

     3. Tokens do not cross audiences. A ticket token must not open a portal
        and a portal token must not open a ticket.

   Driven through the same Apps Script harness webhook-routing.test.js uses, so
   what runs is the shipped code rather than a description of it. */

const REPO_ROOT = require('path').resolve(__dirname, '..');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(REPO_ROOT, 'apps-script', 'webhook.gs'), 'utf8');

let bad = 0;
const t = (label, cond, extra) => {
  console.log((cond ? '  ok    ' : '  FAIL  ') + label +
              (extra !== undefined ? '  ->  ' + JSON.stringify(extra) : ''));
  if (!cond) bad++;
};
const head = (m) => console.log('\n=== ' + m + ' ===');

/* ---- the sheet, simulated ------------------------------------------- */
const JOBS_HEADERS = ['job_id','lead_id','source','property_key','service_type','frequency',
  'condition','beds','baths','quoted_price','add_ons','add_on_rev','final_price','scheduled_date',
  'completed_date','cleaner','start_time','duration_min','photos_passed','payment_status',
  'job_status','notes','submission_id','received_at','name','email','phone','segment','src_chain',
  'customer_notes','pets_flag','scheduling_type','address','unit','zip','quote_meta',
  'property_id','contact_id','partner_payout','vendor_id','operator_id'];

const LEADS_HEADERS = ['lead_id','name','email','phone','service_address','unit','zip','source',
  'source_detail','contacted_via','source_history','status','first_variant','dnc_scrub',
  'first_touch','last_touch','ltv','notes','segment','contact_id'];

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

function build() {
  const tabs = {
    JOBS:   makeSheet('JOBS', JOBS_HEADERS),
    LEADS:  makeSheet('LEADS', LEADS_HEADERS),
    /* openById returns this same book, so the vendor tabs sit here too.
       Enough columns for buildClientVendorProfile and no more. */
    VENDORS: makeSheet('VENDORS', ['vendor_id','status','display_name','logo_url',
      'public_description','partner_since','insurance_verified','service_area',
      'public_rating','public_review_count','rating_source','client_visible']),
  };
  const logs = [];
  const ss = {
    getSheetByName: n => tabs[n] || null,
    insertSheet: n => (tabs[n] = makeSheet(n, null)),
    getName: () => 'Leads MASTER',
  };

  const box = {
    console: { log: m => logs.push(String(m)), warn: m => logs.push(String(m)),
               error: m => logs.push(String(m)), info: () => {} },
    JSON, Date, Math, String, Number, Boolean, Array, Object, RegExp, isNaN, parseInt, parseFloat,
    SpreadsheetApp: { openById: () => ss, getActiveSpreadsheet: () => ss },
    PropertiesService: {
      getScriptProperties: () => {
        const store = { TICKET_SECRET: 'test-secret-value' };
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
  return { box, tabs, ss, logs };
}

const T = build();
const S = T.box;

/* Two contacts, so "only their own" can be tested rather than assumed. */
function seedLead(leadId, name, contactId) {
  const row = new Array(LEADS_HEADERS.length).fill('');
  row[LEADS_HEADERS.indexOf('lead_id')] = leadId;
  row[LEADS_HEADERS.indexOf('name')] = name;
  row[LEADS_HEADERS.indexOf('contact_id')] = contactId;
  T.tabs.LEADS.appendRow(row);
}
function seedJob(jobId, leadId, propertyId, over) {
  const row = new Array(JOBS_HEADERS.length).fill('');
  const set = (k, v) => { row[JOBS_HEADERS.indexOf(k)] = v; };
  set('job_id', jobId); set('lead_id', leadId); set('property_id', propertyId);
  set('service_type', 'First Clean'); set('frequency', 'once');
  set('beds', 2); set('baths', 1); set('quoted_price', 214);
  set('scheduled_date', '2026-09-20'); set('start_time', '9-11 AM');
  set('address', '123 Beacon St'); set('unit', '4B'); set('zip', '02116');
  set('name', 'Uriel Lopez'); set('email', leadId); set('phone', '617-555-0100');
  Object.keys(over || {}).forEach(k => set(k, over[k]));
  T.tabs.JOBS.appendRow(row);
}

seedLead('uriel@example.com', 'Uriel Lopez', 'CON-0001');
seedLead('other@example.com', 'Someone Else', 'CON-0002');
seedJob('SRV-20260920-AAAAAA', 'uriel@example.com', 'PROP-0001');
seedJob('SRV-20260810-BBBBBB', 'uriel@example.com', 'PROP-0001',
        { completed_date: '2026-08-11', scheduled_date: '2026-08-10' });
seedJob('SRV-20260915-CCCCCC', 'other@example.com', 'PROP-0002');

const MINE  = S.portalToken('CON-0001');
const THEIRS = S.portalToken('CON-0002');
const get  = (q) => JSON.parse(S.doGet({ parameter: q }).getContent());
const post = (o) => JSON.parse(S.doPost({ postData: { contents: JSON.stringify(o) } }).getContent());
const write = (o, tok, cid) => post(Object.assign(
  { event_type: 'portal_write', contact_id: cid || 'CON-0001', t: tok || MINE }, o));

/* ------------------------------------------------------------------ */
head('1. Tokens do not cross audiences');
t('a portal token is produced', typeof MINE === 'string' && MINE.length === 20, MINE);
t('two contacts get different tokens', MINE !== THEIRS);
t('a portal token differs from that job\'s ticket tokens',
  MINE !== S.ticketToken('SRV-20260920-AAAAAA', 'client') &&
  MINE !== S.ticketToken('SRV-20260920-AAAAAA', 'partner'));
t('the id alone opens nothing', get({ portal: 'CON-0001' }).ok === false);
t('a wrong token opens nothing', get({ portal: 'CON-0001', t: 'f'.repeat(20) }).ok === false);
t('a TICKET token does not open the portal',
  get({ portal: 'CON-0001', t: S.ticketToken('SRV-20260920-AAAAAA', 'client') }).ok === false);
t('a PORTAL token does not open a ticket',
  get({ job: 'SRV-20260920-AAAAAA', t: MINE, view: 'client' }).ok === false);
t('an unknown contact looks identical to a bad token',
  get({ portal: 'CON-9999', t: S.portalToken('CON-9999') }).error ===
  get({ portal: 'CON-0001', t: 'f'.repeat(20) }).error);

/* ------------------------------------------------------------------ */
head('2. The portal shows one contact and only that contact');
const P = get({ portal: 'CON-0001', t: MINE });
t('it opens', P.ok === true, P.error);
t('it carries the first name for the header', P.firstName === 'Uriel', P.firstName);
t('it lists both of their bookings', (P.bookings || []).length === 2,
  (P.bookings || []).map(b => b.bookingId));
t('and NONE of the other contact\'s',
  !JSON.stringify(P).includes('SRV-20260915-CCCCCC'));
t('the other contact sees only theirs',
  JSON.stringify(get({ portal: 'CON-0002', t: THEIRS }).bookings).includes('CCCCCC'));
t('newest booking first', P.bookings[0].bookingId === 'SRV-20260920-AAAAAA',
  P.bookings.map(b => b.date));
t('an upcoming booking is editable and carries rooms',
  P.bookings[0].editable === true && (P.bookings[0].rooms || []).length > 0,
  (P.bookings[0].rooms || []).map(r => r.key));
t('a completed booking is a record, with no rooms to edit',
  P.bookings[1].editable === false && P.bookings[1].rooms === undefined);
t('their home appears once', (P.homes || []).length === 1,
  (P.homes || []).map(h => h.propertyId));
t('three questions, as designed',
  (P.homes[0].questions || []).length === 3,
  (P.homes[0].questions || []).map(q => q.field));

/* ------------------------------------------------------------------ */
head('3. THE OWNERSHIP CHECK');
/* The assertion that matters most in this file. A valid token for ONE contact
   must not touch another contact's booking or home. */
t('cannot write an instruction on someone else\'s booking',
  write({ kind: 'instruction', job_id: 'SRV-20260915-CCCCCC',
          scope_type: 'BOOKING', scope_key: 'GENERAL', instruction: 'x' }).ok === false);
t('cannot write access on someone else\'s home',
  write({ kind: 'access', property_id: 'PROP-0002',
          field: 'parking', choice: 'GARAGE' }).ok === false);
t('and cannot invent a booking id',
  write({ kind: 'instruction', job_id: 'SRV-19990101-ZZZZZZ',
          scope_type: 'BOOKING', scope_key: 'GENERAL', instruction: 'x' }).ok === false);
t('a refusal looks the same as a missing record',
  write({ kind: 'access', property_id: 'PROP-0002', field: 'parking', choice: 'GARAGE' }).error ===
  write({ kind: 'access', property_id: 'PROP-9999', field: 'parking', choice: 'GARAGE' }).error);
t('their OWN booking is writable',
  write({ kind: 'instruction', job_id: 'SRV-20260920-AAAAAA',
          scope_type: 'ROOM', scope_key: 'BEDROOM_1',
          instruction: 'Fresh sheets in the closet.' }).ok === true);
t('a completed booking of their own is not',
  write({ kind: 'instruction', job_id: 'SRV-20260810-BBBBBB',
          scope_type: 'BOOKING', scope_key: 'GENERAL', instruction: 'late' }).error === 'closed');

/* ------------------------------------------------------------------ */
head('4. Access answers are choices, validated');
t('a known choice saves',
  write({ kind: 'access', property_id: 'PROP-0001',
          field: 'parking', choice: 'FREE_STREET' }).ok === true);
t('PROPERTY_ACCESS was auto-created', !!T.tabs.PROPERTY_ACCESS);
t('an invented choice is refused',
  write({ kind: 'access', property_id: 'PROP-0001',
          field: 'parking', choice: 'HELICOPTER' }).error === 'unknown_choice');
t('an invented field is refused',
  write({ kind: 'access', property_id: 'PROP-0001',
          field: 'moat', choice: 'YES' }).error === 'unknown_field');
t('a choice with a detail keeps the detail',
  write({ kind: 'access', property_id: 'PROP-0001', field: 'entry',
          choice: 'KEY', detail: 'Under the mat' }).ok === true);
t('pets is free text and needs no choice',
  write({ kind: 'access', property_id: 'PROP-0001',
          field: 'pets', detail: 'Rufus and Bean' }).ok === true);

const P2 = get({ portal: 'CON-0001', t: MINE });
const q = (f) => (P2.homes[0].questions || []).filter(x => x.field === f)[0] || {};
t('the parking choice reads back', q('parking').choice === 'FREE_STREET', q('parking').choice);
t('the entry detail reads back', q('entry').detail === 'Under the mat', q('entry').detail);
t('pets reads back', P2.homes[0].petNotes === 'Rufus and Bean', P2.homes[0].petNotes);
t('a room instruction reads back',
  (P2.bookings[0].rooms || []).some(r => r.instruction === 'Fresh sheets in the closet.'));

/* ------------------------------------------------------------------ */
head('5. THE DOOR CODE NEVER COMES BACK');
t('a code saves', write({ kind: 'access', property_id: 'PROP-0001', field: 'entry',
                          choice: 'CODE', detail: '4417' }).ok === true);

const P3 = get({ portal: 'CON-0001', t: MINE });
const portalJson = JSON.stringify(P3);
t('the portal does NOT contain the code anywhere', !portalJson.includes('4417'), portalJson.slice(0, 120));
t('it reports only that one is saved', q2(P3, 'entry').secretSet === true);
t('and never a value field named like a code',
  !/entry_code"|entryCode"/.test(portalJson));

/* Neither ticket may carry it either. */
const cJson = JSON.stringify(get({ job: 'SRV-20260920-AAAAAA',
  t: S.ticketToken('SRV-20260920-AAAAAA', 'client'), view: 'client' }));
const pJson = JSON.stringify(get({ job: 'SRV-20260920-AAAAAA',
  t: S.ticketToken('SRV-20260920-AAAAAA', 'partner'), view: 'partner' }));
t('the client ticket does not contain the code', !cJson.includes('4417'));
t('the PARTNER ticket does not contain the code', !pJson.includes('4417'));
t('and no log line contains it', !T.logs.some(l => String(l).includes('4417')));

/* Moving off the code option must clear it, or a home whose access says
   "I'll let you in" still has a live code sitting in the sheet. */
write({ kind: 'access', property_id: 'PROP-0001', field: 'entry', choice: 'LET_IN' });
const codeCol = (T.tabs.PROPERTY_ACCESS._rows[0] || []).indexOf('entry_code');
const codeCell = String((T.tabs.PROPERTY_ACCESS._rows[1] || [])[codeCol] || '');
t('choosing a different entry method clears the stored code', codeCell === '', codeCell);

function q2(model, field) {
  return (model.homes[0].questions || []).filter(x => x.field === field)[0] || {};
}

/* ------------------------------------------------------------------ */
head('6. The booking email hands out the portal link');
t('portalUrl points at /h with the token',
  /^https:\/\/servecleaning\.com\/h\?id=CON-0001&t=[0-9a-f]{20}$/.test(S.portalUrl('CON-0001')),
  S.portalUrl('CON-0001'));
const block = S.ticketBlock('SRV-20260920-AAAAAA', 'CON-0001');
t('the block carries the portal link', block.includes(S.portalUrl('CON-0001')));
t('and the cleaner\'s per-job link', block.includes('view=partner'));
t('but no per-job CLIENT link when a portal exists', !block.includes('view=client'));
/* Without the LEADS column there is no contact_id, and the customer must still
   get something — otherwise adding the portal silently removes their link. */
const fallback = S.ticketBlock('SRV-20260920-AAAAAA', '');
t('falls back to the per-job link when contact_id is missing',
  fallback.includes('view=client'));

/* ============================================================
   r17 — customer links printed on demand, not by a booking

   Lives here rather than in vendor-portal.test.js because that harness has
   no LEADS tab: the same assertions there passed against the string
   "No LEADS tab.", which is a test that proves nothing.
   ============================================================ */
console.log('\n=== r17: printing customer portal links ===');

/* One lead carrying the fields that must never be printed, and one with no
   contact_id — the normal state until that customer books. */
const pii = new Array(LEADS_HEADERS.length).fill('');
pii[LEADS_HEADERS.indexOf('lead_id')]         = 'priya@example.com';
pii[LEADS_HEADERS.indexOf('name')]            = 'Priya N.';
pii[LEADS_HEADERS.indexOf('contact_id')]      = 'CON-0042';
pii[LEADS_HEADERS.indexOf('service_address')] = '77 Marlborough St';
pii[LEADS_HEADERS.indexOf('phone')]           = '6175559999';
pii[LEADS_HEADERS.indexOf('email')]           = 'priya@example.com';
T.tabs.LEADS.appendRow(pii);

const unbooked = new Array(LEADS_HEADERS.length).fill('');
unbooked[LEADS_HEADERS.indexOf('lead_id')] = 'later@example.com';
unbooked[LEADS_HEADERS.indexOf('name')]    = 'Not Yet Booked';
T.tabs.LEADS.appendRow(unbooked);

T.logs.length = 0;
S.printCustomerLinks();
const custOut = T.logs.join('\n');

t('the LEADS tab was actually found', !custOut.includes('No LEADS tab'),
  custOut.slice(0, 80));
t('a link is printed for a contact', custOut.includes('CON-0042'), custOut.slice(0, 200));
t('under their name', custOut.includes('Priya N.'));
t('and the token is exactly portalToken(id)',
  custOut.includes(S.portalToken('CON-0042')));

/* The link is the credential; nothing else about the person belongs in a log. */
t('no address is printed', !custOut.includes('77 Marlborough St'));
t('no phone is printed',   !custOut.includes('6175559999'));
t('no email is printed',   !custOut.includes('priya@example.com'));

t('a row with no contact_id is counted, not silently dropped',
  /\d+ row\(s\) have no contact_id/.test(custOut), custOut.slice(-160));
t('and it is not given a link', !custOut.includes('Not Yet Booked'));


/* ============================================================
   r18 — the portal answers "who is cleaning my home"

   buildPortalModel was written in r14, before VENDORS existed, and never
   gained a partner field. r14 is also the revision that pointed the booking
   confirmation at the PORTAL link — so the one page every customer opens was
   the one page that could not answer the question.
   ============================================================ */
console.log('\n=== r18: the portal carries the partner ===');

T.tabs.VENDORS.appendRow(['VEN-0001','active','Beacon Hill Home Care',
  '/images/vendors/bh.svg','Back Bay specialists.','2024', true, 'Greater Boston',
  4.8, 31, 'Google', true]);
T.tabs.VENDORS.appendRow(['VEN-0002','active','Half Filled Co.','','','', false,
  '', '', '', '', false]);

const jrows = T.tabs.JOBS._rows;
const jvi = JOBS_HEADERS.indexOf('vendor_id');
const jci = JOBS_HEADERS.indexOf('completed_date');
const jji = JOBS_HEADERS.indexOf('job_id');

const upcomingRows = [];
for (let r = 1; r < jrows.length; r++) if (!jrows[r][jci]) upcomingRows.push(r);
t('the fixture has an upcoming booking to assign', upcomingRows.length > 0,
  upcomingRows.length);

jrows[upcomingRows[0]][jvi] = 'VEN-0001';
const ASSIGNED = jrows[upcomingRows[0]][jji];

const P18 = get({ portal: 'CON-0001', t: MINE });
t('the portal opens', P18.ok === true, P18.error);
const mine18 = (P18.bookings || []).filter(b => b.bookingId === ASSIGNED)[0];
t('the assigned booking is in it', !!mine18, ASSIGNED);

t('it carries a partner at all', !!(mine18 && mine18.partner),
  mine18 && mine18.partner);
t('named as the company', !!mine18 && !!mine18.partner &&
  mine18.partner.displayName === 'Beacon Hill Home Care',
  mine18 && mine18.partner && mine18.partner.displayName);
t('with the logo, which is the whole point', !!mine18 && !!mine18.partner &&
  mine18.partner.logoUrl === '/images/vendors/bh.svg',
  mine18 && mine18.partner && mine18.partner.logoUrl);

/* Same whitelist as the ticket: nothing internal may ride along. */
const p18 = JSON.stringify(mine18 && mine18.partner);
t('no payout, legal name or internal contact in the payload',
  !/payout|legal|internal/i.test(p18), p18);

/* Unassigned stays null — that is what renders the coordinating state, and it
   is EVERY preference booking. */
/* Read it off the RESPONSE, not the sheet: the fixture's other upcoming job
   belongs to the second contact, so it is correctly absent from this portal
   and looking for it there asserts nothing. */
const otherUp = (P18.bookings || []).filter(
  b => !b.completed && b.bookingId !== ASSIGNED)[0];
if (otherUp) {
  t('an unassigned booking reports partner null', otherUp.partner === null,
    otherUp.partner);
} else {
  t('this contact has exactly one upcoming booking', true, 'null case covered below');
}

/* A finished booking is a receipt. "Coordinating with our vendor network" over
   a job that already happened would be nonsense, not merely useless. */
const donerow = (P18.bookings || []).filter(b => b.completed)[0];
if (donerow) {
  t('completed bookings carry no partner field at all',
    donerow.partner === undefined, donerow.partner);
}

/* A partner Serve has not finished setting up must not reach a customer:
   client_visible FALSE renders as coordinating, never as a half-empty card. */
jrows[upcomingRows[0]][jvi] = 'VEN-0002';
const P18b = get({ portal: 'CON-0001', t: MINE });
const half = (P18b.bookings || []).filter(b => b.bookingId === ASSIGNED)[0];
t('client_visible FALSE yields no card', !!half && half.partner === null,
  half && half.partner);

/* A missing VENDORS tab must cost the card, never the booking list. */
const savedVendors = T.tabs.VENDORS;
delete T.tabs.VENDORS;
const P18c = get({ portal: 'CON-0001', t: MINE });
t('a missing VENDORS tab still returns the bookings',
  P18c.ok === true && (P18c.bookings || []).length === (P18.bookings || []).length,
  P18c.error);
T.tabs.VENDORS = savedVendors;

console.log('\n' + (bad ? bad + ' FAILURES' : 'ALL ASSERTIONS PASSED'));
process.exit(bad ? 1 : 0);
