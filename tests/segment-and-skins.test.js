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

function makeBox(search, storage, headlineSink) {
  const body = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
  const box = {
    console,
    location: { search, pathname: '/' },
    URLSearchParams,
    sessionStorage: storage,
    document: {
      body,
      querySelector: sel => (sel === '.hero__headline'
        ? { set textContent(v) { headlineSink.value = v; }, get textContent() { return headlineSink.value; } }
        : null),
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
function skinFor(search, storage) {
  const sink = { value: 'DEFAULT' };
  const b = makeBox(search, storage || fakeStorage(), sink);
  const attr = vm.runInContext('SERVE_ATTRIBUTION', b);
  b.applyHeroSkin(attr.segment);
  return { headline: sink.value, segment: attr.segment, body: b.document.body.attrs };
}

const mv = skinFor('?src=deed-movein');
t('movein hero renders', /Just closed on a new home/.test(mv.headline), mv.headline.slice(0, 50));
t('movein segment', mv.segment === 'movein');
t('body carries data-segment', mv.body['data-segment'] === 'movein', mv.body);

const pro = skinFor('?src=dh-bh-01');
t('pro hero renders', /Come back Friday to a clean home/.test(pro.headline), pro.headline.slice(0, 50));

const dir = skinFor('');
t('untagged leaves the authored hero untouched', dir.headline === 'DEFAULT', dir.headline);
t('untagged segment is direct', dir.segment === 'direct');
t('unknown tag also leaves the hero alone', skinFor('?src=who-knows').headline === 'DEFAULT');

/* first touch wins over a later tag, within one session */
const shared = fakeStorage();
const first  = skinFor('?src=deed-movein', shared);
const second = skinFor('?src=dh-poster-01', shared);
t('a later poster tag does NOT flip a mover to pro',
  /Just closed on a new home/.test(second.headline), second.headline.slice(0, 50));
t('segment still movein on the second page view', second.segment === 'movein');
t('but last-touch src is still recorded for reporting',
  vm.runInContext('SERVE_ATTRIBUTION', makeBox('?src=dh-poster-01', shared, { value: '' })).src === 'dh-poster-01');

/* refresh keeps the skin */
t('hard refresh keeps the skin', /Just closed/.test(skinFor('', shared).headline));

/* storage blocked -> default hero, no throw */
const hostile = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
let threw = null;
let blockedSkin;
try { blockedSkin = skinFor('?src=deed-movein', hostile); } catch (e) { threw = e.message; }
t('storage blocked does not throw', threw === null, threw);
t('storage blocked still derives the skin from the URL',
  blockedSkin && /Just closed/.test(blockedSkin.headline));

/* ============================================================ */
console.log('\n=== 3. vanity redirects feed the same first-touch path ===');
const red = fs.readFileSync(path.join(REPO_ROOT, '_redirects'), 'utf8');
const rules = red.split('\n').filter(l => l.trim() && !l.trim().startsWith('#'))
  .map(l => l.trim().split(/\s+/));
console.log('  ' + rules.map(r => r.join(' ')).join('\n  '));

const byPath = Object.fromEntries(rules.map(r => [r[0], r]));
t('/movein exists', !!byPath['/movein']);
t('/clean exists',  !!byPath['/clean']);
[['/movein', 'movein'], ['/clean', 'pro']].forEach(([p, want]) => {
  const target = byPath[p] && byPath[p][1];
  const src = target && new URLSearchParams(target.split('?')[1] || '').get('src');
  t(p + ' carries a src tag', !!src, target);
  t(p + ' resolves to segment ' + want, segmentFor(src) === want, segmentFor(src));
});
t('redirects are 302, not permanently cached',
  rules.every(r => r[2] === '302'), rules.map(r => r[2]));
t('build stages _redirects',
  /cp _headers _redirects/.test(fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'build-site.sh'), 'utf8')));

/* ============================================================ */
console.log('\n=== 4. CTA copy is identical across every skin ===');
/* Scoped to the actual controls — anchors pointing at the quote flow — not to
   every occurrence of the phrase. Headings elsewhere on the page are prose and
   may legitimately read differently ("Instant Quotes" in How It Works). The
   rule is that a CONTROL says the same thing everywhere it appears.

   Both href forms count. The nav moved to the absolute "/#quote" when /pricing
   and /services were added, because the nav block is now byte-identical across
   three files and a bare "#quote" would point at the wrong page from two of
   them. The hero stays relative — it only ever renders here. What is being
   asserted is the LABEL, which did not change and must not. */
const ctas = [...HTML.matchAll(/<a[^>]*href="\/?#quote"[^>]*>([^<]+)<\/a>/g)].map(m => m[1].trim());
t('every CTA control reads "Instant quote"',
  ctas.length === 3 && ctas.every(c => c === 'Instant quote'), ctas);
t('no skin touches the CTA', !/btn--primary|nav__cta/.test(JSON.stringify(vm.runInContext('HERO_SKINS', box))));
t('skins define a headline and nothing else',
  Object.values(vm.runInContext('HERO_SKINS', box)).every(s => Object.keys(s).join() === 'headline'));

/* ============================================================ */
console.log('\n=== 5. the 15-minute promise ===');
t('promise present in the confirmation panel', /within 15 minutes/.test(HTML));
t('states a fallback action', /If it doesn't arrive/.test(HTML));
t('fallback uses the address the footer already carries',
  (HTML.match(/mailto:servehomecleaning@gmail\.com/g) || []).length >= 2);
t('no phone number was invented — only the existing one appears',
  (HTML.match(/tel:\+?\d+/g) || []).every(x => x === 'tel:+12062097707'),
  [...new Set(HTML.match(/tel:\+?\d+/g) || [])]);
t('TODO left for the Twilio swap', /TODO\(twilio\)/.test(HTML));
t('promise appears exactly once', (HTML.match(/within 15 minutes/g) || []).length === 1);

console.log('\n' + (bad ? 'FAILURES: ' + bad : 'ALL CHECKS PASSED'));
process.exit(bad ? 1 : 0);
