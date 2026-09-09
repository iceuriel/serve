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
| 20 | `payment_status` | **OPS** | Never touched by the script. |
| 21 | `job_status` | WH → OPS | Script writes `new` at booking. Operator updates thereafter. |
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
| 36 | `quote_meta` | WH | JSON blob: secondary quote data only (`original_price`, `discount_applied`, `steady_state_price`, the three recurring prices, `zip_tier`, `page_path`, `utm_*`, `unit_label`, `src`, `submitted_at`, the two SMS consent flags, plus `zone` / `park_tier` / `levels` — see below). |

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
| `BOOKING_INSTRUCTIONS` | What the customer asked for on ONE visit, scoped to the booking, a room, or an access question. Auto-created by the webhook. | WH (from the client ticket) |

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

On a slot booking the webhook opens the Ops workbook by id, finds the first row
matching date + time with `status = open`, sets it to `booked`, and writes the
`job_id` — which is what links a JOBS row to the AVAILABILITY row that satisfied
it. **`held` is never touched**; it is the operator's hold and only `open` is
eligible.

The read happens at write time, inside the script lock `doPost` already holds —
never from the customer's view, which the five-minute feed cache makes stale by
construction.

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
- **Nothing releases a slot.** If a booking is cancelled, its `AVAILABILITY` row
  stays `booked`. The `job_id` written back is the handle for undoing that, but
  no code does it yet.
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
