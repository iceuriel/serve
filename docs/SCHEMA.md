# SERVE — DATA SCHEMA

**Location:** `/docs/SCHEMA.md` in the site repo.
**Purpose:** the single source of truth for what every column means and who writes it.

**Companion:** `/docs/HANDOFF.md` — current system state, what the last build
changed, and what to work on next. This file is the contract; that one is the
narrative.

**Rules:**
1. Any build that adds, renames, or repurposes a column updates this file **in the same commit**. No exceptions.
2. Claude Code reads this file during Phase 0 recon. It is never pasted into chat — pasting is how context gets truncated.
2a. Anything a future reader would need lives in the docs, not the chat. If it changes how the system behaves or fails — a risk, a gotcha, a deferred decision — it belongs in this file or `HANDOFF.md`. Chat scrolls away.
3. Workbook: **Leads MASTER**, owned by servecos.com. Tabs: `PROPERTIES · LEADS · JOBS · OUTREACH_LOG · RAW_INTAKE · DASHBOARD` (+ `EVENTS`, auto-created).
4. Tab names use **underscores**, not spaces. Anything comparing tab names must normalize.

**Writer legend:**
`WH` = webhook.gs writes it · `OPS` = the operator fills it by hand · `FX` = formula · `MAN` = manual import (deed batches, Apollo)

---

## JOBS — one row per booking

| # | Column | Writer | Meaning |
|---|---|---|---|
| 1 | `job_id` | WH | `SRV-yyyyMMdd-XXXXXX`. One per booking. Deterministic from `submission_id`. |
| 2 | `lead_id` | WH | Foreign key to LEADS. Person-level, stable across bookings. |
| 3 | `source` | WH | **First-touch** src tag (e.g. `dh-bh-01`). Not last-touch. |
| 4 | `property_key` | WH | `ZIP-ADDRESS-UNIT` normalized. Join key to PROPERTIES. |
| 5 | `service_type` | WH | `First Clean` or `Move In / Move Out`. |
| 6 | `frequency` | WH | `once` · `weekly` · `biweekly` · `monthly`. |
| 7 | `condition` | WH | Condition multiplier tier selected at quote. |
| 8 | `beds` | WH | Bedrooms. `0` = studio. |
| 9 | `baths` | WH | Bathrooms. |
| 10 | `quoted_price` | WH | Price displayed at quote time. |
| 11 | `add_ons` | WH | Human-readable list. **Blank on move-in/out** — bundled into the multiplier. |
| 12 | `add_on_rev` | WH | Add-on dollars. **Always 0 on move-in/out by design.** Do not impute $85. |
| 13 | `final_price` | WH | First-visit total charged. |
| 14 | `scheduled_date` | WH | Requested date `YYYY-MM-DD`. Blank when the customer chose earlier/later only. |
| 15 | `completed_date` | **OPS** | Filled after the job. Never touched by the script. |
| 16 | `cleaner` | **OPS** | Who performed it. Never touched by the script. |
| 17 | `start_time` | WH | Requested window (e.g. `9–11 AM`) or preference label. |
| 18 | `duration_min` | **OPS** | **CLEANER-minutes, not elapsed minutes.** Two people for 3.5 hours is `420`, not `210`. **Input to the frontier time standard — protect this data.** See below. |

> **`duration_min` is cleaner-minutes.** Multiply elapsed time by the number of
> people who worked. This is the single most consequential definition in the
> workbook and it was ambiguous until 2026-08-28.
>
> Every hours figure in `script.js` — `WORK_RATE`, `WORK_MODEL`, `LEVEL_HOURS`,
> the $35 floor, every margin scenario — is denominated in cleaner-hours,
> because that is the quantity a second cleaner does not change: two people
> halve the clock and halve the rate each. A single row logged as elapsed time
> on a two-person job would halve the apparent work and silently reprice
> everything downstream.
>
> `SRV-20260812-11B353` is recorded as `420` for a job that ran 3.5 hours with
> two people. That is correct and is the convention.
| 19 | `photos_passed` | **OPS** | `TRUE`/`FALSE`. Photo-verification QA gate. |
| 20 | `payment_status` | **OPS + SCRIPT** | **Changed 2026-09-15 (r50) — this used to read "never touched by the script".** Stripe now writes it through one exempt path. Values the code recognises: blank · `authorized` · `paid` · `released` · `refunded`. See below. |
| 21 | `job_status` | WH → OPS | Script writes `new` at booking, and `cancelled` when a customer calls the visit off in their portal (r43). Operator updates otherwise. **A cancelled booking is never deleted** — see below. |
| 22 | `notes` | WH | **Schedule summary only.** Human-readable, never empty. Not customer text. |
| 23 | `submission_id` | WH | Client-generated UUID. **Idempotency key.** Dedupe runs on this. |
| 24 | `received_at` | WH | Server-side ISO timestamp, America/New_York. |
| 25 | `name` | WH | Point-in-time snapshot. LEADS is canonical; this is deliberate duplication. |
| 26 | `email` | WH | Snapshot. |
| 27 | `phone` | WH | Snapshot. |
| 28 | `segment` | WH | `movein` · `pro` · `direct`. Derived from the src prefix. |
| 29 | `src_chain` | WH | Every tag seen within the 30-day attribution window, `>`-separated. Was "the session" until 2026-08-30, when attribution moved to localStorage so a card scanned on Tuesday still credits a booking made on Thursday. |
| 30 | `customer_notes` | WH | **Customer free text only.** Never mixed with `notes`. **Blank at booking since 2026-09-01** — arrives later via a `job_notes` event from the confirmation screen, which fills this cell in place. A booking with no notes now means "not yet asked", not "nothing to say". |
| 31 | `pets_flag` | WH | `TRUE`/`FALSE`. Keyword-derived from `customer_notes`, **server-side**, when the `job_notes` event lands. Negation-blind — over-flags on purpose. Blank until then; the site no longer sends it, deliberately, because `FALSE` would read as "asked, no pets" when nobody was asked. |
| 32 | `scheduling_type` | WH | `slot` · `preference` · `label` · `none`. |
| 33 | `address` | WH | Street address snapshot. Real column, not `quote_meta` — ops sorts and filters on it. |
| 34 | `unit` | WH | Unit/apt. |
| 35 | `zip` | WH | ZIP. |
| 36 | `quote_meta` | WH | JSON blob: secondary quote data only (`original_price`, `discount_applied`, `steady_state_price`, the three recurring prices, `zip_tier`, `page_path`, `utm_*`, `unit_label`, `src`, `submitted_at`, the two SMS consent flags, plus `zone` / `park_tier` / `levels`, and `quote_sig` / `quote_scope` / `quote_version` — see below). |
| 37 | `payment_ref` | **SCRIPT** | Added 2026-09-15 (r50). The Stripe PaymentIntent (`pi_…`) behind whatever `payment_status` says — the handle that ties this row to the Stripe dashboard, and what gets voided when a customer cancels. **Optional**: where the header is absent the payment state still writes and the omission is logged. Reaches no view model. |

### The columns ops actually owns, and the one exception — r50

Two columns on this tab are written by no one but a person, and one used to be:

| | |
|---|---|
| `completed_date`, `cleaner`, `duration_min`, `photos_passed`, `partner_payout`, `vendor_id`, `operator_id` | **still ops-only.** `setJobCells` throws if anything tries. |
| `payment_status` | **ops, plus exactly one script path.** |

**Why the promise changed.** The old rule made sense while the only way Serve
learned about money was a person seeing it arrive. Once `/api/checkout` started
placing real holds, the sheet had no way to find out one existed — so a
customer who authorized ninety seconds ago reloaded their portal and was told
"Not yet authorized", with the Authorize button still inviting a second hold on
the same card. Stripe knows sooner and more exactly than a person can.

**The exemption is one function, not a door left open.** `payment_status` is
still in `OPS_OWNED_COLUMNS`, which guards `setJobCells` — the booking form,
the portal writes, the reschedule and the cancellation are all still refused.
`handlePaymentEvent` writes the cell directly, behind `PAYMENT_BRIDGE_SECRET`,
and nothing else does.

**The two sources coexist.** An operator typing `paid` for a customer who paid
by check still works and is still correct. Stripe never blanks a hand-typed
value; the rank guard below decides who wins.

**Three states, because the flow has three.** `paid` keeps its exact old
meaning — money actually taken. `authorized` is the hold in between, where the
funds are guaranteed to Serve and nothing has left the customer's account.
Writing `paid` on a mere hold would tell somebody they had been charged when
they had not, which is the specific lie this column previously had no way to
avoid. `released` (hold voided or lapsed) and `refunded` are the two reversals.

**The rank guard: once money has actually moved, only news about money that has
actually moved may overwrite it.** Stripe retries failed deliveries for days
and promises no ordering, so `amount_capturable_updated` can arrive *after*
`succeeded` — which, written naively, turns a captured payment back into a mere
hold and re-offers the Authorize button to somebody already charged. Below that
line (blank, `released`, `authorized`) nothing has left anyone's account and
every transition is allowed, including the ordinary `authorized` → `released`
of a cancelled booking.

### `partner_payout` — documented 2026-09-15, and it predates this note

**This column has existed since r13 and appeared nowhere in this file**, which
breaks the first rule at the top of it. Recorded now rather than left to be
rediscovered.

| | |
|---|---|
| **Owner** | **OPS.** Set by hand at dispatch. Never written or blank-filled by the script. |
| **What** | What the partner *company* is paid for this job, in dollars. |
| **Beside** | `payout_rate` in `quote_meta`, which derives a payout from the ticket. **This column wins wherever it is set** — it is how one job gets a different answer (a difficult home, an apology, a bonus), and a derived figure must never quietly replace a number a human chose. |

**It is not the customer's money and must never be confused with it.** Customer
→ Serve is `payment_status` and `/api/checkout`. Serve → partner is this
column, and nothing built for payments touches it. **The customer never pays
the partner**, and the joint-employer position depends on that staying true.

### `discount_applied` in `quote_meta` — values changed 2026-09-16

Comes straight from the pricing engine's `discountLabel` as of 2026-09-16.
**It used to read `None` on every move clean and every large heavy home**,
because script.js assembled it from a hardcoded `'First clean 50% off'` plus a
boolean. Those tickets now carry a real 15% discount, so the four values are:

| value | discount |
|---|---|
| `First clean 50% off` | 50% |
| `Move clean 15% off` | 15% |
| `Large heavy home 15% off` | 15% |
| *(`None` no longer produced)* | — |

`None` still appears on rows written before 2026-09-16. **Reporting that sums
discounts must not treat a pre-2026-09-16 `None` as "no discount applied"** for
a move clean — at that time it meant no discount *existed* for that service.

`original_price` is the undiscounted anchor on every path now. It was `null` for
move cleans and no-stack homes before this date, and script.js fell back to the
shown price — so on those older rows `original_price` equals the price paid.

### `payout_rate` in `quote_meta` — added 2026-09-11 (webhook.gs r24)

The share of this booking that goes to the partner company. `0.85` means the
partner is paid 85% of the ticket and Serve keeps 15%.

**There are TWO rates as of 2026-09-16, and which one is stamped depends on the
home.** A **half-price first clean** is stamped `0.98`; **everything else** is
stamped `0.85`.

| booking | discount | `payout_rate` | Serve keeps |
|---|---|---|---|
| first clean, under 4BR **or** not heavy | 50% | **0.98** | 2% |
| first clean, 4BR+ **and** heavy (no-stack) | 15% | 0.85 | 15% |
| move in / move out | 15% | 0.85 | 15% |
| recurring visit | none | 0.85 | 15% |

**Why:** Serve's cut is 15% and the first-clean discount is 50%, so a 50%
discount cannot be funded out of the margin. At the ordinary `0.85` the partner
would be paid 85% of a *halved* ticket — 42.5% of the job's real price, for work
the pricing model costs at 67% of it — and the cleaning company would absorb
almost the whole discount. At `0.98` Serve is near break-even on that visit by
design; the **recurring** visits are where the 15% earns, and one of them
repays the whole first-visit shortfall. That is why `bookPlanVisit` stamps
`currentPayoutRate()` directly and deliberately does **not** call
`payoutRateFor()`.

**Stamped by the server at booking, never accepted from the payload.** `doPost`
assigns it from `payoutRateFor(data)` before the record is built, so a browser
sending its own `payout_rate` is overwritten rather than obeyed. A test asserts
exactly that.

**And the CHOICE between the two rates is re-derived, not read from the
payload.** `payoutRateFor()` recomputes the discount from `service`,
`condition` and `bedrooms`, ignoring the `discount_applied` string the site
sends for the sheet's benefit — a crafted payload claiming a half-price first
clean must not be able to talk Serve out of its margin on a move clean.

> **THIS RULE IS WRITTEN TWICE.** `pricing-engine.js` decides the discount for
> the customer (R5 + `discountApplies`); `payoutRateFor()` decides it for the
> partner. Apps Script cannot `require()` the engine, so the two are genuine
> copies. If they drift, nothing fails loudly — the customer is charged half
> price while the partner is paid 85% of that half, and a partner is quietly
> underpaid on a class of job with no error and no log line.
> `tests/payout-discount-parity.test.js` drives both over 240 homes and fails
> naming the exact home that disagrees. **Change one copy and you must change
> the other.**

**It is read back instead of the live setting, and that is the whole point.**
Every partner surface derives its payout from the rate stamped on *that*
booking. Changing the rate must not reprice a job a partner already accepted —
the same rule `quote_sig` enforces on the customer's side, for the same reason:
a number somebody agreed to must not move under them afterwards.

**The source of truth is a sheet cell**, not this column and not the code:
`SETTINGS` in the **Ops** workbook, column A `key`, column B `value` — two rows
now, `payout_rate` = `0.85` and `payout_rate_first_clean` = `0.98`. Editing
either changes every booking made afterwards, with no deploy. Missing tab,
missing row, empty cell or unreadable workbook all fall back to
`DEFAULT_PAYOUT_RATE` / `DEFAULT_PAYOUT_RATE_FIRST_CLEAN` in webhook.gs — a
booking must never fail because a settings lookup did. **Whether either row is
actually present in the Ops `SETTINGS` tab has not been checked** — if
`payout_rate_first_clean` is absent it runs on the `0.98` code default, which is
a supported state rather than a pending task. Add the row only to change the
number.

**Anything outside `(0, 1]` is refused, not clamped**, and the default is used
with a loud log. `85` typed where `0.85` was meant is far likelier than an
instruction to pay 8500%, and clamping would be guessing with somebody's money.
A trailing `%` is accepted, because eventually somebody types one.

> **`partner_payout` still wins wherever it is set.** That column (OPS, #20's
> neighbour) is how one job gets a different answer — a difficult home, an
> apology, a bonus — and a derived figure must never quietly replace a number a
> human chose. Blank rate *and* blank override means no derived payout at all,
> which is every booking made before r24, and it renders as "confirmed at
> dispatch" rather than as zero.

### `quote_sig`, `quote_scope` and `quote_version` in `quote_meta` — added 2026-09-10 (webhook.gs r20)

**What they are for:** proving, later, that the number in `quoted_price` is one
Serve actually offered for *that* home. The edge Worker issues prices and signs
them (`POST /api/quote`) and verifies the signature before a booking is relayed;
these three keys are what let it prove the same thing again months afterwards —
which is the gate a payment link must pass before it may charge anyone.

| key | what it holds |
|---|---|
| `quote_sig` | `q1.<unix expiry>.<64 hex>` — HMAC-SHA256 over scope + price + engine version + expiry, keyed on the Worker's `QUOTE_SECRET`. |
| `quote_scope` | The canonical home the price was quoted for: `q1\|zip\|beds\|baths\|levels\|service\|condition\|fridge\|oven\|frequency`. |
| `quote_version` | The engine the **server** signed with. |

**Three things about these that are easy to get wrong:**

**`quote_scope` is stored, not rebuilt.** This row cannot losslessly reproduce
it: `service_type` is written as `First Clean` rather than the code the engine
prices from, and the add-on booleans are never stored at all — only `add_on_rev`,
their dollar total. A rebuild would drift, and it would fail **silently**: every
job quietly unchargeable with nothing in a log to say why.

**`quote_version` is the server's, not `pricing_version`.** `pricing_version` is
what the *browser* reported, and telling those two apart is the entire mechanism
for distinguishing a mid-session deploy from a tampered payload. Verification
needs the one the signature was made with.

**None of the three is a secret.** `quote_sig` is an HMAC output and is useless
without `QUOTE_SECRET`, which exists only on the Worker and is not
`TICKET_SECRET`. `quote_scope` describes the home — never the person. Nothing
here identifies a customer, and none of it may be shown to one.

**Blank is normal and is not an error.** A booking arriving without a signature —
a tab older than the deploy, a blocked request, an expired quote — stores blanks
and books exactly as it always has. Blank means *the price was never
authenticated*, which is a reason to have a human look before charging, not a
reason to doubt the booking.

### `geo_factor`, `park_tier` and `levels` in `quote_meta` — added 2026-08-20

`geo_factor` (a number, `1.00` = the regional norm for that home) and
`park_tier` (`P2` · `P1` · `P0`) are the silent geographic adjustment applied to
this quote, resolved from the ZIP by `serve-geo-data.js`. `geo_factor` scaled the
size base; `park_tier` added flat dollars per visit. They are recorded so quote
accuracy can be analysed by area once completed jobs accumulate.

> **This key was `zone` for one day.** Until 2026-08-21 the site shipped three
> tiers (`LARGE` / `STD` / `SMALL`) and logged the tier name. The tiers were
> withdrawn before ever reaching production — their index double-counted
> bathrooms — and the key now carries the measured factor itself, which is
> strictly more informative and cannot go stale as a taxonomy. **No row was ever
> written with `zone`:** the rename landed while r8 was still undeployed, and the
> first deployment to reach production was r9 on 2026-08-29, so only
> `geo_factor` has ever been written.

**Neither is ever shown to a customer, named in copy, or itemised on a quote.**
The customer sees one price. `tests/geo-pricing.test.js` §7 greps every rendered
surface and fails if either leaks.

An unmapped ZIP records `1.00` / `P0`. No mapped ZIP is exactly 1.00 any more, so
unlike under the old tiers the fallback is now distinguishable from a real
measurement in the sheet — a `geo_factor` of exactly 1.00 means the ZIP was not
in the map. Ten served ZIPs are unmapped: Brookline Village (02447) and the nine
EXTENDED-tier towns, none of which are in the parcel datasets.

`levels` is floors **inside the unit**, 1–3. It is an ops field, not reference
data: stairs decide what equipment comes off the van. There is no `levels`
header on JOBS today, so it rides in `quote_meta` and the webhook logs that it
did. **Add a `levels` header to JOBS and it moves into its own column with no
code change** — it is in `OPS_PREFERRED_KEYS` for exactly that reason.

**The column rule, so this stays consistent as the schema grows:**
Anything a human reads, sorts, or filters in normal ops → its own column.
Anything that's reference data for a single job → `quote_meta`.

---

## LEADS — one row per person

| # | Column | Writer | Meaning |
|---|---|---|---|
| 1 | `lead_id` | WH / MAN | Normalized lowercased email, else `property_key`. Match key for the upsert. |
| 2 | `name` | WH / MAN | Blank cells only — the upsert never overwrites populated values. |
| 3 | `email` | WH / MAN | Normalized lowercase. |
| 4 | `phone` | WH / MAN | |
| 5 | `service_address` | WH / MAN | Street address. Payload key is `address` → maps here. |
| 6 | `unit` | WH / MAN | |
| 7 | `zip` | WH / MAN | |
| 8 | `source` | WH / MAN | First-touch tag or channel. |
| 9 | `source_detail` | ? | **TO DEFINE.** Likely: sub-detail under `source` — batch number, poster location, deed batch id. |
| 10 | `contacted_via` | ? | **TO DEFINE.** Likely: outreach channel used — `email` · `sms` · `eddm` · `door_hanger` · `poster`. |
| 11 | `source_history` | WH / MAN | Comma-separated accumulated tags. Appended, never overwritten. |
| 12 | `status` | ? | **TO DEFINE.** Likely lifecycle: `new` → `contacted` → `quoted` → `booked` → `customer` / `dead`. |
| 13 | `first_variant` | ? | **TO DEFINE.** Likely: which A/B/C cold-email subject line this lead received first. |
| 14 | `dnc_scrub` | ? | **TO DEFINE.** Likely: `TRUE`/`FALSE` — scrubbed against the DNC registry before SMS. |
| 15 | `first_touch` | **WH** | **RECORD ACTIVITY** timestamp — when this workbook first saw the person. Real Sheets datetime, never a string. Stamped once at row creation and **immutable forever after**. Not an outreach date; `OUTREACH_LOG` owns sends. Existing cells verified `DATE` on 2026-07-27. |
| 16 | `last_touch` | **WH** | **RECORD ACTIVITY** timestamp — most recent activity for this person. Real Sheets datetime. Bumped on every matched booking. **The only cell the upsert overwrites when already populated.** Existing cells verified `DATE` on 2026-07-27. |
| 17 | `ltv` | FX | Lifetime value. Sum of `final_price` in JOBS for this `lead_id`. |
| 18 | `notes` | OPS | Free text about the person. Not written by the script. |
| 19 | `segment` | WH | `movein` · `pro` · `direct`. Header live as of 2026-07-27 — LEADS is 19 columns. **See the segment conflict in Known open items: the site is not yet emitting this vocabulary.** |
| 20 | `sms_transactional` | **WH** | `yes` or blank. Consent to service texts about a booking. **ADD THIS HEADER** — see the SMS consent block below. |
| 21 | `sms_promotional` | **WH** | `yes` or blank. Separate consent to marketing texts. Never bundled with column 20 — bundling them is an A2P 10DLC violation. **ADD THIS HEADER.** |
| 22 | `sms_consent_at` | **WH** | Real Sheets datetime, stamped from the **server** clock when either consent above is first recorded. Blank when neither was given. **ADD THIS HEADER.** |

**The script writes only:** `lead_id`, `contact_id`, `name`, `email`, `phone`, `phone_e164`, `service_address`, `unit`, `zip`, `source`, `segment`, `source_history`, `first_touch`, `last_touch`, `sms_transactional`, `sms_promotional`, `sms_consent_at`.

> **`phone_e164` holds DIGITS, with no leading `+`.** `16178527117`, not
> `+16178527117`. Prepend the `+` when calling Twilio.
>
> This is not a style choice. A Sheets cell beginning with `+` is parsed as a
> **formula** — `+16178527117` becomes `=+16178527117` — which evaluates to a
> number. The formula bar still shows the plus so it looks stored, but
> `getValue()` returns the number, and the column ends up holding a mix of data
> cells and formula cells. That is worse than a format mismatch: formulas
> behave differently under sort, fill and paste, and nothing warns you.
>
> The apostrophe prefix that works when typing by hand is not available to a
> script writing via `appendRow`, so the fix is to not emit a character the
> sheet cannot hold. Same principle as `zip`, which the sheet stores without
> its leading zero and `zipN()` restores on read: **store lossy, normalise on
> read** — consistently, rather than fighting the spreadsheet in two different
> ways in two different columns.
**Everything else is yours** and is skipped silently.

**Write rules, in precedence order:**
1. `first_touch` — write once, at creation. Never modified, **not even blank-filled** on a later match. A row imported from a deed or Apollo batch first appeared on its import date, not on the day it happens to book. Enforced by `setLeadCell()`, which throws.
2. `last_touch` — always overwritten on a match. This is the single documented exception to the blank-cells-only rule.
3. `source_history` — append-only; a tag already present is not re-added.
4. Everything else — blank cells only; a populated value is never overwritten.

### SMS consent — columns 20–22

Added 2026-08-16 for Twilio A2P 10DLC campaign registration. **These three headers do not exist on the live tab yet.** Until they are added by hand, the upsert logs `LEADS has no column for: sms_transactional, sms_promotional, sms_consent_at — skipped.` and writes nothing, exactly as it does for any other absent header. Bookings are unaffected. Add the headers **before** sending any text message: consent has to exist at the moment you send, and it cannot be reconstructed afterwards.

The site sends `"yes"` or `""`. **It never sends `"no"`, and nothing here should ever write one.** Rule 4 above is blank-fill-only, so a `no` recorded today would permanently block a genuine opt-in on a later booking — the cell would be populated, and every future write would decline to touch it. A blank cell already means "no consent on record", which is the same thing when a carrier asks, and it stays upgradeable.

`sms_consent_at` is stamped from the server clock inside `upsertLead()`, not taken from the payload, and is a real `Date` for the same reason `first_touch` is. If consent is ever challenged, a timestamp the customer's browser supplied is not the one to be standing on.

**Revocation is out of band.** A customer opting out replies STOP, which Twilio honours at the carrier level — it never reaches this webhook and will not clear column 20 or 21. Twilio's opt-out list is authoritative for whether a message may be sent; these columns are the record that consent was *given*. Do not treat a `yes` here as permission to send without checking Twilio.

Every booking also carries its own consent snapshot in the JOBS `quote_meta` JSON (`sms_transactional`, `sms_promotional`), which needs no new JOBS column. LEADS is the person-level record you filter on; `quote_meta` is the per-submission audit trail.

> Both timestamps are written as JS `Date` objects so Sheets stores real datetimes. An ISO string in a date column sorts lexically and breaks date math with no error. `reportLeadsSchema()` samples the existing cells and reports whether they hold `DATE`, `TEXT`, `number`, or `blank`; the upsert also logs a warning if it finds text where a date belongs.

> **How to resolve a TO DEFINE:** scroll the column. If it has values, those values are the definition — write them down here. If it's empty, it has never been used — define it now or delete the column. Do not let a script write to a column whose meaning is unresolved.

---

## Other tabs

| Tab | Purpose | Written by |
|---|---|---|
| `PROPERTIES` | One row per address. The durable asset — customers are transient, properties aren't. Keyed on `property_key`. | **WH** (six columns only) + MAN |
| `RAW_INTAKE` | Deed + Apollo staging buffer. Columns: `file_date · intake_date · batch · raw_source · name · email_corp · email_personal · phone · address · unit · zip · linkdin · company · title · sale_price · deed_type · promoted · promoted_lead_id · raw_notes`. Rows get promoted into LEADS. | MAN |
| `OUTREACH_LOG` | Sends, opens, replies per lead. | MAN |
| `DASHBOARD` | Channel spend → cost-per-booked-job. Spend entered by hand. | FX + OPS |
| `EVENTS` | Non-reservation site events (quote viewed, waitlist, custom quote). Auto-created by the webhook. | WH |
| `PROPERTY_ACCESS` | How to get into a home, in the customer’s own words, set from the portal. Property-scoped so it outlives one booking. Auto-created. | WH (from the portal) |
| `BOOKING_INSTRUCTIONS` | What the customer asked for on ONE visit, scoped to the booking, a room, or an access question. Auto-created by the webhook. | WH (from the client ticket) |

### PROPERTY_ACCESS — how to get into this home (r14)

Auto-created on first save, like `BOOKING_INSTRUCTIONS`. No setup step.

`property_id · occupancy_choice · occupancy_detail · entry_choice ·
entry_detail · entry_code_saved · entry_code_set_at · parking_choice ·
parking_detail · pet_notes · updated_at`

**PROPERTY-scoped, not booking-scoped.** The lockbox is in the same place next
month, and asking again every visit is exactly what "Serve remembers your home"
exists to stop. Set once in the portal, it applies to every future booking.

Answers are **choices plus an optional detail**, not free text. One taxonomy
(`ACCESS_QUESTIONS` in webhook.gs) drives the bullets the portal renders, the
validation on write, and which column each answer lands in — three separate
lists would be three chances to disagree about what `KEY` means.

| field | choices |
|---|---|
| `occupancy` | `YES` · `NO` · `OTHER` |
| `entry` | `LET_IN` · `KEY` · `CODE` · `UNLOCKED` · `OTHER` |
| `parking` | `FREE_STREET` · `PAID_STREET` · `GARAGE` · `NONE` · `OTHER` |
| `pets` | free text, optional — the booking form already screens for pets |

**Portal completion flag (2026-09-09):** the Arrival & access navigation item
shows red `Incomplete` until all three questions have saved choices for every
home on the account. A choice with a follow-up (Key, Access code, or Other)
also needs that detail saved; Access code uses only `secretSet`, never the code.
Pets remain optional. The flag becomes green `Complete` only after successful
saves, updates without a reload, and remains incomplete for an unlinked home or
missing question data. No homes also shows incomplete until a home is available.
This is a completion indicator, not a new server-side restriction on saving
partial answers; the column contract and API payload are unchanged.

**r28 contract (deployment status in HANDOFF):** `entry_code_saved` is a boolean,
never the code. The actual value goes to the separate **Access MASTER** workbook.
No view model reads that workbook or returns a code, and nothing logs one.
Choosing a different entry method clears the private code; an empty submission
while keeping CODE retains the existing code. Saving fails if private storage
is unavailable, misconfigured, or has duplicate property records.

Script Properties `ACCESS_SPREADSHEET_ID` and `ACCESS_CODES_TAB` identify the
existing private workbook and its code tab. Neither has a fallback. The target
must differ from Leads and Ops. The private tab has `property_id`, `access_secret`
and `access_secret_set_at`; other existing columns are preserved. Codes are
stored as literal text so leading zeroes and formula-looking input survive.
New codes are verified before Leads' saved marker and timestamp are updated.

**r29 — run `checkAccessMigration()` first, and again after.** Editor-only; it
changes nothing in Leads and prints counts and property IDs, never a code. It
reports whether Access MASTER is configured, whether the legacy `entry_code`
column is still present, and how the legacy cells were KEPT: before r28 codes
were written into Automatic-format cells, so Sheets may hold `0042` as the
number 42 and `12/25` as a date. Its one write is a synthetic `0042` sent
through the real save path under `__serve_probe__`, read back, and removed — it
proves whether a plain-text cell keeps r28's leading apostrophe, which would
make every code save fail. The migration refuses any date-coded home and names
every number-coded one for re-confirmation with the customer.

Run editor-only `migratePropertyAccessCodes()` after configuring the destination.
It verifies transferred codes before deleting Leads' legacy `entry_code` column,
preserves unrelated answers, and stops on conflicting or duplicate records.
It logs counts only and can be retried. Deploy r28 before migration; entry saves
against the unmigrated schema fail safely until migration completes.
Removing current cells does not erase spreadsheet version history. Hidden or
protected columns are not confidentiality controls; Access MASTER sharing and
automation credentials must exclude routine Leads readers.

**Not `PROPERTY_MEMORY`.** That tab is the crew's curated record and sits on
`PROTECTED_TABS` — a form submission knows nothing about a sticky gate latch.
This one is the customer's own answers. The partner ticket shows both, as
`standing` and `fromCustomer`, and never merges them.

### LEADS.contact_id — required for the portal (r14)

`upsertLead` writes `contact_id` only when the column exists, so it was a no-op
from r9 until the column was added. **The portal cannot work without it**:
`/h?id=CON-nnnn` is the permanent customer link, and `getContact` returns null
when the column is absent.

It **self-backfills** — any existing row without one gets a `CON-nnnn` on that
customer's next booking. Fill the column down by hand once for immediate
history; `nextSeqId` continues from the highest existing value.

**No JOBS column is needed.** The portal resolves
`contact_id` → LEADS row → `lead_id` → every JOBS row with that `lead_id`, and
`lead_id` is already column 2 of the live JOBS header. That deliberately avoids
depending on `JOBS.property_id` or `JOBS.contact_id`.

Until the column exists, the booking email falls back to the old per-job client
link, so a customer is never left with no link at all.

### BOOKING_INSTRUCTIONS — what was asked for on this visit

Added r13. Auto-created on first write, like `EVENTS`, so there is no setup step.

`instruction_id · job_id · scope_type · scope_key · instruction · created_at · updated_at · source`

**One row per `(job_id, scope_type, scope_key)`.** A second write to the same
scope updates that row rather than appending, so a ticket shows one current
instruction per room instead of a growing list of edits. Blanking the text keeps
the row and empties it; the read side skips empties.

`scope_type` is one of three, and `scope_key` is validated against the booking:

| scope_type | scope_key | comes from |
|---|---|---|
| `BOOKING` | always `GENERAL` | the "anything else" box |
| `ROOM` | `BEDROOM_1`, `BATHROOM_2`, `KITCHEN`, `LIVING_ROOM`, `STUDIO_MAIN`, `BATHROOM_HALF` | the room accordion |
| `ACCESS` | `OCCUPANCY`, `METHOD`, `NOTES`, `PARKING`, `PETS` | the arrival & access section |

Room keys are **derived from the booking's own bed and bath counts**
(`deriveRooms`), so a 2BR/1.5BA booking accepts `BEDROOM_1`, `BEDROOM_2`,
`BATHROOM_1`, `BATHROOM_HALF`, `KITCHEN`, `LIVING_ROOM` and refuses anything
else with `unknown_room`. Without that check the tab becomes a free-text store
keyed on whatever a caller sends, and the note silently never appears on a
ticket because it was filed under a room that does not exist.

**This is NOT `PROPERTY_MEMORY`, and the split is deliberate.** `PROPERTY_MEMORY`
holds what is true of the house every visit — the lockbox is round the back, the
gate latch sticks. `BOOKING_INSTRUCTIONS` holds what is true of Tuesday — fresh
sheets are in the closet, we'll be away this time. Merging them means either
re-typing the house every visit or carrying a one-off note forward forever. The
partner ticket shows both, labelled, and never merges them.

**Writes are authorised by the CLIENT ticket token**, not by `submission_id`:
this is the customer editing their own booking rather than the site reporting
one. A partner token is refused — a partner may read a job, never rewrite what
was asked for. A completed job refuses edits entirely (`closed`); at that point
the ticket is a record, not a form.

### BOOKING_PHOTOS — private room pictures (r21)

Auto-created on first upload reservation. The image bytes live in the private
Cloudflare R2 bucket `serve-booking-photos`, bound as `BOOKING_PHOTOS`.

`photo_id · job_id · room_key · object_key · status · bytes · created_at · updated_at · booking_link`

One row per UUID photo. Room keys come from the booking's own `deriveRooms`.
Maximum three READY or unexpired PENDING photos per room. Images are JPEGs up to
1,500,000 bytes; the browser resizes to 1600px maximum dimension and re-encodes,
discarding the original metadata. No original filenames, addresses, credentials,
or room labels appear in R2 object keys. `booking_link` opens the protected client
ticket for staff reviewing the sheet; treat it as a credential, like existing
portal links. It is never returned as photo metadata to a browser.

Status: PENDING reserves a slot for ten minutes; READY means R2 storage and
metadata commit both succeeded; DELETED immediately removes visibility;
PURGED records confirmed physical deletion by maintenance. Repeat requests with
the same photo UUID are idempotent. Deleted/expired reservations cannot be revived.
Daily Worker maintenance selects at most 100 DELETED or over-24-hour-old PENDING
rows, deletes their R2 objects, and marks PURGED. READY photos are never selected;
there is no new retention limit on completed customer records.

`PHOTO_BRIDGE_SECRET` must match in Cloudflare secrets and Apps Script properties.
`booking_photo` events require this internal credential AND the portal's contact
ownership or the correct per-job client/partner token. Partners can only read
READY photos while the job is open. Customers may read completed-job photos but
cannot edit them. The bridge-only cleanup/purged operations never accept image
references from browser requests. Public view models return only `id`, `roomKey`,
and `createdAt`. Browser image requests use POST bodies; blob URLs are local to
the page and are revoked when the view is replaced. No public R2 URL is enabled.
Since 2026-09-15 `booking-photos.js` also keeps each photo it has read in a page
variable, by purpose and photo id (bounded at 30 MB, oldest dropped first;
removed on delete; never browser storage), so a repaint does not read again, and
sends at most three reads at once.

### COMPLETION_PHOTOS — the cleaner's room photos (r47, simplified r48)

Separate from customer instruction pictures in BOOKING_PHOTOS. Auto-created in
Leads MASTER on the first authorized cleaner upload. Private image bytes stay
in the same R2 bucket, under `completion-photos/<photo_id>.jpg`.

`photo_id · job_id · vendor_id · room_key · object_key · status · bytes · created_at · updated_at`

**r48** dropped `room_label`, `service_label` and `scheduled_date` (only the
removed archive read them); a tab created by r47 with those columns still works
and they are left blank. The vendor company is stamped when an upload begins,
so a job moved to another company does not hand them the first company's
photos. Photo metadata adds `purpose: completion`; no object key, credential or
customer contact detail is returned.

`/api/photos` uses `purpose: completion` to select this separate authorization
path. The assigned job's partner ticket can upload/read while the job is open —
**no finished-room confirmation (r47's `finished: true`) is required since
r48**. Vendor-company credentials can only read records stamped with their
vendor_id, including after the ticket expires. Client tokens cannot read or
write these photos, and the customer portal does not receive them. No delete
operation exists in either the Worker or Apps Script, and neither cleanup nor
customer photo deletion can select this table or prefix.

PENDING becomes READY only after R2 storage succeeds. Retries use the same UUID
and preserve the first stored bytes; no overwrite or replacement is allowed.
The UI displays success only after metadata commit. Maximum 20 READY/recent
PENDING photos per room. JPEG resizing/metadata stripping and size limits match
customer pictures. Retention has no time limit; **no R2 bucket-lock rule has
been configured** (r47 proposed one for `completion-photos/`; it is optional
hardening, not needed for the feature to work).

**Where they show (r48).** Partner ticket: `completionPhotos`, inside each
Scope room — a closed `<details>` like the customer's rooms, holding what the
customer asked for, one **Add photos** control (`accept="image/*" multiple`, no
`capture`, so a phone offers camera or library) with "Add photos when
completed", and the room note below. Vendor portal: each `bookings[]` row
carries `report` — `[{ key, label, note, photos }]`, only rooms with a photo or
a note, only this company's — rendered inside that job. r47's separate
`completionHistory` archive is gone.

### PARTNER_NOTES — the cleaner's note on a room (r48)

Auto-created in Leads MASTER on the first non-empty note.

`note_id · job_id · vendor_id · room_key · room_label · note · created_at · updated_at`

One row per (job_id, vendor_id, room_key), updated in place; blanking keeps the
row and empties it. Written only by `event_type: partner_note` (POST `/api/job`,
relayed as-is) with the job's **partner** ticket token — a client ticket,
portal or vendor token is refused `not_found`. Refused `closed` once the job is
completed or cancelled; `unknown_room` for a key the booking does not have.
Text is trimmed to 2,000 characters; a note starting with `= + - @` is written
with a leading apostrophe so Sheets keeps it as text.

**Its own tab, not a scope_type in BOOKING_INSTRUCTIONS:** `sortInstructions`
files anything that is not ROOM or ACCESS as the customer's general note, so a
cleaner's note stored there would replace the customer's own words.

Read by, and only by: the partner ticket (`scope[].note`), the vendor portal
(`bookings[].report[].note`) and the customer portal
(`bookings[].partnerNotes: [{ roomLabel, note }]`, in room order, empty for a
cancelled booking, shown as "Notes from your service partner"). Each reader
matches the booking's current vendor_id. No author, vendor id or timestamp
reaches the customer.

### SERVICE_REQUESTS — a customer asking for something other than a clean (r62)

Auto-created in Leads MASTER on the first request. Founder's request,
2026-09-29: a portal customer picks a category from the homepage's "One
relationship" grid, says what is wrong, attaches a photograph, sends.

`request_id · client_ref · contact_id · lead_id · property_id · property_label ·
service · service_label · message · photo_count · status · customer_name ·
customer_email · customer_phone · created_at · updated_at · portal_link`

One row per request, `REQ-nnnn` by sequence. Written only by
`event_type: portal_write, kind: service_request` — the portal token proves the
contact, and a `property_id` that is not on one of their bookings is refused
`not_found` rather than dropped. **This is the first portal write that targets
nothing the customer already has**, so unlike `instruction`, `reschedule`,
`cancel` and `access` there is no existing row to prove ownership of: the token
is the whole check.

**IT IS A REQUEST, NOT A BOOKING.** No JOBS row, no availability consumed, no
price computed, no card touched, no vendor assigned. Nothing in the system reads
this tab to schedule anything. The only delivery mechanism is one email to
`NOTIFY_EMAIL`, which says so in capitals.

`service` is one of `cleaning · handyman · plumbing · hvac · electrical ·
landscaping · other`. The first six **must** equal the ids in
`serve-services.js`, which is the one file that decides what Serve says it does;
`REQUEST_SERVICES` in webhook.gs restates them because a browser script cannot be
read from Apps Script, and `service-requests.test.js` §1 reads BOTH and fails if
they disagree. `other` is the portal's own and is deliberately absent from the
catalogue — it is not a service, it is the guarantee that somebody is never stuck.

`message` is trimmed to 2,000 characters. `client_ref` is the browser's own
reference and authorises nothing; it makes the write **idempotent**, so a portal
write that ran past the Worker's 12-second budget and was reported to the page
as a failure cannot become a second copy of one leak. A repeat answers
`ok:true, duplicate:true` with the original `request_id`, and sends no second
email.

`status` is **the operator's column** once the script has written `NEW`, and the
customer never sees the raw cell. `requestStatusLabel` maps it through a
whitelist — `Received · In progress · Quote sent · Scheduled · Closed`, with
anything unrecognised reading as `Received` — so an internal note typed into it
cannot turn up on the customer's own page. `DONE · CLOSED · DECLINED ·
CANCELLED` also stop the request accepting new photographs, while leaving the
ones it has readable.

`portal_link` opens the customer's portal for staff reading the sheet; treat it
as a credential, like `BOOKING_PHOTOS.booking_link`. It is never in a view model.
Name, email and phone are denormalised off the newest booking so a request can
be answered without joining to LEADS.

Portal view model (`requests[]`, newest first, whitelisted field by field):
`requestId · clientRef · service · serviceLabel · message · propertyLabel ·
createdDate · statusLabel · open · photoLimit · photos[]`. No raw status, no
lead_id, no phone, no portal link. `serviceLabel` comes from the whitelist, not
the cell, so an operator retyping it cannot rename a category on a customer's
page. `createdDate` is `YYYY-MM-DD` because `prettyDate()` in portal.js parses
exactly that and silently returns "" for anything else.

### SERVICE_REQUEST_PHOTOS — pictures on a request (r62)

Auto-created on the first upload reservation. Image bytes live in the same
private R2 bucket as the room photos, under `request-photos/<photo_id>.jpg`.

`photo_id · request_id · contact_id · object_key · status · bytes · created_at ·
updated_at`

Same state machine as BOOKING_PHOTOS — PENDING reserves for ten minutes, READY
means both the R2 write and the metadata commit succeeded, DELETED removes
visibility — and the same 1,500,000-byte JPEG limit, browser-side resize to
1600px and EXIF-discarding re-encode. Maximum three READY or unexpired PENDING
photos per request. `photo_count` on SERVICE_REQUESTS is **recounted** from this
tab on every commit and delete, never incremented, so a lost response cannot
drift it.

Authorised by `booking_photo` with `purpose: "request"`, which requires the
`PHOTO_BRIDGE_SECRET` **and** `auth_kind: "portal"` with a portal token whose
contact matches the request row. A client or partner ticket token is refused —
a ticket opens one job and a request is not one. `room_key` must be blank, on
both sides: a request has no room, and the blank is what lets the shipped photo
grid render these without a second copy of it.

**ITS OWN TAB AND ITS OWN PREFIX, on purpose.** `cleanupBookingPhotos` and the
Worker's nightly `cleanupPhotoStorage` are both scoped to the BOOKING_PHOTOS tab
and the literal `booking-photos/` prefix, so neither can reach a request photo —
the same separation that keeps the indefinitely locked COMPLETION_PHOTOS out of
that sweep. **Known gap:** nothing therefore sweeps an abandoned PENDING request
photo, so an interrupted upload leaks one R2 object (≤1.5 MB, unreadable — the
row never reaches READY). A deleted photo IS removed from R2 immediately by the
Worker, which is the common path.

`PHOTO_PURPOSES` in `src/worker.js` maps the three purposes to the three
prefixes. **Until r62 the Worker read `data.purpose === "completion"` and
silently treated everything else as an instruction photo** — so a typo would
have filed a permanently locked completion image under the prefix the nightly
sweep is allowed to delete from. An unknown purpose is now refused `bad_upload`.

### Shared portal updates (r21 site)

Customer portal, client/partner tickets and vendor portal reread their existing
authorized view every 25 seconds while visible, and on focus, visibility return,
or reconnect. Requests do not overlap and failures back off to 120 seconds.
Refreshes preserve expanded booking/room sections and scroll position; no repaint
occurs while a form is dirty, saving, focused, showing a failed save, uploading a
photo, or displaying an enlarged photo. A response started before a user edit
cannot overwrite it. Expired/revoked views clear their displayed data and stop.

All existing writes still update Sheets when saved; no separate notification
queue or email/SMS was added. Vendor `access.fromPortal` now includes the current
PROPERTY_ACCESS occupancy/entry/parking choices and permitted details plus pets,
separately labelled from old booking notes and crew PROPERTY_MEMORY. Entry codes
remain write-only and excluded from all view models. Both ticket views receive
`photos`; portal booking rows include them for upcoming and completed bookings.

### RECURRING_PLANS — one row per plan a customer was OFFERED (r38)

`plan_id · contact_id · lead_id · origin_job_id · property_id · frequency ·
quoted_price · created_at · expires_at · status · anchor_date · anchor_time ·
preferred_vendor_id · confirmed_job_id`

**A plan is an offer, not a booking.** Somebody who books a first clean and
picks a cadence has asked for ONE clean and expressed an intention about the
rest. Offering a plan writes **no JOBS row, holds no availability slot and
assigns no vendor** — a slot held for a clean nobody confirmed is a slot a
paying customer could have had. It becomes a real booking only when the
customer confirms it and chooses a time in their portal.

This is why it is its own tab rather than columns on JOBS: it has a lifecycle
JOBS does not (`pending` → `confirmed`, or lapsed), a window that closes, and an
anchor that later visits are counted from. JOBS is one row per *booking*.

**`plan_id` is `PLN-` plus the origin job's suffix**, so it is derived from the
booking it came from and one booking can never mint two plans.

**`quoted_price` is what the customer was actually shown**, taken from
`recurring_weekly` / `recurring_biweekly` / `recurring_monthly` in the origin
booking's `quote_meta`. It is never recomputed later against today's table — the
price on screen when they chose is the price being held.

**NOTHING EVER WRITES `expired`.** `planStatus()` compares `expires_at` against
now on every read, so a lapsed plan simply reads as gone. There is no nightly
trigger to fail silently and no stored state that drifts while nobody is
looking. Both sides are parsed rather than compared as text, because the stamps
carry an offset and `-04:00` does not sort against `-05:00`.

**`anchor_date` / `anchor_time` are the source of truth for every later visit**,
written when the customer confirms. A one-off reschedule moves that visit only;
the next one is counted from the anchor, not from the visit that moved.

**BOTH ARE BLANK ON A PLAN CONFIRMED WITH A PREFERENCE**, and the plan is still
`confirmed` with a real visit behind it. A customer who answers "earlier in the
day" rather than picking a slot has given no clock time to count a cadence from,
so none is invented; the beat starts when dispatch sets the day and writes one.
`plan_confirm` has accepted a preference since the portal stopped dead-ending on
an empty feed — `changeMovePlan` has cleared the anchor this way since r45.

**`preferred_vendor_id`** records a request for the same partner as last time.
It is a preference for dispatch, not a guarantee, and it is never shown to the
customer as one. **Nothing reads it yet** — dispatch is a human's, and this is
what the human is told. Same posture as `OPERATORS.show_to_customer`.

### Confirming a plan — `plan_confirm`, the portal write that books (r42)

A fourth portal write kind, beside `instruction` and `access`, and **the only
one that creates a booking**. `handlePortalWrite` proves the plan carries this
contact's `lead_id` *and* that the origin booking does too, then:

| | what it writes |
|---|---|
| `JOBS` | one new row: `CLEAN_STANDARD` ("Recurring clean"), the cadence, the chosen date and time, **`quoted_price` from the plan row** — never recomputed against today's table — the home and people copied from the origin booking, and the payout rate in force at that moment |
| `AVAILABILITY` (Ops) | the chosen row flips to `booked` and takes the new `job_id`, through the same `bookAvailabilitySlot` the website uses. A conflict is flagged to a human, never refused to the customer |
| `JOBS.vendor_id` | the consumed slot's partner, blank cells only |
| `RECURRING_PLANS` | `status` → `confirmed`, the anchor, `confirmed_job_id`, and `preferred_vendor_id` if they asked |

**It creates that job the one way jobs are created** — the payload is
synthesised and handed to `buildJobRecord` / `writeRow` /
`bookAvailabilitySlot` / `stampJobVendor`, the same calls in the same order as
`doPost`. A second way to write a JOBS row would be a second place to forget
every column added later.

**`submission_id` is `PLNC-<plan_id>-01`.** Deterministic, so a double-tapped
button dedupes through `alreadyWritten()` into one booking — which is also the
only guard covering the instant between the JOBS write and the status write.
**The `-01` is load-bearing:** `job_id` is the date plus the last six
characters of the submission id, and a `plan_id` is its origin job's id with
the prefix swapped, so an id derived from the plan alone would collide exactly
when somebody confirms a visit for the same day as their first clean.

**Attribution is deliberately blank** on these rows. The booking came from a
customer opening their own portal, not from a campaign; `confirmed_job_id` is
where it came from.

**The time is validated, not passed along.** An unreadable date or time is
refused (`bad_slot`) rather than written — it would match no `AVAILABILITY`
row, consume nothing, and leave a customer holding a confirmation for a visit
no cleaner can see. The browser picks from `/api/slots` through the same
horizon rules the booking form uses (`serve-slots.js`).

**Blank is the normal state.** Most bookings carry no cadence and so have no
row here at all. A missing tab costs the plan prompt in the portal and nothing
else — the booking, the portal and every other surface are unaffected.


### Changing a booked visit — `reschedule` and `cancel` (r43)

Two more portal writes, and the first code in the system that ever GIVES
CAPACITY BACK. Both resolve the booking through the same seam every portal
write uses — the contact's `lead_id`, then a job carrying it — and both are
refused on a booking that is finished (`closed`) or already called off
(`cancelled`). "Not yours" and "does not exist" stay indistinguishable.

| | what it writes |
|---|---|
| `reschedule` | `JOBS.scheduled_date`, `start_time`, `notes`, `scheduling_type` on the existing row; books the new `AVAILABILITY` row and releases the old one; stamps the new slot's partner into a **blank** `vendor_id` only |
| `cancel` | `JOBS.job_status` → `cancelled`; releases the `AVAILABILITY` row. Nothing else. |

**THE ANCHOR IS NOT TOUCHED BY EITHER.** `RECURRING_PLANS.anchor_date` /
`anchor_time` is the beat every later visit is counted from. Moving October's
clean does not move the cadence, and cancelling October does not cancel
November. Writing a new time back onto the anchor would let one one-off change
silently redefine the schedule — the drift that walks an every-other-Tuesday
onto a different weekday over a few months with nobody deciding it.

**THE `job_id` NEVER CHANGES.** It is minted once from the date first booked,
so after a move the date inside the id no longer matches `scheduled_date`. That
is correct: the id is an identity and the join key for the `AVAILABILITY` row,
the instructions, the photos, the ticket and the portal. Re-minting it to keep
the digits tidy would orphan all five at once.

**A CANCELLED ROW IS KEPT, NEVER DELETED.** It is the record of something that
was really sold and really given back; deleting it would take the address, the
price, the instructions and the attribution with it, and every count of "work
booked" would quietly stop including work that was booked and cancelled.

**The new slot is taken BEFORE the old one is released**, and the release is
told which row was just booked. Both rows carry the same `job_id` for that
instant, so a release matching on the id alone hands back the time the customer
has just chosen — they keep a confirmation for a slot reading `open` that the
next visitor can buy. This was a real defect, caught by its own test.

**`vendor_id` is never overwritten by a move.** It is ops-owned: where a
dispatcher has already assigned the job, a new slot belonging to another company
is a clash for a human, and the ops email says so outright. `setJobCells()`
refuses any ops-owned column by throwing rather than skipping — a customer-facing
path must not become the back door onto a hand entry.

**Money is untouched.** Nothing captures, voids or refunds here; refund terms
were still the founder's open decision. The ops email says whether a hold may
still be outstanding.

#### `cancel_notice_hours` — a lever with no number in it

How much notice a customer must give to change or cancel in the portal.
`SETTINGS` in the **Ops** workbook, column A `key` = `cancel_notice_hours`,
column B `value` = a whole number of hours. Same shape and same failure
behaviour as `payout_rate`: a missing tab, missing row or empty cell falls back
to `DEFAULT_CANCEL_NOTICE_HOURS`, because a lookup must never be what stops a
customer managing their own booking.

**The default is `0`, and that is a deliberate non-decision.** A notice window
is a customer promise with a refund question attached, and both were the
founder's to make. The mechanism is built, tested and OFF: put a number in the
sheet and it starts being enforced, with no deploy. Anything outside `[0, 336]`
is refused and logged rather than clamped — two weeks is already an extreme
notice period for a house clean, so a larger number is a typo, and guessing
what it meant would lock customers out of their own bookings.

A move can never land sooner than the feed allows regardless: `/api/slots`
publishes nothing inside `MIN_LEAD_HOURS` (18), inherited from availability.gs.

### A plan after a clean with no plan — `plan_start` and `plan_change` (r45, widened r59)

**No new column and no new tab.** The plan is a `RECURRING_PLANS` row whose
`origin_job_id` is the booking it follows.

**WHO IS ASKED — `planBasisKind()`, the one predicate (r59).** Three places
decide (the portal box, `plan_start`, `plan_change`) and they all read this, so
they cannot drift into a box whose button always fails.

| the booking | kind | why |
|---|---|---|
| move in / move out (`CLEAN_MOVEOUT`) | `move` | the form never offers a move a cadence |
| deep clean (`CLEAN_DEEP`) sold as **"once"** or blank | `deep` | r59. Same gap: nothing offered them a plan and nothing asked again |
| deep clean sold **with a cadence** | `""` | r38 already wrote them a pending offer; this box must not ask a second time |
| anything else | `""` | |

**The cadence test is what keeps the two offers apart.** A blank `frequency`
counts as "once" — an old row or an operator's edit is not a recurring plan.

r38's `createRecurringPlan` still never *offers* a move a plan at booking time
(`serviceCodeOf` returns `CLEAN_MOVEOUT` whatever the frequency says, so it
answers "not a first clean"); the portal asks instead, and choosing books.

**The portal model gains `movePlan`** — a whitelist, null for everybody with no
eligible booking. The booking it belongs to is the newest eligible booking that
already has a plan, or failing that the newest one not cancelled.

| key | meaning |
|---|---|
| `state` | `choose` (no plan yet) or `saved` (a confirmed plan) |
| `kind` | r59. `move` or `deep` — the browser picks WORDS with it and nothing else. Absent from a script older than r59, and portal.js falls back to the move wording |
| `jobId` | the booking the plan follows |
| `propertyLabel` | address and unit of that booking — the plan is for THIS home |
| `after` | that booking's date; the first plan visit must be later. Blank for a preference booking |
| `home` | `{ zip, bedrooms, bathrooms, levels }` — exactly what the engine prices the recurring track from, built once in `homeSpecFor()` |
| `samePartner` | boolean: that booking has a vendor, so "same company" can be asked |
| `planId`, `frequency`, `price`, `visitId`, `sameAsked` | `saved` only. `price` is the plan row's `quoted_price`; `visitId` its `confirmed_job_id`; `sameAsked` a boolean — the vendor id never leaves the server |

**THE PRICE IS THE PRICING ENGINE'S, NOT THE BROWSER'S.** Apps Script has no copy
of `pricing-engine.js`. It calls `POST https://servecleaning.com/api/quote`
(`PRICING_QUOTE_URL`) with the home from that booking and reads
`recurring.{weekly,biweekly,monthly}` — `computeQuote().freqSteady`, which
does not depend on service, condition or add-ons. The portal displays prices
from the same endpoint. The browser sends back `shown_price` only so that a
price that moved in between is refused (`price_changed`, with the new prices)
rather than booked. A missing or non-positive engine answer refuses the write
(`price_unavailable`). Nothing logs the address or ZIP.

| write | what it writes |
|---|---|
| `plan_start` { job_id, frequency, shown_price, slot_date + slot_time **or** time_preference, same_provider } | the first visit's `JOBS` row through `bookPlanVisit` (r42's path: `CLEAN_STANDARD`, the engine price in `quoted_price` and `final_price`, condition blank, slot consumed and vendor stamped for a slot), THEN one `RECURRING_PLANS` row: `status=confirmed`, blank `expires_at`, the anchor (blank for a preference), `preferred_vendor_id` from the move booking if asked, `confirmed_job_id` |
| `plan_change` { plan_id, frequency, shown_price?, time? } | if the plan's visit is still coming: that same row in place — `frequency`/`quoted_price`/`final_price` on a cadence change, the time through `moveVisit` (r43's path, which now also accepts a preference). If the visit was cleaned or cancelled: a NEW visit, `submission_id` `PLNC-<plan_id>-NN`. Then the plan row's `frequency`, `quoted_price`, anchor and `confirmed_job_id` as applicable |

Rules:

- **A time-only change never re-prices.** Only a different cadence asks the engine again.
- **The plan box moves the anchor; r43's "Change time" on a visit still does not.** Changing the plan's time is the customer redefining the cadence on purpose.
- **A paid visit is not re-priced** (`paid`). An unpaid one is, and the ops email says any card hold was for the old amount. Nothing captures, voids or refunds.
- **Only a plan whose origin is a move can be changed here** — a first-clean plan holds the price it was QUOTED (r38) and is refused.
- Ownership: `plan_start` needs the move booking among this contact's bookings; `plan_change` needs the plan row's `lead_id` AND the move booking. Each is tested alone.
- The time must be after the move booking's date (`too_early`). The notice window (`cancel_notice_hours`) applies to changing a visit that is coming.
- Earlier / later in the day writes a preference visit with no date and takes no slot; the ops email subject carries `NO TIME CHOSEN`.
- A retry after a failure between the JOBS write and the plan write dedupes on `submission_id` and writes the missing plan row.

**Nothing generates later visits yet** — for move plans or r42's plans. The box
books one visit at a time; once it is cleaned or cancelled the box offers
"Book your next visit".

### PROPERTIES — one row per address

Live header row (17 cols), confirmed 2026-07-28:

`property_key · service_address · unit · neighborhood · zip · property_type ·
beds · baths · deed_date · sale_price · deed_type · buyer_name ·
first_clean_min · last_service_date · photo_folder · known_issues · notes`

**The webhook writes six of them**, blank-cells-only, on every booking:
`property_key`, `service_address` (payload `address`), `unit`, `zip`,
`beds` (payload `bedrooms`), `baths` (payload `bathrooms`).

Everything else is yours. Deed fields (`deed_date`, `sale_price`, `deed_type`,
`buyer_name`) are promoted from `RAW_INTAKE`; `neighborhood`, `property_type`,
`first_clean_min`, `photo_folder`, `known_issues` and `notes` are operator
knowledge. **`last_service_date` is deliberately not written** — a booking is a
future intention, not a service that happened. It belongs to whatever marks a
job complete.

`property_key` is `ZIP-ADDRESS-UNIT` normalised, so **unit is part of the
identity**: `123 Beacon St Apt 4B` and `Apt 5C` are two properties with separate
access notes and separate histories. A booking with no address writes nothing.

`PROPERTIES` remains on the protected list. `upsertProperty()` is the only
writer, through `assertPropertiesWritable()`, which throws for any tab that is
not `PROPERTIES`.

### EVENTS — non-reservation site events

Auto-created by the webhook if missing, with this header row. Matching is by raw
payload key (no `HEADER_MAP` translation — that map is JOBS-specific), so a
column named for a payload field fills itself in:

`received_at · submitted_at · submission_id · event_type · event · name · email ·
phone · zip · zip_tier · bedrooms · bathrooms · service · condition ·
frequency_selected · quote_price · steady_state_price · addon_total ·
addon_fridge · addon_oven · unit_label · src · src_first · src_chain · segment ·
utm_source · utm_medium · utm_campaign · page_path`

Carries `quote_emailed`, `waitlist_zip` and `custom_quote_request`. These are
identity-light and must never go to LEADS, which is one row per *person* —
identity-less rows would corrupt the upsert's match.

## The vendor side — three tabs in the OPS workbook (r15)

**These live in Ops, not Leads MASTER.** Leads MASTER is the customer side; Ops
is supply. The split means someone helping with customer support can be given
Leads MASTER without ever seeing payout terms, and it matches where `CLEANERS`,
`SCHEDULE` and `AVAILABILITY` already sit. `webhook.gs` already opens the Ops
workbook by id in three places, so this is a proven path rather than a new one.

**Create all three by hand.** Unlike `EVENTS`, `BOOKING_INSTRUCTIONS` and
`PROPERTY_ACCESS`, these are *not* auto-created — a vendor is a relationship
somebody agreed to, not a row a form conjures.

### VENDORS — one row per partner company

`vendor_id · status · legal_name · display_name · internal_contact_name ·
internal_phone · internal_email · logo_url · public_description ·
partner_since · insurance_verified · service_area · capabilities ·
public_rating · public_review_count · rating_source · client_visible ·
default_payout_rate · created_at · updated_at`

`vendor_id` is `VEN-0001`, same sequence style as `CON-` and `PROP-`.

**`client_visible` is the master switch.** `buildClientVendorProfile` returns
null unless it is `TRUE`, so a half-filled vendor never reaches a customer and
the ticket says "your service professional will be confirmed" instead.

**The finished card is cached five minutes (r49).** `clientVendorCard` keeps
the whitelist's output — never the row — in the Apps Script script cache, key
`partner_card:<vendor_id>`, for the portal and the client ticket. A vendor
portal save clears that company's card at once. **A hand edit to `VENDORS`,
`VENDOR_REVIEWS` or `VENDOR_PHOTOS` — including flipping `client_visible` off
— reaches customers within five minutes**; run `forgetPartnerCards()` from the
editor to apply it now.

**`capabilities` is not a service.** "Luxury", "pet-safe", "post-construction"
describe what a company is good at. The three `SERVICE_CODES` are what a
customer can book and what the calculator prices — putting luxury among them
would list something the booking flow has no path to.

**`default_payout_rate`, `internal_*` and `legal_name` appear in no view
model**, not even the vendor's own portal.

### VENDOR_REVIEWS — one row per quotation (r35)

`vendor_id · quote · author · rating · source · source_url · reviewed_on ·
client_visible`

Serve quoting somebody else on a customer's page. **No write kind names this
tab**, so a partner cannot add a review of themselves — the portal write path
knows exactly `profile`, `service` and `operator`, and a tab none of them names
cannot be reached at all.

**`source` is per row on purpose.** A Google rating, a quote from the company's
own site and a forum post are three different claims, and each says which it is.
A quote with no visible source reads as marketing Serve wrote about its own
partner, which is the one thing it must never look like.

**`source_url` must be `http(s)`.** It becomes an `href` on a customer page, so
a `javascript:` URL typed into the cell would otherwise be a live script there.
Anything else is dropped and the review still renders, without a link.

Quotes are **never truncated** — the cap is `MAX_CLIENT_REVIEWS` (3) on how many
are shown. Trimming somebody's words is the thing attribution rules object to.

### VENDOR_PHOTOS — one row per picture (r35)

`vendor_id · image_url · caption · sort · client_visible`

**`image_url` must be a same-origin `/images/…` path** — a file an operator put
in the repo, exactly as `logo_url` already is. An offsite URL is dropped, so a
photo row cannot be made to load a tracker from another host onto a customer's
ticket, and `..` is refused outright. `build-site.sh` already copies `images/`
wholesale, so a new photo publishes on the next push with no build change.

`caption` doubles as the alt text. An uncaptioned photo falls back to naming its
subject rather than rendering unlabelled: these are content a customer uses to
decide whether to trust a company, not decoration.

`sort` orders the strip ascending. `MAX_CLIENT_PHOTOS` is 6.

**A missing tab costs the reviews or the photos, never the card** — the same
failure shape as a missing `VENDORS` tab costing the card and never the
booking list.

### VENDOR_SERVICES — one row per (vendor, service)

`vendor_id · service_code · offers · preference · active · notes`

`service_code` must be one of `CLEAN_DEEP`, `CLEAN_STANDARD`, `CLEAN_MOVEOUT`.
Anything else is refused on write. `preference` is `preferred` / `neutral` /
`avoid`, and anything unrecognised falls back to `neutral` rather than storing
itself.

The portal renders all three services whether or not a row exists, so a vendor
answers every one rather than only the ones somebody happened to create.

### OPERATORS — one row per person

`operator_id · vendor_id · public_display_name · first_name · last_initial ·
photo_url · role · years_experience · specialties · active · show_to_customer ·
serve_rating · serve_jobs_completed`

`operator_id` is `OPR-0001`, generated by the portal when a vendor adds someone.

**`serve_rating` and `serve_jobs_completed` are Serve's.** They are shown to the
vendor and are not writable through the portal — a field arriving in the payload
that is not in `OPERATOR_EDITABLE` is dropped rather than written.

> **`show_to_customer` exists on the row and is deliberately read by nothing.**
> Serve introduces a *company* to a customer, never a named individual — the
> §148B position recorded on 2026-09-08. The roster is for dispatch and for the
> partner's own job tickets. Flipping that decision means teaching a client view
> model to read this column, which is a deliberate act rather than a config
> change.

### Assignment: two columns on JOBS, not a fourth tab

Add **`vendor_id`** and **`operator_id`** to `JOBS`, beside the existing
`cleaner` column. JOBS is already one row per booking and `getBooking` already
reads it; a join table would duplicate that for nothing.

Blank is a legitimate state: the client ticket says the professional will be
confirmed rather than inventing one.

**`vendor_id` is filled automatically as of r16** — see *The slot decides the
assignment* under AVAILABILITY. It is still on `OPS_OWNED_COLUMNS`: the webhook
writes it only into a blank cell and never blank-fills it, so a dispatcher's
own entry always wins.

**`operator_id` is never written by the webhook.** Which of their people comes
is the vendor's call, not Serve's — that is the §148B line, not a missing
feature.

### The portal carries the partner (r18)

Each **upcoming** booking in the portal payload carries a `partner` object
built by the same `buildClientVendorProfile` whitelist the per-job ticket
uses — one definition of what a customer may learn about a company, not two
to keep in step. `null` is a legitimate value and is what renders the
"coordinating with our vendor network" state; it is **every preference
booking**, since those consume no availability row.

Completed bookings carry no `partner` field at all. A finished job is a
receipt, and offering to go find someone for it would be nonsense.

A missing `VENDORS` tab costs the card, never the booking list.

### Getting a partner their link (r17)

**A booking is not required and never was.** A token is a pure HMAC of the id, so
the link exists the moment the `VENDORS` row does, never expires and never
changes. What was missing until r17 was a way to print one: the Apps Script Run
button cannot pass arguments, so `vendorUrl("VEN-0002")` had no caller.

In the Apps Script editor, pick **`printVendorLinks`** from the function dropdown
and Run. It logs every vendor with their status, whether customers can see them,
and their link. **`printCustomerLinks`** does the same for contacts — kept
separate because it prints a working credential for every customer you have.

Both are read-only.

This is the onboarding path *and* the sales path: add the row, run it, send the
link. A row with `status = prospect` and `client_visible = FALSE` has a fully
working portal that no customer can ever reach — **`status` does not gate the
portal**, only the token and the row existing do. So a company you are pitching
can be shown their own portal, with their own name and blurb in it, before they
have agreed to anything.

### What a vendor may change about themselves

Editable: `display_name` · `public_description` · `service_area` ·
`capabilities`, plus their own `VENDOR_SERVICES` rows and their own
`OPERATORS` rows.

Everything else is Serve's, and the write path is a **whitelist** — a column
added to `VENDORS` next month is not editable by a vendor unless somebody adds
it to `VENDOR_EDITABLE` on purpose. A denylist would fail open into exactly the
place it must not: a partner rewriting what Serve says about them.

### Logos

`logo_url` points at a file the site already serves, e.g.
`/images/vendors/beacon-hill.png`. A vendor cannot write to the repo, so V1 is:
they email the file, you add it to `images/vendors/` and set the column. The
portal shows the current logo and says how to change it. A real upload needs
somewhere to put bytes and is separate work.

**Push the file BEFORE setting the column.** The sheet and the repo are not
the same system: a path can be typed in seconds, the file only exists after a
deploy. In that order the logo is never broken, even briefly.

> **THE LOGO MUST READ ON A LIGHT BACKGROUND.** Both surfaces that show one
> are light — the partner card sits on `--color-bg-light`, the vendor portal on
> `#fff`. `images/serve-wordmark.svg` is `#ffffff`, drawn for the dark hero,
> and rendered perfectly and invisibly on both for a day. Serve's own row uses
> **`/images/serve-wordmark-dark.svg`** (`#1a2744`). Nothing detects this
> automatically: a white-on-transparent PNG loads fine and shows nothing.

Sizing: capped at 140 × 56, `object-fit: contain`. A wide wordmark is bound by
the width and looks right; a square mark is bound by the height and looks
small. Ask partners for a horizontal lockup.


### The Ops sheet — a separate workbook

`AVAILABILITY` lives in the **Ops** spreadsheet, not Leads MASTER, and is served
by `/apps-script/availability.gs` as its own deployment. Required headers,
case-sensitive: **`date`** · **`start_time`** · **`status`** (`cleaner_id` is read
but not required). A row is published when `status` is `open`, the date is a real
date cell, `start_time` parses as `"8:00 AM"` text or a real time value, and the
start falls between `MIN_LEAD_HOURS` (18) and `DAYS_AHEAD` (21) out.

Output is aggregated counts only — never cleaner names:
`{ ok, slots: [ { date: "2026-07-29", time: "1:00 PM", open: 2 } ] }`

`DAYS_AHEAD` must not exceed `HORIZON_DAYS` in `script.js`, or the site silently
discards the tail of the feed.

Responses are cached for 5 minutes, so a row added to `AVAILABILITY` takes up to
that long to appear on the site. Append `?nocache=1` to the `/exec` URL to bypass.

A missing or mis-cased header returns `ok:false` rather than an empty slot list.
That distinction matters: the site treats an empty list as "no availability" and
quietly serves the earlier/later radios, so a header typo would otherwise remove
the scheduler with nothing anywhere reporting a fault.

**Live header row (7 cols), confirmed 2026-07-28:**
`date · start_time · cleaner_id · status · job_id · week_of · notes`
Observed `status` values: `open`, `booked`, `held`.

#### `status` and `job_id` are now written by the webhook

On a slot booking the webhook opens the Ops workbook by id, finds an open row
matching date + time, sets it to `booked`, and writes the `job_id` — which is
what links a JOBS row to the AVAILABILITY row that satisfied it. **`held` is
never touched**; it is the operator's hold and only `open` is eligible.

*Which* open row, when several match, is decided by the ranking below. With a
single match it is the same row it has always been.

#### Unassigned capacity — a row with a blank `vendor_id` (r25)

**Leave `vendor_id` empty and the row is still a real, bookable slot.** It is
how a time gets offered — and guaranteed — before anybody is booked to work it:
the customer picks it, the webhook marks it `booked` and writes the `job_id`,
and the search for a partner starts from a time the customer has already chosen
rather than from a blank diary.

To post one, add a row with `date`, `start_time`, `status` = `open`, and
**nothing in `vendor_id`**. The feed never looks at that column — it reads
date, time and status — so the slot appears to customers like any other.

**The customer sees the same thing every preference booking has always shown:**
"Coordinating with our vendor network" on their portal and ticket, because the
JOBS row carries no `vendor_id` and `partnerPending` is therefore true. Filling
`vendor_id` on the JOBS row is what swaps that for the partner's card. Nothing
extra is built on the customer's side.

**It ranks below every real vendor** — see the table below. Serve should hand a
job to a partner who is genuinely free before promising to find one. It ranks
*above* `avoid` and `disqualified`, because "we will find somebody" beats
sending a company work they told us they do not want or do not do.

> **The booking notification says so, loudly.** An unassigned-capacity booking
> is the one case where a customer has been promised a time nobody is committed
> to yet, so the email reads `*** NO VENDOR YET, AND THE TIME IS PROMISED ***`
> and names the fix. It is deliberately different from the preference-booking
> wording — that one really did consume no availability row; this one did.

The read happens at write time, inside the script lock `doPost` already holds —
never from the customer's view, which the five-minute feed cache makes stale by
construction.

#### The slot decides the assignment (r16)

The AVAILABILITY row a booking consumes already knows whose capacity it was, so
dispatch is settled at booking time instead of copied across by hand. The vendor
column is read as **`vendor_id`** or, failing that, **`cleaner_id`** — so the
sheet can be renamed before or after the script is deployed and neither order
breaks a booking.

When more than one row is open at that date and time, they are ranked against
the booked service (`serviceCodeOf` → `CLEAN_DEEP` / `CLEAN_STANDARD` /
`CLEAN_MOVEOUT`) using `VENDOR_SERVICES`:

| Rank | Meaning |
|---|---|
| 4 | declared, offers it, `preference = preferred` |
| 3 | **declared nothing at all**, or declared it `neutral` |
| 2 | declared it `avoid` |
| 1 | declared their services and left this one out |

Ties keep sheet order, so the first matching row still wins among equals.

**Absence of data is not refusal.** A vendor with no `VENDOR_SERVICES` rows has
told us nothing, so they rank 3 rather than 1. That is what makes an empty
`VENDOR_SERVICES` tab a no-op — booking behaves exactly as it did before r16
until somebody actually declares a service. The same applies to a row with no
vendor in it at all, which is what most rows are before the sheet is migrated.

**A rank-1 pick is still booked.** Refusing would show the customer a conflict
on a slot the feed had just published as open — our data problem charged to
them. The notification carries a `NEEDS A HUMAN:` line instead.

The chosen vendor is then written onto the JOBS row's `vendor_id`, **into a
blank cell only**. A JOBS tab without that column is a silent no-op, which is
the state every JOBS tab is in until it is added.

**A conflict is not an error.** If no open row matches, someone took the slot
inside the cache window. The booking is still written and the notification
subject carries `· SLOT CONFLICT` for a human to resolve. Refusing the booking
would punish the customer for our caching. Likewise an unreachable Ops workbook
gives `· SLOT NOT MARKED` and the slot stays open until fixed by hand.

> **Drift hazard.** `webhook.gs` and `availability.gs` are separate script
> projects and cannot share code, yet both must derive the same date key and the
> same time label or every booking reports a phantom conflict.
> `slotDateKey`/`slotTimeLabel` in the webhook mirror `ymd`/`clockLabel` in the
> feed, and `tests/properties-and-slots.test.js` loads both files and asserts
> they agree. Change one, change the other.

**Protected from the script:** `PROPERTIES`, `RAW_INTAKE`, `OUTREACH_LOG`, `DASHBOARD`. `assertWritable()` throws rather than writing to any of them.

---

## The marketplace — Cloudflare D1 (2026-11-06)

**A third data store, and the first that is not a Google Sheet.** Founder
decision 2026-11-06: marketplace data lives in D1 from the start. Database
`serve-marketplace`, Worker binding `MARKET_DB`, schema in
`migrations/0001_marketplace.sql` (applied with
`npx wrangler d1 migrations apply serve-marketplace --remote`). Read and
written ONLY by `src/marketplace.js`. Sheets stay the record for everything
else — bookings, payments, the brokered lane, vendors, availability.

| Table | One row per | Written by |
|---|---|---|
| `providers` | marketplace company (`PRV-0001`) | seed + founder by hand (phase 2: admin page, vendor self-edit) |
| `provider_photos` | picture on a profile | seed / founder |
| `provider_quotes` | someone else's words about a company, with source | seed / founder |
| `clients` | phone number that has asked for an estimate (`CLI-…`) | `/api/estimate` |
| `estimate_requests` | estimate request (`EST-…`) | `/api/estimate`; quote fields by founder (phase 2: business portal) |
| `homes`, `home_rooms` | client home and its rooms ("My home") | phase 2 — tables exist, nothing writes them yet |

### `providers` — the rules that matter

- **`listed = 1` AND `status = 'approved'` is the ONLY thing that makes a
  company public** — directory, profile, `/api/providers`, and able to receive
  requests. Both are set BY HAND after the owner approves their profile. The
  seed forces `listed = 0` whatever the JSON says.
- **`internal_phone`, `internal_email`, `internal_contact`, `website_url`,
  `internal_notes` and `vendor_id` are never rendered and never returned.**
  Founder decision 2026-11-06: every request goes through Serve.
  `publicProvider()` is a whitelist built field by field; a new column reaches
  no page until it is added there on purpose. `tests/marketplace.test.js`
  greps every seeded profile for the business's phone number.
- **`rating` / `review_count` are shown only when `rating_checked_on` is set**,
  and then always with `rating_source` and the date. The seeded numbers came
  from prospect research and are unverified, so every seed row leaves it blank.
- **`claims` are the company's own words** and render under "From <name>:".
  **`insurance_verified` / `registration_verified` are Serve's checks** and
  render as "verified by Serve" only when 1. Never put a claim in a verified
  column because the company said so.
- `logo_path` and photo `path` must be same-origin `/images/…` (files live in
  `images/providers/<slug>/`, staged with `images/`). Anything else is dropped.
  `brand_color` / `logo_bg` must be `#rrggbb`. A logo must READ on its
  `logo_bg` — Rose's is white text and needs a dark one.
- `regions` ∈ `core · north · west · south`; `service_tags` ∈ `SERVICE_TAGS`
  in `src/marketplace.js`. Unknown values are dropped, not shown.
- `sort_rank` orders the directory ascending. **It is a placeholder** — how
  ranking stays neutral is an open founder decision.

### `estimate_requests`

`method` ∈ `phone · walkthrough`; `address` only for a walkthrough (never
logged — the Worker logs provider, method and ZIP only). `time_pref` ∈
`earlier · later` (8–12 / 12–5, the same windows as the booking form).
`client_ref` is minted by the page; a retry carrying the same one gets the
original row back (unique partial index). `quoted_price_cents`,
`quoted_frequency`, `quote_note`, `quoted_at` hold **the quoted price — the one
number the marketplace exists to keep**; nothing writes them yet (phase 2).
`notified_at` is stamped when webhook r63 confirms the founder email: **a blank
`notified_at` is a request nobody was told about.**

### Leads MASTER: `ESTIMATE_REQUESTS_LOG` (r63, auto-created)

`request_id · created_at · provider_id · provider_name · method · time_pref ·
phone · address · zip · sms_consent · source · logged_at`

**A COPY, NOT THE RECORD.** Appended by webhook r63 when the Worker relays a
saved request; editing it changes nothing in D1, and it deliberately has no
status column. Idempotent on `request_id`.

### Secrets and keys

`MARKET_BRIDGE_SECRET` — Worker secret AND Apps Script Script Property, equal,
and different from the photo and payment bridge secrets. Set the Worker side
LAST (after r63 is deployed). `MARKET_PREVIEW_KEY` — Worker secret;
`/providers/<slug>?preview=<key>` shows an unlisted profile, noindex and
uncached. Anyone holding the link sees every draft.

---

## Endpoints

Two Apps Script web apps, in two different spreadsheets, deployed separately.
Both owned by servecos.com. This table is the thing that was lost when the
workbook changed accounts — keep it current.

| | Booking webhook | Availability feed |
|---|---|---|
| Source | `/apps-script/webhook.gs` | `/apps-script/availability.gs` |
| Spreadsheet | Leads MASTER | Ops |
| Reads / writes | JOBS, LEADS, EVENTS | AVAILABILITY (read-only) |
| Called from | `SHEETS_URL`, `script.js` ~line 155 | `AVAILABILITY_SOURCE_URL`, `script.js` ~line 174 |
| Method | `POST`, `Content-Type: text/plain` | `GET` |
| Deployed version | `2026-08-28 r9` deployed — **repo is at r10, NOT deployed** | `2026-07-27 avail r2` |
| Health check | open the `/exec` URL — `doGet` returns the stamp | the `/exec` URL *is* the feed |
| Editor dry-run | `reportLeadsSchema()`, then `testPayload()` | `testAvailability()` |

> **Repo and deployment agree as of 2026-08-29: both are r9.** r8 was never
> deployed on its own; its additions (`geo_factor` / `park_tier` / `levels`)
> reached production inside r9, along with the stable `property_id` /
> `contact_id`, the digits-only `phone_e164`, and levels on the booking email.
>
> This row has been stale before — it read `r4` while `HANDOFF.md` §3 read `r6`,
> and neither matched what was actually deployed. **Two files claiming a version
> is not evidence.** Open the `/exec` URL and read the stamp `doGet` returns;
> that is the only statement about the deployed version that cannot be wrong.
>
> Webhook revisions have been additive so far, which is why a lagging deployment
> has never cost a booking: an older deployment receiving a newer payload ignores
> keys it does not know and writes every existing column exactly as before. The
> site can therefore ship ahead of the webhook. That property is a design choice,
> not a guarantee — a revision that changes an existing column's meaning would
> break it, and would need the deployment to go first.

#### Both are kept warm by a cron (2026-09-13)

Apps Script sleeps an app that nobody has called, and the next caller pays the
cold start. `wrangler.jsonc` therefore carries **two** cron triggers, and
`scheduled()` in `src/worker.js` branches on `controller.cron`:

| cron | what runs |
|---|---|
| `17 8 * * *` | `cleanupPhotoStorage()` — deletes purged room photos from R2 |
| `*/5 * * * *` | `warmUpstreams()` — a GET to each `/exec`, purely to keep the container alive, **plus (r55) one POST `booking_notify` `action:"sweep"` to the webhook**, which sends any booking text/email parked for over a minute |

#### Booking texts and emails are sent after the answer (r55, 2026-09-17)

`/api/submit` adds `notify_deferred: true` to the booking it relays. The webhook
then writes the sheets, parks what the text and email need in **one script
property, `notify:<submission_id>`** (JSON, ≤ 8,500 chars), and answers with
`notify_pending: true`. The Worker answers the browser and, in `waitUntil`,
POSTs `{event_type:"booking_notify", submission_id}`; the webhook claims the
property under the script lock (read + delete), releases, and sends.

| field / key | where | meaning |
|---|---|---|
| `notify_deferred` | request, Worker → webhook | delivery instruction; deleted before any row is written |
| `notify_pending` | webhook reply, reservation and duplicate | a notice for this submission is parked; the Worker should send it |
| `notify:<submission_id>` | Script Properties, Leads MASTER project | the parked notice, contact details included; deleted on claim |

At most once per booking. No secret: the call can only send a notice the
booking already parked. Too large, an unusable `submission_id`, a failed
property write, or no `notify_deferred` → sent inline exactly as before r55.
Either deploy order is safe.

#### "Is this booking in the sheet yet?" (r56, 2026-09-17)

**`GET /api/booking-status?id=<submission_id>` → `{ok, found}`.** The Worker
relays it as **`GET <WEBHOOK_URL>?booking=<submission_id>`**; the webhook answers
`{ok:true, found, notify_pending}`.

**Why it exists.** `/api/submit` is a write with a 12s budget, and a POST that
does not return in time carries **no information about whether the booking
happened**. Those two were treated as the same thing until a booking that had
fully succeeded — row written, text delivered, email delivered — showed the
customer "your booking could not be confirmed" (2026-09-17, r53 live). No
timeout can be tuned out of that; a reservation is a dozen Sheets calls across
two workbooks behind the script lock and its tail is long. So the browser got a
**second, cheaper question** instead of a longer wait.

| property | why it is load-bearing |
|---|---|
| **No script lock** | `routePost` waits up to 20s for the lock before routing, so a status check sent as a POST would queue behind the very booking it asks about — the trap r53 found in the retry. `doGet` takes none, so this answers *while* the slow write is still running. |
| **No write, ever** | it is a GET; it cannot create a row on any deployment. |
| **`found` is `alreadyWritten()`** | the same predicate the reservation dedupes on, so "the screen says confirmed" and "a replay says duplicate" are one fact. Two opinions about whether a booking exists is two screens for one customer. |
| **Always HTTP 200** | every answer means "it is there" or "still don't know"; the caller's response to the second is to ask again. A 502 reads as an outage and would stop the poll on a live booking. |

**Nothing about the customer crosses this boundary** — no name, number, address,
price or `job_id`. A `submission_id` is a random id the browser minted for
itself and the answer is one boolean about it, so there is no secret to check
and nothing to learn by guessing ids.

**Safe in either deploy order, and safe un-pasted.** A webhook older than r56
does not know `booking` and falls through to its health stamp, which carries no
`found`; the Worker reports `upstream_stale` and **logs that the script needs
pasting**. The browser then behaves exactly as it did before r56.

The browser's side: a reservation POST that does not answer starts a watch
(`RESERVE_WATCH_MS`, polling every `RESERVE_WATCH_INTERVAL_MS`) *and* replays
the POST once. Either may confirm; **only the watch may conclude failure**, and
it is sized to outlive the replay so that stays true. The failure panel now
means the booking is genuinely not in the sheet.

**The strings are duplicated in `wrangler.jsonc` and in the `CRON_*` constants**
— Cloudflare reads the config, the Worker reads the event — so a test asserts
the two agree. Drift is silent and one-directional: the daily cleanup would
simply stop running with nothing anywhere reporting it. For the same reason the
destructive job runs ONLY on an exact match and any unrecognised schedule falls
through to the harmless ping.

The ping is a plain GET, never `?nocache=1`: the goal is a warm container, and a
cache hit still executes the script. Its timeout is 25s — deliberately far
longer than the 8s a customer-facing call gets, because nobody is waiting behind
it and absorbing the cold start here is the entire point.

**A cron that failed to register looks exactly like one that is not working.**
After any deploy that changes `triggers`, confirm the schedules are listed under
the Worker's Settings → Triggers in the Cloudflare dashboard; `wrangler deploy
--dry-run` validates the config but does not report them.

#### How the webhook reads the sheets — ONE READ PER TAB, PER REQUEST (r44)

Every SpreadsheetApp call is a round trip to Google. r43 opened a five-booking
customer's portal with **211** of them — JOBS read seventeen times, the whole
photo tab once per booking — and the page could show nothing until the last
came back. r44 opens the same portal with **39**, the vendor portal with 19
(was 79), a cleaner's ticket with 22 (was 51), a saved access answer with 28
(was 102) and a new booking with 77 (was 103). Measured by counting harness,
not estimated; the before/after responses and every tab were compared and are
**identical**.

**What any response contains did not change.** This is a contract about how
often the sheet is asked, and it has three rules a future change must keep:

| Rule | Why | Enforced by |
|---|---|---|
| **A GET reads each tab at most once**, and its cost does not grow with the number of bookings. `readTable(ss, name)` shares a tab's values for the rest of the request. | This is the speed-up. | `tests/read-budget.test.js` §1–2 |
| **A GET writes nothing.** | The shared snapshot is only true because nothing changes the sheet mid-request. A GET that starts writing must not also keep reading through `readTable`. | `read-budget` §3 — every GET route is checked for zero writes |
| **A POST never shares a snapshot.** `readTable` reads fresh on every call inside `doPost`, and `sheetValues(sheet)` — what the write paths use — is fresh everywhere. | A POST reads, writes and reads again (book the new slot, then release the old one). | `read-budget` §4, including a check of the scope `doGet`/`doPost` actually open |
| **r49: a photo read is the one POST that runs like a GET.** `doPost` routes `booking_photo` with `action` exactly `"read"` before the script lock, in a shared-snapshot scope. Begin, commit, delete and cleanup still take the lock. | Every POST waits for the lock, so thumbnails loaded one at a time site-wide, behind bookings. Safe only because the read branches write nothing. | `read-budget` §8 — every read kind: no lock, no writes, shared scope |

Handles that are not data — the Ops workbook (`opsBook()`), each workbook's
timezone (`sheetTimeZone()`) and the ticket secret — are looked up once per
request, GET or POST. Code run from the editor has no request scope and reads
exactly as it always did.

**One behaviour did change, deliberately.** A booking in a portal or vendor
list is now built from *its own* JOBS row. Before, it was re-found by `job_id`
and the first match won — so on a sheet where an operator had copied a row
without changing its id, a second customer's portal showed the first
customer's row. Only a duplicated `job_id` can see the difference.

**The three signed-link pages start their request from `<head>`** (r44 site),
before the stylesheet and scripts have downloaded, and the page script adopts
that answer. The address is therefore built in two places — the inline script in
`h.html`/`j.html`/`v.html` and the page script — and **must stay identical**,
or the page quietly asks twice. `tests/early-load.test.js` runs both and counts
the requests. Change a query parameter of `/api/portal`, `/api/job` or
`/api/vendor` and change both.

**Deploy settings both need:** Execute as **Me**, Who has access **Anyone**.
Anything else and the browser gets a login page instead of JSON.

`Content-Type: text/plain` on the POST is deliberate — it keeps the request
CORS-simple so no preflight `OPTIONS` is fired, which an Apps Script web app
cannot answer. The `.gs` reads `e.postData.contents` regardless. The site gates
its success panel on `{status:"ok"}`, so do not change the response shape.

**Version stamps are the drift detector.** If a `/exec` health check reports a
version older than the repo, what is deployed is stale — saving the editor does
not redeploy. Use Deploy → Manage deployments → pencil → New version to keep the
same URL. Bump the stamp on any behavioural change, not just schema changes.

**Archive superseded deployments.** A retired deployment keeps answering and
keeps writing wherever it was bound; browsers cache `script.js` for hours, so
stale copies keep POSTing to the old URL. Archived on 2026-07-27:
`AKfycbwaMIS1nklX…` (old webhook) and `AKfycbxx_iQ1x71D…` (old availability),
both confirmed returning 404.

---

## Known open items

- `linkdin` in RAW_INTAKE is a typo for `linkedin`. Header matching is by exact text — fix it and the mapping together, or not at all.
- `ltv` has no formula yet.
- **Slot depth is one cleaner deep.** Write-back now prevents a slot being sold
  twice, but with a single `open` row per time a conflict is still a real clash
  rather than a queue. This is a roster problem, not a code one — more
  `AVAILABILITY` rows per time means `open: 2+` and genuine resilience.
- ~~**Nothing releases a slot.**~~ **CLOSED by r43.** `releaseAvailabilitySlot()`
  now hands capacity back when a visit is cancelled or moved, using exactly the
  handle this entry named: the `job_id` written into the `AVAILABILITY` row. It
  matches on that id and never on date and time — after a conflict a human
  resolved by hand, the square on the calendar can belong to somebody else — and
  it never touches a `held` row, which is an operator's own diary rather than
  public capacity. Every cancellation before this release leaked its time out of
  the feed permanently; those rows still read `booked` and are worth a look.
- **The availability feed cold-starts slower than the Worker waits.** Observed
  2026-09-13: `/api/slots` answered `{"ok":false,"error":"upstream_unreachable"}`
  on a first probe and `ok:true` with 14 slots moments later — with the feed
  itself healthy both times (`avail r3`, answering directly in well under the
  cap). An Apps Script cold start can exceed the Worker's 8s `slots` timeout.
  **Nothing breaks:** the booking form falls back to the earlier/later radios
  and the portal's plan card says it has no open times to show. But both are
  degraded for the first visitor after an idle period, and that visitor now
  includes anyone confirming a recurring plan or rescheduling a visit.

  **MITIGATED 2026-09-13 by a warm ping, not cured.** A second cron trigger
  (`*/5 * * * *`) calls `warmUpstreams()` in the Worker, which GETs both Apps
  Script apps so a container is already awake when a customer arrives. The
  visitor-facing timeouts were deliberately left alone: raising them would not
  remove the wait, only move it into the customer's browser. **Low traffic is
  what made this bite** — idle is the normal state of a quiet site, so "the
  first visitor after idle" was close to every visitor. It is a mitigation
  because a cold start is still possible: right after a Worker deploy, if the
  cron misses, or if Google's undocumented idle threshold is shorter than five
  minutes. Watch for `warm ... failed` lines in the Worker logs — that is the
  only place a failing ping is ever visible.
- Part of the original build spec was lost to a truncated paste — the `src` /
  "skins" / "redirects" sub-items of Task 1. All three are now built: `src` by
  the attribution work, skins and redirects re-specified and shipped 2026-07-28.
- Part of the original build spec was lost to a truncated paste — the "skins" and
  "redirects" items of Task 1. Both were re-specified and built on 2026-07-28
  (two hero skins plus `/movein` and `/clean`). Nothing outstanding.

### `segment` — resolved 2026-07-28

`segment` is an **intent** taxonomy: `movein · pro · direct`. Derived from the
first-touch `src` prefix by `SRC_SEGMENTS` in `script.js` (~line 172).

Channel is deliberately **not** what this column records — `source` already holds
the full first-touch tag and `src_chain` holds every tag of the window, so a
third channel field would say nothing new. Segment answers what the person
*needs*, which is what selects the hero skin and the pricing emphasis.

| Prefix | Segment | Meaning |
|---|---|---|
| `deed` `db` `mv` | `movein` | Just closed. Needs a first clean, buys once, decides fast. |
| `dh` `poster` `qr` `flyer` `eddm` | `pro` | Lives here already. Pitch is weekends back; goal is a recurring plan. |
| `email` `em` | `pro` | Cold email to the professional segment. |
| `ref` | `direct` | A person sent them, but we do not know why. |
| *(no tag)* | `direct` | |
| *(unrecognised tag)* | `direct` | Intent unknown — guessing puts the wrong pitch in front of a real customer. |

Selection is **first touch**. A visitor who arrives on a deed link and later
scans a poster QR stays `movein`; the poster did not change why they need a
clean.

Any row stays recomputable — `source` keeps the full tag — so a prefix added
later can be backfilled. **No backfill was needed at resolution:** `JOBS.segment`
held `direct ×1` and blank ×12, with no channel values anywhere.

---

## Changelog

| Date | Change |
|---|---|
| 2026-09-29 | **Home services — webhook r62, the Worker and the site.** Two new Leads MASTER tabs, **`SERVICE_REQUESTS`** and **`SERVICE_REQUEST_PHOTOS`**, both auto-created; a third portal tab; one new portal write `kind: service_request`; the portal model gains `requests[]`. No JOBS column, no change to any existing view model. A portal customer can report a problem or ask for a quote on any category in the homepage grid — pick the service, say what is wrong, attach a photograph, send. **It is a request, not a booking:** nothing is scheduled, priced, charged or assigned, and the only delivery is one email to `NOTIFY_EMAIL`. Three founder's calls are built in rather than defaulted, and `service-requests.test.js` §2 asserts each of them against the shipped files: the **homepage grid still reads "Coming to Serve"** for five of the six (a request channel for existing customers is not a public capability claim), **no timeframe is promised anywhere** (no partner has agreed to one), and **nothing is priced**. `status` is operator-owned after `NEW` and reaches the customer only through a label whitelist. The write is idempotent on a browser-minted `client_ref`, so the r58 timeout failure cannot file one leak twice. **`booking_photo` gains `purpose: "request"`, and the Worker's purpose handling became a whitelist** — it previously treated every unknown purpose, typos included, as an instruction photo, which would have filed a locked completion image under the sweepable prefix. New sections above; see `HANDOFF.md` §r62. |
| 2026-09-15 | **Payment state is written down — webhook r50, the Worker and the site. THE FIRST ENTRY HERE THAT CHANGES AN OWNERSHIP PROMISE.** `payment_status` (#20) was documented as "never touched by the script" since this file was created; it is now written by Stripe through one exempt path, `handlePaymentEvent`, behind a new Script Property `PAYMENT_BRIDGE_SECRET`. It stays in `OPS_OWNED_COLUMNS`, so every other caller is still refused, and a hand-typed value still works. **New column `payment_ref` (37)** — the Stripe PaymentIntent; optional, and absent it the state still writes. **New recognised values** blank · `authorized` · `paid` · `released` · `refunded`, because authorize-at-booking has three states and the column could previously say only two — recording a hold as `paid` tells a customer they were charged when no money has moved. Both customer view models gain `authorized` beside `paid`; `paymentNote` replaces the hardcoded "Due at service". **New Worker route `/api/stripe-webhook`**, the only one authenticated by a signature rather than a ticket token, plus `can_record_payments` on `/api/health` — `can_charge: true` with `can_record_payments: false` is the dangerous combination and is now one request away from being visible. A customer cancelling a booking with an uncaptured hold releases it; a captured one is still a human's decision. `partner_payout` documented at last — it has existed since r13 and appeared nowhere in this file. See `HANDOFF.md` §r50. |
| 2026-09-15 | **Load-time fixes — webhook r49, the Worker and the site.** No column, tab or response change; the paste and the push can go in either order. Webhook: a `booking_photo` read runs before the script lock, in a shared-snapshot scope (new row in "How the webhook reads the sheets"); the customer's partner card is cached five minutes per company, cleared by a vendor portal save or `forgetPartnerCards()` (see VENDORS). Site: `booking-photos.js` remembers photos it has read for the life of the page and sends at most three reads at once. Worker: an `/api/address` miss reads its two counters together and writes both before the provider is called (still fail-closed), then saves the answer via `waitUntil`. `read-budget.test.js` §8–9, `address-suggest.test.js` A4 and the new `photo-cache.test.js` enforce it. See `HANDOFF.md` §2026-09-15. |
| 2026-09-14 | **The cleaner ticket's rooms, simplified — webhook r48, the Worker and the site.** Supersedes r47's UI. New tab **`PARTNER_NOTES`** (auto-created; partner-token writes via `partner_note`). **`COMPLETION_PHOTOS`** drops `room_label`, `service_label`, `scheduled_date` and no longer requires `finished: true`. View models: partner ticket `scope[].note`; vendor portal `bookings[].report` replaces `completionHistory`; customer portal `bookings[].partnerNotes`. Site: each Scope room is a closed box with one Add photos control and an optional note; `completion-photos.css` removed. See `HANDOFF.md` §r48. |
| 2026-09-14 | **A plan after a move — webhook r45, the Worker and the site.** No column or tab change. The portal model gains `movePlan`; two portal writes `plan_start` and `plan_change`; `/api/quote` also returns `recurring` (the engine's three per-visit prices). A move-in / move-out customer chooses a cadence priced by the engine for their home, books the first visit at an open time or earlier/later, and the box stays as their plan until they change it. `bookPlanVisit`, `visitAlreadyAt` and `moveVisit` were split out of r42/r43 unchanged. New section "A plan after a move" above. See `HANDOFF.md` §r45. |
| 2026-09-13 | **One read per tab, per request — webhook r44, plus the site.** No column, tab or response change. The portal, tickets and vendor portal were slow because every helper re-read the tabs it needed; a request now reads each tab once (`readTable`, shared only inside `doGet`), opens Ops once, and builds bookings from the JOBS rows already in hand (`bookingFromRow`). Portal load 211 → 39 Sheets calls; vendor portal 79 → 19; a new booking 103 → 77. Old and new were run through the same 82-request sequence in two timezones — reads, saves, reschedule, cancel, plan confirmation and a booking — and every response, tab and log line came out identical. Site: /h, /j and /v paint a skeleton immediately and start their request from `<head>`; the portal fetches open times before the customer clicks; the booking form asks for times at the first touch of step 1 and keeps a second try if that fails. New contract in "How the webhook reads the sheets" above; `read-budget.test.js` and `early-load.test.js` enforce it. See `HANDOFF.md` §r44. |
| 2026-09-13 | **Reschedule and cancel — webhook r43.** Two portal writes act on a booking the customer already has, and `releaseAvailabilitySlot()` closes the "nothing releases a slot" open item that had stood since r5 — every cancellation before today leaked its time out of the feed permanently. No new column: `job_status` gains the value `cancelled` (written by the script, second value it writes), and the row is **kept, never deleted**, so counts of booked work keep including work that was given back. `JOBS.vendor_id` stays ops-owned — `setJobCells()` throws on any ops column rather than skipping it. **The anchor is untouched by both writes**, which is the property the release exists to protect: a one-off move shifts one visit, never the cadence. New optional Ops `SETTINGS` key `cancel_notice_hours`, defaulting to `0` — the mechanism is built and enforces nothing until the founder sets a number, because a notice window is a customer promise with a refund question attached. Two real defects were caught by the new tests rather than in production: a release that gave back the slot a move had just booked, and a guard comparing `getBooking`'s display time (`"1:00 PM ET"`) against a raw slot time (`"1:00 PM"`), which meant it never once fired. See `HANDOFF.md` §r43. |
| 2026-09-02 | **Server-side price verification — no schema change, one new payload key.** The pricing engine moved out of `script.js` into `pricing-engine.js`, and the Worker now re-derives every booking's price instead of trusting `quote_price` from the browser. `pricing_version` joins the payload and rides in `quote_meta`; it is what lets the server tell an edited payload (same version, different price → refused) from a deploy that landed mid-session (different version → the quoted price is honoured). 86,400 configurations priced before and after the extraction and compared by hash — identical. **This caused a live outage:** the two shared files are classic `<script>` files exporting through `if (typeof module …)`, which never runs under a bundler that treats `.js` as ESM, so the Worker's import was `undefined`, every geo-mapped ZIP priced as unmapped, and bookings from 49 ZIPs were rejected for about an hour. Fixed by generating a real ES module (`src/engine.generated.mjs`) rather than importing the sources. Rejection is now gated on `CAN_PRICE`, so a Worker that cannot reproduce the browser's arithmetic relays instead of refusing. See `HANDOFF.md` §2026-09-02 before touching the Worker's imports. |
| 2026-09-01 | **Webhook r10 — `job_notes` updates an existing JOBS row.** The reserve step's "anything we should know?" textarea was removed: asking at the moment of commitment costs bookings, and free text is the worst shape to ask in — it arrives as prose to be re-typed into PROPERTY_MEMORY by hand. The same question now sits on the confirmation screen, after the spot is claimed, and posts a `job_notes` event carrying the booking's `submission_id`. **This is the one write path that deliberately skips `alreadyWritten()`** — everywhere else a repeated submission_id is a replay to ignore; here it is how the booking gets found. Blank-fill only, so a second send cannot erase the first and a hand-edit always survives, and it never throws because the booking is already confirmed on screen. No new column: it fills `customer_notes` and `pets_flag`, both of which now arrive **blank at booking**. The site sends neither key rather than sending `''` and `false` — `FALSE` would read as "asked, and no pets" when nobody was asked, the same trap as a blank `levels`. `PET_WORDS` extracted so `petsFlag()` and `petsFromText()` cannot drift. Covered by SCENARIO 6 in `tests/webhook-routing.test.js`. **Repo is r10; production is still r9.** |
| 2026-08-29 | **r9 deployed — repo and production agree for the first time since r6.** `/exec` confirmed reporting `2026-08-28 r9`. This is a deployment, not a schema change: every column below was already documented, but until today none of `property_id`, `contact_id`, `phone_e164` or `PROPERTY_MEMORY` was being written by a real booking. Two "Deployed version" rows that had been stale for a month (this file said `r4`, `HANDOFF.md` §3 said `r6`, production was actually r8) are corrected. **Neither file is evidence — read the stamp from `/exec`.** Also shipped in the same paste: the booking notification email now states `Levels:` on its own line, always, including one floor, and says `NOT REPORTED` when a cached browser sends no `levels` key at all — a blank there is indistinguishable from a field that never arrived, which defeats the point of the line. |
| 2026-08-28 | **Webhook r9 — stable ids, and property matching stops using the key.** PROPERTIES gains `property_id` (`PROP-nnnn`), LEADS gains `contact_id` (`CON-nnnn`) and `phone_e164`, and both ids are written onto the JOBS row. New tab **`PROPERTY_MEMORY`** (11 cols) holds what the crew learns; the webhook only ever appends a blank row for a new property and is barred from filling any cell by `assertPropertyMemoryWritable()`. **The real fix is that `upsertProperty()` now matches on normalised FIELDS — zip, address, unit — not on the `property_key` string.** One apartment had become three records because `unit 0006` / `6` / `0006` produced three keys and Sheets strips leading zeros; field matching is immune to both, and to any future key-format change. ZIP stays in the key deliberately: Greater Boston recycles street names across the towns served, so dropping it would merge two different homes — worse than a typo forking one. Door codes are **not** in this workbook; they live in a separate `Access MASTER` file. `duration_min` is now defined as **cleaner-minutes**, not elapsed. See `HANDOFF.md` §2026-08-28. |
| 2026-08-24 | **Prices derived from a work model — no schema change.** `DEEP_MULT`, `MOVEOUT_MULT` and all three `FREQ` values are now computed from `WORK_MODEL` (labour, measurable with a stopwatch) and `MARGIN` (a business decision), rather than set directly — so a price has a stated reason for the first time. `PER_LEVEL` $50 → $191 on a measured 4h→6h storey comparison; the small-unit multipliers withdrawn as a double discount. No column added, renamed or repurposed, and the booking payload is untouched. Recorded here for one reason: **every published price moved**, and `/pricing` and `/services` render from `computeQuote` — recurring +27%, move in/out −16%, first clean −7% on 2BR and up. The 50% first-clean discount was reviewed and deliberately kept below contractor cost as acquisition spend. See `HANDOFF.md` §2026-08-24. |
| 2026-08-21 | **Geo factors recalibrated against the parcel data — no new column.** The three tiers (`LARGE` / `STD` / `SMALL` at 1.30 / 1.00 / 0.85) were withdrawn before deployment and replaced by a continuous per-ZIP factor. **The reason is a double-count:** the tier index controlled for bedrooms × levels, but the calculator also charges `PER_BATHROOM`, so bathroom-driven size was billed twice — which is why LARGE read 1.30 when the data supported 1.09. Rebuilt on bedrooms × baths × levels, with Boston figures scaled by 0.9825 to share one regional footing with the MassGIS towns. Schema impact is a **rename inside `quote_meta` only**: `zone` → `geo_factor`, now a number. Nothing was ever written under the old key — r8 is still undeployed. Published prices did not move: the tables now state their neutral basis outright (`SERVE_RANGE_GEO`) instead of borrowing whichever ZIP sat nearest 1.00, so a future data refresh cannot silently reprice three pages. All 15 published cells verified byte-identical. See `HANDOFF.md` §2026-08-21. |
| 2026-08-20 | **Geographic pricing — webhook r8.** The quote gains a `levels` input, half-step bathrooms, a silent per-ZIP zone factor and a parking adder, all from `serve-geo-data.js` (49 ZIPs, derived from 184,552 Boston parcels plus four MassGIS layers). Schema impact is additive and needs no header: `zone` and `park_tier` join `QUOTE_META_KEYS`, `levels` joins `OPS_PREFERRED_KEYS` so a `levels` header on JOBS would pick it up automatically. **Nothing geographic is user-facing** — see the `quote_meta` note above. Published prices did not move: `SERVE_RANGE_ZIP` was repointed 02116 → 02130 in the same commit, because the new map rates Back Bay LARGE and leaving the anchor there would have raised every published price on three pages by about a third as a side effect. All 15 published cells verified byte-identical against the previous engine. Real quotes now spread $183–$282 for a 2BR/1BA first clean where they were a flat $198 across CORE. See `HANDOFF.md` §2026-08-20. |
| 2026-08-19 | **Published pricing — no schema change.** `/pricing` and `/services` shipped, plus two homepage teasers. No column added, renamed or repurposed; the booking payload is untouched. Recorded here for one reason: **every price cell is a link into the calculator, and the hop preserves existing query params**, so `src` / `src_first` / `src_chain` and therefore `segment` survive a visitor clicking a published price. Attribution reaching JOBS and LEADS is unchanged by the new pages. Prefill lands on the Build step unless a ZIP is already resolvable — deliberately, because a booking submitted with a blank `zip` would break `property_key` and skip the PROPERTIES upsert. See `HANDOFF.md` §2026-08-19. |
| 2026-08-16 | **Webhook r7 — SMS consent.** LEADS gains `sms_transactional` / `sms_promotional` / `sms_consent_at` (columns 20–22) for Twilio A2P 10DLC registration; the timestamp is server-stamped and the site never sends `"no"`, so a blank cell stays upgradeable. Consent also rides in JOBS `quote_meta` as a per-booking snapshot, needing no JOBS column. Site side: `/privacy` and `/sms-terms` published as real pages on the allow-list, two separate unchecked consent boxes beside the phone field, policy links in the footer of every page, and `/book` added as the opt-in URL named in the campaign registration. **The three LEADS headers are not on the live tab yet — add them by hand before sending any message.** `tests/sms-consent.test.js` guards the whole surface. |
| 2026-08-14 | **Service area.** Six ZIPs that had never been listed — 02210 Seaport, 02215 Fenway/Kenmore, 02199 Back Bay, 02163 Allston/HBS, 02136 Hyde Park, 02447 Brookline Village — added to `ZIP_TIERS.CORE` after a Seaport visitor was shown the waitlist instead of a price. Coverage 53 → 59, purely additive. `tests/service-area.test.js` pins the sold-to list so a dropped ZIP fails the suite rather than silently costing a lead. |
| 2026-07-28 | **Webhook r5.** `PROPERTIES` upsert — six columns, blank-fill only, the tab stays on the protected list behind a `assertPropertiesWritable()` allowance that refuses any other tab. `AVAILABILITY` write-back to the Ops workbook — `open` → `booked` plus `job_id`, never touching `held`, read at write time inside the existing script lock. Both run *after* the JOBS row and can never fail a booking; failures surface as `· SLOT CONFLICT` / `· SLOT NOT MARKED` / a PROPERTIES warning in the notification. Ops tabs `CLEANERS`, `SCHEDULE`, `OPS_DASHBOARD` added to the protected list now that the workbook is reachable by id. |
| 2026-07-28 | `segment` resolved to the intent taxonomy `movein · pro · direct`; two hero skins select off it by first touch; `/movein` and `/clean` vanity redirects feed the same first-touch path. Confirmation panel now promises a confirmation email within 15 minutes with the footer address as fallback — the tripwire for a silent write failure, which otherwise looks identical to success from the customer's side. |
| 2026-07-28 | **Privacy.** The Pages workflow published the whole repo to servecleaning.com, including a personal profile. Site moved to Cloudflare with an allow-list build, the GitHub repo made private, and every personal identifier purged from all 47 commits on both branches. `tests/privacy.test.js` enforces it. |
| 2026-07-27 | JOBS extended 22 → 36 columns (attribution, contact snapshot, customer notes, pets, address, quote_meta). LEADS upsert added. EVENTS tab introduced. This file created. |
| 2026-07-27 | Reconciled `webhook.gs` against this file: protected-tab names normalized to underscores (the guard had been comparing against space-separated names and was silently inert for `RAW_INTAKE` and `OUTREACH_LOG`); LEADS upsert extended to `service_address` / `unit` / `zip`; `received_at` switched from UTC to America/New_York; `start_time` now carries the preference label on non-slot bookings instead of being left blank. |
| 2026-07-27 | Timezone pinning. `job_id`'s undated fallback and `prettyDate()` were using the Apps Script *project* timezone while `received_at` used `America/New_York`. All date formatting now pins `BUSINESS_TZ`, and `prettyDate()` is timezone-free entirely — a booked calendar date has no timezone, and deriving the weekday through a local `Date` could shift it by a day. **Correction:** an earlier version of this entry said a live `testPayload()` run had produced a `job_id` dated a day off its `received_at`. That was inferred from the `job_id` alone; the row's `received_at` was never checked and the two may well have agreed. The fix stands regardless — the webhook and availability scripts are separate Apps Script projects with independent timezone settings, and nothing guaranteed they matched. |
| 2026-07-27 | **Verified against the live workbook** via `reportLeadsSchema()`: six tabs confirmed with underscore names; JOBS at 36 columns in the documented order with `quote_meta` present; LEADS at **19** columns — the `segment` header has landed, so coverage is complete and nothing is skipped; `first_touch` / `last_touch` confirmed to hold real `DATE` values (number format is Automatic, which is cosmetic). Row matching resolves on `lead_id`. |
| 2026-07-27 | **Merged to `master` and live** (`487bb1f`). Verified after deploy: `servecleaning.com/script.js` byte-identical to the repo, both endpoint constants resolving to the current deployments, webhook reporting r4 and availability r2, `Access-Control-Allow-Origin: *` present, and the live 9-slot feed rendering through the site's own `filterSlots()`. Old deployments archived and confirmed 404. Added to this file in the same pass: the Endpoints registry, the EVENTS column list, the availability cache and `ok:false` behaviour, and the double-booking gap. |
| 2026-07-27 | LEADS `first_touch` and `last_touch` resolved from TO DEFINE to **record-activity timestamps written by the webhook** as real Sheets datetimes — not outreach dates. `first_touch` is immutable after creation (enforced, throws); `last_touch` bumps on every matched booking. `LEADS_FIELDS` now lists payload keys translated through `LEADS_HEADER_MAP` (`address` → `service_address`), mirroring how JOBS already worked. Live LEADS tab confirmed at 18 columns; `segment` still pending. |
