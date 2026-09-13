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
/* r42: loaded for real, like the other two. The plan card's confirm flow is
   built out of ServeSlots.load and ServeSlots.picker, and stubbing them would
   assert against a fixture of the agenda instead of the one that ships. */
const SLOTS   = fs.readFileSync(path.join(ROOT, 'serve-slots.js'), 'utf8');

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
    /* LISTENERS ARE KEPT rather than dropped on the floor. r42 put the first
       real interaction on this page — choose a time, then confirm — and a shim
       that swallows addEventListener can only ever test the first paint. */
    _on: {},
    addEventListener(ev, fn) { (this._on[ev] = this._on[ev] || []).push(fn); },
    /* Only the class selector ServeSlots.picker actually uses. Everything else
       answers empty, exactly as it did before. */
    querySelectorAll(sel) {
      if (!/^\.[\w-]+$/.test(String(sel))) return [];
      const want = String(sel).slice(1);
      const out = [];
      (function walk(n) {
        (n.children || []).forEach(function (c) {
          if (String(c.className || '').split(/\s+/).indexOf(want) !== -1) out.push(c);
          walk(c);
        });
      })(this);
      return out;
    },
    querySelector() { return null; },
  };
}

/**
 * Load the page with this model and return what it drew.
 *
 * A fresh context every time: portal.js keeps module state, and a second
 * render into a used context would be asserting against the first one.
 */
/* The feed, built RELATIVE TO TODAY rather than pinned to fixed dates. That
   makes the horizon rules themselves the thing under test — three of the six
   below must never reach the screen (nobody open, already past, beyond the
   three-week horizon) — and it keeps that true on every future day the suite
   is run, instead of quietly rotting into a calendar-flaky red. */
const dayAt   = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d; };
const isoOf   = (d) => d.getFullYear() + '-' +
  ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
const prettyOf = (d) =>
  ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()] + ', ' +
  ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()] +
  ' ' + d.getDate();

const SOON = dayAt(3), LATER = dayAt(9);
const FEED = [
  { date: isoOf(SOON),      time: '9:00 AM',  open: 1 },
  { date: isoOf(SOON),      time: '1:00 PM',  open: 1 },
  { date: isoOf(LATER),     time: '11:00 AM', open: 2 },
  { date: isoOf(dayAt(4)),  time: '8:00 AM',  open: 0 },   // nobody actually open
  { date: isoOf(dayAt(-2)), time: '9:00 AM',  open: 1 },   // already gone
  { date: isoOf(dayAt(60)), time: '9:00 AM',  open: 1 },   // past the horizon
];

/* Fire what a real click would fire. */
const click = (root, cls) => {
  const n = byClass(root, cls)[0];
  ((n && n._on && n._on.click) || []).forEach((fn) => fn({}));
};

async function boot(model, opts) {
  opts = opts || {};
  const els = {};
  const warns = [];
  const posts = [];
  /* What the NEXT read of the account returns. After a confirmation the offer
     has become a booking, so a page that repaints must stop offering it. */
  let served = model;
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
    /* ServeSlots.load races the feed against a timeout. No timers, no agenda. */
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    fetch: (url, init) => {
      if (init && init.method === 'POST') {
        posts.push(JSON.parse(init.body));
        served = opts.after || Object.assign({}, model, { plan: null });
        return Promise.resolve({ ok: true, json: () => Promise.resolve(
          opts.reply || { ok: true, job_id: 'SRV-CONFIRMED' }) });
      }
      if (String(url).indexOf('/api/slots') === 0) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(
          { ok: true, slots: opts.slots || FEED }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(served) });
    },
  };
  box.window = box;
  vm.createContext(box);
  vm.runInContext(SCOPE, box);
  vm.runInContext(SLOTS, box);
  vm.runInContext(PARTNER, box);
  vm.runInContext(PORTAL, box);
  /* One macrotask flushes every pending microtask in the chain. */
  const settle = async () => {
    for (let i = 0; i < 3; i++) await new Promise(r => setImmediate(r));
  };
  await settle();
  return { body: els['p-body'] || node('div'), state: els['p-state'] || node('div'),
           warns, posts, settle };
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

  head('D. r42 — choosing a time, and confirming it');

  const D = await boot(model());

  t('the card offers a way to book it', textOf(D.body, 'plan__cta'), 'Choose a time');
  t('and shows no times until it is asked', byClass(D.body, 'slot-chip').length, 0);
  /* Opening a portal must not reserve, request or confirm anything. */
  t('opening the portal sends nothing', D.posts, []);

  click(D.body, 'plan__cta');
  await D.settle();

  /* THE HORIZON RULES ARE THE PAGE'S, NOT THE FEED'S. Six slots were served;
     the one with nobody open, the one already past and the one beyond three
     weeks are the page's job to drop. */
  t('only the bookable times are offered',
    byClass(D.body, 'slot-chip').map(n => n._text), ['9:00 AM', '1:00 PM', '11:00 AM']);
  t('grouped under one heading per day',
    byClass(D.body, 'scheduler-day__head').length, 2);
  t('and nothing can be confirmed before a time is chosen',
    (byClass(D.body, 'plan__row')[0] || {}).hidden, true);
  t('a customer with no previous company is not asked about one',
    byClass(D.body, 'plan__samewrap').length, 0);

  click(D.body, 'slot-chip');
  await D.settle();

  /* Choosing is not confirming. */
  t('choosing a time still sends nothing', D.posts, []);
  t('it says back exactly which visit is about to be booked',
    textOf(D.body, 'plan__chosen'),
    'Your first weekly visit: ' + prettyOf(SOON) + ' at 9:00 AM');

  click(D.body, 'plan__go');
  await D.settle();

  t('confirming sends exactly one request', D.posts.length, 1);
  t('carrying the plan, the time, and the credential — and nothing else',
    D.posts[0], { event_type: 'portal_write', contact_id: 'CON-1', t: 'tok',
                  kind: 'plan_confirm', plan_id: 'PLN-20260910-1',
                  slot_date: isoOf(SOON), slot_time: '9:00 AM', same_provider: false });

  /* THE CONSEQUENCE, not just the request: the account is re-read and the
     offer is gone, because it is a booking now. */
  t('the offer stops being offered once it is booked', byClass(D.body, 'plan').length, 0);
  t('and none of that threw', D.warns, []);

  head('E. Asking for the same company as last time');

  const E = await boot(model({ plan: Object.assign({}, PLAN, { samePartner: true }) }));
  click(E.body, 'plan__cta');
  await E.settle();

  t('the question waits until there is a visit to ask about',
    (byClass(E.body, 'plan__samewrap')[0] || {}).hidden, true);

  click(E.body, 'slot-chip');
  await E.settle();

  t('then it is asked', (byClass(E.body, 'plan__samewrap')[0] || {}).hidden, false);
  /* IT IS A REQUEST AND SAYS SO. Serve assigns the visit; a promise about
     which company turns up is not this page's to make. */
  t('as a request, in those words', textOf(E.body, 'plan__samenote'),
    'We pass this on when we assign the visit. It is a request, not a guarantee.');

  const ticked = all(E.body).filter(n => n.tagName === 'input')[0];
  if (ticked) ticked.checked = true;
  click(E.body, 'plan__go');
  await E.settle();

  t('ticking it sends the request', (E.posts[0] || {}).same_provider, true);
  /* The browser says yes or no. WHICH company that means is the server's to
     resolve, from the booking it came from. */
  t('and the browser never names a company',
    /VEN|vendor/.test(JSON.stringify(E.posts[0] || {})), false);

  head('F. When there are no times to offer');

  /* An unreachable feed, a slow one, one answering ok:false and one with
     genuinely nothing open all arrive here as the same empty list — and they
     all mean the same thing to the customer. */
  const F = await boot(model(), { slots: [] });
  click(F.body, 'plan__cta');
  await F.settle();

  t('it says so plainly rather than showing an empty box',
    byClass(F.body, 'plan__body').some(n => n._text.indexOf('no open times') !== -1), true);
  /* The BUTTON's own hidden flag is never set — its row is what is revealed
     when a time is chosen, so the row is what proves it cannot be reached. */
  t('and offers no confirm control that could not work',
    (byClass(F.body, 'plan__row')[0] || {}).hidden, true);
  t('nothing was requested', F.posts, []);
  t('and nothing threw', F.warns, []);

  console.log('\n' + (bad ? bad + ' FAILURES' : 'all portal-render checks passed'));
  process.exit(bad ? 1 : 0);
})();
