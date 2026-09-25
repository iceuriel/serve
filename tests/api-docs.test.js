/**
 * THE DOCUMENTATION MUST NOT LIE.
 *
 * /api-docs and /openapi.json are the contract Serve hands to an AI agent that
 * shops for home cleaning, and to whoever reviews a connector application. They
 * are worse than useless if they drift from the code: an agent that builds
 * against a documented field the Worker never reads gets silence, and one that
 * trusts a documented enum the engine rejects gets a wrong price.
 *
 * So nothing here is typed twice. Every claim is checked against the thing that
 * actually implements it:
 *
 *   src/worker.js          the routes, the error codes, the quote TTL
 *   pricing-engine.js      the services, conditions and cadences that exist
 *   apps-script/availability.gs   the booking horizon and the feed's cache window
 *   script.js              the query-string names the booking form really reads
 *
 * And the two documents are checked against EACH OTHER, because a spec that
 * disagrees with the prose beside it is a third thing that is wrong.
 *
 * THE OTHER HALF IS PUBLICATION. scripts/build-site.sh is an allow-list: a file
 * not named there is simply absent in production while working perfectly on a
 * local file open. A documentation URL that 404s for the audience it was
 * written for is the exact failure this repo has had before.
 */
const REPO_ROOT = require('path').resolve(__dirname, '..');
const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const read = f => fs.readFileSync(path.join(REPO_ROOT, f), 'utf8');

const HTML    = read('api-docs.html');
const SPEC    = JSON.parse(read('openapi.json'));
const WORKER  = read('src/worker.js');
const ENGINE  = read('pricing-engine.js');
const AVAIL   = read('apps-script/availability.gs');
const SITE    = read('script.js');
const BUILD   = read('scripts/build-site.sh');
const HEADERS = read('_headers');
const SITEMAP = read('sitemap.xml');
const ROBOTS  = read('robots.txt');

let bad = 0;
const t = (label, cond, extra) => {
  console.log((cond ? '  ok    ' : '  FAIL  ') + label +
              (extra !== undefined ? '  ->  ' + JSON.stringify(extra) : ''));
  if (!cond) bad++;
};

/* ============================================================
   1. IT IS ACTUALLY PUBLISHED
   ============================================================ */
console.log('=== 1. A DOCUMENT NOBODY CAN FETCH IS NOT DOCUMENTATION ===');
for (const f of ['api-docs.html', 'openapi.json']) {
  t(f + ' is in the build allow-list', BUILD.includes(f), null);
}
t('/api-docs has a cache rule in _headers', /^\/api-docs$/m.test(HEADERS));
t('   and so does its .html form, which is what the asset server resolves to',
  /^\/api-docs\.html$/m.test(HEADERS));
t('/openapi.json has one too', /^\/openapi\.json$/m.test(HEADERS));
/* A spec served as text/plain renders fine for a human and is rejected by
   every parser that matters — the kind of failure nobody notices until a
   submission is already refused. */
t('   declared application/json, not left to be guessed',
  /^\/openapi\.json$[\s\S]{0,200}?Content-Type: application\/json/m.test(HEADERS),
  HEADERS.slice(HEADERS.indexOf('/openapi.json'), HEADERS.indexOf('/openapi.json') + 160));
/* The spec is fetched by tools running on their own origin. */
t('   and readable cross-origin, or a browser-based reviewer sees nothing',
  /^\/openapi\.json$[\s\S]{0,300}?Access-Control-Allow-Origin: \*/m.test(HEADERS));
t('/api-docs is in the sitemap', SITEMAP.includes('/api-docs'));
t('robots.txt points an agent at both', ROBOTS.includes('/api-docs') &&
  ROBOTS.includes('/openapi.json'));
/* robots.txt has no field for this, so it rides in a comment. An invented
   directive could make a strict parser treat the file as malformed and drop
   the Allow line with it. */
t('   as comments, never as invented directives',
  ROBOTS.split('\n').filter(l => /servecleaning\.com\/(api-docs|openapi)/.test(l))
    .every(l => l.trim().startsWith('#')),
  ROBOTS.split('\n').filter(l => /api-docs|openapi/.test(l)));
t('and the Allow line still stands untouched', /^Allow: \/$/m.test(ROBOTS));

/* ============================================================
   2. THE ROUTES EXIST
   ============================================================ */
console.log('\n=== 2. EVERY DOCUMENTED ROUTE IS ONE THE WORKER SERVES ===');
const SPEC_PATHS = Object.keys(SPEC.paths);
t('the spec documents exactly the two public routes',
  SPEC_PATHS.length === 2 && SPEC_PATHS.includes('/api/quote') &&
  SPEC_PATHS.includes('/api/slots'), SPEC_PATHS);

for (const p of SPEC_PATHS) {
  t('the Worker routes ' + p, WORKER.includes('url.pathname === "' + p + '"'));
  t('   and the written docs name it too', HTML.includes(p));
  /* Documenting a route that is NOT cross-origin would send every agent into
     an unexplained CORS failure. */
  t('   and it is in CORS_METHODS, so a browser agent can reach it',
    new RegExp('"' + p.replace('/', '\\/') + '": "').test(WORKER), null);
}

/* The verbs must match what the route actually permits. */
t('/api/quote is documented as POST', !!SPEC.paths['/api/quote'].post);
t('/api/slots is documented as GET', !!SPEC.paths['/api/slots'].get);
const slotsMethods = (WORKER.match(/"\/api\/slots": "([^"]+)"/) || [])[1] || '';
t('   and the Worker offers GET on it, not POST',
  /GET/.test(slotsMethods) && !/POST/.test(slotsMethods), slotsMethods);

/* Nothing token-bearing or money-moving may appear in a public document. */
for (const secret of ['/api/submit', '/api/checkout', '/api/portal', '/api/vendor',
                      '/api/job', '/api/photos', '/api/stripe-webhook']) {
  t('the spec does not advertise ' + secret,
    !JSON.stringify(SPEC.paths).includes(secret), secret);
}
/* The three token-bearing surfaces, checked as whole paths rather than as
   substrings — "/j" matches inside "application/json", which made an earlier
   version of this fail for entirely the wrong reason. */
for (const surface of ['/h', '/j', '/v']) {
  t('the spec documents no operation at ' + surface,
    !SPEC_PATHS.includes(surface), SPEC_PATHS);
  t('   and neither document links it',
    !new RegExp('servecleaning\\.com' + surface + '(?![a-z-])').test(HTML) &&
    !new RegExp('servecleaning\\.com' + surface + '(?![a-z-])').test(JSON.stringify(SPEC)),
    surface);
}

/* ============================================================
   3. THE VALUES ARE THE ENGINE'S VALUES
   ============================================================ */
console.log('\n=== 3. NO DOCUMENTED VALUE THE CODE WOULD REJECT ===');

/* Read the engine's own tables rather than retyping them. Loaded whole, the
   way geo-pricing.test.js does it: PRICING's entries call priceMultiplier(),
   so slicing the declaration out on its own throws. */
const engineBox = { console: { log() {}, warn() {}, error() {} } };
vm.createContext(engineBox);
vm.runInContext(ENGINE + '\n;globalThis.__x = { PRICING, ZIP_TIERS };', engineBox);
const CONDITIONS = Object.keys(engineBox.__x.PRICING.CONDITION);
const CADENCES   = ['once'].concat(Object.keys(engineBox.__x.PRICING.FREQ));
const SERVICES   = [...new Set((ENGINE.match(/service === '([a-z_]+)'/g) || [])
  .map(s => s.replace(/.*'([a-z_]+)'.*/, '$1')))];

const props = SPEC.components.schemas.QuoteRequest.properties;
const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x));

t('the documented services are the engine\'s services',
  sameSet(props.service.enum, SERVICES), { doc: props.service.enum, engine: SERVICES });
t('the documented conditions are the engine\'s conditions',
  sameSet(props.condition.enum, CONDITIONS), { doc: props.condition.enum, engine: CONDITIONS });
t('the documented cadences are the engine\'s cadences',
  sameSet(props.frequency_selected.enum, CADENCES),
  { doc: props.frequency_selected.enum, engine: CADENCES });

for (const s of SERVICES) t('the written docs mention the service "' + s + '"', HTML.includes(s));
for (const c of CONDITIONS) t('   and the condition "' + c + '"', HTML.includes(c));

/* Every documented request field must be one the Worker actually reads off
   the body, or an agent sends it into a void. quoteScope is the honest
   source: it is what the signature is computed over. */
const SCOPE = WORKER.slice(WORKER.indexOf('function quoteScope'),
                           WORKER.indexOf('function priceFrom'));
const READS = [...new Set((SCOPE.match(/\bd\.([a-z_]+)/g) || []).map(s => s.slice(2)))];
for (const f of Object.keys(props)) {
  t('the Worker reads the documented field "' + f + '"', READS.includes(f), READS);
}

/* And the inverse: a priced field left undocumented is one an agent will
   never send, so it silently takes the default and the price is wrong. */
for (const f of READS) {
  t('the priced field "' + f + '" is documented', Object.keys(props).includes(f));
}

/* ============================================================
   4. THE ERROR CODES ARE THE WORKER'S ERROR CODES
   ============================================================ */
console.log('\n=== 4. NO INVENTED ERROR CODES, AND NONE LEFT OUT ===');
const QUOTE_FN = WORKER.slice(WORKER.indexOf('async function handleQuote'),
                              WORKER.indexOf('PAYMENT  —  POST /api/checkout'));
const THROWN = [...new Set((QUOTE_FN.match(/error: "([a-z_]+)"/g) || [])
  .map(s => s.replace(/.*"([a-z_]+)".*/, '$1')))];
const DOCUMENTED = SPEC.components.schemas.QuoteRefused.properties.error.enum;

for (const e of THROWN) {
  t('/api/quote can answer "' + e + '", and the spec says so',
    DOCUMENTED.includes(e), DOCUMENTED);
  t('   and the written docs explain it', HTML.includes(e), null);
}
for (const e of DOCUMENTED) {
  t('the documented code "' + e + '" is one the Worker can actually return',
    THROWN.includes(e), THROWN);
}

/* out_of_area is the one whose SHAPE matters: an agent must be able to tell a
   refusal from a price, and must not find a number to fall back on. */
const refusedProps = Object.keys(SPEC.components.schemas.QuoteRefused.properties);
t('the refusal schema carries no price field',
  !refusedProps.includes('price') && !refusedProps.includes('recurring'), refusedProps);
t('and the docs say plainly not to guess one',
  /no price/i.test(HTML) && /out_of_area/.test(HTML));

/* ============================================================
   5. THE NUMBERS
   ============================================================ */
console.log('\n=== 5. EVERY NUMBER IN THE PROSE IS A NUMBER IN THE CODE ===');

const leadHours = Number((AVAIL.match(/MIN_LEAD_HOURS:\s*(\d+)/) || [])[1]);
const daysAhead = Number((AVAIL.match(/DAYS_AHEAD:\s*(\d+)/) || [])[1]);
const cacheSecs = Number((AVAIL.match(/CACHE_SECONDS:\s*(\d+)/) || [])[1]);
t('read the horizon from availability.gs',
  leadHours === 18 && daysAhead === 21 && cacheSecs === 300,
  { leadHours, daysAhead, cacheSecs });

t('the docs state the real minimum lead time',
  new RegExp('\\b' + leadHours + '\\b[^.]{0,20}hours').test(HTML), leadHours);
t('the docs state the real horizon',
  new RegExp('\\b' + daysAhead + '\\b[^.]{0,20}days').test(HTML), daysAhead);
t('the spec states both too',
  SPEC.paths['/api/slots'].get.description.includes(String(leadHours)) &&
  SPEC.paths['/api/slots'].get.description.includes(String(daysAhead)));

/* The polling guidance must match the upstream's real rebuild window, or it
   is either a lie or an invitation to burn the Apps Script quota that also
   takes bookings. */
t('the documented poll interval matches CACHE_SECONDS',
  /five minutes/.test(HTML) && cacheSecs === 300, cacheSecs);
t('and the Worker enforces that same window',
  WORKER.includes('const SLOTS_UPSTREAM_CACHE_MS = 5 * 60 * 1000;'));

/* The quote signature TTL. */
const ttl = (WORKER.match(/const QUOTE_TTL_S = ([^;]+);/) || [])[1];
t('QUOTE_TTL_S is two hours', ttl && eval(ttl) === 7200, ttl);
t('and the docs say two hours', /two hours/.test(HTML));
t('and so does the spec',
  /two hours/.test(SPEC.components.schemas.Quote.properties.expires_at.description));

/* The maximum body size. */
t('the documented 10 KB body cap is the Worker\'s',
  /10_000/.test(QUOTE_FN) && /10 KB/.test(HTML));

/* ============================================================
   6. THE HANDOFF LINK REALLY WORKS
   ============================================================ */
console.log('\n=== 6. THE PREFILL PARAMETERS THE DOCS PROMISE ARE READ ===');
const READER = SITE.slice(SITE.indexOf('function readPrefillParams'),
                          SITE.indexOf('/* --- Utils --- */'));
/* Pulled out of the documented example URL rather than listed here, so the
   example itself is what gets verified. */
const example = (HTML.match(/servecleaning\.com\/\?([^<]+)#quote/) || [])[1] || '';
const exampleKeys = [...new Set(example.replace(/\s+/g, '')
  .split(/&amp;|&/).map(p => p.split('=')[0]).filter(Boolean))];
t('the documented example URL carries parameters', exampleKeys.length >= 5, exampleKeys);
for (const k of exampleKeys) {
  t('the booking form reads "' + k + '" from the query string',
    READER.includes("'" + k + "'"), k);
}
/* And every parameter named in the prose list, not only the example. */
for (const k of ['zip', 'bedrooms', 'bathrooms', 'levels', 'service',
                 'frequency', 'condition', 'addon_fridge', 'addon_oven']) {
  t('   the prose promises "' + k + '" and the form reads it',
    HTML.includes('<code>' + k + '</code>') && READER.includes("'" + k + "'"), k);
}

/* ============================================================
   7. WHAT MUST NOT BE IN A PUBLIC DOCUMENT
   ============================================================ */
console.log('\n=== 7. PRIVACY AND PROMISES ===');
/* The advice not to put a customer on a query string is load-bearing: a URL
   is logged by every network it crosses. */
t('the docs warn against putting personal data on the handoff link',
  /name, phone, email or street address/i.test(HTML));
for (const field of ['name', 'email', 'phone', 'address', 'unit']) {
  t('   and the form does not read "' + field + '" from the query string',
    !READER.includes("'" + field + "'"), field);
}
/* No secret, key or token value may appear in either document. */
for (const leak of ['sk_live', 'sk_test', 'whsec_', 'TICKET_SECRET', 'QUOTE_SECRET',
                    'PAYMENT_BRIDGE_SECRET', 'script.google.com']) {
  t('no "' + leak + '" in the public docs',
    !HTML.includes(leak) && !JSON.stringify(SPEC).includes(leak), leak);
}
/* A booking endpoint is the one thing an eager reader might assume exists. */
t('the docs say plainly there is no booking endpoint',
  /no booking (endpoint|operation)/i.test(HTML) &&
  /no booking operation/i.test(SPEC.info.description));
t('and the spec advertises no security scheme, because there is none',
  Array.isArray(SPEC.security) && SPEC.security.length === 0 &&
  Object.keys(SPEC.components.securitySchemes || {}).length === 0);
t('both documents point at the Terms',
  HTML.includes('/terms') && SPEC.info.termsOfService.endsWith('/terms'));

/* ============================================================
   8. THE TWO DOCUMENTS AGREE
   ============================================================ */
console.log('\n=== 8. THE PROSE AND THE SPEC SAY THE SAME THING ===');
t('both name the same server', SPEC.servers[0].url === 'https://servecleaning.com' &&
  HTML.includes('https://servecleaning.com/api/quote'));
t('the spec links the written docs',
  SPEC.externalDocs.url === 'https://servecleaning.com/api-docs');
t('and the written docs are canonical at that URL',
  HTML.includes('href="https://servecleaning.com/api-docs"'));
t('both say the endpoints need no key',
  /no key/i.test(HTML) && /no API key/i.test(SPEC.info.description));
t('both describe `open` as a flag rather than a capacity count',
  /not a capacity count/i.test(HTML) &&
  /not a capacity count/i.test(SPEC.components.schemas.Slot.properties.open.description));
/* The page must survive being read on a phone. */
t('the field tables can scroll rather than crushing at 390px',
  HTML.includes('api__table-wrap') && /\.api__table-wrap\s*\{[^}]*overflow-x:\s*auto/
    .test(read('style.css')));

console.log(bad ? '\n' + bad + ' FAILED' : '\nall API documentation checks passed');
process.exit(bad ? 1 : 0);
