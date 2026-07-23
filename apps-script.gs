/**
 * Serve — Google Apps Script (doPost)
 * Handles the rebuilt booking flow (Build → Price → Reserve).
 *
 * Four event types arrive from servecleaning.com (read from data.event_type,
 * with the legacy data.event kept as a fallback):
 *   reservation | quote_emailed | waitlist_zip | custom_quote_request
 * Every event is appended as a row. Reservations and the three lead events
 * each trigger a notification email to NOTIFY_EMAIL.
 *
 * SHEET COLUMNS (Row 1 headers, left → right)
 *   Columns A–P are the ORIGINAL layout — unchanged so old rows still line up.
 *   Columns Q onward are ADDITIVE (new). Paste this full header row into Row 1:
 *
 *   Timestamp | Event | Name | Email | Phone | Address | Service Type | Unit |
 *   Modifiers | Original Price | Discount | First Visit Total | Weekly Rate |
 *   Biweekly Rate | Monthly Rate | Schedule Preference | Event Type | ZIP |
 *   ZIP Tier | Bedrooms | Bathrooms | Condition | Add Fridge | Add Oven |
 *   Frequency | Quote Price | Steady-State Price | Time Preference | Unit/Apt |
 *   Src | UTM Source | UTM Medium | UTM Campaign | Page Path | Slot Date |
 *   Slot Time
 *
 * DEPLOY
 *   1. Paste this over the existing script and Save.
 *   2. Add the new column headers (Q–AJ above) to Row 1 of the sheet.
 *   3. Deploy > Manage Deployments > edit the existing Web App >
 *      Version: New version > Deploy. Keep the SAME URL (script.js needs no change).
 *   4. First run may re-prompt for the Gmail/MailApp send permission — approve it.
 *
 * NOTES
 *   - The site POSTs with mode:'no-cors', so this script's response is opaque to
 *     the browser. Debug via Apps Script's "Executions" panel.
 *   - MailApp daily quota: 100/day (free Gmail), 1500/day (Workspace). Email
 *     failures are caught so they never block the sheet append.
 */

const NOTIFY_EMAIL = "ops@example.com";

function doPost(e) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  const data  = JSON.parse(e.postData.contents);

  sheet.appendRow([
    // --- Original columns A–P (unchanged) ---
    data.timestamp,
    data.event,
    data.name,
    data.email,
    data.phone,
    data.address,
    data.service_type              || "",
    data.unit_label                || "",
    data.modifiers_applied ? data.modifiers_applied.join(", ") : "",
    data.original_price            || "",
    data.discount_applied          || "",
    data.first_visit_total         || "",
    data.recurring_weekly          || "",
    data.recurring_biweekly        || "",
    data.recurring_monthly         || "",
    data.schedule_preference_label || data.schedule_preference || "",
    // --- New additive columns Q onward ---
    data.event_type                || "",
    data.zip                       || "",
    data.zip_tier                  || "",
    valOrBlank(data.bedrooms),
    valOrBlank(data.bathrooms),
    data.condition                 || "",
    yesNo(data.addon_fridge),
    yesNo(data.addon_oven),
    data.frequency_selected        || "",
    valOrBlank(data.quote_price),
    valOrBlank(data.steady_state_price),
    data.time_preference           || "",
    data.unit                      || "",
    data.src                       || "",
    data.utm_source                || "",
    data.utm_medium                || "",
    data.utm_campaign              || "",
    data.page_path                 || "",
    data.slot_date                 || "",
    data.slot_time                 || "",
  ]);

  try {
    const type = data.event_type || data.event;
    if (type === "reservation" || data.event === "quote_reserved") {
      sendReservationEmail(data);
    } else if (type === "quote_emailed") {
      sendQuoteEmailedEmail(data);
    } else if (type === "waitlist_zip") {
      sendWaitlistEmail(data);
    } else if (type === "custom_quote_request") {
      sendCustomQuoteEmail(data);
    }
  } catch (err) {
    // Don't block the sheet write if mail fails — log only.
    console.error("Email send failed: " + err);
  }

  return ContentService
    .createTextOutput(JSON.stringify({ status: "ok" }))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ============================================================
   Notification emails — one per event type
   ============================================================ */

function sendReservationEmail(data) {
  const subject = "Serve Reservation — " + (data.name || "Unknown") + " · " + homeSummary(data);
  const addons = [];
  if (data.addon_fridge) addons.push("Fridge interior (+$45)");
  if (data.addon_oven)   addons.push("Oven interior (+$40)");

  const body =
    "A visitor just reserved a clean on servecleaning.com.\n\n" +
    "— CONTACT —\n" +
    "Name:    " + (data.name    || "") + "\n" +
    "Email:   " + (data.email   || "") + "\n" +
    "Phone:   " + (data.phone   || "") + "\n" +
    "Address: " + (data.address || "") + (data.unit ? (", " + data.unit) : "") + "\n" +
    "ZIP:     " + (data.zip || "") + " (" + (data.zip_tier || "") + ")\n\n" +
    "— SERVICE —\n" +
    "Service:         " + serviceLabel(data) + "\n" +
    "Home:            " + homeSummary(data) + "\n" +
    "Condition:       " + (data.condition || "") + "\n" +
    "Add-ons:         " + (addons.length ? addons.join(", ") : "(none)") + "\n" +
    "Frequency:       " + (data.frequency_selected || "once") + "\n" +
    "Time preference: " + (data.schedule_preference_label || data.time_preference || "") + "\n\n" +
    "— PRICING (all-in) —\n" +
    "First-visit price: " + money(data.quote_price != null ? data.quote_price : data.first_visit_total) + "\n" +
    (isSet(data.steady_state_price)
      ? "Recurring/visit:   " + money(data.steady_state_price) + " (" + (data.frequency_selected || "") + ")\n" : "") +
    (data.recurring_weekly   ? "Weekly rate:       " + money(data.recurring_weekly)   + "\n" : "") +
    (data.recurring_biweekly ? "Biweekly rate:     " + money(data.recurring_biweekly) + "\n" : "") +
    (data.recurring_monthly  ? "Monthly rate:      " + money(data.recurring_monthly)  + "\n" : "") +
    attributionBlock(data) +
    "\nSubmitted: " + (data.timestamp || "");
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
    "Quoted:    " + money(data.quote_price != null ? data.quote_price : data.first_visit_total) + "\n" +
    attributionBlock(data) +
    "\nSubmitted: " + (data.timestamp || "");
  MailApp.sendEmail(NOTIFY_EMAIL, subject, body);
}

function sendWaitlistEmail(data) {
  const subject = "Serve Waitlist — " + (data.zip || "?") + " (out of area)";
  const body =
    "Someone outside the current service area joined the waitlist on servecleaning.com.\n\n" +
    "Email: " + (data.email || "") + "\n" +
    "ZIP:   " + (data.zip || "") + "\n" +
    attributionBlock(data) +
    "\nSubmitted: " + (data.timestamp || "");
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
    "Submitted: " + (data.timestamp || "");
  MailApp.sendEmail(NOTIFY_EMAIL, subject, body);
}

/* ============================================================
   Helpers
   ============================================================ */

function valOrBlank(v) { return (v === null || v === undefined) ? "" : v; }
function isSet(v)      { return v !== null && v !== undefined && v !== ""; }
function yesNo(v)      { return v === true ? "Yes" : (v === false ? "No" : ""); }
function money(v)      { return isSet(v) ? "$" + v : "—"; }

function serviceLabel(data) {
  if (data.service === "move_out")    return "Move In / Move Out";
  if (data.service === "first_clean") return "First Clean";
  return data.service_type || "";
}

function homeSummary(data) {
  const bd = (data.bedrooms === 0) ? "Studio" : (valOrBlank(data.bedrooms) + " BR");
  return bd + " / " + valOrBlank(data.bathrooms) + " BA";
}

function attributionBlock(data) {
  const parts = [];
  if (data.src)          parts.push("Src (poster/QR): " + data.src);
  if (data.utm_source)   parts.push("UTM Source:   " + data.utm_source);
  if (data.utm_medium)   parts.push("UTM Medium:   " + data.utm_medium);
  if (data.utm_campaign) parts.push("UTM Campaign: " + data.utm_campaign);
  return parts.length ? ("\n— ATTRIBUTION —\n" + parts.join("\n") + "\n") : "";
}
