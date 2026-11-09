/**
 * The portals' data and access rules — migrations/0003_portals.sql,
 * src/portals.js and db/dev-seed-portals.sql (PORTALS_SPEC.md §6, PR 1).
 *
 * design/serve/db/portals_schema.sql enforces these rules with Postgres
 * row-level security. D1 has none, so src/portals.js is the policy and this
 * file is what the kit's RLS tests would have been: each section names the
 * kit policy it stands in for.
 *
 * D1 IS REAL SQLITE HERE (node:sqlite), running the shipped migrations, the
 * shipped partner seed and the dev seed, as tests/marketplace.test.js does.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let bad = 0;
const t = (label, cond, extra) => {
  console.log((cond ? '  ok    ' : '  FAIL  ') + label + (extra !== undefined ? '  ->  ' + JSON.stringify(extra) : ''));
  if (!cond) bad++;
};

/* A D1 binding over real SQLite, with batch() as one transaction, as D1's is. */
function makeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const f of ['migrations/0001_marketplace.sql', 'migrations/0002_neighborhoods.sql',
    'migrations/0003_portals.sql', 'db/seed-first-partners.sql', 'db/dev-seed-portals.sql']) db.exec(read(f));
  const plain = (r) => (r ? Object.assign({}, r) : null);
  const stmt = (sql, args) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => plain(db.prepare(sql).get(...(args || []))),
    all: async () => ({ results: db.prepare(sql).all(...(args || [])).map(plain) }),
    run: async () => { db.prepare(sql).run(...(args || [])); return { success: true }; },
    _exec: () => db.prepare(sql).run(...(args || [])),
  });
  const binding = {
    prepare: (sql) => stmt(sql, []),
    batch: async (list) => {
      db.exec('BEGIN');
      try { list.forEach((s) => s._exec()); db.exec('COMMIT'); }
      catch (e) { db.exec('ROLLBACK'); throw e; }
      return list.map(() => ({ success: true }));
    },
  };
  return { raw: db, binding };
}

const EXPORTS = ['getHome', 'homeSummary', 'partnerRequests', 'shortName', 'markContacted', 'sendQuote',
  'submitProfileEdit', 'approveProfileEdit', 'rejectProfileEdit', 'ROOM_TYPES', 'FREQUENCIES',
  'PORTAL_SERVICES', 'PRICE_LABELS', 'EDITABLE_KEYS'];
const SRC = read('src/portals.js');
function loadPortals() {
  const box = { crypto: require('crypto').webcrypto, JSON, console };
  box.globalThis = box;
  vm.createContext(box);
  vm.runInContext(SRC.replace(/^export\s+/gm, '') + '\nglobalThis.__p = {' + EXPORTS.join(',') + '};', box);
  return box.__p;
}
const P = loadPortals();

const TASKFORCE = 'PRV-0003';
const CAMBRIDGE = 'PRV-0006';
const ALEX = 'CLI-DEV00001', PRIYA = 'CLI-DEV00002', MARCUS = 'CLI-DEV00003', DANA = 'CLI-DEV00004';
const asTaskforce = { kind: 'provider', providerId: TASKFORCE };
const asCambridge = { kind: 'provider', providerId: CAMBRIDGE };
const asAlex = { kind: 'client', clientId: ALEX };
const asAdmin = { kind: 'admin' };
const throws = (fn) => { try { fn(); return false; } catch (_) { return true; } };

(async function run() {

console.log('=== 1. migration 0003 and the dev seed ===');
{
  const { raw } = makeD1();
  const n = (sql) => raw.prepare(sql).get().n;
  t('0003 applies on top of 0001, 0002 and the partner seed, then the dev seed', true);
  t('the dev seed: 2 members, 4 clients, 4 requests (2 new, 1 contacted, 1 quoted), 1 quote',
    n('SELECT count(*) n FROM provider_members') === 2 && n("SELECT count(*) n FROM clients WHERE id LIKE 'CLI-DEV%'") === 4 &&
    n("SELECT count(*) n FROM estimate_requests WHERE status = 'new'") === 2 &&
    n("SELECT count(*) n FROM estimate_requests WHERE status = 'contacted'") === 1 &&
    n("SELECT count(*) n FROM estimate_requests WHERE status = 'quoted'") === 1 && n('SELECT count(*) n FROM quotes') === 1);
  t('Alex has the design\'s 2-floor home with 8 rooms', n("SELECT count(*) n FROM home_floors WHERE home_id = 'HOM-DEV00001'") === 2 &&
    n("SELECT count(*) n FROM home_rooms WHERE home_id = 'HOM-DEV00001'") === 8);
  const rooms = n('SELECT count(*) n FROM home_rooms');
  raw.exec(read('db/dev-seed-portals.sql'));
  t('re-running the dev seed duplicates nothing', n('SELECT count(*) n FROM home_rooms') === rooms &&
    n('SELECT count(*) n FROM estimate_requests') === 4 && n('SELECT count(*) n FROM quotes') === 1);
  t('every room the seed wrote has a valid type and a floor in its own home',
    n('SELECT count(*) n FROM home_rooms r JOIN home_floors f ON f.id = r.floor_id WHERE f.home_id = r.home_id AND r.room_type IN (' +
      P.ROOM_TYPES.map((x) => "'" + x + "'").join(',') + ')') === rooms);

  t('a quote cannot be changed (UPDATE refused by the table)', throws(() => raw.exec("UPDATE quotes SET amount_cents = 1")));
  t('…or deleted', throws(() => raw.exec('DELETE FROM quotes')));
  t('a quote must be a positive amount and a known frequency',
    throws(() => raw.exec("INSERT INTO quotes (id, request_id, provider_id, amount_cents, frequency, created_at) VALUES ('Q1','EST-DEV0000001','PRV-0003',0,'weekly','x')")) &&
    throws(() => raw.exec("INSERT INTO quotes (id, request_id, provider_id, amount_cents, frequency, created_at) VALUES ('Q2','EST-DEV0000001','PRV-0003',100,'yearly','x')")));
  t('one home per client', throws(() => raw.exec("INSERT INTO homes (id, client_id, created_at, updated_at) VALUES ('H2','CLI-DEV00001','x','x')")));
  t('contact_pref is text, call or either', throws(() => raw.exec("UPDATE clients SET contact_pref = 'email' WHERE id = 'CLI-DEV00001'")));
  t('an edit\'s changes must be a JSON object',
    throws(() => raw.exec("INSERT INTO provider_profile_edits (id, provider_id, changes, created_at) VALUES ('E1','PRV-0003','not json','x')")) &&
    throws(() => raw.exec("INSERT INTO provider_profile_edits (id, provider_id, changes, created_at) VALUES ('E2','PRV-0003','[1]','x')")));
  t('removing a floor removes its rooms', (() => {
    raw.exec("DELETE FROM home_floors WHERE id = 'FLR-DEV00041'");
    return n("SELECT count(*) n FROM home_rooms WHERE floor_id = 'FLR-DEV00041'") === 0;
  })());

  const seed = read('db/dev-seed-portals.sql');
  t('the dev seed uses only DEV ids and 555-01xx phones', !/'(CLI|EST|HOM|FLR|QTE)-(?!DEV)/.test(seed) &&
    (seed.match(/\+1\d{10}/g) || []).every((p) => /^\+1\d{3}55501\d\d$/.test(p)));
  const shipped = ['wrangler.jsonc', 'scripts/build-site.sh', 'db/seed-first-partners.sql', 'src/worker.js', 'src/marketplace.js', 'src/portals.js']
    .filter((f) => fs.existsSync(path.join(ROOT, f)) && read(f).includes('dev-seed-portals'));
  t('…and nothing that ships refers to it', shipped.length === 0, shipped);
}

console.log('\n=== 2. a company reads a home ONLY after a request (kit: partner_can_see_client) ===');
{
  const { binding: db } = makeD1();
  const home = await P.getHome(db, asTaskforce, ALEX);
  t('Taskforce, which Alex sent a request to, reads Alex\'s home', !!home && home.floors.length === 2 &&
    home.wholeNotes.includes('Miso'));
  t('…with the summary chips right (half bath = 0.5; notes = rooms with notes)',
    JSON.stringify(home.summary) === JSON.stringify({ levels: 2, beds: 2, baths: 1.5, rooms: 8, notes: 4 }), home.summary);
  t('…and no floor or room ids (those are the client\'s)', !JSON.stringify(home).includes('FLR-') &&
    home.floors.every((f) => !('id' in f) && f.rooms.every((r) => !('id' in r))));
  const others = await Promise.all([ALEX, PRIYA, MARCUS, DANA].map((c) => P.getHome(db, asCambridge, c)));
  t('Cambridge Clean Co, with no requests, reads NO client\'s home', others.every((h) => h === null));
  t('a made-up provider id reads nothing', (await P.getHome(db, { kind: 'provider', providerId: 'PRV-9999' }, ALEX)) === null);
  t('an actor with no provider id reads nothing', (await P.getHome(db, { kind: 'provider' }, ALEX)) === null &&
    (await P.getHome(db, null, ALEX)) === null && (await P.getHome(db, {}, ALEX)) === null);
  const own = await P.getHome(db, asAlex, ALEX);
  t('Alex reads their own home, with ids to edit it', !!own && own.floors[0].id === 'FLR-DEV00011' && !!own.floors[0].rooms[0].id);
  t('Alex cannot read another client\'s home', (await P.getHome(db, asAlex, PRIYA)) === null);
  t('the founder reads any home', !!(await P.getHome(db, asAdmin, DANA)));

  t('Cambridge cannot list Taskforce\'s requests', (await P.partnerRequests(db, asCambridge, TASKFORCE)) === null);
  t('Cambridge\'s own inbox is empty', (await P.partnerRequests(db, asCambridge, CAMBRIDGE)).length === 0);
  t('a client cannot list a company\'s requests', (await P.partnerRequests(db, asAlex, TASKFORCE)) === null);

  await db.prepare("INSERT INTO estimate_requests (id, provider_id, client_id, method, phone_e164, time_pref, status, created_at, updated_at) " +
    "VALUES ('EST-DEV0000009', ?, ?, 'phone', '+16175550123', 'earlier', 'new', '2026-11-10T12:00:00.000Z', '2026-11-10T12:00:00.000Z')")
    .bind(CAMBRIDGE, ALEX).run();
  t('once Alex sends Cambridge a request, Cambridge reads Alex\'s home', !!(await P.getHome(db, asCambridge, ALEX)));
  t('…and still not Priya\'s', (await P.getHome(db, asCambridge, PRIYA)) === null);
}

console.log('\n=== 3. the street address only on walkthroughs (kit: get_partner_requests) ===');
{
  const { binding: db } = makeD1();
  const list = await P.partnerRequests(db, asTaskforce, TASKFORCE);
  const by = Object.fromEntries(list.map((r) => [r.clientName, r]));
  t('Taskforce\'s inbox has its 4 requests, newest first', list.length === 4 &&
    list.map((r) => r.id).join() === 'EST-DEV0000001,EST-DEV0000002,EST-DEV0000003,EST-DEV0000004');
  t('walkthrough requests carry the street address', by['Alex R.'].address === '[Street], Somerville, MA 02143, Unit 2' &&
    by['Marcus T.'].address === '[Street], Everett, MA 02149');
  t('phone requests carry none', by['Priya S.'].address === '' && by['Dana R.'].address === '');
  const json = JSON.stringify(list);
  t('…and the phone clients\' addresses are nowhere in the response', !json.includes('Cambridge, MA 02139') && !json.includes('02144'));
  t('names are first name + last initial; no surname, no email anywhere',
    Object.keys(by).sort().join() === 'Alex R.,Dana R.,Marcus T.,Priya S.' &&
    !/Rivera|Shah|Thompson|Reyes|@example\.com/.test(json));
  t('phone and contact preference are there for the company to call', by['Priya S.'].phone === '(617) 555-0147' &&
    by['Priya S.'].contactPref === 'call');
  t('the quoted request carries its latest quote', JSON.stringify(by['Marcus T.'].latestQuote) ===
    JSON.stringify({ amountCents: 24000, frequency: 'one_time_deep', createdAt: '2026-11-06T16:00:00.000Z' }));
  t('each request carries the home, without ids', by['Dana R.'].home.summary.levels === 3 && by['Dana R.'].home.summary.beds === 3 &&
    !json.includes('FLR-') && !json.includes('HOM-'));
  t('the request\'s own walkthrough address wins over the profile one', await (async () => {
    await db.prepare("UPDATE estimate_requests SET address = '1 Request Rd, Everett 02149' WHERE id = 'EST-DEV0000003'").run();
    const l2 = await P.partnerRequests(db, asTaskforce, TASKFORCE);
    return l2.find((r) => r.id === 'EST-DEV0000003').address === '1 Request Rd, Everett 02149';
  })());
  t('…but a phone request never shows even its own stored address', await (async () => {
    await db.prepare("UPDATE estimate_requests SET address = 'Leaked St' WHERE id = 'EST-DEV0000002'").run();
    const l3 = await P.partnerRequests(db, asTaskforce, TASKFORCE);
    return !JSON.stringify(l3).includes('Leaked St');
  })());
  t('shortName handles one name and extra spaces', P.shortName('  Cher ') === 'Cher' && P.shortName('ana  de souza') === 'ana D.');
}

console.log('\n=== 4. companies never write providers or quotes directly (kit: partners_admin_all, send_quote, approve_profile_edit) ===');
{
  const { raw, binding: db } = makeD1();
  const status = (id) => raw.prepare('SELECT status FROM estimate_requests WHERE id = ?').get(id).status;
  const quoteCount = (id) => raw.prepare('SELECT count(*) n FROM quotes WHERE request_id = ?').get(id).n;

  t('Cambridge cannot mark Taskforce\'s request contacted', (await P.markContacted(db, asCambridge, 'EST-DEV0000001')).ok === false &&
    status('EST-DEV0000001') === 'new');
  t('a client cannot either', (await P.markContacted(db, asAlex, 'EST-DEV0000001')).ok === false);
  t('Taskforce marks its own new request contacted', (await P.markContacted(db, asTaskforce, 'EST-DEV0000001')).ok === true &&
    status('EST-DEV0000001') === 'contacted' && raw.prepare("SELECT contacted_at c FROM estimate_requests WHERE id = 'EST-DEV0000001'").get().c !== '');
  t('…only from "new" (a second click changes nothing)', (await P.markContacted(db, asTaskforce, 'EST-DEV0000001')).ok === false);

  t('Cambridge cannot quote Taskforce\'s request', (await P.sendQuote(db, asCambridge, 'EST-DEV0000002', 18500, 'biweekly')).ok === false &&
    quoteCount('EST-DEV0000002') === 0 && status('EST-DEV0000002') === 'contacted');
  t('a client or the founder cannot send a quote', (await P.sendQuote(db, asAlex, 'EST-DEV0000002', 18500, 'biweekly')).ok === false &&
    (await P.sendQuote(db, asAdmin, 'EST-DEV0000002', 18500, 'biweekly')).ok === false);
  t('bad amounts and frequencies are refused', (await P.sendQuote(db, asTaskforce, 'EST-DEV0000002', 0, 'biweekly')).error === 'bad_amount' &&
    (await P.sendQuote(db, asTaskforce, 'EST-DEV0000002', 185.5, 'biweekly')).error === 'bad_amount' &&
    (await P.sendQuote(db, asTaskforce, 'EST-DEV0000002', 18500, 'yearly')).error === 'bad_frequency');
  const q1 = await P.sendQuote(db, asTaskforce, 'EST-DEV0000002', 18500, 'biweekly');
  const row = raw.prepare("SELECT status, quoted_price_cents, quoted_frequency, quoted_at FROM estimate_requests WHERE id = 'EST-DEV0000002'").get();
  t('Taskforce quotes its own request: a quotes row, and the request moves to quoted', q1.ok && quoteCount('EST-DEV0000002') === 1 &&
    row.status === 'quoted' && row.quoted_price_cents === 18500 && row.quoted_frequency === 'biweekly' && row.quoted_at !== '');
  const q2 = await P.sendQuote(db, asTaskforce, 'EST-DEV0000002', 17500, 'biweekly');
  const kept = raw.prepare("SELECT amount_cents FROM quotes WHERE request_id = 'EST-DEV0000002' ORDER BY rowid").all().map((r) => r.amount_cents);
  t('editing the quote inserts a new row and keeps the old one', q2.ok && kept.join() === '18500,17500', kept);
  t('…and the inbox shows the latest', (await P.partnerRequests(db, asTaskforce, TASKFORCE))
    .find((r) => r.id === 'EST-DEV0000002').latestQuote.amountCents === 17500);
  t('quoting a "new" request fills contacted_at too', (await P.sendQuote(db, asTaskforce, 'EST-DEV0000004', 9000, 'weekly')).ok &&
    raw.prepare("SELECT contacted_at c FROM estimate_requests WHERE id = 'EST-DEV0000004'").get().c !== '');
  raw.exec("UPDATE estimate_requests SET status = 'closed' WHERE id = 'EST-DEV0000003'");
  t('a closed request takes no quote', (await P.sendQuote(db, asTaskforce, 'EST-DEV0000003', 9000, 'weekly')).error === 'not_open');

  const before = JSON.stringify(raw.prepare('SELECT * FROM providers WHERE id = ?').get(TASKFORCE));
  t('Cambridge cannot file an edit to Taskforce\'s profile',
    (await P.submitProfileEdit(db, asCambridge, TASKFORCE, { tagline: 'Hijacked' })).ok === false);
  t('ratings and review counts are not editable', (await P.submitProfileEdit(db, asTaskforce, TASKFORCE, { rating: 5 })).error === 'not_editable:rating' &&
    (await P.submitProfileEdit(db, asTaskforce, TASKFORCE, { review_count: 900 })).error === 'not_editable:review_count');
  t('…nor listing, logo or internal fields', ['listed', 'status', 'logo_path', 'internal_notes', 'rating_checked_on']
    .every((k) => !P.EDITABLE_KEYS.includes(k)));
  t('values are checked: tagline ≤ 120, known services, known price labels, real neighborhoods',
    (await P.submitProfileEdit(db, asTaskforce, TASKFORCE, { tagline: 'x'.repeat(121) })).ok === false &&
    (await P.submitProfileEdit(db, asTaskforce, TASKFORCE, { services: ['Recurring', 'Window washing'] })).ok === false &&
    (await P.submitProfileEdit(db, asTaskforce, TASKFORCE, { price_label: 'Cheapest in town' })).ok === false &&
    (await P.submitProfileEdit(db, asTaskforce, TASKFORCE, { service_areas: ['everett', 'atlantis'] })).ok === false);
  const cur = raw.prepare('SELECT name, tagline FROM providers WHERE id = ?').get(TASKFORCE);
  t('an "edit" that changes nothing is refused', (await P.submitProfileEdit(db, asTaskforce, TASKFORCE, { name: cur.name })).error === 'no_changes');
  const ed = await P.submitProfileEdit(db, asTaskforce, TASKFORCE, { name: cur.name, tagline: 'A new tagline.',
    services: ['Recurring', 'Organizing'], service_areas: ['everett', 'somerville'], price: '20% off your first clean' });
  const stored = JSON.parse(raw.prepare('SELECT changes FROM provider_profile_edits WHERE id = ?').get(ed.id).changes);
  t('a real edit is filed pending, holding only the changed keys', ed.ok &&
    Object.keys(stored).sort().join() === 'price,service_areas,services,tagline', stored);
  t('…and the providers row has not changed', JSON.stringify(raw.prepare('SELECT * FROM providers WHERE id = ?').get(TASKFORCE)) === before);

  t('a company cannot approve its own edit', (await P.approveProfileEdit(db, asTaskforce, ed.id)).ok === false &&
    raw.prepare('SELECT status FROM provider_profile_edits WHERE id = ?').get(ed.id).status === 'pending');
  t('the founder approves it', (await P.approveProfileEdit(db, asAdmin, ed.id)).ok === true);
  const after = raw.prepare('SELECT * FROM providers WHERE id = ?').get(TASKFORCE);
  t('…which applies exactly the changed keys', after.tagline === 'A new tagline.' && after.price_value === '20% off your first clean' &&
    after.service_areas === '["everett","somerville"]' && after.name === cur.name);
  t('…services keep "Organizing"; the marketplace filter tags take only filter tags',
    after.services === '["Recurring","Organizing"]' && after.service_tags === '["Recurring"]');
  t('approving twice applies nothing twice', (await P.approveProfileEdit(db, asAdmin, ed.id)).error === 'no_pending_edit');
  const ed2 = await P.submitProfileEdit(db, asTaskforce, TASKFORCE, { tagline: 'Rejected tagline.' });
  t('a company cannot reject either; the founder can, and nothing changes',
    (await P.rejectProfileEdit(db, asTaskforce, ed2.id)).ok === false &&
    (await P.rejectProfileEdit(db, asAdmin, ed2.id, 'Too vague')).ok === true &&
    raw.prepare('SELECT tagline FROM providers WHERE id = ?').get(TASKFORCE).tagline === 'A new tagline.');
  const ratingBefore = raw.prepare('SELECT rating, review_count FROM providers WHERE id = ?').get(TASKFORCE);
  raw.exec("INSERT INTO provider_profile_edits (id, provider_id, changes, created_at) VALUES ('EDT-PLANTED', 'PRV-0003', '{\"rating\":1.2,\"review_count\":9999,\"listed\":1,\"tagline\":\"ok\"}', 'x')");
  await P.approveProfileEdit(db, asAdmin, 'EDT-PLANTED');
  const planted = raw.prepare('SELECT rating, review_count, listed, tagline FROM providers WHERE id = ?').get(TASKFORCE);
  t('approval re-checks the stored JSON: a planted rating or listing never applies',
    planted.tagline === 'ok' && planted.listed === 0 && planted.rating === ratingBefore.rating &&
    planted.review_count === ratingBefore.review_count, planted);
}

console.log('\n=== 5. the module itself ===');
{
  // SQL strings only (they open with a quote), not the comments that discuss them.
  const targets = [...new Set([...SRC.matchAll(/["'](?:UPDATE|INSERT INTO|DELETE FROM)\s+([a-z_]+)/g)].map((m) => m[1]))].sort();
  t('it writes only estimate_requests, quotes, provider_profile_edits and (approval) providers',
    targets.join() === 'estimate_requests,provider_profile_edits,providers,quotes', targets);
  const provWrites = SRC.split('\n').filter((l) => /UPDATE providers/.test(l));
  const approveAt = SRC.indexOf('export async function approveProfileEdit');
  t('…providers in exactly one place, inside approveProfileEdit', provWrites.length === 1 &&
    SRC.indexOf('UPDATE providers') > approveAt && SRC.indexOf('UPDATE providers') < SRC.indexOf('export async function rejectProfileEdit'));
  t('…and never UPDATE or DELETE on quotes', !/UPDATE quotes|DELETE FROM quotes/.test(SRC));
  const M = read('src/marketplace.js').match(/SERVICE_TAGS = (\[[^\]]+\])/);
  t('the first five portal services are the marketplace\'s filter tags',
    !!M && JSON.stringify(JSON.parse(M[1])) === JSON.stringify(P.PORTAL_SERVICES.slice(0, 5)));
  t('homeSummary counts a half bath as 0.5', P.homeSummary({ floors: [{ rooms: [{ type: 'half_bath', notes: '' }, { type: 'half_bath', notes: '' }, { type: 'bathroom', notes: ' ' }] }] }).baths === 2);
}

console.log(bad ? `\n${bad} FAILED` : '\nall portals checks passed');
process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
