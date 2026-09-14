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
  /* r44: every GET of the feed, so warming it can be counted rather than
     assumed. */
  const slotGets = [];
  /* r45: every ask of the pricing engine, and what it was asked. */
  const quotes = [];
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
      /* r45. The Worker's pricing engine, which the move plan box asks for
         this home's recurring prices. Not a portal write. */
      if (String(url).indexOf('/api/quote') === 0) {
        quotes.push(JSON.parse(init.body));
        const q = opts.quote === undefined
          ? { ok: true, price: 999, recurring: { weekly: 180, biweekly: 210, monthly: 260 } }
          : opts.quote;
        return Promise.resolve({ ok: true, json: () => Promise.resolve(q) });
      }
      if (init && init.method === 'POST') {
        posts.push(JSON.parse(init.body));
        served = opts.after || Object.assign({}, model, { plan: null });
        return Promise.resolve({ ok: true, json: () => Promise.resolve(
          opts.reply || { ok: true, job_id: 'SRV-CONFIRMED' }) });
      }
      if (String(url).indexOf('/api/slots') === 0) {
        slotGets.push(url);
        return Promise.resolve({ ok: true, json: () => Promise.resolve(
          { ok: true, slots: opts.slots || FEED }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(served) });
    },
  };
  box.window = box;
  /* r44: a clock the test can move, so "fresh for a minute" is checked
     without waiting a minute. Everything else about Date is the real one. */
  if (opts.clock) {
    const RealDate = Date;
    box.Date = class extends RealDate {
      static now() { return opts.clock.now; }
    };
  }
  vm.createContext(box);
  vm.runInContext(SCOPE, box);
  /* r43: SKIPPABLE, so the page can be driven without the slots module. The
     two halves of "change this visit" degrade separately — a missing scheduler
     may cost the move control, but it must never cost the ability to call a
     visit off, or a customer who cannot stop a cleaner arriving is on the
     phone instead. */
  if (!opts.noSlots) vm.runInContext(SLOTS, box);
  vm.runInContext(PARTNER, box);
  vm.runInContext(PORTAL, box);
  /* One macrotask flushes every pending microtask in the chain. */
  const settle = async () => {
    for (let i = 0; i < 3; i++) await new Promise(r => setImmediate(r));
  };
  await settle();
  return { body: els['p-body'] || node('div'), state: els['p-state'] || node('div'),
           warns, posts, settle, slotGets, quotes };
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

  head('G. r43 — the two controls, and what they ask before acting');

  /* Two buttons share a class, so "the first one" is not a selector. Reaching
     for them by their words is also what a person does. */
  const clickText = (root, cls, text) => {
    const n = byClass(root, cls).filter(x => x._text === text)[0];
    ((n && n._on && n._on.click) || []).forEach((fn) => fn({}));
  };

  const G = await boot(model());

  t('an open booking offers both ways to change it',
    byClass(G.body, 'sched__btn').map(n => n._text),
    ['Change time', 'Cancel visit', 'Keep it']);
  t('a finished booking offers neither',
    byClass(G.body, 'pb--done').length === 1 && byClass(G.body, 'sched').length === 1, true);
  t('nothing is asked before cancelling is chosen',
    (byClass(G.body, 'sched__confirm')[0] || {}).hidden, true);
  t('and nothing can be moved before a time is chosen',
    (byClass(G.body, 'sched__go')[0] || {}).hidden, true);
  t('opening the portal sends nothing', G.posts, []);

  click(G.body, 'sched__btn--quiet');
  await G.settle();

  /* ASKING IS NOT DOING. Cancelling gives a slot back to somebody else, so it
     asks twice — and the question itself must reach no server. */
  t('choosing to cancel asks first',
    (byClass(G.body, 'sched__confirm')[0] || {}).hidden, false);
  t('and asking sends nothing', G.posts, []);
  t('it says plainly what cancelling costs them', textOf(G.body, 'sched__warn'),
    'Cancelling gives this time back to another customer. We cannot promise ' +
    'the same slot if you change your mind.');

  clickText(G.body, 'sched__btn', 'Keep it');
  await G.settle();
  t('backing out closes the question',
    (byClass(G.body, 'sched__confirm')[0] || {}).hidden, true);
  t('and still sends nothing', G.posts, []);

  click(G.body, 'sched__btn--quiet');
  click(G.body, 'sched__yes');
  await G.settle();

  t('confirming sends exactly one request', G.posts.length, 1);
  t('naming the booking, and carrying no time at all',
    G.posts[0], { event_type: 'portal_write', contact_id: 'CON-1', t: 'tok',
                  kind: 'cancel', job_id: 'SRV-1' });
  t('and none of that threw', G.warns, []);

  head('H. A cancelled visit reads as a record, not as an appointment');

  const CANCELLED = model({ bookings: [
    { bookingId: 'SRV-1', serviceLabel: 'First clean · deep clean',
      serviceCode: 'CLEAN_DEEP', date: '2026-09-18', time: '9:00 AM',
      price: 420, paid: false, completed: '', cancelled: true,
      rooms: [], partner: null },
    { bookingId: 'SRV-0', serviceLabel: 'Move-out clean',
      serviceCode: 'CLEAN_MOVEOUT', date: '2026-08-02', time: '1:00 PM',
      price: 300, paid: true, completed: '2026-08-02', rooms: [], photos: [] },
  ] });
  const H = await boot(CANCELLED);

  /* IT LEAVES UPCOMING ENTIRELY. A visit nobody is coming to, sitting at the
     top of the page under a heading that says it is coming, is the one place
     it must never be. */
  t('it is not upcoming, and it is not past', headings(H.body), ['Past', 'Cancelled']);
  t('it is labelled without having to be opened', textOf(H.body, 'pb__tag'), 'Cancelled');
  t('and reads as struck through', byClass(H.body, 'pb--cancelled').length, 1);
  t('it says in words that nobody is coming',
    byClass(H.body, 'tk-note').some(n => n._text.indexOf('nobody is coming') !== -1), true);

  /* NOTHING ACTIONABLE SURVIVES ON IT. */
  t('no control that could change it', byClass(H.body, 'sched__btn').length, 0);
  t('no payment button on a visit that will not happen',
    byClass(H.body, 'pay__btn').length, 0);
  t('and renders without throwing', H.warns, []);

  head('I. Moving a visit to another time');

  const I = await boot(model());
  click(I.body, 'sched__btn');
  await I.settle();

  /* THE HORIZON RULES ARE THE PAGE'S, AND THEY ARE THE SAME ONES. Six slots
     served; the one with nobody open, the one already past and the one beyond
     three weeks are dropped here exactly as they are on the booking form. */
  t('only the bookable times are offered',
    byClass(I.body, 'slot-chip').map(n => n._text), ['9:00 AM', '1:00 PM', '11:00 AM']);
  t('and looking sends nothing', I.posts, []);

  click(I.body, 'slot-chip');
  await I.settle();
  t('a move control appears once a time is chosen',
    (byClass(I.body, 'sched__go')[0] || {}).hidden, false);
  t('choosing a time still sends nothing', I.posts, []);

  click(I.body, 'sched__move');
  await I.settle();

  t('moving sends exactly one request', I.posts.length, 1);
  t('naming the booking and the new time, and nothing else',
    I.posts[0], { event_type: 'portal_write', contact_id: 'CON-1', t: 'tok',
                  kind: 'reschedule', job_id: 'SRV-1',
                  slot_date: isoOf(SOON), slot_time: '9:00 AM' });
  t('and none of that threw', I.warns, []);

  head('J. Without the scheduler, calling off still works');

  /* The move control needs serve-slots.js. Cancelling does not, and must not:
     losing the ability to stop a cleaner arriving because a script failed to
     load is the worse failure by far. */
  const J = await boot(model(), { noSlots: true });

  t('the move control is simply absent',
    byClass(J.body, 'sched__btn').map(n => n._text), ['Cancel visit', 'Keep it']);
  t('and no dead control is offered in its place',
    byClass(J.body, 'sched__move').length, 0);

  click(J.body, 'sched__btn--quiet');
  click(J.body, 'sched__yes');
  await J.settle();

  t('the visit can still be called off', (J.posts[0] || {}).kind, 'cancel');
  t('and nothing threw', J.warns, []);

  head('K. The schedule is asked for before the click (r44)');

  /* "Loading times..." used to start on click and last as long as the feed
     took. Now the page asks once as it opens, when something on it could use
     the answer, and a click inside a minute uses what is already in hand. */
  const clock = { now: 1000000 };
  const K = await boot(model(), { clock });
  t('an open plan and an upcoming visit warm the feed before any click', K.slotGets.length, 1);

  click(K.body, 'sched__btn');
  await K.settle();
  t('opening "move" uses the warmed answer instead of asking again', K.slotGets.length, 1);
  t('and still offers exactly the bookable times',
    byClass(K.body, 'slot-chip').map(n => n._text), ['9:00 AM', '1:00 PM', '11:00 AM']);

  click(K.body, 'plan__cta');
  await K.settle();
  t('so does choosing a time for the plan', K.slotGets.length, 1);

  const NOTHING = model({ plan: null, bookings: [
    { bookingId: 'SRV-0', serviceLabel: 'Move-out clean', serviceCode: 'CLEAN_MOVEOUT',
      date: '2026-08-02', time: '1:00 PM', price: 300, paid: true,
      completed: '2026-08-02', rooms: [], photos: [] },
    { bookingId: 'SRV-9', serviceLabel: 'First clean', serviceCode: 'CLEAN_DEEP',
      date: '2026-09-01', time: '9:00 AM', price: 200, paid: false, completed: '',
      cancelled: true, rooms: [], partner: null },
  ] });
  const K0 = await boot(NOTHING);
  t('a page with nothing to schedule does not ask at all', K0.slotGets.length, 0);

  /* An empty answer is as likely to be a slow server as a full calendar. */
  const KE = await boot(model(), { slots: [] });
  t('an empty warm answer is still one request', KE.slotGets.length, 1);
  click(KE.body, 'sched__btn');
  await KE.settle();
  t('but is not kept: the click asks again', KE.slotGets.length, 2);

  const later = { now: 5000000 };
  const KC = await boot(model(), { clock: later });
  later.now += 61000;
  click(KC.body, 'sched__btn');
  await KC.settle();
  t('a click more than a minute later asks again', KC.slotGets.length, 2);

  /* Moving a visit changes what is open. The warmed list no longer says. */
  const KM = await boot(model(), { clock: { now: 9000000 } });
  click(KM.body, 'sched__btn');
  await KM.settle();
  click(KM.body, 'slot-chip');
  click(KM.body, 'sched__move');
  await KM.settle();
  t('the move went through', (KM.posts[0] || {}).kind, 'reschedule');
  const before = KM.slotGets.length;
  click(KM.body, 'sched__btn');
  await KM.settle();
  t('after a move, the next look at the schedule asks again', KM.slotGets.length, before + 1);
  t('and none of section K threw', [].concat(K.warns, K0.warns, KE.warns, KC.warns, KM.warns), []);

  head('L. r45 — a plan after a move');

  /* The move booking, a move date between the two bookable days of FEED, and
     the plan box the server sends for it. */
  const AFTER = isoOf(dayAt(5));
  const MOVE_BOOKING = { bookingId: 'SRV-M', serviceLabel: 'Move in / move out',
    serviceCode: 'CLEAN_MOVEOUT', date: AFTER, time: '9:00 AM', price: 640, paid: false,
    completed: '', rooms: [], partner: null };
  const HOME = { zip: '02116', bedrooms: 3, bathrooms: 2, levels: 2 };
  const CHOOSE = { state: 'choose', jobId: 'SRV-M', propertyLabel: '9 Tremont St, 2',
    after: AFTER, home: HOME, samePartner: false };
  const moveModel = (mp, extra) => model({ plan: null, movePlan: mp,
    bookings: [MOVE_BOOKING].concat((extra || {}).bookings || []) });
  const opt = (root, f) => all(root).filter(n => n.attrs && n.attrs['data-frequency'] === f)[0];
  const tap = (n) => ((n && n._on && n._on.click) || []).forEach(fn => fn({}));
  const VISIT = { bookingId: 'SRV-V', serviceLabel: 'Recurring clean', serviceCode: 'CLEAN_STANDARD',
    date: isoOf(LATER), time: '11:00 AM', price: 210, paid: false, completed: '', rooms: [], partner: null };
  const SAVED = Object.assign({}, CHOOSE, { state: 'saved', planId: 'PLN-M', frequency: 'biweekly',
    price: 199, visitId: 'SRV-V', sameAsked: false });

  const L1 = await boot(moveModel(CHOOSE), {
    after: moveModel(Object.assign({}, SAVED, { price: 210 }), { bookings: [VISIT] }) });
  t('a move customer sees the plan box', byClass(L1.body, 'mplan').length, 1);
  t('naming the home it is for', textOf(L1.body, 'mplan__home'), 'For 9 Tremont St, 2');
  t('the engine is asked once, about that home, on the recurring track',
    L1.quotes, [{ zip: '02116', bedrooms: 3, bathrooms: 2, levels: 2,
      service: 'first_clean', condition: 'standard', frequency_selected: 'once' }]);
  t('the three plans, in order, at the engine\'s prices',
    byClass(L1.body, 'mplan__opt').map(n => textOf(n, 'mplan__optname') + ' ' + textOf(n, 'mplan__optprice')),
    ['Every week $180.00 per visit', 'Every 2 weeks $210.00 per visit', 'Every month $260.00 per visit']);
  t('nothing can be confirmed yet', (byClass(L1.body, 'mplan__go')[0] || {}).hidden, true);
  t('and no button on the page is disabled — the live refresh would freeze',
    all(L1.body).filter(n => n.tagName === 'button' && n.disabled).length, 0);
  t('an untouched box does not hold off the live refresh',
    /is-dirty/.test((byClass(L1.body, 'mplan')[0] || {}).className || ''), false);
  t('opening it sends nothing', L1.posts, []);

  tap(opt(L1.body, 'biweekly'));
  await L1.settle();
  t('picking a plan marks it', ((opt(L1.body, 'biweekly') || { attrs: {} }).attrs)['aria-pressed'], 'true');
  t('and holds off the live refresh',
    /is-dirty/.test((byClass(L1.body, 'mplan')[0] || {}).className || ''), true);
  t('times offered are only those AFTER the move clean',
    byClass(L1.body, 'slot-chip').map(n => n.attrs['data-date'] + ' ' + n._text),
    [isoOf(LATER) + ' 11:00 AM']);
  t('still nothing to confirm without a time', (byClass(L1.body, 'mplan__go')[0] || {}).hidden, true);

  click(L1.body, 'slot-chip');
  await L1.settle();
  t('it says back the plan, the price and the first visit', textOf(L1.body, 'mplan__chosen'),
    'Every 2 weeks at $210.00 per visit · first visit on ' + prettyOf(LATER) + ' at 11:00 AM');
  t('now it can be confirmed', (byClass(L1.body, 'mplan__go')[0] || {}).hidden, false);
  t('choosing sent nothing', L1.posts, []);

  click(L1.body, 'mplan__go');
  await L1.settle();
  t('starting sends one request: the move, the plan, the price SHOWN, the time',
    L1.posts, [{ event_type: 'portal_write', contact_id: 'CON-1', t: 'tok', kind: 'plan_start',
      job_id: 'SRV-M', same_provider: false, frequency: 'biweekly', shown_price: 210,
      slot_date: isoOf(LATER), slot_time: '11:00 AM' }]);
  t('the box becomes the saved plan', textOf(L1.body, 'mplan__tag'), 'Your recurring plan');
  t('with its cadence', textOf(L1.body, 'mplan__title'), 'Every 2 weeks');
  t('its price', textOf(L1.body, 'mplan__price'), '$210.00 per visit');
  t('and the visit it booked', textOf(L1.body, 'mplan__next'),
    'Next visit: ' + prettyOf(LATER) + ' · 11:00 AM');
  t('the saved box is static — no plan tiles, no times',
    [byClass(L1.body, 'mplan__opt').length, byClass(L1.body, 'mplan__slots').length], [0, 0]);
  t('the visit is listed under Upcoming', headings(L1.body)[0], 'Upcoming');

  /* ---- earlier / later, when none of the times suit ---- */
  const L2 = await boot(moveModel(Object.assign({}, CHOOSE, { samePartner: true })));
  tap(opt(L2.body, 'monthly'));
  await L2.settle();
  t('the earlier/later choice waits behind "none of these work"',
    (byClass(L2.body, 'mplan__prefs')[0] || {}).hidden, true);
  click(L2.body, 'mplan__other');
  const laterBtn = all(L2.body).filter(n => n.attrs && n.attrs['data-pref'] === 'later')[0];
  tap(laterBtn);
  await L2.settle();
  t('choosing "later" says what happens next', textOf(L2.body, 'mplan__chosen'),
    'Every month at $260.00 per visit · first visit later in the day — we will call to set the day');
  const box2 = all(L2.body).filter(n => n.tagName === 'input')[0];
  if (box2) box2.checked = true;
  click(L2.body, 'mplan__go');
  await L2.settle();
  const p2 = L2.posts[0] || {};
  t('it sends the preference and no slot',
    [p2.kind, p2.frequency, p2.shown_price, p2.time_preference, 'slot_date' in p2],
    ['plan_start', 'monthly', 260, 'later', false]);
  t('a same-company request is a yes, never a company',
    [p2.same_provider, JSON.stringify(p2).includes('VEN')], [true, false]);

  /* ---- changing a saved plan ---- */
  const L3 = await boot(moveModel(SAVED, { bookings: [VISIT] }));
  t('a saved plan offers a change', textOf(L3.body, 'mplan__edit'), 'Change plan or time');
  t('and asks the engine nothing until then', L3.quotes.length, 0);
  click(L3.body, 'mplan__edit');
  await L3.settle();
  t('changing shows the plans, the current one chosen',
    ((opt(L3.body, 'biweekly') || { attrs: {} }).attrs)['aria-pressed'], 'true');
  t('the current plan keeps the price it was booked at, not today\'s',
    textOf(opt(L3.body, 'biweekly') || {}, 'mplan__optprice'), '$199.00 per visit');
  t('keeping the visit\'s time is the default',
    ((byClass(L3.body, 'mplan__keep')[0] || { attrs: {} }).attrs)['aria-pressed'], 'true');
  t('with nothing changed there is nothing to save', (byClass(L3.body, 'mplan__go')[0] || {}).hidden, true);
  tap(opt(L3.body, 'monthly'));
  await L3.settle();
  t('a different cadence can be saved', (byClass(L3.body, 'mplan__go')[0] || {}).hidden, false);
  click(L3.body, 'mplan__go');
  await L3.settle();
  t('it sends the plan, the new cadence and its shown price — and no time',
    L3.posts, [{ event_type: 'portal_write', contact_id: 'CON-1', t: 'tok', kind: 'plan_change',
      plan_id: 'PLN-M', frequency: 'monthly', shown_price: 260 }]);

  const L4 = await boot(moveModel(SAVED, { bookings: [VISIT] }));
  click(L4.body, 'mplan__edit');
  await L4.settle();
  click(L4.body, 'mplan__cancel');
  await L4.settle();
  t('"keep my plan" puts the saved box back, sending nothing',
    [textOf(L4.body, 'mplan__tag'), L4.posts.length], ['Your recurring plan', 0]);

  /* ---- the engine's price moved between looking and choosing ---- */
  const L5 = await boot(moveModel(CHOOSE), { reply: { ok: false, error: 'price_changed',
    prices: { weekly: 185, biweekly: 215, monthly: 265 } } });
  tap(opt(L5.body, 'biweekly'));
  await L5.settle();
  click(L5.body, 'slot-chip');
  click(L5.body, 'mplan__go');
  await L5.settle();
  t('a changed price is shown, not booked',
    textOf(opt(L5.body, 'biweekly') || {}, 'mplan__optprice'), '$215.00 per visit');
  t('and the customer is told to look again',
    byClass(L5.body, 'tk-save').map(n => n._text).filter(Boolean),
    ['Prices were just updated. Please check the price and confirm again.']);
  click(L5.body, 'mplan__go');
  await L5.settle();
  t('confirming again sends the NEW price', (L5.posts[1] || {}).shown_price, 215);

  /* ---- the engine cannot be reached ---- */
  const L6 = await boot(moveModel(CHOOSE), { quote: { ok: false, error: 'cannot_price' } });
  t('no prices, no plans to pick', byClass(L6.body, 'mplan__opt').length, 0);
  t('and it says so, with a retry',
    [textOf(byClass(L6.body, 'mplan')[0] || {}, 'tk-note'), textOf(L6.body, 'mplan__retry')],
    ['We could not load prices just now.', 'Try again']);

  const L7 = await boot(model({ plan: null }));
  t('nobody else sees a plan box, or asks the engine anything',
    [byClass(L7.body, 'mplan').length, L7.quotes.length], [0, 0]);

  t('and none of section L threw',
    [].concat(L1.warns, L2.warns, L3.warns, L4.warns, L5.warns, L6.warns, L7.warns), []);

  console.log('\n' + (bad ? bad + ' FAILURES' : 'all portal-render checks passed'));
  process.exit(bad ? 1 : 0);
})();
