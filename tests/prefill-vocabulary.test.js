/**
 * THE DEEP LINK AND THE QUOTE API MUST SPEAK ONE LANGUAGE.
 *
 * Serve has two agent-facing surfaces that describe the same home:
 *
 *   POST /api/quote        bedrooms, bathrooms, service=first_clean|move_out,
 *                          frequency_selected, condition, addon_fridge, ...
 *   GET  /?…#quote         the booking form, prefilled from the query string
 *
 * They were built years apart in project time and did NOT agree. The link
 * spoke `beds`, `baths` and `service=deep|recurring|moveinout`; the API spoke
 * `bedrooms`, `bathrooms` and `service=first_clean|move_out`. An agent that
 * priced a home through the API and then built a follow-on link out of the
 * words it had just learned got a page that LOADED AND IGNORED EVERY ONE OF
 * THEM — no error, nothing in a console, just a form that had forgotten what
 * the agent had told the customer thirty seconds earlier. Found 2026-09-25
 * while writing the Muse connector application.
 *
 * So this file runs the REAL prefill code sliced out of script.js against a
 * fake DOM, feeds it query strings in both vocabularies, and asserts the
 * resulting form state. The point is not that the parser works — it is that
 * the two surfaces cannot drift apart again without this going red, which is
 * why the API's field names are read out of src/worker.js rather than typed
 * here a second time.
 */
const REPO_ROOT = require('path').resolve(__dirname, '..');
const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const SITE   = fs.readFileSync(path.join(REPO_ROOT, 'script.js'), 'utf8');
const WORKER = fs.readFileSync(path.join(REPO_ROOT, 'src', 'worker.js'), 'utf8');

let bad = 0;
const t = (label, cond, extra) => {
  console.log((cond ? '  ok    ' : '  FAIL  ') + label +
              (extra !== undefined ? '  ->  ' + JSON.stringify(extra) : ''));
  if (!cond) bad++;
};

/* ============================================================
   HARNESS — the real prefill block, a fake form
   ============================================================ */
const FROM = SITE.indexOf('    const PREFILL_SERVICES = {');
const END  = SITE.indexOf('    /* --- Utils --- */');
if (FROM === -1 || END === -1) throw new Error('could not slice the prefill block');
const SLICE = SITE.slice(FROM, END);

/* Radio groups as the booking form actually declares them. A value absent
   here is a value the real page has no control for, so pickRadio must miss it
   exactly as it would in a browser. */
const RADIOS = {
  service:    ['first_clean', 'move_out'],
  last_clean: ['recent', 'months', 'long'],
  has_pets:   ['yes', 'no'],
};

/**
 * Runs the prefill block against `search` and hands back the resulting state.
 * `init` seeds the form as the visitor might already have left it — which is
 * the only way to test that an UNMENTIONED field is left alone rather than
 * quietly reset to a default that happens to match.
 */
function run(search, init) {
  const state = Object.assign({
    zip: '', tier: 'core', bedrooms: 1, bathrooms: 1, levels: 1,
    service: 'first_clean', frequency: 'once', condition: 'standard',
    lastClean: null, hasPets: false, addonFridge: false, addonOven: false,
  }, init || {});
  const views = [];
  const checked = { service: 'first_clean', last_clean: null, has_pets: null };

  /* Rebuilt on demand so `checked` and the elements never disagree. */
  const radio = (name, value) => ({
    get checked() { return checked[name] === value; },
    set checked(v) { if (v) checked[name] = value; },
    dispatchEvent() {
      if (name === 'service')    { state.service = value; syncAddonsToService(); }
      if (name === 'last_clean') { state.lastClean = value; derive(); }
      if (name === 'has_pets')   { state.hasPets = value === 'yes'; derive(); }
      return true;
    },
  });

  /* The real mapping, copied from script.js's CONDITION_FROM. Kept honest by
     an assertion further down that reads the table out of the source. */
  const CONDITION_FROM = {
    recent: { no: 'light',    yes: 'standard' },
    months: { no: 'standard', yes: 'standard' },
    long:   { no: 'heavy',    yes: 'heavy'    },
  };
  function derive() {
    const row = CONDITION_FROM[state.lastClean || 'months'] || CONDITION_FROM.months;
    state.condition = row[state.hasPets ? 'yes' : 'no'] || 'standard';
  }
  function syncAddonsToService() {
    if (state.service === 'first_clean') return;
    state.addonFridge = false; state.addonOven = false;
    box.addonFridge.checked = false; box.addonOven.checked = false;
  }

  const box = {
    console: { log() {}, warn() {}, error() {} },
    URLSearchParams,
    Event: class { constructor(type) { this.type = type; } },
    location: { search },
    window: {},
    state,
    PRICING: { FREQ: { weekly: 1, biweekly: 1, monthly: 1 }, OVERFLOW_BEDROOMS: 5 },
    SERVE_ATTRIBUTION: { segment: null },
    addonFridge: { checked: !!state.addonFridge },
    addonOven:   { checked: !!state.addonOven },
    zipInput: { value: '' },
    buildForm: {
      querySelector(sel) {
        const m = sel.match(/input\[name="([^"]+)"\]\[value="([^"]+)"\]/);
        if (!m) return null;
        const [, name, value] = m;
        return (RADIOS[name] || []).indexOf(value) === -1 ? null : radio(name, value);
      },
    },
    stepperSet: {
      'stepper-bedrooms':  v => { state.bedrooms  = v; },
      'stepper-bathrooms': v => { state.bathrooms = v; },
      'stepper-levels':    v => { state.levels    = v; },
    },
    evaluateZip() { state.zip = box.zipInput.value; },
    syncAddonsToService,
    recompute() {}, renderPrice() {}, prefetchAvailability() {},
    setView: v => views.push(v),
  };
  box.globalThis = box;
  vm.createContext(box);
  vm.runInContext(SLICE, box);

  return { state, views, addons: { fridge: box.addonFridge.checked,
                                   oven: box.addonOven.checked } };
}

/* ============================================================
   1. THE API's WORDS NOW WORK ON A LINK
   ============================================================ */
console.log('=== 1. AN AGENT MAY SPELL IT THE WAY THE API TAUGHT IT ===');
{
  /* Exactly the shape an agent builds after calling POST /api/quote. */
  const r = run('?zip=02116&bedrooms=3&bathrooms=2&service=first_clean' +
                '&frequency=biweekly&addon_oven=true');
  t('bedrooms (the API spelling) sets the stepper', r.state.bedrooms === 3, r.state.bedrooms);
  t('bathrooms too', r.state.bathrooms === 2, r.state.bathrooms);
  t('service=first_clean selects First Clean', r.state.service === 'first_clean', r.state.service);
  t('frequency=biweekly survives the service token',
    r.state.frequency === 'biweekly', r.state.frequency);
  t('addon_oven=true ticks the box', r.addons.oven === true, r.addons);
  t('and an unmentioned add-on is left alone, not cleared',
    r.addons.fridge === false, r.addons);
  t('the ZIP lands and the visitor goes straight to the price',
    r.state.zip === '02116' && r.views[r.views.length - 1] === 2, r.views);
}
{
  const r = run('?zip=02116&bedrooms=2&bathrooms=1&service=move_out');
  t('service=move_out selects the move clean', r.state.service === 'move_out', r.state.service);
}
{
  /* THE API ACCEPTS `service_type` AND `frequency_selected` AS WELL — the
     first because the booking payload has always called it that, the second
     because that is the only name the sheet knows. An agent that read either
     off a payload rather than the docs must not be punished for it. */
  const r = run('?zip=02116&bedrooms=2&service_type=move_out');
  t('service_type works as an alias for service', r.state.service === 'move_out',
    r.state.service);
  const f = run('?zip=02116&bedrooms=2&service=first_clean&frequency_selected=monthly');
  t('frequency_selected works as an alias for frequency',
    f.state.frequency === 'monthly', f.state.frequency);
}
{
  /* WHAT THE `frequency: null` ON THE API TOKENS IS ACTUALLY FOR. Seed a
     cadence the visitor already chose, then send a link that names a service
     and no cadence. A table token would stamp its own 'once' over it; an API
     token states no opinion and leaves it standing. */
  const r = run('?bedrooms=2&service=first_clean', { frequency: 'biweekly' });
  t('an API service token does not stamp a cadence over one already chosen',
    r.state.frequency === 'biweekly', r.state.frequency);
  const legacy = run('?bedrooms=2&service=deep', { frequency: 'biweekly' });
  t('   while a published-table token still carries its own, as it always did',
    legacy.state.frequency === 'once', legacy.state.frequency);
}
{
  /* An add-on the link does not mention must survive it. Seeded ticked, so a
     parser that read "absent" as "false" would show up here and nowhere else. */
  const r = run('?bedrooms=2&service=first_clean&addon_oven=true',
                { addonFridge: true });
  t('an add-on the link never mentions is left ticked',
    r.addons.fridge === true && r.addons.oven === true, r.addons);
  const off = run('?bedrooms=2&service=first_clean&addon_fridge=false',
                  { addonFridge: true });
  t('but one named false is genuinely unticked', off.addons.fridge === false, off.addons);
}
{
  /* Move Out prices the fridge and oven in, and hides its cadence block. A
     cadence arriving on such a link must not reach the sheet as though the
     customer had chosen one. */
  const r = run('?bedrooms=2&service=move_out&frequency=weekly');
  t('a cadence named on a MOVE OUT link is refused, not recorded',
    r.state.frequency === 'once', r.state.frequency);
}

/* ============================================================
   2. AND THE OLD WORDS STILL DO
   ============================================================
   These are in hrefs on /pricing and /services, in a test in
   pricing-and-services.test.js, and in links already sent to real people. */
console.log('\n=== 2. THE PUBLISHED-TABLE TOKENS ARE PERMANENT ===');
{
  const r = run('?beds=2&baths=1&service=deep');
  t('beds/baths still fill the steppers',
    r.state.bedrooms === 2 && r.state.bathrooms === 1, r.state);
  t('service=deep is still a one-off First Clean',
    r.state.service === 'first_clean' && r.state.frequency === 'once', r.state.frequency);
}
{
  const r = run('?beds=2&baths=1&service=recurring');
  t('service=recurring still means biweekly', r.state.frequency === 'biweekly',
    r.state.frequency);
}
{
  const r = run('?beds=2&baths=1&service=moveinout');
  t('service=moveinout still means the move clean', r.state.service === 'move_out',
    r.state.service);
}
{
  /* THE ONE THAT MADE THE API TOKENS CARRY NO FREQUENCY. A table token owns
     its cadence; an API token must not overwrite a cadence stated beside it. */
  const r = run('?beds=2&service=recurring&frequency=monthly');
  t('an explicit frequency beats a table token that also implies one',
    r.state.frequency === 'monthly', r.state.frequency);
}

/* ============================================================
   3. CONDITION — a grade in, the form's own answers out
   ============================================================ */
console.log('\n=== 3. A GRADE BECOMES THE TWO QUESTIONS THAT PRODUCE IT ===');
{
  const r = run('?zip=02116&bedrooms=2&bathrooms=1&condition=heavy');
  t('condition=heavy is reachable from a link', r.state.condition === 'heavy',
    r.state.condition);
  t('and it got there through last_clean, not by assignment',
    r.state.lastClean === 'long', r.state.lastClean);
}
{
  const r = run('?bedrooms=2&condition=light');
  t('condition=light lands too', r.state.condition === 'light', r.state.condition);
}
{
  /* The merge. A grade sets both answers; an explicit one overrides its half.
     Without this, `pets=true` would silently drop the heavy grade to standard
     by resetting last_clean — the quiet wrong answer, not a loud one. */
  const r = run('?bedrooms=2&condition=heavy&pets=true');
  t('a grade PLUS an explicit answer keeps both',
    r.state.condition === 'heavy' && r.state.hasPets === true, r.state);
}
{
  const r = run('?bedrooms=2&last_clean=recent&pets=false');
  t('the form\'s own vocabulary works directly', r.state.condition === 'light',
    r.state.condition);
}
{
  /* Junk on a public URL must be ignored, never thrown on. */
  const r = run('?bedrooms=2&condition=pristine&service=teleportation&frequency=hourly');
  t('unrecognised values change nothing and do not throw',
    r.state.condition === 'standard' && r.state.service === 'first_clean' &&
    r.state.frequency === 'once', r.state);
}

/* ============================================================
   4. THE GUARDS
   ============================================================ */
console.log('\n=== 4. WHAT A LINK MUST NOT DO ===');
{
  /* A ZIP names a place, not a home. Quoting a default home nobody described
     puts a number in front of someone who never asked for one. */
  const r = run('?zip=02116');
  t('a ZIP alone is not a prefill and quotes nothing', r.views.length === 0, r.views);
}
{
  const r = run('');
  t('an empty query string does nothing at all', r.views.length === 0, r.views);
}
{
  const r = run('?src=bu-alumni&utm_source=instagram');
  t('attribution params alone are not a prefill', r.views.length === 0, r.views);
}
{
  /* Move Out includes the fridge and oven in the price, so its add-on boxes
     are hidden. A link must not leave them armed and invisible. */
  const r = run('?zip=02116&bedrooms=2&service=move_out&addon_oven=true&addon_fridge=true');
  t('add-ons named on a MOVE OUT link are cleared, not left armed',
    r.addons.oven === false && r.addons.fridge === false, r.addons);

  /* AND WITH NO ZIP, which is a different code path and was genuinely broken
     until mutation testing found it: the clearing call lived only in the
     branch that reaches a price, so a Move Out link without a ZIP left the box
     ticked and invisible, ready to reappear on a switch back to First Clean. */
  const noZip = run('?bedrooms=2&service=move_out&addon_oven=true&addon_fridge=true');
  t('   and cleared on a Move Out link that never reaches a price',
    noZip.addons.oven === false && noZip.addons.fridge === false &&
    noZip.state.addonOven === false, noZip.addons);
}
{
  const r = run('?bedrooms=6&bathrooms=3&service=first_clean&zip=02116');
  t('6 bedrooms goes to the custom-quote path, not to a price that does not exist',
    r.views[r.views.length - 1] === 'overflow', r.views);
}

/* ============================================================
   5. THE TWO SURFACES, READ FROM SOURCE
   ============================================================
   The assertions above would all still pass if someone added a third service
   to the API tomorrow and forgot the link. These are the ones that would not.
   Both sides are READ, never retyped. */
console.log('\n=== 5. NEITHER SURFACE MAY GAIN A WORD THE OTHER LACKS ===');

const PREFILL_SRC = SLICE.slice(SLICE.indexOf('const PREFILL_SERVICES'),
                                SLICE.indexOf('const PREFILL_FREQUENCIES'));
const prefillBox = {};
vm.createContext(prefillBox);
vm.runInContext(PREFILL_SRC.replace('const PREFILL_SERVICES', 'var PREFILL_SERVICES'),
                prefillBox);
const TOKENS = Object.keys(prefillBox.PREFILL_SERVICES);

/* The services the pricing engine actually branches on, read out of the
   worker's own scope builder and engine calls rather than listed here. */
const ENGINE_SERVICES = [...new Set(
  (fs.readFileSync(path.join(REPO_ROOT, 'pricing-engine.js'), 'utf8')
    .match(/service === '([a-z_]+)'/g) || [])
    .map(s => s.replace(/.*'([a-z_]+)'.*/, '$1')))];

t('the engine prices exactly the two services we think it does',
  ENGINE_SERVICES.length === 2 && ENGINE_SERVICES.includes('first_clean') &&
  ENGINE_SERVICES.includes('move_out'), ENGINE_SERVICES);

for (const s of ENGINE_SERVICES) {
  t('a link accepts the API/engine token "' + s + '"',
    TOKENS.indexOf(s) !== -1, TOKENS);
  t('   and maps it to that same service',
    prefillBox.PREFILL_SERVICES[s] &&
    prefillBox.PREFILL_SERVICES[s].service === s, prefillBox.PREFILL_SERVICES[s]);
  t('   carrying NO frequency of its own',
    prefillBox.PREFILL_SERVICES[s].frequency === null,
    prefillBox.PREFILL_SERVICES[s]);
}
for (const legacy of ['deep', 'recurring', 'moveinout']) {
  t('the published-table token "' + legacy + '" survives', TOKENS.indexOf(legacy) !== -1);
}

/* Every priced field the API reads off its request body must be reachable on
   a link, or an agent can quote something it cannot hand over. quoteScope is
   the right source: it is the list the signature is computed over, so a field
   that moves a price is in it by construction. */
const SCOPE = WORKER.slice(WORKER.indexOf('function quoteScope'),
                           WORKER.indexOf('function priceFrom'));
const SCOPE_FIELDS = [...new Set((SCOPE.match(/\bd\.([a-z_]+)/g) || [])
  .map(s => s.slice(2)))];
t('quoteScope was found and reads fields', SCOPE_FIELDS.length >= 7, SCOPE_FIELDS);

const READER = SLICE.slice(SLICE.indexOf('function readPrefillParams'));
/* `service_type` and `frequency_selected` are alternates the API accepts; the
   link accepts them too, so reading either name counts. */
const ALIAS = { service_type: 'service', frequency_selected: 'frequency' };
for (const f of SCOPE_FIELDS) {
  const names = [f, ALIAS[f]].filter(Boolean);
  t('a link can carry the priced field "' + f + '"',
    names.some(n => READER.indexOf("'" + n + "'") !== -1), READER.indexOf(f));
}

/* And the inverse: the condition table the harness above copied must still be
   the one script.js uses, or section 3 is testing a fiction. */
t('the harness\'s condition table still matches script.js',
  /recent:\s*\{\s*no:\s*'light',\s*yes:\s*'standard'\s*\}/.test(SITE) &&
  /long:\s*\{\s*no:\s*'heavy',\s*yes:\s*'heavy'\s*\}/.test(SITE));

console.log(bad ? '\n' + bad + ' FAILED' : '\nall prefill vocabulary checks passed');
process.exit(bad ? 1 : 0);
