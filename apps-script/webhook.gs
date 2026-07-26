/**
 * Serve — Booking webhook (doPost)   ·   LEADS MASTER, servecos.com
 * ==================================================================
 * VERSION STAMP:  2026-07-27  ·  branch build/attribution-and-notes  ·  SCHEMA.md r2
 *
 * Repo source of truth: /apps-script/webhook.gs
 * Column meanings and ownership: /docs/SCHEMA.md — that file is authoritative.
 * If the stamp in the Apps Script editor does not match the repo, what is
 * deployed is stale.
 * ==================================================================
 *
 * ROUTING
 *   reservation  ->  resolve lead_id  ->  upsert LEADS  ->  append JOBS
 *   everything else (quote_emailed, waitlist_zip, custom_quote_request)  ->  EVENTS
 *
 *   Tabs this script is ALLOWED to write: JOBS, LEADS, EVENTS.
 *   PROPERTIES, RAW_INTAKE, OUTREACH_LOG and DASHBOARD are hard-blocked by
 *   assertWritable() — a coding mistake throws rather than corrupting them.
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
 *   1. Fill SPREADSHEET_ID, NOTIFY_EMAIL, JOBS_TAB below.
 *   2. Run reportLeadsSchema() once — it prints the LEADS header row and tells
 *      you exactly which fields this script can and cannot write there.
 *      It is strictly READ-ONLY: getSheets, getSheetByName, getLastColumn,
 *      getRange().getValues() and console.log, nothing else. It creates no tab,
 *      no column and no cell, and sends no email. Safe on a live workbook.
 *   3. Run testPayload() — writes both scheduling shapes, a repeat-customer
 *      booking, and an idempotency replay.
 *   4. Deploy > New deployment > Web app > Execute as: Me > Access: Anyone.
 *      Paste the /exec URL into SHEETS_URL in script.js (line ~155).
 *
 * The site POSTs Content-Type text/plain so the request stays CORS-simple and
 * the browser can read the reply. Keep returning { status: "ok" } — the success
 * panel on the site is gated on it.
 */


/* ============================================================
   1. CONFIG
   ============================================================ */

const SPREADSHEET_ID = "";                    // "" = use the bound spreadsheet
const NOTIFY_EMAIL   = "ops@example.com";
const JOBS_TAB       = "JOBS";

const LEADS_TAB  = "LEADS";    // must already exist — never auto-created
const EVENTS_TAB = "EVENTS";   // auto-created if missing

/**
 * Tabs this script must never touch, whatever else changes.
 * Compared through normalizeTabName(), so spacing and punctuation cannot defeat
 * the guard: "RAW_INTAKE", "RAW INTAKE" and "raw-intake" all match.
 */
const PROTECTED_TABS = ["PROPERTIES", "RAW_INTAKE", "OUTREACH_LOG", "DASHBOARD"];

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
];

/**
 * Ops fields that belong in their own columns and must never be silently lost.
 * Written straight to the matching header. If a header is missing, they fall
 * back into quote_meta rather than vanishing — a safety net for a schema that
 * has not caught up yet, not the intended path.
 */
const OPS_PREFERRED_KEYS = ["address", "unit", "zip"];

/**
 * The ONLY LEADS columns this script writes. Exact header matches, no alias
 * guessing. Everything else on that tab is the operator's — source_detail,
 * contacted_via, status, first_variant, dnc_scrub, first_touch, last_touch,
 * ltv, notes — and is skipped silently.
 *
 * Note the payload key `address` maps to the header `service_address`.
 */
const LEADS_FIELDS = ["lead_id", "name", "email", "phone", "service_address",
                      "unit", "zip", "source", "segment", "source_history"];

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

    try {
      sendReservationEmail(data, sched, leadId, leadResult);
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
  return json({ ok: true, service: "serve-booking-webhook", version: "2026-07-27 SCHEMA.md r2" });
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
    : Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyyMMdd");
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

  /* Which of the fields we care about actually exist on the tab. */
  const col = {};
  const missing = [];
  LEADS_FIELDS.forEach(function (f) {
    const i = headers.indexOf(f);
    if (i === -1) missing.push(f); else col[f] = i;
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
  const incoming = {
    lead_id:         leadId,
    name:            data.name  || "",
    email:           normalizeEmail(data.email),
    phone:           data.phone || "",
    service_address: data.address || "",     // payload `address` -> `service_address`
    unit:            data.unit || "",
    zip:             data.zip  || "",
    source:          firstSet(data.src_first, data.src, ""),
    segment:         data.segment || "",
  };

  /* ---- No match: create ---- */
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
    sheet.appendRow(row);
    return { ok: true, action: "created", lead_id: leadId, row: sheet.getLastRow(),
             fields: written, missing: missing, headers: headers };
  }

  /* ---- Match: update blanks only, append to source_history ---- */
  const current = existing[rowIndex - 2];
  const filled = [];

  Object.keys(incoming).forEach(function (f) {
    if (col[f] === undefined) return;
    if (isSet(current[col[f]])) return;              // never overwrite a non-empty cell
    if (!isSet(incoming[f])) return;
    sheet.getRange(rowIndex, col[f] + 1).setValue(incoming[f]);
    filled.push(f);
  });

  let historyAppended = false;
  if (col.source_history !== undefined && isSet(incomingTag)) {
    const raw  = String(current[col.source_history] || "");
    const tags = raw.split(",").map(function (t) { return t.trim(); }).filter(Boolean);
    if (tags.indexOf(incomingTag) === -1) {
      tags.push(incomingTag);
      sheet.getRange(rowIndex, col.source_history + 1).setValue(tags.join(", "));
      historyAppended = true;
    }
  }

  return { ok: true, action: "matched", lead_id: leadId, row: rowIndex,
           fields: filled, history_appended: historyAppended, missing: missing, headers: headers };
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

/** "2026-08-14" -> "Friday, Aug 14". Parsed local, never UTC midnight. */
function prettyDate(ymd) {
  const parts = String(ymd).split("-");
  if (parts.length !== 3) return String(ymd);
  const d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  if (isNaN(d.getTime())) return String(ymd);
  return Utilities.formatDate(d, Session.getScriptTimeZone(), "EEEE, MMM d");
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

function sendReservationEmail(data, sched, leadId, leadResult) {
  const warn = (leadResult && leadResult.ok === false)
    ? "\n*** LEADS UPSERT FAILED — the JOBS row was written anyway. ***\n" +
      "*** " + leadResult.error + " ***\n" +
      "*** Add the person to LEADS by hand. ***\n\n"
    : "";

  const subject = "Serve Reservation — " + (data.name || "Unknown") + " · " + homeSummary(data) +
                  (petsFlag(data) ? " · PETS" : "") +
                  ((leadResult && leadResult.ok === false) ? " · LEADS WRITE FAILED" : "");

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
    "lead_id:  " + leadId + "  (" + (leadResult ? leadResult.action : "?") + ")\n" +
    "job_id:   " + makeJobId(data, sched) + "\n" +
    "property: " + propertyKey(data) + "\n\n" +
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

  MailApp.sendEmail(NOTIFY_EMAIL, subject, body);
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

  MailApp.sendEmail(NOTIFY_EMAIL, subject, body);
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
  LEADS_FIELDS.forEach(function (f) {
    (headers.indexOf(f) !== -1 ? found : missing).push(f);
  });
  console.log("WILL WRITE:  " + (found.join(", ")   || "(nothing)"));
  console.log("NO COLUMN:   " + (missing.join(", ") || "(none — full coverage)"));
  console.log("Row matching on: " +
    (headers.indexOf("lead_id") !== -1 ? "lead_id" :
     headers.indexOf("email")   !== -1 ? "email (no lead_id column)" :
     "NOTHING — upsert will fail"));

  const jobs = ss.getSheetByName(JOBS_TAB);
  if (jobs) {
    const jh = sheetHeaders(jobs);
    console.log("\nJOBS row 1 (" + jh.length + " columns):\n  " + jh.join(" | "));
    console.log("quote_meta column present: " + (jh.indexOf("quote_meta") !== -1));
  }
}

/**
 * Writes: a slot booking, a preference booking, a REPEAT booking from the same
 * email, and an idempotency replay. Check that the repeat produced one LEADS
 * row with an appended source_history and a second JOBS row.
 */
function testPayload() {
  const stamp = Date.now();

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
    address: "123 Beacon St", unit: "4B", unit_label: "2 BR / 1 BA",
    src: "qr-allston-01", src_first: "qr-allston-01", src_chain: "qr-allston-01",
    segment: "qr_code", utm_source: "poster", utm_medium: "print", page_path: "/",
  };

  const slot = Object.assign({}, base, {
    submission_id: "test-" + stamp + "-slot",
    slot_date: "2026-08-14", slot_time: "9-11 AM",
    schedule_preference_label: "Friday, Aug 14 at 9-11 AM",
    customer_notes: "We have a friendly dog, keep the back door shut.",
    pets_flag: true,
  });

  const pref = Object.assign({}, base, {
    submission_id: "test-" + stamp + "-pref",
    email: "someone.else@example.com",
    schedule_preference: "earlier", time_preference: "earlier",
    schedule_preference_label: "Earlier in the Day",
    customer_notes: "No pets. Lockbox on the door.",
    pets_flag: false,
  });

  // Same person as `slot`, different casing and a different tag.
  const repeat = Object.assign({}, base, {
    submission_id: "test-" + stamp + "-repeat",
    email: "TEST.CUSTOMER@example.com",
    src: "ig-story-07", src_first: "qr-allston-01",
    src_chain: "qr-allston-01>ig-story-07",
    slot_date: "2026-09-02", slot_time: "1-3 PM",
    customer_notes: "Same dog as last time.",
  });

  // Move Out — add_on_rev must be 0, not $85.
  const moveOut = Object.assign({}, base, {
    submission_id: "test-" + stamp + "-moveout",
    email: "moveout@example.com",
    service: "move_out", service_type: "move_out",
    modifiers_applied: [], addon_total: 0,
    quote_price: 536, first_visit_total: 536,
    slot_date: "2026-09-10", slot_time: "8-10 AM",
  });

  [slot, pref, repeat, moveOut].forEach(function (p) {
    const res = doPost({ postData: { contents: JSON.stringify(p) } });
    console.log(p.submission_id + " -> " + res.getContent());
  });

  const replay = doPost({ postData: { contents: JSON.stringify(slot) } });
  console.log("idempotency replay -> " + replay.getContent());
}
