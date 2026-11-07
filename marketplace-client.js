/* The marketplace pages' only script. Everything here is an enhancement: with
   it switched off, every provider still shows and the estimate form still
   posts (the Worker answers a plain form POST with a full page). */
(function () {
    'use strict';

    /* ---------- mobile nav (same markup and classes as script.js) ---------- */
    var hamburger = document.querySelector('.nav__hamburger');
    var mobileMenu = document.getElementById('mobile-menu');
    if (hamburger && mobileMenu) {
        hamburger.addEventListener('click', function () {
            var isOpen = mobileMenu.classList.toggle('open');
            hamburger.setAttribute('aria-expanded', String(isOpen));
        });
    }

    /* ---------- the marketplace home (design/serve/HOME_SPEC.md §2, §3) ----------
       Area and Service filter everything together, live: the results heading,
       the count, the cards and the drifting sky logos. Every company is already
       on the page (rendered by the Worker); this only shows, hides and lights
       things up. Matching data comes from the page's #mk-areas JSON, which the
       Worker builds from the neighborhoods tables in D1: no list lives here.
       Nothing typed is sent anywhere. */
    var areaData = document.getElementById('mk-areas');
    if (areaData) initHome();

    function initHome() {
        var D;
        try { D = JSON.parse(areaData.textContent); } catch (e) { D = { areas: [], zips: {} }; }
        var areas = D.areas || [];
        var zips = D.zips || {};
        var bySlug = {};
        areas.forEach(function (a) { bySlug[a.slug] = a; });
        var byName = areas.slice().sort(function (a, b) { return b.name.length - a.name.length; });
        var popular = areas.filter(function (a) { return a.rank > 0; })
            .sort(function (a, b) { return a.rank - b.rank; });

        var split = function (v, sep) { return (v || '').split(sep).filter(Boolean); };
        var P = Array.prototype.map.call(document.querySelectorAll('.pc[data-slug]'), function (el) {
            return { el: el, slug: el.getAttribute('data-slug'), areas: split(el.getAttribute('data-areas'), ' '),
                regions: split(el.getAttribute('data-regions'), ' '), tags: split(el.getAttribute('data-tags'), '|') };
        });
        var sky = Array.prototype.map.call(document.querySelectorAll('.bn-lc[data-slug]'), function (el) {
            return { el: el, slug: el.getAttribute('data-slug'),
                op: parseFloat(el.getAttribute('data-op')) || 1, blur: parseFloat(el.getAttribute('data-blur')) || 0 };
        });

        var $ = function (sel) { return document.querySelector(sel); };
        var input = $('#mk-area'), list = $('#mk-area-list'), chev = $('[data-chev]'), combo = $('[data-combo]');
        var heading = $('[data-results-h]'), live = $('[data-live]'), clear = $('[data-clear]');
        var empty = $('[data-empty]'), emptyTitle = $('[data-empty-title]'), results = $('#providers');
        var pills = Array.prototype.slice.call(document.querySelectorAll('.mk-pill'));
        var state = { q: '', svc: 'All', open: false };
        var closeTimer;

        var titleCase = function (s) { return s.replace(/\b\w/g, function (c) { return c.toUpperCase(); }); };
        var plural = function (n) { return n === 1 ? 'company' : 'companies'; };

        /* What was typed → a place: { slug, name, zip } or { name } for a place
           we don't know, or null for nothing typed. */
        function toPlace(q) {
            var raw = (q || '').trim();
            if (!raw) return null;
            var zip = raw.match(/\b(\d{5})\b/);
            if (zip) {
                var slug = zips[zip[1]] || (zip[1].indexOf('021') === 0 ? 'boston' : '');
                return slug && bySlug[slug] ? { slug: slug, name: bySlug[slug].name, zip: zip[1] } : { name: 'ZIP ' + zip[1], zip: zip[1] };
            }
            var words = ' ' + raw.toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
            for (var i = 0; i < byName.length; i++) {
                if (words.indexOf(' ' + byName[i].name.toLowerCase() + ' ') !== -1) return { slug: byName[i].slug, name: byName[i].name };
            }
            /* Mid-word, as someone types: "Qu" means Quincy, not "Not in Qu
               yet". Popular areas first, then the shortest name. */
            var stem = words.trim();
            if (stem.length >= 2) {
                var starts = areas.filter(function (a) { return a.name.toLowerCase().indexOf(stem) === 0; })
                    .sort(function (a, b) { return (a.rank || 99) - (b.rank || 99) || a.name.length - b.name.length; });
                if (starts.length) return { slug: starts[0].slug, name: starts[0].name };
            }
            return { name: titleCase(raw) };
        }

        /* HOME_SPEC.md §3: companies that name the place (or its parent town, or
           the ZIP) first; if none do, the place's region; then nothing. */
        function inPlace(place) {
            if (!place) return P;
            var area = place.slug ? bySlug[place.slug] : null;
            var direct = P.filter(function (p) {
                return (area && (p.areas.indexOf(area.slug) !== -1 || (area.parent && p.areas.indexOf(area.parent) !== -1))) ||
                    (place.zip && p.areas.indexOf(place.zip) !== -1);
            });
            if (direct.length || !area) return direct;
            return P.filter(function (p) { return p.regions.indexOf(area.region) !== -1; });
        }

        function setOpen(open) { state.open = open; renderList(); }

        function renderList() {
            input.setAttribute('aria-expanded', String(state.open));
            chev.setAttribute('aria-expanded', String(state.open));
            list.hidden = !state.open;
            if (!state.open) return;
            var raw = state.q.trim().toLowerCase();
            var typed = /^\d/.test(raw) ? '' : raw;
            var place = toPlace(state.q);
            var items = [{ label: 'All of Greater Boston', val: '' }].concat(popular.map(function (a) { return { label: a.name, val: a.name, slug: a.slug }; }))
                .filter(function (a) { return !typed || a.val === '' || a.label.toLowerCase().indexOf(typed) !== -1; });
            list.innerHTML = '<div class="mk-combo__head">Popular areas</div>';
            items.forEach(function (a) {
                var n = inPlace(a.val ? { slug: a.slug, name: a.label } : null).length;
                var b = document.createElement('button');
                b.type = 'button';
                b.className = 'mk-opt';
                b.setAttribute('role', 'option');
                b.setAttribute('aria-selected', String(a.val ? !!(place && place.slug === a.slug) : !place));
                var label = document.createElement('span');
                label.textContent = a.label;
                var count = document.createElement('small');
                count.textContent = n + ' ' + plural(n);
                b.appendChild(label);
                b.appendChild(count);
                b.addEventListener('click', function () {
                    state.q = a.val;
                    input.value = a.val;
                    state.open = false;
                    render();
                    input.focus();
                });
                list.appendChild(b);
            });
            if (items.length <= 1 && typed) {
                var none = document.createElement('div');
                none.className = 'mk-combo__none';
                none.textContent = 'No popular area matches. Press Find Providers to search it.';
                list.appendChild(none);
            }
        }

        function render() {
            var place = toPlace(state.q);
            var shown = inPlace(place).filter(function (p) { return state.svc === 'All' || p.tags.indexOf(state.svc) !== -1; });
            var hit = {};
            shown.forEach(function (p) { hit[p.slug] = true; });
            var active = !!place || state.svc !== 'All';
            var n = shown.length;

            pills.forEach(function (c) { c.setAttribute('aria-pressed', String(c.getAttribute('data-service') === state.svc)); });
            if (P.length) {
                heading.textContent = n + ' trusted ' + plural(n) + (place ? ' near ' + place.name : ' across Greater Boston') +
                    (state.svc === 'All' ? '' : ' for ' + state.svc.toLowerCase());
                if (live) live.textContent = active ? n + ' of ' + P.length + ' ' + plural(P.length) + ' match' : P.length + ' trusted ' + plural(P.length) + ', live now';
            }
            clear.hidden = !place;
            P.forEach(function (p) { p.el.hidden = !hit[p.slug]; });
            empty.hidden = n > 0;
            emptyTitle.textContent = place ? 'Not in ' + place.name + ' yet.'
                : P.length ? 'No companies offer that yet.' : 'Book instantly in the meantime.';

            /* Styles only, so the drift animations keep running. */
            sky.forEach(function (s) {
                var on = active && hit[s.slug];
                s.el.style.opacity = String(!active ? s.op : on ? Math.max(0.95, s.op) : s.op * 0.15);
                s.el.style.filter = 'blur(' + (on ? 0 : s.blur) + 'px)';
                s.el.classList.toggle('is-hit', !!on);
            });
            renderList();
        }

        var options = function () { return Array.prototype.slice.call(list.querySelectorAll('.mk-opt')); };
        var toResults = function () {
            if (results) results.scrollIntoView({ behavior: 'smooth', block: 'start' });
        };

        input.addEventListener('input', function () { state.q = input.value; state.open = true; render(); });
        input.addEventListener('focus', function () { clearTimeout(closeTimer); setOpen(true); });
        input.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') { setOpen(false); }
            else if (e.key === 'ArrowDown') { e.preventDefault(); if (!state.open) setOpen(true); var o = options(); if (o[0]) o[0].focus(); }
            else if (e.key === 'Enter') { e.preventDefault(); setOpen(false); input.blur(); toResults(); }
        });
        list.addEventListener('keydown', function (e) {
            var o = options(), i = o.indexOf(document.activeElement);
            if (e.key === 'ArrowDown') { e.preventDefault(); if (o[i + 1]) o[i + 1].focus(); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); if (i > 0) o[i - 1].focus(); else input.focus(); }
            else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); input.focus(); }
        });
        /* Close when focus leaves the whole combobox, not when it moves from
           the input into the list, so keyboard users can reach the options. */
        combo.addEventListener('focusin', function () { clearTimeout(closeTimer); });
        combo.addEventListener('focusout', function (e) {
            if (!combo.contains(e.relatedTarget)) closeTimer = setTimeout(function () { setOpen(false); }, 160);
        });
        chev.addEventListener('click', function () { clearTimeout(closeTimer); setOpen(!state.open); });
        pills.forEach(function (c) {
            c.addEventListener('click', function () { state.svc = c.getAttribute('data-service'); render(); });
        });
        var find = $('[data-find]');
        find.addEventListener('click', function (e) { e.preventDefault(); setOpen(false); toResults(); });
        clear.addEventListener('click', function () { state.q = ''; input.value = ''; render(); });

        render();
    }

    /* ---------- estimate form ---------- */
    var form = document.querySelector('[data-estimate]');
    if (!form) return;

    var walkOnly = form.querySelector('[data-walk-only]');
    var errorEl = form.querySelector('[data-error]');
    var doneEl = form.querySelector('[data-done]');
    var submit = form.querySelector('button[type="submit"]');

    /* One reference per page view. A retry after a timeout sends the same one,
       and the Worker hands back the request it already saved. */
    var ref = form.querySelector('input[name="client_ref"]');
    if (ref && !ref.value) {
        ref.value = 'r-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    }
    var src = form.querySelector('input[name="source"]');
    if (src) {
        var params = new URLSearchParams(location.search);
        src.value = params.get('utm_source') || params.get('src') || '';
    }

    function method() {
        var picked = form.querySelector('input[name="method"]:checked');
        return picked ? picked.value : '';
    }
    function syncMethod() {
        if (walkOnly) walkOnly.hidden = method() !== 'walkthrough';
    }
    form.querySelectorAll('input[name="method"]').forEach(function (r) {
        r.addEventListener('change', syncMethod);
    });
    syncMethod();

    form.addEventListener('submit', function (e) {
        e.preventDefault();
        errorEl.textContent = '';
        var data = {};
        new FormData(form).forEach(function (v, k) { data[k] = v; });
        if (method() !== 'walkthrough') delete data.address;
        submit.disabled = true;
        submit.textContent = 'Sending…';
        fetch('/api/estimate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify(data)
        }).then(function (res) {
            return res.json().catch(function () { return { ok: false }; });
        }).then(function (reply) {
            if (reply && reply.ok) {
                Array.prototype.forEach.call(form.children, function (el) {
                    if (el !== doneEl && el.tagName !== 'H2') el.hidden = true;
                });
                doneEl.hidden = false;
                return;
            }
            errorEl.textContent = (reply && reply.message) || 'That didn’t go through. Try again in a minute.';
            submit.disabled = false;
            submit.textContent = 'Request Estimate';
        }).catch(function () {
            errorEl.textContent = 'No connection. Check your signal and try again — your request won’t be sent twice.';
            submit.disabled = false;
            submit.textContent = 'Request Estimate';
        });
    });
})();
