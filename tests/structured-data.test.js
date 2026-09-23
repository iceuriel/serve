/* Structured data — the machine-readable copy of what Serve claims.
   ==================================================================
   Added 2026-09-23, when the site's JSON-LD went from one FAQPage block on
   /pricing to a business identity on the homepage as well.

   WHY THIS NEEDS ITS OWN FILE. Every other claim on this site is checked
   somewhere: service-catalogue.test.js holds the visible grid to
   serve-services.js, pricing-and-services.test.js holds every published price
   to the engine. JSON-LD was the one layer nothing read — and it is the layer
   that gets quoted rather than browsed. Google lifts it into an answer box,
   and an AI agent shopping for a cleaner reads it INSTEAD of the page, so a
   wrong figure or an overstated service there is delivered with more
   authority than the same mistake in visible prose, to a reader with no way
   to notice the page disagrees.

   The /pricing FAQ proved the point the day this was written: both its copies
   had been quoting four stale prices since the pricing rework, uncaught,
   because the test written for exactly that rot read the <meta> tag only.

   Three rules, in order of how badly they bite:

     1. IT MUST PARSE. A trailing comma makes the whole block invisible, and
        nothing on the page looks wrong.
     2. IT MUST NOT CLAIM A SERVICE SERVE CANNOT DELIVER. serve-services.js is
        the source of truth and says so in its own banner; five of its six
        categories are 'planned'. An agent reading makesOffer has no "Coming to
        Serve" badge to temper it with.
     3. IT MUST NOT INVENT. No rating without customers, no street address for
        a business that has no premises, no contact detail that is not already
        on the page. */

const REPO_ROOT = require('path').resolve(__dirname, '..');
const fs   = require('fs');
const path = require('path');

const read = f => fs.readFileSync(path.join(REPO_ROOT, f), 'utf8').replace(/\r\n/g, '\n');

const INDEX     = read('index.html');
const PRICING   = read('pricing.html');
const SERVICES  = read('services.html');
const WORKER    = read('src/worker.js');
const CATALOGUE = require(path.join(REPO_ROOT, 'serve-services.js'));

let bad = 0;
const t = (label, cond, extra) => {
  console.log((cond ? '  ok    ' : '  FAIL  ') + label + (extra !== undefined ? '  ->  ' + JSON.stringify(extra) : ''));
  if (!cond) bad++;
};

/* Pull every <script type="application/ld+json"> body out of a document. */
function blocksIn(doc) {
  const out = [];
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(doc)) !== null) out.push(m[1]);
  return out;
}

/* ---------- 1. every block on the site is valid JSON ---------- */
console.log('=== 1. every JSON-LD block parses ===');

const DOCS = [['index.html', INDEX], ['pricing.html', PRICING], ['services.html', SERVICES]];
const parsed = {};

DOCS.forEach(([name, doc]) => {
  const blocks = blocksIn(doc);
  parsed[name] = [];
  blocks.forEach((body, i) => {
    let obj = null, err = null;
    try { obj = JSON.parse(body); } catch (e) { err = e.message; }
    t(name + ' block ' + (i + 1) + ' is valid JSON', obj !== null, err || undefined);
    if (obj) {
      parsed[name].push(obj);
      t(name + ' block ' + (i + 1) + ' declares a schema.org context',
        obj['@context'] === 'https://schema.org', obj['@context']);
      t(name + ' block ' + (i + 1) + ' declares a @type', typeof obj['@type'] === 'string', obj['@type']);
    }
  });
});

/* ---------- 2. the homepage identifies the business ---------- */
console.log('\n=== 2. the homepage carries a business identity ===');

const BIZ_TYPES = ['LocalBusiness', 'HomeAndConstructionBusiness', 'Organization', 'ProfessionalService'];
const biz = (parsed['index.html'] || []).filter(o => BIZ_TYPES.indexOf(o['@type']) !== -1)[0] || null;

t('index.html has a business block', biz !== null,
  (parsed['index.html'] || []).map(o => o['@type']));

if (!biz) {
  console.log('\nFAILURES: ' + (bad || 1) + ' (no business block — the rest cannot run)');
  process.exit(1);
}

t('it is named Serve', biz.name === 'Serve', biz.name);
/* Must match <link rel="canonical"> or the entity splits in two. */
const canonical = (INDEX.match(/<link rel="canonical" href="([^"]*)"/) || [])[1];
t('its url matches the page canonical', biz.url === canonical, { inBlock: biz.url, canonical });
t('it carries a stable @id', typeof biz['@id'] === 'string' && biz['@id'].length > 0, biz['@id']);
t('it says where it works', !!biz.areaServed, biz.areaServed);
t('the area named is Boston',
  JSON.stringify(biz.areaServed || {}).indexOf('Boston') !== -1, biz.areaServed);

/* ---------- 3. it offers only what Serve can actually deliver ----------
   The rule serve-services.js states in its own banner, enforced here against
   the data file rather than against a list retyped into this test. */
console.log('\n=== 3. it claims no service Serve cannot deliver ===');

const offers  = [].concat(biz.makesOffer || []);
const offered = offers.map(o => ((o.itemOffered || {}).name || '')).join(' | ');

t('it makes at least one offer', offers.length > 0, offers.length);
t('every offer is a Service',
  offers.every(o => (o.itemOffered || {})['@type'] === 'Service'),
  offers.map(o => (o.itemOffered || {})['@type']));
t('every offer points somewhere real',
  offers.every(o => /^https:\/\/servecleaning\.com\//.test((o.itemOffered || {}).url || '')),
  offers.map(o => (o.itemOffered || {}).url));

const notLive = CATALOGUE.all().filter(s => s.status !== 'live');
notLive.forEach(s => {
  t('does not offer "' + s.name + '" (status: ' + s.status + ')',
    offered.toLowerCase().indexOf(s.name.toLowerCase()) === -1, offered);
});

/* The inverse, so the block cannot quietly stop mentioning the one live
   service either — an empty-but-valid catalogue would pass everything above. */
const live = CATALOGUE.live();
t('exactly one category is live today — this test assumes it', live.length === 1, live.map(s => s.id));
live.forEach(s => {
  t('the live category "' + s.name + '" IS represented',
    offers.some(o => /clean/i.test(((o.itemOffered || {}).serviceType || '') + ' ' + ((o.itemOffered || {}).name || ''))),
    offered);
});

/* ---------- 4. it invents nothing ---------- */
console.log('\n=== 4. it invents nothing ===');

/* No customers yet. A rating object here is a fabricated number in the one
   place a machine treats as authoritative — and Google penalises it besides. */
t('no aggregateRating — Serve has no customers yet', !('aggregateRating' in biz));
t('no review block, for the same reason', !('review' in biz));
/* Serve has no premises a customer visits, and the only street address within
   reach is a personal one. See the privacy constraint. */
t('no street address — areaServed is the honest shape', !('address' in biz));
/* /pricing owns every figure. A price here is a second place to go stale, and
   this page's own <meta> comment says so. */
t('no price figure on the homepage block',
  !/\$\d/.test(JSON.stringify(biz)) && !('priceRange' in biz),
  JSON.stringify(biz).match(/\$\d+/g));

/* Contact details must already be on the page — this block is a restatement
   of the markup, never a new claim. */
/* Matched against the `tel:` hrefs specifically, NOT against the digits of the
   whole document. Stripping non-digits from index.html concatenates every
   coordinate in the hero's skyline <path> into one enormous number, and a
   fabricated phone number turns up inside it by chance — a made-up
   +1-555-010-9999 passed this check when it was written that way. */
if (biz.telephone) {
  const norm   = s => s.replace(/\D/g, '').replace(/^1/, '');
  const onPage = (INDEX.match(/href="tel:([^"]+)"/g) || [])
    .map(h => norm(h.slice(10, -1)));
  t('the phone number is one the page actually links to',
    onPage.indexOf(norm(biz.telephone)) !== -1, { inBlock: biz.telephone, onPage });
}
if (biz.email) {
  t('the email appears in the page markup', INDEX.indexOf(biz.email) !== -1, biz.email);
}

/* ---------- 5. an agent can find the way to book ----------
   The one field here that exists for agents rather than for search: it names
   the entry point to the booking flow, so a reader that intends to transact
   does not have to infer it from the nav. */
console.log('\n=== 5. the booking entry point is declared ===');

const actions = [].concat(biz.potentialAction || []);
t('at least one potentialAction is declared', actions.length > 0, actions.map(a => a['@type']));
t('every action targets servecleaning.com',
  actions.every(a => /^https:\/\/servecleaning\.com\//.test((a.target || {}).urlTemplate || '')),
  actions.map(a => (a.target || {}).urlTemplate));

const reserve = actions.filter(a => a['@type'] === 'ReserveAction')[0];
t('the booking action is present', !!reserve);
if (reserve) {
  /* The anchor has to exist, or the action points at a page section that was
     renamed — a dead entry point reads as working right up until it is used. */
  const frag = (((reserve.target || {}).urlTemplate || '').split('#')[1] || '');
  t('the booking action points at a fragment', frag.length > 0, reserve.target);
  t('that fragment is a real id in index.html',
    new RegExp('id="' + frag + '"').test(INDEX), frag);
}

/* The quote API, advertised here because this is the only machine-readable
   place that can say "there is an endpoint, here is how to call it". An agent
   that finds it does in one request what it would otherwise do by driving the
   booking form — which is the whole reason Serve can be quoted by an agent
   when a cleaner who quotes by phone cannot. */
const quote = actions.filter(a => a['@type'] === 'QuoteAction')[0];
t('the quote action is present', !!quote);
if (quote) {
  const target = quote.target || {};
  /* Asserted against the ROUTE THE WORKER ACTUALLY SERVES, read from
     src/worker.js, not against a path retyped here. Advertising an endpoint
     that 404s is worse than advertising none: the agent has no way to tell a
     wrong URL from a business that cannot quote. */
  const advertised = new URL(target.urlTemplate).pathname;
  t('it advertises a route the Worker actually serves',
    WORKER.includes('url.pathname === "' + advertised + '"'), advertised);
  t('it states the HTTP method', target.httpMethod === 'POST', target.httpMethod);
  t('it states the content type', /json/.test(target.contentType || ''), target.contentType);
  /* The endpoint must accept a cross-origin call, or an agent running in a
     page context gets a CORS failure the description does not warn it about. */
  t('that route sends public CORS headers',
    /publicCors\(await handleQuote/.test(WORKER));
  t('and answers the preflight', /request\.method === "OPTIONS"\) return corsPreflight/.test(WORKER));
  /* Credentials must never be allowed alongside Allow-Origin: * — browsers
     reject the pair, and a future route with a cookie would inherit it. */
  t('it never allows credentials', !/Access-Control-Allow-Credentials/.test(WORKER));
}

console.log('\n' + (bad ? 'FAILURES: ' + bad : 'ALL CHECKS PASSED'));
process.exit(bad ? 1 : 0);
