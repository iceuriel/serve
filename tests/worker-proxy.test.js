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
    AbortController, setTimeout, clearTimeout, URL, Response, Request, Headers, JSON,
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

console.log('\n' + (bad ? 'FAILURES: ' + bad : 'ALL CHECKS PASSED'));
process.exit(bad ? 1 : 0);
})();
