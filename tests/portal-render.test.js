/* THE PORTAL'S RENDER PATH, DRIVEN THE WAY A BROWSER DRIVES IT.
   ==================================================================
   r38 shipped a plan card no customer could ever see. The line that drew it
   read `d.plan`, and `d` is the fetch callback's parameter — it does not exist
   inside renderBookings(), where the model is called `model`. Every
   server-side test passed, because the fault was in the browser file and
   nothing in this suite had ever executed one.

   It did not look like a crash, which is why it survived two releases. The
   throw happened AFTER the upcoming rows were already on the page and was
   swallowed by the .catch() on the load promise, so the portal rendered up to
   that line and stopped: no plan card, and no Past section either. Ten plans
   sat in the sheet, correct and invisible.

   This boots the real portal.js — byte for byte, IIFE and all — against a DOM
   shim and a stubbed fetch, then asserts what a person would actually see.
   partner-card.js and serve-scope.js are loaded for real rather than stubbed:
   bookingRow() calls ServePartner.block() with no typeof guard, so a stub
   would be asserting against a fixture instead of the shipped page. */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const PORTAL  = fs.readFileSync(path.join(ROOT, 'portal.js'), 'utf8');
const PARTNER = fs.readFileSync(path.join(ROOT, 'partner-card.js'), 'utf8');
const SCOPE   = fs.readFileSync(path.join(ROOT, 'serve-scope.js'), 'utf8');

let bad = 0;
const t = (label, got, want) => {
  const okp = JSON.stringify(got) === JSON.stringify(want);
  console.log((okp ? '  ok    ' : '  FAIL  ') + label + '  ->  ' + JSON.stringify(got));
  if (!okp) { console.log('        expected ' + JSON.stringify(want)); bad++; }
};
const head = (m) => console.log('\n=== ' + m + ' ===');

/* --- the smallest DOM that portal.js actually touches --- */
function node(tag) {
  return {
    tagName: tag, className: '', children: [], _text: '', attrs: {}, hidden: false,
    classList: { toggle() {}, add() {}, remove() {} },
    set textContent(v) {
      this._text = String(v);
      /* Clearing a node empties it, the way paint() relies on. */
      if (String(v) === '') this.children.length = 0;
    },
    get textContent() { return this._text; },
    appendChild(c) { this.children.push(c); return c; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    addEventListener() {},
    querySelectorAll() { return []; },
    querySelector() { return null; },
  };
}

/**
 * Load the page with this model and return what it drew.
 *
 * A fresh context every time: portal.js keeps module state, and a second
 * render into a used context would be asserting against the first one.
 */
async function boot(model) {
  const els = {};
  const warns = [];
  const box = {
    console: {
      log() {},
      /* The swallowed throw lands here. Keeping the message makes a failure
         name the bug instead of just reporting an empty page. */
      warn() {
        warns.push(Array.prototype.slice.call(arguments).map(
          x => (x && x.message) ? String(x.message) : String(x)).join(' '));
      },
      error() { warns.push('error: ' + Array.prototype.slice.call(arguments).join(' ')); },
    },
    document: {
      createElement: node,
      getElementById(id) { els[id] = els[id] || node('div'); return els[id]; },
    },
    location: { search: '?id=CON-1&t=tok', href: '' },
    URLSearchParams: URLSearchParams,
    sessionStorage: { getItem() { return null; }, setItem() {} },
    fetch: () => Promise.resolve({ json: () => Promise.resolve(model) }),
  };
  box.window = box;
  vm.createContext(box);
  vm.runInContext(SCOPE, box);
  vm.runInContext(PARTNER, box);
  vm.runInContext(PORTAL, box);
  /* One macrotask flushes every pending microtask in the load chain. */
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  return { body: els['p-body'] || node('div'), state: els['p-state'] || node('div'), warns };
}

/* --- reading the rendered tree. Every lookup degrades rather than throws:
       a regression must fail an assertion, not kill the file. --- */
const all = (n) => (n.children || []).reduce((a, c) => a.concat([c], all(c)), []);
const byClass = (root, cls) => all(root).filter(
  n => String(n.className || '').split(/\s+/).indexOf(cls) !== -1);
const textOf = (root, cls) => (byClass(root, cls)[0] || {})._text || '';
const headings = (root) => byClass(root, 'portal__h').map(n => n._text);

const PLAN = { planId: 'PLN-20260910-1', frequency: 'weekly', price: 180,
               expiresAt: '2026-09-20', afterJobId: 'SRV-20260910-1' };

function model(over) {
  return Object.assign({
    ok: true, view: 'portal', firstName: 'Logan',
    bookings: [
      { bookingId: 'SRV-1', serviceLabel: 'First clean · deep clean',
        serviceCode: 'CLEAN_DEEP', date: '2026-09-18', time: '9:00 AM',
        price: 420, paid: false, completed: '', rooms: [], partner: null },
      { bookingId: 'SRV-0', serviceLabel: 'Move-out clean',
        serviceCode: 'CLEAN_MOVEOUT', date: '2026-08-02', time: '1:00 PM',
        price: 300, paid: true, completed: '2026-08-02', rooms: [], photos: [] },
    ],
    homes: [], plan: PLAN,
  }, over || {});
}

/* The card quotes a date, so build the expectation the way a reader would
   read it rather than hardcoding a weekday that a changed fixture would
   silently invalidate. */
const D = new Date(2026, 8, 20);
const PRETTY = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][D.getDay()] +
               ', Sep ' + D.getDate();

(async function main() {

  head('A. The bug: the plan card was drawn from a variable that does not exist');

  const A = await boot(model());

  /* THE ASSERTION THAT WOULD HAVE CAUGHT IT. A ReferenceError in the render
     path is swallowed by the load promise, so nothing crashes and nothing is
     logged where anyone would look. */
  t('the bookings tab renders without throwing', A.warns, []);

  t('the plan card is on the page', byClass(A.body, 'plan').length, 1);
  t('it says plainly that it is not booked', textOf(A.body, 'plan__tag'), 'Not booked yet');
  t('it names the cadence', textOf(A.body, 'plan__title'), 'Your weekly plan');
  t('and holds the price they were quoted', textOf(A.body, 'plan__price'), '$180.00 per visit');
  t('and says how long that price stands',
    textOf(A.body, 'plan__when'), 'This price is held until ' + PRETTY + '.');

  /* The collateral damage, and the reason the page looked merely incomplete
     rather than broken: everything after the throwing line vanished too. */
  t('the Past section after it still renders', headings(A.body), ['Upcoming', 'Past']);

  head('B. A customer with no plan is shown no plan');

  const B = await boot(model({ plan: null }));
  t('no card, and no empty shell either', byClass(B.body, 'plan').length, 0);
  t('renders without throwing', B.warns, []);
  t('and the rest of the page is untouched', headings(B.body), ['Upcoming', 'Past']);

  head('C. A plan with no cadence is not a plan');

  const C = await boot(model({ plan: { planId: 'PLN-X', price: 180 } }));
  t('nothing is drawn for it', byClass(C.body, 'plan').length, 0);
  t('renders without throwing', C.warns, []);

  console.log('\n' + (bad ? bad + ' FAILURES' : 'all portal-render checks passed'));
  process.exit(bad ? 1 : 0);
})();
