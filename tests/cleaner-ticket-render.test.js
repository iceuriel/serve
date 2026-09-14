/* THE CLEANER'S SCOPE ROOMS, DRIVEN THE WAY A BROWSER DRIVES THEM. r48.
   ==================================================================
   Boots the real ticket.js and booking-photos.js — byte for byte — against a
   DOM shim and a stubbed fetch, and asserts what a cleaner sees and sends:

     - every room is a closed <details>, like the customer's rooms
     - inside: what the customer asked for, ONE Add photos control (camera or
       library, several at once) with "Add photos when completed", and an
       optional note
     - no finished-room checkbox and none of r47's retention copy
     - a note saves as partner_note with the partner token, never as a
       customer instruction; the customer's own view still saves instructions
     - picking two photos uploads two, as the cleaner's kind, and the room's
       flag counts them */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const TICKET  = fs.readFileSync(path.join(ROOT, 'ticket.js'), 'utf8');
const PHOTOS  = fs.readFileSync(path.join(ROOT, 'booking-photos.js'), 'utf8');
const PARTNER = fs.readFileSync(path.join(ROOT, 'partner-card.js'), 'utf8');
const VENDOR  = fs.readFileSync(path.join(ROOT, 'vendor.js'), 'utf8');

let bad = 0;
const t = (label, got, want) => {
  const okp = JSON.stringify(got) === JSON.stringify(want);
  console.log((okp ? '  ok    ' : '  FAIL  ') + label + '  ->  ' + JSON.stringify(got));
  if (!okp) { console.log('        expected ' + JSON.stringify(want)); bad++; }
};
const head = (m) => console.log('\n=== ' + m + ' ===');

/* --- the smallest DOM these two files touch --- */
function node(tag) {
  const n = {
    tagName: String(tag).toUpperCase(), className: '', children: [], parentNode: null,
    _text: '', attrs: {}, hidden: false, _on: {}, clicks: 0,
    classList: { add() {}, remove() {}, toggle() {} },
    set textContent(v) { this._text = String(v); if (String(v) === '') this.children.length = 0; },
    get textContent() { return this._text; },
    get firstChild() { return this.children[0] || null; },
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    remove() { if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    removeAttribute(k) { delete this.attrs[k]; },
    addEventListener(ev, fn) { (this._on[ev] = this._on[ev] || []).push(fn); },
    fire(ev, e) { return Promise.all((this._on[ev] || []).map(fn => fn(e || {}))); },
    click() { this.clicks++; },
    contains(other) { return all(this).indexOf(other) !== -1; },
    querySelectorAll(sel) {
      const wants = String(sel).split(',').map(s => s.trim());
      return all(this).filter(c => wants.some(w => w.charAt(0) === '.'
        ? String(c.className).split(/\s+/).indexOf(w.slice(1)) !== -1
        : c.tagName === w.toUpperCase()));
    },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
  };
  if (n.tagName === 'CANVAS') {
    n.getContext = () => ({ fillRect() {}, drawImage() {} });
    n.toBlob = (cb) => cb(new Blob([new Uint8Array(900)], { type: 'image/jpeg' }));
  }
  return n;
}
const all = (n) => (n.children || []).reduce((a, c) => a.concat([c], all(c)), []);
const byClass = (root, cls) => all(root).filter(n => String(n.className || '').split(/\s+/).indexOf(cls) !== -1);
const byTag = (root, tag) => all(root).filter(n => n.tagName === tag.toUpperCase());
const textOf = (root, cls) => (byClass(root, cls)[0] || {})._text || '';
const texts = (root) => all(root).map(n => n._text).filter(Boolean);

async function boot(model, view) {
  const els = {}, posts = [], uploads = [], warns = [];
  /* ticket.js swallows a render throw into console.warn, so keep the message:
     a failure should name the bug, not report an empty page. */
  const keep = (...a) => warns.push(a.map(x => (x && x.stack) || String(x)).join(' '));
  const box = {
    console: { log() {}, warn: keep, error: keep },
    document: {
      createElement: node,
      getElementById(id) { return (els[id] = els[id] || node('div')); },
    },
    location: { search: (view === 'vendor' ? '?id=VEN-1' : '?id=SRV-9') + '&t=tok' + (view === 'partner' ? '&view=partner' : '') },
    URLSearchParams, Blob, FormData, setTimeout, clearTimeout, AbortController,
    sessionStorage: { getItem() { return null; }, setItem() {} },
    crypto: require('crypto').webcrypto,
    URL: { createObjectURL: () => 'blob:local', revokeObjectURL() {} },
    Image: class { set src(v) { this.naturalWidth = 3000; this.naturalHeight = 2000; setImmediate(() => this.onload()); } },
    fetch(url, init) {
      if (url === '/api/photos') {
        // Uploads are a form; reads are plain JSON.
        const data = JSON.parse(typeof init.body === 'string' ? init.body : init.body.get('data'));
        uploads.push(data);
        const reply = { ok: true, photo: { id: 'new-' + uploads.length, roomKey: data.room_key, createdAt: '', purpose: data.purpose } };
        return Promise.resolve({ ok: true, headers: { get: () => 'application/json' }, json: () => Promise.resolve(reply) });
      }
      if (init && init.method === 'POST') {
        posts.push(JSON.parse(init.body));
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(model) });
    },
  };
  box.window = box;
  box.window.addEventListener = () => {};
  vm.createContext(box);
  vm.runInContext(PARTNER, box);
  vm.runInContext(PHOTOS, box);
  vm.runInContext(view === 'vendor' ? VENDOR : TICKET, box);
  const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(r => setImmediate(r)); };
  await settle();
  return { body: els[view === 'vendor' ? 'v-body' : 't-body'] || node('div'), posts, uploads, warns, settle };
}

function partnerModel(over) {
  return Object.assign({
    ok: true, view: 'partner', bookingId: 'SRV-9',
    photos: [{ id: 'cust-1', roomKey: 'KITCHEN', createdAt: '' }],
    completionPhotoSupport: true,
    completionPhotos: [{ id: 'p1', roomKey: 'BATHROOM_1', createdAt: '', purpose: 'completion' },
                       { id: 'p2', roomKey: 'BATHROOM_1', createdAt: '', purpose: 'completion' }],
    booking: { serviceCode: 'CLEAN_DEEP', serviceLabel: 'Deep clean', date: '2026-09-20',
               time: '9:00 AM', payout: 120, completed: '', cancelled: false },
    property: { address: '1 Main St', zip: '02116', beds: 1, baths: 1 },
    scope: [
      { key: 'BEDROOM_1', label: 'Bedroom 1', instruction: '', note: '' },
      { key: 'BATHROOM_1', label: 'Bathroom 1', instruction: 'Scrub the grout', note: 'Fan is loud' },
      { key: 'KITCHEN', label: 'Kitchen', instruction: '', note: '' },
    ],
    instructions: {}, access: { standing: {} },
  }, over || {});
}

(async function main() {
  head('A. Each Scope room is a closed box, like the customer\'s');
  const A = await boot(partnerModel(), 'partner');
  t('the ticket rendered without a swallowed error', A.warns, []);
  const rooms = byClass(A.body, 'tk-room');
  t('one box per room', rooms.map(r => r.tagName), ['DETAILS', 'DETAILS', 'DETAILS']);
  t('closed until tapped', rooms.map(r => !!r.open || 'open' in r.attrs), [false, false, false]);
  t('kept open across a live refresh, by room', rooms.map(r => r.attrs['data-live-key']), ['BEDROOM_1', 'BATHROOM_1', 'KITCHEN']);
  t('the summary names the room', rooms.map(r => textOf(r, 'tk-room__name')), ['Bedroom 1', 'Bathroom 1', 'Kitchen']);
  t('and says what is inside', rooms.map(r => textOf(r, 'tk-room__flag')),
    ['Add photos', 'Has instructions · 2 photos', 'Has instructions']);
  t('what the customer asked for sits inside the box', rooms.map(r => byClass(r, 'tk-room__from').map(f => texts(f).slice(0, 2))),
    [[], [['From the customer', 'Scrub the grout']], [['From the customer', 'Load photo 1']]]);
  t("the customer's photo is shown, read-only", byClass(rooms[2], 'tk-room__from').map(f => byClass(f, 'room-photos__card').length), [1]);
  t('no old flat scope rows', byClass(A.body, 'tk-scope').length, 0);

  head('B. One Add photos control per room');
  const addButtons = rooms.map(r => byTag(r, 'button').filter(b => b._text === 'Add photos'));
  t('exactly one Add photos button in each room', addButtons.map(b => b.length), [1, 1, 1]);
  const pickers = rooms.map(r => byTag(r, 'input').filter(i => i.type === 'file'));
  t('one file picker each, and no other photo buttons', pickers.map(p => p.length), [1, 1, 1]);
  t('the picker offers camera AND library (no capture), several at once',
    pickers.map(p => [p[0].accept, p[0].multiple === true, 'capture' in p[0].attrs]),
    [['image/*', true, false], ['image/*', true, false], ['image/*', true, false]]);
  t('the reminder sits beside it', rooms.map(r => byClass(r, 'room-photos__note').map(n => n._text)),
    [['Add photos when completed'], ['Add photos when completed'], ['Add photos when completed']]);
  t("the cleaner's saved photos show in their room", byClass(rooms[1], 'room-photos__card').length, 2);
  t('no checkbox anywhere', all(A.body).filter(n => n.type === 'checkbox').length, 0);
  t("none of r47's copy", texts(A.body).filter(s => /finished|retain|archive|cannot be removed|up to 20/i.test(s)), []);
  t('no remove control on a cleaner photo', byClass(A.body, 'room-photos__remove').length, 0);

  head('C. The optional note');
  const boxes = rooms.map(r => byTag(r, 'textarea'));
  t('one note box per room', boxes.map(b => b.length), [1, 1, 1]);
  t('labelled as optional', rooms.map(r => textOf(r, 'tk-edit__lbl')), ['Notes (optional)', 'Notes (optional)', 'Notes (optional)']);
  t('says who reads it', boxes[0][0].placeholder, 'Anything the customer, your company or Serve should know.');
  t('a saved note comes back in its box', boxes[1][0].value, 'Fan is loud');
  boxes[1][0].value = 'Fan is loud; mold behind the tub';
  await byClass(rooms[1], 'tk-edit__save').filter(b => b._text === 'Save')[0].fire('click');
  await A.settle();
  t('Save sends a partner_note with the partner token, and nothing else', A.posts,
    [{ job_id: 'SRV-9', t: 'tok', event_type: 'partner_note', room_key: 'BATHROOM_1', note: 'Fan is loud; mold behind the tub' }]);
  t('and says it saved', textOf(rooms[1], 'tk-save'), 'Saved');

  head('D. Picking two photos uploads two');
  addButtons[0][0].fire('click');
  t('the button opens the picker', pickers[0][0].clicks, 1);
  pickers[0][0].files = [new Blob([new Uint8Array(10)], { type: 'image/jpeg' }), new Blob([new Uint8Array(10)], { type: 'image/png' })];
  await pickers[0][0].fire('change');
  await A.settle();
  t('two uploads, as the cleaner\'s kind, for that room, with no confirmation field',
    A.uploads.map(u => [u.action, u.purpose, u.auth_kind, u.t, u.job_id, u.room_key, 'finished' in u]),
    [['upload', 'completion', 'partner', 'tok', 'SRV-9', 'BEDROOM_1', false],
     ['upload', 'completion', 'partner', 'tok', 'SRV-9', 'BEDROOM_1', false]]);
  t('both show in the room', byClass(rooms[0], 'room-photos__card').length, 2);
  t('the summary counts them', textOf(rooms[0], 'tk-room__flag'), '2 photos');
  t('and the status says so', textOf(rooms[0], 'room-photos__status'), '2 photos saved');
  t('the controls are usable again', byTag(rooms[0], 'button').filter(b => b.disabled).length, 0);

  head('E. Without photo storage, or on a called-off visit');
  const E1 = await boot(partnerModel({ completionPhotoSupport: false }), 'partner');
  t('no storage: no Add photos, the note still works',
    [byTag(E1.body, 'button').filter(b => b._text === 'Add photos').length, byTag(E1.body, 'textarea').length], [0, 3]);
  const E2 = await boot(partnerModel({ booking: Object.assign({}, partnerModel().booking, { cancelled: true }) }), 'partner');
  t('called off: nothing to add, the note shown as text',
    [byTag(E2.body, 'button').filter(b => b._text === 'Add photos').length, byTag(E2.body, 'textarea').length,
     byClass(byClass(E2.body, 'tk-room')[1], 'tk-edit').map(e => texts(e))],
    [0, 0, [['Notes (optional)', 'Fan is loud']]]);

  head("F. The customer's own ticket still saves instructions");
  const F = await boot({ ok: true, view: 'client', booking: { date: '2026-09-20', completed: '' },
    home: { rooms: [{ key: 'KITCHEN', label: 'Kitchen', instruction: '' }] }, instructions: {}, access: { fields: [] } }, 'client');
  const room = byClass(F.body, 'tk-room')[0];
  byTag(room, 'textarea')[0].value = 'Fresh sheets are in the closet';
  await byClass(room, 'tk-edit__save')[0].fire('click');
  await F.settle();
  t('a customer room note is still a booking_instruction', F.posts,
    [{ job_id: 'SRV-9', t: 'tok', event_type: 'booking_instruction', scope_type: 'ROOM', scope_key: 'KITCHEN', instruction: 'Fresh sheets are in the closet' }]);
  t("and the customer's room has no cleaner controls",
    [byTag(room, 'button').filter(b => b._text === 'Add photos').length, textOf(room, 'tk-edit__lbl')], [0, '']);

  head('G. The vendor company sees them on the job, not in a separate archive');
  const job = (over) => Object.assign({ serviceLabel: 'Deep clean', date: '2026-09-20', time: '9:00 AM',
    payout: 120, address: '1 Main St', zip: '02116', home: '1 BR / 1 BA', completed: '', report: [] }, over);
  const G = await boot({ ok: true, view: 'vendor', vendorId: 'VEN-1', company: { displayName: 'Beacon' },
    bookings: [
      job({ bookingId: 'SRV-9', ticketUrl: 'https://example.test/j', report: [
        { key: 'KITCHEN', label: 'Kitchen', note: 'Oven door sticks', photos: [{ id: 'p1', roomKey: 'KITCHEN', createdAt: '', purpose: 'completion' }] },
        { key: 'BATHROOM_1', label: 'Bathroom 1', note: '', photos: [{ id: 'p2', roomKey: 'BATHROOM_1', createdAt: '', purpose: 'completion' },
                                                                  { id: 'p3', roomKey: 'BATHROOM_1', createdAt: '', purpose: 'completion' }] }] }),
      job({ bookingId: 'SRV-8', completed: '2026-09-01' }),
    ] }, 'vendor');
  t('the vendor portal rendered without a swallowed error', G.warns, []);
  const rows = byClass(G.body, 'pb');
  const reportOf = (row) => byClass(row, 'pb__h').filter(h => h._text === 'From the job ticket').length
    ? byClass(row, 'tk-blk').filter(b => ['Kitchen', 'Bathroom 1'].indexOf(textOf(b, 'tk-lbl')) !== -1)
        .map(b => [textOf(b, 'tk-lbl'), textOf(b, 'tk-val'), byClass(b, 'room-photos__card').length])
    : null;
  t('the job with photos and a note shows them by room', reportOf(rows[0]), [['Kitchen', 'Oven door sticks', 1], ['Bathroom 1', '', 2]]);
  t('a job with nothing added shows nothing', reportOf(rows[1]), null);
  t('read-only for the company', [byTag(G.body, 'button').filter(b => b._text === 'Add photos').length,
    byClass(G.body, 'room-photos__remove').length], [0, 0]);
  t('and no separate archive section', byClass(G.body, 'portal__h').map(h => h._text), ['Upcoming', 'Completed']);
  await byClass(rows[0], 'room-photos__view')[0].fire('click');
  await G.settle();
  t('a photo is read with the company credential', G.uploads.map(u => [u.action, u.purpose, u.auth_kind, u.vendor_id, u.job_id, u.room_key]),
    [['read', 'completion', 'vendor', 'VEN-1', 'SRV-9', 'KITCHEN']]);

  console.log('\n' + (bad ? bad + ' FAILURES' : 'all cleaner-ticket-render checks passed'));
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
