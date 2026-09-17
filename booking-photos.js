/* Room pictures are private JPEGs read with the current page credential.
   Object URLs exist only in this page and are revoked when their view closes. */
(function () {
    'use strict';
    var active = new Set();
    /* PHOTOS ALREADY READ, KEPT FOR THIS PAGE. A repaint (tab switch, live
       refresh, reload after a save) used to download every photo again, each
       one a trip through the booking server. A photo id's bytes never change,
       so the blob is kept by this page, by id, and shown again. A variable,
       never browser storage (no localStorage, no Cache API): it is gone when
       the page closes. Bounded by size; a removed photo is forgotten at once. */
    var CACHE_BYTES = 30000000, READ_PARALLEL = 3;
    var cached = new Map(), cachedBytes = 0, pending = new Map();
    var reading = 0, queue = [];
    function cacheKey(data) { return data.purpose + ':' + data.photo_id; }
    function forget(key) {
        var blob = cached.get(key);
        if (blob) { cachedBytes -= blob.size; cached.delete(key); }
        pending.delete(key);
    }
    function remember(key, blob) {
        if (!(blob instanceof Blob) || blob.size > CACHE_BYTES) return;
        forget(key);
        cached.set(key, blob); cachedBytes += blob.size;
        while (cachedBytes > CACHE_BYTES) forget(cached.keys().next().value);  // oldest first
    }
    /* At most READ_PARALLEL reads at once; the rest wait their turn. */
    function limited(task) {
        return new Promise(function (resolve, reject) {
            queue.push(function () {
                reading++;
                task().then(resolve, reject).then(function () { reading--; nextRead(); });
            });
            nextRead();
        });
    }
    function nextRead() { while (reading < READ_PARALLEL && queue.length) queue.shift()(); }
    function readPhoto(data) {
        var key = cacheKey(data), hit = cached.get(key);
        if (hit) { cached.delete(key); cached.set(key, hit); return Promise.resolve(hit); }
        if (pending.has(key)) return pending.get(key);
        var read = limited(function () { return request(data); }).then(function (blob) {
            // Not kept if the photo was removed while this read was out.
            if (pending.get(key) === read) { pending.delete(key); remember(key, blob); }
            return blob;
        }, function (err) {
            if (pending.get(key) === read) pending.delete(key);
            throw err;
        });
        pending.set(key, read);
        return read;
    }
    function node(tag, cls, text) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text) n.textContent = text;
        return n;
    }
    async function request(data, file) {
        var headers = {}, body;
        if (file) {
            body = new FormData(); body.append('data', JSON.stringify(data));
            body.append('photo', file, 'room.jpg');
        } else { headers['Content-Type'] = 'application/json'; body = JSON.stringify(data); }
        var abort = new AbortController();
        var timer = setTimeout(function () { abort.abort(); }, 60000);
        try {
            var r = await fetch('/api/photos', { method: 'POST', headers: headers,
                body: body, cache: 'no-store', signal: abort.signal });
            if (r.ok && data.action === 'read' && r.headers.get('Content-Type') === 'image/jpeg') return r.blob();
            var result = await r.json();
            if (!r.ok || !result.ok) throw new Error(result.error || 'photo_unavailable');
            return result;
        } finally { clearTimeout(timer); }
    }
    async function compress(file) {
        if (!file || file.size > 25000000 || !/^image\//.test(file.type)) throw new Error('unsupported_photo');
        var url = URL.createObjectURL(file);
        try {
            var img = new Image();
            await new Promise(function (resolve, reject) { img.onload = resolve; img.onerror = reject; img.src = url; });
            if (!img.naturalWidth || !img.naturalHeight) throw new Error();
            var scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
            var canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
            canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
            var ctx = canvas.getContext('2d');
            ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            // Re-encoding also removes location and other original EXIF metadata.
            var blob = await new Promise(function (resolve) { canvas.toBlob(resolve, 'image/jpeg', 0.82); });
            if (!blob || blob.size > 1500000) throw new Error();
            return blob;
        } catch (_) { throw new Error('unsupported_photo'); }
        finally { URL.revokeObjectURL(url); }
    }
    var messages = {
        not_configured: 'Photo uploads are not available yet. Your written notes still work.',
        photo_limit: 'You can add up to 3 photos per room. Remove one to add another.',
        closed: 'This booking is finished, so photos can no longer be changed.',
        expired: 'This booking link has closed.',
        unsupported_photo: 'Please choose a JPG, PNG or WebP photo under 25 MB. If a phone photo will not open, try a screenshot.',
        retry_upload: 'This upload expired. Choose the photo again.',
        not_found: 'This photo is no longer available.',
        completion_photo_limit: 'This room already has 20 photos.'
    };
    /* Two kinds of room photo. A customer's (the default) shows the cleaner what
       they mean: up to 3, removable. A cleaner's (purpose: 'completion') shows
       the finished room: one Add photos button, several at a time, and no
       remove — what was uploaded stays with Serve and the provider company. */
    function mount(opts) {
        var completion = opts.purpose === 'completion';
        var wrap = node('div', 'room-photos');
        var grid = node('div', 'room-photos__grid');
        var status = node('p', 'room-photos__status');
        status.setAttribute('role', 'status');
        var photos = (opts.photos || []).filter(function (p) { return p.roomKey === opts.roomKey; }).slice();
        var urls = [], observers = [], disposed = false, busy = false;
        var record = { wrap: wrap, release: function () { disposed = true;
            urls.forEach(function (u) { URL.revokeObjectURL(u); });
            observers.forEach(function (o) { o.disconnect(); }); active.delete(record); } };
        active.add(record);
        function auth(action, photoId) { return Object.assign({}, opts.auth, {
            action: action, job_id: opts.jobId, room_key: opts.roomKey, photo_id: photoId,
            purpose: completion ? 'completion' : 'instruction' }); }
        function error(err) { status.textContent = messages[err.message] || 'That did not finish. Please try again.'; }
        function loading(value) {
            busy = value;
            if (value) wrap.setAttribute('data-photo-busy', 'true'); else wrap.removeAttribute('data-photo-busy');
            wrap.querySelectorAll('button, input').forEach(function (n) { n.disabled = value; });
        }
        function changed() { if (opts.onChange) opts.onChange(photos.slice()); }
        // One photo, compressed and stored. `of` is '' or ' 2 of 3' for a batch.
        async function upload(file, of) {
            status.textContent = 'Preparing photo' + of + '…';
            var photoId = crypto.randomUUID();
            var blob = await compress(file); status.textContent = 'Uploading' + of + '…';
            var result;
            // Retry the same ID: a lost response must not create a duplicate.
            try { result = await request(auth('upload', photoId), blob); }
            catch (err) { if (err.message !== 'photo_unavailable' && err.name !== 'AbortError' && !(err instanceof TypeError)) throw err;
                result = await request(auth('upload', photoId), blob); }
            // The stored photo is these exact bytes, so showing it costs no read.
            remember(cacheKey(auth('read', photoId)), blob);
            photos.push(result.photo); changed(); draw();
        }
        function draw() {
            observers.forEach(function (o) { o.disconnect(); }); observers = [];
            urls.forEach(function (u) { URL.revokeObjectURL(u); }); urls = [];
            grid.textContent = '';
            photos.forEach(function (p, index) {
                var card = node('div', 'room-photos__card');
                var show = node('button', 'room-photos__view', 'Load photo ' + (index + 1));
                show.type = 'button';
                show.setAttribute('aria-label', opts.roomLabel + ' photo ' + (index + 1) + ', enlarge');
                var loaded = '', fetching = false;
                async function load() {
                    if (loaded || fetching || disposed) return;
                    fetching = true;
                    try {
                        var blob = await readPhoto(auth('read', p.id));
                        if (disposed || !card.isConnected) return;
                        loaded = URL.createObjectURL(blob); urls.push(loaded);
                        var img = node('img'); img.src = loaded;
                        img.alt = opts.roomLabel + (completion ? ' completion photo ' : ' instruction photo ') + (index + 1);
                        show.textContent = ''; show.appendChild(img);
                    } catch (_) { show.textContent = 'Retry photo'; }
                    finally { fetching = false; }
                }
                show.addEventListener('click', function () {
                    if (!loaded) { load(); return; }
                    var dialog = node('dialog', 'room-photos__dialog');
                    var close = node('button', 'tk-edit__save', 'Close photo'); close.type = 'button';
                    var full = node('img'); full.src = loaded; full.alt = opts.roomLabel + (completion ? ' completion photo' : ' instruction photo');
                    dialog.appendChild(close); dialog.appendChild(full); wrap.appendChild(dialog);
                    close.addEventListener('click', function () { dialog.close(); });
                    dialog.addEventListener('close', function () { dialog.remove(); });
                    dialog.showModal();
                });
                card.appendChild(show); grid.appendChild(card);
                if (typeof IntersectionObserver !== 'undefined') {
                    var observer = new IntersectionObserver(function (entries) {
                        if (entries.some(function (e) { return e.isIntersecting; })) { observer.disconnect(); load(); }
                    }); observer.observe(card); observers.push(observer);
                }
                if (opts.editable && !completion) {
                    var remove = node('button', 'room-photos__remove', 'Remove'); remove.type = 'button';
                    remove.setAttribute('aria-label', 'Remove ' + opts.roomLabel + ' photo ' + (index + 1));
                    remove.addEventListener('click', async function () {
                        if (busy) return; loading(true); status.textContent = 'Removing…';
                        try { await request(auth('delete', p.id));
                            forget(cacheKey(auth('delete', p.id)));
                            photos = photos.filter(function (x) { return x.id !== p.id; });
                            changed(); draw(); status.textContent = 'Photo removed';
                        } catch (err) { error(err); } finally { loading(false); }
                    }); card.appendChild(remove);
                }
            });
        }
        wrap.appendChild(grid);
        if (opts.editable && completion) {
            var actions = node('div', 'room-photos__actions');
            // No `capture`: a phone then offers the camera AND the photo library.
            var input = node('input'); input.type = 'file'; input.accept = 'image/*'; input.multiple = true; input.hidden = true;
            var button = node('button', 'tk-edit__save', 'Add photos'); button.type = 'button';
            button.setAttribute('aria-label', 'Add photos of ' + opts.roomLabel);
            button.addEventListener('click', function () { if (!busy) input.click(); });
            input.addEventListener('change', async function () {
                var files = Array.prototype.slice.call(input.files || []);
                if (!files.length || busy) { input.value = ''; return; }
                loading(true);
                try {
                    for (var i = 0; i < files.length; i++) {
                        if (photos.length >= 20) throw new Error('completion_photo_limit');
                        await upload(files[i], files.length > 1 ? ' ' + (i + 1) + ' of ' + files.length : '');
                    }
                    status.textContent = files.length > 1 ? files.length + ' photos saved' : 'Photo saved';
                } catch (err) { error(err); }
                finally { input.value = ''; loading(false); }
            });
            actions.appendChild(button); actions.appendChild(input);
            actions.appendChild(node('p', 'room-photos__note', 'Add photos when completed'));
            wrap.appendChild(actions);
        } else if (opts.editable) {
            var actions = node('div', 'room-photos__actions');
            [['Take a photo', true], ['Upload photo', false]].forEach(function (pair) {
                var input = node('input'); input.type = 'file'; input.accept = 'image/*'; input.hidden = true;
                if (pair[1]) input.setAttribute('capture', 'environment');
                var button = node('button', 'tk-edit__save', pair[0]); button.type = 'button';
                button.setAttribute('aria-label', button.textContent + ' for ' + opts.roomLabel);
                button.addEventListener('click', function () { if (!busy) input.click(); });
                input.addEventListener('change', async function () {
                    var file = input.files && input.files[0]; if (!file || busy) return;
                    if (photos.length >= 3) { error(new Error('photo_limit')); input.value = ''; return; }
                    loading(true);
                    try { await upload(file, ''); status.textContent = 'Saved — shared with your service partner'; }
                    catch (err) { error(err); }
                    finally { input.value = ''; loading(false); }
                });
                actions.appendChild(button); actions.appendChild(input);
            });
            wrap.appendChild(actions);
            wrap.appendChild(node('p', 'room-photos__note', 'Optional · Up to 3 photos. Shared with Serve and your service partner.'));
        }
        wrap.appendChild(status); draw(); return wrap;
    }
    function release(root) { active.forEach(function (r) { if (root.contains(r.wrap)) r.release(); }); }
    window.addEventListener('pagehide', function () { active.forEach(function (r) { r.release(); }); });
    window.ServePhotos = { mount: mount, release: release };
})();
