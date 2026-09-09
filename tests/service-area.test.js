/**
 * Service-area coverage.
 *
 * A ZIP that is in neither ZIP_TIERS list gets the waitlist instead of a price —
 * the visitor is told "we're not in your area yet" and the lead is gone. On
 * 2026-08-14 a Seaport visitor (02210) hit that path, so the required-coverage
 * list below is now a test: drop a ZIP out of script.js and this goes red.
 *
 * Runs the REAL ZIP_TIERS / zipTier / computeQuote sliced out of script.js, so
 * what is asserted here is exactly what the site does.
 */
const REPO_ROOT = require('path').resolve(__dirname, '..');
const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const SITE   = fs.readFileSync(path.join(REPO_ROOT, 'script.js'), 'utf8');
const ENGINE = fs.readFileSync(path.join(REPO_ROOT, 'pricing-engine.js'), 'utf8');

let bad = 0;
const t = (label, cond, extra) => {
  console.log((cond ? '  ok    ' : '  FAIL  ') + label + (extra !== undefined ? '  ->  ' + JSON.stringify(extra) : ''));
  if (!cond) bad++;
};

/* The pricing/coverage block is now a whole file of its own. */
if (!/const ZIP_TIERS/.test(ENGINE)) throw new Error('pricing-engine.js has no ZIP_TIERS — wrong file?');

const box = { console };
vm.createContext(box);
vm.runInContext(ENGINE, box);

const zipTier      = box.zipTier;
const computeQuote = box.computeQuote;
const ZIP_TIERS    = vm.runInContext('ZIP_TIERS', box);
const PRICING      = vm.runInContext('PRICING', box);

/* ============================================================
   Required coverage — the towns Serve sells to. Every ZIP here must quote.
   Tier (core vs extended, i.e. whether the +$25 applies) is a pricing choice
   and is asserted separately; this block only asserts "we serve it at all".
   ============================================================ */
const REQUIRED = {
  Boston: ['02108','02109','02110','02111','02113','02114','02115','02116','02118',
           '02119','02120','02121','02122','02124','02125','02126','02127','02128',
           '02129','02130','02131','02132','02134','02135','02136','02163','02199',
           '02210','02215',
           /* PO-box ZIP, deliberately served — see the note in ZIP_TIERS. */
           '02117'],
  Cambridge:  ['02138','02139','02140','02141','02142'],
  Somerville: ['02143','02144','02145'],
  Brookline:  ['02445','02446','02447'],
  Newton:     ['02458','02459','02460','02461','02462','02464','02465','02466','02467','02468'],
  Watertown:  ['02472'],
  Medford:    ['02155'],
  Malden:     ['02148'],
  Everett:    ['02149'],
  Chelsea:    ['02150'],
};

console.log('=== 1. every required ZIP is served (never the waitlist) ===');
Object.keys(REQUIRED).forEach(town => {
  const missing = REQUIRED[town].filter(z => zipTier(z) === 'unknown');
  t(town.padEnd(11) + REQUIRED[town].length + ' ZIPs', missing.length === 0, missing);
});

console.log('\n=== 2. the ZIPs that regressed ===');
// Seaport — the reported miss. The rest are downtown/Boston-proper ZIPs that
// were absent for the same reason and would have failed the same way.
[['02210','Seaport / Fort Point'],
 ['02215','Fenway / Kenmore'],
 ['02199','Back Bay / Prudential'],
 ['02163','Allston / HBS'],
 ['02136','Hyde Park'],
 ['02447','Brookline Village']].forEach(([zip, name]) => {
  t(zip + '  ' + name, zipTier(zip) === 'core', zipTier(zip));
});

console.log('\n=== 3. Boston proper is never charged the travel fee ===');
const outOfCoreBoston = REQUIRED.Boston.filter(z => zipTier(z) !== 'core');
t('all ' + REQUIRED.Boston.length + ' Boston ZIPs are core',
  outOfCoreBoston.length === 0, outOfCoreBoston);
['02138','02139','02140','02141','02142','02143','02144','02145','02445','02446','02447']
  .forEach(z => t(z + ' core', zipTier(z) === 'core', zipTier(z)));

console.log('\n=== 4. the two lists stay clean ===');
const all = ZIP_TIERS.CORE.concat(ZIP_TIERS.EXTENDED);
const dupes = all.filter((z, i) => all.indexOf(z) !== i);
t('no ZIP listed twice / in both tiers', dupes.length === 0, dupes);
const malformed = all.filter(z => typeof z !== 'string' || !/^0[12]\d{3}$/.test(z));
t('all entries are 5-digit MA ZIP strings', malformed.length === 0, malformed);
t('CORE is non-empty',     ZIP_TIERS.CORE.length > 0,     ZIP_TIERS.CORE.length);
t('EXTENDED is non-empty', ZIP_TIERS.EXTENDED.length > 0, ZIP_TIERS.EXTENDED.length);

console.log('\n=== 5. tiering still drives the $25 travel fee ===');
const q = (zip) => computeQuote({
  bedrooms: 2, bathrooms: 1, service: 'first_clean', condition: 'standard',
  addonFridge: false, addonOven: false, zip, frequency: 'once',
});
t('core     02210 -> no fee',  q('02210').zipFee === 0, q('02210').zipFee);
t('extended 02458 -> +$25',    q('02458').zipFee === PRICING.EXTENDED_ZIP_FEE, q('02458').zipFee);
t('unknown  99999 -> no fee',  q('99999').zipFee === 0, q('99999').zipFee);
t('99999 is unknown (waitlist)', zipTier('99999') === 'unknown', zipTier('99999'));
t('a Seaport 2BR/1BA quotes a real price', q('02210').displayPrice > 0, q('02210').displayPrice);

console.log('\n' + (bad ? bad + ' check(s) FAILED' : 'service-area: all checks passed')
  + '  (' + ZIP_TIERS.CORE.length + ' core / ' + ZIP_TIERS.EXTENDED.length + ' extended)');
process.exit(bad ? 1 : 0);
