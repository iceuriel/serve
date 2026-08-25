/**
 * Geographic pricing — levels, half-baths, per-ZIP size factor, parking adder.
 *
 * Runs the REAL serve-geo-data.js and the REAL pricing engine out of script.js,
 * concatenated the way the browser sees them (two <script> tags sharing one
 * lexical scope). Nothing here is a reimplementation of the maths — every
 * expectation is either a fixed acceptance value from the build spec or a
 * relationship between two live computeQuote calls.
 *
 * The one rule this file exists to defend: THE SIZE FACTOR AND PARKING TIER
 * ARE NEVER SHOWN TO A CUSTOMER. They price the job and they go to the sheet. Section 7
 * checks the rendered site for leaks.
 */
const REPO_ROOT = require('path').resolve(__dirname, '..');
const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const read = f => fs.readFileSync(path.join(REPO_ROOT, f), 'utf8');

const SITE     = read('script.js');
const GEO      = read('serve-geo-data.js');
const INDEX    = read('index.html');
const PRICING_HTML = read('pricing.html');
const SERVICES = read('services.html');
const CSS      = read('style.css');
const WEBHOOK  = read('apps-script/webhook.gs');

let bad = 0;
const t = (label, cond, extra) => {
  console.log((cond ? '  ok    ' : '  FAIL  ') + label + (extra !== undefined ? '  ->  ' + JSON.stringify(extra) : ''));
  if (!cond) bad++;
};

/* ---------- load the engine exactly as a page does ---------- */
const engineFrom = SITE.indexOf('const WORK_RATE =');
const engineTo   = SITE.indexOf('/* ============================================================', engineFrom);
if (engineFrom === -1 || engineTo === -1) throw new Error('could not slice script.js — the banners moved');

const box = { console: { log() {}, warn() {}, error() {} } };
vm.createContext(box);
vm.runInContext(
  GEO + '\n' + SITE.slice(engineFrom, engineTo) +
  '\n;globalThis.__x = { PRICING, ZIP_TIERS, ZIP_GEO, PARK_ADDER, DEFAULT_GEO };',
  box
);
const { computeQuote, lookupGeo, serveGeo } = box;
const { PRICING, ZIP_TIERS, ZIP_GEO, PARK_ADDER, DEFAULT_GEO } = box.__x;
const factorOf = z => ZIP_GEO[z][0];
/* What the factor actually does to a price. Only AREA_SHARE of the size base is
   exposed to it, because the extra square footage in a high-factor ZIP is bigger
   rooms rather than more of them — setup, kitchen and bathroom fixtures do not
   grow with the home. Anything comparing two ZIPs must compare THIS, not the
   raw factor. */
const effectOf = z => (1 - PRICING.AREA_SHARE) + PRICING.AREA_SHARE * factorOf(z);

/* A standard First Clean, varying only what each test is about.
   `q` pins an explicitly NEUTRAL geo so the size model can be asserted without
   whichever factor the anchor ZIP happens to carry. `qz` drops the override so
   the real per-ZIP factor applies — use it whenever geography is the point. */
const NEUTRAL = { parkTier: 'P0', factor: 1, park: 0, mapped: false };
const base = (over) => Object.assign({
  bedrooms: 2, bathrooms: 1, levels: 1, service: 'first_clean',
  condition: 'standard', addonFridge: false, addonOven: false,
  zip: '02130', frequency: 'once',
}, over);
const q  = (over) => computeQuote(Object.assign(base(over), { geo: NEUTRAL }));
const qz = (over) => computeQuote(base(over));

/* ============================================================
   1. The acceptance table from the build spec, verbatim
   ============================================================ */
console.log('=== 1. spec §4 acceptance table ===');

/* The spec's acceptance table named buckets. Buckets are gone as of
   2026-08-21 — they double-counted bathrooms — so the equivalent assertion is
   that each ZIP still resolves to a factor on the right side of the norm, with
   its parking tier unchanged. Parking was never in question and did not move. */
[['02210', 'above', 'P1'],
 ['02113', 'below', 'P2'],
 ['02135', 'below', 'P0']].forEach(([zip, side, park]) => {
  const g = lookupGeo(zip);
  const ok = side === 'above' ? g.factor > 1 : g.factor < 1;
  t(zip + ' -> factor ' + side + ' 1.00, park ' + park,
    ok && g.parkTier === park, [g.factor, g.parkTier]);
});
t('every factor is a number in the clamp range [0.85, 1.45]',
  Object.keys(ZIP_GEO).every(z => {
    const f = factorOf(z); return typeof f === 'number' && f >= 0.85 && f <= 1.45;
  }));

const unmapped = lookupGeo('99999');
t('99999 -> factor 1.00, park P0, mapped false',
  unmapped.factor === 1 && unmapped.parkTier === 'P0' && unmapped.mapped === false, unmapped);
let threw = false;
try { qz({ zip: '99999' }); } catch (_) { threw = true; }
t('an unmapped ZIP does not throw — a quote is still produced', !threw);
t('and it produces a real price', qz({ zip: '99999' }).displayPrice > 0);

t('baths=2.5 -> fullBaths 2, halfBaths 1',
  q({ bathrooms: 2.5 }).fullBaths === 2 && q({ bathrooms: 2.5 }).halfBaths === 1);
t('baths=3 -> fullBaths 3, halfBaths 0',
  q({ bathrooms: 3 }).fullBaths === 3 && q({ bathrooms: 3 }).halfBaths === 0);

/* The spec states levels in minutes; this build prices in dollars, so the
   assertion is the equivalent one — a level beyond the first costs PER_LEVEL on
   the size base, and level 1 costs nothing. */
t('levels=1 adds nothing',
  q({ levels: 1 }).standard === PRICING.BASE + PRICING.PER_BEDROOM * 2 + PRICING.PER_BATHROOM * 1);
/* Since 2026-08-25 a storey is NOT in the size base — it is a flat per-service
   charge added after the multipliers, so the base must not move at all. */
t('a storey never touches the size base — that is the whole point of the change',
  q({ levels: 3 }).standard === q({ levels: 1 }).standard);
t('levels=1 carries no level fee', q({ levels: 1 }).levelFee === 0);
t('levels=2 charges one storey, levels=3 charges two — beyond the first, not per level',
  q({ levels: 3 }).levelFee === q({ levels: 2 }).levelFee * 2,
  [q({ levels: 2 }).levelFee, q({ levels: 3 }).levelFee]);
/* The measured job: a 3BR/2BA biweekly went 4h to 6h, so a storey is 2 hours
   of a biweekly visit, charged at cost plus the level margin. */
const bw2 = computeQuote(Object.assign(base({ bedrooms: 3, bathrooms: 2, levels: 2 }), { geo: NEUTRAL }));
const bw1 = computeQuote(Object.assign(base({ bedrooms: 3, bathrooms: 2, levels: 1 }), { geo: NEUTRAL }));
t('a storey adds 2 biweekly hours at the level margin — the measured case',
  bw2.freqSteady.biweekly - bw1.freqSteady.biweekly === Math.ceil(2 * 35 / 0.75),
  bw2.freqSteady.biweekly - bw1.freqSteady.biweekly);
/* A move-out gets more hours than a weekly visit, because the ladder is per
   service. Nothing else in the flat-fee block behaves this way. */
t('the level charge is bigger on a move-out than on a weekly visit',
  bw2.levelFee > (bw2.freqSteady.weekly - bw1.freqSteady.weekly));
/* And it must be immune to everything the size base is exposed to. */
const lvlIn = (over) => {
  const two = computeQuote(base(Object.assign({ bedrooms: 3, bathrooms: 2, levels: 2 }, over)));
  const one = computeQuote(base(Object.assign({ bedrooms: 3, bathrooms: 2, levels: 1 }, over)));
  return two.freqSteady.biweekly - one.freqSteady.biweekly;
};
t('a storey costs the same in a dear ZIP as a cheap one — stairs are stairs',
  lvlIn({ zip: '02110' }) === lvlIn({ zip: '02135' }), [lvlIn({ zip: '02110' }), lvlIn({ zip: '02135' })]);
/* The charge is flat in dollars EXCEPT where the 50% cap binds. The hour
   ladder was set with a three-bedroom in mind, so on a very small home it
   overshoots — a two-storey studio deep clean reached 9.4 cleaner-hours, the
   same as a single-storey 3BR/2BA with two baths and three bedrooms. */
const lvlFee = (bd, ba, extra) => {
  const two = computeQuote(Object.assign(base({ bedrooms: bd, bathrooms: ba, levels: 2 }), extra || {}, { geo: NEUTRAL }));
  const one = computeQuote(Object.assign(base({ bedrooms: bd, bathrooms: ba, levels: 1 }), extra || {}, { geo: NEUTRAL }));
  return two.freqSteady.biweekly - one.freqSteady.biweekly;
};
t('the charge is flat across mid and large homes — 2BR/2BA up to 4BR/3BA',
  lvlFee(2, 2) === lvlFee(3, 2) && lvlFee(3, 2) === lvlFee(4, 3),
  [lvlFee(2, 2), lvlFee(3, 2), lvlFee(4, 3)]);
t('but a studio pays LESS, because the 50% cap binds there',
  lvlFee(0, 1) < lvlFee(3, 2), [lvlFee(0, 1), lvlFee(3, 2)]);
t('the cap never lets a storey exceed half the visit it is attached to',
  (() => {
    for (const [bd, ba] of [[0,1],[1,1],[2,1],[2,2],[3,2],[4,3]]) {
      const one = computeQuote(Object.assign(base({ bedrooms: bd, bathrooms: ba, levels: 1 }), { geo: NEUTRAL }));
      if (lvlFee(bd, ba) > one.freqSteady.biweekly * 0.5 + 1) return false;
    }
    return true;
  })());
/* And it must still be immune to condition — the cap reads the service price,
   which for recurring is condition-free by construction. */
t('a storey costs the same whatever condition is selected',
  (() => {
    const f = c => {
      const two = computeQuote(Object.assign(base({ bedrooms: 3, bathrooms: 2, levels: 2, condition: c }), { geo: NEUTRAL }));
      const one = computeQuote(Object.assign(base({ bedrooms: 3, bathrooms: 2, levels: 1, condition: c }), { geo: NEUTRAL }));
      return two.freqSteady.biweekly - one.freqSteady.biweekly;
    };
    return f('light') === f('standard') && f('standard') === f('heavy');
  })());

/* The headline claim of the whole change: two identical homes, priced apart by
   where they are. The magnitude is read from the live map rather than frozen —
   it was 1.53x under the old buckets and is smaller now that the factors are
   measured on the basis the calculator actually charges on. What must hold is
   that the gap is real and that it equals the ratio of the two factors exactly,
   with nothing else leaking in. */
console.log('\n--- the geographic spread that is the point of the change ---');
const large = qz({ zip: '02210' });
const small = qz({ zip: '02113' });
/* Measured on the ANCHOR, not the shown price: the first clean is half of
   everything including the parking adder, so subtracting the full adder from a
   halved price would leave the wrong number. The anchor is the undiscounted
   ticket, which is where a flat fee sits at full value. */
const ratio = (large.deepAnchorDisplay - large.parkAdder) / (small.deepAnchorDisplay - small.parkAdder);
const expected = effectOf('02210') / effectOf('02113');
t('identical homes in 02210 and 02113 differ by exactly the ratio of their '
  + 'geo EFFECTS — the damped factor, not the raw one',
  Math.abs(ratio - expected) < 0.01, [Number(ratio.toFixed(3)), Number(expected.toFixed(3))]);
t('and that spread is material — at least 1.15x before parking',
  ratio > 1.15, Number(ratio.toFixed(3)));
/* The damping is the point: a raw factor spread of 1.46x must reach the customer
   as something smaller, or we are charging a Seaport bathroom more than an East
   Boston one for being in a bigger apartment. */
t('the damped spread is strictly narrower than the raw factor spread',
  expected < factorOf('02210') / factorOf('02113'),
  [Number(expected.toFixed(3)), Number((factorOf('02210') / factorOf('02113')).toFixed(3))]);
t('AREA_SHARE is a real fraction — 1 would mean scaling arrival and fixtures too',
  PRICING.AREA_SHARE > 0 && PRICING.AREA_SHARE < 1, PRICING.AREA_SHARE);
/* A neutral ZIP must be untouched by the damping — (1-s) + s*1 === 1. */
t('a factor of exactly 1.00 passes through unchanged whatever AREA_SHARE is',
  Math.abs(((1 - PRICING.AREA_SHARE) + PRICING.AREA_SHARE * 1) - 1) < 1e-12);

/* ============================================================
   2. Order of operations — spec §2.3, which says do not rearrange
   ============================================================ */
console.log('\n=== 2. flat dollars are added after multipliers, never scaled ===');

/* 02113 is P2 (+$25) and 02135 is P0 ($0). If the parking adder were multiplied
   rather than added, the difference between a studio and a 4BR in the same ZIP
   would not be a constant. The factor ratio divides out the size difference so
   only the parking term is left. */
const parkOf = (zip, beds) => qz({ zip, bedrooms: beds }).displayPrice
  - qz({ zip: '02135', bedrooms: beds }).displayPrice * (effectOf(zip) / effectOf('02135'));
t('the parking adder is the same dollars on a studio as on a 4BR',
  Math.abs(parkOf('02113', 0) - parkOf('02113', 4)) < 1.5,
  [parkOf('02113', 0).toFixed(2), parkOf('02113', 4).toFixed(2)]);

t('P2 adds more than P1, which adds more than P0',
  PARK_ADDER.P2 > PARK_ADDER.P1 && PARK_ADDER.P1 > PARK_ADDER.P0);
/* 02115 Fenway and 02121 Dorchester carry the SAME size factor and differ only
   in parking (P2 vs P0), so the whole gap between them must be the adder and
   nothing else. Asserted against the live map so the pair cannot silently stop
   being comparable on the next data refresh. */
t('02115 and 02121 do share a factor — the premise of the next assertion',
  factorOf('02115') === factorOf('02121'), [factorOf('02115'), factorOf('02121')]);
t('a P2 ZIP quote exceeds the same home in a P0 ZIP of identical size',
  qz({ zip: '02115' }).displayPrice > qz({ zip: '02121' }).displayPrice);
t('and by exactly the P2 adder on the undiscounted ticket',
  qz({ zip: '02115' }).deepAnchorDisplay - qz({ zip: '02121' }).deepAnchorDisplay === PARK_ADDER.P2);
/* On the SHOWN price it is half the adder, because the first clean halves the
   whole ticket. That is the intended behaviour and worth pinning too. */
t('and about half of it on the shown first-clean price, since the discount is '
  + 'total — exactly half is not reachable once both prices are whole dollars',
  Math.abs((qz({ zip: '02115' }).displayPrice - qz({ zip: '02121' }).displayPrice)
           - PARK_ADDER.P2 / 2) <= 1,
  qz({ zip: '02115' }).displayPrice - qz({ zip: '02121' }).displayPrice);

/* The extended-area fee and the geo adjustment must stack, not replace. Both
   ZIPs here are unmapped, so both price at the neutral factor with no parking
   adder and the only difference left is the travel fee. */
t('the $25 extended-area fee still applies on top of geo',
  qz({ zip: '02155' }).deepAnchorDisplay - qz({ zip: '99999' }).deepAnchorDisplay === PRICING.EXTENDED_ZIP_FEE);

/* ============================================================
   3. Nothing that already worked stopped working
   ============================================================ */
console.log('\n=== 3. existing canonical logic is preserved ===');

/* The anchor and the price are each ceiled to whole dollars independently, so
   they relate to within that rounding and not exactly. $1 is the slack. */
const fc = q();
t('first clean is still deep x 0.50 — the struck-through anchor is the price '
  + 'before the discount, up to whole-dollar rounding',
  Math.abs(fc.deepAnchorDisplay * PRICING.FIRST_CLEAN_FACTOR
           - (fc.displayPrice - fc.parkAdder - fc.zipFee - fc.addons)) <= 1,
  [fc.deepAnchorDisplay, fc.displayPrice]);
t('and the discount is actually shown as applying', fc.discountApplies === true);
t('condition still moves the price', q({ condition: 'heavy' }).displayPrice > q({ condition: 'light' }).displayPrice);
t('add-ons are still First Clean only, and full price on the undiscounted ticket',
  q({ addonFridge: true }).deepAnchorDisplay - q().deepAnchorDisplay === PRICING.ADDONS.fridge &&
  q({ service: 'move_out', addonFridge: true }).displayPrice === q({ service: 'move_out' }).displayPrice);
t('the 4BR+ heavy no-stack rule still suppresses the discount',
  q({ bedrooms: 4, condition: 'heavy' }).noStack === true &&
  q({ bedrooms: 4, condition: 'heavy' }).discountApplies === false);
t('recurring prices are still produced for all three frequencies',
  ['weekly', 'biweekly', 'monthly'].every(f => q().freqSteady[f] > 0));
t('recurring carries the zone factor too — a bigger home is bigger every visit',
  q({ zip: '02210' }).freqSteady.weekly > qz({ zip: '02135' }).freqSteady.weekly);
t('and carries the parking adder, which costs the same on every visit',
  qz({ zip: '02115' }).freqSteady.weekly - qz({ zip: '02121' }).freqSteady.weekly === PARK_ADDER.P2);
t('move-out is still priced and still ignores add-ons',
  q({ service: 'move_out' }).displayPrice > q().displayPrice);

/* Half-baths are priced as their own constant, at half a full bath, matching
   the 22min / 11min ratio the spec derived them from. */
t('a half bath costs exactly half a full one',
  PRICING.HALF_BATHROOM * 2 === PRICING.PER_BATHROOM);
t('2.5 baths sits strictly between 2 and 3',
  q({ bathrooms: 2 }).displayPrice < q({ bathrooms: 2.5 }).displayPrice &&
  q({ bathrooms: 2.5 }).displayPrice < q({ bathrooms: 3 }).displayPrice);

/* ============================================================
   4. Degradation — serve-geo-data.js is a separate file
   ============================================================ */
console.log('\n=== 4. a missing geo file prices neutrally, never throws ===');
const bare = { console: { log() {}, warn() {}, error() {} } };
vm.createContext(bare);
vm.runInContext(SITE.slice(engineFrom, engineTo), bare);   /* engine ALONE, no geo */
let bareThrew = false, barePrice = null;
try { barePrice = bare.computeQuote({ bedrooms: 2, bathrooms: 1, levels: 1, service: 'first_clean',
      condition: 'standard', zip: '02210', frequency: 'once' }); } catch (_) { bareThrew = true; }
t('the engine loads and runs with no geo file at all', !bareThrew);
t('and still returns a real price', barePrice && barePrice.displayPrice > 0);
t('reporting the neutral zone rather than pretending to be mapped',
  barePrice && barePrice.geoFactor === 1 && barePrice.parkTier === 'P0' && barePrice.geoMapped === false);
t('an above-norm ZIP prices at the norm when the map is gone — under, never over',
  barePrice && barePrice.displayPrice < qz({ zip: '02210' }).displayPrice);

/* ============================================================
   5. The map itself
   ============================================================ */
console.log('\n=== 5. the ZIP map ===');
const zips = Object.keys(ZIP_GEO);
t('49 ZIPs mapped, as specified', zips.length === 49, zips.length);
t('every entry is [zone, parkTier, label]',
  zips.every(z => Array.isArray(ZIP_GEO[z]) && ZIP_GEO[z].length === 3));
t('every factor is a number inside the documented clamp',
  zips.every(z => typeof factorOf(z) === 'number' && factorOf(z) >= 0.85 && factorOf(z) <= 1.45));
t('every parking tier is a real PARK_ADDER key',
  zips.every(z => typeof PARK_ADDER[ZIP_GEO[z][1]] === 'number'));
t('every ZIP is five digits', zips.every(z => /^\d{5}$/.test(z)));
t('02467 is mapped once despite straddling three towns',
  typeof ZIP_GEO['02467'][0] === 'number');

/* A mapped ZIP we do not sell to would be inert — the visitor gets the waitlist
   and the zone never applies. Worth knowing about, so it is asserted. */
const sold = ZIP_TIERS.CORE.concat(ZIP_TIERS.EXTENDED);
const inert = zips.filter(z => sold.indexOf(z) === -1);
t('every mapped ZIP is one we actually sell to', inert.length === 0, inert);

/* The reverse is allowed — the nine EXTENDED towns and Brookline Village have
   no parcel data — but it must stay a KNOWN list, not a silent drift. */
const unmappedSold = sold.filter(z => !ZIP_GEO[z]);
t('the served-but-unmapped list is exactly the 10 known ZIPs',
  unmappedSold.length === 10, unmappedSold);
t('02447 Brookline Village is the only CORE ZIP without parcel data',
  unmappedSold.filter(z => ZIP_TIERS.CORE.indexOf(z) !== -1).join() === '02447', unmappedSold);

/* ============================================================
   6. lookupGeo input handling
   ============================================================ */
console.log('\n=== 6. lookupGeo is not fussy about its input ===');
[undefined, null, '', '  ', 'abcde', 12345, '021'].forEach(v => {
  let ok = true;
  try { const g = lookupGeo(v); ok = typeof g.factor === 'number' && typeof g.parkTier === 'string'; }
  catch (_) { ok = false; }
  t('lookupGeo(' + JSON.stringify(v) + ') returns a usable result', ok);
});
t('a ZIP+4 resolves on its first five digits',
  lookupGeo('02210-1234').factor === factorOf('02210'));
t('surrounding whitespace is tolerated',
  lookupGeo('  02210 ').factor === factorOf('02210'));

/* ============================================================
   7. NOTHING GEOGRAPHIC IS EVER SHOWN TO A CUSTOMER
   ============================================================ */
console.log('\n=== 7. the customer sees one price, never a zone ===');

/* Zone names and tier codes must not appear in any rendered surface. Checked
   against markup and stylesheet, not against script.js — the engine of course
   names them, and quote_meta is supposed to carry them. */
const RENDERED = INDEX + PRICING_HTML + SERVICES + CSS;
['parkTier', 'park_tier', 'geo_factor', 'PARK_ADDER', 'ZIP_GEO', 'size index', 'size factor']
  .forEach(term => t('"' + term + '" appears in no rendered surface',
    RENDERED.indexOf(term) === -1));

/* The engine may return them — the sheet needs them — but no render path may
   interpolate one. This catches the realistic mistake: someone adding zone to
   a price caption or an aria-label. */
const shared = SITE.slice(SITE.indexOf('   SERVE — SHARED PAGE MODULE'));
t('the shared page module never interpolates a zone or tier',
  !/\$\{[^}]*\b(zone|parkTier|parkAdder)\b[^}]*\}/.test(shared) &&
  !/\+\s*q\.(zone|parkTier|parkAdder)/.test(shared));
t('no innerHTML or textContent assignment anywhere names one',
  !/(innerHTML|textContent)\s*=[^\n;]*\.(zone|parkTier|parkAdder)\b/.test(SITE));

/* ============================================================
   8. It reaches the sheet
   ============================================================ */
console.log('\n=== 8. zone, park tier and levels reach the sheet ===');
t('the site sends levels in the booking payload', /levels:\s*state\.levels/.test(SITE));
t('the site sends geo_factor and park_tier',
  /geo_factor:\s*q \? q\.geoFactor/.test(SITE) && /park_tier:\s*q \? q\.parkTier/.test(SITE));
t('webhook carries geo_factor and park_tier in quote_meta',
  /QUOTE_META_KEYS[\s\S]*?"geo_factor",\s*"park_tier"/.test(WEBHOOK));
t('webhook treats levels as an ops field, so a real column picks it up later',
  /OPS_PREFERRED_KEYS\s*=\s*\[[^\]]*"levels"/.test(WEBHOOK));
t('the version stamp moved — the only drift detector between repo and deployment',
  /VERSION STAMP:[^\n]*r8/.test(WEBHOOK) && /version:\s*"[^"]*r8"/.test(WEBHOOK));

/* ============================================================
   9. The form collects it
   ============================================================ */
console.log('\n=== 9. the Build step asks for levels and half-baths ===');
t('a levels stepper exists', /id="stepper-levels"/.test(INDEX));
t('it offers 1 to 3', /id="stepper-levels"[^>]*data-min="1"[^>]*data-max="3"/.test(INDEX));
t('it defaults to 1 — the overwhelming majority of Boston condos',
  /id="stepper-levels"[^>]*data-value="1"/.test(INDEX));
t('bathrooms step by 0.5', /id="stepper-bathrooms"[^>]*data-step="0.5"/.test(INDEX));
t('bedrooms do NOT — half bedrooms are not a real category',
  !/id="stepper-bedrooms"[^>]*data-step/.test(INDEX));

/* The hint is mandatory: without it someone on the 8th floor answers "8". */
const levelsBlock = INDEX.slice(INDEX.indexOf('id="stepper-levels"') - 400,
                                INDEX.indexOf('id="stepper-levels"') + 700);
t('the levels hint is present and always visible, not a tooltip or a title attr',
  /class="field-hint">Floors inside your unit/.test(levelsBlock));
t('the hint distinguishes the unit from the building',
  /not the floor your building is on/.test(levelsBlock));
t('a half-bath hint tells the customer what 0.5 means',
  /Count a half bath/.test(INDEX));

/* ============================================================
   10. The stepper actually steps
   Runs the REAL initStepper against a fake DOM and drives its buttons. The
   engine tests above prove 2.5 baths prices correctly; this proves a customer
   can reach 2.5 at all, which is a different claim and the one that broke when
   the control was integer-only.
   ============================================================ */
console.log('\n=== 10. driving the real stepper ===');

const stepFrom = SITE.indexOf('    function initStepper(');
const stepTo   = SITE.indexOf("    initStepper('stepper-bedrooms'", stepFrom);
t('initStepper could be located in script.js', stepFrom !== -1 && stepTo !== -1);

function drive(attrs, format) {
  const mk = dir => {
    const b = { disabled: false, getAttribute: k => (k === 'data-dir' ? dir : null) };
    b.addEventListener = (_e, fn) => { b.click = fn; };
    return b;
  };
  const btns = { '-1': mk('-1'), '1': mk('1') };
  const el = {
    attrs, getAttribute(k) { return this.attrs[k]; }, setAttribute(k, v) { this.attrs[k] = v; },
    querySelector: sel => (sel.indexOf('"-1"') !== -1 ? btns['-1'] : btns['1']),
    querySelectorAll: () => [btns['-1'], btns['1']],
  };
  const val = { textContent: '' };
  const sandbox = { $: id => (id.indexOf('stepper') === 0 ? el : val),
                    bedroomsLabel: n => (n === 0 ? 'Studio' : n + ' BR'),
                    stepperSet: {}, parseInt, parseFloat, Math, String, Number };
  vm.createContext(sandbox);
  vm.runInContext(SITE.slice(stepFrom, stepTo) + '\n;globalThis.__i = initStepper;', sandbox);
  const seen = [];
  sandbox.__i('stepper-x', 'val-x', v => seen.push(v), format);
  return { el, val, seen, btns, plus: () => btns['1'].click(), minus: () => btns['-1'].click() };
}

const bath = drive({ 'data-min': '1', 'data-max': '5', 'data-step': '0.5', 'data-value': '1' });
const walk = [bath.val.textContent];
for (let i = 0; i < 6; i++) { bath.plus(); walk.push(bath.val.textContent); }
t('six clicks walk 1 -> 1.5 -> 2 -> 2.5 -> 3 -> 3.5 -> 4, exactly the spec list',
  walk.join(' ') === '1 1.5 2 2.5 3 3.5 4', walk.join(' '));
t('no floating-point drift after a long run of clicks — every value lands on the '
  + '0.5 grid, so a quote can never be built from 1.4999999999999998',
  bath.seen.every(v => Math.round(v * 2) / 2 === v));
for (let i = 0; i < 20; i++) bath.minus();
t('clamps at the floor and disables the minus button',
  bath.val.textContent === '1' && bath.btns['-1'].disabled === true, bath.val.textContent);
for (let i = 0; i < 20; i++) bath.plus();
t('clamps at the ceiling and disables the plus button',
  bath.val.textContent === '5' && bath.btns['1'].disabled === true, bath.val.textContent);

const lv = drive({ 'data-min': '1', 'data-max': '3', 'data-value': '1' },
                 (v, max) => (v >= max ? v + '+' : String(v)));
const lwalk = [lv.val.textContent];
for (let i = 0; i < 3; i++) { lv.plus(); lwalk.push(lv.val.textContent); }
t('levels walk 1 -> 2 -> 3+ and stop', lwalk.join(' ') === '1 2 3+ 3+', lwalk.join(' '));
t('the ceiling label is "3+", not "3" — it has to read as "three or more"',
  lv.val.textContent === '3+');
lv.minus();
t('stepping back off the ceiling re-enables the plus button and drops the +',
  lv.val.textContent === '2' && lv.btns['1'].disabled === false);

/* The bedroom label is the one pre-existing special case; it must survive the
   generalisation to fractional steps. */
const bed = drive({ 'data-min': '0', 'data-max': '5', 'data-value': '2' },
                  v => (v === 0 ? 'Studio' : v + ' BR').replace(' BR', ''));
bed.minus(); bed.minus();
t('bedrooms still say "Studio" at zero', bed.val.textContent === 'Studio', bed.val.textContent);

console.log('\n' + (bad ? 'FAILURES: ' + bad : 'ALL CHECKS PASSED'));
process.exit(bad ? 1 : 0);
