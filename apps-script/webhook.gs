/**
 * Serve — Booking webhook (doPost)   ·   LEADS MASTER, servecos.com
 * ==================================================================
 * VERSION STAMP:  2026-08-20  ·  master  ·  r8 — levels + geo pricing fields
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
  "PROPERTIES", "RAW_INTAKE", "OUTREACH_LOG", "DASHBOARD",
  // Ops workbook — reachable by id now that availability write-back exists.
  // OPS_DASHBOARD normalises to OPS_DASHBOARD, not DASHBOARD, so it needs its
  // own entry rather than relying on the one above.
  "CLEANERS", "SCHEDULE", "OPS_DASHBOARD",
];

/** Columns ops owns on JOBS. Never written, not even blank-filled. */
const OPS_OWNED_COLUMNS = ["completed_date", "cleaner", "duration_min", "photos_passed", "payment_status"];

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
const LEADS_FIELDS = ["lead_id", "name", "email", "phone", "address",
                      "unit", "zip", "source", "segment", "source_history",
                      "sms_transactional", "sms_promotional", "sms_consent_at"];

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

    const record = buildJobRecord(data, sched, leadId, jobs);
    const write  = writeRow(jobs, record);

    /* Everything below happens AFTER the booking is safely recorded. None of it
       can fail the booking; each failure is reported in the notification. */

    /* PROPERTIES — the durable asset the join key has been pointing at. */
    let propertyResult;
    try {
      propertyResult = upsertProperty(ss, data, record.property_key);
    } catch (propErr) {
      propertyResult = { ok: false, action: "failed", error: String(propErr) };
      console.error("PROPERTIES upsert failed (JOBS row still written): " + propErr);
    }

    /* Ops AVAILABILITY — stop the slot being sold twice. Reads at write time,
       inside the script lock doPost already holds. Never throws. */
    const slotResult = bookAvailabilitySlot(sched, record.job_id);

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
function doGet() {
  return json({ ok: true, service: "serve-booking-webhook", version: "2026-08-20 r8" });
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

/** ZIP + address + unit, normalised. The same home always produces the same key. */
function propertyKey(data) {
  return [data.zip, data.address, data.unit]
    .filter(isSet)
    .map(function (v) {
      return String(v).trim().toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    })
    .filter(function (v) { return v !== ""; })
    .join("-");
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

  const incoming = {
    lead_id: leadId,
    name:    data.name  || "",
    email:   normalizeEmail(data.email),
    phone:   data.phone || "",
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
    sheet.appendRow(row);
    return { ok: true, action: "created", lead_id: leadId, row: sheet.getLastRow(),
             fields: written, missing: missing, headers: headers };
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

  return { ok: true, action: "matched", lead_id: leadId, row: rowIndex,
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
    throw new Error('PROPERTIES has no "property_key" column — cannot match rows.');
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

  const needle = String(propertyKey).trim().toLowerCase();
  let rowIndex = -1;
  for (let i = 0; i < existing.length; i++) {
    if (String(existing[i][col.property_key]).trim().toLowerCase() === needle) { rowIndex = i + 2; break; }
  }

  /* ---- No match: create ---- */
  if (rowIndex === -1) {
    const row = new Array(headers.length).fill("");
    const written = [];
    Object.keys(incoming).forEach(function (f) {
      if (col[f] !== undefined && isSet(incoming[f])) { row[col[f]] = incoming[f]; written.push(f); }
    });
    sheet.appendRow(row);
    return { ok: true, action: "created", property_key: propertyKey,
             row: sheet.getLastRow(), fields: written, missing: missing };
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

  return { ok: true, action: "matched", property_key: propertyKey,
           row: rowIndex, fields: filled, missing: missing };
}


/* ============================================================
   5c. AVAILABILITY WRITE-BACK  (Ops workbook)
   ============================================================ */

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
function bookAvailabilitySlot(sched, jobId) {
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

    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      if (String(row[iStat]).trim().toLowerCase() !== SLOT_OPEN) continue;   // never touch `held`
      if (slotDateKey(row[iDate]) !== sched.date) continue;
      if (slotTimeLabel(row[iTime]) !== sched.time) continue;

      const sheetRow = r + 2;
      av.getRange(sheetRow, iStat + 1).setValue(SLOT_BOOKED);
      if (iJob !== -1 && isSet(jobId)) av.getRange(sheetRow, iJob + 1).setValue(jobId);

      return { ok: true, action: "booked", row: sheetRow,
               cleaner: headers.indexOf("cleaner_id") !== -1 ? row[headers.indexOf("cleaner_id")] : "" };
    }

    return { ok: true, action: "conflict",
             reason: 'no open row for ' + sched.date + ' ' + sched.time +
                     ' — taken inside the 5-minute feed cache, or removed' };

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

function buildJobRecord(data, sched, leadId, sheet) {
  const record = {
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
          (isSet(slotResult.cleaner) ? ", cleaner " + slotResult.cleaner : "")
        : (slotResult.reason ? " — " + slotResult.reason : "")) + "\n\n" +
    "— SERVICE —\n" +
    "Service:    " + serviceLabel(data) + "\n" +
    "Home:       " + homeSummary(data) + "\n" +
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
    lead = "A larger home (5+ BR) requested a personal quote. Send an hourly scope today ($130/hr).";
  } else {
    subject = "Serve Event — " + eventType;
    lead = "A non-reservation event was recorded.";
  }

  const body =
    lead + "\n\n" +
    "Email:     " + (data.email || "") + "\n" +
    "Phone:     " + (data.phone || "(not provided)") + "\n" +
    "ZIP:       " + (data.zip || "") + " (" + (data.zip_tier || "") + ")\n" +
    "Service:   " + serviceLabel(data) + "\n" +
    "Home:      " + homeSummary(data) + "\n" +
    "Quoted:    " + money(firstSet(data.quote_price, data.first_visit_total)) + "\n" +
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

function homeSummary(data) {
  const bd = (Number(data.bedrooms) === 0) ? "Studio" : (valOrBlank(data.bedrooms) + " BR");
  return bd + " / " + valOrBlank(data.bathrooms) + " BA";
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

/**
 * Trust the site's flag when it sends one; re-derive from the notes otherwise,
 * so a stale cached script.js cannot lose the signal. Word-boundaried —
 * "carpet" must not read as "pet".
 */
function petsFlag(data) {
  if (data.pets_flag === true)  return true;
  if (data.pets_flag === false) return false;
  if (String(data.pets_flag).toUpperCase() === "TRUE")  return true;
  if (String(data.pets_flag).toUpperCase() === "FALSE") return false;
  const re = /\b(pets?|dogs?|puppy|puppies|cats?|kitten|kittens|kitty|feline|canine|animals?|birds?|parrot|hamster|rabbits?|bunny|guinea pig|ferret|reptile|snake|lizard|litter ?box|crate|kennel|leash|paws?|fur|shedding)\b/i;
  return re.test(String(data.customer_notes || ""));
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
  report.push(deleteMatching(ss, PROPERTIES_TAB, "property_key",
    function (v) { return String(v).toUpperCase().indexOf("TESTING-WAY") !== -1; }));
  report.push(deleteMatching(ss, EVENTS_TAB, "submission_id",
    function (v) { return String(v).indexOf(TEST_PREFIX) === 0; }));

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
