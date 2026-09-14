/* Real Worker -> Apps Script -> in-memory Sheets and immutable R2 storage.
   Proves retained ownership, not merely that both pages show an upload button. */
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
const credentials = { auth_kind:'partner', job_id:'JOB-A', room_key:'BEDROOM_1', t:S.ticketToken('JOB-A','partner'), purpose:'completion', finished:true };
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
const partner = () => JSON.parse(S.handleTicket({ job:'JOB-A', view:'partner', t:S.ticketToken('JOB-A','partner') }).getContent());
const owner = (vendor='VEN-A') => ({ auth_kind:'vendor', vendor_id:vendor, t:S.vendorToken(vendor) });
const history = (vendor='VEN-A') => S.buildVendorPortalModel(T.ss, S.getVendor(T.ss, vendor)).completionHistory;
(async function () {
    const photoId = randomUUID(), upload = { ...credentials, action:'upload', photo_id:photoId };
    assert.equal((await json({ ...upload, finished:false }, jpeg)).error, 'room_not_finished');
    assert.equal((await json({ ...upload, t:'wrong' }, jpeg)).ok, false);
    assert.equal((await json({ ...upload, auth_kind:'portal', contact_id:'CONTACT-A', t:S.portalToken('CONTACT-A') }, jpeg)).ok, false);
    assert.equal((await json({ ...upload, ...owner() }, jpeg)).ok, false, 'owner cannot pretend to be cleaner');
    assert.equal((await json({ ...upload, room_key:'BEDROOM_99' }, jpeg)).ok, false);
    assert.equal(objects.size, 0);
    const result = await json(upload, jpeg);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.photo.purpose, 'completion');
    assert.ok(objects.has('completion-photos/' + photoId + '.jpg'));
    assert.equal(partner().completionPhotos[0].id, photoId);
    assert.equal(partner().photos.length, 0, 'customer reference gallery stays separate');
    assert.equal(history()[0].rooms[0].photos[0].id, photoId);
    assert.equal(history('VEN-B').length, 0);
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
    assert.deepEqual(objects.get('completion-photos/' + retry.photo_id + '.jpg'), original, 'retry keeps the original bytes');
    failAfterCommit = true;
    const lost = { ...upload, photo_id:randomUUID() };
    assert.equal((await json(lost, jpeg)).ok, false);
    assert.equal((await json(lost, jpeg)).ok, true);
    assert.equal(partner().completionPhotos.length, 3, 'lost responses do not duplicate records');
    // Orphaned completion objects are retained too, never swept into instruction cleanup.
    const orphan = { ...upload, photo_id:randomUUID() };
    failBeforeCommit = true; assert.equal((await json(orphan, jpeg)).ok, false);
    const sheet = T.tabs.COMPLETION_PHOTOS, headers = sheet._rows[0];
    const orphanRow = sheet._rows.find(r => r[0] === orphan.photo_id);
    orphanRow[headers.indexOf('created_at')] = new Date(Date.now() - 90000000);
    await loaded.box.cleanupPhotoStorage(env);
    assert.equal(objects.size, 4);
    assert.equal(orphanRow[headers.indexOf('status')], 'PENDING');
    for (let i = 3; i < 20; i++) assert.equal((await json({ ...upload, photo_id:randomUUID() }, jpeg)).ok, true);
    assert.equal((await json({ ...upload, photo_id:randomUUID() }, jpeg)).error, 'completion_photo_limit');
    const client = JSON.parse(S.handlePortal({ portal:'CONTACT-A', t:S.portalToken('CONTACT-A') }).getContent());
    assert.ok(!JSON.stringify(client).includes(photoId), 'completion evidence is not silently exposed to clients');
    assert.ok(!JSON.stringify(history()).includes('object_key'));
    const row = T.tabs.JOBS._rows[1];
    row[H.JOBS_HEADERS.indexOf('completed_date')] = '2026-09-14';
    assert.equal((await json({ ...upload, action:'read' })).error, 'closed');
    assert.equal((await json({ ...upload, photo_id:randomUUID() }, jpeg)).error, 'closed');
    assert.equal((await request(read)).headers.get('Content-Type'), 'image/jpeg', 'owner can review completed jobs');
    row[H.JOBS_HEADERS.indexOf('vendor_id')] = 'VEN-B';
    assert.equal(history()[0].rooms[0].photos.length, 20, 'stored owner survives reassignment');
    assert.equal(history('VEN-B').length, 0);
    assert.equal((await json({ ...read, ...owner('VEN-B') })).ok, false);
    T.tabs.JOBS.deleteRow(2);
    assert.equal(history()[0].rooms[0].label, 'Bedroom 1', 'archive does not depend on operational job row');
    assert.equal((await request(read)).headers.get('Content-Type'), 'image/jpeg');
    await loaded.box.cleanupPhotoStorage(env);
    assert.equal(objects.size, 21);
    console.log('Completion photos: finished-room consent, isolation, immutable retries, limits, retained vendor ownership and cleanup safety passed.');
})().catch(err => { console.error(err); process.exitCode = 1; });
