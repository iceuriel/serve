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
      /* Real Apps Script has both. handleJobNotes reads a single cell before
         overwriting it, and without this the blank-fill guard is untestable. */
      getValue: () => { const row = rows[r-1] || []; return row[c-1] === undefined ? '' : row[c-1]; },
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
    console: { log: m => logs.push(String(m)), warn: m => logs.push('WARN ' + m), error: m => logs.push('ERR ' + m) },
    SpreadsheetApp: { openById: () => ssObj, getActiveSpreadsheet: () => ssObj },
    ContentService: { MimeType: { JSON: 'json' },
      createTextOutput: s => ({ getContent: () => s, setMimeType() { return this; } }) },
    MailApp: { sendEmail: (to, subject, body) => mails.push({ to, subject, body }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Session: { getScriptTimeZone: () => 'America/New_York', getEffectiveUser: () => ({ getEmail: () => 'ops@example.com' }) },
    /* A real store, not a stub returning null: ticketSecret() mints a secret on
       first use and every later token depends on reading back the same one.
       A getProperty that always answered null would hand out a fresh secret per
       call, and every token would be single-use without anything failing. */
    PropertiesService: (() => {
      const store = {};
      return { getScriptProperties: () => ({
        getProperty: k => (k in store ? store[k] : null),
        setProperty: (k, v) => { store[k] = String(v); },
      }) };
    })(),
    Utilities: {
      formatDate,
      getUuid: () => require('crypto').randomUUID(),
      /* Apps Script returns a signed byte array. Node gives unsigned bytes, so
         convert — the webhook's hex conversion handles negatives, and feeding
         it unsigned values would test a different function than the one that
         ships. */
      computeHmacSha256Signature: (value, key) =>
        [...require('crypto').createHmac('sha256', String(key))
          .update(String(value)).digest()]
          .map(b => (b > 127 ? b - 256 : b)),
    },
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
/* PROPERTIES is deliberately writable now — it is the one narrow exception, and
   properties-and-slots.test.js owns its behaviour. Everything else on the deny
   list must still be header-only. */
['RAW INTAKE','OUTREACH LOG','DASHBOARD'].forEach(n =>
  t(n + ' untouched (header only)', S.tabs[n]._rows.length === 1));
t('PROPERTIES IS written (the deliberate exception)', S.tabs['PROPERTIES']._rows.length > 1,
  S.tabs['PROPERTIES']._rows.length - 1);
t('assertWritable still refuses PROPERTIES for any other caller', (() => {
  try { S.sandbox.assertWritable('PROPERTIES'); return false; } catch (e) { return /Refusing to write/.test(e.message); }
})());
t('the PROPERTIES allowance cannot be pointed at another tab', (() => {
  try { S.sandbox.assertPropertiesWritable('RAW_INTAKE'); return false; }
  catch (e) { return /exists\s+only for PROPERTIES/.test(e.message); }
})());

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

/* ============ SCENARIO 5: levels reach the notification ============
   The crew needs stairs before they arrive, not after. homeSummary() feeds
   both the subject line and the SERVICE block, so both are asserted — a
   regression in one is a regression in the other. */
console.log('\n\n=== SCENARIO 5 — levels in the reservation email ===');
const EM = build(LEADS_FULL);
const atFloors = n => Object.assign({}, slot, {
  submission_id: 'uuid-lv-' + n, levels: n, bedrooms: 2, bathrooms: 1.5,
});

EM.post(atFloors(3));
let lm = EM.mails[EM.mails.length - 1];
t('SERVICE block reports 3 floors', /Levels:\s+3 floors/.test(lm.body),
  (lm.body.match(/Levels:.*/) || [])[0]);
t('subject line reports 3 floors', /2 BR \/ 1\.5 BA \/ 3 floors/.test(lm.subject), lm.subject);

/* The single-storey case is the whole point of the field. Suppressing it once
   left a real booking looking as though levels had never been captured. */
EM.post(atFloors(1));
lm = EM.mails[EM.mails.length - 1];
t('ONE floor is stated, not suppressed', /Levels:\s+1 floor\b/.test(lm.body),
  (lm.body.match(/Levels:.*/) || [])[0]);
t('one floor is singular, not "1 floors"', !/1 floors/.test(lm.body));
t('one floor reaches the subject too', /2 BR \/ 1\.5 BA \/ 1 floor/.test(lm.subject), lm.subject);

/* A stale cached script.js sends no `levels` at all. That must say so out
   loud — never a blank, which reads identically to "one floor". */
const noLevels = Object.assign({}, slot, { submission_id: 'uuid-lv-absent' });
delete noLevels.levels;
EM.post(noLevels);
lm = EM.mails[EM.mails.length - 1];
t('absent levels says NOT REPORTED', /Levels:\s+NOT REPORTED/.test(lm.body),
  (lm.body.match(/Levels:.*/) || [])[0]);
t('absent levels never prints NaN', !/NaN|undefined/.test(lm.body));

/* Every booking email carries the line, whatever the payload. */
t('Levels line is never missing', EM.mails.every(m => /^Levels:/m.test(m.body)));

/* ============ SCENARIO 6: late notes from the confirmation screen ============
   r10. The reserve step's textarea moved to the confirmation screen, so notes
   now arrive AFTER the JOBS row exists and have to update it in place. That
   makes this the one write path that deliberately skips the replay guard: the
   submission_id is expected to already be in the sheet, because it is how the
   booking gets found. */
console.log('\n\n=== SCENARIO 6 — job_notes updates the booking it belongs to ===');
const N = build(LEADS_FULL);
const jn = N.tabs.JOBS;
const noteCol = JOBS_HEADERS.indexOf('customer_notes');
const petCol  = JOBS_HEADERS.indexOf('pets_flag');

const booking = Object.assign({}, BASE, { submission_id: 'uuid-notes-1',
  slot_date: '2026-09-10', slot_time: '9-11 AM' });
delete booking.customer_notes;
delete booking.pets_flag;
N.post(booking);

t('booking lands with notes blank', !jn._rows[1][noteCol], jn._rows[1][noteCol]);
const rowsAfterBooking = jn._rows.length;

const notes = m => N.post({ event: 'job_notes', event_type: 'job_notes',
  submission_id: 'uuid-notes-1', customer_notes: m });

const r1 = notes('We have a friendly dog — please keep the back door shut.');
t('job_notes reports ok', r1.status === 'ok', r1);
t('notes land on the booking row',
  /friendly dog/.test(jn._rows[1][noteCol]), jn._rows[1][noteCol]);
t('pets_flag derived server-side', jn._rows[1][petCol] === true, jn._rows[1][petCol]);
t('NO new row was appended', jn._rows.length === rowsAfterBooking, jn._rows.length);

/* Blank-fill only, like every other upsert here — a second send must not be
   able to erase what someone said the first time. */
notes('Actually ignore all that.');
t('a second send cannot overwrite the first',
  /friendly dog/.test(jn._rows[1][noteCol]), jn._rows[1][noteCol]);

/* The word list must not fire on "carpet" or "category". */
const N2 = build(LEADS_FULL);
N2.post(Object.assign({}, BASE, { submission_id: 'uuid-notes-2' }));
N2.post({ event_type: 'job_notes', submission_id: 'uuid-notes-2',
  customer_notes: 'New carpet in the den, and the category of clean is standard.' });
t('carpet/category do not read as pets',
  N2.tabs.JOBS._rows[1][petCol] === false, N2.tabs.JOBS._rows[1][petCol]);

/* Failure modes. None may throw, and none may write. */
const N3 = build(LEADS_FULL);
N3.post(Object.assign({}, BASE, { submission_id: 'uuid-notes-3' }));
const jobsBefore = JSON.stringify(N3.tabs.JOBS._rows);

const orphan = N3.post({ event_type: 'job_notes', submission_id: 'never-existed',
  customer_notes: 'notes for a job that is not there' });
t('unknown submission_id is refused', orphan.status === 'error', orphan);

const empty = N3.post({ event_type: 'job_notes', submission_id: 'uuid-notes-3',
  customer_notes: '   ' });
t('whitespace-only notes are skipped, not written', empty.status === 'ok' && !!empty.skipped, empty);

const noId = N3.post({ event_type: 'job_notes', customer_notes: 'no id at all' });
t('missing submission_id is refused', noId.status === 'error', noId);

t('none of the failure paths touched JOBS',
  JSON.stringify(N3.tabs.JOBS._rows) === jobsBefore);

/* ============ SCENARIO 7: job tickets ============
   r11. One JOBS row served to two audiences, and the split is decided on the
   server precisely so a view cannot render what it was never sent.

   The token carries the whole security model. job_id is NOT a secret — it is a
   known date plus six characters and it appears in every notification email —
   while the URL exposes a home address and when the house will be empty. */
console.log('\n\n=== SCENARIO 7 — job tickets ===');
const T = build(LEADS_FULL);
/* The shared JOBS_HEADERS above models the 32-column sheet on purpose, to
   exercise the narrow-tab degradation path. The live tab has these too, and the
   partner view is built from them, so they are added for this scenario only —
   widening the shared constant would shift the index-based assertions in
   SCENARIO 4. */
['address', 'unit', 'zip', 'levels', 'property_id'].forEach(h => {
  if (!T.tabs.JOBS._rows[0].includes(h)) T.tabs.JOBS._rows[0].push(h);
});
const tJob = Object.assign({}, BASE, { submission_id: 'uuid-ticket-1',
  slot_date: '2026-09-10', slot_time: '9-11 AM',
  customer_notes: 'Friendly dog, please skip the office.' });
T.post(tJob);

const tRow   = T.tabs.JOBS._rows[1];
const jobId  = tRow[JOBS_HEADERS.indexOf('job_id')];
const tokenOf = T.sandbox.ticketToken;
const clientTok  = tokenOf(jobId, 'client');
const partnerTok = tokenOf(jobId, 'partner');
const get    = (q) => JSON.parse(T.sandbox.doGet({ parameter: q }).getContent());

t('a ticket token is produced', typeof clientTok === 'string' && clientTok.length === 20, clientTok);
t('it is stable across calls', tokenOf(jobId, 'client') === clientTok);
t('a different job gets a different token', tokenOf('SRV-20260101-AAAAAA', 'client') !== clientTok);

/* TWO AUDIENCES, TWO SECRETS.
   Until r13 the token was an HMAC of the job_id alone, so ONE token opened
   both views and `&view=` merely chose which. A partner holding their own link
   could flip it to `view=client` and read the customer's name, the price they
   paid and their private notes; a customer could flip the other way into the
   crew's access notes. The price leak is the serious one — what Serve charges
   versus what a partner is paid is the whole model.

   These four assertions are the fix. The old test used one token for both
   views, which is exactly the shape of the bug. */
t('the two views get different tokens', clientTok !== partnerTok);
t('a CLIENT token does not open the partner view',
  get({ job: jobId, t: clientTok, view: 'partner' }).ok === false);
t('a PARTNER token does not open the client view',
  get({ job: jobId, t: partnerTok, view: 'client' }).ok === false);
t('and a refusal looks identical either way',
  get({ job: jobId, t: clientTok, view: 'partner' }).error ===
  get({ job: jobId, t: 'f'.repeat(20), view: 'partner' }).error);

/* Without this the id alone is the key, and ids are guessable by date. */
t('the id alone opens nothing', get({ job: jobId }).ok === false);
t('a wrong token opens nothing', get({ job: jobId, t: 'f'.repeat(20) }).ok === false);
t('a wrong token and a real one look the same to the caller',
  get({ job: jobId, t: 'f'.repeat(20) }).error ===
  get({ job: 'SRV-19990101-ZZZZZZ', t: clientTok }).error);

const client  = get({ job: jobId, t: clientTok,  view: 'client' });
const partner = get({ job: jobId, t: partnerTok, view: 'partner' });

t('the client view opens', client.ok === true, client.error);
t('the partner view opens', partner.ok === true, partner.error);

/* THE PRIVACY SPLIT. Asserted as absence over the WHOLE serialized object, not
   as a missing top-level key — the r13 view models are nested, and
   `!('address' in client)` would pass while `client.property.address` sat one
   level down. */
const clientJson  = JSON.stringify(client);
const partnerJson = JSON.stringify(partner);

t('client is told the price', Number(client.booking.price) > 0, client.booking.price);
t('client is told whether it is paid', typeof client.booking.paid === 'boolean');
t('client is NOT given the street address anywhere in the payload',
  !clientJson.includes(tJob.address), clientJson.slice(0, 200));
t('client is NOT given the crew access notes',
  !/access_notes|priority_rooms|skip_areas|product_notes/.test(clientJson));

t('partner is given the address', partner.property.address === tJob.address, partner.property.address);
t('partner is NOT given the customer email anywhere',
  !partnerJson.includes(tJob.email), partnerJson.slice(0, 200));
t('partner is NOT given the customer phone anywhere',
  !partnerJson.includes(String(tJob.phone)));

/* r22 — THE FIRST NAME, AND EXACTLY THAT MUCH.
   Somebody knocking on a stranger's door should know who they are expecting.
   The rule this relaxes exists to stop a partner arranging work around Serve,
   and a first name is not a contact route — it cannot be dialled, emailed or
   looked up. The surname is what turns a greeting into an identity, so the
   assertion below is the one that matters: the full name must NOT survive. */
t('partner IS given the customer first name', partner.customerFirstName === 'Test',
  partner.customerFirstName);
t('but NOT the full name — a first name is a greeting, a surname is an identity',
  !partnerJson.includes('Test Customer'), partnerJson.slice(0, 200));
t('and the client view does not gain a partner-shaped name field',
  !('customerFirstName' in client) || client.customerFirstName === undefined,
  client.customerFirstName);
/* THE TWO SIDES OF THE MONEY ARE NOT THE SAME NUMBER.
   The partner sees `payout` — what they are paid. They must never see
   `price` — what the customer paid. Serve's margin is the difference and it
   is visible to neither. */
t('partner is NOT given the customer price',
  !/"price"|quoted|final_price|add_on_rev/.test(partnerJson), partnerJson.slice(0, 200));
t('partner IS given a payout field', 'payout' in partner.booking, Object.keys(partner.booking));
t('the payout is blank until an operator sets it — never a guessed number',
  !partner.booking.payout, partner.booking.payout);
t('and the client is never shown the payout', !/payout/i.test(clientJson));

/* r23 — A SHEET CELL DOES NOT ALWAYS HOLD WHAT SOMEBODY TYPED.
   An operator reformatting `start_time` turns it into a real time value, and
   getValues() then returns a Date rather than a string. String()ing one put

       Fri Dec 29 1899 22:00:00 GMT-0500 (Eastern Standard Time)

   at the top of live booking slips. 1899 is Sheets' own epoch for a cell that
   has a time and no date. Driven here with the exact Date the sheet produces,
   not with a hand-written string, because the string is the symptom. */
{
  const timeCell = S.sandbox.timeCellText, dateCell = S.sandbox.dateCellText;
  t('the cell normalisers are reachable',
    typeof timeCell === 'function' && typeof dateCell === 'function');

  /* Exactly what Sheets hands back for a time-only cell reading 9:00. */
  const sheetTime = new Date(1899, 11, 30, 9, 0, 0);
  t('a time-only cell becomes a readable time, not 1899',
    timeCell(sheetTime) === '9:00 AM ET', timeCell(sheetTime));
  t('and never leaks the epoch date',
    !/1899|GMT|Dec/.test(timeCell(sheetTime)), timeCell(sheetTime));

  const pm = new Date(1899, 11, 30, 14, 30, 0);
  t('afternoon reads as PM', timeCell(pm) === '2:30 PM ET', timeCell(pm));
  const midnight = new Date(1899, 11, 30, 0, 5, 0);
  t('midnight is 12, not 0', timeCell(midnight) === '12:05 AM ET', timeCell(midnight));

  /* Most cells are still text and always will be. */
  t('existing text is kept, with ET added', timeCell('9–11 AM') === '9–11 AM ET');
  t('and ET is not doubled', timeCell('9–11 AM ET') === '9–11 AM ET');
  t('prose is left completely alone', timeCell('Morning preferred') === 'Morning preferred');
  t('blank stays blank', timeCell('') === '');

  /* scheduled_date has to stay ISO — prettyDate() splits it on "-", so a
     reformatted date cell would silently stop rendering a day. */
  t('a date cell stays YYYY-MM-DD',
    dateCell(new Date(2026, 8, 20)) === '2026-09-20', dateCell(new Date(2026, 8, 20)));
  t('and date text passes through', dateCell('2026-09-20') === '2026-09-20');

  /* The whole point: the partner ticket header is clean. */
  t('no booking slip carries the 1899 epoch',
    !/1899|GMT[-+]/.test(partnerJson + clientJson),
    (('' + partnerJson + clientJson).match(/.{0,40}1899.{0,40}/) || [])[0]);
}

/* r22 — THE AMOUNT AND THE MONEY ARE TWO DIFFERENT MOMENTS.
   Both partner surfaces used to say only "at dispatch", and the vendor
   portal's "Payout at dispatch" read as though that were payday. The amount IS
   agreed at dispatch — nobody can be asked to accept a job without knowing what
   it pays — but payment follows completion and the photo check. */
{
  const tk = fs.readFileSync(require('path').join(REPO_ROOT, 'ticket.js'), 'utf8');
  const vd = fs.readFileSync(require('path').join(REPO_ROOT, 'vendor.js'), 'utf8');
  /* Comments out so a copy assertion tests what a PARTNER reads, and adjacent
     string literals joined so that where a sentence happens to wrap in the
     source does not decide whether the test passes. */
  const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/'\s*\+\s*'/g, '');

  t('the ticket tells a partner when they are actually paid',
    /completed and the photo check passes/.test(strip(tk)));
  t('the vendor portal says it too, per job',
    /completed and the photo check passes/.test(strip(vd)));
  t('the misleading "Payout at dispatch" is gone',
    !/Payout at dispatch/.test(strip(vd)),
    (strip(vd).match(/.{0,30}Payout at dispatch.{0,20}/) || [])[0]);

  /* THE PROMISE IS COPY, NOT A TRIGGER — the founder verifies completion and
     photos by hand and pays by hand. If payout ever becomes mechanical it is a
     new decision, and this column stops being ops-owned on the same day. So
     assert the ownership rather than trusting the comment above it. */
  const opsOwned = (SRC.match(/const OPS_OWNED_COLUMNS = \[([\s\S]*?)\];/) || [, ''])[1];
  t('partner_payout is still OPS-owned, so no code can set it',
    /"partner_payout"/.test(opsOwned), opsOwned.replace(/\s+/g, ' ').slice(0, 120));
  t('and nothing releases a payout from completion or the photo gate',
    !/payout[^;\n]*\b(completedDate|photosPassed|completed_date|photos_passed)\b/i
      .test(strip(SRC)));
}

/* Door codes live in a separate workbook and must never reach either view. */
t('no view carries anything named like a code',
  !/access_secret|door_code|lockbox/i.test(clientJson + partnerJson));

/* The rooms a booking implies, which is what instructions attach to. */
t('the client ticket lists rooms derived from the booking',
  Array.isArray(client.home.rooms) && client.home.rooms.length > 0,
  (client.home.rooms || []).map(r => r.key));
t('and the partner sees the same room keys',
  JSON.stringify(partner.scope.map(r => r.key)) ===
  JSON.stringify(client.home.rooms.map(r => r.key)));

/* The partner link is for doing the job; the client link is their record. */
const done = T.tabs.JOBS._rows[1];
done[JOBS_HEADERS.indexOf('completed_date')] = '2026-09-11';
t('partner link closes once the job is complete',
  get({ job: jobId, t: partnerTok, view: 'partner' }).error === 'expired');
t('client link still opens after completion',
  get({ job: jobId, t: clientTok, view: 'client' }).ok === true);

/* ============================================================
   BOOKING_INSTRUCTIONS — the customer editing their own ticket
   ============================================================ */
console.log('\n=== instructions: the write path ===');
{
  /* A fresh job, because the one above was marked complete and a finished
     ticket is a record rather than a form. */
  const iJob = Object.assign({}, BASE, { submission_id: 'uuid-ins-1',
    slot_date: '2026-09-12', slot_time: '9-11 AM' });
  T.post(iJob);
  const iRow = T.tabs.JOBS._rows[T.tabs.JOBS._rows.length - 1];
  const iId  = iRow[JOBS_HEADERS.indexOf('job_id')];
  const iTok = tokenOf(iId, 'client');
  const pTok = tokenOf(iId, 'partner');

  const write = (o) => JSON.parse(T.sandbox.doPost({ postData: { contents: JSON.stringify(
    Object.assign({ event_type: 'booking_instruction', job_id: iId, t: iTok }, o)) } }).getContent());

  /* THE TAB IS AUTO-CREATED, like EVENTS. No setup step for the founder. */
  t('the first write creates BOOKING_INSTRUCTIONS',
    write({ scope_type: 'ROOM', scope_key: 'BEDROOM_1',
            instruction: 'Fresh sheets are in the closet.' }).ok === true);
  t('and the tab now exists', !!T.tabs.BOOKING_INSTRUCTIONS);

  /* AUTHORISATION. A partner may read a job; they may not rewrite what the
     customer asked for. */
  t('a partner token cannot write an instruction',
    JSON.parse(T.sandbox.doPost({ postData: { contents: JSON.stringify({
      event_type: 'booking_instruction', job_id: iId, t: pTok,
      scope_type: 'BOOKING', scope_key: 'GENERAL', instruction: 'x' }) } }).getContent()).ok === false);
  t('nor can a wrong token',
    JSON.parse(T.sandbox.doPost({ postData: { contents: JSON.stringify({
      event_type: 'booking_instruction', job_id: iId, t: 'f'.repeat(20),
      scope_type: 'BOOKING', scope_key: 'GENERAL', instruction: 'x' }) } }).getContent()).ok === false);

  /* SCOPE VALIDATION. Without it the tab becomes a free-text store keyed on
     whatever a caller sends, and the note silently never appears on a ticket
     because it was filed under a room that does not exist. */
  t('a room this booking does not have is refused',
    write({ scope_type: 'ROOM', scope_key: 'BEDROOM_9', instruction: 'x' }).error === 'unknown_room');
  t('an invented access field is refused',
    write({ scope_type: 'ACCESS', scope_key: 'DOOR_CODE', instruction: '1234' })
      .error === 'unknown_access_field');

  /* ONE ROW PER SCOPE. A second write to the same room updates rather than
     appending, so the ticket shows one current instruction per room instead of
     an ever-growing list of edits. */
  const rowsBefore = T.tabs.BOOKING_INSTRUCTIONS._rows.length;
  t('re-writing the same room updates in place',
    write({ scope_type: 'ROOM', scope_key: 'BEDROOM_1',
            instruction: 'Sheets are in the hall cupboard now.' }).updated === true);
  t('and adds no row', T.tabs.BOOKING_INSTRUCTIONS._rows.length === rowsBefore);

  t('a general note is accepted',
    write({ scope_type: 'BOOKING', scope_key: 'GENERAL',
            instruction: 'Dog is friendly.' }).ok === true);
  t('so is an access answer',
    write({ scope_type: 'ACCESS', scope_key: 'PARKING',
            instruction: 'Resident permit, use the driveway.' }).ok === true);

  /* AND IT REACHES BOTH TICKETS, from the same root data. */
  const c = get({ job: iId, t: iTok, view: 'client' });
  const p = get({ job: iId, t: pTok, view: 'partner' });

  const bed1 = (c.home.rooms || []).filter(r => r.key === 'BEDROOM_1')[0] || {};
  t('the client ticket shows the updated room instruction',
    bed1.instruction === 'Sheets are in the hall cupboard now.', bed1.instruction);
  t('the client ticket shows the general note',
    c.instructions.general === 'Dog is friendly.', c.instructions.general);
  const park = (c.access.fields || []).filter(f => f.key === 'PARKING')[0] || {};
  t('the client reads back their own access answer',
    park.value === 'Resident permit, use the driveway.', park.value);

  const pBed1 = (p.scope || []).filter(r => r.key === 'BEDROOM_1')[0] || {};
  t('the PARTNER sees the same room instruction',
    pBed1.instruction === 'Sheets are in the hall cupboard now.', pBed1.instruction);
  t('the partner sees the general note',
    p.instructions.general === 'Dog is friendly.');
  t('and the customer access answer, marked as this visit',
    (p.access.fromCustomer || []).some(f => f.key === 'PARKING'),
    p.access.fromCustomer);

  /* A finished job is a record, not a worksheet. */
  T.tabs.JOBS._rows[T.tabs.JOBS._rows.length - 1][JOBS_HEADERS.indexOf('completed_date')] = '2026-09-13';
  t('a completed job refuses further edits',
    write({ scope_type: 'BOOKING', scope_key: 'GENERAL', instruction: 'late' }).error === 'closed');
}

/* ============================================================
   THE TWO LINKS IN THE BOOKING EMAIL
   ============================================================
   The notification is where both tickets are actually handed out, so it is
   where the view-scoped token has to hold. Before r13 one link opened both
   views: forwarding the cleaner's link to a customer, or the reverse, showed
   the other view rather than nothing. */
console.log('\n=== the booking email carries two different links ===');
{
  /* Its OWN booking, deliberately. The jobs above were marked complete to test
     link expiry, and a completed partner link is correctly refused — reusing
     one here would report that correct behaviour as a failure. */
  T.post(Object.assign({}, BASE, { submission_id: 'uuid-mail-1',
    slot_date: '2026-09-14', slot_time: '9-11 AM' }));
  const mail = T.mails.filter(m => /TICKETS/.test(m.body)).pop();
  t('a booking notification carries a TICKETS block', !!mail);

  const links = (mail.body.match(/https:\/\/servecleaning\.com\/j\?[^\s]+/g) || []);
  t('it carries exactly two links', links.length === 2, links.length);

  const client  = links.filter(l => /view=client/.test(l))[0]  || '';
  const partner = links.filter(l => /view=partner/.test(l))[0] || '';
  t('one for each audience', !!client && !!partner, links);

  const tokOf = (u) => (u.match(/[?&]t=([^&]+)/) || [])[1] || '';
  t('THE TWO TOKENS DIFFER — a forwarded link is not the other view',
    tokOf(client) !== tokOf(partner), [tokOf(client), tokOf(partner)]);

  /* And each really only opens its own view, driven through doGet rather than
     inferred from the strings. */
  const idOf = (u) => decodeURIComponent((u.match(/[?&]id=([^&]+)/) || [])[1] || '');
  const mailedId = idOf(client);
  t('the link ids match the job it is about', mailedId === idOf(partner) && !!mailedId, mailedId);
  t('the emailed client link opens the client view',
    get({ job: mailedId, t: tokOf(client), view: 'client' }).ok === true);
  t('the emailed partner link opens the partner view',
    get({ job: mailedId, t: tokOf(partner), view: 'partner' }).ok === true);
  t('the emailed client link does NOT open the partner view',
    get({ job: mailedId, t: tokOf(client), view: 'partner' }).ok === false);
  t('the emailed partner link does NOT open the client view',
    get({ job: mailedId, t: tokOf(partner), view: 'client' }).ok === false);

  /* A token in an email is a token in an inbox. It must not also be in a log. */
  t('no ticket token is written to a log line',
    !T.logs.some(l => tokOf(client) && String(l).includes(tokOf(client))));
}

/* The health check must survive gaining a second job.
   The revision is read from the file's own VERSION STAMP rather than pinned to
   a literal. Pinning made every routine bump fail this file for no reason, and
   a test that cries wolf on a version number is a test people learn to edit
   without reading. What actually matters is that the two agree — the stamp is
   how a deploy is identified, and a doGet reporting a different one means the
   deployed copy is not the file. */
const stampRev = (require('fs')
  .readFileSync(require('path').join(REPO_ROOT, 'apps-script', 'webhook.gs'), 'utf8')
  .match(/VERSION STAMP:.*?\br(\d+)\b/) || [])[1];
const health = JSON.parse(T.sandbox.doGet({}).getContent());
t('doGet with no params is still the health check',
  health.ok === true && !!stampRev && new RegExp('\\br' + stampRev + '\\b').test(health.version),
  health.version + ' vs stamp r' + stampRev);

console.log('\n' + (bad ? 'FAILURES: ' + bad : 'ALL ASSERTIONS PASSED'));
process.exit(bad ? 1 : 0);
