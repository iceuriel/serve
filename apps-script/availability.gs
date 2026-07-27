/*******************************************************************
 * SERVE — Availability endpoint (doGet)
 * ==================================================================
 * VERSION STAMP:  2026-07-27  ·  branch build/attribution-and-notes  ·  avail r2
 *
 * Repo source of truth: /apps-script/availability.gs
 * Lives in the OPS sheet — a DIFFERENT spreadsheet from Leads MASTER.
 * This and /apps-script/webhook.gs never touch the same workbook and are
 * deployed separately.
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
 *   { "ok": true, "slots": [ { "date": "2026-07-29", "time": "1:00 PM",
 *                              "open": 2 }, ... ] }
 * Sorted by date then time. Aggregated counts only — never cleaner names.
 * Cached 5 min; append ?nocache=1 to bypass.
 *
 * ------------------------------------------------------------------
 * TIMEZONES — read this before changing any date handling
 *
 * There are TWO settings, and they are not the same one:
 *   A. Spreadsheet timezone   File > Settings > Time zone
 *   B. Script project timezone  Apps Script > Project Settings > Time zone
 * Both should be America/New_York. checkTimezones() reports either one that
 * is not, in the response and in testAvailability().
 *
 * This script no longer DEPENDS on either being right for the values it
 * publishes. Dates and times are recovered with local getters
 * (getFullYear/getHours/...), which round-trip exactly: Apps Script converted
 * the cell's serial number to a Date using the project timezone, so reading it
 * back through that same timezone returns precisely what was typed, whatever
 * the timezone happens to be. Formatting through a *different* zone is what
 * shifts a date by a day or an hour — so Utilities.formatDate is not used here
 * at all, and labels are built from the recovered numbers.
 *
 * The one thing still timezone-sensitive is the lead-time / horizon comparison,
 * which weighs a wall-clock slot against the current instant. That is only
 * meaningful when setting B is the business timezone. A mismatch skews the
 * 18-hour boundary; it does not corrupt any published date or time. Warned,
 * not fatal — losing the whole scheduler over a settings mismatch would be the
 * worse outcome.
 * ------------------------------------------------------------------
 *
 * The website treats ok:false, a network error, a timeout, and an empty slot
 * list identically: it falls back to the earlier/later radios and bookings keep
 * working. A bad deploy here degrades the booking flow, it never breaks it.
 *******************************************************************/

var CONFIG = {
  SHEET: 'AVAILABILITY',
  DAYS_AHEAD: 21,          // must not exceed HORIZON_DAYS in script.js
  MIN_LEAD_HOURS: 18,
  CACHE_SECONDS: 300,
  BUSINESS_TZ: 'America/New_York',
  VERSION: '2026-07-27 avail r2'
};

/** Required in row 1 of AVAILABILITY. Case-sensitive. */
var REQUIRED_HEADERS = ['date', 'start_time', 'status'];


function doGet(e) {
  try {
    var useCache = !(e && e.parameter && e.parameter.nocache);
    var cache = CacheService.getScriptCache();
    if (useCache) {
      var hit = cache.get('avail_v4');
      if (hit) return json(hit);
    }

    var ss = SpreadsheetApp.getActiveSpreadsheet();

    var sh = ss.getSheetByName(CONFIG.SHEET);
    if (!sh) {
      return fail('No tab named "' + CONFIG.SHEET + '". Tabs present: ' +
                  ss.getSheets().map(function (s) { return s.getName(); }).join(', '));
    }

    var data = sh.getDataRange().getValues();
    if (!data.length) return fail('"' + CONFIG.SHEET + '" is empty — no header row.');

    var head = data[0].map(function (h) { return String(h).trim(); });

    /* Fail loudly rather than publishing an empty list. A missing header used to
       make indexOf return -1, skip every row, and return {ok:true, slots:[]} —
       which the website reads as "no availability" and answers by silently
       dropping the scheduler. */
    var missing = REQUIRED_HEADERS.filter(function (h) { return head.indexOf(h) === -1; });
    if (missing.length) {
      return fail('AVAILABILITY is missing required header(s): ' + missing.join(', ') +
                  '. Row 1 currently reads: ' + head.join(' | '));
    }

    var iDate = head.indexOf('date'),
        iTime = head.indexOf('start_time'),
        iStat = head.indexOf('status');

    var tzIssues = checkTimezones(ss);
    tzIssues.forEach(function (w) { console.warn(w); });

    var now = new Date();
    var minStart = new Date(now.getTime() + CONFIG.MIN_LEAD_HOURS * 3600 * 1000);
    var maxDate  = new Date(now.getTime() + CONFIG.DAYS_AHEAD * 86400 * 1000);

    var agg = {}, skipped = 0;
    for (var r = 1; r < data.length; r++) {
      if (String(data[r][iStat]).trim().toLowerCase() !== 'open') continue;

      var d = data[r][iDate];
      if (!(d instanceof Date)) { skipped++; continue; }

      var t = parseTime(data[r][iTime]);
      if (!t) { skipped++; continue; }

      /* Same timezone in and out — the wall time typed in the sheet, compared
         against the current instant. */
      var start = new Date(d.getFullYear(), d.getMonth(), d.getDate(),
                           Math.floor(t.min / 60), t.min % 60, 0);
      if (start < minStart || start > maxDate) continue;

      var key = ymd(d) + '|' + pad(t.min) + '|' + t.label;
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
    if (skipped)         payload.skipped_rows = skipped;   // unreadable date/time cells
    if (tzIssues.length) payload.warning = tzIssues.join(' ');

    var body = JSON.stringify(payload);
    cache.put('avail_v4', body, CONFIG.CACHE_SECONDS);
    return json(body);

  } catch (err) {
    console.error(err);
    return fail(String(err));
  }
}


/** Both timezone settings should be the business timezone. Returns messages. */
function checkTimezones(ss) {
  var issues = [];
  var scriptTz = Session.getScriptTimeZone();
  var sheetTz  = ss.getSpreadsheetTimeZone();
  if (scriptTz !== CONFIG.BUSINESS_TZ) {
    issues.push('Apps Script project timezone is ' + scriptTz + ', expected ' +
                CONFIG.BUSINESS_TZ + ' — fix under Project Settings > Time zone.');
  }
  if (sheetTz !== CONFIG.BUSINESS_TZ) {
    issues.push('Spreadsheet timezone is ' + sheetTz + ', expected ' +
                CONFIG.BUSINESS_TZ + ' — fix under File > Settings > Time zone.');
  }
  return issues;
}

/**
 * Accepts "8:00 AM" text OR a real Sheets time / date-time value.
 * Returns { min: minutes-since-midnight, label: "8:00 AM" } or null.
 *
 * Takes no timezone. Local getters recover the wall time exactly as typed; the
 * label is then built from those numbers rather than formatted through a zone.
 */
function parseTime(v) {
  if (v instanceof Date) {
    var h = v.getHours(), mi = v.getMinutes();
    return { min: h * 60 + mi, label: clockLabel(h, mi) };
  }
  var m = String(v == null ? '' : v).trim().match(/^(\d{1,2}):(\d{2})\s*([AP])\.?M\.?$/i);
  if (!m) return null;
  var h24 = (+m[1]) % 12 + (/p/i.test(m[3]) ? 12 : 0);
  return { min: h24 * 60 + (+m[2]), label: clockLabel(h24, +m[2]) };
}

/** (13, 0) -> "1:00 PM".  (0, 5) -> "12:05 AM". */
function clockLabel(h, mi) {
  var h12 = (h % 12 === 0) ? 12 : (h % 12);
  return h12 + ':' + ('0' + mi).slice(-2) + ' ' + (h < 12 ? 'AM' : 'PM');
}

/** Calendar date as typed, with no timezone conversion. */
function ymd(d) {
  return d.getFullYear() + '-' +
         ('0' + (d.getMonth() + 1)).slice(-2) + '-' +
         ('0' + d.getDate()).slice(-2);
}

/** Zero-padded minutes-since-midnight, so the sort key orders chronologically. */
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
   Read-only: reports exactly what the endpoint would publish now.
   ============================================================ */
function testAvailability() {
  var res = JSON.parse(doGet({ parameter: { nocache: '1' } }).getContent());

  console.log('ok: ' + res.ok + '   version: ' + res.version);
  console.log('Business timezone: ' + CONFIG.BUSINESS_TZ);
  console.log('  script project: ' + Session.getScriptTimeZone());
  console.log('  spreadsheet:    ' + SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone());

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
