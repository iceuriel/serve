/* Real Worker -> real Apps Script -> in-memory Sheets/R2. No live customer
   records. Reuse the existing execution harnesses, not their assertions. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert/strict');
const { randomUUID } = require('crypto');
const root = path.resolve(__dirname, '..');
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
S.PropertiesService = { getScriptProperties: () => ({ getProperty: k =>
    ({ TICKET_SECRET: 'test-secret-value', PHOTO_BRIDGE_SECRET: 'test-photo-bridge' })[k] || null }) };
function seed(tab, headers, values) { tab.appendRow(headers.map(h => values[h] === undefined ? '' : values[h])); }
seed(T.tabs.LEADS, H.LEADS_HEADERS, { lead_id: 'LEAD-A', contact_id: 'CONTACT-A', name: 'Customer A' });
seed(T.tabs.LEADS, H.LEADS_HEADERS, { lead_id: 'LEAD-B', contact_id: 'CONTACT-B', name: 'Customer B' });
for (const [job, lead, prop] of [['JOB-A','LEAD-A','PROPERTY-A'], ['JOB-B','LEAD-B','PROPERTY-B']]) {
    seed(T.tabs.JOBS, H.JOBS_HEADERS, { job_id: job, lead_id: lead, property_id: prop,
        beds: 2, baths: 1, service_type: 'First Clean', name: 'Test Customer', quoted_price: 200 });
}
const objects = new Map(); let puts = 0, failCommit = false, failRead = false;
const B = { put: async (key, bytes) => { puts++; if (!objects.has(key)) objects.set(key, Buffer.from(bytes)); },
    get: async key => objects.has(key) ? { body: objects.get(key) } : null,
    delete: async key => { for (const k of Array.isArray(key) ? key : [key]) objects.delete(k); } };
const loaded = W.loadWorker(async (_, init) => {
    const d = JSON.parse(init.body);
    if (failRead) throw new Error('offline');
    const result = S.doPost({ postData: { contents: JSON.stringify(d) } }).getContent();
    if (failCommit && d.action === 'commit') { failCommit = false; throw new Error('lost commit response'); }
    return new Response(result);
});
const env = { WEBHOOK_URL: 'https://example.test/webhook', BOOKING_PHOTOS: B, PHOTO_BRIDGE_SECRET: 'test-photo-bridge' };
const credentials = { auth_kind: 'portal', contact_id: 'CONTACT-A', job_id: 'JOB-A', room_key: 'KITCHEN', t: S.portalToken('CONTACT-A') };
const jpeg = new Blob([new Uint8Array([255,216,255,224,0,2,255,217])], { type: 'image/jpeg' });
async function request(data, file, options = {}) {
    let body, headers;
    if (file) { body = new FormData(); body.append('data', JSON.stringify(data)); body.append('photo', file, 'test.jpg'); }
    else { body = JSON.stringify(data); headers = { 'Content-Type': 'application/json' }; }
    return loaded.worker.fetch(new Request('https://servecleaning.com/api/photos', {
        method: 'POST', headers, body, ...options }), env);
}
async function json(data, file) { return (await request(data, file)).json(); }
const direct = d => JSON.parse(S.doPost({ postData: { contents: JSON.stringify(d) } }).getContent());
const partner = () => JSON.parse(S.handleTicket({ job: 'JOB-A', view: 'partner', t: S.ticketToken('JOB-A', 'partner') }).getContent());
const portal = () => JSON.parse(S.handlePortal({ portal: 'CONTACT-A', t: S.portalToken('CONTACT-A') }).getContent());
(async function () {
    const photoId = randomUUID();
    const upload = { ...credentials, action: 'upload', photo_id: photoId };
    assert.equal(direct({ ...upload, event_type: 'booking_photo', action: 'begin' }).ok, false, 'direct /exec cannot forge upload metadata');
    assert.equal((await json({ ...upload, t: 'wrong' }, jpeg)).ok, false);
    assert.equal((await json({ ...upload, job_id: 'JOB-B' }, jpeg)).ok, false, 'one portal is not all bookings');
    assert.equal((await json({ ...upload, room_key: 'BEDROOM_99' }, jpeg)).ok, false);
    assert.equal(objects.size, 0, 'rejected requests never reach R2');
    const result = await json(upload, jpeg);
    assert.equal(result.ok, true); assert.equal(objects.size, 1);
    assert.equal(partner().photos[0].id, photoId, 'vendor sees the saved photo');
    assert.equal(portal().bookings[0].photos[0].id, photoId, 'customer sees the same photo');
    assert.ok(!JSON.stringify(partner()).includes('object_key'));
    const read = await request({ ...upload, action: 'read', auth_kind: 'partner', t: S.ticketToken('JOB-A', 'partner') });
    assert.equal(read.headers.get('Content-Type'), 'image/jpeg');
    assert.match(read.headers.get('Cache-Control'), /no-store/);
    assert.deepEqual(Buffer.from(await read.arrayBuffer()), Buffer.from(await jpeg.arrayBuffer()));
    assert.equal((await json({ ...upload, action: 'read', job_id: 'JOB-B', t: S.portalToken('CONTACT-B'), contact_id: 'CONTACT-B' })).ok, false);
    assert.equal((await json({ ...upload, auth_kind: 'partner', t: S.ticketToken('JOB-A','partner') }, jpeg)).ok, false, 'partner cannot upload');
    assert.equal((await json({ ...upload, action: 'delete', auth_kind: 'partner', t: S.ticketToken('JOB-A','partner') })).ok, false);
    const count = puts;
    assert.equal((await json(upload, jpeg)).ok, true); assert.equal(puts, count, 'acknowledged retry does not rewrite image');
    failCommit = true;
    const second = { ...upload, photo_id: randomUUID() };
    assert.equal((await json(second, jpeg)).ok, false, 'lost response is not presented as success');
    assert.equal((await json(second, jpeg)).ok, true, 'same ID recovers committed upload');
    assert.equal(partner().photos.length, 2, 'retry does not duplicate photo');
    assert.equal((await json({ ...upload, photo_id: randomUUID() }, jpeg)).ok, true);
    assert.equal((await json({ ...upload, photo_id: randomUUID() }, jpeg)).error, 'photo_limit');
    assert.equal((await json({ ...upload, action: 'delete' })).ok, true);
    assert.equal(partner().photos.length, 2); assert.equal(objects.size, 2);
    assert.equal((await json({ ...upload, action: 'read' })).ok, false, 'removed image cannot be read');
    assert.equal((await json(upload, jpeg)).ok, false, 'deleted upload cannot be resurrected by retry');
    assert.equal((await json({ ...upload, photo_id: randomUUID() }, new Blob(['<svg>bad</svg>'], {type:'image/jpeg'}))).ok, false);
    const forged = await request({ ...second, action: 'read' }, null, { headers: { Origin: 'https://evil.test' } });
    assert.equal(forged.status, 403);
    failRead = true; assert.equal((await json({ ...second, action: 'read' })).ok, false); failRead = false;
    // Exercise all the customer-to-vendor written paths, including changes and clearing.
    const write = (data) => direct({ event_type: 'portal_write', contact_id:'CONTACT-A', t:S.portalToken('CONTACT-A'), ...data });
    assert.equal(write({kind:'instruction', job_id:'JOB-A', scope_type:'ROOM', scope_key:'KITCHEN', instruction:'Focus on sink'}).ok,true);
    assert.equal(partner().scope.find(r=>r.key==='KITCHEN').instruction,'Focus on sink');
    write({kind:'instruction', job_id:'JOB-A', scope_type:'BOOKING', instruction:'Please arrive quietly'});
    assert.equal(partner().instructions.general,'Please arrive quietly');
    write({kind:'access', property_id:'PROPERTY-A', field:'pets', detail:'Cat in office'});
    assert.ok(partner().access.fromPortal.some(f=>f.value==='Cat in office'));
    const accessQuestions = portal().homes[0].questions;
    for (const q of accessQuestions) {
        const choice = q.choices.find(c=>c.detail && !c.secret) || q.choices.find(c=>!c.secret);
        assert.equal(write({kind:'access', property_id:'PROPERTY-A', field:q.field, choice:choice.key, detail:'Updated detail'}).ok,true);
        assert.ok(partner().access.fromPortal.some(f=>f.key===q.field && f.value.includes(choice.label)));
    }
    const entry = accessQuestions.find(q=>q.field==='entry').choices.find(c=>c.secret);
    write({kind:'access', property_id:'PROPERTY-A', field:'entry', choice:entry.key, detail:'SECRET-DO-NOT-RETURN'});
    assert.ok(!JSON.stringify(partner()).includes('SECRET-DO-NOT-RETURN'));
    assert.ok(!JSON.stringify(portal()).includes('SECRET-DO-NOT-RETURN'));
    write({kind:'access', property_id:'PROPERTY-A', field:'pets', detail:''});
    assert.ok(!partner().access.fromPortal.some(f=>f.key==='pets'));
    write({kind:'instruction', job_id:'JOB-A', scope_type:'ROOM', scope_key:'KITCHEN', instruction:''});
    assert.equal(partner().scope.find(r=>r.key==='KITCHEN').instruction,'');
    T.tabs.JOBS._rows[1][H.JOBS_HEADERS.indexOf('completed_date')] = '2026-09-21';
    assert.equal((await json({ ...second, action:'read', auth_kind:'partner', t:S.ticketToken('JOB-A','partner') })).error,'expired');
    assert.equal((await json({ ...second, action:'delete' })).error,'closed');
    assert.equal((await request({ ...second, action:'read' })).headers.get('Content-Type'),'image/jpeg', 'customer retains completed record');
    const missingEnv = await loaded.worker.fetch(new Request('https://servecleaning.com/api/photos',{method:'POST',body:'{}'}),{});
    assert.equal(missingEnv.status,503);
    // Maintenance only purges abandoned or deleted uploads, never READY photos.
    const orphanId = randomUUID();
    direct({ ...credentials, event_type:'booking_photo', bridge_token:env.PHOTO_BRIDGE_SECRET,
        job_id:'JOB-B', contact_id:'CONTACT-B', t:S.portalToken('CONTACT-B'), action:'begin', photo_id:orphanId, bytes:8 });
    const photoSheet=T.tabs.BOOKING_PHOTOS, ph=photoSheet._rows[0];
    const orphan=photoSheet._rows.find(r=>r[ph.indexOf('photo_id')]===orphanId);
    assert.ok(orphan); orphan[ph.indexOf('created_at')]=new Date(Date.now()-90000000);
    objects.set('booking-photos/'+orphanId+'.jpg',Buffer.from('orphan'));
    await loaded.box.cleanupPhotoStorage(env);
    assert.equal(objects.has('booking-photos/'+orphanId+'.jpg'),false);
    assert.equal(orphan[ph.indexOf('status')],'PURGED');
    assert.equal(objects.size,2,'ready records survive maintenance');
    assert.ok(!T.logs.join('').includes('SECRET-DO-NOT-RETURN'));
    console.log('Photo authorization, R2 lifecycle, retries, limits, shared text and access privacy passed.');
})().catch(err=>{console.error(err);process.exitCode=1;});
