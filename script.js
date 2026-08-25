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
   SERVE PRICING ENGINE

   The whole region from here to the ATTRIBUTION banner is the engine. Test
   harnesses slice it out and run it, anchoring on `const WORK_RATE` — if you
   move that declaration, update tests/geo-pricing.test.js and
   tests/pricing-and-services.test.js with it.

   HOW A PRICE IS BUILT, in order:

     size base      BASE + beds + baths + levels        the home
     x geo          only the AREA_SHARE of it            the neighbourhood
     x condition    one-time services only               how dirty
     x service      derived from work + margin           what they bought
     + flat fees    parking, extended area, add-ons      never scaled
     x frequency    recurring track only

   WHAT IS MEASURED AND WHAT IS NOT — read before tuning anything.

   MEASURED, from real timed jobs:
     PER_LEVEL          a 3BR/2BA biweekly went 4h to 6h when it gained a
                        storey. Same home, same service, one variable. The
                        cleanest number in this file.
     WORK_MODEL.move    one 10-12h move-in on a 3BR/2BA
     WORK_MODEL.biweekly  one 4h visit on a one-storey 3BR/2BA
     WORK_RATE          solved from one 7h deep clean on a 2BR/1BA

   NOT MEASURED:
     BASE, PER_BEDROOM, PER_BATHROOM, HALF_BATHROOM — these arrived whole in
       the 2026-07-20 rebuild, from a spec lost to a truncated paste. The 2:1
       bathroom-to-bedroom ratio is convention, not evidence. Two deep cleans
       at different sizes would test it; there is only one.
     WORK_MODEL.weekly and .monthly — from the frequency curve, no observations.
     AREA_SHARE — a judgement about how much of a clean scales with floor area.

   The one genuinely data-backed input is serve-geo-data.js, and it yields only
   RELATIVE factors: it knows a Back Bay 2BR is larger than a typical 2BR, not
   what an hour of cleaning is worth.

   JOBS.duration_min is what retires the guesses. Until then, a change here is
   a business decision, not a correction.
   ============================================================ */

/* ============================================================
   THE WORK MODEL — what a job costs in labour, before any price exists.

   Prices are DERIVED from these three blocks:

       hours = size base x work multiplier / WORK_RATE
       price = hours x TARGET_WAGE / (1 - margin)

   Kept separate on purpose. A work multiplier is a claim about reality that
   a stopwatch can confirm or refute; a margin is a business decision. When
   the two are fused into one "price multiplier" — as they were until
   2026-08-24 — neither can be checked, and they drift apart silently. That
   is how recurring ended up billing $33/cleaner-hour while move-out billed
   $56 with nobody choosing it.

   TO RE-TUNE: change WORK_MODEL when you measure a job, change MARGIN when
   you make a pricing decision. Never edit the multipliers they produce.
   ============================================================ */

/* Size-base dollars of work per cleaner-hour. Solved from the one measured
   deep clean: a 2BR/1BA (size base $282) at DEEP 1.40 took 7 hours.
   EVERY hours figure in this system is anchored here — if that job was
   unusual, all of it moves. */
const WORK_RATE = 56.4;

/* What one cleaner-hour must earn the contractor. A floor, not a target. */
const TARGET_WAGE = 35;

/* Work relative to the size base. Measured where it says measured.
     deep      the 7h anchor — true by construction, never independently tested
     move      one 10-12h job on a 3BR/2BA
     biweekly  one 4h job on a ONE-STOREY 3BR/2BA
     weekly    NOT MEASURED — from the frequency curve below
     monthly   NOT MEASURED — from the frequency curve below

   The frequency curve: every visit has a fixed part (the toilet gets cleaned
   whatever the interval) plus accumulation that grows with days elapsed. At a
   50% fixed share anchored on the measured biweekly, 7/14/30 days gives
   0.44 / 0.59 / 0.93. Monthly stays under the deep-clean ceiling of 1.40,
   which it must — no home gets dirtier than dirty. */
const WORK_MODEL = {
    deep:     1.40,
    move:     1.63,
    weekly:   0.44,
    biweekly: 0.59,
    monthly:  0.93,
};

/* Share of the price left after paying the contractor. Supplies, card fees
   and everything else come out of this.

   Deliberately thinnest on weekly: that cash flow is the most predictable and
   the customer the most loyal, so the discount for commitment is taken out of
   margin rather than out of the contractor. It widens through biweekly to
   monthly, whose visits are heavier and whose relationship is loosest.

   WEEKLY HAS A HARD FLOOR NEAR 15%. Weekly jobs are small, so the flat
   per-job cost — supplies plus the card fee, about $19 — is a large share of
   them. Below roughly 22% a weekly visit stops being worth running. */
const MARGIN = {
    deep:     0.33,
    move:     0.33,
    weekly:   0.25,
    biweekly: 0.33,
    monthly:  0.41,
};

function priceMultiplier(kind) {
    return WORK_MODEL[kind] * TARGET_WAGE / (WORK_RATE * (1 - MARGIN[kind]));
}

/* ------------------------------------------------------------
   LEVELS — priced as their own line, not as part of the home.

   An extra storey used to sit in the size base, which meant it was scaled by
   the neighbourhood factor, the condition factor AND the service multiplier.
   That compounded a single 2-hour measurement into 5.5 extra hours on a
   move-out, and made a second floor cost +88% on a studio against +40% on a
   4BR — because a flat dollar amount is a bigger share of a small base.

   Now it is what it actually is: a fixed number of extra cleaner-hours, set
   per service, charged at cost plus a margin of its own.

   LEVEL_HOURS is per extra storey. The biweekly 2 is measured — a 3BR/2BA
   went 4h to 6h. The rest are Uriel's ladder, and they land within half an
   hour of what the old scaling model implied, so this is mostly a change of
   MARGIN rather than of hours.

   LEVEL_MARGIN is deliberately below every service's own margin. A second
   floor is priced close to cost so a townhouse quote stays competitive —
   the same reasoning that makes weekly the thinnest plan. */
const LEVEL_HOURS = {
    weekly:   1,
    biweekly: 2,     // measured: 4h -> 6h on a 3BR/2BA
    monthly:  3,
    deep:     4,
    move:     5,
};
const LEVEL_MARGIN = 0.25;

/* A storey may never add more than this share of the job it is attached to,
   per storey. The hour ladder was set with a three-bedroom home in mind, and
   on a very small one it overshoots: a two-storey studio deep clean came out
   at 9.4 cleaner-hours, the same as a single-storey 3BR/2BA with two
   bathrooms and three bedrooms. A two-storey studio is a small loft with a
   staircase, not a house.

   The cap is measured against the service's price BEFORE the first-clean
   discount. Capping against the discounted price would bind on every home
   rather than the small ones — the discount halves the job but not the
   stairs, so the level charge is inherently large next to it. */
const LEVEL_CAP = 0.50;

/* Flat dollars for every storey beyond the first. Never scaled by geo,
   condition or the service multiplier — stairs are stairs.

   `basePrice` is that service's own per-visit price at one storey, undiscounted
   and before flat fees. It is only used for the cap. */
function levelCharge(kind, levels, basePrice) {
    const extra = Math.max(0, (levels || 1) - 1);
    if (!extra) return 0;
    const uncapped = LEVEL_HOURS[kind] * extra * TARGET_WAGE / (1 - LEVEL_MARGIN);
    const cap      = LEVEL_CAP * basePrice * extra;
    return Math.ceil(Math.min(uncapped, cap));
}

const PRICING = {
    BASE: 150,
    PER_BEDROOM: 33,
    PER_BATHROOM: 66,
    HALF_BATHROOM: 33,   // toilet + sink + mirror + floor; no shower or tub to detail

    /* PER_LEVEL is GONE from the size base as of 2026-08-25. Levels are now
       LEVEL_HOURS + LEVEL_MARGIN above — a flat per-service charge added after
       the multipliers, alongside parking and the extended-area fee. Putting a
       storey in the size base compounded it through geo, condition and the
       service multiplier, which is not how stairs work. */

    /* How much of the size base scales with FLOOR AREA rather than with fixture
       count or fixed setup. The geographic factor is applied only to this share.

       Why it exists: parcel data shows that when a ZIP's homes are larger at the
       same bed/bath/level spec, the room COUNT is identical (1.000x) and the
       rooms are simply bigger (1.354x sqft per room). So a Seaport 2BR has the
       same four rooms, one kitchen and one bathroom as an East Boston 2BR — just
       more open floor. Scaling the whole base by the geo factor charged 24% more
       for arrival, staging and a toilet, none of which grow with the home.

       0.6 is an estimate of the deep-clean time that is genuinely area-driven —
       bedrooms, living space and floors — against setup, kitchen and bathroom
       fixtures, which are not. It is a judgement, not a measurement. Raising it
       widens the geographic spread; lowering it flattens it. */
    AREA_SHARE: 0.6,

    /* THESE FIVE ARE DERIVED, NOT SET. See WORK_MODEL above — edit the work
       multiplier or the margin, never the number that comes out here. */
    DEEP_MULT:    priceMultiplier('deep'),
    MOVEOUT_MULT: priceMultiplier('move'),

    FIRST_CLEAN_FACTOR: 0.5,     // first clean = deep price x 0.5

    /* x standard, condition 1.0 — recurring never takes a condition factor */
    FREQ: {
        weekly:   priceMultiplier('weekly'),
        biweekly: priceMultiplier('biweekly'),
        monthly:  priceMultiplier('monthly'),
    },

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

/* Silent geographic adjustment, resolved from serve-geo-data.js.
 *
 * NOTHING HERE IS EVER SHOWN TO A CUSTOMER. The size factor and parking tier
 * are logged to the sheet so quote accuracy can be analysed by area later; they
 * are never rendered, never named in copy, and never sent back as a line item.
 * The customer sees one price.
 *
 * serve-geo-data.js is a separate <script> tag, so this must survive its
 * absence: a missing file, a typo'd tag on one page, or a malformed map all
 * resolve to the neutral case instead of throwing. A visitor still gets a
 * price. The `try` is load-bearing — an unloaded `const PARK_ADDER` raises a
 * ReferenceError rather than reading as undefined.
 *
 * The 10 served ZIPs with no parcel data (Brookline Village and the nine
 * EXTENDED-tier towns) land here too, by the same neutral path.
 */
const NEUTRAL_GEO = { parkTier: 'P0', factor: 1, park: 0, mapped: false };

function serveGeo(zip) {
    try {
        const g    = lookupGeo(zip);
        const park = PARK_ADDER[g.parkTier];
        if (typeof g.factor !== 'number' || typeof park !== 'number') return NEUTRAL_GEO;
        return { parkTier: g.parkTier, factor: g.factor, park: park, mapped: g.mapped };
    } catch (_) {
        return NEUTRAL_GEO;
    }
}

/**
 * Deterministic quote per spec §3.2 / §3.3. All price fields returned RAW
 * (un-rounded); apply Math.ceil at display (R11). `frequency` is 'once' or a
 * FREQ key and only affects `steadySelected`, never the one-time price.
 *
 * `bathrooms` accepts half-steps (2.5). `levels` counts floors INSIDE the unit
 * and defaults to 1. `zip` now does two jobs: the CORE / EXTENDED tier it
 * always did, and a silent zone + parking adjustment from serve-geo-data.js.
 *
 * Order of operations, which is not arbitrary:
 *   1. sum the size base            beds, baths, levels
 *   2. x zone factor                the only thing it scales
 *   3. x condition, x service       existing canonical multipliers
 *   4. + flat per-visit dollars     add-ons, travel fee, parking — never scaled
 *   5. x frequency                  recurring track only, off the size base
 */
function computeQuote(input) {
    const { bedrooms, bathrooms, service, condition, addonFridge, addonOven, zip, frequency, levels, geo: geoOverride } = input;

    const tier   = zipTier(zip);
    const zipFee = tier === 'extended' ? PRICING.EXTENDED_ZIP_FEE : 0;      // R8
    /* `geo` may be passed explicitly. The published price tables do that to
       quote the NEUTRAL case rather than borrowing whichever ZIP they happen to
       be anchored at — see SERVE_RANGE_GEO. Everything else resolves from the
       customer's own ZIP. */
    const geo    = geoOverride || serveGeo(zip);

    /* G1 — bathrooms carry half-steps. A half bath is a toilet, sink, mirror and
       floor with no shower or tub, so it is priced as its own constant rather
       than as a fraction of a full one. 2.5 baths means two full and one half. */
    const fullBaths = Math.floor(bathrooms);
    const halfBaths = Math.round((bathrooms % 1) * 2);

    /* G2 — LEVELS. Charged BEYOND the first, so a single-level home is
       unaffected. Defaults to 1 when the caller omits it, which is what the
       published price tables do.

       This is the strongest single predictor the calculator has — better than
       ZIP. Held out on 30k Boston homes, adding levels cut the error in
       predicting home size from 16.5% to 14.9%, where ZIP alone managed 15.4%.
       It also makes a "condo or house?" question unnecessary: one floor is
       already 91% condo, and asking property type on top of levels adds exactly
       nothing.

       A storey is NOT in the size base. It is charged as its own flat amount
       per service — see LEVEL_HOURS and levelCharge() above, and G4 below. */
    const levelCount = Math.max(1, Math.floor(Number(levels) || 1));

    // R1 — base formula. Levels deliberately absent; see G4.
    const sizeBase = PRICING.BASE
        + PRICING.PER_BEDROOM   * bedrooms
        + PRICING.PER_BATHROOM  * fullBaths
        + PRICING.HALF_BATHROOM * halfBaths;

    /* G3 — the geographic factor scales only the AREA-DRIVEN SHARE of the size
       base, not all of it.

       The factor measures one thing: how much larger homes in this ZIP are once
       bedrooms, baths and levels are accounted for. Parcel data shows that extra
       size is entirely bigger rooms, not more rooms — same room count, same
       fixtures, more floor. So it must not scale arrival, staging, or a
       bathroom. AREA_SHARE is the fraction it is allowed to touch.

       A factor of 1.24 therefore lifts the base by 0.6 x 24% = 14%, not 24%.

       Applied here, before the service and condition multipliers, so it flows
       into the one-time price and the recurring prices alike — a bigger home is
       bigger on every visit. */
    const geoEffect = (1 - PRICING.AREA_SHARE) + PRICING.AREA_SHARE * geo.factor;
    const standard  = sizeBase * geoEffect;

    /* R2 — WITHDRAWN 2026-08-24. There used to be a second, lower multiplier
       for studios and 1BRs (DEEP_MULT_SMALL / MOVEOUT_MULT_SMALL). It
       discounted small homes twice: the size base already charges a studio
       $216 against a 3BR/2BA's $381, and the small multiplier then cut that
       again. Nothing measured supported it. `smallUnit` is still reported for
       any caller that wants to know, but it no longer changes a price. */
    const smallUnit = bedrooms <= 1;
    const deepMult  = PRICING.DEEP_MULT;
    const moveMult  = PRICING.MOVEOUT_MULT;

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

    /* G4 — flat per-visit dollars, added AFTER every multiplier and never
       scaled by one. Parking costs the same whether the job is a studio or a
       townhouse, so multiplying it would tax the largest jobs for a fixed cost.
       The extended-area fee has always worked this way; the parking adder joins
       it at the same stage. */
    const flatFees = zipFee + geo.park;

    /* Levels join the flat fees, but at a rate that depends on the service —
       a second storey is 5 extra hours on a move-out and 1 on a weekly visit.
       Like the add-ons, this sits OUTSIDE the first-clean discount: the
       contractor works those hours whether or not the visit is half price, so
       discounting them would mean paying for labour that was never charged. */
    const levelFee = service === 'move_out'
        ? levelCharge('move', levelCount, moveOutPrice)
        : levelCharge('deep', levelCount, deepPrice);

    let oneTime, deepAnchor = null, discountApplies = false;
    if (service === 'move_out') {
        oneTime = moveOutPrice + flatFees + levelFee;
    } else {
        if (noStack) {
            oneTime = deepPrice + addons + flatFees + levelFee;   // full deep price, no anchor
        } else {
            /* The anchor carries the level fee too, so the struck-through
               price and the discounted one describe the same job. */
            deepAnchor = deepPrice + levelFee;                    // R4 — struck-through anchor
            discountApplies = true;
            oneTime = deepPrice * PRICING.FIRST_CLEAN_FACTOR + addons + flatFees + levelFee;
        }
    }

    // R3 / R7 — recurring steady-state ALWAYS at condition 1.0, + flat fees
    const freqSteady = {};
    Object.keys(PRICING.FREQ).forEach(f => {
        const visit = standard * PRICING.FREQ[f];
        freqSteady[f] = Math.ceil(visit + flatFees + levelCharge(f, levelCount, visit));
    });

    const steadySelected = (service === 'first_clean' && frequency && frequency !== 'once' && PRICING.FREQ[frequency] != null)
        ? freqSteady[frequency]
        : null;

    return {
        tier, zipFee, standard, smallUnit, noStack, discountApplies, addons,
        displayPrice: Math.ceil(oneTime),                       // R11 — whole dollars, round up
        deepAnchorDisplay: deepAnchor != null ? Math.ceil(deepAnchor) : null,
        freqSteady, steadySelected,
        /* For the sheet and for tests. Never render any of these. */
        fullBaths, halfBaths, levels: levelCount, levelFee,
        geoFactor: geo.factor, parkTier: geo.parkTier, parkAdder: geo.park, geoMapped: geo.mapped,
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
        levels: 1,
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
            levels:             state.levels,
            service:            state.service,
            condition:          state.condition,
            addon_fridge:       state.addonFridge,
            addon_oven:         state.addonOven,
            frequency_selected: state.frequency,
            quote_price:        q ? q.displayPrice : null,
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
               calculator must still be sitting there, usable, at Step 1. */
            console.warn('Prefill could not be applied.', err);
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
