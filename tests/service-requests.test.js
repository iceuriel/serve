/* SERVICE REQUESTS — the portal asks for something other than a clean.  r62
   ==================================================================
   Four things this file exists to prove, in order of how badly they would hurt:

     1. A PORTAL TOKEN AUTHORISES ONE CONTACT. A request is the first portal
        write that targets nothing the customer already has, so there is no
        booking or home to prove ownership of — the token IS the check. And a
        photograph on somebody else's request must be refused as flatly as a
        note on somebody else's booking.

     2. THE CATALOGUE CANNOT DRIFT. serve-services.js decides what Serve says
        it does. webhook.gs cannot read it — it is a browser script — so the ids
        are restated there, and both are read HERE and compared. Two surfaces
        describing the same thing in different words drift until something reads
        both; that is exactly how the prefill vocabulary and the quote API came
        to disagree, silently, for weeks.

     3. THE OPERATOR'S STATUS CELL NEVER REACHES THE CUSTOMER. An internal note
        typed into it ("chasing, vendor ghosted us") must come out as a plain
        label, not as itself.

     4. THE THREE FOUNDER'S CALLS OF 2026-09-29 ARE STILL TRUE IN THE SHIPPED
        FILES: the homepage still says "Coming to Serve", no timeframe is
        promised anywhere on the request path, and nothing is priced.

   Driven through the SAME end-to-end harness booking-photos.test.js uses —
   real Worker, real Apps Script, in-memory Sheets and R2 — plus the real
   portal.js against the DOM shim for the half a customer touches. */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert/strict');
const { randomUUID } = require('crypto');

const ROOT = path.resolve(__dirname, '..');

let bad = 0;
/* Comparing by default. `want` omitted means "just be truthy", and `detail` is
   then what gets printed — a boolean alone names no bug. */
const t = (label, got, want) => {
  const okp = JSON.stringify(got) === JSON.stringify(want);
  console.log((okp ? '  ok    ' : '  FAIL  ') + label + '  ->  ' + JSON.stringify(got));
  if (!okp) { console.log('        expected ' + JSON.stringify(want)); bad++; }
};
const ok = (label, cond, detail) => {
  console.log((cond ? '  ok    ' : '  FAIL  ') + label +
              (detail !== undefined ? '  ->  ' + JSON.stringify(detail) : ''));
  if (!cond) bad++;
};
const head = (m) => console.log('\n=== ' + m + ' ===');

/* Slice another suite's harness out and run it for its machinery, never its
   assertions. Same helper booking-photos.test.js uses, plus a uniqueness check:
   a marker that starts matching twice would silently slice the wrong half. */
function harness(file, marker, exports) {
  const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
  const end = source.indexOf(marker);
  assert.ok(end > 0, file + ': marker "' + marker + '" not found');
  assert.equal(source.indexOf(marker, end + 1), -1, file + ': marker is not unique');
  return vm.runInNewContext(source.slice(0, end) + '\n(' + exports + ');', {
    require, __dirname, console, Buffer, AbortController, setTimeout, clearTimeout,
    setImmediate, URL, URLSearchParams, Response, Request, Headers,
    TextEncoder, TextDecoder, Blob, FormData, Intl,
  });
}

const H = harness('portal.test.js', 'const T = build();',
                  '{ build, JOBS_HEADERS, LEADS_HEADERS }');
const W = harness('worker-proxy.test.js', 'const ASSETS =', '{ loadWorker }');
const R = harness('portal-render.test.js', 'const PLAN = {',
                  '{ boot, all, byClass, textOf, node }');

const SERVICES_SRC = fs.readFileSync(path.join(ROOT, 'serve-services.js'), 'utf8');
const WEBHOOK = fs.readFileSync(path.join(ROOT, 'apps-script', 'webhook.gs'), 'utf8');
const PORTAL_SRC = fs.readFileSync(path.join(ROOT, 'portal.js'), 'utf8');
const WORKER_SRC = fs.readFileSync(path.join(ROOT, 'src', 'worker.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const H_HTML = fs.readFileSync(path.join(ROOT, 'h.html'), 'utf8');

/* One declaration out of a shipped file, EXECUTED rather than pattern-matched.
   A rename then fails here instead of passing against a copy written into this
   file, which is the whole point of reading both sides. */
function constantIn(source, name, where) {
  const m = source.match(new RegExp('const ' + name + ' = \\{[\\s\\S]*?\\n\\};'));
  assert.ok(m, name + ' not found in ' + where);
  return vm.runInNewContext(m[0] + '\n' + name + ';', {});
}

/* ==================================================================
   1. THE CATALOGUE CANNOT DRIFT
   ================================================================== */
head('1. One catalogue, read from both sides');

const catalogue = (() => {
  const box = { window: undefined };
  box.window = box;
  vm.createContext(box);
  vm.runInContext(SERVICES_SRC, box);
  return box.ServeServices;
})();
const requestServices = constantIn(WEBHOOK, 'REQUEST_SERVICES', 'webhook.gs');

const catalogueIds = catalogue.all().map(s => s.id).sort();
const scriptIds = Object.keys(requestServices).filter(k => k !== 'other').sort();

t('the catalogue still holds the six homepage categories', catalogueIds.length, 6);
t('every catalogue id is requestable, and there are no extras', scriptIds, catalogueIds);
ok('"other" exists on the script side only, and is not in the catalogue',
   !!requestServices.other && catalogueIds.indexOf('other') === -1,
   requestServices.other);

const nameMismatch = catalogue.all().filter(s => requestServices[s.id] !== s.name)
  .map(s => s.id + ': "' + s.name + '" vs "' + requestServices[s.id] + '"');
ok('and the names agree, so a request reads the same on both sides',
   nameMismatch.length === 0, nameMismatch);

ok('portal.js builds its chooser from ServeServices.all()',
   /ServeServices\.all\(\)/.test(PORTAL_SRC));
ok('and h.html actually loads that file, or the tab offers nothing',
   /<script src="serve-services\.js"><\/script>/.test(H_HTML));

/* ==================================================================
   2. WHAT WAS DELIBERATELY NOT CHANGED
   ================================================================== */
head('2. The founder\'s calls of 2026-09-29, asserted in the shipped files');

const planned = catalogue.all().filter(s => s.status === 'planned');
t('five categories are still "planned" in the catalogue', planned.length, 5);
ok('none of them was promoted to "request" or "live"',
   planned.every(s => s.status === 'planned'));

/* The homepage grid is a PUBLIC capability claim. A request channel for
   existing customers is not, and turning one into the other is not ours. */
const gridAt = INDEX.indexOf('One relationship');
ok('the "One relationship" section is still on the homepage', gridAt > 0);
const grid = INDEX.slice(gridAt, INDEX.indexOf('</section>', gridAt));
t('it still reads "Coming to Serve" five times',
  (grid.match(/Coming to Serve/g) || []).length, 5);
ok('and nothing in it has become "By request"', !/By request/.test(grid));

/* No timeframe and no price anywhere on the request path. These are the two
   promises most likely to be "improved" later by somebody who does not know
   they are promises. Comments are stripped first: this reads the copy that
   ships, not the reasoning about it. */
const requestCode = PORTAL_SRC
  .slice(PORTAL_SRC.indexOf('HOME SERVICES'), PORTAL_SRC.indexOf('ARRIVAL & ACCESS'))
  .replace(/\/\*[\s\S]*?\*\//g, '');
const clock = /(\d+\s*(hours?|hrs?|days?|business days?)|within the (hour|day)|same.day|24\s*h|one business day|by (tomorrow|tonight))/i;
ok('the Home services tab promises no timeframe', !clock.test(requestCode),
   (requestCode.match(clock) || [])[0] || null);
ok('and quotes no price', !/\$/.test(requestCode));

/* ==================================================================
   3. THE SERVER
   ================================================================== */
const T = H.build();
const S = T.box;
T.propStore.PHOTO_BRIDGE_SECRET = 'test-photo-bridge';
/* Set, because the live project sets it. Left unset the script falls back to
   Session.getEffectiveUser(), which this harness does not model — and section
   3f below proves that a send failing that way still keeps the request. */
T.propStore.NOTIFY_EMAIL = 'ops@example.com';

function seed(tab, headers, values) {
  tab.appendRow(headers.map(h => values[h] === undefined ? '' : values[h]));
}
seed(T.tabs.LEADS, H.LEADS_HEADERS,
     { lead_id: 'a@example.com', contact_id: 'CON-A', name: 'Ada Customer' });
seed(T.tabs.LEADS, H.LEADS_HEADERS,
     { lead_id: 'b@example.com', contact_id: 'CON-B', name: 'Bo Other' });
seed(T.tabs.JOBS, H.JOBS_HEADERS,
     { job_id: 'SRV-A1', lead_id: 'a@example.com', property_id: 'PROP-A',
       beds: 2, baths: 1, service_type: 'First Clean', quoted_price: 200,
       address: '12 Beacon St', unit: '4B', zip: '02116',
       name: 'Ada Customer', email: 'a@example.com', phone: '617-555-0101' });
seed(T.tabs.JOBS, H.JOBS_HEADERS,
     { job_id: 'SRV-B1', lead_id: 'b@example.com', property_id: 'PROP-B',
       beds: 1, baths: 1, service_type: 'First Clean', quoted_price: 150,
       address: '9 Hope Ave', zip: '02143',
       name: 'Bo Other', email: 'b@example.com', phone: '617-555-0202' });

const TOK_A = S.portalToken('CON-A');
const TOK_B = S.portalToken('CON-B');

/* Every outbound email, so "a human was told" is checked, not assumed. */
const mails = [];
S.MailApp = { sendEmail: (to, subject, body) => mails.push({ to, subject, body }) };

const post = (o) => JSON.parse(S.doPost({ postData: { contents: JSON.stringify(o) } }).getContent());
const write = (o, tok, cid) => post(Object.assign(
  { event_type: 'portal_write', contact_id: cid || 'CON-A', t: tok || TOK_A }, o));
const ask = (cid, tok) => JSON.parse(
  S.handlePortal({ portal: cid || 'CON-A', t: tok || TOK_A }).getContent());
let refs = 0;
const req = (o) => write(Object.assign(
  { kind: 'service_request', client_ref: 'ref-auto-' + (++refs) + '-pad' }, o));

head('3. A request reaches the sheet, and only from its own contact');
t('a wrong token files nothing',
  write({ kind: 'service_request', client_ref: 'ref-badtoken1', service: 'plumbing',
          message: 'leak' }, 'f'.repeat(20)).error, 'not_found');
t('a service outside the catalogue is refused',
  req({ service: 'pool_cleaning', message: 'the pool' }).error, 'unknown_service');
t('a request with no message is refused — a category alone is not actionable',
  req({ service: 'plumbing', message: '   ' }).error, 'message_required');
t('a malformed client reference is refused',
  write({ kind: 'service_request', client_ref: 'x', service: 'plumbing',
          message: 'leak' }).error, 'bad_request');
t("somebody else's home is refused, not silently dropped",
  req({ service: 'plumbing', message: 'leak', property_id: 'PROP-B' }).error, 'not_found');
ok('and nothing at all was written by any of those',
   !T.tabs.SERVICE_REQUESTS || T.tabs.SERVICE_REQUESTS.getLastRow() <= 1,
   T.tabs.SERVICE_REQUESTS ? T.tabs.SERVICE_REQUESTS.getLastRow() : 'no tab');

const first = write({ kind: 'service_request', client_ref: 'ref-first-0001',
  service: 'plumbing', property_id: 'PROP-A',
  message: 'Slow drip under the kitchen sink, worse since Saturday.' });
ok('a real request is accepted', first.ok === true, first);
ok('and gets an id a person can read out', /^REQ-\d{4}$/.test(String(first.request_id)),
   first.request_id);
ok('the tab was created with no setup step', !!T.tabs.SERVICE_REQUESTS);

const reqHeaders = T.tabs.SERVICE_REQUESTS._rows[0];
const cell = (n, row) => (row || T.tabs.SERVICE_REQUESTS._rows[1])[reqHeaders.indexOf(n)];
t('it carries the contact it belongs to', cell('contact_id'), 'CON-A');
t('and the lead_id every other tab joins on', cell('lead_id'), 'a@example.com');
t('the home, resolved to the label whoever reads the sheet needs',
  cell('property_label'), '12 Beacon St, 4B');
t('the service as a code and as a label',
  [cell('service'), cell('service_label')], ['plumbing', 'Plumbing']);
t('the message, verbatim', cell('message'),
  'Slow drip under the kitchen sink, worse since Saturday.');
t('status starts at NEW, for an operator to move along', cell('status'), 'NEW');
t('no photos yet', cell('photo_count'), 0);
t('and the name, email and phone to answer it with',
  [cell('customer_name'), cell('customer_email'), cell('customer_phone')],
  ['Ada Customer', 'a@example.com', '617-555-0101']);

head('3b. Nothing about a booking was touched');
t('no JOBS row was created', T.tabs.JOBS.getLastRow(), 3);
t('no availability was consumed', T.tabs.AVAILABILITY.getLastRow(), 1);
t('and no plan was offered', T.tabs.RECURRING_PLANS.getLastRow(), 1);

head('3c. A human was told, and told plainly that it is not a booking');
t('exactly one email went out', mails.length, 1);
ok('its subject names the service and the customer',
   /^Serve Request — Plumbing · Ada Customer$/.test(mails[0].subject), mails[0].subject);
ok('the body says in capitals that nothing is booked',
   /THIS IS NOT A BOOKING/.test(mails[0].body));
ok('it carries what they actually said',
   /Slow drip under the kitchen sink/.test(mails[0].body));
ok('and the phone number, so it can be answered without opening the sheet',
   /617-555-0101/.test(mails[0].body));
ok('it puts no price and no deadline in the founder\'s mouth',
   !/\$/.test(mails[0].body) && !/within \d/.test(mails[0].body));

head('3d. A write that timed out must not become two requests');
const again = write({ kind: 'service_request', client_ref: 'ref-first-0001',
  service: 'plumbing', property_id: 'PROP-A',
  message: 'Slow drip under the kitchen sink, worse since Saturday.' });
t('the retry is accepted', again.ok, true);
t('and says so rather than pretending to be new', again.duplicate, true);
t('handing back the SAME request id', again.request_id, first.request_id);
t('one row, not two', T.tabs.SERVICE_REQUESTS.getLastRow(), 2);
t('and the founder is not emailed twice about one leak', mails.length, 1);

head('3e. The message is capped');
const long = write({ kind: 'service_request', client_ref: 'ref-long-00001',
  service: 'other', message: 'x'.repeat(5000) });
t('a very long message is accepted', long.ok, true);
t('and stored at the 2000-character cap',
  String(cell('message', T.tabs.SERVICE_REQUESTS._rows[2])).length, 2000);

head('3f. A mail failure must not lose a saved request');
/* Filed by the OTHER contact so it cannot disturb the rows and indexes every
   section below reads. A MailApp quota failure, or the missing effective-user
   lookup this harness really has, must never come back as "that did not send"
   for a row that is already on the sheet — the same wrapper r61 put around the
   payment emails, for the same reason. */
S.MailApp = { sendEmail: () => { throw new Error('Service invoked too many times'); } };
const quiet = write({ kind: 'service_request', client_ref: 'ref-mailfail-01',
  service: 'electrical', message: 'Outlet in the hall is dead.' },
  TOK_B, 'CON-B');
ok('the request still succeeds', quiet.ok === true, quiet);
t('and is on the sheet', T.tabs.SERVICE_REQUESTS.getLastRow(), 4);
t("the other customer's request is visible to them",
  (ask('CON-B', TOK_B).requests || []).map(r => r.serviceLabel), ['Electrical']);
ok('and the failure was logged rather than swallowed silently',
   T.logs.some(l => /service request email failed/.test(l)),
   T.logs.filter(l => /email failed/.test(l)).length);
S.MailApp = { sendEmail: (to, subject, body) => mails.push({ to, subject, body }) };

/* ==================================================================
   4. THE VIEW MODEL
   ================================================================== */
head('4. What the customer is allowed to see');
const modelA = ask('CON-A');
t('their requests come back, newest first',
  modelA.requests.map(r => r.requestId), ['REQ-0002', 'REQ-0001']);
t('with the label from our own whitelist', modelA.requests[1].serviceLabel, 'Plumbing');
t('a plain status, never the raw cell', modelA.requests[1].statusLabel, 'Received');
t('and whether it is still open', modelA.requests[1].open, true);
ok('the created date is the shape prettyDate() can parse',
   /^\d{4}-\d{2}-\d{2}$/.test(modelA.requests[1].createdDate),
   modelA.requests[1].createdDate);

t('the row is a whitelist, field by field', Object.keys(modelA.requests[1]).sort(),
  ['clientRef', 'createdDate', 'message', 'open', 'photoLimit', 'photos',
   'propertyLabel', 'requestId', 'service', 'serviceLabel', 'statusLabel']);
ok('no raw status, no lead_id, no phone, no portal link',
   !/"status"|lead_id|customer_phone|portal_link|617-555/.test(JSON.stringify(modelA.requests)));
t('another contact sees none of THEIRS — only their own',
  (ask('CON-B', TOK_B).requests || [])
    .filter(r => ['REQ-0001', 'REQ-0002'].indexOf(r.requestId) >= 0), []);
t('and Ada is not shown Bo\'s',
  modelA.requests.filter(r => r.requestId === 'REQ-0003'), []);

head('4b. An operator\'s note in the status cell stays internal');
const statusCol = reqHeaders.indexOf('status');
T.tabs.SERVICE_REQUESTS.getRange(2, statusCol + 1)
  .setValue('chasing — vendor ghosted us, call Ada Friday');
const leaky = ask('CON-A');
t('the customer is told "Received", not the note', leaky.requests[1].statusLabel, 'Received');
ok('and the note is nowhere in the payload', !/ghosted/.test(JSON.stringify(leaky)));

head('4c. The statuses an operator can actually type');
[['NEW', 'Received', true], ['seen', 'Received', true],
 ['In Progress', 'In progress', true], ['in-progress', 'In progress', true],
 ['QUOTED', 'Quote sent', true], ['Scheduled', 'Scheduled', true],
 ['CLOSED', 'Closed', false], ['declined', 'Closed', false],
 ['', 'Received', true], ['anything at all', 'Received', true],
].forEach(([raw, label, open]) => {
  t('"' + raw + '" reads as "' + label + '"' + (open ? '' : ', and is closed'),
    [S.requestStatusLabel(raw), S.requestIsOpen(raw)], [label, open]);
});
T.tabs.SERVICE_REQUESTS.getRange(2, statusCol + 1).setValue('NEW');

/* ==================================================================
   5 & 6. PHOTOGRAPHS, through the real Worker
   ================================================================== */
const objects = new Map();
const BUCKET = {
  put: async (key, bytes) => { if (!objects.has(key)) objects.set(key, Buffer.from(bytes)); },
  get: async key => objects.has(key) ? { body: objects.get(key) } : null,
  head: async key => objects.has(key) ? {} : null,
  delete: async key => { for (const k of Array.isArray(key) ? key : [key]) objects.delete(k); },
};
const loaded = W.loadWorker(async (_, init) => new Response(
  S.doPost({ postData: { contents: init.body } }).getContent()));
const env = { WEBHOOK_URL: 'https://example.test/webhook', BOOKING_PHOTOS: BUCKET,
              PHOTO_BRIDGE_SECRET: 'test-photo-bridge' };
const jpeg = new Blob([new Uint8Array([255, 216, 255, 224, 0, 2, 255, 217])],
                      { type: 'image/jpeg' });
async function photos(data, file) {
  let body, headers;
  if (file) {
    body = new FormData();
    body.append('data', JSON.stringify(data));
    body.append('photo', file, 'r.jpg');
  } else { body = JSON.stringify(data); headers = { 'Content-Type': 'application/json' }; }
  return loaded.worker.fetch(new Request('https://servecleaning.com/api/photos',
    { method: 'POST', headers, body }), env);
}
const photoJson = async (d, f) => (await photos(d, f)).json();

const creds = { auth_kind: 'portal', contact_id: 'CON-A', t: TOK_A,
                purpose: 'request', request_id: 'REQ-0001', room_key: '' };
const pid = randomUUID();
const extra = [randomUUID(), randomUUID()];

/* ==================================================================
   7. THE BROWSER
   ================================================================== */
const REQ = { requestId: 'REQ-0001', clientRef: 'ref-existing-1', service: 'plumbing',
  serviceLabel: 'Plumbing', message: 'Slow drip under the sink.',
  propertyLabel: '12 Beacon St, 4B', createdDate: '2026-09-27',
  statusLabel: 'Received', open: true, photoLimit: 3, photos: [] };

function pageModel(over) {
  return Object.assign({
    ok: true, view: 'portal', firstName: 'Ada', photoSupport: true,
    bookings: [{ bookingId: 'SRV-A1', serviceLabel: 'First clean',
      serviceCode: 'CLEAN_DEEP', date: '2026-10-02', time: '9:00 AM',
      price: 200, completed: '', rooms: [], photos: [], partner: null }],
    homes: [{ propertyId: 'PROP-A', label: '12 Beacon St, 4B', questions: [] }],
    plan: null, movePlan: null, requests: [],
  }, over || {});
}

/* The photo module, stubbed — booking-photos.js builds canvases and registers a
   pagehide listener, neither of which the DOM shim has. What matters here is
   what portal.js ASKS of it, which is exactly what this records. */
const PHOTO_STUB = `
  window.addEventListener = function () {};
  window.__photoCalls = [];
  window.__photoFail = false;
  window.ServePhotos = {
    release: function () {},
    mount: function (opts) {
      window.__photoCalls.push({ call: 'mount', opts: opts });
      var n = document.createElement('div');
      n.className = 'room-photos';
      return n;
    },
    store: function (opts, file) {
      window.__photoCalls.push({ call: 'store', opts: opts, file: file });
      if (window.__photoFail) return Promise.reject(new Error('photo_unavailable'));
      return Promise.resolve({ id: 'PH-' + window.__photoCalls.length, roomKey: '',
                               createdAt: '2026-09-29' });
    },
  };
`;

const tick = (ms) => new Promise(r => setTimeout(r, ms || 20));
const openRequests = async (page) => {
  page.box.document.getElementById('p-nav').children[1]._on.click.forEach(fn => fn({}));
  await page.settle();
};
const fire = (n, ev) => ((n && n._on && n._on[ev]) || []).forEach(fn => fn({}));
const pick = (page, label) => {
  const row = R.byClass(page.body, 'pq__opt')
    .filter(n => n.children.some(c => c._text === label))[0];
  ok('the option "' + label + '" exists', !!row);
  if (row) { row.children[0].checked = true; fire(row.children[0], 'change'); }
};
const type = (page, text) => {
  const box = R.byClass(page.body, 'tk-edit__box')[0];
  ok('there is a message box', !!box);
  if (box) { box.value = text; fire(box, 'input'); }
  return box;
};
const send = async (page) => {
  fire(R.byClass(page.body, 'svcreq__send')[0], 'click');
  for (let i = 0; i < 8; i++) { await tick(15); await page.settle(); }
};

(async function main() {

  head('5. A photograph on a request');
  ok('the public /exec cannot forge upload metadata without the bridge token',
     post({ event_type: 'booking_photo', ...creds, action: 'begin',
            photo_id: pid, bytes: 8 }).ok === false);
  ok('a wrong portal token is refused',
     (await photoJson({ ...creds, t: 'wrong', action: 'upload', photo_id: pid }, jpeg)).ok === false);
  ok("another contact's credential cannot reach this request",
     (await photoJson({ ...creds, contact_id: 'CON-B', t: TOK_B, action: 'upload',
                        photo_id: randomUUID() }, jpeg)).ok === false);
  t('a request that does not exist is refused the same way',
    (await photoJson({ ...creds, request_id: 'REQ-9999', action: 'upload',
                       photo_id: randomUUID() }, jpeg)).error, 'not_found');
  ok('a TICKET token cannot reach a request',
     (await photoJson({ ...creds, auth_kind: 'client',
                        t: S.ticketToken('SRV-A1', 'client'), action: 'upload',
                        photo_id: randomUUID() }, jpeg)).ok === false);
  ok('an invented room is refused rather than ignored',
     (await photoJson({ ...creds, room_key: 'KITCHEN', action: 'upload',
                        photo_id: randomUUID() }, jpeg)).ok === false);
  t('and none of those reached R2', objects.size, 0);

  const stored = await photoJson({ ...creds, action: 'upload', photo_id: pid }, jpeg);
  ok('a real upload succeeds', stored.ok === true, stored);
  t('the photo has no room, on both sides', stored.photo.roomKey, '');
  t('exactly one object in R2', objects.size, 1);
  t('under the request prefix, never the booking one',
    [...objects.keys()][0], 'request-photos/' + pid + '.jpg');

  head('5b. Where the bytes are NOT');
  ok('nothing landed under booking-photos/',
     ![...objects.keys()].some(k => k.startsWith('booking-photos/')));
  ok('request photos have their own tab, so the nightly booking sweep cannot see them',
     !!T.tabs.SERVICE_REQUEST_PHOTOS && !T.tabs.BOOKING_PHOTOS,
     Object.keys(T.tabs).filter(n => /PHOTO/.test(n)));
  t('and the sweep, asked, finds nothing to delete',
    post({ event_type: 'booking_photo', bridge_token: 'test-photo-bridge',
           action: 'cleanup' }).photos, []);

  head('5c. The customer sees it, and the founder can count it');
  t('it is on their request', ask('CON-A').requests[1].photos.map(p => p.id), [pid]);
  ok('no storage key came with it',
     !/object_key|request-photos\//.test(JSON.stringify(ask('CON-A').requests)));
  t('photo_count on the sheet was recounted, not guessed', cell('photo_count'), 1);

  head('5d. Every read is authorised');
  const readOk = await photos({ ...creds, action: 'read', photo_id: pid });
  t('the owner reads the image', readOk.headers.get('Content-Type'), 'image/jpeg');
  ok('and it is never cached', /no-store/.test(readOk.headers.get('Cache-Control')));
  ok('the bytes are the bytes that were sent',
     Buffer.from(await readOk.arrayBuffer()).equals(Buffer.from(await jpeg.arrayBuffer())));
  ok('another contact cannot read it',
     (await photoJson({ ...creds, contact_id: 'CON-B', t: TOK_B, action: 'read',
                        photo_id: pid })).ok === false);

  head('5e. Three photos per request, and not four');
  for (const id of extra) {
    ok('another photo stored',
       (await photoJson({ ...creds, action: 'upload', photo_id: id }, jpeg)).ok === true);
  }
  t('a fourth is refused by the SHEET, not merely by the browser',
    (await photoJson({ ...creds, action: 'upload', photo_id: randomUUID() }, jpeg)).error,
    'photo_limit');
  t('three objects, not four', objects.size, 3);
  t('and photo_count agrees', cell('photo_count'), 3);

  head('5f. Removing one');
  t('a customer can remove their own photo',
    (await photoJson({ ...creds, action: 'delete', photo_id: extra[0] })).ok, true);
  t('the object is gone from R2', objects.size, 2);
  t('photo_count came back down', cell('photo_count'), 2);
  t('and it is off their request',
    ask('CON-A').requests[1].photos.map(p => p.id).indexOf(extra[0]), -1);

  head('5g. A closed request keeps its pictures and takes no more');
  T.tabs.SERVICE_REQUESTS.getRange(2, statusCol + 1).setValue('CLOSED');
  t('no new photo',
    (await photoJson({ ...creds, action: 'upload', photo_id: randomUUID() }, jpeg)).error,
    'closed');
  t('no removing one either',
    (await photoJson({ ...creds, action: 'delete', photo_id: extra[1] })).error, 'closed');
  const closedRead = await photos({ ...creds, action: 'read', photo_id: pid });
  t('but the pictures still open', closedRead.headers.get('Content-Type'), 'image/jpeg');
  t('the customer is told it is closed', ask('CON-A').requests[1].statusLabel, 'Closed');
  t('with the photos still on it', ask('CON-A').requests[1].photos.length, 2);
  T.tabs.SERVICE_REQUESTS.getRange(2, statusCol + 1).setValue('NEW');

  /* ================================================================ */
  head('6. A purpose is a whitelist now, not a test for one value');
  /* THE LATENT BUG THIS CLOSES. Until r62 handlePhotos read
     `data.purpose === "completion"` and EVERYTHING else — a typo included —
     became an instruction photo. A mistyped "completon" would have filed a
     permanently locked completion image as a deletable customer one, under the
     prefix the nightly sweep is allowed to delete from. */
  const room = { auth_kind: 'portal', contact_id: 'CON-A', t: TOK_A,
                 job_id: 'SRV-A1', room_key: 'KITCHEN' };
  t('a mistyped purpose is refused, not quietly downgraded',
    (await photoJson({ ...room, purpose: 'completon', action: 'upload',
                       photo_id: randomUUID() }, jpeg)).error, 'bad_upload');
  ok('an absent purpose still means an instruction photo, as every old caller sends',
     (await photoJson({ ...room, action: 'upload', photo_id: randomUUID() }, jpeg)).ok === true);
  ok('which lands under booking-photos/, where the nightly sweep can reach it',
     [...objects.keys()].some(k => k.startsWith('booking-photos/')));

  const prefixes = constantIn(WORKER_SRC, 'PHOTO_PURPOSES', 'src/worker.js');
  t('three purposes, three prefixes', Object.keys(prefixes).sort(),
    ['completion', 'instruction', 'request']);
  t('no two share a prefix', new Set(Object.values(prefixes)).size, 3);
  t('the completion prefix is still its own, so the lock cannot be swept by accident',
    prefixes.completion, 'completion-photos/');

  /* The cron is the one thing that must NOT learn about the new prefix. */
  const cronAt = WORKER_SRC.indexOf('async function cleanupPhotoStorage');
  const cron = WORKER_SRC.slice(cronAt, WORKER_SRC.indexOf('\n}\n', cronAt));
  ok('the nightly sweep still names booking-photos/ literally',
     (cron.match(/"booking-photos\/"/g) || []).length === 1, cron.length);
  ok('and knows nothing of the request or completion prefixes',
     !/request-photos|completion-photos/.test(cron));

  /* ================================================================ */
  head('7. The page a customer actually uses');
  const A = await R.boot(pageModel(), { preload: PHOTO_STUB });
  t('the page renders without throwing', A.warns, []);
  t('three tabs, in order',
    A.box.document.getElementById('p-nav').children.map(b => b._text),
    ['Bookings', 'Home services', 'Arrival & access']);

  await openRequests(A);
  t('the tab renders its form', R.byClass(A.body, 'svcreq').length, 1);

  /* THE COPY ON SCREEN, read the way a customer reads it. It may say cleaning
     is bookable — that IS the distinction being drawn — but nothing on this
     tab may suggest that sending a request books, schedules, confirms or
     prices anything, and none of it may name a clock. */
  const onScreen = R.all(A.body).map(n => n._text || '').join(' ');
  ok('the tab explains that cleaning is the bookable one',
     /book yourself/i.test(onScreen));
  ok('but never claims a request is booked, scheduled or confirmed',
     !/\b(is booked|we.ll book|booked|scheduled|confirmed)\b/i.test(onScreen),
     (onScreen.match(/\b(is booked|we.ll book|booked|scheduled|confirmed)\b/i) || [])[0] || null);
  ok('and promises no clock and no price on screen either',
     !clock.test(onScreen) && !/\$/.test(onScreen),
     (onScreen.match(clock) || [])[0] || null);
  t('all six categories plus Something else are offered',
    R.byClass(A.body, 'pq__opt-label').map(n => n._text),
    ['Cleaning', 'Handyman', 'Plumbing', 'Heating & Cooling', 'Electrical',
     'Lawn & Snow', 'Something else']);
  ok('one home means no home question, just a statement',
     R.byClass(A.body, 'tk-val').map(n => n._text).indexOf('12 Beacon St, 4B') >= 0);
  t('nothing has been sent', A.posts.length, 0);

  head('7b. Sending one, with a photograph');
  const B = await R.boot(pageModel(), {
    preload: PHOTO_STUB,
    /* The account, answering with the request the page has just filed —
       recognised by the reference the page invented for itself. */
    afterPost: (body) => Object.assign(pageModel(), {
      requests: [Object.assign({}, REQ, { requestId: 'REQ-0007',
        clientRef: body.client_ref, service: body.service,
        serviceLabel: 'Heating & Cooling', message: body.message, photos: [] })],
    }),
  });
  await openRequests(B);
  pick(B, 'Heating & Cooling');
  type(B, 'No heat upstairs since the cold snap. Thermostat clicks, nothing happens.');

  /* Attach a file the way the file input does. */
  const inputs = R.all(B.body).filter(n => n.tagName === 'input' && n.type === 'file');
  ok('the form offers a camera and an upload', inputs.length === 2, inputs.length);
  inputs[1].files = [{ name: 'boiler.jpg' }];
  fire(inputs[1], 'change');
  await B.settle();
  t('the chosen file is listed before sending',
    R.byClass(B.body, 'svcreq__file-name').map(n => n._text), ['boiler.jpg']);

  await send(B);
  t('exactly one write went out', B.posts.length, 1);
  const sent = B.posts[0];
  t('addressed as a service request', sent.kind, 'service_request');
  t('with the credential in the BODY, never a query string',
    [sent.contact_id, sent.t], ['CON-1', 'tok']);
  t('the chosen service, by code', sent.service, 'hvac');
  t('the home it is about', sent.property_id, 'PROP-A');
  t('what they typed', sent.message,
    'No heat upstairs since the cold snap. Thermostat clicks, nothing happens.');
  ok('and a reference so a lost answer can be chased rather than re-sent',
     /^r[a-z0-9]{6,}$/.test(String(sent.client_ref)), sent.client_ref);
  ok('no price and no date were invented by the page',
     !('quote_price' in sent) && !('scheduled_date' in sent) && !('quoted_price' in sent));

  const uploads = B.box.__photoCalls.filter(c => c.call === 'store');
  t('the photo was uploaded once, after the request existed', uploads.length, 1);
  t('against the request the server had just minted', uploads[0].opts.extra,
    { request_id: 'REQ-0007' });
  t('as a request photo, with no room and no job',
    [uploads[0].opts.purpose, uploads[0].opts.roomKey, uploads[0].opts.jobId],
    ['request', '', '']);
  t('on this customer\'s own portal credential', uploads[0].opts.auth,
    { auth_kind: 'portal', contact_id: 'CON-1', t: 'tok' });
  t('and it was the file they chose', uploads[0].file, { name: 'boiler.jpg' });

  t('the customer is told it was sent', R.textOf(B.body, 'tk-save'),
    'Sent — we will follow up with you.');
  t('the request is now on the page', R.byClass(B.body, 'svcreq-card').length, 1);
  t('naming the service', R.textOf(B.body, 'svcreq-card__title'), 'Heating & Cooling');
  t('and its plain status', R.textOf(B.body, 'svcreq-card__tag'), 'Received');
  t('the form was emptied', R.byClass(B.body, 'tk-edit__box')[0].value, '');
  t('with no file left attached to it', R.byClass(B.body, 'svcreq__file-name').length, 0);
  const mounted = B.box.__photoCalls.filter(c => c.call === 'mount');
  ok('the new request carries its photo grid', mounted.length >= 1);
  t('and the uploaded photo is already on it',
    mounted[mounted.length - 1].opts.photos.map(p => p.id), ['PH-1']);

  head('7c. A photo that fails must not fail the request');
  const P = await R.boot(pageModel(), {
    preload: PHOTO_STUB + '\nwindow.__photoFail = true;',
    afterPost: (body) => Object.assign(pageModel(), {
      requests: [Object.assign({}, REQ, { clientRef: body.client_ref, photos: [] })],
    }),
  });
  await openRequests(P);
  pick(P, 'Plumbing');
  type(P, 'Drip under the sink.');
  const pInputs = R.all(P.body).filter(n => n.tagName === 'input' && n.type === 'file');
  pInputs[1].files = [{ name: 'sink.jpg' }];
  fire(pInputs[1], 'change');
  await P.settle();
  await send(P);
  t('the request was still sent', P.posts.length, 1);
  t('it is on the page', R.byClass(P.body, 'svcreq-card').length, 1);
  t('and the customer is told which half failed', R.textOf(P.body, 'tk-save'),
    'Sent — but the photo did not upload. Add it to the request below.');

  head('7d. A write nobody heard the answer to');
  /* The r58 failure applied to this form: the Worker gave up on a slow script
     while the row was already written. Sending a second copy would have the
     founder ring the customer twice about one broken boiler. */
  const C = await R.boot(pageModel(), {
    preload: PHOTO_STUB,
    reply: { ok: false, error: 'upstream_unreachable' },
    afterPost: (body) => Object.assign(pageModel(), {
      requests: [Object.assign({}, REQ, { clientRef: body.client_ref })],
    }),
  });
  await openRequests(C);
  pick(C, 'Plumbing');
  type(C, 'Drip under the sink.');
  await send(C);
  t('it was sent once and only once', C.posts.length, 1);
  t('and the page found its own request rather than re-filing it',
    R.byClass(C.body, 'svcreq-card').length, 1);
  t('the customer is not told it failed', R.textOf(C.body, 'tk-save'),
    'Sent — we will follow up with you.');

  head('7e. A write that truly did not land');
  const L = await R.boot(pageModel(), {
    preload: PHOTO_STUB,
    reply: { ok: false, error: 'upstream_unreachable' },
    afterPost: () => pageModel(),          // the account never shows it
  });
  await openRequests(L);
  pick(L, 'Plumbing');
  type(L, 'Drip under the sink.');
  fire(R.byClass(L.body, 'svcreq__send')[0], 'click');
  for (let i = 0; i < 14; i++) { await tick(1200); await L.settle(); }
  t('still only one attempt', L.posts.length, 1);
  ok('and it says honestly that it could not confirm',
     /could not confirm/.test(R.textOf(L.body, 'tk-save')), R.textOf(L.body, 'tk-save'));
  ok('the typed message was NOT thrown away',
     R.byClass(L.body, 'tk-edit__box')[0].value === 'Drip under the sink.',
     R.byClass(L.body, 'tk-edit__box')[0].value);

  head('7f. A refusal the script actually made is reported as itself');
  const D = await R.boot(pageModel(),
    { preload: PHOTO_STUB, reply: { ok: false, error: 'message_required' } });
  await openRequests(D);
  pick(D, 'Plumbing');
  type(D, 'something');
  await send(D);
  t('no second attempt on a considered refusal', D.posts.length, 1);
  t('and the reason is shown', R.textOf(D.body, 'tk-save'),
    'Tell us what is going on first.');

  head('7g. Sending nothing sends nothing');
  const E = await R.boot(pageModel(), { preload: PHOTO_STUB });
  await openRequests(E);
  await send(E);
  t('no service chosen, no write', E.posts.length, 0);
  t('and it says which step is missing', R.textOf(E.body, 'tk-save'),
    'Choose which service you need.');

  head('7h. Requests already on the account');
  const F = await R.boot(pageModel({ requests: [REQ,
    Object.assign({}, REQ, { requestId: 'REQ-0000', serviceLabel: 'Handyman',
      statusLabel: 'Closed', open: false, message: 'Shelf mounted, thanks.' })] }),
    { preload: PHOTO_STUB });
  await openRequests(F);
  t('both are listed', R.byClass(F.body, 'svcreq-card').length, 2);
  t('with their own statuses',
    R.byClass(F.body, 'svcreq-card__tag').map(n => n._text), ['Received', 'Closed']);
  ok('the closed one is marked as such',
     R.byClass(F.body, 'svcreq-card__tag')[1].className.indexOf('is-closed') >= 0);
  ok('the form is still there, above them', R.byClass(F.body, 'svcreq').length === 1);
  ok('a closed request with no photos gets no photo grid',
     F.box.__photoCalls.filter(c => c.call === 'mount').length === 1);

  head('7i. Two homes become a question');
  const G = await R.boot(pageModel({ homes: [
    { propertyId: 'PROP-A', label: '12 Beacon St, 4B', questions: [] },
    { propertyId: 'PROP-C', label: '88 Elm St', questions: [] }] }),
    { preload: PHOTO_STUB });
  await openRequests(G);
  t('both homes are offered, plus somewhere else',
    R.byClass(G.body, 'pq__opt-label').map(n => n._text).slice(-3),
    ['12 Beacon St, 4B', '88 Elm St', 'Somewhere else']);

  head('7j. No photo storage means no photo controls');
  const N = await R.boot(pageModel({ photoSupport: false }), { preload: PHOTO_STUB });
  await openRequests(N);
  t('the form still works', R.byClass(N.body, 'svcreq').length, 1);
  t('but offers no file input',
    R.all(N.body).filter(n => n.tagName === 'input' && n.type === 'file').length, 0);

  head('8. The shipped JavaScript parses');
  const { execFileSync } = require('child_process');
  ['portal.js', 'booking-photos.js', 'serve-services.js'].forEach(f => {
    try {
      execFileSync(process.execPath, ['--check', path.join(ROOT, f)], { stdio: 'pipe' });
      ok(f + ' parses', true);
    } catch (e) {
      ok(f + ' DOES NOT PARSE', false, String(e.stderr || e.message).split('\n')[0]);
    }
  });

  console.log('\n' + (bad ? 'FAILURES: ' + bad : 'ALL CHECKS PASSED'));
  process.exit(bad ? 1 : 0);
})();
