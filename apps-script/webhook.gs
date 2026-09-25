/**
 * Serve — Booking webhook (doPost)   ·   LEADS MASTER, servecos.com
 * ==================================================================
 * VERSION STAMP:  2026-09-25  ·  master  ·  r61 — somebody is told the card moved
 *
 * r61 = THE ONE EVENT INVOLVING A REAL CARD NOW SENDS AN EMAIL.
 *       INCLUDES r60 BELOW — this is one paste, not two.
 *
 *       SCRIPT-ONLY. No site file changes with it, so the deploy order that
 *       bit r59 and r60 does not apply: paste and deploy whenever.
 *
 *       Every other thing that happens to a booking mailed the founder —
 *       reservation, plan started, visit moved, visit cancelled. A payment
 *       mailed nothing. handlePaymentEvent wrote payment_status and returned,
 *       so a hold could be placed on a Tuesday and be known to nobody.
 *
 *       THE REASON IT IS NOT MERELY UNTIDY: a hold expires. Serve authorizes
 *       at booking and captures by hand, and Stripe releases an uncaptured
 *       card authorization about seven days after it is created. Nothing
 *       watched that clock, so money that was held on Tuesday is gone the
 *       Tuesday after and the first symptom is a finished clean nobody can
 *       charge for.
 *
 *       AND THE SLOT FEED PUBLISHES 21 DAYS OUT — three times the hold
 *       window. Any booking made more than a week ahead has a hold that dies
 *       before the cleaner arrives. The authorize email says so, by name and
 *       by date, whenever the two dates say it will happen. It does not fix
 *       it: shortening the horizon, re-authorizing before the visit and
 *       capturing at booking are three different promises about when a card
 *       is charged, and that is the founder's call.
 *
 *       A LAPSE IS SILENT TODAY EXCEPT ON THE SHEET. Stripe cancels the
 *       expired intent, which lands here as `released` and correctly re-offers
 *       the Authorize button. The customer is not told, and they last heard
 *       their card WAS authorized — so the `released` email is loud whenever
 *       the booking is still live.
 *
 * r60 = THE PORTAL CAN FINALLY TELL A REFUND FROM A BOOKING NEVER PAID FOR.
 *       INCLUDES r59 BELOW — this is one paste, not two.
 *
 *       PASTE THIS BEFORE THE SITE IS PUSHED. portal.js starts reading
 *       `booking.refunded`, and a script that does not send it leaves every
 *       refunded booking reading "Not yet authorized" exactly as before —
 *       the site change alone fixes nothing.
 *
 *       FOUND 2026-09-24 by running a real card all the way through on the
 *       live key: authorize, capture, refund. The sheet has recorded
 *       `refunded` since r50 and PAYMENT_RANK has ranked it since r50, but it
 *       reached NO view model — `payment.refunded` did not exist, so both
 *       customer surfaces fell through to their blank case. A customer who
 *       had paid $137 and been refunded was shown "Not yet authorized" beside
 *       a live Authorize button.
 *
 *       That is r50's own bug arriving through a different door. The button
 *       was made to disappear on a confirmed hold precisely so nobody could
 *       place a second one by accident; here it sat, offering to charge a card
 *       again for a booking a human had deliberately refunded.
 *
 *       `released` STAYS collapsed into blank and that is still correct — a
 *       voided hold means no money ever moved, so that customer can and
 *       should authorize again. A refund means money moved and a person chose
 *       to give it back. Only one of those is quietly re-payable.
 *
 * r59 = THE PORTAL'S PLAN BOX NOW ASKS ONE-TIME DEEP-CLEAN CUSTOMERS TOO.
 *       INCLUDES r58 BELOW — this is one paste, not two.
 *
 *       PASTE THIS BEFORE THE SITE IS PUSHED. portal.js starts reading
 *       `movePlan.kind` to word the box, and a script that does not send it
 *       leaves the copy on its move-clean wording for a deep-clean customer.
 *
 *       r45 built this box for move-in / move-out on the reasoning that the
 *       booking form never offers those customers a cadence, so the portal has
 *       to ask instead. That reasoning was never about moves: the form makes a
 *       second group of exactly the same shape — somebody who picks a first /
 *       deep clean and answers "Just once". They finished a clean with no plan
 *       attached and nothing ever asked them again.
 *
 *       ELIGIBILITY IS NOW planBasisKind(), one predicate read by all three
 *       places that decide — the box, plan_start and plan_change. They cannot
 *       drift apart into a box whose button always fails.
 *
 *       THE CADENCE TEST IS WHAT KEEPS TWO OFFERS APART. A deep clean sold
 *       WITH a cadence already has r38's pending offer card; it is not a basis
 *       here. A deep clean sold as "once" has no plan row at all, and this box
 *       is the only thing that asks. See the comment above planBasisKind.
 *
 *       plan_change still refuses a plan that was OFFERED AT BOOKING, because
 *       that one holds its quoted price. The test for that is the same
 *       predicate — not a move/deep distinction — for the reason written at
 *       the call site.
 *
 * r58 = EVERY BOOKING NOW EMAILS THE CUSTOMER, WITH THEIR PORTAL LINK.
 *
 *       PASTE THIS BEFORE THE SITE IS PUSHED. The confirmation screen ships
 *       saying a booking page link is on its way by email, and the consent
 *       block ships saying the link is emailed "either way". A site making
 *       that promise against r57 promises something nothing sends.
 *
 *       WHAT WAS BROKEN. Serve sent the customer nothing by email, ever. Every
 *       MailApp.sendEmail in this file goes to notifyEmail() — the operator.
 *       The only automatic delivery a customer got was the r26 text, gated on
 *       `sms_transactional`, which may not be pre-ticked and mostly is not. So
 *       the default outcome of a booking was silence, and the portal link —
 *       the page holding their visit, their price, their payment and their
 *       ability to change or cancel — never reached them. Meanwhile the
 *       confirmation screen had been promising a confirmation email within 15
 *       minutes since long before this, and nobody was keeping that promise.
 *
 *       NO CONSENT GATE, DELIBERATELY. See sendCustomerBookingEmail. A
 *       transactional email to somebody who just booked is not the instrument
 *       A2P 10DLC governs; the texts are, and their gate is untouched.
 *
 *       Sent from deliverBookingNotify, so it inherits r55's at-most-once
 *       claim: a retry, a duplicate submission or the sweep cannot send twice.
 *       It cannot fail a booking — wrapped at the call site and internally —
 *       and it logs the job id and an outcome, never an address or a link.
 *
 * r57 = THE PORTAL'S PLAN CARD NO LONGER DEAD-ENDS WHEN THE FEED IS EMPTY.
 *       INCLUDES r56 BELOW — this is one paste, not two.
 *
 *       PASTE THIS BEFORE THE SITE IS PUSHED. The browser begins sending
 *       `time_preference` on `plan_confirm` as soon as the site ships, and a
 *       script still demanding a slot answers `bad_slot` to every one of them.
 *
 *       On 2026-09-18 AVAILABILITY held no open row on or after that day —
 *       every open slot was in the past, every future row booked or held — so
 *       the feed published nothing, correctly. A customer who had already
 *       chosen a cadence and accepted a price pressed "Choose a time" and was
 *       shown a phone number and nothing else.
 *
 *       `confirmRecurringPlan` now takes a slot OR earlier/later, the same two
 *       answers `readMovePlanChoice` has always taken. Barely any of this is
 *       new plumbing: `bookPlanVisit` already wrote `time_preference` for a
 *       schedule with no clock time, `makeJobId` already handled an undated
 *       booking, `bookAvailabilitySlot` already skipped a non-slot. This one
 *       handler demanded a clock time and nothing else did.
 *
 *       THE ANCHOR CLEARS for a preference, as changeMovePlan has done since
 *       r45. No clock time means no cadence to count from, and writing a
 *       guessed one would invent a schedule nobody agreed to.
 *
 * r56 = A BOOKING THAT SUCCEEDED CAN NO LONGER SHOW THE FAILURE PANEL.
 *
 *      r53 and r55 both attacked the WAIT. This attacks the SCREEN, and it is
 *      the one that closes the hole for good, because no latency budget can be
 *      made generous enough to be right every time.
 *
 *      Until now the only question the browser could ask was "please make this
 *      booking" — a write, behind the script lock, costing the full reservation
 *      path. If that ran past the Worker's 12s budget the browser learned
 *      nothing at all, and a completed booking (row written, text sent, email
 *      sent) showed the yellow "we couldn't confirm" panel. That happened to a
 *      real test booking on 2026-09-17 with r53 live.
 *
 *      NOW THERE IS A SECOND, CHEAP QUESTION:  GET ?booking=<submission_id>
 *      answers {ok:true, found:<bool>}. One column read. No lock, no write, no
 *      customer data in or out. It answers in about a second WHILE the slow
 *      write is still running, which is exactly when it is needed.
 *
 *      `found` is alreadyWritten() — the very predicate the reservation dedupes
 *      on — so the confirmation screen appears exactly when a replay would have
 *      answered duplicate:true. See handleBookingStatus.
 *
 *      SAFE TO PASTE IN EITHER ORDER, and safe if it is never pasted at all:
 *      the check is a GET, so an older script answers its health stamp, which
 *      carries no `found` and leaves the browser exactly as it behaves today.
 *      Nothing is written and no row is created either way.
 *
 * r55 = "RESERVE" TOOK ~15 SECONDS. PASTE THIS BEFORE THE SITE IS PUSHED.
 *
 *      The reservation answered only after the Twilio call and the Gmail send,
 *      which regularly carried it past the Worker's 12s budget: the browser got
 *      a 502, waited 1.2s, retried, and only then saw "You're on the schedule".
 *
 *      Now, when the Worker asks (notify_deferred), the booking parks the text
 *      and email in a script property and answers as soon as the sheets are
 *      written. The Worker then calls back with event_type "booking_notify" in
 *      the background, and its five-minute cron sweeps up anything missed. Each
 *      notice is claimed under the lock and sent at most once. See
 *      handleBookingNotify.
 *
 *      EITHER DEPLOY ORDER IS SAFE, and paste-first is still the rule. This
 *      script defers only when asked, and the Worker calls back only when told
 *      a notice is pending — so an old Worker with this script, or this Worker
 *      with the old script, both behave exactly as r54 did.
 *
 *      No new script properties to set and no new secrets.
 *
 * r54 = COPY ONLY. NO BEHAVIOUR CHANGES, AND A PASTE IS OPTIONAL.
 *
 *      "vendor" is a procurement word. Everything a customer or a partner
 *      reads now says "provider". In THIS file that is three things, none of
 *      them load-bearing:
 *
 *        - the customer-facing string quoted in the ops email and in two
 *          comments, "Coordinating with our provider network" — the string
 *          itself lives in partner-card.js and is rendered there, not here
 *        - the ops email's own labels, "Provider portal for …" / "Provider
 *          portal: nobody assigned …", which only the founder reads
 *        - one comment above the portal-write route
 *
 *      NOT RENAMED, AND DELIBERATELY SO. Every identifier stays exactly as it
 *      was, because each one is load-bearing:
 *
 *        vendor_id, VENDORS, VENDOR_SERVICES   the SCHEMA contract and the
 *                                              live sheets
 *        the "|vendor" token audience          renaming invalidates every
 *                                              signed provider link already
 *                                              sent
 *        view: "vendor"                        vendor.js matches on it; a
 *                                              rename blanks the portal
 *        the /v route                          every link already in a
 *                                              partner's inbox
 *
 *      Section 7 of tests/payout-discount-parity.test.js asserts the copy
 *      changed AND the wiring did not, in both directions. Getting that
 *      backwards is how a rename takes a portal offline.
 *
 *      Skipping this paste costs you the word "Vendor" in your own ops emails
 *      and nothing else. r53's fix is unaffected.
 *
 * r53 = WHY A BOOKING THAT FULLY SUCCEEDED SAID "WE COULDN'T CONFIRM".
 *
 *      LIVE SYMPTOM. A founder test booking showed the yellow failure panel
 *      while the booking had entirely succeeded: JOBS row written, customer
 *      text delivered, portal link delivered, everything logged.
 *
 *      The Twilio call and the Gmail send ran INSIDE the script lock, and the
 *      response is only returned after both. So attempt 1 overran the Worker's
 *      12s submit budget and the browser got the Worker's own 502, while this
 *      function kept running and finished the booking. The browser's retry,
 *      1.2s later, then BLOCKED ON waitLock() behind attempt 1's still-running
 *      execution — it could not answer sooner than attempt 1 finished, burned
 *      its own 12s, and got a second 502. Two failures, one good booking, and
 *      a customer told to email us.
 *
 *      THE RETRY WAS STRUCTURALLY UNABLE TO HELP. It is the documented fix for
 *      a slow upstream, but on a reservation it queued behind the very
 *      execution it was retrying.
 *
 *      FIX: the reservation path releases the lock as soon as the SHEET work
 *      is done, before the SMS and the email. Attempt 1 still overruns and
 *      still gets a 502 — Twilio and Gmail are genuinely slow. But attempt 2
 *      now takes the lock immediately, hits the alreadyWritten() dedupe and
 *      answers {status:"ok", duplicate:true} in about a second, which the
 *      browser already treats as confirmed.
 *
 *      The lock serializes SHEET WRITES, and every one of them is above the
 *      release. Neither sender nor anything they call touches a spreadsheet —
 *      checked function by function. ANYTHING ADDED AFTER THE RELEASE THAT
 *      WRITES A SHEET MUST GO ABOVE IT, or it races another booking;
 *      tests/reservation-lock-release.test.js fails if one appears, and pins
 *      the release/SMS/email order that is the fix.
 *
 *      NOT PROVEN IN PRODUCTION. The mechanism is read off this code and the
 *      Worker's budget. Apps Script -> Executions for that booking should show
 *      two executions, the first long and the second long and nearly idle.
 *      No response shape changes, so this paste and the site deploy in either
 *      order.
 *
 * r52 = THE HALF-PRICE FIRST CLEAN PAYS THE PARTNER A DIFFERENT SHARE.
 *
 *      THE ARITHMETIC, WHICH IS THE WHOLE REASON THIS EXISTS. Serve's cut is
 *      15% and the first-clean discount is 50%. A 50% discount therefore
 *      cannot be funded out of the margin: at the ordinary 0.85 the partner is
 *      paid 85% of a HALVED ticket — 42.5% of the job's real price — for work
 *      the pricing model costs at 67% of it. The cleaning company would absorb
 *      almost the entire discount, which is neither fair nor something a real
 *      partner accepts twice.
 *
 *      NEW `payoutRateFor(data)`. A half-price first clean stamps 0.98, so
 *      Serve keeps 2% of that visit and is near break-even on it by design.
 *      Everything else — a move clean, a 4BR+ heavy first clean, and every
 *      RECURRING visit — stamps the ordinary 0.85. The recurring visits are
 *      the repayment: 15% of a biweekly covers the whole first-visit shortfall
 *      in one visit. `bookPlanVisit` therefore still calls currentPayoutRate()
 *      directly and MUST NOT be routed through payoutRateFor().
 *
 *      WHICH RATE IS DERIVED, NEVER READ FROM THE PAYLOAD. payoutRateFor
 *      recomputes the discount from service, condition and bedrooms and
 *      ignores the `discount_applied` string the site sends for the sheet's
 *      benefit. A crafted booking claiming a half-price first clean must not
 *      be able to collect 0.98 on an undiscounted move clean. Tested.
 *
 *      readPayoutRate now takes (key, fallback) so both rates share one
 *      validator — same (0,1] refusal, same loud log, same "%" tolerance.
 *      New Ops SETTINGS key `payout_rate_first_clean`.
 *
 *      THIS RULE IS ALSO WRITTEN IN pricing-engine.js (R5 + discountApplies),
 *      because Apps Script cannot require() the engine. If the two copies
 *      drift, NOTHING FAILS LOUDLY — the customer is charged half price while
 *      the partner is paid 85% of that half, with no error and no log line.
 *      tests/payout-discount-parity.test.js drives both halves over 240 homes
 *      and fails naming the home that disagrees. Change one, change the other.
 *
 *      No column, no view model, no response shape changes, and no partner
 *      surface gains a rate — partners see a dollar payout and never a share.
 *      So this paste and the site deploy in either order, though the standing
 *      order (script first) still applies.
 *
 * r51 = WHY THE r50 WRITE-BACK REFUSED EVERY REAL PAYMENT.
 *
 *      Live symptom: Stripe's Event deliveries showed 500s on
 *      checkout.session.completed, payment_status never moved off blank, and
 *      the portal kept asking a customer who had already authorized to pay.
 *      The Worker was relaying correctly; THIS function was refusing it.
 *
 *      TWO FIXES, BOTH IN handlePaymentEvent, NEITHER CHANGING ANY RESPONSE.
 *
 *      1. The bridge secret is TRIMMED on both sides. Script Properties is a
 *         web form and a pasted secret very easily carries a trailing space or
 *         newline, which Google stores verbatim — so an exact comparison fails
 *         forever against a Cloudflare secret that looks identical on screen.
 *         A shared secret loses no entropy by ignoring surrounding whitespace.
 *
 *      2. A refusal now SAYS WHY IN THE LOG — "not set" versus "mismatch",
 *         with lengths only, never values or prefixes. The answer returned to
 *         the caller is unchanged and still identical for both cases: anyone
 *         probing this endpoint must learn nothing about which it was.
 *
 *      Nothing else moves. No column, no view model, no response shape, so
 *      this paste and the site deploy in either order.
 *
 * r50 = THE SHEET FINALLY LEARNS WHAT HAPPENED TO A CARD.
 *
 *      THE GAP THIS CLOSES. /api/checkout has been issuing real Stripe holds
 *      since r21, and NOTHING recorded that one was placed. `payment_status`
 *      was filled in by hand, so a customer who authorized ninety seconds ago
 *      reloaded their portal and was told "Not yet authorized", with the
 *      Authorize button still there inviting a second hold on the same card.
 *      Survivable on a test key. Not survivable on a live one — which is why
 *      the live key waited for this revision.
 *
 *      NEW ACTION `payment_event` (handlePaymentEvent). The Worker verifies
 *      Stripe's signature, then relays the outcome here behind a new Script
 *      Property, PAYMENT_BRIDGE_SECRET. Its own secret, NOT PHOTO_BRIDGE_
 *      SECRET: the rule that one credential never opens another surface holds
 *      for bridges too.
 *
 *      `payment_status` IS NOW SCRIPT-WRITTEN, which changes a promise
 *      SCHEMA.md made and is documented there in the same commit. It stays in
 *      OPS_OWNED_COLUMNS — that list guards setJobCells, and every other
 *      caller is still refused. An operator typing "paid" for a customer who
 *      paid by check still works; the two sources coexist.
 *
 *      A THIRD STATE. not authorized -> authorized (held, no money moved) ->
 *      paid. The old shape could only say the first and last, so a hold had to
 *      be recorded as either a lie or nothing. `booking.payment.authorized`
 *      joins `paid` and both customer surfaces read it.
 *
 *      NEW COLUMN `payment_ref` on JOBS — the Stripe PaymentIntent, the handle
 *      that ties a row to the dashboard. Optional: absent, the state still
 *      writes and the omission is logged. It reaches NO view model.
 *
 *      A CANCELLED VISIT RELEASES ITS HOLD. cancelBooking names an uncaptured
 *      authorization in its reply and the Worker voids it. Nothing here
 *      refunds — money actually taken is still a human's decision.
 *
 * r49 = TWO THINGS THAT MADE PAGES WAIT, NEITHER CHANGING WHAT ANY PAGE GETS.
 *      No request or response shape changes, so this paste and the site can
 *      deploy in either order.
 *
 *      PHOTO READS DO NOT QUEUE (doPost). Every POST waits for the script
 *      lock, so every thumbnail on the site loaded one at a time behind
 *      bookings and saves. A booking_photo read writes nothing; it now runs
 *      before the lock, in a shared-snapshot scope like a GET. Uploads,
 *      commits, deletes and cleanup still take the lock.
 *
 *      THE PARTNER CARD IS CACHED FIVE MINUTES (clientVendorCard). The portal
 *      and the client ticket opened the Ops workbook and read three tabs for
 *      it on every open. A vendor portal save clears that company's card at
 *      once; a hand edit to the Ops sheet shows within five minutes, or run
 *      forgetPartnerCards() from the editor.
 *
 * r48 = THE CLEANER TICKET'S ROOMS, SIMPLIFIED. r47 put a finished-room
 *      checkbox, two camera buttons and a paragraph of retention copy under
 *      every Scope room. Each room is now a collapsed box like the customer's;
 *      inside are one Add photos control and an optional note.
 *
 *      PHOTOS: the finished confirmation is no longer required, and the vendor
 *      portal's separate completion archive (completionHistory) is gone. Each
 *      job the company holds carries `report` — the rooms with a cleaner photo
 *      or note — instead. COMPLETION_PHOTOS drops room_label, service_label
 *      and scheduled_date, which only that archive read; an existing tab with
 *      those columns still works. Uploads stay append-only, in their own R2
 *      prefix, stamped with the vendor company.
 *
 *      NOTES: a new PARTNER_NOTES tab, written only with a partner ticket
 *      token (event_type partner_note). Its own tab on purpose — see
 *      PARTNER_NOTES_TAB. Read by the partner ticket (scope[].note), the vendor
 *      portal (bookings[].report) and the customer portal
 *      (bookings[].partnerNotes: room label and text, nothing else).
 *
 * r45 = SOMEBODY WHO BOOKED A MOVE WAS NEVER OFFERED A PLAN. createRecurringPlan
 *      refuses a move booking by design, and nothing else asked. The portal now
 *      shows a move customer the three cadences, each priced for their home by
 *      the pricing engine, lets them pick one and a time (or earlier / later in
 *      the day), and books the first visit. The box then stays as the plan they
 *      chose until they change it. See "A PLAN AFTER A MOVE".
 *
 *      THE PRICE IS THE ENGINE'S. Apps Script has no copy of the engine, so it
 *      asks the Worker's /api/quote for the home's recurring track — the same
 *      answer the portal displayed — and refuses (price_changed) if the two
 *      differ, rather than booking a number the customer never saw.
 *
 *      bookPlanVisit (from confirmRecurringPlan) and visitAlreadyAt / moveVisit
 *      (from rescheduleBooking) were split out UNCHANGED so the plan box books
 *      and moves visits through the same code r42 and r43 do.
 *
 * r44 = THE PORTAL WAS SLOW BECAUSE IT READ THE SAME SHEETS OVER AND OVER.
 *      A customer with five bookings cost 211 SpreadsheetApp calls to open —
 *      JOBS read seventeen times, the whole photo tab once per booking — and
 *      every one of those is a round trip to Google. Nothing on the page could
 *      show until the last of them came back.
 *
 *      NOW: a request reads each tab at most once (readTable, shared across the
 *      request by doGet only), opens the Ops workbook once, asks each
 *      workbook its timezone once, and builds every booking from the JOBS row
 *      already in hand (bookingFromRow). WHAT ANY RESPONSE CONTAINS IS
 *      UNCHANGED — this release changes how often the sheet is asked, never
 *      what is sent. See "ONE READ PER TAB, PER REQUEST" for why POSTs never
 *      share a snapshot.
 *
 * r40 = A PLAN IS FOUND BY lead_id, NOT BY contact_id. The r39 backfill wrote
 *      ten plans and not one of them appeared in a portal. They were correct
 *      rows; they simply matched nobody.
 *
 *      THE CAUSE, AND IT IS WRITTEN DOWN A FEW HUNDRED LINES ABOVE: the portal
 *      chain is contact_id -> LEADS -> lead_id -> every JOBS row with that
 *      lead_id, and that chain exists precisely to avoid depending on
 *      JOBS.contact_id, which is not reliably populated. contact_id
 *      self-backfills onto LEADS for older rows, never onto JOBS. The backfill
 *      read it off the JOBS row anyway, so every plan for a booking taken
 *      before that column was filled carried a blank contact and was invisible.
 *
 *      Plans are now matched on lead_id, which is JOBS's own join key and is
 *      always there. That fixes the rows already written — nothing has to be
 *      repaired — and it is the same seam getContactBookings uses, so a plan is
 *      found exactly the way that customer's bookings are.
 *
 *      contact_id stays ON the row as reference data. It is simply no longer
 *      the thing anything matches on.
 *
 * r39 = PLANS FOR THE BOOKINGS THAT CAME BEFORE r38. createRecurringPlan runs
 *      inside doPost, so it only ever sees NEW bookings. Every clean already
 *      sold with a cadence — including the ones taken while this was being
 *      built — has no plan row and shows no prompt in the portal.
 *
 *      backfillRecurringPlans() is the one-time answer: run it from the editor
 *      and it offers a plan for every past booking that qualifies. It is the
 *      direct caller planAlreadyOffered() exists for, so running it twice is
 *      harmless — the second pass reports "already offered" and writes nothing.
 *
 *      THE WINDOW RUNS FROM THE BACKFILL, NOT FROM THE ORIGINAL BOOKING. Seven
 *      days from a clean sold last week would arrive already expired, which is
 *      not an offer at all. The customer gets a real week to decide.
 *
 *      IT TOUCHES NO BOOKING. It reads JOBS and writes only RECURRING_PLANS.
 *      A row it cannot read is reported and skipped rather than guessed at.
 *
 * r38 = A PLAN IS AN OFFER, NOT A BOOKING. Somebody who books a first clean and
 *      picks a cadence has asked for one clean and expressed an intention about
 *      the rest. Until r38 the cadence was a column on that one row and nothing
 *      else: no second visit existed anywhere, and the portal could not say
 *      what the plan would cost or when it would start.
 *
 *      IT DOES NOT BECOME A JOB HERE. No JOBS row, no availability slot, no
 *      vendor — because a slot held for a clean nobody has confirmed is a slot
 *      a paying customer could have had. The plan is recorded in its own tab
 *      and shown to the customer with the price they were quoted, and it
 *      becomes a real booking only when they confirm and choose a time.
 *
 *      SEVEN DAYS, AND EXPIRY IS EVALUATED ON READ. A pending plan past its
 *      window simply reads as expired; nothing has to run overnight to make
 *      that true, so there is no trigger to fail silently and no state that
 *      drifts while nobody is looking.
 *
 *      THE PRICE WAS ALREADY CAPTURED. recurring_weekly / recurring_biweekly /
 *      recurring_monthly have been written into quote_meta on every first
 *      clean since the calculator shipped. The plan quotes what they were
 *      actually shown, not a price recomputed later against today's table.
 *
 *      NOTHING HERE MAY FAIL A BOOKING. Creating the plan sits in the same band
 *      as the vendor stamp, the SMS and the email — each wrapped on its own. A
 *      missing RECURRING_PLANS tab costs the plan prompt and nothing else.
 *
 * r37 = EVERY BOOKING SAYS WHAT IT ACTUALLY INCLUDES. The customer portal and
 *      the per-job ticket render a closed "What's included" list from
 *      SERVE_SCOPE, which moved into its own file (serve-scope.js) because
 *      those two pages carry a signed token and load nothing from the
 *      marketing bundle — so the data they most needed was the one thing they
 *      could not reach.
 *
 *      THIS FILE'S PART IS ONE FIELD: the portal booking row now carries
 *      `serviceCode` beside r36's `frequency`. The label is prose and may be
 *      reworded at any time; the code is the join into that scope table. A
 *      code the table has no column for renders NOTHING on the page rather
 *      than another service's list, which would be a promise nobody made.
 * * r36 = THE CADENCE DESCRIBES THE PLAN, NOT THIS VISIT. A customer who booked
 *      a First Clean and asked for a weekly plan opened their portal and saw
 *      "Recurring clean" as the upcoming service. The visit they are about to
 *      receive is a deep clean; the weekly part starts after it.
 *
 *      serviceCodeOf() asked the frequency before it asked what was booked, so
 *      any first clean with a plan attached resolved to CLEAN_STANDARD. The
 *      docblock directly above it has described the correct rule since it was
 *      written — "a First Clean on a biweekly plan is the start of a recurring
 *      relationship, and a First Clean on its own is a deep clean" — and only
 *      the order of two lines disagreed with it.
 *
 *      THIS ALSO MOVED A DISPATCH DECISION. The same function tells
 *      bookAvailabilitySlot which service to rank vendors against, so those
 *      bookings were matched on CLEAN_STANDARD. A first clean is deep-clean
 *      work and is now matched as such — a partner who offers standard but not
 *      deep no longer ranks first for it. Prices are untouched: they are
 *      stamped on the row at booking and never derived from this.
 *
 * r35 = BORROWED REVIEWS AND WORK PHOTOS, TWO NEW OPS TABS. A partner card
 *      could say a company was rated 4.8 but never show a word anyone wrote or
 *      a room anyone cleaned. VENDOR_REVIEWS and VENDOR_PHOTOS are read here,
 *      through the same buildClientVendorProfile whitelist as everything else
 *      a customer may learn about a company — one definition, not two.
 *
 *      NEITHER IS WRITABLE BY A VENDOR. The portal's write path knows exactly
 *      three kinds — profile, service, operator — and a tab no kind names
 *      cannot be reached at all. These are Serve's quotations of somebody
 *      else's words, so a partner editing them would be forging a reference.
 *
 *      EVERY QUOTE CARRIES ITS SOURCE, per row: Google, their own site, a
 *      forum. A quote with no visible attribution reads as Serve's own
 *      marketing, which is the one thing it must never look like.
 *
 *      TWO URL GUARDS, BOTH BECAUSE THESE CELLS ARE TYPED BY HAND AND LAND ON
 *      A CUSTOMER'S PAGE. `source_url` must be http(s) — a "javascript:" URL
 *      in a spreadsheet cell would otherwise become a live script on a
 *      customer's browser. `image_url` must be a same-origin /images/ path, so
 *      a photo row cannot be made to load a tracker from somebody else's host.
 *      Anything else is dropped, never rendered and never half-rendered.
 *
 *      Quotes are NOT truncated. The cap is on how many are shown, because
 *      trimming somebody's words is the thing attribution rules object to.
 *      A missing tab costs the reviews or the photos, never the card.
 *
 * r34 = partner_since IS A DATE CELL TOO, AND IT REACHED A CUSTOMER. getVendor
 *      read it with String(), so an operator formatting that column turned
 *      every partner card into "With Serve since Wed Jul 01 2026 00:00:00
 *      GMT-0400 (Eastern Standard Time)". Third time this fault has surfaced:
 *      r23 on the JOBS cells, r32 on how they are read, and now the OPS
 *      workbook, which neither release reached. Normalised here through that
 *      workbook's own timezone; the card turns it into "July 2026".
 *
 *      The card also names a rating's source. public_rating is meant to carry
 *      a number borrowed from somewhere public, and an unattributed one beside
 *      Serve's own name reads as Serve's own score.
 *
 * r33 = THE SLOT KEYS ARE READ THE SAME WAY THE TICKETS ARE. r32 fixed the
 *      JOBS cells in THIS workbook. The AVAILABILITY cells in the OPS workbook
 *      were still read with local getters by slotDateKey/slotTimeLabel, which
 *      are this project's timezone — and availability.gs re-derives the very
 *      same key in a DIFFERENT project with a timezone of its own.
 *
 *      Nothing was broken: Ops' workbook, Ops' project and this project are all
 *      America/New_York today, so all three agreed and the keys matched. They
 *      agreed by coincidence. Leads MASTER being set to Australia/Sydney is
 *      proof a workbook's timezone can drift, and if the Ops workbook drifted
 *      the feed would publish a day the sheet never said while this file went
 *      on matching against a different one — or stopped matching, which prints
 *      "no open row for ..." and leaves the slot unsold.
 *
 *      Both files now key off the OPS WORKBOOK's own timezone, so they agree by
 *      construction rather than by three settings happening to line up. The
 *      change is a no-op while they do line up, which is why it was safe to
 *      make now. availability.gs avail r3 is the other half and must ship with
 *      it — see its TIMEZONES header.
 *
 * r32 = A DATE CELL IS READ THROUGH THE SPREADSHEET'S OWN TIMEZONE. The
 *      founder's Leads MASTER was set to Australia/Sydney while the script and
 *      the business are America/New_York, and checkBookingDates proved what
 *      that does: a booking displaying "2026-09-18" and "3:30 PM" in the sheet
 *      came back as "2026-09-17" and "12:30 AM ET" — a day early on every
 *      ticket and portal, with only the prose summary still correct.
 *
 *      Sheets turns a cell's serial into an instant using the SPREADSHEET's
 *      timezone. r23 read that instant back with local getters, which are the
 *      PROJECT's timezone, so the two only agreed while the two settings did.
 *      availability.gs states the opposite in its own header and its tests
 *      encode that belief, so the slot feed has the same fault and its tests
 *      cannot see it. That is a separate fix, noted in HANDOFF.
 *
 *      dateCellText and timeCellText now take the spreadsheet's timezone and
 *      format through it, which recovers exactly what was typed whatever either
 *      setting happens to be. Local getters remain the fallback for a harness
 *      or workbook that cannot report one. checkBookingDates reads through the
 *      same timezone, so the diagnostic and the ticket can never disagree.
 *      Fixing the setting is still worth doing — it is one click and it makes
 *      the two agree — but the reading no longer depends on anyone remembering.
 *
 * r31 = WHAT IS ACTUALLY IN THE DATE CELLS. A test booking rendered as
 *      "Thu, Sep 17 · 12:30 AM ET · Friday, Sep 18 at 3:30 PM": three fields
 *      of one row disagreeing, with only the prose summary correct. The row is
 *      written consistent — buildJobRecord takes the date, the window and the
 *      summary from one normalizeSchedule result, the site sends only
 *      slot_date and slot_time, and nothing rewrites those columns afterwards.
 *      So something between writing and reading changes them, and two
 *      explanations survive: the cells hold Sep 17 and 00:30 because appendRow
 *      let Sheets convert the text it was given, or they hold the right values
 *      and the read is skewed.
 *
 *      Guessing between them has already cost two wrong theories, so
 *      checkBookingDates() reads the cells instead: for the most recent
 *      bookings it prints what each cell contains, what TYPE it is, what the
 *      cell displays to a human, what the code reads it as, and both timezone
 *      settings. Editor-only, read-only, and it prints only the schedule —
 *      never a name, email, phone or address.
 *
 * r30 = "NOT READY" NOW SAYS WHICH ONE. checkAccessMigration reported every
 *      Access MASTER fault in one sentence covering seven causes — properties
 *      unset or saved in another project, a property name mistyped, a URL
 *      pasted where the ID belongs, Leads or Ops given by mistake, an ID that
 *      will not open, a tab name that does not match, headers missing or in
 *      the wrong case — and the founder hit it twice with no way to tell
 *      which. After privateAccessStore refuses, privateAccessDiagnosis()
 *      retraces it step by step and names the first fault it finds: property
 *      NAMES, tab NAMES, header names and the length of the ID, never a value
 *      from inside Access MASTER. Only the editor-run check changed; nothing a
 *      customer or the web app touches is different from r29.
 *
 * r29 = THE MIGRATION CHECKS WHAT THE SHEET KEPT, NOT WHAT WAS SENT. Before
 *      r28 a door code was written with a plain setValue into an
 *      Automatic-format cell, and Sheets converts what it is given: "0042" was
 *      kept as the NUMBER 42, and "12/25" could become a DATE. r28's migration
 *      copied the cell's string, so a date would have landed in Access MASTER
 *      as "Fri Dec 25 2026 00:00:00 GMT-0500" — kept as the door code while the
 *      source column was deleted. Its tests could not see this: their fake
 *      sheet stores '0042' as a string, which is what the old code SENT, not
 *      what a real sheet KEPT. The migration now refuses any date (home named,
 *      value never printed) and names every number-coded home for
 *      re-confirmation, since a lost leading zero cannot be recovered.
 *
 *      checkAccessMigration() is a pre-flight. Run it before the migration and
 *      again after. It changes nothing in Leads and prints counts and property
 *      IDs only. Its one write is a synthetic "0042" round-tripped through the
 *      real save path under __serve_probe__ and then removed, because whether
 *      Sheets keeps r28's leading apostrophe in a plain-text cell could not be
 *      proved outside a real workbook — and if it does, every code save fails.
 *
 * r28 = Codes are written only to a configured separate Access MASTER file.
 *      Leads PROPERTY_ACCESS holds a saved flag and timestamp. Entry saves
 *      fail closed if private storage or the write lock is unavailable.
 *      Editor-only migration verifies copies before removing the old column.
 *
 * r27 = ONE CHARACTER, ONE EXTRA BILLED SEGMENT ON EVERY BOOKING. r26 greeted
 *      the customer with "Hi Uriel — your Serve clean is booked". The em
 *      dash is not in the GSM-7 alphabet, so it forced the whole text into
 *      UCS-2, where a segment holds 67 characters instead of 153 — and a
 *      191-character message went from two segments to three. It is a
 *      comma now. With no first name on file the text also began with a
 *      lowercase "your"; it now opens "Your Serve clean is booked".
 *      r26 was committed but not deployed when this was found, so no text
 *      ever went out with the em dash in it.
 *
 * r26 = ONE SMS WHEN A BOOKING IS WRITTEN: a sentence and their portal link.
 *      A text is frozen the second it sends and costs money per segment; the
 *      portal is always current and holds everything. So the message is an
 *      envelope, never the contents — texting the booking itself would mean
 *      texting again on every change, and the customer would not know which
 *      message was true.
 *
 *      Sent from here rather than the Worker: this is the moment the booking
 *      exists, after the JOBS write and after the dedupe, with the contact_id
 *      the link needs already in hand. A retried submission returns long
 *      before this, so nobody is texted twice.
 *
 *      FOUR GATES, ALL SILENT WHEN THEY CLOSE — consent (`sms_transactional`
 *      exactly "yes", the A2P 10DLC line and the only one here carrying a
 *      legal penalty), credentials, a phone toE164 can read, and a contact_id
 *      to build a link from. Most bookings will report one of them.
 *
 *      Three Script Properties turn it on, and until they are set it does
 *      nothing at all: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM.
 *
 *      NOTHING HERE MAY FAIL A BOOKING, and no phone number, signed link or
 *      token may reach a log line. Twilio's own error text quotes the recipient
 *      number, so only the HTTP status and Twilio's error code are logged.
 *
 * r25 = AN AVAILABILITY ROW WITH AN EMPTY vendor_id IS A REAL, BOOKABLE SLOT.
 *      It lets a time be offered and GUARANTEED before anybody is booked to
 *      work it: the customer picks the slot, it is marked booked, and the
 *      search for a partner starts from a time they have already chosen rather
 *      than from a blank diary.
 *
 *      Almost all of this already worked. The feed reads date/time/status and
 *      never looked at the vendor, the claim tolerated a blank one, and the
 *      customer's "Coordinating with our provider network" state is the same one
 *      every preference booking has always had. Two things were wrong:
 *
 *      RANK. An empty row scored ORDINARY, tying with a genuinely available
 *      partner, and ties keep sheet order — so a row with nobody in it could
 *      beat a company sitting free at that hour purely for being higher up the
 *      tab. Unassigned now sits below every real vendor and above `avoid` and
 *      `disqualified`: take a partner whenever there is one, and "we will find
 *      somebody" still beats sending work to a company that does not want it.
 *
 *      THE OPERATOR EMAIL. "Nobody assigned — this booking consumed no
 *      availability row" was true of a preference booking and false here, in
 *      the one case that actually needs somebody today. There are three states
 *      now, and the promised-time one says so loudly.
 *
 * r24 = PARTNERS SEE WHAT THEY ARE PAID, WITHOUT ANYONE TYPING IT PER JOB.
 *      The payout is 85% of the ticket by default. An operator's
 *      `partner_payout` still wins wherever it is set — that column is how one
 *      job gets a different answer, and a formula must not overwrite a decision
 *      a human made about a hard home or an apology.
 *
 *      ONE PLACE TO CHANGE THE RATE, AND IT IS A SHEET CELL: `SETTINGS` in the
 *      Ops workbook, key `payout_rate`, value `0.85`. No code change, no
 *      deploy. A dashboard built over it later is a nicer front end onto the
 *      same cell, not a second source of truth competing with it.
 *
 *      AND IT IS STAMPED PER BOOKING. The rate in force is written into
 *      quote_meta when the booking is made, and every partner surface reads the
 *      stamped value. Moving to 20% tomorrow must not reprice a job a partner
 *      already accepted at 85% — the same rule the signed quote enforces on the
 *      customer's side, for the same reason.
 *
 *      The cell is NOT trusted: anything outside (0,1] is refused and the code
 *      default used instead, loudly. `85` typed where `0.85` was meant is far
 *      likelier than an instruction to pay 8500%, and clamping would be
 *      guessing with somebody's money.
 *
 * r23 = A SHEET CELL DOES NOT ALWAYS HOLD WHAT SOMEBODY TYPED INTO IT.
 *      `scheduled_date` and `start_time` are written as plain text, but the
 *      moment an operator retypes one — or Sheets decides a typed value looks
 *      like a time — the cell becomes a real date value and getValues() returns
 *      a JavaScript Date. String()ing one put
 *
 *          Fri Dec 29 1899 22:00:00 GMT-0500 (Eastern Standard Time)
 *
 *      at the top of live booking slips, on every surface at once. 1899 is not
 *      corruption: a time-only cell has no date, so Sheets anchors it to its own
 *      epoch of 30 December 1899.
 *
 *      dateCellText and timeCellText normalise both, and every `when` field now
 *      reads through them. Times carry ET, because a cleaner reading "9–11 AM"
 *      on a phone in another timezone cannot tell which 9 is meant. Text passes
 *      through untouched — most cells are still text and always will be.
 *
 * r22 = THE CREW KNOWS WHO THEY ARE EXPECTING. buildVendorTicketModel gains
 *      `customerFirstName`, and only that. Somebody knocking on a stranger's
 *      door should be able to say "Hi, Sarah?" rather than guessing.
 *
 *      This RELAXES the standing rule on partner surfaces — "address only, no
 *      customer name, email or phone, contact routes through Serve" — and the
 *      founder made that call on 2026-09-11. The reasoning the rule protects is
 *      untouched: a first name is not a contact route. It cannot be dialled,
 *      emailed or looked up, so it does not let a partner arrange work around
 *      Serve, which is the thing that rule exists to prevent.
 *
 *      Surname, email and phone stay out. So does the vendor PORTAL, which
 *      lists every job the company has and has no business being a customer
 *      directory. One name, on one job's ticket, for the person going to it.
 *
 *      r22 also SEPARATES THE TWO PAYOUT MOMENTS in partner-facing copy. The
 *      amount is agreed at dispatch; the money follows completion and the photo
 *      check. Both surfaces said only "at dispatch", and the vendor portal's
 *      "Payout at dispatch" read as though that were payday. No code changed:
 *      the founder verifies completion and photos by hand and pays by hand, and
 *      nothing reads completed_date or photos_passed to release anything.
 *
 * r21 adds BOOKING_PHOTOS, private Worker-authorized image operations, and
 * customer portal arrival answers in the vendor ticket (never entry codes).
 *
 * r20 = THE ROW REMEMBERS THAT THE PRICE WAS PROVED. The edge Worker now
 *      ISSUES prices and signs them (see "SIGNED QUOTES" in src/worker.js);
 *      it verifies that signature before relaying a booking, and then the
 *      verdict was thrown away, because quote_meta is a whitelist and
 *      quote_sig was not on it.
 *
 *      Three keys join QUOTE_META_KEYS so the verdict survives: `quote_sig`,
 *      `quote_scope` and `quote_version`. Together they let the Worker
 *      re-prove, months later, that the figure in `quoted_price` is the one
 *      Serve offered for THAT home — which is the gate a payment link has to
 *      pass before it may charge anybody.
 *
 *      quote_scope is stored rather than rebuilt from the row ON PURPOSE.
 *      `service_type` lands here as "First Clean", not the code the engine
 *      prices from, and the add-on booleans are not stored at all — only
 *      their dollar total. Rebuilding through those would drift, and the
 *      failure would be SILENT: every job quietly unchargeable and nothing
 *      in a log to say why. The canonical string is one cell and cannot rot.
 *
 *      NONE OF THE THREE IS A SECRET. quote_sig is an HMAC output, useless
 *      without QUOTE_SECRET, which lives only on the Worker. quote_scope is
 *      beds, baths, floors, ZIP, service, condition, add-ons and frequency —
 *      the home, never the person. Nothing here identifies a customer.
 *
 *      This revision writes no new column and changes no existing behaviour.
 *      A booking that arrives without a signature — an old tab, a blocked
 *      request — stores blanks and books exactly as it always has.
 *
 * r19 = THE PARTNER'S LINK RIDES ALONG. Every booking notification now
 *      carries the vendor's own portal link beside the cleaner's job link.
 *      They are different things and the email now says so: the cleaner
 *      link is ONE job and dies when completed_date is filled; the vendor
 *      link is the company's standing portal and never changes.
 *
 *      Unassigned says so rather than going quiet — that is every
 *      preference booking, and the line names the two steps to fix it.
 *
 * r18 = THE PORTAL SAYS WHO IS COMING. buildPortalModel was written in r14,
 *      a revision before VENDORS existed, and never gained a partner field.
 *      Since r14 is also what redirected the confirmation email to the
 *      PORTAL link, the page every customer actually opens was the one
 *      page that could not answer "who is cleaning my home".
 *
 *      Upcoming bookings only. A finished booking is a receipt, and
 *      "coordinating with our vendor network" over a job that happened
 *      last month would be nonsense rather than merely useless.
 *
 *      Same whitelist as the ticket — buildClientVendorProfile — so there
 *      is one definition of what a customer may learn about a partner and
 *      no second one to forget to update.
 *
 * r17 = PORTAL LINKS ARE MINTED ON DEMAND, not by a booking. A token is a
 *      pure HMAC of the id, so a link has always existed the moment the row
 *      did — what was missing was a way to print one. The Run button cannot
 *      pass arguments, so vendorUrl("VEN-0002") had no caller.
 *
 *      printVendorLinks() and printCustomerLinks() are that caller. Two
 *      functions rather than one: the customer list prints a working
 *      credential for every customer you have, and that should be a thing
 *      you chose to do, not a side effect of looking up a partner.
 *
 * r16 = THE SCHEDULE IS THE ASSIGNMENT. The AVAILABILITY row a booking
 *      consumes already knows whose capacity it was, so dispatch is
 *      decided at booking time instead of copied across by hand.
 *
 *      The column is read as `vendor_id` OR `cleaner_id`, so the Ops sheet
 *      can be renamed before or after this deploys and neither order
 *      breaks a booking.
 *
 *      ABSENCE OF DATA IS NOT REFUSAL. A vendor who has declared no
 *      services ranks as ordinary, not disqualified — so an empty
 *      VENDOR_SERVICES tab leaves booking behaviour exactly as it was.
 *      Only a vendor who declared their services and left this one out is
 *      pushed last, and even then the booking is taken and flagged rather
 *      than refused: a conflict shown to a customer for a slot the feed
 *      had just published is our data problem charged to them.
 *
 * r15 = PARTNER COMPANIES GET A PORTAL, and three tabs in the OPS workbook:
 *      VENDORS, VENDOR_SERVICES, OPERATORS. Ops rather than Leads MASTER so
 *      customer support can be given Leads without seeing payout terms.
 *      Created by hand, not auto-created: a vendor is a relationship somebody
 *      agreed to, not a row a form conjures.
 *
 *      /v is a fourth token scope. Client ticket, partner ticket, customer
 *      portal, vendor portal — none opens another.
 *
 *      A VENDOR MAY DESCRIBE THEMSELVES, NOT PROMOTE THEMSELVES. Writes are a
 *      WHITELIST (VENDOR_EDITABLE, OPERATOR_EDITABLE): display name, blurb,
 *      areas, capabilities, their services and their own team. Rating,
 *      review count, insurance_verified, client_visible, status,
 *      partner_since, the logo and everything internal are Serve's. A
 *      denylist would fail open into exactly the wrong place.
 *
 *      ASSIGNMENT IS TWO COLUMNS ON JOBS — vendor_id and operator_id, beside
 *      cleaner, both ops-owned. A join tab would duplicate a row that already
 *      exists one-per-booking.
 *
 *      THE CUSTOMER STILL SEES A COMPANY, NEVER A PERSON. show_to_customer
 *      exists on OPERATORS and is read by nothing — the §148B position of
 *      2026-09-08 stands, and reversing it is a deliberate act rather than a
 *      config change.
 *
 * r14 = ONE PERMANENT LINK PER CUSTOMER, keyed on contact_id.
 *      A ticket was per booking, which is wrong for how people behave: they
 *      have a home, they book repeatedly, and how to get in is true every
 *      visit rather than once. /h shows all their bookings and their access
 *      answers, and the link never changes.
 *
 *      NEEDS ONE COLUMN: contact_id on LEADS. upsertLead writes it only when
 *      that column exists, so it has been a no-op since r9. Adding it starts
 *      it working, and it self-backfills on each customer's next booking. No
 *      JOBS column is needed — the chain is contact_id -> LEADS -> lead_id ->
 *      JOBS, and lead_id is already column 2 of the live JOBS header.
 *
 *      PROPERTY_ACCESS is new and auto-created: the customer's own answers
 *      about getting in, PROPERTY-scoped so they outlive one booking. Kept
 *      apart from PROPERTY_MEMORY, which is the crew's curated record.
 *      The entry_code column is WRITE-ONLY: no view model returns it and
 *      nothing logs it. The portal reports only the date it was saved.
 *
 *      Access is now CHOICES rather than free text. One taxonomy
 *      (ACCESS_QUESTIONS) drives the bullets, the validation and where each
 *      answer is stored, so the three cannot disagree.
 *
 *      A portal token authorises ONE contact. Every write proves the target
 *      belongs to them before touching it — without that check a valid token
 *      would be a key to every booking in the sheet.
 *
 * r13 = A DATA LAYER BETWEEN THE SHEET AND THE TICKET, plus two fixes to r11
 *      found while building on it.
 *
 *      Nothing above the repositories knows a column name any more:
 *          get*()                sheet row  ->  normalized object
 *          build*TicketModel()   object     ->  what ONE audience may see
 *      A view model is a WHITELIST, built up field by field. Filtering a row
 *      down fails open — a column added to JOBS next month would arrive in a
 *      browser because nobody remembered to exclude it.
 *
 *      THE TICKET TOKEN IS NOW SCOPED TO THE VIEW. It was an HMAC of the
 *      job_id alone, so ONE token opened both views and `&view=` merely chose
 *      which. A partner holding their own link could read the customer's name,
 *      the price they paid and their private notes; a customer could read the
 *      crew's access notes. Two audiences, two secrets.
 *
 *      BOOKING_INSTRUCTIONS is new and auto-created, one row per
 *      (job_id, scope_type, scope_key). BOOKING/GENERAL, ROOM/<room key> and
 *      ACCESS/<one of five fixed fields>. Deliberately separate from
 *      PROPERTY_MEMORY, which holds what is true of the house every visit —
 *      "fresh sheets are in the closet" is about Tuesday, the lockbox is not.
 *
 *      NO VENDORS, OPERATORS OR ASSIGNMENTS TAB IS CREATED. Serve has no
 *      partner companies yet. getAssignment reads the one real thing — the
 *      `cleaner` cell — and reports `pending` when blank, so the ticket says
 *      "confirmed before your appointment" rather than inventing a partner.
 *
 * r12 = the custom-quote email carries the customer's NAME and their SCOPE.
 *      The request form now asks what they actually need done, because that
 *      lane stopped being "5+ bedrooms only" — the booking page has a link into
 *      it for jobs a calculator has no business pricing (only the downstairs, an
 *      empty move-out, one room that needs three hours).
 *      EVENTS has no customer_notes column, so for these requests THE EMAIL IS
 *      THE ONLY RECORD OF THE SCOPE. Nothing else changes; no new tab, no new
 *      column, no schema change of any kind.
 *
 * r11 = doGet serves a JOB TICKET when given `?job=&t=&view=`. One JOBS row,
 *      two audiences: the client sees price, cleaner and their own notes read
 *      back; the partner sees the address and the crew notes and never the
 *      customer's email or phone. The split is decided HERE, not in the page,
 *      so a view can only render what it was sent.
 *      The token is an HMAC of job_id under a self-provisioning script secret —
 *      job_id itself is not secret (it is a known date plus six characters and
 *      it appears in every notification email), and the URL carries a home
 *      address and when the house is empty. No new column, no setup step.
 *      Partner links expire on completion; client links persist, because the
 *      photos and the price are the customer's record.
 *      DOOR CODES STAY OUT. They are in Access MASTER and reach the cleaner by
 *      direct message; a URL token is not the place for them.
 *
 * r10 = `job_notes` events UPDATE an existing JOBS row instead of appending.
 *      The reserve step's "anything we should know?" textarea was removed —
 *      asking at the moment of commitment costs bookings — and the same
 *      question now sits on the confirmation screen, after the spot is claimed.
 *      This is the one write path that deliberately skips alreadyWritten():
 *      everywhere else a repeated submission_id is a replay to ignore, here it
 *      is how the booking gets found. Blank-fill only, so a second submission
 *      cannot erase the first and a hand-edit always survives. It never throws
 *      — the booking is already confirmed on screen and must stay that way.
 *      Also extracts PET_WORDS so petsFlag() and petsFromText() cannot drift.
 *
 * r9 = PROPERTIES gains a stable `property_id` (PROP-nnnn) and LEADS a
 *      `contact_id` (CON-nnnn); both are written onto the JOBS row so history
 *      joins on an id rather than on a string built from typed input.
 *      Property matching now compares NORMALISED FIELDS (zip, address, unit)
 *      instead of the property_key string, which is what let one apartment
 *      become three records. A new property also gets a blank PROPERTY_MEMORY
 *      row so there is always somewhere to put what the crew learns.
 *      (r9 was revised twice before ever being deployed. First: toE164 now
 *      emits bare digits, because a leading "+" makes Sheets parse the cell as
 *      =+1617... — a formula that happens to evaluate to the right number,
 *      leaving the column holding a mix of data and formula cells. The "+" is
 *      re-attached on read, wherever E.164 is actually required. Second: the
 *      reservation email reports levels, via homeSummary.)
 *
 * r8 = `levels` (floors inside the unit) joins the ops-preferred keys, and
 *      `geo_factor` / `park_tier` join quote_meta. All three are additive: no
 *      header is required for a booking to succeed, and JOBS is not widened.
 *      Adding a `levels` header moves it out of quote_meta into its own column.
 *      (r8 was revised on 2026-08-21 before ever being deployed: the geo key was
 *      `zone` while the site still shipped three tiers. It now carries the
 *      measured factor itself, which is strictly more informative.)
 * r7 = SMS consent (sms_transactional / sms_promotional / sms_consent_at)
 *      written to LEADS, timestamped server-side. Needs three new LEADS
 *      headers; without them the upsert reports and skips, as always.
 * r6 = testPayload picks a real open slot and cleans up after itself.
 * r5 = PROPERTIES upsert + AVAILABILITY write-back to the Ops workbook.
 * r4 = timezone pinning (BUSINESS_TZ everywhere, timezone-free prettyDate).
 * Each revision differs in behaviour, so an older stamp reported by doGet means
 * the deployed copy is stale. Bump this on every behavioural change, not just
 * schema changes — that is the whole point of it.
 *
 * Editor-only functions (testPayload, cleanupTestRows, reportLeadsSchema,
 * findOpenSlot) do NOT bump the stamp. They never run in a deployment, so a
 * change to them cannot make a deployed copy stale, and bumping would raise a
 * false alarm on a request path that is byte-identical.
 *
 * Repo source of truth: /apps-script/webhook.gs
 * Column meanings and ownership: /docs/SCHEMA.md — that file is authoritative.
 * ==================================================================
 *
 * ROUTING — a reservation touches four tabs across TWO workbooks
 *   1. LEADS       upsert the person          (Leads MASTER)
 *   2. JOBS        append the booking         (Leads MASTER)
 *   3. PROPERTIES  upsert the address         (Leads MASTER)
 *   4. AVAILABILITY flip the slot to booked   (OPS workbook, by id)
 *   Everything else (quote_emailed, waitlist_zip, custom_quote_request) -> EVENTS.
 *
 *   ONLY STEP 2 CAN FAIL THE REQUEST. Steps 1, 3 and 4 run after the booking is
 *   safely recorded; each failure is reported in the notification email and
 *   none of them is ever raised to the customer. A booking is worth more than
 *   any bookkeeping attached to it.
 *
 * WRITE PERMISSIONS
 *   Freely writable:  JOBS, LEADS, EVENTS.
 *   Hard-blocked:     RAW_INTAKE, OUTREACH_LOG, DASHBOARD, and the Ops tabs
 *                     CLEANERS, SCHEDULE, OPS_DASHBOARD. assertWritable()
 *                     throws for all of them.
 *   Narrow exceptions: PROPERTIES via assertPropertiesWritable() and
 *                     AVAILABILITY via assertAvailabilityWritable(). Each
 *                     refuses any tab other than its own, so the allowance
 *                     cannot widen. assertWritable() still refuses both.
 *   Tab names normalize, so underscores vs. spaces cannot defeat the guard.
 *
 * THREE INVARIANTS
 *   1. Never widen a tab you designed. Writes are header-driven: read row 1,
 *      fill the columns that exist, drop the rest (and say so in the log).
 *      Only EVENTS is auto-created, and only when missing.
 *   2. Never lose a booking to bookkeeping. If the LEADS upsert fails for any
 *      reason, the JOBS row is still written and the notification email says so.
 *   3. Never write twice. submission_id is the idempotency key; a replay
 *      mutates nothing at all — no JOBS row, no LEADS edit.
 *
 * ATOMICITY
 *   The JOBS row is a single appendRow of an array built completely in memory
 *   first. You get a whole row or no row — never a half-populated one. If the
 *   append throws, doPost returns {status:"error"}, the site's retry fires, and
 *   the same submission_id writes cleanly because nothing was recorded. See
 *   upsertLead for the LEADS caveat.
 *
 * IDENTITY MODEL
 *   submission_id  one per POST. Client-generated UUID. Dedupe key only.
 *   lead_id        one per PERSON. Normalized lowercased email, else property_key.
 *   job_id         one per BOOKING. SRV-<yyyyMMdd>-<6 chars of submission_id>.
 *   Same person booking three times -> 1 lead_id, 3 submission_ids, 3 job_ids.
 *
 * CONTACT DETAILS ARE INTENTIONALLY IN BOTH TABS.
 *   LEADS is the canonical person record. The JOBS copy is a point-in-time
 *   snapshot, the way an order snapshots customer details. Do not "normalize"
 *   this away.
 *
 * SETUP
 *
 *   THE CONSTANTS BELOW ARE ALREADY CORRECT FOR THE LIVE DEPLOYMENT.
 *   Read this before changing any of them.
 *
 *   SPREADSHEET_ID   Leave it "". This project is BOUND to Leads MASTER — it was
 *                    opened from inside that sheet via Extensions > Apps Script —
 *                    and "" means "use the spreadsheet I am attached to", which
 *                    is already the right one. Fill it in ONLY for a standalone
 *                    project created from script.google.com. Setting it to the
 *                    wrong id points every write at another workbook.
 *   JOBS_TAB         Already "JOBS", which matches the live tab. Change only if
 *                    the tab itself is renamed.
 *   OPS_SPREADSHEET_ID  Already filled in — the Ops workbook is a DIFFERENT
 *                    spreadsheet, so it can only be reached by id. Safe to keep
 *                    in the file: the repo is private, and a spreadsheet id is
 *                    not a credential. Opening it still requires permission.
 *   NOTIFY_EMAIL     NOT in this file. Set it as a Script Property:
 *                    Project Settings > Script Properties > add NOTIFY_EMAIL.
 *                    Unset, it falls back to the account the script runs as.
 *
 *   THEN, IN ORDER
 *   1. Run reportLeadsSchema(). Read-only — getSheets, getSheetByName,
 *      getLastColumn, getRange().getValues() and console.log, nothing else. It
 *      creates no tab, no column and no cell, and sends no email. Confirms this
 *      project is attached to the workbook you think it is.
 *   2. Run testPayload(). Writes both scheduling shapes, a repeat customer, a
 *      move-out, a same-slot clash and an idempotency replay, across four tabs
 *      in two workbooks. IT LEAVES THE ROWS IN PLACE ON PURPOSE — the log only
 *      proves the calls returned ok, and everything worth checking (notes
 *      populated, pets_flag, add_on_rev 0 on a move-out, source_history
 *      appended) is visible in the sheet or nowhere. The log prints exactly
 *      what to look at. Run cleanupTestRows() when you are done.
 *   3. Authorize when prompted. r5 opens a second spreadsheet by id, which is a
 *      new scope — an existing deployment WILL re-prompt.
 *   4. Deploy. For the EXISTING deployment use
 *         Deploy > Manage deployments > pencil > Version: New version
 *      which keeps the URL. "New deployment" mints a DIFFERENT /exec URL and the
 *      site would keep talking to the old one.
 *   5. Open the /exec URL. It must report this file's version stamp. Anything
 *      older means the editor was saved but not redeployed.
 *
 * The site POSTs Content-Type text/plain so the request stays CORS-simple and
 * the browser can read the reply. Keep returning { status: "ok" } — the success
 * panel on the site is gated on it.
 */


/* ============================================================
   1. CONFIG
   ============================================================ */

const SPREADSHEET_ID = "";                    // "" = use the bound spreadsheet
const JOBS_TAB       = "JOBS";

const LEADS_TAB  = "LEADS";    // must already exist — never auto-created
const EVENTS_TAB = "EVENTS";   // auto-created if missing

/**
 * Notification recipient. Deliberately NOT a constant in this file — the repo is
 * version controlled and a personal address must not live in it.
 *
 * Set it once: Apps Script > Project Settings > Script Properties > add a
 * property named NOTIFY_EMAIL. If unset it falls back to the account the script
 * runs as, which is almost always the right person, so a missed setup step
 * cannot silently stop notifications.
 */
function notifyEmail() {
  var v = PropertiesService.getScriptProperties().getProperty("NOTIFY_EMAIL");
  if (v && String(v).trim()) return String(v).trim();
  return Session.getEffectiveUser().getEmail();
}

/**
 * Tabs this script must never touch, whatever else changes.
 * Compared through normalizeTabName(), so spacing and punctuation cannot defeat
 * the guard: "RAW_INTAKE", "RAW INTAKE" and "raw-intake" all match.
 */
const PROTECTED_TABS = [
  // Leads MASTER
  // PROPERTY_MEMORY is hand-curated knowledge — what the crew learned about a
  // home. The webhook may only ever CREATE a blank row for a new property, via
  // assertPropertyMemoryWritable(). It must never fill or overwrite a cell:
  // a form submission knows nothing about a sticky gate latch.
  "PROPERTIES", "PROPERTY_MEMORY", "RAW_INTAKE", "OUTREACH_LOG", "DASHBOARD",
  // Ops workbook — reachable by id now that availability write-back exists.
  // OPS_DASHBOARD normalises to OPS_DASHBOARD, not DASHBOARD, so it needs its
  // own entry rather than relying on the one above.
  "CLEANERS", "SCHEDULE", "OPS_DASHBOARD",
];

/** Columns ops owns on JOBS. Never written, not even blank-filled.
    `partner_payout` joins them in r13: what the crew is paid for this job, set
    by hand at dispatch. A booking form cannot know it and must never guess.

    r22 — WHEN THE MONEY MOVES IS NOT WHEN THE AMOUNT IS SET. The amount is
    agreed at dispatch, because nobody can be asked to accept a job without
    knowing what it pays. Payment follows completion and the photo check, and
    both partner surfaces now say so.

    NONE OF THAT IS MECHANICAL, by the founder's decision on 2026-09-11. No code
    reads `completed_date` or `photos_passed` to release a payout; both are
    verified by hand and payment is made by hand. The copy describes how Serve
    operates. If that ever becomes automatic it is a new decision, and this
    column stops being ops-owned on the same day.

    r50 — `payment_status` HAS EXACTLY ONE EXEMPT WRITER, and it is still in
    this list on purpose. The list guards setJobCells, which is what the
    booking form, the portal writes, the reschedule and the cancellation all
    go through; every one of them is still refused. handlePaymentEvent writes
    the cell directly, behind PAYMENT_BRIDGE_SECRET, because Stripe knows what
    happened to a card sooner and more exactly than a person can. Keeping the
    name here means the exemption is one function rather than a door left open
    — anything that reaches for setJobCells still gets an exception. */
const OPS_OWNED_COLUMNS = ["completed_date", "cleaner", "duration_min", "photos_passed",
                           "payment_status", "partner_payout", "vendor_id", "operator_id"];

const NEW_JOB_STATUS = "new";

/* r43. What job_status reads once a customer calls a visit off in their portal.
   The row is NEVER deleted — a cancelled booking is a record of something that
   was really sold and really given back, and ops reporting that counted only
   surviving rows would quietly overstate how much work was actually booked. */
const CANCELLED_JOB_STATUS = "cancelled";


/* ============================================================
   2. HEADER_MAP — payload/record key -> EXACT header text
   Built against JOBS row 1 — 36 columns until r50, 37 with `payment_ref`:

     job_id | lead_id | source | property_key | service_type | frequency |
     condition | beds | baths | quoted_price | add_ons | add_on_rev |
     final_price | scheduled_date | completed_date | cleaner | start_time |
     duration_min | photos_passed | payment_status | job_status | notes |
     submission_id | received_at | name | email | phone | segment |
     src_chain | customer_notes | pets_flag | scheduling_type |
     address | unit | zip | quote_meta | payment_ref

   r50 added `payment_ref` (37) — the Stripe PaymentIntent behind whatever
   `payment_status` says. OPTIONAL: where the header is absent the payment
   state still writes and the omission is logged, so adding the column late
   costs nothing but the reconciliation handle.

   Only keys whose record name DIFFERS from the header need an entry here.
   Everything else matches by name: job_id, lead_id, property_key, condition,
   job_status, notes, submission_id, received_at, name, email, phone, segment,
   src_chain, customer_notes, pets_flag, scheduling_type, address, unit, zip,
   quote_meta.

   THE RULE, so this stays consistent as the schema grows:
     Anything a human reads, sorts or filters in normal ops  ->  its own column.
     Anything that is reference data for one job              ->  quote_meta.
   ============================================================ */

const HEADER_MAP = {
  src_first:          "source",
  service_label:      "service_type",
  frequency_selected: "frequency",
  bedrooms:           "beds",
  bathrooms:          "baths",
  quote_price:        "quoted_price",
  addons_label:       "add_ons",
  addon_total:        "add_on_rev",
  first_visit_total:  "final_price",
  requested_date:     "scheduled_date",
  requested_window:   "start_time",
};

/**
 * SECONDARY reference data only — what you read when investigating one job,
 * never what you sort or filter a sheet by. Packed into `quote_meta` as compact
 * JSON if that header exists; dropped otherwise, never folded into notes.
 *
 * address / unit / zip are deliberately NOT here. property_key is a join key,
 * not an address, and nothing in this build writes to PROPERTIES — so an address
 * missing from JOBS is absent from the whole workbook. They are ops data and get
 * real columns. See OPS_PREFERRED_KEYS.
 */
const QUOTE_META_KEYS = [
  "original_price", "discount_applied", "steady_state_price",
  "recurring_weekly", "recurring_biweekly", "recurring_monthly",
  "zip_tier", "page_path", "utm_source", "utm_medium", "utm_campaign",
  "unit_label", "src", "submitted_at",
  /* Silent geographic pricing adjustment applied to this quote, from
     serve-geo-data.js. Logged so quote accuracy can be analysed by area once
     completed jobs accumulate — `geo_factor` scaled the size base (1.00 = the
     regional norm for that home), `park_tier` added a flat per-visit amount.
     NEITHER IS EVER SHOWN TO A CUSTOMER, and neither belongs in an email or an
     ops column; they are reference data for one job, which is what quote_meta
     is for. */
  "geo_factor", "park_tier",
  /* SMS consent as captured on THIS booking. LEADS holds the person-level
     record you filter by; this is the per-booking snapshot you read when
     investigating one job, which is exactly what quote_meta is for. It also
     means every submission carries its own consent state with no new JOBS
     column, so the audit trail exists even before LEADS gets its headers. */
  "sms_transactional", "sms_promotional",
  /* r20 — PROOF THAT THE PRICE CAME FROM US, not from the customer's machine.
     The Worker signs every quote it issues and verifies the signature before
     this script ever sees the booking; these three keys are what let it prove
     the same thing again later, when a payment link wants to know whether
     `quoted_price` may be charged.

     `quote_scope` is the canonical description of the home the price was
     quoted for — beds, baths, floors, ZIP, service, condition, add-ons,
     frequency. It is STORED rather than rebuilt from this row because the row
     is lossy: service_type is written as "First Clean" rather than the code
     the engine prices from, and the add-on booleans never land at all. A
     rebuild would drift and fail silently.

     `quote_version` is the engine the SERVER signed with, which is not
     necessarily the `pricing_version` the browser reported — that is the whole
     point of telling drift from tampering. Verification needs the server's.

     All three are blank on an unsigned booking, and blank simply means the
     price was never authenticated. It does not mean anything is wrong. */
  "quote_sig", "quote_scope", "quote_version",
  /* r24 — the partner share in force when this booking was made. STAMPED by
     doPost from currentPayoutRate(), never accepted from the payload, and read
     back by every partner surface instead of the live setting. Changing the
     rate must not reprice a job somebody already accepted. */
  "payout_rate",
];

/**
 * Ops fields that belong in their own columns and must never be silently lost.
 * Written straight to the matching header. If a header is missing, they fall
 * back into quote_meta rather than vanishing — a safety net for a schema that
 * has not caught up yet, not the intended path.
 *
 * `levels` (floors inside the unit) is here rather than in QUOTE_META_KEYS
 * because it is a thing a cleaner needs to know before arriving — stairs decide
 * what equipment comes out of the van — and it prices like beds and baths,
 * which both have real columns. There is no `levels` header on JOBS today, so
 * it rides in quote_meta and logs that it did. Add the header and it moves into
 * its own column with no code change.
 */
const OPS_PREFERRED_KEYS = ["address", "unit", "zip", "levels"];

/**
 * The ONLY LEADS columns this script writes, listed as PAYLOAD keys.
 * Translate to header text with leadsHeaderFor().
 *
 * Everything else on that tab is the operator's — source_detail, contacted_via,
 * status, first_variant, dnc_scrub, ltv, notes — and is skipped silently.
 */
const LEADS_FIELDS = ["lead_id", "name", "email", "phone", "phone_e164", "address",
                      "unit", "zip", "source", "segment", "source_history",
                      "sms_transactional", "sms_promotional", "sms_consent_at",
                      "contact_id"];

/**
 * E.164 DIGITS — country code included, leading "+" deliberately omitted.
 *
 * A phone number is the routing key for an inbound text, and a wrong one fails
 * silently: the message matches nobody and you conclude the lookup is broken
 * rather than the data. So anything not unambiguously a US number returns ""
 * and a human fills it in.
 *
 * WHY NO "+":
 * A Sheets cell beginning with "+" is parsed as a FORMULA — "+16178527117"
 * becomes "=+16178527117", which evaluates to a number. The formula bar still
 * shows the plus, so it looks stored, but getValue() returns the number and the
 * column ends up holding a mix of data cells and formula cells. That is worse
 * than a format mismatch: formulas behave differently under sort, fill and
 * paste, and nothing warns you.
 *
 * The apostrophe trick that works when typing by hand is not available to a
 * script writing via appendRow, so the honest fix is to not emit a character
 * the sheet cannot hold. The country code is always present, so "16178527117"
 * is unambiguous. Prepend "+" when handing it to Twilio, the same way zipN()
 * restores a leading zero the sheet has eaten.
 */
function toE164(raw) {
  const d = String(raw == null ? "" : raw).replace(/[^0-9]/g, "");
  if (d.length === 10)                        return "1" + d;
  if (d.length === 11 && d.charAt(0) === "1") return d;
  return "";
}

/** LEADS-specific payload key -> header, where the two differ. */
const LEADS_HEADER_MAP = { address: "service_address" };

function leadsHeaderFor(field) {
  return LEADS_HEADER_MAP[field] || field;
}

/**
 * RECORD ACTIVITY timestamps — when this workbook last heard from the person.
 * NOT outreach dates: OUTREACH_LOG owns actual sends.
 *
 * Written as JS Date objects so Sheets stores real datetimes. Writing an ISO
 * string here would break sorting and date math silently, because the column
 * would hold text that merely looks like a date.
 */
const LEADS_FIRST_TOUCH = "first_touch";
const LEADS_LAST_TOUCH  = "last_touch";

/**
 * Columns that must never be modified once a LEADS row exists.
 *
 * first_touch is stamped exactly once, at row creation, and is immutable
 * forever after. This is enforced by setLeadCell() THROWING — not merely by
 * this script happening not to write it — so a future edit that adds
 * first_touch to an update loop fails loudly instead of quietly rewriting
 * history. On a match we do not even blank-fill it: a row imported from a deed
 * or Apollo batch first appeared on its import date, not today.
 */
const LEADS_IMMUTABLE_ON_MATCH = [LEADS_FIRST_TOUCH];

/* ============================================================
   PROPERTIES — the durable asset

   Customers are transient; addresses are not. property_key has been generated
   on every booking as a join key while the tab stayed empty, so the join had
   nothing to join to.

   PROPERTIES stays on PROTECTED_TABS. This is a deliberate, narrow exception:
   upsertProperty() is the only writer, via assertPropertiesWritable(), which
   refuses any tab that is not PROPERTIES. assertWritable() still throws for it,
   so no other code path can reach it even by accident.

   Live header row (17 cols), confirmed 2026-07-28:
     property_key | service_address | unit | neighborhood | zip | property_type |
     beds | baths | deed_date | sale_price | deed_type | buyer_name |
     first_clean_min | last_service_date | photo_folder | known_issues | notes

   A booking only knows six of those. The rest are deed data (MAN, promoted from
   RAW_INTAKE) or measured after a job (OPS). Notably last_service_date is NOT
   written here: a booking is a future intention, not a service that happened.
   ============================================================ */
const PROPERTIES_TAB = "PROPERTIES";

/* One row per property, holding what has been learned by cleaning it — access,
   parking, pets, no-go areas. The webhook only ever appends a blank row for a
   new property; a human fills it. Door codes are NOT here: they live in a
   separate Access MASTER file so that nothing which reads this tab can leak
   them. */
const PROPERTY_MEMORY_TAB = "PROPERTY_MEMORY";

/* BOOKING_INSTRUCTIONS — what the customer wants done on THIS visit.
   -------------------------------------------------------------------
   Auto-created like EVENTS, so no setup step. Deliberately separate from
   PROPERTY_MEMORY above, which holds durable facts about the house: the
   lockbox is round the back every time, "fresh sheets are in the closet" is
   about Tuesday. Storing both in one place means either re-typing the house
   every visit or carrying a one-off note forward forever.

   One row per (job_id, scope_type, scope_key). Re-writing the same scope
   updates the row rather than appending, so the ticket shows one current
   instruction per room instead of an ever-growing list of edits. Blanking the
   text keeps the row and empties it — the read side skips empties, and the
   row is the audit trail of the change. */
const INSTRUCTIONS_TAB = "BOOKING_INSTRUCTIONS";
const INSTRUCTIONS_HEADERS = [
  "instruction_id", "job_id", "scope_type", "scope_key",
  "instruction", "created_at", "updated_at", "source",
];
/* PROPERTY_ACCESS — how to get into this home, in the customer's own words.
   -------------------------------------------------------------------
   Auto-created like BOOKING_INSTRUCTIONS and EVENTS, so no setup step.

   PROPERTY-SCOPED, NOT BOOKING-SCOPED, and that is the whole point of the
   portal: the lockbox is in the same place next month. Asking again every
   visit is exactly what "Serve remembers your home" exists to stop.

   Separate from PROPERTY_MEMORY, which is the crew's curated record and sits
   on PROTECTED_TABS — a form submission knows nothing about a sticky gate
   latch. This tab is the customer's own answers; the partner ticket shows
   both, labelled, and never merges them.

   Codes live only in the separate Access MASTER workbook. Leads stores a
   nonsecret saved flag and timestamp. Hiding a column is not access control.
   No view model reads the private workbook or returns a code. */
const PROPERTY_ACCESS_TAB = "PROPERTY_ACCESS";

/* r38. A plan a customer has been offered and has not yet confirmed. Its own
   tab because it has a lifecycle JOBS does not: pending -> confirmed or
   expired, an anchor day and time that later visits are counted from, and a
   window that closes. JOBS is one row per BOOKING, and a pending plan is not
   one.

   Row 1, in Leads MASTER:

     plan_id | contact_id | lead_id | origin_job_id | property_id | frequency |
     quoted_price | created_at | expires_at | status | anchor_date |
     anchor_time | preferred_vendor_id | confirmed_job_id
*/
const RECURRING_PLANS_TAB = "RECURRING_PLANS";
const PROPERTY_ACCESS_HEADERS = [
  "property_id",
  "occupancy_choice", "occupancy_detail",
  "entry_choice", "entry_detail", "entry_code_saved", "entry_code_set_at",
  "parking_choice", "parking_detail",
  "pet_notes", "updated_at",
];


/** Payload keys the webhook may write to PROPERTIES. Nothing else. */
const PROPERTIES_FIELDS = ["property_key", "address", "unit", "zip", "bedrooms", "bathrooms"];

/** Payload key -> PROPERTIES header, where the two differ. */
const PROPERTIES_HEADER_MAP = {
  address:   "service_address",
  bedrooms:  "beds",
  bathrooms: "baths",
};

function propertiesHeaderFor(field) {
  return PROPERTIES_HEADER_MAP[field] || field;
}


/* ============================================================
   OPS WORKBOOK — availability write-back

   A different spreadsheet from Leads MASTER, reached by id. Nothing marked a
   slot as taken, so a second visitor could book a time already sold; every
   published slot is one cleaner deep, which makes that a real conflict rather
   than a queue.

   Only AVAILABILITY is writable, and only its status and job_id cells. The Ops
   workbook's other tabs are on the protected list, and
   assertAvailabilityWritable() refuses anything that is not AVAILABILITY.

   Live header row (7 cols), confirmed 2026-07-28:
     date | start_time | cleaner_id | status | job_id | week_of | notes
   Observed status values: open, booked, held. `held` is the operator's and is
   never touched — only open -> booked.
   ============================================================ */
const OPS_SPREADSHEET_ID = "1MhaQGxwTZvg7HF94WWpeof5A6P9GCa8Fq7hkZKqxwW4";
const AVAILABILITY_TAB   = "AVAILABILITY";
const SLOT_OPEN          = "open";
const SLOT_BOOKED        = "booked";

/** EVENTS is ours, so its schema is fixed here rather than inferred per payload. */
const EVENTS_HEADERS = [
  "received_at", "submitted_at", "submission_id", "event_type", "event",
  "name", "email", "phone", "zip", "zip_tier", "bedrooms", "bathrooms",
  "service", "condition", "frequency_selected", "quote_price",
  "steady_state_price", "addon_total", "addon_fridge", "addon_oven",
  "unit_label", "src", "src_first", "src_chain", "segment",
  "utm_source", "utm_medium", "utm_campaign", "page_path",
];


/* ============================================================
   3. ENTRY POINTS
   ============================================================ */

/* r44. Every POST runs in a request scope WITHOUT shared snapshots: it may
   write and then read the same tab, and must see its own write. See
   "ONE READ PER TAB, PER REQUEST".

   r49. PHOTO READS DO NOT QUEUE. Every POST below waits up to 20s for the
   script lock, so every thumbnail on every page used to load one at a time,
   site-wide, behind bookings and saves — and a page full of photos could push
   a booking arriving at the same moment toward the Worker's 12s budget. A
   photo read writes nothing: it checks the credential and the sheet row and
   hands back a storage key. So it is routed here, before the lock, and runs
   the way a GET does, in a shared-snapshot scope. tests/read-budget.test.js
   asserts it writes nothing and never touches the lock. Only a string
   action of exactly "read" takes this path; begin, commit, delete and cleanup
   still wait their turn. */
function doPost(e) {
  var data = parseBody(e);
  if (isPhotoRead(data)) {
    return withRequestScope(true, function () {
      try { return handleBookingPhoto(leadsBook(), data); }
      catch (err) {   /* JSON, as routePost answers; never the request itself in the log */
        console.error("photo read failed: " + err);
        return json({ ok: false, error: "photo_unavailable" });
      }
    });
  }
  return withRequestScope(false, function () { return routePost(e, data); });
}

function isPhotoRead(data) {
  return !!data && (data.event_type || data.event) === "booking_photo" && data.action === "read";
}

/** Leads MASTER — the workbook this script is bound to. */
function leadsBook() {
  return SPREADSHEET_ID ? SpreadsheetApp.openById(SPREADSHEET_ID)
                        : SpreadsheetApp.getActiveSpreadsheet();
}

/* `parsed` is the body doPost already parsed, so it is parsed (and a bad one
   logged) once. Called with the event alone, it parses for itself. */
function routePost(e, parsed) {
  const lock = LockService.getScriptLock();
  var writeLockHeld = false;
  try { lock.waitLock(20000); writeLockHeld = true; } catch (lockErr) { /* ordinary lead intake keeps its existing fallback */ }

  /* RELEASED EXACTLY ONCE, WHETHER EARLY OR IN THE FINALLY — r53.
     The reservation path lets go of the lock as soon as the SHEET work is
     done, well before this function returns, because what follows it is a
     Twilio call and a Gmail send that touch no sheet. See the call site below
     for the live bug that forced it. The finally still runs for every other
     path and for any throw, and calling this twice is a no-op. */
  var lockReleased = false;
  function releaseWriteLock() {
    if (lockReleased) return;
    lockReleased = true;
    try { lock.releaseLock(); } catch (releaseErr) { /* nothing to do */ }
  }

  try {
    const data = parsed === undefined ? parseBody(e) : parsed;
    if (!data) return json({ status: "error", message: "Empty or unparseable body" });

    const eventType     = data.event_type || data.event || "unknown";
    const isReservation = eventType === "reservation" || data.event === "quote_reserved";
    const ss = SPREADSHEET_ID ? SpreadsheetApp.openById(SPREADSHEET_ID)
                              : SpreadsheetApp.getActiveSpreadsheet();

    /* Late notes from the confirmation screen. Routed BEFORE handleEvent
       because these update an existing JOBS row rather than appending an
       EVENTS one — and EVENTS has no customer_notes column, so falling through
       would silently drop the whole message. */
    if (eventType === "job_notes") return handleJobNotes(ss, data);

    /* Room and general instructions edited from a client ticket. Routed here
       for the same reason as job_notes — it writes its own tab rather than
       appending an EVENTS row — and it authorises on the ticket token rather
       than on submission_id, because it is the customer editing their own
       booking rather than the site reporting one. */
    if (eventType === "booking_instruction") return handleInstruction(ss, data);
    if (eventType === "booking_photo") return handleBookingPhoto(ss, data);
    /* r50. What Stripe says happened to a card, relayed by the Worker after it
       has verified Stripe's signature. Routed here rather than through
       handleEvent because it updates a JOBS row and must never append an
       EVENTS one — and because it is the single caller allowed past the
       ops-owned guard on payment_status. */
    if (eventType === "payment_event") return handlePaymentEvent(ss, data);
    /* r48. A cleaner's note on a room, from the partner ticket. */
    if (eventType === "partner_note") return handlePartnerNote(ss, data);

    /* Portal writes. Authorised by a portal token and an ownership check
       rather than by a per-job ticket token — see handlePortalWrite. */
    if (eventType === "portal_write") {
      if (!writeLockHeld) return json({ ok: false, error: "save_failed" });
      return handlePortalWrite(ss, data);
    }

    /* Provider portal writes. Authorised by a provider token, and every field
       checked against a whitelist — a partner may describe themselves, not
       promote themselves. */
    if (eventType === "vendor_write") return handleVendorWrite(data);

    /* r55. The booking's text and email, sent after the customer already has
       their confirmation. See handleBookingNotify. */
    if (eventType === "booking_notify") {
      return handleBookingNotify(data, writeLockHeld, releaseWriteLock);
    }

    if (!isReservation) return handleEvent(ss, data, eventType);

    /* r55. Set by the Worker, never by a browser, and read exactly once: it
       is a delivery instruction, not booking data, so it must not reach a
       row or the "dropped fields" log. */
    const deferNotify = data.notify_deferred === true;
    delete data.notify_deferred;

    const jobs = requireTab(ss, JOBS_TAB);

    /* Idempotency first — a replay must mutate nothing anywhere.

       notify_pending on a replay is what rescues the text when attempt 1 ran
       past the Worker's budget: that Worker never saw the answer that would
       have told it to send, and this is the retry's Worker learning it. */
    if (alreadyWritten(jobs, data.submission_id)) {
      console.log("Duplicate submission_id — no JOBS row, no LEADS mutation: " + data.submission_id);
      return json({ status: "ok", duplicate: true, submission_id: data.submission_id,
                    notify_pending: hasPendingNotify(data.submission_id) });
    }

    /* THE PARTNER SHARE IN FORCE RIGHT NOW, stamped onto this booking so that
       changing the rate tomorrow cannot reprice it. Assigned, never defaulted:
       `data` came from a browser, and a payload arriving with its own
       payout_rate must not be the one that gets written. See currentPayoutRate.

       WHICH of the two shares, as of 2026-09-16, is also derived here rather
       than taken from the payload — a half-price first clean is passed through
       at 0.98, everything else pays the ordinary 0.85. See payoutRateFor. */
    data.payout_rate = payoutRateFor(data);

    const sched  = normalizeSchedule(data);
    const leadId = resolveLeadId(data);

    /* LEADS upsert BEFORE the JOBS row, so the foreign key points at something
       real. A failure here is logged and surfaced in the email, never fatal. */
    let leadResult;
    try {
      leadResult = upsertLead(ss, data, leadId);
    } catch (leadErr) {
      leadResult = { ok: false, action: "failed", error: String(leadErr), fields: [], missing: [] };
      console.error("LEADS upsert failed (JOBS row still written): " + leadErr);
    }

    /* PROPERTIES — moved AHEAD of the JOBS write as of r9.
       The JOBS row now carries property_id, so the property has to be resolved
       before the row is built. This does not weaken the guarantee that only the
       JOBS write can fail a booking: the call is wrapped, and a failure leaves
       property_id blank rather than stopping anything. The worst case is a
       property row for a booking that then fails to write — harmless, since the
       tab is blank-fill-only and the row is reused on the next attempt. */
    let propertyResult;
    try {
      propertyResult = upsertProperty(ss, data, propertyKey(data));
    } catch (propErr) {
      propertyResult = { ok: false, action: "failed", error: String(propErr), property_id: "" };
      console.error("PROPERTIES upsert failed (booking continues): " + propErr);
    }

    const record = buildJobRecord(data, sched, leadId, jobs, {
      property_id: propertyResult.property_id || "",
      contact_id:  leadResult.contact_id || "",
    });
    const write  = writeRow(jobs, record);
    const jobRow = jobs.getLastRow();

    /* Everything below happens AFTER the booking is safely recorded. None of it
       can fail the booking; each failure is reported in the notification. */

    /* Ops AVAILABILITY — stop the slot being sold twice. Reads at write time,
       inside the script lock doPost already holds. Never throws. */
    const slotResult = bookAvailabilitySlot(
      sched, record.job_id, serviceCodeOf(serviceLabel(data), data.frequency_selected));

    /* r16. The consumed slot knows whose capacity it was, so write that onto
       the JOBS row rather than making somebody copy it across by hand.

       INTO A BLANK CELL ONLY. vendor_id is on OPS_OWNED_COLUMNS; a
       dispatcher's own entry outranks an inference from the schedule. And
       it is wrapped, because nothing after the JOBS write may fail a
       booking. */
    try {
      stampJobVendor(jobs, jobRow, slotResult.vendorId);
    } catch (stampErr) {
      console.error("vendor_id stamp failed (booking stands): " + stampErr);
    }

    /* r38. The cadence they chose, recorded as an OFFER rather than a booking.
       No slot is held and no vendor assigned until they confirm it. In the same
       band as the vendor stamp and the SMS: wrapped on its own, so a failure
       costs the plan prompt rather than the clean. */
    var planResult = "skipped";
    try {
      planResult = createRecurringPlan(ss, data, record, {
        contact_id:  leadResult.contact_id || "",
        property_id: propertyResult.property_id || "",
      });
    } catch (planErr) {
      planResult = "failed";
      console.error("recurring plan not recorded (booking stands): " + planErr);
    }
    console.log("recurring plan " + record.job_id + ": " + planResult);

    /* ============================================================
       THE LOCK COMES OFF HERE — r53, AND THIS IS A BUG FIX.
       ============================================================

       THE LIVE SYMPTOM (2026-09-16). A founder test booking showed the yellow
       "we couldn't confirm your booking" panel while the booking had in fact
       completely succeeded: the JOBS row was written, the customer's text
       arrived, the portal link arrived, everything logged.

       WHY THE SERVER SUCCEEDING AND THE BROWSER BEING TOLD IT FAILED ARE
       CONSISTENT. Everything below this line — the Twilio call and the Gmail
       send — used to run INSIDE this lock, and the response is only returned
       after both. So:

         1. Attempt 1 overran the Worker's 12s submit budget
            (UPSTREAM_TIMEOUT_MS.submit in src/worker.js). The Worker answered
            its own 502 and the browser saw a failure. This function kept
            running and finished the booking, text included.

         2. The browser retried 1.2s later (RESERVE_RETRY_DELAY_MS in
            script.js) — and that attempt BLOCKED ON waitLock() ABOVE, behind
            attempt 1's still-running execution. It could not answer sooner
            than attempt 1 finished, so it burned its own 12s waiting and got
            a second 502. Two failures, one successful booking, and a
            paying customer told to email us.

       THE RETRY WAS STRUCTURALLY UNABLE TO HELP. It is the documented fix for
       a slow upstream, but on a reservation it queued behind the exact
       execution it was retrying.

       SO THE LOCK IS RELEASED AS SOON AS THE SHEET WORK IS DONE. Attempt 1
       still overruns and still gets a 502 — Twilio and Gmail are genuinely
       slow and this does not change that. But attempt 2 now takes the lock
       immediately, hits the alreadyWritten() dedupe above, and answers
       {status:"ok", duplicate:true} in about a second. Which the browser
       already treats as confirmed. The customer sees the confirmation screen.

       WHAT THIS LOCK IS FOR, AND WHY LETTING GO HERE IS SAFE: it serializes
       SHEET WRITES. Every one of them is above — the LEADS upsert, PROPERTIES,
       the JOBS row, the availability slot, the vendor stamp, the recurring
       plan. Neither sendBookingSms nor sendReservationEmail nor anything they
       call touches a spreadsheet; that was checked function by function, not
       assumed. ANYTHING ADDED BELOW THAT WRITES TO A SHEET MUST GO ABOVE THIS
       LINE INSTEAD, or it races another booking.

       NOT PROVEN IN PRODUCTION. The mechanism is read off the code and the
       Worker's budget; the Apps Script Executions log for that booking should
       show two executions, the first long and the second long and almost
       entirely idle. The suite cannot catch any of this — neither the lock nor
       the 12s budget exists in the harness. */

    /* r55. Everything the text and the email need, gathered once. Queued
       BEFORE the release so a retry that reaches the dedupe can already see
       it; a script property is not a sheet, and each booking has its own key. */
    const notice = {
      data: data, sched: sched, leadId: leadId, leadResult: leadResult,
      propertyResult: propertyResult, slotResult: slotResult,
      contactId: (leadResult && leadResult.contact_id) || "",
      jobId: record.job_id, queuedAt: Date.now(),
    };
    const notifyPending = deferNotify && queueBookingNotify(notice);

    releaseWriteLock();

    /* Not deferred — a caller other than the Worker, or a notice too large to
       park — means the old behaviour exactly: send now, answer after. */
    if (!notifyPending) deliverBookingNotify(notice);

    return json({
      status: "ok",
      duplicate: false,
      notify_pending: notifyPending,
      submission_id: data.submission_id || "",
      lead_id: leadId,
      job_id: record.job_id,
      lead_action: leadResult.action,
      property_action: propertyResult.action,
      slot_action: slotResult.action,
      dropped_fields: write.noColumn,
      row: jobs.getLastRow(),
    });

  } catch (err) {
    console.error("doPost failed: " + (err && err.stack ? err.stack : err));
    return json({ status: "error", message: String(err) });
  } finally {
    /* A no-op when the reservation path already let go above. */
    releaseWriteLock();
  }
}

/**
 * Late notes, captured on the confirmation screen once the booking is safe.
 *
 * The reserve step used to carry an "anything we should know?" textarea. It was
 * removed because asking at the moment of commitment costs bookings; the same
 * question is now asked after the spot is claimed, where hesitation is free.
 *
 * THIS UPDATES AN EXISTING ROW, which makes it the one write path that
 * deliberately skips alreadyWritten(). Everywhere else a repeated
 * submission_id means a replay to be ignored; here it is the whole point — the
 * id is how we find the booking these notes belong to.
 *
 * Blank-fill only, matching every other upsert in this workbook. Someone who
 * sends notes twice cannot erase the first message, and an operator's
 * hand-edit always survives.
 *
 * Never throws. The booking is already recorded and confirmed on screen; a
 * failure here must not turn a completed booking into an error the customer
 * sees.
 */
function handleJobNotes(ss, data) {
  const id    = String(data.submission_id || "").trim();
  const notes = String(data.customer_notes || "").trim();

  if (!id)    return json({ status: "error", message: "job_notes requires a submission_id" });
  if (!notes) return json({ status: "ok", skipped: "empty notes" });

  try {
    const jobs    = requireTab(ss, JOBS_TAB);
    const headers = sheetHeaders(jobs);
    const idCol   = headers.indexOf("submission_id");
    const noteCol = headers.indexOf("customer_notes");
    const petCol  = headers.indexOf("pets_flag");

    if (idCol === -1)   return json({ status: "error", message: "JOBS has no submission_id column" });
    if (noteCol === -1) return json({ status: "error", message: "JOBS has no customer_notes column" });

    const lastRow = jobs.getLastRow();
    if (lastRow < 2) return json({ status: "error", message: "no rows to match" });

    const ids = jobs.getRange(2, idCol + 1, lastRow - 1, 1).getValues();
    let row = -1;
    for (let i = 0; i < ids.length; i++) {
      if (String(ids[i][0]).trim() === id) { row = i + 2; break; }
    }
    if (row === -1) {
      console.warn("job_notes for an unknown submission_id: " + id);
      return json({ status: "error", message: "no job matches that submission_id" });
    }

    const existing = String(jobs.getRange(row, noteCol + 1).getValue()).trim();
    if (existing) {
      console.log("job_notes ignored — row " + row + " already has notes.");
      return json({ status: "ok", duplicate: true, row: row });
    }

    jobs.getRange(row, noteCol + 1).setValue(notes);

    /* Derived here rather than trusted from the browser, for the same reason
       the price will be: it is the one field a client could set to anything. */
    if (petCol !== -1) jobs.getRange(row, petCol + 1).setValue(petsFromText(notes));

    console.log("job_notes written to JOBS row " + row + " for " + id);
    try { sendJobNotesEmail(data, notes, row); }
    catch (mailErr) { console.error("job_notes email failed: " + mailErr); }

    return json({ status: "ok", row: row, submission_id: id });

  } catch (err) {
    console.error("handleJobNotes failed: " + (err && err.stack ? err.stack : err));
    return json({ status: "error", message: String(err) });
  }
}

/** The crew needs this before they arrive, so it goes out on its own. */
function sendJobNotesEmail(data, notes, row) {
  MailApp.sendEmail(
    notifyEmail(),
    "Serve — notes added after booking · " + (data.name || "Unknown") +
      (petsFromText(notes) ? " · PETS" : ""),
    "A customer added notes on the confirmation screen, after their booking " +
    "was already recorded.\n\n" +
    "— WHAT THEY TOLD US —\n" + notes + "\n\n" +
    "Pets:       " + (petsFromText(notes) ? "YES — plan around them" : "none mentioned") + "\n" +
    "JOBS row:   " + row + "\n" +
    "Submission: " + (data.submission_id || "(none)") + "\n\n" +
    "Worth copying anything durable into PROPERTY_MEMORY — this is about the\n" +
    "home, not just this one visit."
  );
}

/** Non-reservation events. Never LEADS (identity-less rows), never RAW INTAKE. */
function handleEvent(ss, data, eventType) {
  const sheet = eventsTab(ss);

  if (alreadyWritten(sheet, data.submission_id)) {
    return json({ status: "ok", duplicate: true, submission_id: data.submission_id });
  }

  const record = { received_at: receivedAt() };
  EVENTS_HEADERS.forEach(function (h) {
    if (h !== "received_at" && data[h] !== undefined) record[h] = data[h];
  });
  const write = writeRow(sheet, record, {});   // EVENTS uses raw payload names

  try { sendEventEmail(eventType, data); }
  catch (mailErr) { console.error("Email send failed: " + mailErr); }

  return json({
    status: "ok", duplicate: false, tab: EVENTS_TAB,
    submission_id: data.submission_id || "", dropped_fields: write.noColumn,
  });
}

/** Health check — open the /exec URL in a browser. */
/* r44. A GET writes nothing, so every tab it reads is read once and shared
   for the rest of the request. See "ONE READ PER TAB, PER REQUEST". */
function doGet(e) {
  return withRequestScope(true, function () { return routeGet(e); });
}

function routeGet(e) {
  /* One job ticket, rendered by /j on the site. Everything else is the health
     check that has always been here. */
  var p = (e && e.parameter) || {};
  if (p.job) return handleTicket(p);
  if (p.portal) return handlePortal(p);
  if (p.vendor) return handleVendorPortal(p);
  if (p.property) return handleKnownProperty(p.property);
  /* r56. "Did that booking land?" — see handleBookingStatus. A GET on purpose:
     it writes nothing, and on a script older than r56 it falls through to the
     health stamp below rather than creating anything. */
  if (p.booking) return handleBookingStatus(p.booking);

  return json({ ok: true, service: "serve-booking-webhook", version: "2026-09-25 r61" });
}


/**
 * GET ?booking=<submission_id>  ->  {ok:true, found:<bool>, notify_pending:<bool>}
 *
 * THE CHEAP QUESTION. A reservation POST is a dozen Sheets calls, two workbooks
 * and the script lock; when it overran the Worker's 12s budget the browser was
 * left with no way to find out that the booking had in fact completed, so it
 * showed the failure panel over a perfectly good booking. This is the same
 * question asked for the price of ONE COLUMN READ, and it can be asked
 * repeatedly while the slow write is still in flight.
 *
 * NO LOCK, DELIBERATELY, AND THIS IS THE WHOLE POINT. routePost waits up to 20s
 * for the script lock before it routes anything, so a status check sent through
 * doPost would queue behind the very booking it is asking about — the same
 * structural trap r53 found in the retry. doGet takes no lock, and a read needs
 * none: a half-written booking reads as not-found, which is the honest answer,
 * and the next poll two seconds later says yes.
 *
 * IT SHARES A PREDICATE WITH THE DEDUPE RATHER THAN RE-IMPLEMENTING ONE.
 * alreadyWritten() is what a replayed reservation answers duplicate:true on, so
 * "the screen says confirmed" and "a retry would say duplicate" can never drift
 * apart. Two opinions about whether a booking exists is two different screens
 * for one customer.
 *
 * NOTHING ABOUT THE CUSTOMER CROSSES THIS BOUNDARY — not a name, a number, an
 * address, a price or a job_id. A submission_id is a random id the browser
 * minted for itself, and the answer is one boolean about that id. Someone
 * guessing ids learns only that a random UUID they invented is not a booking.
 */
function handleBookingStatus(submissionId) {
  var id = String(submissionId || "").trim();
  if (!NOTIFY_ID_SHAPE.test(id)) return json({ ok: false, error: "bad_submission_id" });

  var jobs = leadsBook().getSheetByName(JOBS_TAB);
  if (!jobs) return json({ ok: false, error: "unavailable" });

  var found = alreadyWritten(jobs, id);

  /* r55's parked text and email. Reported for the same reason the dedupe
     reports it: the Worker that asked may be the only one that ever learns a
     notice is waiting, because the Worker that took the booking gave up
     before it was answered. */
  return json({ ok: true, found: found,
                notify_pending: found && hasPendingNotify(id) });
}


/**
 * POST an instruction from a client ticket.
 *
 * THE TICKET TOKEN IS THE AUTHORIZATION, and it must be the CLIENT token —
 * a partner may read a job, never rewrite what the customer asked for.
 *
 * `scope_key` is validated against the rooms this booking actually implies.
 * Without that check the tab becomes a free-text store keyed on whatever a
 * caller sends, and the ticket quietly stops showing instructions because they
 * were filed under a room that does not exist.
 *
 * NEVER FATAL, like handleJobNotes. The booking is already made; a failure to
 * save a note must return an error the page can show, not throw.
 */
function handleInstruction(ss, data) {
  var jobId = String(data.job_id || "").trim();
  var token = String(data.t || "").trim();
  if (!jobId || ticketToken(jobId, "client") !== token) {
    return json({ ok: false, error: "not_found" });
  }

  try {
    var booking = getBooking(ss, jobId);
    if (!booking) return json({ ok: false, error: "not_found" });
    /* A finished job is a record, not a worksheet. */
    if (booking.completedDate) return json({ ok: false, error: "closed" });

    var raw = String(data.scope_type || "BOOKING").toUpperCase();
    var scopeType = (raw === "ROOM" || raw === "ACCESS") ? raw : "BOOKING";
    var scopeKey  = String(data.scope_key || "GENERAL").toUpperCase();
    if (scopeType === "BOOKING") scopeKey = "GENERAL";
    if (scopeType === "ACCESS" && !ACCESS_KEYS[scopeKey]) {
      return json({ ok: false, error: "unknown_access_field" });
    }

    var allowed = validScopeKeys(booking.beds, booking.baths);
    if (!allowed[scopeKey]) return json({ ok: false, error: "unknown_room" });

    var text = String(data.instruction || "").trim().slice(0, 2000);

    var sheet = ensureInstructionsTab(ss);
    var h = sheetHeaders(sheet);
    var col = function (n) { return h.indexOf(n); };
    var now = new Date();

    /* Update in place when this scope already has a row. */
    var last = sheet.getLastRow();
    if (last > 1) {
      var rows = sheet.getRange(2, 1, last - 1, h.length).getValues();
      for (var i = 0; i < rows.length; i++) {
        if (String(rows[i][col("job_id")]).trim() !== jobId) continue;
        if (String(rows[i][col("scope_type")]).toUpperCase() !== scopeType) continue;
        if (String(rows[i][col("scope_key")]).toUpperCase() !== scopeKey) continue;
        sheet.getRange(i + 2, col("instruction") + 1).setValue(text);
        sheet.getRange(i + 2, col("updated_at") + 1).setValue(now);
        return json({ ok: true, updated: true, scope_key: scopeKey });
      }
    }

    if (!text) return json({ ok: true, updated: false, scope_key: scopeKey });

    var row = new Array(h.length).fill("");
    row[col("instruction_id")] = "INS-" + Utilities.getUuid().slice(0, 8).toUpperCase();
    row[col("job_id")]      = jobId;
    row[col("scope_type")]  = scopeType;
    row[col("scope_key")]   = scopeKey;
    row[col("instruction")] = text;
    row[col("created_at")]  = now;
    row[col("updated_at")]  = now;
    row[col("source")]      = "client";
    sheet.appendRow(row);
    return json({ ok: true, created: true, scope_key: scopeKey });

  } catch (err) {
    console.error("handleInstruction failed: " + (err && err.stack ? err.stack : err));
    return json({ ok: false, error: "save_failed" });
  }
}

/** Auto-created on first use, exactly like EVENTS. No setup step. */
function ensureInstructionsTab(ss) {
  assertWritable(INSTRUCTIONS_TAB);
  var sheet = ss.getSheetByName(INSTRUCTIONS_TAB);
  if (!sheet) {
    sheet = ss.insertSheet(INSTRUCTIONS_TAB);
    sheet.appendRow(INSTRUCTIONS_HEADERS);
    sheet.setFrozenRows(1);
    console.log('Created the "' + INSTRUCTIONS_TAB + '" tab.');
  }
  return sheet;
}

/* PARTNER_NOTES — what the cleaner wants the customer, their company or Serve
   to know about a room. r48.
   -------------------------------------------------------------------
   ITS OWN TAB, NOT ANOTHER scope_type IN BOOKING_INSTRUCTIONS. That tab is
   read by sortInstructions, which files anything that is not ROOM or ACCESS
   as the customer's general note — so a cleaner's note stored there would
   replace what the customer asked for, on the customer's own page. Nothing
   reads this tab unless it names it.

   One row per (job_id, vendor_id, room_key), updated in place like an
   instruction; blanking the text keeps the row and empties it. The vendor
   company is stamped when the note is written, so a job moved to another
   company does not hand them the first company's notes. Auto-created on the
   first non-empty note. */
const PARTNER_NOTES_TAB = "PARTNER_NOTES";
const PARTNER_NOTES_HEADERS = ["note_id", "job_id", "vendor_id", "room_key",
  "room_label", "note", "created_at", "updated_at"];

function partnerNoteRows(ss) {
  var table = readTable(ss, PARTNER_NOTES_TAB);
  if (!table || !table.rows.length) return [];
  var h = table.headers;
  return table.rows.map(function (row) {
    var out = {};
    PARTNER_NOTES_HEADERS.forEach(function (key) {
      var i = h.indexOf(key);
      out[key] = i < 0 || row[i] === null || row[i] === undefined ? "" : String(row[i]).trim();
    });
    return out;
  });
}

/** The current note for one room, from one company, on one job. "" if none. */
function partnerNoteFor(rows, jobId, vendorId, roomKey) {
  var hit = rows.filter(function (n) {
    return n.job_id === String(jobId) && n.vendor_id === String(vendorId || "") &&
           n.room_key.toUpperCase() === roomKey;
  })[0];
  return hit ? hit.note : "";
}

/** A job's notes from its company, in room order: label and text, nothing else. */
function partnerNotesForRooms(rows, booking) {
  if (!booking.vendorId) return [];
  return deriveRooms(booking.beds, booking.baths).map(function (r) {
    return { roomLabel: r.label, note: partnerNoteFor(rows, booking.bookingId, booking.vendorId, r.key) };
  }).filter(function (n) { return n.note; });
}

/* Routed from routePost. A PARTNER ticket token only: the customer's ticket,
   the portal and the vendor portal cannot write a cleaner's note. Never fatal,
   like handleInstruction. */
function handlePartnerNote(ss, data) {
  var jobId = String(data.job_id || "").trim();
  if (!jobId || ticketToken(jobId, "partner") !== String(data.t || "").trim()) {
    return json({ ok: false, error: "not_found" });
  }
  try {
    var booking = getBooking(ss, jobId);
    if (!booking || !booking.vendorId) return json({ ok: false, error: "not_found" });
    if (booking.completedDate || bookingIsCancelled(booking)) return json({ ok: false, error: "closed" });

    var roomKey = String(data.room_key || "").trim().toUpperCase();
    var room = deriveRooms(booking.beds, booking.baths).filter(function (r) { return r.key === roomKey; })[0];
    if (!room) return json({ ok: false, error: "unknown_room" });

    var text = String(data.note || "").trim().slice(0, 2000);
    /* Typed by hand into a workbook that holds customer details: a note that
       starts like a formula is kept as text, never evaluated. */
    var cellText = /^[=+\-@]/.test(text) ? "'" + text : text;
    var vendorId = String(booking.vendorId);

    assertWritable(PARTNER_NOTES_TAB);
    var sheet = ss.getSheetByName(PARTNER_NOTES_TAB);
    if (!sheet) {
      if (!text) return json({ ok: true, updated: false });
      sheet = ss.insertSheet(PARTNER_NOTES_TAB);
      sheet.appendRow(PARTNER_NOTES_HEADERS);
      sheet.setFrozenRows(1);
    }
    var table = sheetValues(sheet), h = table.headers, now = new Date();
    if (PARTNER_NOTES_HEADERS.some(function (k) { return h.indexOf(k) < 0; })) {
      return json({ ok: false, error: "save_failed" });
    }
    for (var i = 0; i < table.rows.length; i++) {
      var r = table.rows[i];
      if (String(r[h.indexOf("job_id")]).trim() !== jobId) continue;
      if (String(r[h.indexOf("vendor_id")]).trim() !== vendorId) continue;
      if (String(r[h.indexOf("room_key")]).trim().toUpperCase() !== roomKey) continue;
      sheet.getRange(i + 2, h.indexOf("note") + 1).setValue(cellText);
      sheet.getRange(i + 2, h.indexOf("updated_at") + 1).setValue(now);
      return json({ ok: true, updated: true });
    }
    if (!text) return json({ ok: true, updated: false });

    var record = { note_id: "NOTE-" + Utilities.getUuid().slice(0, 8).toUpperCase(),
      job_id: jobId, vendor_id: vendorId, room_key: roomKey, room_label: room.label,
      note: cellText, created_at: now, updated_at: now };
    sheet.appendRow(h.map(function (k) { return record[k] === undefined ? "" : record[k]; }));
    return json({ ok: true, created: true });
  } catch (err) {
    console.error("handlePartnerNote failed: " + (err && err.stack ? err.stack : err));
    return json({ ok: false, error: "save_failed" });
  }
}


/* ============================================================
   SERVE DOMAIN LAYER  —  sheet rows in, normalized objects out
   ============================================================
   Added r13.

   THE POINT: nothing above the repositories may know a sheet column name.
   The tabs get renamed, columns get inserted, a tab moves to a database — and
   the only things that have to change are the four `get*` functions below.
   Everything downstream speaks Serve's own vocabulary.

   THREE LAYERS, and the order matters:

     get*()                sheet row  ->  normalized domain object
     build*TicketModel()   domain object -> what one audience may see
     the page              renders a view model and asks no questions

   A VIEW MODEL IS A WHITELIST, NEVER A FILTER. Every field a browser receives
   is named explicitly in the builder. The alternative — take the row and
   delete the private parts — fails open: a column added to JOBS next month
   arrives in the browser because nobody remembered to exclude it. Building up
   fails closed, which is the direction a mistake should go.

   WHAT DOES NOT EXIST YET, and is not invented here: there is no VENDORS tab,
   no OPERATORS tab and no ASSIGNMENTS tab. Serve has no partner companies.
   `getAssignment` therefore reads the one thing that is real — the `cleaner`
   cell on the JOBS row — and reports `pending` when it is blank. The shapes
   are right so a registry can be added without touching the ticket; the data
   is not faked so the ticket cannot claim a partner that does not exist. */

/** The service taxonomy. Serve's codes, not the sheet's labels. */
var SERVICE_CODES = {
  CLEAN_STANDARD: "Recurring clean",
  CLEAN_DEEP:     "First clean",
  CLEAN_MOVEOUT:  "Move in / move out",
};

/**
 * JOBS stores a human label in `service_type` and the cadence in `frequency`.
 * Neither alone is the service: a First Clean on a biweekly plan is the start
 * of a recurring relationship, and a First Clean on its own is a deep clean.
 */
function serviceCodeOf(label, frequency) {
  var s = String(label || "").toLowerCase();
  var f = String(frequency || "once").toLowerCase();
  if (s.indexOf("move") !== -1) return "CLEAN_MOVEOUT";
  /* r36. WHAT WAS BOOKED WINS OVER THE CADENCE. This test used to sit below the
     frequency one, which made every first clean sold with a plan report itself
     as a recurring clean — to the customer, to the crew, and to the vendor
     ranking. The plan is real, but it describes the visits after this one. */
  if (s.indexOf("first") !== -1 || s.indexOf("deep") !== -1) return "CLEAN_DEEP";
  if (f && f !== "once")        return "CLEAN_STANDARD";
  return "CLEAN_DEEP";
}

/**
 * The rooms a booking implies, as stable keys plus display labels.
 *
 * V1 IS A LIST, NOT A FLOORPLAN. The booking already knows the bed and bath
 * count, which is enough to give someone a place to attach "fresh sheets are
 * in the closet" to. A drawn plan would need data nobody has collected.
 *
 * The KEY is what gets stored and must never be re-worded; the LABEL is what a
 * person reads and may change freely.
 */
function deriveRooms(beds, baths) {
  var rooms = [];
  var b = Math.max(0, Math.round(Number(beds) || 0));
  var t = Math.max(0, Number(baths) || 0);

  if (b === 0) rooms.push({ key: "STUDIO_MAIN", label: "Main room" });
  for (var i = 1; i <= b; i++) rooms.push({ key: "BEDROOM_" + i, label: "Bedroom " + i });

  var full = Math.floor(t);
  for (var j = 1; j <= full; j++) rooms.push({ key: "BATHROOM_" + j, label: "Bathroom " + j });
  /* Half baths are a real category in Boston listings and the calculator
     already prices them at 0.5 — so they get their own room, not a rounding. */
  if (t - full >= 0.5) rooms.push({ key: "BATHROOM_HALF", label: "Half bath" });

  rooms.push({ key: "KITCHEN",     label: "Kitchen" });
  rooms.push({ key: "LIVING_ROOM", label: "Living room" });
  return rooms;
}

/* THE ACCESS QUESTIONS, as options rather than free text.
   -------------------------------------------------------------------
   ONE STRUCTURE DRIVES THREE THINGS: the bullets the portal renders, the
   validation on write, and where each answer is stored. Three separate lists
   would be three chances to disagree about what "KEY" means.

   A choice is what Serve can route on — "no parking" is actionable, a
   paragraph mentioning parking is not. The optional detail is what a human
   reads, and only some choices have one.

   `secret: true` is the door code, and it is the reason this table exists in
   this shape. Its detail is written to `entry_code`, which NO VIEW MODEL
   RETURNS. The customer sets it and the portal thereafter shows only the date
   it was saved. Codes still reach the cleaner by direct message at dispatch;
   a URL token has never been the place for one and still is not. */
var ACCESS_QUESTIONS = [
  {
    field: "occupancy",
    label: "Will someone be home?",
    choices: [
      { key: "YES",   label: "Yes" },
      { key: "NO",    label: "No" },
      { key: "OTHER", label: "Other", detail: "Tell us more" },
    ],
  },
  {
    field: "entry",
    /* `access_notes` used to be its own question. It is this question's detail
       box now — "how do we get in" and "notes about getting in" were always
       one thing asked twice. */
    label: "How to get in",
    choices: [
      { key: "LET_IN",   label: "I'll let you in" },
      { key: "KEY",      label: "Key",         detail: "Where will the key be?" },
      { key: "CODE",     label: "Access code", detail: "Access code", secret: true },
      { key: "UNLOCKED", label: "Unlocked for instant entry and service" },
      { key: "OTHER",    label: "Other",       detail: "Tell us more" },
    ],
  },
  {
    field: "parking",
    label: "Parking",
    choices: [
      { key: "FREE_STREET", label: "Free available street parking" },
      { key: "PAID_STREET", label: "Paid street parking" },
      { key: "GARAGE",      label: "Parking garage" },
      { key: "NONE",        label: "No parking" },
      { key: "OTHER",       label: "Other", detail: "Tell us more" },
    ],
  },
];

/* Pets is deliberately not a question with choices. The booking form already
   screens for pets, so this is the one thing left worth knowing. */
var ACCESS_PET_PLACEHOLDER = "We'd love to know their names!";

/** The choice definition for a field, or null when the key is not one of ours. */
function accessChoice(field, key) {
  for (var i = 0; i < ACCESS_QUESTIONS.length; i++) {
    var q = ACCESS_QUESTIONS[i];
    if (q.field !== field) continue;
    for (var j = 0; j < q.choices.length; j++) {
      if (q.choices[j].key === String(key || "").toUpperCase()) return q.choices[j];
    }
  }
  return null;
}

/* The old per-booking ACCESS scope keys, kept so instructions written before
   the portal existed still render. Nothing writes these any more. */
var ACCESS_KEYS = {
  OCCUPANCY: "Will someone be home?",
  METHOD:    "How to get in",
  NOTES:     "Access notes",
  PARKING:   "Parking",
  PETS:      "Pets",
};

/**
 * Every scope key this booking may legitimately carry.
 *
 * Validated on write. Without it the tab becomes a free-text store keyed on
 * whatever a caller sends, and instructions silently vanish from the ticket
 * because they were filed under a room that does not exist.
 */
function validScopeKeys(beds, baths) {
  var keys = { GENERAL: true };
  deriveRooms(beds, baths).forEach(function (r) { keys[r.key] = true; });
  Object.keys(ACCESS_KEYS).forEach(function (k) { keys[k] = true; });
  return keys;
}

/* ---------- repositories: one sheet row -> one domain object ---------- */

/**
 * The booking, by id. Returns null when there is no such row — never a partial
 * object, because a caller that has to check each field for emptiness is a
 * caller that will forget to.
 */
function getBooking(ss, jobId) {
  var jobs = requireTable(ss, JOBS_TAB);
  var idCol = jobs.headers.indexOf("job_id");
  if (idCol === -1) return null;

  var want = String(jobId).trim();
  for (var i = 0; i < jobs.rows.length; i++) {
    if (String(jobs.rows[i][idCol]).trim() === want) {
      return bookingFromRow(jobs.headers, jobs.rows[i], sheetTimeZone(ss));
    }
  }
  return null;
}

/**
 * One JOBS row as a booking. r44: split out of getBooking so that a caller
 * already holding the rows — every booking of one contact, every job of one
 * vendor — builds each booking from the row in hand, instead of searching JOBS
 * again once per booking.
 *
 * `h` is the JOBS header row and `tz` MUST be the Leads workbook's own
 * timezone, sheetTimeZone(ss). r32: Sheets built these Dates from the
 * SPREADSHEET timezone, so that is the only one that reads them back as they
 * were typed.
 */
function bookingFromRow(h, values, tz) {
  var f = function (name) { var c = h.indexOf(name); return c === -1 ? "" : values[c]; };

  var beds  = Number(f("beds"));
  var baths = Number(f("baths"));
  var meta  = {};
  try { meta = JSON.parse(f("quote_meta") || "{}") || {}; } catch (_) { meta = {}; }

  return {
    /* identity */
    bookingId:    String(f("job_id")),
    customerId:   String(f("lead_id") || ""),
    propertyId:   String(f("property_id") || ""),
    propertyKey:  String(f("property_key") || ""),
    submissionId: String(f("submission_id") || ""),

    /* what was bought */
    serviceCode:  serviceCodeOf(f("service_type"), f("frequency")),
    serviceLabel: String(f("service_type") || ""),
    frequency:    String(f("frequency") || ""),
    condition:    String(f("condition") || ""),
    addOns:       String(f("add_ons") || ""),

    /* the home, as priced */
    beds:   isNaN(beds) ? null : beds,
    baths:  isNaN(baths) ? null : baths,
    levels: Number(meta.levels) || 1,

    /* when — READ THROUGH THE CELL NORMALISERS, never String() directly, and
       through the SPREADSHEET's timezone rather than the project's.
       See dateCellText/timeCellText: a cell an operator formatted as a date or
       a time comes back from getValues() as a Date. String()ing one put
       "Fri Dec 29 1899 22:00:00 GMT-0500 (Eastern Standard Time)" at the top of
       live booking slips (r23), and reading one with LOCAL getters put the
       wrong DAY there whenever the workbook's timezone differed from the
       project's (r32). `tz` is what closes the second one. */
    scheduledDate:   dateCellText(f("scheduled_date"), tz),
    startTime:       timeCellText(f("start_time"), tz),
    scheduleSummary: String(f("notes") || ""),
    completedDate:   dateCellText(f("completed_date"), tz).trim(),
    status:          String(f("job_status") || ""),

    /* MONEY, AND THE TWO SIDES OF IT ARE NOT THE SAME NUMBER.
       `price` is what the customer pays and belongs only to the client view.
       `partnerPayout` is what the crew is paid and belongs only to the partner
       view. Serve's margin is the difference, and it stays visible to neither.
       Keeping them in separate fields is what makes that easy to get right —
       one `price` object passed to both would be one careless line away from
       showing a partner the retail rate. */
    price: {
      quoted: f("quoted_price"),
      final:  f("final_price"),
      addOnRevenue: f("add_on_rev"),
    },
    partnerPayout: f("partner_payout"),
    /* The share agreed when THIS booking was made, not the one in force today.
       Blank on anything booked before r24, which is a real state and reads as
       "no derived payout" rather than as zero. */
    payoutRate:    Number(meta.payout_rate) || null,
    /* THE COLUMN MODELS TWO STATES AND THE FLOW HAS THREE (r50).
       Until the Stripe write-back existed, `paid` was the only question worth
       asking, because the only thing that could set this cell was an operator
       typing into it after money had already moved. Authorize-at-booking adds
       a middle state the old shape could not say:

         not authorized  ->  authorized (held, NO money moved)  ->  paid

       Writing "paid" on a mere hold would tell a customer they have been
       charged when they have not, and hide the Authorize button from the one
       person who still needs it. So `paid` keeps its exact old meaning — money
       actually taken — and `authorized` is a new, separate field.

       `released` IS deliberately NEITHER. A voided hold is a booking back to
       needing authorization, which is the same thing the blank cell means, and
       every surface should treat it that way.

       `refunded` WAS treated the same way and should not have been (r60).
       A released hold means no money ever moved; a refund means money moved
       and a person decided to hand it back. Collapsing the two told a
       customer who had paid and been refunded that they were "Not yet
       authorized", and put a live Authorize button in front of them — a
       second hold on a booking somebody had deliberately refunded, which is
       the exact failure r50's write-back existed to end, arriving through a
       different door. So it gets its own flag. */
    payment: {
      status:     String(f("payment_status") || ""),
      paid:       String(f("payment_status") || "").toLowerCase() === "paid",
      authorized: String(f("payment_status") || "").toLowerCase() === "authorized",
      refunded:   String(f("payment_status") || "").toLowerCase() === "refunded",
      /* INTERNAL. The Stripe PaymentIntent behind the state above — the handle
         that ties this row to the dashboard, and what the Worker voids when a
         customer cancels. Reaches no view model; see the whitelists. */
      ref:        String(f("payment_ref") || ""),
    },

    /* people — INTERNAL */
    customerName:  String(f("name") || ""),
    customerEmail: String(f("email") || ""),
    customerPhone: String(f("phone") || ""),

    /* where — INTERNAL, partner-only */
    address: String(f("address") || ""),
    unit:    String(f("unit") || ""),
    zip:     String(f("zip") || ""),

    petsFlag:      f("pets_flag") === true || String(f("pets_flag")).toUpperCase() === "TRUE",
    customerNotes: String(f("customer_notes") || ""),
    cleanerCell:   String(f("cleaner") || ""),
    /* Assignment, r15. Two ops-owned columns filled at dispatch beside the
       cleaner cell. Absent columns read as blank, which is the unassigned
       state and a legitimate one. */
    vendorId:      String(f("vendor_id") || ""),
    operatorId:    String(f("operator_id") || ""),
  };
}

/**
 * Durable knowledge about the home, from PROPERTY_MEMORY. This is deliberately
 * PROPERTY-scoped rather than booking-scoped: the door is in the same place
 * next month, and re-asking every visit is what "Serve remembers your home"
 * exists to stop.
 *
 * Never fatal. A missing tab or row means an empty access record, and the job
 * still runs — the crew simply learns it on the day, as they always did.
 */
function getBookingAccess(ss, propertyId) {
  var empty = { accessMethod: "", accessNotes: "", parkingNotes: "", petNotes: "",
                priorityRooms: "", skipAreas: "", productNotes: "", timingNotes: "" };
  if (!propertyId) return empty;
  try {
    var mt = readTable(ss, PROPERTY_MEMORY_TAB);
    if (!mt) return empty;
    var mh = mt.headers;
    var mi = mh.indexOf("property_id");
    if (mi === -1 || !mt.rows.length) return empty;

    var rows = mt.rows;
    for (var k = 0; k < rows.length; k++) {
      if (String(rows[k][mi]).trim() !== String(propertyId).trim()) continue;
      var m = {};
      mh.forEach(function (name, idx) { m[name] = rows[k][idx]; });
      return {
        accessMethod:  String(m.access_method  || ""),
        accessNotes:   String(m.access_notes   || ""),
        parkingNotes:  String(m.parking_notes  || ""),
        petNotes:      String(m.pets           || ""),
        priorityRooms: String(m.priority_rooms || ""),
        skipAreas:     String(m.skip_areas     || ""),
        productNotes:  String(m.product_notes  || ""),
        timingNotes:   String(m.timing_notes   || ""),
      };
    }
  } catch (err) {
    console.warn("PROPERTY_MEMORY lookup failed: " + err);
  }
  return empty;
}

/**
 * Per-booking instructions, scoped to the whole job or to one room.
 *
 * BOOKING-scoped on purpose, unlike access. "Fresh sheets are in the closet"
 * is about this visit; "the lockbox is round the back" is about the house.
 * Mixing them means either re-typing the house every time or carrying a
 * one-off note forward forever.
 */
function getBookingInstructions(ss, jobId) {
  var out = [];
  try {
    var t = readTable(ss, INSTRUCTIONS_TAB);
    if (!t) return out;
    var h = t.headers;
    if (!t.rows.length) return out;
    var idx = function (n) { return h.indexOf(n); };
    if (idx("job_id") === -1) return out;

    var rows = t.rows;
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i][idx("job_id")]).trim() !== String(jobId).trim()) continue;
      var text = String(rows[i][idx("instruction")] || "").trim();
      if (!text) continue;                       // blanked by an edit; not a note
      out.push({
        instructionId: String(rows[i][idx("instruction_id")] || ""),
        scopeType:     String(rows[i][idx("scope_type")] || "BOOKING").toUpperCase(),
        scopeKey:      String(rows[i][idx("scope_key")] || "GENERAL").toUpperCase(),
        instruction:   text,
        updatedAt:     String(rows[i][idx("updated_at")] || ""),
      });
    }
  } catch (err) {
    console.warn("BOOKING_INSTRUCTIONS read failed: " + err);
  }
  return out;
}

/**
 * Who is doing this job.
 *
 * THERE IS NO VENDOR REGISTRY YET, so this reads the only thing that exists:
 * the `cleaner` cell an operator types on the JOBS row. It reports the shape a
 * real assignment will have, with `vendorId` null, so the ticket renders the
 * unassigned state honestly today and needs no change the day VENDORS exists.
 */
function getAssignment(ss, booking) {
  var label    = String(booking.cleanerCell || "").trim();
  var vendorId = String(booking.vendorId || "").trim();
  return {
    bookingId:  booking.bookingId,
    /* Real as of r15: two columns on the JOBS row, filled at dispatch beside
       the `cleaner` cell. Blank until then, and blank is a legitimate state —
       the client ticket says the professional will be confirmed rather than
       inventing one. */
    vendorId:   vendorId || null,
    operatorId: String(booking.operatorId || "").trim() || null,
    /* Internal. A view model may use it to decide "assigned or not"; it may
       never be sent to a browser, because it is a person's name typed into a
       spreadsheet, not a vetted public display name. */
    internalLabel: label,
    status:     (vendorId || label) ? "assigned" : "pending",
    assignedAt: null,
  };
}



/* ---------- view models: explicit whitelists ---------- */

/**
 * The only vendor shape a customer may ever receive.
 *
 * BUILT UP, NOT FILTERED DOWN. Naming each field means a column added to
 * VENDORS later — payout rate, dispatch score, margin — cannot reach a browser
 * by default. It has to be added here on purpose.
 *
 * Returns null when there is nothing legitimate to show, which the ticket
 * renders as "your service professional will be confirmed". An empty card
 * would be worse than no card.
 */
function buildClientVendorProfile(vendor) {
  if (!vendor || !vendor.clientVisible) return null;
  if (!vendor.displayName) return null;
  return {
    displayName:       vendor.displayName,
    logoUrl:           vendor.logoUrl || "",
    publicDescription: vendor.publicDescription || "",
    partnerSince:      vendor.partnerSince || "",
    insuranceVerified: vendor.insuranceVerified === true,
    serviceArea:       vendor.serviceArea || "",
    rating:            typeof vendor.publicRating === "number" && vendor.publicRating > 0
                         ? vendor.publicRating : null,
    reviewCount:       typeof vendor.publicReviewCount === "number" && vendor.publicReviewCount > 0
                         ? vendor.publicReviewCount : null,
    ratingSource:      vendor.ratingSource || "",
    /* r35. Other people's words and this company's own work. Both are capped
       and both fail to an empty list, so a missing tab costs the reviews or the
       photos and never the card itself. */
    reviews:           clientVendorReviews(vendor.vendorId),
    photos:            clientVendorPhotos(vendor.vendorId),
  };
}

/* r49. THE PARTNER CARD, REMEMBERED FOR FIVE MINUTES.
   Building the card opens the Ops workbook and reads VENDORS, VENDOR_REVIEWS
   and VENDOR_PHOTOS — on every portal open and every client ticket, for a card
   that changes a few times a year. The script cache now holds the FINISHED
   card: the output of the whitelist above, never a VENDORS row, so the most a
   cache entry can hand back is what a customer was already shown. Keyed by
   company, never by customer. null is remembered too (no card to show).

   FRESHNESS IS THE TRADE. A vendor portal save forgets that company's card at
   once (handleVendorWrite). An edit typed into the Ops sheet itself — a
   client_visible flip, a new review — reaches customers within five minutes;
   run forgetPartnerCards() from the editor to show it now.

   Never fatal. Without CacheService (the test harnesses) or with a cache that
   refuses, the card is built fresh, exactly as it was before r49. */
const PARTNER_CARD_TTL_S = 300;

function partnerCardCache() {
  try {
    return typeof CacheService !== "undefined" && CacheService.getScriptCache
      ? CacheService.getScriptCache() : null;
  } catch (_) { return null; }
}

function partnerCardKey(vendorId) { return "partner_card:" + vendorId; }

/** The customer's card for this company: buildClientVendorProfile, cached. */
function clientVendorCard(ss, vendorId) {
  var vid = String(vendorId || "").trim();
  if (!vid) return null;
  /* A cache key is capped at 250 characters; a vendor id is a few. */
  var cache = vid.length <= 100 ? partnerCardCache() : null;
  if (cache) {
    try {
      var hit = cache.get(partnerCardKey(vid));
      if (hit !== null && hit !== undefined) return JSON.parse(hit);
    } catch (_) { /* an unreadable entry is a miss */ }
  }
  var card = buildClientVendorProfile(getVendor(ss, vid));
  if (cache) {
    try { cache.put(partnerCardKey(vid), JSON.stringify(card), PARTNER_CARD_TTL_S); }
    catch (_) { /* too large or refused: the next open builds it again */ }
  }
  return card;
}

function forgetPartnerCard(vendorId) {
  var cache = partnerCardCache();
  var vid = String(vendorId || "").trim();
  if (!cache || !vid) return;
  try { cache.remove(partnerCardKey(vid)); } catch (_) {}
}

/** RUN FROM THE EDITOR after editing VENDORS, VENDOR_REVIEWS or VENDOR_PHOTOS
    by hand, to put the change on customers' cards now instead of within five
    minutes. Reads VENDORS; writes nothing to any sheet. */
function forgetPartnerCards() {
  var cache = partnerCardCache();
  if (!cache) return "no script cache here";
  var table = readTable(opsBook(), VENDORS_TAB);
  var col = table ? table.headers.indexOf("vendor_id") : -1;
  if (col === -1) return "VENDORS has no vendor_id column";
  var keys = table.rows.map(function (r) { return String(r[col]).trim(); })
    .filter(Boolean).map(partnerCardKey);
  if (keys.length) cache.removeAll(keys);
  return keys.length + " partner card(s) forgotten";
}

/**
 * What the customer sees. Their booking, their home, their words.
 *
 * NO ADDRESS, NO ACCESS NOTES, NO INDIVIDUAL NAMED. The address they already
 * know; the access notes are the crew's working copy and a leaked client link
 * should not carry how to get into the house. The person is not named because
 * Serve routes to a company — see the joint-employer note on the network
 * section of the site.
 */
function buildClientTicketModel(ss, booking) {
  var rooms = deriveRooms(booking.beds, booking.baths);
  var instructions = getBookingInstructions(ss, booking.bookingId);
  var assignment = getAssignment(ss, booking);
  var vendor = clientVendorCard(ss, assignment.vendorId);

  var sorted = sortInstructions(instructions);

  return {
    ok: true,
    view: "client",
    bookingId: booking.bookingId,
    photoSupport: !!PropertiesService.getScriptProperties().getProperty("PHOTO_BRIDGE_SECRET"),
    photos: publicBookingPhotos(ss, booking.bookingId),

    booking: {
      serviceCode:  booking.serviceCode,
      serviceLabel: SERVICE_CODES[booking.serviceCode] || booking.serviceLabel,
      frequency:    booking.frequency,
      date:         booking.scheduledDate,
      time:         booking.startTime,
      when:         booking.scheduleSummary,
      status:       booking.status,
      /* r43. A ticket for a visit nobody is coming to has to say so. */
      cancelled:    bookingIsCancelled(booking),
      completed:    booking.completedDate,
      addOns:       booking.addOns,
      /* The price the customer agreed to. `final` once an operator sets it,
         otherwise the quote. Never both, so there is nothing to reconcile. */
      price:        booking.price.final || booking.price.quoted,
      /* r50. THREE STATES, NOT TWO — see the note on booking.payment. `paid`
         keeps its old meaning exactly: money actually taken. `authorized` is
         the hold in between, and a page that cannot tell them apart either
         tells a customer they were charged when they were not, or goes on
         asking them to pay when they already have.
         `payment_ref` is NOT here and must not be: whitelists are built up
         field by field, and an internal Stripe handle has no business on a
         customer's page. */
      paid:         booking.payment.paid,
      authorized:   booking.payment.authorized,
      paymentNote:  paymentNote(booking),
    },

    home: {
      beds:   booking.beds,
      baths:  booking.baths,
      levels: booking.levels,
      /* Each room carries any instruction already attached to it, so the page
         renders the current state without a second request. */
      rooms: rooms.map(function (r) {
        return { key: r.key, label: r.label, instruction: sorted.rooms[r.key] || "" };
      }),
    },

    instructions: {
      general: sorted.general,
      /* Their own words from booking, read back. Kept separate from anything
         they add later so an edit cannot overwrite what they first told us. */
      atBooking: booking.customerNotes,
    },

    /* WHAT THE CUSTOMER TOLD US, read back to the customer — never Serve's own
       PROPERTY_MEMORY, which is the crew's working record of the home and is
       not the customer's to see. Reading back only their own words means a
       leaked client link exposes nothing the holder did not already write. */
    access: {
      fields: accessFieldList(sorted.access),
    },

    firstName: booking.customerName.split(" ")[0] || "",
    partner: vendor,
    partnerPending: !vendor,
  };
}

/* ============================================================
   THE BOOKING TEXT  —  r26
   ============================================================

   One SMS when a booking is written: a sentence and their portal link.

   WHY A LINK AND NOT THE DETAILS. A text is frozen the second it sends and
   costs money per segment; the portal is always current and holds everything —
   the date, the price, who is coming, entry details, payment. Texting the
   booking itself would mean texting again every time any of it changed, and
   the customer would still not know which message was the true one.

   SENT FROM HERE, NOT FROM THE WORKER. This is the moment the booking actually
   exists — after the JOBS row is written, after the dedupe, and where the
   contact_id the portal link needs is already in hand. A duplicate submission
   returns long before this, so a retry cannot text somebody twice.

   FOUR GATES, AND ALL OF THEM ARE SILENT WHEN THEY CLOSE:

     consent      `sms_transactional` must be exactly "yes". Blank is not a
                  "no" on record, it is "nobody asked" — and either way it is
                  not permission. This is the A2P 10DLC line and it is the one
                  gate here that carries a legal penalty.
     credentials  unset Script Properties mean the feature is simply off, the
                  way QUOTE_SECRET and PHOTO_BRIDGE_SECRET are off until set.
     a real phone toE164 returns "" for anything it cannot make sense of.
     a portal     no contact_id means no link, and a text saying "you booked"
                  with nothing to open is worse than no text.

   NOTHING HERE MAY FAIL A BOOKING, and nothing here may write a phone number or
   a signed link into a log line. The log says the job id and whether it sent. */

const TWILIO_SID_PROP   = "TWILIO_ACCOUNT_SID";
const TWILIO_TOKEN_PROP = "TWILIO_AUTH_TOKEN";
const TWILIO_FROM_PROP  = "TWILIO_FROM";

/**
 * The message itself.
 *
 * Deliberately short: two sentences and a link is one or two segments, and
 * every segment is billed. The STOP line is what sms-terms.html already
 * promises — "Reply STOP to any message to stop receiving texts from Serve" —
 * so leaving it out would break a promise the site makes in writing.
 *
 * EVERY CHARACTER OF THE FIXED TEXT IS GSM-7, and that is not fussiness.
 * One character outside that alphabet — an em dash, a curly quote, a
 * backtick — switches the WHOLE message to UCS-2, where a segment of a
 * multi-part text holds 67 characters instead of 153. This text shipped in
 * r26 with an em dash after the name, which made a two-segment message a
 * three-segment one on every single booking. portal.test.js checks the
 * alphabet and the segment count, so it cannot quietly come back.
 */
function bookingSmsText(firstName, link) {
  var open = firstName ? "Hi " + firstName + ", your" : "Your";
  return open + " Serve clean is booked. Your booking page has the details, " +
         "entry instructions and payment:\n" + link + "\nReply STOP to opt out.";
}

/**
 * Returns a short reason string, always. Never throws, never returns a phone
 * number or a link, and the reason is safe to log verbatim.
 */
function sendBookingSms(data, contactId, jobId) {
  try {
    if (String(data.sms_transactional || "") !== "yes") return "no consent";

    var props = PropertiesService.getScriptProperties();
    var sid   = props.getProperty(TWILIO_SID_PROP);
    var token = props.getProperty(TWILIO_TOKEN_PROP);
    var from  = props.getProperty(TWILIO_FROM_PROP);
    if (!sid || !token || !from) return "twilio not configured";

    var e164 = toE164(data.phone);
    if (!e164) return "no usable phone";
    if (!contactId) return "no contact_id, so no portal link";

    var body = bookingSmsText(String(data.name || "").split(" ")[0],
                              portalUrl(contactId));

    /* Basic auth rather than a library: one call, one dependency fewer, and
       the token never leaves this function. muteHttpExceptions so a 4xx comes
       back as a response to read rather than an exception to catch. */
    var res = UrlFetchApp.fetch(
      "https://api.twilio.com/2010-04-01/Accounts/" + encodeURIComponent(sid) + "/Messages.json",
      {
        method: "post",
        muteHttpExceptions: true,
        headers: { Authorization: "Basic " + Utilities.base64Encode(sid + ":" + token) },
        payload: { From: from, To: "+" + e164, Body: body },
      });

    var code = res.getResponseCode();
    if (code >= 200 && code < 300) return "sent";

    /* Twilio's error names the parameter it disliked and carries the TO number,
       so only the code and its own error code are logged — never the body. */
    var detail = "";
    try { detail = " twilio_code=" + (JSON.parse(res.getContentText()) || {}).code; } catch (_) {}
    console.error("booking SMS failed for " + jobId + ": HTTP " + code + detail);
    return "failed http " + code;

  } catch (err) {
    console.error("booking SMS threw for " + jobId + " (booking stands): " + err);
    return "failed";
  }
}


/* ============================================================
   THE CUSTOMER'S OWN CONFIRMATION EMAIL  —  r58
   ============================================================

   UNTIL NOW SERVE SENT THE CUSTOMER NOTHING BY EMAIL. Every MailApp.sendEmail
   in this file goes to notifyEmail() — the operator. The only automatic
   delivery a customer ever got was the r26 text, and that is gated on
   `sms_transactional`. So a customer who left the consent box unticked — the
   default, since it may not be pre-ticked — booked a clean and then heard
   nothing at all, and never received the portal link that holds their visit,
   their price and their payment.

   Meanwhile index.html has promised, on the confirmation screen, that "you'll
   get a confirmation email within 15 minutes" — and that promise was being
   kept by nobody. This function is what makes it true.

   WHY THIS NEEDS NO CONSENT CHECKBOX. This is a transactional message to
   somebody who has just bought, about the thing they bought. That is the
   relationship email CAN-SPAM contemplates, and it is a different instrument
   from the A2P 10DLC consent on the site, which governs TEXT messages to a
   carrier-registered number. Do not add a consent gate here by analogy with
   sendBookingSms; the whole point is that this one always goes.

   EVERY BOOKING, ONCE. Called only from deliverBookingNotify, which sends a
   notice it has CLAIMED under the script lock — read, delete, release — so a
   retry, a duplicate submission or the five-minute sweep cannot send twice.

   NOTHING HERE MAY FAIL A BOOKING. It is wrapped at the call site and again
   internally, and it returns a reason string rather than throwing. It also
   must not log the address, the email or the link: the log line gets the job
   id and the outcome, the same discipline as the SMS.

   NO ENTRY CODE, EVER. Door and access codes are write-only across this
   system. The booking payload carries none, and none may be added here. */

/**
 * The body the customer reads.
 *
 * Plain text on purpose: it matches every other send in this file, it cannot
 * render broken in a client, and the link is unmistakably a link. Kept short —
 * the portal holds the detail, and the point of the email is to hand them the
 * door to it, so the description of what the link is FOR is the part that
 * earns its space.
 */
function customerBookingEmailText(firstName, sched, data, link) {
  var hello = firstName ? "Hi " + firstName + "," : "Hi,";

  /* A SLOT AND A PREFERENCE ARE NOT THE SAME PROMISE, and printing them the
     same way would be the more expensive kind of wrong. A slot booking has a
     real date and time the customer chose and Serve has held. A preference
     booking has only "earlier in the day" — nothing is on the calendar yet, and
     heading that "your clean" would read as a confirmed appointment that does
     not exist. normalizeSchedule already tells them apart; say so. */
  var when = "";
  if (isSet(sched && sched.summary) && sched.shape === "slot") {
    when = "— YOUR CLEAN —\n" + sched.summary + "\n\n";
  } else if (isSet(sched && sched.summary) && sched.shape !== "none") {
    when = "— WHEN YOU ASKED FOR —\n" + sched.summary + "\n" +
           "We'll confirm the exact day and arrival window with you shortly.\n\n";
  }

  /* The price the customer was shown. firstSet because the two fields are
     written by different paths, exactly as sendReservationEmail reads them. */
  var price = firstSet(data.quote_price, data.first_visit_total);
  var cost  = isSet(price) ? "Price for this visit: " + money(price) + " (all in)\n\n" : "";

  var portal = link
    ? "— YOUR BOOKING PAGE —\n" +
      "This is your own page, and the link stays the same for every clean you\n" +
      "ever book with us. Open it any time to see your visit, check who is\n" +
      "coming, add entry instructions, pay, or change or cancel a visit:\n\n" +
      link + "\n\n" +
      "Worth saving — it is the fastest way to reach us about this booking.\n\n"
    : "We'll follow up shortly with a link to your own booking page, where you\n" +
      "can see your visit and make changes.\n\n";

  return hello + "\n\n" +
         "You're on the schedule. Serve has your booking and we're coordinating\n" +
         "with our provider network on your arrival window.\n\n" +
         when + cost + portal +
         "Anything we should know before we come — pets, parking, how to get in,\n" +
         "rooms to skip — just reply to this email and we'll pass it on.\n\n" +
         "— Serve\n" +
         "management@servecos.com · (617) 804-7201";
}

/**
 * Returns a short reason string, always. Never throws, and never returns or
 * logs an email address, an address or a signed link.
 */
function sendCustomerBookingEmail(data, contactId, sched, jobId) {
  try {
    var to = String(data.email || "").trim();
    /* Deliberately loose. A real address this rejects is worse than a bad one
       it lets through — MailApp simply fails on a bad one, and that is caught
       below, whereas a strict pattern silently drops the customer entirely. */
    if (!to || to.indexOf("@") < 1 || /\s/.test(to)) return "no usable email";

    /* No contact_id means the portal does not exist for them yet. The email
       still goes: confirming the booking is the promise on the screen, and the
       link is the bonus. */
    var link = contactId ? portalUrl(contactId) : "";

    var subject = "Your Serve cleaning is booked" +
                  (isSet(sched && sched.summary) && sched.shape === "slot"
                    ? " — " + sched.summary : "");

    MailApp.sendEmail(to, subject,
      customerBookingEmailText(String(data.name || "").split(" ")[0], sched, data, link),
      { name: "Serve", replyTo: "management@servecos.com" });

    return link ? "sent" : "sent without portal link";

  } catch (err) {
    /* err can quote the recipient, so it is not logged verbatim. */
    console.error("customer booking email failed for " + jobId +
                  " (booking stands): " + (err && err.name ? err.name : "error"));
    return "failed";
  }
}


/* ============================================================
   THE TEXT AND THE EMAIL NO LONGER HOLD UP THE CONFIRMATION  —  r55
   ============================================================

   THE SYMPTOM (2026-09-17). "Reserve" took ~15 seconds to reach "You're on the
   schedule". r53 stopped that wait ending on the yellow failure panel, but not
   the wait itself: this script answered only after the Twilio call and the
   Gmail send, which routinely pushed it past the Worker's 12s budget, and the
   browser then sat through a 502 and a retry before it saw the confirmation.

   NOW THE BOOKING ANSWERS AS SOON AS THE SHEETS ARE WRITTEN. When the Worker
   asks for it (notify_deferred), the reservation parks everything the text and
   email need in one script property, "notify:<submission_id>", and returns
   notify_pending:true. The Worker answers the browser, then — in waitUntil, with
   nobody waiting — POSTs {event_type:"booking_notify", submission_id} back here,
   and this sends them.

   THREE ROUTES TO THE SAME PARKED NOTICE, AND IT IS SENT AT MOST ONCE:
     1. the Worker that got the booking's answer (the normal case)
     2. the Worker of a RETRY — the dedupe reports notify_pending, so a first
        attempt that ran past its budget still gets its text within seconds
     3. the five-minute warm cron's sweep, for anything older than a minute
        (a failed follow-up call, a cold start past the Worker's patience)
   Each one CLAIMS under the script lock — read, delete, release — and sends
   only what it claimed. Two callers racing get one send.

   NO SECRET, DELIBERATELY. The only thing either request can do is deliver a
   notification this script already decided to send, once, a little early. A
   stranger holding a submission_id gains nothing; a bridge secret would add a
   paste step and a failure mode to protect nothing.

   THE PARKED NOTICE HOLDS CONTACT DETAILS for the seconds it waits, in script
   properties — visible only to editors of this project, deleted on claim. It
   carries no entry code: the booking payload has none. Any customer data added
   to the payload later is parked with it; keep that in mind.

   FALLS BACK TO SENDING INLINE, i.e. exactly the pre-r55 behaviour, when the
   caller did not ask, the submission_id is unusable as a key, the notice is
   larger than one property holds, or the write throws. */

var NOTIFY_PREFIX = "notify:";
var NOTIFY_MAX_CHARS = 8500;          // one script property value holds 9KB
var NOTIFY_SWEEP_AGE_MS = 60000;      // leave the Worker's own call time to land
var NOTIFY_SWEEP_MAX = 10;            // each send is seconds; stay well inside a run
var NOTIFY_ID_SHAPE = /^[A-Za-z0-9_-]{1,100}$/;

/** Parks a notice. True only when it was parked; never throws. */
function queueBookingNotify(notice) {
  try {
    var id = String((notice.data && notice.data.submission_id) || "");
    if (!NOTIFY_ID_SHAPE.test(id)) return false;
    var text = JSON.stringify(notice);
    if (text.length > NOTIFY_MAX_CHARS) {
      console.warn("booking notice too large to park (" + text.length + " chars) for " +
                   notice.jobId + " — sending inline");
      return false;
    }
    PropertiesService.getScriptProperties().setProperty(NOTIFY_PREFIX + id, text);
    return true;
  } catch (err) {
    console.error("booking notice not parked for " + notice.jobId + ", sending inline: " + err);
    return false;
  }
}

function hasPendingNotify(submissionId) {
  try {
    var id = String(submissionId || "");
    return NOTIFY_ID_SHAPE.test(id) &&
           !!PropertiesService.getScriptProperties().getProperty(NOTIFY_PREFIX + id);
  } catch (err) {
    return false;
  }
}

/** Sends one notice. Returns reasons safe to log; never throws. */
function deliverBookingNotify(notice) {
  /* r26. The customer's own text, after the row exists and after the dedupe,
     so a retried submission cannot text anybody twice. Returns a reason
     rather than throwing; "no consent" and "twilio not configured" are
     ordinary outcomes and most bookings will report one of them. */
  var sms = "skipped";
  try {
    sms = sendBookingSms(notice.data, notice.contactId, notice.jobId);
  } catch (smsErr) {
    sms = "failed";
    console.error("booking SMS wrapper failed (booking stands): " + smsErr);
  }
  console.log("booking SMS " + notice.jobId + ": " + sms);

  /* r58. The customer's own confirmation, with their portal link. Sent to
     EVERY booking — no consent gate, see sendCustomerBookingEmail — and sent
     BEFORE the operator's copy, because this is the one a customer is waiting
     on and the operator's is long and can throw on a bad field. */
  var customerEmail = "skipped";
  try {
    customerEmail = sendCustomerBookingEmail(notice.data, notice.contactId,
                                             notice.sched, notice.jobId);
  } catch (custErr) {
    customerEmail = "failed";
    console.error("customer email wrapper failed (booking stands): " + custErr);
  }
  console.log("customer booking email " + notice.jobId + ": " + customerEmail);

  var email = "sent";
  try {
    sendReservationEmail(notice.data, notice.sched, notice.leadId, notice.leadResult,
                         notice.propertyResult, notice.slotResult);
  } catch (mailErr) {
    email = "failed";
    console.error("Email send failed (row was still written): " + mailErr);
  }
  return { sms: sms, email: email, customerEmail: customerEmail };
}

/**
 * POST {event_type:"booking_notify", submission_id} — send that one notice.
 * POST {event_type:"booking_notify", action:"sweep"} — send every notice
 * parked longer than NOTIFY_SWEEP_AGE_MS.
 *
 * Answers counts only: no name, number, address or link leaves this function.
 */
function handleBookingNotify(data, writeLockHeld, releaseWriteLock) {
  /* Without the lock a claim could race another claim. Nothing is lost by
     refusing: the notice stays parked and the next sweep takes it. */
  if (!writeLockHeld) return json({ ok: false, error: "busy" });

  var props = PropertiesService.getScriptProperties();
  var claimed = [];
  function claim(key) {
    var text = props.getProperty(key);
    if (!text) return;
    props.deleteProperty(key);
    try { claimed.push(JSON.parse(text)); }
    catch (err) { console.error("unreadable booking notice discarded: " + key); }
  }

  if (data.action === "sweep") {
    var all = props.getProperties();
    var now = Date.now();
    Object.keys(all).forEach(function (key) {
      if (key.indexOf(NOTIFY_PREFIX) !== 0 || claimed.length >= NOTIFY_SWEEP_MAX) return;
      var queuedAt = 0;
      try { queuedAt = Number(JSON.parse(all[key]).queuedAt) || 0; } catch (_) {}
      if (now - queuedAt >= NOTIFY_SWEEP_AGE_MS) claim(key);
    });
    if (claimed.length) console.log("notify sweep: " + claimed.length + " late booking notice(s)");
  } else {
    var id = String(data.submission_id || "");
    if (!NOTIFY_ID_SHAPE.test(id)) {
      releaseWriteLock();
      return json({ ok: false, error: "bad_submission_id" });
    }
    claim(NOTIFY_PREFIX + id);
  }

  /* Claimed and deleted; the sends touch no sheet, so let the next booking in. */
  releaseWriteLock();

  claimed.forEach(deliverBookingNotify);
  return json({ ok: true, sent: claimed.length });
}


/* ============================================================
   DATE AND TIME CELLS  —  r23
   ============================================================

   A SHEET CELL DOES NOT ALWAYS CONTAIN WHAT SOMEBODY TYPED INTO IT.

   The script writes `scheduled_date` as "2026-09-20" and `start_time` as
   "9–11 AM", both plain text. The moment an operator retypes one, or Sheets
   decides a typed value looks like a date, the cell stops being text and
   becomes a real date value — and getValues() hands it back as a JavaScript
   Date rather than a string.

   String()ing one of those produced the bug this fixes:

       Fri Dec 29 1899 22:00:00 GMT-0500 (Eastern Standard Time)

   at the top of live booking slips. 1899 is not a corruption: a TIME-ONLY cell
   has no date, so Sheets anchors it to its own epoch of 30 December 1899, and
   the offset is the script's own timezone applied to that midnight.

   NO Utilities.formatDate, AND NO TIMEZONE ARITHMETIC. Apps Script already
   builds these Dates in the script's timezone, so the local getters return the
   numbers the operator actually typed. Converting again would move them. It
   also keeps both helpers pure JavaScript, so the test harness exercises the
   real thing rather than a stubbed formatter.

   Both are TOTAL: text in, the same text out. A value that is already
   "9–11 AM" or "Morning preferred" passes through untouched, because most
   cells are still text and always will be. */

/** A real, valid Date — not a string that looks like one, not an Invalid Date. */
function isDateValue(v) {
  return Object.prototype.toString.call(v) === "[object Date]" && !isNaN(v.getTime());
}

/**
 * The timezone Sheets used to build the Dates this workbook hands back.
 *
 * Returns "" rather than a guess when it cannot be asked: an empty timezone
 * sends the cell helpers down their local-getter path, which is what they did
 * before r32, instead of formatting through a timezone that may be wrong.
 */
function sheetTimeZone(ss) {
  /* r44. Once per workbook per request — getBooking used to ask on every
     booking. A failure is remembered too, so one response never formats
     half its dates through one zone and half through another. */
  var zones = REQUEST_SCOPE && ss ? REQUEST_SCOPE.zones : null;
  if (zones && zones.has(ss)) return zones.get(ss);
  var tz = "";
  try {
    tz = (ss && ss.getSpreadsheetTimeZone ? ss.getSpreadsheetTimeZone() : "") || "";
  } catch (_) {
    tz = "";
  }
  if (zones) zones.set(ss, tz);
  return tz;
}

/** A date cell as `YYYY-MM-DD`, whether it arrived as text or as a Date. */
function dateCellText(v, tz) {
  if (!isDateValue(v)) return String(v || "");
  if (tz) {
    /* The timezone that built this instant is the only one that gives back the
       day that was typed. Formatting through any other shifts it. */
    try { return Utilities.formatDate(v, tz, "yyyy-MM-dd"); } catch (_) {}
  }
  var p = function (n) { return (n < 10 ? "0" : "") + n; };
  return v.getFullYear() + "-" + p(v.getMonth() + 1) + "-" + p(v.getDate());
}

/**
 * A time cell as `9:00 AM ET`, whether it arrived as text or as a Date.
 *
 * ET is appended to anything that reads as a clock time, including text the
 * script wrote itself, because a cleaner reading "9–11 AM" on a phone in
 * another timezone has no way to know which 9 is meant. A cell that is not a
 * time at all — "Morning preferred" — is left exactly alone.
 */
function timeCellText(v, tz) {
  if (isDateValue(v)) {
    var text = "";
    if (tz) {
      try { text = Utilities.formatDate(v, tz, "h:mm a"); } catch (_) { text = ""; }
    }
    if (!text) {
      var h24 = v.getHours(), m = v.getMinutes();
      var h12 = h24 % 12 === 0 ? 12 : h24 % 12;
      text = h12 + ":" + (m < 10 ? "0" : "") + m + " " + (h24 < 12 ? "AM" : "PM");
    }
    return text + " ET";
  }
  var s = String(v || "").trim();
  if (!s) return "";
  if (/\bET\b|eastern/i.test(s)) return s;              // already said so
  return /\d\s*(:|am|pm)/i.test(s) ? s + " ET" : s;     // a clock time, or prose
}

/* ============================================================
   WHAT IS IN THE DATE CELLS  —  r31
   ============================================================ */

/**
 * Read-only. Run from the editor: `checkBookingDates()` for the last three
 * bookings, or `checkBookingDates(10)` for more.
 *
 * Prints, per booking, the four things that settle where a wrong date came
 * from, and nothing else about the customer:
 *
 *   raw        what getValues() hands the script, and its TYPE
 *   displayed  what getDisplayValues() shows — what a person sees in the cell
 *   read as    what dateCellText/timeCellText turn it into, which is what
 *              every ticket and portal then renders
 *   notes      the schedule summary, prose the script wrote and Sheets cannot
 *              convert, so it still says what was booked
 *
 * If `raw` is a Date, Sheets converted what the script wrote. If `displayed`
 * and `read as` disagree, the conversion back is skewed and the timezone lines
 * at the top say which setting is wrong.
 */
function checkBookingDates(howMany) {
  var lines = [];
  var say = function (s) { lines.push(s); };
  try {
    var ss = SPREADSHEET_ID ? SpreadsheetApp.openById(SPREADSHEET_ID)
                            : SpreadsheetApp.getActiveSpreadsheet();

    say("Business timezone expected: " + BUSINESS_TZ);
    var scriptTz = "(unavailable)", sheetTz = "(unavailable)";
    try { scriptTz = Session.getScriptTimeZone(); } catch (_) {}
    try { sheetTz = ss.getSpreadsheetTimeZone(); } catch (_) {}
    say("  Apps Script project timezone: " + scriptTz +
        (scriptTz === BUSINESS_TZ ? "" : "  <-- not the business timezone (Project Settings > Time zone)"));
    say("  Spreadsheet timezone:         " + sheetTz +
        (sheetTz === BUSINESS_TZ ? "" : "  <-- not the business timezone (File > Settings > Time zone)"));

    /* r32: read the cells the way the tickets now read them, or this
       diagnostic would report a different day than the booking slip shows —
       and it is the tool someone reaches for precisely when those disagree.
       sheetTimeZone() is used rather than the sheetTz reported above, because
       that one holds the string "(unavailable)" when it cannot be read. */
    var tz = sheetTimeZone(ss);
    var sheet = ss.getSheetByName(JOBS_TAB);
    if (!sheet) { say("No " + JOBS_TAB + " tab."); return finish(lines); }
    var h = sheetHeaders(sheet);
    var last = sheet.getLastRow();
    if (last < 2) { say("No bookings yet."); return finish(lines); }

    var want = Math.min(Math.max(1, Number(howMany) || 3), 10);
    var first = Math.max(2, last - want + 1);
    var count = last - first + 1;
    var range = sheet.getRange(first, 1, count, h.length);
    var raw = range.getValues();
    var shown = [];
    try { shown = range.getDisplayValues(); } catch (_) {}

    var col = function (n) { return h.indexOf(n); };
    var at = function (row, name) { var i = col(name); return i === -1 ? "" : row[i]; };
    var seen = function (r, name) {
      var i = col(name);
      return (i === -1 || !shown[r] || shown[r][i] === undefined) ? "(no display value)" : String(shown[r][i]);
    };

    for (var r = 0; r < count; r++) {
      var row = raw[r];
      say("");
      say("Row " + (first + r) + "  " + String(at(row, "job_id") || "(no job_id)") +
          "  scheduling_type=" + String(at(row, "scheduling_type") || "(blank)"));
      say("  scheduled_date  raw " + cellKind(at(row, "scheduled_date")) +
          " | displayed " + JSON.stringify(seen(r, "scheduled_date")) +
          " | read as " + JSON.stringify(dateCellText(at(row, "scheduled_date"), tz)));
      say("  start_time      raw " + cellKind(at(row, "start_time")) +
          " | displayed " + JSON.stringify(seen(r, "start_time")) +
          " | read as " + JSON.stringify(timeCellText(at(row, "start_time"), tz)));
      say("  notes           " + JSON.stringify(String(at(row, "notes") || "")));
    }
    say("");
    say("Compare the last two lines of each booking: notes is what was booked.");
  } catch (err) {
    say("Check stopped before finishing. Details are suppressed because service errors can contain cell data.");
  }
  return finish(lines);
}

/** The type of a cell value, and its instant when it is a Date. Never guesses. */
function cellKind(v) {
  if (v === "" || v === null || v === undefined) return "blank";
  if (isDateValue(v)) {
    var iso = "";
    try { iso = v.toISOString(); } catch (_) { iso = "(uniso)"; }
    return "DATE " + iso + " (local " + v.getFullYear() + "-" + (v.getMonth() + 1) + "-" + v.getDate() +
           " " + v.getHours() + ":" + ("0" + v.getMinutes()).slice(-2) + ")";
  }
  if (typeof v === "number") return "NUMBER " + v;
  if (typeof v === "boolean") return "BOOLEAN " + v;
  return "text " + JSON.stringify(String(v));
}

/** Log every line and hand the whole report back, so tests can read it. */
function finish(lines) {
  lines.forEach(function (l) { console.log(l); });
  return lines.join(" | ");
}

/** Split a flat instruction list into the three shapes a ticket renders. */
function sortInstructions(list) {
  var out = { general: "", rooms: {}, access: {} };
  list.forEach(function (ins) {
    if (ins.scopeType === "ROOM")        out.rooms[ins.scopeKey]  = ins.instruction;
    else if (ins.scopeType === "ACCESS") out.access[ins.scopeKey] = ins.instruction;
    else                                 out.general = ins.instruction;
  });
  return out;
}

/** The access questions in a fixed order, with whatever has been answered. */
function accessFieldList(answered) {
  return Object.keys(ACCESS_KEYS).map(function (k) {
    return { key: k, label: ACCESS_KEYS[k], value: answered[k] || "" };
  });
}

/**
 * What the partner sees. Enough to do the job and nothing else.
 *
 * NO PRICE. Not the quote, not the final, not the add-on revenue. What Serve
 * charges is not a partner's business and the margin is the model.
 * NO CUSTOMER EMAIL OR PHONE — contact routes through Serve.
 */
function buildVendorTicketModel(ss, booking) {
  var rooms = deriveRooms(booking.beds, booking.baths);
  var instructions = getBookingInstructions(ss, booking.bookingId);
  var access = getBookingAccess(ss, booking.propertyId);

  var sorted = sortInstructions(instructions);
  var notes = partnerNoteRows(ss);

  return {
    ok: true,
    view: "partner",
    bookingId: booking.bookingId,
    photos: publicBookingPhotos(ss, booking.bookingId),
    /* r47/r48. The cleaner's own room photos, for the company assigned now. */
    completionPhotoSupport: !!booking.vendorId && !!PropertiesService.getScriptProperties().getProperty("PHOTO_BRIDGE_SECRET"),
    completionPhotos: completionPhotoRows(ss).filter(function (r) {
      return r.job_id === booking.bookingId && r.vendor_id === booking.vendorId && r.status === "READY";
    }).map(completionPhotoPublic),

    booking: {
      serviceCode:  booking.serviceCode,
      serviceLabel: SERVICE_CODES[booking.serviceCode] || booking.serviceLabel,
      condition:    booking.condition,
      /* THEIR payout, never the customer's price.
         r24 — derived from the share stamped on this booking when a human has
         not set a figure by hand. An operator's number always wins; see
         partnerPayoutFor. Still blank on a pre-r24 booking with no override,
         and the ticket says "confirmed at dispatch" rather than showing a zero,
         because a zero reads as "this job pays nothing". */
      payout:       partnerPayoutFor(booking),
      date:         booking.scheduledDate,
      time:         booking.startTime,
      when:         booking.scheduleSummary,
      status:       booking.status,
      /* r43. THE MOST CONSEQUENTIAL PLACE THIS FIELD APPEARS. A cleaner
         holding a live-looking ticket for a cancelled visit drives to a
         stranger's home and knocks. The customer's own surfaces losing a
         cancellation is confusing; this one is somebody's morning. */
      cancelled:    bookingIsCancelled(booking),
      completed:    booking.completedDate,
      addOns:       booking.addOns,
    },

    /* THE CUSTOMER'S FIRST NAME, AND DELIBERATELY NOTHING ELSE. r22.
       Somebody knocking on a stranger's door should know who they are expecting,
       and "Hi, Sarah?" is the difference between a professional arriving and a
       stranger at the door.

       The standing rule on partner surfaces is "address only — no customer name,
       email or phone, contact routes through Serve" (see buildVendorPortalModel).
       The founder relaxed it for this field on 2026-09-11, and the reasoning it
       protects still holds: a FIRST NAME IS NOT A CONTACT ROUTE. It cannot be
       dialled, emailed, or looked up, so it does not let a partner arrange work
       around Serve — which is what that rule exists to prevent. The partner
       already has the address, without which they could not do the job at all.

       SURNAME, EMAIL AND PHONE STAY OUT, and so does this field on the vendor
       PORTAL — the company's standing list of every job does not need to be a
       customer directory. One name, on the ticket for the one job, for the
       person actually going. Widening this again is a founder decision. */
    customerFirstName: String(booking.customerName || "").split(" ")[0] || "",

    property: {
      address: booking.address,
      unit:    booking.unit,
      zip:     booking.zip,
      beds:    booking.beds,
      baths:   booking.baths,
      levels:  booking.levels,
    },

    scope: rooms.map(function (r) {
      return { key: r.key, label: r.label, instruction: sorted.rooms[r.key] || "",
               /* r48. What this company's cleaner noted about the room. */
               note: partnerNoteFor(notes, booking.bookingId, booking.vendorId, r.key) };
    }),

    instructions: {
      general: sorted.general,
      atBooking: booking.customerNotes,
    },

    /* TWO SOURCES, KEPT APART ON PURPOSE.
       `standing` is PROPERTY_MEMORY: what the crew learned about this home and
       expects to be true every visit. `fromCustomer` is what the customer said
       for THIS booking. Merging them would let a one-off ("we'll be away, use
       the lockbox") silently become the permanent record of the house.

       DOOR CODES ARE IN NEITHER AND MUST NOT BE ADDED. They live in Access
       MASTER, owner-only, and reach the cleaner by direct message at dispatch.
       A URL token is not the place for them. */
    access: {
      standing: {
        method:        access.accessMethod,
        notes:         access.accessNotes,
        parking:       access.parkingNotes,
        pets:          access.petNotes,
        priorityRooms: access.priorityRooms,
        skipAreas:     access.skipAreas,
        productNotes:  access.productNotes,
        timingNotes:   access.timingNotes,
      },
      fromCustomer: accessFieldList(sorted.access).filter(function (f) { return f.value; }),
      fromPortal: vendorPortalAccess(ss, booking.propertyId),
      petsFlagged:  booking.petsFlag,
    },
  };
}



/* ============================================================
   THE PORTAL  —  one customer, all their homes and bookings
   ============================================================
   Added r14.

   KEYED ON contact_id, NOT ON A PROPERTY. A portal tied to one home cannot
   serve someone with several, and contact_id is the seam a real account with a
   password attaches to later. The link never changes.

   NO NEW JOBS COLUMN IS NEEDED. The chain is
       contact_id -> LEADS row -> lead_id -> every JOBS row with that lead_id
   and lead_id is already column 2 of the live JOBS header. That deliberately
   avoids depending on JOBS.property_id or JOBS.contact_id, neither of whose
   presence in the live sheet is confirmed. */

/** The person. Returns null when the id is unknown — never a partial object. */
function getContact(ss, contactId) {
  var want = String(contactId || "").trim();
  if (!want) return null;
  var leads = readTable(ss, LEADS_TAB);
  if (!leads) return null;
  var h = leads.headers;
  var ci = h.indexOf("contact_id");
  var li = h.indexOf("lead_id");
  /* Without the column there is no portal. It is documented as a one-line
     addition to LEADS rather than guessed at from an email. */
  if (ci === -1 || li === -1) return null;

  var rows = leads.rows;
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][ci]).trim() !== want) continue;
    var name = String(rows[i][h.indexOf("name")] || "").trim();
    return {
      contactId: want,
      leadId:    String(rows[i][li] || "").trim(),
      name:      name,
      firstName: name.split(" ")[0] || "",
    };
  }
  return null;
}

/**
 * Every booking this person has made, newest first.
 *
 * Matched on lead_id, which is their normalised email. Two people at one
 * address with different emails therefore get separate portals showing the
 * bookings each of them personally made — the right behaviour for something
 * that becomes an account, though it is a behaviour worth knowing.
 */
function getContactBookings(ss, leadId) {
  var want = String(leadId || "").trim().toLowerCase();
  if (!want) return [];
  var jobs = requireTable(ss, JOBS_TAB);
  var h = jobs.headers;
  var li = h.indexOf("lead_id");
  var idc = h.indexOf("job_id");
  if (li === -1 || idc === -1) return [];

  /* r44. Each booking is built from ITS OWN row, already in hand. This used to
     call getBooking(id), which searched JOBS again per booking — and returned
     the FIRST row carrying that id, which on a sheet with a duplicated job_id
     could be somebody else's. */
  var rows = jobs.rows;
  var tz = sheetTimeZone(ss);
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][li]).trim().toLowerCase() !== want) continue;
    if (!String(rows[i][idc]).trim()) continue;
    out.push(bookingFromRow(h, rows[i], tz));
  }
  /* Newest first. An undated booking is a preference with no slot yet, which
     is the most current thing there is, so it sorts to the top. */
  out.sort(function (a, z) {
    var av = a.scheduledDate || "9999-99-99";
    var zv = z.scheduledDate || "9999-99-99";
    return av < zv ? 1 : av > zv ? -1 : 0;
  });
  return out;
}

/** The distinct homes behind a set of bookings, most recent first. */
function getContactProperties(bookings) {
  var seen = {}, out = [];
  bookings.forEach(function (b) {
    var pid = String(b.propertyId || "").trim();
    /* No property_id means the JOBS column is missing or the row predates r9.
       Fall back to the address so the portal still has something to group by
       rather than collapsing every home into one. */
    var key = pid || (b.address + "|" + b.unit + "|" + b.zip).toUpperCase();
    if (!key.replace(/\|/g, "").trim() || seen[key]) return;
    seen[key] = true;
    out.push({
      propertyId: pid,
      key:        key,
      address:    b.address,
      unit:       b.unit,
      zip:        b.zip,
      label:      [b.address, b.unit].filter(Boolean).join(", "),
    });
  });
  return out;
}

/**
 * How to get into one home, as the customer answered it.
 *
 * THE CODE NEVER COMES BACK. Only the nonsecret saved marker is read here;
 * what is returned is whether one exists and when it was saved, so
 * the portal can say "saved 8 Sep" and offer to replace it. A leaked portal
 * link exposes no code, which is the property that made collecting one
 * acceptable in the first place.
 */
function getPropertyAccess(ss, propertyId) {
  var empty = {
    occupancyChoice: "", occupancyDetail: "",
    entryChoice: "", entryDetail: "",
    entryCodeSet: false, entryCodeSetAt: "",
    parkingChoice: "", parkingDetail: "",
    petNotes: "", updatedAt: "",
  };
  var want = String(propertyId || "").trim();
  if (!want) return empty;
  try {
    var table = readTable(ss, PROPERTY_ACCESS_TAB);
    if (!table) return empty;
    var h = table.headers;
    var pi = h.indexOf("property_id");
    if (pi === -1 || !table.rows.length) return empty;
    var rows = table.rows;
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i][pi]).trim() !== want) continue;
      var v = {};
      h.forEach(function (n, idx) { v[n] = rows[i][idx]; });
      return {
        occupancyChoice: String(v.occupancy_choice || ""),
        occupancyDetail: String(v.occupancy_detail || ""),
        entryChoice:     String(v.entry_choice || ""),
        entryDetail:     String(v.entry_detail || ""),
        entryCodeSet:    v.entry_code_saved === true || String(v.entry_code_saved).toLowerCase() === "true",
        entryCodeSetAt:  String(v.entry_code_set_at || ""),
        parkingChoice:   String(v.parking_choice || ""),
        parkingDetail:   String(v.parking_detail || ""),
        petNotes:        String(v.pet_notes || ""),
        updatedAt:       String(v.updated_at || ""),
      };
    }
  } catch (err) {
    console.warn("PROPERTY_ACCESS read failed: " + err);
  }
  return empty;
}

/** Auto-created on first save, exactly like BOOKING_INSTRUCTIONS. */
function ensurePropertyAccessTab(ss) {
  assertWritable(PROPERTY_ACCESS_TAB);
  var sheet = ss.getSheetByName(PROPERTY_ACCESS_TAB);
  if (!sheet) {
    sheet = ss.insertSheet(PROPERTY_ACCESS_TAB);
    sheet.appendRow(PROPERTY_ACCESS_HEADERS);
    sheet.setFrozenRows(1);
    console.log("Created the " + PROPERTY_ACCESS_TAB + " tab.");
  }
  return sheet;
}

/** Private workbook configuration is deliberately required; no Leads fallback. */
function privateAccessStore(leads, setup) {
  var props = PropertiesService.getScriptProperties();
  var id = String(props.getProperty("ACCESS_SPREADSHEET_ID") || "").trim();
  var tab = String(props.getProperty("ACCESS_CODES_TAB") || "").trim();
  if (!id || !tab || id === leads.getId() || id === OPS_SPREADSHEET_ID) throw new Error("private_access_unavailable");
  var book = SpreadsheetApp.openById(id);
  if (book.getId() === leads.getId()) throw new Error("private_access_unavailable");
  var sheet = book.getSheetByName(tab);
  if (!sheet && setup) {
    sheet = book.insertSheet(tab);
    sheet.appendRow(["property_id", "access_secret", "access_secret_set_at"]);
    sheet.setFrozenRows(1);
  }
  if (!sheet) throw new Error("private_access_unavailable");
  var h = sheetHeaders(sheet);
  if (setup && h.indexOf("property_id") !== -1 && h.indexOf("access_secret") !== -1 && h.indexOf("access_secret_set_at") === -1) {
    sheet.getRange(1, h.length + 1).setValue("access_secret_set_at");
    h = sheetHeaders(sheet);
  }
  ["property_id", "access_secret", "access_secret_set_at"].forEach(function (key) {
    if (h.indexOf(key) === -1) throw new Error("private_access_schema");
  });
  return { sheet: sheet, headers: h };
}

/** Internal only. The caller holds the script lock. Never return the secret. */
function savePrivateEntryCode(leads, propertyId, code, when, keepExisting) {
  var store = privateAccessStore(leads, false);
  var sheet = store.sheet, h = store.headers;
  var pi = h.indexOf("property_id"), ci = h.indexOf("access_secret"), ti = h.indexOf("access_secret_set_at");
  var matches = [], last = sheet.getLastRow();
  if (last > 1) {
    sheet.getRange(2, pi + 1, last - 1, 1).getValues().forEach(function (r, i) {
      if (String(r[0]).trim() === propertyId) matches.push(i + 2);
    });
  }
  if (matches.length > 1) throw new Error("private_access_duplicate");
  var row = matches[0];
  if (!row && (!code || keepExisting)) return { saved: false, savedAt: "" };
  if (!row) {
    row = last + 1;
    sheet.getRange(row, pi + 1).setValue(propertyId);
  }
  var cell = sheet.getRange(row, ci + 1);
  if (!keepExisting) {
    // Text formatting preserves leading zeroes. Escape formula-looking input.
    cell.setNumberFormat("@");
    cell.setValue(code ? "'" + code : "");
    SpreadsheetApp.flush();
    if (String(cell.getValues()[0][0]) !== code) throw new Error("private_access_verification");
    sheet.getRange(row, ti + 1).setValue(code ? when : "");
  }
  var present = String(cell.getValues()[0][0] || "").trim() !== "";
  return { saved: present, savedAt: present ? sheet.getRange(row, ti + 1).getValues()[0][0] : "" };
}

/** Run once from the editor, after configuring Access MASTER. Counts only.
 * Copies and verifies ALL codes before removing the legacy column. A conflict
 * stops the migration with the source intact; retries are safe after a failure.
 * This is intentionally not reachable through doGet/doPost.
 */
function migratePropertyAccessCodes() {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var ss = SPREADSHEET_ID ? SpreadsheetApp.openById(SPREADSHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
    var store = privateAccessStore(ss, true);
    var sheet = ensurePropertyAccessTab(ss), h = sheetHeaders(sheet);
    var ci = h.indexOf("entry_code"), pi = h.indexOf("property_id");
    if (pi === -1) throw new Error("migration_schema");
    if (h.indexOf("entry_code_saved") === -1) {
      sheet.getRange(1, h.length + 1).setValue("entry_code_saved");
      h = sheetHeaders(sheet);
    }
    var count = Math.max(0, sheet.getLastRow() - 1);
    var rows = count ? sheet.getRange(2, 1, count, h.length).getValues() : [];
    var seen = {}, copied = 0;
    /* r29 — A LEGACY CELL IS NOT NECESSARILY THE CODE THAT WAS TYPED. Before
       r28 codes were written with a plain setValue into an Automatic-format
       cell, and Sheets converts what it is given: "0042" was kept as the
       NUMBER 42, and something like "12/25" could become a DATE. A date's
       string is not a door code, so any date stops the migration with the
       source intact and the home named. A number is copied, because nothing
       better survives in the sheet, and is named in the completion log so the
       code can be re-confirmed with the customer. Never a value. */
    var legacy = legacyCodeKinds(rows, pi, ci);
    if (legacy.dates.length) {
      console.log("Access migration refused: codes stored as DATES, not codes, for " +
                  legacy.dates.join(", ") + ". Confirm those codes with the customer, " +
                  "retype each as text (start it with an apostrophe), then retry.");
      throw new Error("migration_date_coded");
    }
    // Preflight all conflicts before changing any secret.
    var dest = store.sheet.getDataRange().getValues();
    var dpi = store.headers.indexOf("property_id"), dci = store.headers.indexOf("access_secret");
    rows.forEach(function (r) {
      var id = String(r[pi] || "").trim();
      var code = ci === -1 ? "" : String(r[ci] == null ? "" : r[ci]);
      if (!id && !code) return;
      if (!id || seen[id]) throw new Error("migration_duplicate_or_missing_property");
      seen[id] = true;
      var matches = dest.slice(1).filter(function (d) { return String(d[dpi]).trim() === id; });
      if (matches.length > 1 || (code && matches.length && String(matches[0][dci] || "") && String(matches[0][dci]) !== code)) {
        throw new Error("migration_conflict_source_retained");
      }
    });
    rows.forEach(function (r, i) {
      var id = String(r[pi] || "").trim();
      if (!id) return;
      var code = ci === -1 ? "" : String(r[ci] == null ? "" : r[ci]);
      var saved = savePrivateEntryCode(ss, id, code, r[h.indexOf("entry_code_set_at")] || new Date(), !code);
      sheet.getRange(i + 2, h.indexOf("entry_code_saved") + 1).setValue(saved.saved);
      sheet.getRange(i + 2, h.indexOf("entry_code_set_at") + 1).setValue(saved.savedAt);
      if (code) copied++;
    });
    SpreadsheetApp.flush();
    if (ci !== -1) sheet.deleteColumn(ci + 1);
    SpreadsheetApp.flush();
    if (sheetHeaders(sheet).indexOf("entry_code") !== -1) throw new Error("migration_verification");
    console.log("Access migration complete. Properties checked: " + rows.length + "; codes transferred: " + copied + "; legacy code columns: 0.");
    if (legacy.numbers.length) {
      console.log("Codes that had been stored as NUMBERS, so any leading zeros were lost when they were first saved, before this migration. Re-confirm these with the customer: " +
                  legacy.numbers.join(", ") + ".");
    }
  } catch (err) {
    // Deliberately suppress service exception detail: it may contain cell data.
    throw new Error("Access migration stopped. Source codes retained unless column removal already completed. Check private workbook configuration, schema and duplicate/conflicting property records.");
  } finally {
    lock.releaseLock();
  }
}

/* ============================================================
   ACCESS MIGRATION PRE-FLIGHT  —  r29
   ============================================================ */

/**
 * Sort legacy entry_code cells by what Sheets actually KEPT in them, which
 * before r28 was not necessarily what the customer typed. Property IDs only,
 * never a code. `dates` cannot be migrated as codes; `numbers` can, but may
 * have lost leading zeros when they were first saved.
 */
function legacyCodeKinds(rows, pi, ci) {
  var out = { dates: [], numbers: [], text: 0 };
  if (ci === -1) return out;
  rows.forEach(function (r) {
    var v = r[ci];
    if (v === "" || v == null) return;
    var id = String(r[pi] || "").trim() || "(no property_id)";
    if (isDateValue(v)) out.dates.push(id);
    else if (typeof v === "number") out.numbers.push(id);
    else out.text++;
  });
  return out;
}

/**
 * One synthetic code through the exact path a portal save takes, under a
 * property ID no real home can have, read back, then removed. r28 writes codes
 * as text with a leading apostrophe and verifies what comes back; whether
 * Sheets keeps that apostrophe in a plain-text cell could not be proved outside
 * a real workbook, and if it does, EVERY portal code save is refused. Better the
 * probe finds out than the first customer. Never throws.
 */
function probeAccessWrite(ss, store) {
  var PROBE = "__serve_probe__";
  var result;
  try {
    var saved = savePrivateEntryCode(ss, PROBE, "0042", new Date(), false);
    result = saved.saved ? "OK, a code written the r28 way reads back exactly"
                         : "FAILED, the probe code did not persist";
  } catch (e) {
    result = String(e && e.message || e) === "private_access_verification"
      ? "FAILED, a code read back differently from what was written, so every portal code save would be refused. Do not migrate"
      : "FAILED, the private write path is unavailable";
  }
  try {
    var h = sheetHeaders(store.sheet), pi = h.indexOf("property_id");
    for (var r = store.sheet.getLastRow(); r >= 2; r--) {
      if (String(store.sheet.getRange(r, pi + 1).getValues()[0][0]).trim() === PROBE) store.sheet.deleteRow(r);
    }
  } catch (_) {
    result += "; the probe row could not be removed, so delete the row keyed __serve_probe__ by hand";
  }
  return result;
}

/**
 * Why privateAccessStore refused, in words an operator can act on. r30.
 *
 * Called only AFTER it has refused, and retraces its checks in the same order,
 * so the first fault named here is the one that stopped it. Reports property
 * NAMES, tab NAMES, header names and the LENGTH of the ID. It reads nothing in
 * Access MASTER except its tab names and header row, so it cannot print a code.
 *
 * The name check matters more than it looks. A property saved as
 * "ACCESS_SPREADSHEET_ID " — trailing space — or saved in a different Apps
 * Script project reads as simply not set, and nothing else would say why.
 * Headers are compared exactly as sheetHeaders returns them: trimmed, NOT
 * lowercased, so "Property_ID" is a miss and is reported as one.
 */
function privateAccessDiagnosis(leads) {
  var props = PropertiesService.getScriptProperties();
  var rawId = props.getProperty("ACCESS_SPREADSHEET_ID");
  var rawTab = props.getProperty("ACCESS_CODES_TAB");

  var near = [];
  try {
    near = (props.getKeys() || []).filter(function (k) {
      return /access/i.test(k) && k !== "ACCESS_SPREADSHEET_ID" && k !== "ACCESS_CODES_TAB";
    });
  } catch (_) {}
  var hint = near.length
    ? " Properties with similar names ARE set: " +
      near.map(function (k) { return JSON.stringify(k); }).join(", ") +
      ". A name must match exactly, with no spaces."
    : " If you did set it, it was probably not saved (Save script properties), " +
      "or it was saved in a different Apps Script project than this one.";

  if (rawId === null || String(rawId).trim() === "") {
    return "ACCESS_SPREADSHEET_ID is not set in this project's Script Properties." + hint;
  }
  if (rawTab === null || String(rawTab).trim() === "") {
    return "ACCESS_CODES_TAB is not set in this project's Script Properties." + hint;
  }

  var id = String(rawId).trim(), tab = String(rawTab).trim();
  if (/[^A-Za-z0-9_-]/.test(id)) {
    return "ACCESS_SPREADSHEET_ID contains characters a spreadsheet ID never has " +
           "(" + id.length + " characters in all) — usually a pasted URL, /edit or #gid=. " +
           "Use only the long ID between /d/ and /edit.";
  }
  if (id === leads.getId()) return "ACCESS_SPREADSHEET_ID is Leads MASTER itself. It must be Access MASTER.";
  if (id === OPS_SPREADSHEET_ID) return "ACCESS_SPREADSHEET_ID is the Ops workbook. It must be Access MASTER.";

  var book;
  try {
    book = SpreadsheetApp.openById(id);
  } catch (_) {
    return "No spreadsheet opens with that ID (" + id.length + " characters). Either it is mistyped, " +
           "or the Google account running this editor cannot open Access MASTER.";
  }
  if (book.getId() === leads.getId()) return "That ID opens Leads MASTER. It must be Access MASTER.";

  var names = [];
  try { names = book.getSheets().map(function (s) { return s.getName(); }); } catch (_) {}
  var sheet = book.getSheetByName(tab);
  if (!sheet) {
    var close = names.filter(function (n) { return n.trim().toLowerCase() === tab.toLowerCase(); });
    return "Access MASTER opened, but it has no tab named " + JSON.stringify(tab) + ". " +
           (close.length ? "Nearest: " + JSON.stringify(close[0]) +
                           " — the name must match exactly, capitals and spaces included. " : "") +
           "Its tabs are: " +
           (names.length ? names.map(function (n) { return JSON.stringify(n); }).join(", ") : "(none readable)") + ".";
  }

  var h = sheetHeaders(sheet);
  var need = ["property_id", "access_secret", "access_secret_set_at"];
  var missing = need.filter(function (k) { return h.indexOf(k) === -1; });
  if (missing.length) {
    var wrongCase = missing.map(function (k) {
      var hit = h.filter(function (x) { return String(x).toLowerCase() === k; })[0];
      return hit ? JSON.stringify(hit) + " should be " + k : "";
    }).filter(Boolean);
    return "The tab " + JSON.stringify(tab) + " exists but row 1 is missing: " + missing.join(", ") + "." +
           (wrongCase.length ? " Found " + wrongCase.join("; ") + " — header names are case-sensitive." : "") +
           " Row 1 needs exactly property_id, access_secret and access_secret_set_at, lowercase, one per cell.";
  }
  return "Every step checks out on a second look — run the check again, and if it repeats, bring this line back.";
}

/**
 * RUN THIS BEFORE migratePropertyAccessCodes, AND AGAIN AFTER. Editor-only.
 *
 * Changes nothing in Leads. Prints counts and property IDs, never a code.
 * Answers the questions a one-way migration cannot afford to get wrong: is
 * Access MASTER configured and separate, is the legacy column still there, did
 * Sheets keep any code as a number or a date, would any collide with a
 * different code already in Access MASTER, and does a code written the r28
 * way come back exactly (the probe above — its one write, removed afterwards).
 *
 * After a migration it still earns its keep: a date copied in as a code by
 * r28 is still findable in Access MASTER, and this names the home.
 */
function checkAccessMigration() {
  var lines = [];
  var say = function (s) { lines.push(s); };
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    var ss = SPREADSHEET_ID ? SpreadsheetApp.openById(SPREADSHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();

    var store = null;
    try {
      store = privateAccessStore(ss, false);
      say("Access MASTER: configured, separate from Leads and Ops, required columns present.");
    } catch (e) {
      /* r30 — name the actual fault. "NOT READY" used to cover seven causes in
         one sentence, and the founder hit it twice with no way to tell which. */
      var why;
      try { why = privateAccessDiagnosis(ss); } catch (_) { why = "the reason could not be narrowed down any further."; }
      say("Access MASTER: NOT READY. " + why);
    }

    var sheet = ss.getSheetByName(PROPERTY_ACCESS_TAB);
    var h = sheet ? sheetHeaders(sheet) : [];
    var pi = h.indexOf("property_id"), ci = h.indexOf("entry_code");
    var rows = (sheet && pi !== -1 && sheet.getLastRow() > 1)
      ? sheet.getRange(2, 1, sheet.getLastRow() - 1, h.length).getValues() : [];
    say("Leads PROPERTY_ACCESS: " + rows.length + " home(s); legacy entry_code column " +
        (ci === -1 ? "ABSENT (already migrated)" : "PRESENT (not yet migrated)") +
        "; entry_code_saved column " + (h.indexOf("entry_code_saved") === -1 ? "absent" : "present") + ".");

    if (ci !== -1) {
      var kinds = legacyCodeKinds(rows, pi, ci);
      say("Codes stored as text: " + kinds.text + ".");
      say("Codes stored as NUMBERS (leading zeros may already be lost): " +
          (kinds.numbers.length ? kinds.numbers.join(", ") : "none") + ".");
      say("Codes stored as DATES (the migration will refuse these): " +
          (kinds.dates.length ? kinds.dates.join(", ") : "none") + ".");

      var seen = {}, dups = [];
      rows.forEach(function (r) {
        var id = String(r[pi] || "").trim();
        if (!id) return;
        if (seen[id]) dups.push(id);
        seen[id] = true;
      });
      say("Duplicate homes in Leads: " + (dups.length ? dups.join(", ") : "none") + ".");

      if (store) {
        var dest = store.sheet.getDataRange().getValues();
        var dpi = store.headers.indexOf("property_id"), dci = store.headers.indexOf("access_secret");
        var conflicts = [];
        rows.forEach(function (r) {
          var id = String(r[pi] || "").trim(), code = String(r[ci] == null ? "" : r[ci]);
          if (!id || !code) return;
          var m = dest.slice(1).filter(function (d) { return String(d[dpi]).trim() === id; });
          if (m.length > 1 || (m.length && String(m[0][dci] || "") && String(m[0][dci]) !== code)) conflicts.push(id);
        });
        say("Would clash with a different code already in Access MASTER: " +
            (conflicts.length ? conflicts.join(", ") : "none") + ".");
      }
    }

    if (store) {
      var dv = store.sheet.getDataRange().getValues();
      var di = store.headers.indexOf("property_id"), dc = store.headers.indexOf("access_secret");
      var dated = [];
      dv.slice(1).forEach(function (d) {
        var v = d[dc];
        if (isDateValue(v) || /GMT[+-][0-9]{4}/.test(String(v))) {
          dated.push(String(d[di] || "").trim() || "(no property_id)");
        }
      });
      say("Access MASTER values that are dates rather than codes: " + (dated.length ? dated.join(", ") : "none") + ".");
      say("Write round trip: " + probeAccessWrite(ss, store) + ".");
    }
  } catch (err) {
    say("Check stopped before finishing. Details are suppressed because service errors can contain cell data.");
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
  lines.forEach(function (l) { console.log(l); });
  return lines.join(" | ");
}

/** The questions, with this home's answers filled in. Drives the portal form. */
function accessQuestionList(access) {
  return ACCESS_QUESTIONS.map(function (q) {
    return {
      field:  q.field,
      label:  q.label,
      choice: String(access[q.field + "Choice"] || "").toUpperCase(),
      detail: String(access[q.field + "Detail"] || ""),
      /* Never the code — only whether one exists and when it was set. */
      secretSet:   q.field === "entry" ? access.entryCodeSet : false,
      secretSetAt: q.field === "entry" ? access.entryCodeSetAt : "",
      choices: q.choices.map(function (c) {
        return { key: c.key, label: c.label, detail: c.detail || "", secret: !!c.secret };
      }),
    };
  });
}

/**
 * THE PORTAL VIEW MODEL. A whitelist, built field by field, like the two
 * ticket models beside it.
 *
 * Upcoming bookings carry their editable detail inline; completed ones are a
 * read-only record. One request, no second token, and a finished job is not a
 * form.
 */

/* ============================================================
   THE RECURRING PLAN  —  r38

   An offer, recorded when a first clean is booked with a cadence attached and
   shown in the customer's portal until they confirm it or it lapses.

   status is `pending`, `confirmed` or `expired`. NOTHING EVER WRITES
   `expired` — see planStatus(): the window is read, never swept.
   ============================================================ */

var PLAN_WINDOW_DAYS = 7;

/** How the cadence is priced, from what the customer was actually shown. */
function recurringPriceFor(data, frequency) {
  var f = String(frequency || "").toLowerCase();
  if (f === "weekly")   return valOrBlank(data.recurring_weekly);
  if (f === "biweekly") return valOrBlank(data.recurring_biweekly);
  if (f === "monthly")  return valOrBlank(data.recurring_monthly);
  return "";
}

/**
 * Deterministic, so one booking can never mint two plans.
 *
 * Derived from the job it came from rather than randomly, so any caller that
 * asks twice about one booking gets one answer. NOT because of replays: doPost
 * returns on a duplicate submission_id long before this is reached.
 */
function planIdFor(jobId) {
  return "PLN-" + String(jobId || "").replace(/^SRV-/, "");
}

/** The window this plan closes at, in the same stamp shape as received_at. */
function planExpiresAt(fromMs) {
  var at = new Date((fromMs || new Date().getTime()) + PLAN_WINDOW_DAYS * 86400000);
  return Utilities.formatDate(at, BUSINESS_TZ, "yyyy-MM-dd'T'HH:mm:ssXXX");
}

/**
 * Has this plan already been offered?
 *
 * Its own check rather than alreadyWritten(), which matches on a
 * `submission_id` column. Carrying a column named for something this tab does
 * not have, purely to borrow that helper, would read as a mistake later.
 *
 * WHAT THIS ACTUALLY DEFENDS: a caller reaching createRecurringPlan directly.
 * The replay path never gets here — doPost answers a duplicate submission_id
 * and returns. The direct callers are the ones coming: confirming a plan, and
 * any backfill over bookings taken before r38.
 */
function planAlreadyOffered(sheet, planId) {
  var plans = sheetValues(sheet);   // r44: one fresh read
  var col = plans.headers.indexOf("plan_id");
  if (col === -1 || !plans.rows.length) return false;
  var needle = String(planId).trim();
  for (var i = 0; i < plans.rows.length; i++) {
    if (String(plans.rows[i][col]).trim() === needle) return true;
  }
  return false;
}

/**
 * What a stored row's status actually is right now.
 *
 * A pending row past its window is expired and says so, without anything having
 * written that. Both sides are PARSED rather than compared as text: the stamps
 * carry an offset, and -04:00 and -05:00 do not sort against each other.
 */
function planStatus(row) {
  var stored = String(row.status || "pending").toLowerCase();
  if (stored !== "pending") return stored;
  var ends = Date.parse(String(row.expires_at || ""));
  if (!ends) return "pending";                 // unreadable window: do not expire it
  return ends < new Date().getTime() ? "expired" : "pending";
}

/**
 * Record the plan a first clean was sold with. Never throws; the caller sits in
 * the band where nothing may fail a booking.
 *
 * ONLY for a first clean carrying a real cadence. A move-out on a plan is not a
 * thing, and a first clean booked once has nothing to offer.
 */
function createRecurringPlan(ss, data, record, ids) {
  var frequency = String(data.frequency_selected || "").toLowerCase();
  if (!frequency || frequency === "once") return "no cadence";
  if (serviceCodeOf(serviceLabel(data), frequency) !== "CLEAN_DEEP") return "not a first clean";

  var sheet = ss.getSheetByName(RECURRING_PLANS_TAB);
  if (!sheet) return "no " + RECURRING_PLANS_TAB + " tab";

  var planId = planIdFor(record.job_id);
  if (planAlreadyOffered(sheet, planId)) return "already offered";

  /* An EMPTY translation map on purpose. writeRow() otherwise runs keys through
     HEADER_MAP, which is built for JOBS — `quoted_price` and `frequency` are
     real columns here, and a future entry there could silently rewrite one into
     a column this tab does not have. */
  writeRow(sheet, {
    plan_id:       planId,
    contact_id:    (ids && ids.contact_id) || "",
    lead_id:       record.lead_id || "",
    origin_job_id: record.job_id,
    property_id:   (ids && ids.property_id) || "",
    frequency:     frequency,
    quoted_price:  recurringPriceFor(data, frequency),
    created_at:    receivedAt(),
    expires_at:    planExpiresAt(new Date().getTime()),
    status:        "pending",
  }, {});
  return "offered";
}

/**
 * The plan to show this customer, or null.
 *
 * MATCHED ON lead_id, NOT contact_id. See r40: the portal's own chain is
 * contact_id -> LEADS -> lead_id -> JOBS, and it is built that way because
 * JOBS.contact_id is not reliably populated — it self-backfills onto LEADS for
 * older rows and never onto JOBS. A plan keyed on it is invisible for exactly
 * the customers who have been around longest.
 *
 * A WHITELIST, like every other view model here: a column added to the tab
 * later cannot reach a browser until somebody names it. The newest PENDING plan
 * only — a customer with a lapsed one and a live one is being asked about the
 * live one.
 */
function clientRecurringPlan(ss, leadId) {
  try {
    var table = readTable(ss, RECURRING_PLANS_TAB);
    if (!table) return null;
    var h = table.headers;
    if (!table.rows.length) return null;

    var rows = table.rows;
    /* Lower-cased and trimmed, the same way getContactBookings matches it: a
       lead_id is an email address and cases drift between forms. */
    var want = String(leadId || "").trim().toLowerCase();
    if (!want) return null;
    var best = null;
    for (var r = 0; r < rows.length; r++) {
      var row = {};
      h.forEach(function (name, i) { row[name] = rows[r][i]; });
      if (String(row.lead_id || "").trim().toLowerCase() !== want) continue;
      if (planStatus(row) !== "pending") continue;
      if (!best || String(row.created_at) > String(best.created_at)) best = row;
    }
    if (!best) return null;

    return {
      planId:    String(best.plan_id || ""),
      frequency: String(best.frequency || ""),
      price:     best.quoted_price === "" || best.quoted_price === undefined
                   ? null : Number(best.quoted_price),
      expiresAt: String(best.expires_at || "").slice(0, 10),
      /* The visit it follows, so the portal can say "after your first clean"
         rather than naming a date nobody has chosen yet. */
      afterJobId: String(best.origin_job_id || ""),
    };
  } catch (err) {
    console.error("recurring plan unavailable: " + err);
    return null;
  }
}

/* ============================================================
   CONFIRM & SCHEDULE — where the offer becomes a booking (r42)
   ============================================================ */

/** A time exactly as the availability feed publishes it: "9:00 AM". */
var PLAN_TIME_SHAPE = /^\d{1,2}:\d{2}\s*[AP]M$/i;

/**
 * The plan as the PORTAL needs it: the open offer, plus whether there is a
 * previous company to offer asking for again.
 *
 * A SEPARATE STEP FROM clientRecurringPlan ON PURPOSE. That one answers "is an
 * offer open?" out of a single tab. This answers a question that needs the
 * booking list — and it answers as a BOOLEAN. The browser is never handed a
 * vendor_id and so can never name one; which company it means is resolved on
 * this side, from the origin booking, at the moment it is confirmed.
 */
function planForPortal(plan, bookings) {
  if (!plan) return null;
  var origin = null;
  for (var i = 0; i < (bookings || []).length; i++) {
    if (bookings[i].bookingId === plan.afterJobId) { origin = bookings[i]; break; }
  }
  plan.samePartner = !!(origin && String(origin.vendorId || "").trim());
  return plan;
}

/** Where a plan sits on the sheet, so it can be updated rather than re-found. */
function findPlanRow(sheet, planId) {
  var h = sheetHeaders(sheet);
  var col = h.indexOf("plan_id");
  var last = sheet.getLastRow();
  if (col === -1 || last < 2) return null;

  var values = sheet.getRange(2, 1, last - 1, h.length).getValues();
  var needle = String(planId).trim();
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][col]).trim() !== needle) continue;
    var row = {};
    h.forEach(function (name, c) { row[name] = values[i][c]; });
    return { row: row, rowNumber: i + 2, headers: h };
  }
  return null;
}

/**
 * Write named cells on one plan row.
 *
 * A column this tab does not have is SKIPPED, never created. Same rule as
 * writeRow: the sheet's header row decides what exists, and a script that
 * widens a tab behind somebody's back is how a spreadsheet stops being
 * readable by the person who owns it.
 */
function setPlanCells(sheet, found, fields) {
  Object.keys(fields).forEach(function (name) {
    var c = found.headers.indexOf(name);
    if (c === -1) { console.log("No " + name + " column on " + RECURRING_PLANS_TAB); return; }
    sheet.getRange(found.rowNumber, c + 1).setValue(fields[name]);
  });
}

/**
 * The submission_id a confirmation carries. Deterministic, so a double-tapped
 * button dedupes through alreadyWritten() into ONE booking.
 *
 * THE SUFFIX IS LOAD-BEARING, and it is not decoration. makeJobId builds
 * "SRV-<date>-<last six alphanumerics of the submission id>". A plan_id is its
 * origin job's id with the prefix swapped, so an id derived from the plan alone
 * ends in the same six characters the FIRST CLEAN's job_id does — and a plan
 * confirmed for the same calendar day as that first clean would mint a job_id
 * identical to it. Two JOBS rows sharing an id means getBooking answers with
 * the wrong one forever, on every surface. The "-01" keeps the tails apart.
 *
 * r45. `seq` numbers the visits one plan books. A move plan whose visit has
 * been cleaned or called off books its NEXT one from the plan box, and that
 * visit needs its own id: "-02" ends in different characters from "-01", so
 * the two job_ids stay apart for the same reason the first one did. Omitted,
 * it is 1, which is exactly what r42 has always written.
 */
function planSubmissionId(planId, seq) {
  var n = Math.max(1, Math.floor(Number(seq) || 1));
  return "PLNC-" + String(planId).trim() + "-" + (n < 10 ? "0" : "") + n;
}

/**
 * CONFIRM A RECURRING PLAN: the customer picks a time and the offer becomes a
 * real booking — a JOBS row, a consumed AVAILABILITY slot, a vendor stamp.
 *
 * THE OWNERSHIP CHECK IS THE SECURITY MODEL, as everywhere else in the portal,
 * and here it is checked TWICE: the plan must carry this contact's lead_id, and
 * so must the booking the plan came from. This is the only portal write that
 * creates a booking, so "not yours" must be unreachable rather than unlikely.
 *
 * IT CREATES A JOB THE ONE WAY JOBS ARE CREATED. The payload below is
 * synthesised and then handed to buildJobRecord / writeRow / bookAvailabilitySlot
 * / stampJobVendor — the same calls, in the same order, that doPost makes for a
 * booking off the website. A second way to write a JOBS row would be a second
 * place for every future column to be forgotten.
 *
 * Never throws: handlePortalWrite is wrapped, and a customer who tapped
 * Confirm must get an answer they can read rather than a stack trace.
 */
function confirmRecurringPlan(ss, contact, data) {
  var planId = String(data.plan_id || "").trim();
  var sheet  = ss.getSheetByName(RECURRING_PLANS_TAB);
  if (!planId || !sheet) return json({ ok: false, error: "not_found" });

  var found = findPlanRow(sheet, planId);
  if (!found) return json({ ok: false, error: "not_found" });

  /* OWNERSHIP, on lead_id — the same seam the portal reads plans through, and
     for the same reason: JOBS.contact_id is not reliably populated. See r40. */
  var want = String(contact.leadId || "").trim().toLowerCase();
  if (!want || String(found.row.lead_id || "").trim().toLowerCase() !== want) {
    return json({ ok: false, error: "not_found" });
  }

  var status = planStatus(found.row);
  if (status === "confirmed") {
    return json({ ok: false, error: "already_confirmed",
                  job_id: String(found.row.confirmed_job_id || "") });
  }
  if (status !== "pending") return json({ ok: false, error: "expired" });

  var frequency = String(found.row.frequency || "").trim().toLowerCase();
  if (!frequency || frequency === "once") return json({ ok: false, error: "not_found" });

  /* THE TIME IS VALIDATED, NOT MERELY PASSED ALONG. An unreadable time matches
     no AVAILABILITY row, consumes nothing, and leaves a customer holding a
     confirmation for a visit no cleaner can see.

     A SLOT FROM THE FEED **OR** A PREFERENCE — exactly the two answers the
     booking form and the move-plan card have always taken, and the two
     `bookPlanVisit` has always been able to write. This handler alone demanded
     a clock time, so on any day AVAILABILITY has nothing open the portal's plan
     card could offer no way through at all. A preference is a weaker answer,
     not an invalid one: it books the visit and dispatch calls to set the day. */
  var slotDate = String(data.slot_date || "").trim();
  var slotTime = String(data.slot_time || "").trim();
  var pref     = String(data.time_preference || "").trim().toLowerCase();
  var sched;

  if (slotDate || slotTime) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(slotDate) || !PLAN_TIME_SHAPE.test(slotTime)) {
      return json({ ok: false, error: "bad_slot" });
    }
    sched = normalizeSchedule({ slot_date: slotDate, slot_time: slotTime });
    if (sched.shape !== "slot") return json({ ok: false, error: "bad_slot" });
  } else if (pref === "earlier" || pref === "later") {
    sched = normalizeSchedule({ time_preference: pref });
  } else {
    /* Neither — the same answer an unreadable slot gets. */
    return json({ ok: false, error: "bad_slot" });
  }

  /* The booking this plan came from carries the home, the size and the people.
     It must belong to them too — a plan row is not permission to read a job. */
  var origin = getBooking(ss, String(found.row.origin_job_id || ""));
  if (!origin || String(origin.customerId || "").trim().toLowerCase() !== want) {
    return json({ ok: false, error: "not_found" });
  }

  /* THE SAME COMPANY, RESOLVED HERE. The browser sends yes or no; which vendor
     that means is read off the origin booking. A payload naming a vendor could
     otherwise request any company on the network — and dispatch would have no
     way to tell that request apart from one Serve made. */
  var asked = data.same_provider === true ||
              String(data.same_provider).trim().toLowerCase() === "true";
  var preferredVendor = asked ? String(origin.vendorId || "").trim() : "";

  var booked = bookPlanVisit(ss, contact, origin, {
    frequency: frequency,
    /* THE PRICE THEY WERE QUOTED, carried from the plan row rather than
       recomputed against today's table. That is the whole promise of the held
       window: the number on screen when they chose is the number they pay. */
    price: found.row.quoted_price,
    sched: sched,
    /* Passed for the same reason startMovePlan passes it: it keeps the
       SYNTHESISED PAYLOAD an accurate description of the booking. Nothing
       reads it back today — bookPlanVisit takes the already-normalised `sched`
       and buildJobRecord works off that — so a mutation dropping this line
       breaks no test, and that is recorded rather than papered over. It earns
       its place the day a column added to buildJobRecord reads the payload. */
    preference: sched.shape === "preference" ? pref : "",
    submissionId: planSubmissionId(planId),
  });

  /* A DOUBLE-TAPPED BUTTON MAKES ONE BOOKING — see bookPlanVisit. */
  if (booked.duplicate) {
    return json({ ok: true, duplicate: true, job_id: booked.jobId, when: sched.summary });
  }
  var record = booked.record, payload = booked.payload, slotResult = booked.slotResult;

  /* THE ANCHOR. Every later visit is counted from this date and time, not from
     whatever the most recent visit happened to be moved to. See SCHEMA.

     A PREFERENCE CLEARS IT, exactly as changeMovePlan does: there is no clock
     time to count a cadence from yet. The plan is confirmed and the first visit
     is real; the beat starts once dispatch sets the day. Writing a guessed
     anchor here would invent a schedule nobody agreed to. */
  try {
    setPlanCells(sheet, found, {
      status:              "confirmed",
      anchor_date:         sched.shape === "slot" ? sched.date : "",
      anchor_time:         sched.shape === "slot" ? sched.time : "",
      confirmed_job_id:    record.job_id,
      preferred_vendor_id: preferredVendor,
    });
  } catch (planErr) {
    console.error("plan row not updated (booking stands): " + planErr);
  }

  try {
    sendPlanConfirmedEmail({ payload: payload, record: record, sched: sched,
                             planRow: found.row, preferredVendor: preferredVendor,
                             slotResult: slotResult, contactId: contact.contactId });
  } catch (mailErr) {
    console.error("plan confirmation email failed (booking stands): " + mailErr);
  }

  return json({ ok: true, duplicate: false, job_id: record.job_id,
                when: sched.summary, slot_action: slotResult.action });
}

/**
 * BOOK ONE VISIT OF A PLAN — the JOBS row, the slot, the vendor stamp.
 *
 * r45: split out of confirmRecurringPlan so a move plan books its visits
 * through exactly the same calls. Nothing about r42's behaviour moved with it.
 *
 * IT CREATES A JOB THE ONE WAY JOBS ARE CREATED. The payload is synthesised
 * and handed to buildJobRecord / writeRow / bookAvailabilitySlot /
 * stampJobVendor — the same calls, in the same order, that doPost makes for a
 * booking off the website.
 *
 * `opts`: frequency, price, sched (a normalizeSchedule result — a slot or a
 * preference), submissionId, and optionally sourceLabel for the email.
 *
 * Returns { duplicate, jobId, record, payload, sched, slotResult }.
 */
function bookPlanVisit(ss, contact, origin, opts) {
  var sched = opts.sched;
  var payload = {
    name:  origin.customerName, email: origin.customerEmail, phone: origin.customerPhone,
    address: origin.address, unit: origin.unit, zip: origin.zip,
    bedrooms: origin.beds, bathrooms: origin.baths, levels: origin.levels,
    /* A recurring visit never takes a condition factor (R3/R7 in the engine),
       and a move-out's "heavy" describes the empty home it cleaned, not the
       lived-in one the plan will. Carried only from a first clean, where r42
       has always carried it. */
    condition: origin.serviceCode === "CLEAN_MOVEOUT" ? "" : origin.condition,
    /* A recurring clean, not another first clean. serviceCodeOf reads this
       label plus the cadence and answers CLEAN_STANDARD, which is what the
       scope block, the vendor ranking and both tickets key off. */
    service_type:       SERVICE_CODES.CLEAN_STANDARD,
    frequency_selected: opts.frequency,
    quote_price:        opts.price,
    first_visit_total:  opts.price,
    steady_state_price: opts.price,
    pets_flag:          origin.petsFlag ? "TRUE" : "FALSE",
    submission_id: opts.submissionId,
    /* The share in force NOW, stamped onto this booking, exactly as doPost
       does it — a rate change tomorrow must not reprice a job a partner has
       already accepted.

       DELIBERATELY THE ORDINARY SHARE, NOT payoutRateFor(). This is a
       RECURRING visit, and the recurring visits are precisely where Serve's
       15% earns back the near-zero margin on the half-price first clean. A
       recurring clean is never discounted — `recurringPriceFor` prices it at
       the steady-state rate — so there is nothing here to pass through. */
    payout_rate: currentPayoutRate(),
    /* ATTRIBUTION IS DELIBERATELY BLANK. This booking came from a customer
       opening their own portal, not from a campaign, and inventing a src tag
       here would put a channel in the attribution data that nobody spent
       anything on. The plan row's confirmed_job_id is where it came from. */
  };
  if (sched.shape === "slot") {
    payload.slot_date = sched.date;
    payload.slot_time = sched.time;
  } else {
    payload.time_preference = opts.preference || "";
  }

  var jobs = requireTab(ss, JOBS_TAB);

  /* A DOUBLE-TAPPED BUTTON MAKES ONE BOOKING. The id is derived from the plan,
     so a second confirmation carries the same one and stops here — the same
     guard doPost uses for a retried form. It also covers the window where the
     JOBS row is written and the plan write after it has not landed yet, which
     is the one gap a status check on the plan cannot close. */
  if (alreadyWritten(jobs, payload.submission_id)) {
    return { duplicate: true, payload: payload, sched: sched,
             jobId: jobIdForSubmission(jobs, payload.submission_id) ||
                    makeJobId(payload, sched) };
  }

  var record = buildJobRecord(payload, sched, origin.customerId, jobs, {
    property_id: origin.propertyId || "",
    contact_id:  contact.contactId || "",
  });
  writeRow(jobs, record);
  var jobRow = jobs.getLastRow();

  /* Everything below happens AFTER the booking is safely recorded, and none of
     it may fail the booking. Same band, same rule, as the website's path. */
  var slotResult = { ok: true, action: "skipped" };
  try {
    slotResult = bookAvailabilitySlot(sched, record.job_id,
                   serviceCodeOf(payload.service_type, opts.frequency));
  } catch (slotErr) {
    slotResult = { ok: false, action: "failed", error: String(slotErr) };
    console.error("plan visit slot write-back failed (booking stands): " + slotErr);
  }
  try {
    stampJobVendor(jobs, jobRow, slotResult.vendorId);
  } catch (stampErr) {
    console.error("plan visit vendor stamp failed (booking stands): " + stampErr);
  }

  return { duplicate: false, jobId: record.job_id, record: record, payload: payload,
           sched: sched, slotResult: slotResult };
}

/**
 * The job_id a submission already wrote, or "". Only the duplicate path asks:
 * a preference visit's id carries the day it was BOOKED, so rebuilding it on a
 * later day would name a job that does not exist.
 */
function jobIdForSubmission(jobs, submissionId) {
  var t = sheetValues(jobs);
  var s = t.headers.indexOf("submission_id"), j = t.headers.indexOf("job_id");
  if (s === -1 || j === -1) return "";
  var needle = String(submissionId).trim();
  for (var i = t.rows.length - 1; i >= 0; i--) {
    if (String(t.rows[i][s]).trim() === needle) return String(t.rows[i][j] || "").trim();
  }
  return "";
}


/* ============================================================
   A PLAN AFTER A MOVE  —  r45
   ============================================================

   Somebody who booked a move-in / move-out clean was never offered a
   recurring plan: createRecurringPlan refuses them, because at booking time
   nothing about a move says they want one. So the portal ASKS instead — the
   three cadences, each priced for their home, a time from the same feed, or
   earlier/later in the day if none of the times suit.

   CHOOSING BOOKS. Unlike r38's offer there is no held window to confirm
   later: the customer picks a plan and a time in one sitting, and that writes
   the RECURRING_PLANS row (status `confirmed`, straight away) and the first
   visit's JOBS row, through bookPlanVisit — the same calls r42 makes.

   THE PRICE COMES FROM THE ENGINE, NEVER FROM THE BROWSER. Apps Script has no
   copy of pricing-engine.js, and a second copy would be a second place for
   prices to drift. So the server asks the Worker's /api/quote — the one copy
   of the engine the site runs — for this home's recurring track, from the
   home as stored on the move booking. The portal shows numbers from that same
   endpoint; the price the customer was shown is sent back only so a pricing
   change between looking and choosing is REFUSED (`price_changed`) rather
   than booked at a number they never saw.

   ONCE CHOSEN, THE PLAN HOLDS ITS PRICE. A time-only change never re-prices.
   Only choosing a different cadence asks the engine again.

   THE PLAN BOX MOVES THE ANCHOR; THE BOOKING PANEL DOES NOT. r43's "Change
   time" on a visit is a one-off and leaves the anchor alone. Changing the
   plan's time HERE is the customer redefining the cadence on purpose, which is
   exactly what the anchor records.

   IT IS FOR THE HOME ON THE MOVE BOOKING. A move-OUT customer is leaving that
   address; the portal names it on the card so nobody books upkeep for a home
   they no longer live in without seeing which home it is.

   No new column, no new tab: a move plan is a RECURRING_PLANS row whose
   origin_job_id is a move booking.
   ============================================================ */

var MOVE_PLAN_FREQUENCIES = ["weekly", "biweekly", "monthly"];

/* The Worker route that runs the pricing engine. The same address the booking
   form signs its quotes at; see handleQuote in src/worker.js. */
var PRICING_QUOTE_URL = "https://servecleaning.com/api/quote";

/* ------------------------------------------------------------
   WHO THIS BOX IS FOR  —  widened in r59
   ------------------------------------------------------------

   r45 built this for move-in / move-out, on the reasoning that the booking
   form never offers those customers a cadence, so the portal has to ask
   instead. THAT REASONING WAS NEVER ABOUT MOVES. It is about anybody who
   finished a clean with no plan attached, and the booking form produces a
   second group exactly like that: somebody who picks a first/deep clean and
   answers "Just once".

   THE TWO OFFERS MUST NOT BOTH APPEAR, and they cannot, by construction:

     deep clean + a cadence   createRecurringPlan writes a PENDING plan at
                              booking time, and the portal shows r38's card.
                              Not a basis here — the cadence disqualifies it.
     deep clean + "once"      no plan row exists, r38 shows nothing, and this
                              box is the only thing that asks. r59's case.
     move (any cadence)       serviceCodeOf returns CLEAN_MOVEOUT whatever the
                              frequency says, so r38 skips it as "not a first
                              clean". Unchanged from r45.

   So the cadence test below is not a detail — it is the whole thing keeping
   one customer from being asked the same question twice by two different
   boxes. A "once" that arrives as "" counts: a blank frequency cell is an
   old row or an operator's edit, and neither is a recurring plan.

   The KIND travels to the browser because the copy differs — "after your
   move" is wrong for somebody who just had a deep clean — but every rule
   below this point is identical for both, deliberately. */

var PLAN_BASIS_MOVE = "move";
var PLAN_BASIS_DEEP = "deep";

/** "once", blank, or an operator's wording of the same thing. */
function isOneOffFrequency(v) {
  var s = String(v || "").trim().toLowerCase();
  return s === "" || s === "once" || s === "one-time" || s === "one time" ||
         s === "just once";
}

/** "move", "deep", or "" for a booking this box must not be offered on. */
function planBasisKind(b) {
  if (!b) return "";
  if (b.serviceCode === "CLEAN_MOVEOUT") return PLAN_BASIS_MOVE;
  if (b.serviceCode === "CLEAN_DEEP" && isOneOffFrequency(b.frequency)) {
    return PLAN_BASIS_DEEP;
  }
  return "";
}

function isMoveBooking(b) {
  return planBasisKind(b) === PLAN_BASIS_MOVE;
}

/**
 * The home as the engine prices it, or null when it cannot be priced.
 *
 * THE ONE PLACE THIS IS BUILT, for the browser and the server alike, so the
 * numbers the portal shows and the number the server books are asked for with
 * identical inputs. The recurring track reads only these four — see R7.
 */
function homeSpecFor(b) {
  if (!b) return null;
  /* zipN, NEVER the raw cell. appendRow hands Sheets "02116" and Sheets keeps
     the NUMBER 2116, so every Boston ZIP comes back four digits long. r45
     first shipped reading the cell as text: no move customer saw the box. */
  var zip = zipN(b.zip);
  var beds = Number(b.beds), baths = Number(b.baths);
  if (!/^\d{5}$/.test(zip)) return null;
  if (b.beds === null || !isFinite(beds) || beds < 0) return null;
  if (b.baths === null || !isFinite(baths) || baths <= 0) return null;
  return { zip: zip, bedrooms: beds, bathrooms: baths, levels: Number(b.levels) || 1 };
}

/**
 * This home's three recurring prices, from the engine, or null.
 *
 * Null on every failure — unreachable, non-200, unparseable, a missing or
 * non-positive price. The callers refuse to book on null: a plan without a
 * price from the engine is not a plan this system will write.
 *
 * LOGS NO ADDRESS AND NO ZIP. A status code is all a failure needs.
 */
function movePlanPrices(booking) {
  var home = homeSpecFor(booking);
  if (!home) return null;
  try {
    var res = UrlFetchApp.fetch(PRICING_QUOTE_URL, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify({
        zip: home.zip, bedrooms: home.bedrooms, bathrooms: home.bathrooms,
        levels: home.levels, service: "first_clean", condition: "standard",
        frequency_selected: "once",
      }),
      muteHttpExceptions: true,
    });
    if (res.getResponseCode() !== 200) {
      console.error("recurring prices unavailable: HTTP " + res.getResponseCode());
      return null;
    }
    var d = JSON.parse(res.getContentText());
    if (!d || d.ok !== true || !d.recurring) {
      console.error("recurring prices unavailable: " + (d && d.error ? d.error : "no recurring"));
      return null;
    }
    var out = {};
    for (var i = 0; i < MOVE_PLAN_FREQUENCIES.length; i++) {
      var f = MOVE_PLAN_FREQUENCIES[i];
      var n = Number(d.recurring[f]);
      if (!isFinite(n) || n <= 0) return null;
      out[f] = n;
    }
    return out;
  } catch (err) {
    console.error("recurring prices unavailable: " + err);
    return null;
  }
}

/** A plan row from an already-read table, as an object, or null. */
function planRowIn(table, planId) {
  if (!table || !table.rows.length) return null;
  var col = table.headers.indexOf("plan_id");
  if (col === -1) return null;
  var needle = String(planId).trim();
  for (var r = 0; r < table.rows.length; r++) {
    if (String(table.rows[r][col]).trim() !== needle) continue;
    var row = {};
    table.headers.forEach(function (name, i) { row[name] = table.rows[r][i]; });
    return row;
  }
  return null;
}

/**
 * The plan box the portal draws for a move customer, or null.
 *
 * THE BOOKING IT BELONGS TO is the newest move booking that already has a
 * plan, or failing that is still going ahead — so somebody who moves again
 * is asked about the new home, and a cancelled move is not offered a plan.
 *
 * A WHITELIST, built field by field. The plan row's vendor id never leaves
 * the server: `sameAsked` is a boolean, as r42's `samePartner` is.
 */
function movePlanForPortal(ss, bookings) {
  try {
    var table = readTable(ss, RECURRING_PLANS_TAB);
    if (!table) return null;   // nowhere to record a plan, so nothing to offer

    var basis = null, planRow = null, kind = "";
    for (var i = 0; i < (bookings || []).length; i++) {
      var b = bookings[i];
      var k = planBasisKind(b);
      if (!k) continue;
      var row = planRowIn(table, planIdFor(b.bookingId));
      if (row) { basis = b; planRow = row; kind = k; break; }
      if (!bookingIsCancelled(b)) { basis = b; kind = k; break; }
    }
    if (!basis) return null;

    var home = homeSpecFor(basis);
    if (!home) return null;

    var date = String(basis.scheduledDate || "").trim();
    var out = {
      state:         "choose",
      /* r59. Which kind of clean this plan follows, so the portal can say so.
         The browser chooses WORDS with it and nothing else — every rule that
         decides what may be booked is on this side. */
      kind:          kind,
      jobId:         basis.bookingId,
      propertyLabel: [basis.address, basis.unit].filter(Boolean).join(", "),
      /* The first plan visit is after the move clean. Blank when the move
         booking has no date of its own (an earlier/later request). */
      after:         /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "",
      home:          { zip: home.zip, bedrooms: home.bedrooms,
                       bathrooms: home.bathrooms, levels: home.levels },
      samePartner:   !!String(basis.vendorId || "").trim(),
    };
    if (!planRow) return out;

    /* A row in any other state was put there by a person. Show nothing rather
       than guess what they meant. */
    if (planStatus(planRow) !== "confirmed") return null;

    out.state     = "saved";
    out.planId    = String(planRow.plan_id || "");
    out.frequency = String(planRow.frequency || "").toLowerCase();
    out.price     = planRow.quoted_price === "" || planRow.quoted_price === undefined
                      ? null : Number(planRow.quoted_price);
    out.visitId   = String(planRow.confirmed_job_id || "");
    out.sameAsked = !!String(planRow.preferred_vendor_id || "").trim();
    return out;
  } catch (err) {
    console.error("move plan unavailable: " + err);
    return null;
  }
}

/**
 * What the customer asked for, validated, or { error }.
 *
 * A TIME IS A SLOT FROM THE FEED OR A PREFERENCE, exactly the two the booking
 * form offers. `allowKeep` lets a change leave the time alone.
 */
function readMovePlanChoice(data, basis, allowKeep) {
  var frequency = String(data.frequency || "").trim().toLowerCase();
  if (MOVE_PLAN_FREQUENCIES.indexOf(frequency) === -1) return { error: "bad_plan" };

  var slotDate = String(data.slot_date || "").trim();
  var slotTime = String(data.slot_time || "").trim();
  var pref     = String(data.time_preference || "").trim().toLowerCase();
  var sched = null;

  if (slotDate || slotTime) {
    /* Validated, not passed along — r42's rule. */
    if (!/^\d{4}-\d{2}-\d{2}$/.test(slotDate) || !PLAN_TIME_SHAPE.test(slotTime)) {
      return { error: "bad_slot" };
    }
    sched = normalizeSchedule({ slot_date: slotDate, slot_time: slotTime });
    if (sched.shape !== "slot") return { error: "bad_slot" };
    /* The upkeep starts after the move clean, never before it or on the day. */
    var after = String(basis.scheduledDate || "").trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(after) && slotDate <= after) return { error: "too_early" };
  } else if (pref === "earlier" || pref === "later") {
    sched = normalizeSchedule({ time_preference: pref });
  } else if (!allowKeep) {
    return { error: "bad_slot" };
  }
  return { frequency: frequency, sched: sched, preference: sched && sched.shape === "preference" ? pref : "" };
}

/** Is the price the customer was shown the one the engine gives now? */
function shownPriceMatches(data, price) {
  var shown = Number(data.shown_price);
  return isFinite(shown) && shown === Number(price);
}

/**
 * START A PLAN from the portal of somebody who booked a move.
 *
 * Writes the first visit, THEN the plan row. The visit is the commitment; a
 * plan row pointing at a job that failed to write would be a promise with
 * nothing behind it. A retry after a failure between the two dedupes on the
 * submission id and writes the missing plan row — see the duplicate branch.
 */
function startMovePlan(ss, contact, bookings, data) {
  var jobId = String(data.job_id || "").trim();
  var basis = null;
  for (var i = 0; i < bookings.length; i++) {
    if (bookings[i].bookingId === jobId) { basis = bookings[i]; break; }
  }
  /* Not theirs, not a clean this box is offered on, or called off — the same
     answer as "no such job". r59: the eligibility test is planBasisKind, and
     it is the SAME predicate the portal drew the box from. If these two ever
     disagree, a customer is shown a box whose button always fails. */
  if (!basis || !planBasisKind(basis) || bookingIsCancelled(basis)) {
    return json({ ok: false, error: "not_found" });
  }

  var sheet = ss.getSheetByName(RECURRING_PLANS_TAB);
  if (!sheet) return json({ ok: false, error: "not_found" });

  var planId = planIdFor(basis.bookingId);
  var existing = findPlanRow(sheet, planId);
  if (existing) {
    return json({ ok: false, error: "already_confirmed",
                  job_id: String(existing.row.confirmed_job_id || "") });
  }

  var choice = readMovePlanChoice(data, basis, false);
  if (choice.error) return json({ ok: false, error: choice.error });

  var prices = movePlanPrices(basis);
  if (!prices) return json({ ok: false, error: "price_unavailable" });
  var price = prices[choice.frequency];
  if (!shownPriceMatches(data, price)) {
    return json({ ok: false, error: "price_changed", prices: prices });
  }

  var asked = data.same_provider === true ||
              String(data.same_provider).trim().toLowerCase() === "true";
  var preferredVendor = asked ? String(basis.vendorId || "").trim() : "";

  var booked = bookPlanVisit(ss, contact, basis, {
    frequency: choice.frequency, price: price, sched: choice.sched,
    preference: choice.preference, submissionId: planSubmissionId(planId, 1),
  });

  /* Only the plan row is written after the visit; it is wrapped for the same
     reason every write after the JOBS row is. */
  try {
    writeRow(sheet, {
      plan_id:             planId,
      contact_id:          contact.contactId || "",
      lead_id:             basis.customerId || "",
      origin_job_id:       basis.bookingId,
      property_id:         basis.propertyId || "",
      frequency:           choice.frequency,
      quoted_price:        price,
      created_at:          receivedAt(),
      /* No window: nothing is being held for later. It was chosen and booked. */
      expires_at:          "",
      status:              "confirmed",
      anchor_date:         choice.sched.shape === "slot" ? choice.sched.date : "",
      anchor_time:         choice.sched.shape === "slot" ? choice.sched.time : "",
      preferred_vendor_id: preferredVendor,
      confirmed_job_id:    booked.jobId,
    }, {});
  } catch (planErr) {
    console.error("move plan row not written (visit stands): " + planErr);
  }

  if (!booked.duplicate) {
    try {
      sendMovePlanEmail({ what: "started", basis: basis, contactId: contact.contactId,
                          planId: planId, frequency: choice.frequency, price: price,
                          sched: choice.sched, jobId: booked.jobId,
                          slotResult: booked.slotResult, preferredVendor: preferredVendor });
    } catch (mailErr) {
      console.error("move plan email failed (visit stands): " + mailErr);
    }
  }

  return json({ ok: true, duplicate: !!booked.duplicate, plan_id: planId,
                job_id: booked.jobId, when: choice.sched.summary });
}

/**
 * CHANGE A MOVE PLAN — the cadence, the time, or both.
 *
 * If the plan's visit is still coming, it is changed IN PLACE: the same row,
 * the same job_id. If it has been cleaned or called off, the plan books its
 * next visit instead, so the box can always put something back in Upcoming.
 *
 * MONEY IS NOT RE-DECIDED HERE. A paid visit's price is not rewritten by a
 * cadence change — that is refused (`paid`) and left to a person. An unpaid
 * one takes the new price, and the ops email says a card hold, if any, was
 * taken for the old amount.
 */
function changeMovePlan(ss, contact, bookings, data) {
  var sheet = ss.getSheetByName(RECURRING_PLANS_TAB);
  var planId = String(data.plan_id || "").trim();
  if (!sheet || !planId) return json({ ok: false, error: "not_found" });

  var found = findPlanRow(sheet, planId);
  if (!found) return json({ ok: false, error: "not_found" });

  /* OWNERSHIP on lead_id, then on the move booking — r42's two checks, in
     r42's order, so neither is proven only by the one behind it. */
  var want = String(contact.leadId || "").trim().toLowerCase();
  if (!want || String(found.row.lead_id || "").trim().toLowerCase() !== want) {
    return json({ ok: false, error: "not_found" });
  }
  if (planStatus(found.row) !== "confirmed") return json({ ok: false, error: "not_found" });

  var basis = null, visit = null;
  var originId = String(found.row.origin_job_id || "").trim();
  var visitId  = String(found.row.confirmed_job_id || "").trim();
  for (var i = 0; i < bookings.length; i++) {
    if (bookings[i].bookingId === originId) basis = bookings[i];
    if (visitId && bookings[i].bookingId === visitId) visit = bookings[i];
  }
  /* A plan OFFERED AT BOOKING holds the price it was QUOTED. Re-pricing it
     from here would break r38's promise, so it cannot be changed here.

     r59: the line is NOT "move versus deep clean", it is WHERE THE PRICE CAME
     FROM — and planBasisKind draws exactly that line, which is why it is the
     test rather than a new flag:

       r38's offer   origin is a deep clean sold WITH a cadence, so the kind is
                     "" and this returns not_found. Price is the quote.
       this box      origin is a move, or a deep clean sold as "once". Both
                     were priced by the engine through movePlanPrices, and both
                     re-price the same way when the cadence changes.

     A plan whose origin booking has since been edited out of eligibility
     (someone typing a cadence onto a one-off JOBS row) stops being changeable
     from the portal. That is the safe direction to fail. */
  if (!basis || !planBasisKind(basis)) return json({ ok: false, error: "not_found" });

  var choice = readMovePlanChoice(data, basis, true);
  if (choice.error) return json({ ok: false, error: choice.error });

  var oldFrequency = String(found.row.frequency || "").trim().toLowerCase();
  var freqChanged  = choice.frequency !== oldFrequency;
  var price = found.row.quoted_price;
  if (freqChanged) {
    var prices = movePlanPrices(basis);
    if (!prices) return json({ ok: false, error: "price_unavailable" });
    price = prices[choice.frequency];
    if (!shownPriceMatches(data, price)) {
      return json({ ok: false, error: "price_changed", prices: prices });
    }
  }

  var live = !!visit && !visit.completedDate && !bookingIsCancelled(visit);
  var jobs = requireTab(ss, JOBS_TAB);
  var slotResult = { action: "n/a" }, release = { action: "n/a" };
  var newJobId = "", fromWhen = "", moved = false;

  if (live) {
    var jobRow = findJobRow(jobs, visit.bookingId);
    if (!jobRow) return json({ ok: false, error: "not_found" });

    var timeChanged = !!choice.sched && !visitAlreadyAt(ss, jobs, jobRow, choice.sched);
    if (!freqChanged && !timeChanged) {
      return json({ ok: true, unchanged: true, plan_id: planId, job_id: visit.bookingId });
    }

    /* The same notice window a move or a cancellation answers to. */
    var notice = cancelNoticeHours();
    var left = hoursUntilBooking(visit);
    if (notice > 0 && left !== null && left < notice) {
      return json({ ok: false, error: "too_late", hours: notice });
    }
    if (freqChanged && visit.payment.paid) return json({ ok: false, error: "paid" });

    if (freqChanged) {
      setJobCells(jobs, jobRow.rowNumber, jobRow.headers, {
        frequency: choice.frequency, quoted_price: price, final_price: price,
      });
    }
    if (timeChanged) {
      fromWhen = scheduleLine(visit);
      var m = moveVisit(jobs, jobRow, visit, choice.sched);
      slotResult = m.slotResult; release = m.release; moved = true;
    }
  } else {
    /* Nothing coming: this books the plan's next visit, which needs a time. */
    if (!choice.sched) return json({ ok: false, error: "bad_slot" });
    var booked = bookPlanVisit(ss, contact, basis, {
      frequency: choice.frequency, price: price, sched: choice.sched,
      preference: choice.preference,
      submissionId: planSubmissionId(planId, nextPlanVisitSeq(jobs, planId)),
    });
    newJobId = booked.jobId;
    slotResult = booked.slotResult || slotResult;
  }

  var planFields = {};
  if (freqChanged) { planFields.frequency = choice.frequency; planFields.quoted_price = price; }
  /* THE PLAN BOX IS WHERE THE CADENCE IS REDEFINED — the anchor follows it.
     A preference has no clock time to anchor to, so it clears. */
  if (choice.sched) {
    planFields.anchor_date = choice.sched.shape === "slot" ? choice.sched.date : "";
    planFields.anchor_time = choice.sched.shape === "slot" ? choice.sched.time : "";
  }
  if (newJobId) planFields.confirmed_job_id = newJobId;
  try {
    setPlanCells(sheet, found, planFields);
  } catch (planErr) {
    console.error("move plan row not updated (visit stands): " + planErr);
  }

  try {
    sendMovePlanEmail({ what: newJobId ? "next visit" : "changed", basis: basis,
                        contactId: contact.contactId, planId: planId,
                        frequency: choice.frequency, oldFrequency: oldFrequency,
                        price: price, sched: choice.sched,
                        jobId: newJobId || visit.bookingId, fromWhen: fromWhen, moved: moved,
                        repriced: freqChanged && live, slotResult: slotResult, release: release,
                        preferredVendor: String(found.row.preferred_vendor_id || "").trim() });
  } catch (mailErr) {
    console.error("move plan change email failed (change stands): " + mailErr);
  }

  return json({ ok: true, plan_id: planId, job_id: newJobId || visit.bookingId,
                when: choice.sched ? choice.sched.summary : "" });
}

/** How many visits this plan has booked so far, plus one. */
function nextPlanVisitSeq(jobs, planId) {
  var t = sheetValues(jobs);
  var s = t.headers.indexOf("submission_id");
  if (s === -1) return 1;
  var prefix = "PLNC-" + String(planId).trim() + "-";
  var n = 0;
  for (var i = 0; i < t.rows.length; i++) {
    if (String(t.rows[i][s]).trim().indexOf(prefix) === 0) n++;
  }
  return n + 1;
}

/**
 * Tell a human a move customer started a plan or changed one.
 *
 * Its own email because what needs doing differs from r42's: an earlier/later
 * request has NO TIME and somebody must call, and a re-priced visit may sit
 * under a card hold taken for the old amount.
 */
function sendMovePlanEmail(ctx) {
  var slot = ctx.slotResult || { action: "n/a" };
  var release = ctx.release || { action: "n/a" };
  var b = ctx.basis;
  var noTime = !!ctx.sched && ctx.sched.shape !== "slot";

  var flags = [];
  if (slot.action === "conflict") flags.push("SLOT CONFLICT");
  if (slot.action === "failed")   flags.push("SLOT NOT MARKED");
  if (release.action === "failed" || release.action === "not_found") flags.push("SLOT NOT FREED");
  if (noTime)                     flags.push("NO TIME CHOSEN");
  if (ctx.repriced)               flags.push("PRICE CHANGED ON A BOOKED VISIT");
  if (ctx.preferredVendor)        flags.push("SAME COMPANY ASKED FOR");

  var warn = "";
  if (slot.action === "conflict") {
    warn += "*** SLOT CONFLICT — that time was already taken. The visit IS recorded. ***\n" +
            "*** " + (slot.reason || "") + " ***\n\n";
  }
  if (slot.action === "failed") {
    warn += "*** AVAILABILITY WRITE-BACK FAILED — the slot still reads open. ***\n" +
            "*** Mark it booked by hand or it can be sold again. ***\n\n";
  }
  if (release.action === "failed" || release.action === "not_found") {
    warn += "*** THE OLD SLOT WAS NOT GIVEN BACK — free it by hand. ***\n\n";
  }
  if (noTime) {
    warn += "*** NO TIME CHOSEN — they asked for " + ctx.sched.summary + ". ***\n" +
            "*** Call them to set the day and time. ***\n\n";
  }
  if (ctx.repriced) {
    warn += "*** THE UPCOMING VISIT WAS RE-PRICED to " + money(ctx.price) + " (" +
            ctx.oldFrequency + " -> " + ctx.frequency + "). ***\n" +
            "*** If a card was authorized for the old amount, that hold is for the ***\n" +
            "*** old price. Nothing was captured, voided or refunded. ***\n\n";
  }

  var verb = ctx.what === "started" ? "Started"
           : ctx.what === "next visit" ? "Next Visit Booked" : "Changed";
  MailApp.sendEmail(
    notifyEmail(),
    "Serve Plan " + verb + " — " + (b.customerName || "Unknown") + " · " + ctx.frequency +
      (flags.length ? " · " + flags.join(" · ") : ""),
    warn +
    /* r59. Which clean the plan follows, read off the basis rather than
       assumed — this box serves move customers AND one-off deep cleans now,
       and an operator reading "move-in / move-out" about a deep-clean
       customer would go looking for a move that does not exist. */
    (planBasisKind(b) === PLAN_BASIS_DEEP
      ? (ctx.what === "started"
          ? "A one-time deep-clean customer chose a recurring plan in their portal.\n" +
            "THIS IS A REAL BOOKING — the first plan visit is on JOBS.\n\n"
          : ctx.what === "next visit"
            ? "A deep-clean-plan customer booked their next visit from the plan box.\n\n"
            : "A deep-clean-plan customer changed their plan in their portal.\n\n")
      : (ctx.what === "started"
          ? "A move-in / move-out customer chose a recurring plan in their portal.\n" +
            "THIS IS A REAL BOOKING — the first plan visit is on JOBS.\n\n"
          : ctx.what === "next visit"
            ? "A move-plan customer booked their next visit from the plan box.\n\n"
            : "A move-plan customer changed their plan in their portal.\n\n")) +
    "— WHAT —\n" +
    "Plan:      " + ctx.planId + " (" + ctx.frequency +
      (ctx.oldFrequency && ctx.oldFrequency !== ctx.frequency ? ", was " + ctx.oldFrequency : "") + ")\n" +
    "After:     " + b.bookingId +
      (planBasisKind(b) === PLAN_BASIS_DEEP ? " (one-time deep clean)" : " (move in / move out)") + "\n" +
    "job_id:    " + ctx.jobId + "\n" +
    "Price:     " + money(ctx.price) + " per visit, from the pricing engine\n" +
    "Address:   " + (b.address || "") + (isSet(b.unit) ? ", " + b.unit : "") + "\n" +
    "ZIP:       " + (b.zip || "") + "\n" +
    (ctx.sched
      ? (ctx.moved ? "Was:       " + ctx.fromWhen + "\n" : "") +
        "When:      " + ctx.sched.summary + "\n" +
        "Slot:      " + slot.action +
          (slot.action === "booked" && isSet(slot.vendorId) ? " — vendor " + slot.vendorId : "") + "\n"
      : "When:      (time unchanged)\n") +
    "\n— WHAT THEY ASKED FOR —\n" +
    (ctx.preferredVendor
      ? "THE SAME COMPANY AS THE " +
        (planBasisKind(b) === PLAN_BASIS_DEEP ? "DEEP CLEAN" : "MOVE CLEAN") + ": " +
        ctx.preferredVendor + "\n" +
        "A preference, not a guarantee. Assign it yourself.\n"
      : "(no company preference)\n") +
    "\n" + ticketBlock(ctx.jobId, ctx.contactId, slot.vendorId, slot.action));
}

/**
 * Tell a human that an offer turned into a real visit.
 *
 * ITS OWN EMAIL RATHER THAN THE RESERVATION ONE, because the two need
 * different things done about them: nobody has to be called about a website
 * booking, and a same-company request is an instruction to dispatch that would
 * be invisible inside "a visitor just reserved a clean".
 */
function sendPlanConfirmedEmail(ctx) {
  var slotResult = ctx.slotResult || { action: "n/a" };

  var warn = "";
  if (slotResult.action === "conflict") {
    warn += "*** SLOT CONFLICT — that time was already taken. ***\n" +
            "*** " + (slotResult.reason || "") + " ***\n" +
            "*** The booking IS recorded. Call them and move it, or find a ***\n" +
            "*** second cleaner for the slot. They have not been told. ***\n\n";
  }
  if (slotResult.action === "failed") {
    warn += "*** AVAILABILITY WRITE-BACK FAILED — the slot still reads open. ***\n" +
            "*** " + (slotResult.error || "") + " ***\n" +
            "*** Mark it booked by hand or it can be sold again. ***\n\n";
  }

  var flags = [];
  if (slotResult.action === "conflict") flags.push("SLOT CONFLICT");
  if (slotResult.action === "failed")   flags.push("SLOT NOT MARKED");
  if (ctx.preferredVendor)              flags.push("SAME COMPANY ASKED FOR");

  MailApp.sendEmail(
    notifyEmail(),
    "Serve Plan Confirmed — " + (ctx.payload.name || "Unknown") + " · " +
      (ctx.payload.frequency_selected || "") +
      (flags.length ? " · " + flags.join(" · ") : ""),
    warn +
    "A customer confirmed their recurring plan in their portal.\n" +
    "THIS IS A REAL BOOKING — a slot was taken for it.\n\n" +
    "— WHEN —\n" + ctx.sched.summary + "\n\n" +
    "— WHAT —\n" +
    "Plan:      " + String(ctx.planRow.plan_id || "") +
      " (" + (ctx.payload.frequency_selected || "") + ")\n" +
    "Follows:   " + String(ctx.planRow.origin_job_id || "") + "\n" +
    "job_id:    " + ctx.record.job_id + "\n" +
    "Price:     " + money(ctx.payload.quote_price) + " per visit, as quoted\n" +
    "Address:   " + (ctx.payload.address || "") +
      (isSet(ctx.payload.unit) ? ", " + ctx.payload.unit : "") + "\n" +
    "ZIP:       " + (ctx.payload.zip || "") + "\n" +
    "Slot:      " + slotResult.action +
      (slotResult.action === "booked"
        ? " — AVAILABILITY row " + slotResult.row +
          (isSet(slotResult.vendorId) ? ", vendor " + slotResult.vendorId : "")
        : (slotResult.reason ? " — " + slotResult.reason : "")) + "\n\n" +
    "— WHAT THEY ASKED FOR —\n" +
    (ctx.preferredVendor
      ? "THE SAME COMPANY AS LAST TIME: " + ctx.preferredVendor + "\n" +
        "Recorded as a preference on the plan row. Nothing dispatches on it\n" +
        "automatically — assign it yourself, and tell them nothing: they were\n" +
        "told this is a request, not a guarantee.\n"
      : "(no company preference)\n") +
    ticketBlock(ctx.record.job_id, ctx.contactId,
                slotResult.vendorId, slotResult.action));
}


/* ============================================================
   CHANGING A VISIT  —  r43
   ============================================================

   Two portal writes that act on ONE booking the customer already has: move it
   to another time, or call it off. Both prove ownership through the same seam
   every other portal write uses, and both are refused on a finished booking —
   a completed visit is a receipt, not a plan.

   THE ANCHOR IS NOT TOUCHED BY EITHER OF THEM, and that is the whole design.
   A plan's anchor_date/anchor_time is the beat every later visit is counted
   from. Moving October's clean to the 9th does not move the cadence to the
   9th, and cancelling October does not cancel November. Writing the new time
   back onto the anchor would let one one-off change silently redefine the
   schedule — the drift that walks a customer's every-other-Tuesday into a
   different day of the week over a few months, with nothing anywhere recording
   that anyone decided it. SCHEMA has said this since r38; this is the release
   where code could first have broken it.

   THE job_id NEVER CHANGES. It is minted once from the date first booked, so
   after a move the date inside the id no longer matches scheduled_date. That
   is correct: the id is an identity, and it is the join key for the
   AVAILABILITY row, the instructions, the photos, the ticket and the portal.
   Re-minting it to keep the digits tidy would orphan all five at once.
   ============================================================ */

/** The sheet row one booking sits on, plus that tab's headers. */
function findJobRow(jobs, jobId) {
  var h = sheetHeaders(jobs);
  var idCol = h.indexOf("job_id");
  var last = jobs.getLastRow();
  if (idCol === -1 || last < 2) return null;

  var ids = jobs.getRange(2, idCol + 1, last - 1, 1).getValues();
  var needle = String(jobId).trim();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]).trim() === needle) return { rowNumber: i + 2, headers: h };
  }
  return null;
}

/**
 * Write named cells on one JOBS row.
 *
 * Same rule as setPlanCells: a column this tab does not have is SKIPPED, never
 * created. And one rule of its own — an OPS-OWNED column is REFUSED outright
 * rather than skipped quietly. Those cells belong to a dispatcher (`vendor_id`,
 * `cleaner`) or to whoever reconciles money (`payment_status`), and a
 * customer-facing write path must never become the back door that overwrites
 * one. A mistyped field name should stop the release, not lose a hand entry.
 */
function setJobCells(jobs, rowNumber, headers, fields) {
  Object.keys(fields).forEach(function (name) {
    if (OPS_OWNED_COLUMNS.indexOf(name) !== -1) {
      throw new Error('setJobCells refuses "' + name + '" — ops owns that column.');
    }
    var c = headers.indexOf(name);
    if (c === -1) { console.log("No " + name + " column on " + JOBS_TAB); return; }
    jobs.getRange(rowNumber, c + 1).setValue(fields[name]);
  });
}


/* ============================================================
   PAYMENT STATE — WRITTEN BY STRIPE, THROUGH THE WORKER (r50)
   ============================================================

   `payment_status` IS NO LONGER PURELY OPS-OWNED, and that is a real change to
   the promise SCHEMA.md made. It is worth being precise about what changed:

     BEFORE  the only thing that could fill this cell was a person typing into
             it, because the only way Serve learned about money was a person
             seeing it arrive.
     NOW     Stripe knows first, and knows exactly. A customer who authorized
             ninety seconds ago should not have to wait for an operator to
             notice before their own portal stops asking them to pay again.

   It stays in OPS_OWNED_COLUMNS on purpose, which is NOT a contradiction. That
   list guards `setJobCells`, and it is what stops the booking form, the portal
   writes, the reschedule and the cancellation from ever touching this cell.
   Exactly one caller is exempt, it is the function below, and it writes
   through its own path so the exemption cannot spread by accident. An operator
   typing "paid" for a customer who paid by check still works and is still
   correct — the two sources coexist, and neither blanks the other.

   THE GUARD THAT MATTERS IS THE RANK. Stripe retries failed deliveries for
   days and does not promise order, so `amount_capturable_updated` can land
   AFTER `succeeded` — which, written naively, would turn a captured payment
   back into a mere hold and re-offer the Authorize button to somebody who has
   already been charged. Rank makes that specific downgrade impossible while
   leaving the two legitimate ones (a hold voided, a payment refunded) alone. */

/* HOW FAR THE MONEY HAS GOT. `released` sits at 0 beside the blank cell
   because that is honestly what it is: no money, no hold, and a booking that
   needs authorizing again.

   A FIRST DRAFT OF THIS REJECTED EVERY DOWNGRADE, and a test caught that
   voiding a hold — `authorized` -> `released`, a perfectly ordinary
   cancellation — would then never have been recorded at all. The rule is
   narrower than "newer must outrank older", and worth stating exactly:

     ONCE MONEY HAS ACTUALLY MOVED, only news about money that has actually
     moved may overwrite it.

   Below that line (blank, released, authorized) nothing has left anybody's
   account, every transition is reversible, and a late event costs nothing. At
   or above it, a stale delivery would rewrite history the customer can see in
   their bank — which is the only case this guard exists for. */
const PAYMENT_RANK = { "": 0, "released": 0, "authorized": 1, "paid": 2, "refunded": 3 };

/* The line. `paid` and above mean a real card was really debited. */
const PAYMENT_SETTLED_RANK = 2;

/**
 * The one line a customer reads about money on this booking.
 *
 * FOUNDER COPY, NOT MINE — every sentence here is a statement about when a
 * real card gets charged, and it replaced "Due at service", which stopped
 * being true the moment authorize-at-booking shipped. It is worded to be
 * accurate rather than final; reword it freely, but keep the three cases
 * distinct, because collapsing them is what makes a page lie.
 */
function paymentNote(booking) {
  if (booking.payment.paid)       return "Paid";
  if (booking.payment.authorized) return "Card authorized — charged after your clean";
  return "Authorize before your clean";
}

/**
 * Record what Stripe says happened to one booking's money.
 *
 * ONLY THE WORKER MAY CALL THIS. The /exec URL is public, so a caller who
 * knows a job id must not be able to mark it paid; PAYMENT_BRIDGE_SECRET is
 * what separates this Worker from anyone else who has found the endpoint. It
 * is a DIFFERENT secret from PHOTO_BRIDGE_SECRET for the same reason the four
 * ticket audiences are different: one leaking must not become the other.
 *
 * Returns `applied: false` when the rank guard declined. That is a success —
 * the state on the row is already at least as advanced as the news — and the
 * Worker must not retry it.
 */
function handlePaymentEvent(ss, data) {
  /* TRIMMED ON BOTH SIDES, r51, AND THIS IS NOT COSMETIC. The Script
     Properties editor is a web form: a secret pasted into it very easily
     arrives with a trailing space or newline, and Google stores it verbatim.
     An exact comparison then fails forever against a Cloudflare secret that
     looks character-for-character identical on screen. A shared secret loses
     no entropy by having its surrounding whitespace ignored, and this cost the
     founder a live debugging session on 2026-09-16.

     THE ANSWER OUTWARD IS STILL IDENTICAL for a missing secret and a wrong
     one — a caller probing this endpoint must learn nothing about which it
     was. Only the LOG distinguishes them, because from inside they need
     completely different fixes and previously looked the same here too. */
  var secret = String(
    PropertiesService.getScriptProperties().getProperty("PAYMENT_BRIDGE_SECRET") || "").trim();
  var offered = String(data.bridge_token || "").trim();
  if (!secret) {
    console.error("payment_event refused: PAYMENT_BRIDGE_SECRET is not set in " +
                  "Script Properties. Payment state cannot be recorded.");
    return json({ ok: false, error: "not_found" });
  }
  if (offered !== secret) {
    /* Lengths only. Never the values, never a prefix — a fragment of a shared
       secret beside its name is a real head start. Equal lengths that still
       mismatch means a different string; different lengths usually means one
       side was pasted short or carries a stray character. */
    console.error("payment_event refused: bridge token mismatch (offered " +
                  offered.length + " chars, expected " + secret.length + "). " +
                  "The Cloudflare secret and this Script Property differ.");
    return json({ ok: false, error: "not_found" });
  }

  var jobId = String(data.job_id || "").trim();
  var state = String(data.state || "").trim().toLowerCase();
  if (!jobId) return json({ ok: false, error: "not_found" });
  if (!PAYMENT_RANK.hasOwnProperty(state) || state === "") {
    return json({ ok: false, error: "bad_state" });
  }

  var jobs = requireTab(ss, JOBS_TAB);
  var found = findJobRow(jobs, jobId);
  /* A job id Stripe knows and this sheet does not is not a retryable failure —
     it is a payment against something that was never booked here, or a test
     event from another environment. Said plainly so the Worker stops asking. */
  if (!found) {
    console.error("payment event for an unknown job: " + jobId);
    return json({ ok: true, applied: false, reason: "unknown_job" });
  }

  var h = found.headers;
  var statusCol = h.indexOf("payment_status");
  if (statusCol === -1) {
    console.error("JOBS has no payment_status column — payment state cannot be recorded");
    return json({ ok: false, error: "no_column" });
  }

  var current = String(jobs.getRange(found.rowNumber, statusCol + 1).getValue() || "")
    .trim().toLowerCase();
  /* An operator's hand-typed value that means nothing to this map ranks 0, so
     Stripe's news wins over a typo but never over a real state. */
  var currentRank = PAYMENT_RANK.hasOwnProperty(current) ? PAYMENT_RANK[current] : 0;

  /* Stripe retries for days and promises no order, so the harmful case is real:
     `amount_capturable_updated` landing AFTER `succeeded` would turn a captured
     payment back into a mere hold, and re-offer the Authorize button to
     somebody who has already been charged.

     Only settled states are defended. Below that line every transition is
     legitimate — including the downgrade an earlier draft of this wrongly
     refused, `authorized` -> `released`, which is just a cancelled booking
     letting go of its hold. */
  if (currentRank >= PAYMENT_SETTLED_RANK && PAYMENT_RANK[state] < currentRank) {
    console.log("payment event ignored, money has already moved for " + jobId +
                ": " + current + " -> " + state);
    return json({ ok: true, applied: false, reason: "stale" });
  }

  jobs.getRange(found.rowNumber, statusCol + 1).setValue(state);

  /* The reconciliation handle, where the column exists. Missing is survivable
     and logged rather than fatal: the payment state itself is the part a
     customer sees, and refusing to write it because a nice-to-have column is
     absent would be the wrong trade. */
  var refCol = h.indexOf("payment_ref");
  var ref = String(data.payment_ref || "").trim();
  if (ref && refCol !== -1) {
    jobs.getRange(found.rowNumber, refCol + 1).setValue(ref);
  } else if (ref) {
    console.log("No payment_ref column on " + JOBS_TAB + " — state written without it");
  }

  console.log("payment_status " + jobId + ": " + (current || "(blank)") + " -> " + state);

  /* TELL A HUMAN, r61. Only on a real transition, and never at the cost of the
     write above.

     `current !== state` IS THE WHOLE DEDUPE. Stripe retries a delivery it did
     not see acknowledged, and a redelivery of an event already applied lands
     here with the cell already reading `state`. Writing it again is harmless;
     emailing again is not, and a founder who learns to ignore a repeated
     subject line is worse off than one who was never told.

     WRAPPED BECAUSE THE CELL IS ALREADY WRITTEN. An exception escaping here
     would answer Stripe non-200, Stripe would retry, and the retry would find
     the state already applied and say so — so a mail outage would turn into a
     payment this file reports as never recorded. MailApp has a daily quota; it
     is allowed to run out without taking the money trail with it. */
  if (current !== state) {
    try {
      sendPaymentStateEmail({
        jobId: jobId, from: current, to: state, ref: ref,
        amountCents: data.amount_cents,
        fields: jobRowFields(jobs, found),
      });
    } catch (err) {
      console.error("payment recorded but the notification failed for " +
                    jobId + " (" + state + "): " + err);
    }
  }

  return json({ ok: true, applied: true, job_id: jobId, state: state });
}

/** One JOBS row as a name->value object. Absent headers simply do not appear. */
function jobRowFields(jobs, found) {
  var h = found.headers;
  var row = jobs.getRange(found.rowNumber, 1, 1, h.length).getValues()[0];
  var out = {};
  for (var i = 0; i < h.length; i++) out[String(h[i]).trim()] = row[i];
  return out;
}


/* ============================================================
   TELLING A HUMAN THAT MONEY MOVED  —  r61
   ============================================================

   UNTIL r61 NOTHING ANNOUNCED A PAYMENT. handlePaymentEvent wrote the cell and
   returned. Every other thing that can happen to a booking — a reservation, a
   plan started, a visit moved, a visit cancelled — sends the founder an email,
   and the one event involving an actual card sent nothing at all. A hold could
   be placed on a Tuesday and nobody would learn of it unless they happened to
   open the sheet.

   THAT MATTERS BECAUSE A HOLD IS NOT PERMANENT. Serve authorizes at booking
   and captures by hand later, and Stripe expires an uncaptured card
   authorization about seven days after it is created. Nothing here watched
   that clock. Money that was held on Tuesday is simply gone the Tuesday after,
   and the first symptom is a finished clean that cannot be charged for.

   AND THE BOOKING HORIZON IS THREE TIMES THE HOLD WINDOW. The slot feed
   publishes 21 days out (DAYS_AHEAD in availability.gs), so a card authorized
   for a visit more than seven days away WILL lapse before the cleaner arrives.
   That is not an edge case — it is every booking made more than a week ahead.

   THESE EMAILS DO NOT FIX THAT. They are what makes it visible, on the day the
   hold is placed, naming the date it dies. The fix is a choice between
   shortening the horizon, re-authorizing before the visit, and capturing at
   booking; each is a different promise to the customer about when their card
   is charged, and that is the founder's decision, not this file's.

   THE EXPIRY IS SELF-HEALING ON THE SHEET AND ONLY THERE. When Stripe expires
   an uncaptured intent it cancels it, which arrives here as `released` and
   correctly re-offers the Authorize button in the portal. Nobody is told. The
   customer believes they paid at booking, so the `released` email below is
   loud whenever the booking is still live — that is a customer who needs
   asking again, not a status change.
   ============================================================ */

/* Stripe's card default for an uncaptured PaymentIntent. Other payment methods
   differ and Stripe may change it; the dashboard is the source of truth, which
   is why every line built from this number says "about". */
const HOLD_WINDOW_DAYS = 7;

/** Today + n days as "YYYY-MM-DD". UTC on both sides, as prettyDate is. */
function isoDaysFromToday(n) {
  var now = new Date();
  var d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + n));
  return d.getUTCFullYear() + "-" +
         ("0" + (d.getUTCMonth() + 1)).slice(-2) + "-" +
         ("0" + d.getUTCDate()).slice(-2);
}

/**
 * The founder's email for one payment state change.
 *
 * EVERY FIELD IS OPTIONAL. This reads a JOBS row whose columns are whatever
 * that sheet actually has; a missing `name` or `scheduled_date` drops a line
 * and never throws. The four states each need a different thing done about
 * them, so they get different subjects rather than one "payment updated".
 */
function sendPaymentStateEmail(ctx) {
  var f = ctx.fields || {};
  var name = String(f.name || "").trim();
  var visit = String(f.scheduled_date || "").trim();
  var cancelled = String(f.job_status || "").trim().toLowerCase() === CANCELLED_JOB_STATUS;

  /* STRIPE'S NUMBER BEATS THE SHEET'S. quoted_price is what was asked for;
     amount_cents is what was actually held, captured or given back, and when
     the two disagree the second one is the true statement about a card. */
  var amount = (Number(ctx.amountCents) > 0)
    ? "$" + (Number(ctx.amountCents) / 100).toFixed(2)
    : money(firstSet(f.final_price, f.quoted_price));

  var expires = isoDaysFromToday(HOLD_WINDOW_DAYS);
  /* Plain string comparison, which is exactly right for two ISO dates and
     wrong for nothing. An unparseable or blank visit date compares false and
     simply raises no alarm — silence is the correct output for "unknown". */
  var lapsesFirst = ctx.to === "authorized" &&
                    /^\d{4}-\d{2}-\d{2}$/.test(visit) && visit > expires;

  var flags = [];
  var warn = "";
  var lead = "";
  var verb = "";

  if (ctx.to === "authorized") {
    verb = "Card Authorized";
    lead = "A card has been authorized for this booking.\n" +
           "NO MONEY HAS MOVED. This is a hold, and it expires — see the clock below.\n";
    if (lapsesFirst) {
      flags.push("HOLD LAPSES BEFORE THE VISIT");
      warn += "*** THIS HOLD DIES BEFORE THE CLEAN HAPPENS. ***\n" +
              "*** Authorized today, expires about " + prettyDate(expires) + ",\n" +
              "*** and the visit is " + prettyDate(visit) + ". On the day the cleaner\n" +
              "*** arrives there will be NO payment on file, and the customer has\n" +
              "*** been told their card is already authorized.\n" +
              "*** Ask them to authorize again nearer the date, or capture early. ***\n\n";
    }
  } else if (ctx.to === "paid") {
    verb = "Payment Captured";
    lead = "Money has actually moved. The hold on this booking was captured.\n";
  } else if (ctx.to === "refunded") {
    verb = "Refund";
    lead = "A captured payment was refunded.\n" +
           "The customer's portal now reads \"Refunded\" and offers them no pay button.\n";
  } else {
    verb = "Hold Released";
    if (cancelled) {
      lead = "The hold on a CANCELLED booking was released. Nothing is owed and\n" +
             "nothing was taken — this is the cancellation letting go of the card.\n";
    } else {
      /* The dangerous one, and the reason this email exists at all. */
      flags.push("LIVE BOOKING, NO CARD");
      lead = "A hold was released on a booking that is still going ahead.\n";
      warn += "*** THE CARD FOR A LIVE BOOKING IS NO LONGER AUTHORIZED. ***\n" +
              "*** Either somebody voided it, or the " + HOLD_WINDOW_DAYS + "-day Stripe hold\n" +
              "*** expired on its own. Nothing was taken and nothing is held.\n" +
              "*** The portal will ask them to authorize again — but they were\n" +
              "*** last told their card WAS authorized, so they have no reason\n" +
              "*** to look. Ask them. ***\n\n";
    }
  }

  var clock = "";
  if (ctx.to === "authorized") {
    clock = "\n— THE CLOCK —\n" +
            "Authorized:   today, as this event arrived\n" +
            "Expires:      about " + prettyDate(expires) + " — Stripe releases an\n" +
            "              uncaptured authorization about " + HOLD_WINDOW_DAYS + " days after it\n" +
            "              is created. Capture it by hand in the Stripe dashboard\n" +
            "              when the partner has accepted the job.\n" +
            (visit ? "Visit:        " + prettyDate(visit) + "\n" : "");
  }

  MailApp.sendEmail(
    notifyEmail(),
    "Serve " + verb + " — " + (name || "Unknown") + " · " + amount +
      (flags.length ? " · " + flags.join(" · ") : ""),
    warn + lead + "\n" +
    "— WHAT —\n" +
    "job_id:    " + ctx.jobId + "\n" +
    "Amount:    " + amount + (Number(ctx.amountCents) > 0 ? " (from Stripe)" : " (from the sheet)") + "\n" +
    "Was:       " + (ctx.from || "(nothing recorded)") + "\n" +
    "Now:       " + ctx.to + "\n" +
    "Booking:   " + (cancelled ? CANCELLED_JOB_STATUS.toUpperCase()
                               : (String(f.job_status || "").trim() || "(no status)")) + "\n" +
    (visit ? "Visit:     " + prettyDate(visit) +
             (isSet(f.start_time) ? " at " + f.start_time : "") + "\n" : "") +
    (isSet(f.service_type) ? "Service:   " + f.service_type + "\n" : "") +
    (isSet(f.zip) ? "ZIP:       " + f.zip + "\n" : "") +
    (isSet(f.vendor_id) ? "Assigned:  " + f.vendor_id + "\n" : "") +
    clock +
    "\n— IN STRIPE —\n" +
    (ctx.ref ? "Search the dashboard for " + ctx.ref + "\n"
             : "No PaymentIntent came with this event.\n") +
    /* No portal link and no address. This email is about a card, it is the one
       Serve email whose subject line alone says money moved, and it needs
       none of that to be acted on. */
    "");
}

/** Is this booking already called off? */
function bookingIsCancelled(booking) {
  return String(booking.status || "").trim().toLowerCase() === CANCELLED_JOB_STATUS;
}

const DEFAULT_CANCEL_NOTICE_HOURS = 0;
var CANCEL_NOTICE_CACHE = null;

/**
 * How much notice a customer must give to change or cancel in the portal.
 *
 * ZERO BY DEFAULT, AND THAT IS A DELIBERATE NON-DECISION. A notice window is a
 * customer promise with a refund question attached, and both are the founder's
 * to set — both were still open on 2026-09-13. Shipping a number I chose would
 * publish a policy nobody agreed to. So the mechanism is built, tested, and
 * off: put `cancel_notice_hours` in the Ops SETTINGS tab and it starts being
 * enforced, with no redeploy and no code change.
 *
 * A MOVE CANNOT LAND SOONER THAN THE FEED ALLOWS whatever this says. The times
 * offered come from /api/slots, which publishes nothing inside MIN_LEAD_HOURS
 * (18) — that floor is inherited from availability.gs, not invented here.
 */
function cancelNoticeHours() {
  if (CANCEL_NOTICE_CACHE !== null) return CANCEL_NOTICE_CACHE;
  CANCEL_NOTICE_CACHE = readCancelNoticeHours();
  return CANCEL_NOTICE_CACHE;
}

function readCancelNoticeHours() {
  try {
    var sheet = opsBook().getSheetByName(SETTINGS_TAB);
    if (!sheet || sheet.getLastRow() < 2) return DEFAULT_CANCEL_NOTICE_HOURS;

    var rows = sheet.getRange(1, 1, sheet.getLastRow(), 2).getValues();
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i][0] || "").trim().toLowerCase() !== "cancel_notice_hours") continue;

      var raw = String(rows[i][1] === 0 ? "0" : (rows[i][1] || "")).trim();
      if (!raw) return DEFAULT_CANCEL_NOTICE_HOURS;

      var n = Number(raw);
      /* Loud, and never clamped into range. Two weeks is already an extreme
         notice period for a house clean; a bigger number is a typo, and
         guessing what it meant would lock customers out of their own bookings
         with nothing anywhere reporting a fault. */
      if (!isFinite(n) || n < 0 || n > 336) {
        console.error("SETTINGS cancel_notice_hours is not a sane hour count: " +
                      JSON.stringify(raw) + " — using " + DEFAULT_CANCEL_NOTICE_HOURS);
        return DEFAULT_CANCEL_NOTICE_HOURS;
      }
      return n;
    }
    return DEFAULT_CANCEL_NOTICE_HOURS;
  } catch (err) {
    console.error("cancel_notice_hours lookup failed, using default: " + err);
    return DEFAULT_CANCEL_NOTICE_HOURS;
  }
}

/**
 * "2026-10-02" + "9:00 AM" -> a naive wall-clock instant. Null if the date is
 * unreadable, which is how a preference booking with no start reads.
 *
 * Naive on purpose: it is only ever compared against another value from this
 * same function, so both sides sit in the same zone and the offset cancels.
 */
function wallClockMs(dateStr, timeStr) {
  var d = String(dateStr || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  var p = d.split("-");

  /* NOT ANCHORED AT THE END, deliberately. The value handed in is usually
     getBooking's DISPLAY string, which carries a trailing " ET" — anchoring
     would fail to match it, silently fall through to midnight, and measure the
     notice window from the wrong instant by up to a day. Anything after the
     meridiem is ignored; text that is not a clock time at all ("9-11 AM", a
     preference label) still matches nothing and reads as midnight, which is
     the conservative answer for a booking with no real start. */
  var t = /^(\d{1,2}):(\d{2})\s*([AP])\.?M\.?\b/i.exec(String(timeStr || "").trim());
  var hour = 0, minute = 0;
  if (t) {
    hour = Number(t[1]) % 12;
    if (/^p$/i.test(t[3])) hour += 12;
    minute = Number(t[2]);
  }
  return Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]), hour, minute);
}

/**
 * Hours from now until a booking starts. Null when it has no specific time —
 * a preference booking has no start to count down to, and a notice window
 * cannot be applied to one.
 *
 * BOTH SIDES ARE READ IN BUSINESS WALL-CLOCK TIME. The booking's date and time
 * are Boston local, because the customer picked them off a Boston calendar.
 * Building a Date from them directly would interpret them in the SCRIPT
 * PROJECT's timezone, which is a different setting in a different place and
 * has silently disagreed before (r32). Formatting "now" through BUSINESS_TZ
 * and parsing it with the very same parser keeps both sides honest.
 *
 * Off by up to an hour across a DST change. That is acceptable for a window
 * measured in hours and is not worth a calendar library.
 */
function hoursUntilBooking(booking) {
  var start = wallClockMs(booking.scheduledDate, booking.startTime);
  if (start === null) return null;

  var now = new Date();
  var here = wallClockMs(Utilities.formatDate(now, BUSINESS_TZ, "yyyy-MM-dd"),
                         Utilities.formatDate(now, BUSINESS_TZ, "h:mm a"));
  if (here === null) return null;

  return (start - here) / 3600000;
}

/** What a booking's time reads as today, for an email that has to say both. */
function scheduleLine(booking) {
  var explicit = [String(booking.scheduledDate || "").trim(),
                  String(booking.startTime || "").trim()].filter(Boolean).join(" at ");
  return explicit || String(booking.scheduleSummary || "") || "no time on file";
}

/**
 * MOVE ONE VISIT. The customer picks a new time from the same feed and the
 * same horizon rules the booking form uses, and the visit moves to it.
 */
function rescheduleBooking(ss, contact, booking, data) {
  /* Validated, not passed along — the same rule as a plan confirmation. A time
     nothing can read matches no AVAILABILITY row, consumes nothing, and leaves
     a customer holding a confirmation for a visit no cleaner can see. */
  var slotDate = String(data.slot_date || "").trim();
  var slotTime = String(data.slot_time || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(slotDate) || !PLAN_TIME_SHAPE.test(slotTime)) {
    return json({ ok: false, error: "bad_slot" });
  }
  var sched = normalizeSchedule({ slot_date: slotDate, slot_time: slotTime });
  if (sched.shape !== "slot") return json({ ok: false, error: "bad_slot" });

  var jobs = requireTab(ss, JOBS_TAB);
  var found = findJobRow(jobs, booking.bookingId);
  if (!found) return json({ ok: false, error: "not_found" });

  if (visitAlreadyAt(ss, jobs, found, sched)) {
    return json({ ok: true, unchanged: true, job_id: booking.bookingId,
                  when: sched.summary });
  }

  var notice = cancelNoticeHours();
  var left = hoursUntilBooking(booking);
  if (notice > 0 && left !== null && left < notice) {
    return json({ ok: false, error: "too_late", hours: notice });
  }

  var fromWhen = scheduleLine(booking);
  var moved = moveVisit(jobs, found, booking, sched);
  var slotResult = moved.slotResult, release = moved.release;

  /* NOTE WHAT IS ABSENT: nothing here writes RECURRING_PLANS. See the section
     header — the anchor is the cadence, and one moved visit is not a new
     cadence. */
  try {
    sendVisitChangedEmail({
      what: "moved", ss: ss, booking: booking, contactId: contact.contactId,
      fromWhen: fromWhen, toWhen: sched.summary,
      release: release, slotResult: slotResult,
    });
  } catch (mailErr) {
    console.error("reschedule email failed (the move stands): " + mailErr);
  }

  return json({ ok: true, job_id: booking.bookingId, when: sched.summary,
                slot_action: slotResult.action, released: release.action });
}

/**
 * Is this visit already at that time? r45: split out of rescheduleBooking so
 * the plan box asks the same question the same way.
 */
function visitAlreadyAt(ss, jobs, found, sched) {
  /* ALREADY THERE — and this is a guard, not a nicety. A double-tapped button
     would otherwise release the slot this booking holds and then try to book
     the very same row again; whether that succeeds depends on ordering, and
     the failure mode is a customer's own visit handed away to nobody. Nothing
     is touched, and the answer is a success, because from the customer's side
     it is one: the visit is at the time they asked for.

     COMPARED AGAINST THE RAW CELLS, NEVER AGAINST getBooking's STRINGS, and
     that distinction cost this guard its entire purpose the first time it ran.
     `booking.startTime` is a DISPLAY value: timeCellText appends " ET" to
     anything reading as a clock time, so it is "1:00 PM ET" where the browser
     sends "1:00 PM". The comparison was therefore false forever, the guard
     never fired, and a repeated move re-booked a row that was already booked
     (a conflict, so nothing was taken) and then released the row the customer
     was holding — giving their visit away. Both sides are normalised through
     slotTimeLabel, the same function that matches an AVAILABILITY row. */
  var jobTz   = sheetTimeZone(ss);
  var cellOf  = function (name) {
    var c = found.headers.indexOf(name);
    return c === -1 ? "" : jobs.getRange(found.rowNumber, c + 1).getValue();
  };
  /* r45. A preference has no clock time: it is "already there" when the visit
     is already a preference carrying the same wording. */
  if (sched.shape !== "slot") {
    return String(cellOf("scheduling_type")).trim() === sched.shape &&
           String(cellOf("start_time")).trim() === sched.summary;
  }
  return dateCellText(cellOf("scheduled_date"), jobTz) === sched.date &&
         slotTimeLabel(cellOf("start_time"), jobTz) === sched.time;
}

/**
 * MOVE A VISIT'S ROW AND ITS CAPACITY to a new time. r45: split out of
 * rescheduleBooking unchanged, so the plan box moves a visit exactly as
 * "Change time" does. Returns { slotResult, release }.
 *
 * r45 also accepts a PREFERENCE ("earlier" / "later"): the date and clock
 * time clear, the wording goes where the booking form puts it, no slot is
 * taken, and the old one goes back on sale. Only the plan box sends one.
 */
function moveVisit(jobs, found, booking, sched) {
  var isSlot = sched.shape === "slot";

  /* THE COMMITMENT. Everything below is capacity bookkeeping, and none of it
     may fail the change the customer just made — the same band, and the same
     rule, as the website's booking path. */
  setJobCells(jobs, found.rowNumber, found.headers, {
    scheduled_date:  isSlot ? sched.date : "",
    /* start_time holds the preference wording on a preference booking, as
       buildJobRecord writes it. */
    start_time:      isSlot ? sched.time : sched.summary,
    notes:           sched.summary,
    scheduling_type: sched.shape,
  });

  /* TAKE THE NEW TIME BEFORE GIVING THE OLD ONE BACK. Both run inside the
     script lock doPost already holds, so nothing interleaves — the order is
     about failure, not races: never release capacity you are holding until the
     replacement has been secured, or a throw in between leaves the customer
     with neither. */
  var slotResult = { ok: true, action: "skipped" };
  try {
    slotResult = bookAvailabilitySlot(sched, booking.bookingId, booking.serviceCode);
  } catch (slotErr) {
    slotResult = { ok: false, action: "failed", error: String(slotErr) };
    console.error("reschedule slot write-back failed (the move stands): " + slotErr);
  }

  var release = { ok: true, action: "skipped" };
  try {
    /* The row just taken is excluded BY NUMBER. Both rows now carry this
       job_id, so anything matching on the id alone would give the new time
       straight back — see releaseAvailabilitySlot. */
    release = releaseAvailabilitySlot(booking.bookingId,
                slotResult.action === "booked" ? slotResult.row : 0);
  } catch (relErr) {
    release = { ok: false, action: "failed", error: String(relErr) };
    console.error("reschedule release failed (the move stands): " + relErr);
  }

  /* BLANK CELLS ONLY, exactly as at booking. vendor_id is ops-owned: where a
     dispatcher has already assigned this job, the new slot belonging to another
     company is a clash for a HUMAN to resolve, never something a customer's
     reschedule may quietly overwrite. The email below says so in as many
     words. */
  try {
    stampJobVendor(jobs, found.rowNumber, slotResult.vendorId);
  } catch (stampErr) {
    console.error("reschedule vendor stamp failed (the move stands): " + stampErr);
  }

  return { slotResult: slotResult, release: release };
}

/**
 * CALL ONE VISIT OFF.
 *
 * The row is marked, never removed, and the slot goes back to the feed.
 *
 * r50 — A CANCELLED VISIT NO LONGER LEAVES A HOLD ON THE CARD. This used to
 * touch money in neither direction, on the reasoning that refund terms were
 * the founder's open decision and a cancellation that silently voided or kept
 * a hold would be settling it by accident. Half of that still stands: nothing
 * here refunds, because a refund gives back money that was actually taken and
 * that IS a policy question.
 *
 * Releasing an authorization is not the same act. No money ever moved, the
 * customer has just called the visit off themselves, and the only question is
 * whether their card stays encumbered for a week for a cleaning nobody is
 * coming to do. Leaving it was never the neutral choice — to the person whose
 * available balance is short, it reads exactly like being charged for a
 * service they cancelled.
 *
 * THIS FUNCTION STILL TOUCHES NO MONEY ITSELF, and must not: the Stripe key is
 * deliberately not available to Apps Script. It NAMES the outstanding hold in
 * its reply, and the Worker — which verified the caller and holds the key —
 * voids it. A captured payment is named by nobody, because taking money back
 * is the decision this still refuses to make on its own.
 */
function cancelBooking(ss, contact, booking, data) {
  var notice = cancelNoticeHours();
  var left = hoursUntilBooking(booking);
  if (notice > 0 && left !== null && left < notice) {
    return json({ ok: false, error: "too_late", hours: notice });
  }

  var jobs = requireTab(ss, JOBS_TAB);
  var found = findJobRow(jobs, booking.bookingId);
  if (!found) return json({ ok: false, error: "not_found" });

  /* THE ROW SURVIVES. Deleting it would take the address, the price, the
     instructions and the attribution with it, and every count of "work booked"
     would quietly stop including the work that was booked and given back. */
  setJobCells(jobs, found.rowNumber, found.headers, {
    job_status: CANCELLED_JOB_STATUS,
  });

  var release = { ok: true, action: "skipped" };
  try {
    release = releaseAvailabilitySlot(booking.bookingId);
  } catch (relErr) {
    release = { ok: false, action: "failed", error: String(relErr) };
    console.error("cancel release failed (the cancellation stands): " + relErr);
  }

  /* The reason goes in the EMAIL and nowhere else. It is worth a human reading
     and it is not worth a new JOBS column invented on a customer's behalf. */
  try {
    sendVisitChangedEmail({
      what: "cancelled", ss: ss, booking: booking, contactId: contact.contactId,
      fromWhen: scheduleLine(booking), toWhen: "",
      reason: String(data.reason || "").trim().slice(0, 500),
      release: release, slotResult: { action: "n/a" },
    });
  } catch (mailErr) {
    console.error("cancel email failed (the cancellation stands): " + mailErr);
  }

  /* r50. ONLY AN UNCAPTURED HOLD, and only when there is a Stripe intent to
     name. `authorized` is the one state where money is promised but not taken,
     so it is the one state where letting go costs the customer nothing and
     costs Serve nothing. A `paid` booking is money that really moved and stays
     a human's decision; the email below still says so.

     The Worker strips this before the browser sees it. */
  var out = { ok: true, job_id: booking.bookingId, released: release.action };
  if (booking.payment.authorized && booking.payment.ref) {
    out.payment_ref = booking.payment.ref;
  }
  return json(out);
}

/**
 * Tell a human that a booked visit moved or stopped existing.
 *
 * ONE EMAIL FOR BOTH, because the thing a person has to do about them is the
 * same: look at whether capacity ended up where it should be, and whether
 * anybody needs calling. The subject carries the flags so it can be triaged
 * without opening it.
 */
function sendVisitChangedEmail(ctx) {
  var moved   = ctx.what === "moved";
  var release = ctx.release || { action: "n/a" };
  var slot    = ctx.slotResult || { action: "n/a" };
  var b       = ctx.booking;

  var warn = "";
  if (release.action === "failed" || release.action === "not_found") {
    warn += "*** THE OLD SLOT WAS NOT GIVEN BACK — it still reads booked. ***\n" +
            "*** " + (release.error || release.reason || "") + " ***\n" +
            "*** Free it by hand or that time stays unsellable. ***\n\n";
  }
  if (moved && slot.action === "conflict") {
    warn += "*** SLOT CONFLICT — the new time was already taken. ***\n" +
            "*** " + (slot.reason || "") + " ***\n" +
            "*** The visit HAS been moved. Call them, or find a second ***\n" +
            "*** cleaner for that slot. They have not been told. ***\n\n";
  }
  if (moved && slot.action === "failed") {
    warn += "*** THE NEW SLOT WAS NOT MARKED BOOKED — it still reads open. ***\n" +
            "*** " + (slot.error || "") + " ***\n" +
            "*** Mark it by hand or it can be sold twice. ***\n\n";
  }

  /* THE ASSIGNMENT CLASH. A dispatcher's vendor_id is never overwritten by a
     reschedule, so a visit can end up assigned to one company while sitting in
     another company's slot. Nothing is broken and nobody is told — which is
     exactly why it has to be said out loud here. */
  var assigned = String(b.vendorId || "").trim();
  var slotVendor = String(slot.vendorId || "").trim();
  var clash = moved && assigned && slotVendor && assigned !== slotVendor;
  if (clash) {
    warn += "*** ASSIGNED TO ONE COMPANY, BOOKED INTO ANOTHER'S SLOT. ***\n" +
            "*** Job is assigned to " + assigned + "; the new slot belongs to " +
            slotVendor + ". ***\n" +
            "*** Reassign the job or move it again. Nothing was overwritten. ***\n\n";
  }

  var flags = [];
  if (release.action === "failed" || release.action === "not_found") flags.push("SLOT NOT FREED");
  if (moved && slot.action === "conflict") flags.push("SLOT CONFLICT");
  if (moved && slot.action === "failed")   flags.push("SLOT NOT MARKED");
  if (clash) flags.push("VENDOR CLASH");

  MailApp.sendEmail(
    notifyEmail(),
    "Serve Visit " + (moved ? "Moved" : "CANCELLED") + " — " +
      (b.customerName || "Unknown") +
      (flags.length ? " · " + flags.join(" · ") : ""),
    warn +
    (moved
      ? "A customer moved one of their visits in their portal.\n\n"
      : "A customer cancelled one of their visits in their portal.\n" +
        "THE BOOKING ROW IS KEPT and now reads " + CANCELLED_JOB_STATUS + ".\n\n") +
    "— WHEN —\n" +
    (moved ? "Was:       " + ctx.fromWhen + "\n" +
             "Now:       " + ctx.toWhen + "\n"
           : "Was:       " + ctx.fromWhen + "\n") + "\n" +
    "— WHAT —\n" +
    "job_id:    " + b.bookingId + "\n" +
    "Service:   " + (b.serviceLabel || "") +
      (b.frequency ? " (" + b.frequency + ")" : "") + "\n" +
    "Price:     " + money(b.price.final || b.price.quoted) + "\n" +
    "Address:   " + (b.address || "") +
      (isSet(b.unit) ? ", " + b.unit : "") + "\n" +
    "ZIP:       " + (b.zip || "") + "\n" +
    "Assigned:  " + (assigned || "(nobody yet)") + "\n" +
    "Old slot:  " + release.action +
      (release.action === "released" ? " — AVAILABILITY row(s) " + (release.rows || []).join(", ")
                                     : (release.reason ? " — " + release.reason : "")) + "\n" +
    (moved
      ? "New slot:  " + slot.action +
        (slot.action === "booked"
          ? " — AVAILABILITY row " + slot.row +
            (isSet(slot.vendorId) ? ", vendor " + slot.vendorId : "")
          : (slot.reason ? " — " + slot.reason : "")) + "\n"
      : "") +
    (ctx.reason ? "\n— WHY THEY SAID —\n" + ctx.reason + "\n" : "") +
    /* TAKING MONEY, AND GIVING IT BACK, ARE STILL A HUMAN'S (r50). Releasing
       an untaken hold is not — see cancelBooking. The three cases are named
       separately because the thing a person has to DO about them differs. */
    (b.payment.paid
      ? "\n— MONEY —\nThis booking reads PAID — money was actually taken.\n" +
        "Decide what is owed back and refund it in Stripe.\n"
      : b.payment.authorized
      ? "\n— MONEY —\nA hold was outstanding. Releasing it was requested\n" +
        "automatically; confirm in Stripe that the authorization is gone.\n"
      : "\n— MONEY —\nNo payment was authorized or captured. Nothing to undo.\n") +
    "\n" + ticketBlock(b.bookingId, ctx.contactId, b.vendorId, slot.action));
}


function buildPortalModel(ss, contact) {
  var bookings = getContactBookings(ss, contact.leadId);
  /* A customer with a standing partner has the same vendor on every row. */
  var vendorMemo = {};
  var partnerNotes = partnerNoteRows(ss);

  var homes = getContactProperties(bookings).map(function (p) {
    var access = getPropertyAccess(ss, p.propertyId);
    return {
      propertyId: p.propertyId,
      key:        p.key,
      label:      p.label,
      zip:        p.zip,
      questions:  accessQuestionList(access),
      petNotes:   access.petNotes,
      petPlaceholder: ACCESS_PET_PLACEHOLDER,
      updatedAt:  access.updatedAt,
    };
  });

  return {
    ok: true,
    view: "portal",
    photoSupport: !!PropertiesService.getScriptProperties().getProperty("PHOTO_BRIDGE_SECRET"),
    contactId: contact.contactId,
    firstName: contact.firstName,
    name:      contact.name,
    homes:     homes,
    /* r38. The plan they were offered, if one is still open. null is the
       ordinary answer: most bookings carry no cadence, and a lapsed window
       reads as null too.

       r40: matched on lead_id, the same seam getContactBookings uses above.
       contact_id would miss every plan whose JOBS row predates that column.

       r42: planForPortal adds ONE field — whether there is a previous company
       to offer asking for again. It needs the booking list, which is why it is
       a second step rather than another read inside clientRecurringPlan. */
    plan:      planForPortal(clientRecurringPlan(ss, contact.leadId), bookings),
    /* r45. The plan box for somebody who booked a move — the choice, or the
       plan they chose. null for everybody else. */
    movePlan:  movePlanForPortal(ss, bookings),
    bookings:  bookings.map(function (b) {
      var done = !!b.completedDate;
      /* r43. Called off, and still on the account as a record of what was
         really sold and really given back. */
      var cancelled = bookingIsCancelled(b);
      var row = {
        bookingId:    b.bookingId,
        photos:       publicBookingPhotos(ss, b.bookingId),
        /* r48. What the cleaner noted, room by room: the room's label and the
           text, never who wrote it. Routed to the company, like everything
           else a customer sees about who did the work. */
        partnerNotes: cancelled ? [] : partnerNotesForRooms(partnerNotes, b),
        /* The code, not only the label: the portal renders what a service
           includes from SERVE_SCOPE, which is keyed by code. The label is prose
           and may be reworded; the code is the join.

           This key was ALREADY on the row before r37 — that release only
           started using it, and briefly added a second copy of it here. */
        serviceCode:  b.serviceCode,
        serviceLabel: SERVICE_CODES[b.serviceCode] || b.serviceLabel,
        /* r36. The plan the customer chose, beside the visit they are getting.
           Without it the portal could name the service correctly and still not
           explain why someone who asked for weekly upkeep is looking at a first
           clean — which is the confusion that reported the r36 bug in the first
           place. The per-job ticket has carried this since r14; only the portal
           row left it out. */
        frequency:    b.frequency,
        date:         b.scheduledDate,
        time:         b.startTime,
        when:         b.scheduleSummary,
        status:       b.status,
        completed:    b.completedDate,
        /* A FIELD, not a string the browser has to interpret. The portal must
           never have to know how job_status is spelled — that is a sheet
           value an operator can reword, and a page comparing against it would
           start showing cancelled visits as live ones the day they did. */
        cancelled:    cancelled,
        price:        b.price.final || b.price.quoted,
        /* r50. See the client ticket's copy of this for why two fields.
           r60 adds a third: a refund is not the same as never having paid,
           and the portal could not tell them apart. */
        paid:         b.payment.paid,
        authorized:   b.payment.authorized,
        refunded:     b.payment.refunded,
        addOns:       b.addOns,
        propertyLabel: [b.address, b.unit].filter(Boolean).join(", "),
        editable:     !done && !cancelled,
      };
      /* Rooms and instructions only where they can still be acted on. A past
         booking is a receipt, and loading every room of every job a customer
         has ever had would grow the payload for nothing. A cancelled one is
         the same: nobody is coming, so there is nothing to instruct. */
      if (!done && !cancelled) {
        var sorted = sortInstructions(getBookingInstructions(ss, b.bookingId));
        row.rooms = deriveRooms(b.beds, b.baths).map(function (r) {
          return { key: r.key, label: r.label, instruction: sorted.rooms[r.key] || "" };
        });
        row.generalInstruction = sorted.general;
        row.atBooking = b.customerNotes;

        /* Who is coming, through the SAME whitelist the per-job ticket uses.
           null is a legitimate answer and the one the portal renders as
           "coordinating" — it is every preference booking, since a booking
           with no specific time consumes no availability row and so gets no
           vendor. Never fatal: a missing VENDORS tab loses the card, not the
           booking list. */
        row.partner = null;
        try {
          var vid = String(getAssignment(ss, b).vendorId || "");
          if (vid) {
            if (vendorMemo[vid] === undefined) vendorMemo[vid] = clientVendorCard(ss, vid);
            row.partner = vendorMemo[vid];
          }
        } catch (vendErr) {
          console.error("portal vendor lookup failed for " + b.bookingId + ": " + vendErr);
        }
      }
      return row;
    }),
  };
}


/**
 * The portal link's token. A third audience, a third scope, one secret.
 *
 * Same construction as ticketToken, and deliberately NOT the same value: a
 * ticket token must not open a portal and a portal token must not open a
 * ticket. Scoping by string inside the HMAC is what keeps three audiences
 * apart without three secrets to manage.
 */
function portalToken(contactId) {
  var raw = Utilities.computeHmacSha256Signature(String(contactId) + "|portal", ticketSecret());
  var hex = raw.map(function (b) {
    return ("0" + (b < 0 ? b + 256 : b).toString(16)).slice(-2);
  }).join("");
  return hex.slice(0, 20);
}

/** The one link a customer keeps. Same every booking, forever. */
function portalUrl(contactId) {
  return "https://servecleaning.com/h?id=" + encodeURIComponent(contactId) +
         "&t=" + portalToken(contactId);
}

/** GET the portal. */
function handlePortal(p) {
  var contactId = String(p.portal || "").trim();
  if (!contactId || portalToken(contactId) !== String(p.t || "").trim()) {
    return json({ ok: false, error: "not_found" });
  }
  try {
    var ss = SPREADSHEET_ID ? SpreadsheetApp.openById(SPREADSHEET_ID)
                            : SpreadsheetApp.getActiveSpreadsheet();
    var contact = getContact(ss, contactId);
    /* Refused identically to a bad token. Telling a caller that an id exists
       but they hold the wrong key is still telling them the id exists. */
    if (!contact) return json({ ok: false, error: "not_found" });
    return json(buildPortalModel(ss, contact));
  } catch (err) {
    console.error("handlePortal failed: " + (err && err.stack ? err.stack : err));
    return json({ ok: false, error: "lookup_failed" });
  }
}

/**
 * POST from the portal: an instruction on one booking, or an access answer on
 * one home.
 *
 * THE OWNERSHIP CHECK IS THE WHOLE SECURITY MODEL HERE, and it is not
 * optional. A portal token authorises ONE contact, not the sheet. Every write
 * resolves that contact's lead_id first and then proves the target belongs to
 * them — the job carries their lead_id, or the property appears on one of
 * their bookings. Without it a valid token would be a key to every booking
 * Serve has ever taken, which is a far worse failure than the one the token
 * was protecting against.
 *
 * Never throws. A note that fails to save must return an error the page can
 * show, not a stack trace.
 */
function handlePortalWrite(ss, data) {
  var contactId = String(data.contact_id || "").trim();
  if (!contactId || portalToken(contactId) !== String(data.t || "").trim()) {
    return json({ ok: false, error: "not_found" });
  }

  try {
    var contact = getContact(ss, contactId);
    if (!contact) return json({ ok: false, error: "not_found" });

    var bookings = getContactBookings(ss, contact.leadId);
    var kind = String(data.kind || "").toLowerCase();

    /* r43. THREE kinds act on one booking the customer already has, and all
       three need the same proof first: it is a real job, it is theirs, and it
       is still open. Proving it in one place is what keeps the answers
       identical across them — "not yours" and "does not exist" must stay
       indistinguishable on every one of the three, not just on the oldest. */
    if (kind === "instruction" || kind === "reschedule" || kind === "cancel") {
      var jobId = String(data.job_id || "").trim();
      var mine = null;
      for (var i = 0; i < bookings.length; i++) {
        if (bookings[i].bookingId === jobId) { mine = bookings[i]; break; }
      }
      /* Not theirs, or not a job at all — the same answer either way. */
      if (!mine) return json({ ok: false, error: "not_found" });
      if (mine.completedDate) return json({ ok: false, error: "closed" });
      /* A visit already called off cannot be edited, moved or cancelled again.
         Moving one would book a fresh slot for a booking nobody is coming to. */
      if (bookingIsCancelled(mine)) return json({ ok: false, error: "cancelled" });

      if (kind === "instruction") return writeInstruction(ss, mine, data);
      if (kind === "reschedule")  return rescheduleBooking(ss, contact, mine, data);
      return cancelBooking(ss, contact, mine, data);
    }

    if (kind === "access") {
      var propertyId = String(data.property_id || "").trim();
      var owns = false;
      for (var k = 0; k < bookings.length; k++) {
        if (String(bookings[k].propertyId || "").trim() === propertyId && propertyId) {
          owns = true; break;
        }
      }
      if (!owns) return json({ ok: false, error: "not_found" });
      return writeAccess(ss, propertyId, data);
    }

    /* r42. Confirming the recurring plan they were offered. THE ONLY PORTAL
       WRITE THAT CREATES A BOOKING — it proves ownership twice and then goes
       through the same job-creation path the website does. */
    if (kind === "plan_confirm") return confirmRecurringPlan(ss, contact, data);

    /* r45. A move customer choosing a plan, or changing the one they chose.
       Both prove ownership against this contact's own bookings before any
       price is asked for or any row written. */
    if (kind === "plan_start")  return startMovePlan(ss, contact, bookings, data);
    if (kind === "plan_change") return changeMovePlan(ss, contact, bookings, data);

    return json({ ok: false, error: "unknown_kind" });

  } catch (err) {
    console.error("handlePortalWrite failed: " + (err && err.stack ? err.stack : err));
    return json({ ok: false, error: "save_failed" });
  }
}

/**
 * One access answer: a choice, and the detail that choice allows.
 *
 * THE SECRET GOES SOMEWHERE ELSE. A choice flagged `secret` in
 * ACCESS_QUESTIONS writes its detail to Access MASTER, never to Leads.
 * The private write is verified before updating the public saved marker.
 */
function writeAccess(ss, propertyId, data) {
  var field = String(data.field || "").toLowerCase();
  var known = false;
  for (var i = 0; i < ACCESS_QUESTIONS.length; i++) {
    if (ACCESS_QUESTIONS[i].field === field) { known = true; break; }
  }

  var sheet = ensurePropertyAccessTab(ss);
  var h = sheetHeaders(sheet);
  var col = function (n) { return h.indexOf(n); };
  var now = new Date();

  /* Find or create this home's row. */
  var rowIndex = -1;
  var last = sheet.getLastRow();
  if (last > 1) {
    var pi = col("property_id");
    var ids = sheet.getRange(2, pi + 1, last - 1, 1).getValues();
    for (var r = 0; r < ids.length; r++) {
      if (String(ids[r][0]).trim() === propertyId) { rowIndex = r + 2; break; }
    }
  }
  if (rowIndex === -1) {
    var blank = new Array(h.length).fill("");
    blank[col("property_id")] = propertyId;
    sheet.appendRow(blank);
    rowIndex = sheet.getLastRow();
  }

  var set = function (name, value) {
    var c = col(name);
    if (c !== -1) sheet.getRange(rowIndex, c + 1).setValue(value);
  };

  /* Pets is the one free-text answer — the booking form already screens for
     pets, so this only asks the thing left worth knowing. */
  if (field === "pets") {
    set("pet_notes", String(data.detail || "").trim().slice(0, 500));
    set("updated_at", now);
    return json({ ok: true, field: "pets" });
  }

  if (!known) return json({ ok: false, error: "unknown_field" });

  var choiceKey = String(data.choice || "").toUpperCase();
  var choice = accessChoice(field, choiceKey);
  if (!choice) return json({ ok: false, error: "unknown_choice" });

  var detail = String(data.detail || "").trim().slice(0, 500);
  if (field === "entry") {
    // Migration must finish first. Never accept a code against the old schema.
    if (col("entry_code") !== -1 || col("entry_code_saved") === -1) {
      return json({ ok: false, error: "save_failed" });
    }
    try {
      var saved = savePrivateEntryCode(ss, propertyId, choice.secret ? detail : "", now, !!choice.secret && !detail);
      set("entry_code_saved", saved.saved);
      set("entry_code_set_at", saved.savedAt);
    } catch (privateErr) {
      // Service exceptions may contain request data: never log the exception.
      console.warn("Private access storage unavailable; entry answer was not saved.");
      return json({ ok: false, error: "save_failed" });
    }
  }
  set(field + "_choice", choice.key);

  if (choice.secret) {
    /* An empty detail on a secret choice leaves the stored code alone —
       selecting "Access code" again should not wipe a code they set last
       month just because the box renders blank, which it always does. */
    set(field + "_detail", "");
  } else {
    set(field + "_detail", choice.detail ? detail : "");
    /* Moving off the code option clears the code. Leaving it behind would
       mean a home whose access says "I'll let you in" still has a live door
       code sitting in the sheet. */
  }

  set("updated_at", now);
  return json({ ok: true, field: field, choice: choice.key });
}

/**
 * A room or general instruction, written on behalf of a verified owner.
 *
 * Shares BOOKING_INSTRUCTIONS and its one-row-per-scope semantics with
 * handleInstruction, which still serves the older per-job client link. The
 * ownership check happened in the caller; this only validates the scope.
 */
function writeInstruction(ss, booking, data) {
  var raw = String(data.scope_type || "BOOKING").toUpperCase();
  var scopeType = raw === "ROOM" ? "ROOM" : "BOOKING";
  var scopeKey = scopeType === "BOOKING"
    ? "GENERAL"
    : String(data.scope_key || "").toUpperCase();

  var allowed = validScopeKeys(booking.beds, booking.baths);
  if (!allowed[scopeKey]) return json({ ok: false, error: "unknown_room" });

  var text = String(data.instruction || "").trim().slice(0, 2000);
  var sheet = ensureInstructionsTab(ss);
  var h = sheetHeaders(sheet);
  var col = function (n) { return h.indexOf(n); };
  var now = new Date();

  var last = sheet.getLastRow();
  if (last > 1) {
    var rows = sheet.getRange(2, 1, last - 1, h.length).getValues();
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i][col("job_id")]).trim() !== booking.bookingId) continue;
      if (String(rows[i][col("scope_type")]).toUpperCase() !== scopeType) continue;
      if (String(rows[i][col("scope_key")]).toUpperCase() !== scopeKey) continue;
      sheet.getRange(i + 2, col("instruction") + 1).setValue(text);
      sheet.getRange(i + 2, col("updated_at") + 1).setValue(now);
      return json({ ok: true, updated: true, scope_key: scopeKey });
    }
  }

  if (!text) return json({ ok: true, updated: false, scope_key: scopeKey });

  var row = new Array(h.length).fill("");
  row[col("instruction_id")] = "INS-" + Utilities.getUuid().slice(0, 8).toUpperCase();
  row[col("job_id")]      = booking.bookingId;
  row[col("scope_type")]  = scopeType;
  row[col("scope_key")]   = scopeKey;
  row[col("instruction")] = text;
  row[col("created_at")]  = now;
  row[col("updated_at")]  = now;
  row[col("source")]      = "portal";
  sheet.appendRow(row);
  return json({ ok: true, created: true, scope_key: scopeKey });
}


/* ============================================================
   THE VENDOR SIDE  —  companies, their services, their teams
   ============================================================
   Added r15.

   THESE TABS LIVE IN THE OPS WORKBOOK, NOT LEADS MASTER. Leads MASTER is the
   customer side; Ops is supply. The split means someone helping with customer
   support can be given Leads MASTER without ever seeing payout terms, and it
   matches where CLEANERS, SCHEDULE and AVAILABILITY already sit.

   The cost is one extra openById when a client ticket renders a vendor
   profile. webhook.gs already opens that workbook in three places for
   availability write-back, so this is a proven path rather than a new one.

   THE ASSIGNMENT IS TWO COLUMNS ON JOBS, not a fourth tab. JOBS is already one
   row per booking and getBooking already reads it; a join table would
   duplicate that for nothing. A dispatcher fills vendor_id and operator_id
   where they fill `cleaner` today. */

const VENDORS_TAB          = "VENDORS";
const VENDOR_SERVICES_TAB  = "VENDOR_SERVICES";
const OPERATORS_TAB        = "OPERATORS";
const VENDOR_REVIEWS_TAB   = "VENDOR_REVIEWS";
const VENDOR_PHOTOS_TAB    = "VENDOR_PHOTOS";

/** The Ops workbook. Never the active spreadsheet — this code runs bound to Leads. */
function opsBook() {
  /* r44. Opening a workbook is one of the slowest calls Apps Script makes,
     and a vendor portal used to make it three or four times. A handle is not
     a copy of any data, so one per request is safe for POSTs too. */
  if (!REQUEST_SCOPE) return SpreadsheetApp.openById(OPS_SPREADSHEET_ID);
  if (!REQUEST_SCOPE.ops) REQUEST_SCOPE.ops = SpreadsheetApp.openById(OPS_SPREADSHEET_ID);
  return REQUEST_SCOPE.ops;
}


/* ============================================================
   THE PARTNER SHARE  —  r24
   ============================================================

   What fraction of a booking goes to the partner company. 0.85 means the
   partner is paid 85% of the ticket and Serve keeps 15%.

   THERE ARE TWO OF THESE AS OF 2026-09-16 — `payout_rate` for an ordinary
   booking and `payout_rate_first_clean` for a half-price first clean, which is
   passed through at 0.98 because a 50% discount cannot be funded from a 15%
   margin. payoutRateFor() picks between them from the home itself. Everything
   below is true of both.

   ONE PLACE TO CHANGE IT, AND IT IS A SHEET CELL. `SETTINGS` in the Ops
   workbook, column A `key`, column B `value`, row `payout_rate`. Editing that
   cell changes the rate for every booking made afterwards, with no code change,
   no deploy, and no paste into the Apps Script editor. That is the whole design
   goal: the number lives where the founder already works, and a dashboard built
   over it later is a nicer front end onto the same cell rather than a new
   source of truth competing with this one.

   AND IT APPLIES TO FUTURE BOOKINGS ONLY. The rate in force is STAMPED onto
   each JOBS row when the booking is made, and every partner surface reads the
   stamped value rather than this function. Going from 15% to 20% tomorrow must
   not quietly reprice a job a partner already accepted at 85% — that is the
   same rule the signed quote enforces on the customer's side, for the same
   reason: a number somebody agreed to must not move under them afterwards.

   THE CELL IS NOT TRUSTED. A typo here pays a real company real money, and
   `85` typed where `0.85` was meant would be an 8500% payout. Anything outside
   (0, 1] is refused and the code default is used instead, loudly. A trailing
   "%" is accepted because somebody will eventually type it.

   Missing tab, missing row, empty cell, unreadable workbook — all fall back to
   DEFAULT_PAYOUT_RATE. A booking must never fail because a settings lookup did. */

const DEFAULT_PAYOUT_RATE = 0.85;

/* THE HALF-PRICE FIRST CLEAN PAYS A DIFFERENT SHARE — 2026-09-16.
   Ops SETTINGS key `payout_rate_first_clean`.

   THE ARITHMETIC THAT FORCES THIS. Serve's cut is 15% and the first-clean
   discount is 50%. A 50% discount therefore cannot be funded out of the
   margin: at the ordinary 0.85 the partner would be paid 85% of a HALVED
   ticket, which is 42.5% of the job's real price, for work the pricing model
   costs at 67% of it. The discount would be absorbed almost entirely by the
   company doing the cleaning, which is both unfair and unacceptable to them.

   At 0.98 the partner is paid nearly all of what Serve actually collects on
   that visit and Serve keeps 2%. Serve is close to break-even on the first
   clean by design — the recurring visits that follow it are where the 15%
   earns, and one of them repays the whole first-visit shortfall.

   THE 15% TICKETS DO NOT USE THIS. A move clean and a large heavy first clean
   are discounted 15%, not 50%, so the ordinary share already leaves the
   partner above cost. Only the half-price path is passed through — see
   payoutRateFor(). */
const DEFAULT_PAYOUT_RATE_FIRST_CLEAN = 0.98;

const SETTINGS_TAB = "SETTINGS";

/** Parsed once per execution, per key. Apps Script runs are short. */
var PAYOUT_RATE_CACHE = {};

function currentPayoutRate() {
  return cachedPayoutRate("payout_rate", DEFAULT_PAYOUT_RATE);
}

/** The share on a HALF-PRICE first clean. See DEFAULT_PAYOUT_RATE_FIRST_CLEAN. */
function currentPayoutRateFirstClean() {
  return cachedPayoutRate("payout_rate_first_clean", DEFAULT_PAYOUT_RATE_FIRST_CLEAN);
}

function cachedPayoutRate(key, fallback) {
  if (PAYOUT_RATE_CACHE[key] === undefined) {
    PAYOUT_RATE_CACHE[key] = readPayoutRate(key, fallback);
  }
  return PAYOUT_RATE_CACHE[key];
}

/**
 * WHICH SHARE THIS BOOKING PAYS, derived from the home — never read from the
 * payload.
 *
 * `payout_rate` has been assigned by doPost rather than accepted from the
 * browser since r24, for the obvious reason. The same has to be true of the
 * CHOICE between the two rates, so this re-derives the discount from the three
 * priced inputs instead of trusting the `discount_applied` string the site
 * sends for the sheet's benefit. A crafted payload claiming a half-price first
 * clean must not be able to talk Serve out of its margin.
 *
 * MIRRORS R5 IN pricing-engine.js, AND IS TESTED AGAINST IT. These are two
 * copies of one rule in two languages — Apps Script cannot import the engine —
 * so payout-discount-parity.test.js drives both over a grid of homes and fails
 * if they ever disagree. Change the rule in one place and that test goes red.
 */
function payoutRateFor(data) {
  var service   = String(data && data.service || data && data.service_type || "").trim();
  var condition = String(data && data.condition || "").trim().toLowerCase();
  var bedrooms  = Number(data && data.bedrooms);

  var isFirstClean = service === "first_clean";
  /* R5 — a 4BR+ heavy first clean takes the 15% instead of the half price,
     so it pays the ordinary share like any other 15% ticket. */
  var noStack = isFirstClean && isFinite(bedrooms) && bedrooms >= 4 && condition === "heavy";

  return (isFirstClean && !noStack)
    ? currentPayoutRateFirstClean()
    : currentPayoutRate();
}

function readPayoutRate(key, fallback) {
  try {
    var sheet = opsBook().getSheetByName(SETTINGS_TAB);
    if (!sheet || sheet.getLastRow() < 2) return fallback;

    var rows = sheet.getRange(1, 1, sheet.getLastRow(), 2).getValues();
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i][0] || "").trim().toLowerCase() !== key) continue;

      var raw = String(rows[i][1] === 0 ? "0" : (rows[i][1] || "")).trim();
      if (!raw) return fallback;

      var pct = /%\s*$/.test(raw);
      var n = Number(raw.replace(/%\s*$/, "").trim());
      if (pct) n = n / 100;

      if (!isFinite(n) || n <= 0 || n > 1) {
        /* Loud, because the site keeps working and nothing else would say so.
           Never clamp into range: "85" is far more likely to be a typo for
           0.85 than an instruction to pay 8500%, and guessing which would be
           guessing with somebody's money. */
        console.error("SETTINGS " + key + " is not a fraction in (0,1]: " +
                      JSON.stringify(raw) + " — using " + fallback);
        return fallback;
      }
      return n;
    }
    return fallback;
  } catch (err) {
    console.error(key + " lookup failed, using default: " + err);
    return fallback;
  }
}

/**
 * What this partner is paid for this job.
 *
 * `partner_payout` WINS WHENEVER IT IS SET. It is the operator's override for
 * the job that does not fit the rule — a difficult home, an apology, a bonus —
 * and a derived number must never quietly replace a figure a human chose.
 *
 * Otherwise it is the stamped rate times the ticket, using the same
 * `final || quoted` the customer's own price uses, so the two sides of the job
 * always describe the same booking. No stamped rate and no override means a
 * booking older than r24, and the honest answer there is nothing at all.
 */
function partnerPayoutFor(booking) {
  if (booking.partnerPayout !== "" && booking.partnerPayout != null) {
    return booking.partnerPayout;
  }
  var rate  = Number(booking.payoutRate);
  var total = Number(booking.price && (booking.price.final || booking.price.quoted));
  if (!isFinite(rate) || rate <= 0 || rate > 1) return "";
  if (!isFinite(total) || total <= 0) return "";
  return Math.round(total * rate * 100) / 100;
}

/**
 * WHAT A VENDOR MAY EDIT ABOUT THEMSELVES. Everything else on the row is
 * Serve's.
 *
 * A WHITELIST, NOT A DENYLIST, and that direction is the whole point. A column
 * added to VENDORS next month — a payout rate, a dispatch score, a strike
 * count — is not editable by a vendor unless somebody adds it here on purpose.
 * The reverse fails open, and it fails open into the one place it must not:
 * a partner rewriting what Serve says about them.
 */
var VENDOR_EDITABLE = ["display_name", "public_description", "service_area", "capabilities"];

/**
 * Serve-controlled, listed so the reason is written down rather than implied:
 *   status, client_visible      whether they are live at all
 *   legal_name, partner_since   facts of the relationship
 *   insurance_verified          a claim only Serve can make
 *   public_rating, review_count, rating_source, serve_*   earned, not set
 *   logo_url                    Serve places the file (see SCHEMA.md)
 *   internal_*, default_payout_rate   never leave the business
 */
var OPERATOR_EDITABLE = ["public_display_name", "first_name", "last_initial",
                         "photo_url", "role", "years_experience", "specialties",
                         "active", "show_to_customer"];

/** One row from a tab in the Ops workbook, as an object keyed by header. */
function opsRow(sheetName, idColumn, wantedId) {
  var want = String(wantedId || "").trim();
  if (!want) return null;
  var table = readTable(opsBook(), sheetName);
  if (!table) return null;
  var h = table.headers;
  var i = h.indexOf(idColumn);
  if (i === -1 || !table.rows.length) return null;
  var rows = table.rows;
  for (var r = 0; r < rows.length; r++) {
    if (String(rows[r][i]).trim() !== want) continue;
    var o = { __row: r + 2, __headers: h };
    h.forEach(function (n, idx) { o[n] = rows[r][idx]; });
    return o;
  }
  return null;
}

/** Every row of a tab whose `idColumn` matches. */
function opsRows(sheetName, idColumn, wantedId) {
  var want = String(wantedId || "").trim();
  var out = [];
  if (!want) return out;
  var table = readTable(opsBook(), sheetName);
  if (!table) return out;
  var h = table.headers;
  var i = h.indexOf(idColumn);
  if (i === -1 || !table.rows.length) return out;
  var rows = table.rows;
  for (var r = 0; r < rows.length; r++) {
    if (String(rows[r][i]).trim() !== want) continue;
    var o = { __row: r + 2 };
    h.forEach(function (n, idx) { o[n] = rows[r][idx]; });
    out.push(o);
  }
  return out;
}

var truthy = function (v) { return v === true || String(v).toUpperCase() === "TRUE"; };

/**
 * One vendor company.
 *
 * `ss` is accepted and ignored so the signature matches the r13 version that
 * read Leads MASTER — every caller kept working when the tab moved.
 */
function getVendor(ss, vendorId) {
  var v = opsRow(VENDORS_TAB, "vendor_id", vendorId);
  if (!v) return null;
  return {
    vendorId:          String(v.vendor_id || ""),
    status:            String(v.status || ""),
    legalName:         String(v.legal_name || ""),
    displayName:       String(v.display_name || ""),
    internalContact:   String(v.internal_contact_name || ""),
    internalPhone:     String(v.internal_phone || ""),
    internalEmail:     String(v.internal_email || ""),
    logoUrl:           String(v.logo_url || ""),
    publicDescription: String(v.public_description || ""),
    /* r34: an operator who formats this column as a date turns the cell into a
       Date, and String()ing one put "Wed Jul 01 2026 00:00:00 GMT-0400 (Eastern
       Daylight Time)" on every customer's partner card. Same fault r23 fixed on
       JOBS and r32 fixed the reading of — this is the OPS workbook, which
       neither release reached. Normalised to YYYY-MM-DD here, through that
       workbook's own timezone; how to say it is the card's business, not this
       whitelist's. A value that is not a date (often just "2024") is untouched. */
    partnerSince:      isDateValue(v.partner_since)
                         ? dateCellText(v.partner_since, sheetTimeZone(opsBook()))
                         : String(v.partner_since || ""),
    insuranceVerified: truthy(v.insurance_verified),
    serviceArea:       String(v.service_area || ""),
    /* Not a service code. "Luxury", "pet-safe", "post-construction" describe
       what a company is good at; the three SERVICE_CODES are what a customer
       can actually book and what the calculator prices. Mixing them would put
       something unbookable in the service catalogue. */
    capabilities:      String(v.capabilities || ""),
    publicRating:      v.public_rating === "" || v.public_rating === undefined
                         ? null : Number(v.public_rating),
    publicReviewCount: v.public_review_count === "" || v.public_review_count === undefined
                         ? null : Number(v.public_review_count),
    ratingSource:      String(v.rating_source || ""),
    clientVisible:     truthy(v.client_visible),
  };
}

/** What this vendor offers, against Serve's own three codes. */
function getVendorServices(vendorId) {
  return opsRows(VENDOR_SERVICES_TAB, "vendor_id", vendorId)
    .filter(function (r) { return SERVICE_CODES[String(r.service_code || "").toUpperCase()]; })
    .map(function (r) {
      var code = String(r.service_code).toUpperCase();
      return {
        serviceCode: code,
        serviceLabel: SERVICE_CODES[code],
        offers:      truthy(r.offers),
        preference:  String(r.preference || "neutral").toLowerCase(),
        active:      truthy(r.active),
      };
    });
}


/* ------------------------------------------------------------------
   What other people have said, and what the work looks like.  r35

   Both are Serve's, not the vendor's: no write path names these tabs, so a
   partner cannot add a review of themselves. Read through the client
   whitelist, capped, and dropped entirely rather than half-shown when a cell
   is not what it claims to be.
   ------------------------------------------------------------------ */

var MAX_CLIENT_REVIEWS = 3;
var MAX_CLIENT_PHOTOS  = 6;

/* Execution-scoped. The portal builds a card per booking and several bookings
   share a vendor; without this each one re-reads both tabs. */
var vendorExtrasMemo = {};

/** A link a customer's browser may follow. http(s) only — see r35. */
function webUrl(v) {
  var s = String(v || "").trim();
  return /^https?:\/\//i.test(s) ? s : "";
}

/** An image this site actually serves. Same-origin /images/ only — see r35. */
function siteImage(v) {
  var s = String(v || "").trim();
  if (s.indexOf("..") !== -1) return "";
  return /^\/images\/[A-Za-z0-9._\/-]+$/.test(s) ? s : "";
}

/** A positive number, or null. Zero is "no rating", not zero stars. */
function ratingOrNull(v) {
  if (v === "" || v === null || v === undefined) return null;
  var n = Number(v);
  return isNaN(n) || n <= 0 ? null : n;
}

/**
 * Quotations a customer may see, newest first as the sheet orders them.
 *
 * BUILT UP, NOT FILTERED DOWN, like every other client whitelist here: a column
 * added to VENDOR_REVIEWS later cannot reach a browser until somebody names it.
 */
function clientVendorReviews(vendorId) {
  var key = "rev:" + String(vendorId || "");
  if (vendorExtrasMemo[key] !== undefined) return vendorExtrasMemo[key];
  var out = [];
  try {
    var tz = sheetTimeZone(opsBook());
    out = opsRows(VENDOR_REVIEWS_TAB, "vendor_id", vendorId)
      .filter(function (r) { return truthy(r.client_visible); })
      .filter(function (r) { return String(r.quote || "").trim() !== ""; })
      .slice(0, MAX_CLIENT_REVIEWS)
      .map(function (r) {
        return {
          quote:      String(r.quote || "").trim(),
          author:     String(r.author || "").trim(),
          source:     String(r.source || "").trim(),
          sourceUrl:  webUrl(r.source_url),
          rating:     ratingOrNull(r.rating),
          reviewedOn: isDateValue(r.reviewed_on)
                        ? dateCellText(r.reviewed_on, tz)
                        : String(r.reviewed_on || "").trim(),
        };
      });
  } catch (err) {
    console.error("vendor reviews unavailable: " + err);
    out = [];
  }
  vendorExtrasMemo[key] = out;
  return out;
}

/** Photographs of this company's own work, in the order an operator chose. */
function clientVendorPhotos(vendorId) {
  var key = "pic:" + String(vendorId || "");
  if (vendorExtrasMemo[key] !== undefined) return vendorExtrasMemo[key];
  var out = [];
  try {
    out = opsRows(VENDOR_PHOTOS_TAB, "vendor_id", vendorId)
      .filter(function (r) { return truthy(r.client_visible); })
      .map(function (r) {
        return {
          url:     siteImage(r.image_url),
          caption: String(r.caption || "").trim(),
          sort:    Number(r.sort) || 0,
        };
      })
      .filter(function (p) { return p.url !== ""; })
      .sort(function (a, z) { return a.sort - z.sort; })
      .slice(0, MAX_CLIENT_PHOTOS);
  } catch (err) {
    console.error("vendor photos unavailable: " + err);
    out = [];
  }
  vendorExtrasMemo[key] = out;
  return out;
}
/** The vendor's team. Serve-controlled numbers ride along for their own view. */
function getOperators(vendorId) {
  return opsRows(OPERATORS_TAB, "vendor_id", vendorId).map(function (r) {
    return {
      operatorId:      String(r.operator_id || ""),
      publicName:      String(r.public_display_name || ""),
      firstName:       String(r.first_name || ""),
      lastInitial:     String(r.last_initial || ""),
      photoUrl:        String(r.photo_url || ""),
      role:            String(r.role || ""),
      yearsExperience: String(r.years_experience || ""),
      specialties:     String(r.specialties || ""),
      active:          truthy(r.active),
      showToCustomer:  truthy(r.show_to_customer),
      serveRating:     r.serve_rating === "" || r.serve_rating === undefined
                         ? null : Number(r.serve_rating),
      serveJobs:       r.serve_jobs_completed === "" || r.serve_jobs_completed === undefined
                         ? null : Number(r.serve_jobs_completed),
    };
  });
}

function getOperator(ss, operatorId) {
  var o = opsRow(OPERATORS_TAB, "operator_id", operatorId);
  if (!o) return null;
  return {
    operatorId:     String(o.operator_id || ""),
    vendorId:       String(o.vendor_id || ""),
    publicName:     String(o.public_display_name || ""),
    role:           String(o.role || ""),
    active:         truthy(o.active),
    showToCustomer: truthy(o.show_to_customer),
  };
}

/** Every booking assigned to this vendor, newest first. */
function getVendorBookings(ss, vendorId) {
  var want = String(vendorId || "").trim();
  if (!want) return [];
  var jobs = requireTable(ss, JOBS_TAB);
  var h = jobs.headers;
  var vi = h.indexOf("vendor_id");
  var idc = h.indexOf("job_id");
  /* No column means no assignments have ever been recorded — an empty list,
     not an error. The portal says so rather than looking broken. */
  if (vi === -1 || idc === -1) return [];

  /* r44. From the row in hand — see getContactBookings. */
  var rows = jobs.rows;
  var tz = sheetTimeZone(ss);
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][vi]).trim() !== want) continue;
    out.push(bookingFromRow(h, rows[i], tz));
  }
  out.sort(function (a, z) {
    var av = a.scheduledDate || "9999-99-99";
    var zv = z.scheduledDate || "9999-99-99";
    return av < zv ? 1 : av > zv ? -1 : 0;
  });
  return out;
}


/**
 * The vendor portal's token. A fourth audience, a fourth scope, one secret.
 *
 * Client ticket, partner ticket, customer portal, vendor portal — four scopes
 * inside the same HMAC. None of them opens another.
 */
function vendorToken(vendorId) {
  var raw = Utilities.computeHmacSha256Signature(String(vendorId) + "|vendor", ticketSecret());
  var hex = raw.map(function (b) {
    return ("0" + (b < 0 ? b + 256 : b).toString(16)).slice(-2);
  }).join("");
  return hex.slice(0, 20);
}

/** The one link a partner company keeps. */
function vendorUrl(vendorId) {
  return "https://servecleaning.com/v?id=" + encodeURIComponent(vendorId) +
         "&t=" + vendorToken(vendorId);
}

/**
 * THE VENDOR PORTAL VIEW MODEL.
 *
 * A vendor sees their own company, their own team, and their own jobs. Never
 * another vendor's anything, and never a customer's price — `payout` is what
 * this company is paid, and the retail price stays in the client view where it
 * belongs.
 *
 * `serveControlled` is sent so the page can render those fields as facts
 * rather than as inputs. It is a courtesy to the UI, not a security control —
 * the write path has its own whitelist and does not trust this.
 */
function buildVendorPortalModel(ss, vendor) {
  var bookings = getVendorBookings(ss, vendor.vendorId);
  var offered = {};
  getVendorServices(vendor.vendorId).forEach(function (s) { offered[s.serviceCode] = s; });
  var photoRows = completionPhotoRows(ss);
  var noteRows = partnerNoteRows(ss);

  return {
    ok: true,
    view: "vendor",
    vendorId: vendor.vendorId,

    company: {
      displayName:       vendor.displayName,
      legalName:         vendor.legalName,
      publicDescription: vendor.publicDescription,
      serviceArea:       vendor.serviceArea,
      capabilities:      vendor.capabilities,
      logoUrl:           vendor.logoUrl,
      /* Shown, never editable here. Each is either a fact of the relationship
         or something earned. */
      status:            vendor.status,
      partnerSince:      vendor.partnerSince,
      insuranceVerified: vendor.insuranceVerified,
      publicRating:      vendor.publicRating,
      publicReviewCount: vendor.publicReviewCount,
      clientVisible:     vendor.clientVisible,
    },
    editableFields: VENDOR_EDITABLE,

    /* Every Serve service, with this vendor's answer against it — so the form
       shows all three rather than only the rows that happen to exist. */
    services: Object.keys(SERVICE_CODES).map(function (code) {
      var s = offered[code];
      return {
        serviceCode:  code,
        serviceLabel: SERVICE_CODES[code],
        offers:       s ? s.offers : false,
        preference:   s ? s.preference : "neutral",
        active:       s ? s.active : false,
      };
    }),

    team: getOperators(vendor.vendorId).map(function (o) {
      return {
        operatorId: o.operatorId,
        publicName: o.publicName,
        firstName:  o.firstName,
        lastInitial: o.lastInitial,
        photoUrl:   o.photoUrl,
        role:       o.role,
        yearsExperience: o.yearsExperience,
        specialties: o.specialties,
        active:     o.active,
        showToCustomer: o.showToCustomer,
        /* Serve's numbers about this person. Read-only, and a vendor sees
           their own team's — nobody else's. */
        serveRating: o.serveRating,
        serveJobs:   o.serveJobs,
      };
    }),
    /* The customer never sees a named individual, by decision. The roster is
       for the vendor and for dispatch. show_to_customer exists on the row and
       is deliberately not read by any client view model. */
    teamNote: "Your team is used for scheduling and appears on job tickets. " +
              "Serve introduces your company to customers, not individuals.",

    bookings: bookings.map(function (b) {
      return {
        bookingId:    b.bookingId,
        serviceCode:  b.serviceCode,
        serviceLabel: SERVICE_CODES[b.serviceCode] || b.serviceLabel,
        condition:    b.condition,
        date:         b.scheduledDate,
        time:         b.startTime,
        when:         b.scheduleSummary,
        status:       b.status,
        completed:    b.completedDate,
        /* Their payout. NOT b.price — what Serve charges is not a partner's
           business, and the margin is the model. r24 derives it from the share
           stamped on the booking when no operator figure is set. */
        payout:       partnerPayoutFor(b),
        home:         [b.beds === 0 ? "Studio" : b.beds + " BR",
                       b.baths + " BA"].filter(Boolean).join(" / "),
        /* Address only. No customer name, email or phone — contact routes
           through Serve. */
        address:      [b.address, b.unit].filter(Boolean).join(", "),
        zip:          b.zip,
        ticketUrl:    ticketUrl(b.bookingId, "partner"),
        /* r48. What this company's cleaner left on the ticket: rooms with a
           photo or a note, and only this company's. */
        report:       vendorJobReport(b, vendor.vendorId, photoRows, noteRows),
      };
    }),
  };
}

/** Rooms with a cleaner photo or note on this job, from this company only. */
function vendorJobReport(booking, vendorId, photoRows, noteRows) {
  return deriveRooms(booking.beds, booking.baths).map(function (r) {
    return {
      key: r.key,
      label: r.label,
      note: partnerNoteFor(noteRows, booking.bookingId, vendorId, r.key),
      photos: photoRows.filter(function (p) {
        return p.job_id === booking.bookingId && p.vendor_id === vendorId &&
               p.room_key === r.key && p.status === "READY";
      }).map(completionPhotoPublic),
    };
  }).filter(function (r) { return r.note || r.photos.length; });
}

/** GET the vendor portal. */
function handleVendorPortal(p) {
  var vendorId = String(p.vendor || "").trim();
  if (!vendorId || vendorToken(vendorId) !== String(p.t || "").trim()) {
    return json({ ok: false, error: "not_found" });
  }
  try {
    var ss = SPREADSHEET_ID ? SpreadsheetApp.openById(SPREADSHEET_ID)
                            : SpreadsheetApp.getActiveSpreadsheet();
    var vendor = getVendor(ss, vendorId);
    /* Refused identically to a bad token — confirming an id exists is still
       telling a caller something. */
    if (!vendor) return json({ ok: false, error: "not_found" });
    return json(buildVendorPortalModel(ss, vendor));
  } catch (err) {
    console.error("handleVendorPortal failed: " + (err && err.stack ? err.stack : err));
    return json({ ok: false, error: "lookup_failed" });
  }
}

/**
 * POST from the vendor portal: profile, one service, or one team member.
 *
 * EVERY WRITE IS WHITELISTED BY FIELD NAME. A vendor may describe themselves;
 * they may not promote themselves. Rating, review count, insurance verified,
 * partner_since, client_visible, status, the logo and anything internal are
 * Serve's, and a field arriving in the payload that is not on the list is
 * dropped rather than written.
 *
 * Never throws. A profile edit that fails must say so, not 500.
 */
function handleVendorWrite(data) {
  var vendorId = String(data.vendor_id || "").trim();
  if (!vendorId || vendorToken(vendorId) !== String(data.t || "").trim()) {
    return json({ ok: false, error: "not_found" });
  }

  try {
    var vendor = opsRow(VENDORS_TAB, "vendor_id", vendorId);
    if (!vendor) return json({ ok: false, error: "not_found" });

    var kind = String(data.kind || "").toLowerCase();
    if (kind === "profile") return writeVendorProfile(vendorId, vendor, data);
    if (kind === "service") return writeVendorService(vendorId, data);
    if (kind === "operator") return writeOperator(vendorId, data);
    return json({ ok: false, error: "unknown_kind" });

  } catch (err) {
    console.error("handleVendorWrite failed: " + (err && err.stack ? err.stack : err));
    return json({ ok: false, error: "save_failed" });
  } finally {
    /* r49. After the write, so a card rebuilt from here on reads the new row.
       Any kind, not only profile: forgetting costs one rebuild. */
    forgetPartnerCard(vendorId);
  }
}

function writeVendorProfile(vendorId, row, data) {
  var field = String(data.field || "").toLowerCase();
  if (VENDOR_EDITABLE.indexOf(field) === -1) {
    return json({ ok: false, error: "not_editable", field: field });
  }
  var sheet = opsBook().getSheetByName(VENDORS_TAB);
  var h = sheetHeaders(sheet);
  var c = h.indexOf(field);
  if (c === -1) return json({ ok: false, error: "no_column", field: field });

  sheet.getRange(row.__row, c + 1).setValue(String(data.value || "").trim().slice(0, 1000));
  var u = h.indexOf("updated_at");
  if (u !== -1) sheet.getRange(row.__row, u + 1).setValue(new Date());
  return json({ ok: true, field: field });
}

function writeVendorService(vendorId, data) {
  var code = String(data.service_code || "").toUpperCase();
  /* Only Serve's own codes. A vendor cannot invent a service the calculator
     has no price for and the booking flow has no path to. */
  if (!SERVICE_CODES[code]) return json({ ok: false, error: "unknown_service" });

  var pref = String(data.preference || "neutral").toLowerCase();
  if (["preferred", "neutral", "avoid"].indexOf(pref) === -1) pref = "neutral";

  var sheet = opsBook().getSheetByName(VENDOR_SERVICES_TAB);
  if (!sheet) return json({ ok: false, error: "no_tab" });
  var h = sheetHeaders(sheet);
  var col = function (n) { return h.indexOf(n); };
  var last = sheet.getLastRow();

  if (last > 1) {
    var rows = sheet.getRange(2, 1, last - 1, h.length).getValues();
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i][col("vendor_id")]).trim() !== vendorId) continue;
      if (String(rows[i][col("service_code")]).toUpperCase() !== code) continue;
      sheet.getRange(i + 2, col("offers") + 1).setValue(!!data.offers);
      sheet.getRange(i + 2, col("preference") + 1).setValue(pref);
      if (col("active") !== -1) sheet.getRange(i + 2, col("active") + 1).setValue(!!data.offers);
      return json({ ok: true, updated: true, service_code: code });
    }
  }

  var row = new Array(h.length).fill("");
  row[col("vendor_id")]    = vendorId;
  row[col("service_code")] = code;
  row[col("offers")]       = !!data.offers;
  row[col("preference")]   = pref;
  if (col("active") !== -1) row[col("active")] = !!data.offers;
  sheet.appendRow(row);
  return json({ ok: true, created: true, service_code: code });
}

function writeOperator(vendorId, data) {
  var sheet = opsBook().getSheetByName(OPERATORS_TAB);
  if (!sheet) return json({ ok: false, error: "no_tab" });
  var h = sheetHeaders(sheet);
  var col = function (n) { return h.indexOf(n); };

  var operatorId = String(data.operator_id || "").trim();
  var rowIndex = -1;
  var last = sheet.getLastRow();

  if (operatorId && last > 1) {
    var rows = sheet.getRange(2, 1, last - 1, h.length).getValues();
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i][col("operator_id")]).trim() !== operatorId) continue;
      /* THE OWNERSHIP CHECK. A vendor token authorises that company's team,
         not the roster. Without it a valid token could rewrite a competitor's
         people. */
      if (String(rows[i][col("vendor_id")]).trim() !== vendorId) {
        return json({ ok: false, error: "not_found" });
      }
      rowIndex = i + 2;
      break;
    }
    if (rowIndex === -1) return json({ ok: false, error: "not_found" });
  }

  if (rowIndex === -1) {
    var existing = last > 1 ? sheet.getRange(2, col("operator_id") + 1, last - 1, 1).getValues() : [];
    var fresh = new Array(h.length).fill("");
    fresh[col("operator_id")] = nextSeqId(existing.map(function (r) { return r; }),
                                          0, "OPR");
    fresh[col("vendor_id")] = vendorId;
    sheet.appendRow(fresh);
    rowIndex = sheet.getLastRow();
  }

  var written = [];
  OPERATOR_EDITABLE.forEach(function (f) {
    if (!(f in data)) return;
    var c = col(f);
    if (c === -1) return;
    var v = data[f];
    if (f === "active" || f === "show_to_customer") v = !!v;
    else v = String(v || "").trim().slice(0, 300);
    sheet.getRange(rowIndex, c + 1).setValue(v);
    written.push(f);
  });

  return json({ ok: true, operator_row: rowIndex, fields: written });
}


/* ============================================================
   JOB TICKET — one row, two audiences
   ============================================================

   servecleaning.com/j?id=SRV-…&t=…&view=client|partner

   THE TOKEN IS THE WHOLE SECURITY MODEL, because the URL carries a home
   address, when the house is empty, and how to get in. job_id is not a secret:
   it is `SRV-` + a fully known date + six characters, it appears in every
   notification email, and one leaked id exposes the pattern.

   So the token is an HMAC under a secret that never leaves this script. It
   cannot be derived from the id, it is stable for a given job, and it needs no
   new column — nothing to add by hand, nothing to keep in sync.

   THE TOKEN IS SCOPED TO THE VIEW, as of r13. It was an HMAC of the job_id
   alone, which meant ONE token opened both views and `&view=` merely chose
   which. A partner holding their own link could flip it to `view=client` and
   read the customer's name, the price they paid and their private notes; a
   customer could flip the other way into the crew's access notes. The price
   leak is the serious one — what Serve charges versus what a partner is paid
   is the entire model. Two audiences means two secrets, so the view is now
   inside the HMAC and a partner link is not a client link.

   WHAT EACH VIEW MAY SEE is decided by the view models above, on the server.
   Filtering in the browser would mean shipping both and trusting the page.

   DOOR CODES ARE NOT HERE AND MUST NOT BE ADDED. They live in a separate
   Access MASTER file, owner-only, and reach the cleaner by direct message at
   dispatch. Putting one behind a URL token undoes the entire point of that
   separation. */

/**
 * "Do we already know this home?" — asked by the Worker before it spends
 * anything on a property-data provider.
 *
 * This is the cheap half of /api/property, and it gets better as the business
 * grows: a repeat customer, or any address quoted before, answers from our own
 * record for free. The provider is only ever the fallback.
 *
 * RETURNS NOTHING IDENTIFYING. Beds, baths, levels — the specs needed to fill a
 * quote form. No name, no contact, no access notes. The key is guessable by
 * anyone who knows an address, so this must stay a specs lookup and must never
 * become a way to ask "who lives at this address."
 *
 * `key` is ZIP-ADDRESS-UNIT, normalised identically on both sides. If the two
 * normalisations ever drift, every repeat address silently starts billing
 * again — which is the kind of failure that shows up on an invoice rather than
 * in a log.
 */
function handleKnownProperty(key) {
  try {
    var want = String(key || "").trim().toUpperCase();
    if (!want) return json({ found: false });

    var ss = SPREADSHEET_ID ? SpreadsheetApp.openById(SPREADSHEET_ID)
                            : SpreadsheetApp.getActiveSpreadsheet();
    var tab = readTable(ss, PROPERTIES_TAB);
    if (!tab) return json({ found: false });

    var h = tab.headers;
    var iKey = h.indexOf("property_key");
    if (iKey === -1 || !tab.rows.length) return json({ found: false });

    var rows = tab.rows;
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i][iKey]).trim().toUpperCase() !== want) continue;

      var get = function (name) {
        var c = h.indexOf(name);
        return c === -1 ? null : rows[i][c];
      };
      var num = function (v) {
        var n = Number(v);
        return isFinite(n) && n > 0 ? n : null;
      };
      return json({
        found:  true,
        beds:   num(get("beds")),
        baths:  num(get("baths")),
        levels: num(get("levels")),
        sqft:   num(get("sqft")),
        type:   get("property_type") || null,
      });
    }
    return json({ found: false });

  } catch (err) {
    /* A miss and a failure are the same thing to the caller: fall through to
       the provider. Never let this break a quote. */
    console.error("handleKnownProperty failed: " + err);
    return json({ found: false });
  }
}

const TICKET_SECRET_KEY = "TICKET_SECRET";

/**
 * Self-provisioning so there is no setup step to forget. First call mints a
 * secret and stores it; every later call reads the same one, which is what
 * makes a token stable for the life of a job.
 */
function ticketSecret() {
  /* r44. The vendor portal signs a ticket link per booking, and each one used
     to read the property again. */
  if (REQUEST_SCOPE && REQUEST_SCOPE.secret) return REQUEST_SCOPE.secret;
  var props = PropertiesService.getScriptProperties();
  var s = props.getProperty(TICKET_SECRET_KEY);
  if (!s) {
    s = Utilities.getUuid() + "-" + Utilities.getUuid();
    props.setProperty(TICKET_SECRET_KEY, s);
    console.log("Minted a ticket secret. Existing ticket links are unaffected " +
                "because there were none.");
  }
  if (REQUEST_SCOPE) REQUEST_SCOPE.secret = s;
  return s;
}

/** Stable per job, underivable from the id. 20 hex chars ~ 80 bits. */
/**
 * One token per (job, audience).
 *
 * THE VIEW IS INSIDE THE HMAC, and that is the whole point. Signing the job_id
 * alone produced a single token for both audiences with `&view=` choosing
 * between them — so anyone holding either link held both. A partner could read
 * the customer's price; a customer could read the crew's notes. Two audiences,
 * two secrets.
 */
function ticketToken(jobId, view) {
  var scope = String(jobId) + "|" + (view === "partner" ? "partner" : "client");
  var raw = Utilities.computeHmacSha256Signature(scope, ticketSecret());
  var hex = raw.map(function (b) {
    return ("0" + (b < 0 ? b + 256 : b).toString(16)).slice(-2);
  }).join("");
  return hex.slice(0, 20);
}

/** The link to hand a customer or a cleaner. Different links, necessarily. */
function ticketUrl(jobId, view) {
  var v = view === "partner" ? "partner" : "client";
  return "https://servecleaning.com/j?id=" + encodeURIComponent(jobId) +
         "&t=" + ticketToken(jobId, v) +
         "&view=" + v;
}

function handleTicket(p) {
  var jobId = String(p.job || "").trim();
  var view  = p.view === "partner" ? "partner" : "client";

  /* Compared as whole strings, and against a token scoped to THIS view. A
     wrong token is refused before any lookup, so a guessed id cannot even
     confirm a job exists — and a partner's link is not a client's. */
  if (ticketToken(jobId, view) !== String(p.t || "").trim()) {
    return json({ ok: false, error: "not_found" });
  }

  try {
    var ss = SPREADSHEET_ID ? SpreadsheetApp.openById(SPREADSHEET_ID)
                            : SpreadsheetApp.getActiveSpreadsheet();

    var booking = getBooking(ss, jobId);
    if (!booking) return json({ ok: false, error: "not_found" });

    /* The partner view is for doing the job, so it stops being useful once the
       job is done. The client view is their record — the photos and the price
       live there — so it persists. */
    if (view === "partner" && booking.completedDate) {
      return json({ ok: false, error: "expired", note: "this job is complete" });
    }

    return json(view === "partner"
      ? buildVendorTicketModel(ss, booking)
      : buildClientTicketModel(ss, booking));

  } catch (err) {
    console.error("handleTicket failed: " + (err && err.stack ? err.stack : err));
    return json({ ok: false, error: "lookup_failed" });
  }
}


/* ============================================================
   4. IDENTITY
   ============================================================ */

/** One id per person: normalized email, else the property key. */
function resolveLeadId(data) {
  const email = normalizeEmail(data.email);
  if (email) return email;
  const key = propertyKey(data);
  return key || "";
}

function normalizeEmail(v) {
  return isSet(v) ? String(v).trim().toLowerCase() : "";
}

/** Stable per submission — a retry that slips past dedupe produces the same id. */
function makeJobId(data, sched) {
  const day = isSet(sched.date)
    ? String(sched.date).replace(/-/g, "")
    // BUSINESS_TZ, not the script project's timezone — otherwise an undated
    // booking gets a job_id stamped in one zone and a received_at in another,
    // and the two columns disagree about what day it was.
    : Utilities.formatDate(new Date(), BUSINESS_TZ, "yyyyMMdd");
  let tail = String(data.submission_id || "").replace(/[^A-Za-z0-9]/g, "").slice(-6).toUpperCase();
  if (!tail) tail = String(Math.floor(Math.random() * 1000000));
  return "SRV-" + day + "-" + tail;
}

/* ============================================================
   PROPERTY IDENTITY

   The old key was [zip, address, unit] upper-cased with punctuation collapsed,
   and its comment claimed "the same home always produces the same key". It did
   not. One apartment at 15 Buswell St became THREE property records:

     02118-15-BUSWELL-ST-UNIT-0006     ("unit 0006", and a typo'd ZIP)
     02215-15-BUSWELL-ST-6             ("6")
     02215-15-BUSWELL-ST-0006          ("0006")

   Two causes, neither of them exotic:
     - unit strings were never normalised, so "unit 0006" and "6" differed
     - Sheets strips leading zeros from anything that looks numeric, so the
       same unit round-tripped as "0006" one time and "6" the next

   ZIP STAYS IN THE KEY. Dropping it was considered and rejected: Greater
   Boston recycles street names across the towns we serve, so "15 Main St #2"
   without a ZIP would merge two different homes — and showing one customer
   another's access notes is far worse than a typo forking a record, which is
   at least visible and fixable.

   The real fix is that MATCHING no longer uses this string at all — see
   upsertProperty(), which compares normalised fields. The key is now a
   human-readable label, so its format can change again without breaking
   anything that already exists.
   ============================================================ */

/** 5 digits, leading zeros restored. Survives Sheets' numeric coercion. */
function zipN(z) {
  const d = String(z == null ? "" : z).replace(/[^0-9]/g, "");
  return d ? ("00000" + d).slice(-5) : "";
}

/** Upper-cased, punctuation collapsed to single dashes. */
function addrN(a) {
  return String(a == null ? "" : a).toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * The one that was missing. Drops the words people put in front of a unit
 * number, strips separators, then removes leading zeros — but only when digits
 * follow, so "4B" survives and a unit genuinely called "0" survives too.
 *   "unit 0006" -> "6"     "Apt 3131" -> "3131"     "4B" -> "4B"
 */
function unitN(u) {
  return String(u == null ? "" : u).toUpperCase()
    .replace(/\b(UNIT|APT|APARTMENT|NO|NUM)\b\.?/g, " ")
    .replace(/[^A-Z0-9]+/g, "")
    .replace(/^0+(?=\d)/, "");
}

/** A human-readable label. NOT the match key — see upsertProperty(). */
function propertyKey(data) {
  return [zipN(data.zip), addrN(data.address), unitN(data.unit)]
    .filter(function (v) { return v !== ""; })
    .join("-");
}

/** True when two payloads describe the same home. This IS the match. */
function sameProperty(a, b) {
  return zipN(a.zip)      === zipN(b.zip)
      && addrN(a.address)  === addrN(b.address)
      && unitN(a.unit)     === unitN(b.unit);
}

/**
 * Next id in a PREFIX-nnnn series, scanned from a column. Ids are never reused
 * and never derived from input — that is the whole point of having them.
 */
function nextSeqId(values, colIndex, prefix) {
  let max = 0;
  for (let i = 0; i < values.length; i++) {
    const m = String(values[i][colIndex] || "").match(new RegExp("^" + prefix + "-(\\d+)$"));
    if (m) { const n = parseInt(m[1], 10); if (n > max) max = n; }
  }
  return prefix + "-" + ("0000" + (max + 1)).slice(-4);
}


/* ============================================================
   5. LEADS UPSERT
   One row per person. Header-driven, additive-only, never widens the tab.
   ============================================================ */

/**
 * ATOMICITY, for the record:
 *   The CREATE path is one appendRow — atomic, all or nothing.
 *   The MATCH path is several setValue calls and is NOT atomic. If it fails
 *   partway you get a valid row that is merely less complete: only blank cells
 *   are ever filled and source_history is only ever appended to, so a partial
 *   failure can never corrupt or contradict existing data. The JOBS row is
 *   written regardless, and the notification email flags the failure.
 */
function upsertLead(ss, data, leadId) {
  const sheet = ss.getSheetByName(LEADS_TAB);
  if (!sheet) throw new Error('Tab "' + LEADS_TAB + '" not found — cannot upsert the lead.');
  assertWritable(LEADS_TAB);

  /* r44. Headers and rows in one read, fresh — this function writes to the
     rows it matched. */
  const leadsNow = sheetValues(sheet);
  const headers = leadsNow.headers;
  if (!headers.length) throw new Error('Tab "' + LEADS_TAB + '" has no header row.');

  /* Which of the fields we care about actually exist on the tab. Keyed by
     payload key; the header may differ (address -> service_address). */
  const col = {};
  const missing = [];
  LEADS_FIELDS.concat([LEADS_FIRST_TOUCH, LEADS_LAST_TOUCH]).forEach(function (f) {
    const i = headers.indexOf(leadsHeaderFor(f));
    if (i === -1) missing.push(leadsHeaderFor(f)); else col[f] = i;
  });
  if (missing.length) console.log("LEADS has no column for: " + missing.join(", ") + " — skipped.");

  /* Match on lead_id, else on normalized email. */
  const matchCol = (col.lead_id !== undefined) ? col.lead_id
                 : (col.email   !== undefined) ? col.email : -1;
  if (matchCol === -1) {
    throw new Error('LEADS has neither a "lead_id" nor an "email" column — cannot match rows.');
  }
  const matchOnEmail = (col.lead_id === undefined);
  const needle = matchOnEmail ? normalizeEmail(data.email) : String(leadId).trim().toLowerCase();

  const existing = leadsNow.rows;

  let rowIndex = -1;
  if (isSet(needle)) {
    for (let i = 0; i < existing.length; i++) {
      if (String(existing[i][matchCol]).trim().toLowerCase() === needle) { rowIndex = i + 2; break; }
    }
  }

  const incomingTag = firstSet(data.src, data.src_first, "");
  const stamp = new Date();          // a real Date, never an ISO string

  /* A2P 10DLC consent — the record that proves a customer agreed to be texted.
     "yes" or "" — NEVER "no". Every write below is blank-fill-only, so a "no"
     recorded today would permanently block a genuine opt-in on a later booking.
     Blank already means "no consent on record", which is the same thing when a
     carrier asks, and it stays upgradeable.
     The timestamp is the SERVER clock, not a value from the payload: if consent
     is ever challenged, a time the browser supplied is not what you want to be
     standing on. It is a real Date for the same reason first_touch is. */
  const smsT = data.sms_transactional === "yes" ? "yes" : "";
  const smsP = data.sms_promotional   === "yes" ? "yes" : "";

  /* r9 — E.164, the format an inbound text actually arrives in. Stored so a
     reply can be resolved to a person without asking them who they are.
     US-only assumption: 10 digits gets +1, 11 starting with 1 gets a +.
     Anything else is left blank rather than guessed at — a wrong routing key
     fails silently, which is worse than an empty one. */
  const phoneE164 = toE164(data.phone);

  const incoming = {
    lead_id: leadId,
    name:    data.name  || "",
    email:   normalizeEmail(data.email),
    phone:   data.phone || "",
    phone_e164: phoneE164,
    address: data.address || "",     // -> service_address
    unit:    data.unit || "",
    zip:     data.zip  || "",
    source:  firstSet(data.src_first, data.src, ""),
    segment: data.segment || "",
    sms_transactional: smsT,
    sms_promotional:   smsP,
    sms_consent_at:    (smsT || smsP) ? stamp : "",
  };

  /* ---- No match: create. Both timestamps stamped once, here. ---- */
  if (rowIndex === -1) {
    const row = new Array(headers.length).fill("");
    const written = [];
    Object.keys(incoming).forEach(function (f) {
      if (col[f] !== undefined && isSet(incoming[f])) { row[col[f]] = incoming[f]; written.push(f); }
    });
    if (col.source_history !== undefined && isSet(incomingTag)) {
      row[col.source_history] = incomingTag;
      written.push("source_history");
    }
    [LEADS_FIRST_TOUCH, LEADS_LAST_TOUCH].forEach(function (f) {
      if (col[f] !== undefined) { row[col[f]] = stamp; written.push(f); }
    });
    let contactId = "";
    if (col.contact_id !== undefined) {
      contactId = nextSeqId(existing, col.contact_id, "CON");
      row[col.contact_id] = contactId;
      written.push("contact_id");
    }
    sheet.appendRow(row);
    return { ok: true, action: "created", lead_id: leadId, contact_id: contactId,
             row: sheet.getLastRow(), fields: written, missing: missing, headers: headers };
  }

  /* ---- Match: fill blanks, append history, bump last_touch ---- */
  const current = existing[rowIndex - 2];
  const filled = [];

  Object.keys(incoming).forEach(function (f) {
    if (col[f] === undefined) return;
    if (isSet(current[col[f]])) return;              // never overwrite a non-empty cell
    if (!isSet(incoming[f])) return;
    setLeadCell(sheet, rowIndex, col[f], f, incoming[f]);
    filled.push(f);
  });

  let historyAppended = false;
  if (col.source_history !== undefined && isSet(incomingTag)) {
    const raw  = String(current[col.source_history] || "");
    const tags = raw.split(",").map(function (t) { return t.trim(); }).filter(Boolean);
    if (tags.indexOf(incomingTag) === -1) {
      tags.push(incomingTag);
      setLeadCell(sheet, rowIndex, col.source_history, "source_history", tags.join(", "));
      historyAppended = true;
    }
  }

  /* last_touch is the ONE cell this script overwrites when already populated —
     that is the whole point of a "most recent activity" column. Everything else
     above is blank-fill-only.

     first_touch is deliberately absent from this block and always will be;
     setLeadCell() throws if anyone adds it. */
  let lastTouchBumped = false;
  if (col[LEADS_LAST_TOUCH] !== undefined) {
    warnIfTextDate(current[col[LEADS_LAST_TOUCH]], LEADS_LAST_TOUCH);
    setLeadCell(sheet, rowIndex, col[LEADS_LAST_TOUCH], LEADS_LAST_TOUCH, stamp);
    lastTouchBumped = true;
  }

  /* A row that predates contact_id gets one here, same self-backfilling
     behaviour as property_id. */
  let contactId = col.contact_id === undefined ? "" : String(current[col.contact_id] || "");
  if (col.contact_id !== undefined && !contactId) {
    contactId = nextSeqId(existing, col.contact_id, "CON");
    setLeadCell(sheet, rowIndex, col.contact_id, "contact_id", contactId);
    filled.push("contact_id");
  }

  return { ok: true, action: "matched", lead_id: leadId, contact_id: contactId, row: rowIndex,
           fields: filled, history_appended: historyAppended,
           last_touch_bumped: lastTouchBumped, missing: missing, headers: headers };
}

/**
 * Every write to an EXISTING LEADS row goes through here. Throws on any column
 * in LEADS_IMMUTABLE_ON_MATCH, so first_touch cannot be rewritten by a future
 * edit that forgets why it matters.
 */
function setLeadCell(sheet, rowIndex, colIndex, field, value) {
  if (LEADS_IMMUTABLE_ON_MATCH.indexOf(field) !== -1) {
    throw new Error('Refusing to modify "' + field + '" on an existing LEADS row — ' +
                    'it is stamped once at creation and immutable thereafter.');
  }
  sheet.getRange(rowIndex, colIndex + 1).setValue(value);
}

/** A date column holding text will not sort or do date math. Say so, once per write. */
function warnIfTextDate(currentValue, field) {
  if (typeof currentValue === "string" && currentValue.trim() !== "") {
    console.log('WARNING: LEADS "' + field + '" currently holds TEXT ("' + currentValue +
                '"). Writing a real datetime now — reformat the column to a date type ' +
                'so the whole column sorts consistently.');
  }
}


/* ============================================================
   5b. PROPERTIES UPSERT
   One row per address. Header-driven, blank-fill only, never widens the tab.
   ============================================================ */

/**
 * Create or complete the PROPERTIES row for this booking's address.
 *
 * Blank cells only, exactly like the LEADS upsert. An operator who has typed a
 * neighbourhood, a property type or a known issue must never have it replaced
 * by whatever a customer typed into a booking form.
 *
 * Never fatal. A booking is worth more than a property record, so a failure
 * here is reported in the notification and the JOBS row is written regardless.
 */
function upsertProperty(ss, data, propertyKey) {
  if (!isSet(propertyKey)) {
    return { ok: true, action: "skipped", reason: "no property_key (no address given)" };
  }

  const sheet = ss.getSheetByName(PROPERTIES_TAB);
  if (!sheet) throw new Error('Tab "' + PROPERTIES_TAB + '" not found.');
  assertPropertiesWritable(PROPERTIES_TAB);

  /* r44. One fresh read — see upsertLead. */
  const propertiesNow = sheetValues(sheet);
  const headers = propertiesNow.headers;
  if (!headers.length) throw new Error('Tab "' + PROPERTIES_TAB + '" has no header row.');

  const col = {}, missing = [];
  PROPERTIES_FIELDS.forEach(function (f) {
    const i = headers.indexOf(propertiesHeaderFor(f));
    if (i === -1) missing.push(propertiesHeaderFor(f)); else col[f] = i;
  });
  if (missing.length) console.log("PROPERTIES has no column for: " + missing.join(", ") + " — skipped.");

  if (col.property_key === undefined) {
    throw new Error('PROPERTIES has no "property_key" column — cannot label rows.');
  }

  const incoming = {
    property_key: propertyKey,
    address:      data.address || "",     // -> service_address
    unit:         data.unit || "",
    zip:          data.zip  || "",
    bedrooms:     valOrBlank(data.bedrooms),
    bathrooms:    valOrBlank(data.bathrooms),
  };

  const existing = propertiesNow.rows;

  const idCol   = headers.indexOf("property_id");
  const addrCol = headers.indexOf(propertiesHeaderFor("address"));
  const unitCol = headers.indexOf(propertiesHeaderFor("unit"));
  const zipCol  = headers.indexOf(propertiesHeaderFor("zip"));

  /* ---- MATCH ON NORMALISED FIELDS, never on the key string ----
     A stored key was built by whatever version of propertyKey() was deployed
     the day it was written, and Sheets may since have eaten a leading zero out
     of the unit or zip cell. Comparing the FIELDS sidesteps both: it asks
     "is this the same home?" rather than "did two strings come out the same?" */
  let rowIndex = -1;
  if (addrCol !== -1 && unitCol !== -1 && zipCol !== -1) {
    for (let i = 0; i < existing.length; i++) {
      const row = existing[i];
      if (sameProperty(data, { zip: row[zipCol], address: row[addrCol], unit: row[unitCol] })) {
        rowIndex = i + 2; break;
      }
    }
  } else {
    /* Fallback for a tab missing one of those columns: the old exact-key
       comparison. Worse, but better than matching nothing and forking a row. */
    const needle = String(propertyKey).trim().toLowerCase();
    for (let i = 0; i < existing.length; i++) {
      if (String(existing[i][col.property_key]).trim().toLowerCase() === needle) { rowIndex = i + 2; break; }
    }
  }

  /* ---- No match: create, and mint an id ---- */
  if (rowIndex === -1) {
    const propertyId = idCol === -1 ? "" : nextSeqId(existing, idCol, "PROP");
    const row = new Array(headers.length).fill("");
    const written = [];
    Object.keys(incoming).forEach(function (f) {
      if (col[f] !== undefined && isSet(incoming[f])) { row[col[f]] = incoming[f]; written.push(f); }
    });
    if (idCol !== -1) { row[idCol] = propertyId; written.push("property_id"); }
    sheet.appendRow(row);

    /* A new home gets a blank memory row immediately, so there is always
       somewhere waiting for what the crew learns on the first visit. Never
       fatal — a missing PROPERTY_MEMORY tab must not cost a booking. */
    let memory = "skipped";
    try { memory = ensurePropertyMemoryRow(ss, propertyId); }
    catch (memErr) { console.error("PROPERTY_MEMORY row not created: " + memErr); }

    return { ok: true, action: "created", property_key: propertyKey, property_id: propertyId,
             row: sheet.getLastRow(), fields: written, missing: missing, memory: memory };
  }

  /* ---- Match: fill blanks only ---- */
  const current = existing[rowIndex - 2];
  const filled = [];
  Object.keys(incoming).forEach(function (f) {
    if (col[f] === undefined) return;
    if (isSet(current[col[f]])) return;            // never overwrite the operator
    if (!isSet(incoming[f])) return;
    sheet.getRange(rowIndex, col[f] + 1).setValue(incoming[f]);
    filled.push(f);
  });

  /* An existing row that predates property_id gets one now, so the backfill
     happens by itself the next time someone books an address we already know. */
  let propertyId = idCol === -1 ? "" : String(current[idCol] || "");
  if (idCol !== -1 && !propertyId) {
    propertyId = nextSeqId(existing, idCol, "PROP");
    sheet.getRange(rowIndex, idCol + 1).setValue(propertyId);
    filled.push("property_id");
    try { ensurePropertyMemoryRow(ss, propertyId); } catch (memErr) { /* never fatal */ }
  }

  return { ok: true, action: "matched", property_key: propertyKey, property_id: propertyId,
           row: rowIndex, fields: filled, missing: missing };
}

/**
 * Append a blank PROPERTY_MEMORY row for a property that has none.
 *
 * Writes exactly two cells — property_id and updated_at — and never touches an
 * existing row. Everything else on that tab is knowledge a person put there,
 * and a form submission has no business filling any of it.
 */
function ensurePropertyMemoryRow(ss, propertyId) {
  if (!isSet(propertyId)) return "skipped (no property_id)";

  const sheet = ss.getSheetByName(PROPERTY_MEMORY_TAB);
  if (!sheet) return "skipped (no " + PROPERTY_MEMORY_TAB + " tab)";
  assertPropertyMemoryWritable(PROPERTY_MEMORY_TAB);

  const memoryNow = sheetValues(sheet);   // r44: one fresh read
  const headers = memoryNow.headers;
  const idCol = headers.indexOf("property_id");
  if (idCol === -1) return "skipped (no property_id column)";

  const existing = memoryNow.rows;
  for (let i = 0; i < existing.length; i++) {
    if (String(existing[i][idCol]).trim() === String(propertyId).trim()) return "already present";
  }

  const row = new Array(headers.length).fill("");
  row[idCol] = propertyId;
  const upd = headers.indexOf("updated_at");
  if (upd !== -1) row[upd] = receivedAt();
  sheet.appendRow(row);
  return "created";
}


/* ============================================================
   5c. AVAILABILITY WRITE-BACK  (Ops workbook)
   ============================================================ */

/* How well a partner fits the service being booked. Higher wins.

   ABSENCE OF DATA IS NOT REFUSAL. A vendor with no VENDOR_SERVICES rows has
   told us nothing, so they rank ORDINARY rather than disqualified. That is
   what makes an empty VENDOR_SERVICES tab a no-op: booking behaves exactly
   as it did before r16 until somebody actually declares a service. Only a
   vendor who declared their services and left this one out drops to last. */
/* r25 — UNASSIGNED CAPACITY IS A REAL ROW WITH AN EMPTY vendor_id.

   It exists so a time can be offered, and guaranteed, before anybody is booked
   to work it: the customer picks the slot, the booking is held, and the search
   for a partner starts from a time the customer has already chosen rather than
   from a blank diary. Their ticket shows "Coordinating with our provider network"
   the whole time, which is the same state every preference booking has always
   had — nothing new to build on the customer's side.

   IT RANKS BELOW EVERY REAL VENDOR AND ABOVE THE ONES WHO SHOULD NOT GET IT.
   Until r25 an unassigned row scored ORDINARY, tying with a genuinely available
   partner, and ties keep sheet order — so a row with nobody in it could beat a
   company sitting free at that hour, purely for being higher up the tab. That
   is backwards. Unassigned is a promise Serve still has to keep by hand; a real
   vendor is one already kept. Take the vendor whenever there is one.

   It still outranks `avoid` and `disqualified`, because "we will find somebody"
   is a better answer than sending a company work they told us they do not
   want or do not do. */
const SLOT_RANK_PREFERRED    = 5;
const SLOT_RANK_ORDINARY     = 4;
const SLOT_RANK_UNASSIGNED   = 3;
const SLOT_RANK_AVOID        = 2;
const SLOT_RANK_DISQUALIFIED = 1;

function slotRank(vendorId, serviceCode, memo) {
  /* Split deliberately. No vendor is capacity Serve still owes somebody, and
     ranks below a real one. A vendor we simply cannot judge — no service code
     to check them against — is ORDINARY, because absence of data is not
     refusal and that rule predates this one. */
  if (!vendorId)   return SLOT_RANK_UNASSIGNED;
  if (!serviceCode) return SLOT_RANK_ORDINARY;
  var key = vendorId + "|" + serviceCode;
  if (memo && memo[key] !== undefined) return memo[key];

  var rank = SLOT_RANK_ORDINARY;
  try {
    var declared = getVendorServices(vendorId);
    if (declared.length) {
      var match = null;
      for (var i = 0; i < declared.length; i++) {
        if (declared[i].serviceCode === serviceCode && declared[i].active) {
          match = declared[i];
          break;
        }
      }
      if (!match || !match.offers)               rank = SLOT_RANK_DISQUALIFIED;
      else if (match.preference === "preferred") rank = SLOT_RANK_PREFERRED;
      else if (match.preference === "avoid")     rank = SLOT_RANK_AVOID;
    }
  } catch (err) {
    /* A missing VENDOR_SERVICES tab must never stop a booking. */
    rank = SLOT_RANK_ORDINARY;
  }
  if (memo) memo[key] = rank;
  return rank;
}

/**
 * Record which partner the consumed availability row belonged to.
 *
 * INTO A BLANK CELL ONLY. `vendor_id` is on OPS_OWNED_COLUMNS — a human's
 * dispatch decision outranks an inference from the schedule, so this fills
 * the gap and never argues with it. A JOBS tab without the column is a
 * no-op, which is the state every JOBS tab is in until it is added.
 */
function stampJobVendor(jobs, rowNumber, vendorId) {
  var want = String(vendorId || "").trim();
  if (!want || !rowNumber || rowNumber < 2) return false;
  var i = sheetHeaders(jobs).indexOf("vendor_id");
  if (i === -1) return false;
  var cell = jobs.getRange(rowNumber, i + 1);
  if (isSet(cell.getValue())) return false;
  cell.setValue(want);
  return true;
}

/**
 * Mark the booked slot as taken so the next visitor cannot buy it twice.
 *
 * CONCURRENCY: doPost already holds the script lock for the whole execution, so
 * this match-and-write is serialised against other runs of this script. A second
 * waitLock() here would be redundant. What matters is that the read happens
 * HERE, at write time, rather than trusting the client — the feed is cached for
 * five minutes, so the visitor's view of availability is stale by construction.
 *
 * CONFLICT IS NOT AN ERROR. If no open row matches, someone took the slot inside
 * that cache window. The booking is still written and the notification subject
 * is flagged; a human resolves it. Refusing the booking would punish the
 * customer for our caching.
 *
 * Returns { ok, action: booked|conflict|skipped|failed, ... }. Never throws.
 */
function bookAvailabilitySlot(sched, jobId, serviceCode) {
  if (sched.shape !== "slot") {
    return { ok: true, action: "skipped", reason: "not a specific slot (" + sched.shape + ")" };
  }

  try {
    const ops = opsBook();   // r44: once per request
    const av  = ops.getSheetByName(AVAILABILITY_TAB);
    if (!av) throw new Error('Ops workbook "' + ops.getName() + '" has no ' + AVAILABILITY_TAB + ' tab.');
    assertAvailabilityWritable(AVAILABILITY_TAB);

    /* r33: the Ops workbook built these date cells, so its timezone is the
       only one that reads them back the way availability.gs published them. */
    const opsTz = sheetTimeZone(ops);

    /* r44. One fresh read at write time — the whole point of this function is
       to look at the sheet as it is NOW, inside the lock. */
    const slotsNow = sheetValues(av);
    const headers = slotsNow.headers;
    const iDate = headers.indexOf("date"),
          iTime = headers.indexOf("start_time"),
          iStat = headers.indexOf("status"),
          iJob  = headers.indexOf("job_id");

    /* r16. Whose capacity this row is. Accept either name: `vendor_id` is
       what the column becomes, `cleaner_id` is what it is called today.
       Reading both means the rename is not a flag day. */
    const iVen = headers.indexOf("vendor_id") !== -1
                   ? headers.indexOf("vendor_id")
                   : headers.indexOf("cleaner_id");

    const missing = [];
    if (iDate === -1) missing.push("date");
    if (iTime === -1) missing.push("start_time");
    if (iStat === -1) missing.push("status");
    if (missing.length) {
      throw new Error(AVAILABILITY_TAB + " is missing header(s): " + missing.join(", ") +
                      ". Row 1 reads: " + headers.join(" | "));
    }

    if (!slotsNow.rows.length) return { ok: true, action: "conflict", reason: "no availability rows" };

    /* Read at write time, not from the customer's cached view. */
    const rows = slotsNow.rows;

    /* r16. Collect every open row for this date and time, not merely the
       first. With one row this is identical to the old behaviour; with
       several it is a choice, and a choice belongs in the open rather than
       in loop order. Ties keep sheet order, so the first row still wins
       among equals. */
    const memo = {};
    const candidates = [];
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      if (String(row[iStat]).trim().toLowerCase() !== SLOT_OPEN) continue;   // never touch `held`
      if (slotDateKey(row[iDate], opsTz) !== sched.date) continue;
      if (slotTimeLabel(row[iTime], opsTz) !== sched.time) continue;
      const vendorId = iVen === -1 ? "" : String(row[iVen] || "").trim();
      candidates.push({ sheetRow: r + 2, vendorId: vendorId,
                        rank: slotRank(vendorId, serviceCode, memo) });
    }

    if (!candidates.length) {
      return { ok: true, action: "conflict",
               reason: 'no open row for ' + sched.date + ' ' + sched.time +
                       ' — taken inside the 5-minute feed cache, or removed' };
    }

    let pick = candidates[0];
    for (let c = 1; c < candidates.length; c++) {
      if (candidates[c].rank > pick.rank) pick = candidates[c];
    }

    av.getRange(pick.sheetRow, iStat + 1).setValue(SLOT_BOOKED);
    if (iJob !== -1 && isSet(jobId)) av.getRange(pick.sheetRow, iJob + 1).setValue(jobId);

    return { ok: true, action: "booked", row: pick.sheetRow,
             /* `cleaner` is kept so the existing notification line and the
                self-test keep working through the rename. */
             cleaner: pick.vendorId, vendorId: pick.vendorId,
             warning: pick.rank === SLOT_RANK_DISQUALIFIED
                        ? 'vendor ' + pick.vendorId + ' does not offer ' +
                          serviceCode + ' — reassign by hand'
                        : "" };

  } catch (err) {
    console.error("AVAILABILITY write-back failed: " + err);
    return { ok: false, action: "failed", error: String(err) };
  }
}

/**
 * Give a slot back.
 *
 * THE OPEN ITEM THIS CLOSES. Until r43 nothing released capacity: a cancelled
 * or moved booking left its AVAILABILITY row reading `booked` forever, so that
 * time vanished from the feed and no customer could ever buy it again —
 * capacity leaking one cancellation at a time, invisibly. SCHEMA has said since
 * r5 that the `job_id` written back is the handle for undoing a booking. This
 * is the code that finally uses it.
 *
 * `held` IS NEVER TOUCHED, the same rule bookAvailabilitySlot follows. That
 * status is an operator's hold on their own diary; a customer cancelling a
 * visit is not permission to hand somebody's held morning back to the public
 * feed. Only a row reading `booked` AND carrying this job_id is ours to return.
 *
 * MATCHED ON job_id, NEVER ON DATE AND TIME. Freeing "the 9 AM row for the 2nd"
 * would free whatever now sits there — which, after a conflict a human resolved
 * by hand, can be somebody else's booking entirely.
 *
 * EVERY matching row is freed, not merely the first. One booking should hold
 * one row, but a hand-resolved conflict can leave two pointing at the same job,
 * and releasing one would leave the other sold to nobody.
 *
 * `exceptRow` IS WHAT MAKES A RESCHEDULE POSSIBLE AT ALL, and it is not an
 * optimisation. A move books the new slot under the SAME job_id before giving
 * the old one back — so by the time this runs there are two booked rows
 * carrying that id, and "free every row for this job" would hand back the time
 * the customer just chose. They would be left holding a confirmation for a slot
 * that reads open, and the next visitor could buy it. The caller passes the row
 * it just took; that one row is not ours to release.
 *
 * Returns { ok, action: released|not_found|skipped|failed, ... }. Never throws:
 * a cancellation must not fail because the Ops sheet moved underneath it.
 */
function releaseAvailabilitySlot(jobId, exceptRow) {
  var want = String(jobId || "").trim();
  if (!want) return { ok: true, action: "skipped", reason: "no job id" };
  var keep = Number(exceptRow) || 0;

  try {
    const ops = opsBook();   // r44: once per request
    const av  = ops.getSheetByName(AVAILABILITY_TAB);
    if (!av) throw new Error('Ops workbook "' + ops.getName() + '" has no ' + AVAILABILITY_TAB + ' tab.');
    assertAvailabilityWritable(AVAILABILITY_TAB);

    const slotsNow = sheetValues(av);   // r44: one fresh read, inside the lock
    const headers = slotsNow.headers;
    const iStat = headers.indexOf("status");
    const iJob  = headers.indexOf("job_id");

    /* Without job_id there is no handle at all. Refuse rather than fall back to
       date and time, for the reason in the header comment. */
    const missing = [];
    if (iStat === -1) missing.push("status");
    if (iJob  === -1) missing.push("job_id");
    if (missing.length) {
      throw new Error(AVAILABILITY_TAB + " is missing header(s): " + missing.join(", ") +
                      ". Row 1 reads: " + headers.join(" | "));
    }

    if (!slotsNow.rows.length) return { ok: true, action: "not_found", reason: "no availability rows" };

    const rows = slotsNow.rows;
    const freed = [];
    for (let r = 0; r < rows.length; r++) {
      if ((r + 2) === keep) continue;                          // just booked — see above
      if (String(rows[r][iJob]).trim() !== want) continue;
      if (String(rows[r][iStat]).trim().toLowerCase() !== SLOT_BOOKED) continue;   // never `held`
      av.getRange(r + 2, iStat + 1).setValue(SLOT_OPEN);
      av.getRange(r + 2, iJob + 1).setValue("");
      freed.push(r + 2);
    }

    if (!freed.length) {
      return { ok: true, action: "not_found",
               reason: "no booked row carries " + want +
                       " — a preference booking consumed none, or a human already freed it" };
    }
    return { ok: true, action: "released", rows: freed };

  } catch (err) {
    console.error("AVAILABILITY release failed: " + err);
    return { ok: false, action: "failed", error: String(err) };
  }
}

/**
 * Date cell -> "YYYY-MM-DD".
 *
 * MUST match ymd() in /apps-script/availability.gs. These are separate script
 * projects so the code cannot be shared, and if the two ever disagree the match
 * silently fails and every booking reports a conflict.
 *
 * `tz` is the OPS WORKBOOK's timezone — the one Sheets used to build the cell.
 * Local getters are this project's timezone, which is a different setting in a
 * different project; they are kept only as the fallback when the workbook
 * cannot report one. r33.
 */
function slotDateKey(v, tz) {
  if (!(v instanceof Date)) return String(v).trim();
  if (tz) {
    try { return Utilities.formatDate(v, tz, "yyyy-MM-dd"); } catch (_) {}
  }
  return v.getFullYear() + "-" +
         ("0" + (v.getMonth() + 1)).slice(-2) + "-" +
         ("0" + v.getDate()).slice(-2);
}

/**
 * start_time cell -> "9:00 AM".
 * MUST match parseTime()/clockLabel() in /apps-script/availability.gs.
 * `tz` is the OPS WORKBOOK's timezone, as above. Text is never converted.
 */
function slotTimeLabel(v, tz) {
  if (v instanceof Date) {
    let h = v.getHours(), mi = v.getMinutes();
    if (tz) {
      try {
        h  = Number(Utilities.formatDate(v, tz, "H"));
        mi = Number(Utilities.formatDate(v, tz, "m"));
      } catch (_) { h = v.getHours(); mi = v.getMinutes(); }
    }
    return clockLabelFor(h, mi);
  }
  const m = String(v == null ? "" : v).trim().match(/^(\d{1,2}):(\d{2})\s*([AP])\.?M\.?$/i);
  if (!m) return String(v).trim();
  const h24 = (+m[1]) % 12 + (/p/i.test(m[3]) ? 12 : 0);
  return clockLabelFor(h24, +m[2]);
}

function clockLabelFor(h, mi) {
  const h12 = (h % 12 === 0) ? 12 : (h % 12);
  return h12 + ":" + ("0" + mi).slice(-2) + " " + (h < 12 ? "AM" : "PM");
}


/* ============================================================
   6. SCHEDULING
   ============================================================ */

/**
 * Resolve one true schedule answer. The site has two scheduling controls that
 * write different keys, and only schedule_preference_label is populated on both
 * paths — reading a single key is what left `notes` blank on slot bookings.
 *
 *   1. slot_date + slot_time  (or requested_date + requested_window)
 *   2. time_preference / schedule_preference
 *   3. schedule_preference_label — guaranteed non-empty backstop
 *   4. "No time specified"
 *
 * Always returns a non-empty summary.
 */
function normalizeSchedule(data) {
  const date = firstSet(data.slot_date, data.requested_date);
  const time = firstSet(data.slot_time, data.requested_window);

  if (isSet(date) && isSet(time)) {
    return { shape: "slot", date: String(date), time: String(time),
             summary: prettyDate(date) + " at " + time };
  }

  const pref = firstSet(data.time_preference, data.schedule_preference);
  if (isSet(pref)) {
    return { shape: "preference", date: "", time: "", summary: prefLabel(pref) };
  }

  if (isSet(data.schedule_preference_label)) {
    return { shape: "label", date: "", time: "",
             summary: String(data.schedule_preference_label) };
  }

  return { shape: "none", date: "", time: "", summary: "No time specified" };
}

function prefLabel(v) {
  const k = String(v).toLowerCase();
  if (k === "earlier") return "Earlier in the day (typically 8:00 AM - 12:00 PM)";
  if (k === "later")   return "Later in the day (typically 12:00 PM - 5:00 PM)";
  return String(v);
}

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES   = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * "2026-08-14" -> "Friday, Aug 14".
 *
 * Deliberately timezone-free. The customer picked a calendar date, which has no
 * timezone at all. The previous version built a local Date and formatted it in
 * another zone; whenever those two disagreed the weekday came out one day off.
 * Fixing the arithmetic to UTC on both sides removes the class of bug rather
 * than the instance.
 */
function prettyDate(ymd) {
  const parts = String(ymd).split("-");
  if (parts.length !== 3) return String(ymd);
  const y = Number(parts[0]), m = Number(parts[1]), d = Number(parts[2]);
  if (!isFinite(y) || !isFinite(m) || !isFinite(d)) return String(ymd);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (isNaN(dt.getTime())) return String(ymd);
  return WEEKDAY_NAMES[dt.getUTCDay()] + ", " + MONTH_NAMES[dt.getUTCMonth()] + " " + dt.getUTCDate();
}


/* ============================================================
   7. JOBS RECORD
   ============================================================ */

function buildJobRecord(data, sched, leadId, sheet, ids) {
  ids = ids || {};
  const record = {
    /* r9 — the join keys. property_key and lead_id stay for continuity, but
       history should be read through these: an id is minted once and never
       rebuilt from typed input, so it cannot fork the way a key can. */
    property_id:        ids.property_id || "",
    contact_id:         ids.contact_id  || "",
    job_id:             makeJobId(data, sched),
    lead_id:            leadId,
    src_first:          firstSet(data.src_first, data.src, ""),
    property_key:       propertyKey(data),
    service_label:      serviceLabel(data),
    frequency_selected: data.frequency_selected || "",
    condition:          data.condition || "",
    bedrooms:           valOrBlank(data.bedrooms),
    bathrooms:          valOrBlank(data.bathrooms),
    quote_price:        valOrBlank(data.quote_price),
    addons_label:       addonsLabel(data),
    addon_total:        addonRevenue(data),
    first_visit_total:  valOrBlank(firstSet(data.first_visit_total, data.quote_price)),
    requested_date:     sched.date,
    // start_time holds the window on a slot booking, the preference label
    // otherwise. Blank only when no time was expressed at all.
    requested_window:   sched.shape === "slot" ? sched.time
                      : sched.shape === "none" ? ""
                      : sched.summary,
    job_status:         NEW_JOB_STATUS,

    notes:              sched.summary,        // schedule summary ONLY, never empty
    scheduling_type:    sched.shape,

    submission_id:      data.submission_id || "",
    received_at:        receivedAt(),
    name:               data.name  || "",
    email:              data.email || "",
    phone:              data.phone || "",
    segment:            data.segment   || "",
    src_chain:          data.src_chain || "",
    customer_notes:     data.customer_notes || "",   // customer free text ONLY
    pets_flag:          petsFlag(data) ? "TRUE" : "FALSE",
  };

  const headers = sheetHeaders(sheet);

  /* Ops fields -> their own columns. quote_meta is not involved when the column
     exists, which is the normal case. */
  const orphanedOps = [];
  OPS_PREFERRED_KEYS.forEach(function (k) {
    if (headers.indexOf(k) !== -1) record[k] = data[k] || "";
    else if (isSet(data[k]))       orphanedOps.push(k);
  });

  /* Secondary reference data -> quote_meta, plus any ops field whose column is
     missing, so nothing is lost while a schema catches up. */
  if (headers.indexOf("quote_meta") !== -1) {
    const meta = {};
    QUOTE_META_KEYS.forEach(function (k) { if (isSet(data[k])) meta[k] = data[k]; });
    orphanedOps.forEach(function (k) {
      meta[k] = data[k];
      console.log('No "' + k + '" column on ' + sheet.getName() + ' — carried in quote_meta.');
    });
    if (Object.keys(meta).length) record.quote_meta = JSON.stringify(meta);
  } else if (orphanedOps.length) {
    console.log("No quote_meta column — DROPPED: " + orphanedOps.join(", "));
  }

  return record;
}

/**
 * Add-on revenue. Move In / Move Out bundles fridge and oven into the
 * multiplier, so this is legitimately 0 on those jobs — do not impute $85.
 */
function addonRevenue(data) {
  if (serviceKey(data) === "move_out") return 0;
  return valOrBlank(data.addon_total);
}


/* ============================================================
   8. SHEET I/O — header-driven, never widens a tab
   ============================================================ */

/** "Raw Intake" / "RAW_INTAKE" / "raw-intake" all normalize to RAW_INTAKE. */
function normalizeTabName(name) {
  return String(name).trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function assertWritable(name) {
  if (PROTECTED_TABS.map(normalizeTabName).indexOf(normalizeTabName(name)) !== -1) {
    throw new Error('Refusing to write to protected tab "' + name + '".');
  }
}

/**
 * The ONE allowance for PROPERTIES, used only by upsertProperty().
 *
 * Written as a function that refuses everything except PROPERTIES rather than
 * as a flag on assertWritable(), so the exception cannot widen. Passing any
 * other tab name here throws — including the tabs it was meant to protect.
 */
function assertPropertiesWritable(name) {
  if (normalizeTabName(name) !== normalizeTabName(PROPERTIES_TAB)) {
    throw new Error('assertPropertiesWritable("' + name + '") — this allowance exists ' +
                    'only for ' + PROPERTIES_TAB + '. Use assertWritable().');
  }
}

/**
 * The same narrow allowance for PROPERTY_MEMORY — and it is narrower still.
 * The only write this permits is appending a blank row carrying a property_id.
 * Everything else on that tab is written by a human who has been to the home.
 */
function assertPropertyMemoryWritable(name) {
  if (normalizeTabName(name) !== normalizeTabName(PROPERTY_MEMORY_TAB)) {
    throw new Error('assertPropertyMemoryWritable("' + name + '") — this allowance ' +
                    'exists only for ' + PROPERTY_MEMORY_TAB + '. Use assertWritable().');
  }
}

/** The same narrow allowance for the Ops AVAILABILITY tab. */
function assertAvailabilityWritable(name) {
  if (normalizeTabName(name) !== normalizeTabName(AVAILABILITY_TAB)) {
    throw new Error('assertAvailabilityWritable("' + name + '") — this allowance exists ' +
                    'only for ' + AVAILABILITY_TAB + '. Use assertWritable().');
  }
}

/**
 * @param map  key->header translation. HEADER_MAP is JOBS-specific, so EVENTS
 *             passes {} and matches on the raw payload names in its own header
 *             row. Applying the JOBS map everywhere silently dropped bedrooms,
 *             bathrooms and quote_price from EVENTS.
 */
function writeRow(sheet, record, map) {
  assertWritable(sheet.getName());
  const translate = map || HEADER_MAP;

  const headers = sheetHeaders(sheet);
  if (!headers.length) throw new Error('Tab "' + sheet.getName() + '" has no header row.');

  const byHeader = {};
  const noColumn = [];

  Object.keys(record).forEach(function (key) {
    const value = record[key];
    if (value === undefined || value === null || value === "") return;
    const header = translate[key] || key;
    if (OPS_OWNED_COLUMNS.indexOf(header) !== -1) return;      // ops owns these
    if (headers.indexOf(header) === -1) { noColumn.push(key); return; }
    if (byHeader[header] === undefined) byHeader[header] = value;
  });

  if (noColumn.length) console.log("Dropped (no column): " + noColumn.join(", "));

  sheet.appendRow(headers.map(function (h) {
    return byHeader[h] !== undefined ? byHeader[h] : "";
  }));

  return { noColumn: noColumn };
}

/* ============================================================
   ONE READ PER TAB, PER REQUEST  —  r44
   ============================================================

   WHY THIS EXISTS. Every SpreadsheetApp call is a round trip to Google, and
   they add up far faster than the work itself. r43 opened a five-booking
   customer's portal with 211 of them, because each helper fetched the tabs it
   needed for itself: getContactBookings read JOBS and then called getBooking,
   which read JOBS again, once per booking; the photo tab was read whole once
   per booking; the Ops workbook was reopened by every helper that touched it.
   The page could show nothing until the last one returned.

   TWO LEVELS OF SHARING, and the difference between them is the design.

     handles    The Ops workbook (opsBook), each workbook's timezone
                (sheetTimeZone) and the ticket secret (ticketSecret) are looked
                up once per request, GET or POST. None of them can change while
                a request runs, and none is a copy of sheet data, so sharing
                them cannot go stale.

     snapshots  A tab's values, read whole in one call and then shared by
                every helper that asks during the same request. ONLY IN doGet.
                A GET writes nothing, so a snapshot taken at its start is still
                true at its end. A POST reads, writes and reads again — books
                the new slot, then releases the old one; saves an answer, then
                reports whether the home is complete — and a shared snapshot
                would hand the second read a sheet from before the first write.
                So a POST reads fresh on every call: the same one-call reader,
                never shared.

   THE SCOPE IS OPENED BY doGet/doPost AND CLEARED IN A finally. Apps Script
   already gives each execution fresh globals, so in production the finally is
   belt and braces. It is load-bearing in the test harness, where one
   long-lived context serves many requests and a leaked snapshot would answer a
   later request with an earlier sheet. Code run from the editor — backfills,
   sweeps, diagnostics — has no request and reads exactly as it always did.

   KEYED BY WORKBOOK OBJECT, then tab name. Leads and Ops are different objects,
   so a tab name that exists in both cannot collide. A workbook opened twice is
   two objects — a missed share, never a wrong answer.

   NEVER MUTATE WHAT readTable RETURNS. Inside a GET every caller holds the same
   arrays. The converted helpers only read them and build new objects.

   A GET THAT STARTS WRITING BREAKS THIS. tests/read-budget.test.js asserts that
   the GET routes make no writes at all, so it fails before a stale read ships.
   ============================================================ */

var REQUEST_SCOPE = null;

/**
 * Run fn inside a request scope. `snapshots` is true only for doGet.
 * Re-entrant: a nested call joins the scope already open rather than opening a
 * second one (and closing the outer one early on its way out).
 */
function withRequestScope(snapshots, fn) {
  if (REQUEST_SCOPE) return fn();
  REQUEST_SCOPE = {
    snapshots: !!snapshots,
    ops: null,              // the Ops workbook, opened once
    zones: new Map(),       // workbook -> its timezone
    tables: new Map(),      // workbook -> { tabName: table | null }
    secret: "",             // TICKET_SECRET, read once
  };
  try {
    return fn();
  } finally {
    REQUEST_SCOPE = null;
  }
}

/**
 * One whole tab: { sheet, headers, rows } — or null when the tab does not exist.
 *
 * ONE CALL FOR THE DATA. getDataRange().getValues() returns the header row and
 * every data row together, where the reads it replaces made four or five
 * (getLastColumn, the header range, getLastRow, the data range — and often a
 * second pass for one column). `headers` is trimmed exactly as sheetHeaders()
 * trims it; `rows` excludes the header and is [] for a tab with no data.
 *
 * Shared for the rest of the request inside doGet; fresh on every call
 * anywhere else. Read the rows, never write to them.
 */
function readTable(ss, name) {
  var shelf = null;
  if (REQUEST_SCOPE && REQUEST_SCOPE.snapshots) {
    shelf = REQUEST_SCOPE.tables.get(ss);
    if (!shelf) { shelf = {}; REQUEST_SCOPE.tables.set(ss, shelf); }
    if (Object.prototype.hasOwnProperty.call(shelf, name)) return shelf[name];
  }

  var sheet = ss.getSheetByName(name);
  var table = sheet ? sheetValues(sheet) : null;

  if (shelf) shelf[name] = table;
  return table;
}

/**
 * The same one-call read, for a sheet the caller already holds:
 * { sheet, headers, rows }. ALWAYS FRESH — never shared, in any scope — which
 * is what makes it safe inside the write paths, where a tab is read, written
 * and possibly read again in the same request.
 */
function sheetValues(sheet) {
  var values = sheet.getDataRange().getValues();
  var headers = values.length
    ? values[0].map(function (h) { return String(h).trim(); })
    : [];
  /* An empty sheet's data range is one blank cell, not zero cells.
     sheetHeaders() answers [] for that sheet, and so must this. */
  if (values.length === 1 && headers.length === 1 && headers[0] === "") headers = [];
  return { sheet: sheet, headers: headers, rows: values.slice(1) };
}

/** readTable for a tab that must exist. Same refusal, same order, as requireTab. */
function requireTable(ss, name) {
  var table = readTable(ss, name);
  if (!table) throw new Error('Tab "' + name + '" not found. Check the tab-name constants.');
  assertWritable(name);
  return table;
}

function sheetHeaders(sheet) {
  const lastCol = sheet.getLastColumn();
  if (lastCol < 1) return [];
  return sheet.getRange(1, 1, 1, lastCol).getValues()[0]
    .map(function (h) { return String(h).trim(); });
}

/** True if this submission_id is already in the tab. The retry-safety guarantee. */
function alreadyWritten(sheet, submissionId) {
  if (!isSet(submissionId)) return false;

  const headers = sheetHeaders(sheet);
  const col = headers.indexOf("submission_id");
  if (col === -1) return false;                      // nowhere to check — allow the write

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return false;

  const values = sheet.getRange(2, col + 1, lastRow - 1, 1).getValues();
  const needle = String(submissionId).trim();
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][0]).trim() === needle) return true;
  }
  return false;
}

function requireTab(ss, name) {
  const sheet = ss.getSheetByName(name);
  if (!sheet) throw new Error('Tab "' + name + '" not found. Check the tab-name constants.');
  assertWritable(name);
  return sheet;
}

/** EVENTS is ours to create. LEADS and JOBS are never auto-created. */
function eventsTab(ss) {
  assertWritable(EVENTS_TAB);
  let sheet = ss.getSheetByName(EVENTS_TAB);
  if (!sheet) {
    sheet = ss.insertSheet(EVENTS_TAB);
    sheet.appendRow(EVENTS_HEADERS);
    sheet.setFrozenRows(1);
    console.log('Created the "' + EVENTS_TAB + '" tab.');
  }
  return sheet;
}


/* ============================================================
   9. EMAILS
   ============================================================ */

function sendReservationEmail(data, sched, leadId, leadResult, propertyResult, slotResult) {
  propertyResult = propertyResult || { action: "n/a" };
  slotResult     = slotResult     || { action: "n/a" };

  /* Anything needing a human goes at the very top, before the booking detail.
     Buried at the bottom it would be read after the reader has decided the
     email is routine. */
  let warn = "";
  if (leadResult && leadResult.ok === false) {
    warn += "*** LEADS UPSERT FAILED — the JOBS row was written anyway. ***\n" +
            "*** " + leadResult.error + " ***\n" +
            "*** Add the person to LEADS by hand. ***\n\n";
  }
  if (slotResult.action === "conflict") {
    warn += "*** SLOT CONFLICT — this time was already taken. ***\n" +
            "*** " + (slotResult.reason || "") + " ***\n" +
            "*** The booking IS recorded. Call the customer and move them, or ***\n" +
            "*** find a second cleaner for the slot. They have not been told. ***\n\n";
  }
  if (slotResult.action === "failed") {
    warn += "*** AVAILABILITY WRITE-BACK FAILED — the slot is still marked open. ***\n" +
            "*** " + slotResult.error + " ***\n" +
            "*** Mark it booked by hand or it can be sold again. ***\n\n";
  }
  if (propertyResult.ok === false) {
    warn += "*** PROPERTIES UPSERT FAILED — no property record for this address. ***\n" +
            "*** " + propertyResult.error + " ***\n\n";
  }

  const flags = [];
  if (petsFlag(data))                          flags.push("PETS");
  if (leadResult && leadResult.ok === false)   flags.push("LEADS WRITE FAILED");
  if (slotResult.action === "conflict")        flags.push("SLOT CONFLICT");
  if (slotResult.action === "failed")          flags.push("SLOT NOT MARKED");

  const subject = "Serve Reservation — " + (data.name || "Unknown") + " · " + homeSummary(data) +
                  (flags.length ? " · " + flags.join(" · ") : "");

  const body =
    warn +
    "A visitor just reserved a clean on servecleaning.com.\n\n" +
    "— WHEN —\n" + sched.summary + "\n(" + sched.shape + ")\n\n" +
    "— CONTACT —\n" +
    "Name:    " + (data.name    || "") + "\n" +
    "Email:   " + (data.email   || "") + "\n" +
    "Phone:   " + (data.phone   || "") + "\n" +
    "Address: " + (data.address || "") + (isSet(data.unit) ? ", " + data.unit : "") + "\n" +
    "ZIP:     " + (data.zip || "") + " (" + (data.zip_tier || "") + ")\n\n" +
    "— RECORDS —\n" +
    "lead_id:    " + leadId + "  (" + (leadResult ? leadResult.action : "?") + ")\n" +
    "job_id:     " + makeJobId(data, sched) + "\n" +
    "property:   " + propertyKey(data) + "  (" + propertyResult.action + ")\n" +
    "slot:       " + slotResult.action +
      (slotResult.action === "booked"
        ? " — AVAILABILITY row " + slotResult.row +
          (isSet(slotResult.vendorId) ? ", vendor " + slotResult.vendorId : "") +
          (isSet(slotResult.warning)  ? "\n            NEEDS A HUMAN: " + slotResult.warning : "")
        : (slotResult.reason ? " — " + slotResult.reason : "")) + "\n\n" +
    "— SERVICE —\n" +
    "Service:    " + serviceLabel(data) + "\n" +
    "Home:       " + homeSummary(data) + "\n" +
    "Levels:     " + levelsLabel(data) + "\n" +
    "Condition:  " + (data.condition || "") + "\n" +
    "Add-ons:    " + (addonsLabel(data) || "(none)") + "\n" +
    "Frequency:  " + (data.frequency_selected || "once") + "\n" +
    "Pets:       " + (petsFlag(data) ? "YES — plan around them" : "none mentioned") + "\n\n" +
    "— WHAT THEY TOLD US —\n" +
    (isSet(data.customer_notes) ? data.customer_notes : "(nothing added)") + "\n\n" +
    "— PRICING (all-in) —\n" +
    "First-visit price: " + money(firstSet(data.quote_price, data.first_visit_total)) + "\n" +
    (Number(addonRevenue(data)) > 0 ? "Of which add-ons: " + money(addonRevenue(data)) + "\n" : "") +
    (isSet(data.steady_state_price)
      ? "Recurring/visit:   " + money(data.steady_state_price) +
        " (" + (data.frequency_selected || "") + ")\n" : "") +
    attributionBlock(data) +
    /* The two links to hand out. Generated rather than stored: each token is
       an HMAC of the job_id AND the audience, so both are stable for a given
       job and neither needs a column.

       THEY ARE NOT INTERCHANGEABLE, as of r13. Sending the cleaner's link to a
       customer shows them nothing — it is refused, not downgraded — and
       sending the customer's link to a cleaner is equally inert. Before r13
       one link opened both views and the price travelled with it.

       Wrapped because a ticket must never be the reason a booking email fails
       to send. */
    ticketBlock(makeJobId(data, sched), leadResult && leadResult.contact_id,
                slotResult && slotResult.vendorId,
                slotResult && slotResult.action) +
    "\nSubmission: " + (data.submission_id || "(none)") +
    "\nSubmitted:  " + firstSet(data.submitted_at, data.timestamp, "");

  MailApp.sendEmail(notifyEmail(), subject, body);
}

function sendEventEmail(eventType, data) {
  let subject, lead;
  if (eventType === "quote_emailed") {
    subject = "Serve Lead — quote emailed to " + (data.email || "unknown");
    lead = "A visitor emailed themselves a quote. Warm lead — priced, not reserved.";
  } else if (eventType === "waitlist_zip") {
    subject = "Serve Waitlist — " + (data.zip || "?") + " (out of area)";
    lead = "Someone outside the service area joined the waitlist.";
  } else if (eventType === "custom_quote_request") {
    subject = "Serve Custom Quote Request — " + homeSummary(data);
    /* Two doors reach this now (r12). A 5+ BR home trips it on its own because
       the flat-rate table stops there; the link under the Build step is chosen
       deliberately by someone whose SCOPE doesn't fit — half the home, an empty
       move-out, one room that needs three hours. The scope box below is what
       tells them apart, so lead with it. */
    lead = isSet(data.customer_notes)
      ? "Someone asked for a quote we price by hand. Their scope is below — reply today with a firm number and a date."
      : "A larger home (5+ BR) requested a personal quote. Send an hourly scope today ($130/hr).";
  } else {
    subject = "Serve Event — " + eventType;
    lead = "A non-reservation event was recorded.";
  }

  /* The customer's own words, verbatim and never merged into anything else.
     EVENTS has no customer_notes column, so for these requests THIS EMAIL IS
     THE ONLY PLACE THE SCOPE EXISTS. Dropping it here loses it outright, and
     the reply becomes a question instead of a number. */
  const scope = isSet(data.customer_notes)
    ? "\nWHAT THEY NEED DONE\n" + "-".repeat(19) + "\n" + data.customer_notes + "\n"
    : "";

  const body =
    lead + "\n\n" +
    (isSet(data.name) ? "Name:      " + data.name + "\n" : "") +
    "Email:     " + (data.email || "") + "\n" +
    "Phone:     " + (data.phone || "(not provided)") + "\n" +
    "ZIP:       " + (data.zip || "") + " (" + (data.zip_tier || "") + ")\n" +
    "Service:   " + serviceLabel(data) + "\n" +
    "Home:      " + homeSummary(data) + "\n" +
    "Quoted:    " + money(firstSet(data.quote_price, data.first_visit_total)) + "\n" +
    scope +
    attributionBlock(data) +
    "\nLogged to the " + EVENTS_TAB + " tab." +
    "\nSubmitted: " + firstSet(data.submitted_at, data.timestamp, "");

  MailApp.sendEmail(notifyEmail(), subject, body);
}

function attributionBlock(data) {
  const parts = [];
  if (isSet(data.segment))      parts.push("Segment:      " + data.segment);
  if (isSet(data.src_first))    parts.push("First touch:  " + data.src_first);
  if (isSet(data.src) && data.src !== data.src_first) parts.push("Last touch:   " + data.src);
  if (isSet(data.src_chain) && data.src_chain !== data.src_first) parts.push("Tag chain:    " + data.src_chain);
  if (isSet(data.utm_source))   parts.push("UTM Source:   " + data.utm_source);
  if (isSet(data.utm_medium))   parts.push("UTM Medium:   " + data.utm_medium);
  if (isSet(data.utm_campaign)) parts.push("UTM Campaign: " + data.utm_campaign);
  return parts.length ? "\n— ATTRIBUTION —\n" + parts.join("\n") + "\n" : "";
}


/* ============================================================
   10. HELPERS
   ============================================================ */

function parseBody(e) {
  if (!e || !e.postData || !e.postData.contents) return null;
  try { return JSON.parse(e.postData.contents); }
  catch (err) { console.error("Could not parse body: " + err); return null; }
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function nowIso()      { return new Date().toISOString(); }

/**
 * received_at per the schema: ISO 8601 in America/New_York, e.g.
 * 2026-07-27T11:42:08-04:00. Pinned to the business timezone rather than
 * Session.getScriptTimeZone() so the column stays consistent even if the script
 * project's timezone is ever changed.
 */
const BUSINESS_TZ = "America/New_York";
function receivedAt() {
  return Utilities.formatDate(new Date(), BUSINESS_TZ, "yyyy-MM-dd'T'HH:mm:ssXXX");
}
function isSet(v)      { return v !== null && v !== undefined && String(v).trim() !== ""; }
function valOrBlank(v) { return (v === null || v === undefined) ? "" : v; }
function money(v)      { return isSet(v) ? "$" + v : "—"; }

function firstSet() {
  for (let i = 0; i < arguments.length; i++) {
    if (isSet(arguments[i])) return arguments[i];
  }
  return "";
}

function serviceKey(data)   { return String(firstSet(data.service, data.service_type)); }

function serviceLabel(data) {
  const s = serviceKey(data);
  if (s === "move_out")    return "Move In / Move Out";
  if (s === "first_clean") return "First Clean";
  return s;
}

/**
 * The links to hand out: the customer's portal and this job's cleaner ticket.
 *
 * THE CUSTOMER GETS A PORTAL LINK, NOT A JOB LINK, as of r14. It is the same
 * link every booking — their bookings, their homes and their access answers
 * live behind it — so the one they were sent in March still works in November.
 *
 * FALLS BACK TO THE PER-JOB CLIENT LINK when there is no contact_id, which
 * happens only when the LEADS column has not been added yet. Without the
 * fallback, adding the portal would silently remove the customer's link
 * altogether on every booking until that column exists.
 *
 * The cleaner's link is unchanged and still per job: a cleaner should only
 * ever see the one job, and the link closes when it is finished.
 *
 * Never throws. A link is not worth failing a booking notification for.
 */
function ticketBlock(jobId, contactId, vendorId, slotAction) {
  try {
    var customer = contactId
      ? "Customer portal (same link every booking):\n" + portalUrl(contactId) + "\n"
      : "Send to the customer:\n" + ticketUrl(jobId, "client") + "\n" +
        "(per-job link — add a contact_id column to LEADS for a portal link)\n";

    /* r19. The COMPANY's standing portal, not this job. Unassigned is not a
       failure worth hiding: it is every preference booking, so the line
       names the two steps instead of going quiet. */
    /* THREE STATES, NOT TWO. Until r25 "no vendor" meant one thing — a
       preference booking that consumed no availability row — and the line said
       so. Unassigned CAPACITY breaks that: the customer picked a real slot, it
       is marked booked, their time is guaranteed, and Serve owes them a partner.
       Telling an operator that booking "consumed no availability row" would be
       false, and would hide the one case that actually needs them today. */
    var vendor;
    if (isSet(vendorId)) {
      vendor = "Provider portal for " + vendorId + " (permanent):\n" + vendorUrl(vendorId) + "\n";
    } else if (String(slotAction) === "booked") {
      vendor = "*** NO VENDOR YET, AND THE TIME IS PROMISED ***\n" +
               "This booking took an UNASSIGNED availability row. The slot is\n" +
               "held and the customer has been given that time — find a partner\n" +
               "for it, put them in vendor_id on the JOBS row, then run\n" +
               "printVendorLinks() in the editor for their link.\n" +
               "Their ticket reads \"Coordinating with our provider network\"\n" +
               "until that column is filled.\n";
    } else {
      vendor = "Provider portal: nobody assigned — this booking consumed no\n" +
               "availability row. Fill vendor_id on the JOBS row, then run\n" +
               "printVendorLinks() in the editor for the link.\n";
    }

    return "\n— TICKETS —\n" +
           customer + "\n" +
           "Send to the cleaner:\n" + ticketUrl(jobId, "partner") + "\n" +
           "(different links — the cleaner's stops working once\n" +
           " completed_date is filled; the customer's is theirs to keep)\n\n" +
           vendor;
  } catch (err) {
    console.error("ticket links unavailable: " + err);
    return "";
  }
}

/**
 * Levels ride along here so they reach the subject line and the SERVICE block
 * from one place.
 *
 * ALWAYS shown when the payload carries a count, "1 floor" included. An
 * earlier version suppressed the single-storey case as noise. That was wrong:
 * a blank reads identically to "the form never asked", so suppressing it left
 * the reader unable to tell a one-floor condo from a field that never
 * arrived — which is the exact doubt this line exists to remove.
 */

function homeSummary(data) {
  const bd = (Number(data.bedrooms) === 0) ? "Studio" : (valOrBlank(data.bedrooms) + " BR");
  const base = bd + " / " + valOrBlank(data.bathrooms) + " BA";
  const n = Number(data.levels);
  return (n >= 1) ? base + " / " + floorWord(n) : base;
}

function floorWord(n) { return n + (n === 1 ? " floor" : " floors"); }

/**
 * Never blank, so the SERVICE block can always be read as a complete record of
 * what the customer actually entered. A missing count is stated outright
 * rather than left as an empty space to be interpreted.
 */
function levelsLabel(data) {
  const n = Number(data.levels);
  return (n >= 1) ? floorWord(n) : "NOT REPORTED — booked from a cached form";
}

function addonsLabel(data) {
  if (serviceKey(data) === "move_out") return "";      // bundled into the multiplier
  if (Array.isArray(data.modifiers_applied) && data.modifiers_applied.length) {
    return data.modifiers_applied.join(", ");
  }
  const list = [];
  if (data.addon_fridge === true) list.push("Inside the fridge (+$45)");
  if (data.addon_oven   === true) list.push("Inside the oven (+$40)");
  return list.join(", ");
}

/* One word list, two callers — petsFlag() on a booking and petsFromText() on
   late notes. It was inline in petsFlag until job_notes needed the same test;
   a second copy is how "guinea pig" ends up recognised on one path and not the
   other. Word-boundaried on purpose: "carpet" must not read as "pet", and
   "category" must not read as "cat". */
const PET_WORDS = /\b(pets?|dogs?|puppy|puppies|cats?|kitten|kittens|kitty|feline|canine|animals?|birds?|parrot|hamster|rabbits?|bunny|guinea pig|ferret|reptile|snake|lizard|litter ?box|crate|kennel|leash|paws?|fur|shedding)\b/i;

function petsFromText(text) {
  return PET_WORDS.test(String(text || ""));
}

/**
 * Trust the site's flag when it sends one; re-derive from the notes otherwise,
 * so a stale cached script.js cannot lose the signal.
 *
 * As of 2026-09-01 the site sends no flag at all on a booking — the textarea
 * that fed it moved to the confirmation screen — so this now returns false on
 * a fresh reservation and the real answer arrives later via job_notes.
 */
function petsFlag(data) {
  if (data.pets_flag === true)  return true;
  if (data.pets_flag === false) return false;
  if (String(data.pets_flag).toUpperCase() === "TRUE")  return true;
  if (String(data.pets_flag).toUpperCase() === "FALSE") return false;
  return petsFromText(data.customer_notes);
}


/* ============================================================
   11. RUN THESE FROM THE EDITOR
   ============================================================ */

/**
 * Prints the LEADS header row and exactly which fields this script can write
 * there. Run this FIRST — it is the only way to see the real schema, since the
 * mapping happens at runtime against whatever row 1 actually says.
 */
function reportLeadsSchema() {
  const ss = SPREADSHEET_ID ? SpreadsheetApp.openById(SPREADSHEET_ID)
                            : SpreadsheetApp.getActiveSpreadsheet();

  console.log("Tabs in this spreadsheet: " +
    ss.getSheets().map(function (s) { return s.getName(); }).join(" | "));

  const leads = ss.getSheetByName(LEADS_TAB);
  if (!leads) { console.log('NO TAB NAMED "' + LEADS_TAB + '".'); return; }

  const headers = sheetHeaders(leads);
  console.log("LEADS row 1 (" + headers.length + " columns):\n  " + headers.join(" | "));

  const found = [], missing = [];
  LEADS_FIELDS.concat([LEADS_FIRST_TOUCH, LEADS_LAST_TOUCH]).forEach(function (f) {
    const h = leadsHeaderFor(f);
    (headers.indexOf(h) !== -1 ? found : missing).push(
      h === f ? h : (f + " -> " + h));
  });
  console.log("WILL WRITE:  " + (found.join(", ")   || "(nothing)"));
  console.log("NO COLUMN:   " + (missing.join(", ") || "(none — full coverage)"));
  console.log("Row matching on: " +
    (headers.indexOf("lead_id") !== -1 ? "lead_id" :
     headers.indexOf("email")   !== -1 ? "email (no lead_id column)" :
     "NOTHING — upsert will fail"));

  console.log("\nfirst_touch / last_touch cell types (existing data, sampled):");
  reportTouchColumnTypes(leads, headers);

  const jobs = ss.getSheetByName(JOBS_TAB);
  if (jobs) {
    const jh = sheetHeaders(jobs);
    console.log("\nJOBS row 1 (" + jh.length + " columns):\n  " + jh.join(" | "));
    console.log("quote_meta column present: " + (jh.indexOf("quote_meta") !== -1));
  }
}

/**
 * Read-only. Samples the top data rows of first_touch / last_touch and reports
 * what they actually contain: a real Sheets datetime, text that merely looks
 * like one, a number, or blank. Text in a date column is the failure mode worth
 * catching — it sorts lexically and breaks date math without any error.
 */
function reportTouchColumnTypes(sheet, headers) {
  const lastRow = sheet.getLastRow();

  [LEADS_FIRST_TOUCH, LEADS_LAST_TOUCH].forEach(function (field) {
    const i = headers.indexOf(field);
    if (i === -1) { console.log("  " + field + ": NO COLUMN"); return; }
    if (lastRow < 2) { console.log("  " + field + ": column present, no data rows to sample"); return; }

    const n = Math.min(8, lastRow - 1);
    const values  = sheet.getRange(2, i + 1, n, 1).getValues();
    const formats = sheet.getRange(2, i + 1, n, 1).getNumberFormats();

    const kinds = values.map(function (r, k) {
      const v = r[0];
      if (v === "" || v === null || v === undefined) return "blank";
      if (Object.prototype.toString.call(v) === "[object Date]") return "DATE";
      if (typeof v === "number") return "number";
      return 'TEXT("' + String(v).slice(0, 20) + '")';
    });

    const distinct = kinds.filter(function (k, idx) { return kinds.indexOf(k) === idx; });
    console.log("  " + field + ": " + distinct.join(" | ") +
                "   [format: " + formats[0][0] + "]");
    if (distinct.some(function (k) { return k.indexOf("TEXT(") === 0; })) {
      console.log("     ^ TEXT found. The script writes real Dates, so this column " +
                  "will end up mixed. Reformat it to Date time and retype the old cells.");
    }
  });
}

/* ============================================================
   TEST FIXTURES

   Everything the test writes is identifiable and removable:
     submission_id  starts with TEST_PREFIX
     email          ends with @example.com  (RFC-reserved, never a real person)
     address        TEST_ADDRESS, deliberately not a real street
   cleanupTestRows() keys on exactly those, so it can never touch a real row.
   ============================================================ */
const TEST_PREFIX  = "test-";
const TEST_ADDRESS = "1 Testing Way";
const TEST_UNIT    = "TEST";

/**
 * Find a slot that is genuinely open right now.
 *
 * The old fixture hardcoded "2026-08-14" / "9-11 AM" — a date and a window-style
 * time that never existed in AVAILABILITY, which publishes single start times
 * like "8:00 AM". Every run therefore reported a conflict and the happy path of
 * the write-back was never exercised at all. Reading the real sheet means the
 * test cannot drift from the data again.
 *
 * Returns { date, time, row, cleaner } or null.
 */
function findOpenSlot() {
  try {
    const ops = opsBook();   // r44: once per request
    const av  = ops.getSheetByName(AVAILABILITY_TAB);
    if (!av) return null;
    /* r33: the Ops workbook's own timezone, not this project's. */
    const opsTz = sheetTimeZone(ops);
    const headers = sheetHeaders(av);
    const iDate = headers.indexOf("date"),
          iTime = headers.indexOf("start_time"),
          iStat = headers.indexOf("status"),
          iCln  = headers.indexOf("cleaner_id");
    if (iDate === -1 || iTime === -1 || iStat === -1) return null;
    const last = av.getLastRow();
    if (last < 2) return null;
    const rows = av.getRange(2, 1, last - 1, headers.length).getValues();
    const todayKey = slotDateKey(new Date(), opsTz);

    /* Prefer a slot a customer could actually book. AVAILABILITY accumulates
       past rows that are still marked open — nothing expires them — and taking
       the first one would test the write-back against a date the feed never
       publishes. Fall back to any open row so the test still runs on a sheet
       with no future availability, and say which happened. */
    let fallback = null;
    for (let r = 0; r < rows.length; r++) {
      if (String(rows[r][iStat]).trim().toLowerCase() !== SLOT_OPEN) continue;
      const hit = {
        date: slotDateKey(rows[r][iDate], opsTz),
        time: slotTimeLabel(rows[r][iTime], opsTz),
        row:  r + 2,
        cleaner: iCln === -1 ? "" : rows[r][iCln],
        past: false,
      };
      if (hit.date >= todayKey) return hit;              // ISO dates sort as strings
      if (!fallback) { hit.past = true; fallback = hit; }
    }
    if (fallback) return fallback;
  } catch (err) {
    console.error("findOpenSlot failed: " + err);
  }
  return null;
}

/**
 * End-to-end exercise against the LIVE workbooks: a slot booking on a real open
 * slot, a preference booking, a repeat customer, a move-out, and an idempotency
 * replay. Cleans up after itself.
 *
 * What to check in the log:
 *   slot booking      slot_action "booked", property_action "created"
 *   preference        slot_action "skipped" — there is no slot to flip
 *   repeat            lead_action "matched", property_action "matched"
 *   move-out          add_on_rev 0 in the sheet, not 85
 *   replay            duplicate true, and nothing changes anywhere
 */
/* ---------- portal links, minted on demand ---------- */

/**
 * Print the portal link for every partner company. RUN THIS FROM THE EDITOR.
 *
 * A BOOKING HAS NEVER BEEN REQUIRED. The token is a pure HMAC of the vendor id,
 * so the link exists the moment the VENDORS row does, never expires and never
 * changes. Until r17 there was simply no zero-argument entry point to print it
 * from — the editor's Run button cannot pass arguments.
 *
 * This is how a partner is onboarded, and how one is pitched: add the row, run
 * this, send them the link. A row with `client_visible = FALSE` has a fully
 * working portal that no customer can ever reach, which is exactly what a
 * prospect should have — `status` does not gate the portal, only the token and
 * the row's existence do.
 *
 * Read-only. Writes nothing, to any tab.
 */

/**
 * Offer a plan for every past booking that was sold with a cadence.
 * RUN THIS FROM THE EDITOR, once, after r38 is deployed and the
 * RECURRING_PLANS tab exists.
 *
 * SAFE TO RUN TWICE. planAlreadyOffered() refuses a booking that already has a
 * plan, so a second pass writes nothing and says so. That guard exists for
 * exactly this caller — doPost never reaches it, because a replayed submission
 * is answered upstream.
 *
 * Reads JOBS. Writes only RECURRING_PLANS. No booking is touched, no slot is
 * held and no vendor is assigned — a backfilled plan is an offer like any
 * other, and the customer still has to confirm it.
 */
function backfillRecurringPlans() {
  var lines = [];
  var say = function (s) { lines.push(s); };
  try {
    var ss = SPREADSHEET_ID ? SpreadsheetApp.openById(SPREADSHEET_ID)
                            : SpreadsheetApp.getActiveSpreadsheet();

    var plans = ss.getSheetByName(RECURRING_PLANS_TAB);
    if (!plans) {
      say("No " + RECURRING_PLANS_TAB + " tab in this workbook.");
      say("Create it first — the column list is in docs/SCHEMA.md.");
      return finish(lines);
    }

    var jobs = ss.getSheetByName(JOBS_TAB);
    if (!jobs) { say("No " + JOBS_TAB + " tab."); return finish(lines); }
    var h = sheetHeaders(jobs);
    var last = jobs.getLastRow();
    if (last < 2) { say("No bookings yet."); return finish(lines); }

    var rows = jobs.getRange(2, 1, last - 1, h.length).getValues();
    var at = function (row, name) { var i = h.indexOf(name); return i === -1 ? "" : row[i]; };

    var offered = 0, already = 0, noCadence = 0, notFirst = 0, unreadable = 0;

    for (var r = 0; r < rows.length; r++) {
      var row = rows[r];
      var jobId = String(at(row, "job_id") || "").trim();
      if (!jobId) continue;

      var meta = {};
      try { meta = JSON.parse(at(row, "quote_meta") || "{}") || {}; }
      catch (meta_err) { meta = {}; }

      /* The payload createRecurringPlan expects, rebuilt from the stored row.
         The cadence prices live in quote_meta and have since the calculator
         shipped, so a backfilled plan quotes what the customer was shown
         rather than a number recomputed against today's table. */
      var data = {
        service_type:        at(row, "service_type"),
        frequency_selected:  at(row, "frequency"),
        recurring_weekly:    meta.recurring_weekly,
        recurring_biweekly:  meta.recurring_biweekly,
        recurring_monthly:   meta.recurring_monthly,
      };
      var record = { job_id: jobId, lead_id: String(at(row, "lead_id") || "") };
      var ids = {
        contact_id:  String(at(row, "contact_id") || ""),
        property_id: String(at(row, "property_id") || ""),
      };

      var outcome;
      try {
        outcome = createRecurringPlan(ss, data, record, ids);
      } catch (rowErr) {
        unreadable++;
        say("  " + jobId + " — skipped, could not be read");
        continue;
      }

      if (outcome === "offered")             { offered++;   say("  " + jobId + " — plan offered"); }
      else if (outcome === "already offered"){ already++; }
      else if (outcome === "no cadence")     { noCadence++; }
      else if (outcome === "not a first clean") { notFirst++; }
      else { say("  " + jobId + " — " + outcome); }
    }

    say("");
    say("Plans offered now:        " + offered);
    say("Already had one:          " + already);
    say("No cadence (one-off):     " + noCadence);
    say("Not a first clean:        " + notFirst);
    if (unreadable) say("Unreadable rows:          " + unreadable);
    say("");
    say("Each offer is open for " + PLAN_WINDOW_DAYS + " days from now. Nothing was");
    say("booked, no slot was held and no vendor was assigned.");

  } catch (err) {
    say("Backfill stopped before finishing: " + err);
  }
  return finish(lines);
}

function printVendorLinks() {
  var sheet = opsBook().getSheetByName(VENDORS_TAB);
  if (!sheet) { console.log("No " + VENDORS_TAB + " tab in the Ops workbook."); return; }

  var h = sheetHeaders(sheet);
  var last = sheet.getLastRow();
  if (last < 2) { console.log(VENDORS_TAB + " has no rows yet."); return; }

  var rows = sheet.getRange(2, 1, last - 1, h.length).getValues();
  var iId = h.indexOf("vendor_id"),
      iNm = h.indexOf("display_name"),
      iSt = h.indexOf("status"),
      iCv = h.indexOf("client_visible");
  if (iId === -1) { console.log(VENDORS_TAB + " has no vendor_id column."); return; }

  var out = [];
  for (var r = 0; r < rows.length; r++) {
    var id = String(rows[r][iId] || "").trim();
    if (!id) continue;
    var name = iNm === -1 ? "" : String(rows[r][iNm] || "").trim();
    var status = iSt === -1 ? "?" : String(rows[r][iSt] || "(blank)").trim();
    var seen = iCv !== -1 && truthy(rows[r][iCv]);
    out.push(
      id + "  " + (name || "(no display name yet)") + "\n" +
      "    status " + status + "  ·  " +
        (seen ? "shown on customer tickets" : "hidden from customers") + "\n" +
      "    " + vendorUrl(id));
  }

  console.log(out.length ? out.join("\n\n")
                         : "No vendor_id values in " + VENDORS_TAB + ".");
}

/**
 * Print the portal link for every customer. RUN THIS FROM THE EDITOR.
 *
 * Deliberately separate from printVendorLinks: this prints a working credential
 * for every customer on the sheet, which should be something you chose to do
 * rather than a side effect of looking up a partner.
 *
 * The link is the same one the booking confirmation carries. It does not expire
 * and does not change, so re-sending it is always safe.
 *
 * Read-only, and prints no address, phone or email — a name and a link is all
 * anyone needs to send somebody their own portal.
 */
function printCustomerLinks() {
  var ss = SPREADSHEET_ID ? SpreadsheetApp.openById(SPREADSHEET_ID)
                          : SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(LEADS_TAB);
  if (!sheet) { console.log("No " + LEADS_TAB + " tab."); return; }

  var h = sheetHeaders(sheet);
  var last = sheet.getLastRow();
  if (last < 2) { console.log(LEADS_TAB + " has no rows yet."); return; }

  var iCid = h.indexOf("contact_id"), iNm = h.indexOf("name");
  if (iCid === -1) {
    console.log(LEADS_TAB + " has no contact_id column — add it and re-run.");
    return;
  }

  var rows = sheet.getRange(2, 1, last - 1, h.length).getValues();
  var out = [], blanks = 0;
  for (var r = 0; r < rows.length; r++) {
    var id = String(rows[r][iCid] || "").trim();
    if (!id) { blanks++; continue; }
    var name = iNm === -1 ? "" : String(rows[r][iNm] || "").trim();
    out.push((name || "(no name)") + "\n    " + portalUrl(id));
  }

  console.log(out.length ? out.join("\n\n") : "No contact_id values yet.");
  /* A blank contact_id is not an error — it fills itself on that customer's
     next booking. Saying how many are waiting beats silence. */
  if (blanks) {
    console.log("\n" + blanks + " row(s) have no contact_id yet — each gets one " +
                "automatically on that customer's next booking.");
  }
}

function testPayload() {
  const stamp = Date.now();
  const open  = findOpenSlot();

  if (open) {
    console.log("Using a real open slot: " + open.date + " " + open.time +
                " (AVAILABILITY row " + open.row + (open.cleaner ? ", " + open.cleaner : "") + ")");
    if (open.past) {
      console.log("  NOTE: that slot is in the PAST and no customer could book it. " +
                  "The write-back is still exercised, but AVAILABILITY has no future " +
                  "open row — stale rows are never expired. Worth clearing out.");
    }
  } else {
    console.log("NO OPEN SLOT FOUND — the slot bookings will report a conflict, which " +
                "is correct behaviour but does not exercise the write-back. Add an " +
                "`open` row to AVAILABILITY to test it properly.");
  }

  const base = {
    event: "quote_reserved", event_type: "reservation",
    timestamp: nowIso(), submitted_at: nowIso(),
    zip: "02134", zip_tier: "core", bedrooms: 2, bathrooms: 1,
    service: "first_clean", service_type: "first_clean", condition: "standard",
    addon_fridge: true, addon_oven: false, modifiers_applied: ["Inside the fridge"],
    addon_total: 45, frequency_selected: "biweekly",
    quote_price: 214, first_visit_total: 214, original_price: 383,
    discount_applied: "First clean 50% off", steady_state_price: 122,
    recurring_weekly: 111, recurring_biweekly: 122, recurring_monthly: 142,
    name: "Test Customer", email: "Test.Customer@Example.com  ", phone: "(617) 555-0100",
    address: TEST_ADDRESS, unit: TEST_UNIT, unit_label: "2 BR / 1 BA",
    src: "dh-bh-01", src_first: "dh-bh-01", src_chain: "dh-bh-01",
    segment: "pro", utm_source: "poster", utm_medium: "print", page_path: "/",
  };

  const slot = Object.assign({}, base, {
    submission_id: TEST_PREFIX + stamp + "-slot",
    slot_date: open ? open.date : "2026-01-01",
    slot_time: open ? open.time : "9:00 AM",
    customer_notes: "We have a friendly dog, keep the back door shut.",
    pets_flag: true,
  });

  const pref = Object.assign({}, base, {
    submission_id: TEST_PREFIX + stamp + "-pref",
    email: "someone.else@example.com",
    schedule_preference: "earlier", time_preference: "earlier",
    schedule_preference_label: "Earlier in the Day",
    customer_notes: "No pets. Lockbox on the door.",
    pets_flag: false,
  });

  /* Same person as `slot`, different casing and a different tag. Expect NO new
     LEADS row, source_history appended, last_touch bumped, first_touch
     unchanged, and a second JOBS row. Deliberately no slot — booking the same
     open slot twice would be a conflict by design, tested separately below. */
  const repeat = Object.assign({}, base, {
    submission_id: TEST_PREFIX + stamp + "-repeat",
    email: "TEST.CUSTOMER@example.com",
    src: "ref-jordan-m", src_first: "dh-bh-01",
    src_chain: "dh-bh-01>ref-jordan-m",
    time_preference: "later", schedule_preference: "later",
    customer_notes: "Same dog as last time.",
  });

  const moveOut = Object.assign({}, base, {
    submission_id: TEST_PREFIX + stamp + "-moveout",
    email: "moveout@example.com",
    service: "move_out", service_type: "move_out",
    modifiers_applied: [], addon_total: 0,
    quote_price: 536, first_visit_total: 536,
    time_preference: "earlier", schedule_preference: "earlier",
  });

  [slot, pref, repeat, moveOut].forEach(function (p) {
    console.log(p.submission_id + " -> " +
                doPost({ postData: { contents: JSON.stringify(p) } }).getContent());
  });

  /* Booking the SAME slot again must conflict without failing the booking. */
  if (open) {
    const clash = Object.assign({}, slot, {
      submission_id: TEST_PREFIX + stamp + "-clash",
      email: "clash@example.com",
    });
    console.log("same-slot clash -> " +
                doPost({ postData: { contents: JSON.stringify(clash) } }).getContent());
  }

  console.log("idempotency replay -> " +
              doPost({ postData: { contents: JSON.stringify(slot) } }).getContent());

  /* DELIBERATELY NOT CLEANING UP HERE.
     An earlier version called cleanupTestRows() at the end. It deleted the rows
     about six seconds after writing them — before anyone could look at the
     sheet, which is the entire reason to run this by hand. The execution log
     only proves the calls returned ok; it says nothing about whether `notes` is
     populated, whether pets_flag is TRUE, or whether add_on_rev is 0 on the
     move-out. Those are visible in the sheet or nowhere. */
  console.log("");
  console.log("=== ROWS ARE STILL IN THE SHEETS — GO AND LOOK ===");
  console.log("");
  console.log("JOBS — the five rows tagged " + TEST_PREFIX + stamp);
  console.log("  notes           populated on EVERY row, both scheduling shapes.");
  console.log("                  This is the bug the whole rebuild started from.");
  console.log("  customer_notes  the customer's words only, never merged into notes.");
  console.log("  pets_flag       TRUE on the dog rows, FALSE on the no-pets one.");
  console.log("  add_on_rev      0 on the move-out row, NOT 85 — fridge and oven are");
  console.log("                  bundled into that multiplier.");
  console.log("  scheduled_date  filled on the slot row, blank on the preference rows.");
  console.log("  start_time      a real window on the slot row, the preference label");
  console.log("                  on the others — never blank.");
  console.log("  ops columns     completed_date, cleaner, duration_min, photos_passed,");
  console.log("                  payment_status all still empty.");
  console.log("");
  console.log("LEADS — four rows, one per distinct email");
  console.log("  the repeat booking did NOT create a fifth: same person, matched.");
  console.log("  source_history  'dh-bh-01, ref-jordan-m' on the repeat customer.");
  console.log("  first_touch     a real date, IDENTICAL before and after the repeat.");
  console.log("  last_touch      a real date, LATER than first_touch on that row.");
  console.log("  operator columns (status, dnc_scrub, ltv, notes...) still empty.");
  console.log("");
  console.log("PROPERTIES — exactly ONE row for " + TEST_ADDRESS);
  console.log("  five bookings, one property. beds/baths/zip filled, deed and");
  console.log("  operator columns untouched.");
  if (open) {
    console.log("");
    console.log("OPS / AVAILABILITY row " + open.row + " — status 'booked', job_id set.");
    console.log("  The clash booking did NOT flip a second row.");
  }
  console.log("");
  console.log("Also check your inbox: 5 emails, one subject with · SLOT CONFLICT.");
  console.log("");
  console.log(">>> WHEN YOU ARE DONE LOOKING, RUN  cleanupTestRows()  <<<");
  console.log("    It removes every row above and reopens the slot.");
}

/**
 * Remove everything testPayload wrote and reopen any slot it booked.
 *
 * Safe by construction: it only ever deletes rows whose submission_id starts
 * with TEST_PREFIX, whose email is @example.com, or whose property_key came
 * from TEST_ADDRESS. A real booking matches none of those.
 *
 * Runnable on its own if a test run failed part-way through.
 */
function cleanupTestRows() {
  const ss = SPREADSHEET_ID ? SpreadsheetApp.openById(SPREADSHEET_ID)
                            : SpreadsheetApp.getActiveSpreadsheet();
  const report = [];

  /* --- reopen AVAILABILITY rows this test booked --- */
  try {
    const av = SpreadsheetApp.openById(OPS_SPREADSHEET_ID).getSheetByName(AVAILABILITY_TAB);
    const h  = sheetHeaders(av);
    const iStat = h.indexOf("status"), iJob = h.indexOf("job_id");
    const last  = av.getLastRow();
    let reopened = 0;
    if (iStat !== -1 && iJob !== -1 && last > 1) {
      const rows = av.getRange(2, 1, last - 1, h.length).getValues();
      for (let r = 0; r < rows.length; r++) {
        /* Only rows whose job_id belongs to a test JOBS row we are about to
           delete. Matching on job_id, not status, so an operator's own booking
           can never be reopened. */
        if (!isSet(rows[r][iJob])) continue;
        if (!isTestJobId(ss, rows[r][iJob])) continue;
        av.getRange(r + 2, iStat + 1).setValue(SLOT_OPEN);
        av.getRange(r + 2, iJob + 1).setValue("");
        reopened++;
      }
    }
    report.push("AVAILABILITY rows reopened: " + reopened);
  } catch (err) {
    report.push("AVAILABILITY cleanup FAILED: " + err);
  }

  /* --- delete rows, bottom-up so indices stay valid --- */
  report.push(deleteMatching(ss, JOBS_TAB, "submission_id",
    function (v) { return String(v).indexOf(TEST_PREFIX) === 0; }));
  report.push(deleteMatching(ss, LEADS_TAB, "email",
    function (v) { return /@example\.com$/i.test(String(v).trim()); }));
  /* PROPERTY_MEMORY rows carry ONLY a property_id — there is no address on them
     to match "TESTING-WAY" against. So collect the ids off the test PROPERTIES
     rows BEFORE those rows are deleted. Doing it after loses the link and
     leaves the memory row orphaned, which is exactly what r9 shipped with. */
  const testPropertyIds = idsOfMatchingProperties(ss,
    function (key) { return String(key).toUpperCase().indexOf("TESTING-WAY") !== -1; });

  report.push(deleteMatching(ss, PROPERTIES_TAB, "property_key",
    function (v) { return String(v).toUpperCase().indexOf("TESTING-WAY") !== -1; }));
  report.push(deleteMatching(ss, PROPERTY_MEMORY_TAB, "property_id",
    function (v) { return testPropertyIds.indexOf(String(v).trim()) !== -1; }));
  report.push(deleteMatching(ss, EVENTS_TAB, "submission_id",
    function (v) { return String(v).indexOf(TEST_PREFIX) === 0; }));

  /* Sweep any memory row left pointing at a property that no longer exists —
     from an earlier test run, or a property deleted by hand. Only BLANK rows
     are removed: one carrying real knowledge is reported and left alone, on the
     principle that nothing here should ever silently delete what a person
     learned by going to the home. */
  report.push(sweepOrphanMemoryRows(ss));

  console.log("--- cleanup ---");
  report.forEach(function (line) { console.log("  " + line); });
}

/** True if this job_id belongs to a JOBS row created by testPayload. */
function isTestJobId(ss, jobId) {
  const jobs = ss.getSheetByName(JOBS_TAB);
  if (!jobs) return false;
  const h = sheetHeaders(jobs);
  const iJob = h.indexOf("job_id"), iSub = h.indexOf("submission_id");
  if (iJob === -1 || iSub === -1) return false;
  const last = jobs.getLastRow();
  if (last < 2) return false;
  const rows = jobs.getRange(2, 1, last - 1, h.length).getValues();
  const needle = String(jobId).trim();
  for (let r = 0; r < rows.length; r++) {
    if (String(rows[r][iJob]).trim() !== needle) continue;
    return String(rows[r][iSub]).indexOf(TEST_PREFIX) === 0;
  }
  return false;
}

/** Delete rows of `tab` where `column` satisfies `pred`. Bottom-up. */
/** property_id values from PROPERTIES rows whose key satisfies `pred`. */
function idsOfMatchingProperties(ss, pred) {
  const sheet = ss.getSheetByName(PROPERTIES_TAB);
  if (!sheet) return [];
  const h = sheetHeaders(sheet);
  const iKey = h.indexOf("property_key"), iId = h.indexOf("property_id");
  const last = sheet.getLastRow();
  if (iKey === -1 || iId === -1 || last < 2) return [];
  const rows = sheet.getRange(2, 1, last - 1, h.length).getValues();
  const out = [];
  for (let r = 0; r < rows.length; r++) {
    if (pred(rows[r][iKey]) && isSet(rows[r][iId])) out.push(String(rows[r][iId]).trim());
  }
  return out;
}

/**
 * Delete PROPERTY_MEMORY rows that point at a property_id no longer present in
 * PROPERTIES — but ONLY when the row is otherwise empty.
 *
 * A blank orphan is bookkeeping left behind by a deleted property and is safe
 * to drop. An orphan carrying access notes, a pet, a parking quirk is a person's
 * knowledge that outlived a mis-deleted property row; it is reported for a human
 * to reattach, never removed. Losing that is the one failure this whole table
 * exists to prevent.
 */
function sweepOrphanMemoryRows(ss) {
  const mem = ss.getSheetByName(PROPERTY_MEMORY_TAB);
  if (!mem) return PROPERTY_MEMORY_TAB + ": no tab";
  const props = ss.getSheetByName(PROPERTIES_TAB);
  if (!props) return PROPERTY_MEMORY_TAB + ": PROPERTIES missing — not sweeping";

  const mh = sheetHeaders(mem), iMemId = mh.indexOf("property_id");
  const ph = sheetHeaders(props), iPropId = ph.indexOf("property_id");
  if (iMemId === -1 || iPropId === -1) return PROPERTY_MEMORY_TAB + ": no property_id column";

  const pLast = props.getLastRow();
  const live = pLast > 1
    ? props.getRange(2, iPropId + 1, pLast - 1, 1).getValues()
        .map(function (r) { return String(r[0]).trim(); }).filter(Boolean)
    : [];

  const mLast = mem.getLastRow();
  if (mLast < 2) return PROPERTY_MEMORY_TAB + ": no data rows";
  const rows = mem.getRange(2, 1, mLast - 1, mh.length).getValues();

  /* Columns that do not count as content: the id itself, and the timestamp the
     webhook stamps when it creates the row. */
  const ignore = [iMemId, mh.indexOf("updated_at")];

  let deleted = 0; const kept = [];
  for (let r = rows.length - 1; r >= 0; r--) {
    const id = String(rows[r][iMemId]).trim();
    if (!id || live.indexOf(id) !== -1) continue;          // no id, or still live
    const hasContent = rows[r].some(function (v, c) {
      return ignore.indexOf(c) === -1 && isSet(v);
    });
    if (hasContent) { kept.push(id); continue; }
    mem.deleteRow(r + 2);
    deleted++;
  }

  let msg = PROPERTY_MEMORY_TAB + ": " + deleted + " blank orphan(s) deleted";
  if (kept.length) {
    msg += " — KEPT " + kept.length + " orphan(s) WITH CONTENT: " + kept.reverse().join(", ") +
           ". Reattach these to a property by hand; nothing here deletes what a person learned.";
  }
  return msg;
}

function deleteMatching(ss, tabName, column, pred) {
  const sheet = ss.getSheetByName(tabName);
  if (!sheet) return tabName + ": no tab";
  const h = sheetHeaders(sheet);
  const i = h.indexOf(column);
  if (i === -1) return tabName + ': no "' + column + '" column';
  const last = sheet.getLastRow();
  if (last < 2) return tabName + ": no data rows";

  const values = sheet.getRange(2, i + 1, last - 1, 1).getValues();
  let deleted = 0;
  for (let r = values.length - 1; r >= 0; r--) {      // bottom-up keeps indices valid
    if (pred(values[r][0])) { sheet.deleteRow(r + 2); deleted++; }
  }
  return tabName + ": " + deleted + " test row(s) deleted";
}

/* BEGIN BOOKING PHOTOS */
/* Private room photo records. Images live in R2; Sheets owns authorization. */

const BOOKING_PHOTOS_HEADERS = ["photo_id", "job_id", "room_key", "object_key",
  "status", "bytes", "created_at", "updated_at", "booking_link"];

function bookingPhotoRows(ss) {
  /* r44. Read once per GET — the portal used to read this whole tab again for
     every booking on the account, finished ones included. */
  var table = readTable(ss, "BOOKING_PHOTOS");
  if (!table || !table.rows.length) return [];
  var h = table.headers;
  return table.rows.map(function (r, i) {
    var out = { sheetRow: i + 2 };
    BOOKING_PHOTOS_HEADERS.forEach(function (k) { out[k] = r[h.indexOf(k)]; });
    return out;
  });
}

function publicBookingPhotos(ss, jobId) {
  return bookingPhotoRows(ss).filter(function (r) {
    return r.job_id === jobId && r.status === "READY";
  }).map(function (r) {
    // Explicit whitelist. Storage keys and credentials never enter view models.
    return { id: String(r.photo_id), roomKey: String(r.room_key),
      createdAt: String(r.created_at) };
  });
}

function vendorPortalAccess(ss, propertyId) {
  var a = getPropertyAccess(ss, propertyId);
  var fields = [];
  ACCESS_QUESTIONS.forEach(function (q) {
    var choice = accessChoice(q.field, String(a[q.field + "Choice"] || "").toUpperCase());
    if (!choice) return;
    var value = choice.label;
    // Only the choice and permitted detail. Never entry_code or secret timestamps.
    if (choice.detail && !choice.secret && a[q.field + "Detail"]) {
      value += ": " + a[q.field + "Detail"];
    }
    fields.push({ key: q.field, label: q.label, value: value });
  });
  if (a.petNotes) fields.push({ key: "pets", label: "Pets", value: a.petNotes });
  return fields;
}

function handleBookingPhoto(ss, data) {
  // Only the Worker may reserve/commit storage metadata. A portal credential
  // alone must not let a caller invent successful uploads via the public /exec.
  var secret = PropertiesService.getScriptProperties().getProperty("PHOTO_BRIDGE_SECRET");
  if (!secret || String(data.bridge_token || "") !== secret) return json({ ok: false, error: "not_found" });
  /* r49. A read takes no lock (see doPost). Strict equality, so nothing but
     the plain string "read" can skip it; the read branches below write nothing. */
  var lock = data.action === "read" ? null : LockService.getScriptLock();
  try {
    if (lock) lock.waitLock(8000);
    if (data.purpose === "completion") return handleCompletionPhoto(ss, data);
    if (data.action === "cleanup" || data.action === "purged") return cleanupBookingPhotos(ss, data);
    var jobId = String(data.job_id || "");
    var kind = String(data.auth_kind || "");
    var tok = String(data.t || "");
    if (!tok || !jobId) return json({ ok: false, error: "not_found" });
    var booking = null;
    if (kind === "portal") {
      var contactId = String(data.contact_id || "");
      if (!contactId || portalToken(contactId) !== tok) return json({ ok: false, error: "not_found" });
      var contact = getContact(ss, contactId);
      if (contact) {
        var mine = getContactBookings(ss, contact.leadId);
        for (var k = 0; k < mine.length; k++) if (mine[k].bookingId === jobId) booking = mine[k];
      }
    } else if ((kind === "client" || kind === "partner") && ticketToken(jobId, kind) === tok) {
      booking = getBooking(ss, jobId);
    }
    if (!booking) return json({ ok: false, error: "not_found" });
    if (kind === "partner" && booking.completedDate) return json({ ok: false, error: "expired" });
    var action = String(data.action || "");
    if (["begin", "commit", "read", "delete"].indexOf(action) < 0) return json({ ok: false, error: "bad_action" });
    if (action !== "read" && kind === "partner") return json({ ok: false, error: "not_found" });
    if (action !== "read" && booking.completedDate) return json({ ok: false, error: "closed" });
    var room = String(data.room_key || "");
    if (!deriveRooms(booking.beds, booking.baths).some(function (r) { return r.key === room; })) {
      return json({ ok: false, error: "unknown_room" });
    }
    var photoId = String(data.photo_id || "");
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(photoId)) {
      return json({ ok: false, error: "bad_photo" });
    }
    var rows = bookingPhotoRows(ss);
    var record = null;
    rows.forEach(function (r) { if (r.photo_id === photoId) record = r; });
    if (record && (record.job_id !== jobId || record.room_key !== room)) return json({ ok: false, error: "not_found" });
    var now = new Date();
    var sheet = ss.getSheetByName("BOOKING_PHOTOS");
    function result() { return json({ ok: true, object_key: record.object_key, status: record.status,
      photo: { id: photoId, roomKey: room, createdAt: String(record.created_at) } }); }
    function status(value) {
      var h = sheetHeaders(sheet);
      sheet.getRange(record.sheetRow, h.indexOf("status") + 1).setValue(value);
      sheet.getRange(record.sheetRow, h.indexOf("updated_at") + 1).setValue(now);
      record.status = value;
    }
    if (action === "begin") {
      if (record) {
        if (record.status === "READY") return result();
        // A retry cannot revive a deleted or expired reservation.
        if (record.status !== "PENDING" || now - new Date(record.created_at) > 600000) return json({ ok: false, error: "retry_upload" });
        return result();
      }
      var bytes = Number(data.bytes);
      if (!Number.isInteger(bytes) || bytes < 4 || bytes > 1500000) return json({ ok: false, error: "bad_size" });
      var count = rows.filter(function (r) {
        return r.job_id === jobId && r.room_key === room &&
          (r.status === "READY" || (r.status === "PENDING" && now - new Date(r.created_at) <= 600000));
      }).length;
      if (count >= 3) return json({ ok: false, error: "photo_limit" });
      if (!sheet) {
        assertWritable("BOOKING_PHOTOS");
        sheet = ss.insertSheet("BOOKING_PHOTOS");
        sheet.appendRow(BOOKING_PHOTOS_HEADERS);
        sheet.setFrozenRows(1);
      }
      record = { photo_id: photoId, job_id: jobId, room_key: room,
        object_key: "booking-photos/" + photoId + ".jpg", status: "PENDING", bytes: bytes,
        created_at: now, updated_at: now, booking_link: ticketUrl(jobId, "client") };
      sheet.appendRow(sheetHeaders(sheet).map(function (h) { return record[h] === undefined ? "" : record[h]; }));
      return result();
    }
    if (!record) return json({ ok: false, error: "not_found" });
    if (action === "read") return record.status === "READY" ? result() : json({ ok: false, error: "not_found" });
    if (action === "delete") { status("DELETED"); return result(); }
    if (record.status === "READY") return result();
    if (record.status !== "PENDING" || now - new Date(record.created_at) > 600000) return json({ ok: false, error: "retry_upload" });
    status("READY");
    return result();
  } catch (_) {
    return json({ ok: false, error: "photo_unavailable" });
  } finally {
    if (lock) lock.releaseLock();
  }
}

/* The cleaner's room photos. Append-only and NEVER passed to customer-photo
 * cleanup. The vendor company is stamped at upload, so a job moved to another
 * company does not hand them the first company's photos.
 */
const COMPLETION_PHOTOS_HEADERS = ["photo_id", "job_id", "vendor_id", "room_key",
  "object_key", "status", "bytes", "created_at", "updated_at"];

function completionPhotoRows(ss) {
  var table = readTable(ss, "COMPLETION_PHOTOS");
  if (!table) return [];
  return table.rows.map(function (row, i) {
    var out = { sheetRow: i + 2 };
    COMPLETION_PHOTOS_HEADERS.forEach(function (key) { out[key] = row[table.headers.indexOf(key)]; });
    return out;
  });
}

function completionPhotoPublic(r) {
  return { id: String(r.photo_id), roomKey: String(r.room_key),
    createdAt: String(r.created_at), purpose: "completion" };
}

// Called only after Worker bridge authentication and, for begin/commit, the
// lock. A read (r49) holds no lock, so the read path must never write.
function handleCompletionPhoto(ss, data) {
  var action = String(data.action || ""), kind = String(data.auth_kind || "");
  var id = String(data.job_id || ""), roomKey = String(data.room_key || ""), tok = String(data.t || "");
  var photoId = String(data.photo_id || "");
  if (["begin", "commit", "read"].indexOf(action) < 0) return json({ ok: false, error: "bad_action" });
  if (!tok || !id || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(photoId)) {
    return json({ ok: false, error: "not_found" });
  }
  var rows = completionPhotoRows(ss), record = null;
  rows.forEach(function (r) { if (r.photo_id === photoId) record = r; });
  if (record && (record.job_id !== id || record.room_key !== roomKey)) return json({ ok: false, error: "not_found" });
  var booking = null;
  if (kind === "vendor") {
    var vendorId = String(data.vendor_id || "");
    if (action !== "read" || !vendorId || vendorToken(vendorId) !== tok || !getVendor(ss, vendorId) ||
        !record || record.vendor_id !== vendorId) return json({ ok: false, error: "not_found" });
  } else if (kind === "partner" && ticketToken(id, "partner") === tok) {
    booking = getBooking(ss, id);
    if (!booking || !booking.vendorId) return json({ ok: false, error: "not_found" });
    if (booking.completedDate || String(booking.status).toLowerCase() === "cancelled") return json({ ok: false, error: "closed" });
    if (record && record.vendor_id !== booking.vendorId) return json({ ok: false, error: "not_found" });
  } else return json({ ok: false, error: "not_found" });
  function result() { return json({ ok: true, status: record.status, object_key: record.object_key,
    photo: completionPhotoPublic(record) }); }
  if (action === "read") return record && record.status === "READY" ? result() : json({ ok: false, error: "not_found" });
  var room = deriveRooms(booking.beds, booking.baths).filter(function (r) { return r.key === roomKey; })[0];
  if (!room) return json({ ok: false, error: "unknown_room" });
  var sheet = ss.getSheetByName("COMPLETION_PHOTOS"), now = new Date();
  if (action === "begin") {
    // Retrying an upload keeps its ID and original bytes, including after a lost response.
    if (record) return result();
    var bytes = Number(data.bytes);
    if (!Number.isInteger(bytes) || bytes < 4 || bytes > 1500000) return json({ ok: false, error: "bad_size" });
    var count = rows.filter(function (r) { return r.job_id === id && r.room_key === roomKey &&
      (r.status === "READY" || now - new Date(r.created_at) < 600000); }).length;
    if (count >= 20) return json({ ok: false, error: "completion_photo_limit" });
    if (!sheet) {
      assertWritable("COMPLETION_PHOTOS"); sheet = ss.insertSheet("COMPLETION_PHOTOS");
      sheet.appendRow(COMPLETION_PHOTOS_HEADERS); sheet.setFrozenRows(1);
    }
    var h = sheetHeaders(sheet);
    if (COMPLETION_PHOTOS_HEADERS.some(function (key) { return h.indexOf(key) < 0; })) return json({ ok: false, error: "photo_unavailable" });
    record = { photo_id: photoId, job_id: id, vendor_id: booking.vendorId,
      room_key: roomKey, object_key: "completion-photos/" + photoId + ".jpg",
      status: "PENDING", bytes: bytes, created_at: now, updated_at: now };
    sheet.appendRow(h.map(function (key) { return record[key] === undefined ? "" : record[key]; }));
    return result();
  }
  if (!record) return json({ ok: false, error: "not_found" });
  if (record.status === "READY") return result();
  if (record.status !== "PENDING") return json({ ok: false, error: "not_found" });
  var headers = sheetHeaders(sheet);
  sheet.getRange(record.sheetRow, headers.indexOf("status") + 1).setValue("READY");
  sheet.getRange(record.sheetRow, headers.indexOf("updated_at") + 1).setValue(now);
  record.status = "READY";
  return result();
}

/* END BOOKING PHOTOS */

// Worker-only maintenance, under the same lock. Never selects READY images.
function cleanupBookingPhotos(ss, data) {
  var sheet = ss.getSheetByName("BOOKING_PHOTOS");
  if (!sheet) return json({ ok: true, photos: [] });
  var h = sheetHeaders(sheet), now = new Date();
  var selected = bookingPhotoRows(ss).filter(function (r) {
    if (data.action === "purged") return r.status === "DELETED" &&
      Array.isArray(data.photo_ids) && data.photo_ids.slice(0, 100).indexOf(r.photo_id) >= 0;
    return r.status === "DELETED" || (r.status === "PENDING" && now - new Date(r.created_at) > 86400000);
  }).slice(0, 100);
  var out = [];
  selected.forEach(function (r) {
    if (r.object_key !== "booking-photos/" + r.photo_id + ".jpg") return;
    sheet.getRange(r.sheetRow, h.indexOf("status") + 1).setValue(data.action === "purged" ? "PURGED" : "DELETED");
    sheet.getRange(r.sheetRow, h.indexOf("updated_at") + 1).setValue(now);
    out.push({ id: String(r.photo_id), object_key: String(r.object_key) });
  });
  return json({ ok: true, photos: out });
}
