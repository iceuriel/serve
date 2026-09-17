/* The ticket header — one line per fact, never the same fact twice.
   ==================================================================
   A booking with a confirmed slot carries a date and a window. A booking made
   on a time PREFERENCE carries neither: `start_time` and the schedule summary
   both hold the same sentence, and rendering each in turn printed it twice at
   the top of both tickets. Found in production on SRV-20260908-805851, where
   the two fields were byte-identical:

       date : ""
       time : "Later in the day (typically 12:00 PM - 5:00 PM)"
       when : "Later in the day (typically 12:00 PM - 5:00 PM)"

   This drives the real scheduleHead() out of ticket.js against a DOM shim, so
   what is asserted is the shipped function rather than a copy of its rules. */

const REPO_ROOT = require('path').resolve(__dirname, '..');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const JS = fs.readFileSync(path.join(REPO_ROOT, 'ticket.js'), 'utf8');

let bad = 0;
const t = (label, got, want) => {
  const okp = JSON.stringify(got) === JSON.stringify(want);
  console.log((okp ? '  ok    ' : '  FAIL  ') + label + '  ->  ' + JSON.stringify(got));
  if (!okp) { console.log('        expected ' + JSON.stringify(want)); bad++; }
};
const ok   = (m) => console.log('  ok    ' + m);
const fail = (m) => { console.log('  FAIL  ' + m); bad++; };
const head = (m) => console.log('\n=== ' + m + ' ===');

/* Slice the two helpers the header needs, from the real file. */
const cut = (from, to) => {
  const i = JS.indexOf(from), j = JS.indexOf(to, i);
  if (i === -1 || j === -1) throw new Error('could not slice: ' + from);
  return JS.slice(i, j);
};
const src =
  cut('function el(tag, cls, text)', 'function block(') +
  cut('function prettyDate(iso)', 'function render(d)') +
  cut('function scheduleHead(b, subParts)', '/* ========================================================\n       CLIENT');

function node(tag) {
  return {
    tagName: tag, className: '', children: [], _text: '', attrs: {},
    set textContent(v) { this._text = v; },
    get textContent() { return this._text; },
    appendChild(c) { this.children.push(c); return c; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k]; },
  };
}
const box = { document: { createElement: node }, console };
vm.createContext(box);
vm.runInContext(src + '\nglobalThis.h = scheduleHead;', box);

/* partner-card.js is a real module with a real export, so load the whole
   file rather than slicing functions out of a bigger one. What is asserted
   below is therefore the shipped file, byte for byte. */
const PC = fs.readFileSync(path.join(REPO_ROOT, 'partner-card.js'), 'utf8');
const pcBox = { document: { createElement: node }, console };
pcBox.window = pcBox;                 /* the IIFE takes `window` as its root */
vm.createContext(pcBox);
vm.runInContext(PC, pcBox);
const SP = pcBox.ServePartner;

/** The rendered header as [class, text] pairs — what a person would see. */
const lines = (b, sub) => box.h(b, sub).children.map(n => [n.className, n._text]);

/* ------------------------------------------------------------------ */
head('A. The bug: a preference booking said it twice');

const PREF = 'Later in the day (typically 12:00 PM - 5:00 PM)';
t('identical time and summary render ONCE',
  lines({ date: '', time: PREF, when: PREF }),
  [['tk-time', PREF]]);

/* Punctuation must not smuggle a duplicate through — the two fields are
   written by different code paths and one may gain a comma. */
t('and still once when punctuation differs',
  lines({ date: '', time: PREF, when: 'Later in the day — typically 12:00PM-5:00PM.' }),
  [['tk-time', PREF]]);

head('B. A confirmed slot still shows the day and the window');
t('date and time both render',
  lines({ date: '2026-09-10', time: '9-11 AM', when: '' }),
  [['tk-day', 'Thursday, Sep 10'], ['tk-time', '9-11 AM']]);

/* The summary repeats the window next to a date that already says the day. */
t('a summary that merely repeats the window is dropped',
  lines({ date: '2026-09-10', time: '9-11 AM', when: 'Thursday 10 September, 9-11 AM' }),
  [['tk-day', 'Thursday, Sep 10'], ['tk-time', '9-11 AM']]);

head('C. The schedule summary never stands beside a real time');
/* It used to. `when` is the schedule SUMMARY — prose the webhook writes for
   bookings that have no date — so beside a real time it is at best a repeat
   and at worst a contradiction. While the timezone bug was live it was the
   contradiction: the header read "Thu, Sep 17 · 12:30 AM ET · Friday,
   Sep 18 at 3:30 PM", three fields of one booking disagreeing.
   It is the fallback now, not a second opinion. */
t('a summary beside a time is dropped, even when it says something else',
  lines({ date: '', time: '9-11 AM', when: 'Second visit of a biweekly plan' }),
  [['tk-time', '9-11 AM']]);
t('and the summary is still shown when there is no time',
  lines({ date: '', time: '', when: 'Second visit of a biweekly plan' }),
  [['tk-time', 'Second visit of a biweekly plan']]);
t('a slot booking renders exactly one date and one time',
  lines({ date: '2026-09-18', time: '3:30 PM ET', when: 'Friday, Sep 18 at 3:30 PM' }),
  [['tk-day', 'Friday, Sep 18'], ['tk-time', '3:30 PM ET']]);

head('D. Nothing to say, nothing rendered');
t('an empty booking renders no lines', lines({ date: '', time: '', when: '' }), []);
t('whitespace is not a line', lines({ date: '', time: '   ', when: '' }), []);
t('a malformed date is skipped rather than shown raw',
  lines({ date: 'not-a-date', time: '9-11 AM', when: '' }), [['tk-time', '9-11 AM']]);

head('E. The subtitle');
t('sub parts join with a separator and drop empties',
  lines({ date: '', time: PREF, when: PREF }, ['First clean', '', '2 BR / 1 BA']),
  [['tk-time', PREF], ['tk-sub', 'First clean · 2 BR / 1 BA']]);
t('an all-empty sub renders no subtitle',
  lines({ date: '', time: PREF, when: PREF }, ['', null]).length, 1);

head('F. Both views share this function');
/* Two renderers building their own header is how they drift into describing
   the same booking differently. */
const calls = (JS.match(/scheduleHead\(/g) || []).length;
t('scheduleHead is defined once and called by both views', calls, 3);
/\bvar head = el\('div', 'tk-when'\)/.test(JS.replace(/function scheduleHead[\s\S]*?\n    }/, ''))
  ? fail('a renderer still builds its own header inline')
  : ok('neither renderer builds a header of its own');


/* ------------------------------------------------------------------
   The partner block: the logo, and what shows when there is no partner
   ------------------------------------------------------------------ */
const walk = (n, fn) => { fn(n); n.children.forEach(c => walk(c, fn)); };
const byClass = (n, cls) => {
  const out = [];
  walk(n, x => { if (String(x.className).split(' ').indexOf(cls) !== -1) out.push(x); });
  return out;
};
const allText = n => {
  let s = '';
  walk(n, x => { if (x._text) s += x._text + ' '; });
  return s;
};

head('D. The partner card carries the company logo');

const VEN = {
  displayName: 'Serve', logoUrl: '/images/serve-wordmark.svg',
  publicDescription: 'Our own cleaning team.', partnerSince: '2026-07-01',
  insuranceVerified: true, rating: null, reviewCount: null,
};
const withLogo = SP.card(VEN);
const imgs = byClass(withLogo, 'tk-partner__logo');

imgs.length === 1 ? ok('one logo element') : fail('expected one logo, got ' + imgs.length);
t('it is an <img>', imgs.length ? imgs[0].tagName : null, 'img');
t('pointing at the vendor logo_url', imgs.length ? imgs[0].src : null,
  '/images/serve-wordmark.svg');
/* A broken image must still say who is coming. */
t('alt is the company name', imgs.length ? imgs[0].alt : null, 'Serve');
t('and it is lazy', imgs.length ? imgs[0].loading : null, 'lazy');

const noLogo = SP.card(Object.assign({}, VEN, { logoUrl: '' }));
byClass(noLogo, 'tk-partner__logo').length === 0
  ? ok('no logo element when the vendor has no logo_url')
  : fail('an empty logo_url still rendered an <img>');
t('the name still renders', byClass(noLogo, 'tk-partner__name').length, 1);

/* The facts line, which nothing asserted until now — which is why it spent a
   release able to print a raw Date. */
const factsOf = (over) => {
  const n = byClass(SP.card(Object.assign({}, VEN, over || {})), 'tk-partner__facts');
  return n.length ? n[0]._text : '';
};

t('the relationship is a month and a year, not a day or a timestamp',
  factsOf(), 'With Serve since July 2026 · Bonded & insured');
t('a year-only partner_since is left exactly as it is',
  factsOf({ partnerSince: '2024' }), 'With Serve since 2024 · Bonded & insured');
t('a year and month needs no day to read well',
  factsOf({ partnerSince: '2026-07' }), 'With Serve since July 2026 · Bonded & insured');
/* Anything unparseable is somebody's typing, and echoing it is better than
   dropping the fact or guessing at what they meant. */
t('an unrecognised value is passed through rather than mangled',
  factsOf({ partnerSince: 'the beginning' }),
  'With Serve since the beginning · Bonded & insured');

/* A number beside Serve's own name reads as Serve's score unless it says
   otherwise, and these are borrowed from somewhere public. */
t('a borrowed rating names its source',
  factsOf({ rating: 4.8, reviewCount: 127, ratingSource: 'Google' }),
  'With Serve since July 2026 · Bonded & insured · 4.8★ (127) on Google');
t('a rating with no source claims none',
  factsOf({ rating: 4.8, reviewCount: 127 }),
  'With Serve since July 2026 · Bonded & insured · 4.8★ (127)');
t('a source without a rating says nothing at all',
  factsOf({ ratingSource: 'Google' }),
  'With Serve since July 2026 · Bonded & insured');

/* Serve has one completed job. A rating of 0 must not print as 0 stars. */
const unrated = SP.card(Object.assign({}, VEN, { rating: 0, reviewCount: 0 }));
/\u2605/.test(allText(unrated))
  ? fail('a zero rating printed a star')
  : ok('no star when there is no rating');

head('E. No partner yet — the coordinating state');

const seek = SP.seeking();
const seekText = allText(seek);

/Coordinating with our provider network/.test(seekText)
  ? ok('it says what Serve is doing')
  : fail('missing the headline: ' + seekText.slice(0, 90));
/negotiating with trusted local partners/.test(seekText)
  ? ok('and why the wait exists')
  : fail('missing the explanation');
/confirmed before your appointment/.test(seekText)
  ? fail('the old passive copy is still here')
  : ok('the old passive sentence is gone');

const marks = byClass(seek, 'tk-seek__mark');
t('the phone screen wears the Serve mark', marks.length ? marks[0].src : null,
  '/images/favicon.svg');
/* Decorative: the copy already carries the meaning, so a screen reader
   announcing "Serve logo" here would only add noise. */
t('the mark is decorative', marks.length ? marks[0].alt : null, '');

t('four arcs — two a side', byClass(seek, 'tk-seek__wave').length, 4);
t('three coins', byClass(seek, 'tk-seek__coin').length, 3);

const decor = byClass(seek, 'tk-seek__wave').concat(byClass(seek, 'tk-seek__coin'));
decor.every(n => n.attrs['aria-hidden'] === 'true')
  ? ok('every moving part is aria-hidden')
  : fail('a decorative element is exposed to screen readers');

/* The animation is CSS. A render that needed a timer would keep running on a
   backgrounded phone tab. */
/setInterval|requestAnimationFrame|setTimeout/.test(PC)
  ? fail('partner-card.js drives its own animation loop')
  : ok('the animation is left to CSS');

/* ------------------------------------------------------------------
   THE REGRESSION THIS FILE EXISTS FOR.

   The block was written into ticket.js and shipped — but the booking
   confirmation sends the PORTAL link whenever the customer has a
   contact_id, so the page customers actually open never had it. Both
   pages must render it, and both must load the file that defines it.
   ------------------------------------------------------------------ */
head('F. Both customer surfaces show who is coming');

const PORTAL_JS = fs.readFileSync(path.join(REPO_ROOT, 'portal.js'), 'utf8');
const JS_SITE   = fs.readFileSync(path.join(REPO_ROOT, 'script.js'), 'utf8');
const J_HTML    = fs.readFileSync(path.join(REPO_ROOT, 'j.html'), 'utf8');
const H_HTML    = fs.readFileSync(path.join(REPO_ROOT, 'h.html'), 'utf8');
const BUILD     = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'build-site.sh'), 'utf8');

JS.includes('ServePartner.block(')
  ? ok('the per-job ticket renders the partner block')
  : fail('ticket.js no longer renders the partner block');
PORTAL_JS.includes('ServePartner.block(')
  ? ok('the customer portal renders it too')
  : fail('portal.js does not render the partner block — the page customers open');

J_HTML.includes('partner-card.js')
  ? ok('j.html loads partner-card.js')
  : fail('j.html renders the block but never loads the file defining it');
H_HTML.includes('partner-card.js')
  ? ok('h.html loads partner-card.js')
  : fail('h.html renders the block but never loads the file defining it');

/BUILD_UNUSED/.test('') || BUILD.includes('partner-card.js')
  ? ok('and the build publishes it')
  : fail('partner-card.js is not on the build allow-list — both pages 404 it');


head('G. r35 — borrowed words and pictures of the work');

const WORKED = Object.assign({}, VEN, {
  photos: [
    { url: '/images/vendors/bh-kitchen.jpg', caption: 'Kitchen, Back Bay', sort: 1 },
    { url: '/images/vendors/bh-bath.jpg', caption: '', sort: 2 },
  ],
  reviews: [
    { quote: 'They left the kitchen spotless.', author: 'A. Tenant', source: 'Google',
      sourceUrl: 'https://example.com/r/1', rating: 5, reviewedOn: '2026-08-02' },
    { quote: 'On time twice in a row.', author: 'M. Homeowner', source: 'Their website',
      sourceUrl: '', rating: 4, reviewedOn: '2026-07-19' },
  ],
});
const worked = SP.card(WORKED);
const shots  = byClass(worked, 'tk-partner__shot');
const quotes = byClass(worked, 'tk-review');

t('every photo renders', shots.length, 2);
t('a caption becomes the alt text', shots[0].children[0].alt, 'Kitchen, Back Bay');
/* An uncaptioned photo is still content, not decoration: it must say what it
   is rather than announce itself as an empty image. */
t('an uncaptioned photo still names its subject',
  shots[1].children[0].alt, 'Work by this company');
t('and photos are lazy', shots[0].children[0].loading, 'lazy');
t('a caption also renders as a caption', shots[0].children[1].tagName, 'figcaption');
t('and an empty one adds no element', shots[1].children.length, 1);

t('every review renders', quotes.length, 2);
t('the quote is shown in quotation marks and unaltered',
  byClass(worked, 'tk-review__quote')[0]._text, '“They left the kitchen spotless.”');

const by0 = byClass(worked, 'tk-review__by')[0];
t('the author and the source are both shown',
  by0.children.map(n => n._text).join(''), 'A. Tenant · Google');
t('a source with a link is an anchor', by0.children[1].tagName, 'a');
t('pointing at the source', by0.children[1].href, 'https://example.com/r/1');
/* A ticket is a signed link. An opened tab must not reach back into it. */
t('opened safely', by0.children[1].rel, 'noopener noreferrer');

const by1 = byClass(worked, 'tk-review__by')[1];
t('a source with no link is plain text, not a dead anchor',
  by1.children[1].tagName, 'span');

/* The state every vendor starts in. */
const bare = SP.card(VEN);
t('no photo strip when there are no photos', byClass(bare, 'tk-partner__photos').length, 0);
t('no review list when there are none', byClass(bare, 'tk-partner__reviews').length, 0);


head('H. r37 — what a booking actually includes');
/* NOTE: t() in THIS file is deep equality — t(label, got, want). The one in
   portal.test.js is a boolean — t(label, cond, extra). A boolean passed here
   with no `want` compares true against undefined and fails while the thing it
   checks is perfectly correct. Every boolean below says `, true` on purpose. */
/* SERVE_SCOPE moved out of script.js so the two token-bearing pages can read
   it: they deliberately load nothing from the marketing bundle, so before this
   neither could answer "what am I getting?" without a second copy of the list.
   Driven through the real file against the same DOM shim as scheduleHead, so
   what is asserted is the shipped renderer rather than a copy of its rules. */
const SCOPE_JS = fs.readFileSync(path.join(REPO_ROOT, 'serve-scope.js'), 'utf8');
const scopeBox = { console, document: { createElement: node } };
scopeBox.window = scopeBox;
vm.createContext(scopeBox);
vm.runInContext(SCOPE_JS, scopeBox);
const SS = scopeBox.ServeScope;

const deep   = SS.forService('CLEAN_DEEP');
const recur  = SS.forService('CLEAN_STANDARD');
const movein = SS.forService('CLEAN_MOVEOUT');

t('each service reads its own column, not another one',
  JSON.stringify(recur.included) !== JSON.stringify(deep.included) &&
  JSON.stringify(movein.included) !== JSON.stringify(deep.included), true);

/* The coding the site would otherwise contradict itself on, asserted from the
   side a customer reads rather than from the matrix. */
t('the fridge is an ADD-ON on a first clean, never promised as included',
  deep.addOns.indexOf('Inside the fridge') !== -1 &&
  deep.included.indexOf('Inside the fridge') === -1, true);
t('and is included on a move-out, where the price bundles it',
  movein.included.indexOf('Inside the fridge') !== -1, true);
t('linen change is included on a recurring plan only',
  recur.included.indexOf('Linen change') !== -1 &&
  deep.included.indexOf('Linen change') === -1, true);
t('a recurring clean never promises grout scrubbing',
  recur.included.indexOf('Grout scrubbed and brightened') === -1, true);

/* An unknown code must render NOTHING. Another service's promises would be a
   promise nobody made. */
t('an unknown service yields no list at all',
  SS.forService('CLEAN_SPACESHIP') === null, true);
t('and so does a blank one', SS.forService('') === null, true);
t('and the block itself is null, so a caller adds nothing',
  SS.block('CLEAN_SPACESHIP', 'Whatever') === null, true);

/* ---- the rendered block ---- */
/* Falling back to an empty node rather than null: byClass() walks children,
   so a null block would throw before any assertion could report on it. */
const scBlock = SS.block('CLEAN_DEEP', 'First clean') || node('none');
t('it is a details element, closed until asked', scBlock.tagName, 'details');
t('the summary says what it is, in the words of their own service',
  (byClass(scBlock, 'sc__sum')[0] || {})._text, "What's included in your first clean");
const scItems = (byClass(scBlock, 'sc__list')[0] || { children: [] }).children.map(n => n._text);
t('every included task is listed', scItems.length, deep.included.length);
t('and they are the service own tasks', scItems[0], deep.included[0]);
/* Add-ons appear under their own heading. A customer reading "inside the
   fridge" under a heading that says "included" would be owed a fridge. */
t('add-ons are separated under their own heading',
  (byClass(scBlock, 'sc__h')[0] || {})._text, 'Available as paid add-ons');
t('and listed apart from the included ones',
  (byClass(scBlock, 'sc__list--addon')[0] || { children: [] }).children
    .map(n => n._text).join(', '),
  deep.addOns.join(', '));

const recurBlock = SS.block('CLEAN_STANDARD', 'Recurring clean') || node('none');
t('a service with no add-ons shows no add-on heading',
  byClass(recurBlock, 'sc__h').length, 0);

/* ---- one definition, both pages ---- */
/* Two renderers building their own version of this block is how they drift
   into describing one booking differently — the same reason scheduleHead is
   defined once. */
PORTAL_JS.includes('ServeScope.block(')
  ? ok('the customer portal calls the shared block')
  : fail('portal.js does not call ServeScope.block');
JS.includes('ServeScope.block(')
  ? ok('the per-job ticket calls it too')
  : fail('ticket.js does not call ServeScope.block');
/(function|var)\s+includedBlock/.test(PORTAL_JS + JS)
  ? fail('a page builds its own included block instead of using the shared one')
  : ok('neither page owns a copy of it');

/* Both pages must load it and the build must publish it — the exact three-way
   failure partner-card.js shipped with, where the code was right and the file
   never reached the page. */
J_HTML.includes('serve-scope.js')
  ? ok('j.html loads serve-scope.js')
  : fail('j.html renders the included list but never loads the file defining it');
H_HTML.includes('serve-scope.js')
  ? ok('h.html loads serve-scope.js')
  : fail('h.html renders the included list but never loads the file defining it');
BUILD.includes('serve-scope.js')
  ? ok('and the build publishes it')
  : fail('serve-scope.js is not on the build allow-list — every page 404s it');
/const SERVE_SCOPE = \[/.test(JS_SITE)
  ? fail('script.js still declares SERVE_SCOPE — two copies to keep in step')
  : ok('script.js reads the shared copy rather than owning one');

console.log('\n' + (bad ? bad + ' FAILURES' : 'all ticket-render checks passed'));
process.exit(bad ? 1 : 0);
