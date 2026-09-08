/**
 * SERVE — edge Worker
 * ==================================================================
 * VERSION STAMP:  2026-08-02  ·  worker r1
 * ==================================================================
 *
 * WHY THIS EXISTS
 *
 * Corporate networks block script.google.com. Apps Script is a well known
 * data-exfiltration channel, so Zscaler / Netskope / Palo Alto and friends
 * refuse the TLS tunnel by default — the symptom is ERR_TUNNEL_CONNECTION_FAILED
 * with the rest of the site loading perfectly.
 *
 * That silently ate the highest-value visitors: someone on a work laptop could
 * browse, get a quote, fill in the form, and see "You're on the schedule" while
 * the POST never left the building. It also killed the time-slot picker, which
 * falls back to the earlier/later radios without saying anything.
 *
 * So the browser now only ever talks to servecleaning.com — a domain the proxy
 * has already allowed, since the page itself loaded. This Worker relays to
 * Apps Script from Cloudflare's edge, which is not behind anyone's corporate
 * firewall.
 *
 *   POST /api/submit   ->  the booking webhook   (writes JOBS / LEADS / ...)
 *   GET  /api/slots    ->  the availability feed (time slots for step 3)
 *   anything else      ->  static files from _site
 *
 * SECONDARY BENEFITS, ALL LOAD-BEARING
 *
 *   Same origin, so there is no CORS at all — no preflight, and no need for the
 *   text/plain trick that made the request "simple" enough for Apps Script to
 *   answer. Real JSON in both directions.
 *
 *   The /exec URLs are no longer in public JavaScript. Before this, anyone could
 *   read them out of script.js and POST junk straight into the sheet.
 *
 *   It is the seam for replacing Apps Script later. The front end talks to
 *   /api/submit; what sits behind that can change without touching the site.
 *
 * INVARIANT: NEVER LOSE A BOOKING.
 * Every failure path returns JSON the front end can act on. The one thing this
 * must never do is fail in a way that looks like success.
 */

/* The pricing engine, imported rather than reimplemented.
   ---------------------------------------------------------------
   The same file the browser loads with a <script> tag. Wrangler bundles it, so
   there is exactly one copy of the pricing logic in the system and the server
   cannot drift from what the customer was shown. A second implementation here
   would be the whole problem: it would disagree the first time prices move,
   and it would disagree silently. */
/* A GENERATED module, not the source files directly.
   ---------------------------------------------------------------
   serve-geo-data.js and pricing-engine.js are classic <script> files with no
   export syntax — they publish through `if (typeof module !== "undefined")`,
   which never executes under a bundler that treats .js as ESM. Importing them
   here resolved to undefined, silently, and rejected real bookings on
   2026-09-02 until it was caught in production.

   scripts/build-engine-module.js concatenates those same two files and appends
   a real `export` statement. Nothing is retyped; the test suite fails if the
   generated copy has drifted from its sources. An unambiguous ES module cannot
   half-resolve, which is the property that was missing. */
import {
  computeQuote, serveGeo, lookupGeo, PRICING_VERSION, zipTier,
} from "./engine.generated.mjs";

/**
 * Can this Worker price a home the same way the browser just did?
 *
 * If the geo table did not survive bundling, every mapped ZIP prices at the
 * neutral factor — 02116 comes out $360 instead of $373 — and the verifier
 * rejects real customers while looking perfectly healthy. That is precisely
 * what happened, and the lesson is that a guard must not reject when it cannot
 * price correctly in the first place.
 *
 * Checked once at startup against a ZIP known to be in the map. If this is
 * false, verification is skipped entirely and every booking relays. A guard
 * that has lost its inputs must fail OPEN.
 */
const CAN_PRICE = (() => {
  try {
    if (typeof computeQuote !== "function" || typeof serveGeo !== "function") return false;
    if (typeof lookupGeo !== "function") return false;
    const probe = serveGeo("02116", lookupGeo);
    return probe && probe.mapped === true && probe.factor !== 1;
  } catch (_) {
    return false;
  }
})();

/* Apps Script /exec 302s to googleusercontent.com; fetch follows that by
   default. These caps stop a hung upstream holding a customer's browser. */
/* Deliberately shorter than the browser's own 15s budget, so the customer gets
   this Worker's explanatory 502 rather than their fetch aborting blind. */
const UPSTREAM_TIMEOUT_MS = { submit: 12000, slots: 8000 };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/submit") return handleSubmit(request, env);
    if (url.pathname === "/api/slots")  return handleSlots(request, env);
    if (url.pathname === "/api/job")    return handleJob(request, env);
    if (url.pathname === "/api/address")  return handleAddressSuggest(request, env);
    if (url.pathname === "/api/health")   return handleHealth(env);

    /* Not an API route — hand back to the static asset server. */
    return env.ASSETS.fetch(request);
  },
};


/* ============================================================
   POST /api/submit  ->  booking webhook
   ============================================================ */
async function handleSubmit(request, env) {
  if (request.method !== "POST") {
    return json({ status: "error", error: "method_not_allowed" }, 405);
  }
  if (!env.WEBHOOK_URL) {
    console.error("WEBHOOK_URL is not configured");
    return json({ status: "error", error: "not_configured" }, 500);
  }

  let body;
  try {
    body = await request.text();
  } catch (err) {
    return json({ status: "error", error: "unreadable_body" }, 400);
  }
  if (!body || body.length > 100_000) {
    return json({ status: "error", error: "bad_body" }, 400);
  }

  /* Re-derive the price before relaying it. See verifyPrice(). */
  const audit = verifyPrice(body);
  if (audit.reject) {
    console.error("PRICE REJECTED " + JSON.stringify(audit));
    return json({ status: "error", error: "price_mismatch" }, 409);
  }
  if (audit.note) console.warn("price audit: " + JSON.stringify(audit));

  const upstream = await relay(env.WEBHOOK_URL, {
    method: "POST",
    /* text/plain deliberately: Apps Script reads e.postData.contents either
       way, and it keeps the upstream request simple. The BROWSER now sends
       real JSON to us — this is only how we talk to Google. */
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body,
  }, UPSTREAM_TIMEOUT_MS.submit);

  if (!upstream.ok) {
    /* Say plainly that we could not confirm. The front end shows a real
       failure rather than a green tick, because a customer who believes a
       cleaner is coming and is wrong is the worst outcome in the system. */
    console.error("submit relay failed: " + upstream.error);
    return json({ status: "error", error: "upstream_unreachable",
                  detail: upstream.error }, 502);
  }

  /* Pass the webhook's own JSON straight through — it carries status,
     duplicate, job_id, lead_action, slot_action. */
  return new Response(upstream.text, {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8",
               "Cache-Control": "no-store" },
  });
}


/* ============================================================
   GET /api/slots  ->  availability feed
   ============================================================ */
async function handleSlots(request, env) {
  /* HEAD as well as GET: uptime monitors and link checkers use it, and the
     runtime strips the body for us. Refusing it makes a healthy endpoint look
     broken to anything that probes with HEAD. */
  if (request.method !== "GET" && request.method !== "HEAD") {
    return json({ ok: false, error: "method_not_allowed" }, 405);
  }
  if (!env.AVAILABILITY_URL) {
    /* Not configured is not an outage. The site treats ok:false exactly like
       an empty feed and shows the earlier/later radios, so bookings continue. */
    return json({ ok: false, error: "not_configured" }, 200);
  }

  const upstream = await relay(env.AVAILABILITY_URL, { method: "GET" },
                              UPSTREAM_TIMEOUT_MS.slots);

  if (!upstream.ok) {
    console.error("slots relay failed: " + upstream.error);
    return json({ ok: false, error: "upstream_unreachable" }, 200);
  }

  return new Response(upstream.text, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      /* The feed is already cached 5 minutes upstream. A short edge cache
         absorbs bursts without making slots any staler than they already are. */
      "Cache-Control": "public, max-age=60",
    },
  });
}


/* ============================================================
   GET /api/job  ->  one job ticket
   ============================================================

   Relays id + token + view to Apps Script, which decides what each view may
   see. This layer deliberately knows nothing: it does not validate the token,
   does not choose fields, and does not cache. Putting any of that here would
   mean two places could disagree about who sees an address.

   NEVER CACHED. A ticket carries a home address and when the house is empty;
   an intermediary holding a copy is exactly what must not happen. */
async function handleJob(request, env) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return json({ ok: false, error: "method_not_allowed" }, 405);
  }
  if (!env.WEBHOOK_URL) return json({ ok: false, error: "not_configured" }, 500);

  const url = new URL(request.url);
  const id  = url.searchParams.get("id")   || "";
  const tok = url.searchParams.get("t")    || "";
  const vw  = url.searchParams.get("view") === "partner" ? "partner" : "client";

  /* Cheap rejection before spending an upstream round trip on an obviously
     malformed link. Anything that gets past this is still validated upstream. */
  if (!id || !tok || tok.length < 16) return json({ ok: false, error: "not_found" }, 404);

  const target = env.WEBHOOK_URL +
    "?job="  + encodeURIComponent(id) +
    "&t="    + encodeURIComponent(tok) +
    "&view=" + vw;

  const upstream = await relay(target, { method: "GET" }, UPSTREAM_TIMEOUT_MS.slots);
  if (!upstream.ok) {
    console.error("job relay failed: " + upstream.error);
    return json({ ok: false, error: "upstream_unreachable" }, 502);
  }

  return new Response(upstream.text, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, private",
    },
  });
}


/* ============================================================
   GET /api/health  ->  what this Worker can actually see
   ============================================================

   NAMES ONLY. NEVER VALUES. NOT EVEN TRUNCATED ONES.

   Added 2026-09-06 after several rounds of guessing why a provider key was not
   reaching the Worker — a secret added in the dashboard is invisible from
   outside, so "no_provider" could mean a missing secret, a misspelt one, a
   build-time variable that never reaches runtime, or one attached to a
   different Worker. Those need different fixes and looked identical.

   Listing binding names distinguishes all four in one request, and it stays
   useful: the same question arrives again with Stripe and Twilio keys.

   A binding name is not a secret. A binding VALUE always is. If anyone is ever
   tempted to add "just the first four characters" to help debug, that is the
   moment this endpoint becomes a leak — four characters of a key plus the
   provider name is a real head start. There is a test asserting no value is
   returned. */
function handleHealth(env) {
  const names = Object.keys(env || {})
    .filter(k => typeof env[k] !== "function")
    .sort();

  return json({
    ok: true,
    service: "serve-edge-worker",
    pricing_version: PRICING_VERSION,
    /* Whether the engine survived bundling. False here means every geo-mapped
       ZIP is pricing as unmapped — the 2026-09-02 outage, made visible. */
    can_price: CAN_PRICE,
    bindings: names,
  });
}


/* ============================================================
   GET /api/address  ->  address suggestions while someone types
   ============================================================

   THE ONLY SURVIVOR OF THE PROPERTY-LOOKUP EXPERIMENT.

   /api/property sat beside this until 2026-09-08. It took a confirmed address
   to RentCast and pre-filled the booking form with the home's bedrooms,
   bathrooms and floors, so the customer could confirm rather than type. It was
   removed, and the reason is worth keeping written down:

     Measured against 15 real Boston condo addresses, it matched the ACTUAL
     UNIT 0% of the time. A tower with hundreds of apartments answers as ONE
     record — `matches: 1`, not `ambiguous` — so the multi-unit guard never
     fired and the form confidently pre-filled one arbitrary unit's numbers.
     240 Devonshire St came back 1 bed / 1 bath / 900 sqft for a unit that is
     really 1 bed / 2 baths / 1330 sqft, and passing `&unit=4004` changed
     nothing at all.

   Pre-filling a wrong number is worse than an empty field: it gets confirmed
   without being read. The customer knows their own bed count, and asking is
   both more accurate and free. RentCast was fine on houses and blind to condo
   units, which is precisely the segment Serve targets.

   THE SUGGESTIONS STAYED because they were measured separately and they work:
   100% street match, ranked first, on those same 25 addresses. This is the
   field a cleaner navigates by, and a typo in it is a real problem on the day.

   NEVER A DEPENDENCY. Every failure path returns an empty list, and an empty
   list means the field behaves exactly as it did before this existed: a plain
   text box someone types an address into.

   TYPEAHEAD FIRES FAR MORE THAN A LOOKUP — several calls per address rather
   than one — so the per-IP allowance is higher and the cache TTL is long.
   Street names are not news; a suggestion cached in March is still right in
   November, which is why the hit rate here climbs toward 1 over time.

   WHAT IS TYPED DOES NOT GO IN LOGS. A partial address is still an address.
   The ZIP and a short hash are enough to debug and to measure demand.

   AND ITS ZIP IS NEVER TRUSTED BACK. Geoapify answered 02117 for 37 Appleton
   St, 02205 for 118 B St and 01890 (Winchester) for 5 Lagrange St. The client
   sends the customer's ZIP in to rank results and ignores whatever comes back;
   writing those into the form rejected real Back Bay customers at the coverage
   gate. */

/* Both of these came over from the deleted property endpoint, which is where
   they were first written. addrN and unitN went with it — nothing normalises
   an address for a PROPERTIES key any more. */

/** Five digits, zero-padded. Same shape as webhook.gs zipN, deliberately. */
function zipN(z) {
  const d = String(z ?? "").replace(/[^0-9]/g, "");
  return d ? ("00000" + d).slice(-5) : "";
}

/** Short, non-reversible, enough to correlate two log lines. Never the address. */
async function shortHash(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].slice(0, 5)
    .map(b => b.toString(16).padStart(2, "0")).join("");
}

const SUGGEST_TTL_S       = 60 * 60 * 24 * 180;  // street names are not news
const SUGGEST_EMPTY_TTL_S = 60 * 60 * 24;        // a typo, retried, must not re-bill
const SUGGEST_MONTHLY_CAP = 8000;                // well inside the free 3,000/day
const SUGGEST_IP_PER_HOUR = 120;                 // ~25 addresses typed, at 4-5 calls each
const SUGGEST_MIN_CHARS   = 3;
const SUGGEST_LIMIT       = 5;

/* Greater Boston, as a box. Geoapify's `filter=rect:` is a HARD constraint, not
   a ranking hint, so a suggestion outside this rectangle is never offered —
   which is the behaviour we want, because a Worcester address is one we cannot
   clean. Deliberately a little wider than the served ZIP list: the ZIP field
   does the exact coverage check, and a box that clipped an edge suburb would
   silently make the field useless for people we do serve. */
const SUGGEST_RECT = "-71.40,42.15,-70.85,42.58";

/* Words that end a street name, and words that begin a unit. Used only by
   splitUnit below. EXTENSION is in the street list because "370 Harrison
   Avenue Extension" is a real Boston street and its last token must not be
   mistaken for an apartment. */
const STREET_TAIL = /^(ST|STREET|AVE|AVENUE|RD|ROAD|DR|DRIVE|LN|LANE|CT|COURT|PL|PLACE|TER|TERR|TERRACE|WAY|BLVD|BOULEVARD|WHARF|SQ|SQUARE|HWY|HIGHWAY|PKWY|PARKWAY|CIR|CIRCLE|ROW|PATH|EXT|EXTENSION)$/i;
const UNIT_LEAD   = /^(APT|APARTMENT|UNIT|STE|SUITE|PH|PENTHOUSE)$/i;

/**
 * Split "100 Shawmut Ave 907" into the address to search and the unit to keep.
 *
 * WHY THIS EXISTS. Measured against 25 real condo addresses from the
 * prospecting sheet: the street alone is found 100% of the time, but a bare
 * trailing unit collapses that to 52%. Geoapify handles a recognised
 * designator and chokes on a naked number:
 *
 *     "62 Winthrop St Apt 2"  ->  62 Winthrop Street
 *     "62 Winthrop St #2"     ->  62 Winthrop Street
 *     "62 Winthrop St 2"      ->  nothing at all
 *
 * People type the naked form constantly, and every one of those was a
 * customer offered no suggestions on an address that exists.
 *
 * The unit is not discarded once removed — it is returned, so the caller can
 * carry it into the property lookup (where it disambiguates a building) and
 * pre-fill the confirmation card. Someone who typed their unit should not be
 * asked for it again two steps later.
 *
 * CONSERVATIVE BY CONSTRUCTION. A trailing token is only treated as a unit
 * when a street-type word appears BEFORE it, so "4 Charlesgate East" and
 * "181 W Fifth St" are left alone — there is nothing after the street type to
 * take. Getting this wrong in the other direction would delete part of a
 * street name and search for something that does not exist.
 */
function splitUnit(q) {
  const raw = String(q || "").trim();
  const tokens = raw.split(/\s+/);
  if (tokens.length < 3) return { addr: raw, unit: "" };

  /* An explicit designator wins wherever it appears — never at token 0, which
     is the house number. */
  for (let i = 1; i < tokens.length; i++) {
    if (UNIT_LEAD.test(tokens[i]) || tokens[i].charAt(0) === "#") {
      const addr = tokens.slice(0, i).join(" ");
      return addr.length >= SUGGEST_MIN_CHARS
        ? { addr, unit: tokens.slice(i).join(" ") }
        : { addr: raw, unit: "" };
    }
  }

  /* Otherwise: anything after the LAST street-type word is the unit. */
  let last = -1;
  for (let i = 0; i < tokens.length; i++) if (STREET_TAIL.test(tokens[i])) last = i;
  if (last >= 0 && last < tokens.length - 1) {
    const addr = tokens.slice(0, last + 1).join(" ");
    return addr.length >= SUGGEST_MIN_CHARS
      ? { addr, unit: tokens.slice(last + 1).join(" ") }
      : { addr: raw, unit: "" };
  }

  return { addr: raw, unit: "" };
}

async function handleAddressSuggest(request, env) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return json({ suggestions: [], error: "method_not_allowed" }, 405);
  }

  const url = new URL(request.url);
  const q   = String(url.searchParams.get("q") || "").trim().slice(0, 120);
  const zip = zipN(url.searchParams.get("zip"));

  /* Below this a query matches half the city and costs a call to prove it. */
  if (q.length < SUGGEST_MIN_CHARS) return json({ suggestions: [], reason: "too_short" });

  /* Coverage gate before anything billable, same as the property endpoint. A
     ZIP we do not serve is not worth buying suggestions for. An ABSENT zip is
     fine — people type the street first — and the rectangle still bounds it. */
  if (zip && zipTier(zip) === "unknown") {
    return json({ suggestions: [], reason: "out_of_area" });
  }

  /* Take the unit off before searching, and hand it back with the answer. See
     splitUnit: a bare trailing unit takes the hit rate from 100% to 52%, and
     the customer typed it, so they should not be asked for it again later. */
  const split = splitUnit(q);
  const searchFor = split.addr;
  const unit = split.unit;

  /* Keyed on the ADDRESS, not the raw query, so "100 Shawmut Ave" and
     "100 Shawmut Ave 907" share one cache entry. The unit rides on the
     response rather than inside the cached value, which is why it is
     re-attached on a hit. */
  const key = "sug:" + (zip || "any") + ":" + searchFor.toUpperCase().replace(/\s+/g, " ");
  const tag = await shortHash(key);
  const kv  = env.PROPERTY_CACHE || null;

  if (kv) {
    const hit = await kv.get(key, "json").catch(() => null);
    if (hit) return json({ suggestions: hit, unit, source: "cache" });
  }

  if (!env.GEOAPIFY_KEY) {
    /* THE STUB. The field works without a key — it is a text box — so this
       shipped before the key existed, and the log line measured whether
       anyone would have used it. */
    console.log("address_suggest stub zip=" + (zip || "-") + " tag=" + tag);
    return json({ suggestions: [], unit, reason: "no_provider" });
  }

  if (kv) {
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const ipKey = "sugip:" + (await shortHash(ip)) + ":" + new Date().toISOString().slice(0, 13);
    const seen = Number(await kv.get(ipKey)) || 0;
    if (seen >= SUGGEST_IP_PER_HOUR) {
      console.warn("address_suggest rate_limited zip=" + (zip || "-"));
      return json({ suggestions: [], unit, reason: "rate_limited" });
    }
    await kv.put(ipKey, String(seen + 1), { expirationTtl: 3600 });

    const monthKey = "sugspend:" + new Date().toISOString().slice(0, 7);
    const used = Number(await kv.get(monthKey)) || 0;
    if (used >= SUGGEST_MONTHLY_CAP) {
      console.warn("address_suggest monthly_cap_reached used=" + used);
      return json({ suggestions: [], unit, reason: "cap_reached" });
    }
    await kv.put(monthKey, String(used + 1), { expirationTtl: 60 * 60 * 24 * 40 });
  }

  const suggestions = await fetchSuggestions(env, searchFor, zip);
  console.log("address_suggest provider zip=" + (zip || "-") + " tag=" + tag +
              " n=" + suggestions.length);

  if (kv) {
    await kv.put(key, JSON.stringify(suggestions), {
      expirationTtl: suggestions.length ? SUGGEST_TTL_S : SUGGEST_EMPTY_TTL_S,
    });
  }
  return json({ suggestions, unit, source: "provider" });
}

/**
 * Geoapify autocomplete, reduced to the three fields the form actually uses.
 *
 * THE RESPONSE IS DELIBERATELY NARROW. Geoapify returns coordinates, timezone,
 * place ids, confidence scores and a plus code for every hit. None of that
 * helps someone fill in a form, and all of it would sit in a browser's network
 * log next to a home address. Line, city, ZIP — nothing else leaves here.
 *
 * Anything without a house number is dropped. A street-level hit ("Beacon St,
 * Boston") looks like a real suggestion, fills the box with something the
 * property lookup cannot match, and turns a working fallback into a dead end.
 */
async function fetchSuggestions(env, q, zip) {
  /* `type` is deliberately NOT set. It is a category filter — country, state,
     city, postcode, street, amenity — and the nearest value, `street`, would
     restrict results to streets, which is precisely the shape with no house
     number on it. Unconstrained, Geoapify returns house-level hits and the
     loop below keeps only those. */
  /* THE ZIP IS A SECOND ATTEMPT, NOT PART OF THE FIRST QUERY.
     ---------------------------------------------------------------
     Both simpler designs were tried against production and both are wrong:

     Filtering to the ZIP afterwards throws the whole list away whenever the
     best global matches sit in other ZIPs. "100 washington st" + 02135
     returned NOTHING — Greater Boston has a Washington Street in a dozen ZIPs
     and none of the top hits was in Brighton.

     Appending the ZIP to the query text fixes that and breaks something worse.
     Geoapify only matches a trailing postcode when the STREET NAME IS ALREADY
     COMPLETE. Measured:

         "123 beacon 02116"  ->  123 Beacon Street, Boston, 02116
         "123 beac 02116"    ->  nothing at all
         "50 commonwealth 02116" -> 50 Commonwealth Avenue, Boston, 02116
         "50 comm 02116"     ->  nothing at all

     A partial street name is the NORMAL state of a type-ahead, so that trade
     is backwards: it would break the field for most of every word typed.

     So: ask broadly first, which always answers something for a partial word,
     and order the answer by the typed ZIP. Only when nothing in that answer
     matches the ZIP is a second, narrower call worth making — and that is
     exactly the case where the street name is usually complete enough for the
     postcode trick to land. The common keystroke costs one call; the second
     fires only when the first could not find their ZIP. */
  const broad = await suggestOnce(env, q);
  const ranked = rankByZip(broad, zip);
  if (!zip || ranked.some(s => s.zip === zip) || !broad.length) {
    return ranked.slice(0, SUGGEST_LIMIT);
  }

  const narrow = rankByZip(await suggestOnce(env, q + " " + zip), zip);
  /* Only prefer the narrow answer if it actually found the ZIP. Otherwise the
     broad list is strictly more useful than an empty one. */
  return (narrow.some(s => s.zip === zip) ? narrow : ranked).slice(0, SUGGEST_LIMIT);
}

/** One call to Geoapify, reduced to {line, city, zip}. Never throws. */
async function suggestOnce(env, text) {
  const params = new URLSearchParams({
    text:   text,
    apiKey: env.GEOAPIFY_KEY,
    filter: "rect:" + SUGGEST_RECT,
    limit:  String(SUGGEST_LIMIT * 3),   // room to discard street-only hits
    format: "json",
    lang:   "en",
  });

  try {
    const res = await relay("https://api.geoapify.com/v1/geocode/autocomplete?" + params,
                            { method: "GET" }, UPSTREAM_TIMEOUT_MS.slots);
    if (!res.ok) {
      console.warn("address_suggest provider_error");
      return [];
    }
    const body = JSON.parse(res.text);
    /* Accept both documented shapes. `format=json` answers with `results`;
       geojson answers with `features[].properties`. Reading only one of them
       and getting the other back is a silent empty list — the field would look
       broken with a working key and a paid call behind every keystroke. */
    const list = Array.isArray(body && body.results) ? body.results
               : Array.isArray(body && body.features) ? body.features.map(f => (f && f.properties) || {})
               : [];

    const out = [];
    const seen = new Set();
    for (const r of list) {
      if (!r || !r.housenumber || !r.street) continue;         // no street-only hits
      const line = String(r.housenumber).trim() + " " + String(r.street).trim();
      const rzip = zipN(r.postcode);
      const dedupe = (line + "|" + rzip).toUpperCase();
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      out.push({ line, city: String(r.city || r.suburb || "").trim(), zip: rzip });
    }
    return out;
  } catch (err) {
    /* An outage here must be invisible: the field is still a text box. */
    console.error("address_suggest failed: " + String(err));
    return [];
  }
}

/**
 * The typed ZIP ORDERS the list; it never censors it.
 *
 * Dropping a mismatch assumes the ZIP is right and the geocoder wrong, and it
 * is the other way round often enough to matter: people type the street before
 * the ZIP, mistype their own, or give the town's rather than the delivery
 * area's. Picking a suggestion overwrites the ZIP field, so a mismatch
 * corrects itself the moment it is chosen — an empty list corrects nothing.
 */
function rankByZip(items, zip) {
  if (!zip) return items;
  const inZip = [], elsewhere = [];
  items.forEach(s => (s.zip === zip ? inZip : elsewhere).push(s));
  return inZip.concat(elsewhere);
}



function numOrNull(v) { const n = Number(v); return isFinite(n) && n > 0 ? n : null; }


/* ============================================================
   PRICE VERIFICATION
   ============================================================

   quote_price is computed on the customer's machine. Until this existed it was
   taken entirely on trust — harmless while nothing charged money, and a live
   vulnerability the moment anything did: edit one number in devtools and the
   system would produce a real payment link for a dollar.

   So the server re-derives it from the raw inputs and treats the browser's
   figure as a CLAIM TO VERIFY rather than a fact.

   TWO PRICES CAN DISAGREE FOR TWO REASONS, and they need opposite responses:

     same version, different price   someone edited the payload      -> refuse
     different version               a deploy landed mid-session     -> honour

   The second is real and will happen the day prices move: a tab opened before
   the deploy still holds the old engine. Charging that customer the new price
   would be the single most damaging thing this system could do — a quote that
   changes after the fact is the largest source of one-star reviews in this
   category. So the version stamp is what makes rejection safe: without it,
   every repricing would look like an attack.

   Never fails open on its own bugs. A malformed payload, a missing field, a
   thrown exception — all pass through. This is a guard on a booking path, and
   a guard that eats bookings is worse than the thing it guards against. */
function verifyPrice(rawBody) {
  try {
    const d = JSON.parse(rawBody);

    /* First gate, before anything else. If this Worker cannot reproduce the
       browser's arithmetic, it has no standing to call a price wrong. */
    if (!CAN_PRICE) return { skipped: "engine or geo unavailable in this build" };

    const isReservation = d.event_type === "reservation" || d.event === "quote_reserved";
    if (!isReservation) return { skipped: "not a reservation" };

    const claimed = Number(d.quote_price);
    if (!isFinite(claimed) || claimed <= 0) return { skipped: "no price claimed" };
    if (!d.zip) return { skipped: "no zip to price from" };

    /* geo passed explicitly: computeQuote's internal lookup reads a global that
       does not exist in a bundle. See serveGeo() in pricing-engine.js. */
    const q = computeQuote({
      bedrooms:    Number(d.bedrooms),
      bathrooms:   Number(d.bathrooms),
      service:     d.service || d.service_type,
      condition:   d.condition,
      addonFridge: d.addon_fridge === true,
      addonOven:   d.addon_oven === true,
      zip:         String(d.zip),
      frequency:   d.frequency_selected || "once",
      levels:      Number(d.levels) || 1,
      geo:         serveGeo(String(d.zip), lookupGeo),
    });

    const derived = q.displayPrice;
    if (derived === claimed) return { ok: true };

    const sameEngine = d.pricing_version === PRICING_VERSION;
    const base = {
      claimed: claimed, derived: derived,
      claimedVersion: d.pricing_version || null, serverVersion: PRICING_VERSION,
      submission_id: d.submission_id || null,
    };

    /* Engines differ — the page was loaded before the last deploy. Let it
       through at the price they were actually shown, and log it so a flood of
       these is visible as what it is. */
    if (!sameEngine) return Object.assign(base, { note: "version drift — honoured" });

    /* Same engine, different number. There is no innocent explanation. */
    return Object.assign(base, { reject: true, note: "same engine, different price" });

  } catch (err) {
    /* Includes JSON.parse failing, which handleSubmit does not itself do — the
       body is relayed as text. A booking must not die because this could not
       read it. */
    return { skipped: "verifier error: " + String(err) };
  }
}


/* ============================================================
   Helpers
   ============================================================ */

/**
 * One upstream call with a hard timeout. Never throws — returns
 * { ok, text } or { ok: false, error }, so every caller handles failure
 * explicitly instead of relying on a try/catch somewhere up the stack.
 */
async function relay(target, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(target, {
      ...init,
      signal: controller.signal,
      redirect: "follow",          // /exec 302s to googleusercontent.com
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: "HTTP " + res.status };
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: (err && err.name === "AbortError")
      ? "timeout after " + timeoutMs + "ms"
      : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "Content-Type": "application/json; charset=utf-8",
               "Cache-Control": "no-store" },
  });
}
