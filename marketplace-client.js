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
    var nearEl = document.querySelector('[data-near]');
    /* region is 'all' or a list of region keys (a town on a border has two) */
    var state = { region: 'all', tag: 'all' };

    function applyFilters() {
        var shown = 0;
        cards.forEach(function (card) {
            var regions = (card.getAttribute('data-regions') || '').split(' ');
            var tags = (card.getAttribute('data-tags') || '').split('|');
            var inRegion = state.region === 'all' || state.region.some(function (r) {
                return regions.indexOf(r) !== -1;
            });
            var ok = inRegion && (state.tag === 'all' || tags.indexOf(state.tag) !== -1);
            card.hidden = !ok;
            if (ok) shown++;
        });
        if (countEl) countEl.textContent = String(shown);
        if (emptyEl) emptyEl.hidden = shown !== 0 || cards.length === 0;
    }

    function pressChips(name, value) {
        chips.forEach(function (c) {
            if (c.getAttribute('data-filter') === name) {
                c.setAttribute('aria-pressed', String(c.getAttribute('data-value') === value));
            }
        });
    }

    function showNear(text) {
        if (!nearEl) return;
        nearEl.textContent = text;
        nearEl.hidden = !text;
    }

    chips.forEach(function (chip) {
        chip.addEventListener('click', function () {
            var name = chip.getAttribute('data-filter');
            var value = chip.getAttribute('data-value');
            state[name] = name === 'region' && value !== 'all' ? [value] : value;
            pressChips(name, value);
            if (name === 'region') showNear('');
            applyFilters();
        });
    });

    /* ---------- "Neighborhood or ZIP" search ----------
       Turns what the visitor typed into one of the four area keys
       (REGIONS in src/marketplace.js) and filters by it. Nothing is sent
       anywhere: the input has no name, so even a no-script submit just
       reloads /providers with nothing in the URL. */
    var ZIP_RANGES = [
        [2026, 2026, ['south', 'west']],   // Dedham
        [2090, 2090, ['south', 'west']],   // Westwood
        [2420, 2421, ['north', 'west']],   // Lexington
        [2445, 2447, ['core']],            // Brookline
        [2474, 2476, ['north']],           // Arlington
        [2108, 2147, ['core']],            // Boston, Cambridge, Somerville
        [2148, 2156, ['north']],           // Malden, Everett, Chelsea, Revere, Winthrop, Medford
        [2163, 2163, ['core']],
        [2169, 2171, ['south']],           // Quincy
        [2176, 2180, ['north']],           // Melrose, Stoneham
        [2184, 2191, ['south']],           // Braintree, Milton, Weymouth
        [2196, 2299, ['core']],            // Boston
        [2018, 2099, ['south']],           // Norfolk and Plymouth County towns
        [2300, 2399, ['south']],           // Brockton and the South Shore
        [2400, 2499, ['west']],            // Newton, Waltham, Watertown, Belmont, Needham, Wellesley
        [1800, 1999, ['north']],           // Woburn, Reading, Lynn, Salem, Peabody
        [1700, 1799, ['west']]             // Natick, Framingham, Sudbury, Concord
    ];
    var PLACES = {
        core: 'boston,back bay,beacon hill,south end,north end,west end,downtown,financial district,seaport,' +
              'south boston,southie,east boston,eastie,charlestown,fenway,kenmore,mission hill,jamaica plain,jp,' +
              'roxbury,dorchester,mattapan,roslindale,west roxbury,hyde park,allston,brighton,chinatown,' +
              'bay village,leather district,cambridge,harvard square,central square,kendall square,kendall,' +
              'inman square,porter square,somerville,davis square,union square,brookline,coolidge corner',
        north: 'medford,malden,everett,chelsea,revere,winthrop,melrose,arlington,lynn,saugus,woburn,stoneham,' +
               'wakefield,reading,north reading,winchester,burlington,wilmington,peabody,salem,swampscott,' +
               'marblehead,danvers,beverly,lynnfield,lexington',
        west: 'newton,newton centre,newton center,chestnut hill,watertown,waltham,belmont,needham,wellesley,' +
              'weston,natick,framingham,concord,sudbury,wayland,lincoln,lexington,dedham,westwood',
        south: 'quincy,braintree,milton,weymouth,hingham,hull,cohasset,scituate,marshfield,norwell,hanover,' +
               'rockland,abington,randolph,holbrook,canton,sharon,norwood,duxbury,kingston,plymouth,pembroke,' +
               'brockton,stoughton,easton,dedham,westwood'
    };
    var placeIndex = {};
    Object.keys(PLACES).forEach(function (region) {
        PLACES[region].split(',').forEach(function (place) {
            (placeIndex[place] = placeIndex[place] || []).push(region);
        });
    });
    var placeNames = Object.keys(placeIndex).sort(function (a, b) { return b.length - a.length; });

    function regionsFor(text) {
        var zip = text.match(/\b0?(\d{4})\b|\b(\d{5})\b/);
        if (zip) {
            var n = parseInt(zip[1] || zip[2], 10);
            for (var i = 0; i < ZIP_RANGES.length; i++) {
                if (n >= ZIP_RANGES[i][0] && n <= ZIP_RANGES[i][1]) return ZIP_RANGES[i][2];
            }
            return null;
        }
        var words = ' ' + text.toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
        for (var j = 0; j < placeNames.length; j++) {
            if (words.indexOf(' ' + placeNames[j] + ' ') !== -1) return placeIndex[placeNames[j]];
        }
        return null;
    }

    var findForm = document.querySelector('[data-find]');
    var listTop = document.getElementById('providers');
    if (findForm) {
        findForm.addEventListener('submit', function (e) {
            e.preventDefault();
            var input = findForm.querySelector('input');
            var typed = input.value.trim();
            var found = typed ? regionsFor(typed) : null;
            state.region = found || 'all';
            pressChips('region', found && found.length === 1 ? found[0] : (found ? '' : 'all'));
            showNear(!typed ? '' : found ? ' near ' + typed
                : ' — we don’t have “' + typed + '” mapped yet, so here’s everyone');
            applyFilters();
            input.blur();   // drops the phone keyboard so the results are visible
            if (listTop) listTop.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
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
