/* Protected-portal visual contract.
   The theme is deliberately scoped: /h, /j and /v should share the branded
   shell without recolouring the public site or changing their functional ids. */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const css = read('style.css');

let failed = 0;
function check(name, condition) {
  if (condition) console.log('  PASS  ' + name);
  else { console.error('  FAIL  ' + name); failed++; }
}

const pages = [
  ['h.html', 'portal-body--account', 'p-nav', 'p-body'],
  ['j.html', 'portal-body--ticket', null, 't-body'],
  ['v.html', 'portal-body--account', 'v-nav', 'v-body'],
];

console.log('\n=== protected portal shell ===');
pages.forEach(([file, variant, navId, bodyId]) => {
  const html = read(file);
  check(file + ' opts into the shared portal theme',
    /<body class="[^"]*\bportal-body\b/.test(html) && html.includes(variant));
  check(file + ' uses the white Serve mark on its navy header',
    /class="ticket__brand-mark"\s+src="images\/serve-wordmark\.svg"\s+alt="Serve"/.test(html));
  check(file + ' keeps its live content mount', html.includes(`id="${bodyId}"`));
  if (navId) check(file + ' keeps its single accessible navigation',
    (html.match(new RegExp(`id="${navId}"`, 'g')) || []).length === 1 &&
    html.includes('aria-label="Sections"'));
});

console.log('\n=== styling remains scoped and responsive ===');
check('the public site is not opted into the protected theme',
  !/<body class="[^"]*\bportal-body\b/.test(read('index.html')));
check('the theme owns a navy, blue, canvas and card palette',
  /\.portal-body\s*\{[\s\S]*--portal-navy:[^;]+;[\s\S]*--portal-blue:[^;]+;[\s\S]*--portal-canvas:[^;]+;[\s\S]*--portal-card:[^;]+;/.test(css));
check('account portals retain the desktop rail layout',
  /@media \(min-width: 720px\)[\s\S]*\.portal-body--account \.portal\s*\{[\s\S]*grid-template-columns:\s*16\.125rem minmax\(0, 1fr\)/.test(css));
check('phone navigation remains horizontally scrollable',
  /\.portal-body--account \.portal__nav\s*\{[\s\S]*overflow-x:\s*auto/.test(css));
check('the job ticket stays a focused single-column card',
  /\.portal-body--ticket \.ticket\s*\{[\s\S]*max-width:\s*46rem/.test(css));
check('keyboard focus remains visible in the new theme',
  /\.portal-body :is\([^}]+\):focus-visible\s*\{[\s\S]*outline:/.test(css));
check('the incomplete access tag has a high-contrast fill and border',
  /\.portal-body \.portal__access-flag\.is-incomplete\s*\{[^}]*color:\s*#8f1d18;[^}]*border:\s*1px solid #ef6b62;[^}]*background:\s*#ffe5e2;/.test(css));
check('customer bookings use a compact calendar tile and explicit action row',
  /\.pb__date\s*\{[^}]*width:\s*3\.5rem;[^}]*height:\s*3\.5rem;/.test(css) &&
  /\.pb__actions\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/.test(css));
check('availability is presented as responsive day cards',
  /\.slotpick\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*repeat\(auto-fit, minmax\(10\.5rem, 1fr\)\)/.test(css) &&
  /\.scheduler-day__date\s*\{[^}]*width:\s*3\.15rem;[^}]*height:\s*3\.15rem;/.test(css));

process.exit(failed ? 1 : 0);
