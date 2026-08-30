/* Exercise the attribution + pets helpers lifted straight out of script.js. */
/* Repo-relative so this runs from a clean clone on any machine. */
const REPO_ROOT = require('path').resolve(__dirname, '..');
const fs = require('fs');
const vm = require('vm');

const JS = fs.readFileSync(require('path').join(REPO_ROOT, 'script.js'), 'utf8');
/* Two regions, because attribution now lives at module scope — the hero skin
   needs it, so it cannot stay inside the booking IIFE — while newSubmissionId
   and detectPets are still IIFE-local, being used only by the booking flow.
   Splicing both keeps this testing the real code rather than a copy. */
const modStart  = JS.indexOf('const SRC_SEGMENTS');
const modEnd    = JS.indexOf('/* Read once per page load.');
const iifeStart = JS.indexOf('    /* One id per submission');
const iifeEnd   = JS.indexOf('    /* --- State --- */');
if ([modStart, modEnd, iifeStart, iifeEnd].some(i => i === -1)) {
  throw new Error('could not slice script.js — markers moved: ' +
    JSON.stringify({ modStart, modEnd, iifeStart, iifeEnd }));
}
const slice = JS.slice(modStart, modEnd) + '\n' + JS.slice(iifeStart, iifeEnd);

function fakeStorage() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)),
           removeItem: k => m.delete(k), _dump: () => Object.fromEntries(m) };
}

/* `now` lets a test place a visit at an arbitrary point on the calendar without
   sleeping, which is the only way to assert a 30-day window. Date is replaced
   wholesale rather than stubbed, so the code under test cannot reach a real
   clock by another route. */
function load(search, storage, now) {
  const FakeDate = now === undefined ? Date : Object.assign(
    function (...a) { return a.length ? new Date(...a) : new Date(now); },
    Date, { now: () => now });
  const sandbox = { localStorage: storage, location: { search, pathname: '/' },
                    URLSearchParams, window: {}, console, Date: FakeDate };
  vm.createContext(sandbox);
  vm.runInContext(slice, sandbox);
  return sandbox;
}

const DAY = 86400000;

let bad = 0;
const t = (label, got, want) => {
  const okp = JSON.stringify(got) === JSON.stringify(want);
  console.log((okp ? '  ok    ' : '  FAIL  ') + label + '  ->  ' + JSON.stringify(got));
  if (!okp) { console.log('        expected ' + JSON.stringify(want)); bad++; }
};

/* Segment DERIVATION is owned by segment-and-skins.test.js — it is the intent
   taxonomy and is asserted there alongside the hero skins that consume it.
   Duplicating the table here is how two tests end up disagreeing about the
   answer. This file owns persistence: what survives a refresh, a second tag,
   and a hostile storage implementation. */
const s = load('', fakeStorage());

console.log('=== A1. does src survive a refresh? ===');
const st1 = fakeStorage();
const first = load('?src=dh-bh-01&utm_source=poster', st1).readAttribution();
t('landing: src captured',       first.src,       'dh-bh-01');
t('landing: first touch stored', first.src_first, 'dh-bh-01');
t('landing: segment',            first.segment,   'pro');
// Refresh = same session, no query string.
const refreshed = load('', st1).readAttribution();
t('after refresh: src survives',        refreshed.src,       'dh-bh-01');
t('after refresh: utm survives',        refreshed.utm_source,'poster');
t('after refresh: first touch survives',refreshed.src_first, 'dh-bh-01');

console.log('\n=== A2. second tagged link mid-session (the real gap) ===');
const second = load('?src=deed-batch-04', st1).readAttribution();
t('last touch moves to the new tag', second.src,       'deed-batch-04');
t('FIRST touch is NOT overwritten',  second.src_first, 'dh-bh-01');
t('chain records both, in order',    second.src_chain, 'dh-bh-01>deed-batch-04');
// A deed tag arriving second must NOT reclassify a pro lead as a mover.
t('segment still reflects first touch', second.segment, 'pro');
console.log('  localStorage: ' + JSON.stringify(st1._dump()));

console.log('\n=== A2b. the card scanned Tuesday, booked Thursday ===');
/* The whole reason this moved off sessionStorage. A closed tab used to erase
   the tag; the card then earned a booking it could not be credited for. */
const st3 = fakeStorage();
const DAY0 = Date.UTC(2026, 7, 1);
load('?src=qr-card-01', st3, DAY0).readAttribution();
const twoDaysLater = load('', st3, DAY0 + 2 * DAY).readAttribution();
t('2 days later, untagged visit still credits the card', twoDaysLater.src_first, 'qr-card-01');
t('and still carries its segment',                       twoDaysLater.segment,   'pro');

const day29 = load('', st3, DAY0 + 29 * DAY).readAttribution();
t('day 29: inside the window, still credited', day29.src_first, 'qr-card-01');

const day31 = load('', st3, DAY0 + 31 * DAY).readAttribution();
t('day 31: window closed, credit released', day31.src_first, null);
t('day 31: segment falls back to direct',   day31.segment,   'direct');

console.log('\n=== A2c. the window is FIXED, not sliding ===');
/* A sliding window would let someone who drops by every few weeks carry one
   scan forever, so a visit inside the window must not extend it. */
const st4 = fakeStorage();
load('?src=qr-card-02', st4, DAY0).readAttribution();
load('', st4, DAY0 + 20 * DAY).readAttribution();          // a visit that must NOT extend
const stillExpires = load('', st4, DAY0 + 31 * DAY).readAttribution();
t('day 20 visit did not push the expiry out', stillExpires.src_first, null);

console.log('\n=== A2d. the clock starts at the TAG, not the first visit ===');
/* Someone browses untagged for weeks, then scans. The card gets a full 30 days
   from the scan — not whatever was left of an anonymous visit's window. */
const st5 = fakeStorage();
load('', st5, DAY0).readAttribution();                      // anonymous arrival
load('?src=qr-card-03', st5, DAY0 + 25 * DAY).readAttribution();   // scans on day 25
const day50 = load('', st5, DAY0 + 50 * DAY).readAttribution();
t('25 days after the scan, still credited', day50.src_first, 'qr-card-03');

console.log('\n=== A3. no tag at all ===');
const st2 = fakeStorage();
const direct = load('', st2).readAttribution();
t('src null',      direct.src,       null);
t('first null',    direct.src_first, null);
t('segment direct',direct.segment,   'direct');

console.log('\n=== A4. storage disabled (private mode) must not throw ===');
const hostile = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
try {
  const r = load('?src=qr-allston-01', hostile).readAttribution();
  t('still returns last-touch src', r.src, 'qr-allston-01');
  t('degrades to src as first',     r.src_first, 'qr-allston-01');
} catch (e) { console.log('  FAIL  threw: ' + e.message); bad++; }

console.log('\n=== pets detection ===');
const p = load('', fakeStorage());
[['We have a friendly dog, back door shut', true],
 ['Two cats, they hide under the bed', true],
 ['My puppy will be crated', true],
 ['Please use pet-safe products', true],
 ['Litter box is in the bathroom', true],
 ['No animals in the unit', true],
 ['Brand new carpet in the den, please be careful', false],
 ['Sort the recycling by category', false],
 ['The furniture is antique', false],
 ['Lockbox code 1234, park in the driveway', false],
 ['', false]].forEach(([text, want]) => t(JSON.stringify(text.slice(0, 42)), p.detectPets(text), want));

console.log('\n=== submission ids are unique ===');
const ids = new Set(); for (let i = 0; i < 500; i++) ids.add(p.newSubmissionId());
t('500 ids, all distinct', ids.size, 500);

console.log('\n' + (bad ? 'FAILURES: ' + bad : 'ALL ASSERTIONS PASSED'));
process.exit(bad ? 1 : 0);
