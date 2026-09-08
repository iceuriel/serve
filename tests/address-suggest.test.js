/* Address suggestions — /api/address and the type-ahead in front of it.
   ==================================================================
   The feature only ever helps: every failure renders nothing, and nothing is
   a plain text box, which is what the field was before. So what is worth
   asserting is not that suggestions appear — it is that NOTHING this can be
   told stops a booking, and that nothing it is told causes a call we should
   not pay for.

   Three sections:
     A. the endpoint     — guard order, and that every path answers the same shape
     B. the parsing      — a third party's JSON, reduced to three fields
     C. the type-ahead   — the race, the keyboard, and Enter

   Section C exists because the race is the whole problem. Keystrokes fire
   faster than responses return and responses come back out of order; the
   answer for "123 b" can land after the answer for "123 beacon". Debouncing
   makes that rarer, not impossible, and a test that only proves the debounce
   works is testing the wrong thing. */

const REPO_ROOT = require('path').resolve(__dirname, '..');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC  = fs.readFileSync(path.join(REPO_ROOT, 'src', 'worker.js'), 'utf8');
const JS   = fs.readFileSync(path.join(REPO_ROOT, 'script.js'), 'utf8');
const HTML = fs.readFileSync(path.join(REPO_ROOT, 'index.html'), 'utf8');
const ENGINE_MJS = fs.readFileSync(path.join(REPO_ROOT, 'src', 'engine.generated.mjs'), 'utf8');

let bad = 0;
const t = (label, got, want) => {
  const okp = JSON.stringify(got) === JSON.stringify(want);
  console.log((okp ? '  ok    ' : '  FAIL  ') + label + '  ->  ' + JSON.stringify(got));
  if (!okp) { console.log('        expected ' + JSON.stringify(want)); bad++; }
};
const ok   = (m) => console.log('  ok    ' + m);
const fail = (m) => { console.log('  FAIL  ' + m); bad++; };
const head = (m) => console.log('\n=== ' + m + ' ===');

/* ---- the worker, loaded the same way worker-proxy.test.js loads it ---- */
const CJS_TAIL =
  'module.exports = { lookupGeo, ZIP_GEO, PARK_ADDER, DEFAULT_GEO, computeQuote,' +
  ' serveGeo, NEUTRAL_GEO, PRICING_VERSION, PRICING, WORK_MODEL, MARGIN,' +
  ' WORK_RATE, TARGET_WAGE, zipTier, ZIP_TIERS };';

const modBox = { module: { exports: {} }, console: { log() {}, warn() {}, error() {} } };
modBox.exports = modBox.module.exports;
vm.createContext(modBox);
vm.runInContext(ENGINE_MJS.replace(/^export \{[\s\S]*?\};\s*$/m, CJS_TAIL), modBox);
const engineExports = modBox.module.exports;

const importedNames = (SRC.match(/^import\s*\{([\s\S]*?)\}\s*from[^\n]*$/m) || [, ''])[1]
  .split(',').map(s => s.trim()).filter(Boolean);
if (!importedNames.length) throw new Error('could not read the worker import list');

const runnable =
  'const __m = globalThis.__engine;\n' +
  importedNames.map(n => 'const ' + n + ' = __m.' + n + ';').join('\n') + '\n' +
  SRC.replace(/^import\s*\{[\s\S]*?\}\s*from[^\n]*\n/m, '')
     .replace(/^import[^\n]*\n/gm, '')
     .replace(/export\s+default\s*\{/, 'globalThis.__worker = {');

/** A KV good enough to exercise cache, rate limit and cap. */
function makeKV(seed) {
  const m = new Map(Object.entries(seed || {}));
  return {
    _m: m,
    get: async (k, type) => {
      if (!m.has(k)) return null;
      const v = m.get(k);
      return type === 'json' ? JSON.parse(v) : v;
    },
    put: async (k, v) => { m.set(k, String(v)); },
  };
}

function loadWorker(fetchImpl) {
  const calls = [];
  const logs = [];
  const box = {
    console: { log: (m) => logs.push(String(m)), warn: (m) => logs.push(String(m)),
               error: (m) => logs.push(String(m)) },
    AbortController, setTimeout, clearTimeout, URL, Response, Request, Headers, JSON,
    crypto: require('crypto').webcrypto, TextEncoder, TextDecoder, URLSearchParams,
    fetch: async (target, init) => { calls.push({ target: String(target), init });
                                     return fetchImpl(target, init); },
    globalThis: undefined,
    __engine: engineExports,
  };
  box.globalThis = box;
  vm.createContext(box);
  vm.runInContext(runnable, box);
  return { worker: box.__worker, calls, logs };
}

const emptyFetch = async () => new Response('{}', { status: 200 });

async function ask(query, env, fetchImpl) {
  const w = loadWorker(fetchImpl || emptyFetch);
  const res = await w.worker.fetch(
    new Request('https://servecleaning.com/api/address?' + query,
                { headers: { 'CF-Connecting-IP': '203.0.113.9' } }),
    Object.assign({ ASSETS: { fetch: async () => new Response('') } }, env || {}));
  return { res, body: JSON.parse(await res.text()), calls: w.calls, logs: w.logs };
}

/* ------------------------------------------------------------------ */
head('A. The endpoint answers one shape, on every path');

/* THE INVARIANT. Whatever happens — no key, bad ZIP, rate limit, provider
   down — the client gets {suggestions: [...]}. It renders `d.suggestions`
   directly, so a path that answered some other shape would throw in the
   browser on a field someone is mid-way through typing into. */
const KEYED = { GEOAPIFY_KEY: 'test-key' };

(async () => {
  const cases = [
    ['too short',        'q=12',                              {}],
    ['no provider key',  'q=123 beacon',                      {}],
    ['out of area',      'q=123 main&zip=90210',              KEYED],
    ['empty query',      'q=',                                KEYED],
    ['no query at all',  '',                                  KEYED],
    ['junk zip',         'q=123 beacon&zip=abc',              KEYED],
  ];
  for (const [label, qs, env] of cases) {
    const { res, body } = await ask(qs, env);
    const shapeOk = res.status === 200 && Array.isArray(body.suggestions);
    shapeOk ? ok(label + ' -> {suggestions: []}, status 200')
            : fail(label + ' answered ' + res.status + ' ' + JSON.stringify(body));
  }

  /* A short query must not reach the provider at all — that is the whole
     point of the minimum. */
  const short = await ask('q=12', KEYED);
  t('a 2-character query never calls the provider', short.calls.length, 0);
  t('and says why', short.body.reason, 'too_short');

  const away = await ask('q=123 main st&zip=90210', KEYED);
  t('an out-of-area ZIP never calls the provider', away.calls.length, 0);
  t('and says why', away.body.reason, 'out_of_area');

  const stub = await ask('q=123 beacon', {});
  t('with no key it is a stub, not an error', stub.body.reason, 'no_provider');
  t('the stub calls nothing', stub.calls.length, 0);

  /* METHOD. A POST here would be a write to a read-only endpoint. */
  const w = loadWorker(emptyFetch);
  const post = await w.worker.fetch(
    new Request('https://servecleaning.com/api/address?q=123+beacon', { method: 'POST' }),
    Object.assign({ ASSETS: { fetch: async () => new Response('') } }, KEYED));
  t('POST is refused', post.status, 405);
  t('and still answers the right shape', Array.isArray(JSON.parse(await post.text()).suggestions), true);

  head('A2. What is typed never reaches the logs');
  const logged = await ask('q=42 Wollaston Ave&zip=02135', {});
  const leaks = logged.logs.filter(l => /wollaston/i.test(l));
  leaks.length ? fail('a log line contains the typed address: ' + leaks[0])
               : ok('no log line contains the typed address');
  logged.logs.some(l => l.includes('02135'))
    ? ok('the ZIP is logged, which is enough to debug and to measure demand')
    : fail('nothing was logged at all — demand cannot be measured');

  head('A3. Caching and the spend guards');

  const cached = await ask('q=123 beacon st&zip=02116', Object.assign(
    { PROPERTY_CACHE: makeKV({ 'sug:02116:123 BEACON ST': JSON.stringify([{ line: '123 Beacon St', city: 'Boston', zip: '02116' }]) }) },
    KEYED));
  t('a cached query is served from cache', cached.body.source, 'cache');
  t('and costs no provider call', cached.calls.length, 0);

  const capped = await ask('q=99 elm st&zip=02116', Object.assign(
    { PROPERTY_CACHE: makeKV({ ['sugspend:' + new Date().toISOString().slice(0, 7)]: '999999' }) },
    KEYED));
  t('past the monthly cap it stops calling', capped.calls.length, 0);
  t('and says why', capped.body.reason, 'cap_reached');

  const hourKey = 'sugip:';
  const kvRate = makeKV({});
  /* Seed the per-IP counter the same way the worker keys it: hash of the IP
     plus the hour. Rather than reproduce the hash here, drive it by making
     enough real calls to trip the limit. */
  const limitSrc = (SRC.match(/SUGGEST_IP_PER_HOUR\s*=\s*(\d+)/) || [])[1];
  t('the per-IP hourly limit is declared', !!limitSrc, true);
  t('it is higher than the property limit — type-ahead fires more often',
    Number(limitSrc) > Number((SRC.match(/PROPERTY_IP_PER_HOUR\s*=\s*(\d+)/) || [])[1]), true);

  /* ------------------------------------------------------------------ */
  head('B. A third party\'s JSON, reduced to three fields');

  const geo = (results) => async () => new Response(JSON.stringify({ results }), { status: 200 });

  const good = await ask('q=123 beacon&zip=02116', KEYED, geo([
    { housenumber: '123', street: 'Beacon St', city: 'Boston', postcode: '02116', lat: 42.3, lon: -71.0 },
  ]));
  t('a house-level hit becomes {line, city, zip} and nothing else',
    good.body.suggestions, [{ line: '123 Beacon St', city: 'Boston', zip: '02116' }]);

  /* COORDINATES MUST NOT COME BACK. They are of no use in a form and they
     would sit in a browser network log beside a home address. */
  t('no coordinates leak through',
    Object.keys(good.body.suggestions[0]).sort(), ['city', 'line', 'zip']);

  /* A street-level hit looks like a real suggestion, fills the box with
     something /api/property cannot match, and turns a working fallback into
     a dead end. */
  const streetOnly = await ask('q=beacon&zip=02116', KEYED, geo([
    { street: 'Beacon St', city: 'Boston', postcode: '02116' },
    { housenumber: '9', street: 'Beacon St', city: 'Boston', postcode: '02116' },
  ]));
  t('a hit with no house number is dropped',
    streetOnly.body.suggestions, [{ line: '9 Beacon St', city: 'Boston', zip: '02116' }]);

  /* THE TYPED ZIP ORDERS THE LIST, IT DOES NOT CENSOR IT.
     This asserted the opposite until 2026-09-08, and the opposite was wrong in
     a way only real data showed: the endpoint asks for N results across the
     whole rectangle, so filtering to the ZIP afterwards throws away the entire
     list whenever the best global matches sit in other ZIPs. Measured against
     production, "100 washington st" + 02135 returned NOTHING — Greater Boston
     has a Washington Street in a dozen ZIPs and none of the top hits was in
     Brighton.

     Dropping a mismatch also assumes the ZIP is right and the geocoder wrong,
     and it is the other way round often enough to matter. Picking a suggestion
     overwrites the ZIP field, so a mismatch corrects itself; an empty list
     corrects nothing. */
  const wrongZip = await ask('q=123 beacon&zip=02116', KEYED, geo([
    { housenumber: '123', street: 'Beacon St', city: 'Somerville', postcode: '02143' },
    { housenumber: '123', street: 'Beacon St', city: 'Boston', postcode: '02116' },
  ]));
  t('a hit in the typed ZIP is ranked first, even when the provider ranked it second',
    wrongZip.body.suggestions.map(s => s.zip), ['02116', '02143']);
  t('and the mismatch is kept, not discarded', wrongZip.body.suggestions.length, 2);

  const noneInZip = await ask('q=100 washington st&zip=02135', KEYED, geo([
    { housenumber: '100', street: 'Washington St', city: 'Somerville', postcode: '02143' },
    { housenumber: '100', street: 'Washington St', city: 'Boston', postcode: '02121' },
  ]));
  t('when nothing matches the ZIP the list is still offered, never emptied',
    noneInZip.body.suggestions.length, 2);

  /* And the ZIP is handed to the provider so it can rank properly at source,
     rather than being applied here after the ranking is already lost. */
  const texted = await ask('q=100 washington st&zip=02135', KEYED, geo([]));
  /100\+washington\+st\+02135|100%20washington%20st%2002135/.test(texted.calls[0].target)
    ? ok('the ZIP is sent as part of the query text, where it can affect ranking')
    : fail('the ZIP never reaches the provider: ' + texted.calls[0].target);

  const noZip = await ask('q=100 washington st', KEYED, geo([]));
  /text=100\+washington\+st&/.test(noZip.calls[0].target)
    ? ok('with no ZIP typed, the text is left alone')
    : fail('a ZIP was invented: ' + noZip.calls[0].target);

  const dupes = await ask('q=5 elm&zip=02116', KEYED, geo([
    { housenumber: '5', street: 'Elm St', city: 'Boston', postcode: '02116' },
    { housenumber: '5', street: 'Elm St', city: 'Boston', postcode: '02116' },
    { housenumber: '5', street: 'elm st',  city: 'Boston', postcode: '02116' },
  ]));
  t('duplicates collapse, case-insensitively', dupes.body.suggestions.length, 1);

  const many = await ask('q=1 a&zip=02116', KEYED, geo(
    Array.from({ length: 20 }, (_, i) => ({ housenumber: String(i + 1), street: 'A St',
                                            city: 'Boston', postcode: '02116' }))));
  const limit = Number((SRC.match(/SUGGEST_LIMIT\s*=\s*(\d+)/) || [])[1]);
  t('the list is capped at SUGGEST_LIMIT', many.body.suggestions.length, limit);

  /* Both documented response shapes. Reading only one and being handed the
     other is a silent empty list — a working key, a paid call per keystroke,
     and a field that looks broken. */
  const asGeoJson = await ask('q=123 beacon&zip=02116', KEYED, async () => new Response(
    JSON.stringify({ features: [{ properties: { housenumber: '123', street: 'Beacon St',
                                                city: 'Boston', postcode: '02116' } }] }), { status: 200 }));
  t('the geojson shape is understood too',
    asGeoJson.body.suggestions, [{ line: '123 Beacon St', city: 'Boston', zip: '02116' }]);

  /* Garbage in. None of these may throw — the visitor is mid-keystroke. */
  const junk = [
    ['not json',        async () => new Response('<html>nope</html>', { status: 200 })],
    ['a 500',           async () => new Response('{}', { status: 500 })],
    ['a null body',     async () => new Response('null', { status: 200 })],
    ['results not an array', async () => new Response('{"results":"nope"}', { status: 200 })],
    ['null entries',    geo([null, undefined, {}])],
    ['a thrown fetch',  async () => { throw new Error('socket hang up'); }],
  ];
  for (const [label, impl] of junk) {
    const r = await ask('q=123 beacon&zip=02116', KEYED, impl);
    (r.res.status === 200 && Array.isArray(r.body.suggestions) && r.body.suggestions.length === 0)
      ? ok(label + ' -> empty list, no throw')
      : fail(label + ' -> ' + r.res.status + ' ' + JSON.stringify(r.body));
  }

  /* The provider is asked for Greater Boston and nowhere else. */
  const boxed = await ask('q=123 beacon&zip=02116', KEYED, geo([]));
  const url = boxed.calls[0] ? boxed.calls[0].target : '';
  /rect%3A|rect:/.test(url) ? ok('the provider call is bounded to a rectangle')
                            : fail('no geographic filter on the provider call: ' + url);
  /type=/.test(url) ? fail('a `type` filter is set — `street` would exclude house numbers')
                    : ok('no `type` filter, so house-level hits are allowed through');
  url.includes('test-key') ? ok('the key is sent server-side, never to the browser')
                           : fail('the provider call carries no key');

  /* ------------------------------------------------------------------ */
  head('C. The type-ahead');

  head('C1. Markup — the combobox contract');
  const inputTag = (HTML.match(/<input[^>]*id="find-address"[^>]*>/) || [''])[0];
  /role="combobox"/.test(inputTag)      ? ok('input is a combobox')            : fail('no role="combobox"');
  /aria-expanded="false"/.test(inputTag) ? ok('starts collapsed and says so')  : fail('no aria-expanded');
  /aria-controls="find-address-list"/.test(inputTag)
    ? ok('input points at the list') : fail('aria-controls missing or wrong');
  HTML.includes('id="find-address-list"') ? ok('the list exists') : fail('no #find-address-list');
  /<ul[^>]*id="find-address-list"[^>]*role="listbox"/.test(HTML)
    ? ok('the list is a listbox') : fail('the list is not role="listbox"');
  /<ul[^>]*id="find-address-list"[^>]*\shidden/.test(HTML)
    ? ok('the list is hidden in the markup, not only by script')
    : fail('the list would flash open before script.js runs');

  /* Browser autofill must be off, or Chrome stacks its own saved-address
     dropdown on top of ours — two lists, one field. */
  /autocomplete="off"/.test(inputTag)
    ? ok('browser autofill is off, so only one dropdown can appear')
    : fail('autocomplete is not "off" — the browser will stack its own list');

  /* Geoapify's free tier requires the credit. It is a licence term, not a
     preference. */
  HTML.includes('Geoapify') ? ok('the required attribution is present')
                            : fail('Geoapify attribution is missing — the free tier requires it');

  head('C2. Behaviour — the real client code');
  const acStart = JS.indexOf('const acInput  = $(\'find-address\');');
  const acEnd   = JS.indexOf('if (findForm) {', acStart);
  if (acStart === -1 || acEnd === -1) throw new Error('could not slice the type-ahead');
  const acSrc = JS.slice(acStart, acEnd);

  /* THE RACE. Asserted directly rather than trusted to the debounce. */
  /const mine = \+\+acSeq/.test(acSrc) && /if \(mine !== acSeq\) return;/.test(acSrc)
    ? ok('every response is checked against a sequence number before it renders')
    : fail('nothing discards a stale response — an old answer can overwrite a newer one');

  /mousedown/.test(acSrc)
    ? ok('options are taken on mousedown, so blur cannot close the list first')
    : fail('a click on a suggestion would be swallowed by the input blur');

  /* Enter must only be swallowed when something is highlighted. Someone who
     typed their address in full and pressed Enter is done. */
  /if \(acActive >= 0\) \{ e\.preventDefault\(\); acChoose\(acActive\); \}/.test(acSrc)
    ? ok('Enter only cancels the submit when a suggestion is highlighted')
    : fail('Enter may be swallowed with nothing selected — the form would look broken');

  ['ArrowDown', 'ArrowUp', 'Escape', 'Tab'].forEach(k =>
    acSrc.includes("'" + k + "'") ? ok(k + ' is handled') : fail(k + ' is not handled'));

  /aria-activedescendant/.test(acSrc)
    ? ok('the highlight is announced, not only painted')
    : fail('arrow keys move a highlight no screen reader can follow');

  /* Choosing a suggestion has to DISPATCH the zip input event, not just set
     .value — the handler is what runs the coverage check and paints the tick. */
  /dispatchEvent\(new Event\('input'/.test(acSrc)
    ? ok('filling the ZIP fires its handler, so coverage is re-checked')
    : fail('the ZIP is set silently — the coverage tick would not appear');

  head('C2b. The race, actually run');
  /* Everything above reads the source. This runs it. A regex proving the file
     CONTAINS a sequence check is not the same as proving a stale answer gets
     discarded, and the difference is the bug. */

  function el(tag) {
    return {
      tagName: tag, attrs: {}, children: [], handlers: {}, value: '', hidden: false,
      className: '', id: '', _text: '', _focused: 0,
      set textContent(v) { this._text = v; this.children = []; },
      get textContent() { return this._text; },
      appendChild(c) { this.children.push(c); return c; },
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
      removeAttribute(k) { delete this.attrs[k]; },
      addEventListener(e, fn) { (this.handlers[e] = this.handlers[e] || []).push(fn); },
      dispatchEvent(ev) { (this.handlers[ev.type] || []).forEach(fn => fn(ev)); return true; },
      focus() { this._focused++; },
      classList: { add() {}, remove() {}, toggle() {} },
      querySelectorAll(sel) {
        return sel === '.ac__opt' ? this.children.filter(c => c.className === 'ac__opt') : [];
      },
      fire(e, ev) { (this.handlers[e] || []).forEach(fn => fn(ev || {})); },
    };
  }

  function driveClient() {
    const input  = el('input');
    const list   = el('ul');
    const credit = el('p');
    const zip    = el('input');
    zip.value = '02116';
    const ids = { 'find-address': input, 'find-address-list': list,
                  'find-address-credit': credit, 'find-zip': zip };

    const pending = [];
    const timers = [];
    const box = {
      console,
      document: { getElementById: (id) => ids[id] || null, createElement: el },
      Event: function (type) { return { type: type, bubbles: true }; },
      /* Deferred, so the test decides the order responses come back in. */
      fetch: (url) => new Promise((resolve) => pending.push({ url, resolve })),
      setTimeout: (fn) => { timers.push(fn); return timers.length; },
      clearTimeout: (i) => { if (i) timers[i - 1] = null; },
    };
    vm.createContext(box);
    vm.runInContext(
      "const $ = (id) => document.getElementById(id);\n" +
      "const findZipEl = $('find-zip');\n" + acSrc, box);

    return {
      input, list, zip, credit, pending, timers,
      type(v) { input.value = v; input.fire('input'); },
      /** Run every debounce timer that is still armed. */
      flush() { const due = timers.filter(Boolean); timers.length = 0; due.forEach(fn => fn()); },
      answer(i, suggestions) {
        pending[i].resolve({ json: () => Promise.resolve({ suggestions }) });
      },
      lines() { return list.children.map(c => (c.children[0] || {})._text); },
    };
  }

  /* Drain the microtask queue completely. Counting `await` turns by hand was
     wrong: the chain is fetch -> .then -> r.json() -> .then, and being one
     turn short made an assertion read the state BEFORE the render rather than
     after it — which looked like a render failure and was a test bug. */
  const settle = () => new Promise(r => setImmediate(r));

  const S = (n, z) => ({ line: n, city: 'Boston', zip: z || '02116' });

  /* --- the race --- */
  let c = driveClient();
  c.type('123 b');   c.flush();
  c.type('123 beacon'); c.flush();
  t('two keystrokes, two requests', c.pending.length, 2);

  /* Resolve them BACKWARDS: the newest first, then the stale one. */
  c.answer(1, [S('123 Beacon St')]);
  await settle();
  c.answer(0, [S('123 B St'), S('123 Bay St')]);
  await settle();
  t('the stale answer is discarded, the newest one stands',
    c.lines(), ['123 Beacon St']);

  /* And the ordinary direction still works. */
  c = driveClient();
  c.type('99 elm'); c.flush();
  c.answer(0, [S('99 Elm St')]);
  await settle();
  t('a normal in-order answer renders', c.lines(), ['99 Elm St']);
  t('the list opens', c.list.hidden, false);
  t('and says so', c.input.attrs['aria-expanded'], 'true');
  t('the attribution appears once a suggestion has been shown', c.credit.hidden, false);

  /* --- the guards that save calls --- */
  c = driveClient();
  c.type('12'); c.flush();
  t('two characters never fetch', c.pending.length, 0);

  c = driveClient();
  c.type('1'); c.type('12'); c.type('123'); c.type('123 b');
  t('typing fast arms a timer but has not fetched yet', c.pending.length, 0);
  c.flush();
  t('only the last keystroke fetches', c.pending.length, 1);

  /* --- choosing a suggestion --- */
  c = driveClient();
  c.type('123 beacon'); c.flush();
  c.answer(0, [S('123 Beacon St', '02143')]);
  await settle();
  const opt = c.list.children[0];
  opt.fire('mousedown', { preventDefault() {} });
  t('choosing fills the address', c.input.value, '123 Beacon St');
  t('choosing fills the ZIP from the suggestion', c.zip.value, '02143');
  t('the list closes', c.list.hidden, true);
  t('and says so', c.input.attrs['aria-expanded'], 'false');
  t('focus goes back to the field', c.input._focused > 0, true);

  /* The input event that a programmatic .value change can trigger must not
     start another round trip for the string we just put there. */
  c.type('123 Beacon St');
  c.flush();
  t('the chosen value is not queried again', c.pending.length, 1);

  head('C3. Styled');
  const CSS = fs.readFileSync(path.join(REPO_ROOT, 'style.css'), 'utf8');
  ['ac', 'ac__list', 'ac__opt', 'ac__line', 'ac__where', 'ac__credit'].forEach(c =>
    new RegExp('\\.' + c + '(?![\\w-])').test(CSS) ? ok('.' + c + ' styled')
                                                   : fail('.' + c + ' has no CSS rule'));
  /\.ac__list\[hidden\]\s*\{\s*display:\s*none/.test(CSS)
    ? ok('[hidden] is enforced against the absolute positioning')
    : fail('.ac__list[hidden] has no explicit display:none — it may render anyway');

  console.log('\n' + (bad ? bad + ' FAILURES' : 'all address-suggest checks passed'));
  process.exit(bad ? 1 : 0);
})();
