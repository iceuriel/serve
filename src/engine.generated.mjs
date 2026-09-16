/* ============================================================
   GENERATED FILE — DO NOT EDIT
   ============================================================

   Produced by scripts/build-engine-module.js from:

       serve-geo-data.js
       pricing-engine.js

   Edit those. Running the build regenerates this, and the test suite fails if
   this file has drifted from them.

   It exists because the two sources are classic <script> files with no export
   syntax, and Wrangler bundles .js as ES modules — where their conditional
   module.exports never executes. This is the same code with a real export.
   ============================================================ */

/* ============================================================================
   SERVE — GEO PRICING DATA
   Derived from FY2026 City of Boston Property Assessment (184,552 parcels)
   and MassGIS L3 Standardized Assessors' Parcels for Brookline (FY2027),
   Cambridge (FY2026), Newton (FY2026), Somerville (FY2025).

   ---------------------------------------------------------------------------
   WHAT THE FACTOR MEANS

   For each home, its living area was divided by the median living area of every
   home in the region sharing its exact spec. The ZIP's factor is the median of
   those ratios. So 1.09 means "homes here run 9% larger than the same nominal
   home elsewhere in Greater Boston."

   THE SPEC IS (bedrooms x full baths x levels) — every input the calculator
   prices on. This matters. An earlier version of this file controlled for
   bedrooms x levels only, leaving bathroom-driven size differences inside the
   factor while PER_BATHROOM was ALSO charging for them. The same square footage
   was billed twice, which is why the old LARGE tier read 1.30 when the data
   supported about 1.09.

   Boston has bedroom and bathroom counts; the MassGIS town extracts do not, so
   those ZIPs are measured on (property type x total rooms x stories) pooled with
   Boston. The two methods have different denominators, so every Boston figure is
   scaled by 0.9825 — Boston's own index on the pooled scale — to put both on one
   regional footing. Without it Boston reads ~1.8% high against Newton and
   Brookline for no reason anyone chose.

   ---------------------------------------------------------------------------
   A KNOWN, DELIBERATELY ACCEPTED BIAS IN THE FOUR TOWN FIGURES

   Controlling those towns on TOTAL ROOMS controls away something the calculator
   never asks about. A customer tells us bedrooms, bathrooms and levels — never
   room count — so the office, the den and the extra dining room are invisible to
   the quote, and dividing them out of the index makes suburban homes look closer
   to Boston's than a cleaner finds them. Measured on 2026-08-21:

       Brookline   1.08 here vs 1.26 without the rooms control   (~17% low)
       Newton      1.12 here vs 1.27 without                     (~13% low)
       Cambridge   0.95 here vs 0.97 without                     (~2% low)
       Somerville  0.89 here vs 0.78 without                     (~12% HIGH)

   It is not fixed, and the two obvious repairs both fail:
     - dropping the rooms control makes the factor absorb bedroom-count
       differences the customer already tells us and we already charge for;
     - imputing bedrooms from rooms (condo = rooms-3, house = rooms-4) is exactly
       right on only 39% of Boston homes, so it trades one bias for a noisier one.

   The real cause is structural: MassGIS carries no bed/bath counts, so town
   factors can never be measured on the basis Boston's are. Uriel's call on
   2026-08-21 was to leave the towns conservative rather than correct them with a
   judgement. DO NOT "fix" this by dropping the rooms control — that is the wrong
   direction and it double-counts bedrooms. Revisit when JOBS.duration_min can
   adjudicate.

   Two- and three-family parcels are excluded throughout: the record covers the
   whole building while the customer books one unit, and including them teaches
   the model that a 2BR is 1,884 sqft.

   ---------------------------------------------------------------------------
   NO TIERS, DELIBERATELY

   This used to be three buckets (LARGE / STD / SMALL). Buckets buy
   interpretability, and nothing here is ever shown to a customer — so they cost
   accuracy and bought nothing. Continuous per-ZIP is the same lookup at the same
   speed. Values are clamped to [0.85, 1.45]; two ZIPs currently sit on a clamp,
   both noted inline.

   PARK_TIER is unchanged: the share of residential parcels in the ZIP with zero
   on-site parking.  P0 = <40%   P1 = 40-70%   P2 = >70%

   ---------------------------------------------------------------------------
   NOT USER-FACING. Never display a factor, a parking tier, or a ZIP label. The
   customer sees one price.

   HEALTH WARNING: every figure here predicts home SIZE. Price should track TIME.
   Nothing in parcel data bridges the two — JOBS.duration_min is what will, once
   it has rows. Treat a change here as a business decision, not a correction.

   WHY THIS IS A CLASSIC SCRIPT AND NOT AN ES MODULE

   This site has no build step and loads plain <script src> tags, where 'export'
   is a syntax error that takes the whole file down and every price with it. So
   the bindings are top-level const/function. Any page that prices must load this
   file BEFORE script.js.

   If it fails to load, serveGeo() in script.js falls back to the neutral case
   rather than throwing. A visitor still gets a price.
   ========================================================================= */

const PARK_ADDER = {   // flat dollars, added AFTER every multiplier
  P2: 25,
  P1: 15,
  P0: 0,
};

/* zip: [sizeFactor, parkTier, label]
   label is for debugging only and is never rendered.
   n = homes the factor was measured on. "town avg" = no usable per-ZIP data;
   Cambridge populates its ZIP column on 21% of rows and Somerville on 29%. */
const ZIP_GEO = {
  // ---- Boston ----
  '02199': [1.45, 'P2', 'Prudential'],        // n=77, thin
  '02110': [1.24, 'P2', 'Waterfront'],        // n=1980
  '02210': [1.24, 'P1', 'Seaport'],           // n=1161
  '02111': [1.09, 'P1', 'Chinatown'],         // n=1755
  '02108': [1.07, 'P2', 'Beacon Hill'],       // n=1206
  '02109': [1.04, 'P1', 'North End'],         // n=1252
  '02116': [1.04, 'P1', 'Back Bay'],          // n=6604
  '02130': [1.03, 'P0', 'Jamaica Plain'],     // n=7207
  '02132': [1.03, 'P0', 'West Roxbury'],      // n=7811
  '02118': [1.02, 'P2', 'South End'],         // n=5419
  '02114': [0.99, 'P2', 'West End'],          // n=2872
  '02119': [0.99, 'P1', 'Roxbury'],           // n=2016
  '02124': [0.99, 'P0', 'Dorchester'],        // n=4472
  '02122': [0.98, 'P0', 'Dorchester'],        // n=2721
  '02125': [0.98, 'P1', 'Dorchester'],        // n=2993
  '02131': [0.98, 'P0', 'Roslindale'],        // n=5523
  '02136': [0.98, 'P0', 'Hyde Park'],         // n=5500
  '02163': [0.98, 'P1', 'Allston/HBS'],       // town avg, no ZIP data
  '02120': [0.97, 'P1', 'Mission Hill'],      // n=642
  '02115': [0.96, 'P2', 'Fenway'],            // n=3025
  '02121': [0.96, 'P0', 'Dorchester'],        // n=831
  '02126': [0.96, 'P0', 'Mattapan'],          // n=2024
  '02129': [0.96, 'P1', 'Charlestown'],       // n=4721
  '02127': [0.93, 'P1', 'South Boston'],      // n=9200
  '02128': [0.92, 'P1', 'East Boston'],       // n=4650
  '02134': [0.92, 'P1', 'Allston'],           // n=2388
  '02135': [0.92, 'P0', 'Brighton'],          // n=7347
  '02215': [0.91, 'P2', 'Kenmore'],           // n=2105
  '02113': [0.85, 'P2', 'North End'],         // n=1232

  // ---- Brookline (MassGIS FY2027) ----
  '02445': [1.09, 'P1', 'Brookline'],         // n=5599
  '02446': [1.07, 'P1', 'Brookline / Coolidge Corner'], // n=6940

  // ---- Cambridge (MassGIS FY2026) ----
  '02141': [1.02, 'P2', 'Cambridge / East Cambridge'], // n=1576, thin
  '02142': [0.95, 'P2', 'Cambridge / Kendall Sq'], // town avg, no ZIP data
  '02138': [0.93, 'P1', 'Cambridge / Harvard Sq'], // n=651, thin
  '02139': [0.93, 'P1', 'Cambridge / Central Sq'], // n=2739, thin
  '02140': [0.92, 'P1', 'Cambridge / Porter Sq'], // n=548, thin

  // ---- Somerville (MassGIS FY2025) ----
  '02143': [0.89, 'P2', 'Somerville / Union Sq'], // town avg, no ZIP data
  '02144': [0.89, 'P2', 'Somerville / Davis Sq'], // town avg, no ZIP data
  '02145': [0.89, 'P2', 'Somerville / Winter Hill'], // town avg, no ZIP data

  // ---- Newton (MassGIS FY2026) ----
  '02468': [1.18, 'P0', 'Waban'],             // n=1762
  '02459': [1.16, 'P0', 'Newton Centre'],     // n=4639
  '02465': [1.11, 'P0', 'West Newton'],       // n=2792
  '02458': [1.10, 'P0', 'Newton Corner'],     // n=1635
  '02462': [1.09, 'P0', 'Newton Lower Falls'], // n=372
  '02466': [1.09, 'P0', 'Auburndale'],        // n=1197
  '02460': [1.06, 'P0', 'Newtonville'],       // n=1405
  '02461': [1.05, 'P0', 'Newton Highlands'],  // n=1765
  '02467': [0.98, 'P0', 'Chestnut Hill'],     // n=954
  '02464': [0.95, 'P0', 'Newton Upper Falls'], // n=336
};

/* An unmapped ZIP prices as the regional norm with no parking adder. A quote is
   still produced and nothing throws. */
const DEFAULT_GEO = [1.00, 'P0', 'Unmapped'];

function lookupGeo(zip) {
  const z = String(zip || '').trim().slice(0, 5);
  const hit = ZIP_GEO[z];
  return {
    factor:   hit ? hit[0] : DEFAULT_GEO[0],
    parkTier: hit ? hit[1] : DEFAULT_GEO[1],
    label:    hit ? hit[2] : DEFAULT_GEO[2],
    mapped:   Boolean(hit),
  };
}


/* Classic script in the browser, module everywhere else — same pattern as
   pricing-engine.js. index/pricing/services load this with a plain <script>
   tag, so everything above is a global there and `typeof module` is undefined,
   leaving this block inert. The Worker and the tests import it instead. */
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { lookupGeo, ZIP_GEO, PARK_ADDER, DEFAULT_GEO };
}


/* ============================================================
   SERVE — PRICING ENGINE

   ONE ENGINE, THREE CONSUMERS. This file used to live inside script.js.
   It was pulled out so the SERVER can price a booking too:

     the browser   <script src="pricing-engine.js"> on index, pricing, services
     the Worker    imports it to re-derive the price a booking claims
     the tests     require() it

   The point of the split is that a price is now checkable. Until this moved,
   quote_price was computed on the customer's machine and taken on trust —
   fine while nothing charged money, and a live vulnerability the moment
   anything did. See src/worker.js for the verification.

   A COPY OF THIS LOGIC ANYWHERE ELSE IS A BUG. Three consumers reading one
   file cannot disagree; three copies drift, and the failure is silent —
   a server quietly charging last month's prices looks exactly like a server
   working. Edit here and every consumer moves in the same deploy.

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

   DEPENDS ON serve-geo-data.js — lookupGeo() must already be defined. In the
   browser that is the <script> tag above this one; everywhere else it is
   loaded first by hand.
   ============================================================ */

/* Stamped onto every quote, and the reason a mismatch is diagnosable.

   The server re-derives each booking's price. When its number disagrees with
   the browser's there are exactly two explanations, and they need opposite
   responses: someone edited the payload, or the engine changed under a tab
   that was already open. Same version + different price is tampering, and is
   refused. Different version is drift, and the quoted price is honoured —
   the customer must never be charged something other than what they saw.

   BUMP THIS whenever any number below changes. Forgetting turns a real
   repricing into a wave of false tamper alerts on the next deploy. */
const PRICING_VERSION = '2026-08-24';
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

    /* THE 15% THAT APPLIES WHERE THE HALF-PRICE FIRST CLEAN CANNOT — a move
       clean, and a 4BR+ heavy first clean caught by the no-stack rule below.
       Added 2026-09-16.

       Both of those used to be shown at the full ticket with no discount at
       all, and on the no-stack path that produced a cliff rather than a
       premium: one radio answer ("over a year since a professional clean")
       took a 4BR in Allston from $264 to $680, a 2.58x jump, where the same
       answer on a 3BR moved it 1.30x. The condition multiplier and the total
       loss of the discount landed on the same click.

       Those dollar figures are REAL Allston quotes, geo factor and parking
       included. Computing them from Node without passing `geo` gives
       neutral-geo numbers about 3% adrift — see serveGeo() below.

       WHY 15 AND NOT 50. The half-price first clean is sold BELOW the
       contractor's own cost — at MARGIN.deep it is -34% on the labour — and is
       recouped from the recurring visits that follow it. That trade is only
       worth making where a recurring plan is the likely outcome. A move clean
       has no second visit by definition, and a 4BR that has not been cleaned
       in a year is the most expensive possible version of the bet. 15% keeps
       both comfortably above cost.

       IT SOFTENS THE CLIFF RATHER THAN REMOVING IT, and the residual is worth
       knowing before anyone calls this fixed: 3BR heavy $314 -> 4BR heavy $578
       is still 1.84x for one bedroom, down from 2.17x. A hard threshold at
       4BR+heavy necessarily leaves a step there; closing it means tapering the
       no-stack rule or dropping it, which is a pricing decision and not this
       constant's job. */
    SECONDARY_FACTOR: 0.85,

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
        // 02117 is a PO-BOX ZIP — nobody lives in it, and it is here anyway.
        // Geoapify returns it for real Back Bay addresses (37 Appleton St), and
        // some residents give it as their mailing ZIP. Either way the person is
        // in Boston, and the rule at the top of this block applies: a missing ZIP
        // is a lost lead. It has no serve-geo-data.js entry and takes NEUTRAL_GEO
        // — correct rather than lazy, since a ZIP with no residents has no homes
        // to have measured. Alias it to 02116 if that ever looks under-priced.
        "02117",
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

/**
 * `lookup` exists for the server. In the browser serve-geo-data.js is loaded by
 * the <script> tag above this one, so lookupGeo is a global and the argument is
 * never passed. Under a bundler it is a module export and there is no global at
 * all — a bare reference would throw ReferenceError, the catch below would
 * swallow it, and EVERY home would price at the neutral factor. That failure is
 * silent and it looks exactly like working code, so the server passes its own
 * lookup in rather than relying on a global that isn't there.
 *
 * `typeof` on an undeclared name is safe and returns "undefined" — it does not
 * throw — so the browser path needs no guard of its own.
 */
function serveGeo(zip, lookup) {
    const fn = lookup || (typeof lookupGeo === 'function' ? lookupGeo : null);
    if (!fn) return NEUTRAL_GEO;
    try {
        const g    = fn(zip);
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

    /* R4 — THE DISCOUNT APPLIES TO THE WHOLE TICKET.
     *
     * "50% off" has to mean 50% off what the customer would otherwise pay —
     * every line of it: the clean, the add-ons, the storeys, the travel fee,
     * the parking. Anything held outside the discount makes the struck-through
     * price and the shown price describe different jobs, and the advertised
     * percentage stops being true.
     *
     * It used to be partial, and it got badly misleading at the edges: a
     * two-storey home with both add-ons in the extended area was shown "50%
     * off" on a 20% discount. Fixed 2026-08-25.
     *
     * The shown price is computed FROM the struck price so the two are exactly
     * half of each other as displayed — not merely close after two separate
     * roundings.
     */
    const fullTicket = service === 'move_out'
        ? moveOutPrice + flatFees + levelFee
        : deepPrice + addons + flatFees + levelFee;

    /* EVERY PATH IS DISCOUNTED NOW — at 50% or at 15%, never at nothing. The
       anchor is therefore always set, and `deepAnchorDisplay` is no longer a
       way to ask "was there a discount". Read `discountFactor` for that.

       `discountApplies` still means specifically THE HALF-PRICE FIRST CLEAN,
       unchanged, because that is the flag the partner payout keys off — see
       payoutRateFor() in apps-script/webhook.gs. A 15% ticket pays the
       ordinary share; only the half-price one is passed through. Widening this
       flag to mean "any discount" would quietly hand a move clean the
       passthrough rate. */
    const deepAnchor     = Math.ceil(fullTicket);               // what it would cost
    const discountApplies = !(service === 'move_out' || noStack);
    const discountFactor = discountApplies
        ? PRICING.FIRST_CLEAN_FACTOR
        : PRICING.SECONDARY_FACTOR;
    const oneTime = deepAnchor * discountFactor;
    const pct     = Math.round((1 - discountFactor) * 100);

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
        deepAnchorDisplay: deepAnchor,

        /* WHAT KIND OF DISCOUNT, for the badge and for the sheet. Derived here
           rather than rebuilt at each call site: the label and the arithmetic
           must not be able to disagree, which is exactly what happened while
           script.js hardcoded "First clean 50% off" beside a factor it read
           from this object.

           THE PERCENTAGE IN THE LABEL IS COMPUTED, NOT TYPED, for that same
           reason — a hardcoded "15% off" here would start lying the moment
           SECONDARY_FACTOR moved, and it would lie in the sheet, where the
           number is read months later to work out what a booking earned. */
        discountFactor,
        discountPercent: pct,
        discountLabel: discountApplies       ? 'First clean ' + pct + '% off'
                     : service === 'move_out' ? 'Move clean ' + pct + '% off'
                     : 'Large heavy home ' + pct + '% off',
        freqSteady, steadySelected,
        /* For the sheet and for tests. Never render any of these. */
        fullBaths, halfBaths, levels: levelCount, levelFee,
        geoFactor: geo.factor, parkTier: geo.parkTier, parkAdder: geo.park, geoMapped: geo.mapped,
    };
}

/* Classic script in the browser, module everywhere else.

   index/pricing/services load this with a plain <script> tag, exactly like
   serve-geo-data.js, so everything above lands as globals — `typeof module`
   is undefined there and this block never runs. Node require() and the
   Worker's bundler both see the exports. No build step, no module loader,
   nothing added to the page. */
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        PRICING_VERSION, computeQuote, PRICING, WORK_MODEL, MARGIN,
        WORK_RATE, TARGET_WAGE, priceMultiplier, levelCharge, zipTier, ZIP_TIERS,
        /* serveGeo is exported for the server only. It must be called with a
           lookup function there and the result passed to computeQuote as `geo`,
           because computeQuote's own internal call cannot see a global. */
        serveGeo, NEUTRAL_GEO,
    };
}


/* The whole point of this file. */
export {
    lookupGeo, ZIP_GEO, PARK_ADDER, DEFAULT_GEO,
    computeQuote, serveGeo, NEUTRAL_GEO,
    PRICING_VERSION, PRICING, WORK_MODEL, MARGIN,
    WORK_RATE, TARGET_WAGE, zipTier, ZIP_TIERS,
};
