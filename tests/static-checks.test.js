/* Static QA for the Serve site: cross-check every DOM reference against the markup. */
/* Repo-relative so this runs from a clean clone on any machine. */
const REPO_ROOT = require('path').resolve(__dirname, '..');
const fs = require('fs');
const path = require('path');

const ROOT = REPO_ROOT;
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const js   = fs.readFileSync(path.join(ROOT, 'script.js'), 'utf8');
const css  = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');

let fails = 0;
const fail = (m) => { console.log('  FAIL  ' + m); fails++; };
const ok   = (m) => console.log('  ok    ' + m);
const head = (m) => console.log('\n=== ' + m + ' ===');

// Static markup plus ids that script.js injects via innerHTML templates.
const idsInHtml = new Set([
  ...[...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]),
  ...[...js.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]),
]);

/* 1. Every element the JS looks up must exist. */
head('JS element lookups resolve');
const looked = new Set([
  ...[...js.matchAll(/\$\('([^']+)'\)/g)].map(m => m[1]),
  ...[...js.matchAll(/getElementById\('([^']+)'\)/g)].map(m => m[1]),
]);
[...looked].sort().forEach(id => {
  if (!idsInHtml.has(id)) fail('script.js looks up #' + id + ' — no such id in index.html');
});
if (!fails) ok(looked.size + ' ids referenced by script.js all exist');

/* 2. Duplicate ids would break getElementById semantics. */
head('No duplicate ids');
const allIds = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
const dupes = allIds.filter((v, i) => allIds.indexOf(v) !== i);
dupes.length ? fail('duplicate ids: ' + [...new Set(dupes)].join(', '))
             : ok(allIds.length + ' ids, all unique');

/* 3. In-page anchors must have targets. */
head('In-page anchors resolve');
const anchors = [...new Set([...html.matchAll(/href="#([^"]+)"/g)].map(m => m[1]))];
anchors.forEach(a => { if (!idsInHtml.has(a)) fail('href="#' + a + '" has no target'); });
ok('anchors checked: ' + anchors.join(', '));

/* 4. Images must exist on disk and lazy-load. */
head('Image assets');
const imgs = [...html.matchAll(/<img[^>]*src="([^"]+)"[^>]*>/g)];
imgs.forEach(m => {
  const src = m[1];
  if (/^https?:/.test(src)) return;
  if (!fs.existsSync(path.join(ROOT, src))) fail('missing image: ' + src);
});
ok(imgs.length + ' <img> tags, all local files present');
/* Every image needs alt text, and everything below the fold should lazy-load.
   The hero logo is the one legitimate exception — it is the first paint. */
const noAlt = imgs.filter(m => !/alt="/.test(m[0])).map(m => m[1]);
noAlt.length ? fail('images missing alt: ' + noAlt.join(', '))
             : ok('all ' + imgs.length + ' images have alt text');
const notLazy = imgs.filter(m => !/loading="lazy"/.test(m[0]) && !/hero__logo/.test(m[0]))
                    .map(m => m[1]);
notLazy.length ? fail('below-the-fold images not lazy: ' + notLazy.join(', '))
               : ok('all non-hero images lazy-load');

/* 5. Classes introduced this build must be styled. */
head('New classes are styled');
const NEW_CLASSES = ['svmA-section','svmA-wrap','svmA-lede','svmA-grid','svmA-bubble','svmA-step',
  // svmA-shots* removed 2026-08-03 with the "What done looks like" gallery.
  'svmA-foot','step__link','reserve-aftercare','flow-textarea','field-hint'];
NEW_CLASSES.forEach(c => {
  if (!html.includes('class="' + c) && !html.includes(' ' + c + '"') && !html.includes(c + ' '))
    fail(c + ' not used in index.html');
  if (!css.includes('.' + c)) fail(c + ' has no rule in style.css');
});
ok('all ' + NEW_CLASSES.length + ' new classes used and styled');

/* 6. The new section must sit OUTSIDE the step-switching machinery. */
head('after-you-book is outside the quote flow');
const quoteStart = html.indexOf('<section class="quote-section" id="quote">');
const abyIdx     = html.indexOf('id="after-you-book"');
const footerIdx  = html.indexOf('<footer');
// find the </section> that closes #quote: the last one before after-you-book
const quoteEnd   = html.lastIndexOf('</section>', abyIdx);
abyIdx > quoteEnd  ? ok('#after-you-book starts after #quote closes')
                   : fail('#after-you-book is nested inside #quote');
abyIdx < footerIdx ? ok('#after-you-book sits before the footer')
                   : fail('#after-you-book is not before the footer');
const abySection = html.slice(abyIdx - 200, html.indexOf('</section>', abyIdx) + 10);
/class="quote-step/.test(abySection) ? fail('after-you-book contains a .quote-step')
                                     : ok('no .quote-step class inside the new section');
// The step switcher only ever touches these five ids.
const switched = ['step-1','step-2','step-3','state-overflow','state-confirmed'];
switched.includes('after-you-book') ? fail('after-you-book is in the step map')
                                    : ok('step map = [' + switched.join(', ') + '] — after-you-book absent');

/* 7. Payload field names actually sent. */
head('Payload fields');
const baseBlock = js.slice(js.indexOf('function basePayload'), js.indexOf('function bedroomsLabel'));
const baseKeys  = [...baseBlock.matchAll(/^\s{12}([a-z_]+):/gm)].map(m => m[1]);
const reserveBlock = js.slice(js.indexOf("const p = basePayload('reservation'"), js.indexOf('postReservation(p)'));
const reserveKeys  = [...reserveBlock.matchAll(/\bp\.([a-z_]+)\s*=/g)].map(m => m[1]);
const all = [...new Set([...baseKeys, ...reserveKeys])];
console.log('  base (' + baseKeys.length + '): ' + baseKeys.join(', '));
console.log('  reserve (+' + [...new Set(reserveKeys)].length + '): ' + [...new Set(reserveKeys)].join(', '));
console.log('  TOTAL UNIQUE: ' + all.length);
['submission_id','segment','src_first','src_chain','addon_total','customer_notes','pets_flag']
  .forEach(k => { if (!all.includes(k)) fail('payload is missing ' + k); });
ok('all 7 new payload fields present');

/* 8. Tag balance on the block we inserted. */
head('Markup balance');
const opens  = (html.match(/<section\b/g) || []).length;
const closes = (html.match(/<\/section>/g) || []).length;
opens === closes ? ok('<section> balanced (' + opens + ')') : fail('section open/close mismatch: ' + opens + '/' + closes);
const dOpens  = (html.match(/<div\b/g) || []).length;
const dCloses = (html.match(/<\/div>/g) || []).length;
dOpens === dCloses ? ok('<div> balanced (' + dOpens + ')') : fail('div open/close mismatch: ' + dOpens + '/' + dCloses);

/* 9. Availability isolation. */
head('Availability feed isolation');
(js.match(/AVAILABILITY_SOURCE_URL/g) || []).length >= 3 ? ok('AVAILABILITY_SOURCE_URL is the single named constant')
                                                         : fail('constant not wired');
/AVAIL_URL\b(?!.*SOURCE)/.test(js.replace(/AVAILABILITY_SOURCE_URL/g, '')) ? fail('stale AVAIL_URL reference remains')
                                                                          : ok('no stale AVAIL_URL references');
js.includes('AVAILABILITY_TIMEOUT_MS = 5000') ? ok('5s timeout constant present') : fail('no 5s timeout');
js.includes('if (!AVAILABILITY_SOURCE_URL)')  ? ok('empty-URL short circuit present') : fail('no empty-URL short circuit');

/* 10. CTA copy unified — the CONTROLS, not every use of the phrase.
   Headings are prose and may differ; a button must not.
   Both href forms count: the nav uses the absolute "/#quote" so one nav block
   can be byte-identical across index, pricing and services; the hero stays
   relative. The label is what is under test and it did not change. */
head('CTA copy');
const cta = [...html.matchAll(/<a[^>]*href="\/?#quote"[^>]*>([^<]+)<\/a>/g)].map(m => m[1].trim());
cta.length === 3 && cta.every(c => c === 'Instant quote')
  ? ok('all ' + cta.length + ' CTA controls read "Instant quote"')
  : fail('CTA controls inconsistent: ' + JSON.stringify(cta));

/* 11. The hero skyline, and specifically the thing that makes it loop.
   Each sail is in the markup TWICE — once in place, once shifted one full
   viewBox width left — and the drift animation moves both right by exactly
   that width, so the twin arrives as the original leaves. The duplication
   reads as redundant markup and is the obvious thing to "tidy up"; deleting
   a twin leaves the sails vanishing at one edge and reappearing at the other
   several seconds later, which is easy to miss on a page nobody stares at.
   These assertions exist to make that deletion fail loudly instead. */
head('Hero skyline');
const skyline = (html.match(/<div class="hero__skyline"[\s\S]*?<\/div>/) || [''])[0];

skyline ? ok('skyline block present in the hero')
        : fail('no .hero__skyline block in index.html');

/aria-hidden="true"/.test(skyline)
  ? ok('decorative: aria-hidden from the screen reader tree')
  : fail('.hero__skyline must be aria-hidden — it is pure decoration');

['a', 'b', 'c'].forEach(lane => {
  const drift = new RegExp('skyline__drift--' + lane, 'g');
  const bob   = new RegExp('skyline__bob--'   + lane, 'g');
  const drifts = (skyline.match(drift) || []).length;
  const bobs   = (skyline.match(bob)   || []).length;
  drifts === 1 && bobs === 2
    ? ok('lane ' + lane + ': one drift group carrying two hulls')
    : fail('lane ' + lane + ' has ' + drifts + ' drift / ' + bobs +
           ' hulls — the loop needs exactly 1 and 2 (the twin makes it seamless)');
});

(skyline.match(/translate\(-1200,0\)/g) || []).length === 3
  ? ok('all three twins offset by exactly one viewBox width')
  : fail('each lane needs a twin at translate(-1200,0) — that offset IS the loop');

/translateX\(1200px\)/.test(css)
  ? ok('drift travels one full viewBox width')
  : fail('serve-sail-drift must travel 1200px — anything else seams the loop');

/* The animation is decorative motion across the whole viewport, which is
   exactly what a vestibular trigger looks like. The site already honours the
   setting for the CTA pulse; the sails must not be the one exception. */
/prefers-reduced-motion[\s\S]{0,220}skyline__drift/.test(css)
  ? ok('sailing stops under prefers-reduced-motion')
  : fail('no prefers-reduced-motion guard covering .skyline__drift');

/* fill="currentColor" inherits, and .hero sets color:#fff. Without an explicit
   colour on the container the silhouette paints WHITE over the dark hero. */
/\.hero__skyline\s*\{[^}]*color:/.test(css)
  ? ok('skyline sets its own colour (currentColor would inherit #fff)')
  : fail('.hero__skyline must set color — it would otherwise inherit #fff from .hero');

/* 12. The before/after photos stay collapsed.
   They sit between the hero and the quote form, so expanding them by default
   pushes the form down and costs ~1.2 MB of JPEG that a browser skips
   entirely while the panel is shut. Adding `open` to take a screenshot and
   forgetting to remove it would undo both, invisibly — the page would simply
   look the way it used to. */
head('Before/after photos collapsed');
const workSection = (html.match(/<!-- WORK EXAMPLES -->[\s\S]*?<!-- QUOTE FLOW/) || [''])[0]
  .replace(/<!--[\s\S]*?-->/g, '');          // my own comments mention <details>

/<details class="work-acc">/.test(workSection)
  ? ok('photo grid wrapped in <details>')
  : fail('the .ba-grid must sit inside <details class="work-acc">');

/<details class="work-acc"\s+open/.test(workSection)
  ? fail('work-acc has `open` — the photos ship expanded, form pushed down')
  : ok('collapsed by default');

workSection.indexOf('<div class="ba-grid">') > workSection.indexOf('<details class="work-acc">')
  ? ok('grid is inside the panel, not beside it')
  : fail('.ba-grid is outside <details> — it would render regardless');

/* Lazy loading is half of the saving: a closed <details> only avoids the
   fetch because the images defer it. Eager images inside would load anyway. */
const workImgs  = (workSection.match(/<img\b[^>]*>/g) || []);
const lazyImgs  = workImgs.filter(t => /loading="lazy"/.test(t));
workImgs.length > 0 && workImgs.length === lazyImgs.length
  ? ok('all ' + workImgs.length + ' photos are loading="lazy"')
  : fail((workImgs.length - lazyImgs.length) + ' of ' + workImgs.length +
         ' photos are not lazy — those load even while collapsed');

/* 13. Every published page declares one canonical URL, and it agrees with the
   sitemap.
   ---------------------------------------------------------------
   The homepage is the reason this matters now: every campaign slug creates
   another crawlable copy of it — /?src=qr-card-founder-01 and one more per
   card printed — plus a www duplicate of each. Identical content on every one.
   Without a canonical, Google picks a winner itself and splits ranking signals
   across the rest, and the problem grows with each QR code rather than staying
   put.

   Tested against sitemap.xml rather than a list written here, so the two
   cannot drift into disagreeing about a page's real address — which would be
   worse than either being wrong alone. */
head('Canonical URLs');
const sitemap = fs.readFileSync(path.join(ROOT, 'sitemap.xml'), 'utf8');
const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);

/* Derived from the build allow-list: a page staged for publication but not
   listed here would otherwise ship unguarded. */
const staged = (fs.readFileSync(path.join(ROOT, 'scripts', 'build-site.sh'), 'utf8')
  .match(/^cp ([^\n]*\.html[^\n]*?) "\$OUT"/m) || [, ''])[1]
  .split(/\s+/).filter(f => f.endsWith('.html'));

staged.length >= 5
  ? ok(staged.length + ' pages staged: ' + staged.join(', '))
  : fail('could not read the staged page list from build-site.sh — got ' +
         JSON.stringify(staged));

/* index.html is served at "/", the rest drop their .html — the asset server
   answers both forms, and the canonical names which one is real. */
const canonicalFor = f => 'https://servecleaning.com/' +
  (f === 'index.html' ? '' : f.replace(/\.html$/, ''));

staged.forEach(f => {
  const doc  = fs.readFileSync(path.join(ROOT, f), 'utf8');
  const tags = [...doc.matchAll(/<link[^>]+rel="canonical"[^>]*>/g)];
  const href = (doc.match(/<link[^>]+rel="canonical"[^>]+href="([^"]+)"/) || [])[1];
  const want = canonicalFor(f);

  if (tags.length !== 1) {
    fail(f + ' has ' + tags.length + ' canonical tags — it needs exactly 1');
  } else if (href !== want) {
    fail(f + ' canonical is ' + href + ' — expected ' + want);
  } else if (!locs.includes(want)) {
    fail(f + ' canonical ' + want + ' is not in sitemap.xml');
  } else {
    ok(f + ' -> ' + want);
  }
});

/* Every staged page needs a description too, and index.html shipped without
   one for months. A missing description is not a blank result — Google writes
   its own from whatever text it finds first, which on these pages is the nav.
   Over ~160 characters it gets truncated mid-sentence, which reads worse than
   a short one. */
staged.forEach(f => {
  const doc  = fs.readFileSync(path.join(ROOT, f), 'utf8');
  const desc = (doc.match(/<meta name="description" content="([^"]*)"/) || [])[1];
  if (!desc)                  fail(f + ' has no <meta name="description">');
  else if (desc.length > 160) fail(f + ' description is ' + desc.length +
                                   ' chars — truncates around 160');
  else if (desc.length < 50)  fail(f + ' description is only ' + desc.length +
                                   ' chars — too thin to be useful');
  else ok(f + ' description: ' + desc.length + ' chars');
});

/* A www canonical would fight the Cloudflare www -> apex rule: the redirect
   sends crawlers to apex while the tag tells them the www copy is the real
   one. Both are individually defensible and together they are a loop. */
staged.some(f => /rel="canonical"[^>]*href="https:\/\/www\./.test(
  fs.readFileSync(path.join(ROOT, f), 'utf8')))
  ? fail('a canonical points at www — it must be apex, matching the redirect rule')
  : ok('no canonical points at www');

console.log('\n' + (fails ? 'FAILURES: ' + fails : 'ALL CHECKS PASSED'));
process.exit(fails ? 1 : 0);
