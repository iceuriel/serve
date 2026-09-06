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
    if (url.pathname === "/api/property") return handleProperty(request, env);
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

   Added 2026-09-06 after several rounds of guessing why RENTCAST_KEY was not
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
   GET /api/property  ->  what we already know about a home
   ============================================================

   Address in, {beds, baths, levels, sqft, type} out, so the customer CONFIRMS
   their home instead of specifying it. Confirming is a preference; specifying
   is homework, and the homework is what produced a booking quoted at one level
   for a three-storey townhouse — $279 against $466.

   THE PROVIDER IS THE FALLBACK, NOT THE FRONT DOOR. Order is cache, then our
   own PROPERTIES record, then a paid lookup. A repeat customer or an address
   we have quoted before costs nothing and answers instantly, and that gets
   better as the business grows rather than worse.

   WHY THE GUARDS ARE NOT OPTIONAL. Every provider call is billable, this
   endpoint is reachable by anyone, and RentCast's terms make us liable for
   charges from a leaked key "whether such calls are authorized or
   unauthorized," with no refunds and overage billed in $500 increments. Their
   §2(iii) also requires "commercially reasonable measures" against scraping
   through our own infrastructure — so rate limiting here is contractual, not
   merely prudent.

   NEVER A DEPENDENCY. They may throttle, reprice or discontinue at will
   (§13.1). Every failure path returns found:false and the booking form falls
   back to asking. A quote must never require this to work.

   ADDRESSES DO NOT GO IN LOGS. Cloudflare log retention is not the right home
   for a customer's home address; the ZIP and a short hash are enough to debug
   with and enough to measure demand. */

const PROPERTY_TTL_S      = 60 * 60 * 24 * 90;   // a home's bed count is not news
const PROPERTY_MISS_TTL_S = 60 * 60 * 24 * 7;    // an unknown address, retried, must not re-bill
const PROPERTY_MONTHLY_CAP = 400;                // hard stop well under any painful bill
const PROPERTY_IP_PER_HOUR = 12;

/* Same normalisation as webhook.gs zipN/addrN/unitN, deliberately. The cache
   key has to be the same shape as the PROPERTIES key or the two caches miss
   each other and every repeat address bills again. */
function zipN(z)  { const d = String(z ?? "").replace(/[^0-9]/g, ""); return d ? ("00000" + d).slice(-5) : ""; }
function addrN(a) { return String(a ?? "").toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, ""); }
function unitN(u) {
  return String(u ?? "").toUpperCase()
    .replace(/\b(UNIT|APT|APARTMENT|NO|NUM)\b\.?/g, " ")
    .replace(/[^A-Z0-9]+/g, "").replace(/^0+(?=\d)/, "");
}

/** Short, non-reversible, enough to correlate two log lines. Never the address. */
async function shortHash(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].slice(0, 5)
    .map(b => b.toString(16).padStart(2, "0")).join("");
}

async function handleProperty(request, env) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return json({ found: false, error: "method_not_allowed" }, 405);
  }

  const url  = new URL(request.url);
  const zip  = zipN(url.searchParams.get("zip"));
  const addr = addrN(url.searchParams.get("address"));
  const unit = unitN(url.searchParams.get("unit"));

  if (!zip || !addr) return json({ found: false, reason: "incomplete" });

  /* Coverage gate FIRST, before anything billable. We do not clean outside the
     service area, so we have no reason to buy data about it — and this alone
     turns away most traffic that is not a real customer. */
  if (zipTier(zip) === "unknown") {
    return json({ found: false, reason: "out_of_area" });
  }

  const key  = zip + "-" + addr + (unit ? "-" + unit : "");
  const tag  = await shortHash(key);
  const kv   = env.PROPERTY_CACHE || null;      // optional: works before the binding exists

  /* 1. Cache. */
  if (kv) {
    const hit = await kv.get("addr:" + key, "json").catch(() => null);
    if (hit) return json({ ...hit, source: hit.found ? "cache" : "cache_miss" });
  }

  /* 2. Our own record. Free, and the answer we most trust — a customer already
        confirmed it once. */
  const known = await lookupKnownProperty(env, key);
  if (known) {
    if (kv) await kv.put("addr:" + key, JSON.stringify(known), { expirationTtl: PROPERTY_TTL_S });
    return json({ ...known, source: "serve" });
  }

  /* 3. Paid lookup. Everything below here can cost money. */
  if (!env.RENTCAST_KEY) {
    /* THE STUB. Ships before the key so demand can be measured with real
       traffic — observability is on, so these lines are the count that decides
       which plan to buy. Costs nothing and needs no vendor. */
    console.log("property_lookup stub zip=" + zip + " tag=" + tag);
    return json({ found: false, reason: "no_provider" });
  }

  if (kv) {
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const ipKey = "ip:" + (await shortHash(ip)) + ":" + new Date().toISOString().slice(0, 13);
    const seen = Number(await kv.get(ipKey)) || 0;
    if (seen >= PROPERTY_IP_PER_HOUR) {
      console.warn("property_lookup rate_limited zip=" + zip);
      return json({ found: false, reason: "rate_limited" });
    }
    await kv.put(ipKey, String(seen + 1), { expirationTtl: 3600 });

    /* KV counters are eventually consistent, so this can overshoot slightly
       under concurrency. The cap is set far enough below a painful bill that
       being approximate is fine — an exact cap would need a Durable Object,
       which is not worth it to protect a number this small. */
    const monthKey = "spend:" + new Date().toISOString().slice(0, 7);
    const used = Number(await kv.get(monthKey)) || 0;
    if (used >= PROPERTY_MONTHLY_CAP) {
      console.warn("property_lookup monthly_cap_reached used=" + used);
      return json({ found: false, reason: "cap_reached" });
    }
    await kv.put(monthKey, String(used + 1), { expirationTtl: 60 * 60 * 24 * 40 });
  }

  const found = await fetchProvider(env, url.searchParams.get("address"), zip, unit);
  console.log("property_lookup provider zip=" + zip + " tag=" + tag + " found=" + found.found);

  if (kv) {
    await kv.put("addr:" + key, JSON.stringify(found), {
      expirationTtl: found.found ? PROPERTY_TTL_S : PROPERTY_MISS_TTL_S,
    });
  }
  return json({ ...found, source: "provider" });
}

/**
 * Ask Apps Script whether PROPERTIES already has this home. Never fatal — a
 * miss here just means we fall through to the provider, and an outage here must
 * not take the booking form with it.
 */
async function lookupKnownProperty(env, key) {
  if (!env.WEBHOOK_URL) return null;
  const res = await relay(env.WEBHOOK_URL + "?property=" + encodeURIComponent(key),
                          { method: "GET" }, UPSTREAM_TIMEOUT_MS.slots);
  if (!res.ok) return null;
  try {
    const d = JSON.parse(res.text);
    return d && d.found ? d : null;
  } catch (_) { return null; }
}

/**
 * The provider call, isolated so swapping vendors touches one function. The
 * front end only ever sees /api/property — it does not know or care who
 * answered, which is what makes changing supplier a Worker edit rather than a
 * site change.
 */
async function fetchProvider(env, rawAddress, zip, unit) {
  try {
    const q = new URL("https://api.rentcast.io/v1/properties");
    q.searchParams.set("address", String(rawAddress || "") + ", " + zip);
    const res = await fetch(q.toString(), {
      headers: { "X-Api-Key": env.RENTCAST_KEY, "Accept": "application/json" },
    });
    if (!res.ok) return { found: false, reason: "provider_" + res.status };

    const body = await res.json();
    const p = Array.isArray(body) ? body[0] : body;
    if (!p) return { found: false, reason: "no_match" };

    const f = p.features || {};
    return {
      found: true,
      beds:  numOrNull(p.bedrooms),
      baths: numOrNull(p.bathrooms),
      /* Floors is the field this whole feature exists for — and the one their
         own §8.2 warns is often stale, because assessor records "do not always
         include recent additions and/or modifications." Which is exactly how a
         finished loft goes missing. Never rendered as fact; always confirmed. */
      levels:   numOrNull(f.floorCount),
      sqft:     numOrNull(p.squareFootage),
      type:     p.propertyType || null,
      year:     numOrNull(p.yearBuilt),
      unitHint: unit || null,
    };
  } catch (err) {
    console.error("property provider failed: " + String(err));
    return { found: false, reason: "provider_unreachable" };
  }
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
