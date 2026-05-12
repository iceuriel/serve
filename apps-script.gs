/**
 * Serve — Google Apps Script (doPost)
 * Receives lead_captured + quote_reserved events from the Serve website,
 * appends each to the active sheet, AND sends a notification email to
 * NOTIFY_EMAIL for each event (two rows + two emails per completed quote).
 *
 * DEPLOY STEPS
 * 1. Open the existing "Serve Leads" Google Sheet
 * 2. Add a new column header in Row 1 at the end: "Schedule Preference"
 * 3. Extensions > Apps Script
 * 4. Replace the entire existing script with everything below
 *    (NOTIFY_EMAIL constant + doPost + the two send*Email helpers)
 * 5. Save (disk icon)
 * 6. Deploy > Manage Deployments > pencil/edit on the existing Web App
 *      Version: New version
 *      Description: "v3 schema (adds Schedule Preference) + email alerts"
 *      Click Deploy
 *    -> Keep the same URL so script.js doesn't need to change.
 *    (If you instead create a NEW deployment, copy the new URL into
 *     SHEETS_URL at the top of script.js.)
 * 7. First-time only: Apps Script will prompt for permission to send mail
 *    on your behalf. Approve the GmailApp/MailApp scope for the script.
 *
 * COLUMN HEADERS (paste these into Row 1 of the sheet, left to right)
 * Timestamp | Event | Name | Email | Phone | Address | Service Type | Unit | Modifiers | Original Price | Discount | First Visit Total | Weekly Rate | Biweekly Rate | Monthly Rate | Schedule Preference
 *
 * NOTES
 * - Column order below MUST match the header row above.
 * - lead_captured rows leave the pricing/service columns blank.
 * - quote_reserved rows fill every column, including Schedule Preference.
 * - Apps Script web apps cannot read CORS preflights from a static site,
 *   so the website POSTs with mode:'no-cors' (fire-and-forget). That means
 *   this script's response body is opaque to the browser — it is logged
 *   server-side only. Use Apps Script's "Executions" panel to debug.
 * - MailApp has a daily quota (100/day on a free Gmail account, 1500/day
 *   on Workspace). Email failures are caught so they never block the
 *   sheet append — check the Executions log if alerts stop arriving.
 */

const NOTIFY_EMAIL = "ops@example.com";

function doPost(e) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  const data  = JSON.parse(e.postData.contents);

  sheet.appendRow([
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
  ]);

  try {
    if (data.event === "lead_captured") {
      sendLeadCapturedEmail(data);
    } else if (data.event === "quote_reserved") {
      sendQuoteReservedEmail(data);
    }
  } catch (err) {
    // Don't block the sheet write if mail fails — log only.
    console.error("Email send failed: " + err);
  }

  return ContentService
    .createTextOutput(JSON.stringify({ status: "ok" }))
    .setMimeType(ContentService.MimeType.JSON);
}

function sendLeadCapturedEmail(data) {
  const subject = "New Serve Lead — " + (data.name || "Unknown");
  const body =
    "A visitor just submitted Step 1 (contact info) on servecleaning.com.\n\n" +
    "Name:    " + (data.name    || "") + "\n" +
    "Email:   " + (data.email   || "") + "\n" +
    "Phone:   " + (data.phone   || "") + "\n" +
    "Address: " + (data.address || "") + "\n\n" +
    "Submitted: " + (data.timestamp || "") + "\n\n" +
    "They have NOT completed the quote yet. If a quote_reserved email " +
    "follows, they finished Step 3 and reserved.";
  MailApp.sendEmail(NOTIFY_EMAIL, subject, body);
}

function sendQuoteReservedEmail(data) {
  const subject = "Serve Reservation — " + (data.name || "Unknown");
  const mods = (data.modifiers_applied && data.modifiers_applied.length)
    ? data.modifiers_applied.join(", ")
    : "(none)";
  const body =
    "A visitor just completed Step 3 (Reserve) on servecleaning.com.\n\n" +
    "— CONTACT —\n" +
    "Name:    " + (data.name    || "") + "\n" +
    "Email:   " + (data.email   || "") + "\n" +
    "Phone:   " + (data.phone   || "") + "\n" +
    "Address: " + (data.address || "") + "\n\n" +
    "— SERVICE —\n" +
    "Service Type:         " + (data.service_type || "") + "\n" +
    "Unit:                 " + (data.unit_label   || "") + "\n" +
    "Modifiers:            " + mods + "\n" +
    "Scheduling Preference: " + (data.schedule_preference_label || data.schedule_preference || "") + "\n\n" +
    "— PRICING —\n" +
    "Original Price:    $" + (data.original_price    || "") + "\n" +
    "Discount Applied:   " + (data.discount_applied  || "") + "\n" +
    "First Visit Total: $" + (data.first_visit_total || "") + "\n" +
    "Weekly Rate:       $" + (data.recurring_weekly   || "") + "\n" +
    "Biweekly Rate:     $" + (data.recurring_biweekly || "") + "\n" +
    "Monthly Rate:      $" + (data.recurring_monthly  || "") + "\n\n" +
    "Submitted: " + (data.timestamp || "");
  MailApp.sendEmail(NOTIFY_EMAIL, subject, body);
}
