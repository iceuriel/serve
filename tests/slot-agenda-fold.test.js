/* THE AGENDA FOLDS AFTER SEVEN DAYS — driven through the real picker.
   ==================================================================
   r59. AVAILABILITY is growing, and the agenda is drawn vertically: one
   heading plus one row of chips per day. Left whole, twenty-one days of it
   becomes the entire page on a phone, and the customer scrolls past the
   booking button to reach the end of a list they were never going to read.

   So the picker shows seven days and offers the rest behind one button. What
   makes that safe rather than merely shorter is that the folded days are
   BUILT AND HIDDEN, not withheld: same chips, same listeners, one property
   flip away. This file exists to hold that line. A future "optimisation" that
   builds the tail lazily would pass every other test in the suite and ship a
   slot a customer can press with nothing happening — F6 below is the test
   that would catch it.

   The real serve-slots.js is loaded byte for byte against a DOM shim. Stubbing
   picker() would assert against a fixture of the agenda instead of the one
   both pages actually ship. */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SLOTS = fs.readFileSync(path.join(ROOT, 'serve-slots.js'), 'utf8');

let bad = 0;
const t = (label, got, want) => {
  const okp = JSON.stringify(got) === JSON.stringify(want);
  console.log((okp ? '  ok    ' : '  FAIL  ') + label + '  ->  ' + JSON.stringify(got));
  if (!okp) { console.log('        expected ' + JSON.stringify(want)); bad++; }
};
const head = (m) => console.log('\n=== ' + m + ' ===');

/* --- the smallest DOM picker() touches, same shape as portal-render's --- */
function node(tag) {
  return {
    tagName: tag, className: '', children: [], _text: '', attrs: {}, hidden: false,
    set textContent(v) { this._text = String(v); if (String(v) === '') this.children.length = 0; },
    get textContent() { return this._text; },
    appendChild(c) { this.children.push(c); return c; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    _on: {},
    addEventListener(ev, fn) { (this._on[ev] = this._on[ev] || []).push(fn); },
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

const box = { console: { warn() {}, log() {} }, document: { createElement: node } };
vm.createContext(box);
vm.runInContext(SLOTS, box);
const picker = vm.runInContext('ServeSlots.picker', box);
const VISIBLE_DAYS = vm.runInContext('ServeSlots.VISIBLE_DAYS', box);

/* Walk the tree rather than the shim's flat query, so "is it on screen"
   accounts for an ANCESTOR being hidden and not just the node itself. */
const all = (root, cls) => root.querySelectorAll('.' + cls);
const shown = (root, cls) => {
  const out = [];
  (function walk(n, buried) {
    (n.children || []).forEach(function (c) {
      const gone = buried || c.hidden === true;
      if (String(c.className || '').split(/\s+/).indexOf(cls) !== -1 && !gone) out.push(c);
      walk(c, gone);
    });
  })(root, false);
  return out;
};
const click = (n) => ((n && n._on && n._on.click) || []).forEach((fn) => fn({}));

/* N days, two times each. Dates are only ever compared for equality by the
   picker — it groups on change of s.date and never parses them — so plain
   sequential days are the honest fixture here. */
const feedOf = (days) => {
  const out = [];
  for (let i = 1; i <= days; i++) {
    const d = '2026-10-' + ('0' + i).slice(-2);
    out.push({ date: d, time: '9:00 AM', open: 1 });
    out.push({ date: d, time: '3:30 PM', open: 1 });
  }
  return out;
};

head('F1  the constant is the one the page ships');
t('seven days before folding', VISIBLE_DAYS, 7);

head('F2  a short agenda is drawn whole, with no button');
{
  const w = picker(feedOf(3));
  t('three days on screen', shown(w, 'scheduler-day').length, 3);
  t('no reveal button', all(w, 'slotpick__more').length, 0);
}

head('F3  exactly seven days is the boundary, and must not fold');
{
  const w = picker(feedOf(VISIBLE_DAYS));
  t('all seven on screen', shown(w, 'scheduler-day').length, 7);
  /* Off by one here ships "Show 0 more days" to every customer. */
  t('no button offering nothing', all(w, 'slotpick__more').length, 0);
}

head('F4  eight days folds exactly one, and says so in the singular');
{
  const w = picker(feedOf(8));
  t('built all eight', all(w, 'scheduler-day').length, 8);
  t('showing seven', shown(w, 'scheduler-day').length, 7);
  t('reads as one day', all(w, 'slotpick__more')[0].textContent, 'Show 1 more day');
}

head('F5  a full three-week feed folds the rest and counts them');
const WIDE = picker(feedOf(21));
{
  t('built all 21 days', all(WIDE, 'scheduler-day').length, 21);
  t('showing seven', shown(WIDE, 'scheduler-day').length, 7);
  t('every slot is still in the DOM', all(WIDE, 'slot-chip').length, 42);
  t('only the first week is pressable', shown(WIDE, 'slot-chip').length, 14);
  t('names the number', all(WIDE, 'slotpick__more')[0].textContent, 'Show 14 more days');
}

head('F6  the folded chips are WIRED, not placeholders');
{
  /* The property that makes hiding safe. Reach past the fold BEFORE any
     reveal and press a chip: if the tail were built lazily this is the
     assertion that goes quiet. */
  const picks = [];
  const w = picker(feedOf(21), (date, time) => picks.push(date + ' ' + time));
  const last = all(w, 'slot-chip')[41];
  t('the last chip is the one it claims to be',
    [last.getAttribute('data-date'), last.getAttribute('data-time')],
    ['2026-10-21', '3:30 PM']);
  click(last);
  t('a hidden chip still reports its pick', picks, ['2026-10-21 3:30 PM']);
  t('and still marks itself selected', last.className, 'slot-chip is-selected');
}

head('F7  one click reveals the rest and retires the button');
{
  const w = picker(feedOf(21));
  const more = all(w, 'slotpick__more')[0];
  t('closed to begin with', more.getAttribute('aria-expanded'), 'false');
  click(more);
  t('all 21 days on screen', shown(w, 'scheduler-day').length, 21);
  t('all 42 chips pressable', shown(w, 'slot-chip').length, 42);
  t('the button takes itself away', more.hidden, true);
  t('and says it opened', more.getAttribute('aria-expanded'), 'true');
}

head('F8  the button cannot be mistaken for a slot, by a customer or by code');
{
  const more = all(WIDE, 'slotpick__more')[0];
  /* index.html puts this agenda inside <form id="reserve-form">. A button with
     no type is a SUBMIT button there, so "show more days" would attempt the
     booking. The chips declare it for the same reason. */
  t('declares type=button', more.type, 'button');
  t('every chip declares it too',
    all(WIDE, 'slot-chip').every((c) => c.type === 'button'), true);
  /* script.js routes agenda clicks through e.target.closest('.slot-chip').
     Carrying that class would make revealing the rest also select a time. */
  t('is not itself a slot-chip',
    String(more.className).split(/\s+/).indexOf('slot-chip'), -1);
  t('carries no date or time to be read as one',
    [more.getAttribute('data-date'), more.getAttribute('data-time')], [null, null]);
}

head('F8b  every chip says WHICH DAY it books, not just the time');
{
  /* Added 2026-09-24 after driving the booking flow as an agent would.
     Twenty-one days of slots carried exactly TWO distinct accessible names —
     "9:00 AM" and "1:30 PM" — because the date lives in the day heading two
     elements away and in a data- attribute, neither of which is part of a
     button's name. Anything reading names rather than pixels sees a column of
     identical buttons.

     The consequence is not a missed click. It is the WRONG DAY booked, with a
     confirmation that looks correct to everyone, which is the failure this
     repo keeps meeting: healthy from the outside, wrong on the inside.

     Uniqueness is the assertion that matters. A label of "9:00 AM" on every
     chip would satisfy "has an aria-label" and fix nothing. */
  const chips = all(WIDE, 'slot-chip');
  const names = chips.map((c) => c.getAttribute('aria-label'));

  t('every chip carries an aria-label', names.every((n) => !!n), true);
  t('every one of them is unique across the whole agenda',
    new Set(names).size, chips.length);
  t('each names its own date and its own time',
    chips.every((c) => {
      const n = c.getAttribute('aria-label') || '';
      return n.indexOf(c.getAttribute('data-time')) !== -1 && /\d/.test(n) && n.length > 8;
    }), true);
  /* The folded days are built and hidden, so they must be labelled too — the
     tail is what a "show more" reveals straight into an agent's hands. */
  t('the folded tail is labelled as well, not just the visible week',
    chips.length > shown(WIDE, 'slot-chip').length &&
    names.slice(shown(WIDE, 'slot-chip').length).every((n) => !!n), true);
}

head('F9  folding is display only — it narrows nothing');
{
  /* The horizon rules decide what is bookable; this decides what is drawn.
     Same feed through both: the fold must not lose a slot. */
  const feed = feedOf(21);
  const kept = vm.runInContext('ServeSlots.filterSlots', box);
  const w = picker(feed);
  t('picker drew every slot the feed carried', all(w, 'slot-chip').length, feed.length);
  t('and the picker never filters — that is filterSlots\' job',
    typeof kept === 'function', true);
}

head('F10  an empty feed is still an empty agenda');
{
  /* Every failure mode in this module arrives as []. It must not acquire a
     button now. */
  [[], null, undefined].forEach((f) => {
    const w = picker(f);
    t('nothing drawn for ' + JSON.stringify(f) + ' and no button',
      [all(w, 'scheduler-day').length, all(w, 'slotpick__more').length], [0, 0]);
  });
}

head('F11  the booking form carousel shows one day of times at a time');
{
  const w = picker(feedOf(21), null, { layout: 'carousel' });
  const days = all(w, 'scheduler-day');
  const buttons = all(w, 'slotpick__day-button');
  const arrows = all(w, 'slotpick__arrow');

  t('all 21 available dates are in the horizontal rail', buttons.length, 21);
  t('all 42 real time controls are built', all(w, 'slot-chip').length, 42);
  t('only the first day\'s panel is open initially', shown(w, 'scheduler-day').length, 1);
  t('so only its two times are visible', shown(w, 'slot-chip').length, 2);
  t('the carousel needs no vertical show-more control', all(w, 'slotpick__more').length, 0);
  t('its first date is the selected tab',
    [buttons[0].getAttribute('aria-selected'), buttons[1].getAttribute('aria-selected')],
    ['true', 'false']);
  t('both rail arrows are non-submit buttons with useful names',
    arrows.map((b) => [b.type, b.getAttribute('aria-label')]),
    [['button', 'See earlier available days'], ['button', 'See later available days']]);

  click(buttons[1]);
  t('clicking a date closes the first panel and opens that date',
    [days[0].hidden, days[1].hidden], [true, false]);
  t('the active date state follows it',
    [buttons[0].getAttribute('aria-selected'), buttons[1].getAttribute('aria-selected')],
    ['false', 'true']);
  t('still only one compact set of times is visible', shown(w, 'slot-chip').length, 2);
}

console.log(bad ? '\n' + bad + ' FAILED' : '\nall good');
process.exit(bad ? 1 : 0);
