/* r44 — one read per tab, per request.
   ==================================================================
   The portal was slow because the server asked Google Sheets the same
   questions over and over: a five-booking customer cost 211 SpreadsheetApp
   calls to open, JOBS alone was read seventeen times, and the photo tab was
   read whole once per booking. Every one of those is a round trip to Google,
   and the page could show nothing until the last came back.

   r44 reads each tab at most once per GET and shares it for the rest of that
   request. This file exists to keep that true, and to keep the one rule that
   makes it safe:

     1. A GET READS EACH TAB AT MOST ONCE, and the number of reads does not
        grow with how many bookings the customer has. Asserted per route.

     2. A GET WRITES NOTHING. The shared snapshot is only safe because of it.
        A GET that starts writing must fail here before a stale read ships.

     3. A POST NEVER SHARES A SNAPSHOT. A POST reads, writes and may read the
        same tab again, and must see its own write. No POST today happens to
        read back through readTable after writing — which is exactly why this
        is asserted directly: letting doPost share snapshots currently changes
        no output anywhere, so nothing else would notice until the first one
        that does.

     4. THE SCOPE CLOSES. Between requests, and when a request throws. A leaked
        scope answers the next request with the previous request's sheet.

   Driven through a counting harness: every sheet method is wrapped, so what is
   asserted is the number of calls the shipped code actually makes. */

const REPO_ROOT = require('path').resolve(__dirname, '..');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const SRC = fs.readFileSync(path.join(REPO_ROOT, 'apps-script', 'webhook.gs'), 'utf8');
const OPS_ID = (SRC.match(/OPS_SPREADSHEET_ID\s*=\s*"([^"]+)"/) || [])[1];

let bad = 0;
const t = (label, cond, extra) => {
  console.log((cond ? '  ok    ' : '  FAIL  ') + label +
              (extra !== undefined ? '  ->  ' + JSON.stringify(extra) : ''));
  if (!cond) bad++;
};
const head = (m) => console.log('\n=== ' + m + ' ===');

/* ---- the counting harness ------------------------------------------ */
const JOBS_H = ['job_id','lead_id','source','property_key','service_type','frequency',
  'condition','beds','baths','quoted_price','add_ons','add_on_rev','final_price','scheduled_date',
  'completed_date','cleaner','start_time','duration_min','photos_passed','payment_status',
  'job_status','notes','submission_id','received_at','name','email','phone','segment','src_chain',
  'customer_notes','pets_flag','scheduling_type','address','unit','zip','quote_meta',
  'property_id','contact_id','partner_payout','vendor_id','operator_id'];
const LEADS_H = ['lead_id','name','email','phone','service_address','unit','zip','source',
  'source_detail','contacted_via','source_history','status','first_variant','dnc_scrub',
  'first_touch','last_touch','ltv','notes','segment','contact_id'];

function build() {
  const calls = [];          // { kind: 'read'|'write'|'meta', tab, op }
  const note = (kind, tab, op) => calls.push({ kind, tab, op });

  function makeSheet(name, headers) {
    const rows = headers ? [headers.slice()] : [];
    return {
      _name: name, _rows: rows,
      getName: () => { note('meta', name, 'getName'); return name; },
      getLastColumn: () => { note('meta', name, 'getLastColumn'); return rows[0] ? rows[0].length : 0; },
      getLastRow: () => { note('meta', name, 'getLastRow'); return rows.length; },
      appendRow: r => { note('write', name, 'appendRow'); rows.push(r.slice()); },
      setFrozenRows: () => note('write', name, 'setFrozenRows'),
      deleteRow: r => { note('write', name, 'deleteRow'); rows.splice(r - 1, 1); },
      getDataRange: () => ({
        getValues: () => { note('read', name, 'getDataRange'); return rows.map(r => r.slice()); },
      }),
      getRange: (r, c, nr, nc) => ({
        getValues: () => {
          note('read', name, 'getRange');
          const o = [];
          for (let i = 0; i < (nr || 1); i++) o.push((rows[r - 1 + i] || []).slice(c - 1, c - 1 + (nc || 1)));
          return o;
        },
        getValue: () => { note('read', name, 'getValue'); return (rows[r - 1] || [])[c - 1]; },
        getDisplayValues: () => { note('read', name, 'getDisplayValues'); return [[String((rows[r - 1] || [])[c - 1])]]; },
        getNumberFormats: () => { note('read', name, 'getNumberFormats'); return [['']]; },
        setValue: v => {
          note('write', name, 'setValue');
          while (rows.length < r) rows.push([]);
          while (rows[r - 1].length < c) rows[r - 1].push('');
          rows[r - 1][c - 1] = v;
        },
        setNumberFormat: () => note('write', name, 'setNumberFormat'),
      }),
    };
  }

  const tabs = {
    JOBS: makeSheet('JOBS', JOBS_H),
    LEADS: makeSheet('LEADS', LEADS_H),
    VENDORS: makeSheet('VENDORS', ['vendor_id','status','display_name','logo_url',
      'public_description','partner_since','insurance_verified','service_area',
      'public_rating','public_review_count','rating_source','client_visible']),
    VENDOR_SERVICES: makeSheet('VENDOR_SERVICES', ['vendor_id','service_code','offers','preference','active']),
    OPERATORS: makeSheet('OPERATORS', ['operator_id','vendor_id','public_display_name','role','active']),
    VENDOR_REVIEWS: makeSheet('VENDOR_REVIEWS', ['vendor_id','quote','author','rating','source','source_url','reviewed_on','client_visible']),
    VENDOR_PHOTOS: makeSheet('VENDOR_PHOTOS', ['vendor_id','image_url','caption','sort','client_visible']),
    RECURRING_PLANS: makeSheet('RECURRING_PLANS', ['plan_id','contact_id','lead_id','origin_job_id',
      'property_id','frequency','quoted_price','created_at','expires_at','status','anchor_date',
      'anchor_time','preferred_vendor_id','confirmed_job_id']),
    BOOKING_INSTRUCTIONS: makeSheet('BOOKING_INSTRUCTIONS', ['instruction_id','job_id','scope_type',
      'scope_key','instruction','created_at','updated_at']),
    PROPERTY_ACCESS: makeSheet('PROPERTY_ACCESS', ['property_id','occupancy_choice','occupancy_detail',
      'entry_choice','entry_detail','entry_code_saved','entry_code_set_at','parking_choice',
      'parking_detail','pet_notes','updated_at']),
    PROPERTY_MEMORY: makeSheet('PROPERTY_MEMORY', ['property_id','access_method','access_notes','parking_notes','pets']),
    BOOKING_PHOTOS: makeSheet('BOOKING_PHOTOS', ['photo_id','job_id','room_key','object_key','status',
      'bytes','created_at','updated_at','booking_link']),
  };

  let tz = 'America/New_York';
  const scopeSeen = [];
  const opens = [];
  const props = { TICKET_SECRET: 'read-budget-secret' };
  const propReads = [];
  /* ONE workbook object for Leads and Ops, as the other portal harnesses do —
     the tab names do not overlap. */
  const ss = {
    getSheetByName: n => {
      note('meta', n, 'getSheetByName');
      /* What the request scope said at the moment a tab was asked for — how
         section 4 proves doGet and doPost are wired, not merely the helper. */
      scopeSeen.push(box.REQUEST_SCOPE ? (box.REQUEST_SCOPE.snapshots ? 'shared' : 'fresh') : 'none');
      return tabs[n] || null;
    },
    insertSheet: n => { note('write', n, 'insertSheet'); return (tabs[n] = makeSheet(n, null)); },
    getSpreadsheetTimeZone: () => { note('meta', '(book)', 'getSpreadsheetTimeZone'); return tz; },
    getName: () => 'Leads MASTER',
    getId: () => 'leads-book',
  };

  const box = {
    console: { log: () => {}, warn: () => {}, error: () => {}, info: () => {} },
    JSON, Date, Math, String, Number, Boolean, Array, Object, RegExp, isNaN, parseInt, parseFloat,
    SpreadsheetApp: {
      openById: id => { opens.push(id); return ss; },
      getActiveSpreadsheet: () => ss,
      flush: () => {},
    },
    Session: { getScriptTimeZone: () => 'America/New_York' },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: k => { propReads.push(k); return k in props ? props[k] : null; },
        setProperty: (k, v) => { props[k] = v; },
        getKeys: () => Object.keys(props),
      }),
    },
    Utilities: {
      computeHmacSha256Signature: (msg, key) => [...crypto.createHmac('sha256', String(key)).update(String(msg)).digest()]
        .map(b => (b > 127 ? b - 256 : b)),
      getUuid: () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      formatDate: (d, zone, fmt) => {
        if (fmt !== 'yyyy-MM-dd' && fmt !== 'h:mm a') return String(d);
        const p = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit',
          day: '2-digit', hour: 'numeric', minute: '2-digit', hour12: true })
          .formatToParts(d).reduce((o, x) => (o[x.type] = x.value, o), {});
        return fmt === 'yyyy-MM-dd' ? p.year + '-' + p.month + '-' + p.day
                                    : p.hour + ':' + p.minute + ' ' + String(p.dayPeriod).toUpperCase();
      },
      base64Encode: s => Buffer.from(String(s), 'utf8').toString('base64'),
    },
    UrlFetchApp: { fetch: () => ({ getResponseCode: () => 200, getContentText: () => '{}' }) },
    MailApp: { sendEmail: () => {} },
    ContentService: {
      createTextOutput: s => ({ _s: s, setMimeType() { return this; }, getContent() { return this._s; } }),
      MimeType: { JSON: 'application/json' },
    },
    LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
  };
  box.globalThis = box;
  vm.createContext(box);
  vm.runInContext(SRC, box);

  const H = {
    box, tabs, ss, calls, opens, propReads, scopeSeen, makeSheet,
    setTz: z => { tz = z; },
    evalIn: code => vm.runInContext(code, box),
    get: q => JSON.parse(box.doGet({ parameter: q }).getContent()),
    post: o => JSON.parse(box.doPost({ postData: { contents: JSON.stringify(o) } }).getContent()),
    lead(leadId, name, contactId) {
      const row = new Array(LEADS_H.length).fill('');
      row[LEADS_H.indexOf('lead_id')] = leadId;
      row[LEADS_H.indexOf('name')] = name;
      row[LEADS_H.indexOf('contact_id')] = contactId;
      tabs.LEADS._rows.push(row);
    },
    job(jobId, leadId, propertyId, over) {
      const row = new Array(JOBS_H.length).fill('');
      const set = (k, v) => { row[JOBS_H.indexOf(k)] = v; };
      set('job_id', jobId); set('lead_id', leadId); set('property_id', propertyId);
      set('service_type', 'First Clean'); set('frequency', 'biweekly');
      set('beds', 2); set('baths', 1); set('quoted_price', 214);
      set('scheduled_date', '2026-10-01'); set('start_time', '9:00 AM');
      set('address', '1 Budget St'); set('unit', ''); set('zip', '02116');
      set('name', 'Pat Example'); set('email', leadId); set('phone', '617-555-0100');
      Object.keys(over || {}).forEach(k => set(k, over[k]));
      tabs.JOBS._rows.push(row);
    },
    /* Run one request and report what it cost. */
    measure(fn) {
      calls.length = 0; opens.length = 0; propReads.length = 0;
      const out = fn();
      const readsByTab = {};
      calls.filter(c => c.kind === 'read').forEach(c => { readsByTab[c.tab] = (readsByTab[c.tab] || 0) + 1; });
      return {
        out,
        total: calls.length + opens.length,
        reads: calls.filter(c => c.kind === 'read').length,
        writes: calls.filter(c => c.kind === 'write').map(c => c.tab + '.' + c.op),
        readsByTab,
        opsOpens: opens.filter(id => id === OPS_ID).length,
        zoneAsks: calls.filter(c => c.op === 'getSpreadsheetTimeZone').length,
        secretReads: propReads.filter(k => k === 'TICKET_SECRET').length,
      };
    },
  };
  return H;
}

/* An account with `n` bookings: each on the same partner, alternating two
   homes, the last one finished — the shape that made r43 expensive. */
function account(H, n) {
  H.lead('me@example.com', 'Pat Example', 'CON-0001');
  H.lead('them@example.com', 'Sam Other', 'CON-0002');
  for (let i = 0; i < 12; i++) H.job('SRV-2026080' + (i % 9) + '-OTHER' + i, 'them@example.com', 'PROP-0009', { vendor_id: 'VEN-0002' });
  for (let i = 0; i < n; i++) {
    const id = 'SRV-202610' + String(10 + i) + '-MINE' + String(i).padStart(2, '0');
    H.job(id, 'me@example.com', i % 2 ? 'PROP-0002' : 'PROP-0001',
          Object.assign({ vendor_id: 'VEN-0001', scheduled_date: '2026-10-' + String(10 + i) },
                        i === n - 1 && n > 1 ? { completed_date: '2026-10-' + String(10 + i) } : {}));
    H.tabs.BOOKING_PHOTOS._rows.push(['PH-' + i, id, 'KITCHEN', 'k/' + i, 'READY', 10, '', '', '']);
    H.tabs.BOOKING_INSTRUCTIONS._rows.push(['I-' + i, id, 'BOOKING', 'GENERAL', 'note ' + i, '', '']);
  }
  H.tabs.PROPERTY_ACCESS._rows.push(['PROP-0001', 'HOME', '', 'KEY', 'Under the mat', '', '', 'FREE_STREET', '', '', '']);
  H.tabs.PROPERTY_MEMORY._rows.push(['PROP-0001', 'lockbox', 'back door', 'street', 'dog']);
  H.tabs.VENDORS._rows.push(['VEN-0001', 'active', 'Beacon Home Care', '', 'desc', '2024', 'TRUE', 'Boston', 4.9, 30, 'Google', 'TRUE']);
  H.tabs.VENDOR_SERVICES._rows.push(['VEN-0001', 'CLEAN_DEEP', 'TRUE', 'preferred', 'TRUE']);
  H.tabs.OPERATORS._rows.push(['OP-1', 'VEN-0001', 'Sam R.', 'lead', 'TRUE']);
  H.tabs.VENDOR_REVIEWS._rows.push(['VEN-0001', 'Great', 'A.', 5, 'Google', '', '2026-07-01', 'TRUE']);
  H.tabs.VENDOR_PHOTOS._rows.push(['VEN-0001', 'images/x.jpg', 'Kitchen', 1, 'TRUE']);
  /* Tokens are minted HERE, before anything is measured: minting one reads the
     secret, and that read belongs to the test, not to the request. */
  const firstId = 'SRV-20261010-MINE00';
  const tok = {
    portal: H.box.portalToken('CON-0001'),
    vendor: H.box.vendorToken('VEN-0001'),
    client: H.box.ticketToken(firstId, 'client'),
    partner: H.box.ticketToken(firstId, 'partner'),
  };
  return {
    portal: () => H.get({ portal: 'CON-0001', t: tok.portal }),
    client: id => H.get({ job: id, t: tok.client, view: 'client' }),
    partner: id => H.get({ job: id, t: tok.partner, view: 'partner' }),
    vendor: () => H.get({ vendor: 'VEN-0001', t: tok.vendor }),
    firstId,
  };
}

/* ------------------------------------------------------------------ */
head('1. A GET reads each tab at most once');
{
  const H = build();
  const A = account(H, 6);
  const routes = [
    ['the portal', () => A.portal(), 'portal'],
    ['a client ticket', () => A.client(A.firstId), 'client'],
    ['a partner ticket', () => A.partner(A.firstId), 'partner'],
    ['the vendor portal', () => A.vendor(), 'vendor'],
  ];
  routes.forEach(([label, fn, view]) => {
    const m = H.measure(fn);
    t(label + ' opens', m.out.ok === true && m.out.view === view, m.out.error);
    const twice = Object.keys(m.readsByTab).filter(k => m.readsByTab[k] > 1);
    t(label + ': no tab is read twice', twice.length === 0, m.readsByTab);
    t(label + ': the Ops workbook is opened at most once', m.opsOpens <= 1, m.opsOpens);
    t(label + ': the timezone is asked at most once', m.zoneAsks <= 1, m.zoneAsks);
    t(label + ': the ticket secret is read at most once', m.secretReads <= 1, m.secretReads);
  });

  /* The ceiling that matters to a customer. On this account and in this
     harness r43 measured 133 for the portal and 65 for the vendor portal; r44
     measures 16 and 10. The margin is room for one more tab, not for a return
     to per-booking reads — section 2 is what catches those. */
  const P = H.measure(() => A.portal());
  t('the portal stays at or under 30 Sheets calls', P.total <= 30, P.total);
  const V = H.measure(() => A.vendor());
  t('the vendor portal stays at or under 20 Sheets calls', V.total <= 20, V.total);
}

/* ------------------------------------------------------------------ */
head('2. The cost does not grow with the number of bookings');
{
  const cost = (n, route) => {
    const H = build();
    const A = account(H, n);
    const m = H.measure(() => A[route](A.firstId));
    return { reads: m.reads, total: m.total, ok: m.out.ok, count: (m.out.bookings || []).length };
  };
  const p1 = cost(1, 'portal'), p8 = cost(8, 'portal');
  t('a 1-booking portal opens', p1.ok === true && p1.count === 1, p1);
  t('an 8-booking portal opens with all 8', p8.ok === true && p8.count === 8, p8);
  t('and reads the sheet exactly as many times as the 1-booking one',
    p8.reads === p1.reads, { one: p1.reads, eight: p8.reads });
  const v1 = cost(1, 'vendor'), v8 = cost(8, 'vendor');
  t('the vendor portal reads no more for 8 jobs than for 1',
    v8.ok === true && v8.reads === v1.reads, { one: v1.reads, eight: v8.reads });
}

/* ------------------------------------------------------------------ */
head('3. A GET writes nothing — the snapshot depends on it');
{
  const H = build();
  const A = account(H, 4);
  [['the portal', () => A.portal()],
   ['a client ticket', () => A.client(A.firstId)],
   ['a partner ticket', () => A.partner(A.firstId)],
   ['the vendor portal', () => A.vendor()],
   ['a property lookup', () => H.get({ property: '1 BUDGET ST||02116' })],
   ['the health check', () => H.get({})],
  ].forEach(([label, fn]) => {
    const m = H.measure(fn);
    t(label + ' makes no sheet writes', m.writes.length === 0, m.writes);
  });
}

/* ------------------------------------------------------------------ */
head('4. Snapshots are shared inside doGet, and never inside doPost');
{
  const H = build();
  account(H, 2);
  const X = H.evalIn(`(function () {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var out = {};
    out.getShares  = withRequestScope(true,  function () { return readTable(ss, "JOBS") === readTable(ss, "JOBS"); });
    out.postShares = withRequestScope(false, function () { return readTable(ss, "JOBS") === readTable(ss, "JOBS"); });
    out.noneShares = readTable(ss, "JOBS") === readTable(ss, "JOBS");
    /* The case the rule exists for: read, write, read again, in a POST. */
    out.postSeesOwnWrite = withRequestScope(false, function () {
      var before = readTable(ss, "LEADS");
      var col = before.headers.indexOf("notes");
      before.sheet.getRange(2, col + 1).setValue("written mid-request");
      return readTable(ss, "LEADS").rows[0][col];
    });
    out.missingTab = withRequestScope(true, function () { return readTable(ss, "NO_SUCH_TAB"); });
    /* sheetValues is what the write paths use, and it must stay fresh even
       inside a shared scope — bookAvailabilitySlot reads the sheet as it is
       NOW, inside the lock, or it can sell a slot twice. */
    out.sheetValuesShares = withRequestScope(true, function () {
      var jobs = ss.getSheetByName("JOBS");
      return sheetValues(jobs) === sheetValues(jobs);
    });
    return out;
  })()`);
  t('inside a GET, a second read of a tab is the same snapshot', X.getShares === true);
  t('inside a POST, every read is fresh', X.postShares === false);
  t('outside any request (editor-run code), every read is fresh', X.noneShares === false);
  t('a POST that writes and reads back sees its own write',
    X.postSeesOwnWrite === 'written mid-request', X.postSeesOwnWrite);
  t('a missing tab reads as null, not a throw', X.missingTab === null);
  t('sheetValues is never shared, even inside a GET', X.sheetValuesShares === false);

  /* The wiring itself. Everything above calls the helper directly; this is
     what proves the ENTRY POINTS open the right kind of scope. */
  const W = build();
  const WA = account(W, 2);
  W.scopeSeen.length = 0;
  WA.portal();
  const inGet = W.scopeSeen.slice();
  W.scopeSeen.length = 0;
  W.post({ event_type: 'portal_write', contact_id: 'CON-0001', t: W.box.portalToken('CON-0001'),
           kind: 'access', property_id: 'PROP-0001', field: 'parking', choice: 'GARAGE' });
  const inPost = W.scopeSeen.slice();
  t('doGet runs every read inside a SHARED scope',
    inGet.length > 0 && inGet.every(x => x === 'shared'), inGet);
  t('doPost runs every read inside a FRESH scope',
    inPost.length > 0 && inPost.every(x => x === 'fresh'), inPost);
}

/* ------------------------------------------------------------------ */
head('5. Snapshots are keyed by workbook, not only by tab name');
{
  const H = build();
  const Y = H.evalIn(`(function () {
    var mk = function (label) {
      return { getSheetByName: function () {
        return { getDataRange: function () { return { getValues: function () { return [["h"], [label]]; } }; } };
      } };
    };
    var leads = mk("from leads"), ops = mk("from ops");
    return withRequestScope(true, function () {
      return [readTable(leads, "SETTINGS").rows[0][0], readTable(ops, "SETTINGS").rows[0][0]];
    });
  })()`);
  t('the same tab name in two workbooks is two tables', Y[0] === 'from leads' && Y[1] === 'from ops', Y);
}

/* ------------------------------------------------------------------ */
head('6. The scope closes — between requests, and when a request throws');
{
  const H = build();
  const A = account(H, 2);
  const before = A.portal();
  t('no scope is left open after a GET', H.evalIn('REQUEST_SCOPE') === null);
  H.job('SRV-20261120-LATER1', 'me@example.com', 'PROP-0001', { scheduled_date: '2026-11-20' });
  const after = A.portal();
  t('a booking added between two GETs appears in the second',
    after.bookings.length === before.bookings.length + 1,
    { before: before.bookings.length, after: after.bookings.length });

  H.post({ event_type: 'portal_write', contact_id: 'CON-0001', t: H.box.portalToken('CON-0001'),
           kind: 'access', property_id: 'PROP-0001', field: 'parking', choice: 'GARAGE' });
  t('no scope is left open after a POST', H.evalIn('REQUEST_SCOPE') === null);

  const threw = H.evalIn(`(function () {
    try { withRequestScope(true, function () { throw new Error("boom"); }); } catch (_) {}
    return REQUEST_SCOPE === null;
  })()`);
  t('a request that throws still closes its scope', threw === true);

  const nested = H.evalIn(`(function () {
    return withRequestScope(true, function () {
      withRequestScope(false, function () {});
      return REQUEST_SCOPE !== null && REQUEST_SCOPE.snapshots === true;
    });
  })()`);
  t('a nested scope joins the open one instead of closing it', nested === true);
}

/* ------------------------------------------------------------------ */
head('7. Reading less did not change what is read');
{
  /* A duplicated job_id — an operator copying a row and not changing the id.
     r43 built every booking by searching JOBS for its id and took the FIRST
     match, so the second contact's portal showed the first contact's row.
     Building from the row in hand shows each person their own. */
  const H = build();
  H.lead('first@example.com', 'First Person', 'CON-0101');
  H.lead('second@example.com', 'Second Person', 'CON-0102');
  H.job('SRV-20261001-DUPLIC', 'first@example.com', 'PROP-0101', { address: '11 First St' });
  H.job('SRV-20261001-DUPLIC', 'second@example.com', 'PROP-0102', { address: '22 Second St' });
  const second = H.get({ portal: 'CON-0102', t: H.box.portalToken('CON-0102') });
  const text = JSON.stringify(second);
  t('the second contact sees their own address', text.includes('22 Second St'));
  t('and never the first contact\'s', !text.includes('11 First St'));

  /* An empty sheet's data range is one blank cell, not zero cells. */
  const empty = H.evalIn(`sheetValues({ getDataRange: function () {
    return { getValues: function () { return [[""]]; } }; } })`);
  t('an empty sheet has no headers and no rows, as sheetHeaders() says',
    empty.headers.length === 0 && empty.rows.length === 0, empty);

  /* Dates still read through the workbook's own timezone, now asked once. */
  const S = build();
  S.setTz('Australia/Sydney');
  S.lead('tz@example.com', 'Tz Person', 'CON-0201');
  S.job('SRV-20261018-TZCELL', 'tz@example.com', 'PROP-0201',
        { scheduled_date: new Date('2026-10-17T13:00:00Z') });   // 18 Oct, midnight in Sydney
  const tzPortal = S.get({ portal: 'CON-0201', t: S.box.portalToken('CON-0201') });
  t('a date cell reads as the day typed in the workbook\'s timezone',
    tzPortal.bookings && tzPortal.bookings[0].date === '2026-10-18',
    tzPortal.bookings && tzPortal.bookings[0].date);
}

console.log('\n' + (bad ? 'FAILURES: ' + bad : 'all read-budget checks passed'));
process.exit(bad ? 1 : 0);
