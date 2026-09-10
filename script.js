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
   THE PRICING ENGINE MOVED — 2026-09-01

   It is now pricing-engine.js, loaded by a <script> tag immediately before
   this file on index, pricing and services. Everything it defines is still a
   global here, so nothing below changed.

   It left because the SERVER needs it too: src/worker.js re-derives the price
   of every booking rather than trusting the number this file computes on the
   customer's machine. Two copies would drift silently, so there is one file
   and three readers.

   Test harnesses that used to slice this region out of script.js now read
   pricing-engine.js directly.
   ============================================================ */



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

/* How long a tag keeps credit for a booking, and where it is kept.
   ---------------------------------------------------------------
   localStorage, not sessionStorage: people do not book in one sitting. Someone
   scans a card at a leasing office on Tuesday, closes the tab, and books on
   Thursday by typing the URL. Session storage is gone by then and the card gets
   no credit for the sale it caused — which for a QR code on a business card is
   the normal path, not an edge case.

   Thirty days because that is roughly the decision window for a home service.
   Without a bound, a scan in January would still be claiming bookings in
   November. The privacy policy states this window; if you change the number
   here, change it there too. */
const ATTR_KEY      = 'serve_attr';
const ATTR_TTL_DAYS = 30;

/**
 * Read once per page load; persist for up to ATTR_TTL_DAYS.
 *
 * `src` / `utm_*` keep last-touch behaviour: a URL param wins, otherwise the
 * stored value carries through a refresh, a back-button hop, or a return visit
 * days later. Layered on top: `src_first` is the first TAGGED touch and is
 * never overwritten, and `src_chain` records every distinct tag in order — so a
 * second tagged link cannot erase the one that actually earned the visit.
 *
 * ONE RECORD, NOT THREE KEYS. This used to be `serve_attr` + `serve_src` +
 * `serve_src_chain`. Separate keys cannot expire together: the window could
 * close on one and not the others, leaving a first touch from sixty days ago
 * paired with a last touch from today. A single object expires atomically or
 * not at all.
 */
function readAttribution() {
    const params = new URLSearchParams(location.search);
    const keys   = ['src', 'utm_source', 'utm_medium', 'utm_campaign'];

    let saved = {};
    try {
        const raw = JSON.parse(localStorage.getItem(ATTR_KEY) || '{}');
        if (raw.ts && Date.now() - raw.ts <= ATTR_TTL_DAYS * 86400000) {
            saved = raw;
        } else if (raw.ts) {
            localStorage.removeItem(ATTR_KEY);      // window closed — start clean
        }
    } catch (_) { /* private mode / storage disabled — degrade to this load only */ }

    const attr = {};
    keys.forEach(k => { attr[k] = params.get(k) || saved[k] || null; });

    const urlSrc = params.get('src');
    let chain = String(saved.src_chain || '').split('>').filter(Boolean);
    if (urlSrc && chain[chain.length - 1] !== urlSrc) chain.push(urlSrc);

    attr.src_first = saved.src_first || attr.src || null;
    attr.src_chain = chain.length ? chain.join('>') : (attr.src || null);
    attr.segment   = segmentFor(attr.src_first);

    /* The clock starts when a TAG is first recorded, not on an untagged visit.
       Dating the record from someone's first anonymous browse would let a month
       of direct traffic expire a card scan the day after they finally scanned. */
    const tagIsNew = attr.src_first && !saved.src_first;

    try {
        localStorage.setItem(ATTR_KEY, JSON.stringify({
            src:          attr.src,
            utm_source:   attr.utm_source,
            utm_medium:   attr.utm_medium,
            utm_campaign: attr.utm_campaign,
            src_first:    attr.src_first,
            src_chain:    attr.src_chain,
            /* Fixed window, never refreshed on a later visit. A sliding window
               would let someone who drops by every 29 days carry one card scan
               forever. */
            ts: tagIsNew ? Date.now() : (saved.ts || Date.now()),
        }));
    } catch (_) { /* nothing to do — attribution degrades, booking is unaffected */ }

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
        headline: 'Just closed on a new home? It was cleaned for the last owner — not for you. Start fresh with Serve',
    },
    pro: {
        headline: 'Come back Friday to a clean home. Get your weekends back with Serve',
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

    /* Signed quote -> src/worker.js handleQuote.
       Response shape: { ok: true, price, pricing_version, quote_sig, expires_at }

       WHY THE CALCULATOR STILL PRICES LOCALLY. This is not the price the
       customer watches while they set bedrooms and bathrooms — that has to be
       instant, and computeQuote is right here. This is called ONCE, at reserve,
       to have the server put its name to the final figure. The signature is
       what lets anything downstream charge a card against that figure without
       trusting a number that spent the last ten minutes in a browser.

       Its failure mode is silence: no signature attached, the booking goes
       through on exactly the terms it did before this existed, and the job is
       simply not auto-chargeable. Nothing here may ever block a reservation. */
    const QUOTE_SIGN_URL = '/api/quote';
    const QUOTE_SIGN_TIMEOUT_MS = 4000;

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
       "pet", and "category" must not read as "cat".

       CURRENTLY UNCALLED, and kept on purpose. The reserve-step textarea that
       fed it was removed on 2026-09-01; the same question is being moved to
       after reservation, and this is the parser that reply will need. The word
       list and its false-positive traps are the expensive part, not the two
       lines below — deleting it means rebuilding it, and the trap cases are
       exactly what a rewrite would miss. Covered by attribution.test.js. */
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
        levels: 1,
        service: 'first_clean',
        /* What the customer is actually asked. `condition` below is derived from
           these two by deriveCondition() and is never set directly by a form. */
        lastClean: 'months',
        hasPets: false,
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
            levels:             state.levels,
            service:            state.service,
            condition:          state.condition,
            addon_fridge:       state.addonFridge,
            addon_oven:         state.addonOven,
            frequency_selected: state.frequency,
            quote_price:        q ? q.displayPrice : null,
            /* Which engine produced the numbers above. The server re-derives
               them and needs to tell two different disagreements apart: same
               version + different price is a payload someone edited, different
               version is a deploy that landed while this tab was open. The
               first is refused, the second is honoured. */
            pricing_version:    typeof PRICING_VERSION !== 'undefined' ? PRICING_VERSION : null,
            steady_state_price: q ? q.steadySelected : null,
            addon_total:        q ? q.addons : null,   // reported, not recomputed
            /* Silent geo adjustment, logged for later analysis of quote
               accuracy by area. NEVER rendered — see serveGeo(). */
            geo_factor:         q ? q.geoFactor : null,
            park_tier:          q ? q.parkTier : null,
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

    /* Exactly the fields the Worker's quoteScope() reads — and deliberately no
       more. No name, no address, no phone: signing a price needs the home, not
       the person, and this endpoint has no business seeing the customer.

       Adding a priced input means adding it BOTH here and in quoteScope(). Miss
       one and the two sides derive different strings, the signature does not
       verify, and the booking falls back to unsigned. That is the safe way for
       this to break, and the test suite catches it. */
    const QUOTE_SCOPE_FIELDS = ['zip', 'bedrooms', 'bathrooms', 'levels', 'service',
                                'condition', 'addon_fridge', 'addon_oven',
                                'frequency_selected'];

    /**
     * Ask the server to price this booking and put its name to the answer.
     *
     * Resolves to a signature, or to null — and null is an ordinary outcome,
     * not an error. One same-origin edge round trip on a path already budgeted
     * for fifteen seconds.
     *
     * THE SIGNATURE IS ATTACHED ONLY WHEN THE SERVER AGREES WITH THE NUMBER ON
     * SCREEN. When the two disagree — a deploy landed while this tab sat open —
     * the customer still pays what they were shown, because a quote that moves
     * after the fact is the most damaging thing this system could do to
     * somebody. The booking goes through unsigned and an operator settles it.
     */
    function signQuote(p) {
        const ctrl  = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timer = setTimeout(() => { if (ctrl) ctrl.abort(); }, QUOTE_SIGN_TIMEOUT_MS);
        const body  = {};
        QUOTE_SCOPE_FIELDS.forEach(k => { body[k] = p[k]; });

        return fetch(QUOTE_SIGN_URL, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(body),
            signal:  ctrl ? ctrl.signal : undefined,
        })
            .then(r => (r.ok ? r.json() : null))
            .then(d => {
                if (!d || !d.ok || !d.quote_sig) return null;
                if (Number(d.price) !== Number(p.quote_price)) {
                    console.warn('Quote signature declined — server $' + d.price +
                                 ' vs shown $' + p.quote_price +
                                 '. Booking at the price on screen.');
                    return null;
                }
                /* All three travel together or not at all. The signature alone
                   cannot be re-checked later: `scope` is the home it covers,
                   which a JOBS row cannot losslessly reproduce, and `version`
                   is the engine the SERVER signed with, which is not
                   necessarily the one this page is running. */
                return { sig: d.quote_sig, scope: d.quote_scope,
                         version: d.pricing_version };
            })
            .catch(() => null)
            .then(proof => { clearTimeout(timer); return proof; });
    }

    function bedroomsLabel(n) {
        if (n === 0) return 'Studio';
        if (n >= PRICING.OVERFLOW_BEDROOMS) return n + '+ BR';
        return n + ' BR';
    }
    /* Levels only appear once there is more than one — "1 floor" on every
       single-storey condo is noise in the sheet and in the confirmation. */
    function unitLabel() {
        const base = bedroomsLabel(state.bedrooms) + ' / ' + state.bathrooms + ' BA';
        return state.levels > 1 ? base + ' / ' + state.levels + ' floors' : base;
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
       ADDRESS SUGGESTIONS
       ========================================================
       Type-ahead on the address field, served by /api/address.

       IT ONLY EVER HELPS. Every failure — no provider key, an outage, a rate
       limit, a query too short, a network drop — renders nothing, and nothing
       is a plain text box, which is what this field was before. There is no
       state where a booking depends on a suggestion having arrived.

       WHY IT SURVIVED THE PROPERTY LOOKUP. This was built to feed an
       address-first step that looked homes up in public records; that step was
       removed on 2026-09-08 because the records matched the actual UNIT 0% of
       the time. The suggestions themselves measured 100% street match on 25
       real Boston condo addresses, and they still earn their place here: this
       is the field a cleaner navigates by, and a typo in it is a real problem
       on the day.

       THE ZIP GOES ONE WAY ONLY. It is read from the Build step to rank
       results and is NEVER written back from a suggestion. Geoapify returned
       02117 for 37 Appleton St (a PO-box ZIP), 02205 for 118 B St, and 01890 —
       Winchester — for 5 Lagrange St. Writing those into the ZIP field tripped
       the coverage gate and rejected real Back Bay customers mid-booking. The
       customer's own ZIP is the only one this flow trusts.

       THE RACE IS THE WHOLE PROBLEM. Keystrokes fire faster than responses
       return, and they return out of order — the answer for "123 b" can land
       after the answer for "123 beacon" and overwrite a good list with a stale
       one. Every request carries a sequence number and anything but the newest
       is discarded on arrival. Debouncing reduces how often that happens; it
       does not prevent it, and treating it as if it did is the bug.
       ======================================================== */
    const acInput  = $('r-address');
    const acList   = $('r-address-list');
    const acCredit = $('r-address-credit');

    const AC_MIN_CHARS = 3;
    const AC_DEBOUNCE_MS = 220;

    let acTimer = null;
    let acSeq = 0;              // newest request wins, always
    let acItems = [];
    let acActive = -1;          // index of the highlighted option, -1 for none
    let acPicked = '';          // the last value we filled in, so we don't re-query it
    /* The unit the typed text implied, as split out by the server. Someone who
       writes "100 Shawmut Ave 907" has already told us the unit; carrying it
       through means the property lookup can use it to pin the right home in a
       building, and the confirmation card arrives with it filled in rather
       than asking for something they typed thirty seconds ago. */
    let acUnit = '';

    function acClose() {
        if (!acList) return;
        acList.hidden = true;
        acList.textContent = '';
        acInput.setAttribute('aria-expanded', 'false');
        acInput.removeAttribute('aria-activedescendant');
        acItems = [];
        acActive = -1;
    }

    function acHighlight(i) {
        const opts = acList.querySelectorAll('.ac__opt');
        opts.forEach(o => { o.classList.remove('is-active'); o.setAttribute('aria-selected', 'false'); });
        acActive = i;
        if (i < 0 || i >= opts.length) { acInput.removeAttribute('aria-activedescendant'); return; }
        opts[i].classList.add('is-active');
        opts[i].setAttribute('aria-selected', 'true');
        /* The screen-reader half of the highlight. Without this the list moves
           visually and says nothing. */
        acInput.setAttribute('aria-activedescendant', opts[i].id);
        if (opts[i].scrollIntoView) opts[i].scrollIntoView({ block: 'nearest' });
    }

    /**
     * Take a suggestion: fill the address, fill the unit if they typed one,
     * and get out of the way.
     *
     * IT DOES NOT TOUCH THE ZIP, deliberately. Writing the suggestion's ZIP
     * back into the form is exactly what rejected customers in Back Bay:
     * Geoapify answers 02117 for 37 Appleton St, which is a PO-box ZIP nobody
     * lives in, and the coverage gate then told a real customer we do not
     * serve them. The ZIP the customer typed in step 1 already passed that
     * gate. A geocoder does not get to overrule it.
     */
    function acChoose(i) {
        const s = acItems[i];
        if (!s) return;
        acPicked = s.line;
        acInput.value = s.line;
        /* If the typed text carried a unit, put it where units go rather than
           leaving it stripped and lost. Only when that field is still empty —
           what they typed there by hand wins. */
        const unitEl = $('r-unit');
        if (acUnit && unitEl && !unitEl.value.trim()) unitEl.value = acUnit;
        acClose();
        acInput.focus();
    }

    function acRender(items) {
        acItems = items;
        acList.textContent = '';
        if (!items.length) { acClose(); return; }

        items.forEach((s, i) => {
            const li = document.createElement('li');
            li.className = 'ac__opt';
            li.id = 'ac-opt-' + i;
            li.setAttribute('role', 'option');
            li.setAttribute('aria-selected', 'false');

            const line = document.createElement('span');
            line.className = 'ac__line';
            line.textContent = s.line;
            li.appendChild(line);

            const where = [s.city, s.zip].filter(Boolean).join(' · ');
            if (where) {
                const sub = document.createElement('span');
                sub.className = 'ac__where';
                sub.textContent = where;
                li.appendChild(sub);
            }

            /* mousedown, not click: the input's blur fires first on a click and
               would close the list out from under the pointer. */
            li.addEventListener('mousedown', (e) => { e.preventDefault(); acChoose(i); });
            li.addEventListener('mouseenter', () => acHighlight(i));
            acList.appendChild(li);
        });

        acList.hidden = false;
        acInput.setAttribute('aria-expanded', 'true');
        acActive = -1;
        if (acCredit) acCredit.hidden = false;   // shown only once it has been used
    }

    function acQuery(text) {
        const mine = ++acSeq;
        /* The ZIP the customer gave in step 1, read from state rather than from
           any field this step owns. It goes OUT to rank suggestions and never
           comes back — see acChoose. By the time anyone reaches the reserve
           step this is set and has already cleared the coverage check. */
        const zip = String(state.zip || '').trim();
        let url = '/api/address?q=' + encodeURIComponent(text);
        if (/^\d{5}$/.test(zip)) url += '&zip=' + encodeURIComponent(zip);

        fetch(url)
            .then(r => r.json())
            .then(d => {
                if (mine !== acSeq) return;          // a newer keystroke already won
                acUnit = (d && typeof d.unit === 'string') ? d.unit : '';
                const list = (d && Array.isArray(d.suggestions)) ? d.suggestions : [];
                acRender(list.filter(s => s && s.line));
            })
            .catch(() => { if (mine === acSeq) acClose(); });
    }

    if (acInput && acList) {
        acInput.addEventListener('input', () => {
            const v = acInput.value.trim();
            clearTimeout(acTimer);
            /* Don't re-query the exact string we just filled in — that answer
               is on screen and the call would only cost money to confirm it. */
            if (v.length < AC_MIN_CHARS || v === acPicked) { acClose(); return; }
            acTimer = setTimeout(() => acQuery(v), AC_DEBOUNCE_MS);
        });

        acInput.addEventListener('keydown', (e) => {
            if (acList.hidden) {
                /* ArrowDown on a closed list re-opens the last one rather than
                   making the visitor retype a character to see it again. */
                if (e.key === 'ArrowDown' && acItems.length) { acRender(acItems); e.preventDefault(); }
                return;
            }
            if (e.key === 'ArrowDown')      { e.preventDefault(); acHighlight((acActive + 1) % acItems.length); }
            else if (e.key === 'ArrowUp')   { e.preventDefault(); acHighlight((acActive - 1 + acItems.length) % acItems.length); }
            else if (e.key === 'Enter')     {
                /* Only swallow Enter when a suggestion is actually highlighted.
                   Otherwise it must submit the form — someone who typed their
                   address in full and hit Enter is done, and eating that
                   keystroke would look like the button is broken. */
                if (acActive >= 0) { e.preventDefault(); acChoose(acActive); }
                else acClose();
            }
            else if (e.key === 'Escape')    { e.preventDefault(); acClose(); }
            else if (e.key === 'Tab')       { acClose(); }
        });

        acInput.addEventListener('blur', () => acClose());
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

    /* Steppers.
       `stepperSet` holds one setter per stepper so the prefill path can move a
       value the same way a click does — clamped, re-rendered, and pushed into
       state through the same onChange. Writing data-value directly from outside
       would leave the visible number and the button disabled-states stale. */
    const stepperSet = {};

    /* `data-step` defaults to 1. Bathrooms use 0.5 — the convention listings are
       written in, so customers are already fluent in it. Values are held as
       numbers, not integers, and snapped back onto the step grid after every
       arithmetic op so a run of clicks cannot drift into 1.4999999999999998.
       `format` is optional and controls the label only, never the value. */
    function initStepper(elId, valueId, onChange, format) {
        const el = $(elId);
        const valEl = $(valueId);
        if (!el) return;
        const min  = parseFloat(el.getAttribute('data-min'));
        const max  = parseFloat(el.getAttribute('data-max'));
        const step = parseFloat(el.getAttribute('data-step')) || 1;

        const snap = v => Math.round(v / step) * step;
        const read = () => parseFloat(el.getAttribute('data-value'));

        function render() {
            const v = read();
            valEl.textContent = format ? format(v, max) : String(v);
            el.querySelector('[data-dir="-1"]').disabled = v <= min;
            el.querySelector('[data-dir="1"]').disabled  = v >= max;
        }
        function apply(v) {
            v = Math.max(min, Math.min(max, snap(v)));
            el.setAttribute('data-value', String(v));
            render();
            onChange(v);
        }
        el.querySelectorAll('.stepper__btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const dir = parseInt(btn.getAttribute('data-dir'), 10);
                apply(read() + dir * step);
            });
        });
        stepperSet[elId] = apply;
        render();
        onChange(read());
    }

    initStepper('stepper-bedrooms', 'bedrooms-value', v => { state.bedrooms = v; },
                v => bedroomsLabel(v).replace(' BR', ''));
    initStepper('stepper-bathrooms', 'bathrooms-value', v => { state.bathrooms = v; });
    /* "3+" at the ceiling, read from the element's own data-max so the label
       cannot drift from the range the buttons actually allow. */
    initStepper('stepper-levels', 'levels-value', v => { state.levels = v; },
                (v, max) => v >= max ? v + '+' : String(v));

    /* Service + condition radios */
    buildForm.querySelectorAll('input[name="service"]').forEach(r => {
        r.addEventListener('change', () => {
            if (!r.checked) return;
            state.service = r.value;
            syncAddonsToService();   // Move Out hides the toggles — don't leave them armed
        });
    });
    /* CONDITION IS DERIVED, NOT ASKED.
       ---------------------------------------------------------------
       The customer answers two things they actually know — when it was last
       cleaned professionally, and whether there are pets — and Serve translates
       that into the light/standard/heavy the engine prices on.

       The old form asked for the grade directly. That handed a professional
       assessment to the person least able to make it, and priced the answer:
       under-reporting was rewarded, so honest customers paid more than
       optimistic ones for the same home.

       The mapping is deliberately conservative. Where the two inputs disagree,
       it rounds UP — a light home with pets prices as standard rather than
       light. Under-quoting is the expensive error: it is absorbed on the job,
       shows up as a rushed clean, and the customer's memory of it is a bad
       clean rather than a cheap one. */
    const CONDITION_FROM = {
        recent: { no: 'light',    yes: 'standard' },
        months: { no: 'standard', yes: 'standard' },
        long:   { no: 'heavy',    yes: 'heavy'    },
    };

    function deriveCondition() {
        const last = state.lastClean || 'months';
        const pets = state.hasPets ? 'yes' : 'no';
        const row  = CONDITION_FROM[last] || CONDITION_FROM.months;
        state.condition = row[pets] || 'standard';
    }

    buildForm.querySelectorAll('input[name="last_clean"]').forEach(r => {
        r.addEventListener('change', () => {
            if (!r.checked) return;
            state.lastClean = r.value;
            deriveCondition();
        });
    });
    buildForm.querySelectorAll('input[name="has_pets"]').forEach(r => {
        r.addEventListener('change', () => {
            if (!r.checked) return;
            state.hasPets = r.value === 'yes';
            deriveCondition();
        });
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
            levels:      state.levels,
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
        /* The LIVE badge tracks rendered slots, not the block's visibility. In
           'loading' the block is already on screen with nothing in it, and a
           badge there would be advertising a feed that has not answered yet. */
        $('scheduler-live').hidden     = mode !== 'scheduler';
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
        /* pets_flag is sent again as of 2026-09-05, and this time it means
           something. It was omitted while nothing asked about pets — FALSE would
           have read as "asked, no pets" when nobody was asked. The build step now
           puts the question directly, so `false` is a real answer from the person
           who would know, rather than a keyword search over prose that may never
           mention the cat.

           customer_notes stays absent: still collected after reservation. */
        p.pets_flag  = state.hasPets;
        /* The answerable input recorded alongside the grade it produced. Without
           it a heavy job is unexplainable after the fact — and it is what a
           future model would learn the mapping from. */
        p.last_clean = state.lastClean;
        /* A2P 10DLC consent. Sent as "yes" or "" — NEVER "no".
           The LEADS upsert fills blank cells only, so a "no" written today would
           permanently block a real opt-in on a later booking. Blank already means
           "no consent on record", which is the same thing legally and stays
           upgradeable. The timestamp is stamped by the webhook, not here: a
           server clock is the defensible one if consent is ever challenged. */
        p.sms_transactional = $('sms-transactional').checked ? 'yes' : '';
        p.sms_promotional   = $('sms-promotional').checked   ? 'yes' : '';
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
                ? "You're on the schedule for " + slotLabel() +
                  ". Serve is coordinating with the vendor network \u2014 we'll reach out shortly to confirm your exact arrival window."
                : "Serve is coordinating with the vendor network. We'll reach out shortly to confirm your exact arrival window.";
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
        /* Signature first, then the booking. signQuote never rejects and never
           blocks: an unreachable or unbound signer resolves null, `quote_sig`
           is simply absent, and the reservation proceeds exactly as it did
           before signatures existed. */
        signQuote(p).then(proof => {
            if (proof) {
                p.quote_sig     = proof.sig;
                p.quote_scope   = proof.scope;
                p.quote_version = proof.version;
            }
            return postReservation(p);
        }).then(result => {
            clearTimeout(slowNotice);
            if (result.confirmed) {
                setView('confirmed');
                armPostBookingNotes(p.submission_id);
                return;
            }
            console.error('Reservation NOT confirmed.', p.submission_id, result.error);
            showReserveFailure(p, result.error);
        });
    });

    /**
     * "Anything we should know?" — asked on the confirmation screen.
     *
     * The same question used to sit in the reserve step. Before the spot is
     * claimed a textarea is a reason to hesitate; after it is claimed,
     * hesitating is free. So it moved rather than disappeared.
     *
     * Armed ONLY on a confirmed booking, because it needs the submission_id of
     * a row that actually exists — that id is how the webhook finds the job
     * these notes belong to. Arming it on a failed booking would post notes
     * against nothing.
     *
     * Nothing here can hurt the booking. The row is written, the screen already
     * says so, and a failure at this point is answered with "text us instead"
     * rather than an error — the customer has already got what they came for.
     */
    function armPostBookingNotes(submissionId) {
        const box    = $('pb-notes');
        const send   = $('pb-send');
        const status = $('pb-status');
        if (!box || !send || !status || !submissionId) return;

        let sending = false;

        send.addEventListener('click', function () {
            const notes = box.value.trim();
            if (sending) return;
            if (!notes) { box.focus(); return; }

            sending = true;
            send.disabled = true;
            send.textContent = 'Sending…';
            status.textContent = '';

            /* Deliberately NOT postReservation(): that retries, and a retry here
               would be pointless. The webhook fills a blank cell only, so a
               second arrival is ignored anyway. */
            fetch(SHEETS_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    event:          'job_notes',
                    event_type:     'job_notes',
                    submission_id:  submissionId,   // the booking these belong to
                    customer_notes: notes,
                    submitted_at:   new Date().toISOString(),
                }),
            })
                .then(res => res.json().catch(() => { throw new Error('HTTP ' + res.status); }))
                .then(body => {
                    if (!body || body.status !== 'ok') throw new Error('not saved');
                    box.disabled = true;
                    send.hidden = true;
                    status.textContent = 'Got it — your cleaner will see this before they arrive.';
                })
                .catch(err => {
                    console.warn('Post-booking notes failed to send.', err);
                    sending = false;
                    send.disabled = false;
                    send.textContent = 'Try again';
                    /* Their booking is safe and they know it. Give them a route
                       that does not depend on this working. */
                    status.textContent =
                        'That didn’t send. Your booking is still confirmed — ' +
                        'email management@servecos.com and we’ll add it.';
                });
        });
    }

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
                "We couldn't confirm your booking. Please email management@servecos.com and we'll book you in.";
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
            link.href = 'mailto:management@servecos.com' +
                        '?subject=' + encodeURIComponent('Booking that did not go through — ' + payload.name) +
                        '&body='    + encodeURIComponent(body);
        }

        const ref = $('failed-ref');
        if (ref) ref.textContent = payload.submission_id;

        setView('failed');
    }

    /* ========================================================
       Custom quote — the edge-case lane (R9, widened 2026-09-06)
       ========================================================
       Two doors in. 5+ bedrooms lands here on its own because the flat-rate
       table stops there; the link under the Build step is for the scope a
       calculator has no business pricing — half the home, an empty move-out,
       one room that needs three hours.

       The scope box is what makes the second door worth having. Without it the
       request arrives as an email address, and the reply has to be a question
       instead of a number. It rides in `customer_notes`, which the booking
       email already prints and which lands nowhere on the EVENTS row — the
       email is the operative channel for these, and it is read the same day.
       ======================================================== */
    if ($('build-custom')) {
        $('build-custom').addEventListener('click', () => setView('overflow'));
    }
    $('overflow-back').addEventListener('click', () => setView(1));
    $('overflow-submit').addEventListener('click', () => {
        const emailEl = $('overflow-email');
        if (!isEmail(emailEl.value)) { emailEl.classList.add('error'); emailEl.focus(); return; }
        emailEl.classList.remove('error');
        const p = basePayload('custom_quote_request', 'custom_quote_request');
        p.name  = $('overflow-name').value.trim();
        p.email = emailEl.value.trim();
        p.phone = $('overflow-phone').value.trim();
        p.customer_notes = $('overflow-notes').value.trim();
        p.unit_label = unitLabel();
        postToSheets(p);
        $('overflow-done').hidden = false;
        ['overflow-name', 'overflow-email', 'overflow-phone', 'overflow-notes', 'overflow-submit']
            .forEach(id => { $(id).disabled = true; });
    });

    /* ========================================================
       PREFILL — arriving from /pricing, /services, or a homepage teaser

       Published price tables are only useful if clicking a number puts that
       configuration into the calculator. Both routes end up here:

         cross-page   /?beds=2&baths=1&service=deep#quote
         same-page    window.ServeQuote.applyPrefill(...) from a teaser row

       WHY THIS LANDS ON BUILD, NOT PRICE, WHEN THERE IS NO ZIP
       ------------------------------------------------------------
       The build spec asked for the Price step directly. It cannot safely go
       there without a ZIP. `state.zip` gates two separate things: coverage
       (an unlisted ZIP must get the waitlist, never a price) and the $25
       extended-area fee. Jumping to Price with `zip: ''` would quote every
       visitor the CORE rate, and — worse — Step 3 would then submit a booking
       with no ZIP at all, which breaks `property_key`, skips the PROPERTIES
       write, and can put an out-of-area job on the schedule.

       So: everything else is filled in, and the visitor lands on Build with
       one field left and the cursor already in it. If a ZIP IS resolvable —
       already typed this session, or passed as `&zip=` on the link — it goes
       straight to Price as specified.
       ======================================================== */

    /* The published tables speak in services; the calculator speaks in a
       service plus a frequency. `recurring` is not a third service type — it is
       a First Clean with a plan attached, so it maps to biweekly, the middle
       option and the one most recurring customers pick. */
    const PREFILL_SERVICES = {
        deep:      { service: 'first_clean', frequency: 'once' },
        recurring: { service: 'first_clean', frequency: 'biweekly' },
        moveinout: { service: 'move_out',    frequency: 'once' },
    };

    function applyPrefill(cfg) {
        cfg = cfg || {};
        try {
            if (cfg.zip && /^\d{5}$/.test(String(cfg.zip))) {
                zipInput.value = String(cfg.zip);
                evaluateZip();
            }

            if (cfg.beds  != null && stepperSet['stepper-bedrooms'])  stepperSet['stepper-bedrooms'](Number(cfg.beds));
            if (cfg.baths != null && stepperSet['stepper-bathrooms']) stepperSet['stepper-bathrooms'](Number(cfg.baths));

            const map = PREFILL_SERVICES[cfg.service];
            if (map) {
                const radio = buildForm.querySelector('input[name="service"][value="' + map.service + '"]');
                if (radio && !radio.checked) {
                    radio.checked = true;
                    /* Dispatch rather than assigning state directly: the change
                       handler is what clears add-ons when the service is not a
                       First Clean, and skipping it leaves them armed. */
                    radio.dispatchEvent(new Event('change', { bubbles: true }));
                }
                state.frequency = map.frequency;
            }

            if (typeof serveRetirePulse === 'function') serveRetirePulse();

            /* 5+ bedrooms has no flat rate — send it down the same custom-quote
               path the form would, rather than to a price that does not exist. */
            if (state.bedrooms >= PRICING.OVERFLOW_BEDROOMS) { setView('overflow'); return; }

            if (state.zip.length === 5 && state.tier !== 'unknown') {
                syncAddonsToService();
                recompute();
                renderPrice();
                setView(2);
                prefetchAvailability();
            } else {
                setView(1);
                zipInput.focus({ preventScroll: true });
            }
        } catch (err) {
            /* A prefill is a convenience. If anything about it fails the
               calculator must still be sitting there, usable, at Step 1.
               setView is explicit as of 2026-09-06: Step 1 stopped being the
               default view when Find Your Home went in front of it, so a throw
               that used to land on Build now lands on the address search — with
               a half-applied config sitting invisibly behind it. Someone who
               followed a link carrying their specs has already answered these
               questions; put them where their answers are. */
            console.warn('Prefill could not be applied.', err);
            setView(1);
        }
    }

    /* The only surface the shared module talks to. Absent on /pricing and
       /services — where this IIFE returns early — which is exactly how the
       shared click handler tells a same-page prefill from a cross-page one. */
    window.ServeQuote = { applyPrefill: applyPrefill };

    (function readPrefillParams() {
        let params;
        try { params = new URLSearchParams(location.search); } catch (_) { return; }
        const beds    = params.get('beds');
        const baths   = params.get('baths');
        const service = params.get('service');
        const zip     = params.get('zip');
        if (beds == null && baths == null && service == null) return;   // nothing to do

        applyPrefill({
            beds:    beds  != null && /^\d+$/.test(beds)  ? parseInt(beds, 10)  : null,
            baths:   baths != null && /^\d+$/.test(baths) ? parseInt(baths, 10) : null,
            service: service,
            zip:     zip,
        });
    })();

    /* --- Utils --- */
    function isEmail(v) {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((v || '').trim());
    }

    /* Clear error styling on input */
    document.querySelectorAll('.flow-input').forEach(el => {
        el.addEventListener('input', () => el.classList.remove('error'));
    });
})();


/* ============================================================
   SERVE — SHARED PAGE MODULE
   Loaded by index.html, pricing.html and services.html.

   Everything below is page-agnostic: each block looks for its own hook and
   does nothing at all when that hook is absent. That is what lets one
   script.js serve three pages with no per-page bundles and no build step.

   Selectors here are classes and data-attributes rather than ids, on purpose.
   tests/static-checks.test.js asserts that every id script.js looks up exists
   in index.html — an id that only lived on /pricing would fail a test that is
   otherwise doing useful work.
   ============================================================ */


/* ------------------------------------------------------------
   1. CTA pulse

   A slow halo on the two entry-point CTAs. It retires the moment the visitor
   touches the quote form: the animation's whole job is "notice me", and once
   noticed it is only motion competing with the form.
   ------------------------------------------------------------ */
function serveRetirePulse() {
    document.querySelectorAll('.serve-pulse').forEach(el => el.classList.add('is-retired'));
}

(function initPulseRetirement() {
    const quote = document.querySelector('#quote');
    if (!quote) return;
    ['click', 'input', 'change'].forEach(evt =>
        quote.addEventListener(evt, serveRetirePulse, { once: true }));
})();


/* ------------------------------------------------------------
   2. Explainer bubbles

   A phrase inside How Serve Works that opens a short panel saying more. It
   exists because the three-pillar block above that section was repeating the
   steps; two of those ideas were folded into the step that already made the
   point, and the one that needed elaborating rather than compressing — the
   vendor model — moved behind the phrase it explains.

   PROGRESSIVE ENHANCEMENT, AND NOT ONLY IN NAME. Nothing a visitor needs in
   order to book lives inside a bubble. If this block never runs, the trigger
   is a button that does nothing and the paragraph around it still reads as a
   complete sentence.

   Targets are resolved through aria-controls rather than looked up by id.
   That is the same attribute a screen reader follows, so the accessible
   wiring and the script's wiring cannot drift apart — and it keeps this file
   free of id lookups, which is the rule the rest of this module follows.
   ------------------------------------------------------------ */
(function initExplainers() {
    const triggers = [...document.querySelectorAll('.pop-trigger')];
    if (!triggers.length) return;

    const panelOf = (t) => document.getElementById(t.getAttribute('aria-controls'));

    function close(trigger) {
        const panel = panelOf(trigger);
        if (panel) panel.hidden = true;
        trigger.setAttribute('aria-expanded', 'false');
    }

    function closeAll(except) {
        triggers.forEach(t => { if (t !== except) close(t); });
    }

    triggers.forEach(trigger => {
        const panel = panelOf(trigger);
        if (!panel) return;                     // a trigger with no panel stays inert

        trigger.addEventListener('click', (e) => {
            e.stopPropagation();                // don't trip the outside-click handler below
            const open = trigger.getAttribute('aria-expanded') === 'true';
            closeAll(trigger);
            panel.hidden = open;
            trigger.setAttribute('aria-expanded', open ? 'false' : 'true');
        });

        /* Clicks inside the panel are not "outside" it. Without this, reaching
           for the close button would be handled twice — once as a dismissal
           and once as the button itself. */
        panel.addEventListener('click', (e) => e.stopPropagation());

        const closeBtn = panel.querySelector('.pop-bubble__close');
        if (closeBtn) closeBtn.addEventListener('click', () => {
            close(trigger);
            trigger.focus();                    // don't strand the keyboard somewhere gone
        });
    });

    /* Anywhere else on the page dismisses it, and so does Escape — the two
       things a person tries first when a small panel is in the way. */
    document.addEventListener('click', () => closeAll(null));
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        const open = triggers.filter(t => t.getAttribute('aria-expanded') === 'true')[0];
        if (!open) return;
        close(open);
        open.focus();
    });
})();


/* ------------------------------------------------------------
   2. Published price ranges

   Computed by calling the live computeQuote — the same function behind the
   calculator. Nothing here is a hardcoded number, so a published range cannot
   drift from the quote a visitor is then shown. Change PRICING and every table
   on the site moves with it.

   Ranges are quoted at a CORE ZIP. Extended-area ZIPs add
   PRICING.EXTENDED_ZIP_FEE per visit, which the calculator applies once a real
   ZIP is entered; the pages say so in prose rather than publishing two tables.

   THE PUBLISHED TABLES QUOTE THE NEUTRAL CASE, NOT A REAL NEIGHBOURHOOD.

   They used to be anchored on a specific ZIP — 02116 until 2026-08-20, then
   02130. Both attempts were proxies for "adds nothing", and both were fragile:
   02116 turned out to carry a 1.30x factor, which would have raised every
   published price on three pages by a third as a pure side effect. 02130 was
   genuinely neutral only while 19 ZIPs shared an identical bucket value.

   Once factors became continuous (2026-08-21) no ZIP is exactly 1.00 any more,
   so the neutral case is now stated outright instead of being borrowed from a
   neighbourhood that happened to sit near it. The published range is what a
   typical Greater Boston home of that size pays; a visitor's own ZIP then moves
   it up or down, and the pages say so in prose.

   SERVE_RANGE_ZIP still supplies the CORE tier, so no travel fee is baked in.
   Its size factor and parking tier are deliberately NOT used.
   ------------------------------------------------------------ */
const SERVE_RANGE_ZIP = '02130';        /* CORE tier only — supplies zipFee = 0 */
const SERVE_RANGE_GEO = { parkTier: 'P0', factor: 1, park: 0, mapped: false };

const SERVE_SIZES = [
    { key: 'studio', label: 'Studio',    beds: 0, baths: 1 },
    { key: '1br1ba', label: '1BR / 1BA', beds: 1, baths: 1 },
    { key: '2br1ba', label: '2BR / 1BA', beds: 2, baths: 1 },
    { key: '2br2ba', label: '2BR / 2BA', beds: 2, baths: 2 },
    { key: '3br2ba', label: '3BR / 2BA', beds: 3, baths: 2 },
];

const SERVE_SERVICES = [
    { key: 'deep',      label: 'First Clean',   sub: '50% off' },
    { key: 'recurring', label: 'Recurring',     sub: 'per visit' },
    { key: 'moveinout', label: 'Move In / Out', sub: 'empty home' },
];

/**
 * Low/high range for one cell, in whole dollars. Returns null when a
 * combination has no flat rate, so a cell renders an em dash rather than "$0".
 *
 * What the two ends mean differs by column, and the pages say which:
 *   deep / moveinout  — lightly lived-in vs. heavy-duty condition
 *   recurring         — weekly (cheapest per visit) vs. monthly
 */
function serveRange(beds, baths, service) {
    if (typeof computeQuote !== 'function') return null;
    const q = (condition, svc) => computeQuote({
        bedrooms: beds, bathrooms: baths, service: svc, condition: condition,
        addonFridge: false, addonOven: false, zip: SERVE_RANGE_ZIP,
        geo: SERVE_RANGE_GEO, frequency: 'once',
    });
    try {
        if (service === 'deep')      return [q('light', 'first_clean').displayPrice, q('heavy', 'first_clean').displayPrice];
        if (service === 'moveinout') return [q('light', 'move_out').displayPrice,    q('heavy', 'move_out').displayPrice];
        if (service === 'recurring') {
            const f = q('standard', 'first_clean').freqSteady;
            return [f.weekly, f.monthly];
        }
    } catch (_) { /* fall through to null */ }
    return null;
}

function serveRangeText(range) {
    if (!range) return '—';
    return range[0] === range[1] ? '$' + range[0] : '$' + range[0] + '–$' + range[1];
}

/* One price cell: a real button, so it is keyboard-reachable and announced as
   actionable, carrying the config it should load into the calculator. */
function servePriceCellHtml(size, service) {
    const range = serveRange(size.beds, size.baths, service.key);
    /* data-label carries the column header down to narrow screens, where the
       table collapses to stacked cards and the <thead> is hidden. */
    const label = ' data-label="' + service.label + '"';
    if (!range) return '<td class="serve-cell serve-cell--empty"' + label + '>—</td>';
    const spoken = serveRangeText(range).replace('–', ' to ');
    return '<td class="serve-cell"' + label + '>' +
        '<button type="button" class="serve-prefill serve-cell__btn"' +
        ' data-beds="' + size.beds + '" data-baths="' + size.baths + '" data-service="' + service.key + '"' +
        ' aria-label="' + size.label + ', ' + service.label + ', ' + spoken +
        '. Get an instant quote for this home.">' +
        '<span class="serve-cell__price">' + serveRangeText(range) + '</span>' +
        '<span class="serve-cell__go" aria-hidden="true">Get my price →</span>' +
        '</button></td>';
}

/* Full 5 x 3 table — /pricing */
(function renderFullPriceTable() {
    const body = document.querySelector('[data-serve-price-rows]');
    if (!body) return;
    body.innerHTML = SERVE_SIZES.map(size =>
        '<tr><th scope="row" class="serve-size">' + size.label + '</th>' +
        SERVE_SERVICES.map(svc => servePriceCellHtml(size, svc)).join('') +
        '</tr>').join('');
})();

/* Three-row teaser — homepage. First Clean only: it is the entry product and
   the only number a first-time visitor is actually choosing between. */
(function renderTeaserTable() {
    const body = document.querySelector('[data-serve-teaser-rows]');
    if (!body) return;
    const wanted = ['1br1ba', '2br1ba', '3br2ba'];
    body.innerHTML = SERVE_SIZES.filter(s => wanted.indexOf(s.key) !== -1).map(size =>
        '<tr><th scope="row" class="serve-size">' + size.label + '</th>' +
        servePriceCellHtml(size, SERVE_SERVICES[0]) +
        '</tr>').join('');
})();

/* Headline band — the widest honest First Clean span across the published
   sizes, so the first thing on /pricing is a number rather than a preamble. */
(function renderHeadlineBand() {
    const el = document.querySelector('[data-serve-headline-range]');
    if (!el) return;
    const lows = [], highs = [];
    SERVE_SIZES.forEach(s => {
        const r = serveRange(s.beds, s.baths, 'deep');
        if (r) { lows.push(r[0]); highs.push(r[1]); }
    });
    if (!lows.length) return;
    el.textContent = '$' + Math.min.apply(null, lows) + '–$' + Math.max.apply(null, highs);
})();

/* Add-on prices — /services. Read from PRICING for the same reason the tables
   are: the calculator sells these as toggles, and a page that names a different
   number than the toggle does is worse than a page that names none. */
(function renderAddonPrices() {
    document.querySelectorAll('[data-serve-addon]').forEach(el => {
        const key = el.getAttribute('data-serve-addon');
        if (typeof PRICING === 'object' && PRICING.ADDONS && PRICING.ADDONS[key] != null) {
            el.textContent = '$' + PRICING.ADDONS[key];
        }
    });
})();

/* Per-card typical range — /services */
(function renderCardRanges() {
    document.querySelectorAll('[data-serve-card-range]').forEach(el => {
        const svc = el.getAttribute('data-serve-card-range');
        const lows = [], highs = [];
        SERVE_SIZES.forEach(s => {
            const r = serveRange(s.beds, s.baths, svc);
            if (r) { lows.push(r[0]); highs.push(r[1]); }
        });
        if (lows.length) {
            el.textContent = '$' + Math.min.apply(null, lows) + '–$' + Math.max.apply(null, highs);
        }
    });
})();


/* ------------------------------------------------------------
   3. Scope of work — the canonical object

   Deliberately a standalone data structure rather than markup. The room-by-room
   matrix on /services renders from it today; the partner job brief and the
   photo-verification shot list are meant to render from it next. One source,
   three consumers — a task added here appears everywhere it should.

     1 = included     0 = not included     2 = paid add-on

   Fridge and oven interiors are coded 2 on First Clean because the calculator
   sells them there as $45 / $40 toggles (PRICING.ADDONS), and 1 on move-in/out
   because that service bundles them into its multiplier. Linen change is 1 on
   recurring (free, per the plan), 0 on First Clean, and 0 on move-in/out, where
   there are no beds to make.
   ------------------------------------------------------------ */
const SERVE_SCOPE = [
    { group: 'Kitchen', tasks: [
        { task: 'Counters, backsplash, and sink degreased', deep: 1, recurring: 1, moveinout: 1 },
        { task: 'Exterior of all appliances',               deep: 1, recurring: 1, moveinout: 1 },
        { task: 'Stovetop and range hood',                  deep: 1, recurring: 1, moveinout: 1 },
        { task: 'Inside the fridge',                        deep: 2, recurring: 0, moveinout: 1 },
        { task: 'Inside the oven',                          deep: 2, recurring: 0, moveinout: 1 },
        { task: 'Inside cabinets and drawers',              deep: 0, recurring: 0, moveinout: 1 },
    ]},
    { group: 'Bathrooms', tasks: [
        { task: 'Toilet, tub, and sink disinfected',        deep: 1, recurring: 1, moveinout: 1 },
        { task: 'Mirrors and fixtures polished',            deep: 1, recurring: 1, moveinout: 1 },
        { task: 'Shower glass and tile detailed',           deep: 1, recurring: 0, moveinout: 1 },
        { task: 'Grout scrubbed and brightened',            deep: 1, recurring: 0, moveinout: 1 },
    ]},
    { group: 'Bedrooms &amp; living', tasks: [
        { task: 'Surfaces dusted, floors vacuumed',         deep: 1, recurring: 1, moveinout: 1 },
        { task: 'Under and behind movable furniture',       deep: 1, recurring: 0, moveinout: 1 },
        { task: 'Closets and shelving',                     deep: 0, recurring: 0, moveinout: 1 },
        { task: 'Linen change',                             deep: 0, recurring: 1, moveinout: 0 },
    ]},
    { group: 'Throughout', tasks: [
        { task: 'Floors vacuumed and mopped',               deep: 1, recurring: 1, moveinout: 1 },
        { task: 'Baseboards and door frames',               deep: 1, recurring: 0, moveinout: 1 },
        { task: 'Switch plates and handles',                deep: 1, recurring: 0, moveinout: 1 },
        { task: 'Interior windows, sills, and tracks',      deep: 0, recurring: 0, moveinout: 1 },
    ]},
];

const SERVE_SCOPE_MARKS = {
    1: { glyph: '✓', label: 'Included',     cls: 'is-yes' },
    2: { glyph: '+',      label: 'Paid add-on',  cls: 'is-addon' },
    0: { glyph: '·', label: 'Not included', cls: 'is-no' },
};

(function renderScopeMatrix() {
    const body = document.querySelector('[data-serve-scope-rows]');
    if (!body) return;
    body.innerHTML = SERVE_SCOPE.map(group =>
        '<tr class="serve-matrix__group"><th scope="colgroup" colspan="4">' + group.group + '</th></tr>' +
        group.tasks.map(t =>
            '<tr><th scope="row" class="serve-matrix__task">' + t.task + '</th>' +
            ['deep', 'recurring', 'moveinout'].map(k => {
                const m = SERVE_SCOPE_MARKS[t[k]] || SERVE_SCOPE_MARKS[0];
                return '<td class="serve-matrix__mark ' + m.cls + '">' +
                       '<span aria-hidden="true">' + m.glyph + '</span>' +
                       '<span class="serve-sr">' + m.label + '</span></td>';
            }).join('') +
            '</tr>').join('')
    ).join('');
})();


/* ------------------------------------------------------------
   4. Prefill links

   Any .serve-prefill element carries the configuration it should load. On the
   homepage window.ServeQuote exists and the calculator is set directly; on
   /pricing and /services it does not, so the same element navigates to the
   homepage carrying the config as query params.

   Existing query params are preserved — losing src here would silently break
   attribution for every visitor who arrived on a tagged poster or QR link and
   then clicked a price.
   ------------------------------------------------------------ */
(function initPrefillLinks() {
    const nodes = document.querySelectorAll('.serve-prefill');
    if (!nodes.length) return;

    function configOf(el) {
        return {
            beds:    el.getAttribute('data-beds'),
            baths:   el.getAttribute('data-baths'),
            service: el.getAttribute('data-service'),
        };
    }

    function crossPageUrl(cfg) {
        let params;
        try { params = new URLSearchParams(location.search); } catch (_) { params = new URLSearchParams(); }
        if (cfg.beds    != null) params.set('beds', cfg.beds);
        if (cfg.baths   != null) params.set('baths', cfg.baths);
        if (cfg.service != null) params.set('service', cfg.service);
        const qs = params.toString();
        return '/' + (qs ? '?' + qs : '') + '#quote';
    }

    nodes.forEach(el => {
        el.addEventListener('click', function (e) {
            const cfg = configOf(el);
            e.preventDefault();
            if (window.ServeQuote && typeof window.ServeQuote.applyPrefill === 'function') {
                window.ServeQuote.applyPrefill(cfg);
            } else {
                location.href = crossPageUrl(cfg);
            }
        });
    });
})();


/* ------------------------------------------------------------
   5. Arrival cue

   A hash jump moves the page with no explanation. A brief highlight on the
   destination heading answers "why did it move" without a scroll animation
   anyone has to sit through.
   ------------------------------------------------------------ */
(function initArrivalCue() {
    let reduced = false;
    try { reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) {}
    if (reduced) return;

    function cue() {
        const id = (location.hash || '').slice(1);
        if (!id) return;
        let target = null;
        try {
            target = (window.CSS && typeof CSS.escape === 'function')
                ? document.querySelector('#' + CSS.escape(id))
                : document.getElementById(id);
        } catch (_) { return; }
        if (!target) return;
        /* #quote holds five step panels and only one is ever visible, so the
           first heading in DOM order is usually inside a hidden one. Prefer a
           heading that is actually on screen; offsetParent is null for anything
           display:none. */
        const headings = [].slice.call(target.querySelectorAll('h1, h2, h3'));
        const heading = headings.filter(h => h.offsetParent !== null)[0] || headings[0] || target;
        heading.classList.remove('serve-arrive');
        void heading.offsetWidth;              /* restart the animation on a repeat jump */
        heading.classList.add('serve-arrive');
        setTimeout(function () { heading.classList.remove('serve-arrive'); }, 1600);
    }

    window.addEventListener('hashchange', cue);
    if (location.hash) setTimeout(cue, 260);   /* let the browser's own jump land first */
})();
