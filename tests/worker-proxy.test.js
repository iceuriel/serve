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

const runnable =
  'const __m = globalThis.__engine;\n' +
  'const computeQuote = __m.computeQuote, serveGeo = __m.serveGeo,\n' +
  '      lookupGeo = __m.lookupGeo, PRICING_VERSION = __m.PRICING_VERSION;\n' +
  SRC.replace(/^import\s*\{[\s\S]*?\}\s*from[^\n]*\n/m, '')
     .replace(/^import[^\n]*\n/gm, '')
     .replace(/export\s+default\s*\{/, 'globalThis.__worker = {');

function loadWorker(fetchImpl) {
  const calls = [];
  const box = {
    console: { log() {}, warn() {}, error(m) { calls.push({ log: String(m) }); } },
    AbortController, setTimeout, clearTimeout, URL, Response, Request, Headers, JSON,
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

console.log('\n=== 6. the front end and the Worker agree on the paths ===');
{
  const site = fs.readFileSync(path.join(REPO_ROOT, 'script.js'), 'utf8');
  const sheets = /const SHEETS_URL\s*=\s*'([^']+)'/.exec(site);
  const avail  = /const AVAILABILITY_SOURCE_URL\s*=\s*'([^']+)'/.exec(site);
  t('SHEETS_URL is the same-origin path', sheets && sheets[1] === '/api/submit', sheets && sheets[1]);
  t('AVAILABILITY_SOURCE_URL is the same-origin path', avail && avail[1] === '/api/slots', avail && avail[1]);
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

  t('an honest booking passes', verifyPrice(body({})).ok === true, verifyPrice(body({})));

  const cheap = verifyPrice(body({ quote_price: 1 }));
  t('a payload edited down to $1 is REFUSED', cheap.reject === true, cheap);
  const dear  = verifyPrice(body({ quote_price: 9999 }));
  t('a payload edited up is refused too', dear.reject === true, dear);

  const drift = verifyPrice(body({ pricing_version: '2026-07-20', quote_price: 199 }));
  t('an older engine is honoured, not refused', !drift.reject && !!drift.note, drift);
  const noVer = verifyPrice(body({ pricing_version: undefined, quote_price: 199 }));
  t('a payload with no version is honoured', !noVer.reject, noVer);

  /* A guard on the booking path must never eat a booking through its own bug. */
  t('a non-reservation is skipped',  !!verifyPrice(body({ event_type: 'quote_emailed' })).skipped);
  t('unparseable JSON is skipped',   !!verifyPrice('{not json').skipped);
  t('a missing zip is skipped',      !!verifyPrice(body({ zip: undefined })).skipped);
  t('a missing price is skipped',    !!verifyPrice(body({ quote_price: undefined })).skipped);

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

console.log('\n' + (bad ? 'FAILURES: ' + bad : 'ALL CHECKS PASSED'));
process.exit(bad ? 1 : 0);
})();
