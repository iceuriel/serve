# SERVE — Build handoff

**Purpose:** hand the current state of the system to another person or another
assistant with no access to this repo. Self-contained on purpose.

**Companion doc:** `/docs/SCHEMA.md` — authoritative for every column's meaning
and who writes it. This file is the narrative; that file is the contract.

**Latest session: 2026-07-28.** Jump to
[what changed on 2026-07-28](#session-2026-07-28) for the current state. The
sections below it describe the 2026-07-27 build and remain accurate except where
that section supersedes them.

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

---

## 5. What to work on next

Roughly in priority order.

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
