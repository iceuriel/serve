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

    /* ---------- directory filters ---------- */
    var cards = Array.prototype.slice.call(document.querySelectorAll('.mk-card'));
    var chips = Array.prototype.slice.call(document.querySelectorAll('.mk-chip'));
    var countEl = document.querySelector('[data-count]');
    var emptyEl = document.querySelector('[data-empty]');
    var state = { region: 'all', tag: 'all' };

    function applyFilters() {
        var shown = 0;
        cards.forEach(function (card) {
            var regions = (card.getAttribute('data-regions') || '').split(' ');
            var tags = (card.getAttribute('data-tags') || '').split('|');
            var ok = (state.region === 'all' || regions.indexOf(state.region) !== -1) &&
                     (state.tag === 'all' || tags.indexOf(state.tag) !== -1);
            card.hidden = !ok;
            if (ok) shown++;
        });
        if (countEl) countEl.textContent = String(shown);
        if (emptyEl) emptyEl.hidden = shown !== 0 || cards.length === 0;
    }

    chips.forEach(function (chip) {
        chip.addEventListener('click', function () {
            var name = chip.getAttribute('data-filter');
            state[name] = chip.getAttribute('data-value');
            chips.forEach(function (c) {
                if (c.getAttribute('data-filter') === name) c.setAttribute('aria-pressed', String(c === chip));
            });
            applyFilters();
        });
    });

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
