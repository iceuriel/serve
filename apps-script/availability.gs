/*******************************************************************
 * SERVE — Availability endpoint (doGet)
 * ==================================================================
 * VERSION STAMP:  2026-07-27  ·  branch build/attribution-and-notes  ·  avail r1
 *
 * Repo source of truth: /apps-script/availability.gs
 * Lives in the OPS sheet, which is a DIFFERENT spreadsheet from Leads
 * MASTER. This script and /apps-script/webhook.gs never touch the same
 * workbook and are deployed separately.
 * ==================================================================
 *
 * WHERE: Ops sheet -> Extensions -> Apps Script -> paste over everything.
 *   Already deployed: Deploy -> Manage deployments -> pencil -> New version
 *                     (keeps the URL).
 *   First time:       Deploy -> New deployment -> Web app ->
 *                     Execute as: Me -> Access: Anyone -> copy the URL into
 *                     AVAILABILITY_SOURCE_URL in script.js (~line 174).
 *
 * Reads AVAILABILITY (date | start_time | cleaner_id | status ...) and
 * publishes OPEN slots for the next 21 days:
 *   { "ok": true, "slots": [ { "date": "2026-07-25", "time": "1:00 PM",
 *                              "open": 1 }, ... ] }
 * Sorted by date then time. Aggregated counts only — never cleaner names.
 * Cached 5 min; append ?nocache=1 to bypass.
 *
 * WHY THIS DIFFERS FROM THE DRAFT
 *
 *   1. HEADER VALIDATION. Previously a renamed or mis-cased header made
 *      indexOf return -1, every row was skipped, and the response was a
 *      cheerful { ok: true, slots: [] }. The website reads "no open slots"
 *      and silently serves the earlier/later radios — you lose the scheduler
 *      and NOTHING anywhere reports a problem. That is the same silent-failure
 *      class that already cost this feed once. Missing headers are now a loud
 *      { ok: false, error: ... } naming what was expected and what was found.
 *
 *   2. ONE TIMEZONE. The draft read hours via v.getHours() (script project
 *      timezone) but built the label via formatDate(v, tz) (spreadsheet
 *      timezone). When those differ, a slot sorts as 08:00 while displaying
 *      "9:00 AM". Everything now derives from the spreadsheet timezone, and a
 *      mismatch between the two is surfaced in the response instead of
 *      silently skewing times.
 *
 * The website treats ok:false, a network error, a timeout, and an empty slot
 * list identically: it falls back to the earlier/later radios and bookings
 * keep working. So a bad deploy here degrades the booking flow, it never
 * breaks it.
 *******************************************************************/

var CONFIG = {
  SHEET: 'AVAILABILITY',
  DAYS_AHEAD: 21,          // must not exceed HORIZON_DAYS in script.js
  MIN_LEAD_HOURS: 18,
  CACHE_SECONDS: 300,
  VERSION: '2026-07-27 avail r1'
};

/** Header names required in row 1 of the AVAILABILITY tab. Case-sensitive. */
var REQUIRED_HEADERS = ['date', 'start_time', 'status'];


function doGet(e) {
  try {
    var useCache = !(e && e.parameter && e.parameter.nocache);
    var cache = CacheService.getScriptCache();
    if (useCache) {
      var hit = cache.get('avail_v3');
      if (hit) return json(hit);
    }

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var tz = ss.getSpreadsheetTimeZone();

    var sh = ss.getSheetByName(CONFIG.SHEET);
    if (!sh) {
      return fail('No tab named "' + CONFIG.SHEET + '". Tabs present: ' +
                  ss.getSheets().map(function (s) { return s.getName(); }).join(', '));
    }

    var data = sh.getDataRange().getValues();
    if (!data.length) return fail('"' + CONFIG.SHEET + '" is empty — no header row.');

    var head = data[0].map(function (h) { return String(h).trim(); });

    /* Fail loudly rather than publishing an empty list. */
    var missing = REQUIRED_HEADERS.filter(function (h) { return head.indexOf(h) === -1; });
    if (missing.length) {
      return fail('AVAILABILITY is missing required header(s): ' + missing.join(', ') +
                  '. Row 1 currently reads: ' + head.join(' | '));
    }

    var iDate = head.indexOf('date'),
        iTime = head.indexOf('start_time'),
        iStat = head.indexOf('status');

    /* Both timezones must agree, or sort order and labels drift apart. */
    var scriptTz = Session.getScriptTimeZone();
    var tzWarning = (scriptTz === tz) ? null
      : 'Script timezone (' + scriptTz + ') differs from spreadsheet timezone (' + tz +
        '). Set them the same under Project Settings.';
    if (tzWarning) console.warn(tzWarning);

    var now = new Date();
    var minStart = new Date(now.getTime() + CONFIG.MIN_LEAD_HOURS * 3600 * 1000);
    var maxDate  = new Date(now.getTime() + CONFIG.DAYS_AHEAD * 86400 * 1000);

    var agg = {}, skipped = 0;
    for (var r = 1; r < data.length; r++) {
      if (String(data[r][iStat]).trim().toLowerCase() !== 'open') continue;

      var d = data[r][iDate];
      if (!(d instanceof Date)) { skipped++; continue; }

      var t = parseTime(data[r][iTime], tz);
      if (!t) { skipped++; continue; }

      var start = new Date(d.getFullYear(), d.getMonth(), d.getDate(),
                           Math.floor(t.min / 60), t.min % 60, 0);
      if (start < minStart || start > maxDate) continue;

      var key = Utilities.formatDate(d, tz, 'yyyy-MM-dd') + '|' + pad(t.min) + '|' + t.label;
      agg[key] = (agg[key] || 0) + 1;
    }

    var slots = Object.keys(agg).sort().map(function (k) {
      var parts = k.split('|');
      return { date: parts[0], time: parts[2], open: agg[k] };
    });

    var payload = {
      ok: true,
      version: CONFIG.VERSION,
      generated: now.toISOString(),
      count: slots.length,
      slots: slots
    };
    if (skipped)   payload.skipped_rows = skipped;   // unparseable date/time cells
    if (tzWarning) payload.warning = tzWarning;

    var body = JSON.stringify(payload);
    cache.put('avail_v3', body, CONFIG.CACHE_SECONDS);
    return json(body);

  } catch (err) {
    console.error(err);
    return fail(String(err));
  }
}


/**
 * Accepts "8:00 AM" text OR a real Sheets time / date-time value.
 * Returns { min: minutes-since-midnight, label: "8:00 AM" } or null.
 *
 * For a Date value both the minutes and the label are derived from the SAME
 * timezone. The draft mixed v.getHours() (script tz) with formatDate(v, tz)
 * (spreadsheet tz), so the two disagreed whenever the settings did.
 */
function parseTime(v, tz) {
  if (v instanceof Date) {
    var hh = Number(Utilities.formatDate(v, tz, 'H'));
    var mm = Number(Utilities.formatDate(v, tz, 'm'));
    return {
      min: hh * 60 + mm,
      label: Utilities.formatDate(v, tz, 'h:mm a').toUpperCase()
    };
  }
  var m = String(v == null ? '' : v).trim().match(/^(\d{1,2}):(\d{2})\s*([AP])\.?M\.?$/i);
  if (!m) return null;
  var h = (+m[1]) % 12 + (/p/i.test(m[3]) ? 12 : 0);
  var label = (+m[1]) + ':' + m[2] + ' ' + m[3].toUpperCase() + 'M';
  return { min: h * 60 + (+m[2]), label: label };
}

function pad(n) { return ('0000' + n).slice(-4); }

function json(body) {
  return ContentService.createTextOutput(body)
                       .setMimeType(ContentService.MimeType.JSON);
}

function fail(message) {
  console.error(message);
  return json(JSON.stringify({ ok: false, version: CONFIG.VERSION, error: message }));
}


/* ============================================================
   Run from the editor before deploying.
   Read-only: reports what the endpoint would publish right now.
   ============================================================ */
function testAvailability() {
  var res = JSON.parse(doGet({ parameter: { nocache: '1' } }).getContent());

  console.log('ok: ' + res.ok + '   version: ' + res.version);
  if (!res.ok) { console.log('ERROR: ' + res.error); return; }
  if (res.warning)      console.log('WARNING: ' + res.warning);
  if (res.skipped_rows) console.log('Skipped ' + res.skipped_rows + ' row(s) with an unreadable date or start_time.');

  console.log('Publishing ' + res.count + ' slot(s).');
  if (!res.count) {
    console.log('EMPTY. The website will serve the earlier/later fallback. Check that ' +
                'AVAILABILITY has rows with status "open", a real date, a parseable ' +
                'start_time, and a start at least ' + CONFIG.MIN_LEAD_HOURS +
                ' hours out and within ' + CONFIG.DAYS_AHEAD + ' days.');
    return;
  }
  res.slots.slice(0, 20).forEach(function (s) {
    console.log('  ' + s.date + '  ' + s.time + '   open: ' + s.open);
  });
  if (res.count > 20) console.log('  ... and ' + (res.count - 20) + ' more');
}
