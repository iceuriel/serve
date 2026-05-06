/* ============================================================
   SERVE CLEANING — Main Script
   Vanilla JS only. No frameworks or dependencies.
   ============================================================ */


/* --- Sticky Banner: keep nav offset matched to banner height --- */
(function () {
    const banner = document.querySelector('.launch-banner');
    const nav    = document.querySelector('.nav');
    if (!banner || !nav) return;

    function sync() {
        nav.style.top = banner.offsetHeight + 'px';
    }
    sync();
    window.addEventListener('resize', sync);
    window.addEventListener('load', sync);
})();


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
   Serve Pricing Engine — edit PRICING_CONFIG to adjust rates
   ============================================================ */
const PRICING_CONFIG = {
    baseRates: {
        "studio":    { label: "Studio",          sqft: "< 600 sqft",       base: 115 },
        "1br_1ba":   { label: "1 BR / 1 BA",     sqft: "600–800 sqft",    base: 125 },
        "2br_1ba":   { label: "2 BR / 1 BA",     sqft: "800–1,200 sqft",  base: 145 },
        "2br_2ba":   { label: "2 BR / 2 BA",     sqft: "1,000–1,400 sqft",base: 165 },
        "3br_2ba":   { label: "3 BR / 2 BA",     sqft: "1,400–2,000 sqft",base: 185 },
        "4br_2ba":   { label: "4 BR / 2–3 BA",   sqft: "2,000–2,800 sqft",base: 230 },
        "5br_3ba":   { label: "5 BR / 3 BA",     sqft: "2,800–3,500 sqft",base: 285 },
    },

    serviceMultipliers: {
        "deep":    { multiplier: 2.75, label: "First Visit Deep Clean",  tagline: "Top-to-bottom deep clean — fridge, oven, windows, and baseboards all included." },
        "moveout": { multiplier: 4.00, label: "Move-In / Move-Out Clean", tagline: "Empty-unit deep clean — interior cabinets, walls, every appliance, ready for keys." },
    },

    launchDiscount: 0.50,

    recurringDiscounts: {
        weekly:   { label: "Weekly",   cadence: "Every 7 days",  discount: 0.25, badge: "BEST VALUE" },
        biweekly: { label: "Biweekly", cadence: "Every 14 days", discount: 0.20, badge: "RECOMMENDED" },
        monthly:  { label: "Monthly",  cadence: "Every 4 weeks", discount: 0.10, badge: null },
    },

    includedAddons: [
        { label: "Inside fridge",          anchor: 60 },
        { label: "Inside oven",            anchor: 50 },
        { label: "Interior windows",       anchor: 40 },
        { label: "Baseboards (all rooms)", anchor: 25 },
    ],

    modifiers: {
        pets:        { label: "Heavy pet hair",                type: "flat", value: 25 },
        stairs:      { label: "3+ flights, no elevator",       type: "flat", value: 20 },
        sameDay:     { label: "Same-day / next-day booking",   type: "flat", value: 35 },
        outsideCore: { label: "Outside Boston/Cambridge core", type: "flat", value: 25 },
    },
};

function calculateQuote({ unitType, serviceType, activeModifiers = [] }) {
    const unit    = PRICING_CONFIG.baseRates[unitType];
    const service = PRICING_CONFIG.serviceMultipliers[serviceType];
    if (!unit || !service) return null;

    const baseStandard       = unit.base;
    const subtotalBeforeMods = baseStandard * service.multiplier;

    let modAdjustment = 0;
    const modList = [];
    activeModifiers.forEach((key) => {
        const mod = PRICING_CONFIG.modifiers[key];
        if (!mod) return;
        modAdjustment += mod.value;
        modList.push({ label: mod.label, amount: mod.value });
    });

    const fullPrice       = subtotalBeforeMods + modAdjustment;
    const firstVisitTotal = fullPrice * (1 - PRICING_CONFIG.launchDiscount);

    const recurringPlans = Object.entries(PRICING_CONFIG.recurringDiscounts).map(
        ([key, plan]) => ({
            key,
            label:    plan.label,
            cadence:  plan.cadence,
            badge:    plan.badge,
            perVisit: baseStandard * (1 - plan.discount),
        })
    );

    const includedValue = PRICING_CONFIG.includedAddons.reduce((sum, a) => sum + a.anchor, 0);

    return {
        unit,
        service,
        baseStandard,
        subtotalBeforeMods,
        modList,
        modAdjustment,
        fullPrice,
        launchDiscount: PRICING_CONFIG.launchDiscount,
        firstVisitTotal,
        recurringPlans,
        includedValue,
        includedAddons: PRICING_CONFIG.includedAddons,
    };
}


/* ============================================================
   Quote Flow — Multi-Step State, Sheets POSTs, Step 3 Render
   ============================================================ */
(function () {
    const SHEETS_URL = 'https://script.google.com/macros/s/AKfycbwYbRsTSiZKPyfGtlFkGIXkT5Qfkfu4yefgBOBkF21uOrDz9XFEjz8lNjwAXYkLir7z/exec';

    const step1 = document.getElementById('step-1');
    const step2 = document.getElementById('step-2');
    const step3 = document.getElementById('step-3');
    if (!step1 || !step2 || !step3) return;

    const contactForm   = document.getElementById('contact-form');
    const serviceForm   = document.getElementById('service-form');
    const contactError  = document.getElementById('contact-error');
    const serviceError  = document.getElementById('service-error');
    const backBtn       = document.getElementById('back-to-step-1');
    const reserveBtn    = document.getElementById('reserve-btn');
    const display       = document.getElementById('quote-display');
    const bottomBar     = document.getElementById('quote-bottom-bar');
    const bottomPriceEl = document.getElementById('bottom-bar-price');
    const confirmBlock  = document.getElementById('quote-confirmation');
    const confirmName   = document.getElementById('confirm-name');

    const state = {
        contact: null,
        quote: null,
        serviceType: null,
        unitType: null,
        modifiers: [],
    };

    /* --- Step navigation --- */
    function showStep(n) {
        [step1, step2, step3].forEach((el, i) => {
            el.classList.toggle('step-active', i === n - 1);
            el.classList.toggle('step-hidden', i !== n - 1);
        });
        const target = document.getElementById('quote');
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    /* --- Sheets POST (fire-and-forget) --- */
    function postToSheets(payload) {
        try {
            fetch(SHEETS_URL, {
                method: 'POST',
                mode: 'no-cors',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            }).catch(() => {});
        } catch (_) {
            // silent — never block UX
        }
    }

    /* --- Step 1: validate contact --- */
    function validateContact() {
        contactError.textContent = '';
        contactForm.querySelectorAll('.error').forEach(el => el.classList.remove('error'));

        const required = ['name', 'phone', 'email', 'address'];
        let valid = true;
        let firstBad = null;

        required.forEach(name => {
            const el = contactForm.querySelector('[name="' + name + '"]');
            if (!el || !el.value.trim()) {
                if (el) el.classList.add('error');
                valid = false;
                if (!firstBad && el) firstBad = el;
            }
        });

        const emailEl = contactForm.querySelector('[name="email"]');
        if (emailEl && emailEl.value.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailEl.value.trim())) {
            emailEl.classList.add('error');
            valid = false;
            if (!firstBad) firstBad = emailEl;
        }

        if (!valid) {
            contactError.textContent = 'Please fill out all required fields.';
            if (firstBad) firstBad.focus();
        }
        return valid;
    }

    contactForm.addEventListener('submit', function (e) {
        e.preventDefault();
        if (!validateContact()) return;

        const data = new FormData(contactForm);
        state.contact = {
            name:    (data.get('name')    || '').trim(),
            phone:   (data.get('phone')   || '').trim(),
            email:   (data.get('email')   || '').trim(),
            address: (data.get('address') || '').trim(),
        };

        // Fire-and-forget lead capture — never block the user
        postToSheets({
            event: 'lead_captured',
            timestamp: new Date().toISOString(),
            name:    state.contact.name,
            email:   state.contact.email,
            phone:   state.contact.phone,
            address: state.contact.address,
        });

        showStep(2);
    });

    contactForm.querySelectorAll('input').forEach(el => {
        el.addEventListener('input', () => {
            el.classList.remove('error');
            if (!contactForm.querySelector('.error')) contactError.textContent = '';
        });
    });

    /* --- Step 2: collect selections, calculate, render Step 3 --- */
    backBtn.addEventListener('click', () => showStep(1));

    serviceForm.addEventListener('submit', function (e) {
        e.preventDefault();
        serviceError.textContent = '';

        const data        = new FormData(serviceForm);
        const serviceType = data.get('service_type');
        const unitType    = data.get('unit_type');

        const activeModifiers = [];
        ['pets', 'stairs', 'sameDay', 'outsideCore'].forEach(key => {
            if (data.get('mod_' + key)) activeModifiers.push(key);
        });

        const quote = calculateQuote({ unitType, serviceType, activeModifiers });
        if (!quote) {
            serviceError.textContent = 'Something went wrong with your selection. Please try again.';
            return;
        }

        state.serviceType = serviceType;
        state.unitType    = unitType;
        state.modifiers   = activeModifiers;
        state.quote       = quote;

        renderQuote();
        showStep(3);
    });

    /* --- Step 3: render quote display --- */
    function renderQuote() {
        const q       = state.quote;
        const contact = state.contact;
        if (!q || !contact) return;

        const firstName = (contact.name.split(/\s+/)[0]) || 'there';
        const original  = Math.round(q.fullPrice);
        const discount  = Math.round(q.firstVisitTotal);
        const isMoveout = state.serviceType === 'moveout';
        const serviceBadge = isMoveout ? 'MOVE-IN / MOVE-OUT' : 'FIRST VISIT DEEP CLEAN';

        // Adjustments card (only render if any modifiers selected)
        let adjustmentsHTML = '';
        if (q.modList.length) {
            const rows = q.modList.map(m =>
                `<div class="adjust-row">
                    <span class="adjust-row__label">${escapeHtml(m.label)}</span>
                    <span class="adjust-row__amount">+$${m.amount}</span>
                </div>`
            ).join('');
            adjustmentsHTML = `
                <div class="quote-card">
                    <div class="quote-card__title">Adjustments</div>
                    ${rows}
                </div>`;
        }

        // Add-ons rows
        const addonRows = q.includedAddons.map(a =>
            `<div class="addon-row">
                <span class="addon-row__label">${escapeHtml(a.label)}</span>
                <span class="addon-row__anchor">$${a.anchor}</span>
                <span class="addon-row__included">Included</span>
                <span class="addon-row__check">✓</span>
            </div>`
        ).join('');

        // Recurring plan cards
        const planCards = q.recurringPlans.map(p => {
            const featured = p.key === 'biweekly';
            const badgeClass = p.key === 'monthly' ? '' : '';
            const badgeHTML = p.badge
                ? `<span class="plan-card__badge ${p.key === 'weekly' ? 'plan-card__badge--muted' : ''}">${escapeHtml(p.badge)}</span>`
                : '';
            return `
                <div class="plan-card ${featured ? 'plan-card--featured' : ''}">
                    ${badgeHTML}
                    <div>
                        <div class="plan-card__name">${escapeHtml(p.label)}</div>
                        <div class="plan-card__cadence">${escapeHtml(p.cadence)}</div>
                    </div>
                    <div>
                        <div class="plan-card__price">$${Math.round(p.perVisit)}</div>
                        <div class="plan-card__per">per visit</div>
                    </div>
                </div>`;
        }).join('');

        display.innerHTML = `
            <div class="quote-display__header">
                <h2>Your quote is ready, ${escapeHtml(firstName)}.</h2>
                <p>Prepared by Serve. Review the details below and reserve your spot when you're ready.</p>
            </div>

            <div class="quote-discount">
                <div class="quote-discount__badge">🎉 LAUNCH SPECIAL — 50% OFF</div>
                <div class="quote-discount__original">$${original}</div>
                <div class="quote-discount__price">$${discount}</div>
                <div class="quote-discount__note">Early client pricing — limited availability.</div>
            </div>

            <div class="quote-card">
                <div class="quote-card__title">Service Summary</div>
                <div class="service-badge">${escapeHtml(serviceBadge)}</div>
                <div class="service-tagline">${escapeHtml(q.service.tagline)}</div>
                <div class="summary-row">
                    <span class="summary-row__label">Unit</span>
                    <span class="summary-row__value">${escapeHtml(q.unit.label)} <span style="color:var(--color-text-muted);font-weight:500;">(${escapeHtml(q.unit.sqft)})</span></span>
                </div>
                <div class="summary-row">
                    <span class="summary-row__label">Service Address</span>
                    <span class="summary-row__value">${escapeHtml(contact.address)}</span>
                </div>
            </div>

            <div class="quote-card">
                <div class="quote-card__title">Add-Ons Included</div>
                ${addonRows}
                <div class="addon-footer">$${q.includedValue} of extras already included in your price.</div>
            </div>

            ${adjustmentsHTML}

            <div class="recurring-section">
                <div class="recurring-section__header">
                    <div class="recurring-section__title">After Your First Visit — Keep Serve on Your Schedule</div>
                    <p class="recurring-section__sub">Your first-visit price is locked in with the 50% launch discount. After the deep clean, recurring visits are priced at the standard rate below. No commitment required today — just see what it looks like.</p>
                </div>
                <div class="plan-grid">
                    ${planCards}
                </div>
            </div>
        `;

        bottomPriceEl.textContent = '$' + discount;
    }

    /* --- Reserve --- */
    reserveBtn.addEventListener('click', function () {
        if (reserveBtn.disabled) return;
        reserveBtn.disabled = true;
        reserveBtn.textContent = 'Reserving…';

        const q       = state.quote;
        const contact = state.contact;
        if (!q || !contact) return;

        const modifierLabels = q.modList.map(m => m.label);

        postToSheets({
            event:                'quote_reserved',
            timestamp:            new Date().toISOString(),
            name:                 contact.name,
            email:                contact.email,
            phone:                contact.phone,
            address:              contact.address,
            service_type:         state.serviceType,
            unit_type:            state.unitType,
            unit_label:           q.unit.label,
            modifiers_applied:    modifierLabels,
            original_price:       Math.round(q.fullPrice),
            discount_applied:     '50%',
            first_visit_total:    Math.round(q.firstVisitTotal),
            recurring_weekly:     Math.round(q.recurringPlans.find(p => p.key === 'weekly').perVisit),
            recurring_biweekly:   Math.round(q.recurringPlans.find(p => p.key === 'biweekly').perVisit),
            recurring_monthly:    Math.round(q.recurringPlans.find(p => p.key === 'monthly').perVisit),
        });

        // Brief disabled state, then swap to confirmation
        setTimeout(() => {
            display.hidden     = true;
            bottomBar.style.display = 'none';
            const firstName = (contact.name.split(/\s+/)[0]) || 'there';
            confirmName.textContent = firstName;
            confirmBlock.hidden = false;
            confirmBlock.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 1000);
    });

    /* --- Util --- */
    function escapeHtml(s) {
        if (s == null) return '';
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }
})();
