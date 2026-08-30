/* Feed the REAL slots from testAvailability() through the site's actual
   filterSlots / formatSlotDate, sliced live out of script.js. */
/* Repo-relative so this runs from a clean clone on any machine. */
const REPO_ROOT = require('path').resolve(__dirname, '..');
const fs = require('fs');
const vm = require('vm');

const SITE = fs.readFileSync(require('path').join(REPO_ROOT, 'script.js'), 'utf8');
const slice = SITE.slice(SITE.indexOf('const HORIZON_DAYS'),
                         SITE.indexOf('/* Swap which time control is live'));
const box = { console };
vm.createContext(box);
vm.runInContext(slice, box);
const filterSlots     = vm.runInContext('filterSlots', box);
const formatSlotDate  = vm.runInContext('formatSlotDate', box);
const HORIZON_DAYS    = vm.runInContext('HORIZON_DAYS', box);

/* Verbatim from the execution log. */
const LIVE = [
  { date: '2026-07-30', time: '8:00 AM',  open: 1 },
  { date: '2026-07-31', time: '8:00 AM',  open: 1 },
  { date: '2026-07-31', time: '3:30 PM',  open: 1 },
  { date: '2026-07-31', time: '5:30 PM',  open: 1 },
  { date: '2026-08-03', time: '8:00 AM',  open: 1 },
  { date: '2026-08-03', time: '2:00 PM',  open: 1 },
  { date: '2026-08-03', time: '3:30 PM',  open: 1 },
  { date: '2026-08-05', time: '3:30 PM',  open: 1 },
  { date: '2026-08-07', time: '12:00 PM', open: 1 },
];

let bad = 0;
const t = (l, c, x) => { console.log((c ? '  ok    ' : '  FAIL  ') + l + (x !== undefined ? '  ->  ' + JSON.stringify(x) : '')); if (!c) bad++; };

/* Pin "today" to the day the feed was generated. */
const RealDate = Date;
const TODAY = new RealDate(2026, 6, 27);          // 2026-07-27 local
class FixedDate extends RealDate {
  constructor(...a) { if (a.length === 0) super(TODAY.getTime()); else super(...a); }
  static now() { return TODAY.getTime(); }
  static [Symbol.hasInstance](x) { return x instanceof RealDate; }
}
box.Date = FixedDate;

const kept = filterSlots(LIVE);
console.log('site kept ' + kept.length + ' of ' + LIVE.length + '  (HORIZON_DAYS=' + HORIZON_DAYS + ')\n');

t('every live slot survives the site filter', kept.length === LIVE.length,
  { published: LIVE.length, kept: kept.length,
    dropped: LIVE.filter(s => !kept.includes(s)).map(s => s.date + ' ' + s.time) });
t('scheduler shows instead of the earlier/later fallback', kept.length > 0);

/* Render the agenda exactly as renderSchedulerDays groups it. */
console.log('\nWhat a visitor sees in Step 3:');
let cur = null; const groups = [];
kept.forEach(s => {
  if (s.date !== cur) { cur = s.date; groups.push(s.date); console.log('  ' + formatSlotDate(s.date)); }
  console.log('      [ ' + s.time + ' ]');
});

t('no day heading repeats (grouping assumption holds)', groups.length === new Set(groups).size, groups);
t('5 distinct days', groups.length === 5, groups);

/* Weekday sanity — these must be real calendar days. */
const expect = { '2026-07-30': 'Thursday', '2026-07-31': 'Friday',
                 '2026-08-03': 'Monday',   '2026-08-05': 'Wednesday',
                 '2026-08-07': 'Friday' };
const wrong = Object.keys(expect).filter(d => formatSlotDate(d).indexOf(expect[d]) !== 0);
t('weekdays are calendrically correct', wrong.length === 0, wrong);
t('no weekend slots published', !Object.keys(expect).some(d =>
  /Saturday|Sunday/.test(formatSlotDate(d))));

/* Chronological ordering within each day, via minutes-since-midnight. */
const mins = s => { const m = s.time.match(/^(\d{1,2}):(\d{2}) ([AP])M$/);
  return ((+m[1]) % 12 + (m[3] === 'P' ? 12 : 0)) * 60 + (+m[2]); };
let ordered = true;
groups.forEach(g => {
  const day = kept.filter(s => s.date === g).map(mins);
  if (day.join() !== day.slice().sort((a,b) => a-b).join()) ordered = false;
});
t('times ascend within every day', ordered,
  groups.map(g => g + ': ' + kept.filter(s => s.date === g).map(s => s.time).join(', ')));
t('noon rendered as 12:00 PM, not 0:00 or 12:00 AM',
  kept.some(s => s.time === '12:00 PM'), kept.filter(s => /12:/.test(s.time)).map(s => s.time));

/* What a booking of the last slot would send. */
const pick = kept[kept.length - 1];
console.log('\nIf a customer picks the last slot:');
console.log('  slot_date = ' + pick.date + '   -> JOBS.scheduled_date');
console.log('  slot_time = ' + pick.time + '    -> JOBS.start_time');
console.log('  notes     = ' + formatSlotDate(pick.date) + ' at ' + pick.time);
t('slot_date is the ISO form the sheet expects', /^\d{4}-\d{2}-\d{2}$/.test(pick.date));

/* ============================================================
   The LIVE badge must never outrun the feed.
   ------------------------------------------------------------
   It is a claim about data, not decoration: it says the times on screen came
   from the availability feed just now. In 'loading' the scheduler block is
   already on screen with no slots in it, and in 'fallback' the feed did not
   answer at all — a badge in either state is advertising something that is
   not there. setTimeUi is the single place that decides, so drive the real
   function rather than trusting the one line that sets it.

   Sliced separately because the harness above deliberately stops short of
   setTimeUi: everything before it is pure, and this needs a DOM. */
const uiSrc = SITE.slice(SITE.indexOf('function setTimeUi'),
                         SITE.indexOf('/* Build the agenda'));
const seen = {};
const uiBox = {
  console,
  timeUi: null,
  $: (id) => (seen[id] = seen[id] || { hidden: null }),
};
vm.createContext(uiBox);
vm.runInContext(uiSrc, uiBox);
const setTimeUi = vm.runInContext('setTimeUi', uiBox);

console.log('\n=== LIVE badge tracks the feed, not the block ===');

setTimeUi('loading');
t('loading: block visible but badge hidden',
  seen['scheduler-block'].hidden === false && seen['scheduler-live'].hidden === true,
  { block: seen['scheduler-block'].hidden, badge: seen['scheduler-live'].hidden });

setTimeUi('scheduler');
t('scheduler: badge shown once slots are rendered',
  seen['scheduler-live'].hidden === false, seen['scheduler-live'].hidden);

setTimeUi('fallback');
t('fallback: feed never answered, badge hidden',
  seen['scheduler-live'].hidden === true, seen['scheduler-live'].hidden);

console.log('\n' + (bad ? 'FAILURES: ' + bad : 'ALL CHECKS PASSED'));
process.exit(bad ? 1 : 0);
