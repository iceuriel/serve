/* Exercise the attribution + pets helpers lifted straight out of script.js. */
/* Repo-relative so this runs from a clean clone on any machine. */
const REPO_ROOT = require('path').resolve(__dirname, '..');
const fs = require('fs');
const vm = require('vm');

const JS = fs.readFileSync(require('path').join(REPO_ROOT, 'script.js'), 'utf8');
const slice = JS.slice(JS.indexOf('const SRC_SEGMENTS'), JS.indexOf('/* --- State --- */'));

function fakeStorage() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)),
           removeItem: k => m.delete(k), _dump: () => Object.fromEntries(m) };
}

function load(search, storage) {
  const sandbox = { sessionStorage: storage, location: { search, pathname: '/' },
                    URLSearchParams, window: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(slice, sandbox);
  return sandbox;
}

let bad = 0;
const t = (label, got, want) => {
  const okp = JSON.stringify(got) === JSON.stringify(want);
  console.log((okp ? '  ok    ' : '  FAIL  ') + label + '  ->  ' + JSON.stringify(got));
  if (!okp) { console.log('        expected ' + JSON.stringify(want)); bad++; }
};

console.log('=== segment derivation from the prefix table ===');
const s = load('', fakeStorage());
[['qr-allston-01','qr_code'], ['poster_back_bay_3','poster'], ['flyer/comm-ave','flyer'],
 ['ig-story-07','social'], ['fb-group-jp','social'], ['nd-brighton','nextdoor'],
 ['ref-jordan-m','referral'], ['gmb','google_business'], ['door-hanger-01','door_hanger'],
 ['mystery-tag','other'], [null,'direct'], ['','direct']].forEach(([src, want]) => {
  t('src=' + JSON.stringify(src), s.segmentFor(src), want);
});

console.log('\n=== A1. does src survive a refresh? (the question you asked) ===');
const st1 = fakeStorage();
const first = load('?src=qr-allston-01&utm_source=poster', st1).readAttribution();
t('landing: src captured',       first.src,       'qr-allston-01');
t('landing: first touch stored', first.src_first, 'qr-allston-01');
t('landing: segment',            first.segment,   'qr_code');
// Refresh = same session, no query string.
const refreshed = load('', st1).readAttribution();
t('after refresh: src survives',        refreshed.src,       'qr-allston-01');
t('after refresh: utm survives',        refreshed.utm_source,'poster');
t('after refresh: first touch survives',refreshed.src_first, 'qr-allston-01');

console.log('\n=== A2. second tagged link mid-session (the real gap) ===');
const second = load('?src=ig-story-07', st1).readAttribution();
t('last touch moves to the new tag', second.src,       'ig-story-07');
t('FIRST touch is NOT overwritten',  second.src_first, 'qr-allston-01');
t('chain records both, in order',    second.src_chain, 'qr-allston-01>ig-story-07');
t('segment still reflects first touch', second.segment, 'qr_code');
console.log('  sessionStorage: ' + JSON.stringify(st1._dump()));

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
