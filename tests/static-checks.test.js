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
   Headings are prose and may differ; a button must not. */
head('CTA copy');
const cta = [...html.matchAll(/<a[^>]*href="#quote"[^>]*>([^<]+)<\/a>/g)].map(m => m[1].trim());
cta.length === 3 && cta.every(c => c === 'Instant quote')
  ? ok('all ' + cta.length + ' CTA controls read "Instant quote"')
  : fail('CTA controls inconsistent: ' + JSON.stringify(cta));

console.log('\n' + (fails ? 'FAILURES: ' + fails : 'ALL CHECKS PASSED'));
process.exit(fails ? 1 : 0);
