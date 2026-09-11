# SERVE — Build handoff

**Purpose:** hand the current state of the system to another person or another
assistant with no access to this repo. Self-contained on purpose.

**Companion doc:** `/docs/SCHEMA.md` — authoritative for every column's meaning
and who writes it. This file is the narrative; that file is the contract.

**Latest session: 2026-09-10.** Jump to
[what changed on 2026-09-08 / 09](#session-2026-09-08--09) for the current
state. The sections below it describe earlier builds and remain accurate
except where a later section supersedes them.

---

## Current work — 2026-09-10, Codex: room photos and shared updates

LIVE from commit `4cdb615`. Founder authorized private Cloudflare R2 room photos, shown in
customer and partner booking slips, plus automatic refresh of all shared portal
information. Sheets remains the record for booking/photo metadata. Preserve the
concurrent Stripe work in worker.js, portal.js, style.css and its tests.
Implementation is complete locally, including photo handlers, shared browser
helpers, ticket/portal integration, schema documentation and focused tests.
All 26 test files pass; four deliberate in-memory security/refresh mutations
were caught. Browser fixture proved a customer upload and written room note
appear on the open partner ticket automatically. Source and photos were synthetic;
no production booking was created or edited.

Founder activated the R2 subscription themselves in the dashboard. Codex created
`serve-booking-photos` in Serve Account: Standard class, automatic Eastern North
America placement, Public Access Disabled verified. Existing Apps Script source
was backed up and matched HEAD r20 exactly. r21 was saved, read back to verify
the source, and deployed to the EXISTING endpoint; live health reports r21.
Matching PHOTO_BRIDGE_SECRET was saved in Script Properties and as an encrypted
Cloudflare runtime secret. The isolated photo/site release was committed and
pushed; existing Workers Builds published it. Production health reports
`can_price`, `can_sign`, and `can_store_photos` true. All ten changed public
assets/pages were compared with the tested release and matched exactly. A live
invalid-credential image READ returned not_found with no-store/private headers.
Dashboard confirms BOOKING_PHOTOS binds the private serve-booking-photos bucket.
All 26 tests passed against the isolated release and the build staged 70 public
files with no private files. No production booking or image was written for tests.

Live upload/camera/delete behavior has not been exercised on a real booking;
the synthetic browser and in-memory integration checks cover those paths.
Automatic approval review rejected a live cleanup probe because cleanup can
alter production photo records; it was not run or bypassed. Read-only production
checks were used instead. Daily cleanup is configured by the deployed Worker.
The temporary local setup server was stopped and its secret file removed.
Concurrent Stripe, continuity-file, and logo changes remain uncommitted in Code.

## Session 2026-09-10 — signed quotes, step 1 of Stripe (Claude Code)

**Status: LIVE on Cloudflare from commit `527d3cf` (2026-09-10).** No Apps Script
change was made or needed; webhook.gs remains r19.

**Deployment, and exactly what was verified in production.** `QUOTE_SECRET` and
a Stripe TEST key (`sk_test_`) were set as Cloudflare secrets by the founder.
Note that setting a secret redeploys the Worker with THE CODE FROM THE LAST GIT
PUSH — for a while both secrets were bound while `/api/quote` still 404'd,
because the code was uncommitted. A secret set, a script deployed, and a site
pushed are three separate events and none implies another.

`git push origin master` ran the existing Workers Builds pipeline; it completed
in about 45 seconds. Verified live afterwards: `/api/health` returns
`can_sign: true` beside `can_price: true`; `POST /api/quote` for a 2BR/2BA
02116 first clean returns `ok:true`, **$239**, version `2026-08-24`, a
signature matching `q1.<unix expiry>.<64 hex>`, and a 120-minute expiry. The
same inputs through the local engine give **$239** — so the engine survived
bundling, which is the specific check the 2026-09-02 outage exists to remind us
to run.

**NOT verified in production:** no live booking has been made through the signed
path, and the tamper rejection has not been exercised against the live endpoint.
Both were proved locally against the real Worker and real engine. Live
tamper-testing was deliberately not run unilaterally: a guard failure would
write a junk row into the production sheet, which is the founder's call to
authorise, not an agent's.

**Objective.** Make the quoted price something the server ISSUES rather than
something the browser claims, so that a figure which has spent ten minutes in a
customer's tab can be proved to have come from us before anything charges a card
against it. This is the precondition for Stripe, not an optimisation.

**Why it was still needed after the 2026-09-02 verifier.** `verifyPrice` audits
the browser's arithmetic and fails open on purpose — the long comment above it
explains why, and it is right. Measured this session by driving the real
`/api/submit` handler with the real engine: a 2BR/2BA 02116 first clean prices
at $239, and **four tampered payloads relayed a $1 booking**. The cheapest is to
send a `pricing_version` nobody has ever deployed, which converts "refuse" into
"honour". `tests/worker-proxy.test.js` asserted that behaviour deliberately.
Every one of those is fine on a lead form and none is fine once that number
selects an amount of money.

**Changed.**

- `src/worker.js` — new `POST /api/quote`: runs the same engine and returns the
  price with an HMAC over (inputs, price, engine version, expiry), format
  `q1.<unix expiry>.<64 hex>`. `verifyPrice` is now async, takes `env`, and
  checks a returned signature BEFORE the CAN_PRICE gate — verifying our own
  signature needs no engine, so the strong path survives the one failure that
  has actually happened in production. Health reports `can_sign`.
- `script.js` — `signQuote()` posts the nine priced fields at reserve and
  attaches `quote_sig` **only when the server agrees with the number on screen**.
  Disagreement means a deploy landed mid-session: the customer pays what they
  were shown and the booking simply goes through unsigned.
- `tests/worker-proxy.test.js` — existing cases made async and re-asserted as
  the UNSIGNED path, plus a new signed-quote block.
- `wrangler.jsonc` — documents `QUOTE_SECRET` and why it is NOT `TICKET_SECRET`.

**The design in one line: lenient about booking, strict about money.** An
unsigned payload still books on exactly today's terms, because a guard that eats
bookings is worse than the thing it guards. The gate goes downstream instead —
a job whose price was never signature-verified must not be chargeable without a
human. `authenticated: true` is the only flag anything may treat as licence to
charge, and nothing on the unsigned path can produce it.

**Verification, and what it does not cover.** All 24 test files pass. Seven
deliberate mutations were each confirmed to fail a specific assertion before the
new tests were trusted — including a signature check that always passes, an
ignored expiry, and the site quietly dropping a field it signs against. The
end-to-end probe was re-run against the finished Worker: **every bypass is
refused on the signed path, and the unsigned floor is exactly where it was**
(old tabs still book). All of this is local — sandboxed `worker.fetch`, real
engine, stubbed upstream. Nothing was deployed and no live booking was made.
Production was only read: `/api/health` returned `can_price: true`,
`pricing_version 2026-08-24`.

**Founder decision this session:** money is **authorized at booking and captured
when the partner accepts** — so the Stripe primitive is a PaymentIntent with
manual capture, not a static Payment Link. This follows the 2026-09-09 fact that
partners still accept each job: Serve should not hold money for work nobody has
agreed to do. Auth holds lapse after roughly seven days, so acceptance has to
happen inside that window — an operating constraint, not yet a built one.

### A HOLE WAS SHIPPED AND CLOSED THE SAME DAY. Read before touching quoteScope.

`quoteScope` encoded the condition as `Number(d.condition)`. **The engine takes
LABELS there** — `standard`, `heavy` — which it looks up in `PRICING.CONDITION`,
so that expression was `NaN` on every real booking. Every condition therefore
signed to the same scope string, and a signature bought for a standard clean
verified against a heavy one at the standard price. Because the signed path
short-circuits the audit, this was **strictly weaker than r19 for that one
case**: the old audit would have recomputed the heavy price, seen the mismatch
under the same engine version, and refused.

Live in commits `527d3cf`/`5f08a6e` for roughly twenty minutes. No booking was
made through it. Caught by the scope string printing `NaN` in ordinary test
output, not by an assertion — which is why there is now one assertion per
priced input that the scope actually distinguishes two values of it, plus a
behavioural test that a standard-clean signature is refused on a heavy clean.

**Closed by `2d3f228` and verified live.** Two production `/api/quote` calls for
the same 02116 home returned **$239** at `standard` and **$308** at `heavy` — a
$69 gap — with different scope strings and, decisively, **different
signatures**. Checked read-only: no booking was submitted and nothing was
written to the sheet. The live tamper path itself is still unexercised in
production for the reason given above.

The rule: **bind what is sent, and never coerce a priced input to a type it
does not have.** A coercion that silently collapses two different homes to one
string is indistinguishable from a working signature.

**Written this session but NOT YET DEPLOYED — webhook.gs r20 and its site half.**

- `apps-script/webhook.gs` → **r20**, awaiting a manual paste. Adds `quote_sig`,
  `quote_scope` and `quote_version` to `QUOTE_META_KEYS`. Writes no new column
  and changes no behaviour; a booking without a signature stores blanks.
- `src/worker.js` — `/api/quote` now echoes `quote_scope`, and `verifyPrice`
  refuses a booking whose echoed scope does not match the one it derives, so
  what reaches the sheet is provably the string that was verified.
- `script.js` — carries all three fields into the booking payload.
- `docs/SCHEMA.md` — documents the three keys and why scope is stored rather
  than rebuilt.

**On the ordering rule.** The standing rule is to deploy the script before
pushing the site, and it exists because the reverse once cost a day of broken
tickets. It does not bite here, and the reason is worth stating: the site does
not depend on r20. Under r19 the three new keys are simply dropped, because
`quote_meta` is a whitelist. So the site half is safe in either order — the only
consequence of pushing it first is that the fields are not stored yet.

### Payment links — `/api/checkout`, Stripe, TEST MODE ONLY

`POST /api/checkout` returns a Stripe Checkout URL for one booking. That URL is
the payment link: the customer opens it from their own page, Stripe takes the
card, and Serve never sees a card number.

**The one rule the endpoint exists to enforce: the caller does not say what to
charge.** It sends a job id and the credential proving the job is theirs;
there is no field on the request that can carry a price. The amount is read out
of the booking row through the SAME token-checked lookup the customer's own page
performs, so ownership is proved by Apps Script rather than assumed. Signing
quotes would have been pointless if the endpoint that picks an amount accepted
one over the wire.

**Two ways in, because the customer has two surfaces.** The portal sends
`contact_id` + portal token; a job's client ticket sends just the job token and
is read through `?job=…&view=client`. **A partner token opens neither** — the
upstream refuses it and the `view` check refuses it again. A cleaner must never
be able to raise a charge on a customer.

**Authorize, not charge.** `capture_method: manual` places a hold. Money is
collected when the partner accepts. Idempotency key is `serve-<job>-<cents>`, so
a double-click cannot make two holds and a repriced booking is legitimately a
new session.

**Refusals, none of which reach Stripe:** a job not on this credential, an
already-paid or completed booking, no price on file, and a price above a
$2,500 tripwire. The tripwire is a guard against a corrupted cell, **not a
price rule** — if a real booking ever hits it, look at the row.

**The portal token is never sent to Stripe.** The return URL carries no
credential; each page stashes its own in `sessionStorage` before leaving and
restores it on the way back, and the return address is built server-side (a
caller-supplied one would be an open redirect wearing Stripe's domain).

`/api/health` now reports `can_charge` and `stripe_mode`, and **`stripe_mode`
says `LIVE` in capitals on purpose** — a live key reaching production unnoticed
is the one mistake here a redeploy cannot undo.

**Copy changed on both customer surfaces.** "Due at service" stopped being true
the moment a card is authorized at booking; a test now fails if that phrase
returns to either page's rendered text. **The replacement wording is mine, not
the founder's, and is still open for a decision** — see the open items below.

**NOT built yet:** nothing captures the hold, and nothing writes payment state
back. `payment_status` is still OPS-owned and untouched by the script, so the
`paid` flag both pages read is still whatever an operator typed. A Stripe
webhook and the capture action are the next pieces.

**Remaining, in order.**

1. Paste r20 into Leads MASTER → Extensions → Apps Script, then push the site
   half. Confirm the version endpoint reports `2026-09-10 r20`.
2. A real booking through the live site, watching the Worker log stream for
   `price authenticated: <submission_id>`. Nothing else proves the browser half
   works: a `signQuote()` that fails silently books unsigned and looks normal.
   Then confirm `quote_sig` / `quote_scope` / `quote_version` land in the row.
3. `/api/checkout` in test mode — takes `job_id` plus the portal token, reads
   the amount from the JOBS row, re-verifies the stored signature against the
   stored scope, and refuses any job that fails. Never accepts an amount from
   the caller. Stripe Checkout Session, `capture_method: manual`, idempotency
   key on the job id. `STRIPE_SECRET_KEY` (test) is already bound.
4. Portal Pay button. **The portal, not the ticket** — `/j` is the cleaner's
   surface and the confirmation email sends `/h`. Three places currently state
   in comments that no Stripe integration exists and must change together:
   `portal.js` (the `paid`/`Due` line), `ticket.js`, `webhook.gs`.
5. `payment_status` is OPS-owned and "never touched by the script" (SCHEMA #20).
   A Stripe webhook needs somewhere to write. That is a schema decision.

**Open, needing the founder:** deposit versus full amount, refund and
cancellation terms, and what the customer is told about when the card is
charged. None of those is a coding decision and none is settled.

---

## Session 2026-09-09 — homepage and booking brainstorm (Codex)

**Status:** discussion only; no application edits or deployment for this request.
The founder confirmed that partners still need to accept each job; an available
slot is not advance acceptance. Existing automatic vendor assignment must not be
interpreted as the partner having agreed to fulfill the booking.

**Proposal, not implemented:** distinguish receipt of a request from confirmation
of an accepted job with an agreed arrival window. Keep arrival/access completion
separate. Any new response deadline requires an operating decision; current copy
mixes a confirmation email within 15 minutes and a window confirmed within hours.
Homepage directions are being explored around customer time saved, coordination,
and concrete trust evidence. No final copy or workflow change selected yet.

---

## Session 2026-09-09 — arrival and access completion flag (Codex)

**Status:** live on Cloudflare Workers from commit `ec29b20` (2026-09-09).
Codex changed
portal.js, the portal styles, focused access tests, and these documentation notes.

**Requested:** a red `Incomplete` / green `Complete` flag on the customer
portal's Arrival & access navigation item. The founder confirmed that Key,
Access code, and Other require the matching details to be saved as well.
Occupancy, entry, and parking are required; pets remain optional. Completeness
covers every home, and updates only after confirmed saves. No backend deployment
or schema migration is needed. Other existing working-tree changes are preserved.

**Verification:** all 24 test files pass. A deliberate in-memory mutation forcing
every account to Complete was caught by the new tests. Browser checks with
synthetic data passed for desktop/mobile layout, incomplete/complete states,
unsaved and failed details, successful saves, changing/clearing details, saved
code privacy, multiple homes, and tab switching during a pending save. No live
customer answers were changed. The same question cannot receive overlapping
writes when switching tabs, and saved answers persist in the local view model.

**Deployment verified:** the founder explicitly approved publication after the
initial automatic-review block and confirmed Cloudflare is the host. GitHub's
API verified `iceuriel/serve` is private; `git push origin master` triggered the
existing `Workers Builds: serve` pipeline, which completed successfully. Public
`/h`, `/portal.js`, and `/style.css` all returned HTTP 200 from Cloudflare and
matched the local tested files after line-ending normalization. No customer
credentials or answers were used for production verification. No Apps Script
change, deployment, or sheet migration was needed. Existing open portal pages
need a refresh to load the new frontend. No remaining feature work.

---

## Session 2026-09-09 — independent review (Codex)

**Status:** read-only application review requested by the founder. Findings and
proposals only; no fixes, deploys, sheet changes, or live submissions performed.
Do not interpret these proposals as approved product or pricing decisions.

**Evidence checked:** current source, existing tests, and private context. Latest
observed commit `fbcbe06`. Live homepage retrieval failed, so this is a review of
the local site source, not a visual or production audit.

- `src/worker.js` / `verifyPrice`: a browser-supplied noncurrent or missing
  pricing version bypasses mismatch rejection. A local isolated run of the real
  verifier with the real generated engine derived $195: a $1 claim was rejected
  with the current version, but passed as version drift with an invented version.
  No network request or charge was made. Existing tests explicitly allow old and
  missing versions. Before automated payment, authenticate the quoted price and
  inputs with a server-issued quote record or signature; degraded intake may
  remain available without treating an unverified price as chargeable.
- `webhook.gs` can return `status: ok` with `slot_action: conflict` or `failed`;
  `script.js` displays the scheduled state without checking that slot result.
  Distinguish request saved, capacity secured, and partner acceptance. Persist
  exceptions and notification failures so recovery does not rely only on email.
- `doPost` catches a 20-second lock timeout and continues writing without the
  lock; the Worker gives the upstream 12 seconds. Contention/retry behavior needs
  review. No concurrent production failure was reproduced. Do not preserve lead
  intake by bypassing the protection used for deduplication and slot assignment.
- Customer/vendor portal credentials have no per-record revocation version;
  partner job tickets expire on completion but do not check cancellation or
  reassignment. Consider targeted link rotation and access revocation.

**Next action:** founder considers priorities. Private strategic and positioning
ideas are recorded in shared private memory as unapproved proposals. Application
tests were not broadly rerun for this review; the isolated verifier check above
is the only newly executed behavior check.

---

## Session 2026-09-09 — shared agent continuity (Codex)

**Status:** documentation and memory setup completed locally; no application
changes, commit, push, sheet edit, or deployment performed in this session.

**Working agreement:** Codex and Claude Code both cover the full project. The
founder switches between them for usage availability. Both must read the shared
records on entry and update them as work progresses and before handing off.

**Changed:** matching continuity instructions in AGENTS.md and CLAUDE.md; shared
private memory at `../.agent-memory/MEMORY.md` outside the website repository;
a pointer in Claude's existing private memory index. Private business context
stays outside tracked files and outside the public asset allow-list.

**Context correction:** the older landing-page-only introduction and "no clients
yet" guidance are historical, not a reliable current-stage summary. The latest
system state below and the shared private memory take precedence. The memory
also preserves business decisions previously available only to Claude.

**Existing work:** `src/engine.generated.mjs` was already modified on entry
(eight added lines at inspection). Its owner and purpose were not established;
it was left untouched. The latest observed commit was `6c46f9e` (02117 coverage).
At the final check, additional edits had appeared in `index.html`, `script.js`,
`style.css`, `tests/pricing-and-services.test.js`, and `tests/static-checks.test.js`.
Codex did not make or validate those edits. Treat them as concurrent work and
recheck the working tree before continuing.

**Verification:** documentation diff, matching continuity sections, memory
pointers, and private/public file placement checked. Application tests not run
for this documentation-only change. Production and live sheet state unverified.

**Next action:** take the founder's next request, re-read current changes and
handoff, and continue the full Serve remit. No new product build was requested.
The engineering open items under the September 8/9 entry remain recorded
findings, not newly verified live defects.

---

## Session 2026-09-08 / 09

**webhook.gs went r12 → r19.** This session built the entire portal and
partner layer: two new customer-facing surfaces, a vendor-facing one, a
supply-side data model in the Ops workbook, and automatic dispatch. None of
it existed before this session and none of it was in this document.

`/docs/SCHEMA.md` is authoritative for every column. This is the narrative.

### What now exists

| Surface | URL | Who opens it | Lifetime |
|---|---|---|---|
| Customer portal | `/h?id=CON-…&t=…` | the customer | permanent |
| Per-job ticket | `/j?id=SRV-…&t=…&view=client\|partner` | the cleaner | dies when `completed_date` is filled |
| Vendor portal | `/v?id=VEN-…&t=…` | the partner company | permanent |

**Four token audiences under one `TICKET_SECRET`**, each an HMAC of a
different scope string: `jobId|client`, `jobId|partner`, `contactId|portal`,
`vendorId|vendor`. **None opens another.** In r11 a single `ticketToken(jobId)`
opened both job views, so a cleaner's link showed the customer's price. Any
new surface gets a fifth scope, never a reused one.

### The revisions, and why each exists

**r13 — a domain layer.** `getBooking`, `getBookingAccess`, `getAssignment`,
`getVendor`, plus view models that are **whitelists built up field by field,
never filtered down**. Naming each field means a column added to a sheet next
month cannot reach a browser by accident; it has to be added on purpose. This
is the single most important rule in the vendor code.

**r14 — the customer portal.** Keyed on `contact_id`, the PERSON, not the
property: a portal tied to one home cannot serve someone with several, and
`contact_id` is the seam a real login attaches to later. Added the
`PROPERTY_ACCESS` tab (auto-created) and required `contact_id` on `LEADS`.

> **r14 also redirected the booking confirmation to the PORTAL link.** Whenever
> a customer has a `contact_id` — and they all do now — the email sends `/h`,
> not `/j`. **The portal is the customer-facing surface. The per-job ticket is
> the cleaner's.** Forgetting this caused the r18 bug below.

**Door and entry codes are write-only.** `entry_code` is typed once and never
rendered back; the portal shows "Code saved · Replace". No view model returns
it, nothing logs it, and tests assert both.

**r15 — the vendor portal and the supply model.** Three tabs in the **Ops**
workbook, created by hand: `VENDORS`, `VENDOR_SERVICES`, `OPERATORS`. Ops
rather than Leads MASTER so customer support can be given Leads without ever
seeing payout terms. Assignment is two columns on `JOBS` — `vendor_id` and
`operator_id` — not a fourth tab, since JOBS is already one row per booking.

A vendor **may describe themselves, not promote themselves**: `VENDOR_EDITABLE`
is `display_name`, `public_description`, `service_area`, `capabilities`, and
nothing else. Rating, review count, `insurance_verified`, `client_visible`,
`status`, `partner_since` and `logo_url` are Serve's. A denylist would fail
open into exactly the wrong place.

**`client_visible` is the master switch.** FALSE means the customer ticket says
"your service professional will be confirmed" rather than showing a half-filled
company. `status` does NOT gate the portal — only the token and the row
existing do — so a **prospect** can be given a working portal to look at
before they have agreed to anything.

**r16 — availability decides dispatch.** The `AVAILABILITY` row a booking
consumes already knew whose capacity it was; it now becomes the assignment and
is stamped onto `JOBS.vendor_id`, into a blank cell only. The column is read as
`vendor_id` OR `cleaner_id` so the sheet rename was not a flag day.

> **TWO GATES, and the second surprises people.** `bookAvailabilitySlot`
> returns immediately unless `sched.shape === "slot"`. A **preference** booking
> — "earlier in the day" / "later in the day" — consumes no availability row,
> so it gets **no vendor**, no matter what is in the sheet. That is by design
> and it stays manual. It is also why an empty availability feed cascades: no
> slots → customers see the radios → every booking is a preference → nothing
> self-assigns.

**Absence of data is not refusal.** A vendor with no `VENDOR_SERVICES` rows
ranks as ordinary, not disqualified, which is what makes an empty tab a no-op.
A vendor who declared services and left this one out is skipped when somebody
else is open and merely **flagged** when nobody is — the booking is never
refused, because a conflict shown for a slot the feed just published is our
data problem charged to the customer.

**r17 — portal links minted on demand.** A booking was never required: a token
is a pure HMAC of the id. What was missing was a caller, since the Apps Script
Run button cannot pass arguments. `printVendorLinks()` and
`printCustomerLinks()` are run from the editor. Two functions, not one — the
customer list prints a working credential for every customer on the sheet.

**r18 — the portal says who is coming.** `buildPortalModel` was written in r14,
before `VENDORS` existed, and never gained a partner field. Since r14 is also
what pointed the confirmation email at the portal, **the one page every
customer opens was the one page that could not say who was cleaning their
home**. Upcoming bookings only: a finished booking is a receipt.

**r19 — the partner's link in every booking email**, beside the cleaner's,
with the three lifetimes named. Unassigned says so and names the fix.

### Three bugs worth remembering

**The block shipped to a page nobody opens.** The "coordinating with our vendor
network" state and the partner card were written into `ticket.js` — correct,
tested, and on `/j`, which customers stopped receiving in r14. The fix was
`partner-card.js`, loaded by **both** `j.html` and `h.html`, plus a test
asserting all four of: ticket.js calls it, portal.js calls it, both pages load
it, and the build publishes it. Any one missing is the bug.

**A logo that rendered perfectly and invisibly.** `images/serve-wordmark.svg`
is `#ffffff` — drawn for the dark hero. Both surfaces that show a vendor logo
are light. `images/serve-wordmark-dark.svg` (`#1a2744`) exists for them. **Any
partner logo must read on a light background**, and nothing can detect a
white-on-transparent PNG automatically: it loads fine and shows nothing.

**A test that passed against nothing.** Customer-link privacy assertions were
written into `vendor-portal.test.js`, whose harness has no `LEADS` tab, so they
passed against the string `"No LEADS tab."`. Moved to `portal.test.js`. Related:
`portal.test.js`'s `t()` is `t(label, condition, extra)` — passing a **value**
as the second argument makes any non-empty string pass.

### Sheet work done this session

Ops workbook: `VENDORS`, `VENDOR_SERVICES`, `OPERATORS` created and seeded with
`VEN-0001` (Serve itself), three service rows, and two operators.
`AVAILABILITY.cleaner_id` renamed to `vendor_id` and its `C-01`/`C-02` values
swapped for `VEN-0001`. `CLEANERS` deleted.

Leads MASTER: `LEADS.contact_id` added and backfilled `CON-0001`…`CON-0006`.
`JOBS` gained `partner_payout`, `vendor_id` and `operator_id`; the `cleaner`
column was removed after its values were migrated.

> **Order matters, and the reverse order is silent.** A missing column reads as
> blank everywhere in `webhook.gs` (`f()` returns `""` for `indexOf === -1`), so
> deleting `cleaner` before filling `vendor_id` would have flipped every job to
> "pending" with nothing reporting a fault.

### Still open

- **`VENDOR_SERVICES.preference` reads `preffered` on all three rows.** The code
  matches `preferred` exactly, so they silently rank as neutral. Harmless with
  one vendor; wrong the moment there are two.
- **`OPS_DASHBOARD` → "Active cleaners" is `#REF!`** — it pointed at the deleted
  `CLEANERS` tab. The per-cleaner block below it still keys on `C-01`…`C-05`
  while `AVAILABILITY` now holds `VEN-` ids, so it measures nothing.
- One `AVAILABILITY` row still reads `C-01` (already booked, so the picker
  never sees it).
- **`logo_url` is unvalidated.** An operator typo or a pasted external URL would
  make customers' browsers fetch from a third-party host. A guard rejecting
  anything not under `/images/` was offered and not yet built.
- `RENTCAST_KEY` is still bound on the Worker though the property lookup was
  removed — the subscription can be cancelled and the secret deleted.
- Operators have blank `public_display_name`, so the vendor portal's team list
  renders empty rows. Nothing customer-facing reads it.

---

## Session 2026-09-02

### The pricing engine moved, and the server now verifies prices

`script.js` lines 28–475 became **`pricing-engine.js`**, loaded by a `<script>`
tag on index/pricing/services exactly like `serve-geo-data.js`. The Worker
imports it and **re-derives the price of every booking**, treating the browser's
`quote_price` as a claim to verify rather than a fact.

The reason: `quote_price` was computed on the customer's machine and taken on
trust. Harmless while nothing charges money; a live vulnerability the moment
anything does — edit one number in devtools and the system would issue a real
payment link for a dollar. **This is the precondition for Stripe, not an
optimisation.**

Equivalence was proved, not assumed: 86,400 configurations priced before and
after the move and compared by hash. Identical.

`PRICING_VERSION` is stamped on every quote, and it is what makes rejection
safe. Two prices can disagree for two reasons needing opposite responses:

| | same version | different version |
|---|---|---|
| prices differ | edited payload → **refuse** | deploy landed mid-session → **honour** |

Without the stamp, the first repricing would turn every already-open tab into a
false tamper alert. Bump it whenever any number in the engine changes.

### THIS CAUSED A LIVE OUTAGE. Read before touching the Worker's imports.

The first deploy rejected **every booking from all 49 geo-mapped ZIPs** —
most of the core service area — for roughly an hour.

`serve-geo-data.js` and `pricing-engine.js` are classic `<script>` files, so
they cannot carry `export` syntax and publish through
`if (typeof module !== "undefined") module.exports = …` instead. **Wrangler
bundles `.js` as ESM, where there is no `module` object at all**, so that line
never ran, the files exported nothing, and the Worker's import was `undefined`.
`serveGeo()` caught the resulting error and returned its neutral fallback, so
every mapped ZIP priced as unmapped — 02116 came out $360 against the browser's
$373 — and the verifier rejected real customers while looking healthy.

Three fixes were tried and **all three failed identically**: a named import, a
default import, and a `rules` entry declaring the files `CommonJS`. Each needed
a deploy to disprove, because nothing local reproduces a bundler.

**What works, and what must not be undone:** `scripts/build-engine-module.js`
concatenates the two files verbatim and appends a real `export {…}`, producing
`src/engine.generated.mjs`. An unambiguous ES module cannot half-resolve. One
source of truth survives — nothing is retyped, the build regenerates it, and
`tests/worker-proxy.test.js` regenerates it in memory and fails on drift.

**Never import `pricing-engine.js` or `serve-geo-data.js` into the Worker.**
Import the generated module. If another shared file needs to reach the Worker,
add it to the generator.

### Two rules that came out of the outage

**A guard on the booking path must fail OPEN.** The original design note claimed
it never failed on its own bugs; it failed *closed*, which is worse than not
having it. `CAN_PRICE` now probes a known-mapped ZIP at startup and verification
is skipped entirely unless the Worker can reproduce the browser's arithmetic.
That gate is why the next two attempts were safe to ship — each either worked or
left verification quietly off, never refusing customers again.

**A deploy is not verified until production is probed.** Static assets going
live is not evidence the Worker code did; they ship together, but "the new files
are there" was exactly the inference that let the outage run. Send a real
request and read the real answer.

### The test suite was the actual defect

`tests/worker-proxy.test.js` concatenated both dependencies into the Worker's
own scope and deleted its import lines, with a comment claiming that is what
wrangler does. It is not — concatenation manufactures **globals**, which a
bundle does not have, so an import resolving to `undefined` could not fail.
Sixteen green test files stood behind a live outage.

It now loads the same single generated module the Worker does, rewriting only
the closing export line so Node's `vm` can evaluate it, so every line of engine
code under test is the shipped one.

Two smaller traps found the same day, both worth remembering:

- An assertion that only checks *for failure* will accept the **wrong** failure.
  An orphan-id test passed on `TypeError: console.warn is not a function` —
  four console stubs were missing `warn`.
- When concatenated files each end by *assigning* `module.exports`, the last one
  silently wins. Load order is load-bearing.

### Also shipped

- **`job_notes` (webhook r10)** — the reserve step's "anything we should know?"
  textarea moved to the confirmation screen, where hesitation is free. It
  updates an existing JOBS row, so it is the one write path that deliberately
  skips `alreadyWritten()`. **Repo is r10; production is still r9** until it is
  pasted in.
- **Attribution moved to `localStorage`, 30-day fixed window**, so a card
  scanned on Tuesday still credits a booking on Thursday. `privacy.html` was
  updated in the same commit — it promised session-only storage, and that page
  is on the A2P surface carriers re-fetch.
- **Canonical URLs** on all five pages, and `/favicon.ico` at the site root
  (Google was showing a generic globe because the root path 404'd).
- **`/q` and `/friend`** moved out of the Cloudflare dashboard into `_redirects`,
  where the test suite can see them. A dashboard rule is how `/q` shipped
  pointing at an untagged URL.

### Still open

- **The availability feed is empty.** `/api/slots` returns zero slots, so every
  visitor reaching step 3 gets the earlier/later radios instead of the day
  picker, with no LIVE badge. It degrades silently by design, which is why
  nothing surfaced it. **This is affecting real bookings now.**
- **~10 test rows in JOBS** from probing the outage, all prefixed `test-`, plus
  matching `@example.com` rows in LEADS. `cleanupTestRows()` clears them.
- **webhook r10 is not deployed.**
- **DASHBOARD `#VALUE!`** across four blocks, from dropping `LEADS.status`.
- `serve.serve-account.workers.dev` serves the whole site publicly. The canonical
  tags point at the apex so Google is handled, but `"workers_dev": false` would
  close it properly.

---

## Session 2026-08-28

### webhook.gs r9 — deployed 2026-08-29

`/exec` confirmed reporting `2026-08-28 r9`. The repo copy and the deployed copy
agree. To re-check at any time, open the `/exec` URL in a browser: `doGet`
returns the version stamp, and anything older than the repo means what is
deployed is stale. Saving the editor does not redeploy.

r9 contains three things, and was revised twice before it was deployed:

- **Stable ids.** PROPERTIES gains `property_id` (`PROP-nnnn`), LEADS gains
  `contact_id` (`CON-nnnn`), and both are written onto the JOBS row, so history
  joins on an id rather than on a string built from typed input. Property
  matching now compares **normalised fields** (zip, address, unit) instead of
  the `property_key` string — that string comparison is what let one apartment
  become three records via `unit 0006` / `6` / `0006`.
- **`toE164` emits bare digits, no leading `+`.** A leading `+` makes Sheets
  parse the cell as `=+1617…` — a formula that evaluates to the right number,
  leaving the column holding a mix of data and formula cells. The `+` is
  re-attached on read, wherever E.164 is actually required (Twilio's `To`/`From`
  is the only consumer that will need it, and none of that code exists yet).
- **The reservation email reports levels**, on its own `Levels:` line in the
  SERVICE block and in the subject line. **Always** — "1 floor" included.
  The first attempt suppressed the single-storey case as noise, copying
  `unitLabel()` on the site. That was wrong here, and the difference is who is
  reading. On the site the customer already knows their own home, so the line
  is redundant. In an ops email the reader is checking what the customer
  entered, and a blank is indistinguishable from a field that never arrived —
  so suppressing it removed exactly the confirmation the line exists to give.
  A payload with no `levels` key now says `NOT REPORTED` out loud rather than
  rendering blank. Covered by SCENARIO 5 in `tests/webhook-routing.test.js`,
  which asserts the one-floor case explicitly and that the line is never
  missing from any booking email.

### Sheet reorganisation — the tab map changed

`PROPERTY_MEMORY` is new: one row per property, holding what the crew learns
(access method, parking, pets, priority rooms, product notes). It is in
`PROTECTED_TABS`; the webhook only ever creates a **blank** row for a new
property, never overwrites a populated cell.

Two moves were made for privacy, and both are load-bearing:

- **`access_secret` (door codes) lives in a separate `Access MASTER` file**,
  owner-only. Never in Leads MASTER, never handed to an agent or a VA. Data the
  model never receives cannot leak from it.
- **`RAW_INTAKE` and `OUTREACH_LOG` moved to a separate `Prospecting MASTER`.**
  Roughly 130 real people with phones, LinkedIn profiles, sale prices and
  personal notes should not sit in a workbook an assistant reads.

### Still open

- **DASHBOARD is throwing `#VALUE!`** across the source/conversion, apollo,
  variant and CAC blocks. Cause: `LEADS.status` was deleted on my
  recommendation and the formulas still reference it. My miss, not yet repaired.
- **`EVENTS` is empty but must not be deleted.** Three live paths write to it —
  `waitlist_zip` (`script.js:1039`), `quote_emailed` (`script.js:1205`),
  `custom_quote_request` (`script.js:1558`). All three are people who did *not*
  book, which is the one thing JOBS can never tell you. `waitlist_zip` in
  particular is the expansion data: it records every out-of-area ZIP anyone
  actually tried.
- **A `CONTACTS` tab exists and is genuinely dead** — no reference anywhere in
  `webhook.gs`, `availability.gs`, `script.js` or `SCHEMA.md`. LEADS is the
  contacts table; it carries `contact_id` and `phone_e164`. Safe to delete.
- **Dhruv's `phone_e164` cell** may still hold the old `=+1617…` formula. Clear
  it and retype the digits.
- **Dhruv asked for bed cover changes**, which is outside First Clean scope
  (linen change is `0` on deep in `SERVE_SCOPE`). Needs resolving before 09-01,
  and is the first real `PROPERTY_MEMORY` entry.

---

## Session 2026-08-24

**Prices are now derived from a work model instead of being set directly.**
This is the first time any price on the site has had a stated reason.

### The architecture inverted

`PRICING.DEEP_MULT`, `MOVEOUT_MULT` and all three `FREQ` values used to be
numbers somebody chose. They are now **computed**:

```
hours = size base x WORK_MODEL[service] / WORK_RATE
price = hours x TARGET_WAGE / (1 - MARGIN[service])
```

`WORK_MODEL` is a claim about reality a stopwatch can refute. `MARGIN` is a
business decision. Fusing them into one "price multiplier" is what let recurring
drift to $33/cleaner-hour while move-out sat at $56 with nobody choosing it.

**Edit `WORK_MODEL` when you measure a job. Edit `MARGIN` when you make a pricing
decision. Never edit the multipliers they produce.**

The derived values, for reference: DEEP_MULT 1.297 (was 1.40), MOVEOUT_MULT
1.510 (was 1.80), FREQ 0.364 / 0.546 / 0.978 (was 0.39 / 0.43 / 0.50).

### What the model is built on

`TARGET_WAGE = 35` — a floor for what a contractor earns per cleaner-hour, set
by Uriel. `WORK_RATE = 56.4` — size-base dollars of work per cleaner-hour,
solved from one measured 7h deep clean on a 2BR/1BA. **Every hours figure in the
system is anchored on that single job.**

Margin ladder, thinnest on weekly by deliberate choice: **weekly 25%, biweekly
33%, monthly 41%**, one-time services 33%. Weekly is thinnest because that cash
flow is the most predictable and the customer the most loyal — the commitment
discount comes out of margin rather than out of the contractor.

> **Weekly has a hard floor near 15% margin.** Weekly jobs are small, so the flat
> per-job cost — supplies plus card fee, about $19 — is a large share of them.
> Below roughly 22% a weekly visit stops being worth running. That floor is a
> property of the cost structure, not a preference.

### Levels became their own line item · 2026-08-25

**A storey is no longer part of the size base.** It is a flat per-service charge
added after the multipliers, alongside parking and the extended-area fee:

| service | extra hours | labour at $35 | charged | Serve keeps |
|---|---|---|---|---|
| Weekly | 1h | $35 | **$47** | $12 |
| Biweekly | 2h | $70 | **$94** | $24 |
| Monthly | 3h | $105 | **$140** | $35 |
| First Clean | 4h | $140 | **$187** | $47 |
| Move In/Out | 5h | $175 | **$234** | $59 |

`LEVEL_HOURS` per storey, `LEVEL_MARGIN` 25% — deliberately under every
service's own margin, so a townhouse quote stays competitive. Only the biweekly
2h is measured; the rest is Uriel's ladder, and it lands within half an hour of
what the old scaling model implied, so this is mostly a change of **margin**.

**Three things a storey no longer interacts with**, all of which it did before:
the **size base** (so it is the same $94 on a studio as on a 4BR, where it used
to be +88% against +40%), **condition**, and the **neighbourhood factor**. A
heavy Waterfront townhouse used to pay ~60% more for the same flight of stairs
than a light Brighton one. Stairs are stairs.

> **SUPERSEDED the same day.** This paragraph originally said the level charge
> sits outside the 50% discount, like the add-ons. That is no longer true — see
> *"50% off" now actually means 50% off* below. Holding it outside was what made
> the advertised percentage false. A second storey on a first clean is now
> +$93 as shown (half of the +$187 on the undiscounted ticket). Every other
> service came down: weekly −$23, biweekly −$10, monthly −$47, move-out −$54.

**A storey may not add more than half the visit it is attached to** —
`LEVEL_CAP = 0.50`, per storey. The hour ladder was set with a three-bedroom in
mind and overshoots on very small homes: a two-storey studio deep clean reached
**9.4 cleaner-hours**, the same as a single-storey 3BR/2BA with two bathrooms
and three bedrooms. The cap pulls that to 8.4h and leaves everything from
2BR/2BA upward untouched.

It is measured against the service's price **before** the first-clean discount.
Capping against the discounted price would bind on every home rather than the
small ones — the discount halves the job but not the stairs, so the level charge
is inherently large next to it.

Where it binds today: Studio and 1BR on every service, 2BR/1BA on everything
except weekly. Everything 2BR/2BA and up pays the full ladder.

**The hours model is now in two places.** `WORK_MODEL` gives hours proportional
to the size base; `LEVEL_HOURS` gives absolute hours for storeys. Both convert
to dollars through the same `TARGET_WAGE`, so a change to the wage floor still
moves everything together — but a re-measurement now touches two constants, and
they can disagree. If a timed multi-storey job ever contradicts `LEVEL_HOURS`,
fix that constant and leave `WORK_MODEL` alone.

### PER_LEVEL $50 → $191 · superseded 2026-08-25, see above

The best measurement in the system: a 3BR/2BA biweekly went **4h to 6h** when it
gained a storey. Same home, same service, one variable changed. `PER_LEVEL` had
been charging 13% for something worth 50%.

**Unresolved:** whether a storey scales with the service or is a fixed cost. Both
fit the one observation and they disagree by 3.5h on a deep clean. Timing one
multi-storey deep clean settles it.

### The small-unit multipliers are gone

`DEEP_MULT_SMALL` and `MOVEOUT_MULT_SMALL` discounted studios and 1BRs a second
time — the size base already charges a studio $216 against a 3BR/2BA's $381.
Nothing measured supported the extra cut. `smallUnit` is still reported by
`computeQuote` for any caller that wants it, but it no longer changes a price.

### "50% off" now actually means 50% off · 2026-08-25

Uriel tested live quotes and found the discount was not halving the real ticket.
It wasn't: add-ons and the travel fee had always sat outside it, and the level
charge had just joined them. At the edges it was badly misleading —

> a two-storey home with both add-ons in the extended area was labelled
> **"50% off"** on a **20%** discount.

The struck-through price is now the **whole** ticket — clean, add-ons, storeys,
travel fee, parking — and the shown price is computed **from** it, so the two are
exactly half of each other as displayed rather than merely close after two
independent roundings. Verified across eleven configurations, including every
edge that used to diverge.

**Cost of the fix:** the flat lines get halved too, so the subsidy deepens where
they apply. A plain 3BR/2BA first clean is unchanged at −$83; with two storeys
it goes to −$130, and an extended-ZIP job to −$71 (you now absorb half the
travel fee). If that becomes uncomfortable, **the honest lever is the discount
percentage, not carving lines back out** — carving is exactly what produced a
20% "50% off".

Four tests were repointed onto the **undiscounted anchor**, where a flat fee
sits at full value. The suite now pins that the shown price is exactly
`ceil(anchor × FIRST_CLEAN_FACTOR)`.

### The first-clean discount stays at 50%, knowingly

At a $35 floor, **every first clean sells below contractor cost** — $62 on a
2BR/1BA, $83 on a 3BR/2BA. Uriel reviewed this on 2026-08-24 and chose to keep
it as customer-acquisition spend. Recovery is about two biweekly visits, so
roughly one month of a plan.

**This is a decision, not an oversight. Do not "fix" it.** The number to watch is
conversion: a first clean that does not become a plan is a pure loss. The
deepest discount that would still cover the contractor is 33%.

### What moved on the public pages

`/pricing` and `/services` render from `computeQuote`, so they moved too.
Roughly: **recurring +27%**, **move in/out −16%**, **first clean −7%** on 2BR and
up, **+8%** on the two smallest sizes (the small-unit removal).

### The published ranges are single-level, and now they say so

Raising `PER_LEVEL` to $191 broke the published-range promise without touching
the rendering code. `/pricing` publishes **$223–$322** for a 3BR/2BA first clean;
a **two-storey** one at standard condition quotes **$371** — outside the band a
visitor was just shown.

Convention #10 makes published prices render from `computeQuote` so they cannot
drift. That guard does not catch this: the number was computed correctly, it
just answered a different question than the visitor was asking. All three
surfaces now disclose that the ranges are for single-level homes and that a
two-storey runs about half again. `tests/pricing-and-services.test.js` §1b pins
the disclosure **and** asserts numerically that a two-storey really does exceed
the band, so the wording cannot be dropped as redundant later.

**The general lesson:** a published range has two ways to go wrong. It can
disagree with the calculator — which the shared-render rule prevents — or it can
be silently conditional on an input the table does not vary. Adding any new
pricing input re-opens the second one.

### Test harnesses re-anchored

Three test files sliced the engine starting at `const PRICING = {`. The work
model now sits above that, so they slice from **`const WORK_RATE =`** instead.
If that declaration moves, update `geo-pricing`, `pricing-and-services` and
`service-area` together.

### Still open

- **Weekly and monthly work multipliers are unmeasured.** 0.44 and 0.93 come
  from the frequency curve — a fixed part plus accumulation growing with days
  elapsed, anchored on the measured biweekly at a 50% fixed share. One timed
  weekly and one timed monthly visit replace the two biggest guesses in the
  ladder.
- **A 3BR/2BA deep clean is the highest-value single measurement.** There is a
  move-in and a biweekly on that exact spec and no deep clean to anchor them
  against.
- **The bed:bath ratio is untested.** 2:1 is convention. Two deep cleans at
  different sizes would test it; there is one.
- **Travel erodes the $35 floor.** At ~7.5 jobs a week and 30 minutes between
  them, a contractor on paper-$35 clears about **$31.45**. Either pay for travel
  or cluster jobs by neighbourhood — which is what the per-ZIP data is for.
- **Roster, not demand, is the binding constraint.** A 10-customer book is ~133
  cleaner-hours a month, but a 9.5h deep clean and an 11h move-out cannot be
  done by one person in a day. You need a second contractor available about two
  days a month for a book that only keeps one busy.

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
- All of it degrades quietly if `localStorage` is unavailable (private mode).

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
| Version | `2026-08-28 r9` deployed — **repo is at r10, NOT deployed** | `2026-07-27 avail r2` |
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

**Reviewed and deliberately deferred on 2026-08-24.** Uriel looked at all three
options and chose to change nothing, on the grounds that the waitlist already
captures the person's email into `EVENTS` — so this is a booking downgraded to a
lead, not a lead lost — and that the decision is better made with numbers than
with a guess. Both this and the service-area expansion below stay parked.

**The measurement already exists, which is why waiting is cheap.** Every
rejection writes a `waitlist_zip` row to the `EVENTS` tab carrying the ZIP the
visitor actually typed. Once real traffic runs, filter that tab and the answer
falls out:

- **Mostly dead ZIPs** (02216, 02201, and the ~40 other Boston PO Box / firm
  codes) → it is a typo problem. Take option 2, the "check that ZIP" prompt.
- **Mostly real towns** (Quincy 02169, Milton 02186, Belmont 02478, Waltham
  02451–3, Dedham 02026, Needham 02492/4) → it is a demand signal telling you
  where to expand next, and it comes with the customer's email attached.

That is a genuinely better input than either of us guessing today, and it costs
nothing to collect because the plumbing is already there.

### Service-area expansion · also deferred 2026-08-24

The close-in ring — Quincy, Milton, Belmont, Waltham, Dedham, Needham — is real
territory with thousands of homes, and adding ZIPs is a two-minute edit: the
engine prices an unmapped ZIP at the neutral factor without throwing, so nothing
breaks. **It was deferred because it is a roster question, not a code one.**
Quoting a job you cannot staff is a worse failure than the waitlist, and there
are no cleaners committed to those towns yet.

If it is picked up later, those towns would price at the neutral factor until
their MassGIS parcel files are pulled — the same four-file exercise that produced
the Boston, Cambridge, Somerville, Brookline and Newton factors.

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
