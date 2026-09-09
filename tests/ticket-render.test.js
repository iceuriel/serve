/* The ticket header — one line per fact, never the same fact twice.
   ==================================================================
   A booking with a confirmed slot carries a date and a window. A booking made
   on a time PREFERENCE carries neither: `start_time` and the schedule summary
   both hold the same sentence, and rendering each in turn printed it twice at
   the top of both tickets. Found in production on SRV-20260908-805851, where
   the two fields were byte-identical:

       date : ""
       time : "Later in the day (typically 12:00 PM - 5:00 PM)"
       when : "Later in the day (typically 12:00 PM - 5:00 PM)"

   This drives the real scheduleHead() out of ticket.js against a DOM shim, so
   what is asserted is the shipped function rather than a copy of its rules. */

const REPO_ROOT = require('path').resolve(__dirname, '..');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const JS = fs.readFileSync(path.join(REPO_ROOT, 'ticket.js'), 'utf8');

let bad = 0;
const t = (label, got, want) => {
  const okp = JSON.stringify(got) === JSON.stringify(want);
  console.log((okp ? '  ok    ' : '  FAIL  ') + label + '  ->  ' + JSON.stringify(got));
  if (!okp) { console.log('        expected ' + JSON.stringify(want)); bad++; }
};
const ok   = (m) => console.log('  ok    ' + m);
const fail = (m) => { console.log('  FAIL  ' + m); bad++; };
const head = (m) => console.log('\n=== ' + m + ' ===');

/* Slice the two helpers the header needs, from the real file. */
const cut = (from, to) => {
  const i = JS.indexOf(from), j = JS.indexOf(to, i);
  if (i === -1 || j === -1) throw new Error('could not slice: ' + from);
  return JS.slice(i, j);
};
const src =
  cut('function el(tag, cls, text)', 'function block(') +
  cut('function prettyDate(iso)', 'function render(d)') +
  cut('function scheduleHead(b, subParts)', '/* ========================================================\n       CLIENT');

function node(tag) {
  return {
    tagName: tag, className: '', children: [], _text: '',
    set textContent(v) { this._text = v; },
    get textContent() { return this._text; },
    appendChild(c) { this.children.push(c); return c; },
  };
}
const box = { document: { createElement: node }, console };
vm.createContext(box);
vm.runInContext(src + '\nglobalThis.h = scheduleHead;', box);

/** The rendered header as [class, text] pairs — what a person would see. */
const lines = (b, sub) => box.h(b, sub).children.map(n => [n.className, n._text]);

/* ------------------------------------------------------------------ */
head('A. The bug: a preference booking said it twice');

const PREF = 'Later in the day (typically 12:00 PM - 5:00 PM)';
t('identical time and summary render ONCE',
  lines({ date: '', time: PREF, when: PREF }),
  [['tk-time', PREF]]);

/* Punctuation must not smuggle a duplicate through — the two fields are
   written by different code paths and one may gain a comma. */
t('and still once when punctuation differs',
  lines({ date: '', time: PREF, when: 'Later in the day — typically 12:00PM-5:00PM.' }),
  [['tk-time', PREF]]);

head('B. A confirmed slot still shows the day and the window');
t('date and time both render',
  lines({ date: '2026-09-10', time: '9-11 AM', when: '' }),
  [['tk-day', 'Thursday, Sep 10'], ['tk-time', '9-11 AM']]);

/* The summary repeats the window next to a date that already says the day. */
t('a summary that merely repeats the window is dropped',
  lines({ date: '2026-09-10', time: '9-11 AM', when: 'Thursday 10 September, 9-11 AM' }),
  [['tk-day', 'Thursday, Sep 10'], ['tk-time', '9-11 AM']]);

head('C. Genuinely different lines are both kept');
t('two different facts both render',
  lines({ date: '', time: '9-11 AM', when: 'Second visit of a biweekly plan' }),
  [['tk-time', '9-11 AM'], ['tk-time', 'Second visit of a biweekly plan']]);

head('D. Nothing to say, nothing rendered');
t('an empty booking renders no lines', lines({ date: '', time: '', when: '' }), []);
t('whitespace is not a line', lines({ date: '', time: '   ', when: '' }), []);
t('a malformed date is skipped rather than shown raw',
  lines({ date: 'not-a-date', time: '9-11 AM', when: '' }), [['tk-time', '9-11 AM']]);

head('E. The subtitle');
t('sub parts join with a separator and drop empties',
  lines({ date: '', time: PREF, when: PREF }, ['First clean', '', '2 BR / 1 BA']),
  [['tk-time', PREF], ['tk-sub', 'First clean · 2 BR / 1 BA']]);
t('an all-empty sub renders no subtitle',
  lines({ date: '', time: PREF, when: PREF }, ['', null]).length, 1);

head('F. Both views share this function');
/* Two renderers building their own header is how they drift into describing
   the same booking differently. */
const calls = (JS.match(/scheduleHead\(/g) || []).length;
t('scheduleHead is defined once and called by both views', calls, 3);
/\bvar head = el\('div', 'tk-when'\)/.test(JS.replace(/function scheduleHead[\s\S]*?\n    }/, ''))
  ? fail('a renderer still builds its own header inline')
  : ok('neither renderer builds a header of its own');

console.log('\n' + (bad ? bad + ' FAILURES' : 'all ticket-render checks passed'));
process.exit(bad ? 1 : 0);
