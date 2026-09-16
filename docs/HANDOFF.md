# SERVE — Build handoff

**Purpose:** hand the current state of the system to another person or another
assistant with no access to this repo. Self-contained on purpose.

**Companion doc:** `/docs/SCHEMA.md` — authoritative for every column's meaning
and who writes it. This file is the narrative; that file is the contract.

**Latest session: 2026-09-15.** Jump to
[what changed on 2026-09-08 / 09](#session-2026-09-08--09) for the current
state. The sections below it describe earlier builds and remain accurate
except where a later section supersedes them.

---

## Current work — 2026-09-16, Claude Code: two bugs the tests could not have caught

**LIVE.** Apps Script **r51**, Worker/site at **`4b381dc`**. The payment
write-back now works end to end on the test key: the founder resent a failed
`checkout.session.completed` and got **200**. Everything below was found by the
founder testing the real path, not by the suite — worth reading before trusting
a green run on this subsystem again.

**STILL ON `sk_test_`.** The live key swap has not been done.

### What broke, in the order it was found

**1. The capture did nothing.** The founder authorized, saw the portal say
authorized, captured in the Stripe dashboard — and nothing changed. Then the
notice vanished on reload and the booking read unauthorized again.

**The "authorized" they saw was the `?pay=done` RETURN BANNER, not the sheet.**
That banner is driven by a URL parameter and appears whether or not anything
was ever written; it disappears on any reload without the param. The Payment
*line* underneath had said "Not yet authorized" the whole time. Anyone
debugging this subsystem should read the line and the sheet, never the banner.

**The cause: METADATA DOES NOT PROPAGATE FROM A CHECKOUT SESSION TO THE
PAYMENTINTENT IT CREATES.** Separate objects, separate metadata bags, Stripe
copies nothing. `/api/checkout` set only `metadata[job_id]`, which lives on the
session, so of five subscribed events exactly ONE could find its booking:

| Event | Object | Job id |
|---|---|---|
| `checkout.session.completed` | session | ✅ |
| `payment_intent.amount_capturable_updated` | PaymentIntent | ❌ |
| **`payment_intent.succeeded`** — *the capture* | PaymentIntent | ❌ |
| `payment_intent.canceled` | PaymentIntent | ❌ |
| `charge.refunded` | inherits from the PI | ❌ |

Fixed by also setting `payment_intent_data[metadata][job_id]`. **Both are
needed; setting one does not set the other.**

**WHY THE SUITE MISSED IT, AND THIS IS THE REAL LESSON.** The tests hand-built
PaymentIntent events *carrying* metadata and asserted the handler reads it.
That proved the handler right about a message Stripe was never going to send.
Every fixture was written from the same misunderstanding as the code, so the
suite could only ever confirm it. **A suite is no more honest than its
fixtures, and a mutation test does not help — it mutates the code, not the
assumption both sides share.** The new section 2b drives `/api/checkout`, reads
the metadata back out of the form actually sent to Stripe, and builds the
webhook events from *that* — the two halves asserted against each other rather
than separately. Deleting the fix turns 5 assertions red and prints the
production symptom verbatim: `{"ok":true,"ignored":"no_job_id"}`.

**2. The authorization never reached the sheet either.** Stripe's Event
deliveries showed `500 ERR` on both `checkout.session.completed` attempts. The
500 was correct behaviour — a failed write asks Stripe to retry — but nothing
said *why*, and the causes need opposite fixes.

Fixed in two steps. The Worker now puts the reason in the **response body**,
which **Stripe's Event deliveries tab displays per attempt** — turning the
founder's own dashboard into the diagnostic, with no Cloudflare log access, no
`wrangler login`, and no tail running at the right moment. Resending then
answered `{"error":"write_failed","reason":"not_found"}`, which narrowed it to
one line: `handlePaymentEvent` was refusing the Worker on the bridge secret.

**r51 then made that failure mode much less likely and much more legible:**
- **The bridge secret is TRIMMED on both sides.** Script Properties is a web
  form; a pasted secret very easily carries a trailing space or newline, Google
  stores it verbatim, and an exact comparison then fails forever against a
  Cloudflare secret that is character-for-character identical on screen.
  Internal whitespace is still a different secret and still refused.
- **A refusal logs which it was** — "not set" versus "mismatch", with LENGTHS
  only, never values or prefixes. What the caller is told is unchanged and
  still identical for both cases.

### What is proven, and what is NOT

**Proven in production:** `/api/health` reports `can_record_payments: true`;
an unsigned POST to `/api/stripe-webhook` is `400`; `/exec` answers r51; a
resent `checkout.session.completed` returns **200**.

**NOT proven, and it needs a FRESH BOOKING:** the capture path. The
PaymentIntents from every test before `7045796` have empty metadata bags, so
**resending those events can never work** no matter how often it is retried.
Only a booking made after the fix exercises
`payment_intent.succeeded` → `paid`. **Also unproven:** cancel → hold release,
and anything at all on a live key.

**A 200 is not by itself proof the cell changed** — `applied: false` (a stale
event, an unknown job) also answers 200. Read `payment_status` on the row.

### Two smaller things found along the way

- **A restricted Stripe key (`rk_…`) was reported as LIVE in test mode.**
  `stripe_mode` matched only `sk_test_`. Both key kinds carry the mode in the
  same place; `stripeMode()` now reads both, and anything unrecognised still
  reads LIVE rather than being assumed harmless.
- **A single `/exec` probe can lie.** Google intermittently answers with an
  HTML "Sorry, unable to open the file at this time" page. One probe returned
  that; the next two returned r51. Probe more than once before concluding a
  deployment is wrong.

---

## Earlier — 2026-09-15, Claude Code: payment state, and what a live key still needs

**LIVE AND VERIFIED (2026-09-16 03:57Z), pushed as `f57f2cc`.** Apps Script
**r50 was pasted by the founder BEFORE the push**, which is the required order
for a change spanning both — the reverse gives a Worker relaying
`payment_event` to a script that has never heard of it. Workers Builds
registered a check run on `f57f2cc` and succeeded at 03:57:19Z.

**STILL ON THE TEST KEY. `stripe_mode: "test"`.** The live key swap is the
founder's last step and has not been done. No real money has moved.

**What was verified against production after the deploy:**

| Check | Result |
|---|---|
| `/api/health` | `can_record_payments: true` beside `can_charge: true`, `stripe_mode: "test"` |
| `POST /api/stripe-webhook`, unsigned | **`400 bad_signature`** — the route exists and refuses an unsigned caller. It was `404` before this push. |
| `payment_event` with a deliberately WRONG bridge token | `{"ok":false,"error":"not_found"}` — r50's handler is live and the secret check fires. Nothing written. |
| `portal.js`, `ticket.js` on production | byte-identical to the repo (ignoring CR) |
| Apps Script `/exec` | `"version":"2026-09-15 r50"` |

**Cloudflare secrets `STRIPE_WEBHOOK_SECRET` and `PAYMENT_BRIDGE_SECRET` are
bound** (both visible in the health binding list). **Whether
`PAYMENT_BRIDGE_SECRET` MATCHES the Apps Script Script Property of the same
name is NOT verifiable from outside** — both are write-only. A mismatch shows
up as a test payment that authorizes fine while the portal never flips to
"Card authorized", with `payment write-back failed` in the Worker log and
`500`s in Stripe's Event deliveries tab. It is recoverable: fix the secret and
hit **Resend** on the event, because a failed write returns 500 specifically so
Stripe keeps retrying for three days.

**A PROCESS NOTE WORTH KEEPING.** This work sat finished-and-tested but
UNPUSHED while the founder configured Stripe against it, and set two Cloudflare
secrets in the meantime — which redeployed the Worker **with the code from the
last git push**, so the secrets were bound to a Worker that had no route to use
them. The founder found it by curling `/api/health` and seeing no
`can_record_payments`. Built, committed, and deployed are three separate
events; do not describe a verification step for code that is not pushed.

### The stale note this corrects

The previous entry and the r49 section both say **"r49 is still unpasted"**.
**That is wrong — r49 is live.** Probed today: the `/exec` endpoint answers
`{"ok":true,"service":"serve-booking-webhook","version":"2026-09-15 r50"}` once
this is pasted; before the paste it answered **r49**. Whoever wrote that
follow-up action completed it and did not clear the note.

### What the founder asked for, and what was actually in the way

The ask was "put a real Stripe connection in instead of the testing one". The
key swap is the smallest part of it. **Swapping the key today would have taken
real money and still shown every customer "Not yet authorized" forever**,
because nothing recorded that a hold had been placed — `payment_status` was
hand-typed, and `/api/checkout` wrote to no sheet at all. The Authorize button
stayed on screen after a successful payment, inviting a second hold on the same
card. That was an annoyance on a test key and a customer telling you their
money did not arrive on a live one.

So this closes gaps 1, 2 and 3 from "NEXT UP — payments" below, and answers
three of the founder decisions that were open there.

### Founder decisions taken 2026-09-15 (all three the recommended option)

| Question | Answer |
|---|---|
| Deposit or full amount | **Full quoted amount.** One hold, one capture, nothing to collect on the day. |
| Who captures | **The founder, by hand, in the Stripe dashboard**, when the partner accepts. Zero new code, no new money-moving endpoint to secure, and the webhook writes `paid` back within seconds of the click. |
| A customer cancels an authorized booking | **The hold is released automatically.** Leaving it for ~7 days reads, to the person whose balance is short, exactly like being charged for a cleaning they cancelled. |

Still open and still the founder's: **refund and cancellation terms**, and the
**partner response deadline** now that the seven-day authorization window is
real. Neither is a coding decision and neither blocks the key swap.

### What changed

**`webhook.gs` r50 (NOT PASTED).**
- **New action `payment_event` → `handlePaymentEvent`**, behind a new Script
  Property `PAYMENT_BRIDGE_SECRET`. Its own secret, not `PHOTO_BRIDGE_SECRET`.
- **`payment_status` is now script-written.** This changes a promise SCHEMA.md
  has made since it was created, and SCHEMA.md is updated in the same commit.
  It **stays in `OPS_OWNED_COLUMNS`** — that list guards `setJobCells`, so the
  booking form, portal writes, reschedule and cancel are all still refused.
  Exactly one function is exempt. A hand-typed `paid` still works and is never
  blanked by Stripe.
- **A third state.** `not authorized → authorized (held, no money moved) →
  paid`, plus `released` and `refunded`. Both customer view models gain
  `authorized` beside `paid`, and `paymentNote` replaces the hardcoded
  "Due at service".
- **New optional JOBS column `payment_ref`** (37) — the PaymentIntent. Absent,
  the state still writes and the omission is logged.
- **`cancelBooking` names an uncaptured hold** in its reply so the Worker can
  void it. A captured payment is named by nobody.

**`src/worker.js`.**
- **New route `POST /api/stripe-webhook`** — the only route authenticated by a
  signature rather than a ticket token. HMAC-SHA256 over `<t>.<raw body>`,
  constant-time compare, 5-minute tolerance, multiple `v1` digests accepted so
  a secret rotation does not take payments offline.
- **A failed write-back returns 500 on purpose.** Stripe retries a non-2xx with
  backoff for up to three days, which is a more durable queue than anything
  worth building here. A 200 would drop the payment state permanently and
  silently, and the customer would be the one to notice.
- **The idempotency key gained a 10-minute time bucket** (gap 2 below). Stripe
  caches the response *body* against a key for 24 hours, so reissuing a link
  for the same job and amount replayed the original, already-dead session —
  exactly the recovery an operator reaches for after a failed attempt.
- **`can_record_payments` on `/api/health`.** `can_charge: true` beside
  `can_record_payments: false` is the dangerous combination and is now one
  request away from being visible.
- **`afterPortalWrite`** releases the hold on a cancellation and **strips
  `payment_ref` before the browser sees it** — view models are whitelists.

**`portal.js` / `ticket.js`.** Three payment states on both surfaces. The
Authorize button disappears the moment Stripe confirms the hold.

### What was verified

- **`node tests/run-all.js` — all 33 files pass**, including the new
  `tests/stripe-payments.test.js`.
- **16 deliberate mutations, 16 killed, 0 survivors.** Removing the signature
  check, signing only the timestamp, dropping the replay tolerance, answering
  200 on a failed write, recording a hold as `paid`, leaking `payment_ref` to
  the browser, accepting a non-`pi_` ref, dropping the time bucket, trusting an
  unconfigured route, hardcoding `can_record_payments`, removing the rank
  guard, skipping the bridge secret, accepting an unknown state, naming a
  captured payment on cancellation, and blinding the surfaces to `authorized` —
  every one turns the suite red.
- **A REAL BUG WAS CAUGHT THIS WAY, not by reading.** The first rank guard
  rejected *every* downgrade, which would have meant a cancelled booking's hold
  release was never recorded. The rule is narrower than "newer must outrank
  older": **once money has actually moved, only news about money that has
  actually moved may overwrite it.** Below that line every transition is
  legitimate.
- **NOTHING IS VERIFIED IN PRODUCTION.** No paste, no push, no live payment, no
  real card. The four setup steps below have not been done.

### What the founder has to do — the walkthrough

Do these **in order**. Steps 1–3 are safe at any time; **step 5 is the one that
starts moving real money.**

1. **Activate the Stripe account.** Dashboard → Activate payments. Business
   details, bank account, tax info. Until this is done there is no live key.
2. **Add the JOBS column.** Leads MASTER → JOBS → a new header in column 37
   named exactly `payment_ref`. (Optional — without it the payment state still
   writes. Worth having for reconciling a row against Stripe.)
3. **Paste r50 and set the Script Property.** Extensions → Apps Script, paste
   `apps-script/webhook.gs`, Deploy → Manage deployments → edit the EXISTING
   deployment → New version. Then Project Settings → Script Properties → add
   `PAYMENT_BRIDGE_SECRET` = any long random string (`openssl rand -hex 32`).
   Verify: the `/exec` URL answers `"version":"2026-09-15 r50"`.
4. **Push the site**, and set the two new Cloudflare secrets —
   `PAYMENT_BRIDGE_SECRET` (**the same string as step 3**) and, after step 5,
   `STRIPE_WEBHOOK_SECRET`.
5. **Create the Stripe webhook endpoint.** Stripe → Developers → Webhooks → Add
   endpoint → `https://servecleaning.com/api/stripe-webhook`. Subscribe to
   exactly these five: `checkout.session.completed`,
   `payment_intent.amount_capturable_updated`, `payment_intent.succeeded`,
   `payment_intent.canceled`, `charge.refunded`. Copy the signing secret
   (`whsec_…`) into the Cloudflare secret `STRIPE_WEBHOOK_SECRET`.
6. **DONE — steps 1–5 are complete and deployed.** Test the whole path on the TEST key first, then swap
   `STRIPE_SECRET_KEY` to `sk_live_…` last. Confirm `/api/health` reports
   `stripe_mode: "LIVE"` **and** `can_record_payments: true` together.

**Setting a Cloudflare secret redeploys the Worker with the code from the LAST
GIT PUSH.** That has confused this project before: a secret set, a script
deployed, and a site pushed are three separate events and none implies another.

### The proof sequence, once it is wired

Book on the live site → open the portal link from the confirmation email → pay
with `4242 4242 4242 4242` → **confirm Stripe shows an UNCAPTURED payment
rather than a charge**, and that the portal now reads "Card authorized" with no
Authorize button. Then capture in the dashboard and confirm the portal flips to
"Paid". That last pair is what proves authorize-not-charge and the write-back
both took effect.

### Still not built

**Nothing watches the seven-day authorization window** (gap 4 below). A partner
has to accept inside it or the hold has to be retaken, and no deadline is set.
**The payment copy is still mine, not the founder's** (gap 5) — it is worded to
be accurate, not final; `paymentNote()` in webhook.gs and `authorizedNote()` in
portal.js are where it lives.

---

## Earlier — 2026-09-15, Claude Code: the portal that would not open twice

**LIVE AND VERIFIED (2026-09-15 23:25Z), pushed as `4411703`.** Workers Builds
registered a check run this time and succeeded at 23:25:19Z. `portal.js`,
`ticket.js` and `vendor.js` on production match the repo byte-for-byte
(ignoring CR), and `.tk-retry` is in the live stylesheet. **NO APPS SCRIPT
PASTE — `webhook.gs` is
untouched and stays at r49**, so there is no script-before-site ordering to
respect here. This is `src/worker.js`, `portal.js`, `ticket.js`, `vendor.js`,
`style.css` and two test files; it deploys by pushing. (This said r49 was
"still unpasted". **Corrected 2026-09-15: r49 IS pasted and live** — the
`/exec` endpoint was probed and answered `2026-09-15 r49`. Whoever completed
that action did not clear the note.)

### The complaint

The founder opened a test customer portal from the SMS, closed it, opened it
again, and was told **"We could not open that link. It may be mistyped, or it
may have been replaced"** — intermittently, on a link that was fine.

### What it actually was — two bugs stacked

**1. The link was never the problem.** `portal.js` printed that one sentence
for FOUR different outcomes:

| What happened | What the page said |
|---|---|
| The id/token genuinely open nothing (`not_found`) | correct |
| The Worker gave up on a slow Apps Script (502 `upstream_unreachable`) | **wrong** |
| The sheet read threw upstream (`lookup_failed`) | **wrong** |
| An answer that is not this page's view (an old deployment's health check) | **wrong** |

Three of the four are the round trip failing, not a verdict on the credential
— and a customer told their link is dead has no reason to try it again.
`ticket.js` and `vendor.js` had the identical flaw.

**2. The 8s budget sat in the middle of the normal range, which is what made
it feel random.** `/api/portal`, `/api/job` and `/api/vendor` GETs shared
`UPSTREAM_TIMEOUT_MS.slots` = 8000. A cold Apps Script container routinely
answers between 8s and 12s (the 5-minute warm ping makes that rarer, never
impossible), and a warm customer portal is ~39 Sheets calls on top of the
measured 1–2s floor. Sometimes under, sometimes over — hence "inconsistent".

Measured today against production, warm, with a bad token (reaches Apps Script,
reads no sheets): **1.36s, 1.41s, 1.53s, 1.55s, 2.04s.** That is the floor
*before* the 39 reads a real portal does.

**The 2026-09-13 note said visitor-facing timeouts were left alone on purpose,
because raising one "would not remove the wait, only move it into the
customer's browser".** That reasoning is right for `/api/slots` — a failed feed
degrades into the earlier/later radios and the booking still completes. It is
wrong for the three signed-link reads: nothing is on the page until that one
request returns, so giving up early does not save the customer a wait, it
converts the wait into a dead-credential message. The asymmetry is now written
into the constant's comment so it does not get "tidied up".

### What changed

- **`UPSTREAM_TIMEOUT_MS.page = 15000`**, used by the `/api/portal`,
  `/api/job` and `/api/vendor` GET relays and by the checkout's portal lookup.
  `slots` (8s) is unchanged and still used by the availability feed and the
  address type-ahead, both of which have somewhere to fall back to. 15s is
  under `ServeLive`'s own 20s abort, so the Worker's explanatory 502 still
  arrives before the browser gives up blind.
- **One retry, in all three page scripts.** A failed trip is retried once after
  800ms before anything is said. Not three: each attempt can cost the full 15s,
  and a third would leave somebody on a skeleton for 45s before any news. One
  covers the cold start and the blip, which is what these actually are.
- **`answered(d)` decides what a link is called.** Only an explicit `not_found`
  (or `expired`) gets the "mistyped, or replaced" sentence. Everything else
  gets "we could not load your account just now" — or "could not reach Serve,
  check your connection" when the fetch itself threw — plus a **Try again**
  button that reloads (the address bar already holds the credential).
- **`ticket.js` now requires a KNOWN view**, `client` or `partner`, not merely
  `ok:true`. An older deployment's health check answers `ok:true` and the
  ticket would have rendered it as an empty job. `portal.js` has guarded this
  since 2026-09-08; the ticket never did.
- This is the same judgement `ServeLive` already applied to the *refresh* (20s,
  backoff, closes the link only on an explicit `not_found`), finally applied to
  the *first* load — the one that matters most, because nothing is on screen
  behind it.

### What was verified

- **`node tests/run-all.js` — all 32 files pass.**
- **The new assertions were mutation-tested, and the failure output is
  literally the reported symptom.** Making `answered()` return true for every
  reply (the pre-fix behaviour) turns 7 checks red, printing
  `{"fetches":1,"state":"We could not open that link. It may be mistyped…"}`
  for a 502, an upstream error and a health-check answer. Removing the retry
  turns 6 red; removing the Try again button, 4. On the Worker side, putting
  `/api/portal` back on `.slots` fails `"/api/portal reads on the signed-link
  budget"`, and shortening `page` to 8000 fails two more.
- **THE BUG WAS CAUGHT IN THE ACT IN PRODUCTION, AFTER THE DEPLOY.** Probing
  `/api/portal` with a bad token (reaches Apps Script, reads no sheets):

  | | | |
  |---|---|---|
  | `502 15.10s upstream_unreachable` | `502 15.12s` | first after a quiet gap |
  | `200 1.54s not_found` | `200 1.71s`, `200 1.70s` | every one after |

  **The first request after a gap exceeds 15s; every one after it is ~1.5s.**
  That is the founder's symptom exactly: whichever open lands on a cold
  container fails, and nothing about the link differs between them.

### The measured distribution, and what it says about the two halves

**~30 samples of `/api/portal` with a bad token** (reaches Apps Script,
computes one HMAC, reads no sheets — so this is *pure round trip*, before the
~39 Sheets calls a real portal does):

| Band | Count | What the fix does with it |
|---|---|---|
| 1.3 – 3.1s | ~26 | nothing needed |
| 11.87s | 1 | **the raised budget saves it** — would have failed at 8s |
| > 15s | 3 | **the retry saves it** |

**Both halves earn their keep, and an earlier draft of this entry was wrong to
say otherwise.** It claimed "the raised budget is not what fixes this — the
retry is". The 11.87s sample is the counterexample: under the old 8s budget it
was the dead-link message, under 15s it is a page that loads a little slowly
and says nothing. The raise covers the 8–15s band; the retry covers past it.

**The retry was observed converting a failure into a load, twice.** Every
timeout in the samples was immediately followed by a fast success — `15.1s
timeout → 2.94s ok`, and `15.1s timeout → 1.54s ok`. That is exactly the
sequence a browser now performs on its own after 800ms.

**Do not raise `page` past 15s.** `ServeLive` aborts at 20s, and a single 20s
wait is worse for a customer than 15s plus a retry.

### It is not idleness — Apps Script runs SEVERAL containers

The decisive pair, seconds apart after the same quiet gap:

    probe1: 200   1.57s      <- a warm container
    probe2: 200  11.87s      <- a different, cold one

Fast *then* slow. A pure idle-eviction story predicts the opposite order. Each
request is routed to whichever container it gets, warm or cold, **which is why
this felt random rather than time-based**: closing the tab and reopening rolls
the dice again.

**This also settles what the `*/5 * * * *` warm ping can and cannot do.** It
keeps *a* container alive — probe1 is likely its work — but it cannot warm the
one the next request happens to land on. Cold starts get rarer, never
impossible. Warming was never going to fix this on its own, and the retry is
the right primary defence regardless of whether the cron is firing.

**Still unconfirmed (carried over from 2026-09-13):** whether the cron is
actually registered on the deployed Worker. Lower priority than it looked, for
the reason above. A clean test needs ~12 minutes of true silence then one
probe; two attempts at it were killed by local memory pressure before
producing anything, so the gap before the pair above was uncontrolled.

### Next action

**Open a real portal link, close it, wait several minutes, reopen** — the one
check the test harness cannot do. The wording now diagnoses itself: "could not
load your account just now" is a slow server, "may have been replaced" is a
genuinely bad link. Then settle the warm-ping question above.

---

## Earlier — 2026-09-15, Claude Code: load-time fixes 1–4 (r49 + site + Worker)

**SITE + WORKER LIVE AND VERIFIED (2026-09-15 ~14:15Z).** *(This section said
"r49 NOT YET PASTED". **r49 was pasted and is live** — probed 2026-09-15, the
`/exec` endpoint answered `2026-09-15 r49`. The "Next" line at the end of this
section is likewise complete.)*
`468baf8` reached GitHub at 14:00:11Z, but Workers Builds never registered a
build for it: no check run after 12 minutes, where the previous push had one
within 47s. Pushing the docs commit `ca64ca0` started a build within seconds,
and it succeeded at 14:13:14Z. **If a push doesn't show up, check
`gh api repos/iceuriel/serve/commits/<sha>/check-runs`; a follow-up push
re-triggers it.** Verified in production afterwards: `booking-photos.js`
matches the repo (ignoring CR). `/api/address` for a public building address
not cached before answered `source: provider` in 1.06s (one sample; the audit
measured 1.6–2.2s for misses), and the next request answered `source: cache`
in 0.13s, so the save after the response landed. `/api/photos` read with a
fake token answered `not_found`. `/exec` still answers `2026-09-14 r48`.
The founder said "do 1-4" from
the audit below (not 5, not the a/b/c trade-offs, which remain open). No
request or response shape changed, so the paste and the push are safe in
either order. Until r49 is pasted, fixes 1 and 4 are not live; 2 and 3 go live
with the push.

**Founder action:** paste `apps-script/webhook.gs` into Leads MASTER → Deploy →
Manage deployments → new version. Then `curl -sL <exec URL>` must answer
`"version":"2026-09-15 r49"`. Saving in the editor is not deploying.

**What changed.**
1. `apps-script/webhook.gs` r49, **photo reads skip the lock**. `doPost` sends
   `booking_photo` with `action === "read"` (strict: a non-string that only
   stringifies to "read" still takes the lock) straight to
   `handleBookingPhoto`, before the 20s script lock, in a shared-snapshot
   scope like a GET. `handleBookingPhoto` takes its 8s lock for every other
   action. A workbook that won't open answers `photo_unavailable` JSON.
   New helpers `isPhotoRead`, `leadsBook`; `routePost(e, parsed)` takes the
   already-parsed body.
2. `booking-photos.js`, **photos stay in page memory**, keyed by purpose and
   photo id. Capped at 30 MB (oldest dropped first), forgotten on delete,
   seeded from the bytes just uploaded, never put in browser storage. Two
   views of the same photo share one read, a failed read is retried, and at
   most 3 reads are out at once.
3. `src/worker.js` `/api/address`, **on a cache miss**: the IP and monthly
   counter gets now run in parallel. Both counter puts run in parallel but are
   still awaited before Geoapify, so a counter that can't be written stops the
   call (still fail-closed). The answer's cache put goes through
   `ctx.waitUntil`, or is awaited when there's no ctx, and a failed put is
   logged instead of throwing. One small behaviour change: a request refused
   by the monthly cap no longer increments the per-IP counter; nothing is
   billed on that path.
4. r49, **partner card cached 5 min**. `clientVendorCard` caches
   `buildClientVendorProfile`'s output (never the row; null is cached too)
   under `partner_card:<vendor_id>` in the script cache. It is used by the
   portal and the client ticket. Any `vendor_write` that passes the token
   check clears it afterwards. `forgetPartnerCards()` (run from the editor)
   clears every company. No CacheService, or a cache that throws, means
   everything is built fresh, as before.
   **Accepted trade-off:** a hand edit in Ops (including a `client_visible`
   flip to FALSE) can take up to 5 min to show. Also, if a
   VENDOR_REVIEWS/PHOTOS read fails during a rebuild, the card is cached
   without reviews or photos for up to 5 min.

**Checked.** `node tests/run-all.js`: all 32 pass (31 + new
`photo-cache.test.js`). New assertions: `read-budget` §8 (every photo read
kind: no lock, no writes, shared scope; refusals take no lock; delete, other
POSTs and an array action still lock; workbook failure answers JSON) and §9
(cache hit reads no vendor tab and doesn't open Ops; client ticket shares the
card; vendor save clears it; forged save doesn't; hand-edit trade-off;
`forgetPartnerCards`; a broken cache or no cache still works).
`address-suggest` A4 (counter gets in parallel, both puts before the
provider, put failure stops the provider, save via waitUntil, failed save
still answers). `photo-cache.test.js` A–G. **Deliberate breaks, each failed
its test and was restored byte for byte:** photo-read diversion removed; lock
always taken; a write added to the read path; card cache disabled; eviction
removed; the workbook-failure try removed; sequential gets; puts not awaited;
no waitUntil; save error not caught; no photo cache; no parallel limit; no
dedupe; no forget on delete; no upload seed; no eviction; failed read kept.
**Not checked:** `wrangler deploy --dry-run` (no local wrangler; imports are
unchanged), a real phone, a real signed link, and production timing
before/after.

**Next:** ~~founder pastes r49; verify `/exec`~~ — **DONE, r49 is live.** Then, optionally, re-measure a
photo-heavy portal. Fix 5 (self-host Inter) and the a/b/c trade-offs still
need the founder's decision.

## Current work — 2026-09-14 (evening), Claude Code: load-time audit — PAUSED, NOTHING BUILT

**INVESTIGATION ONLY. No code changed, no Apps Script paste, nothing pushed.**
Founder asked whether more can be done to speed up portals, booking and the
vendor page without adding vulnerabilities. Paused mid-audit when the founder
had to leave. The uncommitted AGENTS.md / CLAUDE.md edits are the 2026-09-09
continuity section, not this session's — left untouched.

**Measured in production** (fake tokens only, home connection, 2026-09-15 ~00:10Z):
- Static files ~0.1s each, brotli. Not the bottleneck.
- Apps Script floor: bare `/exec` health 0.9–1.6s (+~0.2s redirect echo).
  `/api/slots` 1.0–1.4s on EVERY call — the Worker's `max-age=60` only reaches
  browsers; nothing caches at the edge. Bad-token `/api/portal` 1.7–2.1s,
  `/api/vendor` 1.3–1.4s, `/api/job` 1.2–2.0s.
- `/api/address`: cache hit 0.11–0.16s; cache MISS 1.6–2.2s, once 4.2s.
- Warm cron: probably firing. The feed cache regenerated at 00:05:26Z and
  00:20:26Z (26s after 5-minute marks) with no other traffic. A confirming
  probe for ~00:30:26Z was scheduled; its result was not recorded.
- Harness counts (read-budget harness, 6-booking account): portal GET 21 calls,
  partner ticket 13, vendor 12, access save 13, booking 48 + Twilio + MailApp.

**Findings, ranked — proposed, not built:**
1. **Photo reads wait on the global script lock.** `routePost` takes
   `waitLock(20000)` for every POST and `handleBookingPhoto` `waitLock(8000)`,
   so every thumbnail site-wide loads one at a time and queues behind bookings
   and saves; a photo-heavy page can push a concurrent booking toward the
   Worker's 12s budget. Fix (r49): route `booking_photo` `action: read` before
   the lock, in a shared-snapshot scope. The read paths in
   `handleBookingPhoto` / `handleCompletionPhoto` write nothing (checked by
   reading). Paste needed; no API change, so either deploy order is safe.
2. **Photos re-download on every repaint** (tab switch, a live-refresh change,
   reload after plan confirm) — each an Apps Script round trip. Fix
   (`booking-photos.js`): in-memory blob cache per photo id (ids are
   immutable), bounded, evicted on delete, nothing persisted; cap parallel
   reads at ~3. Site only.
3. **Address type-ahead misses await KV sequentially**: 2 gets + 2 counter puts
   before Geoapify, 1 cache put after. Fix (`src/worker.js`): gets in parallel;
   the two counter puts in parallel but still awaited BEFORE the provider call
   (spend guard stays fail-closed); final cache put via `ctx.waitUntil`
   (thread `ctx` into `handleAddressSuggest`, await fallback for tests).
4. **The customer partner card opens the Ops workbook on every portal /
   client-ticket open** (VENDORS, VENDOR_REVIEWS, VENDOR_PHOTOS + Ops timezone).
   Fix (r49): cache the `buildClientVendorProfile` output in CacheService
   ≤5 min by vendor_id, removed on `vendor_write`; guard with typeof (harnesses
   have no CacheService). Trade-off: card edits / client_visible flips show up
   to 5 min late.
5. **Self-host Inter** on index / pricing / services: drops render-blocking
   Google Fonts CSS (~0.3–0.5s first paint on phones) and the unused
   Montserrat. Keep `@font-face` OUT of style.css — portals do not load Inter
   today and would change look. Leave privacy / sms-terms (A2P pages) alone.

Not worth it now: edge-caching `/api/slots` (already prefetched; low traffic
means few hits); resizing gallery JPEGs (lazy or inside a closed details).

**Need the founder's decision — trade-offs, not built:** (a) Apps Script-signed,
short-lived photo read grants verified by the Worker (removes an Apps Script
call per photo, but "the sheet authorizes every read" becomes "for N
minutes"); (b) painting a last-known portal snapshot instantly (browser storage
or an encrypted edge cache) — personal data at rest somewhere new; (c) sending
the booking SMS / email after confirmation via a Worker follow-up (~1–2s off
"Reserving…", but a failed follow-up loses the ops email and customer text
unless a sweep is added).

**Checked:** `node tests/run-all.js` 31/31 pass at the start (baseline only).
**Next action:** implement 1–4 (5 if the founder wants it) with tests and
deliberate breaks; paste r49 and verify the `/exec` version; then push.

## Current work — 2026-09-14, Claude Code: hero mark reads GREATER BOSTON

**PUSHED (`3df0c2c`) AND VERIFIED IN PRODUCTION (2026-09-14).** Production
`images/serve-logo-boston.svg` and `index.html` match the repo (ignoring CR).
Caveat: `_headers` gives `/images/*` `max-age=604800`, so a browser that
loaded the old mark in the last 7 days may keep showing BOSTON until its cache
expires; new visitors get the new mark. A `?v=` on the img src would force it
(the 7a test regex would need to allow it). Not checked: a real phone. Founder asked "GREATER" in
front of "BOSTON" under Serve / HOME CLEANING, on every hero variant (all three
use the one `images/serve-logo-boston.svg`).
- `images/serve-logo-boston.svg` — third line "GREATER BOSTON" at font-size
  16, letter-spacing 4.3 (was BOSTON at 19 / 4.5). Measured in Chrome with
  getBBox: at 19 / 4.5 it is 229 units, past the 200-unit viewBox; at 16 / 4.3
  it is 199.9, flush with HOME CLEANING (199.7). viewBox, baselines and colour
  unchanged; aria-label updated.
- `index.html` — hero logo alt "Serve Home Cleaning, Greater Boston".
- `tests/pricing-and-services.test.js` — 7a mark assertions follow the text.
- Not touched: the founder's untracked `images/serve-logo-boston-9-09.svg`
  (a separate draft: BOSTON at 14 / 5, viewBox height 265), which no page uses.
Checked: `node tests/run-all.js` all 31 pass; headless screenshots untagged at
1400px and `?src=poster` at 540px look right.

## Current work — 2026-09-14, Claude Code: new hero sub copy

**PUSHED (`e050f20`) AND VERIFIED IN PRODUCTION (2026-09-14).** Production
`index.html` matches the repo (ignoring CR). On servecleaning.com at 1280px,
untagged, `?src=poster` and `?src=deed` each show exactly one visible
`.hero__sub` reading the new two lines; no console errors. Not checked: a real
phone. Founder's copy replaces "Serve
manages, coordinates, and books your service through partnerships with local &
trusted Boston vendors." on every hero variant with two lines: "Coordination,
Booking & Management" / "Powered by Serve’s network of established & local
providers".
- `index.html` — both copies of `.hero__sub` (in `#hero-body-default` and
  `#hero-body-zip`), one `<p>` with a `<br>`; styling unchanged.
- Tests: pricing-and-services 7a asserts the new sub; segment-and-skins 2b's
  reading order keys on the new text in both blocks.
Checked: `node tests/run-all.js` all 31 pass; headless screenshots untagged
at 1400px and 540px and `?src=poster` at 1400px look right.

## Current work — 2026-09-14, Claude Code: "Made to Serve your needs" set like the lead

**PUSHED (`af1cbd8`) AND VERIFIED IN PRODUCTION (2026-09-14).** Production
`style.css` matches the repo (ignoring CR). Computed style on servecleaning.com
at 1280px with `?src=poster` and `?src=deed`: `.hero__tagline` is Times New
Roman, rgb(249, 250, 251), 18.4px. Not checked: a real phone. Founder asked the tagline to
match "Serve handles the rest…": Times New Roman and #f9fafb, size unchanged.
It now appears only in `#hero-body-zip` (move-in and pro); the untagged hero
has had no tagline since `2fe2bce`.
- `style.css` — `.hero__tagline`: Times, #f9fafb (1.15rem, margins and the
  bold white "your" unchanged).
- `tests/static-checks.test.js` — `.hero__tagline` added to `SERIF_ALLOWED`.
Checked: `node tests/run-all.js` all 31 pass; headless screenshot at 1400px
with `?src=poster` looks right.

## Current work — 2026-09-14, Claude Code: "Serve handles the rest…" set like the headline

**PUSHED (`08a790a`) AND VERIFIED IN PRODUCTION (2026-09-14).** Production
`style.css` matches the repo (ignoring CR). Computed style on
servecleaning.com at 1280px, untagged and `?src=poster`: `.hero__lead` is
Times New Roman, rgb(249, 250, 251), 18.4px, margin-top 9.6px (10px below the
note). Not checked: a real phone. Founder asked: the hero lead
line in the headline's face and colour (Times New Roman, #f9fafb) at its own
size (1.15rem, weight unchanged), and a little closer to "Instantly quote &
book in under 1 minute". One element serves the untagged, move-in and pro
heroes, so one rule covers all three.
- `style.css` — `.hero__lead`: Times, #f9fafb, top margin 1.1rem → 0.6rem.
- `tests/static-checks.test.js` — `.hero__lead` added to `SERIF_ALLOWED`.
Checked: `node tests/run-all.js` all 31 pass; headless screenshots at 1400px,
untagged and `?src=poster`, look right. Noticed, not changed: at 1400px the
pro headline in Times at 3rem wraps as "Get your weekends back with / Serve".

## Current work — 2026-09-14, Claude Code: the authored hero gets the ZIP check too

**PUSHED (`2fe2bce`) AND VERIFIED IN PRODUCTION (2026-09-14).** Production
`index.html`, `style.css` and `script.js` match the repo (ignoring CR). In
headless Chrome over CDP against servecleaning.com, untagged: the headline
reads "A Clean Home, / One Less Thing to Manage", no hero button, no visible
tagline, order headline → sub → ZIP check → note → "Serve handles the rest…".
Typing 02116 at 1280px showed "We serve 02116", filled Build's ZIP and scrolled
to Build; typing 99999 at 390px (mobile emulation) showed "We're not in 99999
yet." with the waitlist link and no scroll. No console errors. No Apps Script
change. Founder asked, for the
untagged hero: headline in Times New Roman with a comma ("A Clean Home, / One
Less Thing to Manage"); the ZIP check in place of the Instant Booking button;
"Made to Serve your needs" removed; "Serve handles the rest…" under "Instantly
quote & book in under 1 minute", styled as on the skins.
- `index.html` — the ZIP form, the under-a-minute note and "Serve handles the
  rest…" are now authored ONCE, shared by every hero. `#hero-body-default` now
  holds only the sub (above the ZIP check); `#hero-body-zip` holds the sub and
  tagline (below "Serve handles the rest…"). HERO_SKINS' swap is unchanged, so
  move-in and pro render exactly as before. The ZIP input lost its `name` and
  the form gained `action="#quote"`: now that the form is visible without JS,
  a no-JS submit jumps to Build instead of putting the ZIP in the URL.
- `style.css` — `.hero__headline` is Times at 2 / 2.4 / 3rem for every hero
  (the segment-only rule from earlier today is gone); `.hero-zip + .hero__note`
  replaces the zip-body-scoped note margin; the default sub gets 1.25rem below.
- `script.js` — comments only. The hero has no pulsing button any more; only
  the nav CTA pulses.
- Tests: `SERIF_ALLOWED` now lists `.hero__headline`; pulse count 2 → 1;
  headline string has the comma; segment-and-skins 2b rewritten for the shared
  form (authored once, outside both blocks; no Instant Booking in the hero; no
  input name; reading order; no tagline on the authored hero). Each new
  assertion was broken on purpose and failed, then passed when restored.
Checked: `node tests/run-all.js` all 31 pass; headless screenshots of the
untagged, `?src=deed` and `?src=poster` heroes at 1400px, and untagged at
540px, look right. Not checked: typing a ZIP in a real browser on the untagged
hero locally — since done in production, above. Not checked: a real phone.

## Current work — 2026-09-14, Claude Code: skin headlines in Times, ZIP placeholder

**PUSHED (`d3238e7`) AND VERIFIED IN PRODUCTION (2026-09-14).** Production
`style.css` matches the repo byte for byte (ignoring CR), production `/` serves
the "ZIP CODE" placeholder, and a headless screenshot of
`servecleaning.com/?src=poster` shows the Times headline. No Apps Script change. Founder asked: the move-in
("Moving in or out?") and pro ("Get your weekends back with Serve") hero
headlines in Times New Roman, and the hero ZIP placeholder as "ZIP CODE",
properly centred in the white field.
- `style.css` — `body[data-segment=movein|pro] .hero__headline` set in Times at
  2 / 2.4 / 3rem (the Inter sizes ÷ 0.875); the default headline stays Inter.
  `.hero-zip__input` gets `text-indent: 0.06em` to cancel the trailing
  letter-spacing that pulled the text left, plus an explicit line-height.
- `index.html` — placeholder "ZIP CODE".
- `tests/static-checks.test.js` — that selector added to `SERIF_ALLOWED`.
Checked: `node tests/run-all.js` all 31 pass; headless Chrome screenshots at
800px and 1400px with `?src=deed` and `?src=poster` look right. Not checked:
a real phone.

## Current work — 2026-09-14, Claude Code: r48, the cleaner ticket's rooms simplified (photos + notes)

**DEPLOYED IN ORDER AND VERIFIED IN PRODUCTION (2026-09-14).** The founder
pasted webhook.gs; `/exec` answered `2026-09-14 r48` before anything was
pushed. A `partner_note` with a fake token through production `/api/job`
returned `not_found` (r47 would have logged it as an event). Then `0f613ee`
was pushed; Workers Builds published it in about a minute. Production
`ticket.js`, `booking-photos.js`, `vendor.js`, `portal.js` and `style.css`
match the repo; `/j` and `/v` no longer link `completion-photos.css`, which now
404s; `/api/photos` with `purpose: completion` and a fake token answers
`not_found`. Not verified live: a real ticket, upload or note (no real signed
link was used), or a real phone. (Keep the order for any later change: pushing
before a paste would make uploads fail on r47 and drop a note, with its ticket
token, into EVENTS.)

**Why.** The founder did not like r47 (Codex, entry below, now superseded): too
much, and every Scope room expanded into a large panel. Asked for: rooms that
open/close like the customer's, one add-photos button (take or upload) with a
slight "Add photos when completed", and an optional note box for the
vendor/client/Serve.

**What changed.**
- `ticket.js` — Scope rooms are closed `<details class="tk-room">` (same as the
  customer's), flag "Has instructions · N photos" / "Add photos". Inside: "From
  the customer" (instruction + their photos, read-only), the photo control, and
  "Notes (optional)" saving `partner_note`. `saveInstruction` now takes a
  payload; the customer view's body is unchanged. Called-off visit: read-only.
- `booking-photos.js` — cleaner kind (`purpose: completion`): one **Add photos**
  button, `accept="image/*" multiple`, no `capture` (phone offers camera or
  library), several uploaded in turn, reminder beside it. r47's checkbox, title,
  timestamps and retention copy removed. Customer kind unchanged (two buttons,
  3 per room, Remove).
- `vendor.js` — r47's "Completion photo archive" section removed; each job row
  shows "From the job ticket": room, note, photos (read-only).
- `portal.js` — "Notes from your service partner" on upcoming and finished
  bookings (room label + text only). Cleaner photos are NOT shown to customers.
- `apps-script/webhook.gs` r48 — new `PARTNER_NOTES` tab + `handlePartnerNote`
  (partner token only; closed/cancelled refused; formula-looking text written
  as text). Own tab on purpose: `sortInstructions` would file an unknown scope
  as the customer's general note. `scope[].note`, vendor `bookings[].report`
  (replaces `completionHistory`), portal `bookings[].partnerNotes`.
  `COMPLETION_PHOTOS` drops room_label/service_label/scheduled_date and the
  finished requirement. `src/worker.js` stops forwarding `finished`.
- `completion-photos.css` deleted (links in j.html/v.html, build-site.sh);
  five small rules in style.css.
- Tests: `completion-photos.test.js` rewritten for r48 + notes (auth, whitelist,
  vendor stamp, in-place update, formula, blank, cancel/complete);
  new `cleaner-ticket-render.test.js` boots the real ticket.js,
  booking-photos.js and vendor.js; portal-render section M. SCHEMA updated.

**Checked.** 31/31 suites. 17 deliberate breaks, each failing its suite
(client token accepted, vendor id leaked to customer, vendor stamp ignored,
finished requirement restored, formula raw, rooms open, note saved as an
instruction, capture forced, single file, batch cut short, reminder dropped,
flag not updated, customer payload changed, vendor report or finished-booking
notes dropped, blank note creating the tab). Real headless Chrome against the
real Worker + real webhook.gs over in-memory Sheets/R2, 390px and 1280px: five
rooms closed (331px for the section), room opens to button + reminder + note;
two real JPEGs picked → compressed, two READY rows stamped with the vendor, two
`completion-photos/` objects, thumbnails drawn, flag "2 photos"; note saved to
PARTNER_NOTES; both back after reload; customer instruction untouched; vendor
portal shows note + 2 photos in the job, no archive; customer portal shows the
note and no cleaner photos; no page errors. Not checked: a real phone's
picker, live R2, live Sheets.

**Not done, on purpose.** No R2 bucket lock (r47's proposal; optional, and it
would stop Serve deleting a wrongly uploaded photo). Client `/j` ticket does not
show cleaner notes — the customer's page is the portal.

**Flag for the founder.** Notes reach the customer verbatim; a cleaner could
write a phone number there, which is the contact-around-Serve route the partner
surfaces otherwise avoid. Delivered as asked; say if customer visibility should
be narrowed.

**Next action.** None required. First real job: open its partner ticket on a
phone, add a photo and a note, and confirm both appear in that job on the
vendor portal and the note on the customer portal.

## Current work — 2026-09-14, Claude Code: professionals get the ZIP-check hero

**COMMITTED (`e1aefa3`), PUSHED, AND VERIFIED IN PRODUCTION.** Site only.

- `HERO_SKINS.pro` headline is now "Get your weekends back with Serve" (the
  "Come back Friday…" sentence is gone) and it names the same body as move-in.
  That block was renamed `#hero-body-movein` → `#hero-body-zip` (class
  `hero__body--zip`); the entries below still use the old id. Both skins share
  it on purpose, so the copy under the two headlines cannot drift apart. Every
  pro-prefixed tag gets it: dh-, poster-, qr- (including the founder card
  `/q`), flyer-, eddm-, email-/em-.
- Move-in alone preselects Move In / Move Out; pro stays on First Clean.
- `.hero__lead` top margin 2.25rem → 1.1rem (18px rendered under "Instantly
  quote & book…"), both skins.
- Checked: 30/30; four deliberate breaks (pro body dropped, old headline, pro
  pointed at the default body, ZIP body not hidden) each fail. Local Chrome at
  1280 and 390: pro ZIP 02116 → green check → Build with the ZIP filled,
  First Clean kept; no overflow at the top or at Build; no page errors.
  Production: the three files hash-match; in Chrome `/clean` shows the new
  headline with the ZIP body and first_clean, `/movein` shows move_out, `/`
  shows the default hero.
- Not verified: a real phone.

## Current work — 2026-09-14, Claude Code: one font on the front page; move-in starts on the move clean

**COMMITTED (`c35d6ba`, `27af1be`), PUSHED, AND VERIFIED IN PRODUCTION.** Site
only. Answers the preselect question left open in the entry below.

**The ask.** (1) Move-in visitors should find Move In / Move Out preselected.
(2) The front page should use one font — the one "Made to Serve your needs" is
in — everywhere.

**Worth knowing: that line was never the serif it was styled as.** It uses
`var(--flow-serif)`, but the token was defined only on `.quote-section`, so in
the hero it resolved to nothing and inherited the page's Inter. The font the
founder picked is Inter.

**What shipped.**
- `script.js` — `SEGMENT_DEFAULT_SERVICE = { movein: 'move_out' }`, applied by
  checking the radio and dispatching `change`, placed just above
  `readPrefillParams`. Placement is load-bearing both ways: earlier, the change
  handler's `syncAddonsToService()` reads the add-on consts before they exist
  (placed beside the radio listeners, Chrome throws "Cannot access 'addonFridge'
  before initialization" — checked); later, it would override a link's own
  `&service=`.
- `style.css` — Times New Roman removed from the hero headline, the booking
  flow (`--flow-serif` deleted, every use now `--flow-sans`), "After you book"
  (five rules) and the footer tagline. Kept: the `Serve` wordmark in nav and
  footer (matches the logo art), `.ticket__brand`, `.serve-page-head h1`
  (/pricing, /services). Inter runs ~14% wider, so `.hero__headline`
  (1.75 / 2.1 / 2.625rem) and `.flow-title` (1.75 / 2.2rem) are 0.875x their
  Times sizes — the lockup took a third line at 1280px otherwise.
- Tests — segment-and-skins 2d (the real block against fakes; both
  source-order guarantees); static-checks "Front page is set in one typeface"
  (an allow-list of serif rules; fails on `--flow-serif`).

**Checked.** 30/30. Nine deliberate breaks, each failing the intended assertion
(incl. both misplacements, no change event, all segments, Times back on the
headline, Georgia on After-you-book, the token restored). Rendered font
inventory of the front page: Times New Roman on 2 elements (the two wordmarks),
Inter on the rest, Arial only on the hamburger, a close "×" and hidden radios.
The headline measured 320–1440px: it fits or wraps at exactly the widths it did
in Times (it already took three lines at 1100, 1024, 900, 768 and ≤390px).
Local Chrome: movein → move_out; `&service=deep` → first_clean; clicking First
Clean still works; pro and direct → first_clean; Price and Reserve render;
/pricing footer tagline is Inter. Production after the build: the three files
hash-match; `/movein` in Chrome shows Inter at 42px, move_out checked, no page
errors; `/` shows first_clean.

**Not verified.** A real phone.

**Follow-up (`3fbb861`, live, style.css hash-matches production).** "Serve
handles the rest…" (`.hero__lead`) now takes the tagline's size and colour
(1.15rem, #cbd5e1); Chrome computes both lines as Inter 18.4px 400. 30/30.

**Tooling note.** Codex runs a local preview on 127.0.0.1:8792. A local server
that binds a taken port on another address can let the browser reach the other
agent's server instead — bind `127.0.0.1` explicitly and fail on EADDRINUSE.

## Current work — 2026-09-14, Claude Code: the move-in hero leads with a ZIP check

**COMMITTED (`0f3dbc3`), PUSHED, AND LIVE — files verified in production.** Site
only: no Apps Script, Worker, or sheet change.

**The ask.** On the page `/movein` visitors see: "Moving in or out?" replaces the
"Just closed on a new home?…" headline; under it Build's ZIP field with Build's
"Check if we're in your area" label; then "Instantly quote & book in under 1
minute", "Serve handles the rest…", the "Serve manages, coordinates, and books…"
sentence, and "Made to Serve your needs". A ZIP we serve gets a green check and
a scroll down to Build with the ZIP already entered.

**What shipped.**
- `index.html` — two hero bodies under the one `h1`: `#hero-body-default`
  (unchanged, with the Instant Booking button) and `#hero-body-movein`, authored
  `hidden`. The move-in body has no button; the ZIP check is its CTA.
- `script.js` — `HERO_SKINS.movein` is `{ headline, body: 'hero-body-movein' }`;
  `applyHeroSkin` swaps bodies only when both are found. `HERO ZIP CHECK` (in the
  booking IIFE, just above Step 1 submit) writes a full ZIP into Build's `#zip`,
  runs `evaluateZip()`, and reads `state.tier` back — coverage is decided in one
  place. Served: green check, `prefetchAvailability()`, 700ms, blur,
  `setView(1)`. Unserved: "We're not in X yet." and a waitlist link to Build,
  whose waitlist is already showing; the page never moves on its own.
- `style.css` — `.hero-zip*`, `.hero__lead`, after `.hero__logo`. Input rules are
  scoped under `.hero-zip` because `.flow-input` sits later at equal weight.
- `tests/segment-and-skins.test.js` — body swap incl. half-present pairs; the
  authored body (hidden, label word-for-word Build's, line order, no button); the
  real ZIP block sliced out and run against fakes. "Skins define a headline and
  nothing else" is now "a headline, and at most a body id authored hidden".

**Checked.** 29/29 before and after. Eight deliberate breaks (Build not written,
no pause, jump not cancelled, default not hidden, half swap, jump to Price,
unserved jumps, wrong headline) each fail the test; script.js restored. Headless
Chrome over CDP, local server, 1280px and 390px emulated: direct and pro heroes
untouched; 02116 shows the green check before moving, then lands on Build with
`#zip` = 02116 and Step 1 active; 90210 never scrolls and shows the waitlist
link; no page exceptions; no horizontal overflow at 390. Production after the
Pages build: `index.html`, `script.js`, `style.css` hash-match the repo;
`/movein` answers 302 `/?src=deed-movein`.

**Not verified.** A real phone (keyboard dismissal, smooth scroll); the flow
driven in a browser on production — only file identity was checked there.

**Open for the founder.** "Serve handles the rest…" existed nowhere, so it
shipped as typed. Build still preselects First Clean for move-in visitors;
preselecting Move In / Move Out is small but is a sales choice, so not done.

**Concurrent.** Codex is active in this checkout (entry below). None of its files
were staged or committed; only this entry was staged from this file.

## Current work — 2026-09-14, Codex: cleaner completion photos — SUPERSEDED by r48 above

**BACKEND r47 LIVE; site publication in progress.** User approved continuing
deployment after the browser approval reviewer timed out and blocked its retry.
The original editor matched committed r46 and was backed up privately. Saved
r47 was read back byte-for-byte (normalized newlines); the existing /exec URL
now answers `2026-09-14 r47`. No real booking or photo test records were created.

Each Scope room gains finished-room confirmation, camera and upload controls.
COMPLETION_PHOTOS auto-creates on the first authorized upload; objects use the
private completion-photos/ R2 prefix. No delete/replace operation. The vendor
company is stamped at upload, and its portal keeps a dated per-room archive
after completion/reassignment/removal of the operational JOBS row. Customer
reference photos remain separate; customers cannot read completion evidence.

**Checked:** 30/30 suites; deliberate removal of finished confirmation, owner
read check, archive owner filter and room binding each fails the new suite.
390px iframe preview: finish-first guard, real browser JPEG compression/upload,
saved image and reload. Synthetic booking completed, vendor archive still loads
and enlarges the photo with no delete controls. Desktop gallery reviewed.
Actual phone camera/device picker and live R2 upload have not been exercised.

**Remaining:** push site after backend, verify production assets, and add an
indefinite R2 bucket lock for completion-photos/ only. Cloudflare browser session
expired; the available Google login reached a different account without
the existing bucket. Founder was asked to switch to the account owning Worker
serve / bucket serve-booking-photos (account f8247a197ff42a877f92b16d227bcc0e).
Do not claim the storage lock exists yet. App cleanup cannot select completion
photos, regardless. Preserve unrelated AGENTS.md/CLAUDE.md changes and images.

## Current work — 2026-09-14, Claude Code: r46, the move plan box never drew

**COMMITTED AND PUSHED. NEEDS THE FOUNDER'S PASTE of `apps-script/webhook.gs`;
`/exec` must answer `2026-09-14 r46`.** Apps Script only — no site change.

**The report.** r45 was pasted (`/exec` answered r45) and the site was live, but
the founder's move-in / move-out test booking showed no plan box.

**The cause.** `homeSpecFor()` required the stored ZIP to match `/^\d{5}$/`.
`writeRow` uses `appendRow`, and Sheets turns `"02116"` into the NUMBER
`2116`, so every Boston ZIP reads back four digits long. The spec came back
null and `movePlanForPortal` returned null for EVERY real move booking. The
same null would have made `movePlanPrices` refuse every write.

**Why 29/29 and 24/24 did not catch it.** The section 25 fixture stored the ZIP
as the text `'02116'` — something real Sheets never gives back. A green suite
and a clean mutation run proved the code agreed with a fixture that did not
describe production. `zipN()` — "Survives Sheets' numeric coercion" — already
existed for exactly this.

**Fix.** `homeSpecFor` reads `zipN(b.zip)`. The fixture now stores the number
`2116`; against the r45 code it fails at "a move customer is shown the plan
box -> null" (checked before the fix), and passes after. 29/29.

**Lesson for fixtures:** seed sheet cells the way Sheets returns them (numbers
for ZIPs, beds, prices; Dates for dates), not the way the code wrote them.

**After the paste:** reopen the test booking's portal link. If the box is still
missing, the next suspects are that booking's row: blank or non-numeric
`beds`/`baths`, a `job_status` of cancelled, or a `service_type` that does not
contain "move".

---

## Current work — 2026-09-14, Claude Code: r45, a plan after a move

**PUSHED AND VERIFIED (site + Worker, `d660d0d`). WAITING ON THE FOUNDER'S PASTE
OF `webhook.gs` r45** — until then nothing is visible to any customer. Checked in
production after the push: `POST /api/quote` returns `recurring`
(`{"weekly":205,"biweekly":323,"monthly":537}` for 3 bed / 2 bath / 2 levels
in 02116) on the third 15-second poll; `portal.js` and `style.css` match the repo
(hash, line endings normalised); `/api/health` ok, `/api/slots` ok,
`/api/portal` with a bad token `not_found`, `/` 200.

### The ask

The founder, testing move-in / move-out bookings, found there was no way for
those customers to set up recurring cleaning anywhere. Asked for: in the portal
of a move customer, show the recurring plans with prices from the real
calculator, let them pick one and a time from availability (or earlier / later
in the day), put the booked visit in Upcoming, and keep the box saved and static
until they change the plan or the time.

### What shipped

- **The plan box** (`portal.js`, `movePlanBox`), under Upcoming beside r38's
  offer card. *Choose*: the home it is for, three tiles (Every week / Every 2
  weeks / Every month) with a per-visit price each, then times from `/api/slots`
  filtered to AFTER the move clean, "None of these work?" → earlier / later
  buttons, the same-company checkbox when the move had a company, a sentence
  saying back exactly what will be booked, and "Start my plan". *Saved*: solid
  card — cadence, price, address, "Next visit: …", "Change plan or time" (or
  "Book your next visit" when nothing is coming). *Change*: the same chooser
  with the current plan selected and "Keep my visit on …" as the default time.
- **Server** (`webhook.gs` r45): `movePlan` on the portal model;
  `plan_start` and `plan_change` portal writes. Full contract in SCHEMA,
  "A plan after a move".
- **Worker**: `/api/quote` also returns `recurring` — `computeQuote().freqSteady`.

### Where the price comes from — the founder asked for this specifically

The recurring prices are the pricing engine's recurring track for that home
(`freqSteady`): the same numbers a first-clean customer with the same home is
shown on the booking form, since that track ignores service, condition and
add-ons. **Apps Script has no copy of the engine**, so it asks the Worker's
`/api/quote` itself, with the beds / baths / levels / ZIP stored on the move
booking — nothing from the browser. The browser shows prices from the same
endpoint and sends back `shown_price` only so that a price change in between is
refused (`price_changed`) rather than booked at a number nobody saw. A plan then
HOLDS its price: a time-only change never re-prices; only a different cadence
asks the engine again.

No new business number was introduced. **Example from the Worker test, 2 bed / 1.5 bath /
2 levels in 02116: weekly $180, biweekly $281, monthly $471 per visit** — monthly costs more per visit because more builds up
between cleans. That is the existing engine, not a decision made here.

### Decisions made here (engineering), and ones left for the founder

Made:
- Choosing BOOKS immediately (plan row `confirmed` + first JOBS row). No 7-day
  held offer as in r38 — the customer is choosing in the moment.
- The plan box moves the ANCHOR; r43's per-visit "Change time" still does not.
- A PAID visit's price is never rewritten by a cadence change (`paid` → call us).
  An unpaid one is; the ops email flags that a card hold may be for the old
  amount. Nothing captures, voids or refunds.
- Only plans originating from a move can be changed from this box; a first-clean
  plan keeps the price it was quoted (r38's promise).
- Move-out condition ("heavy") is not carried onto the upkeep visit.

**For the founder — not decided:**
- **Move-OUT customers are leaving the address on the booking.** The box names
  the home ("For 9 Tremont St, 2") so nobody books upkeep blind, but a move-out
  customer is still offered a plan at the home they are leaving. Options: show
  the box to everyone who booked a move (current), or hide it until there is a
  way to book the NEW address. The service is one combined "Move in / move out"
  type, so the system cannot tell the two apart today.
- Whether move customers should get a discount or the same recurring prices as
  everyone (current: same engine prices).

### Two defects caught before shipping

1. **A disabled button freezes the live refresh.** `booking-live.js` treats any
   `button:disabled` as "a save is in flight" and stops repainting. The first
   draft disabled "Start my plan" until a time was picked, which would have
   frozen every move customer's portal. It is hidden instead, and a test asserts
   no disabled button exists in the untouched box.
2. **After `price_changed` the confirm button stayed disabled**, so the customer
   could never accept the new price. Found by the render test.

### Verified

- **29/29 test files pass.** `portal.test.js` section 25 (server, fresh harness,
  ~105 assertions: ownership each way, engine inputs from the stored home, price
  refusals, start/change/preference/next-visit paths, the repair path, whitelist
  keys, no vendor id). `portal-render.test.js` section L (the real `portal.js`
  driven by clicks). `worker-proxy.test.js` checks `recurring` against the
  engine directly.
- **Mutations: 24/24 caught, each on its named assertion**, every file restored
  byte-identical. The first run missed four, all test weaknesses rather than
  code bugs, and all fixed: (a) change-ownership was only proven by the booking
  check behind it — r42's shape again — now a mis-keyed plan row on the caller's
  own move booking; (b) the same-company mutation had no company to leak; (c) a
  mutation placed after the write it meant to break; (d) the saved price in the
  fixture equalled the engine price, so "keeps the booked price" proved nothing.
- r42 and r43 behaviour unchanged by the three extractions — their sections pass
  untouched.
- `scripts/build-site.sh`: 74 files staged, nothing private.
- Headless Chrome screenshots (stubbed data, local server) of choose-with-a-pick
  at 1280px and 520px, and the saved card at 1280px.

### NOT verified

- **No real Apps Script → Worker call has run.** The harness stubs `UrlFetchApp`.
  Cloudflare could conceivably challenge Google's egress; if so every start
  answers `price_unavailable` and the box says it could not confirm the price.
  Check with a real move booking right after the paste.
- No real portal link has opened the box; no email has been read.
- Phone width below 512px (headless Chrome limit).

### Deploy — THE ORDER IS PUSH FIRST, THEN PASTE. The reverse of the usual rule, on purpose.

- The site half is **inert until r45 is pasted**: the box draws only from
  `movePlan`, which only r45 sends. Pushing first puts nothing on any page.
- The script half **needs the Worker live**: r45 prices through
  `/api/quote`'s new `recurring` field. Pasting first would let a move
  customer see the box's prices fail.

1. Push (Worker + site). Confirm `POST /api/quote` in production returns
   `recurring`.
2. Founder pastes `apps-script/webhook.gs` into Leads MASTER and deploys a new
   version; `/exec` must answer `2026-09-14 r45`.
3. Open a portal link for a move booking: the box, prices, pick, start; the
   visit appears in Upcoming, the box turns into the saved plan, the ops email
   arrives. Then "Change plan or time".

`availability.gs` untouched. No sheet change.

---

## Current work — 2026-09-13, Claude Code: r44, the portals read each sheet once

**DEPLOYED AND VERIFIED IN PRODUCTION, in the standing order.** The founder
pasted the script; `/exec` answered `2026-09-13 r44` before anything was pushed.
Then `6786c82` was pushed and was live on the fourth 15-second poll. Checked
against production:

- `/h`, `/j` and `/v` each serve the early `<head>` request and the skeleton.
- `portal.js`, `ticket.js`, `vendor.js`, `script.js` and `style.css` are
  byte-identical to the repo (line endings normalised).
- `/api/health` ok; `/api/slots` ok with 11 slots; `/api/portal`, `/api/vendor`
  and `/api/job` with a bad token answer `not_found`; `/` 200; `/h` still sends
  `no-store`, `noindex` and `no-referrer`.
- Bad-token timings 0.9–2.1s, the same floor as before. **One vendor probe took
  6.6s**, the first request after the new script version — a cold container, not
  a regression; the next seven were normal.

**Still not verified: a real signed link.** Every token-less probe returns before
any sheet is read, so r44's reading code has run in production only behind a
real portal, ticket or vendor link. Open one of each: a skeleton first, then the
account, with bookings, instructions and access answers as before.

`availability.gs` is untouched — no second paste.

### The problem

The founder reported that portals and the vendor page were slow, especially for
instructions and access questions to "fully load". **Nothing on those pages
appears until one request returns**, and that request was slow for two reasons:

- **A fixed ~1–2s floor.** Measured in production: a portal request with a bad
  token (which reaches Apps Script and reads no sheets) took 0.9–1.9s; the
  Worker alone answers in 0.1s. That is Apps Script, and no code here changes it.
- **The server re-read the same sheets.** Counted by instrumented harness on a
  realistic account (5 bookings, 2 homes, one partner): **211** SpreadsheetApp
  calls to open the portal. `getContactBookings` read JOBS, then called
  `getBooking` per booking, which re-read JOBS (headers, id column, row) each
  time; `publicBookingPhotos` read the whole photo tab once per booking,
  finished ones included; instructions once per upcoming booking; access once
  per home; the Ops workbook reopened by every helper that touched it.

### What changed — webhook.gs r44

- **`withRequestScope`**, opened by `doGet` (shared snapshots) and `doPost`
  (fresh reads only), closed in a `finally`.
- **`readTable(ss, name)`** — a whole tab in one `getDataRange().getValues()`,
  shared for the rest of a GET. **`sheetValues(sheet)`** — the same one-call
  read for a sheet already in hand, never shared; the write paths use it.
- **`bookingFromRow`** split out of `getBooking`; contact and vendor booking
  lists build from the rows already read.
- `opsBook()`, `sheetTimeZone()` and `ticketSecret()` answer once per request.
- Converted readers: `getContact`, `getBooking`, `getContactBookings`,
  `getVendorBookings`, `getPropertyAccess`, `getBookingAccess`,
  `getBookingInstructions`, `bookingPhotoRows`, `clientRecurringPlan`,
  `handleKnownProperty`, `opsRow`, `opsRows`; and on the write side
  `upsertLead`, `upsertProperty`, `ensurePropertyMemoryRow`,
  `planAlreadyOffered`, `bookAvailabilitySlot`, `releaseAvailabilitySlot`.
  `alreadyWritten` deliberately still reads one column: JOBS and EVENTS grow
  forever, and a whole-tab read there would get slower over time, not faster.

| Request | r43 calls | r44 calls |
|---|---|---|
| Customer portal | 211 | **39** |
| Client ticket | 43 | **19** |
| Cleaner's ticket | 51 | **22** |
| Vendor portal | 79 | **19** |
| Save an access answer | 102 | **28** |
| Save an instruction | 99 | **25** |
| New booking | 103 | **77** |

These are Sheets calls, not seconds. The ~1–2s floor stays; what goes is the
multiple of it. **Production timing has not been measured** — it needs the paste
and a real signed link.

**The one intended behaviour change:** a list booking is built from its own row.
On a sheet with a duplicated `job_id`, r43 showed the first row carrying that
id — possibly another customer's — in the second customer's portal.

### What changed — the site

- **Skeletons.** `h.html`, `j.html` and `v.html` paint the page's shape in
  place of "Loading…" (sidebar-shaped from 720px on the portals, so nothing jumps
  sideways), with a screen-reader label, a pulse that stops under reduced motion,
  and "Still loading…" after 6s. `fail()` writes over it, `start()` hides it.
- **The request starts from `<head>`.** An inline script above the stylesheet
  starts the fetch; `portal.js`, `ticket.js` and `vendor.js` adopt it through
  `firstLoad(url)` only for the identical address, and ask for themselves
  otherwise. Saves the stylesheet + scripts download time, which is the whole
  wait on a phone opening a link from a text.
- **Open times fetched before the click** (`portal.js`): when the page has an
  open plan or a visit that can move, it asks once after painting; a click inside
  60s reuses the answer; an empty answer is not kept; a plan confirmation,
  reschedule or cancel forgets it.
- **Booking form** (`script.js`): times are requested at the first `focusin` on
  step 1 instead of at step 2, and a failed or empty attempt no longer uses up the
  only try — step 2 asks again.

### Verified

- **29/29 test files pass.** New: `tests/read-budget.test.js` (budgets, no writes
  in a GET, shared-vs-fresh scopes and the entry-point wiring, scope closing, the
  duplicated-`job_id` fix, the Sydney timezone path) and `tests/early-load.test.js`
  (the early request and each page script agree on the address — exactly one
  request; tampered/absent/offline/no-token cases; the skeleton contract; the
  booking form's second try). `portal-render.test.js` gained section K.
- **Differential run:** r43 and r44 driven through the same 82 requests in New
  York and Sydney timezones, frozen clock — every response, every tab and every
  log line identical, with reschedule, the already-there guard, cancel, plan
  confirmation and a booking all genuinely succeeding (not failing identically).
- **Mutations: 14/14 server, 17/17 site, plus one by hand** (a stylesheet placed
  above the early script) — each caught, every file restored byte-identical.
  The first server mutation — letting `doPost` share snapshots — changed **no
  output and failed no pre-existing test**, because no POST today reads back
  through `readTable` after writing. That rule is now pinned directly.
- Four test harnesses (`webhook-routing`, `leads-upsert`, `webhook-atomicity`,
  `webhook-schema`) gained the `getDataRange` stub real Sheets has. Without it
  the booking path threw inside the harness and **reported LEADS as failed** —
  the failure looked like the code, not the stub.
- `scripts/build-site.sh`: 74 files staged, nothing private.
- Headless Chrome screenshots of the skeleton at 512px and 1280px.

### NOT verified

- **No real signed link has been opened on r44** — see the deploy note above.
- **Phone-width rendering below 512px**: headless Chrome will not lay out
  narrower, and crops the capture; the unchanged r43 page crops identically.

---

## Earlier — 2026-09-13, Claude Code: the warm ping (Worker only)

**Pushed as `190f2a5`.** Post-push probes all answered: `/api/health` ok three
times, `/api/slots` ok with 13 slots, `/api/portal` with a bad token
`not_found` (route alive, auth working), `portal.js` serving r43, `/` 200.
**Cron registration is still unconfirmed** — see "NOT verified" below.

**NO APPS SCRIPT PASTE. `webhook.gs` is untouched and stays at r43** — nothing
here changes the server, so there is no script-before-site ordering to respect.
This is `src/worker.js` + `wrangler.jsonc`, and it deploys by pushing.

### The problem it fixes

Both upstreams are Apps Script web apps, and Apps Script sleeps an app nobody
has called. The first request after that cold-starts, sometimes past the
Worker's 8s budget for `/api/slots`. **What a customer sees is not an error** —
every caller treats a failed feed as "no times available" by design, so a cold
start is indistinguishable from genuine unavailability: the booking form drops
to the earlier/later radios, the plan card says it has no times, and (since
r43) somebody trying to move a visit is told to call. Nothing is logged where
anyone would look.

**Low traffic is what made this bite.** Idle is the normal state of a quiet
site, so "the first visitor after idle" was close to *every* visitor. It gets
better on its own as real traffic arrives, which is the reverse of how these
usually go — and it is worst right now, before any spend on traffic.

### What shipped

A second cron trigger, `*/5 * * * *`, calling `warmUpstreams()` — a plain GET
to each `/exec` purely to keep a container alive. Five minutes matches the
feed's own 5-minute cache, so a ping lands about as the cache expires.

**Both upstreams, not just the feed.** The webhook is the more expensive one to
leave cold: it backs `/api/submit`, `/api/portal`, `/api/job`, `/api/photos`
and `/api/vendor`, so a cold webhook is a slow portal for everyone and, at
worst, a booking that exceeds its 12s budget and fails outright. This is
slightly wider than the availability feed that prompted it, and deliberately so.

**The visitor-facing timeouts were left exactly alone.** Raising them would not
remove the wait, only move it into the customer's browser and make them watch
it. The ping's own budget is 25s — long *because* nobody is waiting behind it;
absorbing the cold start here is the whole point.

**THE DANGEROUS PART WAS THE EXISTING CRON.** `17 8 * * *` already drives
`cleanupPhotoStorage()`, which deletes objects from R2. One `scheduled()`
handler now serves both, branching on `controller.cron`. **The destructive job
runs only on an exact match**; anything unrecognised falls through to the
harmless ping. That asymmetry is deliberate — a cron string edited in
`wrangler.jsonc` but not in the worker fails as "photos stop being tidied up",
which is recoverable and visible, rather than as "the deleter now runs every
five minutes".

The strings are necessarily duplicated (Cloudflare reads the config, the Worker
reads the event), so **a test asserts the two agree**, in both directions.

### The mutation run found a vacuous assertion of mine

First run: 11 of 12 caught. The miss was `and nothing destructive is
triggered` — my own assertion, which **could not fail**. The warm-cron case ran
against an `ENV` with no `BOOKING_PHOTOS`/`PHOTO_BRIDGE_SECRET`, so
`cleanupPhotoStorage` returned at its own guard and could never POST no matter
what the branch did. Deleting the entire cleanup branch left it passing; the
file only went red on a *different* assertion.

Fixed by running that case against a photo-capable env, so the cleanup genuinely
*could* fire and the assertion has something to prove. **12 of 12 caught after
that, each on its named assertion.** This is the same shape as r42's "a guard
proven only by the guard behind it" — an assertion that cannot fail is not an
assertion, and only a mutation run says which is which.

### Verified

- **27/27 test files pass.** `worker-proxy.test.js` gained a cron section: both
  branches, the unknown-schedule fallback, failure logging, the never-rejects
  contract, the unconfigured-upstream skip, the config↔constant drift guard in
  both directions, and that the ping's budget exceeds the customer-facing one.
- **12 deliberate mutations, all 12 caught on a named assertion.**
- `npx wrangler deploy --dry-run` exits 0 and bundles with every binding
  resolved. The only warning is the pre-existing `commonjs-variable-in-esm`
  note about `engine.generated.mjs`.

### NOT verified, and it cannot be from here

**`wrangler --dry-run` does not report trigger registration**, and there is no
way to confirm from the repo that Cloudflare actually registered the new
schedule. **A cron that failed to register looks exactly like one that is not
working** — the site behaves normally either way, which is the whole failure
mode being fixed.

After the deploy, confirm one of:
- the Cloudflare build log for this push shows both crons on the deploy step, or
- the Worker's **Settings → Triggers → Cron Triggers** lists `17 8 * * *` and
  `*/5 * * * *`.

Then, after the next genuinely idle spell, `warm availability: ok in …ms` lines
should appear in the Worker logs every five minutes. A `warm … failed` line is
the only place a failing ping is ever visible.

**This is a mitigation, not a cure.** A cold start is still possible right after
a Worker deploy, if a cron run is missed, or if Google's undocumented idle
threshold turns out to be shorter than five minutes.

---

## Current work — 2026-09-13, Claude Code: r43, reschedule & cancel

**COMMITTED, NOT DEPLOYED. Paste `apps-script/webhook.gs` into Leads MASTER
BEFORE the site is pushed.** This is the order that matters and it is not
optional here: the site half puts live "Change time" and "Cancel visit"
buttons on every open booking, and the deployed r42 server answers
`unknown_kind` to both. A customer would tap Cancel, be told it did not go
through, and reasonably conclude their visit is still booked. Script first,
site second — the rule in CLAUDE.md, and the same trap r42 avoided.

Verify the paste took by opening the `/exec` URL: it must answer
`"version":"2026-09-13 r43"`. Saving the editor is not deploying; only the
stamp can tell those apart.

### What shipped

**A customer can move a booked visit, or call it off.** Two portal writes
(`reschedule`, `cancel`) on a booking they already have, offered at the bottom
of an open booking panel under everything they might add to the visit —
because these are the two controls that change whether it happens at all.
Moving reads times from `/api/slots` through the same horizon rules the
booking form uses. Cancelling asks twice, inline, and says what it costs them.

**This is the first code in the system that ever GIVES CAPACITY BACK.**
`releaseAvailabilitySlot()` closes the "nothing releases a slot" open item that
has stood in SCHEMA since r5. Every cancellation before today left its
`AVAILABILITY` row reading `booked` forever — capacity leaking one cancellation
at a time, invisibly. **Those rows are still out there and are worth a look.**
It matches on `job_id`, never on date and time (after a hand-resolved conflict
the calendar square can belong to somebody else), and never touches `held`,
which is an operator's own diary rather than public capacity.

**THE ANCHOR IS UNTOUCHED BY BOTH WRITES.** That is the property this release
exists to protect. `anchor_date`/`anchor_time` is the beat every later visit is
counted from; moving October's clean does not move the cadence, and cancelling
October does not cancel November. Writing a new time back onto the anchor would
let one one-off change silently redefine the schedule — the drift that walks an
every-other-Tuesday onto a different weekday over months with nobody deciding
it. Nothing in either write path touches `RECURRING_PLANS` at all.

**A cancelled row is kept, never deleted.** `job_status` reads `cancelled` and
the row keeps its price, address, instructions and attribution. Deleting it
would quietly stop every count of "work booked" from including work that was
booked and given back. The portal renders it in its own **Cancelled** section,
struck through, with no payment button and no controls.

**`vendor_id` is never overwritten by a move.** It is ops-owned. Where a
dispatcher has already assigned the job, a new slot belonging to another
company is a clash for a human, and the ops email says so in as many words.
`setJobCells()` **throws** on any ops-owned column rather than skipping it — a
customer-facing path must not become the back door onto a hand entry.

**`cancel_notice_hours` is built, tested, and OFF.** A notice window is a
customer promise with a refund question attached, and both are the founder's
open decisions. The default is `0`, so nothing is enforced; put a number in Ops
`SETTINGS` and it starts working with no deploy. Out-of-range values are
refused and logged, never clamped — guessing what `99999` meant would lock
customers out of their own bookings.

### Two real defects, both caught by the new tests rather than in production

**The release gave back the slot the move had just booked.** A reschedule books
the new row under the SAME `job_id` before releasing the old one, so for that
instant two booked rows carry that id — and "free every row for this job" freed
both. The customer would hold a confirmation for a slot reading `open` that the
next visitor could buy. The caller now passes the row it just took, excluded by
number. Found by reasoning through the ordering while writing the test for it.

**The already-there guard never once fired, and the cause is a class of bug
worth remembering.** It compared `booking.scheduledDate`/`startTime` against
the browser's slot values. But `getBooking()` returns **display** strings:
`timeCellText` appends " ET" to anything reading as a clock time, so the
comparison was `"1:00 PM ET" === "1:00 PM"` — false forever. A repeated move
therefore re-booked an already-booked row (a conflict, so nothing was taken)
and then released the row the customer was holding. It now compares the RAW
cells through `slotTimeLabel`, the same normaliser that matches AVAILABILITY
rows. **`getBooking()`'s `startTime` is for showing a human, never for
matching.** The same bug had also made `wallClockMs` fall back to midnight,
measuring the notice window from an instant up to a day off; its parser is no
longer anchored at the end of the string.

### A class-name collision cost ten assertions

The move button first reused `plan__cta plan__go`. Bookings render ABOVE the
plan card, so every "find the plan's button" in the existing render tests found
the booking's button instead, and r42's section D/E/F went red. It now carries
its own `sched__move`. A class name is an identity, not styling.

### Verified

- **27/27 test files pass.** `portal.test.js` gained section 24 (the server
  side) and `portal-render.test.js` gained G/H/I/J, which drive the real
  `portal.js` through clicks — including with `serve-slots.js` deliberately not
  loaded, because the two halves degrade separately: a missing scheduler may
  cost the move control but must never cost the ability to stop a cleaner
  arriving. That path threw the first time it ran and is now asserted.
- **19 deliberate mutations, all 19 caught, each on a NAMED assertion** rather
  than on a crash somewhere else — the r40 rule, checked explicitly by the
  runner. They covered: the anchor being dragged along, the release not being
  told which row was just booked, the already-there guard disabled, the ET
  regression restored, `held` released, the release ignoring `job_id`,
  ownership falling back to any booking, a cancelled visit acted on twice, the
  row not marked, an ops column written, the notice window unenforced, imposed
  when unset, and clamped instead of ignored, the anchored clock parser, and
  five browser-side breaks. Both files green again after restore.
- `scripts/build-site.sh` runs clean. **No new file this release** —
  `portal.js` and `style.css` are already on the allow-list, and `_site/` is
  gitignored and untracked, so there is nothing to stage into the commit.
- **NOT VERIFIED IN PRODUCTION, because nothing is deployed.** Production is
  still r42. No probe of a live r43 has been made and none can be until the
  paste happens.

**Not mine, left alone:** `AGENTS.md` and `CLAUDE.md` still carry uncommitted
continuity edits from the founder or Codex, and two image files are untracked.
None are in this commit.

**STILL QUEUED:** the portal settings tab for the plan and home layout. Also
worth deciding, both the founder's: the notice window number (the lever is
live and reads `0`), and whether the availability feed's cold start gets a
warm-up ping — it now degrades the reschedule agenda too, not just booking.

---

## Current work — 2026-09-13, Claude Code: r42, confirm & schedule

**DEPLOYED AND VERIFIED IN PRODUCTION. Both halves, in the right order.**

1. The founder pasted `apps-script/webhook.gs`. The health endpoint then
   answered `{"ok":true,...,"version":"2026-09-13 r42"}` — checked BEFORE the
   push, because "pasted and saved" and "deployed as a new version" are not the
   same thing and only the stamp can say which happened.
2. The site was pushed (`9146534..355ee07`) and the Pages build landed.

That order was the point: backwards, the site half puts a live "Choose a time"
button on the portal while the server still answers `unknown_kind`, and the
customer taps Confirm and is told it did not go through. Script first, site
second, as the rule in CLAUDE.md says.

**The gate was cleared first.** The founder confirmed the r41 plan card is
showing on a real portal, which is what this release builds on.

### What shipped

**Confirm & schedule.** The plan card now offers a time. Times come from
`/api/slots` — the same feed the booking form reads — and the customer picks a
day and a slot, is shown exactly which visit they are about to book, and
confirms. That writes a real `JOBS` row (`CLEAN_STANDARD`, the cadence, **the
price the plan held** rather than one recomputed today), flips the
`AVAILABILITY` row to `booked`, stamps the slot's partner onto the job, and
sets `status=confirmed` plus the **anchor** every later visit is counted from.

**The same-company request.** A checkbox, offered only when there IS a previous
company, that records `preferred_vendor_id`. **The browser sends yes or no and
never a vendor id** — which company that means is read off the origin booking
on the server, or a payload could request any company on the network and
dispatch could not tell that apart from a request Serve made. Nothing reads the
column yet; the ops email says plainly that assignment is still a human's.

**It creates that job the one way jobs are created.** The payload is
synthesised and handed to `buildJobRecord` / `writeRow` /
`bookAvailabilitySlot` / `stampJobVendor` — the same calls in the same order as
`doPost`, not a second way to write a JOBS row.

**`serve-slots.js` is new**, and `script.js` now delegates to it. The horizon
rules had to leave the booking page for the same reason `SERVE_SCOPE` did: /h
loads nothing from the marketing bundle, and two copies of "what may a customer
pick?" is how two pages start offering different days. `live-slots.test.js` and
`availability-contract.test.js` were repointed onto the module, so what they
prove is now proved for both callers at once — and the contract test gained an
assertion that the booking page has not grown its own copy back.

**r38's promise is kept on both sides.** Offering a plan still holds nothing.
Confirming one is what takes capacity away from somebody else.

### The hazard that shaped the id

`submission_id` is `PLNC-<plan_id>-01`, deterministic so a double-tapped button
dedupes into one booking. **The `-01` is load-bearing.** A `job_id` is the date
plus the last six characters of the submission id, and a `plan_id` is its
origin job's id with the prefix swapped — so an id derived from the plan alone
ends in the same six characters the first clean's does, and a plan confirmed
for the *same day* as that clean would mint an identical `job_id`. Two rows
answering to one id means `getBooking` returns the wrong one forever. There is
now a test that confirms a plan on exactly that day.

### THE MISSED MUTATION, and it was the ownership check

The first mutation run disabled the plan's `lead_id` ownership check — the most
important guard in the release — and **the suite stayed green.** Not because
the check is redundant: because every attempt to confirm someone else's plan
also reached someone else's *origin booking*, and the second check answered
first. A guard proven only by the guard behind it is not proven at all. That is
the r40 rule ("a crash proves nothing about the assertion that crashed") in a
new shape, and it is the third release in a row where the cause was one guard
standing in front of another.

The fixture that separates them is a plan row carrying **another customer's
lead_id while pointing at this customer's booking** — what a mis-keyed backfill
leaves behind. With it in place the mutation books `SRV-20261004-SSED01` for
the wrong person and the file goes red.

**A test-harness gap found the same way.** The fake `getRange()` had
`getValues` but no `getValue`, so `stampJobVendor`'s `cell.getValue()` threw,
the caller's wrapper swallowed it, and the vendor stamp silently did nothing —
in the harness only. A missing stub is indistinguishable from a bug in the code
under test, which is the worse half of that. Added.

### Verified

- **27/27 test files pass.** `portal.test.js` gained section 23 (the server
  side) and `portal-render.test.js` gained D/E/F, which drive the real
  `portal.js` and the real `serve-slots.js` through a click.
- **13 deliberate mutations, all 13 caught**, each on a named assertion:
  ownership, a browser-named vendor, a non-deterministic submission id, the
  dropped `-01`, an unwritten anchor, unvalidated times, a lapsed plan
  confirmable, no slot consumed, no vendor stamped, every plan claiming a
  previous company, the browser dropping the horizon rules, the same-company
  request never sent, and a confirm control reachable before a time is chosen.
  The suite was green again after restore.
- The render test's feed is built **relative to today**, so the horizon rules
  are the thing under test and the file cannot rot into a calendar-flaky red.
- `scripts/build-site.sh` was run: `_site/serve-slots.js` is staged.
- **VERIFIED IN PRODUCTION, not merely pushed.** The webhook health endpoint
  answers `2026-09-13 r42`. `servecleaning.com/serve-slots.js` is HTTP 200 and
  byte-identical to the repo (7,367); `portal.js` likewise (39,210) and carries
  `plan_confirm`, `function planConfirm` and `ServeSlots.picker`. Both `/` and
  `/h` serve the `serve-slots.js` script tag — the booking page needs it too
  now, and a missing tag there would have degraded the booking funnel, not just
  the portal. `style.css` carries every new rule. `/api/slots` answers
  `ok:true` with 14 real slots.
- The first probe of `serve-slots.js` was a 404 and `portal.js` was still the
  old copy — the Pages build simply had not landed. Re-probed rather than
  assumed. Byte counts were checked against the repo instead of trusting a
  200, because a stale cached file also answers 200.

**Not mine, left alone:** `AGENTS.md` and `CLAUDE.md` carry uncommitted
continuity edits from the founder or Codex, and two new image files are
untracked. None are in this commit.

**STILL QUEUED, in the founder's order:** reschedule / cancel per upcoming
booking with the **anchor as source of truth** (a one-off move shifts that
visit only; the next is counted from the anchor), then the portal settings tab
for the plan and home layout.

---

## Current work — 2026-09-13, Claude Code: r41, the plan card reaches the page

**A SITE FIX. `webhook.gs` is untouched and needs no paste.** r40 is already
live — confirmed by probing the health endpoint, which answered
`{"ok":true,"service":"serve-booking-webhook","version":"2026-09-13 r40"}`.
The server has been sending the plan correctly since that paste. Deploying
this is pushing the site; Cloudflare Pages builds from the repo.

**The bug.** r38’s plan card was drawn by `add(bodyEl, planCard(d.plan))`.
`d` is the parameter of the fetch callback at the top of `portal.js`; inside
`renderBookings()` the model is called `model`. `d` does not exist in that
scope, so the line threw a ReferenceError — in production, on every portal
load, for two releases.

**Why it looked like nothing rather than a crash.** The throw happened AFTER
the upcoming rows were already appended, and the load promise’s `.catch()`
swallowed it into a `console.warn` and a state message that `start()` had
already hidden. So the page rendered up to that line and stopped: no plan
card, and no Past section either. Ten backfilled plans sat in the sheet,
correct and invisible, and the reported symptom was “nothing changed”.

### The gap: no test had ever executed portal.js

26/26 passed throughout. `portal.test.js` tests the server view model;
`portal-access.test.js` string-slices ONE function (`accessComplete`) out of
the file and runs it alone. Nothing ever booted the render path. `ticket.js`
has had `ticket-render.test.js` since r23 — the portal, which is the page the
confirmation email actually sends, had no equivalent.

**New: `tests/portal-render.test.js`.** Boots the real `portal.js` — byte for
byte, IIFE and all — in a `vm` context against a DOM shim and a stubbed fetch,
then asserts what a person would see. `partner-card.js` and `serve-scope.js`
are loaded for real rather than stubbed, because `bookingRow()` calls
`ServePartner.block()` with NO typeof guard; a stub would assert against a
fixture instead of the shipped page.

Its load-bearing assertion is `the bookings tab renders without throwing`,
which reads the captured `console.warn`. Against the unfixed file it printed
`["portal load failed d is not defined"]`, and `the Past section after it
still renders` printed `["Upcoming"]` — the collateral damage, reproduced
exactly. 10 assertions failed before the fix; all pass after it.

**Verified.** Red before, green after, then 27/27 test files pass.

**Verified IN PRODUCTION**, not merely pushed: `servecleaning.com/portal.js`
line 280 now serves `add(bodyEl, planCard(model.plan))`, confirmed by
fetching the deployed file after the Pages build landed (~15s). The Apps
Script side was verified the same way before any of this was written — the
health endpoint answered version `2026-09-13 r40`, which is what ruled the
server out as the cause.

**STILL QUEUED, unchanged:** confirm & schedule (with a slot reader for /h),
the same-provider request, reschedule/cancel with the anchor as source of
truth, then the portal settings tab.

---

## Current work — 2026-09-13, Claude Code: r40, a plan is found by lead_id

**Committed, NOT deployed.** Paste `apps-script/webhook.gs` into Leads MASTER.
No backfill re-run is needed — the ten plans r39 already wrote become visible
the moment this is pasted.

**The bug.** r39's backfill wrote ten plans and not one appeared in a portal.
They were correct rows that matched nobody: the backfill read `contact_id` off
the JOBS row, and `clientRecurringPlan` matched on it.

**Why that was wrong, and it is written down a few hundred lines above the code
that got it wrong.** The portal chain is `contact_id -> LEADS -> lead_id ->
every JOBS row with that lead_id`, and the comment there says it exists
precisely to avoid depending on `JOBS.contact_id`. That column is not reliably
populated: it self-backfills onto LEADS for older rows and never onto JOBS. So
every plan built from a booking taken before that column was filled carried a
blank contact and was invisible — which is every booking the founder had.

**The fix.** Plans are matched on `lead_id`, JOBS's own join key, which is
always present and is the same seam `getContactBookings` uses. Both sides are
trimmed and lower-cased, because a lead_id is an email and case drifts between
a form and a sheet. `contact_id` stays on the row as reference data; it is
simply no longer what anything matches on. Nothing needed repairing.

**A test that would have silently stopped testing.** The r38 isolation check
("another contact plan is not visible here") distinguished rows by `contact_id`
while leaving the default `lead_id`. Under lead matching that row becomes
VISIBLE, so the fixture now differs by `lead_id` — otherwise the assertion
would have kept passing while no longer testing isolation at all.

### THE RULE THIS RELEASE EARNED: never dereference a value a mutation can null

Four of five r40 mutations first reported MISSED for ONE reason. r38's
whitelist assertion did `Object.keys(P21.plan)`, and any mutation that stops
plans matching makes that null — so the file THREW at that line and died before
reaching the r40 assertions that would have failed honestly. The guards were
fine; the file never got far enough to exercise them.

That is the THIRD instance of this shape in one day: r37's `byClass(...)[0]`,
r39's `rows[0]`, and now this. A crash proves nothing about the assertion that
crashed, and worse, it silently disarms every assertion after it in the file.
Read through `|| {}` / `|| []` in any assertion whose subject a change could
remove.

**Two mutations of mine were also wrong, and are recorded rather than quietly
fixed.** One weakened the row comparison to prove the blank-lead guard, but
`if (!want) return null;` returns before the loop, so it could never express
itself — blank leads are defended twice and it was deleted rather than propped
up with a contrived test. The other stripped normalisation from the CALLER side
while the fixture's caller value was already clean, so it changed nothing; it
now targets the ROW side, and the caller side gained a direct assertion of its
own. Both sides of that comparison are now covered.

**Verified.** 26/26 test files pass. Five deliberate mutations, each failing a
specific assertion: matching on contact_id again (the r39 bug restored), a
blank lead matching every plan, the stored lead no longer trimmed and
lower-cased, the asked-about lead no longer normalised, and the portal asking
by contact instead of lead. webhook.gs restored.

**STILL QUEUED, unchanged:** confirm & schedule (with a slot reader for /h),
the same-provider request, reschedule/cancel with the anchor as source of
truth, then the portal settings tab.

---

## Current work — 2026-09-13, Claude Code: r39, plans for earlier bookings

**Committed, NOT deployed. Two steps, and the second is run once by hand:**

1. Paste `apps-script/webhook.gs` into Leads MASTER.
2. Run **`backfillRecurringPlans()`** from the editor, once.

**Why it exists.** `createRecurringPlan` is called from `doPost`, so it only
ever sees NEW bookings. Every clean already sold with a cadence — including the
founder's test booking, which is what reported this — has no plan row and shows
no prompt in the portal. r38 was working correctly; there was simply nothing for
it to show.

**What the backfill does.** Walks JOBS, and for every past booking that is a
first clean carrying a real cadence, offers a plan. Reads JOBS and writes only
RECURRING_PLANS: no booking is touched, no slot held, no vendor assigned. Prints
a count of offered / already had one / one-off / not a first clean.

**Safe to run twice.** `planAlreadyOffered()` refuses a booking that already has
a plan, and the second pass reports it. This is the direct caller that guard
exists for — `doPost` answers a replayed submission upstream and never reaches
it, which is what the r38 MISSED mutation exposed.

**The window runs from the backfill, not the original booking.** Seven days
measured from a clean sold last week would arrive already expired, which is not
an offer at all.

**TWO DEFECTS FOUND BY THE SUITE, both worth remembering.**

1. **A version stamp must carry exactly ONE `rNN`.** The stamp read `r39 —
   plans for the bookings before r38`. THREE suites parse that line:
   `webhook-routing` uses a lazy `.*?` and read r39, while `geo-pricing` and
   `sms-consent` use a greedy `[^\n]*` and read the LAST match — the r38 in the
   prose. Both reported `["38","39"]` and failed. Describe the release in the
   header body, never on the stamp line.
2. **The missing-tab branch called `ss.getName()` and threw.** The one path
   whose entire job is to say "create the tab first" answered `TypeError:
   ss.getName is not a function`. Caught, so nothing corrupted, and useless
   exactly when needed. Not every workbook object provides it.

**Two test-harness defects of mine, same shapes as before.** The backfill
assertions indexed `rows[0]`, so a mutation that wrote no plan threw and took
every later assertion in the file with it — it counted as "caught" only because
a FAIL printed first, which is luck, not evidence. And the mutation file
anchored on a line that an earlier fix in the same release had already
rewritten, so that guard went unproven until the anchor was updated.

**A harness gap worth knowing.** `JOBS_HEADERS` in webhook-routing.test.js has
no `quote_meta`, `contact_id` or `property_id`, so a row written by `post()`
carries no cadence price and no contact. The backfill fixture seeds all three by
hand and asserts the recovered price AND contact_id — a plan with no contact_id
can never reach anybody's portal, so "a plan was written" alone would pass while
proving nothing.

**Verified.** 26/26 test files pass. Four deliberate mutations, each failing a
specific assertion: the cadence never read off the row, the quoted price not
recovered from quote_meta, the plan written without its contact, and a missing
tab passed over in silence. webhook.gs restored.

**STILL QUEUED, unchanged from r38:** confirm & schedule (with a slot reader for
/h), the same-provider request, reschedule/cancel with the anchor as source of
truth, then the portal settings tab.

---

## Current work — 2026-09-13, Claude Code: r38, a plan is an offer not a booking

**Committed, NOT deployed, and it needs a TAB CREATED before it does anything.**

1. Paste `apps-script/webhook.gs` into Leads MASTER.
2. Create a `RECURRING_PLANS` tab in **Leads MASTER** with row 1 exactly:
   `plan_id · contact_id · lead_id · origin_job_id · property_id · frequency ·
   quoted_price · created_at · expires_at · status · anchor_date · anchor_time ·
   preferred_vendor_id · confirmed_job_id`

Until that tab exists nothing happens at all — no plan is recorded and the
portal shows no prompt. That is the designed failure, not a bug: a missing tab
costs the plan and never the booking.

**THE FOUNDER'S DESIGN DECISION, recorded because it shapes everything after.**
A customer who books a first clean and picks a cadence has asked for ONE clean
and expressed an intention about the rest. The plan therefore writes **no JOBS
row, holds no availability slot and assigns no vendor**. A slot held for a clean
nobody confirmed is a slot a paying customer could have had. It becomes a real
booking only when they confirm it and choose a time in their portal.

**What r38 ships:** the plan is recorded in RECURRING_PLANS at booking time and
shown in the portal as an offer — the cadence, the price they were quoted, and
the date the price is held until. Seven-day window. Columns and rules are in
SCHEMA.

**The price needed no new capture.** `recurring_weekly` / `recurring_biweekly` /
`recurring_monthly` have been written into `quote_meta` on every first clean
since the calculator shipped, so the plan quotes what the customer was actually
shown rather than a number recomputed later against today's table.

**Nothing ever writes `expired`.** `planStatus()` compares the window against
now on every read, so a lapsed plan simply reads as gone — no nightly trigger to
fail silently, no stored state drifting while nobody looks. Both sides are
parsed, not compared as text, because the stamps carry an offset.

**The card is display-only on purpose.** Confirm-and-schedule is the next
release; a button that does nothing is worse than no button.

**A MISSED mutation worth remembering.** Disabling `planAlreadyOffered()`
changed no test. Cause: `doPost` answers a duplicate `submission_id` and returns
BEFORE `createRecurringPlan` is ever called, so the replay assertion was passing
on the upstream guard and my comment claiming "a retried submission reaches
this" was false. The guard is kept — it stops being decorative the moment there
is a second caller, which is confirm-and-schedule and any backfill over bookings
taken before r38 — and is now described honestly and exercised by a direct test.

**`writeRow` is called with an explicit empty map** for this tab. It otherwise
translates keys through `HEADER_MAP`, which is built for JOBS: `quoted_price`
and `frequency` are real columns here, and a future entry there could silently
rewrite one into a column this tab does not have, where writeRow drops it and
logs a line nobody reads.

**Verified.** 26/26 test files pass. Seven deliberate mutations, each failing a
specific assertion: a lapsed window still reading as open, an unreadable window
silently expiring an offer, one customer seeing another's plan, a confirmed plan
offered again, a one-off booking offered a plan, the same plan offered twice to
one booking, and a move-out sold a recurring plan. webhook.gs restored.

**STILL QUEUED, in the founder's order:**
- **Confirm & schedule.** A button on the plan card that pulls open slots from
  the AVAILABILITY feed and creates the real booking. `/h` has no slot reader
  today — `booking-live.js` is only a poller — so it needs one, reusing the
  site's `filterSlots` horizon rules rather than a second implementation.
  Confirmation should synthesise a booking-form payload and drive
  `buildJobRecord`, NOT grow a parallel way to create a job. Mint the
  `submission_id` deterministically from the plan so a double-tapped button
  dedupes through the existing `alreadyWritten` guard into one booking.
- **"Same service provider" request** — writes `preferred_vendor_id`, a dispatch
  preference and never a promise shown to the customer.
- **Reschedule / cancel** per upcoming booking. The ANCHOR is source of truth:
  a one-off reschedule moves that visit only, and the next is counted from the
  anchor rather than from the visit that moved.
- **Then** a settings tab in the portal for the plan and home layout.

---

## Current work — 2026-09-13, Claude Code: r37, what a booking actually includes

**Committed, NOT deployed.** Paste `apps-script/webhook.gs` into Leads MASTER.
The site half ships on push. Either order: the payload gains a field the old
pages ignore, and the new pages render nothing without it.

**Each booking on /h and /j now carries a closed "What's included" dropdown**,
listing what that booking's own service covers, with paid add-ons named
separately underneath. Closed by default — someone opening their portal wants
the date and the price; what a deep clean covers is the second question.

**`SERVE_SCOPE` moved out of `script.js` into `serve-scope.js`.** It had to:
/h and /j carry a signed token and deliberately load nothing from the marketing
bundle, so the data was unreachable from the two pages that most needed it. The
file's own comment had said "one source, three consumers" since it was written.
Four pages load it now and three `cp` lines publish it.

**The renderer lives there too, not in the two pages.** Same reason
`scheduleHead` lives in one file: two pages building their own version of a
block is how they drift into describing one booking differently. Both call
`ServeScope.block()`, and a test asserts neither owns a copy.

**NOT the booking-flow accordion.** `INCLUDED_FIRST` in script.js only knows
First vs Move-out and has no recurring column, so it cannot describe a
recurring booking. `SERVE_SCOPE` has all three. Anyone tempted to unify them
should start from SERVE_SCOPE, not from the accordion.

**Named "What's included", not "Scope".** The partner ticket already has
`section('Scope')` and it means the rooms and their instructions.

**Lists are flat, not grouped**, because the group labels carry HTML entities
(`Bedrooms &amp; living`) that are correct for the matrix's innerHTML and would
render literally through textContent, which is how the token pages build nodes.

**CORRECTION to what r37's commit message says.** It claims the portal booking
row "gained `serviceCode`". It did not — that key was already there, and r37
only started USING it. Worse, the patch added a SECOND copy of the key to the
same object literal: legal JavaScript, last one wins, so everything worked and
no test could see it. Removed. The commit message is pushed and stands as
written; this is the correction of record.

Cause, because it will repeat otherwise: the check was `grep -n 'serviceLabel:'
-A 10`, and `-A` prints only the lines AFTER a match. The existing key sat
directly ABOVE the line searched for and was invisible. Use `-B` as well as
`-A` before concluding a field is absent from a view model.

What is true: the label is prose and may be reworded, the code is the join
into SERVE_SCOPE, and an unknown code renders NOTHING rather than another
service's promises.

**Three test bugs of mine in this one, all worth remembering.** (1)
`ticket-render.test.js`'s `t()` is DEEP EQUALITY — `t(label, got, want)` —
while `portal.test.js`'s is a boolean. Eight assertions written in the wrong
idiom compared `true` against `undefined` and failed while the thing they
checked was correct; there is now a note in the file. (2) The render assertions
indexed into `byClass(...)[0]` , so a mutation that emptied the list CRASHED the
suite instead of failing — a crash proves nothing about whether an assertion
bites. Every lookup degrades to an empty node now. (3) The mutation runner
matched the `ok()` wording rather than the `fail()` wording and reported a MISS
on a mutation the suite had caught.

**Verified.** 26/26 test files pass. Five deliberate mutations, each failing a
specific assertion: an unknown service falling back to the deep list, a
recurring clean reading the deep column, paid add-ons promised as included, the
add-on heading losing its class, and the portal not rendering the block at all.
`serve-scope.js` and `portal.js` restored afterwards.

**STILL QUEUED from the same request, in the founder's order:**
2. A projected next recurring visit when a first clean is booked with a plan
   (weekly +7d, biweekly +14d, monthly +1 month, same time). r36 put
   `frequency` in the portal payload, which is the input it needs.
   **OPEN DECISION, put to the founder and not yet answered:** is that second
   visit a REAL JOBS row or a PROJECTION? A projection has no vendor, no slot
   and no price, and item 3 cannot cancel or reschedule what is not a row.
3. Cancel and reschedule per upcoming booking, reschedule tied to the
   AVAILABILITY feed with an earlier/later fallback. Asked for last.

---

## Current work — 2026-09-13, Claude Code: r36, the cadence does not rename the visit

**Committed, NOT deployed.** Paste `apps-script/webhook.gs` into Leads MASTER.
No site files changed, so the push is independent of it.

**Reported from a real test booking.** A customer chose a First Clean AND a
recurring cadence, and his portal titled the upcoming visit "Recurring clean".
The visit he is about to receive is a deep clean; the recurring part starts
after it.

**Cause.** `serviceCodeOf()` asked the frequency before it asked what was
booked, so any first clean sold with a plan resolved to `CLEAN_STANDARD`. The
docblock directly above it has described the correct rule since it was written
— "a First Clean on a biweekly plan is the start of a recurring relationship,
and a First Clean on its own is a deep clean" — and only the order of two lines
disagreed with it. Same shape as the availability.gs header in r33: the prose
was right and the code was not.

**THIS MOVED A DISPATCH DECISION, not just a label.** `serviceCodeOf` has two
callers. One is `getBooking`, which is the label on every surface. The other
feeds `bookAvailabilitySlot`, which passes it to `slotRank(vendorId,
serviceCode)` — so bookings of this shape were being matched against vendors
who declared `CLEAN_STANDARD`, and are now matched against `CLEAN_DEEP`. A
partner who offers standard but not deep no longer ranks first for a first
clean. That is the correct behaviour — it is deep-clean work — but it is a live
change to who gets sent. **Prices are untouched**: they are stamped on the JOBS
row at booking and never derived from this function.

**The portal booking row now carries `frequency`.** A deliberate whitelist
addition: naming the service correctly still does not explain why someone who
asked for weekly upkeep is looking at a first clean, and the projected
recurring visit (queued below) cannot be derived without the cadence. The
per-job ticket has carried it since r14; only the portal row left it out.

**The dispatch suite was realigned, and the interesting part is not the
failures.** `tests/slot-dispatch.test.js` books a First Clean on a biweekly
plan and its premise comment asserted that resolves to `CLEAN_STANDARD` — the
bug, written down as the fixture's starting assumption. Three assertions failed
honestly. FOUR MORE WERE PASSING FOR THE WRONG REASON and are the ones worth
remembering: under `CLEAN_DEEP` those vendors are disqualified for declaring a
*different service*, not for the flag each test is actually about — 2d stopped
exercising `active=FALSE`, 2e tied two DISQUALIFIED vendors instead of two
qualified equals, and 2f stopped exercising `offers=FALSE`. All seven updated,
with the false premise comment rewritten.

**Verified.** 26/26 test files pass. Three deliberate mutations, each failing a
specific assertion: restoring the reported bug (cadence decides again), making
every booking a deep clean, and letting move-out stop being decided first.
webhook.gs restored afterwards.

**QUEUED — the rest of the same request, in the founder's stated order:**
1. A scope dropdown on each booking ticket, rendered per service from
   `SERVE_SCOPE`. It lives in `script.js` (which `/h` and `/j` never load), so
   this means extracting it to `serve-scope.js` loaded by all four pages,
   adding it to three `cp` lines in build-site.sh, and concatenating it in
   `pricing-and-services.test.js`, which reaches it by slicing script.js.
   NOTE: the booking-flow accordion (`INCLUDED_FIRST`) only knows First vs
   Move-out and has no recurring variant, so it cannot be the source.
2. A projected next recurring visit when a first clean is booked with a plan
   (weekly +7d, biweekly +14d, monthly +1 month, same time).
   **OPEN DECISION, ask the founder before building:** is that second visit a
   REAL JOBS row or a PROJECTION? A projection has no vendor, no slot and no
   price, and item 3 cannot cancel or reschedule something that is not a row.
3. Cancel and reschedule buttons per upcoming booking, reschedule tied to the
   AVAILABILITY feed with an earlier/later preference fallback. The founder
   asked for this one last.

---

## Current work — 2026-09-13, Claude Code: r34 and r35, the partner card

**r34 is committed, pushed (`0b3d711`) and NOT yet deployed. r35 is committed
and needs the same paste.** Both are `apps-script/webhook.gs` → Leads MASTER.
Either order with the site push: an un-normalised value renders no worse than
before on the new card, and the new values render correctly on the old one, so
there is no regression window.

**r34 — `partner_since` was a date cell too.** The card read `"With Serve since
" + partnerSince` and `getVendor` filled it with `String(v.partner_since)`.
`opsRow` reads with `getValues()`, so an operator formatting that column hands
back a Date and the card said `With Serve since Wed Jul 01 2026 00:00:00
GMT-0400 (Eastern Daylight Time)`. THIRD appearance of one fault: r23 on the
JOBS cells, r32 on how they are read, and this is the OPS workbook, which
neither reached. Every Ops cell has always been raw. Normalised in `getVendor`
through that workbook's own timezone, and only when the cell really is a Date —
a plain `"2024"` is untouched. The card renders `July 2026`.

r34 also made a rating name its source. `public_rating` and `rating_source`
already existed and the card rendered `4.8★ (127)` while ignoring the source, so
a number borrowed from Google sat beside Serve's name as though it were Serve's
own score. It now reads `4.8★ (127) on Google`.

**r35 — VENDOR_REVIEWS and VENDOR_PHOTOS.** Two new Ops tabs, read through the
same `buildClientVendorProfile` whitelist as everything else a customer may
learn about a company. Columns and rules are in SCHEMA. The founder fills them
by hand; reviews come from anywhere public (Google, a company's own site, a
forum) and each row carries its own `source`.

**Two guards, because these cells are typed by hand and land in a browser.**
`source_url` must be http(s), or a `javascript:` URL in a cell becomes a live
script on a customer page. `image_url` must be a same-origin `/images/…` path,
or a photo row could load a tracker from another host. Both drop the offending
value and render everything else.

**Neither tab is writable by a vendor**, structurally: the portal write path
knows three kinds and none of them names these tabs.

**A test bug worth remembering.** The r18 section signs off by pointing the
assigned booking at VEN-0002, whose `client_visible` is FALSE, to prove that
renders no card — and never points it back. Every r35 assertion appended after
it therefore read a booking with no partner and passed vacuously on empty
lists until the fixture was pointed back at VEN-0001. Anything added at the end
of that file inherits the same trap.

**Also:** `clientVendorReviews`/`clientVendorPhotos` memoise per script
execution, which in production is per request. `tests/portal.test.js` runs every
request in one persistent vm scope, so it resets `vendorExtrasMemo` between
simulated requests — otherwise it reads a list cached before the rows existed.

**Verified.** 26/26 test files pass for both releases. r34: three mutations.
r35: five, covering both URL guards, both `client_visible` filters, and the
link's `rel="noopener noreferrer"`. Every file restored afterwards.

**Next:** paste r35 into Leads MASTER, create the two Ops tabs with the columns
in SCHEMA, and drop photo files into `images/vendors/`.

---

## Current work — 2026-09-12, Claude Code: r33 / avail r3, the slot keys read the same way

**Committed, NOT deployed. Two projects to paste, not one:**
`apps-script/availability.gs` → the **OPS** workbook, `apps-script/webhook.gs` →
**Leads MASTER**. No site files changed, so the git push is independent of both.
Either order is safe *today* (see below); if a workbook timezone ever drifts,
both must be in before it does.

**This was NOT a live bug, and that is load-bearing.** The live feed
(`/api/slots`) emits a `warning` whenever either Ops setting is not
America/New_York. It returns none, so the Ops **spreadsheet** and the Ops
**project** are both New York; the r31 log already showed the Leads project is
too. All three agreed, so local getters and the workbook agreed, and every
published slot and every write-back key was correct. Old and new rules derive
**identical** keys on the current configuration — which is exactly why this was
a safe change to make now rather than after something drifted.

**What was actually wrong: the model was documented backwards.**
availability.gs's header claimed Apps Script builds a date cell from the
PROJECT timezone, so local getters round-trip "whatever the timezone happens to
be". They do not — Sheets builds it from the SPREADSHEET's, which is what r32
proved on Leads MASTER. The same false claim was repeated in
`tests/availability-contract.test.js` and in webhook.gs's `slotDateKey`
docblock. The system was therefore correct by coincidence: it needed three
settings to agree (Ops workbook, Ops project, Leads project) while its own
documentation said none of them mattered.

**Why no test could catch it.** The suite's `{sheetTz: "Australia/Sydney"}`
fixture changed what `getSpreadsheetTimeZone()` REPORTED without changing the
cell instants — a state Sheets can never produce — so "published dates
unchanged under a wrong spreadsheet timezone" passed under either model. It is
now built from instants that correspond to the declared zone, and asserts the
published day is the day somebody typed.

**What changed.** availability.gs gains `sheetTimeZone()` (mirroring
webhook.gs's), `ymd(d, tz)` and `parseTime(v, tz)` format through it, doGet
passes it, and the lead-time comparison is rebuilt from the same `dayKey` so the
published label and the horizon check can never describe different days.
webhook.gs gains `slotDateKey(v, tz)` / `slotTimeLabel(v, tz)` and threads
`sheetTimeZone(ops)` through all five call sites; `findOpenSlot` splits its
chained `openById(...).getSheetByName(...)` so the workbook object is in hand.
Local getters remain the fallback where no timezone can be read.

**Two harness bugs of mine, found by the failures and fixed honestly.** (1) The
1899 time fixture was built with the host's real 1899 New York offset (−5:00)
while the harness formats with a flat −4:00, so a round-trip that is correct in
production read 11:30 AM; it is now built through the same offset it is read
with. (2) `FORMAT_CALLS` is module-level and accumulates across every fixture,
so "every call used the spreadsheet timezone" also saw the happy path's New York
calls; it is now scoped to the Sydney run.

**Verified.** 26/26 test files pass. Six deliberate mutations, each failing a
specific assertion: the feed formatting through the project timezone, never
asking the workbook for its timezone, not passing it into the day key, the two
scripts drifting apart on the clock, the webhook reading slot dates with local
getters, and the write-back not passing the Ops timezone on. A seventh attempt
was refused as ambiguous — r32's `dateCellText` and r33's `slotDateKey` carry a
byte-identical formatDate line — and was re-anchored to its function rather than
left unproven. Every file restored afterwards.

**Still open (unchanged by this, and documented in the file).** The lead-time /
horizon comparison weighs a wall-clock slot against the current instant, which
is only meaningful when the Ops PROJECT timezone is the business one. A mismatch
skews the 18-hour boundary; it corrupts no published date. Warned, not fatal.

---

## Current work — 2026-09-12, Claude Code: r32, dates read through the workbook's timezone

**r32 shipped 2026-09-12** — script pasted into Leads MASTER first, then the
site pushed (`88be7d1`), in that order because pushing the site first would
have left every ticket showing ONE date that was still the wrong one, with the
correct prose summary no longer printed beside it.

**The bug the founder reported.** Vendor and client tickets for the newest test
booking read `Thu, Sep 17 · 12:30 AM ET · Friday, Sep 18 at 3:30 PM` — three
fields of one booking disagreeing, and the two that came from cells were both
wrong.

**Root cause, confirmed by the live `checkBookingDates` log.** Leads MASTER’s
spreadsheet timezone was **Australia/Sydney**; the Apps Script project and the
business are America/New_York. Sheets builds a date cell’s instant from the
SPREADSHEET’s timezone, and r23 read that instant back with local getters,
which are the PROJECT’s. The two agreed only while the two settings did. The
cells were correct the whole time — the log showed `displayed "2026-09-18"` and
`displayed "3:30 PM"` — so nothing in the sheet needed repairing.

**What r32 changes.** `dateCellText(v, tz)` and `timeCellText(v, tz)` format
through the workbook’s own timezone via `sheetTimeZone(ss)`, recovering what was
typed whatever either setting is. A workbook that cannot report one falls back
to local getters — the pre-r32 behaviour, never a guessed zone. `getBooking`
passes it, and so does `checkBookingDates`, so the diagnostic can never report a
different day than the slip it is being used to explain.

The ticket header now shows ONE date. It used to print day, then time, then the
schedule summary, deduping only when one string contained another — which they
never do, so a slot booking printed its date twice and, while this bug was live,
printed two different dates. `notes` is prose the script writes for bookings
with no date, so it is now the fallback rather than a second opinion. One
behaviour was deliberately dropped: a summary saying something genuinely new no
longer appears beside a real time. Its test was updated, not deleted. Sizes
rebalanced with it — `.tk-day` 0.7→0.82rem, `.tk-time` 1.75→1.45rem.

**STILL OPEN, and it is customer-facing: `availability.gs` has the same fault.**
Its header documents the OPPOSITE model and its tests encode that belief, so the
slot feed customers book against is likely reading dates the same wrong way and
its suite cannot catch it. `tests/availability-contract.test.js` already has a
`sheetTz` option, which is the hook for fixing it. Not touched in r32.

**Verified.** 26/26 test files pass. Seven deliberate mutations each failed a
specific assertion: the date and the time formatted through UTC instead of the
sheet zone, the workbook never asked for its timezone, `getBooking` no longer
passing it on (the original bug, reintroduced), the diagnostic drifting off the
ticket’s reading, and the header summary both printed beside a time and dropped
as a fallback. Every file restored afterwards.

`tests/vendor-portal.test.js` and `tests/webhook-routing.test.js` were left
alone on purpose: the first seeds date cells as text, which never reaches the
timezone path, and the second’s workbook stub reports no timezone and calls the
helpers with one argument. Both keep the local-getter path byte for byte.
`tests/portal.test.js` had to change — its workbook already reported
America/New_York, so its `formatDate: (d) => String(d)` stub would have started
returning raw Date strings. It now formats the two real patterns through the
timezone it is handed and keeps `String(d)` for every other pattern, because
job ids and ISO stamps are formatted on paths those tests are not about.

**Next:** (1) paste r32 and save, (2) push the site, (3) set Leads MASTER’s
timezone to New York under File → Settings → Time zone and check the Ops
workbook while there — the reading no longer depends on it, but the two should
agree, (4) fix `availability.gs` and its tests.

---

## Current work — 2026-09-11, Claude Code: the access-code migration is DONE

**Migrated in production, 2026-09-11 17:17 ET** (the founder ran it from the
editor): `Access migration complete. Properties checked: 2; codes transferred:
0; legacy code columns: 0.` The migration verifies the legacy `entry_code`
column is gone before it reports success, so Leads PROPERTY_ACCESS no longer
has it and has `entry_code_saved` instead. No customer door code ever had to
move — there were none.

**Pre-flight immediately before (17:16 ET), all green:** Access MASTER
configured and separate, required columns present; 2 homes and zero codes kept
as text, numbers or dates; no duplicates; no clashes; no dates in Access
MASTER; and **`Write round trip: OK`**. That settles the one thing no local
test could prove: on the real workbook, a code written as text with a leading
apostrophe into a plain-text cell reads back exactly, so r28's save path works.

**Configuration now in place, in Leads MASTER's bound Apps Script project:**
`ACCESS_SPREADSHEET_ID` → Access MASTER, `ACCESS_CODES_TAB` → `ACCESS_CODES`.

**What went wrong on the way, so nobody repeats it.** The check reported NOT
READY three times. The cause was a stale `ACCESS_CODES_TAB` = `Sheet1` in the
Leads-bound project's Script Properties, while the corrected value had not
landed in that project — most likely it was saved in a different Apps Script
project, where it did nothing. After the stale row was deleted, the check said
"not set" with no similar-name warning, which rules out a lookalike property in
the Leads project. **Script Properties are per project, and the only one that
matters is the project bound to Leads MASTER** (Extensions → Apps Script):
`SPREADSHEET_ID` is "" and the webhook finds Leads through that binding. r29's
message could not tell the causes apart; r30's named the stale value on its
first run.

**Pending, for the founder to confirm:** the post-migration check reading
`ABSENT (already migrated)`, and one real portal entry save landing in
`ACCESS_CODES` and not in Leads. Portal entry saves should now pass r28's gate,
but that is unverified until the test save. The live web app is still r29,
which is identical to r30 for everything the web app touches; deploy r30 to the
EXISTING deployment so the version string matches the repo.

---

## Current work — 2026-09-11, Claude Code: r30, and what the live check showed

**r30 is committed and pushed, NOT deployed.** It changes only the editor-run
`checkAccessMigration`: when Access MASTER is not ready, it now names the fault
instead of one sentence covering seven causes. Nothing a customer or the web app
touches differs from r29. A function run from the editor uses the saved source,
so r30's check works as soon as it is pasted and saved; deploy it to the
EXISTING deployment afterwards so the live version string matches the repo.

**Production observations, 2026-09-11 — the founder ran the check on r29 twice
(15:42 and 15:50 ET on their clock):**
- Leads PROPERTY_ACCESS holds **2 homes and ZERO legacy codes** — no codes kept
  as text, numbers or dates. The migration has nothing to transfer and nothing
  to corrupt; it only swaps the legacy `entry_code` column for
  `entry_code_saved`. The date and number risks r29 guards against do not apply
  to this data.
- Access MASTER reported NOT READY both times, the second after the founder had
  been given the setup steps. Cause unknown — which is why r30 exists. Not yet
  resolved.
- The migration has NOT run, so r28's gate still refuses every portal entry
  save. Occupancy, parking and pets save normally.
- Between the two runs the webhook `/exec` URL returned `HTTP 404` ("Sorry,
  unable to open the file at this time") on two attempts about a minute apart,
  lining up with the founder deploying r29. It recovered by itself and then
  reported r29; a portal read through servecleaning.com returned the healthy
  `not_found`, and the separate availability feed answered normally. Cause not
  proven. A booking attempted in that window would have been shown an error,
  never a false confirmation.

**Next:** paste r30 and save, run `checkAccessMigration`, fix whatever it names,
and repeat until it prints `Write round trip: OK`. Then run
`migratePropertyAccessCodes` (expect `codes transferred: 0`), the check once
more (`ABSENT (already migrated)`), and one real entry save from a portal.

---

## Current work — 2026-09-11, Claude Code: r29, a review of r28's access-code migration

**r28 IS LIVE — this supersedes the "NOT LIVE" line in Codex's entry below.**
`curl -sL` on the webhook URL returned `"version":"2026-09-11 r28"` on
2026-09-11, after Codex wrote that entry. r28 contains r26 and r27, so the
booking text is live too, and inert until the three Twilio Script Properties
exist.

**What that means while the migration has not run:** r28's gate refuses every
save to the portal's entry question — "I'll let you in" as well as codes —
because every entry save goes through the private store, and it refuses while
Leads still has the legacy `entry_code` column or Access MASTER is not
configured. No customer can reach "Complete" on Arrival & access until this is
finished. Whether the Script Properties are set, or the migration has run, is
UNVERIFIED from here: neither is visible without the founder's Google sign-in.

**What the review found, and r29 fixes (committed and pushed, NOT deployed):**
- Before r28 a code was saved with a plain `setValue` into an Automatic-format
  cell, and Sheets converts what it is given: `0042` was kept as the NUMBER 42,
  and `12/25` could become a DATE. r28's migration copied the cell's string, so
  a date would have been written into Access MASTER as "Fri Dec 25 … GMT-0500"
  and kept as the door code while the source column was deleted. r28's tests
  could not see it: their fake sheet stores '0042' as a string, which is what
  the old code SENT, not what a real sheet KEPT. The migration now refuses any
  date (home named, value never printed) and names every number-coded home,
  because a lost leading zero cannot be recovered from the sheet.
- r28 writes codes as text with a leading apostrophe and verifies the read-back.
  The fake sheet strips that apostrophe, which is r28's assumption about real
  Sheets; nothing local can prove a plain-text cell does. If it keeps it, every
  portal code save is refused — safely, because the verification catches it,
  but refused. New editor-only `checkAccessMigration()` settles it on the real
  workbook with one synthetic `0042` written through the real save path under
  `__serve_probe__`, read back, and removed. Otherwise it changes nothing in
  Leads and prints counts and property IDs only: configuration, the legacy
  column present or gone, codes kept as text / numbers / dates, duplicates,
  clashes with Access MASTER, and — after a migration — any date already
  copied in.
- Codex's entry committed the founder's personal email address, which failed
  `privacy.test.js`. Removed. History was not rewritten; the repo is private.

**Verification:** 26/26 files pass. 23 new assertions in portal.test.js "5c",
driven with the values a real sheet holds — the number 42 and real Date objects,
not strings. Five deliberate mutations each failed a specific assertion (the
date guard removed, the probe row left behind, the pre-flight printing codes,
number-coded homes not named, the probe ignoring a failed read-back) and the
file was restored. Nothing here has touched a real sheet.

**Run order for the founder. Nothing in it prints a code.**
1. Paste r29 → Deploy → Manage deployments → edit the EXISTING deployment →
   New version. `curl -sL` on the webhook URL should show
   `"version":"2026-09-11 r29"`.
2. In Access MASTER, pick the tab that will hold codes; it needs (or will be
   given) `property_id`, `access_secret`, `access_secret_set_at`. Confirm the
   workbook is shared with nobody who routinely reads Leads.
3. Script Properties: `ACCESS_SPREADSHEET_ID` (from the Access MASTER URL, the
   part between `/d/` and `/edit`) and `ACCESS_CODES_TAB` (that tab's name).
4. Run `checkAccessMigration` from the editor and read the execution log.
   - "Write round trip: FAILED … Do not migrate" → stop, and bring the log line
     back to whichever agent is working; the save path has to change first.
   - Homes under DATES → get the real code from that customer, retype it in
     PROPERTY_ACCESS as text (start it with an apostrophe), run the check again.
   - Homes under NUMBERS → fine to migrate, but confirm those codes with the
     customer; a leading zero may already be gone.
   - Anything under "clash" or "Duplicate" → resolve by hand first.
5. Run `migratePropertyAccessCodes`, then `checkAccessMigration` again: legacy
   column ABSENT, no dates in Access MASTER.
6. Save one entry answer in a portal for a property you control, to confirm
   saves work end to end.

Clearing cells does not erase a spreadsheet's version history; Codex's note on
remaining exposure stands.

---

## Current work — 2026-09-11, Codex: isolate portal entry codes

Local r28 implementation complete. Founder explicitly authorized routing portal
codes to the existing Access MASTER workbook and removing the code column from
Leads PROPERTY_ACCESS. All 26 test files passed; the added verification-failure
case also passed on a focused rerun. Two deliberate mutations (skip private
write verification, overwrite conflicting private code during migration) were
caught. Preserved the other agent's now-committed r27 SMS changes.

**NOT LIVE: no Google Sheets edits, migration, or Apps Script deployment.**
Google Drive in the browser panel is signed out; Chrome is unavailable through
the browser tool. Asked the founder to sign in to the Serve Google account. Last verified
live backend remains r25 (see prior entry). Do not claim code separation is live.

Next: inspect Access MASTER's existing tab and header names WITHOUT printing
codes. Configure Script Properties ACCESS_SPREADSHEET_ID and ACCESS_CODES_TAB
to that separate workbook and its appropriate tab (schema below). Back up and
compare the live editor before pasting r28. Update the existing deployment,
then run editor-only migratePropertyAccessCodes. It verifies all copies before
removing the legacy column, rejects conflicts and logs counts only. Entry writes
against the legacy schema temporarily fail safely until migration completes.
Verify the health revision, private destination schema, zero legacy columns,
and saved flags without exposing codes. Clearing cells does not erase version
history; if real codes were present, explain that remaining exposure.

## Current work — 2026-09-11, Claude Code: partner surfaces, the 85% share, unassigned capacity, the booking text

**Deployment state, exactly.** r22–r27 are committed and pushed. **Apps Script
live: r25**, verified 2026-09-11 with `curl -sL` on the webhook URL, which
returned `"version":"2026-09-11 r25"`. **r26 and r27 are NOT deployed; paste
r27**, which contains r26. The site half of r22 and the portal pay button are
LIVE — checked by fetching `vendor.js`, `ticket.js` and `portal.js` from
servecleaning.com and matching the new copy in each.

| rev | what | live |
|---|---|---|
| r22 | customer FIRST NAME on the partner ticket (never the vendor portal, never surname/email/phone); payout copy separates "agreed at dispatch" from "paid after completion and the photo check" — copy only, nothing mechanical releases money | yes |
| r23 | date/time cells an operator reformatted came back as JS Dates and rendered "Fri Dec 29 1899 22:00:00 GMT-0500"; normalised, and clock times now carry ET | yes |
| r24 | partner share = 85% of the ticket; source of truth is the Ops `SETTINGS` tab, key `payout_rate`; STAMPED per booking so a rate change never reprices an accepted job; `partner_payout` override still wins | yes |
| r25 | an AVAILABILITY row with a blank `vendor_id` is bookable unassigned capacity; ranks below every real vendor and above avoid/disqualified; the operator email says "NO VENDOR YET, AND THE TIME IS PROMISED" | yes |
| r26 | one SMS on booking — a sentence and the portal link — gated on consent, three Twilio Script Properties, a readable phone and a contact_id | no — superseded by r27 before it was ever deployed |
| r27 | r26 greeted "Hi Uriel — your…"; the em dash is outside GSM-7 and forced UCS-2, billing a 191-character text as 3 segments instead of 2 on every booking. Now a comma: pure GSM-7, 190 septets, 2 segments. With no first name the text now opens "Your…" rather than "your…" | **no** |

**SMS BILLING IS DECIDED BY THE ALPHABET, NOT THE LENGTH.** One character
outside GSM-7 — an em dash, a curly quote, a backtick — switches the whole
message to UCS-2 at 67 characters a segment instead of 153. r26's test checked
length only and passed at 191 characters. It now checks the alphabet and does
the real segment arithmetic, and putting the em dash back fails both
assertions. Keep the fixed wording in `bookingSmsText` plain ASCII. A customer's
own first name outside GSM-7 can still cost a segment; that one is theirs, not
a bug.

**VERIFY APPS SCRIPT WITH `curl -sL`, NEVER `curl -s`.** The `/exec` URL answers
`HTTP 302` with an empty body and redirects to googleusercontent.com, so the
`-s` form prints nothing at all — which reads as "no response", not "follow the
redirect". Every verification command given to the founder for r20–r25 omitted
`-L`. The health JSON is on the bare URL; `?ping=1` adds nothing.

**Two consequences worth knowing before anyone checks a booking:**
- r24 derives a payout only for bookings made AFTER r24 went live, because the
  rate is stamped at booking. Every older booking still reads "Amount confirmed
  at dispatch" and will keep doing so unless `partner_payout` is typed.
- Whether the Ops `SETTINGS` tab exists is unverified. It does not need to —
  the code falls back to 0.85 — but a changed rate only takes effect once it does.

**Nothing in r22–r27 has been exercised on a real production booking, and no
SMS has been sent.** All of it is proved against the shipped code in the test
harnesses; 26/26 files pass.

**Stale project rules, not edited:** CLAUDE.md's "Where the project actually
is" still says webhook.gs is at r19 with 23 test files. CLAUDE.md and AGENTS.md
carry uncommitted changes that are not this agent's, so they were left alone;
whoever claims the continuity section should correct those two facts with it.

**Next:** paste r27 and approve the new permission Google asks for ("Connect
to an external service") — r27 is the first code here that calls out to the
internet. Then Twilio: account, a number, A2P 10DLC brand and campaign
registration, and the three Script Properties `TWILIO_ACCOUNT_SID`,
`TWILIO_AUTH_TOKEN`, `TWILIO_FROM`. Then one real booking to confirm the text
arrives. The payment gaps remain queued under "NEXT UP — payments" below.

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

> **Superseded 2026-09-11:** the Stripe work was committed and pushed as
> `c22d360` and is live. Still uncommitted: the shared continuity section in
> AGENTS.md / CLAUDE.md (unclaimed across three sessions now) and
> `images/serve-logo-boston-9-09.svg`. Apps Script is **r21**, not r20 — the
> photo revision landed on top of the signed-quote one.

---

## NEXT UP — payments. Queued 2026-09-11 (Claude Code)

> **Substantially addressed 2026-09-15 by r50 — see the current-work entry at
> the top of this file.** Gaps **1, 2 and 3 are built** (not yet deployed), and
> three of the four founder decisions are taken. **Gaps 4 and 5 are still
> open**, as are refund terms and the partner response deadline. The
> `partner_payout` documentation gap under gap 1 is closed — it has a row in
> SCHEMA.md now. Each item below is annotated; the original text is kept
> because the reasoning still explains *why* each fix is shaped the way it is.

Nothing here is started. The payment path is LIVE in Stripe TEST mode from
`c22d360`; `/api/health` reports `can_price`, `can_sign`, `can_charge` true and
`stripe_mode: "test"`. These are the known gaps, worst first.

**Do not treat any of this as authorized to go live.** The key is `sk_test_`,
and the items under "founder decisions" below are unanswered.

### 1. Payment state is never written back — the biggest gap  ✅ BUILT (r50, not deployed)

Nothing records that a link was issued, opened, or authorized. `/api/checkout`
writes to no sheet; the only trace anywhere is one Worker log line,
`checkout session created: <job> <cents> TEST`, which Cloudflare keeps briefly.

**The visible consequence:** `payment_status` is OPS-owned and typed by hand
(SCHEMA #20), so both customer surfaces can show "Not yet authorized" to
somebody who has already paid.

The fix is a Stripe webhook — a new Worker route verifying Stripe's signature
against a `STRIPE_WEBHOOK_SECRET`, keyed on `metadata[job_id]`, writing status
back through Apps Script. **That makes `payment_status` script-written, which
is a SCHEMA change and a real decision**, since it is currently promised to
never be touched by the script. Either that promise changes in SCHEMA.md in the
same commit, or the webhook writes a new column instead.

**The column models two states and the flow now has three.** `paid` is derived
as `payment_status.toLowerCase() === "paid"` (webhook.gs ~1282), so the only
value any code recognises is the literal string `paid`, and everything else
means not-paid. Under authorize-at-booking the real sequence is **not
authorized → authorized (held, no money moved) → captured (money taken)**, and
there is no way to say the middle one. Writing `paid` on a mere hold tells a
customer they have been charged when they have not, and hides the Authorize
button. Found 2026-09-11 after the founder's first test payment. Whatever the
webhook writes has to carry this third state, in the column or beside it.

**Do not confuse the two money movements.** Customer → Serve is what
`/api/checkout` does. Serve → vendor is `partner_payout`, which nothing built
for payments touches. The customer never pays the vendor; the schema's
joint-employer constraint depends on that staying true.

**`partner_payout` is undocumented.** It is a real JOBS column written by
webhook.gs and it appears nowhere in SCHEMA.md, which breaks that file's first
rule. Needs a row and an owner before payouts are automated.

> **Closed 2026-09-15.** It has a row in SCHEMA.md now, owner **OPS**, beside a
> note on how it relates to `payout_rate` and why customer→Serve money and
> Serve→partner money must never be confused. (The claim that webhook.gs writes
> it was wrong: it is in `OPS_OWNED_COLUMNS`, so `setJobCells` throws on it.)

### 2. The idempotency key outlives the session it created  ✅ FIXED (r50, not deployed)

In `handleCheckout`, the key is `serve-<job>-<cents>`. Stripe caches the
**response body** against a key for 24 hours, so expiring a link and reissuing
it for the same job and amount replays the original — and the customer gets a
dead link. This is exactly the recovery path an operator reaches for after a
test booking.

**The obvious fix does not work.** Checking `session.status === "open"` reads
the cached body, which reports the status as it was at creation, not now. Use a
short time bucket in the key (a double-click needs seconds of protection, not a
day), or follow the create with a `GET /v1/checkout/sessions/{id}` to read the
current status and retry with a salted key when it is not open.

> **Fixed 2026-09-15 with the time bucket** — `serve-<job>-<cents>-<10-minute
> bucket>`. Ten minutes covers the double-click, the impatient reload and the
> back button; anything slower legitimately deserves a fresh session. The
> `worker-proxy.test.js` assertion checks the bucket width, not just the shape.

### 3. Nothing captures the hold  ✅ DECIDED (2026-09-15) — no code needed

`capture_method: manual` places the hold and there is no capture anywhere in
the system. The founder's decision is capture-on-partner-acceptance, so this
needs an operator action, not an automatic one.

> **Resolved 2026-09-15: the founder captures in the Stripe dashboard by hand.**
> An uncaptured payment shows a Capture button there. This deliberately builds
> nothing: an operator-only capture endpoint would be a second way to move real
> money that has to be secured, and the dashboard already does the job well.
> The r50 webhook turns that click into `payment_status: paid` on the row
> within seconds, which was the only part actually missing.

### 4. The seven-day window is now a live constraint, not a hypothesis  ⬜ STILL OPEN

An authorization lapses after roughly seven days. Once a customer authorizes, a
partner has to accept inside that window or the hold has to be retaken, and
**nothing watches for this.** No deadline has been set — see founder decisions.

### 5. The customer-facing payment copy is mine, not the founder's  ⬜ STILL OPEN

Both surfaces now read "We place a hold on your card for $X now, and only
charge it once your cleaner has confirmed the job." That is a promise about
money written by an agent. It replaced "Due at service", which stopped being
true, and a test fails if that old phrase returns to either page's rendered
text — but the replacement still needs the founder's wording.

### Still unproven in production

No booking has been made and paid through the live path. The sequence that
would prove it: book on the live site with the Worker log stream open and watch
for `price authenticated: <id>`; confirm `quote_sig` / `quote_scope` /
`quote_version` land in the row; open the portal link from the confirmation
email; pay with `4242 4242 4242 4242`; then confirm Stripe shows an
**UNCAPTURED** payment rather than a charge. That last step is the one that
proves authorize-not-charge actually took effect.

### Founder decisions still open

Deposit versus full amount. Refund and cancellation terms. What the customer is
told about when their card is charged. A partner response deadline, now that
the seven-day window is real. None is a coding decision.

> **2026-09-15 — three are now settled:** the full quoted amount is held; the
> founder captures by hand in the Stripe dashboard when the partner accepts;
> and a customer's cancellation releases an uncaptured hold automatically.
> **Refund and cancellation terms and the partner response deadline remain
> open**, as does the exact wording of the payment copy. None blocks the live
> key.

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
