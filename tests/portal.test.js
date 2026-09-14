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
    deleteColumn: c => rows.forEach(r => r.splice(c - 1, 1)),
    deleteRow: r => rows.splice(r - 1, 1),

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
      /* r31: real Sheets exposes this on the RANGE, not on the sheet. Reading
         the value and the displayed text side by side is how the check tells
         a cell Sheets converted from one that is still the text we wrote. */
      getDisplayValues: () => {
        const o = [];
        for (let i = 0; i < (nr || 1); i++) {
          const row = rows[r - 1 + i] || [];
          o.push(row.slice(c - 1, c - 1 + (nc || 1)).map(v => String(v)));
        }
        return o;
      },
      /* r42: real Sheets has BOTH, and code that reads one cell uses this one.
         Without it stampJobVendor threw on `cell.getValue()`, the caller's
         wrapper swallowed it, and the vendor stamp silently did nothing — in
         the harness only. A missing stub is indistinguishable from a bug in
         the code under test, which is the worse half of that. */
      getValue: () => (rows[r - 1] || [])[c - 1],
      setValue: v => {
        while (rows.length < r) rows.push([]);
        while (rows[r - 1].length < c) rows[r - 1].push('');
        rows[r - 1][c - 1] = typeof v === 'string' && v.startsWith("'") ? v.slice(1) : v;
      },
      setNumberFormat: () => {},
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
    RECURRING_PLANS: makeSheet('RECURRING_PLANS', ['plan_id','contact_id','lead_id',
      'origin_job_id','property_id','frequency','quoted_price','created_at',
      'expires_at','status','anchor_date','anchor_time','preferred_vendor_id',
      'confirmed_job_id']),
    /* r42. openById returns this same book, so the Ops capacity tab sits here
       too. It exists so confirming a plan can be watched CONSUMING a slot —
       the difference between an offer and a booking is that one of them takes
       capacity away from somebody else. */
    AVAILABILITY: makeSheet('AVAILABILITY', ['date','start_time','vendor_id',
      'status','job_id']),
    VENDOR_REVIEWS: makeSheet('VENDOR_REVIEWS', ['vendor_id','quote','author','rating',
      'source','source_url','reviewed_on','client_visible']),
    VENDOR_PHOTOS: makeSheet('VENDOR_PHOTOS', ['vendor_id','image_url','caption',
      'sort','client_visible']),
  };
  const logs = [];
  /* Harness state the stubs below share and the tests reach through the return
     value: script properties that survive a set, recorded outbound HTTP, and a
     one-shot reply so a test can make the next Twilio call fail. */
  const propStore = { TICKET_SECRET: 'test-secret-value', ACCESS_SPREADSHEET_ID: 'private-access-book', ACCESS_CODES_TAB: 'ACCESS' };
  const privateTabs = { ACCESS: makeSheet('ACCESS', ['property_id', 'access_secret', 'access_secret_set_at']) };
  const privateBook = { getId: () => 'private-access-book', getSheetByName: n => privateTabs[n] || null,
    insertSheet: n => (privateTabs[n] = makeSheet(n, null)),
    /* r30: the diagnosis lists the tabs a workbook really has. */
    getSheets: () => Object.keys(privateTabs).map(n => privateTabs[n]) };
  const fetches = [];
  let nextFetchReply = { code: 201, text: '{"sid":"SM123","status":"queued"}' };
  const ss = {
    getSheetByName: n => tabs[n] || null,
    insertSheet: n => (tabs[n] = makeSheet(n, null)),
    getName: () => 'Leads MASTER',
    getSpreadsheetTimeZone: () => 'America/New_York',
    getId: () => 'leads-book',
  };

  const box = {
    console: { log: m => logs.push(String(m)), warn: m => logs.push(String(m)),
               error: m => logs.push(String(m)), info: () => {} },
    JSON, Date, Math, String, Number, Boolean, Array, Object, RegExp, isNaN, parseInt, parseFloat,
    SpreadsheetApp: { openById: id => id === 'private-access-book' ? privateBook : ss, getActiveSpreadsheet: () => ss, flush: () => {} },
    Session: { getScriptTimeZone: () => 'America/New_York' },
    /* ONE store for the whole harness, not a fresh one per call. It used to be
       rebuilt inside getScriptProperties, which meant a property set from a
       test never survived to be read back — fine while TICKET_SECRET was the
       only one, useless the moment a test needs to turn a feature on. */
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: k => (k in propStore ? propStore[k] : null),
        setProperty: (k, v) => { propStore[k] = v; },
        getKeys: () => Object.keys(propStore),
      }),
    },
    Utilities: {
      computeHmacSha256Signature: (msg) => {
        const h = require('crypto').createHmac('sha256', 'test').update(String(msg)).digest();
        return [...h].map(b => (b > 127 ? b - 256 : b));
      },
      getUuid: () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      /* r32: the two patterns the cell helpers use are formatted for real,
         through whatever timezone they are handed. Every other pattern keeps
         the old String(d) behaviour on purpose — job ids ("yyyyMMdd") and ISO
         stamps are formatted on paths these tests are not about, and making
         those throw would break them for nothing. The old stub ignored the
         timezone completely, which is exactly why it could not have caught a
         date read through the wrong one. */
      formatDate: (d, tz, fmt) => {
        if (fmt !== 'yyyy-MM-dd' && fmt !== 'h:mm a') return String(d);
        const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric',
          month: '2-digit', day: '2-digit', hour: 'numeric', minute: '2-digit', hour12: true })
          .formatToParts(d).reduce((o, x) => (o[x.type] = x.value, o), {});
        return fmt === 'yyyy-MM-dd'
          ? p.year + '-' + p.month + '-' + p.day
          : p.hour + ':' + p.minute + ' ' + String(p.dayPeriod).toUpperCase();
      },
      base64Encode: (s) => Buffer.from(String(s), 'utf8').toString('base64'),
    },
    /* Records outbound HTTP instead of making it. Modelled on Twilio's actual
       contract — muteHttpExceptions means a 4xx is a response to read, not a
       throw — so the code under test takes the same branch it would live. */
    UrlFetchApp: {
      fetch: (url, opts) => {
        fetches.push({ url, opts });
        const reply = nextFetchReply;
        nextFetchReply = { code: 201, text: '{"sid":"SM123","status":"queued"}' };
        return {
          getResponseCode: () => reply.code,
          getContentText:  () => reply.text,
        };
      },
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
  return { box, tabs, ss, logs, propStore, fetches, privateTabs,
           setFetchReply: (code, text) => { nextFetchReply = { code, text }; } };
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
const codeCell = String(T.privateTabs.ACCESS._rows[1][1] || '');
t('choosing a different entry method clears the private stored code', codeCell === '');
t('Leads has no code column', codeCol === -1);
t('Leads contains no saved code value', !JSON.stringify(T.tabs).includes('4417'));

head('5b. Private storage failures and migration');
write({ kind: 'access', property_id: 'PROP-0001', field: 'entry', choice: 'CODE', detail: '0042' });
t('leading zeroes reach the separate workbook intact', T.privateTabs.ACCESS._rows[1][1] === '0042');
write({ kind: 'access', property_id: 'PROP-0001', field: 'entry', choice: 'CODE', detail: '' });
t('an empty code edit keeps the private value', T.privateTabs.ACCESS._rows[1][1] === '0042');
const beforeFailure = JSON.stringify(T.tabs.PROPERTY_ACCESS._rows);
delete T.propStore.ACCESS_SPREADSHEET_ID;
t('missing private configuration rejects the save', write({ kind: 'access', property_id: 'PROP-0001', field: 'entry', choice: 'CODE', detail: '9999' }).ok === false);
t('portal reads use only public markers even when private storage is unavailable', q2(get({ portal: 'CON-0001', t: MINE }), 'entry').secretSet === true);
t('failure does not change the public answer or claim success', JSON.stringify(T.tabs.PROPERTY_ACCESS._rows) === beforeFailure);
t('failure never falls back to Leads', !JSON.stringify(T.tabs).includes('9999'));
T.propStore.ACCESS_SPREADSHEET_ID = 'leads-book';
t('configuration pointing at Leads is rejected', write({ kind: 'access', property_id: 'PROP-0001', field: 'entry', choice: 'CODE', detail: '9999' }).ok === false);
T.propStore.ACCESS_SPREADSHEET_ID = 'private-access-book';

function migrationFixture() {
  const m = build();
  m.tabs.PROPERTY_ACCESS = makeSheet('PROPERTY_ACCESS', ['property_id', 'entry_choice', 'entry_detail', 'entry_code', 'entry_code_set_at', 'pet_notes']);
  m.tabs.PROPERTY_ACCESS.appendRow(['PROP-0001', 'CODE', '', '0042', '2026-09-01', 'Keep this note']);
  return m;
}
const migration = migrationFixture();
migration.box.migratePropertyAccessCodes();
t('migration copies exact code into Access MASTER', migration.privateTabs.ACCESS._rows[1][1] === '0042');
t('migration removes the source column and values', !JSON.stringify(migration.tabs).includes('0042') && !migration.tabs.PROPERTY_ACCESS._rows[0].includes('entry_code'));
t('migration preserves unrelated customer notes', migration.tabs.PROPERTY_ACCESS._rows[1].includes('Keep this note'));
migration.box.migratePropertyAccessCodes();
t('migration retry preserves one destination record', migration.privateTabs.ACCESS._rows.length === 2);
t('migration logs never contain a code', !migration.logs.join(' ').includes('0042'));
const conflict = migrationFixture();
conflict.privateTabs.ACCESS.appendRow(['PROP-0001', 'different-private-code', '']);
let stopped = false;
try { conflict.box.migratePropertyAccessCodes(); } catch (_) { stopped = true; }
t('conflicting private value stops migration without erasing either code', stopped && conflict.tabs.PROPERTY_ACCESS._rows[1][3] === '0042' && conflict.privateTabs.ACCESS._rows[1][1] === 'different-private-code');
const unavailable = migrationFixture();
delete unavailable.propStore.ACCESS_SPREADSHEET_ID;
try { unavailable.box.migratePropertyAccessCodes(); } catch (_) {}
t('missing Access MASTER leaves the source intact', unavailable.tabs.PROPERTY_ACCESS._rows[1][3] === '0042');
const corrupt = migrationFixture();
const privateRange = corrupt.privateTabs.ACCESS.getRange;
corrupt.privateTabs.ACCESS.getRange = (...args) => {
  const cell = privateRange(...args);
  if (args[0] > 1 && args[1] === 2) cell.setValue = () => {};
  return cell;
};
let corruptStopped = false;
try { corrupt.box.migratePropertyAccessCodes(); } catch (_) { corruptStopped = true; }
t('failed destination verification preserves the source code and column', corruptStopped && corrupt.tabs.PROPERTY_ACCESS._rows[1][3] === '0042' && corrupt.tabs.PROPERTY_ACCESS._rows[0].includes('entry_code'));
const timedOut = build();
timedOut.box.LockService.getScriptLock = () => ({ waitLock: () => { throw new Error('busy'); }, releaseLock: () => {} });
t('portal writes fail closed when the script lock is busy', JSON.parse(timedOut.box.doPost({ postData: { contents: JSON.stringify({ event_type: 'portal_write' }) } }).getContent()).ok === false);

head('5c. r29 — a legacy cell is not necessarily the code that was typed');
/* Before r28 a code was written with a plain setValue into an Automatic-format
   cell, and Sheets converts what it is given: "0042" was kept as the NUMBER 42,
   and "12/25" could become a DATE. The migration fixture above stores '0042' as
   a string, which is what the old code SENT, not what the sheet KEPT. These
   fixtures hold what a real sheet would hold. */
function legacyFixture(codeCell) {
  const m = build();
  m.tabs.PROPERTY_ACCESS = makeSheet('PROPERTY_ACCESS',
    ['property_id', 'entry_choice', 'entry_detail', 'entry_code', 'entry_code_set_at', 'pet_notes']);
  m.tabs.PROPERTY_ACCESS.appendRow(['PROP-0007', 'CODE', '', codeCell, '2026-09-01', 'Keep this note']);
  return m;
}

/* A DATE stands in for the code: refuse, keep the source, name the home. */
const asDate = legacyFixture(new Date(2026, 11, 25));
let dateStopped = false;
try { asDate.box.migratePropertyAccessCodes(); } catch (_) { dateStopped = true; }
t('a code Sheets turned into a DATE stops the migration', dateStopped);
t('with the legacy column and its value still in Leads',
  asDate.tabs.PROPERTY_ACCESS._rows[0].includes('entry_code') &&
  asDate.tabs.PROPERTY_ACCESS._rows[1][3] instanceof Date);
t('and nothing written to Access MASTER', asDate.privateTabs.ACCESS._rows.length === 1,
  asDate.privateTabs.ACCESS._rows.length);
t('the log names the home so the code can be re-entered',
  asDate.logs.join(' | ').includes('PROP-0007'), asDate.logs.join(' | ').slice(-200));
t('and never prints the date that was standing in for the code',
  !/Dec 25|2026-12-25|GMT/.test(asDate.logs.join(' | ')));

/* A NUMBER is copied, because nothing better survives, and flagged. */
const asNumber = legacyFixture(42);
asNumber.box.migratePropertyAccessCodes();
t('a code Sheets turned into a NUMBER is still migrated',
  asNumber.privateTabs.ACCESS._rows[1][1] === '42', asNumber.privateTabs.ACCESS._rows[1]);
t('but the completion log names it for re-confirmation',
  /stored as NUMBERS[^|]*PROP-0007/.test(asNumber.logs.join(' | ')), asNumber.logs.join(' | ').slice(-260));
t('and never prints the code itself',
  !/(^|[^0-9])42([^0-9]|$)/.test(asNumber.logs.join(' | ').replace(/PROP-[0-9]+/g, '')));

/* The pre-flight: counts and property IDs, never a value, nothing changed. */
const pre = legacyFixture(42);
pre.tabs.PROPERTY_ACCESS.appendRow(['PROP-0008', 'CODE', '', '0513', '2026-09-02', '']);
pre.tabs.PROPERTY_ACCESS.appendRow(['PROP-0009', 'CODE', '', new Date(2026, 3, 5), '2026-09-03', '']);
const report = pre.box.checkAccessMigration();
t('the check says the legacy column is still there', /entry_code column PRESENT/.test(report), report);
t('it counts the codes kept as text', /stored as text: 1\./.test(report), report);
t('it names the homes whose code was kept as a number', /NUMBERS[^|]*PROP-0007/.test(report), report);
t('it names the homes whose code was kept as a date', /DATES[^|]*PROP-0009/.test(report), report);
t('it never prints a code',
  !report.includes('0513') && !/(^|[^0-9])42([^0-9]|$)/.test(report.replace(/PROP-[0-9]+/g, '')), report);
t('it changes nothing in Leads',
  pre.tabs.PROPERTY_ACCESS._rows[0].includes('entry_code') && pre.tabs.PROPERTY_ACCESS._rows.length === 4);
t('its write probe round-trips and says so', /Write round trip: OK/.test(report), report);
t('and removes the probe row afterwards',
  !JSON.stringify(pre.privateTabs.ACCESS._rows).includes('__serve_probe__'), pre.privateTabs.ACCESS._rows);

/* If a real sheet KEEPS r28's leading apostrophe, every code save is refused.
   The stub strips one apostrophe, as r28 assumed Sheets does; this one keeps
   it, and the probe has to be the thing that says so. */
const sticky = legacyFixture('');
const stickyRange = sticky.privateTabs.ACCESS.getRange;
sticky.privateTabs.ACCESS.getRange = (...args) => {
  const cell = stickyRange(...args);
  const set = cell.setValue;
  cell.setValue = v => set(typeof v === 'string' && v.startsWith("'") ? "'" + v : v);
  return cell;
};
const stickyReport = sticky.box.checkAccessMigration();
t('if Sheets keeps the apostrophe, the probe says do not migrate',
  /Write round trip: FAILED[^|]*Do not migrate/.test(stickyReport), stickyReport);
t('and still removes its probe row',
  !JSON.stringify(sticky.privateTabs.ACCESS._rows).includes('__serve_probe__'), sticky.privateTabs.ACCESS._rows);

/* Unconfigured is reported, not thrown. */
const noStore = legacyFixture('0042');
delete noStore.propStore.ACCESS_SPREADSHEET_ID;
const noStoreReport = noStore.box.checkAccessMigration();
t('an unconfigured Access MASTER is reported as NOT READY',
  /Access MASTER: NOT READY/.test(noStoreReport), noStoreReport);
t('and the check still finishes the Leads side', /stored as text: 1\./.test(noStoreReport), noStoreReport);

/* After an r28 migration, a date copied in as a code is still findable. */
const migrated = build();
migrated.tabs.PROPERTY_ACCESS = makeSheet('PROPERTY_ACCESS',
  ['property_id', 'entry_choice', 'entry_detail', 'entry_code_saved', 'entry_code_set_at', 'pet_notes']);
migrated.tabs.PROPERTY_ACCESS.appendRow(['PROP-0010', 'CODE', '', true, '2026-09-01', '']);
migrated.privateTabs.ACCESS.appendRow(['PROP-0010', 'Fri Dec 25 2026 00:00:00 GMT-0500 (Eastern Standard Time)', '2026-09-01']);
const migratedReport = migrated.box.checkAccessMigration();
t('after a migration, the check reports the legacy column as gone',
  /ABSENT \(already migrated\)/.test(migratedReport), migratedReport);
t('and still finds a date that was copied in as a code',
  /dates rather than codes: PROP-0010/.test(migratedReport), migratedReport);
t('without printing it', !/Dec 25|GMT/.test(migratedReport), migratedReport);

head('5d. r30 — NOT READY names the fault');
/* One sentence used to cover seven causes, and the founder hit it twice with
   the properties apparently set and no way to tell which. Each case builds one
   fault on purpose and checks that the check names THAT fault. */
const diag = (setup) => { const m = legacyFixture(''); setup(m); return m.box.checkAccessMigration(); };
let dr;

dr = diag(m => { delete m.propStore.ACCESS_SPREADSHEET_ID; });
t('an unset ID is named as unset', /ACCESS_SPREADSHEET_ID is not set/.test(dr), dr);
t('and the two likely reasons are given', /not saved/.test(dr) && /different Apps Script project/.test(dr), dr);

dr = diag(m => { delete m.propStore.ACCESS_SPREADSHEET_ID; m.propStore['ACCESS_SPREADSHEET_ID '] = 'private-access-book'; });
t('a property saved under a name with a trailing space is pointed out',
  /similar names ARE set: "ACCESS_SPREADSHEET_ID "/.test(dr), dr);

dr = diag(m => { delete m.propStore.ACCESS_CODES_TAB; });
t('an unset tab name is named as unset', /ACCESS_CODES_TAB is not set/.test(dr), dr);

dr = diag(m => { m.propStore.ACCESS_SPREADSHEET_ID = 'https://docs.google.com/spreadsheets/d/abc123/edit#gid=0'; });
t('a pasted URL is recognised as a URL', /characters a spreadsheet ID never has/.test(dr), dr);
t('without echoing the URL back', !/docs\.google\.com|abc123/.test(dr), dr);

dr = diag(m => { m.propStore.ACCESS_SPREADSHEET_ID = 'leads-book'; });
t('Leads given by mistake is named', /is Leads MASTER itself/.test(dr), dr);

dr = diag(m => {
  m.propStore.ACCESS_SPREADSHEET_ID = 'no-such-book';
  const open = m.box.SpreadsheetApp.openById;
  m.box.SpreadsheetApp.openById = id => { if (id === 'no-such-book') throw new Error('not found'); return open(id); };
});
t('an ID that will not open is named, with its length and the two likely reasons',
  /No spreadsheet opens with that ID \(12 characters\)/.test(dr) && /cannot open Access MASTER/.test(dr), dr);

dr = diag(m => { m.propStore.ACCESS_CODES_TAB = 'access'; });
t('a tab name differing only in capitals is shown with its nearest match',
  /no tab named "access"/.test(dr) && /Nearest: "ACCESS"/.test(dr), dr);
t('and the tabs that do exist are listed', /Its tabs are: "ACCESS"/.test(dr), dr);

dr = diag(m => { m.privateTabs.ACCESS = makeSheet('ACCESS', ['property_id', 'access_secret']); });
t('a missing header is named individually', /row 1 is missing: access_secret_set_at/.test(dr), dr);

dr = diag(m => { m.privateTabs.ACCESS = makeSheet('ACCESS', ['Property_ID', 'access_secret', 'access_secret_set_at']); });
t('a header in the wrong case is shown with what it should be',
  /"Property_ID" should be property_id/.test(dr) && /case-sensitive/.test(dr), dr);

/* It reads Access MASTER's tab names and header row, never a stored code. */
dr = diag(m => { m.privateTabs.ACCESS.appendRow(['PROP-0001', 'SECRET-9911', '']); m.propStore.ACCESS_CODES_TAB = 'nope'; });
t('the diagnosis never prints a value from inside Access MASTER', !/SECRET-9911/.test(dr), dr);

head('5e. r31 — what is actually in the date cells');
/* A test booking rendered as "Thu, Sep 17 · 12:30 AM ET · Friday, Sep 18 at
   3:30 PM". The row is written consistent, so something between writing and
   reading changes it, and only the live cells can say which. This check has to
   report the cell faithfully and give away nothing about the customer.

   The fake sheet's getDisplayValues is String(v), which is not how Sheets
   formats a real date. That is fine here: what is being proved is which FIELDS
   are reported and that no personal detail is, not Google's formatting. */
function datesFixture(dateCell, timeCell) {
  const m = build();
  m.tabs.JOBS = makeSheet('JOBS', JOBS_HEADERS);
  const row = new Array(JOBS_HEADERS.length).fill('');
  const set = (k, v) => { row[JOBS_HEADERS.indexOf(k)] = v; };
  set('job_id', 'SRV-20260918-DATE01');
  set('scheduling_type', 'slot');
  set('scheduled_date', dateCell);
  set('start_time', timeCell);
  set('notes', 'Friday, Sep 18 at 3:30 PM');
  /* Seeded on purpose: the report must never print any of these. */
  set('name', 'Uriel Lopez');
  set('email', 'cust@example.com');
  set('phone', '6175550100');
  set('address', '123 Beacon St');
  m.tabs.JOBS.appendRow(row);
  return m;
}

/* Written as text and still text: the harmless case. */
let dd = datesFixture('2026-09-18', '3:30 PM');
let rep = dd.box.checkBookingDates();
t('text cells are reported as text', /scheduled_date  raw text "2026-09-18"/.test(rep), rep);
t('and read back unchanged', /read as "2026-09-18"/.test(rep), rep);
/* getDisplayValues is what a person sees in the cell, and it is the line that
   settles whether a wrong date was typed in or introduced on the way out.
   Removing it from the report failed no assertion until this one existed. */
t('what the cell displays to a person is shown too',
  /displayed "2026-09-18"/.test(rep) && /displayed "3:30 PM"/.test(rep), rep);
t('a text time keeps its wording and gains ET', /read as "3:30 PM ET"/.test(rep), rep);
t('the booked summary is shown for comparison', /Friday, Sep 18 at 3:30 PM/.test(rep), rep);
t('the job and its scheduling type are named',
  /SRV-20260918-DATE01  scheduling_type=slot/.test(rep), rep);

/* Converted by Sheets: the case that would explain the wrong ticket. */
dd = datesFixture(new Date(2026, 8, 18), new Date(1899, 11, 30, 15, 30));
rep = dd.box.checkBookingDates();
t('a converted date cell is reported as a DATE with its instant',
  /scheduled_date  raw DATE [0-9]{4}-/.test(rep), rep);
t('with the local wall clock beside it', /\(local 2026-9-18 0:00\)/.test(rep), rep);
t('a converted time cell is reported as a DATE too', /start_time      raw DATE/.test(rep), rep);
t('and what the code makes of it is shown', /read as "3:30 PM ET"/.test(rep), rep);

/* Both timezone settings, because a mismatch is one of the two explanations. */
t('the project timezone is reported', /Apps Script project timezone: America\/New_York/.test(rep), rep);
t('the spreadsheet timezone is reported', /Spreadsheet timezone:         America\/New_York/.test(rep), rep);
dd = datesFixture('2026-09-18', '3:30 PM');
dd.box.Session = { getScriptTimeZone: () => 'Australia/Sydney' };
rep = dd.box.checkBookingDates();
t('a wrong project timezone is flagged, with where to fix it',
  /Australia\/Sydney  <-- not the business timezone \(Project Settings/.test(rep), rep);

/* THE RULE THAT MATTERS: a diagnostic must not become a data leak. */
dd = datesFixture(new Date(2026, 8, 18), '3:30 PM');
rep = dd.box.checkBookingDates();
t('no customer name in the report', !/Uriel|Lopez/.test(rep), rep);
t('no email or phone in the report', !/cust@example\.com|6175550100/.test(rep), rep);
t('no address in the report', !/Beacon/.test(rep), rep);
t('the check changes nothing', dd.tabs.JOBS._rows.length === 2, dd.tabs.JOBS._rows.length);

/* Blank cells are a real state on preference bookings, not an error. */
dd = datesFixture('', '');
rep = dd.box.checkBookingDates();
t('blank date cells are reported as blank', /scheduled_date  raw blank/.test(rep), rep);
t('and still show the summary', /Friday, Sep 18 at 3:30 PM/.test(rep), rep);

head("5f. r32 — a date cell is read through the SPREADSHEET's timezone");
/* Leads MASTER was set to Australia/Sydney while the script and the business
   are America/New_York. Sheets builds a cell's instant from the SPREADSHEET's
   timezone; r23 read it back with local getters, which are the PROJECT's. A
   booking displaying "2026-09-18" and "3:30 PM" reached every ticket and
   portal as "2026-09-17" and "12:30 AM ET", a day early.

   The instants below are what a Sydney workbook really hands back for that
   booking. The time uses a modern date rather than the 1899 epoch a time-only
   cell carries: Sheets treats that epoch as a flat +10:00 for Sydney while
   Node's timezone data uses the historical +10:05, so an epoch fixture would
   assert a five-minute fiction. Same code path, honest numbers. */
const SYD_DATE = new Date('2026-09-17T14:00:00.000Z');   // 2026-09-18 00:00 in Sydney
const SYD_TIME = new Date('2026-09-18T05:30:00.000Z');   // 3:30 PM in Sydney

t('a date cell reads as the day that was typed, not the day the project is in',
  S.dateCellText(SYD_DATE, 'Australia/Sydney') === '2026-09-18',
  S.dateCellText(SYD_DATE, 'Australia/Sydney'));
t('and a time cell as the time that was typed',
  S.timeCellText(SYD_TIME, 'Australia/Sydney') === '3:30 PM ET',
  S.timeCellText(SYD_TIME, 'Australia/Sydney'));

/* No timezone is a real workbook's case and the older harnesses': fall back to
   local getters, which is exactly what r23 did — never a guessed zone. */
t('with no timezone the old local reading is kept',
  S.dateCellText(new Date(2026, 8, 18)) === '2026-09-18',
  S.dateCellText(new Date(2026, 8, 18)));
t('and a text cell never consults a timezone at all',
  S.dateCellText('2026-09-18', 'Australia/Sydney') === '2026-09-18' &&
  S.timeCellText('3:30 PM', 'Australia/Sydney') === '3:30 PM ET');

/* THE WIRING, which is the half that was actually broken. The helpers could
   always have been handed a timezone; getBooking never handed them one. */
const syd = datesFixture(SYD_DATE, SYD_TIME);
syd.ss.getSpreadsheetTimeZone = () => 'Australia/Sydney';
const sydBooking = syd.box.getBooking(syd.ss, 'SRV-20260918-DATE01');
t('a booking on a Sydney workbook reports the booked day',
  !!sydBooking && sydBooking.scheduledDate === '2026-09-18',
  sydBooking && sydBooking.scheduledDate);
t('and the booked time',
  !!sydBooking && sydBooking.startTime === '3:30 PM ET',
  sydBooking && sydBooking.startTime);
t('which is the day the summary said all along',
  /Friday, Sep 18/.test(String(sydBooking && sydBooking.scheduleSummary)),
  sydBooking && sydBooking.scheduleSummary);

/* The diagnostic is what someone opens when a slip looks wrong. Reading the
   cells differently from the slip would send them chasing a ghost. */
const sydRep = syd.box.checkBookingDates();
t('checkBookingDates agrees with the ticket rather than the project timezone',
  /read as "2026-09-18"/.test(sydRep) && /read as "3:30 PM ET"/.test(sydRep), sydRep);

/* A correctly configured workbook must be left exactly as it was. */
const ny = datesFixture(SYD_DATE, SYD_TIME);
const nyBooking = ny.box.getBooking(ny.ss, 'SRV-20260918-DATE01');
t('an America/New_York workbook reads its own instants unchanged',
  !!nyBooking && nyBooking.scheduledDate === '2026-09-17',
  nyBooking && nyBooking.scheduledDate);

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

/* ------------------------------------------------------------------
   r35: borrowed reviews and work photos.

   Both are Serve quoting somebody else on a customer's page, so the view model
   is where the guards live: every cell here is typed by hand, and two of these
   columns become a URL in a browser. The names below are fixture names and no
   review carries an address — privacy.test.js sweeps this file like any other.
   ------------------------------------------------------------------ */
head('19. r35 — reviews and photos a customer may see');
/* r18 signs off with the assignment pointing at VEN-0002, whose
   client_visible is FALSE, to prove that renders no card. Point it back at
   VEN-0001 — without a card there is nothing for a review to hang on, and
   every assertion below would pass vacuously on an empty list. */
jrows[upcomingRows[0]][jvi] = 'VEN-0001';

/* clientVendorReviews/Photos memoise per SCRIPT EXECUTION, which in production
   is per request. This harness runs every request in one persistent scope, so
   the reads above already cached "no reviews" for VEN-0001 before these rows
   existed. Clearing it is what a new execution does for free. */
const freshScope = () => { S.vendorExtrasMemo = {}; };

const RV_H = ['vendor_id','quote','author','rating','source','source_url','reviewed_on','client_visible'];
const PH_H = ['vendor_id','image_url','caption','sort','client_visible'];
const rv = (over) => Object.assign({
  vendor_id: 'VEN-0001', quote: 'They left the kitchen spotless.', author: 'A. Tenant',
  rating: 5, source: 'Google', source_url: 'https://example.com/r/1',
  reviewed_on: '2026-08-02', client_visible: true,
}, over || {});
const ph = (over) => Object.assign({
  vendor_id: 'VEN-0001', image_url: '/images/vendors/bh-kitchen.jpg',
  caption: 'Kitchen, Back Bay', sort: 1, client_visible: true,
}, over || {});
const pushRv = (o) => { const r = rv(o); T.tabs.VENDOR_REVIEWS.appendRow(RV_H.map(k => r[k])); };
const pushPh = (o) => { const p = ph(o); T.tabs.VENDOR_PHOTOS.appendRow(PH_H.map(k => p[k])); };

pushRv({});
pushRv({ quote: 'On time twice in a row.', author: 'M. Homeowner', rating: 4,
         source: 'Their website', source_url: '', reviewed_on: '2026-07-19' });
/* Hidden, and the one that would be an XSS if an href were built from it. */
pushRv({ quote: 'Not shown.', client_visible: false });
pushRv({ quote: 'Nice work.', author: 'X', source: 'Forum',
         source_url: 'javascript:alert(1)' });

pushPh({});
pushPh({ image_url: '/images/vendors/bh-bath.jpg', caption: '', sort: 2 });
pushPh({ image_url: 'https://evil.example.org/track.gif', caption: 'offsite', sort: 3 });
pushPh({ image_url: '/images/vendors/hidden.jpg', client_visible: false, sort: 4 });

freshScope();
const P19 = get({ portal: 'CON-0001', t: MINE });
const b19 = (P19.bookings || []).filter(b => b.partner)[0] || {};
const pr  = (b19.partner || {}).reviews || [];
const pp  = (b19.partner || {}).photos  || [];

t('the visible reviews reach the card', pr.length === 3, pr.map(r => r.quote));
t('a hidden review does not', !pr.some(r => /Not shown/.test(r.quote)), pr.map(r => r.quote));
t('the quote is carried whole, never trimmed',
  pr[0] && pr[0].quote === 'They left the kitchen spotless.', pr[0] && pr[0].quote);
t('with its author and its source',
  !!pr[0] && pr[0].author === 'A. Tenant' && pr[0].source === 'Google', pr[0]);
t('an http source_url is kept', pr[0] && pr[0].sourceUrl === 'https://example.com/r/1',
  pr[0] && pr[0].sourceUrl);
t('a review with no link still carries its source',
  !!pr[1] && pr[1].source === 'Their website' && pr[1].sourceUrl === '', pr[1]);

/* THE GUARD. A spreadsheet cell becomes an href on a customer's page. */
const jsReview = pr.filter(r => /Nice work/.test(r.quote))[0];
t('a javascript: source_url is dropped, and the review still renders',
  !!jsReview && jsReview.sourceUrl === '', jsReview);
t('no javascript: URL appears anywhere in the payload',
  !/javascript:/i.test(JSON.stringify(P19)));

t('the visible photos reach the card', pp.length === 2, pp.map(p => p.url));
t('an offsite image_url is dropped', !pp.some(p => /evil/.test(p.url)), pp.map(p => p.url));
t('a hidden photo is dropped too', !pp.some(p => /hidden/.test(p.url)), pp.map(p => p.url));
t('photos come back in the operator order',
  pp.map(p => p.sort).join() === '1,2', pp.map(p => p.sort));
t('no offsite host appears anywhere in the payload',
  !/evil\.example\.org/.test(JSON.stringify(P19)));

/* A column added to either tab next month must not ride along. */
t('reviews expose exactly the named fields',
  pr.every(r => JSON.stringify(Object.keys(r).sort()) ===
    JSON.stringify(['author','quote','rating','reviewedOn','source','sourceUrl'])),
  pr[0] && Object.keys(pr[0]));
t('photos expose exactly the named fields',
  pp.every(p => JSON.stringify(Object.keys(p).sort()) ===
    JSON.stringify(['caption','sort','url'])), pp[0] && Object.keys(pp[0]));

/* Losing a tab must cost the tab, not the card. */
const savedRev = T.tabs.VENDOR_REVIEWS;
delete T.tabs.VENDOR_REVIEWS;
freshScope();
const P19b = get({ portal: 'CON-0001', t: MINE });
const b19b = (P19b.bookings || []).filter(b => b.partner)[0] || {};
t('a missing VENDOR_REVIEWS tab still renders the partner card',
  !!(b19b.partner && b19b.partner.displayName), b19b.partner);
t('and simply has no reviews', ((b19b.partner || {}).reviews || []).length === 0);
t('while the photos are untouched by it',
  ((b19b.partner || {}).photos || []).length === 2);
T.tabs.VENDOR_REVIEWS = savedRev;
freshScope();


/* ============================================================
   r19 — the partner's own portal link rides along in the email

   Three links, three different lifetimes, and the notification has to keep
   them straight: the customer's portal is permanent, the cleaner's job link
   dies when completed_date is filled, and the vendor's company portal is
   permanent but belongs to the company rather than the booking.
   ============================================================ */
console.log('\n=== r19: the vendor link in the booking email ===');

const withVen = S.ticketBlock('SRV-20260920-AAAAAA', 'CON-0001', 'VEN-0001');

t('the vendor portal link is present', withVen.indexOf('/v?id=VEN-0001') !== -1,
  withVen.slice(0, 200));
t('carrying the real vendor token',
  withVen.indexOf('/v?id=VEN-0001&t=' + S.vendorToken('VEN-0001')) !== -1);
t('and it is named as permanent, unlike the cleaner link',
  /permanent/.test(withVen));

/* All three must still be there, and must be three DIFFERENT links. */
t('the customer portal is still there', withVen.indexOf('/h?id=CON-0001') !== -1);
t("the cleaner's per-job link is still there", withVen.indexOf('view=partner') !== -1);
const links = (withVen.match(/https:\/\/[^\s]+/g) || []);
t('three distinct links', new Set(links).size === 3, links);

/* The vendor's link must not be the cleaner's: one opens a company, the other
   opens one job, and they are separate token scopes for that reason. */
t('the vendor link is not the cleaner link',
  withVen.indexOf('/v?id=VEN-0001&t=' + S.ticketToken('SRV-20260920-AAAAAA', 'partner')) === -1);

/* Unassigned is every preference booking. It must say so, and say what to do. */
const noVen = S.ticketBlock('SRV-20260920-AAAAAA', 'CON-0001', '');
t('unassigned says nobody is assigned', /nobody assigned/.test(noVen), noVen.slice(-220));
t('and names the fix', /vendor_id/.test(noVen) && /printVendorLinks/.test(noVen));
t('and mints no vendor link at all', noVen.indexOf('/v?id=') === -1);

/* ------------------------------------------------------------------ */
console.log('\n=== r25: ticketBlock tells three stories, not two ===');
/* "No vendor" used to mean one thing — a preference booking that consumed no
   availability row — and the line said exactly that. r25 adds UNASSIGNED
   CAPACITY: the customer picked a real slot, it is held, their time is
   promised, and Serve owes them a partner. Telling an operator that booking
   "consumed no availability row" would be false, and false about the one case
   that actually needs them today. */
const promised = S.ticketBlock('SRV-20260920-BBBBBB', 'CON-0001', '', 'booked');
t('a held slot with no vendor shouts that the time is promised',
  /NO VENDOR YET, AND THE TIME IS PROMISED/.test(promised), promised.slice(-260));
t('and does NOT repeat the "consumed no availability row" line',
  !/consumed no/.test(promised));
t('it still names the fix', /vendor_id/.test(promised) && /printVendorLinks/.test(promised));
t('and tells the operator what the customer is seeing meanwhile',
  /Coordinating with our vendor network/.test(promised));
t('still no vendor link, because there is no vendor',
  promised.indexOf('/v?id=') === -1);

/* The preference booking keeps its own wording — it really did consume
   nothing, and conflating the two would lose the distinction r25 adds. */
t('a preference booking still says no row was consumed',
  /consumed no/.test(S.ticketBlock('SRV-20260920-CCCCCC', 'CON-0001', '', 'n/a')));
/* And an assigned booking is untouched by any of this. */
const assigned = S.ticketBlock('SRV-20260920-DDDDDD', 'CON-0001', 'VEN-0001', 'booked');
t('an assigned booking still just gets the vendor portal link',
  /\/v\?id=VEN-0001/.test(assigned) && !/NO VENDOR YET/.test(assigned), assigned.slice(-160));

/* ------------------------------------------------------------------ */
head('r26: the booking text');
/* One SMS on booking: a sentence and the portal link. Four gates close it, and
   the first of them is the one with a legal penalty attached. */
{
  const sms = (over) => S.sendBookingSms(Object.assign({
    name: 'Uriel Lopez', phone: '(617) 555-0100', sms_transactional: 'yes',
  }, over), 'CON-0001', 'SRV-20260920-EEEEEE');
  const sent = () => T.fetches.length;

  /* THE CONSENT GATE. Blank is not "no on record", it is "nobody asked" — and
     either way it is not permission. This is the A2P 10DLC line. */
  let before = sent();
  t('no consent means no text, and no request at all',
    sms({ sms_transactional: '' }) === 'no consent' && sent() === before);
  t('and "no" is not treated as a yes either',
    sms({ sms_transactional: 'no' }) === 'no consent' && sent() === before);
  t('nor is any other truthy-looking value',
    sms({ sms_transactional: 'YES' }) === 'no consent' && sent() === before);

  /* Unset credentials mean the feature is simply off, like QUOTE_SECRET. */
  t('unconfigured Twilio is a silent no-op', sms() === 'twilio not configured' &&
    sent() === before);

  T.propStore.TWILIO_ACCOUNT_SID = 'AC_test_sid';
  T.propStore.TWILIO_AUTH_TOKEN  = 'test_token';
  T.propStore.TWILIO_FROM        = '+15550001111';

  t('an unusable phone sends nothing',
    sms({ phone: '12' }) === 'no usable phone' && sent() === before);
  t('and no contact_id means no link, so no text',
    S.sendBookingSms({ name: 'A', phone: '6175550100', sms_transactional: 'yes' },
                     '', 'SRV-1') === 'no contact_id, so no portal link' &&
    sent() === before);

  /* The happy path. */
  t('with consent, credentials, a phone and a portal, it sends', sms() === 'sent');
  const call = T.fetches[T.fetches.length - 1];
  t('to Twilio, under the configured account',
    /api\.twilio\.com\/2010-04-01\/Accounts\/AC_test_sid\/Messages\.json/.test(call.url),
    call.url);
  t('the number is E.164 with the plus Twilio wants',
    call.opts.payload.To === '+16175550100', call.opts.payload.To);
  t('from the configured number', call.opts.payload.From === '+15550001111');
  t('authenticated, and the token is not in the URL',
    /^Basic /.test(call.opts.headers.Authorization) && !/test_token/.test(call.url));
  t('a 4xx comes back as a response to read, not a throw',
    call.opts.muteHttpExceptions === true);

  const body = call.opts.payload.Body;
  t('the message carries the portal link', /\/h\?id=CON-0001&t=/.test(body), body);
  t('and greets them by first name only, never the surname',
    /Hi Uriel/.test(body) && !/Lopez/.test(body), body);
  t('and honours the opt-out sms-terms.html promises in writing',
    /Reply STOP to opt out\./.test(body), body);
  /* EVERY SEGMENT IS BILLED, AND THE ALPHABET DECIDES HOW BIG A SEGMENT IS.
     GSM-7 carries 153 characters per segment of a multi-part text. One
     character outside it — an em dash, a curly quote, a backtick — switches
     the WHOLE message to UCS-2 at 67. r26 shipped with an em dash after the
     name and turned a two-segment text into a three-segment one on every
     booking, while the length check that stood here passed, because 191 is
     comfortably under 320. Length alone was the wrong question.
     Checked with an ASCII first name: a name outside GSM-7 is the customer's
     own, and may legitimately cost a segment. */
  const nonGsm = [...body].filter(ch => {
    const c = ch.codePointAt(0);
    return !(c === 10 || (c >= 32 && c <= 126 && c !== 96));
  });
  t('the text is pure GSM-7, so it is never billed at the UCS-2 rate',
    nonGsm.length === 0, nonGsm);
  /* The real billing arithmetic, in whichever alphabet the text actually is.
     The eight GSM-7 extension characters cost two septets each. */
  const EXT = '[]{}|^~' + String.fromCharCode(92);
  const ucs2 = nonGsm.length > 0;
  const units = ucs2 ? body.length
                     : [...body].reduce((n, ch) => n + (EXT.indexOf(ch) !== -1 ? 2 : 1), 0);
  const segments = units <= (ucs2 ? 70 : 160) ? 1 : Math.ceil(units / (ucs2 ? 67 : 153));
  t('and it bills as two segments at most', segments <= 2,
    { encoding: ucs2 ? 'UCS-2' : 'GSM-7', units, segments });
  t('with no first name it still opens with a capital',
    /^Your Serve clean/.test(S.bookingSmsText('', 'https://x')), S.bookingSmsText('', 'https://x'));

  /* Twilio refusing is not a booking failing. */
  T.setFetchReply(400, '{"code":21610,"message":"Attempt to send to unsubscribed recipient +16175550100"}');
  t('a Twilio error is reported, not thrown', sms() === 'failed http 400');

  /* THE LOG IS THE ONE PLACE THIS COULD LEAK. Twilio's own error text carries
     the TO number; the portal link is a live credential. Neither may be logged,
     and the rule about addresses in logs is older than this feature. */
  /* Scoped to the lines THIS feature writes. A blanket search over every log
     line fails on printCustomerLinks(), an editor-run operator tool whose whole
     purpose is to print portal links for somebody to copy — a deliberate thing,
     not a leak, and not something the booking path does. */
  const smsLogs = T.logs.filter(l => /booking SMS/.test(l)).join(' | ');
  t('the SMS path logs something at all', smsLogs.length > 0);
  t('no phone number reaches an SMS log line',
    !/6175550100|\+1617/.test(smsLogs), smsLogs);
  t('no portal link reaches an SMS log line', !/\/h\?id=/.test(smsLogs), smsLogs);
  t('no auth token reaches an SMS log line', !/test_token/.test(smsLogs));
  t('and Twilio\'s own error text, which quotes the number, is not echoed',
    !/unsubscribed recipient/.test(smsLogs), smsLogs);
  t('but the job id does, so a failure can be chased',
    /SRV-20260920-EEEEEE/.test(smsLogs));
}


/* ------------------------------------------------------------------
   r36 — a first clean sold with a plan is still a first clean.

   Reported from a real test booking: the customer chose a First Clean AND a
   recurring cadence, and their portal called the upcoming visit a recurring
   clean. The cadence describes what happens after this visit.
   ------------------------------------------------------------------ */
head('20. r36 — the cadence does not rename the visit');

t('a first clean on a weekly plan is a first clean',
  S.serviceCodeOf('First Clean', 'weekly') === 'CLEAN_DEEP',
  S.serviceCodeOf('First Clean', 'weekly'));
t('and on biweekly', S.serviceCodeOf('First Clean', 'biweekly') === 'CLEAN_DEEP');
t('and on monthly', S.serviceCodeOf('First Clean', 'monthly') === 'CLEAN_DEEP');
t('a first clean on its own is unchanged',
  S.serviceCodeOf('First Clean', 'once') === 'CLEAN_DEEP');
/* The cadence still names the service when nothing else does — this is what a
   genuine recurring booking stores in service_type. */
t('a recurring booking is still a recurring clean',
  S.serviceCodeOf('standard', 'biweekly') === 'CLEAN_STANDARD',
  S.serviceCodeOf('standard', 'biweekly'));
t('a one-off with no service named is still a deep clean',
  S.serviceCodeOf('', 'once') === 'CLEAN_DEEP');
/* Move-out is decided before either and must stay that way: it is bookable on
   a plan too, and it is neither of the other two. */
t('move-out wins over any cadence',
  S.serviceCodeOf('Move In / Move Out', 'weekly') === 'CLEAN_MOVEOUT');

/* End to end, because the resolver being right is not the same as the portal
   showing it. This is the shape of the booking that was reported. */
seedJob('SRV-20261001-PLAN01', 'uriel@example.com', 'PROP-0001', { frequency: 'weekly' });
const P20 = get({ portal: 'CON-0001', t: MINE });
const planned = (P20.bookings || []).filter(b => b.bookingId === 'SRV-20261001-PLAN01')[0];
t('the booking is in the portal', !!planned, 'SRV-20261001-PLAN01');
t('and it is titled as the first clean they booked',
  !!planned && planned.serviceLabel === 'First clean',
  planned && planned.serviceLabel);
t('the plan they chose is reported alongside the visit',
  !!planned && planned.frequency === 'weekly', planned && planned.frequency);
/* A one-off booking has a cadence too — "once" — and it must not read as a
   plan. The renderer decides what to show; the payload just tells the truth. */
const oneOff = (P20.bookings || []).filter(b => b.bookingId === 'SRV-20260920-AAAAAA')[0];
t('a one-off booking reports once, not blank',
  !!oneOff && oneOff.frequency === 'once', oneOff && oneOff.frequency);


/* ------------------------------------------------------------------
   r38 — a plan is an offer, not a booking.

   Somebody who books a first clean and picks a cadence has asked for ONE clean
   and expressed an intention about the rest. Nothing may be scheduled, no slot
   held and no vendor assigned until they confirm it themselves.
   ------------------------------------------------------------------ */
head('21. r38 — the recurring plan a customer was offered');

const PLAN_H = ['plan_id','contact_id','lead_id','origin_job_id','property_id',
  'frequency','quoted_price','created_at','expires_at','status','anchor_date',
  'anchor_time','preferred_vendor_id','confirmed_job_id'];
const planStamp = (msFromNow) => new Date(Date.now() + msFromNow).toISOString();
const pushPlan = (over) => {
  const row = Object.assign({
    plan_id: 'PLN-1', contact_id: 'CON-0001', lead_id: 'uriel@example.com',
    origin_job_id: 'SRV-20260920-AAAAAA', property_id: 'PROP-0001',
    frequency: 'weekly', quoted_price: 111,
    created_at: planStamp(-1000), expires_at: planStamp(6 * 86400000),
    status: 'pending', anchor_date: '', anchor_time: '',
    preferred_vendor_id: '', confirmed_job_id: '',
  }, over || {});
  T.tabs.RECURRING_PLANS.appendRow(PLAN_H.map(k => row[k]));
};
const onlyPlan = () => { T.tabs.RECURRING_PLANS._rows.length = 1; };
const planNow = () => get({ portal: 'CON-0001', t: MINE }).plan;

pushPlan({});
const P21 = get({ portal: 'CON-0001', t: MINE });
t('the open plan reaches the portal', !!P21.plan, P21.plan);
t('with the cadence they chose', P21.plan && P21.plan.frequency === 'weekly',
  P21.plan && P21.plan.frequency);
t('and the price they were quoted, not one recomputed today',
  P21.plan && P21.plan.price === 111, P21.plan && P21.plan.price);
t('it names the visit it follows rather than inventing a date',
  P21.plan && P21.plan.afterJobId === 'SRV-20260920-AAAAAA', P21.plan);

/* A WHITELIST like every other view model here.

   Read through `|| {}` deliberately: a change that stops plans matching makes
   this null, and Object.keys(null) THROWS — killing the file before every
   later assertion, including ones in other sections that would have caught
   the change honestly. Never dereference a value a mutation can null. */
t('the plan exposes exactly the named fields',
  JSON.stringify(Object.keys(P21.plan || {}).sort()) ===
    JSON.stringify(['afterJobId','expiresAt','frequency','planId','price','samePartner']),
  Object.keys(P21.plan || {}));

/* NOTHING MAY BE BOOKED BY OFFERING A PLAN. This is the whole point of the
   release: an offer that quietly consumed a slot would be precisely the thing
   the founder said not to build. */
t('offering a plan writes no JOBS row',
  !(T.tabs.JOBS._rows || []).slice(1).some(r => /^PLN-/.test(String(r[0]))),
  'a plan id appeared in JOBS');
t('and no booking claims to be a recurring visit yet',
  !(P21.bookings || []).some(b => b.bookingId && /^PLN-/.test(b.bookingId)));

/* ---- the window closes on its own ---- */
onlyPlan();
pushPlan({ plan_id: 'PLN-OLD', expires_at: planStamp(-86400000) });
t('a plan past its window reads as gone, with nothing having swept it',
  planNow() === null, planNow());

/* An unreadable window must not silently delete somebody's offer. */
onlyPlan();
pushPlan({ plan_id: 'PLN-ODD', expires_at: 'sometime next week' });
t('an unreadable window leaves the plan standing rather than expiring it',
  !!planNow());

/* ---- it is one customer's plan ---- */
/* r40: distinguished by lead_id, not contact_id. Plans are matched on lead_id
   now, so a fixture that differed only by contact_id would be VISIBLE here and
   this assertion would silently stop testing isolation. */
onlyPlan();
pushPlan({ plan_id: 'PLN-THEIRS', contact_id: 'CON-0002',
           lead_id: 'other@example.com' });
t('another customer plan is not visible here', planNow() === null);

/* ---- a confirmed plan is no longer an open offer ---- */
onlyPlan();
pushPlan({ plan_id: 'PLN-DONE', status: 'confirmed' });
t('a confirmed plan stops being an open offer', planNow() === null);

/* ---- a missing tab costs the prompt, never the portal ---- */
onlyPlan();
const savedPlans = T.tabs.RECURRING_PLANS;
delete T.tabs.RECURRING_PLANS;
const P21b = get({ portal: 'CON-0001', t: MINE });
t('a missing RECURRING_PLANS tab still returns the portal',
  P21b.ok === true && (P21b.bookings || []).length > 0, P21b.error);
t('and simply offers no plan', P21b.plan === null, P21b.plan);
T.tabs.RECURRING_PLANS = savedPlans;


/* ------------------------------------------------------------------
   r40 — a plan is found by lead_id, not contact_id.

   The r39 backfill wrote ten plans and none appeared in a portal. They were
   correct rows that matched nobody: the backfill read contact_id off the JOBS
   row, and JOBS.contact_id is not reliably populated — it self-backfills onto
   LEADS for older rows and never onto JOBS. The portal's own chain is
   contact_id -> LEADS -> lead_id -> JOBS precisely to avoid depending on it.
   ------------------------------------------------------------------ */
head('22. r40 — a backfilled plan reaches the customer it belongs to');

/* THE EXACT SHAPE THE BACKFILL PRODUCED: a real lead_id and a blank contact_id,
   because the JOBS row it was built from had no contact to copy. */
onlyPlan();
pushPlan({ plan_id: 'PLN-BLANK', contact_id: '' });
const blankContact = planNow();
t('a plan with NO contact_id still reaches its customer',
  !!blankContact && blankContact.planId === 'PLN-BLANK', blankContact);
t('carrying the cadence and the price it was quoted at',
  !!blankContact && blankContact.frequency === 'weekly' && blankContact.price === 111,
  blankContact);

/* lead_id is an email and cases drift between a form and a sheet. */
onlyPlan();
pushPlan({ plan_id: 'PLN-CASE', contact_id: '', lead_id: 'Uriel@Example.com  ' });
t('and matches regardless of case or stray spaces', !!planNow(), planNow());
/* That covers the ROW side — the stored lead is trimmed and lower-cased. The
   lead being ASKED about is normalised too, and nothing above exercises it:
   the portal always passes an already-clean address. Asked directly with a
   messy one, it must still find the plan. */
t('and tolerates a messy lead on the way in too',
  !!S.clientRecurringPlan(T.ss, '  URIEL@Example.com  '),
  S.clientRecurringPlan(T.ss, '  URIEL@Example.com  '));

/* A plan belonging to somebody else must still be invisible — the isolation
   this release could have quietly broken. */
onlyPlan();
pushPlan({ plan_id: 'PLN-OTHER', contact_id: 'CON-0001', lead_id: 'other@example.com' });
t('a plan for another lead is not shown, even with this contact_id on it',
  planNow() === null, planNow());

/* A blank lead_id matches nothing rather than matching everything — the failure
   mode that would show one customer another customer's plan. */
onlyPlan();
pushPlan({ plan_id: 'PLN-NOLEAD', contact_id: '', lead_id: '' });
t('a plan with no lead_id at all reaches nobody', planNow() === null, planNow());

/* THE GUARD ITSELF. The assertion above passes on the comparison — this
   customer has a real lead_id, so a blank one on the row simply does not match.
   It says nothing about what happens when the CALLER has no lead, which is
   where '' !== '' is false and every blank-lead plan would match at once.
   Asked directly, a blank lead must answer with nothing. */
t('asked for a blank lead, it answers with nothing at all',
  S.clientRecurringPlan(T.ss, '') === null, S.clientRecurringPlan(T.ss, ''));

/* ------------------------------------------------------------------
   r42 — confirm & schedule: the offer becomes a booking.

   r38 proved that OFFERING a plan holds nothing. This is the other half of
   that promise: the moment a customer picks a time, a JOBS row is written, a
   slot is taken away from everybody else, and the anchor every later visit is
   counted from is set.

   It is the only portal write that creates a booking, which is why ownership
   is proved on both the plan and the booking it came from, why the time is
   validated rather than passed along, and why the double-tap guard is
   asserted directly rather than assumed.
   ------------------------------------------------------------------ */
head('23. r42 — confirming a plan books a real visit');

const AVAIL_H = ['date','start_time','vendor_id','status','job_id'];
const pushSlot = (date, time, vendor) =>
  T.tabs.AVAILABILITY.appendRow([date, time, vendor || '', 'open', '']);
const slotRow = (date, time) => (T.tabs.AVAILABILITY._rows || []).slice(1)
  .filter(r => r[0] === date && r[1] === time)[0] || [];
const slotCell = (date, time, col) => slotRow(date, time)[AVAIL_H.indexOf(col)];

const jobsRows = () => (T.tabs.JOBS._rows || []).slice(1);
const jobCell  = (jobId, col) => (jobsRows()
  .filter(r => String(r[JOBS_HEADERS.indexOf('job_id')]).trim() === jobId)[0] || [])
  [JOBS_HEADERS.indexOf(col)];
const planCell = (planId, col) => ((T.tabs.RECURRING_PLANS._rows || []).slice(1)
  .filter(r => String(r[0]).trim() === planId)[0] || [])[PLAN_H.indexOf(col)];
const setPlanCell = (planId, col, v) => {
  const rows = T.tabs.RECURRING_PLANS._rows;
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).trim() === planId) rows[i][PLAN_H.indexOf(col)] = v;
  }
};
const setJobCell = (jobId, col, v) => {
  const rows = T.tabs.JOBS._rows;
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][JOBS_HEADERS.indexOf('job_id')]).trim() === jobId) {
      rows[i][JOBS_HEADERS.indexOf(col)] = v;
    }
  }
};
const confirm = (over, tok, cid) => write(Object.assign(
  { kind: 'plan_confirm', plan_id: 'PLN-CONF',
    slot_date: '2026-10-02', slot_time: '9:00 AM' }, over || {}), tok, cid);

/* The origin booking gets a partner, so "the same company as last time" has a
   company to mean. */
setJobCell('SRV-20260920-AAAAAA', 'vendor_id', 'VEN-ORIGIN');

onlyPlan();
pushPlan({ plan_id: 'PLN-CONF' });
pushSlot('2026-10-02', '9:00 AM', 'VEN-SLOT');

const jobsBefore = jobsRows().length;
const C1 = confirm();

t('it confirms', C1.ok === true, C1);
t('and names the booking it made', /^SRV-/.test(String(C1.job_id || '')), C1.job_id);
const NEW = String(C1.job_id || '');
t('exactly one JOBS row was written',
  jobsRows().length === jobsBefore + 1, jobsRows().length - jobsBefore);

t('it is a RECURRING clean, not a second first clean',
  jobCell(NEW, 'service_type') === 'Recurring clean', jobCell(NEW, 'service_type'));
t('carrying the cadence they chose',
  jobCell(NEW, 'frequency') === 'weekly', jobCell(NEW, 'frequency'));
t('at the price the plan held, not one recomputed today',
  Number(jobCell(NEW, 'quoted_price')) === 111, jobCell(NEW, 'quoted_price'));
t('on the day and at the time they picked',
  jobCell(NEW, 'scheduled_date') === '2026-10-02' && jobCell(NEW, 'start_time') === '9:00 AM',
  [jobCell(NEW, 'scheduled_date'), jobCell(NEW, 'start_time')]);
t('joined to the same customer', jobCell(NEW, 'lead_id') === 'uriel@example.com',
  jobCell(NEW, 'lead_id'));
t('and the same home', jobCell(NEW, 'property_id') === 'PROP-0001',
  jobCell(NEW, 'property_id'));
t('the home it will clean is the one they already have',
  jobCell(NEW, 'address') === '123 Beacon St', jobCell(NEW, 'address'));

/* THE ID MUST NOT COLLIDE WITH THE BOOKING IT CAME FROM. A job_id is built
   from the date plus the last six characters of the submission_id, and a plan
   id is its origin job's id with the prefix swapped — so an id derived from
   the plan ALONE ends in the same six characters the first clean's does. A
   plan confirmed for the same calendar day as that clean would then mint the
   identical job_id, and getBooking would answer with the wrong row forever. */
t('its job_id is not the origin booking\'s', NEW !== 'SRV-20260920-AAAAAA', NEW);

/* A BOOKING TAKES CAPACITY. This is the whole difference between the offer
   r38 shipped and the booking this release makes out of it. */
t('the slot is now booked', slotCell('2026-10-02', '9:00 AM', 'status') === 'booked',
  slotCell('2026-10-02', '9:00 AM', 'status'));
t('and carries the job that took it',
  slotCell('2026-10-02', '9:00 AM', 'job_id') === NEW,
  slotCell('2026-10-02', '9:00 AM', 'job_id'));
t('the partner whose capacity it was is stamped on the job',
  jobCell(NEW, 'vendor_id') === 'VEN-SLOT', jobCell(NEW, 'vendor_id'));

/* THE ANCHOR. Every later visit is counted from this, not from wherever a
   one-off reschedule moves a single visit to. */
t('the plan reads confirmed', planCell('PLN-CONF', 'status') === 'confirmed',
  planCell('PLN-CONF', 'status'));
t('with the anchor every later visit is counted from',
  planCell('PLN-CONF', 'anchor_date') === '2026-10-02' &&
  planCell('PLN-CONF', 'anchor_time') === '9:00 AM',
  [planCell('PLN-CONF', 'anchor_date'), planCell('PLN-CONF', 'anchor_time')]);
t('and the booking it turned into',
  planCell('PLN-CONF', 'confirmed_job_id') === NEW,
  planCell('PLN-CONF', 'confirmed_job_id'));
t('the portal stops offering it', planNow() === null, planNow());
t('and the visit is in their bookings instead',
  (get({ portal: 'CON-0001', t: MINE }).bookings || []).some(b => b.bookingId === NEW));

/* ---- a double-tapped button makes ONE booking ---- */
t('confirming the same plan again is refused',
  confirm().error === 'already_confirmed', confirm());

/* THE GUARD UNDER THE GUARD. The status check above answers the second tap.
   It cannot answer the tap that arrives after the JOBS row is written and
   before the status write lands — so put the row back the way that window
   leaves it and prove the deterministic submission_id still stops a second
   booking on its own. */
const beforeRace = jobsRows().length;
setPlanCell('PLN-CONF', 'status', 'pending');
const C3 = confirm();
t('a confirmation racing its own status write still books once',
  C3.ok === true && C3.duplicate === true, C3);
t('and writes no second JOBS row', jobsRows().length === beforeRace,
  jobsRows().length - beforeRace);

/* ---- THE OWNERSHIP CHECK, on the one write that creates a booking ---- */
onlyPlan();
pushPlan({ plan_id: 'PLN-MINE' });
pushSlot('2026-10-03', '9:00 AM', '');
const beforeTheft = jobsRows().length;
t('another customer cannot confirm this plan',
  confirm({ plan_id: 'PLN-MINE', slot_date: '2026-10-03' }, THEIRS, 'CON-0002')
    .error === 'not_found');
t('and nothing was booked by trying', jobsRows().length === beforeTheft);
t('an unknown plan looks exactly like one that is not theirs',
  confirm({ plan_id: 'PLN-NOPE', slot_date: '2026-10-03' }).error === 'not_found');

/* THE PLAN'S OWN lead_id IS A SEPARATE GUARD FROM THE BOOKING'S — and the
   assertions above do not test it. A mutation run proved it: disabling the
   plan's lead check changed nothing, because every attempt to confirm
   somebody else's plan ALSO reached somebody else's origin booking, and the
   second check answered first. A guard proven only by the guard behind it is
   not proven at all; that is the r40 lesson in a new place.

   This is the fixture that separates them: a plan row carrying ANOTHER
   customer's lead_id while pointing at THIS customer's booking — what a
   mis-keyed backfill leaves behind. The origin check passes here. Only the
   plan's own lead_id refuses it. */
onlyPlan();
pushPlan({ plan_id: 'PLN-CROSSED', lead_id: 'other@example.com',
           origin_job_id: 'SRV-20260920-AAAAAA' });
pushSlot('2026-10-04', '9:00 AM', '');
const beforeCrossed = jobsRows().length;
const CROSSED = confirm({ plan_id: 'PLN-CROSSED', slot_date: '2026-10-04' });
t('a plan carrying another customer\'s lead is refused, though the booking is mine',
  CROSSED.error === 'not_found', CROSSED);
t('and refusing it booked nothing',
  jobsRows().length === beforeCrossed, jobsRows().length - beforeCrossed);

/* ---- the window closes on confirmation too, not only on display ---- */
onlyPlan();
pushPlan({ plan_id: 'PLN-LATE', expires_at: planStamp(-86400000) });
t('a lapsed plan cannot be confirmed at the held price',
  confirm({ plan_id: 'PLN-LATE', slot_date: '2026-10-03' }).error === 'expired');

/* ---- the time is validated, not merely passed along ----
   An unreadable time matches no AVAILABILITY row, consumes nothing, and would
   leave a customer holding a confirmation for a visit no cleaner can see. */
onlyPlan();
pushPlan({ plan_id: 'PLN-TIME' });
const beforeJunk = jobsRows().length;
t('a time in no recognisable shape is refused',
  confirm({ plan_id: 'PLN-TIME', slot_time: 'sometime Tuesday' }).error === 'bad_slot');
t('and a date that is not a date',
  confirm({ plan_id: 'PLN-TIME', slot_date: 'next week' }).error === 'bad_slot');
t('neither booked anything', jobsRows().length === beforeJunk);

/* ---- the one day on which the job_id could collide ----
   THE SUFFIX ON THE SUBMISSION ID IS LOAD-BEARING, and only a confirmation on
   the origin booking's OWN DAY can prove it. A job_id is the date plus the
   last six characters of the submission_id, and a plan_id is its origin job's
   id with the prefix swapped — so an id derived from the plan alone ends in
   the same six characters the first clean's does. On this one date that makes
   the two job_ids identical, and getBooking would answer every later question
   about either booking with the same row. */
onlyPlan();
pushPlan({ plan_id: 'PLN-20260920-AAAAAA' });
pushSlot('2026-09-20', '3:00 PM', '');
const C6 = confirm({ plan_id: 'PLN-20260920-AAAAAA',
                     slot_date: '2026-09-20', slot_time: '3:00 PM' });
t('a plan confirmed for the same day as its own first clean still gets its own id',
  C6.ok === true && C6.job_id !== 'SRV-20260920-AAAAAA', C6);
t('and there are not two rows answering to one id',
  jobsRows().filter(r => String(r[JOBS_HEADERS.indexOf('job_id')]).trim() ===
    'SRV-20260920-AAAAAA').length === 1,
  jobsRows().filter(r => String(r[JOBS_HEADERS.indexOf('job_id')]).trim() ===
    'SRV-20260920-AAAAAA').length);

/* ---- "the same company", resolved on this side ---- */
onlyPlan();
pushPlan({ plan_id: 'PLN-SAME' });
pushSlot('2026-10-05', '1:00 PM', 'VEN-SLOT2');
const C4 = confirm({ plan_id: 'PLN-SAME', slot_date: '2026-10-05',
                     slot_time: '1:00 PM', same_provider: true });
t('asking for the same company is recorded on the plan',
  C4.ok === true && planCell('PLN-SAME', 'preferred_vendor_id') === 'VEN-ORIGIN',
  planCell('PLN-SAME', 'preferred_vendor_id'));

/* THE BROWSER NEVER NAMES THE COMPANY. It sends yes or no; which vendor that
   means is read off the origin booking here. A payload that could name one
   would be a request for any company on the network, indistinguishable at
   dispatch from a request Serve made itself. */
onlyPlan();
pushPlan({ plan_id: 'PLN-INJECT' });
pushSlot('2026-10-06', '1:00 PM', '');
confirm({ plan_id: 'PLN-INJECT', slot_date: '2026-10-06', slot_time: '1:00 PM',
          same_provider: true, preferred_vendor_id: 'VEN-PICKED-BY-THE-BROWSER',
          vendor_id: 'VEN-PICKED-BY-THE-BROWSER' });
t('a payload naming a vendor cannot request that vendor',
  planCell('PLN-INJECT', 'preferred_vendor_id') === 'VEN-ORIGIN',
  planCell('PLN-INJECT', 'preferred_vendor_id'));

onlyPlan();
pushPlan({ plan_id: 'PLN-NOASK' });
pushSlot('2026-10-07', '1:00 PM', '');
confirm({ plan_id: 'PLN-NOASK', slot_date: '2026-10-07', slot_time: '1:00 PM' });
t('not asking records no preference at all',
  planCell('PLN-NOASK', 'preferred_vendor_id') === '',
  planCell('PLN-NOASK', 'preferred_vendor_id'));

/* ---- the portal only offers the question when there is an answer ---- */
onlyPlan();
pushPlan({ plan_id: 'PLN-FLAG' });
t('the portal says there is a previous company to ask for',
  (planNow() || {}).samePartner === true, planNow());
setJobCell('SRV-20260920-AAAAAA', 'vendor_id', '');
t('and says there is not when nobody was ever assigned',
  (planNow() || {}).samePartner === false, planNow());
t('a vendor_id still never reaches the browser',
  !JSON.stringify(planNow() || {}).includes('VEN-'), planNow());

/* ------------------------------------------------------------------
   r43 — a booked visit can be moved, or called off.

   r42 made an offer into a booking. This is what a customer can do to that
   booking afterwards, and it is the first code in the system that ever GIVES
   CAPACITY BACK. SCHEMA has carried "nothing releases a slot" as a known open
   item since r5; every cancellation until now leaked a time out of the feed
   permanently.

   The assertion this release exists to protect is THE ANCHOR. Moving one visit
   must not move the cadence, and cancelling one visit must not cancel the plan.
   ------------------------------------------------------------------ */
head('24. r43 — moving a visit, and calling one off');

/* A slot in whatever state the test needs, rather than always an open one —
   releasing capacity can only be watched on a row that is already booked. */
const pushSlotAs = (date, time, vendor, status, jobId) =>
  T.tabs.AVAILABILITY.appendRow([date, time, vendor || '', status, jobId || '']);
/* Found BY JOB, not by date and time: the whole point of the release path is
   that it tracks the booking, not the calendar square it happens to sit in. */
const slotsHolding = (jobId) => (T.tabs.AVAILABILITY._rows || []).slice(1)
  .filter(r => String(r[AVAIL_H.indexOf('job_id')]).trim() === jobId);

const MOVER = 'SRV-20261101-MOVING';
seedJob(MOVER, 'uriel@example.com', 'PROP-0001',
        { scheduled_date: '2026-11-01', start_time: '9:00 AM',
          service_type: 'Recurring clean', frequency: 'weekly' });
pushSlotAs('2026-11-01', '9:00 AM', 'VEN-OLD', 'booked', MOVER);
pushSlot('2026-11-08', '1:00 PM', 'VEN-NEW');

/* The plan this visit belongs to, already confirmed and carrying the anchor
   r42 wrote. Without this row the headline assertion has nothing to watch. */
onlyPlan();
pushPlan({ plan_id: 'PLN-ANCHOR', status: 'confirmed', anchor_date: '2026-11-01',
           anchor_time: '9:00 AM', confirmed_job_id: MOVER });

const move = (over, tok, cid) => write(Object.assign(
  { kind: 'reschedule', job_id: MOVER,
    slot_date: '2026-11-08', slot_time: '1:00 PM' }, over || {}), tok, cid);

const R1 = move();
t('it moves', R1.ok === true, R1);
t('the visit is on the new day', jobCell(MOVER, 'scheduled_date') === '2026-11-08',
  jobCell(MOVER, 'scheduled_date'));
t('and at the new time', jobCell(MOVER, 'start_time') === '1:00 PM',
  jobCell(MOVER, 'start_time'));
t('the schedule summary is rewritten with it',
  /Nov 8/.test(String(jobCell(MOVER, 'notes'))), jobCell(MOVER, 'notes'));
t('and it is still a specific slot', jobCell(MOVER, 'scheduling_type') === 'slot',
  jobCell(MOVER, 'scheduling_type'));

/* THE ID IS AN IDENTITY, NOT A DATE. It is the join key for the AVAILABILITY
   row, the instructions, the photos, the ticket and the portal — re-minting it
   so the digits match the new day would orphan all five at once. */
t('the job keeps the id everything else joins on', R1.job_id === MOVER, R1.job_id);
t('and there is still exactly one row for it',
  jobsRows().filter(r => String(r[JOBS_HEADERS.indexOf('job_id')]).trim() === MOVER).length === 1);

/* THE NEW TIME IS TAKEN. */
t('the new slot is booked', slotCell('2026-11-08', '1:00 PM', 'status') === 'booked',
  slotCell('2026-11-08', '1:00 PM', 'status'));
t('and carries the visit that took it',
  slotCell('2026-11-08', '1:00 PM', 'job_id') === MOVER,
  slotCell('2026-11-08', '1:00 PM', 'job_id'));

/* THE BUG THIS ASSERTION EXISTS FOR, and it was real. A move books the new
   slot under the SAME job_id before giving the old one back, so at release
   time TWO booked rows carry that id. A release matching on the id alone frees
   both — handing back the time the customer just chose, leaving them with a
   confirmation for a slot reading `open` that the next visitor can buy. The
   row just taken is excluded by number. */
t('the time they just chose is NOT given away again',
  slotsHolding(MOVER).length === 1, slotsHolding(MOVER));

/* THE OLD TIME GOES BACK ON SALE — the open item SCHEMA has carried since r5. */
t('the old slot is open again', slotCell('2026-11-01', '9:00 AM', 'status') === 'open',
  slotCell('2026-11-01', '9:00 AM', 'status'));
t('and no longer names a booking',
  slotCell('2026-11-01', '9:00 AM', 'job_id') === '',
  slotCell('2026-11-01', '9:00 AM', 'job_id'));

/* ================================================================
   THE HEADLINE. A one-off move shifts ONE VISIT. The cadence is the anchor,
   and the anchor is what every later visit is counted from — writing the new
   time back onto it would let a single change silently redefine the schedule,
   which is the drift that walks an every-other-Tuesday onto a different day
   over a few months with nobody deciding it.
   ================================================================ */
t('THE ANCHOR DID NOT MOVE WITH THE VISIT',
  planCell('PLN-ANCHOR', 'anchor_date') === '2026-11-01' &&
  planCell('PLN-ANCHOR', 'anchor_time') === '9:00 AM',
  [planCell('PLN-ANCHOR', 'anchor_date'), planCell('PLN-ANCHOR', 'anchor_time')]);
t('and the plan is still confirmed, still pointing at this booking',
  planCell('PLN-ANCHOR', 'status') === 'confirmed' &&
  planCell('PLN-ANCHOR', 'confirmed_job_id') === MOVER,
  [planCell('PLN-ANCHOR', 'status'), planCell('PLN-ANCHOR', 'confirmed_job_id')]);

/* ---- a double-tapped button does not give the slot away ---- */
/* Without the already-there guard this would release the row it holds and then
   try to re-book the very same row — the failure being a customer's own visit
   handed back to nobody. */
const R2 = move();
t('moving a visit to the time it is already at changes nothing',
  R2.ok === true && R2.unchanged === true, R2);
t('and the slot it holds is untouched',
  slotCell('2026-11-08', '1:00 PM', 'status') === 'booked' &&
  slotsHolding(MOVER).length === 1, slotsHolding(MOVER));

/* ---- ownership, on a write that moves somebody's cleaner ---- */
t('another customer cannot move this visit',
  move({}, THEIRS, 'CON-0002').error === 'not_found');
t('and nothing moved by trying', jobCell(MOVER, 'scheduled_date') === '2026-11-08',
  jobCell(MOVER, 'scheduled_date'));
t('an unknown booking looks exactly like one that is not theirs',
  write({ kind: 'reschedule', job_id: 'SRV-NOPE',
          slot_date: '2026-11-08', slot_time: '1:00 PM' }).error === 'not_found');

/* ---- a finished visit is a receipt ---- */
t('a completed booking cannot be moved',
  write({ kind: 'reschedule', job_id: 'SRV-20260810-BBBBBB',
          slot_date: '2026-11-08', slot_time: '1:00 PM' }).error === 'closed');

/* ---- the time is validated, not passed along ---- */
const beforeBad = JSON.stringify(T.tabs.AVAILABILITY._rows);
t('an unreadable time is refused', move({ slot_time: 'sometime Tuesday' }).error === 'bad_slot');
t('an unreadable date is refused', move({ slot_date: 'next week' }).error === 'bad_slot');
t('and neither consumed any capacity',
  JSON.stringify(T.tabs.AVAILABILITY._rows) === beforeBad);

/* ================================================================
   CALLING A VISIT OFF
   ================================================================ */
const KILLED = 'SRV-20261115-CANCEL';
seedJob(KILLED, 'uriel@example.com', 'PROP-0001',
        { scheduled_date: '2026-11-15', start_time: '8:00 AM' });
pushSlotAs('2026-11-15', '8:00 AM', 'VEN-OLD', 'booked', KILLED);

const kill = (over, tok, cid) => write(Object.assign(
  { kind: 'cancel', job_id: KILLED }, over || {}), tok, cid);

const rowsBeforeCancel = jobsRows().length;
const K1 = kill({ reason: 'Away that week.' });
t('it cancels', K1.ok === true, K1);
t('the booking reads cancelled', jobCell(KILLED, 'job_status') === 'cancelled',
  jobCell(KILLED, 'job_status'));

/* THE ROW SURVIVES. Deleting it would take the address, the price, the
   instructions and the attribution with it — and every count of "work booked"
   would quietly stop including the work that was booked and given back. */
t('the row is KEPT, not deleted', jobsRows().length === rowsBeforeCancel,
  jobsRows().length - rowsBeforeCancel);
t('with what was sold still on it',
  jobCell(KILLED, 'quoted_price') === 214 && jobCell(KILLED, 'address') === '123 Beacon St',
  [jobCell(KILLED, 'quoted_price'), jobCell(KILLED, 'address')]);

t('the slot goes back on sale', slotCell('2026-11-15', '8:00 AM', 'status') === 'open',
  slotCell('2026-11-15', '8:00 AM', 'status'));
t('and names no booking', slotCell('2026-11-15', '8:00 AM', 'job_id') === '',
  slotCell('2026-11-15', '8:00 AM', 'job_id'));

/* ---- what the customer's own page is told ---- */
const afterCancel = get({ portal: 'CON-0001', t: MINE });
const killedRow = (afterCancel.bookings || []).filter(b => b.bookingId === KILLED)[0] || {};
t('the portal is told it is cancelled', killedRow.cancelled === true, killedRow.cancelled);
t('and that nothing on it can be acted on', killedRow.editable === false, killedRow.editable);
/* A FIELD, not a string the page has to interpret. job_status is a sheet value
   an operator can reword; a browser comparing against it would start showing
   cancelled visits as live ones the day somebody did. */
t('it is a boolean, not the sheet wording', typeof killedRow.cancelled === 'boolean',
  typeof killedRow.cancelled);
t('a cancelled visit carries no rooms to instruct',
  killedRow.rooms === undefined, killedRow.rooms);

/* ---- a cancelled visit is closed to everything ---- */
t('cancelling it again is refused', kill().error === 'cancelled', kill());
t('and it cannot be moved afterwards',
  write({ kind: 'reschedule', job_id: KILLED,
          slot_date: '2026-11-08', slot_time: '1:00 PM' }).error === 'cancelled');
t('nor instructed', write({ kind: 'instruction', job_id: KILLED,
    scope_type: 'BOOKING', scope_key: 'GENERAL',
    instruction: 'still coming?' }).error === 'cancelled');
t('another customer cannot cancel this visit',
  kill({}, THEIRS, 'CON-0002').error === 'not_found');

/* ================================================================
   WHAT THE RELEASE MUST NEVER TOUCH
   ================================================================ */

/* `held` IS AN OPERATOR'S OWN DIARY. A customer cancelling a visit is not
   permission to hand somebody's held morning back to the public feed. Same
   rule bookAvailabilitySlot has always followed on the way in. */
const HELD = 'SRV-20261120-HELD';
seedJob(HELD, 'uriel@example.com', 'PROP-0001',
        { scheduled_date: '2026-11-20', start_time: '10:00 AM' });
pushSlotAs('2026-11-20', '10:00 AM', 'VEN-OLD', 'held', HELD);
write({ kind: 'cancel', job_id: HELD });
t('a HELD row is never released by a cancellation',
  slotCell('2026-11-20', '10:00 AM', 'status') === 'held',
  slotCell('2026-11-20', '10:00 AM', 'status'));
t('the cancellation itself still stands', jobCell(HELD, 'job_status') === 'cancelled',
  jobCell(HELD, 'job_status'));

/* MATCHED ON job_id, NEVER ON DATE AND TIME. After a conflict a human resolved
   by hand, the square on the calendar can belong to somebody else entirely —
   freeing "the 9 AM row for the 25th" would give away their booking. */
const MINE_AT_NOON = 'SRV-20261125-MINE';
const THEIRS_AT_NOON = 'SRV-20261125-THEIRS';
seedJob(MINE_AT_NOON, 'uriel@example.com', 'PROP-0001',
        { scheduled_date: '2026-11-25', start_time: '12:00 PM' });
pushSlotAs('2026-11-25', '12:00 PM', 'VEN-A', 'booked', MINE_AT_NOON);
pushSlotAs('2026-11-25', '12:00 PM', 'VEN-B', 'booked', THEIRS_AT_NOON);
write({ kind: 'cancel', job_id: MINE_AT_NOON });
t('only the cancelled booking\'s row is freed',
  slotsHolding(MINE_AT_NOON).length === 0, slotsHolding(MINE_AT_NOON));
t('the row at the same time holding ANOTHER booking is untouched',
  slotsHolding(THEIRS_AT_NOON).length === 1 &&
  String(slotsHolding(THEIRS_AT_NOON)[0][AVAIL_H.indexOf('status')]) === 'booked',
  slotsHolding(THEIRS_AT_NOON));

/* ---- the write path cannot become a back door onto ops columns ---- */
/* vendor_id, payment_status and cleaner belong to a dispatcher or to whoever
   reconciles money. A customer-facing path must refuse them LOUDLY rather than
   skip them quietly, so a mistyped field stops the release instead of losing a
   hand entry. */
let opsRefused = '';
try {
  const jobsTab = T.tabs.JOBS;
  S.setJobCells(jobsTab, 2, JOBS_HEADERS.slice(), { vendor_id: 'VEN-SNEAK' });
} catch (e) { opsRefused = String(e.message || e); }
t('setJobCells refuses an ops-owned column outright',
  /refuses "vendor_id"/.test(opsRefused), opsRefused);

/* ================================================================
   THE NOTICE WINDOW — built, tested, and OFF by default.

   A cut-off for changing a booking online is a customer promise with a refund
   question attached, and both were still the founder's open decisions on
   2026-09-13. So the mechanism exists and enforces nothing until a number is
   put in the Ops SETTINGS tab. These run on FRESH harnesses because the hours
   are cached on first read, exactly as payout_rate is.
   ================================================================ */
const dayISO = (n) => {
  const d = new Date(); d.setDate(d.getDate() + n);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
         '-' + String(d.getDate()).padStart(2, '0');
};

function noticeFixture(hours, whenISO) {
  const F = build();
  if (hours !== null) {
    F.tabs.SETTINGS = makeSheet('SETTINGS', ['key', 'value']);
    F.tabs.SETTINGS.appendRow(['cancel_notice_hours', hours]);
  }
  const lead = new Array(LEADS_HEADERS.length).fill('');
  const setL = (k, v) => { lead[LEADS_HEADERS.indexOf(k)] = v; };
  setL('lead_id', 'uriel@example.com'); setL('name', 'Uriel Lopez');
  setL('email', 'uriel@example.com'); setL('contact_id', 'CON-0001');
  F.tabs.LEADS.appendRow(lead);

  const job = new Array(JOBS_HEADERS.length).fill('');
  const setJ = (k, v) => { job[JOBS_HEADERS.indexOf(k)] = v; };
  setJ('job_id', 'SRV-SOON'); setJ('lead_id', 'uriel@example.com');
  setJ('property_id', 'PROP-0001'); setJ('service_type', 'First Clean');
  setJ('frequency', 'once'); setJ('beds', 2); setJ('baths', 1);
  setJ('quoted_price', 214); setJ('scheduled_date', whenISO);
  setJ('start_time', '9:00 AM'); setJ('address', '123 Beacon St');
  setJ('zip', '02116'); setJ('name', 'Uriel Lopez'); setJ('email', 'uriel@example.com');
  F.tabs.JOBS.appendRow(job);

  const tok = F.box.portalToken('CON-0001');
  return {
    call: (o) => JSON.parse(F.box.doPost({ postData: { contents: JSON.stringify(
      Object.assign({ event_type: 'portal_write', contact_id: 'CON-0001', t: tok },
                    o)) } }).getContent()),
    status: () => ((F.tabs.JOBS._rows || []).slice(1)
      .filter(r => String(r[JOBS_HEADERS.indexOf('job_id')]).trim() === 'SRV-SOON')[0]
      || [])[JOBS_HEADERS.indexOf('job_status')],
  };
}

/* Two weeks' notice against a visit tomorrow — comfortably inside the window
   whatever time of day this test runs, so it cannot rot into a flaky red. */
const tooSoon = noticeFixture(336, dayISO(1));
const TL = tooSoon.call({ kind: 'cancel', job_id: 'SRV-SOON' });
t('inside the notice window a cancellation is refused',
  TL.error === 'too_late', TL);
t('and says how much notice is required, for the page to explain',
  TL.hours === 336, TL.hours);
t('nothing was cancelled by trying', tooSoon.status() === '', tooSoon.status());
t('a move is refused on the same footing',
  tooSoon.call({ kind: 'reschedule', job_id: 'SRV-SOON',
                 slot_date: dayISO(20), slot_time: '9:00 AM' }).error === 'too_late');

const farOff = noticeFixture(336, dayISO(30));
t('outside the window the same customer may cancel',
  farOff.call({ kind: 'cancel', job_id: 'SRV-SOON' }).ok === true);

/* THE DEFAULT IS GENUINELY OFF. No SETTINGS row, no window — a visit tomorrow
   can still be cancelled online, because no notice period has been decided. */
const noPolicy = noticeFixture(null, dayISO(1));
t('with nothing configured there is no cut-off at all',
  noPolicy.call({ kind: 'cancel', job_id: 'SRV-SOON' }).ok === true);

/* A nonsense value must not lock customers out of their own bookings. */
const silly = noticeFixture(99999, dayISO(1));
t('an out-of-range notice setting is ignored rather than enforced',
  silly.call({ kind: 'cancel', job_id: 'SRV-SOON' }).ok === true);

/* THE WINDOW MEASURES FROM THE REAL START, and this is asserted directly
   rather than through a fixture. getBooking hands out a DISPLAY time —
   "1:00 PM ET" — so a parser anchored at the END of the string reads nothing,
   falls back to midnight, and measures the window from an instant up to a day
   off. Through a fixture that difference only shows at certain hours, which is
   a test that passes every morning and fails every evening; here it is exact.
   The second clause is what stops both sides simply being midnight. */
t('the clock parser reads the display time a booking actually carries',
  S.wallClockMs('2026-11-08', '1:00 PM ET') === S.wallClockMs('2026-11-08', '1:00 PM') &&
  S.wallClockMs('2026-11-08', '1:00 PM')    !== S.wallClockMs('2026-11-08', ''),
  [S.wallClockMs('2026-11-08', '1:00 PM ET'), S.wallClockMs('2026-11-08', '1:00 PM'),
   S.wallClockMs('2026-11-08', '')]);
t('and a time that is not a clock time at all is not invented into one',
  S.wallClockMs('2026-11-08', 'Morning preferred') === S.wallClockMs('2026-11-08', ''),
  S.wallClockMs('2026-11-08', 'Morning preferred'));

/* ================================================================
   r45 — A PLAN AFTER A MOVE.

   Somebody who booked a move-in / move-out was never offered a recurring
   plan. The portal now shows them the three cadences priced by the ENGINE,
   books the one they pick at a time they pick, and keeps the box as that plan
   until they change it.

   What this section exists to prove, in order of how badly it would hurt:
     1. The price that lands on JOBS is the engine's, asked for with the home
        on the move booking — never a number or a home size from the browser.
     2. Ownership: nobody books or changes a plan on somebody else's move.
     3. A first-clean plan's QUOTED price cannot be re-priced from here.
     4. A change moves the existing visit in place; a finished or cancelled
        visit gets a NEW one, with an id that does not collide.

   A FRESH HARNESS, so the plans and slots of sections 21-24 cannot make an
   assertion pass for the wrong reason.
   ================================================================ */
head('25. r45 — a plan after a move');
{
  const M = build();
  const MB = M.box;
  const MGET  = (cid) => JSON.parse(MB.doGet({ parameter:
    { portal: cid, t: MB.portalToken(cid) } }).getContent());
  const MPOST = (o, cid) => JSON.parse(MB.doPost({ postData: { contents: JSON.stringify(
    Object.assign({ event_type: 'portal_write', contact_id: cid || 'CON-MOVE',
                    t: MB.portalToken(cid || 'CON-MOVE') }, o)) } }).getContent());

  const lead = (leadId, contactId) => {
    const row = new Array(LEADS_HEADERS.length).fill('');
    row[LEADS_HEADERS.indexOf('lead_id')] = leadId;
    row[LEADS_HEADERS.indexOf('name')] = 'Mo Ver';
    row[LEADS_HEADERS.indexOf('contact_id')] = contactId;
    M.tabs.LEADS.appendRow(row);
  };
  const job = (jobId, leadId, over) => {
    const row = new Array(JOBS_HEADERS.length).fill('');
    const set = (k, v) => { row[JOBS_HEADERS.indexOf(k)] = v; };
    set('job_id', jobId); set('lead_id', leadId); set('property_id', 'PROP-MOVE');
    set('service_type', 'Move In / Move Out'); set('frequency', 'once');
    set('condition', 'heavy');
    set('beds', 3); set('baths', 2); set('quoted_price', 640);
    set('scheduled_date', '2026-10-10'); set('start_time', '9:00 AM');
    /* A NUMBER, NOT '02116'. appendRow hands Sheets the text and Sheets keeps
       2116 — every Boston ZIP loses its leading zero. r45 first shipped reading
       the text fixture, passed, and drew no box for any real booking. */
    set('address', '9 Tremont St'); set('unit', '2'); set('zip', 2116);
    set('quote_meta', '{"levels":2}');
    set('name', 'Mo Ver'); set('email', leadId); set('phone', '617-555-0199');
    set('vendor_id', 'VEN-MOVE');
    Object.keys(over || {}).forEach(k => set(k, over[k]));
    M.tabs.JOBS.appendRow(row);
  };
  const rows    = (tab) => (M.tabs[tab]._rows || []).slice(1);
  const jobC    = (jobId, col) => (rows('JOBS').filter(r =>
    String(r[JOBS_HEADERS.indexOf('job_id')]).trim() === jobId)[0] || [])[JOBS_HEADERS.indexOf(col)];
  const setJobC = (jobId, col, v) => rows('JOBS').forEach(r => {
    if (String(r[JOBS_HEADERS.indexOf('job_id')]).trim() === jobId) r[JOBS_HEADERS.indexOf(col)] = v; });
  const planC   = (planId, col) => (rows('RECURRING_PLANS').filter(r =>
    String(r[0]).trim() === planId)[0] || [])[PLAN_H.indexOf(col)];
  const AV = ['date','start_time','vendor_id','status','job_id'];
  const slot  = (date, time, vendor) => M.tabs.AVAILABILITY.appendRow([date, time, vendor || '', 'open', '']);
  const slotC = (date, time, col) => (rows('AVAILABILITY').filter(r =>
    r[0] === date && r[1] === time)[0] || [])[AV.indexOf(col)];

  /* THE ENGINE, STUBBED AT THE WIRE. The Worker answers; these tests watch
     what Apps Script ASKS it and whether it believes the answer. */
  const PRICES = { weekly: 180, biweekly: 210, monthly: 260 };
  const quoteCalls = [];
  let quoteReply = () => ({ code: 200, text: JSON.stringify({ ok: true, price: 999, recurring: PRICES }) });
  MB.UrlFetchApp = { fetch: (url, opts) => {
    if (url === 'https://servecleaning.com/api/quote') {
      quoteCalls.push(JSON.parse(opts.payload));
      const r = quoteReply();
      return { getResponseCode: () => r.code, getContentText: () => r.text };
    }
    return { getResponseCode: () => 201, getContentText: () => '{}' };
  } };

  lead('mover@example.com', 'CON-MOVE');
  lead('first@example.com', 'CON-FIRST');
  lead('gone@example.com',  'CON-GONE');
  const MOVE = 'SRV-20261010-MOVE01';
  job(MOVE, 'mover@example.com');
  job('SRV-20260930-FIRST1', 'first@example.com',
      { service_type: 'First Clean', property_id: 'PROP-FIRST', vendor_id: '' });
  job('SRV-20261012-GONE01', 'gone@example.com',
      { job_status: 'cancelled', property_id: 'PROP-GONE' });

  /* ---- the box, before anything is chosen ---- */
  const V0 = MGET('CON-MOVE');
  const mp = V0.movePlan || {};
  t('a move customer is shown the plan box', mp.state === 'choose', V0.movePlan);
  t('for their move booking', mp.jobId === MOVE, mp.jobId);
  t('naming the home it is for', mp.propertyLabel === '9 Tremont St, 2', mp.propertyLabel);
  t('with the home as the engine prices it, levels from quote_meta',
    JSON.stringify(mp.home) === JSON.stringify({ zip: '02116', bedrooms: 3, bathrooms: 2, levels: 2 }),
    mp.home);
  t('and the move date the first plan visit has to follow', mp.after === '2026-10-10', mp.after);
  t('a previous company exists, so it may be asked for', mp.samePartner === true);
  t('the box is a whitelist — exactly these keys',
    JSON.stringify(Object.keys(mp).sort()) ===
    JSON.stringify(['after','home','jobId','propertyLabel','samePartner','state']), Object.keys(mp));
  t('no vendor id reaches the browser in it', !JSON.stringify(mp).includes('VEN-'));
  t('reading the portal asked the engine nothing — prices are the browser\'s fetch',
    quoteCalls.length === 0, quoteCalls.length);
  t('a first-clean customer gets no move box', MGET('CON-FIRST').movePlan === null);
  t('nor does a move that was called off', MGET('CON-GONE').movePlan === null);

  const start = (over, cid) => MPOST(Object.assign({ kind: 'plan_start', job_id: MOVE,
    frequency: 'biweekly', shown_price: 210, slot_date: '2026-10-24', slot_time: '1:00 PM',
    same_provider: true }, over || {}), cid);
  const jobsAtStart = rows('JOBS').length;

  /* ---- refusals, each writing nothing ---- */
  t('another customer cannot start a plan on this move',
    start({}, 'CON-FIRST').error === 'not_found');
  t('a first clean cannot start a move plan',
    start({ job_id: 'SRV-20260930-FIRST1' }, 'CON-FIRST').error === 'not_found');
  t('a cancelled move cannot either',
    start({ job_id: 'SRV-20261012-GONE01' }, 'CON-GONE').error === 'not_found');
  t('an invented cadence is refused', start({ frequency: 'daily' }).error === 'bad_plan');
  t('no time at all is refused', start({ slot_date: '', slot_time: '' }).error === 'bad_slot');
  t('an unreadable time is refused', start({ slot_time: 'noonish' }).error === 'bad_slot');
  t('a time on the move day itself is refused',
    start({ slot_date: '2026-10-10', slot_time: '3:00 PM' }).error === 'too_early');
  t('as is one before it', start({ slot_date: '2026-10-01' }).error === 'too_early');

  quoteReply = () => ({ code: 502, text: '{"ok":false}' });
  t('no engine answer, no plan', start().error === 'price_unavailable');
  quoteReply = () => ({ code: 200, text: JSON.stringify({ ok: true, recurring: { weekly: 180, biweekly: 0, monthly: 260 } }) });
  t('a non-positive price is not a price', start().error === 'price_unavailable');
  quoteReply = () => ({ code: 200, text: JSON.stringify({ ok: true, price: 999, recurring: PRICES }) });

  const stale = start({ shown_price: 199 });
  t('a price the customer was not shown is REFUSED, not booked', stale.error === 'price_changed', stale);
  t('and the refusal carries the engine\'s prices to show instead',
    JSON.stringify(stale.prices) === JSON.stringify(PRICES), stale.prices);
  t('none of those refusals wrote a job', rows('JOBS').length === jobsAtStart,
    rows('JOBS').length - jobsAtStart);
  t('or a plan', rows('RECURRING_PLANS').length === 0, rows('RECURRING_PLANS').length);

  /* ---- starting one ---- */
  slot('2026-10-24', '1:00 PM', 'VEN-SLOT');
  quoteCalls.length = 0;
  const S1 = start({ bedrooms: 1, bathrooms: 1, zip: '02186', levels: 1 });
  t('it starts', S1.ok === true, S1);
  const VISIT = String(S1.job_id || '');
  const PLAN  = String(S1.plan_id || '');
  t('the plan id is derived from the move booking', PLAN === 'PLN-20261010-MOVE01', PLAN);

  /* THE PRICE IS THE ENGINE'S, FOR THE HOME ON FILE. The payload above tried
     to describe a studio in a cheaper ZIP; none of it may reach the engine. */
  const asked = quoteCalls[0] || {};
  t('the engine was asked exactly once', quoteCalls.length === 1, quoteCalls.length);
  t('about the home on the move booking, not the one in the payload',
    asked.zip === '02116' && asked.bedrooms === 3 && asked.bathrooms === 2 && asked.levels === 2, asked);
  t('in the shape /api/quote prices from',
    asked.service === 'first_clean' && asked.condition === 'standard' &&
    asked.frequency_selected === 'once', asked);
  t('no address travels to the engine', !JSON.stringify(asked).includes('Tremont'));

  t('exactly one JOBS row was written', rows('JOBS').length === jobsAtStart + 1);
  t('a recurring clean', jobC(VISIT, 'service_type') === 'Recurring clean', jobC(VISIT, 'service_type'));
  t('on the cadence chosen', jobC(VISIT, 'frequency') === 'biweekly');
  t('AT THE ENGINE\'S PRICE', Number(jobC(VISIT, 'quoted_price')) === 210 &&
    Number(jobC(VISIT, 'final_price')) === 210, [jobC(VISIT, 'quoted_price'), jobC(VISIT, 'final_price')]);
  t('with no move-out condition carried onto upkeep', jobC(VISIT, 'condition') === '',
    jobC(VISIT, 'condition'));
  t('on the day and time picked', jobC(VISIT, 'scheduled_date') === '2026-10-24' &&
    jobC(VISIT, 'start_time') === '1:00 PM');
  t('at the same home', jobC(VISIT, 'address') === '9 Tremont St' &&
    jobC(VISIT, 'property_id') === 'PROP-MOVE');
  t('for the same customer', jobC(VISIT, 'lead_id') === 'mover@example.com');
  t('its id is not the move booking\'s', VISIT !== MOVE && /^SRV-20261024-/.test(VISIT), VISIT);
  t('the slot is taken', slotC('2026-10-24', '1:00 PM', 'status') === 'booked' &&
    slotC('2026-10-24', '1:00 PM', 'job_id') === VISIT);
  t('and its partner stamped on the visit', jobC(VISIT, 'vendor_id') === 'VEN-SLOT');

  t('the plan row reads confirmed', planC(PLAN, 'status') === 'confirmed');
  t('holding the engine\'s price', Number(planC(PLAN, 'quoted_price')) === 210);
  t('from the move booking', planC(PLAN, 'origin_job_id') === MOVE);
  t('matched on the lead, like every plan', planC(PLAN, 'lead_id') === 'mover@example.com');
  t('anchored at the time chosen', planC(PLAN, 'anchor_date') === '2026-10-24' &&
    planC(PLAN, 'anchor_time') === '1:00 PM');
  t('pointing at the visit', planC(PLAN, 'confirmed_job_id') === VISIT);
  t('with no window — nothing is being held', planC(PLAN, 'expires_at') === '');
  t('the same company, resolved from the move booking',
    planC(PLAN, 'preferred_vendor_id') === 'VEN-MOVE', planC(PLAN, 'preferred_vendor_id'));

  /* ---- the box is now the plan they chose ---- */
  const V1 = MGET('CON-MOVE');
  const sp = V1.movePlan || {};
  t('the box now shows the saved plan', sp.state === 'saved', V1.movePlan);
  t('its cadence, price and visit', sp.frequency === 'biweekly' && sp.price === 210 &&
    sp.visitId === VISIT, sp);
  t('and that the same company was asked for, as a yes', sp.sameAsked === true);
  t('the saved box is a whitelist too',
    JSON.stringify(Object.keys(sp).sort()) === JSON.stringify(['after','frequency','home','jobId',
      'planId','price','propertyLabel','sameAsked','samePartner','state','visitId']), Object.keys(sp));
  t('still with no vendor id', !JSON.stringify(sp).includes('VEN-'));
  t('the visit is in their bookings, upcoming',
    (V1.bookings || []).some(b => b.bookingId === VISIT && !b.completed && !b.cancelled));
  t('and r38\'s offer card stays out of it', V1.plan === null, V1.plan);

  t('starting again is refused, pointing at the plan they have',
    start().error === 'already_confirmed');
  t('and wrote nothing', rows('JOBS').length === jobsAtStart + 1);

  /* THE REPAIR PATH. A failure between the visit and the plan row leaves a
     visit with no plan. Retrying dedupes the visit and writes the missing row. */
  const planRowsNow = M.tabs.RECURRING_PLANS._rows;
  const savedPlanRow = planRowsNow.pop();
  const S2 = start();
  t('a retry after a lost plan row is a duplicate, not a second visit',
    S2.ok === true && S2.duplicate === true && S2.job_id === VISIT, S2);
  t('no second JOBS row', rows('JOBS').length === jobsAtStart + 1);
  t('and the plan row is back', planC(PLAN, 'confirmed_job_id') === VISIT);
  planRowsNow.pop(); planRowsNow.push(savedPlanRow);

  /* ---- changing it ---- */
  const change = (over, cid) => MPOST(Object.assign({ kind: 'plan_change', plan_id: PLAN,
    frequency: 'biweekly' }, over || {}), cid);

  t('another customer cannot change it', change({ slot_date: '2026-10-31', slot_time: '9:00 AM' },
    'CON-FIRST').error === 'not_found');

  /* THE PLAN ROW'S OWN OWNERSHIP CHECK, proven alone. Above, the caller does
     not own the move booking either, so the second check answers first and
     the first is never tested — r42's missed mutation, in a new place. This
     row points at the caller's OWN move booking but carries somebody else's
     lead_id: what a mis-keyed row looks like. */
  M.tabs.RECURRING_PLANS.appendRow(PLAN_H.map(k => ({ plan_id: 'PLN-MISKEYED',
    lead_id: 'someone@example.com', origin_job_id: MOVE, frequency: 'weekly', quoted_price: 180,
    status: 'confirmed' })[k] || ''));
  t('a plan row carrying another lead cannot be changed, even on their own move',
    change({ plan_id: 'PLN-MISKEYED', frequency: 'weekly', time_preference: 'earlier' }).error === 'not_found');
  t('and it was not touched', planC('PLN-MISKEYED', 'anchor_date') === '' &&
    rows('JOBS').length === jobsAtStart + 1);

  /* A FIRST-CLEAN PLAN HOLDS WHAT IT WAS QUOTED. Its row belongs to the right
     customer and is confirmed; the only thing wrong is where it came from. */
  M.tabs.RECURRING_PLANS.appendRow(PLAN_H.map(k => ({ plan_id: 'PLN-FIRSTQ', lead_id: 'first@example.com',
    origin_job_id: 'SRV-20260930-FIRST1', frequency: 'weekly', quoted_price: 111,
    status: 'confirmed' })[k] || ''));
  t('a first-clean plan cannot be re-priced from the move box',
    change({ plan_id: 'PLN-FIRSTQ', frequency: 'monthly', shown_price: 260 }, 'CON-FIRST').error === 'not_found');

  slot('2026-10-31', '9:00 AM', 'VEN-SLOT2');
  quoteCalls.length = 0;
  const C1 = change({ slot_date: '2026-10-31', slot_time: '9:00 AM' });
  t('a time-only change goes through', C1.ok === true, C1);
  t('it moves THE SAME visit', C1.job_id === VISIT && jobC(VISIT, 'scheduled_date') === '2026-10-31' &&
    jobC(VISIT, 'start_time') === '9:00 AM', [C1.job_id, jobC(VISIT, 'scheduled_date')]);
  t('without re-pricing — the engine was not asked', quoteCalls.length === 0);
  t('and the price holds', Number(jobC(VISIT, 'quoted_price')) === 210);
  t('the new slot is taken', slotC('2026-10-31', '9:00 AM', 'job_id') === VISIT);
  t('the old one goes back on sale', slotC('2026-10-24', '1:00 PM', 'status') === 'open');
  t('THE PLAN BOX MOVES THE ANCHOR', planC(PLAN, 'anchor_date') === '2026-10-31' &&
    planC(PLAN, 'anchor_time') === '9:00 AM');
  t('asking for the same time again changes nothing',
    change({ slot_date: '2026-10-31', slot_time: '9:00 AM' }).unchanged === true);

  t('a cadence change at a price not shown is refused',
    change({ frequency: 'monthly', shown_price: 250 }).error === 'price_changed');
  t('and left the visit alone', jobC(VISIT, 'frequency') === 'biweekly');

  setJobC(VISIT, 'payment_status', 'paid');
  t('a PAID visit is not re-priced by a cadence change',
    change({ frequency: 'monthly', shown_price: 260 }).error === 'paid');
  t('and nothing moved', jobC(VISIT, 'frequency') === 'biweekly' && planC(PLAN, 'frequency') === 'biweekly');
  setJobC(VISIT, 'payment_status', '');

  const C2 = change({ frequency: 'monthly', shown_price: 260 });
  t('a cadence change at the engine\'s price goes through', C2.ok === true, C2);
  t('the visit takes the new cadence and price in place',
    jobC(VISIT, 'frequency') === 'monthly' && Number(jobC(VISIT, 'quoted_price')) === 260 &&
    Number(jobC(VISIT, 'final_price')) === 260);
  t('and so does the plan', planC(PLAN, 'frequency') === 'monthly' && Number(planC(PLAN, 'quoted_price')) === 260);
  t('the time was not touched', jobC(VISIT, 'scheduled_date') === '2026-10-31');

  const C3 = change({ frequency: 'monthly', time_preference: 'later' });
  t('a change to "later in the day" goes through', C3.ok === true, C3);
  t('the visit becomes a preference', jobC(VISIT, 'scheduling_type') === 'preference' &&
    jobC(VISIT, 'scheduled_date') === '' && /Later in the day/.test(jobC(VISIT, 'start_time')),
    [jobC(VISIT, 'scheduling_type'), jobC(VISIT, 'scheduled_date'), jobC(VISIT, 'start_time')]);
  t('and its slot goes back on sale', slotC('2026-10-31', '9:00 AM', 'status') === 'open');
  t('the anchor clears — a preference has no clock time', planC(PLAN, 'anchor_date') === '');
  t('asking for "later" again changes nothing',
    change({ frequency: 'monthly', time_preference: 'later' }).unchanged === true);

  /* ---- the visit is called off: the box books the next one ---- */
  t('the visit can still be cancelled the r43 way',
    MPOST({ kind: 'cancel', job_id: VISIT }).ok === true);
  t('with nothing coming, a change needs a time',
    change({ frequency: 'monthly' }).error === 'bad_slot');
  slot('2026-11-07', '11:00 AM', 'VEN-SLOT3');
  const jobsBeforeNext = rows('JOBS').length;
  const C4 = change({ frequency: 'monthly', slot_date: '2026-11-07', slot_time: '11:00 AM' });
  const NEXT = String(C4.job_id || '');
  t('it books the plan\'s next visit', C4.ok === true && NEXT && NEXT !== VISIT, C4);
  t('as a new row', rows('JOBS').length === jobsBeforeNext + 1);
  t('with its own submission id', jobC(NEXT, 'submission_id') === 'PLNC-' + PLAN + '-02',
    jobC(NEXT, 'submission_id'));
  t('at the plan\'s held price', Number(jobC(NEXT, 'quoted_price')) === 260);
  t('the plan points at it now', planC(PLAN, 'confirmed_job_id') === NEXT);
  t('the cancelled visit stays cancelled', jobC(VISIT, 'job_status') === 'cancelled');
  t('the box shows the new visit', (MGET('CON-MOVE').movePlan || {}).visitId === NEXT);
  t('and a repeat is unchanged, not a third visit',
    change({ frequency: 'monthly', slot_date: '2026-11-07', slot_time: '11:00 AM' }).unchanged === true &&
    rows('JOBS').length === jobsBeforeNext + 1);

  /* ---- starting on "earlier in the day", with no previous company ---- */
  lead('pref@example.com', 'CON-PREF');
  job('SRV-20261015-PREF01', 'pref@example.com', { vendor_id: '', property_id: 'PROP-PREF' });
  const PV = MGET('CON-PREF').movePlan || {};
  t('with no previous company, none is offered', PV.samePartner === false);
  const availBefore = JSON.stringify(rows('AVAILABILITY'));
  const S3 = MPOST({ kind: 'plan_start', job_id: 'SRV-20261015-PREF01', frequency: 'weekly',
    shown_price: 180, time_preference: 'earlier', same_provider: true }, 'CON-PREF');
  t('a plan can start on "earlier in the day"', S3.ok === true, S3);
  t('as a preference visit', jobC(S3.job_id, 'scheduling_type') === 'preference' &&
    /Earlier in the day/.test(jobC(S3.job_id, 'start_time')));
  t('which takes no slot', JSON.stringify(rows('AVAILABILITY')) === availBefore);
  t('with no anchor yet', planC('PLN-20261015-PREF01', 'anchor_date') === '');
  t('and a same-company request with no company records nothing',
    planC('PLN-20261015-PREF01', 'preferred_vendor_id') === '');

  /* An UNTICKED same-company box records nothing, even where a company exists. */
  lead('noask@example.com', 'CON-NOASK');
  job('SRV-20261016-NOASK1', 'noask@example.com', { property_id: 'PROP-NOASK' });
  const S4 = MPOST({ kind: 'plan_start', job_id: 'SRV-20261016-NOASK1', frequency: 'weekly',
    shown_price: 180, time_preference: 'later', same_provider: false }, 'CON-NOASK');
  t('an unticked same-company box asks for no company, even when there is one',
    S4.ok === true && planC('PLN-20261016-NOASK1', 'preferred_vendor_id') === '', S4);

  t('r38 still never OFFERS a move a plan at booking',
    MB.createRecurringPlan(M.ss, { frequency_selected: 'weekly', service_type: 'move_out' },
      { job_id: 'SRV-X', lead_id: 'x' }, {}) === 'not a first clean');
}

console.log('\n' + (bad ? bad + ' FAILURES' : 'ALL ASSERTIONS PASSED'));
process.exit(bad ? 1 : 0);
