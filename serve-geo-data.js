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
