/**
 * Serve — Booking webhook (doPost)   ·   LEADS MASTER, servecos.com
 * ==================================================================
 * VERSION STAMP:  2026-09-09  ·  master  ·  r19 — the partner's link, in the email
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
    by hand at dispatch. A booking form cannot know it and must never guess. */
const OPS_OWNED_COLUMNS = ["completed_date", "cleaner", "duration_min", "photos_passed",
                           "payment_status", "partner_payout", "vendor_id", "operator_id"];

const NEW_JOB_STATUS = "new";


/* ============================================================
   2. HEADER_MAP — payload/record key -> EXACT header text
   Built against the 36-column JOBS row 1:

     job_id | lead_id | source | property_key | service_type | frequency |
     condition | beds | baths | quoted_price | add_ons | add_on_rev |
     final_price | scheduled_date | completed_date | cleaner | start_time |
     duration_min | photos_passed | payment_status | job_status | notes |
     submission_id | received_at | name | email | phone | segment |
     src_chain | customer_notes | pets_flag | scheduling_type |
     address | unit | zip | quote_meta

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

   `entry_code` IS WRITE-ONLY. No view model returns it, nothing logs it, and
   two tests assert both. The portal reports only the date it was saved. If
   Leads MASTER is ever shared with anyone outside the business, hide that one
   column — moving this tab to Access MASTER later is a spreadsheet-id change,
   not a redesign. */
const PROPERTY_ACCESS_TAB = "PROPERTY_ACCESS";
const PROPERTY_ACCESS_HEADERS = [
  "property_id",
  "occupancy_choice", "occupancy_detail",
  "entry_choice", "entry_detail", "entry_code", "entry_code_set_at",
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

function doPost(e) {
  const lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (lockErr) { /* proceed rather than drop a lead */ }

  try {
    const data = parseBody(e);
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

    /* Portal writes. Authorised by a portal token and an ownership check
       rather than by a per-job ticket token — see handlePortalWrite. */
    if (eventType === "portal_write") return handlePortalWrite(ss, data);

    /* Vendor portal writes. Authorised by a vendor token, and every field
       checked against a whitelist — a partner may describe themselves, not
       promote themselves. */
    if (eventType === "vendor_write") return handleVendorWrite(data);

    if (!isReservation) return handleEvent(ss, data, eventType);

    const jobs = requireTab(ss, JOBS_TAB);

    /* Idempotency first — a replay must mutate nothing anywhere. */
    if (alreadyWritten(jobs, data.submission_id)) {
      console.log("Duplicate submission_id — no JOBS row, no LEADS mutation: " + data.submission_id);
      return json({ status: "ok", duplicate: true, submission_id: data.submission_id });
    }

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

    try {
      sendReservationEmail(data, sched, leadId, leadResult, propertyResult, slotResult);
    } catch (mailErr) {
      console.error("Email send failed (row was still written): " + mailErr);
    }

    return json({
      status: "ok",
      duplicate: false,
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
    try { lock.releaseLock(); } catch (releaseErr) { /* nothing to do */ }
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
function doGet(e) {
  /* One job ticket, rendered by /j on the site. Everything else is the health
     check that has always been here. */
  var p = (e && e.parameter) || {};
  if (p.job) return handleTicket(p);
  if (p.portal) return handlePortal(p);
  if (p.vendor) return handleVendorPortal(p);
  if (p.property) return handleKnownProperty(p.property);

  return json({ ok: true, service: "serve-booking-webhook", version: "2026-09-09 r19" });
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
  var jobs = requireTab(ss, JOBS_TAB);
  var h = sheetHeaders(jobs);
  var idCol = h.indexOf("job_id");
  if (idCol === -1) return null;

  var last = jobs.getLastRow();
  if (last < 2) return null;

  var ids = jobs.getRange(2, idCol + 1, last - 1, 1).getValues();
  var row = -1;
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]).trim() === String(jobId).trim()) { row = i + 2; break; }
  }
  if (row === -1) return null;

  var values = jobs.getRange(row, 1, 1, h.length).getValues()[0];
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

    /* when */
    scheduledDate:   String(f("scheduled_date") || ""),
    startTime:       String(f("start_time") || ""),
    scheduleSummary: String(f("notes") || ""),
    completedDate:   String(f("completed_date") || "").trim(),
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
    payment: {
      status: String(f("payment_status") || ""),
      paid:   String(f("payment_status") || "").toLowerCase() === "paid",
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
    var mt = ss.getSheetByName(PROPERTY_MEMORY_TAB);
    if (!mt) return empty;
    var mh = sheetHeaders(mt);
    var mi = mh.indexOf("property_id");
    var ml = mt.getLastRow();
    if (mi === -1 || ml < 2) return empty;

    var rows = mt.getRange(2, 1, ml - 1, mh.length).getValues();
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
    var t = ss.getSheetByName(INSTRUCTIONS_TAB);
    if (!t) return out;
    var h = sheetHeaders(t);
    var last = t.getLastRow();
    if (last < 2) return out;
    var idx = function (n) { return h.indexOf(n); };
    if (idx("job_id") === -1) return out;

    var rows = t.getRange(2, 1, last - 1, h.length).getValues();
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
  };
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
  var vendor = buildClientVendorProfile(getVendor(ss, assignment.vendorId));

  var sorted = sortInstructions(instructions);

  return {
    ok: true,
    view: "client",
    bookingId: booking.bookingId,

    booking: {
      serviceCode:  booking.serviceCode,
      serviceLabel: SERVICE_CODES[booking.serviceCode] || booking.serviceLabel,
      frequency:    booking.frequency,
      date:         booking.scheduledDate,
      time:         booking.startTime,
      when:         booking.scheduleSummary,
      status:       booking.status,
      completed:    booking.completedDate,
      addOns:       booking.addOns,
      /* The price the customer agreed to. `final` once an operator sets it,
         otherwise the quote. Never both, so there is nothing to reconcile. */
      price:        booking.price.final || booking.price.quoted,
      /* Real column, filled by hand. There is no Stripe integration, so there
         is no payment link and this must not pretend otherwise. */
      paid:         booking.payment.paid,
      paymentNote:  booking.payment.paid ? "Paid" : "Due at service",
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

  return {
    ok: true,
    view: "partner",
    bookingId: booking.bookingId,

    booking: {
      serviceCode:  booking.serviceCode,
      serviceLabel: SERVICE_CODES[booking.serviceCode] || booking.serviceLabel,
      condition:    booking.condition,
      /* THEIR payout, never the customer's price. Blank until an operator sets
         it at dispatch, and the ticket says "confirmed at dispatch" rather
         than showing a zero — a zero reads as "this job pays nothing". */
      payout:       booking.partnerPayout,
      date:         booking.scheduledDate,
      time:         booking.startTime,
      when:         booking.scheduleSummary,
      status:       booking.status,
      completed:    booking.completedDate,
      addOns:       booking.addOns,
    },

    property: {
      address: booking.address,
      unit:    booking.unit,
      zip:     booking.zip,
      beds:    booking.beds,
      baths:   booking.baths,
      levels:  booking.levels,
    },

    scope: rooms.map(function (r) {
      return { key: r.key, label: r.label, instruction: sorted.rooms[r.key] || "" };
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
  var sheet = ss.getSheetByName(LEADS_TAB);
  if (!sheet) return null;
  var h = sheetHeaders(sheet);
  var ci = h.indexOf("contact_id");
  var li = h.indexOf("lead_id");
  /* Without the column there is no portal. It is documented as a one-line
     addition to LEADS rather than guessed at from an email. */
  if (ci === -1 || li === -1) return null;

  var last = sheet.getLastRow();
  if (last < 2) return null;
  var rows = sheet.getRange(2, 1, last - 1, h.length).getValues();
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
  var jobs = requireTab(ss, JOBS_TAB);
  var h = sheetHeaders(jobs);
  var li = h.indexOf("lead_id");
  var idc = h.indexOf("job_id");
  if (li === -1 || idc === -1) return [];

  var last = jobs.getLastRow();
  if (last < 2) return [];
  var rows = jobs.getRange(2, 1, last - 1, h.length).getValues();

  var out = [];
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][li]).trim().toLowerCase() !== want) continue;
    var id = String(rows[i][idc]).trim();
    if (!id) continue;
    var b = getBooking(ss, id);
    if (b) out.push(b);
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
 * THE CODE NEVER COMES BACK. `entry_code` is read here and deliberately
 * discarded; what is returned is whether one exists and when it was saved, so
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
    var sheet = ss.getSheetByName(PROPERTY_ACCESS_TAB);
    if (!sheet) return empty;
    var h = sheetHeaders(sheet);
    var pi = h.indexOf("property_id");
    var last = sheet.getLastRow();
    if (pi === -1 || last < 2) return empty;
    var rows = sheet.getRange(2, 1, last - 1, h.length).getValues();
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i][pi]).trim() !== want) continue;
      var v = {};
      h.forEach(function (n, idx) { v[n] = rows[i][idx]; });
      return {
        occupancyChoice: String(v.occupancy_choice || ""),
        occupancyDetail: String(v.occupancy_detail || ""),
        entryChoice:     String(v.entry_choice || ""),
        entryDetail:     String(v.entry_detail || ""),
        entryCodeSet:    String(v.entry_code || "").trim() !== "",
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
function buildPortalModel(ss, contact) {
  var bookings = getContactBookings(ss, contact.leadId);
  /* A customer with a standing partner has the same vendor on every row. */
  var vendorMemo = {};

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
    contactId: contact.contactId,
    firstName: contact.firstName,
    name:      contact.name,
    homes:     homes,
    bookings:  bookings.map(function (b) {
      var done = !!b.completedDate;
      var row = {
        bookingId:    b.bookingId,
        serviceCode:  b.serviceCode,
        serviceLabel: SERVICE_CODES[b.serviceCode] || b.serviceLabel,
        date:         b.scheduledDate,
        time:         b.startTime,
        when:         b.scheduleSummary,
        status:       b.status,
        completed:    b.completedDate,
        price:        b.price.final || b.price.quoted,
        paid:         b.payment.paid,
        addOns:       b.addOns,
        propertyLabel: [b.address, b.unit].filter(Boolean).join(", "),
        editable:     !done,
      };
      /* Rooms and instructions only where they can still be acted on. A past
         booking is a receipt, and loading every room of every job a customer
         has ever had would grow the payload for nothing. */
      if (!done) {
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
            if (vendorMemo[vid] === undefined) vendorMemo[vid] = getVendor(ss, vid);
            row.partner = buildClientVendorProfile(vendorMemo[vid]);
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

    if (kind === "instruction") {
      var jobId = String(data.job_id || "").trim();
      var mine = null;
      for (var i = 0; i < bookings.length; i++) {
        if (bookings[i].bookingId === jobId) { mine = bookings[i]; break; }
      }
      /* Not theirs, or not a job at all — the same answer either way. */
      if (!mine) return json({ ok: false, error: "not_found" });
      if (mine.completedDate) return json({ ok: false, error: "closed" });
      return writeInstruction(ss, mine, data);
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
 * ACCESS_QUESTIONS writes its detail to `entry_code`, never to
 * `entry_detail` — so the field a view model reads and the field holding a
 * door code are different cells, and no future edit to the read path can
 * accidentally return one.
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
  set(field + "_choice", choice.key);

  if (choice.secret) {
    /* An empty detail on a secret choice leaves the stored code alone —
       selecting "Access code" again should not wipe a code they set last
       month just because the box renders blank, which it always does. */
    if (detail) {
      set("entry_code", detail);
      set("entry_code_set_at", now);
    }
    set(field + "_detail", "");
  } else {
    set(field + "_detail", choice.detail ? detail : "");
    /* Moving off the code option clears the code. Leaving it behind would
       mean a home whose access says "I'll let you in" still has a live door
       code sitting in the sheet. */
    if (field === "entry") {
      set("entry_code", "");
      set("entry_code_set_at", "");
    }
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

/** The Ops workbook. Never the active spreadsheet — this code runs bound to Leads. */
function opsBook() {
  return SpreadsheetApp.openById(OPS_SPREADSHEET_ID);
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
  var sheet = opsBook().getSheetByName(sheetName);
  if (!sheet) return null;
  var h = sheetHeaders(sheet);
  var i = h.indexOf(idColumn);
  var last = sheet.getLastRow();
  if (i === -1 || last < 2) return null;
  var rows = sheet.getRange(2, 1, last - 1, h.length).getValues();
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
  var sheet = opsBook().getSheetByName(sheetName);
  if (!sheet) return out;
  var h = sheetHeaders(sheet);
  var i = h.indexOf(idColumn);
  var last = sheet.getLastRow();
  if (i === -1 || last < 2) return out;
  var rows = sheet.getRange(2, 1, last - 1, h.length).getValues();
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
    partnerSince:      String(v.partner_since || ""),
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
  var jobs = requireTab(ss, JOBS_TAB);
  var h = sheetHeaders(jobs);
  var vi = h.indexOf("vendor_id");
  var idc = h.indexOf("job_id");
  /* No column means no assignments have ever been recorded — an empty list,
     not an error. The portal says so rather than looking broken. */
  if (vi === -1 || idc === -1) return [];

  var last = jobs.getLastRow();
  if (last < 2) return [];
  var rows = jobs.getRange(2, 1, last - 1, h.length).getValues();

  var out = [];
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][vi]).trim() !== want) continue;
    var b = getBooking(ss, String(rows[i][idc]).trim());
    if (b) out.push(b);
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
           business, and the margin is the model. */
        payout:       b.partnerPayout,
        home:         [b.beds === 0 ? "Studio" : b.beds + " BR",
                       b.baths + " BA"].filter(Boolean).join(" / "),
        /* Address only. No customer name, email or phone — contact routes
           through Serve. */
        address:      [b.address, b.unit].filter(Boolean).join(", "),
        zip:          b.zip,
        ticketUrl:    ticketUrl(b.bookingId, "partner"),
      };
    }),
  };
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
    var tab = ss.getSheetByName(PROPERTIES_TAB);
    if (!tab) return json({ found: false });

    var h = sheetHeaders(tab);
    var iKey = h.indexOf("property_key");
    var last = tab.getLastRow();
    if (iKey === -1 || last < 2) return json({ found: false });

    var rows = tab.getRange(2, 1, last - 1, h.length).getValues();
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
  var props = PropertiesService.getScriptProperties();
  var s = props.getProperty(TICKET_SECRET_KEY);
  if (!s) {
    s = Utilities.getUuid() + "-" + Utilities.getUuid();
    props.setProperty(TICKET_SECRET_KEY, s);
    console.log("Minted a ticket secret. Existing ticket links are unaffected " +
                "because there were none.");
  }
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

  const headers = sheetHeaders(sheet);
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

  const lastRow  = sheet.getLastRow();
  const existing = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, headers.length).getValues() : [];

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

  const headers = sheetHeaders(sheet);
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

  const lastRow  = sheet.getLastRow();
  const existing = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, headers.length).getValues() : [];

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

  const headers = sheetHeaders(sheet);
  const idCol = headers.indexOf("property_id");
  if (idCol === -1) return "skipped (no property_id column)";

  const lastRow = sheet.getLastRow();
  const existing = lastRow > 1 ? sheet.getRange(2, idCol + 1, lastRow - 1, 1).getValues() : [];
  for (let i = 0; i < existing.length; i++) {
    if (String(existing[i][0]).trim() === String(propertyId).trim()) return "already present";
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
const SLOT_RANK_PREFERRED    = 4;
const SLOT_RANK_ORDINARY     = 3;
const SLOT_RANK_AVOID        = 2;
const SLOT_RANK_DISQUALIFIED = 1;

function slotRank(vendorId, serviceCode, memo) {
  if (!vendorId || !serviceCode) return SLOT_RANK_ORDINARY;
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
    const ops = SpreadsheetApp.openById(OPS_SPREADSHEET_ID);
    const av  = ops.getSheetByName(AVAILABILITY_TAB);
    if (!av) throw new Error('Ops workbook "' + ops.getName() + '" has no ' + AVAILABILITY_TAB + ' tab.');
    assertAvailabilityWritable(AVAILABILITY_TAB);

    const headers = sheetHeaders(av);
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

    const lastRow = av.getLastRow();
    if (lastRow < 2) return { ok: true, action: "conflict", reason: "no availability rows" };

    /* Read at write time, not from the customer's cached view. */
    const rows = av.getRange(2, 1, lastRow - 1, headers.length).getValues();

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
      if (slotDateKey(row[iDate]) !== sched.date) continue;
      if (slotTimeLabel(row[iTime]) !== sched.time) continue;
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
 * Date cell -> "YYYY-MM-DD".
 *
 * MUST match ymd() in /apps-script/availability.gs. These are separate script
 * projects so the code cannot be shared, and if the two ever disagree the match
 * silently fails and every booking reports a conflict. Local getters, no
 * timezone conversion, exactly as the feed does it.
 */
function slotDateKey(v) {
  if (!(v instanceof Date)) return String(v).trim();
  return v.getFullYear() + "-" +
         ("0" + (v.getMonth() + 1)).slice(-2) + "-" +
         ("0" + v.getDate()).slice(-2);
}

/**
 * start_time cell -> "9:00 AM".
 * MUST match parseTime()/clockLabel() in /apps-script/availability.gs.
 */
function slotTimeLabel(v) {
  if (v instanceof Date) return clockLabelFor(v.getHours(), v.getMinutes());
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
                slotResult && slotResult.vendorId) +
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
function ticketBlock(jobId, contactId, vendorId) {
  try {
    var customer = contactId
      ? "Customer portal (same link every booking):\n" + portalUrl(contactId) + "\n"
      : "Send to the customer:\n" + ticketUrl(jobId, "client") + "\n" +
        "(per-job link — add a contact_id column to LEADS for a portal link)\n";

    /* r19. The COMPANY's standing portal, not this job. Unassigned is not a
       failure worth hiding: it is every preference booking, so the line
       names the two steps instead of going quiet. */
    var vendor = isSet(vendorId)
      ? "Vendor portal for " + vendorId + " (permanent):\n" + vendorUrl(vendorId) + "\n"
      : "Vendor portal: nobody assigned — this booking consumed no\n" +
        "availability row. Fill vendor_id on the JOBS row, then run\n" +
        "printVendorLinks() in the editor for the link.\n";

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
    const av = SpreadsheetApp.openById(OPS_SPREADSHEET_ID).getSheetByName(AVAILABILITY_TAB);
    if (!av) return null;
    const headers = sheetHeaders(av);
    const iDate = headers.indexOf("date"),
          iTime = headers.indexOf("start_time"),
          iStat = headers.indexOf("status"),
          iCln  = headers.indexOf("cleaner_id");
    if (iDate === -1 || iTime === -1 || iStat === -1) return null;
    const last = av.getLastRow();
    if (last < 2) return null;
    const rows = av.getRange(2, 1, last - 1, headers.length).getValues();
    const todayKey = slotDateKey(new Date());

    /* Prefer a slot a customer could actually book. AVAILABILITY accumulates
       past rows that are still marked open — nothing expires them — and taking
       the first one would test the write-back against a date the feed never
       publishes. Fall back to any open row so the test still runs on a sheet
       with no future availability, and say which happened. */
    let fallback = null;
    for (let r = 0; r < rows.length; r++) {
      if (String(rows[r][iStat]).trim().toLowerCase() !== SLOT_OPEN) continue;
      const hit = {
        date: slotDateKey(rows[r][iDate]),
        time: slotTimeLabel(rows[r][iTime]),
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
