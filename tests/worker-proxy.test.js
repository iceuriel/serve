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
   assignment. Everything else about the file executes verbatim. */
const runnable = SRC.replace(/export\s+default\s*\{/, 'globalThis.__worker = {');

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
  };
  box.globalThis = box;
  vm.createContext(box);
  vm.runInContext(runnable, box);
  return { worker: box.__worker, calls };
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
    (html.match(/tel:\+?\d+/g) || []).every(x => x === 'tel:+12062097707'));
  t('step map includes the failed view', /failed:\s*\$\('state-failed'\)/.test(site));
  t('confirmation is shown ONLY when confirmed',
    /if \(result\.confirmed\) \{[\s\S]{0,80}setView\('confirmed'\)/.test(site));
  t('an unconfirmed booking routes to the failure view',
    /showReserveFailure\(p, result\.error\)/.test(site));
}

console.log('\n' + (bad ? 'FAILURES: ' + bad : 'ALL CHECKS PASSED'));
process.exit(bad ? 1 : 0);
})();
