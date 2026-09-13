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

/* A WHITELIST like every other view model here. */
t('the plan exposes exactly the named fields',
  JSON.stringify(Object.keys(P21.plan).sort()) ===
    JSON.stringify(['afterJobId','expiresAt','frequency','planId','price']),
  Object.keys(P21.plan));

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
onlyPlan();
pushPlan({ plan_id: 'PLN-THEIRS', contact_id: 'CON-0002' });
t('another contact plan is not visible here', planNow() === null);

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

console.log('\n' + (bad ? bad + ' FAILURES' : 'ALL ASSERTIONS PASSED'));
process.exit(bad ? 1 : 0);
