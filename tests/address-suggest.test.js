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

  /* The limits exist and are sized for type-ahead, which fires several times
     per address rather than once. This used to compare against the property
     endpoint's allowance; that endpoint was deleted on 2026-09-08, so the
     comparison is now against absolute floors. */
  const limitSrc = Number((SRC.match(/SUGGEST_IP_PER_HOUR\s*=\s*(\d+)/) || [])[1]);
  t('a per-IP hourly limit is declared', limitSrc > 0, true);
  t('and it is sized for type-ahead, not for one call per address',
    limitSrc >= 60, true);
  const capSrc = Number((SRC.match(/SUGGEST_MONTHLY_CAP\s*=\s*(\d+)/) || [])[1]);
  t('a monthly cap is declared', capSrc > 0, true);
  /* Geoapify's free tier is 3,000/day. A monthly cap above that is not a cap. */
  t('and it sits inside the free tier', capSrc <= 3000 * 30, true);

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

  head('B2. Broad first, ZIP second — and why');
  /* MEASURED AGAINST PRODUCTION, both simpler designs are wrong.

     Filtering to the ZIP afterwards empties the list whenever the best global
     matches sit elsewhere: "100 washington st" + 02135 returned nothing.

     Appending the ZIP to the query text fixes that and breaks something worse
     — Geoapify only matches a trailing postcode once the STREET NAME IS
     COMPLETE:
         "123 beacon 02116"      -> 123 Beacon Street, Boston, 02116
         "123 beac 02116"        -> nothing at all
         "50 commonwealth 02116" -> 50 Commonwealth Avenue, Boston, 02116
         "50 comm 02116"         -> nothing at all
     A partial street name is the NORMAL state of a type-ahead, so that trade
     would break the field for most of every word typed.

     Hence: broad first, ZIP-appended only as a rescue. */

  /** A fetch that answers each call from a queue, so a two-pass run is visible. */
  const sequence = (...bodies) => {
    let i = 0;
    return async () => new Response(JSON.stringify({ results: bodies[Math.min(i++, bodies.length - 1)] }),
                                    { status: 200 });
  };
  const H = (num, street, city, pc) => ({ housenumber: num, street, city, postcode: pc });

  const firstCall = await ask('q=123 beac&zip=02116', KEYED,
    sequence([H('123', 'Beacon St', 'Boston', '02116')]));
  /text=123\+beac&/.test(firstCall.calls[0].target)
    ? ok('the first call sends the raw partial query, with no ZIP glued on')
    : fail('the first call already carries the ZIP: ' + firstCall.calls[0].target);
  t('and when it already found the ZIP, there is no second call', firstCall.calls.length, 1);

  /* The rescue: nothing in the typed ZIP, so try again with it appended. */
  const rescued = await ask('q=100 washington st&zip=02135', KEYED, sequence(
    [H('100', 'Washington St', 'Somerville', '02143')],
    [H('100', 'Washington St', 'Boston', '02135')]));
  t('a broad answer with no ZIP match triggers exactly one retry', rescued.calls.length, 2);
  /100\+washington\+st\+02135/.test(rescued.calls[1].target)
    ? ok('the retry is the one that carries the ZIP')
    : fail('the retry did not append the ZIP: ' + rescued.calls[1].target);
  t('and the retry wins when it finds the ZIP',
    rescued.body.suggestions, [{ line: '100 Washington St', city: 'Boston', zip: '02135' }]);

  /* THE REGRESSION GUARD. "123 beac 02116" returns nothing from Geoapify, so
     the rescue comes back empty — and a partial word is the normal case. The
     broad list must survive that, or the field goes blank while someone is
     mid-word. */
  const rescueEmpty = await ask('q=123 beac&zip=02116', KEYED, sequence(
    [H('123', 'Beach St', 'Boston', '02111'), H('123', 'Beacon St', 'Somerville', '02143')],
    []));
  t('an empty rescue never blanks the broad list',
    rescueEmpty.body.suggestions.length, 2);
  t('and the broad list is still ZIP-ordered',
    rescueEmpty.body.suggestions.map(s => s.zip), ['02111', '02143']);

  const noZip = await ask('q=100 washington st', KEYED, geo([]));
  t('with no ZIP typed there is only ever one call', noZip.calls.length, 1);
  /text=100\+washington\+st&/.test(noZip.calls[0].target)
    ? ok('and the text is left alone')
    : fail('a ZIP was invented: ' + noZip.calls[0].target);

  const nothingAnywhere = await ask('q=zzzz nowhere&zip=02116', KEYED, geo([]));
  t('a query that matches nothing does not retry — there is nothing to rescue',
    nothingAnywhere.calls.length, 1);

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
  /* ------------------------------------------------------------------ */
  head('B3. The unit comes off before searching');
  /* MEASURED, not guessed. 25 real condo addresses from the prospecting sheet
     were run against production on 2026-09-08:

         street alone                 100% found, all ranked first
         street + bare unit            52% found
         street + "Apt " + unit        80% found

     Geoapify handles a recognised designator and chokes on a naked number:

         "62 Winthrop St Apt 2"  ->  62 Winthrop Street
         "62 Winthrop St #2"     ->  62 Winthrop Street
         "62 Winthrop St 2"      ->  nothing at all

     Every one of those was a real customer offered no suggestions for an
     address that exists, on the shape people type most. Stripping the unit
     first is what closes the 48-point gap. */

  const sent = async (q, zip) => {
    const r = await ask('q=' + encodeURIComponent(q) + (zip ? '&zip=' + zip : ''), KEYED, geo([]));
    const text = decodeURIComponent((r.calls[0].target.match(/text=([^&]*)/) || [, ''])[1].replace(/\+/g, ' '));
    return { text, unit: r.body.unit };
  };

  const unitCases = [
    ['100 SHAWMUT AVE 907',          '100 SHAWMUT AVE',      '907'],
    ['62 Winthrop St 2',             '62 Winthrop St',       '2'],
    ['62 Winthrop St Apt 2',         '62 Winthrop St',       'Apt 2'],
    ['62 Winthrop St #2',            '62 Winthrop St',       '#2'],
    ['62 Winthrop St Unit 2',        '62 Winthrop St',       'Unit 2'],
    ['28 SWAN AVE PH',               '28 SWAN AVE',          'PH'],
    ['25 PIEDMONT ST 4 & PKG SP 7',  '25 PIEDMONT ST',       '4 & PKG SP 7'],
    ['12-14 PORTER ST 12 & 2',       '12-14 PORTER ST',      '12 & 2'],
    ['10 ROWES WHARF 802',           '10 ROWES WHARF',       '802'],
    ['735 HARRISON AVE W501/502',    '735 HARRISON AVE',     'W501/502'],
  ];
  for (const [typed, wantAddr, wantUnit] of unitCases) {
    const r = await sent(typed);
    t('"' + typed + '"', [r.text, r.unit], [wantAddr, wantUnit]);
  }

  head('B4. And streets that only LOOK like they carry a unit are left alone');
  /* The dangerous direction. Stripping a real part of a street name searches
     for an address that does not exist, and the customer never learns why.
     All four are real Boston addresses from the same sheet. */
  const untouched = [
    '4 CHARLESGATE EAST',
    '181 W FIFTH ST',
    '370 Harrison Avenue Extension',
    '21 FATHER FRANCIS GILDAY ST',
  ];
  for (const addr of untouched) {
    const r = await sent(addr);
    t('"' + addr + '" is searched whole', [r.text, r.unit], [addr, '']);
  }
  /* A query still being typed must never be split. */
  const partial = await sent('123 Bea');
  t('a partial word is left alone', [partial.text, partial.unit], ['123 Bea', '']);

  head('B5. The unit survives every path, and shares a cache entry');
  const noKey = await ask('q=' + encodeURIComponent('100 Shawmut Ave 907'), {});
  t('the unit comes back even with no provider key', noKey.body.unit, '907');

  /* Keyed on the address, so typing the unit does not cost a second lookup of
     the same street — and the unit is re-attached on the way out. */
  const kv = makeKV({});
  const first = await ask('q=' + encodeURIComponent('100 Shawmut Ave'),
    Object.assign({ PROPERTY_CACHE: kv }, KEYED),
    geo([H('100', 'Shawmut Ave', 'Boston', '02118')]));
  t('a plain address populates the cache', first.body.source, 'provider');
  const second = await ask('q=' + encodeURIComponent('100 Shawmut Ave 907'),
    Object.assign({ PROPERTY_CACHE: kv }, KEYED), geo([]));
  t('the same address WITH a unit hits that cache', second.body.source, 'cache');
  t('and still reports the unit', second.body.unit, '907');
  t('and costs no provider call', second.calls.length, 0);

  head('C. The type-ahead');

  head('C1. Markup — the combobox contract');
  const inputTag = (HTML.match(/<input[^>]*id="r-address"[^>]*>/) || [''])[0];
  /role="combobox"/.test(inputTag)      ? ok('input is a combobox')            : fail('no role="combobox"');
  /aria-expanded="false"/.test(inputTag) ? ok('starts collapsed and says so')  : fail('no aria-expanded');
  /aria-controls="r-address-list"/.test(inputTag)
    ? ok('input points at the list') : fail('aria-controls missing or wrong');
  HTML.includes('id="r-address-list"') ? ok('the list exists') : fail('no #r-address-list');
  /<ul[^>]*id="r-address-list"[^>]*role="listbox"/.test(HTML)
    ? ok('the list is a listbox') : fail('the list is not role="listbox"');
  /<ul[^>]*id="r-address-list"[^>]*\shidden/.test(HTML)
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
  const acStart = JS.indexOf('const acInput  = $(\'r-address\');');
  /* Stop at the START of the next banner comment, not at its text — slicing
     mid-comment leaves an unterminated /* and the vm refuses to parse it. */
  const nextBanner = JS.indexOf('STEP 1 — Build', acStart);
  const acEnd = nextBanner === -1 ? -1 : JS.lastIndexOf('/* ===', nextBanner);
  if (acStart === -1 || acEnd === -1) throw new Error('could not slice the type-ahead');
  const acSrc = JS.slice(acStart, acEnd);

  /* THE ZIP MUST NOT FLOW BACK. This is the assertion that guards the bug
     which rejected real Back Bay customers: a suggestion's ZIP was written
     into the form and the coverage gate refused it, because Geoapify answers
     02117 for 37 Appleton St — a PO-box ZIP nobody lives in. */
  /(findZipEl|zipInput|\$\('zip'\)|\$\('r-zip'\))\s*\.value\s*=/.test(acSrc)
    ? fail('a suggestion writes back into a ZIP field — this rejected real customers')
    : ok('no suggestion ever writes a ZIP back into the form');
  /state\.zip/.test(acSrc)
    ? ok('the ZIP is read from state, where the customer put it')
    : fail('the ZIP is not read from state — suggestions cannot be ranked');

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

  /* Choosing a suggestion fills the UNIT field when the typed text carried one
     — the one thing besides the address that a suggestion is allowed to write.
     It only fills an empty field: what someone typed there by hand wins. */
  /\$\('r-unit'\)/.test(acSrc) && /!unitEl\.value\.trim\(\)/.test(acSrc)
    ? ok('a typed unit lands in the unit field, without overwriting a typed one')
    : fail('the unit is stripped from the search and then lost');

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
    const unit   = el('input');
    const ids = { 'r-address': input, 'r-address-list': list,
                  'r-address-credit': credit, 'r-unit': unit };

    const pending = [];
    const timers = [];
    const box = {
      console,
      /* The ZIP lives in `state`, filled in step 1. The type-ahead reads it and
         never writes it — there is deliberately no ZIP element here to write
         to, so an attempt to would throw and be caught by these tests. */
      state: { zip: '02116' },
      document: { getElementById: (id) => ids[id] || null, createElement: el },
      Event: function (type) { return { type: type, bubbles: true }; },
      /* Deferred, so the test decides the order responses come back in. */
      fetch: (url) => new Promise((resolve) => pending.push({ url, resolve })),
      setTimeout: (fn) => { timers.push(fn); return timers.length; },
      clearTimeout: (i) => { if (i) timers[i - 1] = null; },
    };
    vm.createContext(box);
    vm.runInContext("const $ = (id) => document.getElementById(id);\n" + acSrc, box);

    return {
      input, list, unit, credit, pending, timers, box,
      type(v) { input.value = v; input.fire('input'); },
      /** Run every debounce timer that is still armed. */
      flush() { const due = timers.filter(Boolean); timers.length = 0; due.forEach(fn => fn()); },
      answer(i, suggestions, unitBack) {
        pending[i].resolve({ json: () => Promise.resolve(
          { suggestions, unit: unitBack || '' }) });
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
  /* A suggestion in a DIFFERENT ZIP from the one the customer gave. It must
     still be offered — the customer might have mistyped their own — but it
     must not touch the ZIP the flow already accepted. */
  c.answer(0, [S('123 Beacon St', '02143')]);
  await settle();
  const opt = c.list.children[0];
  opt.fire('mousedown', { preventDefault() {} });
  t('choosing fills the address', c.input.value, '123 Beacon St');
  t('THE CUSTOMER\'S ZIP IS UNTOUCHED, even by a suggestion that disagrees',
    c.box.state.zip, '02116');
  t('the list closes', c.list.hidden, true);
  t('and says so', c.input.attrs['aria-expanded'], 'false');
  t('focus goes back to the field', c.input._focused > 0, true);

  /* A typed unit lands in the unit field rather than being stripped and lost. */
  c = driveClient();
  c.type('100 shawmut ave 907'); c.flush();
  c.answer(0, [S('100 Shawmut Ave', '02118')], '907');
  await settle();
  c.list.children[0].fire('mousedown', { preventDefault() {} });
  t('the unit the server split out is filled in', c.unit.value, '907');

  /* And a unit typed by hand is never overwritten by one we inferred. */
  c = driveClient();
  c.unit.value = '4B';
  c.type('100 shawmut ave 907'); c.flush();
  c.answer(0, [S('100 Shawmut Ave', '02118')], '907');
  await settle();
  c.list.children[0].fire('mousedown', { preventDefault() {} });
  t('a hand-typed unit wins over an inferred one', c.unit.value, '4B');

  /* The input event that a programmatic .value change can trigger must not
     start another round trip for the string we just put there. Its own client,
     because it depends on which suggestion was last chosen — sharing one with
     the tests above made it pass or fail based on their order. */
  c = driveClient();
  c.type('123 beacon'); c.flush();
  c.answer(0, [S('123 Beacon St', '02116')]);
  await settle();
  c.list.children[0].fire('mousedown', { preventDefault() {} });
  const callsAfterChoosing = c.pending.length;
  c.type('123 Beacon St');
  c.flush();
  t('the chosen value is not queried again', c.pending.length, callsAfterChoosing);

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
