/* Refresh shared records without replacing an unsaved form. No customer data
   is broadcast, logged or persisted. Each page reads its own authorized view. */
(function () {
    'use strict';
    function watch(opts) {
        var timer, pending = false, stopped = false, failures = 0, editVersion = 0;
        var previous = JSON.stringify(opts.initial);
        var root = opts.root;
        var status = document.createElement('p');
        status.className = 'booking-live';
        status.setAttribute('role', 'status');
        status.textContent = 'Updates automatically';
        /* WHERE THE LINE SITS IS THE PAGE'S CHOICE, not this file's. Directly
           above the view it describes is the default; a page that hands over
           somewhere quieter — its footer — gets it there instead. On a phone
           that matters: parked above the body it filled the whole band between
           the tabs and the first heading with a sentence nobody came to read,
           and it sat outside the page's own gutter while doing it. */
        if (opts.statusInto) opts.statusInto.appendChild(status);
        else root.parentNode.insertBefore(status, root);
        function editing() {
            return !!root.querySelector('.is-dirty, .tk-save.is-bad, [data-photo-busy], button:disabled, fieldset:disabled, dialog[open]') ||
                (root.contains(document.activeElement) && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName));
        }
        function schedule() {
            clearTimeout(timer);
            if (!stopped) timer = setTimeout(refresh, Math.min(120000, 25000 * Math.pow(2, failures)));
        }
        async function refresh() {
            if (stopped || pending) return;
            if (document.hidden || editing()) { schedule(); return; }
            pending = true;
            var requestVersion = editVersion;
            var abort = new AbortController();
            var timeout = setTimeout(function () { abort.abort(); }, 20000);
            try {
                var response = await fetch(opts.url, { cache: 'no-store', signal: abort.signal });
                if (!response.ok) throw new Error();
                var d = await response.json();
                if (!d || d.ok !== true || d.view !== opts.view) {
                    if (d && (d.error === 'expired' || d.error === 'not_found')) {
                        stopped = true;
                        if (window.ServePhotos) window.ServePhotos.release(root);
                        root.textContent = '';
                        root.hidden = true;
                        /* It has stopped being a footnote. With the view gone
                           this sentence is the only thing left to read, so it
                           comes back above the emptied body wherever the page
                           had parked it — a closed link explained in the
                           footer of a blank page is not explained. */
                        status.className = 'booking-live booking-live--closed';
                        root.parentNode.insertBefore(status, root);
                        status.textContent = 'This link has closed. Contact Serve if you need help.';
                        return;
                    }
                    throw new Error();
                }
                failures = 0;
                // Someone can start typing while the network request is in flight.
                if (editing() || document.hidden || editVersion !== requestVersion) return;
                var next = JSON.stringify(d);
                if (next !== previous) {
                    var opened = Array.from(root.querySelectorAll('details[open][data-live-key]'))
                        .map(function (n) { return n.getAttribute('data-live-key'); });
                    var x = window.scrollX, y = window.scrollY;
                    if (window.ServePhotos) window.ServePhotos.release(root);
                    opts.onData(d);
                    root.querySelectorAll('details[data-live-key]').forEach(function (n) {
                        n.open = opened.indexOf(n.getAttribute('data-live-key')) >= 0;
                    });
                    window.scrollTo(x, y);
                    previous = next;
                    status.textContent = 'Updated just now';
                } else status.textContent = 'Updates automatically';
            } catch (_) {
                failures = Math.min(failures + 1, 3);
                status.textContent = 'Updates paused — reconnecting. Details shown may be out of date.';
            } finally {
                clearTimeout(timeout);
                pending = false;
                schedule();
            }
        }
        function wake() { if (!document.hidden) { clearTimeout(timer); refresh(); } }
        function edited() { editVersion++; }
        root.addEventListener('input', edited, true);
        root.addEventListener('change', edited, true);
        root.addEventListener('click', edited, true);
        document.addEventListener('visibilitychange', wake);
        window.addEventListener('focus', wake);
        window.addEventListener('online', wake);
        schedule();
        return { refresh: refresh, stop: function () { stopped = true; clearTimeout(timer);
            document.removeEventListener('visibilitychange', wake);
            window.removeEventListener('focus', wake); window.removeEventListener('online', wake); } };
    }
    window.ServeLive = { watch: watch };
})();
