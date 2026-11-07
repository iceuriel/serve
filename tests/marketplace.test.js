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
  db.exec('PRAGMA foreign_keys = ON');   // as D1 enforces them
  db.exec(read('migrations/0001_marketplace.sql'));
  db.exec(read('migrations/0002_neighborhoods.sql'));
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
  'renderProfile', 'renderBostonNightHero', 'esc', 'safeImagePath', 'safeHttpUrl', 'normalizePhone', 'SERVICE_TAGS', 'REGIONS'];

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
// Counts come from the seed's source, so adding a company doesn't mean editing tests.
const PARTNERS = JSON.parse(read('db/first-partners.json'));
const N_PARTNERS = PARTNERS.length;
const N_PHOTOS = PARTNERS.reduce((n, p) => n + p.photos.length, 0);
const listOne = (raw, slug) => raw.prepare("UPDATE providers SET listed = 1, status = 'approved' WHERE slug = ?").run(slug);

(async function run() {

console.log('=== 1. schema and seed ===');
{
  const { raw } = makeD1();
  const counts = raw.prepare('SELECT count(*) n, sum(listed) l FROM providers').get();
  t(N_PARTNERS + ' providers seeded (every row in first-partners.json)', N_PARTNERS >= 13 && counts.n === N_PARTNERS, counts.n);
  t('the seed lists NOBODY', counts.l === 0, counts.l);
  t('every seeded provider is a prospect', raw.prepare("SELECT count(*) n FROM providers WHERE status <> 'prospect'").get().n === 0);
  raw.exec(read('db/seed-first-partners.sql'));
  t('re-running the seed duplicates nothing',
    raw.prepare('SELECT count(*) n FROM providers').get().n === N_PARTNERS &&
    raw.prepare('SELECT count(*) n FROM provider_photos').get().n === N_PHOTOS);
  const cols = raw.prepare('PRAGMA table_info(estimate_requests)').all().map((c) => c.name);
  t('estimate_requests keeps the quoted price', ['quoted_price_cents', 'quoted_frequency', 'quoted_at'].every((c) => cols.includes(c)), cols);
  t('estimate_requests has client_ref for retries', cols.includes('client_ref'));

  /* migration 0002: where companies work */
  const popular = raw.prepare('SELECT name FROM neighborhoods WHERE popular_rank IS NOT NULL ORDER BY popular_rank').all().map((r) => r.name);
  t('the popular areas are the spec\'s twelve, in its order', popular.join() ===
    'Somerville,Cambridge,Boston,Brookline,Newton,Medford,Arlington,Quincy,Chelsea,Everett,Waltham,Melrose', popular);
  t('every neighborhood has a valid region',
    raw.prepare("SELECT count(*) n FROM neighborhoods WHERE region NOT IN ('core','north','west','south')").get().n === 0);
  t('a parent must exist (Back Bay → Boston)', raw.prepare("SELECT parent FROM neighborhoods WHERE slug = 'back-bay'").get().parent === 'boston');
  let badZip = false;
  try { raw.exec("INSERT INTO neighborhood_zips (zip, neighborhood) VALUES ('2139', 'cambridge')"); } catch (_) { badZip = true; }
  let badArea = false;
  try { raw.exec("INSERT INTO neighborhood_zips (zip, neighborhood) VALUES ('02999', 'atlantis')"); } catch (_) { badArea = true; }
  t('a ZIP must be 5 digits and point at a real neighborhood', badZip && badArea);
  const slugs = new Set(raw.prepare('SELECT slug FROM neighborhoods').all().map((r) => r.slug));
  const unknown = [];
  for (const r of raw.prepare('SELECT slug, service_areas FROM providers').all()) {
    for (const a of JSON.parse(r.service_areas)) if (!slugs.has(a) && !/^\d{5}$/.test(a)) unknown.push(r.slug + ':' + a);
  }
  t('every seeded service area is a known neighborhood', unknown.length === 0, unknown);
  t('the seed filled service_areas for every company',
    raw.prepare("SELECT count(*) n FROM providers WHERE service_areas = '[]'").get().n === 0);
  raw.exec("UPDATE providers SET service_areas = '[\"somerville\"]' WHERE slug = 'roses-cleaning'");
  raw.exec(read('db/seed-first-partners.sql'));
  t('re-running the seed never overwrites an edited service area',
    raw.prepare("SELECT service_areas FROM providers WHERE slug = 'roses-cleaning'").get().service_areas === '["somerville"]');

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
  const areaed = M.publicProvider(Object.assign({}, row, { service_areas: '["somerville","02139","\\"><b>","Back Bay"]' }), [], []);
  t('service areas keep only neighborhood slugs and ZIPs', areaed.serviceAreas.join() === 'somerville,02139', areaed.serviceAreas);
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
  const area = (dir.match(/<input[^>]*id="mk-area"[^>]*>/) || [''])[0];
  t('the home has the Area combobox', area.includes('role="combobox"') && area.includes('placeholder="Neighborhood or ZIP"') &&
    dir.includes('Find Providers'));
  t('…whose input has no name, so a ZIP never lands in a URL', area !== '' && !/\sname=/.test(area));
  const areasDir = M.renderDirectory([evil], { areas: [{ slug: 'x', name: '</script><script>alert(2)</script>', region: 'core', parent: '', rank: 1 }], zips: {} });
  t('the #mk-areas JSON cannot close its script tag', !areasDir.includes('</script><script>alert(2)'));
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
  const cardCount = (html.match(/<article class="pc"/g) || []).length;
  t('the preview directory shows all ' + N_PARTNERS + ' companies', res.status === 200 && cardCount === N_PARTNERS, cardCount);
  t('…says in its banner how many are drafts (cards carry no badge: HOME_SPEC.md §5)',
    html.includes('including ' + (N_PARTNERS - 1) + ' drafts the public cannot see') && !html.includes('Draft · not public'));
  t('…links each card to its own preview', html.includes('href="/providers/taskforce-cleaning-services?preview=' + PREVIEW + '"') &&
    html.includes('href="/providers/taskforce-cleaning-services?preview=' + PREVIEW + '#estimate"'));
  t('…is noindex in the markup AND the header, and uncached',
    html.includes('<meta name="robots" content="noindex">') && (res.headers.get('X-Robots-Tag') || '').includes('noindex') &&
    res.headers.get('Cache-Control') === 'no-store');
  t('…has no canonical and no structured data', !html.includes('rel="canonical"') && !html.includes('application/ld+json'));
  t('…still carries no internal field', !html.includes('555-0177') && !html.includes('SECRET-NOTE') && !html.includes('owner@example.com'));
  res = await M.handleMarketplace(get('/providers?preview=nope'), env, null, u('/providers?preview=nope'));
  html = await res.text();
  t('a wrong key gets the public directory, drafts hidden', !html.includes('Preview.') && !html.includes('Taskforce'));
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
  t('the public page afterwards shows no draft', !html.includes('Preview.') && !html.includes('Taskforce'));
  t('…and it is the public page that got cached', store.size === 1 && store.has('https://servecleaning.com/providers'));
  res = await M.handleMarketplace(get('/providers?preview=' + PREVIEW), env, null, u('/providers?preview=' + PREVIEW));
  html = await res.text();
  t('a preview after that is not served from the public cache', html.includes('Taskforce'));
  await M.handleMarketplace(get('/providers/taskforce-cleaning-services?preview=' + PREVIEW), env, null,
    u('/providers/taskforce-cleaning-services?preview=' + PREVIEW));
  res = await M.handleMarketplace(get('/providers/taskforce-cleaning-services'), env, null, u('/providers/taskforce-cleaning-services'));
  t('a previewed draft profile is still a 404 to the public', res.status === 404);
}

console.log('\n=== 4c. the Boston Night hero (design/serve/DESIGN.md §5) ===');
{
  const M = loadMarket(async () => new Response('{}'), []);
  const hero = (o) => M.renderBostonNightHero(o);
  const P = (name, extra) => Object.assign({ name, logo: '/images/providers/x/logo.png', logoBg: '#ffffff' }, extra);

  let h = hero({ title: 'T', partners: [] });
  t('no partners: no count line, no invented number', !/\d+ trusted local/.test(h) && !h.includes('bn-status'));
  t('…and no "now opening" unless a neighborhood is given', !h.includes('Now opening'));
  h = hero({ title: 'T', opening: 'Union Square', partners: [P('A'), P('B'), P('C')] });
  t('the count is the number of partners passed in', h.includes('3 trusted local companies in the network'));
  t('…with the neighborhood named', h.includes('Now opening in Union Square'));
  t('one logo card per partner', (h.match(/class="serve-logo-card"/g) || []).length === 3);

  h = hero({ title: '<script>x()</script>', accent: '"><b>', intro: '<i>', eyebrow: '<u>', opening: '<s>',
    partners: [P('<img src=x onerror=alert(1)>', { logo: '' })] });
  t('every text option and partner name is escaped',
    !h.includes('<script>x') && !h.includes('"><b>') && !h.includes('<i>') && !h.includes('<u>') &&
    !h.includes('<s>') && !h.includes('<img src=x'));
  t('a partner without a logo shows its name instead', h.includes('bn-logo-name') && h.includes('&lt;img src=x'));
  h = hero({ title: 'T', partners: [P('Evil', { logo: 'https://tracker.example.com/p.png', logoBg: 'red;background:url(x)' })] });
  t('an off-site logo is dropped, never loaded', !h.includes('tracker.example.com'));
  t('…and a bad background colour falls back to white', h.includes('background:#ffffff') && !h.includes('url(x)'));
  h = hero({ title: 'T', navLinks: [{ href: 'javascript:alert(1)', label: 'x' }, { href: 'https://elsewhere.example', label: 'y' },
    { href: '/providers', label: 'Find' }] });
  t('nav links must be same-site', !h.includes('javascript:') && !h.includes('elsewhere.example') && h.includes('href="/providers"'));
  t('the form slot is the caller\'s markup, unescaped', hero({ title: 'T', form: '<form data-x></form>' }).includes('<form data-x></form>'));

  /* The reference's lane math: logo i rides lane i mod 7, and the speed
     multiplier divides every crossing time. */
  const many = Array.from({ length: 8 }, (_, i) => P('Co ' + i));
  h = hero({ title: 'T', partners: many });
  const tops = [...h.matchAll(/class="serve-drift" style="top:(\d+)px/g)].map((m) => +m[1]);
  t('logos fill the seven reference lanes in order, then wrap', JSON.stringify(tops) === JSON.stringify([6, 128, 62, 236, 330, 412, 182, 6]), tops);
  const durs = (x) => [...x.matchAll(/class="serve-drift"[^>]*animation-duration:([\d.]+)s/g)].map((m) => +m[1]);
  t('speed 1 keeps the reference crossing times', durs(h)[0] === 120 && durs(h)[3] === 74, durs(h));
  t('speed 2 halves them', durs(hero({ title: 'T', partners: many, speed: 2 }))[0] === 60);
  t('a silly speed is clamped, not trusted', durs(hero({ title: 'T', partners: many, speed: 1000 }))[0] === 30 &&
    durs(hero({ title: 'T', partners: many, speed: -5 }))[0] === 120);
  t('the waitlist scene has its 46 stars, 14 ripples and 4 boats',
    (h.match(/class="serve-star"/g) || []).length === 46 && (h.match(/class="serve-wave"/g) || []).length === 14 &&
    (h.match(/class="serve-boat"/g) || []).length === 4);
  const tokens = read('design/serve/tokens.css');
  t('tokens.css stops all of that motion under prefers-reduced-motion',
    /prefers-reduced-motion[^}]*\.serve-drift[^}]*\.serve-boat[^}]*\.serve-star[^}]*\.serve-wave[^}]*animation:\s*none/.test(tokens));
  t('the build serves the tokens at /serve-tokens.css',
    read('scripts/build-site.sh').includes('cp design/serve/tokens.css "$OUT"/serve-tokens.css'));

  /* The "home" scene (HOME_SPEC.md §4): the marketplace's, with no gold. */
  h = hero({ variant: 'home', title: 'T', eyebrow: 'E', partners: many });
  const homeTops = [...h.matchAll(/class="serve-drift" style="top:(\d+)px/g)].map((m) => +m[1]);
  t('home: the reference home lanes, in order', JSON.stringify(homeTops) === JSON.stringify([4, 70, 36, 128, 186, 104, 168, 4]), homeTops);
  t('home: every lane fits the 240px band', [...h.matchAll(/top:(\d+)px;z-index[^"]*"><div class="serve-bob"[^>]*><div class="bn-lc"[^>]*style="height:(\d+)px/g)]
    .every((m) => +m[1] + +m[2] <= 240));
  t('home: 40 stars, 10 ripples, 4 boats', (h.match(/class="serve-star"/g) || []).length === 40 &&
    (h.match(/class="serve-wave"/g) || []).length === 10 && (h.match(/class="serve-boat"/g) || []).length === 4);
  t('home: no gold anywhere in the scene', !/gold|c9a96e/i.test(h));
  t('home: each sky logo carries its slug and lane for the page script',
    (h.match(/class="bn-lc" data-slug="[^"]*" data-op="[\d.]+" data-blur="[\d.]+"/g) || []).length === 8);
  t('home: one-line H1 with no italic accent, eyebrow above it',
    /<div class="bn-home__eyebrow">E<\/div>\s*<h1 id="bn-h" class="bn-home__title">T<\/h1>/.test(h) && !h.includes('class="accent"'));
  t('home: no glass card and no subheading', !h.includes('serve-glass') && !h.includes('bn-intro'));

  /* The marketplace home, from D1. */
  const d1 = makeD1();
  const env = { MARKET_DB: d1.binding, MARKET_PREVIEW_KEY: PREVIEW };
  const u = (p) => new URL('https://servecleaning.com' + p);
  let res = await M.handleMarketplace(get('/providers?preview=' + PREVIEW), env, null, u('/providers?preview=' + PREVIEW));
  let html = await res.text();
  t('/providers is the home: night "home" hero with the tokens loaded',
    html.includes('class="serve-sky bn-hero bn-hero--home"') && html.includes('href="/serve-tokens.css"'));
  t('…H1 is "Boston\'s most trusted home cleaners."', html.includes('>Boston&#39;s most trusted home cleaners.</h1>'));
  t('…one sky logo per company in D1', (html.match(/class="bn-lc"/g) || []).length === N_PARTNERS);
  t('…each logo the company\'s own file from its row', html.includes('src="/images/providers/blue-house-cleaning/logo.png"'));
  const pills = [...html.matchAll(/class="mk-pill" data-service="([^"]+)" aria-pressed="(true|false)"/g)];
  t('…Service pills in the spec order, All pressed', pills.map((m) => m[1]).join('|') ===
    'All|Recurring|Deep clean|Move in / out|Post-construction|Airbnb' && pills[0][2] === 'true' && pills.slice(1).every((m) => m[2] === 'false'));
  t('…the live count comes from the rows', html.includes(N_PARTNERS + ' trusted companies, live now') &&
    html.includes('>' + N_PARTNERS + ' trusted companies across Greater Boston</h2>'));
  t('…cards carry their service areas from D1', html.includes('data-slug="luminos-cleaning-services" data-areas="quincy braintree'));
  const blob = JSON.parse((html.match(/<script type="application\/json" id="mk-areas">([^<]*)<\/script>/) || [])[1] || '{}');
  t('…the page gets the neighborhoods and ZIPs from D1', blob.areas && blob.areas.length === 80 && blob.zips['02139'] === 'cambridge' &&
    blob.areas.filter((a) => a.rank).length === 12, blob.areas && blob.areas.length);
  t('…no gold anywhere on the page', !/c9a96e|serve-gold|serve-btn-gold/i.test(html));
  t('…no Join-the-waitlist link while /waitlist does not exist', !html.includes('Join the waitlist'));
  t('…the empty state always offers Instant Booking', /data-empty[^]*?href="\/#quote">Instant Booking/.test(html));

  /* Before migration 0002 is applied the page must still render. */
  const old = new DatabaseSync(':memory:');
  old.exec(read('migrations/0001_marketplace.sql'));
  const plain = (r) => (r ? Object.assign({}, r) : null);
  const oldBinding = { prepare: (sql) => ({ bind: () => null, first: async () => null,
    all: async () => ({ results: old.prepare(sql).all().map(plain) }) }) };
  res = await M.handleMarketplace(get('/providers?preview=' + PREVIEW), { MARKET_DB: oldBinding, MARKET_PREVIEW_KEY: PREVIEW }, null,
    u('/providers?preview=' + PREVIEW));
  html = await res.text();
  t('without migration 0002 the home still renders, with no areas', res.status === 200 && html.includes('"areas":[]'));
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
