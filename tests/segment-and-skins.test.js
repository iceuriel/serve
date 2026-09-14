/**
 * Segment taxonomy, hero skins, vanity redirects, and the confirmation promise.
 *
 * Runs the REAL attribution and skin code sliced out of script.js against a
 * fake DOM and sessionStorage, so the values a visitor sees and the values
 * written to the sheet are proven to come from the same function.
 */
const REPO_ROOT = require('path').resolve(__dirname, '..');
const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const SITE = fs.readFileSync(path.join(REPO_ROOT, 'script.js'), 'utf8');
const HTML = fs.readFileSync(path.join(REPO_ROOT, 'index.html'), 'utf8');

let bad = 0;
const t = (label, cond, extra) => {
  console.log((cond ? '  ok    ' : '  FAIL  ') + label + (extra !== undefined ? '  ->  ' + JSON.stringify(extra) : ''));
  if (!cond) bad++;
};

/* Slice module-scope attribution + skin code, stopping before the booking IIFE. */
const start = SITE.indexOf('/* ============================================================\r\n   ATTRIBUTION');
const startFallback = SITE.indexOf('const SRC_SEGMENTS');
const from = start !== -1 ? start : startFallback;
const to   = SITE.indexOf('   Booking Flow — Build -> Price -> Reserve');
if (from === -1 || to === -1) throw new Error('could not slice attribution/skin code');
const slice = SITE.slice(from, SITE.lastIndexOf('/*', to));

/* The two hero bodies, as authored: the default showing, the ZIP-check body
   hidden. `omit` drops one, to prove a half-present pair is never half-swapped. */
function heroBodies(omit) {
  const els = { 'hero-body-default': { hidden: false }, 'hero-body-zip': { hidden: true } };
  if (omit) delete els[omit];
  return els;
}

function makeBox(search, storage, headlineSink, bodies) {
  const body = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
  const els  = bodies || heroBodies();
  const box = {
    console,
    location: { search, pathname: '/' },
    URLSearchParams,
    /* localStorage since 2026-08-30 — attribution outlives the tab so a card
       scanned on Tuesday still credits a booking made on Thursday. Leaving this
       as sessionStorage silently gives the code NO storage at all, which looks
       exactly like private mode: first touch stops persisting and every skin
       assertion below fails. */
    localStorage: storage,
    document: {
      body,
      querySelector: sel => (sel === '.hero__headline'
        ? { set textContent(v) { headlineSink.value = v; }, get textContent() { return headlineSink.value; } }
        : null),
      getElementById: id => els[id] || null,
    },
  };
  vm.createContext(box);
  vm.runInContext(slice, box);
  return box;
}

function fakeStorage() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}

/* ============================================================ */
console.log('=== 1. segment is an intent taxonomy, only three values ===');
const box = makeBox('', fakeStorage(), { value: '' });
const segmentFor = box.segmentFor;
const SEGMENTS   = vm.runInContext('SEGMENTS', box);

t('exactly three segments defined', JSON.stringify(SEGMENTS) === JSON.stringify(['movein', 'pro', 'direct']), SEGMENTS);

const cases = [
  ['deed-batch-04',  'movein'], ['db-2026-07', 'movein'], ['mv-somerville', 'movein'],
  ['dh-bh-01',       'pro'],    ['DH_BackBay', 'pro'],    ['poster-comm-ave', 'pro'],
  ['qr-allston-01',  'pro'],    ['flyer/jp',   'pro'],    ['eddm-02134', 'pro'],
  ['email-cold-a',   'pro'],    ['em-b',       'pro'],
  ['ref-jordan-m',   'direct'],
  ['totally-unknown','direct'], ['',           'direct'], [null, 'direct'],
];
cases.forEach(([src, want]) => t(JSON.stringify(src) + ' -> ' + want, segmentFor(src) === want, segmentFor(src)));

t('EVERY output is a valid segment — no channel words leak through',
  cases.every(([s]) => SEGMENTS.includes(segmentFor(s))),
  cases.map(([s]) => segmentFor(s)).filter(v => !SEGMENTS.includes(v)));
t('no legacy channel value is reachable',
  !['qr_code','poster','flyer','door_hanger','social','nextdoor','referral','google_business','email','other']
    .some(v => cases.some(([s]) => segmentFor(s) === v)));

/* ============================================================ */
console.log('\n=== 2. hero skin follows FIRST touch ===');
function skinFor(search, storage, bodies) {
  const sink = { value: 'DEFAULT' };
  const els  = bodies || heroBodies();
  const b = makeBox(search, storage || fakeStorage(), sink, els);
  const attr = vm.runInContext('SERVE_ATTRIBUTION', b);
  b.applyHeroSkin(attr.segment);
  return { headline: sink.value, segment: attr.segment, body: b.document.body.attrs, els };
}
/* Which hero body a visitor actually sees. */
const shown = els => Object.keys(els).filter(id => !els[id].hidden).join();

const MOVEIN_HEADLINE = /^Moving in or out\?$/;

const mv = skinFor('?src=deed-movein');
t('movein hero renders', MOVEIN_HEADLINE.test(mv.headline), mv.headline.slice(0, 50));
t('movein segment', mv.segment === 'movein');
t('body carries data-segment', mv.body['data-segment'] === 'movein', mv.body);
t('movein shows the ZIP-check body, and only that one', shown(mv.els) === 'hero-body-zip', shown(mv.els));

const pro = skinFor('?src=dh-bh-01');
t('pro hero renders', /^Get your weekends back with Serve$/.test(pro.headline), pro.headline.slice(0, 50));
t('pro headline no longer leads with Friday', !/Friday/.test(pro.headline));
t('pro shows the same ZIP-check body, and only that one', shown(pro.els) === 'hero-body-zip', shown(pro.els));
t('pro body missing -> the default body stays visible',
  shown(skinFor('?src=dh-bh-01', null, heroBodies('hero-body-zip')).els) === 'hero-body-default');

const dir = skinFor('');
t('untagged leaves the authored hero untouched', dir.headline === 'DEFAULT', dir.headline);
t('untagged keeps the authored body', shown(dir.els) === 'hero-body-default', shown(dir.els));
t('untagged segment is direct', dir.segment === 'direct');
t('unknown tag also leaves the hero alone', skinFor('?src=who-knows').headline === 'DEFAULT');

/* Half a pair must never be half-swapped: the default hidden with nothing
   shown in its place would be a hero with no body at all. */
const noAlt = skinFor('?src=deed-movein', null, heroBodies('hero-body-zip'));
t('ZIP-check body missing -> the default body stays visible', shown(noAlt.els) === 'hero-body-default', shown(noAlt.els));
const noMain = skinFor('?src=deed-movein', null, heroBodies('hero-body-default'));
t('default body missing -> the ZIP-check body is not shown either', shown(noMain.els) === '', shown(noMain.els));

/* first touch wins over a later tag, within one session */
const shared = fakeStorage();
const first  = skinFor('?src=deed-movein', shared);
const second = skinFor('?src=dh-poster-01', shared);
t('a later poster tag does NOT flip a mover to pro',
  MOVEIN_HEADLINE.test(second.headline), second.headline.slice(0, 50));
t('segment still movein on the second page view', second.segment === 'movein');
t('but last-touch src is still recorded for reporting',
  vm.runInContext('SERVE_ATTRIBUTION', makeBox('?src=dh-poster-01', shared, { value: '' })).src === 'dh-poster-01');

/* refresh keeps the skin */
t('hard refresh keeps the skin', MOVEIN_HEADLINE.test(skinFor('', shared).headline));

/* storage blocked -> default hero, no throw */
const hostile = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
let threw = null;
let blockedSkin;
try { blockedSkin = skinFor('?src=deed-movein', hostile); } catch (e) { threw = e.message; }
t('storage blocked does not throw', threw === null, threw);
t('storage blocked still derives the skin from the URL',
  blockedSkin && MOVEIN_HEADLINE.test(blockedSkin.headline));

/* ============================================================ */
console.log('\n=== 2b. the ZIP-check hero body, as authored ===');
/* Authored in this order, all inside the hero section. The ZIP check sits
   BETWEEN the two blocks, shared by every hero. */
const defaultAt   = HTML.indexOf('id="hero-body-default"');
const zipBodyAt   = HTML.indexOf('id="hero-body-zip"');
const heroEnd     = HTML.indexOf('</section>', zipBodyAt);
const defaultBody = defaultAt !== -1 && zipBodyAt > defaultAt ? HTML.slice(defaultAt, zipBodyAt) : '';
const moveinBody  = zipBodyAt !== -1 && heroEnd !== -1 ? HTML.slice(zipBodyAt, heroEnd) : '';
t('both hero bodies exist, default first', defaultBody !== '' && moveinBody !== '', [defaultAt, zipBodyAt]);
const heroHtml    = defaultAt !== -1 && heroEnd !== -1 ? HTML.slice(HTML.lastIndexOf('<section', defaultAt), heroEnd) : '';

/* One body for both tagged audiences, so the copy under the two headlines
   cannot drift apart. */
const skinsHere = vm.runInContext('HERO_SKINS', makeBox('', fakeStorage(), { value: '' }));
t('move-in and pro name the SAME body', skinsHere.movein.body === 'hero-body-zip' && skinsHere.pro.body === 'hero-body-zip',
  [skinsHere.movein.body, skinsHere.pro.body]);

t('the ZIP-check body ships hidden (no JS -> the authored hero)',
  /<div[^>]*id="hero-body-zip"[^>]*\shidden[\s>]/.test(HTML));
t('the default body does not', !/<div[^>]*id="hero-body-default"[^>]*\shidden[\s>]/.test(HTML));
t('the ZIP check is authored once, outside both blocks',
  (HTML.match(/id="hero-zip-form"/g) || []).length === 1 &&
  !/hero-zip-form/.test(moveinBody) && defaultBody.indexOf('id="hero-zip-form"') > defaultBody.indexOf('</div>'));
t('the hero has no Instant Booking button — the ZIP check is every CTA',
  !/Instant Booking/.test(heroHtml));
t('the ZIP input has no name, so a no-JS submit never puts the ZIP in the URL',
  /<input[^>]*id="hero-zip"/.test(HTML) && !/<input[^>]*id="hero-zip"[^>]*\sname=/.test(HTML));

/* The hero asks Build's own question, in Build's own words. */
const buildLabel = (HTML.match(/<label class="field-label" for="zip">([^<]+)<\/label>/) || [])[1];
const heroLabel  = (HTML.match(/<label[^>]*for="hero-zip">([^<]+)<\/label>/) || [])[1];
t('hero ZIP label is word for word the Build label', !!buildLabel && heroLabel === buildLabel, [heroLabel, buildLabel]);

/* Read in order through the hero: the authored hero is the first four, a
   skin swaps the first for the last two. */
const order = ['id="hero-body-default"', 'Serve manages, coordinates, and books your service', 'for="hero-zip"',
               'Instantly quote &amp; book in under 1 minute', 'Serve handles the rest', 'id="hero-body-zip"',
               'Serve manages, coordinates, and books your service', 'Made to Serve <strong>your</strong> needs'];
let cursor = 0;
const at = order.map(s => { const i = heroHtml.indexOf(s, cursor); if (i !== -1) cursor = i + s.length; return i; });
t('hero reads: [manages] ZIP check, under-a-minute, handles the rest, [manages, tagline]',
  at.every(i => i !== -1), at);
t('the authored hero has no tagline', !/hero__tagline/.test(defaultBody.slice(0, defaultBody.indexOf('</div>'))));

/* ============================================================ */
console.log('\n=== 2c. the hero ZIP check answers through Build ===');
/* The REAL block, sliced out of the booking IIFE and run against fakes for the
   few things it touches there. */
const zipFrom = SITE.indexOf('/* HERO ZIP CHECK');
const zipTo   = SITE.indexOf('/* Step 1 submit */', zipFrom);
if (zipFrom === -1 || zipTo === -1) throw new Error('could not slice the hero ZIP check');
const heroZipSrc = SITE.slice(zipFrom, zipTo);

function fakeEl(extra) {
  const on = {};
  const classes = new Set();
  return Object.assign({
    value: '', hidden: false, textContent: '', blurred: false, focused: false,
    classList: {
      add: (...c) => c.forEach(x => classes.add(x)),
      remove: (...c) => c.forEach(x => classes.delete(x)),
      contains: c => classes.has(c),
    },
    addEventListener(type, fn) { on[type] = fn; },
    fire(type) { const ev = { prevented: false, preventDefault() { this.prevented = true; } }; on[type](ev); return ev; },
    blur() { this.blurred = true; },
    focus() { this.focused = true; },
  }, extra);
}

function heroZip(served) {
  const ids = {
    'hero-zip-form': fakeEl(), 'hero-zip': fakeEl(), 'hero-zip-status': fakeEl(),
    'hero-zip-waitlist': fakeEl({ hidden: true }),
  };
  const timers = [];
  const box = {
    $: id => ids[id] || null,
    zipInput: fakeEl(), buildError: fakeEl({ textContent: 'old error' }),
    state: { zip: '', tier: null },
    views: [], prefetches: 0,
    setTimeout: (fn, ms) => { timers.push({ fn, ms, live: true }); return timers.length; },
    clearTimeout: h => { if (h && timers[h - 1]) timers[h - 1].live = false; },
  };
  /* Stands in for Build's evaluateZip: reads the Build field, sets the verdict. */
  box.evaluateZip = () => {
    box.state.zip = box.zipInput.value;
    if (box.state.zip.length === 5) box.state.tier = served.includes(box.state.zip) ? 'core' : 'unknown';
  };
  box.setView = k => box.views.push(k);
  box.prefetchAvailability = () => { box.prefetches++; };
  vm.createContext(box);
  vm.runInContext(heroZipSrc, box);
  const type = v => { ids['hero-zip'].value = v; ids['hero-zip'].fire('input'); };
  const flush = () => timers.forEach(tm => { if (tm.live) { tm.live = false; tm.fn(); } });
  const live = () => timers.filter(tm => tm.live);
  return { box, ids, type, flush, live, form: ids['hero-zip-form'] };
}

const SERVED = ['02116'];

let h = heroZip(SERVED);
h.type('021');
t('a partial ZIP writes nothing into Build', h.box.zipInput.value === '', h.box.zipInput.value);
t('...shows no verdict', h.ids['hero-zip-status'].textContent === '' && !h.form.classList.contains('is-ok'));

h.type('02116x9');
t('non-digits stripped, capped at five', h.ids['hero-zip'].value === '02116', h.ids['hero-zip'].value);
t('a served ZIP is written into Build', h.box.zipInput.value === '02116', h.box.zipInput.value);
t('...through Build\'s own check, which cleared Build\'s stale error', h.box.buildError.textContent === '');
t('...and gets the green check', h.form.classList.contains('is-ok'));
t('...and says so', h.ids['hero-zip-status'].textContent === 'We serve 02116', h.ids['hero-zip-status'].textContent);
t('...and starts the times feed early', h.box.prefetches === 1, h.box.prefetches);
t('the page does NOT move the instant the check appears', h.box.views.length === 0, h.box.views);
t('the jump waits a beat so the check is seen', h.live().length === 1 && h.live()[0].ms >= 400, h.live().map(x => x.ms));
h.flush();
t('then it scrolls to Build (step 1), not to Price', JSON.stringify(h.box.views) === '[1]', h.box.views);
t('and drops the phone keyboard first', h.ids['hero-zip'].blurred === true);

h = heroZip(SERVED);
h.type('02116');
h.type('0211');
h.flush();
t('editing during the pause cancels the jump', h.box.views.length === 0, h.box.views);
t('...and clears the green check', !h.form.classList.contains('is-ok'));

h = heroZip(SERVED);
h.type('99999');
t('an unserved ZIP still fills Build, so its waitlist is waiting there', h.box.zipInput.value === '99999');
t('...gets no green check', !h.form.classList.contains('is-ok') && h.form.classList.contains('is-out'));
t('...says we are not there yet', /not in 99999 yet/.test(h.ids['hero-zip-status'].textContent), h.ids['hero-zip-status'].textContent);
t('...offers the waitlist link', h.ids['hero-zip-waitlist'].hidden === false);
t('...and never moves the page on its own', h.live().length === 0 && h.box.views.length === 0);
t('...nor fetches times for a place we cannot book', h.box.prefetches === 0);
const click = h.ids['hero-zip-waitlist'].fire('click');
t('the waitlist link takes them to Build', JSON.stringify(h.box.views) === '[1]' && click.prevented, h.box.views);

h = heroZip(SERVED);
h.type('02116');
h.type('99999');
t('served then unserved: the waitlist replaces the check', !h.form.classList.contains('is-ok') && h.ids['hero-zip-waitlist'].hidden === false);
h.flush();
t('...and the earlier jump was cancelled', h.box.views.length === 0, h.box.views);

h = heroZip(SERVED);
h.ids['hero-zip'].value = '02';
const shortSubmit = h.form.fire('submit');
t('Enter on a short ZIP does not submit the page', shortSubmit.prevented);
t('...flags the field and says what is wanted',
  h.ids['hero-zip'].classList.contains('error') && /5-digit/.test(h.ids['hero-zip-status'].textContent));
t('...and goes nowhere', h.box.views.length === 0 && h.box.zipInput.value === '');

h = heroZip(SERVED);
h.ids['hero-zip'].value = '02116';
h.form.fire('submit');
t('Enter on a served ZIP jumps without the pause', h.live().length === 1 && h.live()[0].ms === 0, h.live().map(x => x.ms));

t('a page without the hero markup loses nothing (no throw)', (() => {
  try { const b = { $: () => null }; vm.createContext(b); vm.runInContext(heroZipSrc, b); return true; }
  catch (e) { return false; }
})());

/* ============================================================ */
console.log('\n=== 2d. move-in visitors start on the move clean ===');
/* Sliced to the end of its own IIFE, so the order checks below report a
   misplaced block instead of the slice itself failing to find it. */
const preFrom = SITE.indexOf('const SEGMENT_DEFAULT_SERVICE');
const preFn   = SITE.indexOf('function preselectServiceForSegment', preFrom);
const preTo   = preFn === -1 ? -1 : SITE.indexOf('})();', preFn) + '})();'.length;
if (preFrom === -1 || preFn === -1 || preTo < preFn) throw new Error('could not slice the segment preselect');
const preselectSrc = SITE.slice(preFrom, preTo);

/* Where it sits IS the guarantee, so assert it. After the add-on consts: the
   change handler reaches syncAddonsToService(), which reads them, and a
   dispatch before they exist throws. Before readPrefillParams: a link that
   names its own service must still win. */
const addonConstAt = SITE.indexOf('const addonFridge');
t('runs after the add-on consts exist', addonConstAt !== -1 && addonConstAt < preFrom, [addonConstAt, preFrom]);
const prefillParamsAt = SITE.indexOf('(function readPrefillParams()');
t("runs before a link's own &service= is applied", prefillParamsAt > preFrom, [preFrom, prefillParamsAt]);

function preselectFor(segment, alreadyChecked) {
  const radios = ['first_clean', 'move_out'].map(v => ({
    value: v, checked: v === (alreadyChecked || 'first_clean'), events: [],
    dispatchEvent(e) { this.events.push(e.type + (e.bubbles ? '+bubbles' : '')); return true; },
  }));
  const box = {
    SERVE_ATTRIBUTION: { segment },
    Event: class { constructor(type, o) { this.type = type; this.bubbles = !!(o && o.bubbles); } },
    buildForm: { querySelector: sel => radios.find(r => sel === 'input[name="service"][value="' + r.value + '"]') || null },
  };
  vm.createContext(box);
  vm.runInContext(preselectSrc, box);
  const by = v => radios.find(r => r.value === v);
  return { move: by('move_out'), first: by('first_clean') };
}

let ps = preselectFor('movein');
t('movein: Move In / Move Out is checked', ps.move.checked === true);
t("movein: through the radio's own change handler, as a click would", JSON.stringify(ps.move.events) === '["change+bubbles"]', ps.move.events);
t('movein: First Clean is not touched', ps.first.events.length === 0);

ps = preselectFor('pro');
t('pro keeps First Clean', ps.first.checked && !ps.move.checked && ps.move.events.length === 0);
ps = preselectFor('direct');
t('direct keeps First Clean', ps.first.checked && !ps.move.checked && ps.move.events.length === 0);
ps = preselectFor('movein', 'move_out');
t('already on the move clean: no second change event', ps.move.events.length === 0, ps.move.events);

/* ============================================================ */
console.log('\n=== 3. vanity redirects feed the same first-touch path ===');
const red = fs.readFileSync(path.join(REPO_ROOT, '_redirects'), 'utf8');
const rules = red.split('\n').filter(l => l.trim() && !l.trim().startsWith('#'))
  .map(l => l.trim().split(/\s+/));
console.log('  ' + rules.map(r => r.join(' ')).join('\n  '));

const byPath = Object.fromEntries(rules.map(r => [r[0], r]));

/* A vanity path is a measurement instrument, and an untagged one silently
   measures nothing — it looks identical to organic traffic in the sheet. This
   used to name each path individually, which meant a path added later was
   guarded only by whoever remembered to come back here. /q shipped untagged
   through a Cloudflare dashboard rule for exactly that reason.

   So the rule is now inverted: EVERY redirect must carry a src unless it is
   listed below as deliberately exempt, and adding to that list should take a
   reason rather than a shrug. */
const UNTAGGED_BY_DESIGN = {
  '/book': 'the opt-in URL in Twilio A2P 10DLC registration — reviewers follow ' +
           'it by hand, and a campaign tag would route marketing traffic through ' +
           'the one URL carriers re-fetch after approval',
};

/** The `src` a redirect target hands to the site. Strips the fragment first —
    `...&utm_campaign=founder#quote` otherwise parses the anchor into the last
    parameter's value. */
function srcOf(target) {
  const query = (String(target).split('?')[1] || '').split('#')[0];
  return new URLSearchParams(query).get('src');
}

rules.forEach(([from, to]) => {
  if (UNTAGGED_BY_DESIGN[from]) {
    t(from + ' is untagged on purpose', !srcOf(to),
      'exempt: ' + UNTAGGED_BY_DESIGN[from]);
    return;
  }
  const src = srcOf(to);
  t(from + ' carries a src tag', !!src, to);
  t(from + ' resolves to a known segment', SEGMENTS.includes(segmentFor(src)),
    segmentFor(src));
});

/* Named paths keep their own assertion on top of the blanket rule: these two
   are printed on physical media, so which segment they resolve to is a fact
   about paper that cannot be corrected after the fact. */
t('/movein exists', !!byPath['/movein']);
t('/clean exists',  !!byPath['/clean']);
t('/q exists (founder card)',   !!byPath['/q']);
t('/friend exists (referral card)', !!byPath['/friend']);
[['/movein', 'movein'], ['/clean', 'pro'], ['/q', 'pro'], ['/friend', 'direct']]
  .forEach(([p, want]) => {
    const target = byPath[p] && byPath[p][1];
    t(p + ' resolves to segment ' + want, segmentFor(srcOf(target)) === want,
      segmentFor(srcOf(target)));
  });

/* Two cards must not share a slug — identical tags make the sheet unable to
   tell them apart, which is the one thing the slug exists to do. */
const srcs = rules.map(r => srcOf(r[1])).filter(Boolean);
t('every vanity path has a distinct src', new Set(srcs).size === srcs.length, srcs);
t('redirects are 302, not permanently cached',
  rules.every(r => r[2] === '302'), rules.map(r => r[2]));
t('build stages _redirects',
  /cp _headers _redirects/.test(fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'build-site.sh'), 'utf8')));

/* ============================================================ */
console.log('\n=== 4. CTA copy is identical across every skin ===');
/* Scoped to the BUTTONS, not to every anchor pointing at the quote flow.
   Headings elsewhere on the page are prose and may legitimately read
   differently. The rule is that a control says the same thing everywhere it
   appears — and as of 2026-09-07 the page also has non-button links to #quote
   that must NOT match it: the home card's empty address field ("Add your
   address") and a sentence in the service catalogue. Selecting on href alone
   would have dragged both into the CTA vocabulary.

   Both href forms count. The nav moved to the absolute "/#quote" when /pricing
   and /services were added, because the nav block is now byte-identical across
   three files and a bare "#quote" would point at the wrong page from two of
   them. The rest stay relative — they only ever render here. The LABEL is what
   is asserted; it became "Instant Booking". */
const ctas = (HTML.match(/<a[^>]*href="\/?#quote"[^>]*>[^<]+<\/a>/g) || [])
  .filter(tag => /class="[^"]*\b(btn|nav__cta)\b/.test(tag))
  .map(tag => (tag.match(/>([^<]+)</) || [])[1].trim());
t('every CTA button reads "Instant Booking"',
  ctas.length >= 3 && ctas.every(c => c === 'Instant Booking'), ctas);
t('no skin touches the CTA', !/btn--primary|nav__cta/.test(JSON.stringify(vm.runInContext('HERO_SKINS', box))));
/* Until 2026-09-14 a skin was a headline and nothing else. The founder asked
   for a move-in hero that leads with a ZIP check, so a skin may now also name a
   body — but only by id, and only one authored hidden in index.html. Copy and
   controls still live in the markup, never in these strings. */
const skins = vm.runInContext('HERO_SKINS', box);
t('skins define a headline, and at most a body',
  Object.values(skins).every(s => typeof s.headline === 'string' &&
    Object.keys(s).every(k => k === 'headline' || k === 'body')), skins);
t('every named body is authored hidden in index.html',
  Object.values(skins).filter(s => s.body).every(s =>
    new RegExp('<div[^>]*id="' + s.body + '"[^>]*\\shidden[\\s>]').test(HTML)),
  Object.values(skins).map(s => s.body).filter(Boolean));

/* ============================================================ */
console.log('\n=== 5. the 15-minute promise ===');
t('promise present in the confirmation panel', /within 15 minutes/.test(HTML));
t('states a fallback action', /If it doesn't arrive/.test(HTML));
t('fallback uses the address the footer already carries',
  (HTML.match(/mailto:management@servecos.com/g) || []).length >= 2);
t('no phone number was invented — only the existing one appears',
  (HTML.match(/tel:\+?\d+/g) || []).every(x => x === 'tel:+16178047201'),
  [...new Set(HTML.match(/tel:\+?\d+/g) || [])]);
t('TODO left for the Twilio swap', /TODO\(twilio\)/.test(HTML));
t('promise appears exactly once', (HTML.match(/within 15 minutes/g) || []).length === 1);

console.log('\n' + (bad ? 'FAILURES: ' + bad : 'ALL CHECKS PASSED'));
process.exit(bad ? 1 : 0);
