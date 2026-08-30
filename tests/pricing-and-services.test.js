/**
 * Published pricing and scope — /pricing, /services, and the homepage teasers.
 *
 * The point of this file is the first section. Every price on the new pages is
 * rendered by calling computeQuote — the same function behind the calculator —
 * so a published range and a quoted price cannot disagree. That only stays true
 * if nothing quietly replaces it with a literal, so this runs the REAL shared
 * module against a fake DOM and reads the numbers back out of the markup it
 * produced, then checks those numbers against computeQuote independently.
 *
 * The rest guards the things that make a new page reachable at all: the publish
 * allow-list, the sitemap, the cache headers, and a nav that is identical
 * everywhere it appears.
 */
const REPO_ROOT = require('path').resolve(__dirname, '..');
const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

/* Line endings are normalised on read. _headers is CRLF in this repo, and a
   pattern with a literal \n in the middle of it silently matches nothing —
   `^x$` under /m tolerates \r\n, but `x\n\s*y` does not. That difference
   reported a missing charset header three times over while the header was
   present and correct, which is the worst kind of test failure: one that sends
   you to edit a file that was never wrong. */
const read = f => fs.readFileSync(path.join(REPO_ROOT, f), 'utf8').replace(/\r\n/g, '\n');

const SITE     = read('script.js');
const GEO      = read('serve-geo-data.js');
const INDEX    = read('index.html');
const PRICING  = read('pricing.html');
const SERVICES = read('services.html');
const CSS      = read('style.css');
const BUILD    = read('scripts/build-site.sh');
const HEADERS  = read('_headers');
const SITEMAP  = read('sitemap.xml');

let bad = 0;
const t = (label, cond, extra) => {
  console.log((cond ? '  ok    ' : '  FAIL  ') + label + (extra !== undefined ? '  ->  ' + JSON.stringify(extra) : ''));
  if (!cond) bad++;
};

/* ============================================================
   A fake DOM, big enough to run the shared module.
   Each stub records what was written to it so the test can read the rendered
   markup back rather than trusting that a render happened.
   ============================================================ */
function makeEl(attrs) {
  return {
    attrs: attrs || {},
    innerHTML: '',
    textContent: '',
    handlers: {},
    classList: { added: [], add(c) { this.added.push(c); }, remove() {} },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
    querySelector() { return null; },
    addEventListener(evt, fn) { this.handlers[evt] = fn; },
    offsetWidth: 0,
  };
}

function runModule(opts) {
  opts = opts || {};
  const els = {
    priceRows:   makeEl(),
    teaserRows:  makeEl(),
    headline:    makeEl(),
    scopeRows:   makeEl(),
    cardRange:   makeEl({ 'data-serve-card-range': 'deep' }),
    addonFridge: makeEl({ 'data-serve-addon': 'fridge' }),
    addonOven:   makeEl({ 'data-serve-addon': 'oven' }),
    prefill:     makeEl({ 'data-beds': '2', 'data-baths': '1', 'data-service': 'deep' }),
  };

  const location = { search: opts.search || '', pathname: '/', hash: '', href: '' };

  const SINGLE = {
    '[data-serve-price-rows]':      els.priceRows,
    '[data-serve-teaser-rows]':     els.teaserRows,
    '[data-serve-headline-range]':  els.headline,
    '[data-serve-scope-rows]':      els.scopeRows,
  };
  const MANY = {
    '[data-serve-card-range]': [els.cardRange],
    '[data-serve-addon]':      [els.addonFridge, els.addonOven],
    '.serve-prefill':          [els.prefill],
    '.serve-pulse':            [],
  };

  const box = {
    console: { log() {}, warn() {}, info() {}, error() {} },
    location, URLSearchParams, setTimeout, clearTimeout,
    document: {
      querySelector:    sel => SINGLE[sel] || null,
      querySelectorAll: sel => MANY[sel] || [],
    },
    matchMedia: () => ({ matches: false }),
    addEventListener() {},
    CSS: { escape: s => s },
  };
  box.window = box;
  if (opts.withServeQuote) {
    box.ServeQuote = { applyPrefill(cfg) { box.__prefilled = cfg; } };
  }
  vm.createContext(box);

  /* Slice 1 — the pricing engine. Slice 2 — the shared module. The attribution
     code and the booking IIFE between them need a far larger DOM and are
     already covered by segment-and-skins and static-checks. */
  const engineFrom = SITE.indexOf('const WORK_RATE =');
  const engineTo   = SITE.indexOf('/* ============================================================', engineFrom);
  const moduleFrom = SITE.indexOf('   SERVE — SHARED PAGE MODULE');
  if (engineFrom === -1 || engineTo === -1 || moduleFrom === -1) {
    throw new Error('could not slice script.js — the banners moved');
  }
  const engine = SITE.slice(engineFrom, engineTo);
  const shared = SITE.slice(SITE.lastIndexOf('/*', moduleFrom));

  /* `function` declarations land on the vm global by themselves; `const` ones
     do not — they stay in the script's lexical scope. Export the handful this
     file needs to inspect rather than reaching for them and getting undefined. */
  const exports = '\n;globalThis.__serve = { PRICING, ZIP_TIERS, SERVE_RANGE_ZIP, SERVE_RANGE_GEO, SERVE_SIZES, SERVE_SCOPE };';

  /* serve-geo-data.js is a separate <script> tag in the browser, concatenated
     here because the two share one lexical scope on a real page. `withoutGeo`
     reproduces the tag being absent, which must still price every home rather
     than throwing — that is the degradation path, and it is asserted below. */
  const geo = opts.withoutGeo ? '' : GEO + '\n';

  vm.runInContext(geo + engine + '\n' + shared + exports, box);
  return { box, els, location, mod: box.__serve };
}

/* ---------- 1. published prices are computed, never written down ---------- */
console.log('=== 1. every published price comes from computeQuote ===');

const run = runModule();
const priceHtml  = run.els.priceRows.innerHTML;
const teaserHtml = run.els.teaserRows.innerHTML;

t('the /pricing table body rendered', priceHtml.length > 0);
t('the homepage teaser body rendered', teaserHtml.length > 0);

/* Five sizes x three services. */
t('/pricing renders 5 rows', (priceHtml.match(/<tr>/g) || []).length === 5);
t('/pricing renders 15 price cells', (priceHtml.match(/serve-cell__btn/g) || []).length === 15);
t('teaser renders 3 rows', (teaserHtml.match(/<tr>/g) || []).length === 3);

/* No cell may ever render $0 — a zero is what a placeholder table looks like. */
t('no $0 anywhere in either table', !/\$0\b/.test(priceHtml + teaserHtml));
t('no NaN / undefined leaked into the markup',
  !/(NaN|undefined|null)/.test(priceHtml + teaserHtml));

/**
 * The assertion that matters. Recompute a cell independently and require the
 * rendered markup to contain exactly that string. If anyone replaces the render
 * with a hardcoded table, this fails on the first PRICING change after it.
 */
const computeQuote = run.box.computeQuote;
const PRICING_OBJ  = run.mod.PRICING;

/* Reads the module's own anchor constants rather than naming a ZIP. Hardcoding
   either of them here made this silently wrong the moment the anchor moved —
   the render would use one basis and the independent recompute another, and
   with a size factor in play that is reported as a pricing bug when it is
   really a test bug. */
function expectRange(beds, baths, service) {
  const q = (condition, svc) => computeQuote({
    bedrooms: beds, bathrooms: baths, service: svc, condition: condition,
    addonFridge: false, addonOven: false, zip: run.mod.SERVE_RANGE_ZIP,
    geo: run.mod.SERVE_RANGE_GEO, frequency: 'once',
  });
  if (service === 'deep')      return [q('light', 'first_clean').displayPrice, q('heavy', 'first_clean').displayPrice];
  if (service === 'moveinout') return [q('light', 'move_out').displayPrice,    q('heavy', 'move_out').displayPrice];
  const f = q('standard', 'first_clean').freqSteady;
  return [f.weekly, f.monthly];
}

[[2, 1, 'deep'], [3, 2, 'deep'], [0, 1, 'recurring'], [2, 2, 'moveinout']].forEach(([b, ba, s]) => {
  const [lo, hi] = expectRange(b, ba, s);
  const text = '$' + lo + '–$' + hi;
  t(b + 'BR/' + ba + 'BA ' + s + ' renders ' + text, priceHtml.indexOf(text) !== -1, text);
});

t('recurring low end is the weekly rate, not the monthly one',
  expectRange(3, 2, 'recurring')[0] < expectRange(3, 2, 'recurring')[1]);

/* The published tables must be computed on a basis that adds NOTHING, on all
   three axes. Any one of them silently moves every published price on the site.
   Since 2026-08-21 the size factor and parking adder are stated outright rather
   than borrowed from whichever neighbourhood sits nearest 1.00 — no ZIP is
   exactly neutral once factors are continuous. */
t('the reference ZIP is in the CORE tier, so no $25 travel fee is hidden in the table',
  run.box.zipTier(run.mod.SERVE_RANGE_ZIP) === 'core', run.mod.SERVE_RANGE_ZIP);
const refGeo = run.mod.SERVE_RANGE_GEO;
t('the published basis applies no size factor', refGeo.factor === 1, refGeo);
t('the published basis applies no parking adder', refGeo.park === 0, refGeo);
/* The whole point of stating it explicitly: it must NOT track the anchor ZIP's
   own measured factor, which drifts every time the map is regenerated. */
t('the published basis is independent of the anchor ZIP\'s own factor — that is '
  + 'what stops a data refresh silently repricing three pages',
  run.box.serveGeo(run.mod.SERVE_RANGE_ZIP).factor !== undefined &&
  refGeo.factor === 1);

/* The headline band and the add-on prices come from the same two sources. */
t('headline band rendered a real range', /^\$\d+–\$\d+$/.test(run.els.headline.textContent),
  run.els.headline.textContent);
t('fridge add-on price comes from PRICING.ADDONS',
  run.els.addonFridge.textContent === '$' + PRICING_OBJ.ADDONS.fridge, run.els.addonFridge.textContent);
t('oven add-on price comes from PRICING.ADDONS',
  run.els.addonOven.textContent === '$' + PRICING_OBJ.ADDONS.oven, run.els.addonOven.textContent);

/* The pricing engine now spans two files. If the second one fails to load —
   a missing tag on one page, a 404, a bad deploy — the pages must still publish
   real prices rather than throwing and rendering nothing. "The booking flow
   degrades, never blocks" applies to the price tables too. */
const noGeo = runModule({ withoutGeo: true });
t('the /pricing table still renders with serve-geo-data.js absent',
  noGeo.els.priceRows.innerHTML.length > 0);
t('and still publishes real dollar amounts, not $0 or a dash',
  /\$\d+/.test(noGeo.els.priceRows.innerHTML) && !/\$0\b/.test(noGeo.els.priceRows.innerHTML));
t('and falls back to the neutral case rather than half-applying a factor',
  noGeo.box.serveGeo('02116').factor === 1 && noGeo.box.serveGeo('02116').park === 0);
/* The published tables state their basis outright, so this holds by
   construction: the geo file cannot move a published number at all. */
t('published prices are byte-identical with and without the geo file',
  noGeo.els.priceRows.innerHTML === priceHtml);

/**
 * The published ranges are computed at ONE LEVEL. Once PER_LEVEL became $191
 * (a measured +50%, up from $50) a two-storey home began quoting well outside
 * the published band — a 3BR/2BA first clean publishes $223–$322 and a
 * two-storey standard-condition one quotes $371. The pages must say so.
 *
 * This is the "published price disagrees with the quote" failure that the
 * shared-render rule exists to prevent, and rendering alone does not catch it:
 * the number is correctly computed, it just answers a different question than
 * the visitor is asking.
 */
console.log('\n=== 1b. the published ranges disclose that they are single-level ===');
const levelWords = /single[- ]level|one level|single storey|one storey/i;
t('/pricing says the ranges are for single-level homes', levelWords.test(PRICING));
t('/pricing warns that a multi-storey home costs more',
  /half again|two floors|multi-?storey|over two floors/i.test(PRICING));
t('the homepage teaser says it too', levelWords.test(INDEX));
t('/services labels its typical ranges as single-level',
  /Typical range, single level/.test(SERVICES));
/* And the reason it matters, asserted numerically so the threshold cannot
   drift back without someone noticing. */
const oneLvl = computeQuote({ bedrooms: 3, bathrooms: 2, levels: 1, service: 'first_clean',
  condition: 'heavy', addonFridge: false, addonOven: false,
  zip: run.mod.SERVE_RANGE_ZIP, geo: run.mod.SERVE_RANGE_GEO, frequency: 'once' }).displayPrice;
const twoLvl = computeQuote({ bedrooms: 3, bathrooms: 2, levels: 2, service: 'first_clean',
  condition: 'standard', addonFridge: false, addonOven: false,
  zip: run.mod.SERVE_RANGE_ZIP, geo: run.mod.SERVE_RANGE_GEO, frequency: 'once' }).displayPrice;
t('a two-storey home really does quote outside the published band — which is '
  + 'why the disclosure above is required, not decorative',
  twoLvl > oneLvl, [oneLvl, twoLvl]);

/* ---------- 2. price cells are real, reachable controls ---------- */
console.log('\n=== 2. every price cell is a keyboard-reachable button ===');
t('cells are <button>, not <div> or <a>', /<button type="button" class="serve-prefill serve-cell__btn"/.test(priceHtml));
t('every cell carries its beds/baths/service', (priceHtml.match(/data-beds="/g) || []).length === 15);
t('every cell has an aria-label naming the home and the price',
  (priceHtml.match(/aria-label="[^"]*Get an instant quote/g) || []).length === 15);
t('cells carry data-label so the table can collapse to cards on a phone',
  (priceHtml.match(/data-label="/g) || []).length === 15);
t('focus-visible styling exists for the cells', /\.serve-cell__btn:focus-visible/.test(CSS));

/* ---------- 3. prefill keeps attribution ---------- */
console.log('\n=== 3. prefill navigation preserves the src tag ===');
const tagged = runModule({ search: '?src=dh-bh-01' });
const clickHandler = tagged.els.prefill.handlers.click;
t('a click handler was bound to .serve-prefill', typeof clickHandler === 'function');
if (typeof clickHandler === 'function') {
  clickHandler({ preventDefault() {} });
  const href = tagged.location.href;
  t('navigates to the homepage quote anchor', /^\/\?.*#quote$/.test(href), href);
  t('carries the prefill config', /beds=2/.test(href) && /baths=1/.test(href) && /service=deep/.test(href), href);
  t('src survives the hop — attribution is not reset by clicking a price',
    /src=dh-bh-01/.test(href), href);
}

/* On the homepage the same element sets the calculator directly instead. */
const samePage = runModule({ withServeQuote: true });
const spHandler = samePage.els.prefill.handlers.click;
if (typeof spHandler === 'function') {
  spHandler({ preventDefault() {} });
  t('on the homepage it calls ServeQuote.applyPrefill rather than navigating',
    !!samePage.box.__prefilled && samePage.location.href === '', samePage.box.__prefilled);
}

/* ---------- 4. the scope object drives the matrix ---------- */
console.log('\n=== 4. the room-by-room matrix renders from SERVE_SCOPE ===');
const scope     = run.mod.SERVE_SCOPE;
const scopeHtml = run.els.scopeRows.innerHTML;
const taskCount = scope.reduce((n, g) => n + g.tasks.length, 0);

t('SERVE_SCOPE is exported to module scope for its other two consumers', Array.isArray(scope));
t('every group rendered', (scopeHtml.match(/serve-matrix__group/g) || []).length === scope.length);
t('every task rendered', (scopeHtml.match(/serve-matrix__task/g) || []).length === taskCount);
t('every task has a mark in all three columns',
  (scopeHtml.match(/serve-matrix__mark/g) || []).length === taskCount * 3);
t('marks carry a text label for screen readers, not just a glyph',
  (scopeHtml.match(/serve-sr/g) || []).length === taskCount * 3);

/* Coding that the site would otherwise contradict itself on. */
const find = name => {
  for (const g of scope) for (const task of g.tasks) if (task.task === name) return task;
  return null;
};
const fridge = find('Inside the fridge');
const oven   = find('Inside the oven');
const linen  = find('Linen change');

t('fridge is a paid add-on on a First Clean — the calculator sells it as one',
  fridge && fridge.deep === 2 && PRICING_OBJ.ADDONS.fridge > 0);
t('fridge is included on move-in/out — bundled into that multiplier',
  fridge && fridge.moveinout === 1);
t('oven matches fridge on both counts',
  oven && oven.deep === 2 && oven.moveinout === 1);
t('linen change is free on recurring, and not a move-in/out task',
  linen && linen.recurring === 1 && linen.moveinout === 0);
t('every mark is one of the three legal codes',
  scope.every(g => g.tasks.every(task =>
    [0, 1, 2].includes(task.deep) && [0, 1, 2].includes(task.recurring) && [0, 1, 2].includes(task.moveinout))));

/* ---------- 5. the pulse ---------- */
console.log('\n=== 5. the CTA pulse ===');
t('hero CTA pulses', /class="btn btn--primary serve-pulse"/.test(INDEX));
t('header CTA pulses', /class="nav__cta serve-pulse"/.test(INDEX));
/* Mid-flow buttons must NOT — a pulse on "See my price" reads as an error. */
['build-submit', 'to-reserve', 'reserve-submit'].forEach(id => {
  const tag = INDEX.slice(INDEX.indexOf('id="' + id + '"') - 200, INDEX.indexOf('id="' + id + '"'));
  t(id + ' does not pulse', !/serve-pulse/.test(tag));
});
t('exactly two elements pulse on the homepage', (INDEX.match(/serve-pulse/g) || []).length === 2);
t('the halo is a box-shadow, never a transform — scaling softens the label',
  /@keyframes serve-breathe-hero[\s\S]{0,400}box-shadow/.test(CSS) &&
  !/@keyframes serve-breathe-[a-z]+[\s\S]{0,400}transform:\s*scale/.test(CSS));
t('the existing button shadow is carried inside the keyframes, not dropped',
  /@keyframes serve-breathe-hero[\s\S]{0,300}inset 0 1px 0/.test(CSS));
t('it stops on hover', /\.serve-pulse:hover/.test(CSS));
t('it stops on focus', /\.serve-pulse:focus-visible/.test(CSS));
t('it retires on engagement', /\.serve-pulse\.is-retired/.test(CSS) && /function serveRetirePulse/.test(SITE));
t('the nav variant is also stopped by all three — it outweighs the bare selector',
  /\.nav__cta\.serve-pulse:hover/.test(CSS) &&
  /\.nav__cta\.serve-pulse:focus-visible/.test(CSS) &&
  /\.nav__cta\.serve-pulse\.is-retired/.test(CSS));
t('reduced motion turns it off', /prefers-reduced-motion[\s\S]{0,200}\.serve-pulse/.test(CSS));
t('quote-form interaction is what retires it',
  /quote\.addEventListener\(evt, serveRetirePulse/.test(SITE));

/* ---------- 6. nav is identical wherever it is duplicated ---------- */
console.log('\n=== 6. one nav, three files, byte-identical ===');
function navOf(html) {
  const a = html.indexOf('<nav class="nav">');
  const b = html.indexOf('</nav>', a);
  return a === -1 ? null : html.slice(a, b + 6).replace(/\r\n/g, '\n');
}
const navIndex = navOf(INDEX), navPricing = navOf(PRICING), navServices = navOf(SERVICES);
t('index.html has a nav', !!navIndex);
t('pricing.html nav is byte-identical to index.html', navPricing === navIndex);
t('services.html nav is byte-identical to index.html', navServices === navIndex);
t('index.html lists every file carrying a nav, so an edit cannot miss one',
  ['pricing.html', 'services.html', 'privacy.html', 'sms-terms.html']
    .every(f => INDEX.slice(0, INDEX.indexOf('<html')).includes(f)));
t('nav is real HTML, never injected by JS', !/innerHTML\s*=\s*[`'"]\s*<nav/.test(SITE));

['How It Works', 'Pricing', 'Services', 'Instant quote'].forEach(label =>
  t('nav offers "' + label + '" twice — desktop list and mobile drawer',
    (navIndex.match(new RegExp('>' + label + '<', 'g')) || []).length === 2));
t('Examples was removed from the nav', !/>Examples</.test(navIndex));
t('but the Serve Standard section itself is untouched and still in place',
  INDEX.includes('id="examples"') && INDEX.includes('The Serve Standard') &&
  INDEX.indexOf('id="examples"') < INDEX.indexOf('id="quote"'));

/* ---------- 7. How It Works copy ---------- */
console.log('\n=== 7. How It Works links out twice, never three times ===');
t('step 1 links "price" to /pricing',
  /<a href="\/pricing" class="serve-inline-link">price<\/a>/.test(INDEX));
t('step 2 links the service phrase to /services',
  /<a href="\/services" class="serve-inline-link">first deep clean, a recurring visit, or a move-in<\/a>/.test(INDEX));
/* Step 3 is the close. Three exits in three steps turns the funnel into a menu. */
const step3 = INDEX.slice(INDEX.indexOf('Enjoy Your Space'), INDEX.indexOf('</section>', INDEX.indexOf('Enjoy Your Space')));
t('step 3 carries no inline link', !/serve-inline-link/.test(step3));
t('the existing "see how the day runs" link survived', /href="#after-you-book"/.test(step3));

/* ---------- 8. teasers are placed where they were asked for ---------- */
console.log('\n=== 8. teaser placement ===');
const iQuote  = INDEX.indexOf('id="quote"');
const iPrice  = INDEX.indexOf('id="pricing-teaser"');
const iServ   = INDEX.indexOf('id="services-teaser"');
const iAfter  = INDEX.indexOf('id="after-you-book"');
const iStrip  = INDEX.indexOf('class="work-strip"');
t('pricing teaser sits below the booking form', iPrice > iQuote);
t('services teaser follows the pricing teaser', iServ > iPrice);
t('both sit above "After you book"', iAfter > iServ);
t('"More from recent jobs" is still last', iStrip > iAfter);
/* Comments stripped first: the "After you book" block is introduced by a
   comment that mentions `.quote-step` by name, and matching prose would report
   a problem that is not in the markup. */
const teaserMarkup = INDEX.slice(iPrice, iAfter).replace(/<!--[\s\S]*?-->/g, '');
t('teasers are siblings of #quote, not step panels', !/quote-step/.test(teaserMarkup));
t('teasers sit outside the #quote section entirely',
  iPrice > INDEX.lastIndexOf('</section>', iPrice - 1));

/* ---------- 9. a new page is only real if it is published ---------- */
console.log('\n=== 9. the new pages are actually reachable ===');
['pricing.html', 'services.html', 'sitemap.xml'].forEach(f =>
  t('build-site.sh stages ' + f, new RegExp('cp\\s+[^\\n]*\\b' + f.replace('.', '\\.') + '\\b').test(BUILD)));
['/pricing', '/services'].forEach(p => {
  t(p + ' has a cache rule', new RegExp('^' + p + '$', 'm').test(HEADERS));
  t(p + '.html has one too — the asset server resolves both',
    new RegExp('^' + p + '\\.html$', 'm').test(HEADERS));
  t(p + ' is in the sitemap', SITEMAP.includes('https://servecleaning.com' + p));
});
t('sitemap lists extensionless URLs only, never both forms for one page',
  !/\.html<\/loc>/.test(SITEMAP));
t('both pages load the shared script', /<script src="script\.js">/.test(PRICING) && /<script src="script\.js">/.test(SERVICES));

/* The geo data is a second script file, so it needs the same four things any
   published asset needs — and one more: it must load FIRST. */
t('build-site.sh stages serve-geo-data.js',
  /cp\s+[^\n]*\bserve-geo-data\.js\b/.test(BUILD));
t('serve-geo-data.js has a cache rule', /^\/serve-geo-data\.js$/m.test(HEADERS));
t('serve-geo-data.js declares a charset', /\/serve-geo-data\.js\n\s*Content-Type:[^\n]*charset=utf-8/.test(HEADERS));
[['index.html', INDEX], ['pricing.html', PRICING], ['services.html', SERVICES]].forEach(([name, doc]) => {
  const g = doc.indexOf('<script src="serve-geo-data.js">');
  const s = doc.indexOf('<script src="script.js">');
  t(name + ' loads serve-geo-data.js', g !== -1);
  t(name + ' loads it BEFORE script.js — classic scripts run in tag order',
    g !== -1 && s !== -1 && g < s);
});
/* It is a classic script, not a module: the site has no build step and no
   module loader, so an `export` would be a syntax error that takes the whole
   file down and with it every price on the page. */
t('serve-geo-data.js uses no ES module syntax',
  !/^\s*export\s/m.test(GEO) && !/^\s*import\s/m.test(GEO));
t('both pages load the shared stylesheet',
  /href="style\.css"/.test(PRICING) && /href="style\.css"/.test(SERVICES));
t('no page-scoped <style> or <script> blocks — shared files only',
  !/<style/.test(PRICING + SERVICES) &&
  !/<script(?![^>]*src=)(?![^>]*application\/ld\+json)/.test(PRICING + SERVICES));

/* ---------- 10. SEO and legal surfaces ---------- */
console.log('\n=== 10. SEO, and the A2P surface that must not regress ===');
t('/pricing targets the Boston cost query', /<title>House Cleaning Prices in Boston/.test(PRICING));
t('/pricing meta description carries an actual price',
  /<meta name="description"[^>]*\$\d+/.test(PRICING));
t('/services names all three services in its description',
  /<meta name="description"[^>]*[Rr]ecurring/.test(SERVICES) &&
  /<meta name="description"[^>]*[Mm]ove-in/.test(SERVICES));
[['pricing.html', PRICING], ['services.html', SERVICES]].forEach(([name, doc]) => {
  t(name + ' has exactly one <h1>', (doc.match(/<h1/g) || []).length === 1);
  t(name + ' has a canonical URL', /<link rel="canonical"/.test(doc));
  /* Required on every page for A2P 10DLC — carriers re-check these. */
  t(name + ' carries the privacy and SMS links in its footer',
    /href="\/privacy"/.test(doc) && /href="\/sms-terms"/.test(doc));
  t(name + ' uses the published contact details and no others',
    doc.includes('management@servecos.com') && doc.includes('+16178047201'));
  t(name + ' has a sticky CTA back to the quote flow', /serve-sticky-cta[\s\S]*href="\/#quote"/.test(doc));
});
t('/pricing publishes FAQPage structured data', /"@type":\s*"FAQPage"/.test(PRICING));

/* Structured data that disagrees with the visible page is a markup violation,
   so every JSON-LD question must actually appear in the rendered FAQ. */
const ld = JSON.parse(PRICING.slice(PRICING.indexOf('{', PRICING.indexOf('application/ld+json')),
                                    PRICING.indexOf('</script>', PRICING.indexOf('application/ld+json'))).trim());
t('JSON-LD carries five questions', ld.mainEntity.length === 5);
const visibleFaq = PRICING.slice(PRICING.indexOf('class="serve-faq"'));
t('every JSON-LD question is visible on the page',
  ld.mainEntity.every(q => visibleFaq.includes(q.name)),
  ld.mainEntity.filter(q => !visibleFaq.includes(q.name)).map(q => q.name));

/* ---------- 11. responsive and namespacing floor ---------- */
console.log('\n=== 11. quality floor ===');
t('price tables collapse to cards below 640px', /@media \(max-width: 639px\)[\s\S]{0,600}\.serve-table thead \{\s*display: none/.test(CSS));
t('a 380px phone is handled explicitly', /@media \(max-width: 400px\)/.test(CSS));
t('anchor targets clear the sticky header', /\[id\]\s*\{\s*scroll-margin-top:\s*80px/.test(CSS));
t('the arrival cue respects reduced motion', /prefers-reduced-motion[\s\S]{0,160}\.serve-arrive/.test(CSS));
/**
 * Namespacing, stated as the rule that actually matters: the new block may not
 * INTRODUCE a class outside the serve-* namespace. Combining with an existing
 * one (`.nav__cta.serve-pulse`, `.serve-sticky-cta .btn`) is the correct way to
 * extend a component and must stay allowed — what would be wrong is a new bare
 * `.card` or `.table` colliding with something already in the file.
 */
/* Anchor on the banner comment's OPENING, not on its text — slicing from the
   text leaves a comment with no `/*` for the stripper to match, and the prose
   inside it then reads as a wall of undeclared class names. */
const bannerAt   = CSS.indexOf('SERVE — PRICING & SERVICES');
const newBlockAt = bannerAt === -1 ? -1 : CSS.lastIndexOf('/*', bannerAt);
t('the new stylesheet block is present', newBlockAt !== -1);
/* Comments are stripped before matching. Both halves of the file discuss class
   names in prose — this very block names `.card` as the kind of collision it
   exists to prevent — and reading those back as declarations reports the
   documentation rather than the code. */
const strip     = css => css.replace(/\/\*[\s\S]*?\*\//g, '');
const oldCss    = strip(CSS.slice(0, newBlockAt));
const newCss    = strip(CSS.slice(newBlockAt));
const classesIn = css => new Set((css.match(/\.[A-Za-z_][A-Za-z0-9_-]*/g) || []).map(c => c.slice(1)));
const preExisting = classesIn(oldCss);
const introduced  = [...classesIn(newCss)].filter(c =>
  !c.startsWith('serve-') &&
  !c.startsWith('is-') &&          /* state modifiers, only ever compounded onto a serve-* class */
  !preExisting.has(c));
t('introduces no class outside the serve-* namespace', introduced.length === 0, introduced);

/* And the state modifiers really are compounded, never used alone — a bare
   `.is-yes` would be exactly the collision the namespace is meant to avoid. */
const bareState = (newCss.match(/(^|[\s,>+~])\.is-[a-z-]+/gm) || []).map(s => s.trim());
t('state modifiers are never standalone selectors', bareState.length === 0, bareState);

/* ---------- meta descriptions quote real prices ----------
   The rule everywhere else on this site is that a published price is computed,
   never written down. A <meta name="description"> is the one place that rule
   could not reach: it is plain text in the <head>, invisible to the renderer
   and, until now, to every test.

   It rotted exactly as you would expect. /pricing advertised "first cleans from
   $117 to $347, recurring visits from $85" while the engine quoted $127, $865
   and $79 — the ceiling out by two and a half times, live, on the page whose
   entire job is telling people what things cost. Nobody would have noticed,
   because nothing renders that string on screen.

   Only FLOORS are asserted. Quoting a ceiling is what made the old line rot:
   the floor moves when base pricing changes, the ceiling moves whenever the
   largest home in SERVE_SIZES changes, which is a far lighter trigger. */
console.log('\n=== meta descriptions quote prices the engine agrees with ===');
const metaBox = runModule().box;
const rangeOf = (b, ba, svc) => metaBox.serveRange(b, ba, svc);

/* The cheapest home in the published table sets both floors. */
const sizes    = metaBox.__serve.SERVE_SIZES;
const smallest = sizes[0];
const deepFloor = rangeOf(smallest.beds, smallest.baths, 'deep')[0];
const recFloor  = rangeOf(smallest.beds, smallest.baths, 'recurring')[0];

const pricingDesc =
  (read('pricing.html').match(/<meta name="description" content="([^"]*)"/) || [])[1] || '';
const quoted = (pricingDesc.match(/\$\d+/g) || []).map(s => +s.slice(1));

t('/pricing description quotes exactly two figures', quoted.length === 2, quoted);
t('first-clean floor matches the engine',
  quoted[0] === deepFloor, { inDescription: quoted[0], fromEngine: deepFloor });
t('recurring floor matches the engine',
  quoted[1] === recFloor, { inDescription: quoted[1], fromEngine: recFloor });

/* "from $127" must not become "$127 to $865" again. */
t('description quotes floors, not a range',
  !/\bto \$|\$\d+\s*[–-]\s*\$/.test(pricingDesc), pricingDesc);

console.log('\n' + (bad ? 'FAILURES: ' + bad : 'ALL CHECKS PASSED'));
process.exit(bad ? 1 : 0);
