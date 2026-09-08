/* Explainer bubbles in How Serve Works.
   ==================================================================
   A phrase in the copy that opens a short panel saying more. Small, but it is
   the only interactive thing on the marketing half of the homepage, and a
   popup that opens and then cannot be closed is worse than no popup — on a
   phone it sits over the next step until the page is reloaded.

   Two halves:
     A. the markup contract  — the wiring the script and a screen reader share
     B. the behaviour        — the real initExplainers() against a DOM shim

   Section B runs the actual code sliced out of script.js, not a copy of it. */

const REPO_ROOT = require('path').resolve(__dirname, '..');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = fs.readFileSync(path.join(REPO_ROOT, 'index.html'), 'utf8');
const CSS  = fs.readFileSync(path.join(REPO_ROOT, 'style.css'), 'utf8');
const JS   = fs.readFileSync(path.join(REPO_ROOT, 'script.js'), 'utf8');

let bad = 0;
const t = (label, got, want) => {
  const okp = JSON.stringify(got) === JSON.stringify(want);
  console.log((okp ? '  ok    ' : '  FAIL  ') + label + '  ->  ' + JSON.stringify(got));
  if (!okp) { console.log('        expected ' + JSON.stringify(want)); bad++; }
};
const ok   = (m) => console.log('  ok    ' + m);
const fail = (m) => { console.log('  FAIL  ' + m); bad++; };
const head = (m) => console.log('\n=== ' + m + ' ===');

/* ------------------------------------------------------------------ */
head('A. The markup contract');

const triggers = [...HTML.matchAll(/<button[^>]*class="[^"]*\bpop-trigger\b[^"]*"[^>]*>/g)].map(m => m[0]);
t('at least one trigger exists', triggers.length > 0, true);

/* aria-controls is not decoration here — it is how the script finds the panel,
   which is deliberately the same attribute a screen reader follows. A trigger
   pointing at nothing is a button that silently does nothing. */
triggers.forEach(tag => {
  const id = (tag.match(/aria-controls="([^"]+)"/) || [])[1];
  if (!id) { fail('a pop-trigger has no aria-controls'); return; }
  HTML.includes('id="' + id + '"')
    ? ok('trigger controls #' + id + ', which exists')
    : fail('trigger points at #' + id + ', which is not in the markup');

  /aria-expanded="false"/.test(tag)
    ? ok('#' + id + ' starts collapsed and says so')
    : fail('trigger for #' + id + ' is missing aria-expanded="false"');

  /type="button"/.test(tag)
    ? ok('trigger is type="button"')
    : fail('a pop-trigger without type="button" submits any form it lands in');
});

/* The panel must start hidden in the MARKUP, not merely be hidden by script.
   Hidden only in JS means it flashes open on every page load before the
   script runs. */
const panels = [...HTML.matchAll(/<div class="pop-bubble" id="([^"]+)"([^>]*)>/g)];
t('every bubble is hidden in the markup',
  panels.every(p => /\bhidden\b/.test(p[2])), true);
t('every bubble has a close control',
  panels.length > 0 && panels.every(p =>
    HTML.slice(HTML.indexOf(p[0])).indexOf('pop-bubble__close') <
    HTML.slice(HTML.indexOf(p[0])).indexOf('</div>') + 400), true);

/* PROGRESSIVE ENHANCEMENT, CHECKED RATHER THAN CLAIMED. Nothing a visitor
   needs in order to book may live only inside a bubble, because the bubble is
   unreachable if script.js fails to load. The paragraph around the trigger has
   to still read as a complete sentence — so the trigger's own text is part of
   the prose, not a label like "learn more". */
triggers.forEach(tag => {
  const at = HTML.indexOf(tag);
  const text = HTML.slice(at + tag.length, HTML.indexOf('</button>', at)).trim();
  /^(learn more|read more|more|info|\?)$/i.test(text)
    ? fail('trigger text "' + text + '" is a label, not prose — the sentence breaks without JS')
    : ok('trigger text reads as prose: "' + text + '"');
});

/* A bubble must not be the only place a booking path is offered. */
const bubbleBodies = [...HTML.matchAll(/<div class="pop-bubble"[\s\S]*?<\/div>/g)].map(m => m[0]);
bubbleBodies.some(b => /href="\/?#quote"/.test(b))
  ? fail('a bubble contains the booking CTA — unreachable without JavaScript')
  : ok('no bubble hides a booking path behind JavaScript');

head('A2. Styled');
['pop-trigger', 'pop-bubble', 'pop-bubble__title', 'pop-bubble__body', 'pop-bubble__close']
  .forEach(c => new RegExp('\\.' + c + '(?![\\w-])').test(CSS)
    ? ok('.' + c + ' styled')
    : fail('.' + c + ' has no CSS rule'));
/* Hidden must actually hide. `.pop-bubble` sets `position:absolute`, and a
   positioned element beats the UA stylesheet's `[hidden]{display:none}` on
   specificity in some resets — so the rule is stated explicitly. */
/\.pop-bubble\[hidden\]\s*\{\s*display:\s*none/.test(CSS)
  ? ok('[hidden] is enforced against the positioned rule')
  : fail('.pop-bubble[hidden] has no explicit display:none — it may render anyway');

/* ------------------------------------------------------------------ */
head('B. Behaviour — the real initExplainers()');

const start = JS.indexOf('(function initExplainers() {');
const end   = JS.indexOf('})();', start) + 5;
if (start === -1) throw new Error('initExplainers not found in script.js');
const src = JS.slice(start, end);

/* THE SHIM MODELS BUBBLING, and it has to.
   The first version did not, and one assertion passed on nothing because of
   it: "a click inside the panel does not close it" only holds in a browser
   because the panel calls stopPropagation before the event reaches the
   document listener that closes everything. With no bubbling, deleting that
   stopPropagation changed nothing the test could see — so the check reported
   green against code that would dismiss the bubble the moment anyone clicked
   the text inside it.

   `fire` therefore walks target -> parent -> document and stops when a
   handler calls stopPropagation, which is the only part of the DOM event
   model this code actually depends on. */
function node(tag, attrs) {
  return {
    tagName: tag, attrs: attrs || {}, hidden: false, _focused: 0,
    children: [], parent: null, handlers: {},
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    addEventListener(e, fn) { (this.handlers[e] = this.handlers[e] || []).push(fn); },
    focus() { this._focused++; },
    querySelector(sel) { return this.children.filter(c => '.' + (c.attrs.class || '') === sel)[0] || null; },
  };
}

function wire() {
  const trigger  = node('button', { class: 'pop-trigger', 'aria-controls': 'p1', 'aria-expanded': 'false' });
  const closeBtn = node('button', { class: 'pop-bubble__close' });
  const panel    = node('div', { id: 'p1' });
  panel.children.push(closeBtn);
  closeBtn.parent = panel;
  panel.hidden = true;

  const docHandlers = {};
  const documentNode = { handlers: docHandlers, parent: null };

  trigger.parent = documentNode;
  panel.parent   = documentNode;

  /* Dispatch up the chain, honouring stopPropagation. */
  function fire(target, type, init) {
    let stopped = false;
    const ev = Object.assign({ type: type, stopPropagation() { stopped = true; } }, init || {});
    let n = target;
    while (n && !stopped) {
      (n.handlers[type] || []).slice().forEach(fn => { if (!stopped) fn(ev); });
      n = n.parent;
    }
  }

  const box = {
    console,
    document: {
      querySelectorAll: (sel) => (sel === '.pop-trigger' ? [trigger] : []),
      getElementById: (id) => (id === 'p1' ? panel : null),
      addEventListener: (e, fn) => { (docHandlers[e] = docHandlers[e] || []).push(fn); },
    },
  };
  vm.createContext(box);
  vm.runInContext(src, box);

  /* A throw is reported as a failed assertion rather than crashing the file.
     Removing the "nothing is open" guard from the Escape handler used to take
     the whole run down with a stack trace, which is a detection but a bad one
     — it tells you the file exploded, not which behaviour broke. */
  const guard = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

  return {
    trigger, panel, closeBtn,
    click: (target) => guard(() => fire(target, 'click')),
    doc:   (type, init) => guard(() => fire(documentNode, type, init)),
    state: () => [panel.hidden, trigger.attrs['aria-expanded']],
  };
}

let w = wire();
t('starts closed', w.state(), [true, 'false']);
t('opening throws nothing', w.click(w.trigger), null);
t('click opens it', w.state(), [false, 'true']);
w.click(w.trigger);
t('clicking the trigger again closes it', w.state(), [true, 'false']);

/* The trigger's own click must not bubble into the dismiss-everything handler
   — without stopPropagation there, opening and closing happen in the same
   gesture and the bubble never appears at all. */
w = wire();
w.click(w.trigger);
t('the opening click does not immediately dismiss itself', w.state(), [false, 'true']);

w = wire();
w.click(w.trigger);
w.doc('click');
t('a click anywhere else closes it', w.state(), [true, 'false']);

w = wire();
w.click(w.trigger);
w.click(w.panel);
t('a click INSIDE the panel does not close it', w.state(), [false, 'true']);

w = wire();
w.click(w.trigger);
t('Escape throws nothing', w.doc('keydown', { key: 'Escape' }), null);
t('Escape closes it', w.state(), [true, 'false']);
t('Escape returns focus to the trigger', w.trigger._focused > 0, true);

/* Escape is a document-level handler. If it acted when nothing is open it
   would steal focus from wherever the visitor actually is — and reaching for
   a trigger that is not there is how it throws instead. */
w = wire();
t('Escape while closed throws nothing', w.doc('keydown', { key: 'Escape' }), null);
t('Escape while closed moves no focus', w.trigger._focused, 0);
w.doc('keydown', { key: 'a' });
t('an unrelated key does nothing', w.state(), [true, 'false']);

w = wire();
w.click(w.trigger);
w.click(w.closeBtn);
t('the close button closes it', w.state(), [true, 'false']);
t('and hands focus back rather than stranding it', w.trigger._focused > 0, true);

/* A trigger whose panel is missing must be inert, never fatal — this block
   runs on /pricing and /services too, where the markup is absent. */
const box2 = {
  console,
  document: {
    querySelectorAll: () => [node('button', { class: 'pop-trigger', 'aria-controls': 'nope' })],
    getElementById: () => null,
    addEventListener: () => {},
  },
};
vm.createContext(box2);
let threw = null;
try { vm.runInContext(src, box2); } catch (e) { threw = e.message; }
t('a trigger with no panel is inert, not fatal', threw, null);

const box3 = { console, document: { querySelectorAll: () => [], getElementById: () => null,
                                    addEventListener: () => { throw new Error('must not wire up'); } } };
vm.createContext(box3);
threw = null;
try { vm.runInContext(src, box3); } catch (e) { threw = e.message; }
t('a page with no triggers wires up nothing at all', threw, null);

console.log('\n' + (bad ? bad + ' FAILURES' : 'all explainer checks passed'));
process.exit(bad ? 1 : 0);
