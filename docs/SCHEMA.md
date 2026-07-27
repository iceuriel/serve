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
`WH` = webhook.gs writes it · `OPS` = the operator fills by hand · `FX` = formula · `MAN` = manual import (deed batches, Apollo)

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
| 18 | `duration_min` | **OPS** | Measured minutes. **Input to the frontier time standard — protect this data.** |
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
| 29 | `src_chain` | WH | Every tag seen in the session, comma-separated. |
| 30 | `customer_notes` | WH | **Customer free text only.** Never mixed with `notes`. |
| 31 | `pets_flag` | WH | `TRUE`/`FALSE`. Keyword-derived from `customer_notes`. Negation-blind — over-flags on purpose. |
| 32 | `scheduling_type` | WH | `slot` · `preference` · `label` · `none`. |
| 33 | `address` | WH | Street address snapshot. Real column, not `quote_meta` — ops sorts and filters on it. |
| 34 | `unit` | WH | Unit/apt. |
| 35 | `zip` | WH | ZIP. |
| 36 | `quote_meta` | WH | JSON blob: secondary quote data only (`original_price`, `discount_applied`, `steady_state_price`, the three recurring prices, `zip_tier`, `page_path`, `utm_*`, `unit_label`, `src`, `submitted_at`). |

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

**The script writes only:** `lead_id`, `name`, `email`, `phone`, `service_address`, `unit`, `zip`, `source`, `segment`, `source_history`, `first_touch`, `last_touch`.
**Everything else is yours** and is skipped silently.

**Write rules, in precedence order:**
1. `first_touch` — write once, at creation. Never modified, **not even blank-filled** on a later match. A row imported from a deed or Apollo batch first appeared on its import date, not on the day it happens to book. Enforced by `setLeadCell()`, which throws.
2. `last_touch` — always overwritten on a match. This is the single documented exception to the blank-cells-only rule.
3. `source_history` — append-only; a tag already present is not re-added.
4. Everything else — blank cells only; a populated value is never overwritten.

> Both timestamps are written as JS `Date` objects so Sheets stores real datetimes. An ISO string in a date column sorts lexically and breaks date math with no error. `reportLeadsSchema()` samples the existing cells and reports whether they hold `DATE`, `TEXT`, `number`, or `blank`; the upsert also logs a warning if it finds text where a date belongs.

> **How to resolve a TO DEFINE:** scroll the column. If it has values, those values are the definition — write them down here. If it's empty, it has never been used — define it now or delete the column. Do not let a script write to a column whose meaning is unresolved.

---

## Other tabs

| Tab | Purpose | Written by |
|---|---|---|
| `PROPERTIES` | One row per address. The durable asset — customers are transient, properties aren't. Keyed on `property_key`. | MAN (webhook does **not** write here yet) |
| `RAW_INTAKE` | Deed + Apollo staging buffer. Columns: `file_date · intake_date · batch · raw_source · name · email_corp · email_personal · phone · address · unit · zip · linkdin · company · title · sale_price · deed_type · promoted · promoted_lead_id · raw_notes`. Rows get promoted into LEADS. | MAN |
| `OUTREACH_LOG` | Sends, opens, replies per lead. | MAN |
| `DASHBOARD` | Channel spend → cost-per-booked-job. Spend entered by hand. | FX + OPS |
| `EVENTS` | Non-reservation site events (quote viewed, waitlist, custom quote). Auto-created by the webhook. | WH |

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
| Deployed version | `2026-07-27 SCHEMA.md r4` | `2026-07-27 avail r2` |
| Health check | open the `/exec` URL — `doGet` returns the stamp | the `/exec` URL *is* the feed |
| Editor dry-run | `reportLeadsSchema()`, then `testPayload()` | `testAvailability()` |

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

- **A booked slot is never marked taken — double-booking is possible today.** The
  booking flow reads `AVAILABILITY` but nothing writes back to it. `status` is the
  only source of truth for whether a slot is free, so after every reservation
  somebody must set that row to `booked` by hand. Until then the same slot stays
  bookable by the next visitor. Every slot currently published is one cleaner
  deep, so a single booking exhausts it and the second customer is a genuine
  conflict, not a queue. Highest-value next build: have the webhook flip the row,
  which needs it to reach the Ops spreadsheet as well as Leads MASTER —
  `SpreadsheetApp.openById` on the Ops ID, plus that ID added to config.
- `linkdin` in RAW_INTAKE is a typo for `linkedin`. Header matching is by exact text — fix it and the mapping together, or not at all.
- Nothing writes to `PROPERTIES` yet. `property_key` is generated on every booking but no property record is created. Next build.
- `ltv` has no formula yet.
- Part of the original build spec was lost to a truncated paste — the `src` /
  "skins" / "redirects" sub-items of Task 1. `src` was covered by the attribution
  work; the other two were never recovered and never built.
- **`segment` vocabulary conflict — UNRESOLVED, see below.** The header is now live in both JOBS and LEADS, so every booking writes to it. Until the prefix table is confirmed, that column receives values outside `movein · pro · direct`.

### The `segment` conflict (open)

This file defines `segment` as `movein · pro · direct`, derived from the src prefix.

`script.js` (`SRC_SEGMENTS`, ~line 226) currently derives a finer-grained channel
taxonomy instead: `qr_code · poster · flyer · door_hanger · social · nextdoor ·
referral · google_business · email · other · direct`.

Both are internally consistent; they answer different questions. The channel
taxonomy says *what medium* the tag came from. `movein · pro · direct` looks like
it says *which acquisition pipeline* the lead belongs to — plausibly deed/mover
data vs. Apollo B2B contacts vs. untagged, mirroring the two halves of
`RAW_INTAKE`.

No data is lost either way: `source` holds the full first-touch tag and
`src_chain` holds every tag, so `segment` can be recomputed retroactively for
every historical row once the mapping is settled.

**To resolve:** state which src prefixes map to `movein` and which to `pro`.
Then `SRC_SEGMENTS` becomes that two-entry table with `direct` as the default,
and this section is deleted.

**Until then:** the column will contain channel-taxonomy values from live
bookings. `testPayload()` deliberately sends a schema-valid `movein` so test
rows do not add to the mess.

---

## Changelog

| Date | Change |
|---|---|
| 2026-07-27 | JOBS extended 22 → 36 columns (attribution, contact snapshot, customer notes, pets, address, quote_meta). LEADS upsert added. EVENTS tab introduced. This file created. |
| 2026-07-27 | Reconciled `webhook.gs` against this file: protected-tab names normalized to underscores (the guard had been comparing against space-separated names and was silently inert for `RAW_INTAKE` and `OUTREACH_LOG`); LEADS upsert extended to `service_address` / `unit` / `zip`; `received_at` switched from UTC to America/New_York; `start_time` now carries the preference label on non-slot bookings instead of being left blank. |
| 2026-07-27 | Timezone pinning. `job_id`'s undated fallback and `prettyDate()` were using the Apps Script *project* timezone while `received_at` used `America/New_York`. All date formatting now pins `BUSINESS_TZ`, and `prettyDate()` is timezone-free entirely — a booked calendar date has no timezone, and deriving the weekday through a local `Date` could shift it by a day. **Correction:** an earlier version of this entry said a live `testPayload()` run had produced a `job_id` dated a day off its `received_at`. That was inferred from the `job_id` alone; the row's `received_at` was never checked and the two may well have agreed. The fix stands regardless — the webhook and availability scripts are separate Apps Script projects with independent timezone settings, and nothing guaranteed they matched. |
| 2026-07-27 | **Verified against the live workbook** via `reportLeadsSchema()`: six tabs confirmed with underscore names; JOBS at 36 columns in the documented order with `quote_meta` present; LEADS at **19** columns — the `segment` header has landed, so coverage is complete and nothing is skipped; `first_touch` / `last_touch` confirmed to hold real `DATE` values (number format is Automatic, which is cosmetic). Row matching resolves on `lead_id`. |
| 2026-07-27 | **Merged to `master` and live** (`487bb1f`). Verified after deploy: `servecleaning.com/script.js` byte-identical to the repo, both endpoint constants resolving to the current deployments, webhook reporting r4 and availability r2, `Access-Control-Allow-Origin: *` present, and the live 9-slot feed rendering through the site's own `filterSlots()`. Old deployments archived and confirmed 404. Added to this file in the same pass: the Endpoints registry, the EVENTS column list, the availability cache and `ok:false` behaviour, and the double-booking gap. |
| 2026-07-27 | LEADS `first_touch` and `last_touch` resolved from TO DEFINE to **record-activity timestamps written by the webhook** as real Sheets datetimes — not outreach dates. `first_touch` is immutable after creation (enforced, throws); `last_touch` bumps on every matched booking. `LEADS_FIELDS` now lists payload keys translated through `LEADS_HEADER_MAP` (`address` → `service_address`), mirroring how JOBS already worked. Live LEADS tab confirmed at 18 columns; `segment` still pending. |
