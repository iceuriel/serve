/* ============================================================
   SERVE CLEANING — Main Script
   Vanilla JS only. No frameworks or dependencies.
   ============================================================ */


/* --- Mobile Nav Toggle --- */
(function () {
    const hamburger = document.querySelector('.nav__hamburger');
    const mobileMenu = document.getElementById('mobile-menu');

    if (!hamburger || !mobileMenu) return;

    hamburger.addEventListener('click', function () {
        const isOpen = mobileMenu.classList.toggle('open');
        hamburger.setAttribute('aria-expanded', String(isOpen));
    });

    mobileMenu.querySelectorAll('a').forEach(function (link) {
        link.addEventListener('click', function () {
            mobileMenu.classList.remove('open');
            hamburger.setAttribute('aria-expanded', 'false');
        });
    });
})();


/* ============================================================
   Serve Pricing Engine  (spec §3 — deterministic)
   Edit PRICING and ZIP_TIERS to adjust rates / coverage.
   ============================================================ */
const PRICING = {
    BASE: 150,
    PER_BEDROOM: 33,
    PER_BATHROOM: 66,

    DEEP_MULT: 1.4,
    DEEP_MULT_SMALL: 1.2,        // bedrooms <= 1 (studio or 1BR)
    MOVEOUT_MULT: 2.0,
    MOVEOUT_MULT_SMALL: 1.8,     // bedrooms <= 1

    FIRST_CLEAN_FACTOR: 0.5,     // first clean = deep price x 0.5

    FREQ: { weekly: 0.39, biweekly: 0.43, monthly: 0.50 },  // x standard, condition 1.0

    CONDITION: { light: 0.9, standard: 1.0, heavy: 1.3 },

    ADDONS: { fridge: 45, oven: 40 },   // First Clean only; Move-Out includes them

    EXTENDED_ZIP_FEE: 25,        // per visit, all service types incl. recurring display
    OVERFLOW_BEDROOMS: 5,        // >= 5 bedrooms -> custom quote state
    NOSTACK_BEDROOMS: 4,         // >= 4 + heavy + first clean -> no 50% discount
    OVERFLOW_HOURLY_RATE: 130,   // copy only, never computed
};

// Service-area coverage. To change coverage, edit these two lists.
const ZIP_TIERS = {
    CORE: ["02108","02109","02110","02111","02113","02114","02115","02116",
           "02118","02119","02120","02121","02122","02124","02125","02126",
           "02127","02128","02129","02130","02131","02132","02134","02135",
           "02138","02139","02140","02141","02142","02143","02144","02145",
           "02445","02446","02467"],          // Boston core + Cambridge / Somerville / Brookline
    EXTENDED: ["02150","02151","02152","02149","02155","02148","02472","02474",
               "02476","02458","02459","02460","02461","02462","02464","02465",
               "02466","02468"],              // +$25 ring (Chelsea / Revere / Newton / Watertown)
};

function zipTier(zip) {
    if (ZIP_TIERS.CORE.includes(zip))     return 'core';
    if (ZIP_TIERS.EXTENDED.includes(zip)) return 'extended';
    return 'unknown';
}

/**
 * Deterministic quote per spec §3.2 / §3.3. All price fields returned RAW
 * (un-rounded); apply Math.ceil at display (R11). `frequency` is 'once' or a
 * FREQ key and only affects `steadySelected`, never the one-time price.
 */
function computeQuote(input) {
    const { bedrooms, bathrooms, service, condition, addonFridge, addonOven, zip, frequency } = input;

    const tier   = zipTier(zip);
    const zipFee = tier === 'extended' ? PRICING.EXTENDED_ZIP_FEE : 0;      // R8

    // R1 — base formula
    const standard = PRICING.BASE + PRICING.PER_BEDROOM * bedrooms + PRICING.PER_BATHROOM * bathrooms;

    // R2 — small-unit multipliers
    const smallUnit = bedrooms <= 1;
    const deepMult  = smallUnit ? PRICING.DEEP_MULT_SMALL : PRICING.DEEP_MULT;
    const moveMult  = smallUnit ? PRICING.MOVEOUT_MULT_SMALL : PRICING.MOVEOUT_MULT;

    // R3 — condition applies to one-time services only
    const condFactor   = PRICING.CONDITION[condition] != null ? PRICING.CONDITION[condition] : 1.0;
    const condAdjusted = standard * condFactor;

    const deepPrice    = condAdjusted * deepMult;
    const moveOutPrice = condAdjusted * moveMult;

    // R5 — 4BR+ no-stack rule (heavy + first clean): full deep price, no 50% off
    const noStack = bedrooms >= PRICING.NOSTACK_BEDROOMS && condition === 'heavy' && service === 'first_clean';

    // R6 — add-ons are First Clean only
    let addons = 0;
    if (service === 'first_clean') {
        if (addonFridge) addons += PRICING.ADDONS.fridge;
        if (addonOven)   addons += PRICING.ADDONS.oven;
    }

    let oneTime, deepAnchor = null, discountApplies = false;
    if (service === 'move_out') {
        oneTime = moveOutPrice + zipFee;
    } else {
        if (noStack) {
            oneTime = deepPrice + addons + zipFee;             // full deep price, no anchor
        } else {
            deepAnchor = deepPrice;                            // R4 — struck-through anchor
            discountApplies = true;
            oneTime = deepPrice * PRICING.FIRST_CLEAN_FACTOR + addons + zipFee;
        }
    }

    // R3 / R7 — recurring steady-state ALWAYS at condition 1.0, + zipFee
    const freqSteady = {};
    Object.keys(PRICING.FREQ).forEach(f => {
        freqSteady[f] = Math.ceil(standard * PRICING.FREQ[f] + zipFee);
    });

    const steadySelected = (service === 'first_clean' && frequency && frequency !== 'once' && PRICING.FREQ[frequency] != null)
        ? freqSteady[frequency]
        : null;

    return {
        tier, zipFee, standard, smallUnit, noStack, discountApplies, addons,
        displayPrice: Math.ceil(oneTime),                       // R11 — whole dollars, round up
        deepAnchorDisplay: deepAnchor != null ? Math.ceil(deepAnchor) : null,
        freqSteady, steadySelected,
    };
}


/* ============================================================
   Booking Flow — Build -> Price -> Reserve
   ============================================================ */
(function () {
    const SHEETS_URL = 'https://script.google.com/macros/s/AKfycbwaMIS1nklX2rWuCEa9koeTyuAFt-UdGAZ1mqY98Z5IOHz0i5HgaugH0j5j2Nf-XUGB/exec';
    const AVAIL_URL  = 'https://script.google.com/macros/s/AKfycbxx_iQ1x71D8FN-pDNwna34KE2YjNrpL7UDUwGlcW54MA_HQzfcGAK_8f6H6Gi5pzY/exec';

    const $ = (id) => document.getElementById(id);

    const stepEls = {
        1:          $('step-1'),
        2:          $('step-2'),
        3:          $('step-3'),
        overflow:   $('state-overflow'),
        confirmed:  $('state-confirmed'),
    };
    if (!stepEls[1] || !stepEls[2] || !stepEls[3]) return;

    const progressEl = $('flow-progress');

    /* --- Content lists (spec §5, Step 2 accordion) --- */
    const INCLUDED_FIRST = [
        'Dusting &amp; wiping all accessible surfaces and walls',
        'Vacuum + mop all floors — including under and behind furniture',
        'Blinds',
        'Full bathroom scrub — sink, toilet, tub/shower, mirror',
        'Kitchen — counters, sink, stovetop, appliance exteriors, cabinet fronts',
        'Doors, frames, light switches and outlet covers',
        'Detailed hand-scrubbing of built-up grime',
    ];
    const INCLUDED_MOVEOUT_EXTRA = [
        'Windows and sills',
        'Inside cabinets',
        'Baseboards',
        'Appliance interiors',
    ];

    /* --- State --- */
    const state = {
        zip: '',
        tier: 'unknown',
        bedrooms: 2,
        bathrooms: 1,
        service: 'first_clean',
        condition: 'standard',
        addonFridge: false,
        addonOven: false,
        frequency: 'once',
        timePreference: null,
        slotDate: null,
        slotTime: null,
        quote: null,
        attribution: readAttribution(),
    };

    /* --- Attribution (src / UTM) — read once, persist across steps --- */
    function readAttribution() {
        let saved = {};
        try { saved = JSON.parse(sessionStorage.getItem('serve_attr') || '{}'); } catch (_) {}
        const params = new URLSearchParams(location.search);
        const keys = ['src', 'utm_source', 'utm_medium', 'utm_campaign'];
        const attr = {};
        keys.forEach(k => { attr[k] = params.get(k) || saved[k] || null; });
        try { sessionStorage.setItem('serve_attr', JSON.stringify(attr)); } catch (_) {}
        return attr;
    }

    /* --- Sheets POST (fire-and-forget, never blocks UX) --- */
    function postToSheets(payload) {
        try {
            fetch(SHEETS_URL, {
                method: 'POST',
                mode: 'no-cors',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            }).catch(() => {});
        } catch (_) { /* silent */ }
    }

    /* --- Payload builder: legacy fields (keep Apps Script working) + §6 additions --- */
    function basePayload(eventType, legacyEvent) {
        const now = new Date().toISOString();
        const a = state.attribution;
        const q = state.quote;
        return {
            // legacy fields the existing Apps Script reads
            event:      legacyEvent,
            timestamp:  now,
            // §6 additive schema
            event_type:         eventType,
            zip:                state.zip,
            zip_tier:           state.tier,
            bedrooms:           state.bedrooms,
            bathrooms:          state.bathrooms,
            service:            state.service,
            condition:          state.condition,
            addon_fridge:       state.addonFridge,
            addon_oven:         state.addonOven,
            frequency_selected: state.frequency,
            quote_price:        q ? q.displayPrice : null,
            steady_state_price: q ? q.steadySelected : null,
            time_preference:    state.timePreference,
            utm_source:         a.utm_source,
            utm_medium:         a.utm_medium,
            utm_campaign:       a.utm_campaign,
            src:                a.src,
            page_path:          location.pathname,
            submitted_at:       now,
        };
    }

    function bedroomsLabel(n) {
        if (n === 0) return 'Studio';
        if (n >= PRICING.OVERFLOW_BEDROOMS) return n + '+ BR';
        return n + ' BR';
    }
    function unitLabel() {
        return bedroomsLabel(state.bedrooms) + ' / ' + state.bathrooms + ' BA';
    }
    function addonLabels() {
        const list = [];
        if (state.service === 'first_clean') {
            if (state.addonFridge) list.push('Inside the fridge');
            if (state.addonOven)   list.push('Inside the oven');
        }
        return list;
    }
    function timePrefLabel() {
        if (state.timePreference === 'earlier') return 'Earlier in the Day';
        if (state.timePreference === 'later')   return 'Later in the Day';
        return '';
    }

    /* --- View / progress navigation --- */
    function setView(key) {
        Object.values(stepEls).forEach(el => {
            if (!el) return;
            el.classList.remove('step-active');
            el.classList.add('step-hidden');
        });
        const el = stepEls[key];
        if (el) {
            el.classList.add('step-active');
            el.classList.remove('step-hidden');
            updateProgress(parseInt(el.getAttribute('data-progress'), 10) || 1);
        }
        const anchor = $('quote');
        if (anchor) anchor.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function updateProgress(n) {
        if (!progressEl) return;
        progressEl.querySelectorAll('.flow-progress__step').forEach(step => {
            const p = parseInt(step.getAttribute('data-progress'), 10);
            step.classList.toggle('is-active', p === n);
            step.classList.toggle('is-done', p < n);
        });
    }

    /* ========================================================
       STEP 1 — Build
       ======================================================== */
    const buildForm    = $('build-form');
    const zipInput     = $('zip');
    const zipStatus    = $('zip-status');
    const buildError   = $('build-error');
    const buildSubmit  = $('build-submit');
    const zipWaitlist  = $('zip-waitlist');
    const waitlistCopy = $('waitlist-copy');

    /* Steppers */
    function initStepper(elId, valueId, onChange) {
        const el = $(elId);
        const valEl = $(valueId);
        if (!el) return;
        const min = parseInt(el.getAttribute('data-min'), 10);
        const max = parseInt(el.getAttribute('data-max'), 10);

        function render() {
            const v = parseInt(el.getAttribute('data-value'), 10);
            valEl.textContent = (elId === 'stepper-bedrooms') ? bedroomsLabel(v).replace(' BR', '') : String(v);
            el.querySelector('[data-dir="-1"]').disabled = v <= min;
            el.querySelector('[data-dir="1"]').disabled  = v >= max;
        }
        el.querySelectorAll('.stepper__btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const dir = parseInt(btn.getAttribute('data-dir'), 10);
                let v = parseInt(el.getAttribute('data-value'), 10) + dir;
                v = Math.max(min, Math.min(max, v));
                el.setAttribute('data-value', String(v));
                render();
                onChange(v);
            });
        });
        render();
        onChange(parseInt(el.getAttribute('data-value'), 10));
    }

    initStepper('stepper-bedrooms', 'bedrooms-value', v => { state.bedrooms = v; });
    initStepper('stepper-bathrooms', 'bathrooms-value', v => { state.bathrooms = v; });

    /* Service + condition radios */
    buildForm.querySelectorAll('input[name="service"]').forEach(r => {
        r.addEventListener('change', () => { if (r.checked) state.service = r.value; });
    });
    buildForm.querySelectorAll('input[name="condition"]').forEach(r => {
        r.addEventListener('change', () => { if (r.checked) state.condition = r.value; });
    });

    /* ZIP validation — coverage confirmation / waitlist swap (R10) */
    function evaluateZip() {
        const zip = (zipInput.value || '').trim();
        state.zip = zip;

        if (zip.length < 5) {
            zipStatus.textContent = '';
            zipStatus.className = 'zip-status';
            showWaitlist(false);
            return;
        }

        state.tier = zipTier(zip);
        if (state.tier === 'unknown') {
            zipStatus.textContent = '';
            zipStatus.className = 'zip-status';
            waitlistCopy.textContent = "We're not in " + zip + " yet — leave your email and you're first in line when we are.";
            showWaitlist(true);
        } else {
            zipStatus.textContent = '✓ We serve ' + zip;
            zipStatus.className = 'zip-status is-ok';
            showWaitlist(false);
        }
    }

    function showWaitlist(show) {
        if (!zipWaitlist) return;
        zipWaitlist.hidden = !show;
        buildSubmit.hidden = show;
    }

    zipInput.addEventListener('input', () => {
        zipInput.value = zipInput.value.replace(/\D/g, '').slice(0, 5);
        buildError.textContent = '';
        evaluateZip();
    });

    /* Waitlist submit (R10) */
    $('waitlist-submit').addEventListener('click', () => {
        const emailEl = $('waitlist-email');
        if (!isEmail(emailEl.value)) { emailEl.classList.add('error'); emailEl.focus(); return; }
        emailEl.classList.remove('error');
        const p = basePayload('waitlist_zip', 'waitlist_zip');
        p.email = emailEl.value.trim();
        postToSheets(p);
        $('waitlist-done').hidden = false;
        emailEl.disabled = true;
        $('waitlist-submit').disabled = true;
    });

    /* Step 1 submit */
    buildForm.addEventListener('submit', (e) => {
        e.preventDefault();
        buildError.textContent = '';

        if (state.zip.length < 5 || state.tier === 'unknown') {
            buildError.textContent = 'Enter a ZIP code in our service area to see pricing.';
            zipInput.focus();
            return;
        }

        // R9 — overflow (5+ bedrooms)
        if (state.bedrooms >= PRICING.OVERFLOW_BEDROOMS) {
            setView('overflow');
            return;
        }

        recompute();
        renderPrice();
        setView(2);
        prefetchAvailability();   // warm the Step 3 scheduler — fetches once per session
    });

    /* ========================================================
       STEP 2 — Price
       ======================================================== */
    const priceCard   = $('price-card');
    const addonBlock  = $('addon-block');
    const freqBlock   = $('freq-block');
    const freqOptions = $('freq-options');
    const includedBody = $('included-body');
    const addonFridge = $('addon-fridge');
    const addonOven   = $('addon-oven');

    const FREQ_META = [
        { key: 'once',     name: 'Just once' },
        { key: 'weekly',   name: 'Weekly' },
        { key: 'biweekly', name: 'Biweekly' },
        { key: 'monthly',  name: 'Monthly' },
    ];

    function recompute() {
        state.quote = computeQuote({
            bedrooms:    state.bedrooms,
            bathrooms:   state.bathrooms,
            service:     state.service,
            condition:   state.condition,
            addonFridge: state.addonFridge,
            addonOven:   state.addonOven,
            zip:         state.zip,
            frequency:   state.frequency,
        });
    }

    function renderPrice() {
        const q = state.quote;
        if (!q) return;
        const isFirst = state.service === 'first_clean';

        // --- Price block ---
        let html = '';
        if (isFirst && q.discountApplies) {
            html = `
                <div class="price-badge">First clean — 50% off</div>
                <div class="price-strike">$${q.deepAnchorDisplay}</div>
                <div class="price-main" id="price-main">$${q.displayPrice}</div>
                <div class="price-caption">Your first-visit price — for first-time customers.</div>`;
        } else if (isFirst && q.noStack) {
            html = `
                <div class="price-badge">First clean</div>
                <div class="price-main" id="price-main">$${q.displayPrice}</div>
                <div class="price-caption">Your first-visit price — for first-time customers.</div>
                <p class="price-note">For larger homes needing heavy-duty attention, the first-visit discount doesn't apply — you'll get $50 off visits 2&ndash;4 on a recurring plan instead.</p>`;
        } else {
            html = `
                <div class="price-badge">Move In / Move Out</div>
                <div class="price-main" id="price-main">$${q.displayPrice}</div>
                <div class="price-caption">Your all-in move clean.</div>`;
        }
        priceCard.innerHTML = html;

        // --- Add-ons (First Clean only) ---
        addonBlock.hidden = !isFirst;

        // --- Frequency (First Clean only) ---
        freqBlock.hidden = !isFirst;
        if (isFirst) renderFreq();

        // --- What's included ---
        const items = isFirst ? INCLUDED_FIRST : INCLUDED_FIRST.concat(INCLUDED_MOVEOUT_EXTRA);
        includedBody.innerHTML = '<ul>' + items.map(i => '<li>' + i + '</li>').join('') + '</ul>';
    }

    function renderFreq() {
        const q = state.quote;
        freqOptions.innerHTML = FREQ_META.map(f => {
            const price = f.key === 'once' ? '' : `<span class="freq-chip__price">$${q.freqSteady[f.key]}/visit</span>`;
            const checked = state.frequency === f.key ? 'checked' : '';
            return `
                <label class="freq-chip">
                    <input type="radio" name="frequency" value="${f.key}" ${checked}>
                    <span class="freq-chip__body">
                        <span class="freq-chip__name">${f.name}</span>
                        ${price || '<span class="freq-chip__price">first visit only</span>'}
                    </span>
                </label>`;
        }).join('');

        freqOptions.querySelectorAll('input[name="frequency"]').forEach(r => {
            r.addEventListener('change', () => {
                if (!r.checked) return;
                state.frequency = r.value;
                recompute();       // updates steadySelected for the payload
            });
        });
    }

    /* Live add-on toggles (R6) */
    function onAddonChange() {
        state.addonFridge = addonFridge.checked;
        state.addonOven   = addonOven.checked;
        recompute();
        const mainEl = $('price-main');
        if (mainEl && state.quote) mainEl.textContent = '$' + state.quote.displayPrice;
    }
    addonFridge.addEventListener('change', onAddonChange);
    addonOven.addEventListener('change', onAddonChange);

    $('back-to-1').addEventListener('click', () => setView(1));
    $('to-reserve').addEventListener('click', () => setView(3));

    /* Ghost email capture (spec §5, Step 2) */
    const emailQuoteTrigger = $('email-quote-trigger');
    const emailQuoteForm    = $('email-quote-form');
    emailQuoteTrigger.addEventListener('click', () => {
        emailQuoteForm.hidden = !emailQuoteForm.hidden;
        if (!emailQuoteForm.hidden) $('email-quote-input').focus();
    });
    $('email-quote-send').addEventListener('click', () => {
        const emailEl = $('email-quote-input');
        if (!isEmail(emailEl.value)) { emailEl.classList.add('error'); emailEl.focus(); return; }
        emailEl.classList.remove('error');
        const p = basePayload('quote_emailed', 'quote_emailed');
        p.email = emailEl.value.trim();
        // legacy pricing fields so the row is readable server-side
        p.unit_label = unitLabel();
        p.service_type = state.service;
        p.first_visit_total = state.quote ? state.quote.displayPrice : '';
        postToSheets(p);
        $('email-quote-done').hidden = false;
        emailEl.disabled = true;
        $('email-quote-send').disabled = true;
    });

    /* ========================================================
       STEP 3 — Live availability scheduler (open agenda)
       Fed by AVAIL_URL. If the endpoint is down, slow, or has no
       open slots, the original time-preference radios stay live.
       ======================================================== */
    const HORIZON_DAYS = 21;

    let availSlots  = null;        // session cache of bookable slots
    let availFetched = false;
    let timeUi = 'fallback';       // 'fallback' | 'loading' | 'scheduler'

    function prefetchAvailability() {
        if (availFetched) return;
        availFetched = true;
        setTimeUi('loading');
        fetch(AVAIL_URL)
            .then(res => {
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.json();
            })
            .then(data => {
                if (!data || data.ok !== true || !Array.isArray(data.slots)) {
                    throw new Error('Unexpected availability response');
                }
                availSlots = filterSlots(data.slots);
                if (availSlots.length) {
                    renderSchedulerDays(availSlots);
                    if (timeUi === 'loading') setTimeUi('scheduler');
                } else if (timeUi === 'loading') {
                    setTimeUi('fallback');
                }
            })
            .catch(err => {
                console.warn('Availability unavailable — keeping time-preference fallback.', err);
                if (timeUi === 'loading') setTimeUi('fallback');
            });
    }

    /* Bookable = open > 0, today through the three-week horizon */
    function filterSlots(slots) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const horizon = new Date(today);
        horizon.setDate(horizon.getDate() + HORIZON_DAYS);
        return slots.filter(s => {
            if (!s || !s.date || !s.time || !(s.open > 0)) return false;
            const d = parseSlotDate(s.date);
            return isFinite(d.getTime()) && d >= today && d <= horizon;
        });
    }

    /* "2026-07-25" -> local Date (avoids the UTC-midnight off-by-one) */
    function parseSlotDate(str) {
        const p = String(str).split('-');
        return new Date(+p[0], +p[1] - 1, +p[2]);
    }

    function formatSlotDate(str) {
        return parseSlotDate(str).toLocaleDateString('en-US', {
            weekday: 'long', month: 'short', day: 'numeric',
        });
    }

    function slotLabel() {
        return formatSlotDate(state.slotDate) + ' at ' + state.slotTime;
    }

    /* Swap which time control is live: scheduler vs. the radios */
    function setTimeUi(mode) {
        timeUi = mode;
        $('scheduler-block').hidden    = mode === 'fallback';
        $('timepref-block').hidden     = mode !== 'fallback';
        $('scheduler-loading').hidden  = mode !== 'loading';
        $('scheduler-fallback').hidden = mode !== 'scheduler';
    }

    /* Build the agenda: one section per day, one chip per open time */
    function renderSchedulerDays(slots) {
        const container = $('scheduler-days');
        container.innerHTML = '';
        let currentDate = null, rowEl = null;
        slots.forEach(s => {
            if (s.date !== currentDate) {
                currentDate = s.date;
                const day  = document.createElement('div');
                day.className = 'scheduler-day';
                const head = document.createElement('div');
                head.className = 'scheduler-day__head';
                head.textContent = formatSlotDate(s.date);
                rowEl = document.createElement('div');
                rowEl.className = 'scheduler-day__times';
                day.appendChild(head);
                day.appendChild(rowEl);
                container.appendChild(day);
            }
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'slot-chip';
            chip.textContent = s.time;
            chip.setAttribute('data-date', s.date);
            chip.setAttribute('data-time', s.time);
            chip.setAttribute('aria-pressed', 'false');
            rowEl.appendChild(chip);
        });
    }

    function clearSlotSelection() {
        state.slotDate = null;
        state.slotTime = null;
        document.querySelectorAll('.slot-chip.is-selected').forEach(c => {
            c.classList.remove('is-selected');
            c.setAttribute('aria-pressed', 'false');
        });
    }

    $('scheduler-days').addEventListener('click', (e) => {
        const chip = e.target.closest('.slot-chip');
        if (!chip) return;
        clearSlotSelection();
        chip.classList.add('is-selected');
        chip.setAttribute('aria-pressed', 'true');
        state.slotDate = chip.getAttribute('data-date');
        state.slotTime = chip.getAttribute('data-time');
        reserveError.textContent = '';
    });

    $('scheduler-fallback-link').addEventListener('click', () => {
        clearSlotSelection();
        reserveError.textContent = '';
        setTimeUi('fallback');
    });

    /* ========================================================
       STEP 3 — Reserve
       ======================================================== */
    const reserveForm  = $('reserve-form');
    const reserveError = $('reserve-error');
    const reserveSubmit = $('reserve-submit');

    reserveForm.querySelectorAll('input[name="time_preference"]').forEach(r => {
        r.addEventListener('change', () => { if (r.checked) state.timePreference = r.value; });
    });

    $('back-to-2').addEventListener('click', () => setView(2));

    reserveForm.addEventListener('submit', (e) => {
        e.preventDefault();
        reserveError.textContent = '';
        reserveForm.querySelectorAll('.error').forEach(el => el.classList.remove('error'));

        let valid = true, firstBad = null;
        if (timeUi !== 'fallback') {
            if (!state.slotDate || !state.slotTime) {
                reserveError.textContent = 'Pick a day and time to continue.';
                return;
            }
        } else if (!state.timePreference) {
            reserveError.textContent = 'Pick a time preference to continue.';
            return;
        }
        ['r-name', 'r-email', 'r-phone', 'r-address'].forEach(id => {
            const el = $(id);
            if (!el.value.trim()) { el.classList.add('error'); valid = false; firstBad = firstBad || el; }
        });
        const emailEl = $('r-email');
        if (emailEl.value.trim() && !isEmail(emailEl.value)) {
            emailEl.classList.add('error'); valid = false; firstBad = firstBad || emailEl;
        }
        if (!valid) {
            reserveError.textContent = 'Please fill out all required fields.';
            if (firstBad) firstBad.focus();
            return;
        }

        reserveSubmit.disabled = true;
        reserveSubmit.textContent = 'Reserving…';

        recompute();
        const q = state.quote;
        const p = basePayload('reservation', 'quote_reserved');
        // identity (only on reservation)
        p.name    = $('r-name').value.trim();
        p.email   = $('r-email').value.trim();
        p.phone   = $('r-phone').value.trim();
        p.address = $('r-address').value.trim();
        p.unit    = $('r-unit').value.trim();
        // legacy pricing fields so existing Sheet columns + email keep populating
        p.unit_label        = unitLabel();
        p.service_type      = state.service;
        p.modifiers_applied = addonLabels();
        p.original_price    = q.deepAnchorDisplay != null ? q.deepAnchorDisplay : q.displayPrice;
        p.discount_applied  = (state.service === 'first_clean' && q.discountApplies) ? 'First clean 50% off' : 'None';
        p.first_visit_total = q.displayPrice;
        p.recurring_weekly   = state.service === 'first_clean' ? q.freqSteady.weekly   : '';
        p.recurring_biweekly = state.service === 'first_clean' ? q.freqSteady.biweekly : '';
        p.recurring_monthly  = state.service === 'first_clean' ? q.freqSteady.monthly  : '';
        p.schedule_preference       = state.timePreference;
        p.schedule_preference_label = timePrefLabel();
        // scheduler slot — null when the fallback radios were used
        p.slot_date = state.slotDate || null;
        p.slot_time = state.slotTime || null;
        if (p.slot_date && p.slot_time) {
            // existing Schedule Preference column + notification email pick this up
            p.schedule_preference_label = slotLabel();
        }

        const confirmCopy = $('confirm-copy');
        if (confirmCopy) {
            confirmCopy.textContent = (p.slot_date && p.slot_time)
                ? "You're on the schedule for " + slotLabel() + ". We'll reach out shortly to confirm your exact arrival window."
                : "We'll reach out shortly to confirm your exact arrival window.";
        }

        postToSheets(p);
        setView('confirmed');
    });

    /* ========================================================
       Overflow state — custom quote request (R9)
       ======================================================== */
    $('overflow-back').addEventListener('click', () => setView(1));
    $('overflow-submit').addEventListener('click', () => {
        const emailEl = $('overflow-email');
        if (!isEmail(emailEl.value)) { emailEl.classList.add('error'); emailEl.focus(); return; }
        emailEl.classList.remove('error');
        const p = basePayload('custom_quote_request', 'custom_quote_request');
        p.email = emailEl.value.trim();
        p.phone = $('overflow-phone').value.trim();
        p.unit_label = unitLabel();
        postToSheets(p);
        $('overflow-done').hidden = false;
        emailEl.disabled = true;
        $('overflow-phone').disabled = true;
        $('overflow-submit').disabled = true;
    });

    /* --- Utils --- */
    function isEmail(v) {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((v || '').trim());
    }

    /* Clear error styling on input */
    document.querySelectorAll('.flow-input').forEach(el => {
        el.addEventListener('input', () => el.classList.remove('error'));
    });
})();
