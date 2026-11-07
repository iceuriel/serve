/**
 * The marketplace — src/marketplace.js, migrations/0001_marketplace.sql,
 * db/first-partners.json, and the r63 estimate handler in webhook.gs.
 *
 * D1 IS MODELLED WITH REAL SQLITE (node:sqlite), running the shipped migration
 * and the shipped seed. A hand-written fake would agree with whatever the code
 * assumed; SQLite is what D1 actually is, so a bad column name, a broken
 * upsert or a partial index that does not do what it says fails here.
 *
 * What it holds the code to, in the order of how badly each would hurt:
 *   1. Nothing internal reaches a page or the JSON — phone, email, website,
 *      notes. Founder decision 2026-11-06.
 *   2. Nothing unlisted is public, and the seed lists nobody.
 *   3. Every rendered string is escaped; every image is same-origin.
 *   4. An estimate request is saved before anyone is emailed, exactly once,
 *      and never logged with its phone number or address.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let bad = 0;
const t = (label, cond, extra) => {
  console.log((cond ? '  ok    ' : '  FAIL  ') + label + (extra !== undefined ? '  ->  ' + JSON.stringify(extra) : ''));
  if (!cond) bad++;
};

/* ---------- a D1 binding over real SQLite ---------- */
function makeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(read('migrations/0001_marketplace.sql'));
  db.exec(read('db/seed-first-partners.sql'));
  const plain = (r) => (r ? Object.assign({}, r) : null);
  const stmt = (sql, args) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => plain(db.prepare(sql).get(...(args || []))),
    all: async () => ({ results: db.prepare(sql).all(...(args || [])).map(plain) }),
    run: async () => { db.prepare(sql).run(...(args || [])); return { success: true }; },
  });
  return { raw: db, binding: { prepare: (sql) => stmt(sql, []) } };
}

function makeKV() {
  const m = new Map();
  return { get: async (k) => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, v); } };
}

/* ---------- load the module the way the Worker bundle sees it ---------- */
const MARKET_SRC = read('src/marketplace.js');
const EXPORTS = ['handleMarketplace', 'publicProvider', 'validateEstimate', 'renderDirectory',
  'renderProfile', 'esc', 'safeImagePath', 'safeHttpUrl', 'normalizePhone', 'SERVICE_TAGS', 'REGIONS'];

function loadMarket(fetchImpl, logs, cachesImpl) {
  const box = {
    caches: cachesImpl,
    console: { log: (m) => logs.push(String(m)), warn: (m) => logs.push(String(m)), error: (m) => logs.push(String(m)) },
    crypto: require('crypto').webcrypto, TextEncoder, TextDecoder, URL, URLSearchParams,
    Request, Response, Headers, AbortController, setTimeout, clearTimeout, JSON,
    fetch: fetchImpl,
  };
  box.globalThis = box;
  vm.createContext(box);
  vm.runInContext(MARKET_SRC.replace(/^export\s+/gm, '') +
    '\nglobalThis.__market = {' + EXPORTS.join(',') + '};', box);
  return box.__market;
}

/* The repo copy of the seed carries no internal fields (it is public), so the
   leak checks plant known ones — the shape the live D1 rows actually have. */
const PLANTED = { internal_phone: '(617) 555-0177', internal_email: 'owner@example.com',
  website_url: 'https://cleaning-site.example.org/about', internal_notes: 'Confirm with owner: SECRET-NOTE' };
function plantInternals(raw) {
  raw.prepare('UPDATE providers SET internal_phone = ?, internal_email = ?, website_url = ?, internal_notes = ?')
    .run(PLANTED.internal_phone, PLANTED.internal_email, PLANTED.website_url, PLANTED.internal_notes);
}

const PREVIEW = 'preview-key-0123456789abcdef';
const BRIDGE = 'bridge-secret-abcdef0123456789';
const INTERNAL_FIELDS = ['internal_phone', 'internal_email', 'website_url', 'internal_notes', 'internal_contact', 'vendor_id'];

const get = (p, headers) => new Request('https://servecleaning.com' + p, { method: 'GET', headers: headers || {} });
const postJson = (body, headers) => new Request('https://servecleaning.com/api/estimate', {
  method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json', Accept: 'application/json' }, headers || {}),
  body: JSON.stringify(body) });
const listOne = (raw, slug) => raw.prepare("UPDATE providers SET listed = 1, status = 'approved' WHERE slug = ?").run(slug);

(async function run() {

console.log('=== 1. schema and seed ===');
{
  const { raw } = makeD1();
  const counts = raw.prepare('SELECT count(*) n, sum(listed) l FROM providers').get();
  t('13 providers seeded', counts.n === 13, counts.n);
  t('the seed lists NOBODY', counts.l === 0, counts.l);
  t('every seeded provider is a prospect', raw.prepare("SELECT count(*) n FROM providers WHERE status <> 'prospect'").get().n === 0);
  raw.exec(read('db/seed-first-partners.sql'));
  t('re-running the seed duplicates nothing',
    raw.prepare('SELECT count(*) n FROM providers').get().n === 13 &&
    raw.prepare('SELECT count(*) n FROM provider_photos').get().n === 20);
  const cols = raw.prepare('PRAGMA table_info(estimate_requests)').all().map((c) => c.name);
  t('estimate_requests keeps the quoted price', ['quoted_price_cents', 'quoted_frequency', 'quoted_at'].every((c) => cols.includes(c)), cols);
  t('estimate_requests has client_ref for retries', cols.includes('client_ref'));

  const seed = JSON.parse(read('db/first-partners.json'));
  const files = [];
  seed.forEach((p) => { files.push(p.logo_path); (p.photos || []).forEach((ph) => files.push(ph.path)); });
  const missing = files.filter((f) => !fs.existsSync(path.join(ROOT, f)));
  t('every seeded logo and photo exists in the repo', missing.length === 0, missing);
  t('every seeded image is under /images/providers/', files.every((f) => f.startsWith('/images/providers/')));
  const publicText = JSON.stringify(seed.map((p) => { const c = Object.assign({}, p); delete c.internal_notes; return c; }));
  t('no ◆ confirm-marker left in any public field', !publicText.includes('◆'));
  t('no seeded rating is marked as checked (none verified yet)', seed.every((p) => !p.rating_checked_on));
  const internalInRepo = seed.filter((p) => p.internal_phone || p.internal_email || p.website_url || p.internal_notes);
  t('the PUBLIC repo seed carries no internal field', internalInRepo.length === 0, internalInRepo.map((p) => p.slug));
  t('…and no link to any company website', !/https?:\/\//.test(read('db/first-partners.json')) &&
    !/https?:\/\//.test(read('db/seed-first-partners.sql')));
}

console.log('\n=== 2. the public whitelist ===');
{
  const logs = [];
  const M = loadMarket(async () => new Response('{}'), logs);
  const { raw } = makeD1();
  plantInternals(raw);
  const row = raw.prepare("SELECT * FROM providers WHERE slug = 'roses-cleaning'").get();
  const pub = M.publicProvider(Object.assign({}, row), [], []);
  const leaked = INTERNAL_FIELDS.filter((f) => f in pub || JSON.stringify(pub).includes(String(row[f] || '\u0000')));
  t('publicProvider carries no internal field or value', leaked.length === 0, leaked);
  t('unchecked rating is not public', pub.rating === null && pub.reviewCount === null);
  const checked = M.publicProvider(Object.assign({}, row, { rating_checked_on: '2026-11-10' }), [], []);
  t('checked rating is public with its source', checked.rating === 4.7 && checked.ratingSource === 'Google');
  t('offsite logo dropped', M.safeImagePath('https://evil.example/x.png') === '');
  t('traversal dropped', M.safeImagePath('/images/../wrangler.jsonc') === '');
  t('protocol-relative dropped', M.safeImagePath('//evil.example/x.png') === '');
  t('same-origin image kept', M.safeImagePath('/images/providers/a/logo.png') === '/images/providers/a/logo.png');
  t('javascript: source url dropped', M.safeHttpUrl('javascript:alert(1)') === '');
  const hostile = M.publicProvider(Object.assign({}, row, { brand_color: 'red;background:url(x)', logo_bg: 'expression(x)' }), [], []);
  t('non-hex colours fall back', hostile.brandColor === '#1f2937' && hostile.logoBg === '#ffffff');
  const tagged = M.publicProvider(Object.assign({}, row, { service_tags: '["Recurring","<b>x</b>"]', regions: '["core","mars"]' }), [], []);
  t('unknown filter tags and regions are dropped', tagged.serviceTags.join() === 'Recurring' && tagged.regions.join() === 'core');
}

console.log('\n=== 3. rendering is escaped and leaks nothing ===');
{
  const M = loadMarket(async () => new Response('{}'), []);
  const { raw } = makeD1();
  plantInternals(raw);
  const rows = raw.prepare('SELECT * FROM providers').all();
  let leaks = [];
  for (const row of rows) {
    const html = M.renderProfile(M.publicProvider(Object.assign({}, row), [], []), { preview: true });
    if (html.replace(/\D/g, '').includes('6175550177') || html.includes('555-0177')) leaks.push(row.slug + ':phone');
    if ((html.includes('owner@example.com') || html.includes('cleaning-site.example.org'))) leaks.push(row.slug + ':email-or-website');
    if (html.includes('SECRET-NOTE')) leaks.push(row.slug + ':notes');
  }
  t('no profile renders the business phone, email, website or notes', leaks.length === 0, leaks);
  const evil = M.publicProvider({ slug: 'x', name: '<script>alert(1)</script>', tagline: '"><img src=x onerror=alert(1)>',
    about: '</p><script>bad()</script>', claims: '["<b>insured</b>"]', status: 'approved', listed: 1 }, [], []);
  const page = M.renderProfile(evil, {});
  t('profile escapes name, tagline, about and claims',
    !page.includes('<script>alert(1)') && !page.includes('<img src=x') && !page.includes('<script>bad') && !page.includes('<b>insured'));
  const dir = M.renderDirectory([evil]);
  t('directory escapes card text', !dir.includes('<script>alert(1)') && !dir.includes('<img src=x'));
  t('JSON-LD cannot close its script tag', !/<\/script>[^]*<\/script>[^]*application\/ld\+json/.test(page) &&
    !page.includes('"name":"<script>'));
  t('preview page is noindex', M.renderProfile(evil, { preview: true }).includes('<meta name="robots" content="noindex">'));
}

console.log('\n=== 4. routes: listed, unlisted, preview ===');
{
  const M = loadMarket(async () => new Response('{}'), []);
  const d1 = makeD1();
  plantInternals(d1.raw);
  const env = { MARKET_DB: d1.binding, MARKET_PREVIEW_KEY: PREVIEW };
  const u = (p) => new URL('https://servecleaning.com' + p);

  let res = await M.handleMarketplace(get('/providers'), env, null, u('/providers'));
  let html = await res.text();
  t('/providers with nobody listed still answers 200', res.status === 200);
  t('…and lists no seeded company', !html.includes("Rose&#39;s Cleaning Inc") && !html.includes('Taskforce'));

  listOne(d1.raw, 'roses-cleaning');
  res = await M.handleMarketplace(get('/providers'), env, null, u('/providers'));
  html = await res.text();
  t('a listed company appears in the directory', html.includes("Rose&#39;s Cleaning Inc"));
  t('an unlisted one still does not', !html.includes('Taskforce'));

  res = await M.handleMarketplace(get('/providers/taskforce-cleaning-services'), env, null, u('/providers/taskforce-cleaning-services'));
  t('unlisted profile is a 404 to the public', res.status === 404, res.status);
  res = await M.handleMarketplace(get('/providers/taskforce-cleaning-services?preview=wrong'), env, null,
    u('/providers/taskforce-cleaning-services?preview=wrong'));
  t('a wrong preview key is a 404 too', res.status === 404, res.status);
  res = await M.handleMarketplace(get('/providers/taskforce-cleaning-services?preview=' + PREVIEW), env, null,
    u('/providers/taskforce-cleaning-services?preview=' + PREVIEW));
  html = await res.text();
  t('the founder preview renders', res.status === 200 && html.includes('Taskforce Cleaning Services'));
  t('…marked as a preview, noindex and uncached', html.includes('This profile is not public') &&
    html.includes('noindex') && res.headers.get('Cache-Control') === 'no-store');
  const preview2 = await M.handleMarketplace(get('/providers/taskforce-cleaning-services'), { MARKET_DB: d1.binding }, null,
    u('/providers/taskforce-cleaning-services?preview='));
  t('no preview key configured means no preview', preview2.status === 404);

  res = await M.handleMarketplace(get('/providers/roses-cleaning'), env, null, u('/providers/roses-cleaning'));
  html = await res.text();
  t('a listed profile renders publicly', res.status === 200 && html.includes('Get a Free Estimate'));
  t('…with its photos from the repo', html.includes('/images/providers/roses-cleaning/photo-1.png'));
  t('…and no business phone anywhere', !html.includes('555-0177'));

  res = await M.handleMarketplace(get('/api/providers'), env, null, u('/api/providers'));
  const body = await res.json();
  t('/api/providers lists only the listed company', body.ok && body.providers.length === 1 && body.providers[0].slug === 'roses-cleaning');
  t('/api/providers carries no internal field', INTERNAL_FIELDS.every((f) => !(f in body.providers[0])) &&
    !JSON.stringify(body).includes('555-0177') && !JSON.stringify(body).includes('example.com') && !JSON.stringify(body).includes('cleaning-site.example.org') &&
    !JSON.stringify(body).includes('SECRET-NOTE'));

  res = await M.handleMarketplace(get('/providers'), {}, null, u('/providers'));
  html = await res.text();
  t('without the D1 binding the page says it is opening soon', res.status === 200 && html.includes('opening soon'));

  /* The preview directory: every draft, each linking to its own preview. */
  res = await M.handleMarketplace(get('/providers?preview=' + PREVIEW), env, null, u('/providers?preview=' + PREVIEW));
  html = await res.text();
  const cardCount = (html.match(/<article class="mk-card"/g) || []).length;
  t('the preview directory shows all 13 companies', res.status === 200 && cardCount === 13, cardCount);
  t('…badges the 12 drafts and not the listed one', (html.match(/Draft · not public/g) || []).length === 12);
  t('…links each card to its own preview', html.includes('href="/providers/taskforce-cleaning-services?preview=' + PREVIEW + '"') &&
    html.includes('href="/providers/taskforce-cleaning-services?preview=' + PREVIEW + '#estimate"'));
  t('…is noindex in the markup AND the header, and uncached',
    html.includes('<meta name="robots" content="noindex">') && (res.headers.get('X-Robots-Tag') || '').includes('noindex') &&
    res.headers.get('Cache-Control') === 'no-store');
  t('…has no canonical and no structured data', !html.includes('rel="canonical"') && !html.includes('application/ld+json'));
  t('…still carries no internal field', !html.includes('555-0177') && !html.includes('SECRET-NOTE') && !html.includes('owner@example.com'));
  res = await M.handleMarketplace(get('/providers?preview=nope'), env, null, u('/providers?preview=nope'));
  html = await res.text();
  t('a wrong key gets the public directory, drafts hidden', !html.includes('Draft · not public') && !html.includes('Taskforce'));
  res = await M.handleMarketplace(get('/providers/taskforce-cleaning-services?preview=' + PREVIEW), env, null,
    u('/providers/taskforce-cleaning-services?preview=' + PREVIEW));
  html = await res.text();
  t('a previewed profile links back to the preview directory', html.includes('href="/providers?preview=' + PREVIEW + '"'));
  res = await M.handleMarketplace(get('/providers/roses-cleaning?preview=' + PREVIEW), env, null,
    u('/providers/roses-cleaning?preview=' + PREVIEW));
  t('even a LISTED profile opened with the key is noindex and uncached',
    (await res.text()).includes('noindex') && res.headers.get('Cache-Control') === 'no-store');
}

console.log('\n=== 4b. a preview can never reach the public cache ===');
{
  /* A real-shaped edge cache: keyed on the URL, exactly as caches.default is. */
  const store = new Map();
  const fakeCaches = { default: {
    match: async (req) => { const r = store.get(req.url); return r ? r.clone() : undefined; },
    put: async (req, res) => { store.set(req.url, res.clone()); },
  } };
  const M = loadMarket(async () => new Response('{}'), [], fakeCaches);
  const d1 = makeD1();
  listOne(d1.raw, 'roses-cleaning');
  const env = { MARKET_DB: d1.binding, MARKET_PREVIEW_KEY: PREVIEW };
  const u = (p) => new URL('https://servecleaning.com' + p);

  await M.handleMarketplace(get('/providers?preview=' + PREVIEW), env, null, u('/providers?preview=' + PREVIEW));
  t('opening the preview stores nothing', store.size === 0, [...store.keys()]);
  let res = await M.handleMarketplace(get('/providers'), env, null, u('/providers'));
  let html = await res.text();
  t('the public page afterwards shows no draft', !html.includes('Draft · not public') && !html.includes('Taskforce'));
  t('…and it is the public page that got cached', store.size === 1 && store.has('https://servecleaning.com/providers'));
  res = await M.handleMarketplace(get('/providers?preview=' + PREVIEW), env, null, u('/providers?preview=' + PREVIEW));
  html = await res.text();
  t('a preview after that is not served from the public cache', html.includes('Draft · not public'));
  await M.handleMarketplace(get('/providers/taskforce-cleaning-services?preview=' + PREVIEW), env, null,
    u('/providers/taskforce-cleaning-services?preview=' + PREVIEW));
  res = await M.handleMarketplace(get('/providers/taskforce-cleaning-services'), env, null, u('/providers/taskforce-cleaning-services'));
  t('a previewed draft profile is still a 404 to the public', res.status === 404);
}

console.log('\n=== 5. POST /api/estimate ===');
{
  const logs = [];
  const notified = [];
  const M = loadMarket(async (target, init) => {
    notified.push({ target, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }, logs);
  const d1 = makeD1();
  listOne(d1.raw, 'roses-cleaning');
  const env = { MARKET_DB: d1.binding, WEBHOOK_URL: 'https://script.google.com/macros/s/W/exec', MARKET_BRIDGE_SECRET: BRIDGE };
  const call = (req, e) => M.handleMarketplace(req, e || env, null, new URL(req.url));
  const base = { provider: 'roses-cleaning', method: 'phone', phone: '(617) 555-0142', time_pref: 'later', sms_consent: 'yes',
    client_ref: 'ref-aaaaaaaa-0001' };

  let res = await call(postJson(base));
  let body = await res.json();
  t('a phone request is accepted', res.status === 200 && body.ok && /^EST-/.test(body.request_id), body);
  const row = d1.raw.prepare('SELECT * FROM estimate_requests WHERE id = ?').get(body.request_id);
  t('…saved in D1 with the normalized phone', row && row.phone_e164 === '+16175550142' && row.method === 'phone' && row.time_pref === 'later');
  t('…and a client row was created', d1.raw.prepare('SELECT count(*) n FROM clients').get().n === 1);
  t('the founder was notified with the bridge token', notified.length === 1 &&
    notified[0].body.event_type === 'estimate_request' && notified[0].body.bridge_token === BRIDGE);
  t('…and notified_at was stamped once the webhook confirmed', !!d1.raw.prepare('SELECT notified_at FROM estimate_requests WHERE id = ?').get(body.request_id).notified_at);

  res = await call(postJson(base));
  const again = await res.json();
  t('a retry with the same client_ref returns the same request', again.ok && again.request_id === body.request_id && again.duplicate === true);
  t('…and files nothing new', d1.raw.prepare('SELECT count(*) n FROM estimate_requests').get().n === 1);

  res = await call(postJson(Object.assign({}, base, { method: 'walkthrough', client_ref: 'ref-aaaaaaaa-0002',
    address: '12 Example St, Somerville MA 02143' })));
  body = await res.json();
  const walk = d1.raw.prepare('SELECT * FROM estimate_requests WHERE id = ?').get(body.request_id);
  t('a walkthrough keeps its address and ZIP', walk && walk.address.includes('Example St') && walk.zip === '02143');
  t('the same phone is one client, not two', d1.raw.prepare('SELECT count(*) n FROM clients').get().n === 1);

  res = await call(postJson(Object.assign({}, base, { method: 'walkthrough', client_ref: 'ref-aaaaaaaa-0003', address: '' })));
  t('a walkthrough without an address is refused', res.status === 400 && (await res.json()).error === 'bad_address');
  res = await call(postJson(Object.assign({}, base, { phone: '555-0142', client_ref: 'ref-aaaaaaaa-0004' })));
  t('a short phone is refused', res.status === 400 && (await res.json()).error === 'bad_phone');
  res = await call(postJson(Object.assign({}, base, { provider: 'taskforce-cleaning-services', client_ref: 'ref-aaaaaaaa-0005' })));
  t('an unlisted company cannot receive requests', res.status === 404);
  res = await call(postJson(Object.assign({}, base, { time_pref: 'midnight', client_ref: 'ref-aaaaaaaa-0006' })));
  t('an unknown time is refused', res.status === 400);

  const before = d1.raw.prepare('SELECT count(*) n FROM estimate_requests').get().n;
  res = await call(postJson(Object.assign({}, base, { website: 'http://spam', client_ref: 'ref-aaaaaaaa-0007' })));
  t('the honeypot is told ok and stores nothing', (await res.json()).ok === true &&
    d1.raw.prepare('SELECT count(*) n FROM estimate_requests').get().n === before);

  const form = new Request('https://servecleaning.com/api/estimate', { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ provider: 'roses-cleaning', method: 'phone', phone: '6175550199', time_pref: 'earlier' }).toString() });
  res = await call(form);
  const page = await res.text();
  t('a plain form POST (no JS) gets a full confirmation page', res.status === 200 && page.includes('Request sent'));

  const leakyLogs = logs.filter((l) => /555|0142|0199|Example St/.test(l));
  t('no log line carries a phone number or an address', leakyLogs.length === 0, leakyLogs);

  res = await call(postJson(base), { WEBHOOK_URL: env.WEBHOOK_URL });
  t('without D1 the endpoint refuses rather than pretending', res.status === 503 && (await res.json()).error === 'unavailable');

  const quiet = loadMarket(async () => { throw new Error('should not be called'); }, []);
  const d2 = makeD1();
  listOne(d2.raw, 'roses-cleaning');
  res = await quiet.handleMarketplace(postJson(Object.assign({}, base, { client_ref: 'ref-bbbbbbbb-0001' })),
    { MARKET_DB: d2.binding, WEBHOOK_URL: env.WEBHOOK_URL }, null, new URL('https://servecleaning.com/api/estimate'));
  body = await res.json();
  t('with no bridge secret the request is STILL saved', body.ok && !!d2.raw.prepare('SELECT id FROM estimate_requests WHERE id = ?').get(body.request_id));
  t('…and stays un-notified, which is the founder\'s to-do list',
    d2.raw.prepare('SELECT notified_at FROM estimate_requests WHERE id = ?').get(body.request_id).notified_at === '');

  const kvEnv = Object.assign({}, env, { PROPERTY_CACHE: makeKV() });
  let last;
  for (let i = 0; i < 7; i++) {
    last = await call(postJson(Object.assign({}, base, { client_ref: 'ref-cccccccc-000' + i }),
      { 'CF-Connecting-IP': '203.0.113.9' }), kvEnv);
  }
  t('the seventh request in an hour from one connection is refused', last.status === 429);
}

console.log('\n=== 6. the Worker hands over only marketplace paths ===');
{
  const SRC = read('src/worker.js');
  t('the Market import is one line, as the harnesses need', /^import \* as Market from "\.\/marketplace\.js";$/m.test(SRC));
  t('the engine import is still the first import', /^import\s*\{[\s\S]*?\}\s*from "\.\/engine\.generated\.mjs";/m.test(SRC) &&
    SRC.indexOf('engine.generated.mjs') < SRC.indexOf('./marketplace.js'));
  t('health reports the D1 binding and the notify path', SRC.includes('has_marketplace_db') && SRC.includes('can_notify_estimates'));
  const fn = SRC.slice(SRC.indexOf('function isMarketplacePath'), SRC.indexOf('function handleHealth'));
  const isMk = new Function(fn + '; return isMarketplacePath;')();
  t('/providers and /providers/x are marketplace paths', isMk('/providers') && isMk('/providers/') && isMk('/providers/roses-cleaning'));
  t('/api/estimate and /api/providers are marketplace paths', isMk('/api/estimate') && isMk('/api/providers'));
  t('/ /h /api/submit /providersx are not', !isMk('/') && !isMk('/h') && !isMk('/api/submit') && !isMk('/providersx'));
}

console.log('\n=== 7. publishing ===');
{
  const build = read('scripts/build-site.sh');
  t('build-site stages marketplace.css and marketplace-client.js', /cp marketplace\.css marketplace-client\.js "\$OUT"\//.test(build));
  t('both files exist', fs.existsSync(path.join(ROOT, 'marketplace.css')) && fs.existsSync(path.join(ROOT, 'marketplace-client.js')));
  t('images/ (and so images/providers) is staged wholesale', /cp -r images "\$OUT"\//.test(build));
}

console.log('\n=== 8. webhook r63: estimate_request ===');
{
  const GS = read('apps-script/webhook.gs');
  t('routePost routes estimate_request', /eventType === "estimate_request"\) return handleEstimateRequest\(ss, data\)/.test(GS));
  t('version stamp is r63', GS.includes('version: "2026-11-06 r63"'));
  const start = GS.indexOf('const ESTIMATE_LOG_TAB');
  const end = GS.indexOf('/* END MARKETPLACE ESTIMATE REQUESTS */');
  const chunk = GS.slice(start, end);
  t('the handler names no JOBS, LEADS or EVENTS tab', !/JOBS_TAB|LEADS_TAB|EVENTS_TAB|"JOBS"|"LEADS"|"EVENTS"/.test(chunk));
  t('it uses its own secret, not the payment or photo one',
    chunk.includes('"MARKET_BRIDGE_SECRET"') && !chunk.includes('PAYMENT_BRIDGE_SECRET') && !chunk.includes('PHOTO_BRIDGE_SECRET'));

  /* Run it. */
  const sent = [];
  const sheets = {};
  const fakeSheet = (name) => ({
    rows: [],
    appendRow(r) { this.rows.push(r.slice()); },
    setFrozenRows() {},
  });
  const ss = { getSheetByName: (n) => sheets[n] || null, insertSheet: (n) => (sheets[n] = fakeSheet(n)) };
  const box = {
    console: { log() {}, error() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k === 'MARKET_BRIDGE_SECRET' ? ' ' + BRIDGE + '\n' : null) }) },
    MailApp: { sendEmail: (to, subject, bodyText) => sent.push({ to, subject, bodyText }) },
    json: (o) => o, assertWritable: () => {}, notifyEmail: () => 'founder@example.com',
    sheetValues: (s) => s.rows,
  };
  vm.createContext(box);
  vm.runInContext(chunk + '\nthis.handleEstimateRequest = handleEstimateRequest;', box);
  const req = { request_id: 'EST-ABCDEFGH2345', provider_id: 'PRV-0001', provider_name: "Rose's Cleaning Inc",
    method: 'walkthrough', phone: '(617) 555-0142', address: '12 Example St, Somerville 02143', zip: '02143',
    time_pref: 'earlier', sms_consent: false, created_at: '2026-11-06T12:00:00Z' };
  t('a wrong token is refused', box.handleEstimateRequest(ss, { bridge_token: 'nope', request: req }).ok === false && sent.length === 0);
  let out = box.handleEstimateRequest(ss, { bridge_token: BRIDGE, request: req });
  t('the right token (pasted with whitespace) is accepted', out.ok === true);
  t('one log row, after the header', sheets.ESTIMATE_REQUESTS_LOG && sheets.ESTIMATE_REQUESTS_LOG.rows.length === 2);
  t('the founder email names the company and the method', sent.length === 1 && sent[0].subject.includes("Rose's Cleaning Inc") &&
    sent[0].subject.includes('Walkthrough'));
  t('the email says plainly not to text someone who did not consent', sent[0].bodyText.includes('do not text'));
  out = box.handleEstimateRequest(ss, { bridge_token: BRIDGE, request: req });
  t('the same request twice logs once', out.duplicate === true && sheets.ESTIMATE_REQUESTS_LOG.rows.length === 2 && sent.length === 1);
}

console.log(bad ? '\n' + bad + ' FAILED' : '\nall marketplace checks passed');
process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
