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
/* DEFAULT imports, not named ones. Both files export through a conditional
   `if (typeof module !== "undefined")` block so they can still load as classic
   <script> tags in the browser. A bundler cannot statically see inside that
   `if`, so `import { lookupGeo }` compiled to undefined — silently. The default
   import is the whole module.exports object, resolved at runtime, which is
   what actually survives.

   This is not hypothetical. It shipped on 2026-09-02 and rejected every
   booking from a mapped ZIP until it was caught. */
import geoData from "../serve-geo-data.js";
import engine from "../pricing-engine.js";

const lookupGeo      = geoData && geoData.lookupGeo;
const computeQuote   = engine  && engine.computeQuote;
const serveGeo       = engine  && engine.serveGeo;
const PRICING_VERSION = engine && engine.PRICING_VERSION;

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
