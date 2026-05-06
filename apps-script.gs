/**
 * Serve — Google Apps Script (doPost)
 * Receives lead_captured + quote_reserved events from the Serve website
 * and appends each to the active sheet.
 *
 * DEPLOY STEPS
 * 1. Open the existing "Serve Leads" Google Sheet
 * 2. Extensions > Apps Script
 * 3. Replace the existing doPost(e) with the function below
 * 4. Save (disk icon)
 * 5. Deploy > Manage Deployments > pencil/edit on the existing Web App
 *      Version: New version
 *      Description: "v2 schema (lead_captured + quote_reserved)"
 *      Click Deploy
 *    -> Keep the same URL so script.js doesn't need to change.
 *    (If you instead create a NEW deployment, copy the new URL into
 *     SHEETS_URL at the top of script.js.)
 *
 * COLUMN HEADERS (paste these into Row 1 of the sheet, left to right)
 * Timestamp | Event | Name | Email | Phone | Address | Service Type | Unit | Modifiers | Original Price | Discount | First Visit Total | Weekly Rate | Biweekly Rate | Monthly Rate
 *
 * NOTES
 * - Column order below MUST match the header row above.
 * - lead_captured rows leave the pricing/service columns blank.
 * - quote_reserved rows fill every column.
 * - Apps Script web apps cannot read CORS preflights from a static site,
 *   so the website POSTs with mode:'no-cors' (fire-and-forget). That means
 *   this script's response body is opaque to the browser — it is logged
 *   server-side only. Use Apps Script's "Executions" panel to debug.
 */

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
    data.service_type      || "",
    data.unit_label        || "",
    data.modifiers_applied ? data.modifiers_applied.join(", ") : "",
    data.original_price    || "",
    data.discount_applied  || "",
    data.first_visit_total || "",
    data.recurring_weekly  || "",
    data.recurring_biweekly|| "",
    data.recurring_monthly || "",
  ]);

  return ContentService
    .createTextOutput(JSON.stringify({ status: "ok" }))
    .setMimeType(ContentService.MimeType.JSON);
}
