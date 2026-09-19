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
      /* A FUNCTION when the answer must CHANGE between reads. r58 asks the
         account more than once precisely because the write it is asking about
         may still be running, and a fixture that is already settled on the
         first read cannot express that. */
      return Promise.resolve({ ok: true, json: () => Promise.resolve(
        typeof served === 'function' ? served() : served) });
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
  /* `box` is handed back for the same reason opts.clock exists: r58's confirm
     waits between attempts, and a test that actually waited would spend ten
     real seconds proving the browser is patient. */
  return { body: els['p-body'] || node('div'), state: els['p-state'] || node('div'),
           warns, posts, settle, slotGets, quotes, box };
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
     all mean the same thing to the customer.

     AN EMPTY FEED IS ORDINARY, AND IT MUST NOT BE A DEAD END. The founder
     refills AVAILABILITY by hand each week, so "nothing open on screen" is a
     state this card meets often — and on 2026-09-18 it met it for real, with
     every open row in the sheet already in the past. Until then the card's
     whole answer was "call us", which loses every customer who will not phone
     and turns the ones who do into a voicemail instead of a row in JOBS. */
  const F = await boot(model(), { slots: [] });
  click(F.body, 'plan__cta');
  await F.settle();

  t('it says so plainly rather than showing an empty box',
    byClass(F.body, 'plan__body').some(n => n._text.indexOf('no open times') !== -1), true);
  /* The POINT of the release: a way forward on the page itself. */
  t('and offers earlier / later rather than only a phone number',
    byClass(F.body, 'plan__pref').map(n => n.getAttribute('data-pref')),
    ['earlier', 'later']);
  t('revealed, not left hidden behind a disclosure nobody opens',
    (byClass(F.body, 'plan__prefs')[0] || {}).hidden, false);
  /* The BUTTON's own hidden flag is never set — its row is what is revealed
     when a time is chosen, so the row is what proves it cannot be reached. */
  t('with no confirm control until one is chosen',
    (byClass(F.body, 'plan__row')[0] || {}).hidden, true);
  t('nothing was requested merely by looking', F.posts, []);

  /* CHOOSING ONE BOOKS THE PLAN. */
  click(F.body, 'plan__pref');
  await F.settle();

  t('choosing a preference arms the confirm button',
    (byClass(F.body, 'plan__row')[0] || {}).hidden, false);
  t('and says what was chosen, in the customer\'s own terms',
    byClass(F.body, 'plan__chosen').some(n => /earlier in the day/i.test(n._text)), true);

  click(F.body, 'plan__go');
  await F.settle();

  t('confirming sends exactly one request', F.posts.length, 1);
  /* A PREFERENCE, AND NO SLOT. Sending both would leave the server deciding
     which of two answers the customer meant; sending a blank slot_date is how
     `bad_slot` came back for somebody who chose perfectly clearly. */
  t('carrying the preference and no slot at all',
    F.posts[0], { event_type: 'portal_write', contact_id: 'CON-1', t: 'tok',
                  kind: 'plan_confirm', plan_id: 'PLN-20260910-1',
                  time_preference: 'earlier', same_provider: false });
  t('and nothing threw', F.warns, []);

  head('F2. A full feed still offers the escape hatch');

  /* Six open times and none of them work is an ordinary Tuesday. The booking
     form has always offered this; the plan card did not. One click away rather
     than on screen competing with the real times. */
  const F2 = await boot(model());
  click(F2.body, 'plan__cta');
  await F2.settle();

  t('the way out is offered', byClass(F2.body, 'plan__other').length, 1);
  t('but stays out of the way until asked for',
    (byClass(F2.body, 'plan__prefs')[0] || {}).hidden, true);

  click(F2.body, 'plan__other');
  await F2.settle();

  t('asking for it reveals the choice',
    (byClass(F2.body, 'plan__prefs')[0] || {}).hidden, false);

  /* A SLOT AND A PREFERENCE ARE TWO ANSWERS TO ONE QUESTION. Whichever was
     chosen last is the one that gets sent, and the other must be cleared —
     both in what is posted and in what the customer can see. */
  click(F2.body, 'slot-chip');
  await F2.settle();
  click(F2.body, 'plan__pref');
  await F2.settle();
  click(F2.body, 'plan__go');
  await F2.settle();

  t('a preference chosen after a slot replaces it',
    F2.posts[0], { event_type: 'portal_write', contact_id: 'CON-1', t: 'tok',
                   kind: 'plan_confirm', plan_id: 'PLN-20260910-1',
                   time_preference: 'earlier', same_provider: false });

  const F3 = await boot(model());
  click(F3.body, 'plan__cta');
  await F3.settle();
  click(F3.body, 'plan__other');
  await F3.settle();
  click(F3.body, 'plan__pref');
  await F3.settle();
  click(F3.body, 'slot-chip');
  await F3.settle();

  /* Asserted BEFORE confirming: a successful confirm re-reads the account and
     the whole card goes away, so anything checked after it is checking a page
     that no longer has one. */
  t('the abandoned preference is visibly deselected',
    byClass(F3.body, 'plan__pref').map(n => n.getAttribute('aria-pressed')),
    ['false', 'false']);

  click(F3.body, 'plan__go');
  await F3.settle();

  t('and a slot chosen after a preference replaces that',
    F3.posts[0], { event_type: 'portal_write', contact_id: 'CON-1', t: 'tok',
                   kind: 'plan_confirm', plan_id: 'PLN-20260910-1',
                   slot_date: isoOf(SOON), slot_time: '9:00 AM',
                   same_provider: false });
  t('and nothing threw', F3.warns, []);

  head('F4. r58 — a slow confirm is not a failed confirm');

  /* THE BUG THE FOUNDER HIT ON 2026-09-18, in a test portal. The plan was
     confirmed: the JOBS row was written, the plan was marked booked and the
     confirmation email arrived. The card said it did not go through.

     Nothing was wrong with the booking. The Worker gives a portal write twelve
     seconds (UPSTREAM_TIMEOUT_MS.submit) and then answers 502, and Apps Script
     never hears that it stopped listening — so it finishes the write nobody is
     waiting for any more. This page used to read that silence as a refusal.

     THE ACCOUNT IS THE ONLY HONEST WITNESS, and it is already reachable: the
     next read of it no longer offers the plan, because clientRecurringPlan
     offers PENDING plans only. */
  const F4 = await boot(model(), { reply: { ok: false, error: 'upstream_unreachable' } });
  click(F4.body, 'plan__cta');
  await F4.settle();
  click(F4.body, 'slot-chip');
  await F4.settle();
  click(F4.body, 'plan__go');
  /* ONE REAL TICK, and the real schedule. That the first question is asked
     with no delay at all is half the point — twelve seconds have already gone
     by, and the answer is usually waiting. F6 below collapses time; this one
     must not. */
  await new Promise((r) => setTimeout(r, 20));
  await F4.settle();

  t('a Worker that stopped listening is not reported as a refusal',
    byClass(F4.body, 'tk-save').map(n => n._text).filter(Boolean), []);
  t('the card gives way to the booking that really was made',
    byClass(F4.body, 'plan').length, 0);
  /* Asking is a READ. A second confirm would be a second plan. */
  t('and it asked rather than sending the booking twice', F4.posts.length, 1);
  t('and nothing threw', F4.warns, []);

  /* THE SECOND HALF OF THE SAME BUG. Somebody told "that did not go through"
     presses it again, and the script — correctly — refuses the duplicate.
     `already_confirmed` was then printed in red over a plan that IS booked,
     which is how a customer ends up phoning to ask which screen to believe. */
  const F5 = await boot(model(), { reply: { ok: false, error: 'already_confirmed' } });
  click(F5.body, 'plan__cta');
  await F5.settle();
  click(F5.body, 'slot-chip');
  await F5.settle();
  click(F5.body, 'plan__go');
  await F5.settle();

  t('"already booked" is shown as the success it is, not an error',
    byClass(F5.body, 'tk-save').map(n => n._text).filter(Boolean), []);
  t('and the booked plan stops being offered', byClass(F5.body, 'plan').length, 0);
  t('and nothing threw', F5.warns, []);

  /* THE CASE THAT ACTUALLY HAPPENS. The Worker gave up at twelve seconds
     because the write was SLOW, so at the moment of the first question it is
     very often still running — the plan is still pending, and the honest
     answer is "not yet". One question would report a failure here. Asking
     again is the whole reason there is a schedule and not a single poll. */
  let reads = 0;
  const F6a = await boot(model(), {
    reply: { ok: false, error: 'upstream_unreachable' },
    after: () => (++reads >= 2 ? model({ plan: null }) : model()),
  });
  click(F6a.body, 'plan__cta');
  await F6a.settle();
  click(F6a.body, 'slot-chip');
  await F6a.settle();
  F6a.box.setTimeout = (fn) => setImmediate(fn);
  click(F6a.body, 'plan__go');
  for (let i = 0; i < 8; i++) await F6a.settle();

  t('a write still finishing is waited for, not written off',
    byClass(F6a.body, 'plan').length, 0);
  t('and it took more than one question to find out', reads >= 2, true);
  t('while the customer was told it was still working, never that it failed',
    byClass(F6a.body, 'tk-save').map(n => n._text).filter(Boolean), []);
  t('and nothing threw', F6a.warns, []);

  /* A WRITE THAT REALLY DID FAIL STILL SAYS SO. The account is asked, the
     answers run out, and the customer is told the truth — late, but true. The
     failure here is that this case might be swallowed into a cheerful screen,
     which would be the original bug pointing the other way. */
  const F6 = await boot(model(), {
    reply: { ok: false, error: 'upstream_unreachable' },
    after: model(),                     // the plan is still pending, every time
  });
  click(F6.body, 'plan__cta');
  await F6.settle();
  click(F6.body, 'slot-chip');
  await F6.settle();
  /* Time, collapsed — see boot's `box`. */
  F6.box.setTimeout = (fn) => setImmediate(fn);
  click(F6.body, 'plan__go');
  for (let i = 0; i < 12; i++) await F6.settle();

  t('a write that truly did not land is still reported as a failure',
    byClass(F6.body, 'tk-save').map(n => n._text).filter(Boolean),
    ['That did not go through. Please try again.']);
  t('the card stays, so the customer can try again',
    byClass(F6.body, 'plan').length, 1);
  t('and asking never turned into booking again', F6.posts.length, 1);
  t('and nothing threw', F6.warns, []);

  /* A READ THAT FAILED IS NOT AN ANSWER EITHER. An account that cannot be
     reached carries no `plan` — and "no plan offered" is the very signal that
     means the confirm landed. Taken at face value, an outage on the read would
     congratulate the customer on a booking that does not exist, which is the
     original bug inverted and worse. */
  const F6b = await boot(model(), {
    reply: { ok: false, error: 'upstream_unreachable' },
    after: () => ({ ok: false, error: 'upstream_unreachable' }),
  });
  click(F6b.body, 'plan__cta');
  await F6b.settle();
  click(F6b.body, 'slot-chip');
  await F6b.settle();
  F6b.box.setTimeout = (fn) => setImmediate(fn);
  click(F6b.body, 'plan__go');
  for (let i = 0; i < 12; i++) await F6b.settle();

  t('an unreachable account is never read as a completed booking',
    byClass(F6b.body, 'plan').length, 1);
  t('and the customer is told the truth instead',
    byClass(F6b.body, 'tk-save').map(n => n._text).filter(Boolean),
    ['That did not go through. Please try again.']);
  t('and nothing threw', F6b.warns, []);

  /* A REFUSAL THE SCRIPT ACTUALLY MADE IS NOT AMBIGUOUS, and must not be
     softened into "still working on it". The customer needs to pick another
     time, and every second spent politely re-asking is a second the slot they
     want is being taken by somebody else. */
  const F7 = await boot(model(), { reply: { ok: false, error: 'bad_slot' } });
  click(F7.body, 'plan__cta');
  await F7.settle();
  click(F7.body, 'slot-chip');
  await F7.settle();
  click(F7.body, 'plan__go');
  await F7.settle();

  t('a real refusal is reported at once, in its own words',
    byClass(F7.body, 'tk-save').map(n => n._text).filter(Boolean),
    ['That time is no longer available. Please pick another.']);
  t('without re-reading the account to second-guess it', F7.posts.length, 1);
  t('and nothing threw', F7.warns, []);

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

  /* ---- r59: the same box, worded for a one-time deep clean ---- */
  /* The server decides WHO is asked; `kind` decides only what the box calls
     the clean it follows. Saying "after your move" to somebody who booked a
     deep clean is the whole failure this guards against. */
  const DEEP_BOOKING = { bookingId: 'SRV-D', serviceLabel: 'First Clean',
    serviceCode: 'CLEAN_DEEP', date: AFTER, time: '9:00 AM', price: 420, paid: false,
    completed: '', rooms: [], partner: null };
  const deepModel = (mp) => model({ plan: null, movePlan: mp, bookings: [DEEP_BOOKING] });
  const DEEP_CHOOSE = Object.assign({}, CHOOSE, { kind: 'deep', jobId: 'SRV-D',
    samePartner: true });

  const L8 = await boot(deepModel(DEEP_CHOOSE));
  t('a one-time deep clean sees the same box', byClass(L8.body, 'mplan').length, 1);
  t('worded for the clean they actually had', textOf(L8.body, 'mplan__tag'),
    'After your deep clean');
  t('and the same-company line names that clean too',
    all(L8.body).map(n => n._text).filter(s => s && /same cleaning company/.test(s)),
    ['Ask for the same cleaning company as your deep clean']);

  /* THE OLD SCRIPT'S ANSWER. A webhook older than r59 sends no `kind` at all,
     and the box must still work — reading slightly wrong beats going blank. */
  const L9 = await boot(moveModel(Object.assign({}, CHOOSE, { samePartner: true })));
  t('no kind at all falls back to the move wording', textOf(L9.body, 'mplan__tag'),
    'After your move');

  const L10 = await boot(deepModel(Object.assign({}, DEEP_CHOOSE, { state: 'saved',
    planId: 'PLN-D', frequency: 'biweekly', price: 210, visitId: '', sameAsked: true })));
  t('a saved deep-clean plan says which clean it followed',
    all(L10.body).map(n => n._text).filter(s => s && /same cleaning company/.test(s)),
    ['You asked for the same cleaning company as your deep clean.']);

  t('and none of section L threw',
    [].concat(L1.warns, L2.warns, L3.warns, L4.warns, L5.warns, L6.warns, L7.warns,
              L8.warns, L9.warns, L10.warns), []);

  head('M. r48: notes the cleaner left, on the customer\'s own bookings');

  const notesOn = (root, id) => {
    const panel = all(root).filter(n => n.attrs && n.attrs['data-live-key'] === id)[0] || {};
    return byClass(panel, 'tk-blk')
      .filter(b => textOf(b, 'tk-lbl') === 'Notes from your service partner')
      .map(b => byClass(b, 'tk-val').map(v => v._text));
  };
  const withNotes = model({ plan: null });
  withNotes.bookings[0].partnerNotes = [{ roomLabel: 'Kitchen', note: 'Oven door sticks' },
                                        { roomLabel: 'Bathroom 1', note: 'Fan is loud' }];
  withNotes.bookings[1].partnerNotes = [{ roomLabel: 'Bedroom 1', note: 'Closet light is out' }];
  const M1 = await boot(withNotes);
  t('an upcoming booking shows them, room by room',
    notesOn(M1.body, 'SRV-1'), [['Kitchen: Oven door sticks', 'Bathroom 1: Fan is loud']]);
  t('a finished booking keeps them', notesOn(M1.body, 'SRV-0'), [['Bedroom 1: Closet light is out']]);
  const M2 = await boot(model({ plan: null }));
  t('no notes, no block', [notesOn(M2.body, 'SRV-1'), notesOn(M2.body, 'SRV-0')], [[], []]);
  t('and section M did not throw', [].concat(M1.warns, M2.warns), []);

  head('N. r58 — the same honesty on the other slow writes');

  /* The plan card was the one that was REPORTED, but every portal write shares
     the Worker's 12s budget, so every one of them can be told a completed write
     failed. Each surface gets its OWN question, because "did it land" is a
     different fact each time and a shared guess is worse than none. */

  /* ---- CANCELLING. The highest-stakes of the three: somebody wrongly told the
          cancellation failed either phones us, or assumes a cleaner is still
          coming and waits in for one who is not. `cancelled` is a real boolean
          on the row, built so the browser never has to read job_status. ---- */
  const cancelled = model({ plan: null });
  cancelled.bookings[0] = Object.assign({}, cancelled.bookings[0], { cancelled: true });
  const N1 = await boot(model({ plan: null }), {
    reply: { ok: false, error: 'upstream_unreachable' },
    after: cancelled,
  });
  click(N1.body, 'sched__btn--quiet');
  click(N1.body, 'sched__yes');
  await new Promise((r) => setTimeout(r, 20));
  await N1.settle();

  /* Asserted on the REPAINTED page, like section D: once the answer is in, the
     card is rebuilt from the account and the status line it was written on no
     longer exists. What matters is that the visit now reads as called off and
     no failure was ever shown. */
  t('a cancellation that landed repaints as called off',
    [byClass(N1.body, 'pb--cancelled').length, textOf(N1.body, 'pb__tag')], [1, 'Cancelled']);
  t('and no failure was left on screen',
    byClass(N1.body, 'tk-save').map(n => n._text).filter(Boolean), []);
  t('and it asked rather than cancelling twice', N1.posts.length, 1);
  t('and nothing threw', N1.warns, []);

  /* AND THE DANGEROUS DIRECTION. A cancellation that did NOT land must never
     be reported as done — somebody who believes a visit is called off and is
     wrong gets a cleaner at the door, which is worse than any error message.
     The account still showing a live booking is the whole answer. */
  const N1b = await boot(model({ plan: null }), {
    reply: { ok: false, error: 'upstream_unreachable' },
    after: model({ plan: null }),                    // still very much booked
  });
  click(N1b.body, 'sched__btn--quiet');
  N1b.box.setTimeout = (fn) => setImmediate(fn);
  click(N1b.body, 'sched__yes');
  for (let i = 0; i < 12; i++) await N1b.settle();

  t('a cancellation that did NOT land is never reported as done',
    byClass(N1b.body, 'tk-save').map(n => n._text).filter(Boolean),
    ['That did not go through. Please try again.']);
  t('and the visit is still shown as happening',
    byClass(N1b.body, 'pb--cancelled').length, 0);
  t('and nothing threw', N1b.warns, []);

  /* ---- MOVING A VISIT, AND THE TRAP IN IT. The account returns the time as a
          DISPLAY string with ET appended; the feed returns it raw. Comparing
          them as they arrive is false forever — a guard that reads perfectly
          and never fires once. That bug has shipped here before. ---- */
  const moved = model({ plan: null });
  moved.bookings[0] = Object.assign({}, moved.bookings[0],
    { date: isoOf(SOON), time: '9:00 AM ET' });      // as the sheet really answers
  const N2 = await boot(model({ plan: null }), {
    reply: { ok: false, error: 'upstream_unreachable' },
    after: moved,
  });
  click(N2.body, 'sched__btn');
  await N2.settle();
  click(N2.body, 'slot-chip');
  await N2.settle();
  click(N2.body, 'sched__move');
  await new Promise((r) => setTimeout(r, 20));
  await N2.settle();

  t('a move that landed is recognised through the ET the sheet appends',
    byClass(N2.body, 'tk-save').map(n => n._text).filter(Boolean), []);
  t('and the visit repaints on the time that was asked for',
    textOf(N2.body, 'pb__when'), prettyOf(SOON) + ' · 9:00 AM ET');
  t('and it asked rather than moving the visit twice', N2.posts.length, 1);
  t('and nothing threw', N2.warns, []);

  /* THE PREDICATE MUST NOT BE MERELY LOOSE. A visit that came back sitting on
     some OTHER time is not the move that was asked for, and calling it one
     would report a success that never happened — the failure r58 exists to
     prevent, pointing the other way. */
  const elsewhere = model({ plan: null });
  elsewhere.bookings[0] = Object.assign({}, elsewhere.bookings[0],
    { date: isoOf(SOON), time: '1:00 PM ET' });
  const N3 = await boot(model({ plan: null }), {
    reply: { ok: false, error: 'upstream_unreachable' },
    after: elsewhere,
  });
  click(N3.body, 'sched__btn');
  await N3.settle();
  click(N3.body, 'slot-chip');                       // 9:00 AM
  await N3.settle();
  N3.box.setTimeout = (fn) => setImmediate(fn);
  click(N3.body, 'sched__move');
  for (let i = 0; i < 12; i++) await N3.settle();

  t('a visit found on a different time is NOT called a successful move',
    byClass(N3.body, 'tk-save').map(n => n._text).filter(Boolean),
    ['That did not go through. Please try again.']);
  t('and nothing threw', N3.warns, []);

  /* ---- STARTING A PLAN AFTER A MOVE. `choose` becoming `saved` is
          unambiguous, so this one can be asked about. ---- */
  const N4 = await boot(moveModel(CHOOSE), {
    reply: { ok: false, error: 'upstream_unreachable' },
    after: moveModel(SAVED, { bookings: [VISIT] }),
  });
  tap(opt(N4.body, 'biweekly'));
  await N4.settle();
  click(N4.body, 'slot-chip');
  await N4.settle();
  click(N4.body, 'mplan__go');
  await new Promise((r) => setTimeout(r, 20));
  await N4.settle();

  t('a plan started after a move leaves no failure on screen',
    byClass(N4.body, 'tk-save').map(n => n._text).filter(Boolean), []);
  t('and it repaints as the plan, not the chooser',
    /mplan--saved/.test((byClass(N4.body, 'mplan')[0] || {}).className || ''), true);
  t('and it asked rather than starting two plans', N4.posts.length, 1);
  t('and nothing threw', N4.warns, []);

  /* AND THE DANGEROUS DIRECTION AGAIN: a box still saying `choose` means no
     plan was started, however long the write took. */
  const N4b = await boot(moveModel(CHOOSE), {
    reply: { ok: false, error: 'upstream_unreachable' },
    after: moveModel(CHOOSE),                        // nothing was ever saved
  });
  tap(opt(N4b.body, 'biweekly'));
  await N4b.settle();
  click(N4b.body, 'slot-chip');
  await N4b.settle();
  N4b.box.setTimeout = (fn) => setImmediate(fn);
  click(N4b.body, 'mplan__go');
  for (let i = 0; i < 12; i++) await N4b.settle();

  t('a plan that was never started is not reported as booked',
    byClass(N4b.body, 'tk-save').map(n => n._text).filter(Boolean),
    ['That did not go through. Please try again.']);
  t('and nothing threw', N4b.warns, []);

  /* ---- CHANGING AN EXISTING PLAN IS DELIBERATELY LEFT ALONE, and this pins
          that decision so it is not quietly "improved" later. Changing the TIME
          keeps the frequency, so the only fact the model exposes is already
          true before the write; asking would report success without checking
          anything. Until the model carries the plan's time, the old behaviour
          is the honest one. ---- */
  let planReads = 0;
  const N5 = await boot(moveModel(SAVED, { bookings: [VISIT] }), {
    reply: { ok: false, error: 'upstream_unreachable' },
    after: () => { planReads++; return moveModel(SAVED, { bookings: [VISIT] }); },
  });
  click(N5.body, 'mplan__edit');
  await N5.settle();
  /* THE EXACT HAZARD: the TIME is changed and the cadence deliberately left
     alone, so "the plan is biweekly" — the only fact the model carries — is
     already true before the write ever happens. */
  click(N5.body, 'slot-chip');
  await N5.settle();
  click(N5.body, 'mplan__go');
  await new Promise((r) => setTimeout(r, 20));
  await N5.settle();

  t('a plan CHANGE is still reported honestly rather than guessed at',
    byClass(N5.body, 'tk-save').map(n => n._text).filter(Boolean),
    ['That did not go through. Please try again.']);
  t('and the account is not asked a question it cannot answer', planReads, 0);
  t('and nothing threw', N5.warns, []);

  console.log('\n' + (bad ? bad + ' FAILURES' : 'all portal-render checks passed'));
  process.exit(bad ? 1 : 0);
})();
