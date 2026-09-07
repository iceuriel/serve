/* Find Your Home — the address-first fast path on the booking page.
   ==================================================================
   This step sits in front of every booking, so the thing worth asserting is
   not that it works when the lookup works. It is that NOTHING it can be told
   stops a booking. A provider outage, a malformed body, a building with
   fourteen apartments in it, a home missing from public records — each has one
   correct answer, and it is "ask the questions instead".

   Three sections:
     A. the routing table          — what each response means
     B. the clamp                  — third-party numbers held inside our range
     C. the wiring                 — markup and CSS the JS assumes exist

   Section C exists because the card is built in JavaScript. A class name that
   has no rule in style.css renders as unstyled text on a live booking page and
   no test that only reads script.js would ever notice. */

const REPO_ROOT = require('path').resolve(__dirname, '..');
const path = require('path');
const fs = require('fs');
const vm = require('vm');

const JS   = fs.readFileSync(path.join(REPO_ROOT, 'script.js'), 'utf8');
const HTML = fs.readFileSync(path.join(REPO_ROOT, 'index.html'), 'utf8');
const CSS  = fs.readFileSync(path.join(REPO_ROOT, 'style.css'), 'utf8');

let bad = 0;
const t = (label, got, want) => {
  const okp = JSON.stringify(got) === JSON.stringify(want);
  console.log((okp ? '  ok    ' : '  FAIL  ') + label + '  ->  ' + JSON.stringify(got));
  if (!okp) { console.log('        expected ' + JSON.stringify(want)); bad++; }
};
const ok   = (m) => console.log('  ok    ' + m);
const fail = (m) => { console.log('  FAIL  ' + m); bad++; };
const head = (m) => console.log('\n=== ' + m + ' ===');

/* Slice the pure decision helpers out of the real file rather than copying
   them here. A copy passes forever after the original changes. */
const START = JS.indexOf('/* --- find-decisions:');
const END   = JS.indexOf('/* --- end find-decisions --- */');
if (START === -1 || END === -1) {
  throw new Error('could not slice script.js — the find-decisions markers moved');
}
const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(
  'const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v) || lo)));\n' +
  JS.slice(START, END), sandbox);
const { findRoute, findSpecs } = sandbox;

/* ------------------------------------------------------------------ */
head('A. Routing — every response has exactly one destination');

const HIT = { found: true, beds: 3, baths: 2, levels: 2 };

t('a clean match confirms',              findRoute(HIT, ''), 'confirm');
t('a clean match with a unit confirms',  findRoute({ ...HIT, unitMatched: true }, '4B'), 'confirm');

/* The fail-open set. Each of these is a real response shape the worker
   returns, and every one of them must reach the questions. */
t('no provider configured -> build',  findRoute({ found: false, reason: 'no_provider' }, ''), 'build');
t('out of area -> build',             findRoute({ found: false, reason: 'out_of_area' }, ''), 'build');
t('rate limited -> build',            findRoute({ found: false, reason: 'rate_limited' }, ''), 'build');
t('monthly cap reached -> build',     findRoute({ found: false, reason: 'cap_reached' }, ''), 'build');
t('provider unreachable -> build',    findRoute({ found: false, reason: 'provider_unreachable' }, ''), 'build');
t('no match -> build',                findRoute({ found: false, reason: 'no_match' }, ''), 'build');
t('incomplete query -> build',        findRoute({ found: false, reason: 'incomplete' }, ''), 'build');

/* Garbage in. A parse that yields something unexpected must not throw and must
   not confirm — an exception here leaves the customer on a dead step. */
t('null -> build',                    findRoute(null, ''), 'build');
t('undefined -> build',               findRoute(undefined, ''), 'build');
t('empty object -> build',            findRoute({}, ''), 'build');
t('found but no beds -> build',       findRoute({ found: true, levels: 2 }, ''), 'build');
t('found with beds:0 -> build',       findRoute({ found: true, beds: 0 }, ''), 'build');

/* THE MULTI-UNIT GUARD — the case that would otherwise quote a neighbour. */
head('A2. A street address that matched several homes');
t('ambiguous, no unit given -> ask',
  findRoute({ found: true, beds: 2, ambiguous: true, matches: 14 }, ''), 'ask');
t('ambiguous even with beds and floors present -> still ask',
  findRoute({ found: true, beds: 4, baths: 3, levels: 3, ambiguous: true, matches: 6 }, ''), 'ask');
t('still ambiguous after they gave a unit -> build, never confirm',
  findRoute({ found: true, beds: 2, ambiguous: true, matches: 14 }, '4B'), 'build');
t('unit pinned it -> confirm',
  findRoute({ found: true, beds: 2, ambiguous: false, unitMatched: true, matches: 14 }, '4B'), 'confirm');

/* ------------------------------------------------------------------ */
head('B. Clamping a third party\'s numbers');

const MAXL = 3, MAXB = 5;
const specs = (d) => findSpecs(d, MAXL, MAXB);

t('a normal home passes through',
  specs({ beds: 3, baths: 2, levels: 2, sqft: 1850 }),
  { beds: 3, baths: 2, levels: 2, sqft: 1850 });

t('7 bedrooms clamps to the overflow threshold',
  specs({ beds: 7, baths: 2, levels: 1 }).beds, MAXB);
t('5 bedrooms is left alone — it is the custom-quote trigger',
  specs({ beds: 5, baths: 2, levels: 1 }).beds, 5);
t('a 4-storey reading clamps to the stepper ceiling',
  specs({ beds: 3, baths: 2, levels: 4 }).levels, MAXL);

t('half-baths survive — the convention listings use',
  specs({ beds: 2, baths: 2.5, levels: 1 }).baths, 2.5);
t('a quarter-bath snaps onto the half-step grid',
  specs({ beds: 2, baths: 2.4, levels: 1 }).baths, 2.5);
t('0 baths floors at 1 — no home has none',
  specs({ beds: 2, baths: 0, levels: 1 }).baths, 1);

t('missing floors defaults to 1, never 0',
  specs({ beds: 2, baths: 1 }).levels, 1);
t('null floors defaults to 1',
  specs({ beds: 2, baths: 1, levels: null }).levels, 1);
t('missing sqft is null, not 0 — the card hides the row',
  specs({ beds: 2, baths: 1 }).sqft, null);
t('sqft of 0 is null, not a home with no floor area',
  specs({ beds: 2, baths: 1, sqft: 0 }).sqft, null);

/* Strings: JSON from a third party is not typed. */
t('numeric strings are coerced, not concatenated',
  specs({ beds: '3', baths: '2.5', levels: '2', sqft: '1400' }),
  { beds: 3, baths: 2.5, levels: 2, sqft: 1400 });
t('non-numeric junk degrades to the floor rather than NaN',
  specs({ beds: 'many', baths: 'two', levels: 'lots', sqft: 'big' }),
  { beds: 0, baths: 1, levels: 1, sqft: null });

/* ------------------------------------------------------------------ */
head('C1. The find step is the default, and Build is still reachable');

const findIdx  = HTML.indexOf('id="step-find"');
const buildIdx = HTML.indexOf('id="step-1"');
(findIdx !== -1 && buildIdx !== -1 && findIdx < buildIdx)
  ? ok('#step-find is present and precedes #step-1')
  : fail('#step-find must exist and come before #step-1 (find=' + findIdx + ' build=' + buildIdx + ')');

const findTag  = (HTML.match(/<div[^>]*id="step-find"[^>]*>/) || [''])[0];
const buildTag = (HTML.match(/<div[^>]*id="step-1"[^>]*>/) || [''])[0];
findTag.includes('step-active')
  ? ok('#step-find opens active')
  : fail('#step-find must carry step-active — it is the default view');
buildTag.includes('step-hidden')
  ? ok('#step-1 starts hidden')
  : fail('#step-1 must start step-hidden now that the find step is first');

/* Both steps are the same point in the customer's journey, so the progress bar
   must not jump when the fast path falls through to the questions. */
const prog = (tag) => (tag.match(/data-progress="(\d+)"/) || [])[1];
t('both steps report the same progress', [prog(findTag), prog(buildTag)], ['1', '1']);

/* The escape hatches. If either of these is gone, a lookup miss is a dead end. */
['find-skip', 'find-result', 'find-status', 'find-zip-status', 'find-submit',
 'find-address', 'find-zip', 'find-form'].forEach(id => {
  HTML.includes('id="' + id + '"') ? ok('#' + id + ' present')
                                   : fail('#' + id + ' is missing from index.html');
});

head('C2. The custom-quote lane');
['build-custom', 'overflow-notes', 'overflow-name'].forEach(id => {
  HTML.includes('id="' + id + '"') ? ok('#' + id + ' present')
                                   : fail('#' + id + ' is missing from index.html');
});
/* The scope box is the whole reason the second door is worth having: without
   it these arrive as an email address and the reply has to be a question. */
JS.includes("p.customer_notes = $('overflow-notes')")
  ? ok('the scope box is actually sent as customer_notes')
  : fail('overflow-notes is collected but never put on the payload');

head('C3. Classes the JS invents all have CSS');
/* Every class name script.js builds an element with, checked against the
   stylesheet. This is the check that catches a renamed rule: the card is
   assembled at runtime, so a class with no rule is invisible until a customer
   sees an unstyled booking form. Comments are stripped first — prose about a
   class is not a use of it. */
const jsNoComments = JS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const findRegion = jsNoComments.slice(
  jsNoComments.indexOf("const findForm   = $('find-form')"),
  jsNoComments.indexOf('STEP 1 — Build'));
if (!findRegion) throw new Error('could not isolate the find region of script.js');

const emitted = new Set();
[...findRegion.matchAll(/findEl\(\s*'[^']+'\s*,\s*'([^']+)'/g)]
  .forEach(m => m[1].split(/\s+/).forEach(c => emitted.add(c)));
[...findRegion.matchAll(/setAttribute\('class',\s*'([^']+)'\)/g)]
  .forEach(m => m[1].split(/\s+/).forEach(c => emitted.add(c)));

/* `\b` is the wrong boundary for a class name: `-` is a non-word character, so
   /\.find-house\b/ is satisfied by a rule for `.find-house-wrap`. That made
   this check pass while the rule it was guarding did not exist. The class must
   be followed by something that cannot continue it. */
const styled = (c) => new RegExp('\\.' + c + '(?![\\w-])').test(CSS);

const missing = [...emitted].filter(c => !styled(c));
missing.length ? fail('classes with no CSS rule: ' + missing.join(', '))
               : ok(emitted.size + ' classes emitted by the find step, all styled');

/* The house drawing is built with createElementNS, so its classes are set
   through setAttribute on SVG nodes and are worth naming explicitly — a
   silently unstyled SVG is a blank rectangle. */
['fh-roof', 'fh-wall', 'fh-door', 'fh-win', 'fh-lbl', 'find-house'].forEach(c => {
  styled(c) ? ok('.' + c + ' styled') : fail('.' + c + ' has no CSS rule');
});

/* ------------------------------------------------------------------ */
head('D. The house drawing');
/* The card's centrepiece, and the only part of the flow that argues with the
   customer about a number. It is drawn from a floor count with arithmetic, so
   it is worth checking the arithmetic: a viewBox that does not grow with the
   storeys clips the roof, and a rect outside it is invisible.

   It also shipped "3th" once. */
const HS = JS.indexOf('const FLOOR_ORDINAL');
const HE = JS.indexOf('function findSpec(');
if (HS === -1 || HE === -1) throw new Error('could not slice findHouse from script.js');

/* Enough of an SVG DOM to record what was drawn. */
const svgBox = {
  document: {
    createElementNS: (ns, tag) => ({
      tagName: tag, attrs: {}, children: [], _text: '',
      set textContent(v) { this._text = v; }, get textContent() { return this._text; },
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return this.attrs[k] ?? null; },
      appendChild(c) { this.children.push(c); return c; },
    }),
  },
};
vm.createContext(svgBox);
vm.runInContext(JS.slice(HS, HE) + '\nglobalThis.house = findHouse;', svgBox);

const LABELS = { 1: ['Main'], 2: ['2nd', 'Main'], 3: ['3rd', '2nd', 'Main'] };
for (let n = 1; n <= 3; n++) {
  const svg = svgBox.house(n);
  const [, , vw, vh] = svg.attrs.viewBox.split(' ').map(Number);

  t(n + '-floor labels read the way someone describes their own house',
    svg.children.filter(c => c.tagName === 'text').map(c => c.textContent), LABELS[n]);

  /* Every shape inside the canvas it declares. */
  const escapes = svg.children.filter(c => {
    if (c.tagName === 'polygon') {
      return c.attrs.points.split(' ').some(p => {
        const [px, py] = p.split(',').map(Number);
        return px < 0 || py < 0 || px > vw || py > vh;
      });
    }
    const x = Number(c.attrs.x), y = Number(c.attrs.y);
    if (Number.isNaN(x)) return false;
    return x < 0 || y < 0 || x + Number(c.attrs.width || 0) > vw
                          || y + Number(c.attrs.height || 0) > vh;
  });
  escapes.length ? fail(n + '-floor house draws outside its own viewBox: ' +
                        escapes.map(e => e.tagName).join(', '))
                 : ok(n + '-floor house fits its viewBox (' + vw + '×' + vh + ')');

  /* One wall band per storey — this is the whole point of the drawing. */
  t(n + '-floor house has ' + n + ' wall band(s)',
    svg.children.filter(c => c.attrs.class && c.attrs.class.startsWith('fh-wall')).length, n);

  /* And exactly one door, on the ground floor. */
  t(n + '-floor house has one door',
    svg.children.filter(c => c.attrs.class === 'fh-door').length, 1);

  svg.attrs['aria-label'] === n + ' floor' + (n === 1 ? '' : 's')
    ? ok(n + '-floor house is announced as "' + svg.attrs['aria-label'] + '"')
    : fail('aria-label is "' + svg.attrs['aria-label'] + '" for ' + n + ' floors');
}

/* The canvas must grow with the storeys, or a 3-floor house renders squashed
   into a 1-floor frame. */
const heights = [1, 2, 3].map(n => Number(svgBox.house(n).attrs.viewBox.split(' ')[3]));
(heights[0] < heights[1] && heights[1] < heights[2])
  ? ok('the viewBox grows with each floor: ' + heights.join(' → '))
  : fail('viewBox height does not grow with floors: ' + heights.join(', '));

console.log('\n' + (bad ? bad + ' FAILURES' : 'all find-your-home checks passed'));
process.exit(bad ? 1 : 0);
