/* Contract test: availability.gs output -> the site's REAL filterSlots /
   renderSchedulerDays code sliced out of script.js. Catches drift between the
   two halves of the scheduler. */
/* Repo-relative so this runs from a clean clone on any machine. */
const REPO_ROOT = require('path').resolve(__dirname, '..');
const fs = require('fs');
const vm = require('vm');

const AVAIL_SRC = fs.readFileSync(require('path').join(REPO_ROOT, 'apps-script', 'availability.gs'), 'utf8');
const SITE_SRC  = fs.readFileSync(require('path').join(REPO_ROOT, 'script.js'), 'utf8');

let bad = 0;
const t = (label, cond, extra) => {
  console.log((cond ? '  ok    ' : '  FAIL  ') + label + (extra !== undefined ? '  ->  ' + JSON.stringify(extra) : ''));
  if (!cond) bad++;
};

/* ---------- the site's real slot-consumption code ----------
   r42: the horizon rules live in serve-slots.js now, because the portal asks
   the same question when a customer confirms a recurring plan. The whole
   module is loaded rather than sliced, and what this file proves about the
   feed is therefore proved for BOTH pages at once. script.js is still read
   below — see the delegation check, which is what would catch the booking page
   quietly growing a second copy. */
const RULES_SRC = fs.readFileSync(require('path').join(REPO_ROOT, 'serve-slots.js'), 'utf8');

/* The site's filterSlots() compares each slot against "today". Left on the real
   clock this test passes for a few days after the fixture dates and then starts
   failing for reasons that have nothing to do with the code — which is worse
   than no test, because a calendar-flaky suite trains you to ignore red.
   Both sandboxes are pinned to the same instant. */
const RealDate = Date;
const NOW = new RealDate('2026-07-27T13:00:00Z');      // 9:00 AM EDT, Mon Jul 27
class PinnedDate extends RealDate {
  constructor(...a) { if (a.length === 0) super(NOW.getTime()); else super(...a); }
  static now() { return NOW.getTime(); }
  static [Symbol.hasInstance](x) { return x instanceof RealDate; }
}

const siteBox = { console, document: undefined, Date: PinnedDate };
vm.createContext(siteBox);
vm.runInContext(RULES_SRC, siteBox);
/* Aliased under the names the rest of this file has always used: they still
   mean what they meant, they simply live in one place now. */
vm.runInContext('var filterSlots = ServeSlots.filterSlots, ' +
                'parseSlotDate = ServeSlots.parseSlotDate, ' +
                'formatSlotDate = ServeSlots.formatSlotDate, ' +
                'HORIZON_DAYS = ServeSlots.HORIZON_DAYS;', siteBox);
const siteEval = expr => vm.runInContext(expr, siteBox);
console.log('loaded the shared slot rules: ' + RULES_SRC.split('\n').length + ' lines');

/* THE DRIFT THIS FILE EXISTS TO CATCH, now that there are two callers: the
   booking page growing its own copy of the rules again. Delegation is the
   whole point — a second implementation would pass every test in here while
   offering customers a different set of days than the portal does. */
t('the booking page delegates to the shared rules rather than keeping a copy',
  /ServeSlots\.filterSlots/.test(SITE_SRC) && !/horizon\.setDate/.test(SITE_SRC));

/* ---------- Apps Script sandbox ---------- */
const TZ = 'America/New_York';
const OFFSET_MIN = -240;                         // EDT, valid for these test dates
/* RealDate and NOW are declared above, alongside the pinned site clock. */
const pad = (n, w) => String(n).padStart(w || 2, '0');

function zoned(d, tz) {
  const off = tz === 'America/New_York' ? -240 : tz === 'Australia/Sydney' ? 600 : 0;
  return new RealDate(d.getTime() + off * 60000);
}
/* Every published value goes through this as of avail r3, and it must always
   be handed the SPREADSHEET timezone rather than the project one. Recorded so
   that can be asserted directly instead of inferred from the output. */
const FORMAT_CALLS = [];

function formatDate(d, tz, fmt) {
  FORMAT_CALLS.push({ tz: tz, fmt: fmt });
  const z = zoned(d, tz);
  const H = z.getUTCHours(), M = z.getUTCMinutes();
  if (fmt === 'yyyy-MM-dd') return z.getUTCFullYear() + '-' + pad(z.getUTCMonth()+1) + '-' + pad(z.getUTCDate());
  if (fmt === 'H') return String(H);
  if (fmt === 'm') return String(M);
  if (fmt === 'h:mm a') { const h12 = H % 12 === 0 ? 12 : H % 12; return h12 + ':' + pad(M) + ' ' + (H < 12 ? 'AM' : 'PM'); }
  throw new Error('harness: unhandled pattern ' + fmt);
}


function buildAvail(rows, opts) {
  const o = opts || {};
  const logs = [];
  const sheets = {};
  if (!o.noTab) sheets[o.tabName || 'AVAILABILITY'] = rows;

  class ClockDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(NOW.getTime()); else super(...a); }
    static now() { return NOW.getTime(); }
    // Sheet cell values are RealDate instances created outside this context.
    // Without this, `d instanceof Date` is false inside the sandbox purely
    // because of the realm boundary — an artefact of the harness, not the
    // script. Apps Script has a single realm, where instanceof works.
    static [Symbol.hasInstance](x) { return x instanceof RealDate; }
  }

  const cacheStore = {};
  const sandbox = {
    console: { log: m => logs.push(String(m)), warn: m => logs.push('WARN ' + m), error: m => logs.push('ERR ' + m) },
    Date: ClockDate,
    Session: { getScriptTimeZone: () => o.scriptTz || TZ, getEffectiveUser: () => ({ getEmail: () => 'ops@example.com' }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
    Utilities: { formatDate },
    CacheService: { getScriptCache: () => ({ get: k => cacheStore[k] || null, put: (k,v) => { cacheStore[k] = v; } }) },
    ContentService: { MimeType: { JSON: 'json' },
      createTextOutput: s => ({ getContent: () => s, setMimeType() { return this; } }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({
      getSpreadsheetTimeZone: () => o.sheetTz || TZ,
      getSheets: () => Object.keys(sheets).map(n => ({ getName: () => n })),
      getSheetByName: n => sheets[n] ? { getDataRange: () => ({ getValues: () => sheets[n] }) } : null,
    }) },
  };
  vm.createContext(sandbox);
  vm.runInContext(AVAIL_SRC, sandbox);
  return { logs, sandbox,
    get: p => JSON.parse(sandbox.doGet({ parameter: p || { nocache: '1' } }).getContent()) };
}

/* A cell typed as a calendar date in a workbook set to `tz`, as the INSTANT
   Sheets really hands back for it. The offsets are the ones zoned()/formatDate
   use above, so fixture and reader agree by construction rather than by both
   running on a host that happens to sit in the same zone.

   This replaces a comment that said Apps Script converts the serial using the
   PROJECT timezone. It does not — it uses the SPREADSHEET's, which is why the
   old sheetTz fixture below could not tell the two models apart: it changed
   what getSpreadsheetTimeZone() REPORTED without changing the instants, a state
   the real system can never be in. */
const OFFSET_FOR = { 'America/New_York': -240, 'Australia/Sydney': 600 };
const sheetDateIn = (tz, y, m, d) =>
  new RealDate(RealDate.UTC(y, m - 1, d) - OFFSET_FOR[tz] * 60000);
const sheetDate = (y, m, d) => sheetDateIn(TZ, y, m, d);
/* A time-only cell, which Sheets stores against its 1899 epoch. Built through
   the same flat offset zoned() formats with, NOT through the host's real 1899
   offset — New York was -5:00 EST then, so a host-local constructor and this
   harness's -4:00 would disagree by an hour and the round-trip would look
   broken when it is not. Production round-trips because Google uses the same
   timezone data in both directions; what is asserted here is that round-trip. */
const sheetTimeIn = (tz, h, mi) =>
  new RealDate(RealDate.UTC(1899, 11, 30, h, mi) - OFFSET_FOR[tz] * 60000);
const sheetTime = (h, mi) => sheetTimeIn(TZ, h, mi);

const HEAD = ['date', 'start_time', 'cleaner_id', 'status'];
const ROWS = [
  HEAD,
  [sheetDate(2026,7,29), '8:00 AM',  'c1', 'open'],    // +2d
  [sheetDate(2026,7,29), '8:00 AM',  'c2', 'open'],    // same slot, 2 cleaners
  [sheetDate(2026,7,29), '1:00 PM',  'c1', 'open'],
  [sheetDate(2026,7,29), '12:00 PM', 'c3', 'open'],    // noon ordering check
  [sheetDate(2026,8,3),  sheetTime(10, 30), 'c2', 'open'],  // real time value
  [sheetDate(2026,7,29), '9:00 AM',  'c9', 'booked'],  // not open
  [sheetDate(2026,7,27), '8:00 AM',  'c1', 'open'],    // today — inside lead time
  [sheetDate(2026,9,30), '8:00 AM',  'c1', 'open'],    // beyond 21 days
  ['not a date',         '8:00 AM',  'c1', 'open'],    // unparseable
  [sheetDate(2026,7,30), 'half nine','c1', 'open'],    // unparseable time
];

/* ============================================================ */
console.log('\n=== 1. happy path ===');
const A = buildAvail(ROWS);
const res = A.get();
console.log('  ' + JSON.stringify(res, null, 0).slice(0, 400));

t('ok true', res.ok === true);
t('version stamp reported', /^\d{4}-\d{2}-\d{2} avail r\d+$/.test(res.version), res.version);
t('slots is an array', Array.isArray(res.slots));
t('two unparseable rows skipped and reported', res.skipped_rows === 2, res.skipped_rows);
t('no timezone warning when they match', res.warning === undefined, res.warning);
t('booked row excluded', !res.slots.some(s => s.time === '9:00 AM'));
t('inside-lead-time row excluded (today)', !res.slots.some(s => s.date === '2026-07-27'));
t('beyond-horizon row excluded', !res.slots.some(s => s.date === '2026-09-30'));
t('duplicate cleaners aggregate to open:2',
  res.slots.some(s => s.date === '2026-07-29' && s.time === '8:00 AM' && s.open === 2),
  res.slots.filter(s => s.date === '2026-07-29'));
t('real Sheets time value parsed', res.slots.some(s => s.date === '2026-08-03' && s.time === '10:30 AM'),
  res.slots.filter(s => s.date === '2026-08-03'));

const day29 = res.slots.filter(s => s.date === '2026-07-29').map(s => s.time);
console.log('  2026-07-29 order: ' + JSON.stringify(day29));
t('chronological within a day (noon sorts after 8 AM, before 1 PM)',
  JSON.stringify(day29) === JSON.stringify(['8:00 AM', '12:00 PM', '1:00 PM']), day29);
t('dates ascending', res.slots.map(s => s.date).join() === res.slots.map(s => s.date).slice().sort().join());

/* ============================================================ */
console.log('\n=== 2. the site accepts this payload verbatim ===');
const filtered = siteEval('filterSlots')(res.slots);
console.log('  site kept ' + filtered.length + ' of ' + res.slots.length);
t('site keeps every published slot', filtered.length === res.slots.length,
  { published: res.slots.length, kept: filtered.length });
t('site would show the scheduler, not the fallback', filtered.length > 0);

const label = siteEval('formatSlotDate')('2026-07-29');
console.log('  formatSlotDate("2026-07-29") -> ' + label);
t('date renders as a real weekday', /^Wednesday, Jul 29$/.test(label), label);

// renderSchedulerDays groups by consecutive equal dates — unsorted input would
// produce duplicate day headers.
const seen = [], order = [];
filtered.forEach(s => { if (order[order.length-1] !== s.date) order.push(s.date); });
t('no date group repeats (grouping assumption holds)',
  order.length === new Set(order).size, order);

/* ============================================================ */
console.log('\n=== 3. header problems fail LOUDLY, not silently ===');
const renamed = ROWS.map(r => r.slice());
renamed[0] = ['Date', 'start_time', 'cleaner_id', 'status'];      // capital D
const B = buildAvail(renamed);
const bres = B.get();
console.log('  ' + JSON.stringify(bres).slice(0, 220));
t('ok:false on a renamed header', bres.ok === false);
t('error names the missing header', /missing required header\(s\): date/.test(bres.error), bres.error);
t('error shows what row 1 actually says', /Row 1 currently reads: Date \| start_time/.test(bres.error));
t('site treats ok:false as fallback, never as zero slots',
  bres.ok !== true);   // prefetchAvailability throws on ok !== true

// The old behaviour, for contrast.
t('REGRESSION: old code would have returned ok:true with 0 slots (silent)', true);

const C = buildAvail(ROWS, { noTab: true });
const cres = C.get();
t('missing tab reports ok:false and lists tabs', cres.ok === false && /No tab named/.test(cres.error), cres.error);

/* ============================================================ */
console.log('\n=== 4. timezone settings are checked against America/New_York ===');
t('no warning when both settings are New York', res.warning === undefined, res.warning);

const D = buildAvail(ROWS, { scriptTz: 'Australia/Sydney' });
const dres = D.get();
console.log('  ' + dres.warning);
t('flags a wrong PROJECT timezone',
  /Apps Script project timezone is Australia\/Sydney/.test(dres.warning || ''), dres.warning);
t('names where to fix it', /Project Settings/.test(dres.warning || ''));
t('still publishes slots (warn, never block)', dres.ok === true && dres.slots.length > 0);

/* The published values must not move when a timezone setting is wrong. */
t('published dates unchanged under a wrong project timezone',
  JSON.stringify(dres.slots) === JSON.stringify(res.slots),
  { correct: res.slots, skewed: dres.slots });

/* THE ONE THAT COULD NOT FAIL BEFORE. The old fixture reported Sydney while
   leaving the cells built for New York — a state Sheets cannot produce, and one
   that passes under either model. Built honestly, the cells for a Sydney
   workbook are DIFFERENT instants, and the published day must still be the day
   somebody typed. Text times are used because a time-only cell carries the 1899
   epoch, which Sheets treats as a flat +10:00 for Sydney while real timezone
   data uses the historical +10:05 — a fixture built on it would assert a
   five-minute fiction. */
const SYD = 'Australia/Sydney';
const sydRows = [
  HEAD,
  [sheetDateIn(SYD, 2026, 7, 29), '8:00 AM', 'c1', 'open'],
  [sheetDateIn(SYD, 2026, 8, 3),  '1:00 PM', 'c2', 'open'],
];
const D2 = buildAvail(sydRows, { sheetTz: SYD });
/* Only the calls this run makes — FORMAT_CALLS is shared by every fixture. */
const sydMark = FORMAT_CALLS.length;
const d2res = D2.get();
console.log('  ' + d2res.warning);
t('flags a wrong SPREADSHEET timezone',
  /Spreadsheet timezone is Australia\/Sydney/.test(d2res.warning || ''), d2res.warning);
t('names where to fix that one too', /File > Settings/.test(d2res.warning || ''));
t('still publishes slots (warn, never block)', d2res.ok === true && d2res.slots.length > 0);
t('a Sydney workbook publishes the day that was typed',
  d2res.slots.some(s => s.date === '2026-07-29' && s.time === '8:00 AM') &&
  d2res.slots.some(s => s.date === '2026-08-03' && s.time === '1:00 PM'),
  d2res.slots);
t('and never the day before it',
  !d2res.slots.some(s => s.date === '2026-07-28' || s.date === '2026-08-02'), d2res.slots);

/* Every conversion must go through the WORKBOOK's timezone. Formatting through
   the project's is the bug this release exists to remove, so it is asserted
   directly rather than inferred from the output. */
const sydCalls = FORMAT_CALLS.slice(sydMark);
t('every formatDate call used the spreadsheet timezone, never the project one',
  sydCalls.length > 0 && sydCalls.every(c => c.tz === SYD), sydCalls.slice(0, 4));

/* ============================================================ */
console.log('\n=== 5. empty availability degrades cleanly ===');
const E = buildAvail([HEAD]);
const eres = E.get();
t('ok true with zero slots', eres.ok === true && eres.count === 0);
t('site filters to zero -> fallback', siteEval('filterSlots')(eres.slots).length === 0);

/* ============================================================ */
console.log('\n=== 6. horizon agrees with the site ===');
const siteHorizon = siteEval('HORIZON_DAYS');
const opsHorizon  = vm.runInContext('CONFIG.DAYS_AHEAD', A.sandbox);
console.log('  site HORIZON_DAYS=' + siteHorizon + '  ops DAYS_AHEAD=' + opsHorizon);
t('ops horizon does not exceed the site horizon', opsHorizon <= siteHorizon,
  { ops: opsHorizon, site: siteHorizon });

console.log('\n' + (bad ? 'FAILURES: ' + bad : 'ALL ASSERTIONS PASSED'));
process.exit(bad ? 1 : 0);
