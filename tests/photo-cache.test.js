/* PHOTOS ALREADY READ ARE NOT READ AGAIN. 2026-09-15.
   ==================================================================
   Boots the real booking-photos.js against a DOM shim and a fetch that holds
   every photo read until the test answers it, and asserts:

     - at most three photo reads are out at once; the rest wait their turn
     - a repaint (the page releasing its views and mounting them again) shows
       photos already read without asking the server again
     - two views of one photo share one read
     - a photo just uploaded shows from the bytes in hand, with no read
     - a removed photo is forgotten, so it could only come back by a new read
     - a failed read is not remembered: Retry asks again
     - the memory is bounded: past 30 MB the oldest photo is dropped

   Every photo read is a trip through the booking server, which is why each of
   these is worth a test and not only a comment. */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PHOTOS = fs.readFileSync(path.join(__dirname, '..', 'booking-photos.js'), 'utf8');

let bad = 0;
const t = (label, got, want) => {
  const okp = JSON.stringify(got) === JSON.stringify(want);
  console.log((okp ? '  ok    ' : '  FAIL  ') + label + '  ->  ' + JSON.stringify(got));
  if (!okp) { console.log('        expected ' + JSON.stringify(want)); bad++; }
};
const head = (m) => console.log('\n=== ' + m + ' ===');

/* --- the smallest DOM booking-photos.js touches --- */
function node(tag) {
  const n = {
    tagName: String(tag).toUpperCase(), className: '', children: [], parentNode: null,
    _text: '', attrs: {}, _on: {}, disabled: false,
    set textContent(v) { this._text = String(v); if (String(v) === '') this.children.length = 0; },
    get textContent() { return this._text; },
    get isConnected() { let x = this; while (x.parentNode) x = x.parentNode; return !!x._root; },
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    remove() { if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    removeAttribute(k) { delete this.attrs[k]; },
    addEventListener(ev, fn) { (this._on[ev] = this._on[ev] || []).push(fn); },
    fire(ev, e) { return Promise.all((this._on[ev] || []).map(fn => fn(e || {}))); },
    click() {},
    showModal() {}, close() {},
    contains(other) { return all(this).indexOf(other) !== -1; },
    querySelectorAll(sel) {
      const wants = String(sel).split(',').map(s => s.trim().toUpperCase());
      return all(this).filter(c => wants.indexOf(c.tagName) !== -1);
    },
  };
  if (n.tagName === 'CANVAS') {
    n.getContext = () => ({ fillRect() {}, drawImage() {} });
    n.toBlob = (cb) => cb(new Blob([new Uint8Array(900)], { type: 'image/jpeg' }));
  }
  return n;
}
const all = (n) => (n.children || []).reduce((a, c) => a.concat([c], all(c)), []);
const byClass = (root, cls) => all(root).filter(n => String(n.className || '').split(/\s+/).indexOf(cls) !== -1);
const imgs = (root) => all(root).filter(n => n.tagName === 'IMG');
const settle = async () => { for (let i = 0; i < 40; i++) await new Promise(r => setImmediate(r)); };

function boot() {
  const reads = [];     // every photo read the server was asked for, in order
  const others = [];    // uploads and deletes
  const box = {
    console: { log() {}, warn() {}, error() {} },
    document: { createElement: node },
    Blob, FormData, AbortController, setTimeout, clearTimeout,
    crypto: require('crypto').webcrypto,
    URL: { createObjectURL: () => 'blob:local', revokeObjectURL() {} },
    Image: class { set src(v) { this.naturalWidth = 3000; this.naturalHeight = 2000; setImmediate(() => this.onload()); } },
    /* Seen as soon as it is observed, like a photo already on screen. */
    IntersectionObserver: class {
      constructor(cb) { this.cb = cb; this.live = true; }
      observe() { setImmediate(() => { if (this.live) this.cb([{ isIntersecting: true }]); }); }
      disconnect() { this.live = false; }
    },
    fetch(url, init) {
      const data = JSON.parse(typeof init.body === 'string' ? init.body : init.body.get('data'));
      if (data.action !== 'read') {
        others.push(data);
        const reply = data.action === 'upload'
          ? { ok: true, photo: { id: data.photo_id, roomKey: data.room_key, createdAt: '' } } : { ok: true };
        return Promise.resolve({ ok: true, headers: { get: () => 'application/json' }, json: () => Promise.resolve(reply) });
      }
      return new Promise((resolve, reject) => {
        reads.push({
          id: data.photo_id, purpose: data.purpose, done: false,
          answer(bytes) {
            this.done = true;
            resolve({ ok: true, headers: { get: () => 'image/jpeg' },
                      blob: () => Promise.resolve(new Blob([new Uint8Array(bytes || 10)], { type: 'image/jpeg' })) });
          },
          fail() { this.done = true; reject(new TypeError('offline')); },
        });
      });
    },
  };
  box.window = box;
  box.addEventListener = () => {};
  vm.createContext(box);
  vm.runInContext(PHOTOS, box);

  const root = node('div');
  root._root = true;
  return {
    reads, others, root,
    out: () => reads.filter(r => !r.done),
    readsOf: id => reads.filter(r => r.id === id).length,
    answerAll: async (bytes) => { for (let i = 0; i < 20 && reads.some(r => !r.done); i++) {
      reads.filter(r => !r.done).forEach(r => r.answer(bytes)); await settle(); } },
    mount(photoIds, over) {
      const wrap = box.ServePhotos.mount(Object.assign({
        jobId: 'SRV-1', roomKey: 'KITCHEN', roomLabel: 'Kitchen', editable: false,
        auth: { auth_kind: 'portal', contact_id: 'CON-1', t: 'tok' },
        photos: photoIds.map(id => ({ id, roomKey: 'KITCHEN', createdAt: '' })),
      }, over || {}));
      root.appendChild(wrap);
      return wrap;
    },
    /* What a portal or ticket does on a repaint: release its views, redraw. */
    repaint() { box.ServePhotos.release(root); root.children.slice().forEach(c => c.remove()); },
  };
}

(async function main() {
  head('A. At most three photo reads at once');
  const A = boot();
  const six = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
  A.mount(six);
  await settle();
  t('six photos on screen start three reads', [A.reads.length, A.out().length], [3, 3]);
  A.reads[0].answer();
  await settle();
  t('one finishing lets the next one start', [A.reads.length, A.out().length], [4, 3]);
  await A.answerAll();
  t('every photo is read exactly once', six.map(A.readsOf), [1, 1, 1, 1, 1, 1]);
  t('and every photo shows', imgs(A.root).length, 6);

  head('B. A repaint shows photos already read, without asking again');
  A.repaint();
  t('the old views are gone', imgs(A.root).length, 0);
  A.mount(six);
  await settle();
  t('no new read after the repaint', A.reads.length, 6);
  t('and all six show again', imgs(A.root).length, 6);

  head('C. Two views of one photo share one read');
  const first = A.mount(['p7']);
  const second = A.mount(['p7']);
  await settle();
  t('one read for the two views', A.readsOf('p7'), 1);
  await A.answerAll();
  t('and both show it', [imgs(first).length, imgs(second).length], [1, 1]);

  head('D. A photo just uploaded shows with no read');
  const D = boot();
  const editable = D.mount([], { editable: true });
  const upload = all(editable).filter(n => n.tagName === 'INPUT' && !('capture' in n.attrs))[0];
  upload.files = [new Blob([new Uint8Array(20)], { type: 'image/jpeg' })];
  await upload.fire('change');
  await settle();
  const uploaded = D.others.filter(o => o.action === 'upload').map(o => o.photo_id);
  t('the upload went out', uploaded.length, 1);
  t('the new photo shows', imgs(editable).length, 1);
  t('without a read of the photo just sent', D.reads.length, 0);

  head('E. A removed photo is forgotten');
  const E = boot();
  const mine = E.mount(['r1'], { editable: true });
  await settle();
  await E.answerAll();
  t('the photo was read once and shows', [E.readsOf('r1'), imgs(mine).length], [1, 1]);
  await byClass(mine, 'room-photos__remove')[0].fire('click');
  await settle();
  t('Remove sent a delete', E.others.map(o => [o.action, o.photo_id]), [['delete', 'r1']]);
  E.repaint();
  E.mount(['r1']);
  await settle();
  t('had it come back, it would take a new read', E.readsOf('r1'), 2);

  head('F. A failed read is not remembered');
  const F = boot();
  const failing = F.mount(['f1']);
  await settle();
  F.reads[0].fail();
  await settle();
  const retry = byClass(failing, 'room-photos__view')[0];
  t('the card offers a retry', retry.textContent, 'Retry photo');
  await retry.fire('click');
  await settle();
  t('Retry asks the server again', F.readsOf('f1'), 2);
  await F.answerAll();
  t('and the photo shows', imgs(failing).length, 1);

  head('G. Memory is bounded: past 30 MB the oldest photo is dropped');
  const G = boot();
  const MB12 = 12000000;
  G.mount(['big1']); await settle(); await G.answerAll(MB12);
  G.mount(['big2']); await settle(); await G.answerAll(MB12);
  G.mount(['big3']); await settle(); await G.answerAll(MB12);
  G.repaint();
  G.mount(['big3']); await settle();
  t('the newest is still kept', G.readsOf('big3'), 1);
  G.mount(['big1']); await settle();
  t('the oldest was dropped, so it is read again', G.readsOf('big1'), 2);

  console.log('\n' + (bad ? 'FAILURES: ' + bad : 'all photo-cache checks passed'));
  process.exit(bad ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
