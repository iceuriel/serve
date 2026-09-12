/*******************************************************************
 * SERVE — Availability endpoint (doGet)
 * ==================================================================
 * VERSION STAMP:  2026-09-12  ·  master  ·  avail r3 — dates read through the workbook timezone
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
 * WHICH ONE BUILDS A DATE CELL: setting A, the SPREADSHEET's. Sheets turns a
 * cell's serial number into an instant using the workbook's own timezone. This
 * file used to claim the opposite — that the PROJECT timezone did it, so local
 * getters round-tripped exactly whatever either setting was — and every date
 * here was recovered with getFullYear/getHours on that basis.
 *
 * It is not true, and Leads MASTER proved it: that workbook was set to
 * Australia/Sydney while its project was America/New_York, and a booking
 * displaying "2026-09-18" read back through local getters as "2026-09-17".
 * Local getters are the PROJECT's timezone, so they return what was typed only
 * while A and B happen to agree. See webhook.gs r32.
 *
 * So dates and times are now formatted through the SPREADSHEET's own timezone
 * (sheetTimeZone()), which recovers what was typed whatever either setting is.
 * Local getters remain the fallback for a workbook that cannot report one —
 * the pre-r3 behaviour, never a guessed zone.
 *
 * THIS MATTERS BEYOND THIS FILE. webhook.gs re-derives the same key from the
 * same AVAILABILITY cells to match a booking to its row, and it runs in a
 * DIFFERENT project whose timezone is its own. While both files used local
 * getters, the two agreed only because three settings happened to match: this
 * workbook's, this project's, and the Leads project's. Keying both to the
 * workbook's own timezone makes them agree by construction instead. Change one
 * of these files and you must change the other.
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
  VERSION: '2026-09-12 avail r3'
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

    /* Sheets built every date cell below from THIS workbook's timezone, so it
       is the only one that reads them back as they were typed. */
    var tz = sheetTimeZone(ss);

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

      /* The day as typed, then the wall clock rebuilt from it. Both come from
         the workbook's timezone, so the published label and the lead-time
         comparison can never describe two different days. */
      var dayKey = ymd(d, tz);
      var ymdParts = dayKey.split('-');
      var start = new Date(Number(ymdParts[0]), Number(ymdParts[1]) - 1, Number(ymdParts[2]),
                           Math.floor(t.min / 60), t.min % 60, 0);
      if (start < minStart || start > maxDate) continue;

      var key = dayKey + '|' + pad(t.min) + '|' + t.label;
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


/**
 * The timezone Sheets used to build the Dates this workbook hands back.
 *
 * Returns '' rather than a guess when it cannot be asked: an empty timezone
 * sends the helpers below down their local-getter path, which is what they did
 * before avail r3, instead of formatting through a timezone that may be wrong.
 *
 * MUST match sheetTimeZone() in /apps-script/webhook.gs.
 */
function sheetTimeZone(ss) {
  try {
    var tz = ss && ss.getSpreadsheetTimeZone ? ss.getSpreadsheetTimeZone() : '';
    return tz || '';
  } catch (_) {
    return '';
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
 * `tz` is the SPREADSHEET's timezone — the one that built the cell. Without it
 * the wall clock is recovered with local getters, which is the project's and is
 * right only while the two settings agree. Text is never converted at all.
 *
 * MUST match slotTimeLabel() in /apps-script/webhook.gs.
 */
function parseTime(v, tz) {
  if (v instanceof Date) {
    var h = v.getHours(), mi = v.getMinutes();
    if (tz) {
      try {
        h  = Number(Utilities.formatDate(v, tz, 'H'));
        mi = Number(Utilities.formatDate(v, tz, 'm'));
      } catch (_) { h = v.getHours(); mi = v.getMinutes(); }
    }
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

/**
 * Calendar date as typed, read through the SPREADSHEET's timezone.
 * MUST match slotDateKey() in /apps-script/webhook.gs.
 */
function ymd(d, tz) {
  if (tz) {
    try { return Utilities.formatDate(d, tz, 'yyyy-MM-dd'); } catch (_) {}
  }
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
