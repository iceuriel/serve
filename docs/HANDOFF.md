# SERVE — Build handoff

**Purpose:** hand the current state of the system to another person or another
assistant with no access to this repo. Self-contained on purpose.

**Companion doc:** `/docs/SCHEMA.md` — authoritative for every column's meaning
and who writes it. This file is the narrative; that file is the contract.

**Latest session: 2026-08-21.** Jump to
[what changed on 2026-08-21](#session-2026-08-21) for the current state. The
sections below it describe earlier builds and remain accurate except where a
later section supersedes them.

---

## Session 2026-08-21

**The geo factors shipped the day before were wrong, and the parcel data proves
it.** Nothing had been deployed, so this corrects them in place rather than
undoing a live change.

### The bug: the size index double-counted bathrooms

`serve-geo-data.js` derived each ZIP's index by controlling for **bedrooms ×
levels**. That is only correct if bedrooms and levels are the only things the
calculator charges for — and they aren't. `PER_BATHROOM` charges $66 a bathroom
on the same base the factor then multiplies.

So any part of a neighbourhood's size advantage that came from having more
bathrooms was billed twice: once through `PER_BATHROOM`, once through the zone
factor. Rebuilt on **bedrooms × baths × levels** — the basis the calculator
actually prices on — the three tiers fit like this:

| tier | shipped | measured | verdict |
|---|---|---|---|
| LARGE | 1.30 | **1.09** | far too high; only Seaport and Waterfront earned it |
| STD | 1.00 | **1.00** | excellent — 19 ZIPs, all within ±7% |
| SMALL | 0.85 | **0.91** | slightly too low; only the North End reached 0.85 |

Worst single case: **Chestnut Hill measured 0.98 — precisely average — and was
charged 1.30**, quoting $257 for a 2BR/1BA first clean the data supports at $194.
It was rated LARGE because it is an expensive area, but expensive and *large* are
different things and only one of them takes longer to clean.

### Tiers are gone entirely

Three buckets forced 49 neighbourhoods into three numbers, and bought
interpretability that nothing consumes — no zone name has ever been rendered.
`ZIP_GEO` now holds a continuous per-ZIP factor, clamped to [0.85, 1.45]. Same
lookup, same cost, strictly more accurate. `ZONE_FACTOR` no longer exists.

19 of 49 ZIPs move by 0.08 or more; the mean factor falls 1.061 → 1.015. Real
quotes for a 2BR/1BA first clean now span **$182–$312** where the old tiers gave
$183–$282 and flat pricing gave $198 everywhere.

### Both data sources now share one scale

Boston has bedroom and bathroom counts; the MassGIS town extracts do not. So
Boston ZIPs are measured on beds × baths × levels against a **Boston**
denominator, and town ZIPs on type × rooms × stories against a **pooled**
denominator. Two denominators mean two definitions of 1.00.

Boston measures **0.9825** on the pooled scale — its homes run slightly small for
the region — so every Boston figure is multiplied by that to land both groups on
one regional footing. Left uncorrected, Boston read ~1.8% high against Newton and
Brookline for no reason anyone chose. It is a single common multiplier, so the
ordering within Boston is untouched.

### The published tables no longer borrow a ZIP

They were anchored on `SERVE_RANGE_ZIP` — 02116 until 2026-08-20, then 02130.
Both were proxies for "adds nothing", and both were fragile: 02116 turned out to
carry a 1.30 factor, and 02130 was neutral only while 19 ZIPs shared one bucket
value. **Once factors went continuous, no ZIP is exactly 1.00.**

So `SERVE_RANGE_GEO` now states the neutral basis outright and `computeQuote`
accepts it as an explicit `geo` override. `SERVE_RANGE_ZIP` survives only to
supply the CORE tier, so no travel fee is baked in. A data refresh can no longer
silently reprice three pages. Verified: all 15 published cells byte-identical to
what the pre-geo engine produced.

### What the data also settled

- **Levels beats ZIP as a predictor.** Held out on 30k homes, predicting living
  area: beds+baths 16.6% median error, +floors **14.9%**, +ZIP 15.4%,
  +floors+ZIP **14.2%**.
- **Asking "condo or house?" would add nothing.** Adding property type on top of
  floors moves the error 14.9% → 14.9%. Floors already answers it — **1 floor is
  91% condo**. Do not add a property-type input.
- **Cross-town size differences are mostly composition.** Single-family medians
  run Boston 1,620 → Newton 2,349 → Brookline 2,816 sqft, a 1.74× spread. Control
  for room count and it collapses to 1.08–1.22×. Beds and baths were already
  absorbing most of it.
- **`PER_LEVEL` at $35 is low on a pure-size basis.** Within the same beds and
  baths, a 2-floor home is 1.17–1.37× the area of a 1-floor one at 1–2 baths — so
  size implies $60–85. But the effect *reverses* at 3+ baths (0.91–0.94×), and a
  floor adds no fixtures. Left at $35 deliberately; see below.

### THE FIRST REAL TIMING DATA — and what it broke

Late in the session Uriel supplied the first measured job durations this project
has ever had. One cleaner, start to finish:

| job | hours | price then | $/cleaner-hour |
|---|---|---|---|
| 2BR/1BA first deep clean (Malden) | 7 | $223 | **$31.86** |
| 3BR/2BA move-in | 12 | $787 | $65.58 |
| 3BR/2BA recurring | 4–6 | $189 | **$31.50–47.25** |

**The deep-clean base rate turned out to be right.** That same 2BR/1BA *before*
the 50% first-clean discount is $420, which over 7 hours is exactly
**$60/cleaner-hour**. The engine's view of the work is sound. What is not sound
is what sits on top of it.

Three things follow, and only the third was acted on this session:

1. **The 50% first-clean discount is a ~$200 subsidy per job**, taking the first
   visit to $32/cleaner-hour. That may well be worth it as customer acquisition
   — but it should be a marketing decision with a payback period, not a
   multiplier inherited from a lost spec.
2. **Recurring is the real emergency.** Across the service area a 3BR/2BA
   biweekly runs **$156 (Brighton) to $234 (Prudential)**, and at the observed
   4–6 hours that is **$26–$59 per cleaner-hour** against the $60 the deep clean
   validates. Only the dearest ZIP at the fastest duration even approaches
   target. Recurring is the product the whole `pro` segment pitch exists to sell.
   **Not changed here — this is Uriel's call.**

   **Uriel reviewed the full spread on 2026-08-21 and chose to leave recurring
   prices unchanged for now.** That is a decision, not an oversight — do not
   "correct" it in a later pass without asking. The reasoning to revisit it with
   is below, and the numbers hold until `duration_min` says otherwise.

   Reaching $60/cleaner-hour needs somewhere between **+27% and +131%**,
   depending on the ZIP and the duration:

   | base | → $240 (4h) | → $300 (5h) | → $360 (6h) |
   |---|---|---|---|
   | cheapest CORE — Brighton $156 | +54% | +92% | +131% |
   | Malden $189 *(the observed job)* | +27% | +59% | +90% |
   | dearest — Prudential $234 | +3% | +28% | +54% |

   > An earlier version of this entry said "45–90%". That number was built by
   > taking the low end off one base and the high end off another, and it
   > understated the top badly. Quote a required increase against **one** base at
   > a time or it describes nothing.

   **The 4h-vs-6h swing matters more than the ZIP spread.** It is ±50% of the
   labour on the same nominal job, which is a scope or scheduling problem rather
   than a pricing one — no single price serves both, and today the 4-hour homes
   subsidise the 6-hour ones. Worth understanding before repricing, because
   raising the price uniformly locks that cross-subsidy in.
3. **Move-in was ~9% rich per hour** and was corrected. See below.

> **A correction worth recording, because the first version of this analysis was
> wrong.** An earlier pass reported move-in as priced "3.53x a first clean but
> only 1.71x as long", implying it was 2x too expensive. That compared the
> move-in against the **discounted** first clean, so the 50% discount showed up
> as a move-out problem. Compared like for like — both undiscounted, per
> cleaner-hour — move-in was $65.58 against the deep clean's $60.00, i.e. 9%
> rich. The correction shipped is a ~10% trim, not a halving.

### The three levers, in the order the data ranks them

**1. Levels — the strongest, and it retires a question.** Held out on 30k homes,
adding levels cuts size-prediction error 16.5% → 14.9%; ZIP alone manages 15.4%.
It also makes a "condo or house?" input pointless: **one floor is already 91%
condo**, and adding property type on top of levels improves nothing at all
(14.9% → 14.9%). `PER_LEVEL` raised **$35 → $50**, from the measured 1.215x area
of a second floor, of which `AREA_SHARE` is chargeable, plus stair and hauling
overhead.

**2. Geography — real, but it was applied far too broadly.** The decisive finding:
holding bed/bath/level fixed, high-factor ZIPs have **identical room counts**
(1.000x) and simply bigger rooms (1.354x sqft per room). A Seaport 2BR has the
same four rooms, one kitchen and one bathroom as an East Boston 2BR — just more
open floor.

Scaling the whole size base by the factor therefore charged 24% more for
arrival, staging and a toilet, none of which grow with the home. New
`PRICING.AREA_SHARE = 0.6` confines the factor to the area-driven share, so a
1.24 ZIP lifts the base 14% rather than 24%. The 2BR/1BA spread across Boston
compresses from roughly $183–$282 to **$188–$241**.

**3. Access and parking — unchanged, and validated.** Correlation between the
size factor and the parking adder is **−0.10**: they measure genuinely different
things and both earn their place, with parking pulling mildly against geography
exactly as expected (dense areas are smaller *and* harder to park).

### Where the model now sits against the measured jobs

| job | hours | price now | $/cleaner-hour |
|---|---|---|---|
| 2BR/1BA deep clean | 7 | $420 | $60.00 |
| 3BR/2BA move-in | 12 | $711 | $59.25 |
| 3BR/2BA recurring | 5 | $189 | **$37.80** |

Two of three now agree. Recurring remains open.

### Prediction accuracy is at its ceiling — stop optimising it

Among homes sharing beds, baths, levels, ZIP **and** room count exactly, the
median home still differs from its neighbours by **11.1%**. That is irreducible.
The model sits at 14.1%. Adding total room count buys 0.2 points; adding half
baths buys nothing. **There is no input you can put on a form that closes that
gap** — the remaining error is the home itself. Effort belongs in measuring
duration, not in refining the size proxy.

### Still open

- **Size is not time.** Every geographic figure in this build predicts square
  footage. A second floor adds area and stairs but no toilets, sinks or kitchens,
  and fixtures are what consume the hour. `AREA_SHARE` is the one knob that
  encodes this and **0.6 is a judgement, not a measurement**.
- **Recurring pricing** — see above. The largest open number in the system.
- **The first-clean subsidy** — $200/job, currently undecided rather than chosen.
- **The four town factors are knowingly ~15% conservative**, and that was a
  decision, not an oversight. They are measured controlling for total room count
  — which the calculator never asks about — so the suburban office, den and extra
  dining room get divided out. Brookline and Newton read ~13–17% low; Somerville
  ~12% high. Both obvious repairs fail (dropping the control double-counts
  bedrooms; imputing bedrooms from rooms is right only 39% of the time), and the
  root cause is that MassGIS carries no bed/bath counts at all. Uriel chose to
  leave the towns conservative on 2026-08-21. **Do not "fix" it by dropping the
  rooms control** — the full reasoning is in the header of `serve-geo-data.js`.

  This is the empirical answer to a question worth keeping: a suburban home at
  the same nominal spec really is a bigger job, and roughly a third to a half of
  that is genuinely extra rooms rather than bigger ones. A single family carries
  exactly **+1 room over a condo at every bedroom count** — 1BR through 4BR.
- **Assessed value is in both datasets and is not usable.** Median single-family
  value per square foot runs $438 in Boston to $952 in Cambridge — a 2.2x spread
  that tracks desirability, not size. It would import location a second time, and
  a customer cannot state their assessment at quote time regardless.
- **Three measured jobs is not a dataset.** Every calibration above rests on
  one or two observations. Also: 7 hours for a 2BR/1BA deep clean is high against
  an industry norm of 4–6, so there is a real fork — price for that standard, or
  trim its scope. Get `duration_min` to 15–20 rows and all of this becomes
  measurable.
- **Even the best model misses by 14.2% at the median and 40% at the 90th
  percentile.** Geographic pricing narrows the error; it does not remove it.
- **Three rows rest on thin data.** Prudential (02199) measures 1.51 on 77 homes
  and sits on the 1.45 clamp. Allston/HBS (02163) is a campus with almost no
  residential parcels, so its 0.98 is the Boston average wearing a ZIP code. The
  three Somerville ZIPs share one town figure — Somerville populates its ZIP
  column on 29% of rows, Cambridge on 21%.
- **02447 Brookline Village still has no parcel data**, so it prices neutral
  while 02445/02446 measure 1.09 and 1.07. Unchanged from yesterday.
- **Still no browser verification.** Third session with the Chrome extension
  unavailable.

---

## Session 2026-08-20

**Price now depends on where the home is.** Until this build, a 2BR/1BA first
clean cost $198 whether it was in Back Bay or Allston. It now ranges $183–$282
across the 59 served ZIPs. The quote also asks how many levels the home has and
accepts half bathrooms.

### What is actually data-backed here, and what is not

`serve-geo-data.js` is real: 49 ZIPs derived from 184,552 FY2026 Boston parcel
records plus MassGIS layers for Brookline, Cambridge, Newton and Somerville. For
each ZIP it holds a **zone** — how much larger or smaller homes there are once
bedrooms and levels are already accounted for — and a **parking tier**, the
share of parcels with no on-site parking.

**Everything else in the pricing engine is an unmeasured guess, including the
parts that were already there.** `BASE`, `PER_BEDROOM` and `PER_BATHROOM` have
no recorded derivation: they arrived whole in the 2026-07-20 rebuild, which
cites a "spec §3.2 / §3.3" and rules R1–R11 annotated down the function. That
document is not in this repo and never was — the Known open items in
`SCHEMA.md` record it as lost to a truncated paste. `HALF_BATHROOM` and
`PER_LEVEL`, added this session, are no better founded; they were set from
minute priors in the geo spec, which itself says its coefficients are priors
rather than measurements.

This is now written into the banner above `PRICING` in `script.js`, because
that is where the next person will reach for these numbers. The point is not
that they are wrong. It is that **a change there is a business decision, not a
correction**, and nobody should believe otherwise on the strength of the
confident-looking parcel data sitting next to it.

`JOBS.duration_min` is what changes this. Once real measured durations
accumulate, these coefficients become fittable for the first time. Protect that
column.

### The published price tables did not move, and that took a deliberate step

Every price on `/pricing`, `/services` and the homepage teaser renders by
calling `computeQuote` (convention #10). Those tables were quoted at
`SERVE_RANGE_ZIP = 02116` — and the new map rates **Back Bay as LARGE, 1.30x,
with P1 parking**. Left alone, every published price on three pages would have
risen about a third overnight, as a side effect of which ZIP the table happened
to be anchored at rather than any pricing decision anyone made.

The anchor moved to **02130 (Jamaica Plain)**, the one combination that adds
nothing on all three axes: STD zone, P0 parking, CORE tier. All 15 published
cells were then verified byte-identical against the previous engine by loading
both versions and diffing every cell.

`tests/pricing-and-services.test.js` now pins the anchor's zone, parking tier
and tier — and that it is actually *mapped*, since an unmapped ZIP would pass
the first two by falling back, which is not the same as being deliberately
neutral.

### The tension this creates, which prose has to carry

The geo spec says never to render the zone. The site publishes price tables. A
Back Bay visitor therefore sees a table and is then quoted about a third more,
with no on-page explanation available.

`/pricing` and the homepage teaser now say the ranges are *typical* and that the
exact price depends on the home and the address. `/services` already said
"Typical range" and was left alone. **This is a mitigation, not a fix.** If the
gap starts costing conversions, the honest options are publishing a span across
zones or rendering the table after a ZIP is entered — both were considered and
rejected as worse for now.

### `serve-geo-data.js` is a classic script, not a module

The spec supplied it with ES `export`. This site has no build step and no module
loader; `export` would be a syntax error that takes the file down and every
price with it. It ships as top-level `const`/`function`, loaded by its own
`<script>` tag **before** `script.js` on all three script-bearing pages.

Being a second file means it needs everything convention #9 demands — a `cp`
line in `scripts/build-site.sh`, a cache rule in `_headers` — plus one more:
**load order**. All of it is pinned by test.

If it fails to load, `serveGeo()` returns the neutral STD / P0 case rather than
throwing, so every home still prices. The `try` around it is load-bearing: an
unloaded `const ZONE_FACTOR` raises a ReferenceError rather than reading as
undefined. Asserted by running the engine slice with no geo file at all.

### Two tests were failing on master before this build, and both were wrong

`npm test` was red on a clean tree: `sms-consent.test.js` reported that
`_headers` declared no charset for `/privacy` and `/sms-terms`. **The headers
were present and correct the whole time.** `_headers` is CRLF, and while `^x$`
under `/m` tolerates `\r\n`, a pattern with a literal `\n` in the middle of it
matches nothing. Both files now normalise line endings on read.

This is the dangerous kind of failing test: it sends you to edit a file that was
never wrong — and that file is on the A2P surface, where a "fix" can cost a live
campaign.

The same file pinned the webhook revision to the exact string `r7`, so the r8
bump reported the SMS consent surface as broken when nothing about it changed.
It now parses the revision and asserts **r7 or later**, with the stamp and the
`doGet` response still required to agree. Below r7 still fails.

### Still open

- **The webhook is at r8 in the repo and is not deployed.** r8 is purely
  additive — an r7 deployment ignores the three new keys and writes every
  existing column as before — so bookings are safe and the site can ship first.
  The new fields simply are not recorded until it goes out.
- **02447 Brookline Village has no parcel data**, so it falls back to STD while
  the other two Brookline ZIPs (02445, 02446) are both LARGE. An identical home
  there prices about 30% below one two ZIPs over. Nine EXTENDED-tier towns are
  also unmapped, which matters less — they are neutral anyway.
- **No job floor, and it turns out not to need one.** Nothing clamps a quote
  upward. An exhaustive scan on 2026-08-21 — all 59 ZIPs x beds x baths x
  condition x service x levels, 47,790 configurations — puts the cheapest
  reachable quote at **$115** (studio, light, first clean, 02134), against a
  previous floor of $117. A $2 drop.

  An earlier draft of this list said "about $100", which was the figure *before
  the parking adder* and overstated the risk. All four SMALL-zone ZIPs (02113,
  02134, 02163, 02215) are P1 or P2, so each adds $15–$25 back and the two
  adjustments largely cancel. `ZONE_MINIMUM` from the spec stays unbuilt — not
  only because setting one means inventing a business number, but because there
  is nothing for it to catch.
- **Still no browser verification.** The Chrome extension was not connected for
  this build either. The new stepper was verified by driving the real
  `initStepper` against a fake DOM — half-steps, clamping, the "3+" label and
  float drift are all covered by test — but **nobody has looked at the Levels
  control rendered on a real page.** Do that before pointing traffic at it.

---

## Session 2026-08-19

**Prices and scope are now published.** Until this build no price appeared
anywhere on the site until a visitor completed five calculator steps, and the
only visible dollar figure was the `$130/hr` in the oversized-home fallback — an
hourly rate shown exclusively to the people we had just told we could not price.
Service descriptions were one-liners, so customers filled in the scope
themselves and the gap surfaced at the door.

### The site is now three pages, not one

`/pricing` and `/services` join `/` as full pages, plus two compressed teasers
on the homepage between the booking form and *After you book*. The teasers exist
so someone who scrolls past the calculator without using it still sees a real
number before they leave.

### Every published price is computed, never written down

**This is the part to protect.** No price on either new page or on the homepage
teaser is a literal. All of them render at page load by calling `computeQuote` —
the same function behind the calculator — from the shared module at the end of
`script.js`. Change `PRICING` and every table on the site moves with it.

A published range that disagrees with the quote a visitor is then shown is the
worst failure this feature can have, and the only way to make it structurally
impossible is to have one source. `tests/pricing-and-services.test.js` runs the
real module against a fake DOM, reads the numbers back out of the markup it
produced, and recomputes them independently — so replacing the render with a
hardcoded table fails the suite on the next `PRICING` change.

Ranges are quoted at `SERVE_RANGE_ZIP` (02116, CORE tier), so no travel fee is
baked into them; the extended-area $25 is explained in prose and applied by the
calculator once a real ZIP is entered.

The same rule covers the add-on prices on `/services` and the room-by-room
matrix, which renders from `SERVE_SCOPE`.

### `SERVE_SCOPE` is meant to have three consumers

It is a standalone exported object, not markup, because the partner job brief
and the photo-verification shot list should render from it next. One source,
three consumers — a task added there appears everywhere it should. A task
written into the HTML would appear on the website and nowhere else, which is how
a cleaner ends up not knowing what was sold.

Coding worth remembering: fridge and oven interiors are `2` (paid add-on) on
First Clean because the calculator sells them as `$45` / `$40` toggles, and `1`
on move-in/out because that service bundles them into its multiplier. This
mirrors `add_on_rev` being 0 on every move-in/out job.

### Prefill lands on Build, not Price — deliberately

Every price cell is a real `<button>` that loads that configuration into the
calculator: directly on the homepage via `window.ServeQuote.applyPrefill`, and
from the other two pages via `/?beds=2&baths=1&service=deep#quote`.

**It stops at Build when there is no ZIP, and that is not an oversight.**
`state.zip` gates coverage (an unlisted ZIP must get the waitlist, never a
price) and the extended-area fee. Jumping to Price without one would quote every
visitor the CORE rate and — worse — Step 3 would then submit with no ZIP at all,
breaking `property_key`, skipping the PROPERTIES write, and potentially putting
an out-of-area job on the schedule. Everything else is filled in and the cursor
is already in the ZIP field. A `&zip=` param is supported, and with it the
prefill goes straight to Price.

**Existing query params are preserved on the hop.** Losing `src` when someone
clicks a price would silently reset attribution for every visitor who arrived on
a tagged poster or QR link. Asserted by test.

### The nav is duplicated on purpose

Nav and footer are real HTML in all five pages, never injected by JS — crawlers
and Twilio's A2P reviewers both follow links out of the served markup. The cost
is that a nav edit is a five-file edit, so **`index.html` opens with a comment
listing every file that carries one.** The three content pages are byte-identical
and a test enforces it.

`privacy.html` and `sms-terms.html` keep their **shorter** nav and no script tag.
They are load-bearing for A2P registration and are plain HTML by design — which
means no hamburger, so a full link list would be unreachable on a phone, where
`.nav__links` is `display:none` until 721px. Do not "fix" that.

`Examples` lost its nav item. The Serve Standard section (`#examples`) is
unchanged and still in its position.

### The CTA pulse

A slow halo on the hero and header CTAs only. Four properties, all load-bearing:

- **`box-shadow`, never `transform: scale`.** Scaling a button with a text label
  shifts it off the pixel grid and the label goes visibly soft mid-cycle.
- **Stops on hover and focus.** A button still pulsing under the pointer reads
  as unresponsive.
- **Retires on engagement.** `serveRetirePulse()` fires on first interaction
  with `#quote`. The pulse means "notice me"; once noticed it is only motion
  competing with the form.
- **Respects `prefers-reduced-motion`.**

The halo is white, not the brand accent. Both CTAs sit on the dark navy, and a
`#4b5563` halo on a gray button against that bar is invisible. `--serve-accent`
and `--serve-accent-rgb` are defined as the existing brand gray and used for
inline links, the arrival cue and the on-light pulse variant.

The existing button shadows are repeated inside both keyframe sets. `box-shadow`
is one property — animating it without the insets drops the bevel for the whole
cycle.

### Two tests were changed, and why

The nav CTA moved from `#quote` to `/#quote` so one nav block can be
byte-identical across three files. `static-checks` §10 and `segment-and-skins`
§4 both matched the literal `href="#quote"` and went to zero matches. Both now
accept either form. **The assertion itself did not weaken** — what is under test
is that every control leading to the quote flow reads `Instant quote`, which is
unchanged and still enforced at exactly three controls.

### Still open

- **The `$130/hr` top end.** Homes at 5+ bedrooms still fall through to the
  hourly custom-quote path — the one pricing mechanic the brand otherwise
  rejects. The published table stops at 3BR/2BA and 4BR still gets a flat rate,
  so the wall is two rows past the table's edge; that is why this shipped. The
  real fix is separating fixed overhead from marginal rate at the top end and
  extending flat-rate pricing upward. Uriel decided on 2026-08-19 to ship
  without it.
- **No browser verification.** The Chrome extension was not connected during
  this build, so the pages were verified by executing the real module against a
  fake DOM, by static assertions, and by serving `_site` locally and confirming
  every route returns 200. **Nobody has looked at these pages rendered.** Do that
  before pointing traffic at them.

---

## Session 2026-07-28

Seven planned tasks, plus an unplanned privacy migration that took priority.

### The site moved hosts and the repo went private

**This was not planned work.** While adding `/tests` I checked what the GitHub
Pages workflow published and found `path: .` — the whole repository. Verified
live: `servecleaning.com/IDENTITY.md` returned HTTP 200. A personal profile —
name, university, employers, business strategy — was readable on the business's
own marketing domain, along with `CLAUDE.md`, the data schema and the Apps
Script source. It had been that way since the repo was first published.

The repo was also public, so deleting files would not have removed them from
history, and the free plan requires a public repo for Pages.

What was done, in order, with no downtime:

1. `IDENTITY.md` moved out of the repo to `~/.claude/serve-private/`.
2. The notification address moved from a hardcoded constant to a Script
   Property, read by `notifyEmail()` with a fallback to the executing account.
3. Every personal identifier purged from **all 47 commits on both branches**
   with `git filter-branch`, verified term by term, then force-pushed. A mirror
   backup was taken first.
4. Site rebuilt onto **Cloudflare Workers** with an allow-list publish. DNS was
   already on Cloudflare, which made this simpler than the Netlify route
   originally recommended — that recommendation rested on avoiding a nameserver
   move that had already happened.
5. GitHub repo made **private**. Cloudflare keeps deploying via OAuth.
6. GitHub Pages workflow and `CNAME` removed — a dormant workflow would
   re-publish the repo root on the next push, which is the dangerous kind.

**A near-miss worth knowing:** the first Cloudflare deploy read **2235 files**
from the repo root and only failed because a 122 MiB binary in `node_modules`
exceeded the asset size limit. `wrangler deploy` auto-detects the output
directory as `.` when unconfigured. Had the repo been slightly smaller,
everything would have gone straight back up. `wrangler.jsonc` now pins
`assets.directory: "./_site"` and that is the single most load-bearing file in
the repo for privacy.

Four mechanisms now enforce this and all four matter:
`scripts/build-site.sh` (the allow-list), `wrangler.jsonc` (the asset pin),
`.gitignore`, and `tests/privacy.test.js`, which fails `npm test` if any of the
others drift.

### The test suite is now in the repo

Eight harnesses from the previous build lived only in a temporary scratchpad.
They are now `/tests`, run by `npm test`, with repo-relative paths so they work
from a clean clone. **Eleven files, no dependencies, no framework** — they
execute the real source, including running each `.gs` inside a `vm` with
simulated Sheets and an audited write trail, so a test can assert *how many*
writes happened and to which cells.

`gs-harness.js` was deliberately not carried over: it asserted the pre-Part-7
contract where `notes` was a blob holding pets and contact details. That was
replaced on purpose, so the file tested a contract that no longer exists.

### `segment` is an intent taxonomy

Resolved to `movein · pro · direct`. Channel was already recorded twice —
`source` holds the full first-touch tag, `src_chain` holds every tag — so a
third channel field said nothing new. `segment` now answers what the person
*needs*, which is what selects the hero. Full prefix table in `SCHEMA.md`.

No backfill was needed: `JOBS.segment` held `direct ×1` and blank ×12, with no
channel values anywhere.

### Hero skins and vanity URLs

Two headline variants selected by **first** touch — a visitor who arrives on a
deed link and later scans a poster QR keeps the mover headline, because the
poster did not change why they need a clean. Only the headline varies; the CTA
is `Instant quote` everywhere, asserted by test. The default hero lives in the
HTML rather than being rendered by JS, so an unknown segment, blocked storage or
a missing element all leave the authored page standing.

`/movein` and `/clean` redirect to the index carrying a `src` tag, so the skin
and the attribution come from the one normal first-touch path rather than a
second mechanism that could disagree with the sheet.

Attribution moved to module scope so the hero and the booking flow read one
`SERVE_ATTRIBUTION` object. `segment` cannot differ between what a visitor sees
and what is written.

### The 15-minute promise

The confirmation panel now says a confirmation email arrives within 15 minutes,
with the footer's existing address as the fallback. No phone number was added;
a `TODO(twilio)` marks the swap.

The 15 minutes is the whole point. When a write fails there is no row **and** no
notification email, so from the customer's side a failed booking is
indistinguishable from a successful one — forever. A stated window turns silence
into something they notice and act on.

### PROPERTIES and slot write-back

Both described fully in `SCHEMA.md`. The shape worth remembering:

**A reservation now touches four tabs across two workbooks**, and **only the
JOBS write can fail the request.** LEADS, PROPERTIES and AVAILABILITY all run
after the booking is safely recorded; each failure is reported in the
notification subject and none reaches the customer.

`PROPERTIES` and `AVAILABILITY` stay on the protected list. Each has a narrow
allowance — `assertPropertiesWritable()`, `assertAvailabilityWritable()` — that
throws for any tab other than its own, so the exception cannot widen.

**A slot conflict is not an error.** If someone takes a slot inside the
five-minute feed cache, the booking is still written and the subject carries
`· SLOT CONFLICT`. Refusing it would punish the customer for our caching.

### Two things the live runs taught us

**The test fixture was dead.** `testPayload` hardcoded `2026-08-14` at
`"9-11 AM"` — a date and a window-style time that never existed in
`AVAILABILITY`, which publishes single start times. Every run reported a
conflict and the happy path was never exercised once. It now reads the sheet and
books a genuinely open slot, preferring a future one.

**Auto-cleanup destroyed the evidence.** A version of `testPayload` deleted its
rows six seconds after writing them, before anyone could look at the sheet —
which is the entire reason to run it by hand. The log only proves the calls
returned ok; whether `notes` is populated is visible in the sheet or nowhere.
It now leaves the rows and prints a checklist; `cleanupTestRows()` is run
separately when you are done.

Both were caught because Uriel questioned output that looked wrong. Neither was
a bug in the writes — both were instrumentation that hid the truth.

---

## 1. What Serve is, and what this system does

Serve is an early-stage home cleaning business in Greater Boston. No platform, no
backend, no database. The whole product is:

- **A single static page** — `index.html` + `script.js` + `style.css`, vanilla,
  no frameworks, served by Cloudflare Workers at `servecleaning.com` from a
  PRIVATE GitHub repo, publishing an allow-list (see the 2026-07-28 section).
- **Two Google Apps Script web apps**, each bound to a different spreadsheet.
- **Two Google Sheets** doing the work a database would.

The goal is lead capture and demand validation, not software. Simplicity beats
architecture; the repo's `CLAUDE.md` says so explicitly and it still holds.

### The booking flow

Three steps in one page, `Build → Price → Reserve`:

1. **Build** — ZIP, bedrooms, bathrooms, service type, condition. No identity
   collected yet.
2. **Price** — instant deterministic quote, add-ons, recurring frequency,
   "what's included". Still no identity.
3. **Reserve** — pick a real time slot (or a general preference), then name,
   email, phone, address, and a free-text notes box.

Identity is deliberately deferred to step 3. Steps 1 and 2 can be abandoned with
no friction, and there are two lighter capture points along the way (email-me-
this-quote, and an out-of-area waitlist).

### Data flow

```
visitor → servecleaning.com (static)
            │
            ├── GET  availability feed ──→ Ops sheet · AVAILABILITY
            │        (time slots for step 3)
            │
            └── POST booking ────────────→ Leads MASTER · JOBS + LEADS
                                            └→ notification email
```

---

## 2. What changed in this build

Everything below is new or rewritten in this pass.

### 2a. The bug that started it

Bookings made through the **time-slot picker** were landing in the sheet with an
empty `notes` column, while bookings made through the older **earlier/later**
radios populated it fine. The notification email showed the time correctly in
both cases, so the failure was invisible from the inbox.

**Cause:** the two scheduling controls write different payload keys —
`slot_date`/`slot_time` versus `time_preference`/`schedule_preference` — and only
`schedule_preference_label` was populated on both paths. The receiving script
read a single key.

**Fix:** `normalizeSchedule()` resolves one answer in priority order —
structured slot → preference → label backstop → `"No time specified"` — and is
the only thing that decides scheduling. The summary is never empty.

### 2b. Bookings can no longer silently vanish

The POST used `mode:'no-cors'`, which makes the response unreadable. The customer
saw "You're on the schedule" whether or not the write succeeded — the worst
possible failure on a lead path.

Now:
- The POST sends `Content-Type: text/plain`, which keeps it CORS-simple so no
  preflight `OPTIONS` is fired (Apps Script cannot answer one). The `.gs` reads
  `e.postData.contents` either way.
- The success panel only shows on a confirmed `{status:"ok"}`.
- If the readable POST fails for any reason, it retries **once** as the old
  fire-and-forget call, then still shows success with a console warning — a
  customer never gets an error screen for a booking we probably received.
- A client-generated `submission_id` (UUID) makes that retry safe: the server
  skips any `submission_id` it has already written.
- The submit button disables on click, and a re-entry guard blocks the
  Enter-key/click double-fire.

### 2c. Attribution

`src` tags (printed on posters, QR codes, door hangers) were already captured,
but **last-touch only** — a second tagged link mid-session overwrote the tag that
actually earned the visit.

Added, without disturbing the existing behaviour:
- `serve_src` — first touch, written once per session, never overwritten.
- `serve_src_chain` — every distinct tag in order, e.g. `dh-bh-01>ref-jordan-m`.
- `segment` — derived from the first-touch prefix via an editable table.
- All of it degrades quietly if `sessionStorage` is unavailable (private mode).

Verified: survives refresh and back-button; a second tagged link moves last-touch
but not first-touch.

### 2d. Customer notes and the pets flag

A free-text box on the reserve step ("Pets, parking, how to get in, rooms to
skip…"), captured as `customer_notes`.

`pets_flag` is derived from that text by keyword match. It is **word-boundaried
and deliberately negation-blind**: "carpet" does not read as "pet", but "no
animals" flags TRUE. Over-flagging is the intended failure direction — arriving
unprepared for a dog is worse than a false positive. The notification email
subject appends `· PETS`.

### 2e. The availability feed can no longer strand a customer

The feed was dead (bound to a Google account the Ops sheet had left) and there
was no timeout — only error handling. A feed that *hung* rather than failed would
leave the customer on "Loading times…" with the radios hidden and no way to book.

Now: one named constant, a 5s abort cap, a second independent fail-safe timer, an
empty-string short-circuit that skips the network entirely, and every failure
path — no URL, network error, non-200, bad JSON, no slots, hang — landing on the
working earlier/later radios.

**Principle worth keeping: the scheduler degrades, bookings never block.**

### 2f. "After you book" section

A new page section answering what happens next — confirmation timing, access and
parking, pets, what to expect on the day, the photo-verified walkthrough. Linked
from How It Works step 3 and from the reserve step.

Deliberately a **sibling** of the quote flow, not a step panel, so it stays
readable at every stage. All styles are `.svmA-` prefixed so nothing bleeds.

### 2g. Smaller front-end fixes

- Add-on toggles are cleared from state *and* DOM when the service isn't First
  Clean — a ticked box could previously stay ticked but invisible on Move Out,
  then reappear.
- The Move In/Out "what's included" list now names fridge and oven interiors
  explicitly, since those are paid add-ons on a First Clean and the toggles are
  hidden on Move Out.
- CTA copy unified to sentence case across the hero and both nav pills.

### 2h. The receiving script, rebuilt

`/apps-script/webhook.gs` replaces the previous script and is now the repo's
source of truth.

- **Header-driven writes.** It reads row 1 and fills the columns that exist, in
  whatever order. It never appends a column, so it can never split history
  across a duplicate header.
- **Identity model.** `submission_id` = one per POST (dedupe key).
  `lead_id` = one per person (normalized lowercased email, else `property_key`).
  `job_id` = one per booking, `SRV-yyyyMMdd-XXXXXX`, deterministic.
- **LEADS upsert.** Matches an existing person and updates in place: blank cells
  only, `source_history` appended, `last_touch` bumped, `first_touch` never
  touched. If the upsert fails the JOBS row is still written and the email says
  so — a booking is never lost to bookkeeping.
- **Protected tabs.** `assertWritable()` throws rather than writing to
  `PROPERTIES`, `RAW_INTAKE`, `OUTREACH_LOG` or `DASHBOARD`. Names are normalized,
  so spacing or a rename cannot disarm the guard.
- **Atomic JOBS write.** One `appendRow` of an array built completely in memory
  first — a whole row or no row, never a half-populated one.
- **Non-reservation events** route to an `EVENTS` tab, auto-created if missing.

### 2i. The availability endpoint, hardened

`/apps-script/availability.gs`, now versioned in the repo.

- **Fails loudly on a bad header.** Previously a renamed or mis-cased header made
  every row skip and returned a cheerful `{ok:true, slots:[]}` — which the site
  reads as "no availability" and answers by silently dropping the scheduler. Now
  a missing header returns `ok:false` naming what was expected and printing what
  row 1 actually says.
- **No timezone dependence.** It mixed script-project and spreadsheet timezones,
  which could shift a published date by a full day. Values are now recovered with
  local getters that round-trip exactly, and `Utilities.formatDate` is unused.

### 2j. Timezones, generally

All date formatting pins a `BUSINESS_TZ = "America/New_York"` constant. There is
no remaining `Session.getScriptTimeZone()` call in either script, so output does
not depend on a project setting nobody remembers to check.

---

## 3. Live state, and how to check it

| | Booking webhook | Availability feed |
|---|---|---|
| Source | `/apps-script/webhook.gs` | `/apps-script/availability.gs` |
| Spreadsheet | Leads MASTER | Ops |
| Constant | `SHEETS_URL`, `script.js` ~155 | `AVAILABILITY_SOURCE_URL`, `script.js` ~174 |
| Deployment id starts | `AKfycbxVWfrn2Mos…` | `AKfycbzumNZZ9KI5…` |
| Version | `2026-07-28 r6` | `2026-07-27 avail r2` |
| Dry-run in editor | `reportLeadsSchema()` → `testPayload()` | `testAvailability()` |

Both deployed **Execute as: Me**, **Access: Anyone**. Anything else and the
browser gets a login page instead of JSON.

**Health check:** open either `/exec` URL in a browser. Each returns its version
stamp. If the stamp is older than the repo, what is deployed is stale — saving
the editor does not redeploy.

Verified at merge: live `script.js` byte-identical to the repo, both constants
resolving to the current deployments, `Access-Control-Allow-Origin: *` present,
and the live 9-slot feed rendering correctly through the site's own filter. The
two superseded deployments were archived and confirmed returning 404.

---

## 4. Conventions this project runs on

Break these and things fail quietly, which is the failure mode this build spent
most of its effort eliminating.

1. **`/docs/SCHEMA.md` is the source of truth** for column meaning and ownership.
   Any change that adds, renames or repurposes a column updates it *in the same
   commit*. Read it during recon; never ask for it to be pasted, since that is
   how context gets truncated.
2. **Anything a future reader would need goes in the docs, not the chat.** If
   something changes how the system behaves or fails, it belongs in
   `SCHEMA.md` or here. Chat scrolls away.
3. **Version stamps move on any behavioural change**, not just schema changes.
   They are the only drift detector between deployed and committed code.
4. **Tab names use underscores.** Anything comparing them must normalize.
5. **Pricing math is not touched** without an explicit decision. `PRICING`,
   `ZIP_TIERS` and `computeQuote` in `script.js` are deterministic and load-bearing.
   *Coverage* is the exception — which ZIPs are listed at all is an operator call,
   not a pricing one, and a ZIP in neither tier is silently refused a quote and
   shown the waitlist. That is a lost lead, and it happened: a Seaport visitor
   (02210) was turned away on 2026-08-14 because five Boston-proper ZIPs and
   Brookline Village had never been listed. `tests/service-area.test.js` now
   pins the sold-to list; expand coverage there in the same commit.
6. **Vanilla HTML/CSS/JS only.** No frameworks, no build step, no dependencies.
7. **The booking flow degrades, never blocks.** Every failure in the scheduler,
   the feed, or the LEADS upsert must still let a customer book.
8. **Never widen a sheet the operator designed.** Header-driven writes; report
   what has no column rather than creating one.
9. **A new page needs four things, not one.** A file added to the repo is
   private by default — `scripts/build-site.sh` publishes an allow-list, which
   is the mechanism that keeps engineering docs and personal material off the
   marketing domain. So a page also needs: a `cp` line in that script, a cache
   rule in `_headers` (both `/page` and `/page.html` — the asset server resolves
   one to the other), and an entry in `sitemap.xml`. Miss the build script and
   the page 404s in production while working perfectly on a local file open.
   `tests/pricing-and-services.test.js` §9 pins this for the two current pages.
10. **Published prices are never literals.** Every price on the site renders by
   calling `computeQuote`. A number typed into HTML is a promise that goes stale
   the next time `PRICING` changes, silently, on a page nobody re-reads.
11. **The SMS consent surface is regulated, not cosmetic.** `/privacy`,
   `/sms-terms`, the two consent checkboxes and their wording were submitted to
   Twilio for A2P 10DLC registration, and carriers re-check them *after*
   approval. Breaking one can revoke a live campaign and silence every booking
   confirmation. Never bundle the two checkboxes, pre-check one, make one
   required, move the policy links inside a label, or reword the
   mobile-information paragraph in `/privacy`. `tests/sms-consent.test.js`
   enforces all of it; if a change makes that test fail, the change is wrong.
   Consent is written `"yes"` or blank — **never `"no"`**, because LEADS is
   blank-fill-only and a `no` would lock out a real opt-in forever.
12. **Nothing in `serve-geo-data.js` is user-facing.** Not the size factor, not
   the parking tier, not the neighbourhood labels. The customer sees one price.
   Factor and tier go to `quote_meta` for later analysis and nowhere else.
   `tests/geo-pricing.test.js` §7 greps every rendered surface and fails if
   either leaks.
13. **Published prices are computed at an explicitly neutral basis, never at a
   real ZIP.** `SERVE_RANGE_GEO` states it: factor 1.00, no parking adder, and
   `SERVE_RANGE_ZIP` supplies only the CORE tier so no travel fee is baked in.
   Anchoring on a neighbourhood was tried twice and broke twice — 02116 carried
   a 1.30 factor, and 02130 was neutral only while 19 ZIPs shared a bucket. A
   regenerated map must never be able to reprice three pages as a side effect.
   Pinned by test.
15. **Any index that scales the size base must control for everything the base
   already charges for** — bedrooms, baths AND levels. Controlling for a subset
   bills the same square footage twice. That shipped for one day in the LARGE
   tier and cost up to 31% on a quote. When the map is regenerated from newer
   parcel data, regenerate it on the same three axes, and keep both data sources
   on one scale (see the 0.9825 note in `serve-geo-data.js`).
14. **Pricing constants are guesses; the geo data is not.** Do not let their
   adjacency imply otherwise. See the banner above `PRICING` in `script.js` and
   the 2026-08-20 session notes — changing a coefficient is a business decision
   until `duration_min` has enough rows to fit against.

---

## 5. What to work on next

Roughly in priority order.

### 5-0. Add three headers to LEADS · blocking, before any SMS is sent

Not code, and it gates the Twilio number. Add these to the end of the LEADS
header row, spelled exactly:

```
sms_transactional    sms_promotional    sms_consent_at
```

Webhook r7 already writes them (`tests/leads-upsert.test.js` §9 proves it against
the 22-column shape). Until the headers exist the upsert logs
`LEADS has no column for: … — skipped.` and writes nothing, so bookings are
unaffected — but **consent given in the meantime is not recorded anywhere except
the per-booking `quote_meta` snapshot on JOBS.** Consent has to exist at the
moment a message is sent and cannot be reconstructed afterwards, so do this
before the first text goes out, not before the first booking.

Format `sms_consent_at` as a date column. The webhook writes a real `Date`; a
column formatted as plain text will hold something that only looks like one.

### 5-1. What happens when someone types a ZIP we don't recognise · deferred 2026-08-21

Uriel entered **02216** on the live site and was shown the out-of-area waitlist.
It looks like a coverage gap next to 02215 Fenway/Kenmore. **It is not.**

Checked against the 184,552-parcel Boston assessment: **02216 has zero parcels of
any kind** — no residential, no commercial. It is a PO Box / institutional ZIP,
not a place anyone lives. Turning it away is arguably the correct answer.

The same sweep says coverage is complete: **every Boston ZIP with 25 or more
residential parcels is already in `ZIP_TIERS`.** There is no missing
neighbourhood. The only unserved ZIPs carrying any residential parcels at all
are 02026 (4 homes — Dedham, outside the area), and **02146, the retired
Brookline ZIP** that was split into 02445/02446. Someone in Brookline who still
writes their old ZIP from memory gets the waitlist today; that one is worth
adding, and is the single real instance of this.

**So the thing to work on is the failure mode, not the list.** An unrecognised
ZIP currently means "we do not serve you", when it can equally mean a typo, a PO
Box, a retired code, or somewhere genuinely outside the area. Convention #5 says
a ZIP in neither tier is a lost lead, and that already cost a real Seaport
visitor on 2026-08-14.

Options when this is picked up, roughly in order of how much they change:

1. **Add 02146** and any other retired-but-still-used codes. Trivial, purely
   additive, no downside.
2. **Separate "unknown" from "outside our area".** A ZIP that is not in
   `ZIP_TIERS` and not in the parcel data is probably a typo or a PO Box — worth
   saying "check that ZIP" rather than "we're not there yet", because the second
   ends the conversation.
3. **Quote unknown ZIPs anyway at the neutral factor and flag the row for
   review.** The engine already prices a ZIP it has never seen without throwing
   (`DEFAULT_GEO`), so this is a UI decision, not an engine one. Trades a
   possible out-of-area job for a lead that is currently discarded.

Nothing here is urgent — coverage is genuinely complete — but option 1 is a
five-minute fix and option 2 is where the lost leads actually are.

### 5a. Clear the stale `open` rows in AVAILABILITY · trivial, do it first

Not code. `AVAILABILITY` accumulates past-dated rows that stay `open` forever
because nothing expires them. Customers never see them — the feed's 18-hour lead
time hides them — but anything scanning for "an open slot" finds them first, as
`testPayload` did on 2026-07-28 when it booked a slot three days in the past.
Delete or close them.

### 5b. Nothing releases a slot on cancellation · next real build

Write-back marks a slot `booked`, but if a booking is cancelled the row stays
booked forever. The `job_id` written back is the handle for undoing it; no code
does that yet. This is the natural follow-on to the write-back and gets more
urgent as soon as a real customer cancels.

### 5c. Slot depth is one cleaner deep · roster, not code

Write-back prevents a slot being sold twice, but with a single `open` row per
time a conflict is still a genuine clash rather than a queue. More
`AVAILABILITY` rows per time means `open: 2+` and real resilience. You cannot
publish depth that does not exist, so this resolves as the roster fills.

### 5d. Finish the LEADS schema

Five columns are still `TO DEFINE`: `source_detail`, `contacted_via`, `status`,
`first_variant`, `dnc_scrub`. The rule in `SCHEMA.md`: scroll the column — if it
has values, those values are the definition; if it is empty it has never been
used, so define it or delete it. Do not let a script write to a column whose
meaning is unresolved.

`ltv` also has no formula. It should sum `final_price` in JOBS per `lead_id`.

### 5e. `PROPERTIES` is only half populated

The webhook now writes six columns on every booking, but `neighborhood`,
`property_type` and the deed fields still come from nowhere. Promoting
`RAW_INTAKE` rows into `PROPERTIES` is the obvious next step — the deed data is
already sitting there.

### 5f. Operational, not code

- **The 5-minute cache.** A row added to `AVAILABILITY` takes up to five minutes
  to appear on the site. `?nocache=1` bypasses it for checking.
- **Test rows.** `testPayload()` leaves its rows deliberately so you can inspect
  them. Run `cleanupTestRows()` afterwards or they accumulate.

### 5g. The real ceiling, when you get there

Hosting and schema are solved for now. The thing that will actually break is
**Google Sheets as the database** — no transactions, no real locking, no
relational integrity. The slot write-back papers over the worst symptom.

Do not move early: Sheets is readable, the ops team is one person, and data can
be fixed by hand. **The signal is when manual correction becomes weekly rather
than occasional.** At that point the booking webhook becomes a real endpoint
over a real database — Supabase or Postgres — with Sheets demoted to a read-only
view. Cloudflare Workers was chosen partly so that step is a file in this repo
rather than a fourth vendor.

---

## 6. Things that will bite you

- **Two spreadsheets, two scripts, two deployments, and two timezone settings
  each** (spreadsheet vs Apps Script project). They are independent. Changing one
  does not change the other.
- **Apps Script breaks when signed into multiple Google accounts.** Symptom is a
  useless "An unknown error has occurred". Use an incognito window signed into
  only the owning account.
- **Saving the editor does not redeploy.** `/dev` runs the latest saved code and
  is owner-only; `/exec` runs the last *deployed* version and is what the site
  talks to. Deploy → Manage deployments → pencil → New version keeps the URL;
  "New deployment" mints a different one.
- **Archive superseded deployments.** They keep answering and keep writing
  wherever they were bound. Browsers cache `script.js` for hours after a push, so
  stale copies keep POSTing to the old URL.
- **The site's `notes` and `customer_notes` are different things.** `notes` is the
  schedule summary and is never empty; `customer_notes` is the customer's own
  words and is often blank. Never merge them.
- **Contact details are duplicated in JOBS and LEADS on purpose.** LEADS is the
  canonical person record; the JOBS copy is a point-in-time snapshot, the way an
  order snapshots customer details. Do not normalize it away.
- **`add_on_rev` is 0 on every move-in/out job by design** — fridge and oven are
  bundled into the multiplier there. Do not impute $85.
