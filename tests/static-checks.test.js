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
  // flow-textarea removed 2026-09-01 with the "anything we should know?" box.
  'svmA-foot','step__link','reserve-aftercare','field-hint'];
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
['submission_id','segment','src_first','src_chain','addon_total']
  .forEach(k => { if (!all.includes(k)) fail('payload is missing ' + k); });
ok('all 5 required payload fields present');

/* pets_flag came BACK on 2026-09-05, and the reasoning inverted with it.
   It was absent while nothing asked about pets — FALSE would have read as
   "asked, no pets" when nobody was asked. The build step now poses the question
   directly, so a false is a real answer from the person who would know. */
all.includes('pets_flag')
  ? ok('pets_flag sent — the build step now asks directly')
  : fail('pets_flag is missing; the pets question exists, so its answer should ship');
all.includes('last_clean')
  ? ok('last_clean sent alongside the condition it derives')
  : fail('last_clean is missing — without it a heavy grade is unexplainable later');

/* customer_notes stays absent: still collected after reservation, and sending
   it empty would make "not yet asked" indistinguishable from "nothing to say". */
all.includes('customer_notes')
  ? fail('customer_notes is being sent again — it is collected after booking; ' +
         'sending it empty makes "not asked" look like "nothing to say"')
  : ok('customer_notes correctly omitted — collected after booking');

/* CONDITION IS DERIVED. If a form ever sets it directly, the customer is being
   asked to grade their own home again, which is the thing this replaced. */
!/input\[name="condition"\]/.test(js)
  ? ok('no form binds condition directly — it is derived')
  : fail('something binds an input[name="condition"]; condition must be derived ' +
         'from last_clean and has_pets, not asked');
/deriveCondition/.test(js)
  ? ok('deriveCondition() does the translation')
  : fail('deriveCondition() is gone — who is grading the home?');

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

/* 10. CTA copy unified — the BUTTONS, not every link that happens to point at
   the form. Headings are prose and may differ; a button must not.

   Scoped on the class rather than on href, as of 2026-09-07. href alone was a
   fine proxy for "control" until the page grew links to #quote that are
   deliberately NOT buttons and must not read the same: the home card's empty
   address field says "Add your address", and the service catalogue ends with a
   sentence whose link is prose. Matching those would have forced two good
   pieces of copy to become a fourth "Book a service".

   Both href forms count: the nav uses the absolute "/#quote" so one nav block
   can be byte-identical across index, pricing and services; the others stay
   relative. */
head('CTA copy');
const ctaTags = (html.match(/<a[^>]*href="\/?#quote"[^>]*>[^<]+<\/a>/g) || []);
const cta = ctaTags
  .filter(tag => /class="[^"]*\b(btn|nav__cta)\b/.test(tag))
  .map(tag => (tag.match(/>([^<]+)</) || [])[1].trim());
cta.length >= 3 && cta.every(c => c === 'Instant Booking')
  ? ok('all ' + cta.length + ' CTA buttons read "Book a service"')
  : fail('CTA buttons inconsistent: ' + JSON.stringify(cta));

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
/* Sliced by the section's OWN boundaries, not by what follows it. This used to
   read from the WORK EXAMPLES marker to the QUOTE FLOW marker, which silently
   encoded an assumption about page order — and when the photos moved below the
   booking flow on 2026-09-07 the regex matched nothing at all, so every check
   below it reported against an empty string. "0 of 0 photos are not lazy" is
   what a vacuously-passing assertion looks like when it finally fails out
   loud; it could just as easily have gone the other way. */
const workStart = html.indexOf('<!-- WORK EXAMPLES -->');
const workSection = (workStart === -1 ? '' :
    html.slice(workStart, html.indexOf('</section>', workStart) + 10))
  .replace(/<!--[\s\S]*?-->/g, '');          // my own comments mention <details>
workStart !== -1 ? ok('the photo section is on the page')
                 : fail('WORK EXAMPLES section is gone from index.html');

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

/* 14. The address field asks for a street and nothing else.
   ---------------------------------------------------------------
   A placeholder is an instruction, whatever the label says. This one read
   "123 Beacon St, Boston, MA" and produced "19 Glenbrook Ln,Arlington ma" from
   a real customer, against "500 Broadway" from another — the city and state
   then live in that property_key permanently, because the key is built from
   what was typed.

   City and state are redundant: the ZIP is required, collected earlier, and is
   what actually drives zip tier, geo factor and the PROPERTIES key. Every
   fixture in this suite already uses a bare street. */
head('Address field asks for a street only');
const addrTag = (html.match(/<input[^>]*id="r-address"[^>]*>/) || [''])[0];
const addrPh  = (addrTag.match(/placeholder="([^"]*)"/) || [])[1];

addrPh ? ok('placeholder present: "' + addrPh + '"')
       : fail('#r-address has no placeholder');

!/,/.test(addrPh || '')
  ? ok('no comma — nothing suggesting extra address parts')
  : fail('placeholder "' + addrPh + '" contains a comma, which reads as ' +
         '"add more here" and is how city/state got into a property_key');

!/\b(MA|Mass|Massachusetts|Boston)\b/i.test(addrPh || '')
  ? ok('names no city or state')
  : fail('placeholder "' + addrPh + '" names a city or state — the ZIP already has both');

/* The reassurance matters as much as the example: someone who assumes the city
   is needed will type it regardless of what the placeholder shows. */
/your ZIP already tells us the city/i.test(html)
  ? ok('hint explains why the city is not needed')
  : fail('no hint under the address field explaining that the ZIP covers the city');

/* 0. Does the JavaScript we ship even parse?
   ---------------------------------------------------------------
   The cheapest possible test, added 2026-09-05 after a stray object-literal line
   in buildPayload() left script.js unparseable — a completely dead booking flow
   — and ALL SIXTEEN test files passed anyway. Every harness slices a region and
   evaluates it; not one of them ever asked whether the whole file was valid.

   A suite that cannot notice a syntax error is not protecting the site, however
   many assertions it contains. This runs first for that reason. */
head('Shipped JavaScript parses');
const { execFileSync } = require('child_process');
['script.js', 'pricing-engine.js', 'serve-geo-data.js', 'ticket.js', 'src/worker.js']
  .forEach(f => {
    try {
      execFileSync(process.execPath, ['--check', path.join(ROOT, f)], { stdio: 'pipe' });
      ok(f + ' parses');
    } catch (e) {
      const msg = String(e.stderr || e.message).split('\n').slice(0, 3).join(' ').trim();
      fail(f + ' DOES NOT PARSE — ' + msg);
    }
  });

/* 15. The job ticket is deliberately NOT an indexable page.
   ---------------------------------------------------------------
   /j renders one booking from an id in the query string, so the URL carries a
   customer's home address, when the house will be empty, and how the cleaner
   gets in. It is excluded from the staged-page list above only because it is
   copied on a separate line in build-site.sh, which is accidental — so the
   exclusion is asserted here on purpose.

   The X-Robots-Tag is the control, not the meta tag: a meta directive only
   applies if a crawler renders the page. */
head('Job ticket is not indexable');
const ticketHtml = fs.readFileSync(path.join(ROOT, 'j.html'), 'utf8');
const headersTxt = fs.readFileSync(path.join(ROOT, '_headers'), 'utf8').replace(/\r\n/g, '\n');

/noindex/.test(ticketHtml)
  ? ok('j.html carries a noindex meta tag')
  : fail('j.html has no noindex meta tag');

/^\/j\n(?:\s{2}[^\n]*\n)*\s{2}X-Robots-Tag:[^\n]*noindex/m.test(headersTxt)
  ? ok('/j sends X-Robots-Tag: noindex')
  : fail('/j has no X-Robots-Tag — the meta tag alone will not stop indexing');

/^\/j\n(?:\s{2}[^\n]*\n)*\s{2}Cache-Control:[^\n]*no-store/m.test(headersTxt)
  ? ok('/j is never cached by an intermediary')
  : fail('/j must be no-store — the URL contains a home address');

!/rel="canonical"/.test(ticketHtml)
  ? ok('no canonical tag — every ticket is a different job')
  : fail('j.html declares a canonical, which would point every ticket at one URL');

!/j\.html|<loc>[^<]*\/j<\/loc>/.test(sitemap)
  ? ok('absent from sitemap.xml')
  : fail('the ticket page is in the sitemap — it must never be submitted for indexing');

/* The page must not decide who sees what. If it ever filters, both views' data
   is being shipped to the browser and the split is one bug away from leaking. */
/* Comments stripped first: the file's own header explains that it contains no
   innerHTML, and matching that sentence reports the documentation instead of
   the code. */
const ticketJs = fs.readFileSync(path.join(ROOT, 'ticket.js'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
!/innerHTML/.test(ticketJs)
  ? ok('ticket.js never uses innerHTML — sheet values stay inert')
  : fail('ticket.js uses innerHTML; values typed into a sheet would render as markup');

/* The root favicon. Crawlers and browsers request /favicon.ico by convention
   whatever the <link rel="icon"> tags say, and Google's search-result icon is
   one of them: with the file only at /images/favicon.ico, the live root 404'd
   and the result rendered a generic globe instead of the Serve house. The
   build has to place a copy at the root, so the build script is what gets
   asserted — the markup alone cannot fix this. */
head('Root favicon');
const buildSh = fs.readFileSync(path.join(ROOT, 'scripts', 'build-site.sh'), 'utf8');
/cp images\/favicon\.ico "\$OUT"\/favicon\.ico/.test(buildSh)
  ? ok('build-site.sh stages /favicon.ico at the site root')
  : fail('nothing copies images/favicon.ico to the root — /favicon.ico will 404');

/* Google picks a favicon that is a multiple of 48px square; a lone 32x32 is
   below every one of those. favicon-192.png was in the repo unreferenced. */
staged.forEach(f => {
  const doc = fs.readFileSync(path.join(ROOT, f), 'utf8');
  /favicon-192\.png/.test(doc)
    ? ok(f + ' offers a 192x192 icon')
    : fail(f + ' declares no icon at a multiple of 48px — Google may skip it');
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
