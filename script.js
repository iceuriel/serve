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

/* Service-area coverage. To change coverage, edit these two lists.
   CORE     — no travel fee.
   EXTENDED — +$25 per visit (PRICING.EXTENDED_ZIP_FEE).
   A ZIP in NEITHER list gets the waitlist instead of a price, so a missing ZIP
   is a lost lead. When in doubt, add it to CORE — you can re-tier it later. */
const ZIP_TIERS = {
    CORE: [
        // Boston — every neighborhood, incl. Hyde Park (02136), Allston/HBS (02163),
        // Back Bay/Prudential (02199), Seaport (02210), Fenway/Kenmore (02215)
        "02108","02109","02110","02111","02113","02114","02115","02116","02118",
        "02119","02120","02121","02122","02124","02125","02126","02127","02128",
        "02129","02130","02131","02132","02134","02135","02136","02163","02199",
        "02210","02215",
        "02138","02139","02140","02141","02142",     // Cambridge
        "02143","02144","02145",                     // Somerville
        "02445","02446","02447",                     // Brookline
        "02467",                                     // Chestnut Hill
    ],
    EXTENDED: [                                      // +$25 per visit
        "02148","02149","02150","02151","02152",     // Malden / Everett / Chelsea / Revere / Winthrop
        "02155",                                     // Medford
        "02458","02459","02460","02461","02462",     // Newton
        "02464","02465","02466","02468",
        "02472",                                     // Watertown
        "02474","02476",                             // Arlington
    ],
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
   ATTRIBUTION — src / segment / UTM
   `src` is the tag printed on a poster, QR code, or door hanger:
   servecleaning.com/?src=dh-bh-01

   SEGMENT IS AN INTENT TAXONOMY, NOT A CHANNEL ONE.

   Channel is already recorded twice — `source` holds the full first-touch
   tag and `src_chain` holds every tag of the session — so recording it a
   third time here would say nothing new. `segment` answers the different
   question: what does this person actually need? That is what drives which
   hero renders and which urgency copy applies.

       movein   just closed on a home. Needs a first clean before moving in,
                buys once, decides fast, price is not the objection.
       pro      lives here already. The pitch is getting weekends back, and
                the goal is a recurring plan, not a single job.
       direct   intent unknown. Never guess it — the default hero makes no
                assumption, which is the correct behaviour when we know
                nothing.

   EDIT ME: one row per tag prefix you print. Matching is on the first
   segment of the tag, split on - _ . / and case-insensitive, so
   `dh-bh-01`, `DH_backbay` and `dh` all match `dh`.

   An unrecognised tag falls to `direct` on the same reasoning as referral:
   we do not know the intent, and inventing one puts a wrong hero in front
   of a real customer. Nothing is lost — `source` keeps the full tag, so any
   row can be reclassified later once the tag's meaning is settled.
   ============================================================ */
const SRC_SEGMENTS = [
    // Deed lists and recent-buyer outreach — they just closed.
    ['deed',   'movein'],
    ['db',     'movein'],   // deed batch
    ['mv',     'movein'],

    // Neighbourhood physical media in dense professional areas.
    ['dh',     'pro'],      // door hanger
    ['poster', 'pro'],
    ['qr',     'pro'],
    ['flyer',  'pro'],
    ['eddm',   'pro'],      // every-door direct mail

    // Cold email to the professional segment.
    ['email',  'pro'],
    ['em',     'pro'],

    // Referral — a real person sent them, but we do not know why.
    ['ref',    'direct'],
];

const SEGMENTS = ['movein', 'pro', 'direct'];

function segmentFor(src) {
    if (!src) return 'direct';
    const head = String(src).toLowerCase().split(/[-_./]/)[0];
    const hit = SRC_SEGMENTS.find(pair => pair[0] === head);
    return hit ? hit[1] : 'direct';
}

/**
 * Read once per page load, persist for the session.
 *
 * `src` / `utm_*` keep their original last-touch behaviour: a URL param wins,
 * otherwise the stored value carries through a refresh or a back-button hop.
 * Layered on top: `serve_src` is the FIRST tag of the session and is never
 * overwritten, and `serve_src_chain` records every distinct tag in order — so
 * a second tagged link can no longer erase the one that actually earned the visit.
 */
function readAttribution() {
    let saved = {};
    try { saved = JSON.parse(sessionStorage.getItem('serve_attr') || '{}'); } catch (_) {}
    const params = new URLSearchParams(location.search);
    const keys = ['src', 'utm_source', 'utm_medium', 'utm_campaign'];
    const attr = {};
    keys.forEach(k => { attr[k] = params.get(k) || saved[k] || null; });
    try { sessionStorage.setItem('serve_attr', JSON.stringify(attr)); } catch (_) {}

    const urlSrc = params.get('src');
    let firstSrc = null;
    let chain = [];
    try {
        firstSrc = sessionStorage.getItem('serve_src');
        if (!firstSrc && attr.src) {
            firstSrc = attr.src;
            sessionStorage.setItem('serve_src', firstSrc);   // first touch — write once
        }
        chain = (sessionStorage.getItem('serve_src_chain') || '').split('>').filter(Boolean);
        if (urlSrc && chain[chain.length - 1] !== urlSrc) {
            chain.push(urlSrc);
            sessionStorage.setItem('serve_src_chain', chain.join('>'));
        }
    } catch (_) { /* private mode / storage disabled — degrade to last-touch only */ }

    attr.src_first = firstSrc || attr.src || null;
    attr.src_chain = chain.length ? chain.join('>') : (attr.src || null);
    attr.segment   = segmentFor(attr.src_first);
    return attr;
}

/* Read once per page load. The hero skin and the booking flow read this same
   object, so `segment` can never disagree between what a visitor is shown and
   what is written to the sheet. */
const SERVE_ATTRIBUTION = readAttribution();


/* ============================================================
   HERO SKIN — headline varies by intent segment

   Same page, same offer, same CTA. Only the headline changes, because that is
   the line deciding whether someone reads the second one.

   Selection is FIRST touch, never last. Someone who arrives on a deed link and
   later scans a poster QR is still a mover — the poster did not change why they
   need a clean, and flipping the hero mid-session would be disorienting.

   `direct` has no entry and gets the markup as authored. Any failure — unknown
   segment, storage blocked, missing element — leaves the default in place,
   which is why the default lives in the HTML rather than being rendered here.

   Redirect stubs /movein and /clean land here with a src tag attached, so the
   skin and the attribution both come from the one normal first-touch path.
   See _redirects.
   ============================================================ */
const HERO_SKINS = {
    movein: {
        headline: 'Just closed on a new home? It was cleaned for the last owner — not for you. Start fresh with Serve.',
    },
    pro: {
        headline: 'Come back Friday to a clean home. Get your weekends back with Serve.',
    },
};

function applyHeroSkin(segment) {
    try {
        const skin = HERO_SKINS[segment];
        if (!skin) return;                                  // 'direct' and anything unexpected
        const el = document.querySelector('.hero__headline');
        if (!el) return;
        el.textContent = skin.headline;
        document.body.setAttribute('data-segment', segment);   // hook for styling / analytics
    } catch (_) {
        /* Never let a headline swap break the page. The authored hero stands. */
    }
}

applyHeroSkin(SERVE_ATTRIBUTION.segment);


/* ============================================================
   Booking Flow — Build -> Price -> Reserve
   ============================================================ */
(function () {

    /* ============================================================
       ENDPOINTS — both are SAME-ORIGIN paths on servecleaning.com.

       They used to be script.google.com/macros/.../exec addresses. Corporate
       proxies block that host by default — Apps Script is a known exfiltration
       channel — so on a work laptop the page loaded, the quote calculated, and
       the POST died with ERR_TUNNEL_CONNECTION_FAILED while the customer was
       shown a green confirmation. The time-slot picker failed the same way and
       silently fell back to the earlier/later radios.

       src/worker.js now relays both from Cloudflare's edge, which is not behind
       anyone's firewall. The browser only ever talks to the domain it already
       loaded, so there is nothing left for a proxy to refuse.

       Being same-origin also removes CORS entirely: no preflight, no text/plain
       workaround, real JSON both ways. And the Apps Script URLs are no longer
       readable in this file, which is served publicly.

       The real /exec addresses live in wrangler.jsonc `vars`.
       ============================================================ */

    /* Booking webhook -> /apps-script/webhook.gs */
    const SHEETS_URL = '/api/submit';

    /* Availability feed -> /apps-script/availability.gs.
       Set to '' to skip the network call and go straight to the fallback.
       Response shape:
         { ok: true, slots: [ { date: "2026-08-07", time: "12:00 PM", open: 1 }, … ] } */
    const AVAILABILITY_SOURCE_URL = '/api/slots';

    /* Hard caps. The availability fetch must never strand a customer on
       "Loading times…" with no way to submit, and the reservation POST must
       never leave them staring at "Reserving…". */
    const AVAILABILITY_TIMEOUT_MS = 5000;

    /* Budget for the reservation POST.
       The Worker gives up on Apps Script at 12s and answers with its own 502,
       so 15s here is long enough to receive that rather than aborting blind.
       Two attempts is cheap insurance — submission_id makes a retry safe — but
       it puts the worst case near 30s, so the button reports progress instead
       of sitting frozen. Most successes return in under five seconds. */
    const RESERVE_CONFIRM_TIMEOUT_MS = 15000;
    const RESERVE_MAX_ATTEMPTS = 2;
    const RESERVE_RETRY_DELAY_MS = 1200;
    const RESERVE_SLOW_NOTICE_MS = 6000;

    const $ = (id) => document.getElementById(id);

    const stepEls = {
        1:          $('step-1'),
        2:          $('step-2'),
        3:          $('step-3'),
        overflow:   $('state-overflow'),
        confirmed:  $('state-confirmed'),
        failed:     $('state-failed'),
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
    /* Move In / Move Out adds these on top of INCLUDED_FIRST. The fridge and oven
       lines matter: those are paid add-ons on a First Clean, and the add-on
       toggles are hidden on Move Out — this list is where the customer learns
       they are already covered. */
    const INCLUDED_MOVEOUT_EXTRA = [
        'Windows and sills',
        'Inside cabinets and drawers',
        'Baseboards',
        'Inside the fridge &mdash; included, not an add-on',
        'Inside the oven &mdash; included, not an add-on',
    ];

    /* One id per submission. Sent as submission_id so the Apps Script can skip a
       row it has already written — which is what makes the Addition E retry safe. */
    function newSubmissionId() {
        try {
            if (window.crypto && typeof window.crypto.randomUUID === 'function') {
                return window.crypto.randomUUID();
            }
        } catch (_) { /* fall through */ }
        return 'sub-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    }

    /* Notes → pets flag. Word-boundaried on purpose: "carpet" must not read as
       "pet", and "category" must not read as "cat". */
    const PET_WORDS = /\b(pets?|dogs?|puppy|puppies|cats?|kitten|kittens|kitty|feline|canine|animals?|birds?|parrot|hamster|rabbits?|bunny|guinea pig|ferret|reptile|snake|lizard|litter ?box|crate|kennel|leash|paws?|fur|shedding)\b/i;

    function detectPets(text) {
        return PET_WORDS.test(String(text || ''));
    }

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
        attribution: SERVE_ATTRIBUTION,   // shared with the hero skin
    };

    /* ============================================================
       POST to the edge Worker

       Same-origin, so this is plain JSON with no CORS considerations at all.
       The text/plain workaround is gone — it existed only to keep a
       cross-origin request simple enough for Apps Script to answer, and the
       Worker handles that translation now.

       Lead events (waitlist, emailed quote, custom quote) stay fire-and-forget:
       losing one costs a follow-up, not a booking. The reservation is confirmed
       — see postReservation.
       ============================================================ */
    function postToSheets(payload) {
        try {
            fetch(SHEETS_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                keepalive: true,      // survives the page being closed mid-flight
            }).catch(() => {});
        } catch (_) { /* silent */ }
    }

    /**
     * Reservation POST — readable, so we only tell someone they are booked once
     * the sheet write is confirmed.
     *
     * If the readable call fails for ANY reason (network, timeout, CORS, a non-ok
     * status, an unparseable body), it retries once as the old fire-and-forget
     * no-cors call so the lead still lands, then resolves unconfirmed. The caller
     * shows the success panel either way — a customer never gets an error screen
     * for a booking we may well have received. Both attempts carry the same
     * submission_id, so the retry cannot double-book the sheet.
     *
     * Resolves { confirmed: true|false }. Never rejects.
     */
    function postReservation(payload, attempt) {
        attempt = attempt || 1;
        return new Promise((resolve) => {
            const ctrl  = (typeof AbortController !== 'undefined') ? new AbortController() : null;
            const timer = setTimeout(() => { if (ctrl) ctrl.abort(); }, RESERVE_CONFIRM_TIMEOUT_MS);

            fetch(SHEETS_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: ctrl ? ctrl.signal : undefined,
            })
                .then(res => res.json().catch(() => { throw new Error('HTTP ' + res.status); }))
                .then(body => {
                    clearTimeout(timer);
                    if (!body || body.status !== 'ok') {
                        throw new Error(body && body.error ? body.error : 'unconfirmed');
                    }
                    resolve({ confirmed: true, body: body });
                })
                .catch(err => {
                    clearTimeout(timer);
                    /* One retry. submission_id is unchanged, so if the first
                       attempt did land the server dedupes it and answers
                       duplicate:true — which still counts as confirmed. */
                    if (attempt < RESERVE_MAX_ATTEMPTS) {
                        console.warn('Reservation attempt ' + attempt + ' failed, retrying.', err);
                        setTimeout(function () {
                            postReservation(payload, attempt + 1).then(resolve);
                        }, RESERVE_RETRY_DELAY_MS);
                        return;
                    }
                    console.error('Reservation could not be confirmed after ' +
                                  attempt + ' attempts.', err);
                    resolve({ confirmed: false, error: String(err && err.message || err) });
                });
        });
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
            addon_total:        q ? q.addons : null,   // reported, not recomputed
            time_preference:    state.timePreference,
            utm_source:         a.utm_source,
            utm_medium:         a.utm_medium,
            utm_campaign:       a.utm_campaign,
            src:                a.src,          // last touch (unchanged behaviour)
            src_first:          a.src_first,    // first touch — never overwritten
            src_chain:          a.src_chain,    // every tag this session, in order
            segment:            a.segment,      // derived from src_first
            page_path:          location.pathname,
            submitted_at:       now,
            submission_id:      newSubmissionId(),
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
        r.addEventListener('change', () => {
            if (!r.checked) return;
            state.service = r.value;
            syncAddonsToService();   // Move Out hides the toggles — don't leave them armed
        });
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

        syncAddonsToService();
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

    /**
     * Add-ons are First Clean only. The block is hidden on Move Out, so a box
     * ticked earlier would otherwise stay ticked and invisible — and reappear,
     * still ticked, the moment the customer switched back. Clear DOM and state
     * together so what they see and what we send never diverge.
     */
    function syncAddonsToService() {
        if (state.service === 'first_clean') return;
        state.addonFridge = false;
        state.addonOven   = false;
        if (addonFridge) addonFridge.checked = false;
        if (addonOven)   addonOven.checked   = false;
    }

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
       Fed by AVAILABILITY_SOURCE_URL. If that endpoint is missing, down, slow,
       or has no open slots, the time-preference radios stay live and the
       customer can always book. See prefetchAvailability for the fail-safes.
       ======================================================== */
    const HORIZON_DAYS = 21;

    let availSlots  = null;        // session cache of bookable slots
    let availFetched = false;
    let timeUi = 'fallback';       // 'fallback' | 'loading' | 'scheduler'

    /**
     * Warm the Step 3 scheduler. Every failure mode — no URL configured, network
     * error, non-200, bad JSON, no open slots, or a feed that simply hangs — lands
     * in the same place: the earlier/later radios, live and submittable. The
     * timeout is the one that matters. A dead endpoint that ERRORS is harmless;
     * a dead endpoint that HANGS would otherwise leave the customer on
     * "Loading times…" with the radios hidden and no way to book.
     */
    function prefetchAvailability() {
        if (availFetched) return;
        availFetched = true;

        if (!AVAILABILITY_SOURCE_URL) {
            console.info('No availability source configured — serving the time-preference fallback.');
            return;   // timeUi is already 'fallback'; skip the round trip entirely
        }

        setTimeUi('loading');

        const ctrl  = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        const timer = setTimeout(() => { if (ctrl) ctrl.abort(); }, AVAILABILITY_TIMEOUT_MS);

        // Belt and braces: if AbortController is missing, this still drops the UI
        // back to the radios once the cap elapses, whatever the fetch is doing.
        const failSafe = setTimeout(() => {
            if (timeUi === 'loading') setTimeUi('fallback');
        }, AVAILABILITY_TIMEOUT_MS);

        fetch(AVAILABILITY_SOURCE_URL, { signal: ctrl ? ctrl.signal : undefined })
            .then(res => {
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.json();
            })
            .then(data => {
                clearTimeout(timer);
                clearTimeout(failSafe);
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
                clearTimeout(timer);
                clearTimeout(failSafe);
                console.warn('Availability unavailable — serving the time-preference fallback.', err);
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
    const reserveForm   = $('reserve-form');
    const reserveError  = $('reserve-error');
    const reserveSubmit = $('reserve-submit');
    const reserveNotes  = $('r-notes');
    let reserveSubmitting = false;   // blocks the Enter-key + click double-fire

    reserveForm.querySelectorAll('input[name="time_preference"]').forEach(r => {
        r.addEventListener('change', () => { if (r.checked) state.timePreference = r.value; });
    });

    $('back-to-2').addEventListener('click', () => setView(2));

    reserveForm.addEventListener('submit', (e) => {
        e.preventDefault();
        if (reserveSubmitting) return;
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

        reserveSubmitting = true;
        reserveSubmit.disabled = true;
        reserveSubmit.textContent = 'Reserving…';

        /* A retry can push the worst case near 30 seconds. Without this the
           button just sits there and people assume it broke and leave. */
        const slowNotice = setTimeout(function () {
            if (reserveSubmitting) reserveSubmit.textContent = 'Still reserving — hold on…';
        }, RESERVE_SLOW_NOTICE_MS);

        recompute();
        const q = state.quote;
        const p = basePayload('reservation', 'quote_reserved');
        // identity (only on reservation)
        p.name    = $('r-name').value.trim();
        p.email   = $('r-email').value.trim();
        p.phone   = $('r-phone').value.trim();
        p.address = $('r-address').value.trim();
        p.unit    = $('r-unit').value.trim();
        // free-text notes + the pets signal derived from them
        p.customer_notes = reserveNotes ? reserveNotes.value.trim() : '';
        p.pets_flag      = detectPets(p.customer_notes);
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

        // Only claim the spot once the sheet write comes back confirmed. If it
        // cannot be confirmed, postReservation has already retried fire-and-forget
        // and warned in the console — we still show success rather than sending a
        // paying customer an error for a booking we probably received.
        /* Only claim the spot on a confirmed write.

           This used to show the confirmation regardless, on the reasoning that a
           customer should never see an error for a booking we had probably
           received. That trade was right when failures were rare and random. It
           was exactly wrong for the corporate-proxy case, where the POST failed
           every single time and every one of those people was told they were on
           the schedule.

           Now the endpoint is same-origin a genuine failure means something is
           actually broken, so saying so is both honest and rare. */
        postReservation(p).then(result => {
            clearTimeout(slowNotice);
            if (result.confirmed) {
                setView('confirmed');
                return;
            }
            console.error('Reservation NOT confirmed.', p.submission_id, result.error);
            showReserveFailure(p, result.error);
        });
    });

    /**
     * The booking could not be confirmed. Say so, and make it recoverable in one
     * tap — their details are already typed, so the fallback carries them into
     * an email rather than asking them to start again somewhere else.
     */
    function showReserveFailure(payload, error) {
        const el = $('state-failed');
        if (!el) {                       // markup missing: never strand them silently
            reserveSubmitting = false;
            reserveSubmit.disabled = false;
            reserveSubmit.textContent = 'Reserve my clean';
            reserveError.textContent =
                "We couldn't confirm your booking. Please email servehomecleaning@gmail.com and we'll book you in.";
            return;
        }

        const link = $('failed-mailto');
        if (link) {
            const when = payload.slot_date && payload.slot_time
                ? payload.slot_date + ' at ' + payload.slot_time
                : (payload.schedule_preference_label || 'no preference given');
            const body =
                "My booking didn't go through on the website. My details:\n\n" +
                'Name: '    + payload.name    + '\n' +
                'Phone: '   + payload.phone   + '\n' +
                'Address: ' + payload.address + (payload.unit ? ', ' + payload.unit : '') + '\n' +
                'ZIP: '     + payload.zip     + '\n' +
                'Home: '    + payload.unit_label + '\n' +
                'Service: ' + payload.service_type + '\n' +
                'Quoted: $' + payload.first_visit_total + '\n' +
                'Requested: ' + when + '\n' +
                (payload.customer_notes ? 'Notes: ' + payload.customer_notes + '\n' : '') +
                '\nRef: ' + payload.submission_id + '\n';
            link.href = 'mailto:servehomecleaning@gmail.com' +
                        '?subject=' + encodeURIComponent('Booking that did not go through — ' + payload.name) +
                        '&body='    + encodeURIComponent(body);
        }

        const ref = $('failed-ref');
        if (ref) ref.textContent = payload.submission_id;

        setView('failed');
    }

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
