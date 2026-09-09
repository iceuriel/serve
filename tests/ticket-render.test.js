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
vm.runInContext(
  src + cut('function partnerCard(v)', 'function homeLine(') +
  '\nglobalThis.h = scheduleHead;' +
  '\nglobalThis.partnerCard = partnerCard;' +
  '\nglobalThis.seekingCard = seekingCard;', box);

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

head('C. Genuinely different lines are both kept');
t('two different facts both render',
  lines({ date: '', time: '9-11 AM', when: 'Second visit of a biweekly plan' }),
  [['tk-time', '9-11 AM'], ['tk-time', 'Second visit of a biweekly plan']]);

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
const withLogo = box.partnerCard(VEN);
const imgs = byClass(withLogo, 'tk-partner__logo');

imgs.length === 1 ? ok('one logo element') : fail('expected one logo, got ' + imgs.length);
t('it is an <img>', imgs.length ? imgs[0].tagName : null, 'img');
t('pointing at the vendor logo_url', imgs.length ? imgs[0].src : null,
  '/images/serve-wordmark.svg');
/* A broken image must still say who is coming. */
t('alt is the company name', imgs.length ? imgs[0].alt : null, 'Serve');
t('and it is lazy', imgs.length ? imgs[0].loading : null, 'lazy');

const noLogo = box.partnerCard(Object.assign({}, VEN, { logoUrl: '' }));
byClass(noLogo, 'tk-partner__logo').length === 0
  ? ok('no logo element when the vendor has no logo_url')
  : fail('an empty logo_url still rendered an <img>');
t('the name still renders', byClass(noLogo, 'tk-partner__name').length, 1);

/* Serve has one completed job. A rating of 0 must not print as 0 stars. */
const unrated = box.partnerCard(Object.assign({}, VEN, { rating: 0, reviewCount: 0 }));
/\u2605/.test(allText(unrated))
  ? fail('a zero rating printed a star')
  : ok('no star when there is no rating');

head('E. No partner yet — the coordinating state');

const seek = box.seekingCard();
const seekText = allText(seek);

/Coordinating with our vendor network/.test(seekText)
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
/setInterval|requestAnimationFrame|setTimeout/.test(
  JS.slice(JS.indexOf('function seekingCard()'), JS.indexOf('function homeLine('))
) ? fail('seekingCard drives its own animation loop')
  : ok('the animation is left to CSS');

console.log('\n' + (bad ? bad + ' FAILURES' : 'all ticket-render checks passed'));
process.exit(bad ? 1 : 0);
