/**
 * Serve — Booking webhook (doPost)   ·   LEADS MASTER, servecos.com
 * ==================================================================
 * VERSION STAMP:  2026-07-26  ·  branch build/attribution-and-notes
 *
 * Repo source of truth: /apps-script/webhook.gs
 * If the version stamp in the Apps Script editor does not match the one in the
 * repo, what is deployed is stale. This file replaces the old apps-script.gs,
 * which has been deleted — do not resurrect it.
 * ==================================================================
 *
 * WHAT THIS DOES
 *   Receives every event from servecleaning.com, writes one row, sends one
 *   notification email, and answers { status: "ok" } so the site can tell the
 *   customer they are actually booked instead of guessing.
 *
 *   reservation            -> JOBS tab
 *   quote_emailed          -> LEADS tab
 *   waitlist_zip           -> LEADS tab
 *   custom_quote_request   -> LEADS tab
 *
 * THE THREE THINGS THAT MAKE THIS DIFFERENT FROM THE OLD SCRIPT
 *
 *   1. HEADER-DRIVEN WRITES. It reads row 1 of the tab and fills the columns
 *      that already exist, in whatever order they sit. It never appends a
 *      column, so it can never split your history across a duplicate header.
 *      HEADER_MAP below translates payload keys to your exact header text.
 *      Anything with no column is captured inside `notes` instead of vanishing
 *      — and the moment you add a header matching an unmapped key name, that
 *      field starts filling itself in with no code change.
 *
 *   2. normalizeSchedule(). The site has two scheduling paths that write
 *      different keys. Resolving them in one place is what fixes the blank
 *      notes column on slot bookings. See the function for the exact order.
 *
 *   3. submission_id IDEMPOTENCY. Every submission carries a UUID. If that id
 *      is already in the tab, the write is skipped and { duplicate: true } comes
 *      back. That is what makes the site's retry-once-on-failure safe.
 *
 * SETUP  (three constants, then deploy)
 *   1. SPREADSHEET_ID — from the LEADS MASTER URL, between /d/ and /edit.
 *      Leave it "" if this script is bound to that sheet (Extensions > Apps
 *      Script from inside it), and it will use the active spreadsheet.
 *   2. NOTIFY_EMAIL   — where notifications go.
 *   3. JOBS_TAB       — the tab holding the job_id ... notes header row.
 *
 *   Then: Run testPayload() once, authorize the scopes, confirm two test rows
 *   land in JOBS and the emails arrive. Then Deploy > New deployment > Web app
 *   > Execute as: Me > Who has access: Anyone. Paste the /exec URL into
 *   SHEETS_URL in script.js.
 *
 * NOTE ON RESPONSES
 *   The site now POSTs with Content-Type text/plain so the request stays
 *   CORS-simple and the browser can read this response. Do not change the
 *   response to anything other than JSON, and keep { status: "ok" } — the
 *   success panel on the site is gated on it.
 */


/* ============================================================
   1. CONFIG — fill these in
   ============================================================ */

const SPREADSHEET_ID = "";                    // "" = use the bound spreadsheet
const NOTIFY_EMAIL   = "ops@example.com";
const JOBS_TAB       = "JOBS";

/* Optional — sensible defaults, change only if your ops vocabulary differs. */
const LEADS_TAB             = "LEADS";   // created automatically if missing
const NEW_JOB_STATUS        = "new";     // written to job_status on every booking
const DEFAULT_PAYMENT_STATUS = "";       // left blank; ops owns this field


/* ============================================================
   2. HEADER_MAP — payload key -> EXACT header text in row 1
   Built against the live JOBS header row:
     job_id | lead_id | source | property_key | service_type | frequency |
     condition | beds | baths | quoted_price | add_ons | add_on_rev |
     final_price | scheduled_date | completed_date | cleaner | start_time |
     duration_min | photos_passed | payment_status | job_status | notes

   Keys NOT listed here fall back to their own name as the header. That is
   deliberate: it means `customer_notes`, `pets_flag`, `segment`, `name`,
   `email`, `phone`, `address` and friends stay dormant today and light up the
   day you add a column with that exact name.

   Columns ops owns and this script never touches:
     completed_date · cleaner · duration_min · photos_passed
   ============================================================ */

const HEADER_MAP = {
  submission_id:      "lead_id",
  src_first:          "source",
  service_label:      "service_type",
  frequency_selected: "frequency",
  bedrooms:           "beds",
  bathrooms:          "baths",
  quote_price:        "quoted_price",
  addons_label:       "add_ons",
  addon_total:        "add_on_rev",
  first_visit_total:  "final_price",
  slot_date:          "scheduled_date",
  slot_time:          "start_time",
};

/* Header row written into LEADS if that tab has to be created. */
const LEADS_HEADERS = [
  "timestamp", "lead_id", "event_type", "source", "segment", "name", "email",
  "phone", "zip", "zip_tier", "beds", "baths", "service_type", "condition",
  "frequency", "quoted_price", "notes",
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

    const ss    = SPREADSHEET_ID ? SpreadsheetApp.openById(SPREADSHEET_ID)
                                 : SpreadsheetApp.getActiveSpreadsheet();
    const sheet = isReservation ? requireTab(ss, JOBS_TAB) : leadsTab(ss);

    if (alreadyWritten(sheet, data.submission_id)) {
      console.log("Duplicate submission_id, write skipped: " + data.submission_id);
      return json({ status: "ok", duplicate: true, submission_id: data.submission_id });
    }

    const sched  = normalizeSchedule(data);
    const record = isReservation ? buildJobRecord(data, sched) : buildLeadRecord(data, sched);
    writeRow(sheet, record);

    try {
      sendNotification(eventType, data, sched);
    } catch (mailErr) {
      console.error("Email send failed (row was still written): " + mailErr);
    }

    return json({
      status: "ok",
      duplicate: false,
      submission_id: data.submission_id || "",
      tab: sheet.getName(),
      row: sheet.getLastRow(),
    });

  } catch (err) {
    console.error("doPost failed: " + (err && err.stack ? err.stack : err));
    return json({ status: "error", message: String(err) });
  } finally {
    try { lock.releaseLock(); } catch (releaseErr) { /* nothing to do */ }
  }
}

/** Health check — open the /exec URL in a browser to confirm the deployment is live. */
function doGet() {
  return json({
    ok: true,
    service: "serve-booking-webhook",
    version: "2026-07-26 build/attribution-and-notes",
  });
}


/* ============================================================
   4. THE SCHEDULING FIX
   ============================================================ */

/**
 * Resolve one true schedule answer from a payload that may describe the time in
 * any of three shapes. The site has two scheduling controls: the live slot
 * picker writes slot_date + slot_time, the earlier/later radios write
 * time_preference + schedule_preference, and only schedule_preference_label is
 * populated on both paths. Reading a single key is what left the notes column
 * blank on slot bookings while the email showed the date fine.
 *
 * Order, most structured first:
 *   1. slot_date + slot_time     — a real booked slot
 *   2. time_preference / schedule_preference — earlier or later
 *   3. schedule_preference_label — guaranteed non-empty backstop
 *   4. "No time specified"       — should never be reached in practice
 *
 * Always returns { shape, date, time, summary } with a non-empty summary.
 */
function normalizeSchedule(data) {
  if (isSet(data.slot_date) && isSet(data.slot_time)) {
    return {
      shape: "slot",
      date: String(data.slot_date),
      time: String(data.slot_time),
      summary: prettyDate(data.slot_date) + " at " + data.slot_time,
    };
  }

  const pref = firstSet(data.time_preference, data.schedule_preference);
  if (isSet(pref)) {
    return { shape: "preference", date: "", time: "", summary: prefLabel(pref) };
  }

  if (isSet(data.schedule_preference_label)) {
    return {
      shape: "label",
      date: "",
      time: "",
      summary: String(data.schedule_preference_label),
    };
  }

  return { shape: "none", date: "", time: "", summary: "No time specified" };
}

function prefLabel(v) {
  const k = String(v).toLowerCase();
  if (k === "earlier") return "Earlier in the day (typically 8:00 AM - 12:00 PM)";
  if (k === "later")   return "Later in the day (typically 12:00 PM - 5:00 PM)";
  return String(v);
}

/** "2026-08-14" -> "Friday, Aug 14". Parsed as a local date, never UTC midnight. */
function prettyDate(ymd) {
  const parts = String(ymd).split("-");
  if (parts.length !== 3) return String(ymd);
  const d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  if (isNaN(d.getTime())) return String(ymd);
  return Utilities.formatDate(d, Session.getScriptTimeZone(), "EEEE, MMM d");
}


/* ============================================================
   5. RECORD BUILDERS
   ============================================================ */

function buildJobRecord(data, sched) {
  return {
    /* --- maps onto existing JOBS columns --- */
    job_id:             makeJobId(data, sched),
    submission_id:      data.submission_id || "",
    src_first:          firstSet(data.src_first, data.src, ""),
    property_key:       propertyKey(data),
    service_label:      serviceLabel(data),
    frequency_selected: data.frequency_selected || "",
    condition:          data.condition || "",
    bedrooms:           valOrBlank(data.bedrooms),
    bathrooms:          valOrBlank(data.bathrooms),
    quote_price:        valOrBlank(data.quote_price),
    addons_label:       addonsLabel(data),
    addon_total:        valOrBlank(data.addon_total),
    first_visit_total:  valOrBlank(firstSet(data.first_visit_total, data.quote_price)),
    slot_date:          sched.date,
    slot_time:          sched.time,
    payment_status:     DEFAULT_PAYMENT_STATUS,
    job_status:         NEW_JOB_STATUS,
    notes:              buildNotes(data, sched),

    /* --- no column in JOBS today; captured inside notes. Add a header with
           any of these exact names and it starts filling itself in. --- */
    name:               data.name || "",
    email:              data.email || "",
    phone:              data.phone || "",
    address:            data.address || "",
    unit:               data.unit || "",
    zip:                data.zip || "",
    zip_tier:           data.zip_tier || "",
    customer_notes:     data.customer_notes || "",
    pets_flag:          petsFlag(data) ? "TRUE" : "FALSE",
    segment:            data.segment || "",
    src:                data.src || "",
    src_chain:          data.src_chain || "",
    schedule_summary:   sched.summary,
    schedule_shape:     sched.shape,
    steady_state_price: valOrBlank(data.steady_state_price),
    recurring_weekly:   valOrBlank(data.recurring_weekly),
    recurring_biweekly: valOrBlank(data.recurring_biweekly),
    recurring_monthly:  valOrBlank(data.recurring_monthly),
    discount_applied:   data.discount_applied || "",
    utm_source:         data.utm_source || "",
    utm_medium:         data.utm_medium || "",
    utm_campaign:       data.utm_campaign || "",
    page_path:          data.page_path || "",
    event_type:         data.event_type || data.event || "",
    submitted_at:       firstSet(data.submitted_at, data.timestamp, ""),
  };
}

function buildLeadRecord(data, sched) {
  return {
    timestamp:          firstSet(data.timestamp, data.submitted_at, new Date().toISOString()),
    submission_id:      data.submission_id || "",
    event_type:         data.event_type || data.event || "",
    src_first:          firstSet(data.src_first, data.src, ""),
    segment:            data.segment || "",
    name:               data.name || "",
    email:              data.email || "",
    phone:              data.phone || "",
    zip:                data.zip || "",
    zip_tier:           data.zip_tier || "",
    bedrooms:           valOrBlank(data.bedrooms),
    bathrooms:          valOrBlank(data.bathrooms),
    service_label:      serviceLabel(data),
    condition:          data.condition || "",
    frequency_selected: data.frequency_selected || "",
    quote_price:        valOrBlank(firstSet(data.quote_price, data.first_visit_total)),
    notes:              buildNotes(data, sched),
  };
}

/**
 * Everything that matters, in one cell, in a fixed order. This is the column
 * that must never be blank — it is the human-readable record of the booking and
 * the safety net for every field that has no column of its own.
 */
function buildNotes(data, sched) {
  const lines = [];

  lines.push("Scheduling: " + sched.summary + "  [" + sched.shape + "]");

  if (isSet(data.customer_notes)) {
    lines.push('Customer said: "' + String(data.customer_notes).trim() + '"');
  }
  lines.push("Pets: " + (petsFlag(data) ? "YES" : "no"));

  const contact = [data.name, data.phone, data.email].filter(isSet);
  if (contact.length) lines.push("Contact: " + contact.join("  ·  "));

  const where = [data.address, data.unit].filter(isSet).join(", ");
  if (isSet(where) || isSet(data.zip)) {
    lines.push("Address: " + where + (isSet(data.zip) ? "  " + data.zip : "") +
               (isSet(data.zip_tier) ? " (" + data.zip_tier + ")" : ""));
  }

  lines.push("Attribution: segment=" + (data.segment || "direct") +
             "  ·  src=" + (data.src || "-") +
             "  ·  first=" + (data.src_first || "-") +
             "  ·  chain=" + (data.src_chain || "-"));

  const utm = ["utm_source", "utm_medium", "utm_campaign"]
    .filter(function (k) { return isSet(data[k]); })
    .map(function (k) { return k.replace("utm_", "") + "=" + data[k]; });
  if (utm.length) lines.push("UTM: " + utm.join("  ·  "));

  if (isSet(data.steady_state_price)) {
    lines.push("Recurring: " + money(data.steady_state_price) + "/visit (" +
               (data.frequency_selected || "") + ")");
  }
  if (isSet(data.discount_applied) && data.discount_applied !== "None") {
    lines.push("Discount: " + data.discount_applied);
  }

  lines.push("Submitted: " + firstSet(data.submitted_at, data.timestamp, ""));
  return lines.join("\n");
}


/* ============================================================
   6. SHEET I/O — header-driven, never widens the sheet
   ============================================================ */

function writeRow(sheet, record) {
  const headers = sheetHeaders(sheet);
  if (!headers.length) {
    throw new Error('Tab "' + sheet.getName() + '" has no header row in row 1.');
  }

  const byHeader = {};
  const noColumn = [];

  Object.keys(record).forEach(function (key) {
    const value = record[key];
    if (value === undefined || value === null || value === "") return;
    const header = HEADER_MAP[key] || key;
    if (headers.indexOf(header) === -1) { noColumn.push(key); return; }
    if (byHeader[header] === undefined) byHeader[header] = value;   // first writer wins
  });

  if (noColumn.length) {
    console.log("No column for [" + noColumn.join(", ") + "] — captured in notes.");
  }

  sheet.appendRow(headers.map(function (h) {
    return byHeader[h] !== undefined ? byHeader[h] : "";
  }));
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
  let col = headers.indexOf(HEADER_MAP.submission_id);
  if (col === -1) col = headers.indexOf("submission_id");
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
  if (!sheet) {
    throw new Error('Tab "' + name + '" not found. Check the JOBS_TAB constant.');
  }
  return sheet;
}

/** Lead events land here. Created with LEADS_HEADERS the first time it is needed. */
function leadsTab(ss) {
  let sheet = ss.getSheetByName(LEADS_TAB);
  if (!sheet) {
    sheet = ss.insertSheet(LEADS_TAB);
    sheet.appendRow(LEADS_HEADERS);
    sheet.setFrozenRows(1);
    console.log('Created the "' + LEADS_TAB + '" tab.');
  }
  return sheet;
}


/* ============================================================
   7. NOTIFICATION EMAILS
   ============================================================ */

function sendNotification(eventType, data, sched) {
  if (eventType === "reservation" || data.event === "quote_reserved") {
    sendReservationEmail(data, sched);
  } else if (eventType === "quote_emailed") {
    sendQuoteEmailedEmail(data);
  } else if (eventType === "waitlist_zip") {
    sendWaitlistEmail(data);
  } else if (eventType === "custom_quote_request") {
    sendCustomQuoteEmail(data);
  }
}

function sendReservationEmail(data, sched) {
  const subject = "Serve Reservation — " + (data.name || "Unknown") + " · " + homeSummary(data) +
                  (petsFlag(data) ? " · PETS" : "");

  const body =
    "A visitor just reserved a clean on servecleaning.com.\n\n" +
    "— WHEN —\n" +
    sched.summary + "\n" +
    "(" + sched.shape + ")\n\n" +
    "— CONTACT —\n" +
    "Name:    " + (data.name    || "") + "\n" +
    "Email:   " + (data.email   || "") + "\n" +
    "Phone:   " + (data.phone   || "") + "\n" +
    "Address: " + (data.address || "") + (isSet(data.unit) ? ", " + data.unit : "") + "\n" +
    "ZIP:     " + (data.zip || "") + " (" + (data.zip_tier || "") + ")\n\n" +
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
    (isSet(data.addon_total) && Number(data.addon_total) > 0
      ? "Of which add-ons: " + money(data.addon_total) + "\n" : "") +
    (isSet(data.steady_state_price)
      ? "Recurring/visit:   " + money(data.steady_state_price) +
        " (" + (data.frequency_selected || "") + ")\n" : "") +
    (isSet(data.recurring_weekly)   ? "Weekly rate:       " + money(data.recurring_weekly)   + "\n" : "") +
    (isSet(data.recurring_biweekly) ? "Biweekly rate:     " + money(data.recurring_biweekly) + "\n" : "") +
    (isSet(data.recurring_monthly)  ? "Monthly rate:      " + money(data.recurring_monthly)  + "\n" : "") +
    attributionBlock(data) +
    "\nSubmission: " + (data.submission_id || "(none)") +
    "\nSubmitted:  " + firstSet(data.submitted_at, data.timestamp, "");

  MailApp.sendEmail(NOTIFY_EMAIL, subject, body);
}

function sendQuoteEmailedEmail(data) {
  const subject = "Serve Lead — quote emailed to " + (data.email || "unknown");
  const body =
    "A visitor emailed themselves a quote on servecleaning.com.\n" +
    "Warm lead — they saw a price but have NOT reserved yet.\n\n" +
    "Email:     " + (data.email || "") + "\n" +
    "ZIP:       " + (data.zip || "") + " (" + (data.zip_tier || "") + ")\n" +
    "Service:   " + serviceLabel(data) + "\n" +
    "Home:      " + homeSummary(data) + "\n" +
    "Condition: " + (data.condition || "") + "\n" +
    "Quoted:    " + money(firstSet(data.quote_price, data.first_visit_total)) + "\n" +
    attributionBlock(data) +
    "\nSubmitted: " + firstSet(data.submitted_at, data.timestamp, "");
  MailApp.sendEmail(NOTIFY_EMAIL, subject, body);
}

function sendWaitlistEmail(data) {
  const subject = "Serve Waitlist — " + (data.zip || "?") + " (out of area)";
  const body =
    "Someone outside the current service area joined the waitlist on servecleaning.com.\n\n" +
    "Email: " + (data.email || "") + "\n" +
    "ZIP:   " + (data.zip || "") + "\n" +
    attributionBlock(data) +
    "\nSubmitted: " + firstSet(data.submitted_at, data.timestamp, "");
  MailApp.sendEmail(NOTIFY_EMAIL, subject, body);
}

function sendCustomQuoteEmail(data) {
  const subject = "Serve Custom Quote Request — " + homeSummary(data);
  const body =
    "A larger home (5+ BR) requested a personal quote on servecleaning.com.\n\n" +
    "Email: " + (data.email || "") + "\n" +
    "Phone: " + (data.phone || "(not provided)") + "\n" +
    "ZIP:   " + (data.zip || "") + " (" + (data.zip_tier || "") + ")\n" +
    "Home:  " + homeSummary(data) + "\n" +
    attributionBlock(data) +
    "\nSend them an hourly-scope quote today ($130/hr).\n" +
    "Submitted: " + firstSet(data.submitted_at, data.timestamp, "");
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
   8. HELPERS
   ============================================================ */

function parseBody(e) {
  if (!e || !e.postData || !e.postData.contents) return null;
  try {
    return JSON.parse(e.postData.contents);
  } catch (err) {
    console.error("Could not parse body: " + err);
    return null;
  }
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
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

function serviceLabel(data) {
  const s = firstSet(data.service, data.service_type);
  if (s === "move_out")    return "Move In / Move Out";
  if (s === "first_clean") return "First Clean";
  return String(s || "");
}

function homeSummary(data) {
  const bd = (Number(data.bedrooms) === 0) ? "Studio" : (valOrBlank(data.bedrooms) + " BR");
  return bd + " / " + valOrBlank(data.bathrooms) + " BA";
}

function addonsLabel(data) {
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
 * so a stale cached script.js can't quietly lose the signal. Word-boundaried —
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

/** Stable per submission — a retry that slips past dedupe still produces the same id. */
function makeJobId(data, sched) {
  const day = isSet(sched.date)
    ? String(sched.date).replace(/-/g, "")
    : Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyyMMdd");
  let tail = String(data.submission_id || "").replace(/[^A-Za-z0-9]/g, "").slice(-6).toUpperCase();
  if (!tail) tail = String(Math.floor(Math.random() * 1000000));
  return "SRV-" + day + "-" + tail;
}

/** ZIP + address + unit, normalised. Same home always produces the same key. */
function propertyKey(data) {
  const parts = [data.zip, data.address, data.unit]
    .filter(isSet)
    .map(function (v) {
      return String(v).trim().toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    })
    .filter(function (v) { return v !== ""; });
  return parts.join("-");
}


/* ============================================================
   9. TEST — run this once from the editor before deploying
   Writes two rows into JOBS, one per scheduling shape, and sends
   both notification emails. Check that `notes` is populated on
   BOTH rows: that is the bug this build exists to fix.
   ============================================================ */

function testPayload() {
  const stamp = Date.now();

  const base = {
    event: "quote_reserved",
    event_type: "reservation",
    timestamp: new Date().toISOString(),
    submitted_at: new Date().toISOString(),
    zip: "02134", zip_tier: "core",
    bedrooms: 2, bathrooms: 1,
    service: "first_clean", service_type: "first_clean",
    condition: "standard",
    addon_fridge: true, addon_oven: false,
    modifiers_applied: ["Inside the fridge"],
    addon_total: 45,
    frequency_selected: "biweekly",
    quote_price: 214, first_visit_total: 214,
    original_price: 383, discount_applied: "First clean 50% off",
    steady_state_price: 122,
    recurring_weekly: 111, recurring_biweekly: 122, recurring_monthly: 142,
    name: "Test Customer", email: "test@example.com", phone: "(617) 555-0100",
    address: "123 Beacon St", unit: "4B", unit_label: "2 BR / 1 BA",
    customer_notes: "We have a friendly dog, please keep the back door shut. Park in the driveway.",
    pets_flag: true,
    src: "qr-allston-01", src_first: "qr-allston-01", src_chain: "qr-allston-01",
    segment: "qr_code",
    utm_source: "poster", utm_medium: "print", utm_campaign: "allston-summer",
    page_path: "/",
  };

  // Shape 1 — live slot picker.
  const slotRow = Object.assign({}, base, {
    submission_id: "test-" + stamp + "-slot",
    slot_date: "2026-08-14",
    slot_time: "9–11 AM",
    schedule_preference: null,
    schedule_preference_label: "Friday, Aug 14 at 9–11 AM",
    time_preference: null,
  });

  // Shape 2 — earlier/later fallback radios.
  const prefRow = Object.assign({}, base, {
    submission_id: "test-" + stamp + "-pref",
    slot_date: null,
    slot_time: null,
    schedule_preference: "earlier",
    schedule_preference_label: "Earlier in the Day",
    time_preference: "earlier",
    customer_notes: "No pets. Lockbox code is on the door, 1234.",
    pets_flag: false,
  });

  [slotRow, prefRow].forEach(function (payload) {
    const res = doPost({ postData: { contents: JSON.stringify(payload) } });
    console.log(payload.submission_id + " -> " + res.getContent());
  });

  // Third call repeats the first id — should come back duplicate:true, no new row.
  const dupe = doPost({ postData: { contents: JSON.stringify(slotRow) } });
  console.log("idempotency check -> " + dupe.getContent());
}
