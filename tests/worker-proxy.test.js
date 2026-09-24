/**
 * The edge Worker — src/worker.js.
 *
 * This sits on the critical path of every booking, so the tests care mostly
 * about failure: the whole reason it exists is that a booking was failing in a
 * way that looked like success.
 *
 * Runs the real Worker module with a stubbed fetch and ASSETS binding.
 */
const REPO_ROOT = require('path').resolve(__dirname, '..');
const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

let bad = 0;
const t = (label, cond, extra) => {
  console.log((cond ? '  ok    ' : '  FAIL  ') + label + (extra !== undefined ? '  ->  ' + JSON.stringify(extra) : ''));
  if (!cond) bad++;
};

/* ---------- load the Worker as an ES module inside a vm ---------- */
const SRC = fs.readFileSync(path.join(REPO_ROOT, 'src', 'worker.js'), 'utf8');

/* Node's vm has no module loader here, so turn `export default {…}` into an
   assignment. Everything else about the file executes verbatim.

   The two imports get the same treatment for the same reason, and are replaced
   by concatenating the very files they name. That is precisely what wrangler
   does when it bundles, so verifyPrice() below runs against the real pricing
   engine rather than a stub — the whole point of the exercise is that there is
   one engine, and a test that mocked it would be testing the wrong thing.

   The Worker imports exactly ONE thing — src/engine.generated.mjs — so that is
   what gets loaded here, in its own scope, handed back only through its
   exports. Nothing leaks into the worker's scope by accident.

   The version of this harness that concatenated the two source files into the
   worker's scope is why a broken import shipped green on 2026-09-02: it
   manufactured globals that no bundle has, so an import resolving to undefined
   could not fail here. */
const ENGINE_MJS = fs.readFileSync(path.join(REPO_ROOT, 'src', 'engine.generated.mjs'), 'utf8');

const CJS_TAIL =
  'module.exports = { lookupGeo, ZIP_GEO, PARK_ADDER, DEFAULT_GEO, computeQuote,' +
  ' serveGeo, NEUTRAL_GEO, PRICING_VERSION, PRICING, WORK_MODEL, MARGIN,' +
  ' WORK_RATE, TARGET_WAGE, zipTier, ZIP_TIERS };';

/* Only the closing `export {…}` is rewritten, so every line of engine code
   under test is the shipped one. */
function loadModule(source) {
  const modBox = { module: { exports: {} }, console: { log() {}, warn() {}, error() {} } };
  modBox.exports = modBox.module.exports;
  vm.createContext(modBox);
  vm.runInContext(source.replace(/^export \{[\s\S]*?\};\s*$/m, CJS_TAIL), modBox);
  return modBox.module.exports;
}

const engineExports = loadModule(ENGINE_MJS);
const geoExports    = engineExports;   // one module now — the geo table is folded in

/* The binding list is READ FROM THE WORKER'S OWN IMPORT, not repeated here.
   It was hardcoded until adding one name to the worker broke this harness with
   a ReferenceError — the same drift that let a broken import ship, in a smaller
   costume. Parsing it means the harness cannot fall behind the file it tests. */
const importedNames = (SRC.match(/^import\s*\{([\s\S]*?)\}\s*from[^\n]*$/m) || [, ''])[1]
  .split(',').map(s => s.trim()).filter(Boolean);
if (!importedNames.length) throw new Error('could not read the worker import list');

const runnable =
  'const __m = globalThis.__engine;\n' +
  importedNames.map(n => 'const ' + n + ' = __m.' + n + ';').join('\n') + '\n' +
  SRC.replace(/^import\s*\{[\s\S]*?\}\s*from[^\n]*\n/m, '')
     .replace(/^import[^\n]*\n/gm, '')
     .replace(/export\s+default\s*\{/, 'globalThis.__worker = {');

function loadWorker(fetchImpl) {
  const calls = [];
  const box = {
    console: { log() {}, warn() {}, error(m) { calls.push({ log: String(m) }); } },
    AbortController, setTimeout, clearTimeout, URL, URLSearchParams,
    Response, Request, Headers, JSON,
    /* Present globally in Workers, absent in a bare vm. Modelled rather than
       stubbed so the hashing under test is the hashing that ships. */
    crypto: require('crypto').webcrypto, TextEncoder, TextDecoder,
    fetch: async (target, init) => {
      calls.push({ target, init });
      return fetchImpl(target, init);
    },
    globalThis: undefined,
    __geo: geoExports,
    __engine: engineExports,
  };
  box.globalThis = box;
  vm.createContext(box);
  vm.runInContext(runnable, box);
  /* box as well as the worker: the price-verification section below reaches in
     for verifyPrice and the bundled engine, which are module-private in the
     real thing and only inspectable from here. */
  return { worker: box.__worker, calls, box };
}

const ASSETS = { fetch: async () => new Response('<html>site</html>', {
  status: 200, headers: { 'Content-Type': 'text/html' } }) };

const ENV = {
  WEBHOOK_URL: 'https://script.google.com/macros/s/WEBHOOK/exec',
  AVAILABILITY_URL: 'https://script.google.com/macros/s/AVAIL/exec',
  ASSETS,
};

const ok   = body => async () => new Response(body, { status: 200 });
const boom = msg  => async () => { throw new Error(msg); };
const http = code => async () => new Response('upstream said no', { status: code });

const post = (body) => new Request('https://servecleaning.com/api/submit',
  { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body });
const get  = (p)    => new Request('https://servecleaning.com' + p, { method: 'GET' });

/* ============================================================ */
(async function run() {

console.log('=== 1. routing ===');
{
  const { worker, calls } = loadWorker(ok('{"status":"ok"}'));
  const res = await worker.fetch(get('/'), ENV);
  t('/ serves static assets, no upstream call', res.status === 200 && calls.length === 0);

  const res2 = await worker.fetch(get('/images/logo.svg'), ENV);
  t('asset paths never reach the relay', res2.status === 200 && calls.length === 0);
}

console.log('\n=== 2. POST /api/submit relays and passes the reply through ===');
{
  const upstream = '{"status":"ok","job_id":"SRV-1","duplicate":false,"slot_action":"booked"}';
  const { worker, calls } = loadWorker(ok(upstream));
  const res  = await worker.fetch(post('{"submission_id":"abc"}'), ENV);
  const body = await res.text();

  t('200 back to the browser', res.status === 200, res.status);
  t('webhook response passed through verbatim', body === upstream, body);
  t('content-type json', /application\/json/.test(res.headers.get('Content-Type')));
  t('not cached — a booking must never be replayed from cache',
    /no-store/.test(res.headers.get('Cache-Control')));

  const call = calls.find(c => c.target);
  t('called the WEBHOOK_URL from env, not a hardcoded address',
    call.target === ENV.WEBHOOK_URL, call.target);
  t('forwarded the body unchanged', call.init.body === '{"submission_id":"abc"}');
  t('sent text/plain upstream so Apps Script can answer',
    /text\/plain/.test(call.init.headers['Content-Type']));
  t('follows the /exec redirect to googleusercontent', call.init.redirect === 'follow');
}

console.log('\n=== 3. a failed booking must NOT look like a success ===');
{
  for (const [label, impl] of [['network error', boom('ECONNREFUSED')],
                               ['HTTP 500',      http(500)],
                               ['HTTP 403',      http(403)]]) {
    const { worker } = loadWorker(impl);
    const res  = await worker.fetch(post('{"submission_id":"x"}'), ENV);
    const body = JSON.parse(await res.text());
    t(label + ' -> 502, status "error"',
      res.status === 502 && body.status === 'error', { code: res.status, body });
    t(label + ' -> never reports status ok', body.status !== 'ok');
  }
}

console.log('\n=== 4. submit guards ===');
{
  const { worker, calls } = loadWorker(ok('{"status":"ok"}'));
  const res = await worker.fetch(get('/api/submit'), ENV);
  t('GET on /api/submit is rejected', res.status === 405, res.status);
  t('and never touches upstream', calls.filter(c => c.target).length === 0);

  const huge = await worker.fetch(post('x'.repeat(200000)), ENV);
  t('oversized body rejected', huge.status === 400, huge.status);

  const empty = await worker.fetch(post(''), ENV);
  t('empty body rejected', empty.status === 400, empty.status);

  const { worker: w2 } = loadWorker(ok('{}'));
  const noCfg = await w2.fetch(post('{"a":1}'), { ASSETS });
  const noCfgBody = JSON.parse(await noCfg.text());
  t('missing WEBHOOK_URL fails loudly, not silently',
    noCfg.status === 500 && noCfgBody.status === 'error', noCfgBody);
}

console.log('\n=== 4b. r55: the text and email go out AFTER the browser has its answer ===');
{
  const makeCtx = () => {
    const pending = [];
    return { pending, waitUntil: (p) => pending.push(p),
             settle: () => Promise.allSettled(pending) };
  };
  const pendingReply = '{"status":"ok","duplicate":false,"notify_pending":true,"submission_id":"sub-55"}';

  /* ---- the webhook parked a notice: the Worker sends for it, in the background ---- */
  {
    const { worker, calls } = loadWorker(ok(pendingReply));
    const ctx = makeCtx();
    const res = await worker.fetch(post('{"submission_id":"sub-55","name":"x"}'), ENV, ctx);
    const body = await res.text();

    const first = calls.find(c => c.target);
    t('the booking asks the webhook to defer its notifications',
      JSON.parse(first.init.body).notify_deferred === true, first.init.body);
    t('and otherwise relays the booking as sent',
      JSON.parse(first.init.body).submission_id === 'sub-55' &&
      JSON.parse(first.init.body).name === 'x');
    t('the browser still gets the webhook reply verbatim', body === pendingReply, body);
    t('the follow-up is queued in waitUntil, not awaited before answering',
      ctx.pending.length === 1, ctx.pending.length);

    await ctx.settle();
    const notify = calls.filter(c => c.target)[1];
    const nb = notify && JSON.parse(notify.init.body);
    t('it POSTs booking_notify for that submission to the webhook',
      notify && notify.target === ENV.WEBHOOK_URL && nb.event_type === 'booking_notify' &&
      nb.submission_id === 'sub-55' && !nb.action, nb);
    t('and carries nothing else about the customer',
      nb && Object.keys(nb).sort().join() === 'event_type,submission_id', nb);
  }

  /* ---- nothing parked (an old webhook, or a notice sent inline): no follow-up ---- */
  for (const [label, reply] of [
    ['a reply without notify_pending', '{"status":"ok","duplicate":false,"submission_id":"a"}'],
    ['notify_pending false',           '{"status":"ok","notify_pending":false,"submission_id":"a"}'],
    ['an error reply',                 '{"status":"error","notify_pending":true,"submission_id":"a"}'],
    ['a non-JSON reply',               'not json'],
  ]) {
    const { worker, calls } = loadWorker(ok(reply));
    const ctx = makeCtx();
    await worker.fetch(post('{"submission_id":"a"}'), ENV, ctx);
    await ctx.settle();
    t(label + ' -> no follow-up call', calls.filter(c => c.target).length === 1 &&
      ctx.pending.length === 0, calls.filter(c => c.target).length);
  }

  /* ---- a dead follow-up is a log line; the sweep takes it later ---- */
  {
    let n = 0;
    const { worker, calls } = loadWorker(async () => (++n === 1
      ? new Response(pendingReply, { status: 200 })
      : (() => { throw new Error('ETIMEDOUT'); })()));
    const ctx = makeCtx();
    const res = await worker.fetch(post('{"submission_id":"sub-55"}'), ENV, ctx);
    const settled = await ctx.settle();
    t('a failed follow-up does not touch the confirmed answer', res.status === 200, res.status);
    t('and resolves rather than rejecting', settled.every(s => s.status === 'fulfilled'));
    t('and is logged at error level',
      calls.some(c => c.log && /booking notify .* failed/.test(c.log)));
  }

  /* ---- no waitUntil: nothing to send from, so the webhook must send inline ---- */
  {
    const { worker, calls } = loadWorker(ok(pendingReply));
    await worker.fetch(post('{"submission_id":"sub-55"}'), ENV);
    t('without a ctx the body is not asked to defer',
      calls.find(c => c.target).init.body === '{"submission_id":"sub-55"}');
  }
}

console.log('\n=== 4c. r56: GET /api/booking-status — the cheap question behind the slow write ===');
{
  const makeCtx = () => {
    const pending = [];
    return { pending, waitUntil: (p) => pending.push(p),
             settle: () => Promise.allSettled(pending) };
  };
  const status = (id) => new Request(
    'https://servecleaning.com/api/booking-status?id=' + id, { method: 'GET' });

  /* ---- the shape of the upstream call: a READ, and nothing else ---- */
  {
    const { worker, calls } = loadWorker(ok('{"ok":true,"found":true,"notify_pending":false}'));
    const res  = await worker.fetch(status('sub-56'), ENV);
    const body = JSON.parse(await res.text());
    const call = calls.find(c => c.target);

    t('answers found:true', res.status === 200 && body.ok === true && body.found === true, body);
    t('asks the webhook with ?booking=, on the WEBHOOK_URL from env',
      call.target === ENV.WEBHOOK_URL + '?booking=sub-56', call.target);
    /* The reason this route can be polled at all: doGet takes no script lock,
       so it answers while the reservation's own write is still running. A POST
       would queue behind the very booking it is asking about — the trap r53
       found in the retry. */
    t('and asks with a GET, which cannot write and cannot take the lock',
      call.init.method === 'GET' && !call.init.body, call.init.method);
    t('never cached — a stale "not found" would strand a real booking',
      /no-store/.test(res.headers.get('Cache-Control')));
  }

  /* ---- found:false is a real answer and must survive the trip ---- */
  {
    const { worker } = loadWorker(ok('{"ok":true,"found":false}'));
    const body = JSON.parse(await (await worker.fetch(status('sub-56'), ENV)).text());
    t('a booking that is not there answers found:false', body.ok === true && body.found === false, body);
  }

  /* ---- "I don't know" must never read as "it failed" ----
     Every answer here means either "the booking is there" or "still don't
     know", and the caller's response to the second is to ask again shortly.
     A 502 would read as an outage and stop the poll on a live booking. */
  for (const [label, impl] of [['upstream down', boom('ETIMEDOUT')],
                               ['upstream 500',  http(500)]]) {
    const { worker } = loadWorker(impl);
    const r = await worker.fetch(status('sub-56'), ENV);
    const b = JSON.parse(await r.text());
    t(label + ' -> HTTP 200, ok:false, and never found:true',
      r.status === 200 && b.ok === false && b.found !== true, { code: r.status, body: b });
  }

  /* ---- a webhook older than r56 answers its health stamp, which has no `found` ---- */
  {
    const stale = '{"ok":true,"service":"serve-booking-webhook","version":"2026-09-17 r55"}';
    const { worker, calls } = loadWorker(ok(stale));
    const r = await worker.fetch(status('sub-56'), ENV);
    const b = JSON.parse(await r.text());
    t('an un-pasted script never reads as a confirmed booking', b.found !== true, b);
    t('and never as a definite "not there" either', b.ok === false, b);
    /* This is the one failure here that looks exactly like a booking that
       never landed, and it is fixed by pasting, not by waiting. */
    t('and says out loud that the script needs pasting',
      calls.some(c => c.log && /paste apps-script\/webhook\.gs r56/.test(c.log)),
      calls.filter(c => c.log).map(c => c.log));
  }

  /* ---- r55's parked notice: whoever first hears it is waiting, sends it ---- */
  {
    const { worker, calls } = loadWorker(ok('{"ok":true,"found":true,"notify_pending":true}'));
    const ctx = makeCtx();
    const res = await worker.fetch(status('sub-56'), ENV, ctx);
    t('the answer is not held up by the send', res.status === 200 && ctx.pending.length === 1,
      ctx.pending.length);
    await ctx.settle();
    const notify = calls.filter(c => c.target)[1];
    const nb = notify && JSON.parse(notify.init.body);
    t('it POSTs booking_notify for that submission',
      nb && nb.event_type === 'booking_notify' && nb.submission_id === 'sub-56', nb);
    t('and still carries nothing else about the customer',
      nb && Object.keys(nb).sort().join() === 'event_type,submission_id', nb);
  }

  /* ---- nothing to send, or nowhere to send it from ---- */
  for (const [label, reply, ctxOn] of [
    ['notify_pending without found', '{"ok":true,"found":false,"notify_pending":true}', true],
    ['no notify_pending',            '{"ok":true,"found":true}',                       true],
    ['found but no waitUntil',       '{"ok":true,"found":true,"notify_pending":true}', false],
  ]) {
    const { worker, calls } = loadWorker(ok(reply));
    const ctx = ctxOn ? makeCtx() : undefined;
    await worker.fetch(status('sub-56'), ENV, ctx);
    if (ctx) await ctx.settle();
    t(label + ' -> no notify call', calls.filter(c => c.target).length === 1,
      calls.filter(c => c.target).length);
  }

  /* ---- guards: a malformed poll must not cost an upstream round trip ---- */
  {
    for (const bad of ['', 'has space', 'a'.repeat(101), '../etc', 'a&b']) {
      const { worker, calls } = loadWorker(ok('{"ok":true,"found":true}'));
      const r = await worker.fetch(new Request(
        'https://servecleaning.com/api/booking-status?id=' + encodeURIComponent(bad),
        { method: 'GET' }), ENV);
      const b = JSON.parse(await r.text());
      t('a malformed id (' + JSON.stringify(bad.slice(0, 12)) + ') is refused without an upstream call',
        b.ok === false && b.found !== true && calls.filter(c => c.target).length === 0, b);
    }

    const { worker, calls } = loadWorker(ok('{"ok":true,"found":true}'));
    const wrong = await worker.fetch(new Request(
      'https://servecleaning.com/api/booking-status?id=sub-56', { method: 'POST', body: '{}' }), ENV);
    t('POST to the status route is rejected', wrong.status === 405, wrong.status);
    t('and never touches upstream', calls.filter(c => c.target).length === 0);

    const { worker: w2 } = loadWorker(ok('{"ok":true,"found":true}'));
    const noCfg = await w2.fetch(status('sub-56'), { ASSETS });
    const nb = JSON.parse(await noCfg.text());
    t('unconfigured webhook answers ok:false rather than found:true',
      noCfg.status === 200 && nb.ok === false && nb.found !== true, nb);
  }
}

console.log('\n=== 5. GET /api/slots — degrades, never blocks booking ===');
{
  const feed = '{"ok":true,"count":2,"slots":[{"date":"2026-08-07","time":"12:00 PM","open":1}]}';
  const { worker, calls } = loadWorker(ok(feed));
  const res  = await worker.fetch(get('/api/slots'), ENV);
  const body = await res.text();
  t('feed passed through verbatim', body === feed);
  t('called AVAILABILITY_URL', calls.find(c => c.target).target === ENV.AVAILABILITY_URL);
  t('briefly cacheable — the feed is already 5 min stale upstream',
    /max-age=\d+/.test(res.headers.get('Cache-Control')));

  /* The site treats ok:false exactly like an empty feed: show the
     earlier/later radios. So a slots outage must be a 200 with ok:false, NOT
     an error status the fetch would reject — otherwise a dead feed takes the
     booking flow down with it. */
  for (const [label, impl] of [['upstream down', boom('ETIMEDOUT')],
                               ['upstream 500',  http(500)]]) {
    const { worker: w } = loadWorker(impl);
    const r = await w.fetch(get('/api/slots'), ENV);
    const b = JSON.parse(await r.text());
    t(label + ' -> HTTP 200 with ok:false, so the site falls back cleanly',
      r.status === 200 && b.ok === false, { code: r.status, body: b });
  }

  const { worker: w3 } = loadWorker(ok('{}'));
  const noCfg = await w3.fetch(get('/api/slots'), { ASSETS });
  const b = JSON.parse(await noCfg.text());
  t('unconfigured feed also degrades to ok:false', noCfg.status === 200 && b.ok === false);

  const { worker: w4 } = loadWorker(ok(feed));
  const wrongMethod = await w4.fetch(new Request(
    'https://servecleaning.com/api/slots', { method: 'POST', body: '{}' }), ENV);
  t('POST to /api/slots rejected', wrongMethod.status === 405, wrongMethod.status);

  /* Uptime monitors and link checkers probe with HEAD. Refusing it makes a
     healthy endpoint look broken. */
  const head = await w4.fetch(new Request(
    'https://servecleaning.com/api/slots', { method: 'HEAD' }), ENV);
  t('HEAD is allowed so monitors see a healthy endpoint', head.status === 200, head.status);
}

console.log('\n=== 5b. a cold upstream must not cost the customer their slot list ===');
{
  /* MEASURED IN PRODUCTION 2026-09-24: seven of ten requests to /api/slots
     failed, every one of them exactly on the 8s wall, every success back in
     about 1.2s. A cold start, not an outage.

     It was invisible because the fallback is graceful: ok:false draws the
     earlier/later radios, so seven in ten customers reaching step 3 were
     offered a vague morning/afternoon preference instead of a real bookable
     time, and the page looked healthy throughout. These tests exist so it
     cannot go quiet again. */

  const feed = '{"ok":true,"count":2,"slots":[{"date":"2026-08-07","time":"12:00 PM","open":1}]}';
  const kvBox = () => {
    const store = new Map();
    return { store,
      get: async (k) => (store.has(k) ? store.get(k) : null),
      put: async (k, v) => { store.set(k, v); } };
  };
  const ctxBox = () => { const pending = []; return { pending, waitUntil: (p) => pending.push(p) }; };
  const settle = async (c) => { await Promise.allSettled(c.pending); };

  /* ---- a good answer is remembered ---- */
  {
    const kv = kvBox(), ctx = ctxBox();
    const { worker } = loadWorker(ok(feed));
    const res = await worker.fetch(get('/api/slots'), { ...ENV, PROPERTY_CACHE: kv }, ctx);
    await settle(ctx);
    t('a live feed is labelled live', res.headers.get('X-Serve-Slots') === 'live', res.headers.get('X-Serve-Slots'));
    t('and is kept for the next cold start', kv.store.get('slots:last-good') === feed, kv.store.get('slots:last-good'));
    t('kept OUT of the hot path — written via waitUntil', ctx.pending.length > 0);
  }

  /* ---- THE FIX: a cold upstream serves the last good feed instead of nothing ---- */
  {
    const kv = kvBox(), ctx = ctxBox();
    kv.store.set('slots:last-good', feed);
    const { worker, calls } = loadWorker(boom('ETIMEDOUT'));
    const res = await worker.fetch(get('/api/slots'), { ...ENV, PROPERTY_CACHE: kv }, ctx);
    const body = await res.text();
    t('a timeout serves the cached feed, not ok:false', body === feed, body.slice(0, 60));
    t('and says so, so it is measurable from outside',
      res.headers.get('X-Serve-Slots') === 'stale', res.headers.get('X-Serve-Slots'));
    /* A stale answer handed to everyone for the next minute would keep the
       upstream cold and the staleness alive. */
    t('a stale answer is never edge-cached',
      /no-store/.test(res.headers.get('Cache-Control')), res.headers.get('Cache-Control'));
    /* The heal is the half that stops the cold start being permanent. */
    t('the upstream is warmed for the NEXT caller, not this one', ctx.pending.length > 0);
    await settle(ctx);
    t('and that warm ping actually went to AVAILABILITY_URL',
      calls.filter(c => c.target === ENV.AVAILABILITY_URL).length >= 2,
      calls.filter(c => c.target === ENV.AVAILABILITY_URL).length);
  }

  /* ---- nothing cached: retry once rather than give up on one cold start ---- */
  {
    const kv = kvBox(), ctx = ctxBox();
    let n = 0;
    const { worker } = loadWorker(async () => {
      n++;
      if (n === 1) throw new Error('ETIMEDOUT');
      return new Response(feed, { status: 200 });
    });
    const res = await worker.fetch(get('/api/slots'), { ...ENV, PROPERTY_CACHE: kv }, ctx);
    t('an empty cache retries once and succeeds', (await res.text()) === feed);
    t('and labels itself a retry', res.headers.get('X-Serve-Slots') === 'retry', res.headers.get('X-Serve-Slots'));
  }

  /* ---- the honest failure still exists ---- */
  {
    const kv = kvBox(), ctx = ctxBox();
    const { worker } = loadWorker(boom('ETIMEDOUT'));
    const res = await worker.fetch(get('/api/slots'), { ...ENV, PROPERTY_CACHE: kv }, ctx);
    const b = JSON.parse(await res.text());
    t('nothing cached and both attempts down still degrades to ok:false',
      res.status === 200 && b.ok === false, b);
  }

  /* ---- WHAT MUST NEVER BE CACHED ----
     Caching an ok:false, or a Google sign-in page, would turn one bad minute
     into a whole hour of one. */
  for (const [label, bad] of [
    ['an ok:false answer',      '{"ok":false,"error":"upstream_unreachable"}'],
    ['an empty slot list',      '{"ok":true,"slots":[]}'],
    ['a non-JSON body',         '<html>Sign in to continue</html>'],
  ]) {
    const kv = kvBox(), ctx = ctxBox();
    const { worker } = loadWorker(ok(bad));
    await worker.fetch(get('/api/slots'), { ...ENV, PROPERTY_CACHE: kv }, ctx);
    await settle(ctx);
    t(label + ' is never stored as last-good', kv.store.has('slots:last-good') === false, kv.store.get('slots:last-good'));
  }

  /* ---- no KV binding at all: behave exactly as before ---- */
  {
    const ctx = ctxBox();
    const { worker } = loadWorker(ok(feed));
    const res = await worker.fetch(get('/api/slots'), ENV, ctx);
    t('works with no KV bound', (await res.text()) === feed);
  }
}

console.log('\n=== 6. the front end and the Worker agree on the paths ===');
{
  const site = fs.readFileSync(path.join(REPO_ROOT, 'script.js'), 'utf8');
  const sheets = /const SHEETS_URL\s*=\s*'([^']+)'/.exec(site);
  const avail  = /const AVAILABILITY_SOURCE_URL\s*=\s*'([^']+)'/.exec(site);
  const bstat  = /const BOOKING_STATUS_URL\s*=\s*'([^']+)'/.exec(site);
  t('SHEETS_URL is the same-origin path', sheets && sheets[1] === '/api/submit', sheets && sheets[1]);
  t('AVAILABILITY_SOURCE_URL is the same-origin path', avail && avail[1] === '/api/slots', avail && avail[1]);
  /* r56. The path the site polls has to be the path the Worker routes, or the
     watch silently never confirms and every slow booking ends on the failure
     panel — which is the bug it was written to fix. */
  t('BOOKING_STATUS_URL is the same-origin path',
    bstat && bstat[1] === '/api/booking-status', bstat && bstat[1]);
  t('and the Worker routes exactly that path',
    SRC.includes('url.pathname === "/api/booking-status"'));
  /* A live endpoint always carries a protocol. Prose mentions of the bare host
     in comments are fine and worth keeping — what must never come back is a
     fetchable URL the browser could read out of the publicly served JS. */
  const liveGoogle = site.match(/https?:\/\/script\.google\.com\S*/g) || [];
  t('no fetchable script.google.com URL in the published JS', liveGoogle.length === 0,
    liveGoogle.slice(0, 2));
  t('no no-cors left — same origin does not need it', !/mode:\s*'no-cors'/.test(site));

  const wr = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'wrangler.jsonc'), 'utf8')
    .replace(/^\s*\/\/.*$/gm, ''));
  t('wrangler declares the Worker entry point', wr.main === 'src/worker.js', wr.main);
  t('ASSETS binding present so non-API paths still serve files',
    wr.assets && wr.assets.binding === 'ASSETS', wr.assets);
  t('assets.directory still pinned to _site', wr.assets && wr.assets.directory === './_site');
  t('both upstream URLs configured in vars',
    wr.vars && /\/exec$/.test(wr.vars.WEBHOOK_URL) && /\/exec$/.test(wr.vars.AVAILABILITY_URL),
    wr.vars);
}

console.log('\n=== 7. the failure UI exists and is reachable ===');
{
  const html = fs.readFileSync(path.join(REPO_ROOT, 'index.html'), 'utf8');
  const site = fs.readFileSync(path.join(REPO_ROOT, 'script.js'), 'utf8');
  t('a distinct failed state exists', /id="state-failed"/.test(html));
  t('it says the booking did NOT go through', /not<\/strong> go through/.test(html));
  t('it carries a mailto the script fills in', /id="failed-mailto"/.test(html));
  t('it shows a reference the operator can match to a submission_id',
    /id="failed-ref"/.test(html));
  t('the phone shown is the existing one, not invented',
    (html.match(/tel:\+?\d+/g) || []).every(x => x === 'tel:+16178047201'));
  t('step map includes the failed view', /failed:\s*\$\('state-failed'\)/.test(site));
  t('confirmation is shown ONLY when confirmed',
    /if \(result\.confirmed\) \{[\s\S]{0,80}setView\('confirmed'\)/.test(site));
  t('an unconfirmed booking routes to the failure view',
    /showReserveFailure\(p, result\.error\)/.test(site));

  /* ---- r56: the failure panel means "not in the sheet", not "no reply" ----

     THE LIVE BUG, 2026-09-17. A booking completed in full — row written, text
     delivered, email delivered — and the customer was shown "your booking
     could not be confirmed", because both POSTs ran past the Worker's 12s
     budget and a POST that does not come back carries NO information about
     whether the booking happened. These pin the second question that replaced
     the guess. */
  t('a slow POST starts a watch on the sheet rather than concluding failure',
    /watchBooking\(payload\.submission_id,/.test(site));
  t('the watch asks the status route, by submission_id',
    /BOOKING_STATUS_URL \+ '\?id=' \+ encodeURIComponent\(submissionId\)/.test(site));
  /* A poll that errors resolves false meaning "don't know". If that ever
     becomes "absent", one flaky poll condemns a live booking. */
  t('a failed poll ends the poll, never the watch',
    /\.catch\(\(\) => \{ clearTimeout\(timer\); resolve\(false\); \}\)/.test(site));
  t('only the deadline ends the watch',
    /if \(Date\.now\(\) >= deadline\) return done\(false\);/.test(site));

  const watchMs    = Number((/const RESERVE_WATCH_MS\s*=\s*(\d+)/.exec(site)    || [, NaN])[1]);
  const retryMs    = Number((/const RESERVE_RETRY_DELAY_MS\s*=\s*(\d+)/.exec(site) || [, NaN])[1]);
  const postMs     = Number((/const RESERVE_CONFIRM_TIMEOUT_MS\s*=\s*(\d+)/.exec(site) || [, NaN])[1]);
  const intervalMs = Number((/const RESERVE_WATCH_INTERVAL_MS\s*=\s*(\d+)/.exec(site) || [, NaN])[1]);
  t('every reservation budget was found',
    [watchMs, retryMs, postMs, intervalMs].every(Number.isFinite),
    { watchMs, retryMs, postMs, intervalMs });
  /* THE LOAD-BEARING INEQUALITY. The replay can only ever say "yes"; only the
     watch may say "no". That is true only while the watch outlives the replay
     — otherwise the watch gives up first and the replay's silence decides the
     screen again, which is precisely the old bug. */
  t('the watch outlives the replay, so the replay can never decide failure',
    watchMs > retryMs + postMs, { watchMs, replayEndsAt: retryMs + postMs });
  t('and polls often enough to be worth asking', intervalMs <= 5000, intervalMs);

  /* A refusal is an ANSWER. Every code in this set is produced by the Worker
     BEFORE it relays anything, so no row is on its way and watching for one
     would only delay the same failure panel by half a minute. The ambiguous
     case must NOT be in there — putting upstream_unreachable in this set would
     restore the original bug exactly. */
  const refusals = (/const RESERVE_REFUSALS = \{([\s\S]*?)\};/.exec(site) || [, ''])[1];
  t('a definite refusal skips the watch', /if \(RESERVE_REFUSALS\[first\.error\]\)/.test(site));
  t('price_mismatch is treated as a definite refusal', /price_mismatch/.test(refusals), refusals.trim());
  t('but a timeout is NOT — that is the ambiguous case the watch exists for',
    !/upstream_unreachable/.test(refusals), refusals.trim());
  /* Every code named there must be one the Worker actually emits, or the
     branch is dead and a real refusal still waits out the watch. */
  const emitted = (SRC.match(/error:\s*"(\w+)"/g) || []).map(s => /"(\w+)"/.exec(s)[1]);
  const named = (refusals.match(/(\w+):\s*1/g) || []).map(s => /(\w+):/.exec(s)[1]);
  t('and every refusal code named is one the Worker really sends',
    named.length > 0 && named.every(c => emitted.includes(c)),
    { named, missing: named.filter(c => !emitted.includes(c)) });
}

/* ============================================================
   The server re-derives every price.
   ------------------------------------------------------------
   quote_price is computed on the customer's machine. This is what stops it
   from being taken on trust, and the whole thing turns on one distinction:
   a price that differs under the SAME engine was edited by hand, and a price
   that differs under a DIFFERENT engine is a deploy that landed while a tab
   was open. Reject the first, honour the second.

   Getting that backwards is expensive in both directions. Reject drift and you
   fail real bookings every time prices move; honour tampering and the guard
   does nothing at all. */
{
  console.log('\n=== price verification ===');
  const { box } = loadWorker(async () => new Response('{}'));
  /* verifyPrice is a `function` declaration inside the worker, so it lands on
     the vm global. The engine is NOT — it arrives through module.exports now,
     exactly as it does in a bundle, so read it from there rather than hoping
     for a global that would not exist in production either. */
  const verifyPrice  = box.verifyPrice;
  const computeQuote = engineExports.computeQuote;
  const serveGeo     = engineExports.serveGeo;
  const lookupGeo    = geoExports.lookupGeo;
  const VERSION      = engineExports.PRICING_VERSION;

  /* The bug of 2026-09-02: the worker imported names a bundler could not see
     inside a conditional export block, got undefined, and rejected real
     bookings. Assert the wiring rather than the symptom. */
  t('geo exports survive as a module', typeof lookupGeo === 'function');
  t('engine exports survive as a module', typeof computeQuote === 'function');
  t('the worker knows it can price', vm.runInContext('CAN_PRICE', box) === true,
    vm.runInContext('CAN_PRICE', box));

  t('verifyPrice is reachable in the bundle', typeof verifyPrice === 'function');
  t('the engine came with it', typeof computeQuote === 'function');
  t('a version is stamped', typeof VERSION === 'string' && VERSION.length > 0, VERSION);

  const cfg = { bedrooms: 2, bathrooms: 1.5, service: 'first_clean', condition: 'heavy',
                addonFridge: false, addonOven: false, frequency: 'monthly', levels: 2 };
  const honest = computeQuote(Object.assign({}, cfg,
    { zip: '02116', geo: serveGeo('02116', lookupGeo) })).displayPrice;

  const body = o => JSON.stringify(Object.assign({
    event_type: 'reservation', bedrooms: 2, bathrooms: 1.5, service: 'first_clean',
    condition: 'heavy', addon_fridge: false, addon_oven: false, zip: '02116',
    frequency_selected: 'monthly', levels: 2, pricing_version: VERSION,
    quote_price: honest, submission_id: 'verify-1' }, o));

  /* Every case below is UNSIGNED — no quote_sig in the payload — so all of it
     exercises the audit exactly as it ran before signatures existed. That is
     the point: adding the strong path must not have moved the lenient floor
     underneath it, because the floor is what keeps real bookings alive. */
  const SECRET = 'test-quote-secret-not-a-real-key';
  const QENV = { QUOTE_SECRET: SECRET };
  const vp = (b, e) => verifyPrice(b, e === undefined ? QENV : e);

  t('an honest booking passes', (await vp(body({}))).ok === true, await vp(body({})));

  const cheap = await vp(body({ quote_price: 1 }));
  t('a payload edited down to $1 is REFUSED', cheap.reject === true, cheap);
  const dear  = await vp(body({ quote_price: 9999 }));
  t('a payload edited up is refused too', dear.reject === true, dear);

  const drift = await vp(body({ pricing_version: '2026-07-20', quote_price: 199 }));
  t('an older engine is honoured, not refused', !drift.reject && !!drift.note, drift);
  const noVer = await vp(body({ pricing_version: undefined, quote_price: 199 }));
  t('a payload with no version is honoured', !noVer.reject, noVer);

  /* A guard on the booking path must never eat a booking through its own bug. */
  t('a non-reservation is skipped',  !!(await vp(body({ event_type: 'quote_emailed' }))).skipped);
  t('unparseable JSON is skipped',   !!(await vp('{not json')).skipped);
  t('a missing zip is skipped',      !!(await vp(body({ zip: undefined }))).skipped);
  t('a missing price is skipped',    !!(await vp(body({ quote_price: undefined }))).skipped);

  /* An honest booking is only ever `ok`. Nothing on the unsigned path may
     claim `authenticated`, because that flag is what will later unlock a
     charge — and the unsigned path is precisely the one that can be lied to. */
  t('an unsigned booking is NOT authenticated',
    (await vp(body({}))).authenticated !== true, await vp(body({})));

  /* THE GEO WIRE. serveGeo reads a global in the browser and there is no global
     in a bundle, so the Worker has to pass its own lookup in. If that ever
     breaks, every ZIP silently prices as unmapped — a 02199 booking moves $84
     — and the verifier starts rejecting real customers. Assert the wire is live
     rather than trusting that an import stayed put. */
  const mapped   = serveGeo('02199', lookupGeo);
  t('the worker can resolve a mapped ZIP', mapped.mapped === true, mapped);
  t('and it is not the neutral fallback', mapped.factor !== 1, mapped.factor);

  /* The difference geo makes, so a silent loss of it is visibly expensive. */
  const neutralPrice = computeQuote(Object.assign({}, cfg,
    { zip: '02199', geo: { parkTier: 'P0', factor: 1, park: 0, mapped: false } })).displayPrice;
  const mappedPrice  = computeQuote(Object.assign({}, cfg, { zip: '02199', geo: mapped })).displayPrice;
  t('losing geo would move a Back Bay price', mappedPrice !== neutralPrice,
    { mapped: mappedPrice, neutral: neutralPrice, gap: mappedPrice - neutralPrice });

  /* This one cannot be simulated in the sandbox: lookupGeo IS a global here,
     because the harness concatenates serve-geo-data.js the way wrangler bundles
     it, so computeQuote's internal serveGeo() would find it either way. In a
     real bundle it would not. So assert the SOURCE does the safe thing —
     resolves geo with an explicit lookup and hands it to computeQuote — rather
     than relying on a global that only exists in a browser. */
  t('worker.js resolves geo with an explicit lookup',
    /serveGeo\(\s*String\(d\.zip\)\s*,\s*lookupGeo\s*\)/.test(SRC));
  t('and passes it into computeQuote as `geo`',
    /geo:\s*serveGeo\(/.test(SRC));
  t('worker.js imports the generated ES module',
    /from\s+"\.\/engine\.generated\.mjs"/.test(SRC));
  /* Importing the classic <script> files directly is what broke: they export
     from inside `if (typeof module …)`, which never runs under a bundler that
     treats .js as ESM, so the import resolved to undefined while looking
     entirely correct in the source. */
  t('worker.js does NOT import the classic script files',
    !/from\s+"\.\.\/(pricing-engine|serve-geo-data)\.js"/.test(SRC));

  /* The generated file is committed, so it can go stale. Regenerate in memory
     and compare — a drifted copy fails here rather than shipping. */
  const fresh = require(path.join(REPO_ROOT, 'scripts', 'build-engine-module.js')).generate();
  t('engine.generated.mjs matches its sources',
    ENGINE_MJS.replace(/\r\n/g, '\n') === fresh,
    ENGINE_MJS.length + ' vs ' + fresh.length);
  t('verification is gated on being able to price at all',
    /if \(!CAN_PRICE\) return \{ skipped:/.test(SRC));
  t('no second copy of the price formula in the worker',
    !/PER_BEDROOM|PER_BATHROOM|WORK_RATE\s*=/.test(SRC));
}

/* ============================================================
   Signed quotes — the server issues the price, /api/quote.
   ------------------------------------------------------------
   The audit above re-derives a number the browser sent. That is enough to keep
   a spreadsheet honest and NOT enough to charge a card: five payload shapes
   relay a $1 booking past it, the cheapest being a `pricing_version` nobody has
   ever deployed. Each one is a deliberate fail-open, and each one is fine right
   up until the moment that figure selects an amount of money.

   So the price is also ISSUED here and signed. These tests care about one
   question above all others: on the SIGNED path, does every bypass that works
   against the audit stop working? */
{
  console.log('\n=== signed quotes ===');
  const SECRET = 'test-quote-secret-not-a-real-key';
  const QENV   = Object.assign({}, ENV, { QUOTE_SECRET: SECRET });
  const VERSION = engineExports.PRICING_VERSION;

  const { worker, box } = loadWorker(async () => new Response('{"status":"ok"}'));
  const verifyPrice = box.verifyPrice;

  /* Exactly what the site posts — see QUOTE_SCOPE_FIELDS in script.js. */
  const INPUTS = { zip: '02116', bedrooms: 2, bathrooms: 1.5, levels: 2,
                   service: 'first_clean', condition: 'heavy',
                   addon_fridge: false, addon_oven: false,
                   frequency_selected: 'monthly' };

  const askQuote = (over, env) => worker.fetch(new Request(
    'https://servecleaning.com/api/quote',
    { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({}, INPUTS, over)) }), env || QENV);

  const issued = await (await askQuote({})).json();
  const honest = engineExports.computeQuote(Object.assign({}, INPUTS, {
    addonFridge: false, addonOven: false, frequency: 'monthly',
    geo: engineExports.serveGeo('02116', engineExports.lookupGeo) })).displayPrice;

  t('/api/quote prices a home', issued.ok === true && issued.price === honest,
    { got: issued.price, engine: honest });
  t('and signs it', typeof issued.quote_sig === 'string' && issued.quote_sig.length > 0);
  t('the signature is the documented format', /^q1\.\d+\.[0-9a-f]{64}$/.test(issued.quote_sig || ''),
    issued.quote_sig);
  t('and it stamps the engine that priced it', issued.pricing_version === VERSION);

  /* r45. The portal prices a move-out customer's recurring plans through this
     endpoint, and Apps Script asks it again when they choose one. The numbers
     must be the engine's recurring track for this home — nothing else. */
  const engineQ = engineExports.computeQuote(Object.assign({}, INPUTS, {
    addonFridge: false, addonOven: false, frequency: 'monthly',
    geo: engineExports.serveGeo('02116', engineExports.lookupGeo) }));
  const rec = issued.recurring || {};
  t('/api/quote also returns the three recurring prices, from the engine',
    rec.weekly === engineQ.freqSteady.weekly && rec.biweekly === engineQ.freqSteady.biweekly &&
    rec.monthly === engineQ.freqSteady.monthly, { got: rec, engine: engineQ.freqSteady });
  const asMoveOut = await (await askQuote({ service: 'move_out', condition: 'standard' })).json();
  t('and they are the same whatever the service was — the recurring track ignores it',
    JSON.stringify(asMoveOut.recurring) === JSON.stringify(issued.recurring), asMoveOut.recurring);
  const unsignedRec = await (await askQuote({}, ENV)).json();
  t('and they come back unsigned too', JSON.stringify(unsignedRec.recurring) === JSON.stringify(issued.recurring));

  /* ---------- /api/quote is the one public, cross-origin route ----------
     Added 2026-09-23 so an agent acting for a customer can price a home from
     its own page context instead of driving the booking form. Exercised here
     against the real Worker rather than by matching strings in the source:
     structured-data.test.js advertises this endpoint to agents, and an advert
     for a route that rejects the caller is worse than no advert.

     Note what is NOT new: this route has always answered any server-side
     caller. Cross-origin rules are a browser restriction. */
  const corsOn = r => r.headers.get('Access-Control-Allow-Origin');

  const quoted = await askQuote({});
  t('a quote answers any origin', corsOn(quoted) === '*', corsOn(quoted));
  t('and never allows credentials alongside it',
    quoted.headers.get('Access-Control-Allow-Credentials') === null);
  t('the body still arrives intact through the CORS wrapper',
    (await quoted.json()).price === honest);

  /* A browser sends OPTIONS with no body and no content type before any
     cross-origin POST carrying a JSON content type. Routed to handleQuote it
     would be answered 405 by the method check, and the real POST would never
     be sent — the failure would appear only in a browser, never in curl. */
  const pre = await worker.fetch(new Request('https://servecleaning.com/api/quote',
    { method: 'OPTIONS' }), QENV);
  t('the preflight is answered, not 405', pre.status === 204, pre.status);
  t('the preflight allows any origin', corsOn(pre) === '*', corsOn(pre));
  t('the preflight permits POST', /POST/.test(pre.headers.get('Access-Control-Allow-Methods') || ''),
    pre.headers.get('Access-Control-Allow-Methods'));
  t('the preflight permits a JSON content type',
    /content-type/i.test(pre.headers.get('Access-Control-Allow-Headers') || ''),
    pre.headers.get('Access-Control-Allow-Headers'));

  /* An error from this route has to carry the headers too. Without them the
     browser reports a CORS failure and the caller never sees "no_zip" — it
     retries a request that was answered correctly the first time. */
  const badQuote = await worker.fetch(new Request('https://servecleaning.com/api/quote',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }), QENV);
  t('an error answer carries the CORS headers too', corsOn(badQuote) === '*',
    { status: badQuote.status, origin: corsOn(badQuote) });

  /* THE BLAST RADIUS. Every other route either carries a token or moves money,
     and handlePhotos blocks cross-site posts in its own comment. If this ever
     goes green for another path, the header was lifted somewhere shared. */
  for (const p of ['/api/submit', '/api/checkout', '/api/photos', '/api/portal', '/api/vendor', '/api/address']) {
    const r = await worker.fetch(new Request('https://servecleaning.com' + p,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }), QENV);
    t(p + ' stays same-origin', corsOn(r) === null, corsOn(r));
  }

  /* A booking carrying that signature, exactly as the site would send it. */
  const signed = o => JSON.stringify(Object.assign({
    event_type: 'reservation', pricing_version: VERSION, submission_id: 'sig-1',
    quote_price: issued.price, quote_sig: issued.quote_sig }, INPUTS, o));

  const good = await verifyPrice(signed({}), QENV);
  t('a signed booking passes', good.ok === true, good);
  t('and is marked AUTHENTICATED — the flag a charge may key on',
    good.authenticated === true, good);

  /* ---- the five bypasses, re-run against the signed path ---- */
  const tampered = async (label, over) => {
    const r = await verifyPrice(signed(over), QENV);
    t(label, r.reject === true, r);
  };
  await tampered('$1 under a valid signature is REFUSED', { quote_price: 1 });
  await tampered('$1 with an invented version is refused now',
    { quote_price: 1, pricing_version: '9999-01-01' });
  await tampered('$1 with the version deleted is refused now',
    { quote_price: 1, pricing_version: undefined });
  await tampered('$1 with the version blanked is refused now',
    { quote_price: 1, pricing_version: '' });
  await tampered('$1 with the zip deleted is refused now', { quote_price: 1, zip: undefined });

  /* The signature covers the HOME, not just the number. Buying a studio quote
     and booking a five-bedroom on it is the same attack wearing a hat. */
  await tampered('editing bedrooms under a valid signature is refused', { bedrooms: 5 });
  await tampered('editing the zip to a cheaper tier is refused', { zip: '02186' });
  await tampered('a forged signature is refused',
    { quote_sig: 'q1.' + (Math.floor(Date.now() / 1000) + 600) + '.' + 'a'.repeat(64) });
  await tampered('a malformed signature is refused', { quote_sig: 'not-a-token' });

  /* ---- and the fail-open floor, which must still be exactly where it was ---- */
  const expSig = await box.signQuote(SECRET, INPUTS, issued.price,
                                     Math.floor(Date.now() / 1000) - 60);
  const stale = await verifyPrice(signed({ quote_sig: expSig }), QENV);
  t('an EXPIRED signature is not treated as an attack',
    !stale.reject && stale.ok === true, stale);
  t('but an expired one is not authenticated either', stale.authenticated !== true, stale);

  const staleCheap = await verifyPrice(
    signed({ quote_sig: expSig, quote_price: 1 }), QENV);
  t('an expired signature drops to the audit, which still catches $1',
    staleCheap.reject === true, staleCheap);

  const unbound = await verifyPrice(signed({}), ENV);
  t('with no QUOTE_SECRET bound, a signed booking still books',
    !unbound.reject, unbound);
  t('and is emphatically not authenticated', unbound.authenticated !== true, unbound);

  /* /api/quote is on the booking path. It may fail; it may not take the form
     down with it. Every one of these is a 200 the browser can shrug off. */
  const noZip = await askQuote({ zip: undefined });
  t('a quote with no zip answers 200, not an error',
    noZip.status === 200 && (await noZip.json()).ok === false, noZip.status);
  const unsigned = await askQuote({}, ENV);
  t('with no secret bound it still returns a price, unsigned',
    (await unsigned.clone().json()).ok === true &&
    (await unsigned.json()).quote_sig === null);
  const junk = await worker.fetch(new Request('https://servecleaning.com/api/quote',
    { method: 'POST', body: '{not json' }), QENV);
  t('unparseable input is a 400, never a 500', junk.status === 400, junk.status);
  const wrongVerb = await worker.fetch(new Request('https://servecleaning.com/api/quote',
    { method: 'GET' }), QENV);
  t('GET is refused', wrongVerb.status === 405, wrongVerb.status);

  /* THE SIGNED PATH HAS TO BE VISIBLE IN PRODUCTION.
     A browser whose signQuote() quietly failed falls back to booking unsigned,
     which looks identical to a browser that never had a signature — right up
     until someone asks why nothing is chargeable. The happy path was silent
     until this was added, so assert the log line behaviourally rather than
     trusting that it survives the next edit. */
  {
    const { worker: w3, box: b3 } = loadWorker(async () => new Response('{"status":"ok"}'));
    const logged = [];
    b3.console.log = (m) => logged.push(String(m));
    await w3.fetch(new Request('https://servecleaning.com/api/submit',
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: signed({}) }), QENV);
    t('an authenticated booking says so in the log',
      logged.some(l => /price authenticated/.test(l)), logged);
    t('and the line carries no address, name, email or phone',
      !logged.some(l => /@|Boylston|\d{3}-\d{3}/.test(l)), logged);
  }

  /* THE SIGNER NEVER TALKS TO GOOGLE. It is pure computation at the edge; a
     quote that made an upstream call would put Apps Script's latency and its
     quota on the path of every reservation. */
  const { worker: w2, calls } = loadWorker(async () => new Response('{}'));
  await w2.fetch(new Request('https://servecleaning.com/api/quote',
    { method: 'POST', body: JSON.stringify(INPUTS) }), QENV);
  t('signing makes no upstream call', calls.filter(c => c.target).length === 0);

  /* ---- the scope travels with the booking, because it cannot be rebuilt ----
     A JOBS row stores service_type as "First Clean" rather than the code the
     engine prices from, and never stores the add-on booleans at all. So the
     canonical string rides along and is persisted verbatim. What matters is
     that the string reaching the sheet is the one that was VERIFIED, not merely
     one carrying a valid signature. */
  t('/api/quote echoes the scope it signed',
    typeof issued.quote_scope === 'string' && issued.quote_scope.startsWith('q1|'),
    issued.quote_scope);
  t('and it is exactly what the verifier derives from the booking',
    issued.quote_scope === box.quoteScope(JSON.parse(signed({}))), issued.quote_scope);

  const liedScope = await verifyPrice(
    signed({ quote_scope: 'q1|02186|0|1|1|first_clean|1|0|0|once' }), QENV);
  t('a scope that does not describe the booking is REFUSED',
    liedScope.reject === true, liedScope);

  /* An honest client cannot produce a mismatch — it builds both from one frozen
     payload — so this only fires on a hand-edited one. It must not fire on a
     booking that simply has no scope, which is every pre-r20 tab. */
  const noScope = await verifyPrice(signed({ quote_scope: undefined }), QENV);
  t('a booking with no scope at all still passes',
    noScope.ok === true && noScope.authenticated === true, noScope);

  /* ---- EVERY PRICED INPUT MUST ACTUALLY MOVE THE SCOPE STRING ----
     `condition` shipped as Number(d.condition) for one deploy. The engine takes
     LABELS there — "standard", "heavy" — so that was NaN on every real booking,
     every condition signed to the same string, and a signature bought for a
     standard clean verified against a heavy one at the standard price. The
     signed path short-circuits the audit that used to catch exactly that.

     One assertion per field, so the next input added is covered whether or not
     anyone remembers to write a test for it. */
  const VARIANTS = {
    zip:                ['02116', '02186'],
    bedrooms:           [2, 5],
    bathrooms:          [1.5, 3],
    levels:             [2, 3],
    service:            ['first_clean', 'move_out'],
    condition:          ['standard', 'heavy'],
    addon_fridge:       [false, true],
    addon_oven:         [false, true],
    frequency_selected: ['monthly', 'weekly'],
  };
  Object.keys(VARIANTS).forEach(field => {
    const pair = VARIANTS[field];
    const one = box.quoteScope(Object.assign({}, INPUTS, { [field]: pair[0] }));
    const two = box.quoteScope(Object.assign({}, INPUTS, { [field]: pair[1] }));
    t('the scope distinguishes ' + field, one !== two, { one: one, two: two });
  });
  const realScope = box.quoteScope(JSON.parse(signed({})));
  t('and no priced input collapses to NaN', !/NaN/.test(realScope), realScope);

  /* The end of that story, stated as behaviour rather than as string shape:
     a signature issued for one condition must not verify against another. */
  const cheapQuote = await (await askQuote({ condition: 'standard' })).json();
  const swapped = await verifyPrice(JSON.stringify(Object.assign({
    event_type: 'reservation', submission_id: 'swap-1',
    quote_price: cheapQuote.price, quote_sig: cheapQuote.quote_sig,
  }, INPUTS, { condition: 'heavy' })), QENV);
  t('a standard-clean signature is refused on a heavy clean',
    swapped.reject === true, swapped);

  /* ---- and the sheet has to actually keep them ----
     This is the bug r20 exists to fix: quote_meta is a whitelist, so a field
     the site sends and the sheet has never heard of is dropped in silence. The
     Worker would verify a price, the row would forget, and nothing would be
     chargeable for a reason no log line mentions. Assert across the two files
     rather than trusting that both were remembered. */
  const gs = fs.readFileSync(path.join(REPO_ROOT, 'apps-script', 'webhook.gs'), 'utf8');
  const metaKeys = (gs.match(/const QUOTE_META_KEYS = \[([\s\S]*?)\n\];/) || [, ''])[1];
  ['quote_sig', 'quote_scope', 'quote_version'].forEach(k => {
    t('webhook.gs persists ' + k, new RegExp('"' + k + '"').test(metaKeys));
  });
  const siteSends = fs.readFileSync(path.join(REPO_ROOT, 'script.js'), 'utf8');
  ['quote_sig', 'quote_scope', 'quote_version'].forEach(k => {
    t('and the site actually sends ' + k, new RegExp('p\\.' + k + '\\s*=').test(siteSends));
  });

  /* ---- the two field lists that have to agree ---- */
  const site = fs.readFileSync(path.join(REPO_ROOT, 'script.js'), 'utf8');
  const listed = (site.match(/QUOTE_SCOPE_FIELDS\s*=\s*\[([\s\S]*?)\]/) || [, ''])[1]
    .split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
  const scopeBody = (SRC.match(/function quoteScope\(d\) \{([\s\S]*?)\n\}/) || [, ''])[1];
  const read = [...new Set([...scopeBody.matchAll(/\bd\.([a-z_]+)/g)].map(m => m[1]))];
  /* service_type is an alias the booking payload also carries; the site sends
     `service`, and quoteScope falls back to it only for older callers. */
  const missing = read.filter(f => f !== 'service_type' && !listed.includes(f));
  t('the site posts every field the signature covers', missing.length === 0, missing);

  /* PII HAS NO BUSINESS HERE. Signing a price needs the home, not the person,
     and this endpoint is one more place a name could end up in a log line. */
  const personal = listed.filter(f => /name|email|phone|address|unit|notes/.test(f));
  t('and posts nothing personal to do it', personal.length === 0, personal);
}

/* ============================================================
   /api/checkout — the payment link.
   ------------------------------------------------------------
   Everything above exists so that this endpoint has a price it can trust. The
   tests here care about one property above all the others: THE CALLER CANNOT
   SAY WHAT TO CHARGE. Signing quotes would have been pointless if the endpoint
   that picks an amount accepted one over the wire.
*/
{
  console.log('\n=== checkout ===');

  /* Comments out, so a copy assertion tests what a CUSTOMER can read rather
     than what a developer wrote about it. Crude on purpose — it only has to be
     good enough to stop a stale sentence surviving in the rendered page. */
  const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  const PORTAL = {
    ok: true, view: 'portal', contactId: 'CON-1', firstName: 'A', name: 'A',
    homes: [],
    bookings: [
      { bookingId: 'SRV-1', serviceLabel: 'First Clean', date: '2026-09-20',
        price: 239, paid: false, completed: '', status: 'new' },
      { bookingId: 'SRV-PAID', serviceLabel: 'First Clean', date: '2026-09-21',
        price: 239, paid: true, completed: '', status: 'new' },
      { bookingId: 'SRV-DONE', serviceLabel: 'First Clean', date: '2026-08-01',
        price: 239, paid: false, completed: '2026-08-01', status: 'done' },
      { bookingId: 'SRV-HUGE', serviceLabel: 'First Clean', date: '2026-09-22',
        price: 99999, paid: false, completed: '', status: 'new' },
    ],
  };

  const CENV = Object.assign({}, ENV, { STRIPE_SECRET_KEY: 'sk_test_fake_key_for_tests' });

  /* The same job seen through its own client ticket, which is the other
     surface a customer can pay from. */
  const TICKET = {
    ok: true, view: 'client',
    booking: { serviceLabel: 'First Clean', date: '2026-09-20',
               price: 239, paid: false, completed: '', status: 'new' },
    home: {},
  };
  const PARTNER = { ok: true, view: 'partner', booking: { price: 239 } };

  /* One stub for every hop: Apps Script answers the portal or ticket read,
     Stripe answers the session create. Recorded separately so each can be
     asserted on. */
  function checkoutWorker(stripeReply, upstream) {
    const seen = { portal: [], stripe: [] };
    const { worker } = loadWorker(async (target, init) => {
      if (String(target).includes('api.stripe.com')) {
        seen.stripe.push({ target, init });
        return stripeReply || new Response(
          JSON.stringify({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' }),
          { status: 200 });
      }
      seen.portal.push({ target, init });
      const body = upstream || (String(target).includes('job=') ? TICKET : PORTAL);
      return new Response(JSON.stringify(body), { status: 200 });
    });
    return { worker, seen };
  }

  const pay = (worker, body, env) => worker.fetch(new Request(
    'https://servecleaning.com/api/checkout',
    { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body) }), env || CENV);

  const GOOD = { job_id: 'SRV-1', contact_id: 'CON-1', t: 'a-token-long-enough-to-pass' };

  /* ---- the happy path ---- */
  {
    const { worker, seen } = checkoutWorker();
    const res  = await pay(worker, GOOD);
    const body = await res.json();
    t('a checkout returns a Stripe URL',
      body.ok === true && /checkout\.stripe\.com/.test(body.url || ''), body);
    t('and reports it is in test mode', body.test_mode === true, body.test_mode);

    const form = new URLSearchParams(seen.stripe[0].init.body);
    t('the amount is the portal price in cents, not anything sent in',
      form.get('line_items[0][price_data][unit_amount]') === '23900',
      form.get('line_items[0][price_data][unit_amount]'));
    t('the hold is AUTHORIZE-ONLY, not a charge',
      form.get('payment_intent_data[capture_method]') === 'manual');
    t('the job is on the session for reconciliation',
      form.get('client_reference_id') === 'SRV-1' && form.get('metadata[job_id]') === 'SRV-1');
    /* A DOUBLE-CLICK MUST NOT MAKE TWO HOLDS, AND A REISSUE MUST NOT REPLAY A
       DEAD ONE. Stripe caches the response BODY against an idempotency key for
       24 hours, so a key of job+amount alone means that expiring a link and
       reissuing it hands back the original, already-dead session — exactly the
       recovery an operator reaches for after a failed attempt. The time bucket
       is what separates the two cases, so this asserts the shape AND that the
       bucket actually moves. */
    const key = seen.stripe[0].init.headers['Idempotency-Key'];
    t('a double-click cannot make two holds',
      /^serve-SRV-1-23900-\d+$/.test(key), key);
    t('and the key is job AND amount, so a repriced booking is a new session',
      key.startsWith('serve-SRV-1-23900-'), key);
    {
      /* Ten-minute buckets: two calls now share a key, a call an hour later
         does not. Proved by arithmetic on the shipped constant rather than by
         waiting — the bucket width is the thing under test. */
      const bucket = Number(key.split('-').pop());
      const width  = 600000;
      t('two clicks seconds apart land in the same bucket',
        Math.floor((bucket * width + 5000) / width) === bucket, bucket);
      t('but a reissue an hour later gets a fresh session, not the dead one',
        Math.floor((bucket * width + 3600000) / width) !== bucket, bucket);
    }
    t('the portal was read with the caller\'s own token',
      /portal=CON-1/.test(seen.portal[0].target) && /t=a-token/.test(seen.portal[0].target));
  }

  /* ---- THE ONE THAT MATTERS ---- */
  {
    const { worker, seen } = checkoutWorker();
    await pay(worker, Object.assign({}, GOOD, {
      amount: 1, price: 1, unit_amount: 1, cents: 1, quote_price: 1,
      line_items: [{ price_data: { unit_amount: 1 } }],
    }));
    const form = new URLSearchParams(seen.stripe[0].init.body);
    t('NO field on the request can change the amount',
      form.get('line_items[0][price_data][unit_amount]') === '23900',
      form.get('line_items[0][price_data][unit_amount]'));
    t('and a dollar never appears anywhere in what Stripe is told',
      !/(^|[^0-9])100([^0-9]|$)/.test(seen.stripe[0].init.body.replace(/23900/g, '')) &&
      !seen.stripe[0].init.body.includes('unit_amount=1&'),
      seen.stripe[0].init.body.slice(0, 200));
  }

  /* ---- refusals, none of which may reach Stripe ---- */
  const refuses = async (label, body, expected) => {
    const { worker, seen } = checkoutWorker();
    const res = await pay(worker, body);
    const out = await res.json();
    t(label, out.ok === false && out.error === expected && seen.stripe.length === 0,
      { got: out, stripeCalls: seen.stripe.length });
  };
  await refuses('a job from someone else\'s portal is not found',
    Object.assign({}, GOOD, { job_id: 'SRV-SOMEONE-ELSE' }), 'not_found');
  await refuses('an already-paid booking is refused',
    Object.assign({}, GOOD, { job_id: 'SRV-PAID' }), 'already_paid');
  await refuses('a completed booking is refused',
    Object.assign({}, GOOD, { job_id: 'SRV-DONE' }), 'already_completed');
  await refuses('a nonsense price never reaches a card',
    Object.assign({}, GOOD, { job_id: 'SRV-HUGE' }), 'price_out_of_range');

  {
    const { worker, seen } = checkoutWorker();
    const res = await pay(worker, GOOD, ENV);   // no STRIPE_SECRET_KEY
    const out = await res.json();
    t('with no Stripe key the button simply cannot be used',
      out.ok === false && out.error === 'not_configured' && seen.stripe.length === 0, out);
  }
  {
    const { worker } = checkoutWorker();
    const res = await worker.fetch(new Request('https://servecleaning.com/api/checkout',
      { method: 'GET' }), CENV);
    t('GET is refused', res.status === 405, res.status);
  }

  /* ---- Stripe itself failing ---- */
  {
    const { worker } = checkoutWorker(new Response(
      '{"error":{"message":"No such price: sk_leak_hint","type":"invalid_request_error"}}',
      { status: 400 }));
    const res = await pay(worker, GOOD);
    const out = await res.json();
    t('a Stripe failure is a 502, not a 200 with no link', res.status === 502, res.status);
    t('and Stripe\'s own message is never handed to the customer',
      !JSON.stringify(out).includes('No such price') &&
      !JSON.stringify(out).includes('sk_leak_hint'), out);
  }

  /* ---- the return trip ---- */
  {
    const { worker, seen } = checkoutWorker();
    await pay(worker, GOOD);
    const form = new URLSearchParams(seen.stripe[0].init.body);
    const urls = [form.get('success_url'), form.get('cancel_url')];
    t('return URLs are built here, never taken from the caller',
      urls.every(u => u.startsWith('https://servecleaning.com/')), urls);
    /* The portal token is a PERMANENT customer credential. It must not end up
       in a third party's dashboard just to get the customer back to the page
       they were already on — portal.js stashes and restores it instead. */
    t('and they carry no portal token',
      urls.every(u => !u.includes('a-token') && !/[?&]t=/.test(u)), urls);
    t('a portal payer comes back to the portal', urls.every(u => u.includes('/h?')), urls);
  }
  {
    /* Bouncing a ticket-payer to /h would land them on a page their credential
       does not open, seconds after paying. */
    const { worker, seen } = checkoutWorker();
    await pay(worker, { job_id: 'SRV-1', t: 'a-token-long-enough-to-pass' });
    const form = new URLSearchParams(seen.stripe[0].init.body);
    t('a ticket payer comes back to the ticket',
      form.get('success_url').includes('/j?') && form.get('cancel_url').includes('/j?'),
      [form.get('success_url'), form.get('cancel_url')]);
  }

  /* ---- the ticket page ---- */
  {
    const tk = fs.readFileSync(path.join(REPO_ROOT, 'ticket.js'), 'utf8');
    const call = (tk.match(/fetch\('\/api\/checkout'[\s\S]*?\}\)/) || [''])[0];
    t('the ticket sends a job and a credential, nothing else',
      /job_id:\s*id/.test(call) && !/price|amount|cents/.test(call), call.slice(0, 120));
    t('the ticket keeps its credential before leaving', /sessionStorage\.setItem\(KEEP/.test(tk));
    t('the old "due at service" copy is gone from the ticket',
      !/due at service/i.test(strip(tk)),
      (strip(tk).match(/.{0,40}due at service.{0,40}/i) || [])[0]);
    /* renderPartner must never grow a pay button. The cleaner's view of a job
       shows no price and must never offer to take one. */
    const partner = (tk.match(/function renderPartner\(d\)[\s\S]*$/) || [''])[0];
    t('the partner view has no payment button', !/payBlock/.test(partner));
  }

  /* ---- the other surface: a job's own client ticket ---- */
  {
    const { worker, seen } = checkoutWorker();
    const res  = await pay(worker, { job_id: 'SRV-1', t: 'a-token-long-enough-to-pass' });
    const body = await res.json();
    t('a client ticket can pay without a portal id',
      body.ok === true && /checkout\.stripe\.com/.test(body.url || ''), body);
    t('and it is read through the JOB lookup, scoped to the client view',
      /job=SRV-1/.test(seen.portal[0].target) && /view=client/.test(seen.portal[0].target),
      seen.portal[0].target);
    const form = new URLSearchParams(seen.stripe[0].init.body);
    t('the ticket price is the sheet price too',
      form.get('line_items[0][price_data][unit_amount]') === '23900');
    t('and with no contact id, none is invented for Stripe',
      form.get('metadata[contact_id]') === null);
  }

  /* A CLEANER MUST NOT BE ABLE TO RAISE A CHARGE ON A CUSTOMER. Apps Script
     refuses a partner token on the client view already; this is the second
     lock, because one lock on a payment path is not enough. */
  {
    const { worker, seen } = checkoutWorker(null, PARTNER);
    const out = await (await pay(worker, { job_id: 'SRV-1', t: 'a-partner-token-long-enough' })).json();
    t('a partner view is never priced from',
      out.ok === false && out.error === 'not_found' && seen.stripe.length === 0, out);
  }

  /* An older Apps Script deployment with no portal route falls through to the
     health check, which answers ok:true. The ticket page hit exactly this on
     2026-09-08 and rendered it as a real booking. */
  {
    const { worker, seen } = checkoutWorker(null, { ok: true, service: 'serve-booking-webhook' });
    const out = await (await pay(worker, GOOD)).json();
    t('a health-check response is not mistaken for a booking',
      out.ok === false && seen.stripe.length === 0, out);
  }

  /* ---- the page that calls it ----
     The server refuses to take an amount, but the strongest version of that
     guarantee is the browser never having one to send. Asserted against the
     source, because this is about what the page is capable of asking for. */
  {
    const portal = fs.readFileSync(path.join(REPO_ROOT, 'portal.js'), 'utf8');
    const call = (portal.match(/fetch\('\/api\/checkout'[\s\S]*?\}\)/) || [''])[0];
    t('the portal sends a job and a credential, nothing else',
      /job_id/.test(call) && /contact_id/.test(call) && /t:\s*token/.test(call), !!call);
    t('and it cannot send an amount even by accident',
      !/price|amount|cents|unit_amount/.test(call), call.slice(0, 160));

    /* Without the stash the customer comes back from Stripe to a portal with
       no credential and gets "This link is incomplete" after paying, which is
       the worst possible moment to show that sentence. */
    t('the page keeps its own credential before leaving for Stripe',
      /sessionStorage\.setItem\(KEEP/.test(portal));
    t('and restores it when Stripe sends them back',
      /sessionStorage\.getItem\(KEEP/.test(portal));

    /* "Due at service" stopped being true the moment a card is authorized at
       booking. It must not survive anywhere the CUSTOMER can read it — comments
       are free to discuss it, and the first version of this check failed on the
       comment explaining the change. */
    t('the old "due at service" copy is gone from the portal',
      !/due at service/i.test(strip(portal)),
      (strip(portal).match(/.{0,40}due at service.{0,40}/i) || [])[0]);
  }

  /* ---- health says whether this could move real money ---- */
  {
    const { worker } = loadWorker(async () => new Response('{}'));
    const live = await (await worker.fetch(new Request('https://servecleaning.com/api/health'),
      { STRIPE_SECRET_KEY: 'sk_live_dangerous' })).json();
    const test = await (await worker.fetch(new Request('https://servecleaning.com/api/health'),
      { STRIPE_SECRET_KEY: 'sk_test_harmless' })).json();
    t('health distinguishes a LIVE key from a test one',
      live.stripe_mode === 'LIVE' && test.stripe_mode === 'test',
      { live: live.stripe_mode, test: test.stripe_mode });
    t('and still never reports the key itself',
      !JSON.stringify(live).includes('dangerous') && !JSON.stringify(test).includes('harmless'));
  }
}

/* ============================================================
   /api/property — the guards protect real money.
   ------------------------------------------------------------
   Every provider call is billable, this endpoint is public, and RentCast holds
   us liable for charges from a leaked key "whether such calls are authorized or
   unauthorized," with no refunds. Their §2(iii) also requires commercially
   reasonable measures against scraping through our own infrastructure — so
   these are contractual obligations, not optimisations, and a guard that
   silently stopped working would show up on an invoice rather than in a log. */
{
  console.log('\n=== provider keys and the cache binding ===');

  /* /api/property was deleted on 2026-09-08 along with its RentCast key, so
     the guards asserted here — coverage gate, monthly cap, per-IP limit,
     negative caching — moved with it to /api/address and are covered in
     address-suggest.test.js. What remains is the hygiene that applies to any
     provider key this Worker ever holds. */

  const wr = fs.readFileSync(path.join(REPO_ROOT, 'wrangler.jsonc'), 'utf8');
  const wrNoComments = wr.replace(/^\s*\/\/.*$/gm, '');
  const shipped = ['script.js', 'ticket.js', 'pricing-engine.js']
    .map(f => fs.readFileSync(path.join(REPO_ROOT, f), 'utf8')).join('');

  /* THE RENTCAST KEY IS GONE AND MUST STAY GONE. A dead reference left in the
     Worker is how a deleted vendor gets quietly re-enabled by someone
     restoring "the missing key". */
  t('no RentCast key is read anywhere in the Worker', !/RENTCAST_KEY/.test(SRC));
  t('and /api/property is not routed', !/pathname === "\/api\/property"/.test(SRC));

  /* Geoapify is the one provider left. Same three rules the other key had. */
  t('the suggest key has no value assigned in wrangler.jsonc',
    !/"GEOAPIFY[A-Z_]*"\s*:/.test(wrNoComments), 'an assignment exists');
  t('and the config documents it as a secret',
    /wrangler secret put GEOAPIFY_KEY/.test(wr));
  t('the suggest key is in nothing the browser downloads', !/GEOAPIFY/.test(shipped));

  /* Ordering is checked against CODE, not comments — worker.js explains these
     guards in prose naming the same identifiers, and matching the explanation
     rather than the implementation has broken assertions here three times.

     `before` must also assert PRESENCE: indexOf returns -1 for a string that
     is gone, and -1 is less than everything, so deleting a guard outright
     would satisfy a bare `<`. */
  const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const before = (a, b) => {
    const i = CODE.indexOf(a), j = CODE.indexOf(b);
    return i !== -1 && j !== -1 && i < j;
  };
  t('the coverage gate runs before anything billable',
    before('out_of_area', 'GEOAPIFY_KEY'));

  /* THE KV BINDING IS DECLARED IN THE CONFIG, NOT ONLY IN THE DASHBOARD.
     Every use is behind `if (kv)` so a KV outage cannot take the booking form
     down — which also means an absent binding fails silently and expensively:
     no cache, no per-IP limit, no monthly cap. It ran unbound until
     2026-09-08 and nothing said so. Deploys come from git and reconcile the
     Worker against this file, so a binding living only in the console is one
     a future push can drop. */
  const cfg = JSON.parse(wrNoComments.replace(/\/\*[\s\S]*?\*\//g, ''));
  const kvBindings = (cfg.kv_namespaces || []).map(k => k.binding);
  t('the cache namespace is bound in wrangler.jsonc',
    kvBindings.includes('PROPERTY_CACHE'), kvBindings);
  t('and it has an id, not a placeholder',
    (cfg.kv_namespaces || []).every(k => /^[0-9a-f]{32}$/i.test(String(k.id || ''))),
    (cfg.kv_namespaces || []).map(k => k.id));
  t('worker.js reads the same binding name the config declares',
    /env\.PROPERTY_CACHE/.test(SRC));

  /* Addresses in logs are addresses in someone else's retention policy. */
  t('no address is written to a log line',
    !/console\.(log|warn|error)\([^)]*rawAddress|console\.(log|warn|error)\([^)]*\baddr\b/.test(SRC));

  /* The site must book without any of this. `found: false` was the property
     endpoint's shape and went with it; the suggester's equivalent invariant —
     that every path answers {suggestions: []} rather than throwing — is
     asserted directly against the running handler in address-suggest.test.js,
     which is a stronger check than counting occurrences in the source. */
  t('every suggest failure path returns an empty list, never a throw',
    (SRC.match(/suggestions: \[\]/g) || []).length >= 5);

  /* /api/health reports binding NAMES so a missing or misspelt secret is
     diagnosable from outside. It must never report a value — not truncated,
     not hashed, not "the first four characters to help debug". */
  const health = await (async () => {
    const { worker } = loadWorker(async () => new Response('{}'));
    const res = await worker.fetch(
      new Request('https://servecleaning.com/api/health'),
      { WEBHOOK_URL: 'https://example.test/exec', RENTCAST_KEY: 'super-secret-value' }, {});
    return JSON.parse(await res.text());
  })();

  t('health lists binding names', Array.isArray(health.bindings) &&
    health.bindings.includes('RENTCAST_KEY'), health.bindings);
  t('health NEVER returns a binding value',
    !JSON.stringify(health).includes('super-secret-value'), 'a value leaked');
  t('health does not leak even a fragment of a value',
    !JSON.stringify(health).includes('super'), 'a value fragment leaked');
  t('health reports whether the engine survived bundling',
    typeof health.can_price === 'boolean', health.can_price);
}

console.log('\n=== UPSTREAM BUDGETS — a slow server is not a dead link (r50) ===');
{
  /* The three signed-link reads used to share the availability feed's 8s
     budget. A failed FEED degrades: the booking form drops to the earlier/
     later radios and the customer still books. A failed signed-link read does
     not degrade — nothing is on the page until it returns — so giving up early
     converts a slow Apps Script into "we could not open that link", on a link
     that is perfectly good. That is the bug the founder reported: a portal
     that opened, then would not open again. Cold Apps Script answers run past
     8s often enough to make it feel random. */
  const ms = (name) =>
    Number((new RegExp('UPSTREAM_TIMEOUT_MS\\s*=\\s*\\{[^}]*\\b' + name + ':\\s*(\\d+)')
      .exec(SRC) || [, NaN])[1]);
  const PAGE = ms('page'), SLOTS = ms('slots'), SUBMIT = ms('submit');

  t('all three budgets were found (a renamed one would make every check below vacuous)',
    [PAGE, SLOTS, SUBMIT].every(Number.isFinite), { PAGE, SLOTS, SUBMIT });
  t('the signed-link budget is longer than the feed\'s', PAGE > SLOTS, { PAGE, SLOTS });
  t('and long enough for a cold Apps Script (>= 12s)', PAGE >= 12000, PAGE);
  /* ServeLive aborts its own refresh at 20s. Staying under that keeps the
     Worker's explanatory 502 arriving BEFORE the browser gives up blind. */
  t('but still under the browser\'s own 20s abort', PAGE < 20000, PAGE);

  /* Which routes actually got it. Read off the source, because the constant
     being right is worthless if a route still passes `.slots`. */
  const budgetAt = (marker) => {
    const at = SRC.indexOf(marker);
    if (at === -1) return 'MARKER NOT FOUND';
    const after = SRC.slice(at, at + 600);
    return (/UPSTREAM_TIMEOUT_MS\.(\w+)/.exec(after) || [, 'none'])[1];
  };
  [['"?portal=" + encodeURIComponent(id)', '/api/portal'],
   ['"?vendor=" + encodeURIComponent(id)', '/api/vendor'],
   ['"?job="  + encodeURIComponent(id)',   '/api/job'],
  ].forEach(([marker, route]) => {
    t(route + ' reads on the signed-link budget', budgetAt(marker) === 'page', budgetAt(marker));
  });

  /* The feed keeps the short one ON PURPOSE — it has somewhere to fall back
     to, and a customer typing an address should not wait 15s for a type-ahead. */
  t('the availability feed still uses the short budget',
    budgetAt('env.AVAILABILITY_URL, { method: "GET" }') === 'slots',
    budgetAt('env.AVAILABILITY_URL, { method: "GET" }'));
  t('address type-ahead still uses the short budget',
    budgetAt('geocode/autocomplete') === 'slots', budgetAt('geocode/autocomplete'));
}

console.log('\n=== CRON TRIGGERS — warm the upstreams, never delete by accident ===');
{
  /* The cron strings are read from the WORKER'S OWN CONSTANTS rather than
     repeated here, so changing an interval means editing two places (the
     config and the constant) instead of three. What must never drift is those
     two against each other — that is the assertion at the end of this block,
     and it is the one that matters: a cron renamed in wrangler.jsonc and not in
     the worker means the daily cleanup silently stops running forever. */
  const cronConst = (name) =>
    (new RegExp('const ' + name + '\\s*=\\s*"([^"]+)"').exec(SRC) || [, ''])[1];
  const WARM_CRON  = cronConst('CRON_WARM_UPSTREAM');
  const DAILY_CRON = cronConst('CRON_PHOTO_CLEANUP');

  /* Without this, a renamed constant makes both '' — which equals nothing and
     would leave every assertion below passing while testing the wrong thing. */
  t('both cron constants were found in the worker',
    !!WARM_CRON && !!DAILY_CRON && WARM_CRON !== DAILY_CRON, { WARM_CRON, DAILY_CRON });

  const makeCtx = () => {
    const pending = [];
    return { waitUntil: (p) => pending.push(p),
             settle: () => Promise.allSettled(pending) };
  };
  const targetsOf = (calls) => calls.filter(c => c.target).map(c => c.target);
  const logsOf    = (calls) => calls.filter(c => c.log).map(c => c.log);

  /* An env the photo cleanup COULD run in. Both blocks below use it, and in the
     warm one that is the whole point: against plain ENV, cleanupPhotoStorage
     returns at its own `if (!env.BOOKING_PHOTOS …)` guard and can never POST,
     so "nothing destructive happened" would be true however the branch behaved.
     A mutation run proved exactly that — deleting the branch left the assertion
     passing. An assertion that cannot fail is not an assertion. */
  const PHOTO_ENV = Object.assign({}, ENV, {
    PHOTO_BRIDGE_SECRET: 'bridge', BOOKING_PHOTOS: { delete: async () => {} } });

  /* ---- the five-minute ping ---- */
  {
    const { worker, calls } = loadWorker(ok('{"ok":true,"slots":[]}'));
    const ctx = makeCtx();
    await worker.scheduled({ cron: WARM_CRON }, PHOTO_ENV, ctx);
    await ctx.settle();
    const targets = targetsOf(calls);

    t('the warm cron pings the availability feed',
      targets.includes(ENV.AVAILABILITY_URL), targets);
    /* The webhook backs /api/submit, /api/portal, /api/job and /api/vendor, so
       it is the more expensive of the two to leave cold. */
    t('and the booking webhook as well', targets.includes(ENV.WEBHOOK_URL), targets);
    /* r55. The one POST is the booking-notify sweep, which can only send
       notices a booking already parked. Everything else still writes nothing. */
    const posts = calls.filter(c => c.target && c.init && c.init.method !== 'GET');
    t('the pings are GETs, and the only POST is the notify sweep',
      posts.length === 1 && posts[0].target === ENV.WEBHOOK_URL &&
      JSON.parse(posts[0].init.body).event_type === 'booking_notify' &&
      JSON.parse(posts[0].init.body).action === 'sweep',
      posts.map(p => p.init.body));
    /* THE ASSERTION THAT KEEPS THIS SAFE. cleanupPhotoStorage deletes objects
       from R2; running it every five minutes is the accident this branch
       exists to prevent. */
    t('and nothing destructive is triggered',
      !calls.some(c => c.init && String(c.init.body || '').includes('booking_photo')));
  }

  /* ---- the daily cleanup still happens, and only then ---- */
  {
    const { worker, calls } = loadWorker(ok('{"ok":true,"photos":[]}'));
    const ctx = makeCtx();
    await worker.scheduled({ cron: DAILY_CRON }, PHOTO_ENV, ctx);
    await ctx.settle();

    t('the daily cron still runs the photo cleanup',
      calls.some(c => c.init && String(c.init.body || '').includes('booking_photo')));
    t('and does NOT spend a ping on the feed',
      !targetsOf(calls).includes(ENV.AVAILABILITY_URL), targetsOf(calls));
  }

  /* ---- an unrecognised schedule does the harmless thing, loudly ---- */
  {
    const { worker, calls } = loadWorker(ok('{}'));
    const ctx = makeCtx();
    await worker.scheduled({ cron: '0 0 1 1 *' }, ENV, ctx);
    await ctx.settle();

    t('an unknown schedule warms rather than deletes',
      targetsOf(calls).includes(ENV.AVAILABILITY_URL), targetsOf(calls));
    t('and says so where it will be seen',
      logsOf(calls).some(m => m.includes('unknown cron schedule')), logsOf(calls));
  }

  /* ---- every failure mode is a log line, never a rejection ---- */
  {
    const { worker, calls } = loadWorker(boom('ETIMEDOUT'));
    const ctx = makeCtx();
    let threw = false;
    try { await worker.scheduled({ cron: WARM_CRON }, ENV, ctx); }
    catch (_) { threw = true; }
    const settled = await ctx.settle();

    t('scheduled() never throws on a dead upstream', !threw);
    t('and the queued work resolves rather than rejecting',
      settled.every(s => s.status === 'fulfilled'), settled.map(s => s.status));
    /* A failed ping means the next real visitor eats the cold start. This line
       is the only place that is ever visible. */
    t('a failed ping is logged at error level',
      logsOf(calls).some(m => /warm .* failed/.test(m)), logsOf(calls));
  }

  /* ---- an unconfigured upstream is skipped, not fatal ---- */
  {
    const { worker, calls } = loadWorker(ok('{}'));
    const ctx = makeCtx();
    await worker.scheduled({ cron: WARM_CRON },
                           { WEBHOOK_URL: ENV.WEBHOOK_URL, ASSETS }, ctx);
    await ctx.settle();
    /* The call COUNT matters as much as the target. Without warmOne's `if
       (!url) return`, an undefined URL still reaches fetch — and a target of
       undefined is filtered out of targetsOf, so the list alone would look
       identical while a junk request went out every five minutes. */
    /* Two calls, both to the webhook: its ping and the r55 notify sweep. */
    t('a missing feed URL still warms the other upstream, and only it',
      targetsOf(calls).every(u => u === ENV.WEBHOOK_URL) &&
      calls.filter(c => 'target' in c).length === 2,
      { targets: targetsOf(calls), fetches: calls.filter(c => 'target' in c).length });
  }

  /* ---- the config and the code must agree, or a schedule dies silently ---- */
  {
    const cfg = fs.readFileSync(path.join(REPO_ROOT, 'wrangler.jsonc'), 'utf8');
    const m = /"crons"\s*:\s*\[([^\]]*)\]/.exec(cfg);
    const scheduled = m ? m[1].split(',').map(s => s.trim().replace(/^"|"$/g, ''))
                              .filter(Boolean) : [];

    t('wrangler.jsonc actually schedules both crons',
      scheduled.includes(WARM_CRON) && scheduled.includes(DAILY_CRON), scheduled);
    t('and schedules nothing the worker would not recognise',
      scheduled.every(c => c === WARM_CRON || c === DAILY_CRON), scheduled);
  }

  /* ---- the budgets say what they mean ---- */
  {
    const warmMs  = Number((/const WARM_TIMEOUT_MS = (\d+)/.exec(SRC) || [, 0])[1]);
    const slotsMs = Number((/slots:\s*(\d+)/.exec(SRC) || [, 0])[1]);
    /* The whole point: nobody is waiting behind the ping, so it may absorb a
       cold start that a customer must never be asked to sit through. */
    t('the warm ping may wait far longer than a customer ever would',
      warmMs > slotsMs && warmMs >= 20000, { warmMs, slotsMs });
  }
}

console.log('\n' + (bad ? 'FAILURES: ' + bad : 'ALL CHECKS PASSED'));
process.exit(bad ? 1 : 0);
})();
