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
/* The marketplace (2026-11-06): /providers, /providers/<slug>, /api/providers
   and /api/estimate, all backed by D1. A separate module so nothing in it can
   reach the booking paths above, and so this file's one-engine import stays
   exactly what the test harness parses. KEEP THIS ON ONE LINE — the harness
   swaps it for the module it loads itself. */
import * as Market from "./marketplace.js";

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
/* `page` IS THE ODD ONE OUT, AND ON PURPOSE.  r50
   The 2026-09-13 note argued that raising a visitor-facing budget "would not
   remove the wait, only move it into the customer's browser and make them
   watch it". That is right for `slots`, where a failed feed degrades into the
   earlier/later radios and the booking still completes. It is WRONG for the
   three signed-link reads: nothing on /h, /j or /v exists until this one
   request returns, so giving up early does not save the customer a wait — it
   converts their wait into "we could not open that link", which reads as a
   dead credential for a link that is perfectly good.
   A cold Apps Script container routinely answers between 8s and 12s (the warm
   ping makes that rarer, never impossible), and a warm customer portal is ~39
   Sheets calls on top of a 1-2s floor. 8s sat right in the middle of the
   normal range, which is what made the failure INTERMITTENT rather than
   total. 15s clears it, the page shows a skeleton the whole time, and the
   client retries once past that. */
/* `status` is the r56 booking check: one column read upstream, no lock, and a
   browser that is already past a slow submit asking again every few seconds.
   Short on purpose — a poll that has not answered in 10s is better replaced by
   the next poll than waited on. */
const UPSTREAM_TIMEOUT_MS = { submit: 12000, slots: 8000, page: 15000, status: 10000 };

/* HOW LONG /api/slots MAY SPEND BEFORE FALLING BACK TO THE CACHED FEED.
   Deliberately well inside script.js's AVAILABILITY_TIMEOUT_MS (5000), because
   that is the deadline that actually decides what a customer sees: the browser
   aborts at five seconds and draws the earlier/later radios, so a reply at 8s
   is not a slow reply, it is none. Raising this above the client's budget
   silently restores the bug it was written to fix. */
const SLOTS_SOFT_DEADLINE_MS = 2500;

/* THE WARM PING'S BUDGET IS DELIBERATELY THE OPPOSITE OF THE ONES ABOVE. Those
   are short because a customer is waiting behind them. Nobody is waiting behind
   this one, and absorbing a slow cold start HERE is the entire point — a ping
   that gave up after 8s would fail in exactly the case it exists for. */
const WARM_TIMEOUT_MS = 25000;

/* The cron expressions from wrangler.jsonc, which scheduled() branches on.
   They are necessarily duplicated — Cloudflare reads the config, this file
   reads the event — so a test asserts the two agree. */
const CRON_PHOTO_CLEANUP = "17 8 * * *";
const CRON_WARM_UPSTREAM = "*/5 * * * *";

/* ============================================================
   CAMPAIGN SHORT LINKS  —  /newhome, and whatever is printed next
   ------------------------------------------------------------
   A QR code on a mailed postcard is the one URL in this business that CANNOT
   be edited after it ships. So the printed address is short, memorable, and
   carries no parameters, and the tags live here where they can be corrected
   after the cards are in mailboxes. 302, never 301: a 301 is cached by the
   scanning phone and by intermediaries, which would make a re-point silently
   fail for exactly the people who already scanned.

   `src` IS STILL THE LOAD-BEARING TAG, NOT `utm_source` — it is what `source`,
   `src_first` and `src_chain` record, and the utm_* trio rides along because
   the sheet keeps all three.

   BUT THE PREFIX HERE IS DELIBERATELY ONE THAT segmentFor() DOES NOT KNOW.
   That function reads the first dash-segment of `src` to choose which hero and
   which urgency copy renders, and an unrecognised head falls to `direct` — the
   default hero, which assumes nothing. That is the intended landing for a
   printed card (founder's call, 2026-09-28): a mailing list says a household
   probably moved, it does not say what they came to the site for, and putting
   the move-in hero in front of someone who wanted a recurring plan is a worse
   trade than showing them the page that guesses nothing.

   So a key added here must NOT start with a head listed in SRC_SEGMENTS
   (`mv`, `deed`, `db`, `dh`, `qr`, `poster`, `flyer`, `eddm`, `email`, `em`,
   `ref`) unless that segment's hero is genuinely wanted. A test enforces it.
   Nothing is lost by staying out of the taxonomy: `source` keeps the full tag,
   so these rows can be reclassified later once the tag's meaning is settled.

   `utm_content` is deliberately absent: readAttribution() does not read it,
   so it would be a tag that looks tracked and records nothing. Per-design
   variants belong in the `src` tail (mv-newhome-02), which IS recorded, and
   which src_chain keeps even after a second tagged visit.

   EDIT ME: one row per printed piece. Key is the path, exactly as printed. */
const SHORT_LINKS = {
  "/newhome": {
    src:          "newhome-01",
    utm_source:   "thanksio",
    utm_medium:   "direct_mail",
    utm_campaign: "boston_new_homeowners_2026",
  },
};

/* Params already on the incoming URL win, and unknown ones pass through: a
   mail vendor that appends its own per-recipient token must not have it
   stripped on the way to the site. */
function shortLinkRedirect(url) {
  const path = url.pathname.toLowerCase().replace(/\/+$/, "");
  const tags = SHORT_LINKS[path || "/"];
  if (!tags) return null;

  const dest = new URL("/", url.origin);
  for (const [k, v] of Object.entries(tags)) dest.searchParams.set(k, v);
  for (const [k, v] of url.searchParams) dest.searchParams.set(k, v);

  return new Response(null, {
    status: 302,
    headers: { Location: dest.toString(), "Cache-Control": "no-store" },
  });
}

export default {
  /* ONE HANDLER, TWO SCHEDULES. controller.cron says which one fired.

     THE DESTRUCTIVE JOB RUNS ONLY ON AN EXACT MATCH, and anything unrecognised
     falls through to the harmless one. cleanupPhotoStorage deletes objects from
     R2 and POSTs to the booking webhook; if a cron string is ever changed in
     wrangler.jsonc and not here, the failure in this direction is "photos stop
     being tidied up" — recoverable, and visible in storage. The other
     direction, an unrecognised schedule running the deleter every five minutes,
     is not a trade worth the symmetry. */
  async scheduled(controller, env, ctx) {
    const cron = controller && controller.cron;

    if (cron === CRON_PHOTO_CLEANUP) {
      ctx.waitUntil(cleanupPhotoStorage(env));
      return;
    }
    if (cron !== CRON_WARM_UPSTREAM) {
      console.error("unknown cron schedule " + JSON.stringify(cron) +
                    " — warming only. Check wrangler.jsonc against the CRON_* " +
                    "constants in src/worker.js.");
    }
    ctx.waitUntil(warmUpstreams(env));
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/submit") return handleSubmit(request, env, ctx);
    if (url.pathname === "/api/booking-status") return handleBookingStatus(request, env, ctx);
    /* THE ONE PUBLIC, CROSS-ORIGIN ROUTE. See publicCors() for why this is
       safe here and nowhere else. The preflight is answered before the handler
       because a browser sends OPTIONS with no body and no content type, which
       handleQuote would correctly reject as a bad request. */
    if (url.pathname === "/api/quote") {
      if (request.method === "OPTIONS") return corsPreflight(url.pathname);
      return publicCors(await handleQuote(request, env), url.pathname);
    }
    if (url.pathname === "/api/checkout") return handleCheckout(request, env);
    /* Stripe calls this one, not a browser. It is the only route whose caller
       proves itself with a signature rather than a ticket token. */
    if (url.pathname === "/api/stripe-webhook") return handleStripeWebhook(request, env);
    /* THE SECOND PUBLIC ROUTE, 2026-09-25. A price with no times beside it is
       half an answer to the only question an agent is really asking. */
    if (url.pathname === "/api/slots") {
      if (request.method === "OPTIONS") return corsPreflight(url.pathname);
      return publicCors(await handleSlots(request, env, ctx), url.pathname);
    }
    if (url.pathname === "/api/job")    return handleJob(request, env);
    if (url.pathname === "/api/photos") return handlePhotos(request, env);
    if (url.pathname === "/api/address")  return handleAddressSuggest(request, env, ctx);
    if (url.pathname === "/api/portal")   return handlePortal(request, env, ctx);
    if (url.pathname === "/api/vendor")   return handleVendor(request, env);
    if (url.pathname === "/api/health")   return handleHealth(env);

    /* The marketplace. Only its own paths are handed over, so a fault in it can
       never reach a booking route above or the static site below. */
    if (isMarketplacePath(url.pathname)) {
      const res = await Market.handleMarketplace(request, env, ctx, url);
      if (res) return res;
    }

    /* Printed QR codes, before the asset server can 404 them. */
    const short = shortLinkRedirect(url);
    if (short) return short;

    /* Not an API route — hand back to the static asset server. */
    return env.ASSETS.fetch(request);
  },
};


/* ============================================================
   POST /api/submit  ->  booking webhook
   ============================================================ */
async function handleSubmit(request, env, ctx) {
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
  const audit = await verifyPrice(body, env);
  if (audit.reject) {
    console.error("PRICE REJECTED " + JSON.stringify(audit));
    return json({ status: "error", error: "price_mismatch" }, 409);
  }
  if (audit.note) console.warn("price audit: " + JSON.stringify(audit));

  /* THE HAPPY PATH USED TO BE SILENT, which made the signed path invisible in
     production: a browser whose signQuote() quietly failed would fall back to
     booking unsigned and look exactly like a browser that never had one. That
     is the failure this project keeps meeting — healthy from the outside, doing
     nothing on the inside — so say when a price was proved rather than only
     when one was doubted. A submission_id is a random client id, not a person. */
  if (audit.authenticated) {
    console.log("price authenticated: " + (audit.submission_id || "no id"));
  }

  /* r55. Ask the webhook to answer once the sheets are written and leave the
     text and email to us — but only when there is a waitUntil to send them
     from. See sendBookingNotify. */
  const canDefer = !!(ctx && typeof ctx.waitUntil === "function");

  const upstream = await relay(env.WEBHOOK_URL, {
    method: "POST",
    /* text/plain deliberately: Apps Script reads e.postData.contents either
       way, and it keeps the upstream request simple. The BROWSER now sends
       real JSON to us — this is only how we talk to Google. */
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: canDefer ? withDeferredNotify(body) : body,
  }, UPSTREAM_TIMEOUT_MS.submit);

  if (!upstream.ok) {
    /* Say plainly that we could not confirm. The front end shows a real
       failure rather than a green tick, because a customer who believes a
       cleaner is coming and is wrong is the worst outcome in the system. */
    console.error("submit relay failed: " + upstream.error);
    return json({ status: "error", error: "upstream_unreachable",
                  detail: upstream.error }, 502);
  }

  if (canDefer) {
    let reply = null;
    try { reply = JSON.parse(upstream.text); } catch (_) { /* passed through below */ }
    if (reply && reply.status === "ok" && reply.notify_pending === true && reply.submission_id) {
      ctx.waitUntil(sendBookingNotify(env, String(reply.submission_id)));
    }
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
   THE BOOKING'S TEXT AND EMAIL, AFTER THE CUSTOMER IS CONFIRMED  —  r55
   ============================================================

   "Reserve" used to take ~15s: the webhook answered only after Twilio and
   Gmail, which pushed it past the 12s submit budget, so the browser sat
   through a 502 and a retry before "You're on the schedule". Now the webhook
   parks the text and email and answers once the sheets are written; this
   sends them from waitUntil, where nobody is waiting.

   NOTHING HERE CAN MAKE A BOOKING FAIL OR A TEXT GO OUT TWICE. The webhook
   claims each notice under its lock and sends it at most once, and a call that
   never lands is picked up by the five-minute sweep in warmUpstreams. The
   budget is the warm ping's, not the submit one: absorbing a cold start is the
   point, and waitUntil allows 30s. */
function withDeferredNotify(body) {
  try {
    const data = JSON.parse(body);
    if (!data || typeof data !== "object" || Array.isArray(data)) return body;
    data.notify_deferred = true;
    return JSON.stringify(data);
  } catch (_) {
    return body;             // the webhook reports an unparseable body itself
  }
}

/* ============================================================
   GET /api/booking-status?id=<submission_id>   ->   did that booking land?
   ============================================================

   THE ROUTE THAT STOPS A GOOD BOOKING SHOWING THE FAILURE PANEL.  r56

   /api/submit is a write with a 12s budget, and when it overruns the browser
   learns nothing — not "it failed", only "I did not hear back". For most of
   this project's life those were treated as the same thing, so a booking that
   had fully succeeded (row, text, email) could still end on the yellow panel.

   This is the other question. It relays one column read that takes no script
   lock upstream, so it answers in about a second EVEN WHILE the slow write is
   still running. The browser polls it after a slow submit and shows the
   confirmation the moment the row exists.

   ALWAYS 200, NEVER A 502. Every answer this route can give means one of two
   things to the caller: "the booking is there" or "I still don't know". An
   unreachable upstream is the second, and the caller's response to it is to
   ask again shortly, not to give up — so a status code that reads as an
   outage would be actively misleading.

   NOTHING IS WRITTEN AND NOTHING CAN BE. The upstream is a GET.
   ============================================================ */
async function handleBookingStatus(request, env, ctx) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return json({ ok: false, error: "method_not_allowed" }, 405);
  }
  if (!env.WEBHOOK_URL) return json({ ok: false, error: "not_configured" });

  const id = new URL(request.url).searchParams.get("id") || "";
  /* The shape a browser's crypto.randomUUID() makes, and the same shape the
     webhook keys a parked notice on. Rejected here so a malformed poll never
     costs an upstream round trip. */
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) {
    return json({ ok: false, error: "bad_submission_id" });
  }

  const upstream = await relay(
    env.WEBHOOK_URL + "?booking=" + encodeURIComponent(id),
    { method: "GET" }, UPSTREAM_TIMEOUT_MS.status);

  if (!upstream.ok) {
    /* Not an error the customer sees: their next poll is a second or two away.
       Logged because a run of these is what a genuinely down upstream looks
       like. A submission_id is a random client id, not a person. */
    console.warn("booking status " + id + " unanswered: " + upstream.error);
    return json({ ok: false, error: "upstream_unreachable" });
  }

  let reply = null;
  try { reply = JSON.parse(upstream.text); } catch (_) { /* reported below */ }

  /* A webhook older than r56 does not know `booking` and answers its health
     stamp instead — well-formed JSON with no `found` in it. Say so out loud
     rather than reporting a cheerful found:false forever: an un-pasted script
     is the one failure here that looks exactly like a booking that never
     landed, and it is the founder's to fix, not the customer's. */
  if (!reply || typeof reply.found !== "boolean") {
    console.error("booking status: upstream has no ?booking route — paste " +
                  "apps-script/webhook.gs r56 or later into Leads MASTER.");
    return json({ ok: false, error: "upstream_stale" });
  }

  /* r55's parked text and email. If we are the first caller to hear that a
     notice is waiting — which is exactly the case this route exists for, since
     the Worker that took the booking gave up before it was answered — send it
     now rather than leaving it to the five-minute sweep. */
  if (reply.found === true && reply.notify_pending === true &&
      ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(sendBookingNotify(env, id));
  }

  return json({ ok: true, found: reply.found });
}


async function sendBookingNotify(env, submissionId) {
  const res = await relay(env.WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ event_type: "booking_notify", submission_id: submissionId }),
  }, WARM_TIMEOUT_MS);
  /* A submission_id is a random client id, not a person. Error level on
     failure: the sweep will send it late, and this line says why it was late. */
  if (res.ok) console.log("booking notify " + submissionId + ": " + res.text);
  else console.error("booking notify " + submissionId + " failed, the sweep will retry: " + res.error);
}


/* ============================================================
   GET /api/slots  ->  availability feed
   ============================================================ */
async function handleSlots(request, env, ctx) {
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

  /* ---------------------------------------------------------------
     THE CLIENT GIVES UP FIRST, AND THAT IS THE WHOLE CONSTRAINT.

     script.js aborts this fetch after AVAILABILITY_TIMEOUT_MS — 5 seconds —
     and drops to the earlier/later radios. So an answer that takes 8s is not
     a slow answer, it is NO answer: the customer has already been moved on.

     The first version of this fix waited the full upstream budget and only
     then served the cached feed, which made every probe succeed under curl
     and changed nothing whatsoever in a browser. Measuring with a client that
     has no deadline is not measuring what customers hit.

     So when there is a cached feed to fall back on, the upstream races a
     deadline well inside the client's. Miss it and the cache is served at
     once; the request already in flight is NOT cancelled — it rides on
     waitUntil and populates the cache when it lands, which is what makes the
     next caller fast. Nobody waits for it. */
  const cachedEarly = await readLastSlots(env);

  /* STILL INSIDE THE UPSTREAM'S OWN CACHE WINDOW — do not ask. The answer
     would be byte-identical to what is already in hand, and the call is what
     a public endpoint makes expensive. See SLOTS_UPSTREAM_CACHE_MS. */
  if (cachedEarly) {
    const age = slotsFeedAgeMs(cachedEarly);
    if (age !== null && age < SLOTS_UPSTREAM_CACHE_MS) {
      return new Response(publicSlotsFeed(cachedEarly), {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          /* Safe to edge-cache for what is left of the upstream window, and
             never longer: the number below is the remaining life of this
             exact payload, not a fixed guess. */
          "Cache-Control": "public, max-age=" +
            Math.max(1, Math.floor((SLOTS_UPSTREAM_CACHE_MS - age) / 1000)),
          "X-Serve-Slots": "fresh",
        },
      });
    }
  }

  if (cachedEarly) {
    const inFlight = relay(env.AVAILABILITY_URL, { method: "GET" }, WARM_TIMEOUT_MS);
    const raced = await Promise.race([
      inFlight,
      new Promise(resolve => setTimeout(() => resolve(null), SLOTS_SOFT_DEADLINE_MS)),
    ]);

    if (raced && raced.ok) {
      if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(saveLastSlots(env, raced.text));
      return new Response(publicSlotsFeed(raced.text), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8",
                   "Cache-Control": "public, max-age=60",
                   "X-Serve-Slots": "live" },
      });
    }

    /* Either the deadline won or the upstream failed outright. Serve what we
       have and let the in-flight request finish in the background. */
    if (ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(inFlight.then(r => { if (r && r.ok) return saveLastSlots(env, r.text); })
                            .catch(() => {}));
    }
    return new Response(publicSlotsFeed(cachedEarly), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        /* NOT edge-cached: the next request must try the upstream again, and
           by then the in-flight refresh above has usually landed. */
        "Cache-Control": "no-store",
        "X-Serve-Slots": "stale",
      },
    });
  }

  /* No cache yet — the first cold start after a deploy, or KV is down. There
     is nothing to serve early, so the full budget is the right one to spend. */
  const upstream = await relay(env.AVAILABILITY_URL, { method: "GET" },
                              UPSTREAM_TIMEOUT_MS.slots);

  if (upstream.ok) {
    /* Keep the last good answer. Written after the response is decided and
       never awaited on the hot path — a KV hiccup must not cost a customer
       their slot list when the feed itself answered perfectly. */
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(saveLastSlots(env, upstream.text));
    return new Response(publicSlotsFeed(upstream.text), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        /* The feed is already cached 5 minutes upstream. A short edge cache
           absorbs bursts without making slots any staler than they already are. */
        "Cache-Control": "public, max-age=60",
        "X-Serve-Slots": "live",
      },
    });
  }

  console.error("slots relay failed: " + upstream.error);

  /* Both attempts are spent here only when there was nothing to fall back on.
     See the race above for why the cached path never reaches this far, and for
     the measurement that prompted all of it. */
  /* Nothing cached yet — the first cold start after a deploy, or KV is down.
     Only here is it worth making the caller wait for a second attempt, because
     the alternative is genuinely nothing. */
  const retry = await relay(env.AVAILABILITY_URL, { method: "GET" },
                            UPSTREAM_TIMEOUT_MS.slots);
  if (retry.ok) {
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(saveLastSlots(env, retry.text));
    return new Response(retry.text, {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8",
                 "Cache-Control": "public, max-age=60",
                 "X-Serve-Slots": "retry" },
    });
  }

  console.error("slots retry failed too: " + retry.error);
  return json({ ok: false, error: "upstream_unreachable" }, 200);
}


/* The last feed that actually answered. Stored under its own key in the same
   namespace the address cache uses — adding a binding means a dashboard step
   the founder has to take, and this needs none. */
const LAST_SLOTS_KEY = "slots:last-good";
const LAST_SLOTS_TTL_S = 60 * 60;   // see the cap argument in handleSlots

/**
 * What the availability feed is allowed to say out loud.
 *
 * THE COUNT NEVER LEAVES THIS WORKER. Upstream, each slot carries `open` — how
 * many cleanings could still be sold at that hour. Published verbatim on
 * 2026-09-25, that read: two slots a day, every day for three weeks, every one
 * of them open. Which is a precise, machine-readable statement that Serve has
 * no bookings, handed to anybody who asks — an agent ranking providers, or a
 * competitor with curl. Nobody needs a capacity number to choose a time.
 *
 * CLAMPED TO 1 RATHER THAN DROPPED, because serve-slots.js filters on
 * `s.open > 0` and a field removed outright would empty the booking form's
 * picker. So a bookable slot still says 1, a slot with nothing left is dropped
 * exactly as the client would have dropped it, and how MANY is never stated.
 *
 * ONE SHAPE FOR EVERYONE, not a richer one for our own page. Anything the
 * browser receives is already public — it is one devtools tab away — so a
 * second, wider projection would leak the same number while costing a second
 * thing to keep right.
 *
 * Never throws. Unparseable upstream text is passed through untouched: this is
 * a narrowing step, and a narrowing step that can fail closed would turn a
 * malformed feed into no feed at all.
 */
function publicSlotsFeed(text) {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || !Array.isArray(parsed.slots)) return text;
    parsed.slots = parsed.slots
      .filter(s => s && Number(s.open) > 0)
      .map(s => ({ date: s.date, time: s.time, open: 1 }));
    /* `count` described the list before it was filtered; leaving the old
       number beside a shorter list invites a caller to trust the wrong one. */
    parsed.count = parsed.slots.length;
    return JSON.stringify(parsed);
  } catch (_) {
    return text;
  }
}

/**
 * How old the held feed may be before asking upstream is worth a quota call.
 *
 * THIS IS THE UPSTREAM'S OWN CACHE WINDOW, not a number picked for taste.
 * availability.gs sets CACHE_SECONDS: 300 and stamps `generated` when it
 * actually rebuilds, so every request inside those five minutes returns a
 * payload with the SAME stamp we already hold. Asking again buys nothing and
 * spends an Apps Script execution to be told what we knew.
 *
 * WHICH IS WHY OPENING THIS ROUTE IS SAFE. Apps Script has a daily execution
 * quota, and the same quota takes BOOKINGS. Before this, every caller cost one
 * upstream attempt; a public, documented endpoint polled once a second would
 * have burned the day's budget by lunch and taken /api/submit down with it —
 * so the first symptom of a busy scraper would have been customers unable to
 * book. Capped here at roughly one upstream call a minute no matter who asks.
 */
const SLOTS_UPSTREAM_CACHE_MS = 5 * 60 * 1000;

/** Age of a held feed in ms, from its own `generated` stamp. null if unknown. */
function slotsFeedAgeMs(text) {
  try {
    const at = Date.parse((JSON.parse(text) || {}).generated);
    if (!isFinite(at)) return null;
    /* A stamp from the future is a clock disagreement, not a fresh feed.
       Treated as unknown so it can never pin us to a stale copy forever. */
    const age = Date.now() - at;
    return age < 0 ? null : age;
  } catch (_) {
    return null;
  }
}

async function saveLastSlots(env, text) {
  const kv = env.PROPERTY_CACHE;
  if (!kv || !text) return;
  /* Only store something that parses AND carries slots. Caching ok:false, or a
     Google sign-in page, would turn one bad minute into a whole hour of it. */
  try {
    const parsed = JSON.parse(text);
    if (!parsed || parsed.ok !== true || !Array.isArray(parsed.slots) || !parsed.slots.length) return;
    await kv.put(LAST_SLOTS_KEY, text, { expirationTtl: LAST_SLOTS_TTL_S });
  } catch (_) { /* not JSON — nothing worth keeping */ }
}

async function readLastSlots(env) {
  const kv = env.PROPERTY_CACHE;
  if (!kv) return null;
  return kv.get(LAST_SLOTS_KEY).catch(() => null);
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
  /* POST is the customer editing an instruction on their own ticket. Same
     route because it is the same resource; the token in the body is what
     authorises it, and Apps Script checks that a client token was used. */
  if (request.method === "POST") return handleJobWrite(request, env);

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

  const upstream = await relay(target, { method: "GET" }, UPSTREAM_TIMEOUT_MS.page);
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

/**
 * POST /api/job — one instruction, from the customer's own ticket.
 *
 * This layer stays deliberately thin, exactly like the GET above: it does not
 * validate the token, does not decide which rooms exist, and does not know
 * what a scope key is. Apps Script owns all of that, because a second opinion
 * on authorisation is a second place for the two to disagree.
 *
 * THE TOKEN TRAVELS IN THE BODY, NOT THE QUERY STRING. A query string lands in
 * proxy logs, browser history and referrer headers; this token is the only
 * thing standing between a URL and someone's home.
 */
async function handleJobWrite(request, env) {
  if (!env.WEBHOOK_URL) return json({ ok: false, error: "not_configured" }, 500);

  let body;
  try {
    body = await request.text();
  } catch (_) {
    return json({ ok: false, error: "unreadable_body" }, 400);
  }
  if (!body || body.length > 8000) return json({ ok: false, error: "bad_body" }, 400);

  const upstream = await relay(env.WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body,
  }, UPSTREAM_TIMEOUT_MS.submit);

  if (!upstream.ok) {
    console.error("instruction relay failed: " + upstream.error);
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
   /api/portal  ->  one customer's homes and bookings
   ============================================================

   GET  reads the portal; POST saves an instruction or an access answer.

   Thin, exactly like /api/job. This layer does not validate the token, does
   not decide which bookings belong to whom, and does not cache. Apps Script
   owns all of it, because a second opinion on authorisation is a second place
   for the two to disagree.

   NEVER CACHED, and the token travels in the BODY on writes. A query string
   lands in proxy logs, browser history and referrer headers; this token is the
   only thing between a URL and a customer's whole account. */
async function handlePortal(request, env, ctx) {
  if (!env.WEBHOOK_URL) return json({ ok: false, error: "not_configured" }, 500);

  if (request.method === "POST") {
    let body;
    try {
      body = await request.text();
    } catch (_) {
      return json({ ok: false, error: "unreadable_body" }, 400);
    }
    if (!body || body.length > 8000) return json({ ok: false, error: "bad_body" }, 400);

    const up = await relay(env.WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body,
    }, UPSTREAM_TIMEOUT_MS.submit);
    if (!up.ok) {
      console.error("portal write relay failed: " + up.error);
      return json({ ok: false, error: "upstream_unreachable" }, 502);
    }
    return afterPortalWrite(up.text, env, ctx);
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return json({ ok: false, error: "method_not_allowed" }, 405);
  }

  const url = new URL(request.url);
  const id  = url.searchParams.get("id") || "";
  const tok = url.searchParams.get("t")  || "";
  /* Cheap rejection before spending a round trip on an obviously malformed
     link. Anything past this is still validated upstream. */
  if (!id || !tok || tok.length < 16) return json({ ok: false, error: "not_found" }, 404);

  const up = await relay(
    env.WEBHOOK_URL + "?portal=" + encodeURIComponent(id) + "&t=" + encodeURIComponent(tok),
    { method: "GET" }, UPSTREAM_TIMEOUT_MS.page);
  if (!up.ok) {
    console.error("portal relay failed: " + up.error);
    return json({ ok: false, error: "upstream_unreachable" }, 502);
  }
  return portalResponse(up.text);
}

/**
 * A cancelled booking should not leave a hold sitting on the customer's card.
 *
 * Apps Script cancels the visit and, when that visit had a live authorization,
 * names the PaymentIntent in its reply. This is the only place in the system
 * that knows both facts at once: Apps Script holds the row but must never hold
 * the Stripe key, and the Worker holds the key but does not know what was
 * cancelled until the answer comes back.
 *
 * TWO THINGS HAPPEN HERE AND THE ORDER MATTERS.
 *
 * `payment_ref` IS STRIPPED BEFORE THE BROWSER SEES IT. It is not a secret and
 * nothing can be done with it without the account key, but it is an internal
 * reconciliation handle that a customer's page has no use for, and the house
 * rule is that view models are whitelists — a field reaches a browser because
 * somebody put it there on purpose. This one is used and dropped.
 *
 * THE RELEASE NEVER DELAYS OR FAILS THE CANCELLATION. It runs after the answer
 * is already on its way back, because the customer's visit is cancelled either
 * way and making them wait on Stripe to hear so would trade a certainty for a
 * network call. A failed release leaves the hold exactly where it was before
 * this existed, and the cancellation email still tells a human to check.
 */
function afterPortalWrite(text, env, ctx) {
  let out;
  try {
    out = JSON.parse(text);
  } catch (_) {
    /* Not ours to interpret. Hand it back untouched, exactly as before. */
    return portalResponse(text);
  }
  if (!out || !out.payment_ref) return portalResponse(text);

  const ref = String(out.payment_ref);
  delete out.payment_ref;

  const release = releaseHold(env, ref);
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(release);

  return portalResponse(JSON.stringify(out));
}

function portalResponse(text) {
  return new Response(text, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, private",
    },
  });
}


/* ============================================================
   /api/vendor  ->  one partner company's portal
   ============================================================

   GET reads it; POST saves a profile field, a service, or a team member.

   Thin, like every other relay here. Apps Script owns the token check, the
   ownership check and the field whitelist — a second opinion on authorisation
   is a second place for the two to disagree.

   NEVER CACHED, and the token travels in the BODY on writes. */
async function handleVendor(request, env) {
  if (!env.WEBHOOK_URL) return json({ ok: false, error: "not_configured" }, 500);

  if (request.method === "POST") {
    let body;
    try {
      body = await request.text();
    } catch (_) {
      return json({ ok: false, error: "unreadable_body" }, 400);
    }
    if (!body || body.length > 8000) return json({ ok: false, error: "bad_body" }, 400);

    const up = await relay(env.WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body,
    }, UPSTREAM_TIMEOUT_MS.submit);
    if (!up.ok) {
      console.error("vendor write relay failed: " + up.error);
      return json({ ok: false, error: "upstream_unreachable" }, 502);
    }
    return portalResponse(up.text);
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return json({ ok: false, error: "method_not_allowed" }, 405);
  }

  const url = new URL(request.url);
  const id  = url.searchParams.get("id") || "";
  const tok = url.searchParams.get("t")  || "";
  if (!id || !tok || tok.length < 16) return json({ ok: false, error: "not_found" }, 404);

  const up = await relay(
    env.WEBHOOK_URL + "?vendor=" + encodeURIComponent(id) + "&t=" + encodeURIComponent(tok),
    { method: "GET" }, UPSTREAM_TIMEOUT_MS.page);
  if (!up.ok) {
    console.error("vendor relay failed: " + up.error);
    return json({ ok: false, error: "upstream_unreachable" }, 502);
  }
  return portalResponse(up.text);
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
function isMarketplacePath(pathname) {
  const p = pathname.replace(/\/+$/, "");
  return p === "/api/estimate" || p === "/api/providers" || p === "/providers" ||
         p.startsWith("/providers/");
}

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
    /* Whether QUOTE_SECRET is bound. False means quotes go out unsigned and
       nothing books through the authenticated path — the site looks perfectly
       healthy either way, which is exactly why it is reported here. */
    can_sign: !!(env && env.QUOTE_SECRET),
    can_store_photos: !!(env && env.BOOKING_PHOTOS && env.PHOTO_BRIDGE_SECRET && env.WEBHOOK_URL),
    /* Whether a payment link can be issued, and — the part worth reporting out
       loud — whether it would move real money. A live key reaching production
       unnoticed is the one mistake here that cannot be undone with a redeploy. */
    can_charge: !!(env && env.STRIPE_SECRET_KEY),
    stripe_mode: stripeMode(env),
    /* Whether a payment, once taken, can be WRITTEN DOWN. False beside
       can_charge: true is the specific dangerous combination — cards would be
       charged and every customer surface would go on saying "Not yet
       authorized" forever. Reported separately so that combination is one
       request away from being obvious, instead of a support call. */
    can_record_payments: !!(env && env.STRIPE_WEBHOOK_SECRET &&
                            env.PAYMENT_BRIDGE_SECRET && env.WEBHOOK_URL),
    /* The marketplace (2026-11-06). has_marketplace_db false means /providers
       says "opening soon" and /api/estimate refuses. can_notify_estimates false
       beside it means requests ARE saved but the founder is never emailed —
       the quiet failure, so it is reported on its own. */
    has_marketplace_db: !!(env && env.MARKET_DB),
    can_notify_estimates: !!(env && env.MARKET_BRIDGE_SECRET && env.WEBHOOK_URL),
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

async function handleAddressSuggest(request, env, ctx) {
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

  /* 2026-09-15. A cache miss used to make its storage calls one after another
     (read, write, read, write) before the provider, and one more after it.
     The two counter reads now go together, then the two counter writes. BOTH
     WRITES ARE STILL AWAITED BEFORE THE PROVIDER IS CALLED, so a guard that
     cannot record a call still stops it — the spend limit fails closed. Only
     saving the answer, once it is paid for, happens after the response. */
  if (kv) {
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const now = new Date().toISOString();
    const ipKey = "sugip:" + (await shortHash(ip)) + ":" + now.slice(0, 13);
    const monthKey = "sugspend:" + now.slice(0, 7);
    const [seenRaw, usedRaw] = await Promise.all([kv.get(ipKey), kv.get(monthKey)]);
    const seen = Number(seenRaw) || 0;
    const used = Number(usedRaw) || 0;
    if (seen >= SUGGEST_IP_PER_HOUR) {
      console.warn("address_suggest rate_limited zip=" + (zip || "-"));
      return json({ suggestions: [], unit, reason: "rate_limited" });
    }
    if (used >= SUGGEST_MONTHLY_CAP) {
      console.warn("address_suggest monthly_cap_reached used=" + used);
      return json({ suggestions: [], unit, reason: "cap_reached" });
    }
    await Promise.all([
      kv.put(ipKey, String(seen + 1), { expirationTtl: 3600 }),
      kv.put(monthKey, String(used + 1), { expirationTtl: 60 * 60 * 24 * 40 }),
    ]);
  }

  const suggestions = await fetchSuggestions(env, searchFor, zip);
  console.log("address_suggest provider zip=" + (zip || "-") + " tag=" + tag +
              " n=" + suggestions.length);

  if (kv) {
    /* The answer is already paid for, so failing to save it must not cost the
       customer their suggestions. After the response when the runtime allows
       it; awaited otherwise (the test harnesses pass no ctx). */
    const save = kv.put(key, JSON.stringify(suggestions), {
      expirationTtl: suggestions.length ? SUGGEST_TTL_S : SUGGEST_EMPTY_TTL_S,
    }).catch(() => console.warn("address_suggest cache_put_failed zip=" + (zip || "-")));
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(save);
    else await save;
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
   SIGNED QUOTES  —  POST /api/quote
   ============================================================

   THE PRICE STOPS BEING A CLAIM AND BECOMES SOMETHING WE ISSUED.

   verifyPrice below re-derives the browser's arithmetic and refuses a payload
   that disagrees. That is an audit, and an audit has to fail open — see the
   long note there. Five separate payload shapes therefore relay a $1 booking
   today, the cheapest being to send a `pricing_version` nobody has heard of.
   All five are acceptable on a lead form, where the worst case is a wrong
   number in a spreadsheet an operator reads. None is acceptable once that
   number selects an amount to charge a card.

   So the server also ISSUES prices. The browser posts the inputs, this Worker
   runs the same engine and hands back the price together with an HMAC over
   (inputs, price, engine version, expiry). At submit the browser returns the
   signature, and verifying it proves the figure came from here — no
   arithmetic, no version negotiation, nothing the customer's machine can move.

   WHY THIS DOES NOT SIMPLY REPLACE THE AUDIT. A signature can be absent for
   entirely innocent reasons: a tab opened before this deployed, a blocked
   request, an engine that could not price. Requiring one would drop those
   bookings, which is the trade the audit exists to refuse to make. So an
   unsigned payload still books, on exactly the terms it books on today.

   The gate that matters is downstream instead: a job whose price was never
   signature-verified is not chargeable without a human. That is the whole
   design in one line — LENIENT ABOUT BOOKING, STRICT ABOUT MONEY.

   THE SECRET IS THIS WORKER'S OWN. The four ticket audiences are minted in
   Apps Script under TICKET_SECRET and none of them opens another; this is a
   fifth audience under a SEPARATE key, so that a quote signature leaking can
   never be worked backwards into a portal link.

       npx wrangler secret put QUOTE_SECRET

   Unbound, /api/quote answers with a price and no signature, and everything
   downstream behaves exactly as it did before signatures existed. */

const QUOTE_TTL_S = 60 * 60 * 2;

/**
 * The exact string the signature covers.
 *
 * ISSUING AND VERIFYING BOTH CALL THIS, on their own request bodies, which is
 * the only reason the two can be trusted to agree. An inlined second copy that
 * read one field differently would produce signatures that never verify — or,
 * far worse, signatures that verify while covering less than they appear to.
 * Add a priced input here and to computeQuote's arguments in the same edit.
 */
/* What a refused ZIP is told instead of a price. Prose, not a ZIP list: the
   list is 60 entries and changes, and an agent that cached it would go on
   refusing a town Serve had started serving. Ask again and find out. */
const SERVICE_AREA_NOTE = "Greater Boston and nearby towns";

function quoteScope(d) {
  return [
    "q1",
    zipN(d.zip),
    Number(d.bedrooms),
    Number(d.bathrooms),
    Number(d.levels) || 1,
    String(d.service || d.service_type || ""),
    /* STRING, not Number. `condition` is a LABEL — "standard", "heavy" — that
       the engine looks up in PRICING.CONDITION, and Number("heavy") is NaN.
       Coercing it collapsed every condition to the same NaN, so a signature
       bought for a standard clean verified against a heavy one at the standard
       price: the signed path short-circuits the audit that used to catch that.
       Shipped that way for one deploy on 2026-09-10 and caught by the scope
       string printing NaN in test output. Bind what is SENT; never coerce a
       priced input to a type it does not have. */
    String(d.condition),
    d.addon_fridge === true ? "1" : "0",
    d.addon_oven === true ? "1" : "0",
    String(d.frequency_selected || "once"),
  ].join("|");
}

/** The engine call, written once so /api/quote and the audit cannot diverge. */
function priceFrom(d) {
  return computeQuote({
    bedrooms:    Number(d.bedrooms),
    bathrooms:   Number(d.bathrooms),
    service:     d.service || d.service_type,
    condition:   d.condition,
    addonFridge: d.addon_fridge === true,
    addonOven:   d.addon_oven === true,
    zip:         String(d.zip),
    frequency:   d.frequency_selected || "once",
    levels:      Number(d.levels) || 1,
    /* geo passed explicitly: computeQuote's internal lookup reads a global that
       does not exist in a bundle. See serveGeo() in pricing-engine.js. */
    geo:         serveGeo(String(d.zip), lookupGeo),
  });
}

/**
 * The three recurring per-visit prices for this home, or null.
 *
 * r45. UNSIGNED AND NOT PART OF THE SCOPE, on purpose. These are what the
 * customer portal shows somebody who booked a move-in / move-out and is now
 * choosing a plan, and what Apps Script asks for again when they pick one —
 * so the number that lands on the booking is re-derived from this engine by
 * the server, never carried over from a browser. Nothing charges against it
 * on that path, so there is nothing for a signature to protect.
 *
 * The recurring track does not depend on service, condition or add-ons —
 * see R3/R7 in pricing-engine.js — so it is the same number a first-clean
 * customer with this home is shown on the booking form.
 */
function recurringFrom(q) {
  const f = q && q.freqSteady;
  if (!f) return null;
  const out = {};
  for (const k of ["weekly", "biweekly", "monthly"]) {
    const n = Number(f[k]);
    if (!isFinite(n) || n <= 0) return null;
    out[k] = n;
  }
  return out;
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  /* Hex rather than base64url, which is 21 characters longer and worth it: hex
     needs nothing but ECMAScript, while btoa is a host global. This project has
     already lost an hour of live bookings to something that existed in the
     browser and not in the bundle, and the token rides in a JSON body where its
     length buys us nothing. It is URL-safe as a side effect. */
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
}

/** `q1.<unix expiry>.<signature>` — self-describing, so a format change is visible. */
async function signQuote(secret, d, price, exp) {
  const sig = await hmac(secret, ["q1", quoteScope(d), price, PRICING_VERSION, exp].join("|"));
  return "q1." + exp + "." + sig;
}

/**
 * Three outcomes, deliberately, and they are not interchangeable:
 *
 *   ok        this price came from us, for these inputs
 *   skipped   we are not in a position to judge  -> fall through to the audit
 *   note      the signature is wrong             -> refuse
 *
 * EXPIRY COUNTS AS "SKIPPED", NOT AS TAMPERING. A stale token means a slow
 * afternoon, not an attack, and rejecting it would fail a real booking. It
 * drops to the unsigned path, which is where such a booking would have been
 * anyway — and stays unchargeable without a human, which is the point.
 */
async function checkQuoteSig(secret, d, claimed) {
  if (!secret) return { skipped: "QUOTE_SECRET not bound" };

  const parts = String(d.quote_sig).split(".");
  if (parts.length !== 3 || parts[0] !== "q1") return { note: "malformed quote signature" };

  const exp = Number(parts[1]);
  if (!isFinite(exp)) return { note: "malformed quote expiry" };
  if (exp * 1000 < Date.now()) return { skipped: "quote signature expired" };

  const expected = await signQuote(secret, d, claimed, exp);

  /* Length-independent compare. The timing margin on an edge worker is
     academic, but a token check written the obvious way is the kind of thing
     that gets copied into somewhere it matters. */
  const a = expected, b = String(d.quote_sig);
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ (b.charCodeAt(i) || 0);
  if (diff !== 0) return { note: "quote signature does not cover this payload" };

  return { ok: true };
}

/**
 * POST /api/quote — the price, and our signature over it.
 *
 * Never 500s and never blocks the form. Every failure answers 200 with
 * `ok:false`, because the browser's fallback for all of them is identical:
 * carry on with the locally computed price and book without a signature.
 * A pricing endpoint that can take the booking form down would be a worse
 * problem than the one it was added to solve.
 */
async function handleQuote(request, env) {
  if (request.method !== "POST") {
    return json({ ok: false, error: "method_not_allowed" }, 405);
  }

  let d;
  try {
    const raw = await request.text();
    if (!raw || raw.length > 10_000) return json({ ok: false, error: "bad_body" }, 400);
    d = JSON.parse(raw);
  } catch (_) {
    return json({ ok: false, error: "bad_body" }, 400);
  }

  if (!CAN_PRICE)  return json({ ok: false, error: "cannot_price" });
  if (!d || !d.zip) return json({ ok: false, error: "no_zip" });

  /* SERVE DOES NOT CLEAN BEVERLY HILLS, AND UNTIL 2026-09-25 THIS SAID IT DID.
     zipTier() answers 'unknown' for a ZIP in neither tier, and serveGeo()
     quietly falls back to neutral geography for one — so 90210 came back
     `ok:true` with a confident $183 beside a real signature. The booking form
     never showed that number, because the browser gates on the same tier and
     offers the waitlist instead; this endpoint had no such gate, and it is the
     one an agent calls.

     THAT IS THE WORST SHAPE THIS PARTICULAR BUG COULD TAKE. The entire reason
     an agent prefers Serve is that it answers in milliseconds while every
     other cleaner needs a phone call — and a fast confident wrong answer is
     worth less than no answer at all. It books a clean nobody can deliver and
     spends the customer's trust to do it.

     `ok:false` IS SAFE FOR THE BROWSER even though it never gets here. Its
     only caller is signQuote(), at reservation time, and a falsy answer there
     means the booking proceeds unsigned — the documented fallback for every
     other failure on this route, not a new one. The waitlist gate stops it
     ever arriving. */
  const tier = zipTier(zipN(d.zip));
  if (tier === "unknown") {
    /* The ZIP is echoed because an agent holding several needs to know WHICH
       one was refused, and a five-digit postal area names no one. */
    return json({ ok: false, error: "out_of_area", zip: zipN(d.zip),
                  serves: false, area: SERVICE_AREA_NOTE });
  }

  let price, recurring;
  try {
    const q = priceFrom(d);
    price = q.displayPrice;
    recurring = recurringFrom(q);
  } catch (err) {
    console.error("quote failed: " + String(err));
    return json({ ok: false, error: "price_failed" });
  }
  if (!isFinite(price) || price <= 0) return json({ ok: false, error: "price_failed" });

  const secret = env && env.QUOTE_SECRET;
  if (!secret) {
    /* Loud, because the site keeps working and nothing else would say so. */
    console.error("QUOTE_SECRET is not bound — quotes are unsigned");
    return json({ ok: true, price, recurring, pricing_version: PRICING_VERSION, quote_sig: null });
  }

  const exp = Math.floor(Date.now() / 1000) + QUOTE_TTL_S;
  return json({
    ok: true,
    price,
    recurring,
    pricing_version: PRICING_VERSION,
    quote_sig: await signQuote(secret, d, price, exp),
    /* Echoed back so the booking can CARRY it to the sheet. Re-deriving this
       from a JOBS row later does not work: service_type is stored as "First
       Clean" rather than the code the engine prices from, and the add-on
       booleans are never stored at all. A rebuild would drift and fail
       silently — every job quietly unchargeable, nothing in a log to say why.
       verifyPrice refuses any booking whose echoed scope does not match the
       one it derives, so what reaches the sheet is provably the verified one. */
    quote_scope: quoteScope(d),
    expires_at: exp,
  });
}


/* ============================================================
   PAYMENT  —  POST /api/checkout
   ============================================================

   Hands back a Stripe Checkout URL for one booking. That URL is the "payment
   link": the customer clicks it from their portal, Stripe collects the card,
   and Serve never sees a card number or takes on any of the handling that
   would come with seeing one.

   THE ONE RULE THIS ENDPOINT EXISTS TO ENFORCE: THE CALLER DOES NOT SAY WHAT
   TO CHARGE. It sends a job id and the credential proving the job is theirs.
   The amount is then read out of the JOBS row through the same token-checked
   lookup the portal itself uses. There is no field on this request that could
   carry a price, which is the only version of this that cannot be argued with
   — the whole point of signing quotes was to stop a number that has been in a
   browser from choosing what a card is charged, and accepting one here would
   have handed it straight back.

   AUTHORIZE NOW, CAPTURE LATER. `capture_method: manual` puts a HOLD on the
   card rather than taking the money: the funds are guaranteed to Serve but not
   collected. That matches the operating fact that a partner still has to
   accept each job — Serve should not be holding somebody's money for work
   nobody has agreed to do. An operator captures when the partner accepts.

   The hold lapses after about seven days. Acceptance has to happen inside that
   window or the authorization has to be retaken; nothing here enforces that,
   and it is an operating decision rather than a coding one. */

/* Above this, something is wrong with the row rather than with the customer.
   A TRIPWIRE, NOT A PRICE RULE: it exists so a corrupted cell, a stray zero or
   a units mix-up cannot reach a card. Real quotes are hundreds of dollars, so
   a genuine booking never comes near it — and if one ever does, the fix is to
   look at the row, not to raise the number. */
const MAX_CHARGE_CENTS = 250000;   // $2,500

/**
 * Is this key test money or real money?
 *
 * STRIPE ISSUES TWO KINDS OF SECRET KEY AND BOTH ARE VALID HERE. A standard
 * secret key is `sk_test_…` / `sk_live_…`; a RESTRICTED key, which is the
 * better practice because it can be limited to just the few permissions this
 * Worker needs, is `rk_test_…` / `rk_live_…`. Both carry the mode in the same
 * position.
 *
 * Matching only `sk_test_` reported a restricted TEST key as LIVE. That errs
 * in the safe direction — it over-warns rather than under-warns — but a health
 * line that cries wolf is a health line nobody reads, and this particular line
 * exists to catch the one mistake on this project that a redeploy cannot
 * undo. Anything unrecognised still reads LIVE, deliberately: an unfamiliar
 * key shape must never be assumed harmless.
 */
function stripeMode(env) {
  const key = env && env.STRIPE_SECRET_KEY;
  if (!key) return "none";
  return /^(sk|rk)_test_/.test(key) ? "test" : "LIVE";
}

async function handleCheckout(request, env) {
  if (request.method !== "POST") {
    return json({ ok: false, error: "method_not_allowed" }, 405);
  }
  if (!env.STRIPE_SECRET_KEY) {
    /* Not configured is not an outage — the button simply does not appear. */
    console.error("STRIPE_SECRET_KEY is not bound — checkout unavailable");
    return json({ ok: false, error: "not_configured" });
  }
  if (!env.WEBHOOK_URL) return json({ ok: false, error: "not_configured" });

  let d;
  try {
    const raw = await request.text();
    if (!raw || raw.length > 4000) return json({ ok: false, error: "bad_body" }, 400);
    d = JSON.parse(raw);
  } catch (_) {
    return json({ ok: false, error: "bad_body" }, 400);
  }

  const jobId     = String((d && d.job_id) || "");
  const contactId = String((d && d.contact_id) || "");
  const tok       = String((d && d.t) || "");
  if (!jobId || tok.length < 16) {
    return json({ ok: false, error: "not_found" }, 404);
  }

  /* THE AMOUNT COMES FROM HERE AND NOWHERE ELSE.
     Two ways in, because the customer has two surfaces that both show a price:
     the portal, which is what the confirmation email sends, and one job's own
     client ticket. Each is read back through the SAME token-checked lookup its
     own page already uses, so ownership is proved upstream by Apps Script
     rather than assumed here.
     A PARTNER TOKEN OPENS NEITHER. It is a different audience under the same
     secret, the upstream refuses it, and the view check below refuses it
     again — a cleaner must never be able to raise a charge on a customer. */
  const lookup = contactId
    ? env.WEBHOOK_URL + "?portal=" + encodeURIComponent(contactId) +
      "&t=" + encodeURIComponent(tok)
    : env.WEBHOOK_URL + "?job=" + encodeURIComponent(jobId) +
      "&t=" + encodeURIComponent(tok) + "&view=client";

  const up = await relay(lookup, { method: "GET" }, UPSTREAM_TIMEOUT_MS.page);
  if (!up.ok) {
    console.error("checkout portal read failed: " + up.error);
    return json({ ok: false, error: "upstream_unreachable" }, 502);
  }

  let model;
  try {
    model = JSON.parse(up.text);
  } catch (_) {
    return json({ ok: false, error: "upstream_unreadable" }, 502);
  }
  if (!model || model.ok !== true) return json({ ok: false, error: "not_found" }, 404);

  /* A portal answers with every booking on the account; a client ticket
     answers with the one its token opens. Anything else — a partner view, a
     health check from an older deployment answering ok:true — is not something
     to price from. The ticket's own page hit that exact ordering bug on
     2026-09-08, which is why this checks the VIEW and not merely `ok`. */
  let booking = null;
  if (model.view === "portal") {
    booking = (model.bookings || []).find(b => String(b.bookingId) === jobId) || null;
  } else if (model.view === "client") {
    booking = model.booking || null;
  }
  /* A job id that is not on THIS credential belongs to somebody else, and the
     answer is the same one an unknown job gets. Never say which it was. */
  if (!booking) return json({ ok: false, error: "not_found" }, 404);

  if (booking.completed) return json({ ok: false, error: "already_completed" });
  if (booking.paid)      return json({ ok: false, error: "already_paid" });

  const cents = Math.round(Number(booking.price) * 100);
  if (!isFinite(cents) || cents <= 0) {
    return json({ ok: false, error: "no_price_on_file" });
  }
  if (cents > MAX_CHARGE_CENTS) {
    console.error("checkout refused, price above tripwire: " + jobId + " " + cents);
    return json({ ok: false, error: "price_out_of_range" });
  }

  /* Built here, never taken from the request: a caller-supplied return address
     would turn this into an open redirect wearing Stripe's domain. The portal
     token is deliberately NOT in it — the page stashes its own credential
     before leaving and restores it on the way back, so a permanent customer
     credential never lands in a third party's dashboard. */
  const origin = new URL(request.url).origin;

  const form = new URLSearchParams();
  form.set("mode", "payment");
  form.set("payment_intent_data[capture_method]", "manual");
  form.set("payment_intent_data[description]", "Serve — " + (booking.serviceLabel || "cleaning"));
  form.set("line_items[0][quantity]", "1");
  form.set("line_items[0][price_data][currency]", "usd");
  form.set("line_items[0][price_data][unit_amount]", String(cents));
  form.set("line_items[0][price_data][product_data][name]",
           (booking.serviceLabel || "Cleaning") +
           (booking.date ? " — " + booking.date : ""));
  /* Back to the surface they started on. Bouncing a ticket-payer to the portal
     would land them on a page their credential does not open, immediately
     after paying — the worst possible moment to show "this link is
     incomplete". Each page restores its own stashed credential. */
  const back = contactId ? "/h" : "/j";
  form.set("success_url", origin + back + "?pay=done");
  form.set("cancel_url",  origin + back + "?pay=cancelled");
  /* Reconciliation handles, both opaque ids rather than anything about a
     person. This is what the Stripe webhook keys on when it writes the payment
     back to the row.

     IT MUST BE SET TWICE, AND THE SECOND ONE IS THE ONE THAT MATTERS.
     METADATA DOES NOT PROPAGATE FROM A CHECKOUT SESSION TO THE PAYMENTINTENT
     IT CREATES. They are separate objects with separate metadata bags, and
     Stripe copies nothing between them.

     Setting only `metadata[…]` meant exactly one of the five subscribed events
     could find its booking:

       checkout.session.completed              object = the SESSION      -> found it
       payment_intent.amount_capturable_updated object = the PAYMENTINTENT -> NO job id
       payment_intent.succeeded                 object = the PAYMENTINTENT -> NO job id
       payment_intent.canceled                  object = the PAYMENTINTENT -> NO job id
       charge.refunded                          charge inherits from the PI -> NO job id

     `payment_intent.succeeded` IS THE CAPTURE — the event that means money
     actually moved. So the founder captured in the dashboard, the event
     arrived with an empty metadata bag, the Worker correctly logged "carries
     no job_id, ignored", and the portal never learned the customer had paid.
     Found 2026-09-16 by the founder testing the real path end to end.

     The tests did not catch this because they hand-built PaymentIntent events
     WITH metadata and asserted the handler reads it — proving the handler
     right about a message Stripe was never going to send. A suite can only be
     as honest as its fixtures. */
  form.set("client_reference_id", jobId);
  form.set("metadata[job_id]", jobId);
  form.set("payment_intent_data[metadata][job_id]", jobId);
  if (contactId) {
    form.set("metadata[contact_id]", contactId);
    form.set("payment_intent_data[metadata][contact_id]", contactId);
  }

  let res, text;
  try {
    res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + env.STRIPE_SECRET_KEY,
        "Content-Type": "application/x-www-form-urlencoded",
        /* A double-click must not create two holds on one card. Keyed on the
           amount as well as the job, so a repriced booking is legitimately a
           new session rather than silently reusing the old figure.

           THE TIME BUCKET IS NOT DECORATION. Stripe caches the RESPONSE BODY
           against an idempotency key for 24 hours, so without it, expiring a
           link and reissuing it for the same job at the same price replays the
           original session — and hands the customer a URL that is already
           dead. That is exactly the recovery an operator reaches for after a
           failed attempt, so the bug would surface on the worst possible day.
           A double-click needs seconds of protection, not a day; ten minutes
           covers the click, the impatient reload and the back button, and
           anything slower than that legitimately deserves a fresh session.

           Checking `session.status === "open"` instead does NOT work: that
           reads the cached body, which reports the status as it was at
           creation rather than as it is now. */
        "Idempotency-Key": "serve-" + jobId + "-" + cents + "-" +
                           Math.floor(Date.now() / 600000),
      },
      body: form.toString(),
    });
    text = await res.text();
  } catch (err) {
    console.error("stripe unreachable: " + String(err));
    return json({ ok: false, error: "stripe_unreachable" }, 502);
  }

  if (!res.ok) {
    /* Stripe's message names the parameter it disliked and carries nothing
       about the customer. Logged in full because a silent checkout failure is
       the hardest kind to diagnose; returned only as a generic error. */
    console.error("stripe rejected the session: HTTP " + res.status + " " + text.slice(0, 500));
    return json({ ok: false, error: "stripe_error" }, 502);
  }

  let session;
  try {
    session = JSON.parse(text);
  } catch (_) {
    return json({ ok: false, error: "stripe_unreadable" }, 502);
  }
  if (!session.url) return json({ ok: false, error: "stripe_no_url" }, 502);

  /* Amount and job, never a name or an address. This is the line that answers
     "was a link ever issued for this booking, and for how much". */
  const mode = stripeMode(env);
  console.log("checkout session created: " + jobId + " " + cents + " " +
              mode.toUpperCase());

  return json({ ok: true, url: session.url, amount: cents,
                test_mode: mode === "test" });
}


/* ============================================================
   PAYMENT STATE  —  POST /api/stripe-webhook
   ============================================================

   THE OTHER HALF OF /api/checkout, AND WITHOUT IT THE FIRST HALF LIES.

   Until this existed, nothing anywhere recorded that a card had been
   authorized. `payment_status` was typed by hand, so a customer who had just
   paid reloaded their portal and was told "Not yet authorized" — with the
   Authorize button still sitting there inviting them to do it twice. That was
   survivable while the key was `sk_test_`. It is not survivable with real
   money, and it is the reason the live key waited for this.

   WHY STRIPE TELLS US RATHER THAN US ASKING STRIPE. The customer's browser is
   the one thing we must not believe: it comes back to `/h?pay=done` whether or
   not a card was ever charged, and anyone can type that URL. Stripe signs
   these callbacks with a secret only Stripe and this Worker hold, which makes
   them the only account of what happened to the money that is worth writing to
   a sheet.

   THE SIGNATURE IS THE WHOLE SECURITY MODEL. This route writes payment state
   for any job id it is handed. Unverified, it would be a public endpoint for
   marking anybody's booking paid. So: no signature, no write — and the body is
   verified as the exact bytes that arrived, before anything parses it.

   WHAT IT DOES NOT DO. It never captures, never refunds, never cancels. Every
   movement of real money stays a human's deliberate click in the Stripe
   dashboard; this only writes down what already happened. The one exception is
   the customer's own cancellation, which voids their hold — see releaseHold,
   where it is the customer acting on their own card. */

/* Stripe's own default. An event older than this is a replay, not news. The
   writes below are idempotent and rank-guarded, so this is a second lock on a
   door that is already bolted — kept because a stale event that somehow named
   a rebooked job is exactly the kind of thing worth refusing outright. */
const STRIPE_SIG_TOLERANCE_S = 300;

/* Stripe event -> what it means for a booking. Everything absent from this map
   is acknowledged and ignored: Stripe sends dozens of event types, an endpoint
   subscribed to more than it needs is normal, and answering anything but 200
   to a routine event would have Stripe retrying it for three days. */
const STRIPE_EVENT_STATES = {
  /* The customer finished checkout. With capture_method: manual this means a
     hold is placed and no money has moved. */
  "checkout.session.completed":              "authorized",
  /* The hold is confirmed on the card. Belt and braces with the above — either
     can arrive first, and the rank guard upstream makes that not matter. */
  "payment_intent.amount_capturable_updated": "authorized",
  /* Captured. THIS is the event that means money actually moved. */
  "payment_intent.succeeded":                "paid",
  /* The hold was voided or lapsed. The card is free and the booking is back to
     needing authorization, which is a real state and not an error. */
  "payment_intent.canceled":                 "released",
  "charge.refunded":                         "refunded",
};

/**
 * Verify a `Stripe-Signature` header against the raw body.
 *
 * The header looks like `t=1699999999,v1=<hex>,v1=<hex>` — more than one v1 is
 * normal while a secret is being rotated, and ANY of them matching is a pass.
 * The signed payload is `<t>.<raw body>`, so this has to run on the exact bytes
 * that arrived. Parsing first and re-serialising would change them.
 */
async function verifyStripeSignature(rawBody, header, secret, nowS) {
  if (!header || !secret) return false;

  let ts = "";
  const claimed = [];
  for (const part of String(header).split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === "t") ts = v;
    else if (k === "v1") claimed.push(v);
  }
  if (!ts || !claimed.length) return false;

  const age = Math.abs(nowS - Number(ts));
  if (!isFinite(age) || age > STRIPE_SIG_TOLERANCE_S) return false;

  const expected = await hmac(secret, ts + "." + rawBody);
  return claimed.some(c => timingSafeEqual(c, expected));
}

/**
 * Compare two hex strings without leaking where they diverge.
 *
 * A plain `===` returns as soon as it finds a difference, and the time that
 * takes is measurable across enough requests — which is a way to guess a
 * signature one character at a time. Both inputs here are fixed-length hex, so
 * comparing every character and OR-ing the differences costs the same whatever
 * the answer is.
 */
function timingSafeEqual(a, b) {
  const x = String(a), y = String(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

async function handleStripeWebhook(request, env) {
  if (request.method !== "POST") {
    return json({ ok: false, error: "method_not_allowed" }, 405);
  }
  /* Not configured is not an outage — it means payment state is still being
     read off whatever an operator typed, exactly as it was before this route
     existed. Loud in the log, because the symptom (portals that never notice a
     payment) looks nothing like the cause. */
  if (!env.STRIPE_WEBHOOK_SECRET || !env.PAYMENT_BRIDGE_SECRET || !env.WEBHOOK_URL) {
    console.error("stripe webhook arrived but the route is not configured");
    return json({ ok: false, error: "not_configured" }, 503);
  }

  let raw;
  try {
    raw = await request.text();
  } catch (_) {
    return json({ ok: false, error: "unreadable_body" }, 400);
  }
  /* Stripe events are small. A megabyte of anything is not one, and the point
     of the cap is to refuse it before spending an HMAC on it. */
  if (!raw || raw.length > 262144) return json({ ok: false, error: "bad_body" }, 400);

  const nowS = Math.floor(Date.now() / 1000);
  const good = await verifyStripeSignature(
    raw, request.headers.get("Stripe-Signature"), env.STRIPE_WEBHOOK_SECRET, nowS);
  if (!good) {
    /* No DISCRIMINATING detail, in the answer or the log. "Timestamp too old"
       versus "bad digest" is a free hint to whoever is probing, and neither
       tells US anything a wrong secret would not.

       The line below is a different thing and gives that up nothing. It is
       IDENTICAL for every rejection, so it separates no two cases for anyone
       probing, and it says only what `bad_signature` already said. What it adds
       is a name for the cause that is overwhelmingly the likely one on the day
       a live key goes in: TEST AND LIVE ARE DIFFERENT ENDPOINTS THAT SIGN WITH
       DIFFERENT SECRETS, so a live endpoint added without also swapping
       STRIPE_WEBHOOK_SECRET rejects every real payment — while /api/health goes
       on reporting `can_record_payments: true`, because it can see only that A
       secret is bound, never that it is the RIGHT one.

       It rides in the body for the same reason the write-back failure below
       does: Stripe's Event deliveries tab shows the body of every attempt, so
       the founder reads the diagnosis in their own dashboard with no Cloudflare
       login and no tail running at the right moment. Nothing in it depends on
       the secret, the request, or the mode. */
    console.error("stripe webhook signature rejected");
    return json({ ok: false, error: "bad_signature",
                  hint: "STRIPE_WEBHOOK_SECRET does not match the endpoint " +
                        "that sent this. Test and live are separate endpoints " +
                        "with different signing secrets." }, 400);
  }

  let event;
  try {
    event = JSON.parse(raw);
  } catch (_) {
    return json({ ok: false, error: "bad_body" }, 400);
  }

  const type  = String((event && event.type) || "");

  /* GOING LIVE IS TWO SECRET SWAPS, NOT ONE, AND A HALF-DONE SWAP IS SIGNED
     CORRECTLY. Test and live are separate worlds in Stripe — separate keys,
     separate endpoints, separate signing secrets — and an endpoint left over in
     the other mode keeps delivering perfectly valid events long after the key
     has moved. Every verified event says which world it came from.

     THE TWO DIRECTIONS NEED OPPOSITE HANDLING, and getting that backwards is
     worse than not checking at all:

       live event, test key   WRITE IT ANYWAY. The money is real. Refusing real
                              payment state over a configuration smell is
                              precisely the bug this subsystem already shipped
                              once — a customer who has paid, told they have
                              not, with an Authorize button inviting a second
                              hold on the same card. The signature already
                              proved the event came from our own account; the
                              mode disagreement is OUR plumbing being wrong, not
                              the payment being false. Loud in the log instead.

       test event, LIVE key   REFUSE. Writing it marks a REAL booking paid on
                              play money — the same lie in the other direction,
                              and the more dangerous one, because nobody is
                              waiting to contradict it. Answered 200 rather than
                              500 on purpose: a retry cannot change what mode an
                              event was born in, and three days of them would
                              bury the real deliveries in the founder's
                              dashboard at exactly the wrong moment.

     Strict equality, because a real Stripe event ALWAYS carries `livemode`. An
     event without it is not a third case to invent handling for. */
  const keyIsLive = stripeMode(env) === "LIVE";
  if (event && event.livemode === false && keyIsLive) {
    console.error("TEST Stripe event refused on a LIVE key — a test-mode " +
                  "endpoint is still pointed at this URL: " + type);
    return json({ ok: true, ignored: "test_event_on_live_key" });
  }
  if (event && event.livemode === true && !keyIsLive) {
    console.error("LIVE Stripe event arrived while STRIPE_SECRET_KEY reads " +
                  stripeMode(env) + " — real money moved and the key has not " +
                  "been swapped. Recording it: " + type);
  }

  const state = STRIPE_EVENT_STATES[type];
  /* Acknowledged, not an error. See the note on the map above. */
  if (!state) return json({ ok: true, ignored: type });

  const obj = (event.data && event.data.object) || {};
  const jobId = String((obj.metadata && obj.metadata.job_id) || obj.client_reference_id || "");
  if (!jobId) {
    /* A payment that is genuinely not ours — someone else's test event, or a
       charge raised from the dashboard by hand — has no job to write to.
       Answered 200 on purpose: retrying will not grow a job id. */
    console.log("stripe event carries no job_id, ignored: " + type);
    return json({ ok: true, ignored: "no_job_id" });
  }

  /* The PaymentIntent id is the handle that ties a sheet row to the Stripe
     dashboard, and it is what the cancellation path later voids. A charge
     names its intent in a different field than a session does. */
  const ref = String(
    obj.object === "checkout.session" ? (obj.payment_intent || "")
      : obj.object === "charge"       ? (obj.payment_intent || "")
      : (obj.id || ""));

  /* A checkout session under automatic capture would already be money taken.
     Serve always sets manual capture, so this should never fire — it is here
     so that if that ever changes, the customer is not told a hold was placed
     when they have actually been charged. */
  const settled = (obj.object === "checkout.session" && obj.payment_status === "paid")
    ? "paid" : state;

  const cents = Number(obj.amount_total || obj.amount_captured ||
                       obj.amount_capturable || obj.amount || 0) || 0;

  const wrote = await recordPayment(env, {
    job_id: jobId, state: settled, payment_ref: ref, amount_cents: cents,
  });

  if (!wrote.ok) {
    /* THE 500 IS LOAD-BEARING. Stripe retries a failed webhook with backoff
       for up to three days, which is a more durable queue than anything worth
       building here. Answering 200 on a failed write would drop the payment
       state permanently and silently, and the customer would be the one to
       notice. */
    console.error("payment write-back failed, asking Stripe to retry: " +
                  jobId + " " + settled + " — " + wrote.error);
    /* THE REASON RIDES IN THE RESPONSE BODY, and that is deliberate.
       Stripe's Event deliveries tab shows the body of every attempt, so this
       turns the founder's own dashboard into the diagnostic — no Cloudflare
       log access, no wrangler login, no tail running at the right moment.
       It matters because the causes need opposite fixes and look identical
       from outside:

         not_found              the bridge secret here does not match the Apps
                                Script Script Property of the same name
         timeout after 15000ms  Apps Script was cold or holding its lock
         no_column              JOBS has no payment_status header
         HTTP 4xx/5xx           the /exec deployment itself is unhappy

       SAFE TO EXPOSE: every one of these is a short machine string about OUR
       plumbing. No customer data, no amount, no id beyond the job. And the
       only caller who can ever see it has already proved it is Stripe by
       signing the request — an unsigned caller is refused long before here. */
    return json({ ok: false, error: "write_failed", reason: wrote.error }, 500);
  }

  /* Job, state and amount. Never a name, an address or a card. */
  console.log("payment recorded: " + jobId + " " + settled + " " + cents +
              " " + (wrote.applied === false ? "(no change)" : ""));
  return json({ ok: true, job_id: jobId, state: settled });
}

/**
 * Write one payment state onto the JOBS row, through Apps Script.
 *
 * The Worker cannot touch the sheet directly and should not learn how: Apps
 * Script owns every write, which is what keeps "who may change this column" a
 * question with one answer. PAYMENT_BRIDGE_SECRET is the same shape of shared
 * secret as PHOTO_BRIDGE_SECRET and exists for the same reason — the /exec URL
 * is public, so the upstream must be able to tell this Worker from anyone else
 * who has found it.
 */
async function recordPayment(env, fields) {
  const up = await relay(env.WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(Object.assign({
      event_type: "payment_event",
      bridge_token: env.PAYMENT_BRIDGE_SECRET,
    }, fields)),
  }, UPSTREAM_TIMEOUT_MS.page);

  if (!up.ok) return { ok: false, error: up.error };
  try {
    const out = JSON.parse(up.text);
    if (!out || out.ok !== true) return { ok: false, error: (out && out.error) || "refused" };
    return { ok: true, applied: out.applied };
  } catch (_) {
    return { ok: false, error: "unreadable" };
  }
}

/**
 * Void the hold on a cancelled booking.
 *
 * WHY THIS IS NOT "SERVE MOVING MONEY". Everywhere else, a human decides. Here
 * the customer has just called the visit off themselves, and the only question
 * is whether their card stays encumbered for a week afterwards for a cleaning
 * nobody is coming to do. Leaving it is not the cautious choice — it is the one
 * that reads as being charged for a service they cancelled.
 *
 * Cancelling a PaymentIntent releases the hold and can never take money, so the
 * worst failure here is a hold that lingers exactly as long as it used to. That
 * is why the cancellation itself never waits on this and never fails with it.
 */
async function releaseHold(env, paymentRef) {
  if (!env.STRIPE_SECRET_KEY || !/^pi_/.test(String(paymentRef || ""))) return;
  try {
    const res = await fetch(
      "https://api.stripe.com/v1/payment_intents/" +
        encodeURIComponent(paymentRef) + "/cancel",
      {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + env.STRIPE_SECRET_KEY,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "cancellation_reason=requested_by_customer",
      });
    if (!res.ok) {
      /* Already captured, already cancelled, or gone. None of these is worth
         failing a cancellation the customer has already been told succeeded —
         and the cancellation email still tells a human to look. */
      console.error("hold release refused: " + paymentRef.slice(0, 12) +
                    " HTTP " + res.status);
      return;
    }
    console.log("hold released on cancellation: " + paymentRef.slice(0, 12));
  } catch (err) {
    console.error("hold release unreachable: " + String(err));
  }
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
   a guard that eats bookings is worse than the thing it guards against.

   A SIGNED QUOTE SHORT-CIRCUITS ALL OF IT. See the section above: when the
   browser returns a signature this Worker issued, the price is not being
   argued about at all, and the outcome carries `authenticated: true` — the
   only flag anything downstream may treat as licence to charge money. */
async function verifyPrice(rawBody, env) {
  try {
    const d = JSON.parse(rawBody);

    const isReservation = d.event_type === "reservation" || d.event === "quote_reserved";
    if (!isReservation) return { skipped: "not a reservation" };

    const claimed = Number(d.quote_price);
    if (!isFinite(claimed) || claimed <= 0) return { skipped: "no price claimed" };

    /* THE STRONG PATH, and deliberately ahead of the CAN_PRICE gate: verifying
       our own signature needs no engine, so this keeps working on the day the
       engine fails to bundle — the one failure that has actually happened. */
    if (d.quote_sig) {
      /* The echoed scope is what gets PERSISTED and re-checked at charge time,
         so it has to be the same string this Worker just verified against — not
         merely a string that happens to carry a valid signature. The browser
         builds both from one frozen payload, so a mismatch is not something an
         honest client can produce. */
      if (d.quote_scope && d.quote_scope !== quoteScope(d)) {
        return { reject: true, note: "quote scope does not describe this booking",
                 claimed: claimed, submission_id: d.submission_id || null };
      }
      const v = await checkQuoteSig(env && env.QUOTE_SECRET, d, claimed);
      if (v.ok) return { ok: true, authenticated: true,
                         submission_id: d.submission_id || null };
      if (v.note) {
        /* A signature that does not cover the payload it arrived with. There
           is no version of this that is an honest mistake. */
        return { reject: true, note: v.note, claimed: claimed,
                 submission_id: d.submission_id || null };
      }
      /* v.skipped — expired, or no secret bound. Fall through and audit it. */
    }

    /* If this Worker cannot reproduce the browser's arithmetic, it has no
       standing to call a price wrong. */
    if (!CAN_PRICE) return { skipped: "engine or geo unavailable in this build" };
    if (!d.zip) return { skipped: "no zip to price from" };

    const derived = priceFrom(d).displayPrice;
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


/* ============================================================
   PUBLIC CORS  —  /api/quote AND /api/slots
   ============================================================

   Added 2026-09-23 so an AI agent acting for a customer can price a home from
   its own page context rather than driving the booking form in a browser.
   Serve answers in one request where a cleaner quoting by phone or by visit
   cannot, and that advantage is worth nothing if it is only reachable by
   somebody clicking.

   WHAT THIS DOES NOT DO, because it is the thing most likely to be
   misremembered later: it does not newly expose pricing. `/api/quote` has
   always been reachable by any server-side caller — curl, a competitor, a
   script — and still is. Cross-origin rules are a BROWSER restriction, and
   lifting it changes who can call this from page JavaScript, not who can call
   it at all. Anyone treating this commit as "the day pricing became public"
   has the history wrong.

   WHY IT IS SAFE ON THIS ROUTE:
     - it reads nothing and writes nothing; `priceFrom` is pure computation
     - it costs nothing per call — no provider, no sheet, no billable upstream,
       unlike /api/address, which is gated behind counters for that reason
     - it takes no credential, so there is no credential to leak, and
       Allow-Credentials is deliberately ABSENT. With `Allow-Origin: *` the two
       together are rejected by every browser anyway, and adding it to a route
       that later grew a cookie would be the quiet mistake.
     - the signed quote it returns is already handed to every visitor's browser,
       and `verifyPrice()` re-derives the price server-side on submission
       regardless, so a quote_sig obtained here buys exactly what one obtained
       through the form buys: nothing that is not re-checked.

   /api/slots JOINED IT ON 2026-09-25, for the Muse connector application and
   for the same reason: an agent comparing cleaners can get a price from Serve
   in one request, and a price with no times beside it is half an answer. It
   reads and writes nothing, takes no credential, and its upstream cost is
   capped — see SLOTS_UPSTREAM_CACHE_MS, which is what makes it safe to publish
   rather than merely possible.

   WHAT IT PUBLISHES IS NARROWER THAN WHAT IT HOLDS. See publicSlotsFeed():
   the capacity count never leaves this Worker.

   DO NOT LIFT THIS TO json() OR TO THE ROUTER GENERALLY. Every other route
   either carries a token in the request or moves money, and handlePhotos says
   in its own comment that it blocks cross-site posts on purpose. */
const PUBLIC_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  /* Chrome caps this at 2h regardless; a day is the polite ask, not a promise. */
  "Access-Control-Max-Age": "86400",
  /* So a shared cache cannot hand one origin's answer to another. The body is
     already no-store, but the header costs nothing and states the intent. */
  "Vary": "Origin",
};

/* Stated per route rather than shared, so a read-only feed never advertises
   that it takes a POST. A browser refuses the method it was not offered. */
const CORS_METHODS = {
  "/api/quote": "POST, OPTIONS",
  "/api/slots": "GET, HEAD, OPTIONS",
};

function corsPreflight(pathname) {
  return new Response(null, {
    status: 204,
    headers: Object.assign({}, PUBLIC_CORS,
      { "Access-Control-Allow-Methods": CORS_METHODS[pathname] || "OPTIONS" }),
  });
}

/* Copies the response rather than mutating it: a Response from json() has
   immutable headers, and assigning to them throws. */
function publicCors(res, pathname) {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(PUBLIC_CORS)) headers.set(k, v);
  headers.set("Access-Control-Allow-Methods", CORS_METHODS[pathname] || "OPTIONS");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/* WHAT A PHOTO IS FOR, AND WHERE ITS BYTES LIVE.  r62
   ------------------------------------------------------------------
   The purpose is not decoration — it selects the storage prefix, and the
   prefix is what separates three sets of images with three different rules:

     instruction  the customer showing the cleaner what they mean. Removable,
                  and swept from R2 by the nightly cron once deleted.
     completion   the cleaner showing a finished room. Locked indefinitely and
                  NEVER swept, by explicit instruction — see the R2 lock.
     request      a photograph on a service request (r62). Its own prefix so
                  that the cron, which is scoped to booking-photos/ and the
                  BOOKING_PHOTOS tab, cannot reach it either way.

   A WHITELIST, NOT A TEST FOR ONE VALUE. Until r62 this read
   `data.purpose === "completion"` and everything else — including a typo —
   silently became an instruction photo, which would have filed a locked
   completion image as a deletable customer one. An unknown purpose is now
   refused. */
const PHOTO_PURPOSES = {
  instruction: "booking-photos/",
  completion:  "completion-photos/",
  request:     "request-photos/",
};

/* Private R2 images. All credentials travel in request bodies; the sheet
   authorizes the job/room/photo on EVERY operation, including image reads. */
async function handlePhotos(request, env) {
  const reply = (data, status = 200) => new Response(JSON.stringify(data), {
    status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store, private" }
  });
  if (request.method !== "POST") return reply({ ok: false, error: "method_not_allowed" }, 405);
  if (!env.BOOKING_PHOTOS || !env.PHOTO_BRIDGE_SECRET || !env.WEBHOOK_URL) {
    return reply({ ok: false, error: "not_configured" }, 503);
  }
  // Prevent cross-site form posts; photos never require cross-origin access.
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) return reply({ ok: false, error: "not_found" }, 403);
  let data, file;
  try {
    const raw = await photoRequestBytes(request, 1600000);
    const type = request.headers.get("Content-Type") || "";
    if (type.startsWith("multipart/form-data")) {
      const form = await new Response(raw, { headers: { "Content-Type": type } }).formData();
      data = JSON.parse(String(form.get("data") || ""));
      file = form.get("photo");
      if (!file || file.type !== "image/jpeg" || file.size > 1500000) throw new Error();
    } else {
      if (raw.byteLength > 8000) throw new Error();
      data = JSON.parse(new TextDecoder().decode(raw));
    }
    if (!data || typeof data !== "object") throw new Error();
  } catch (_) { return reply({ ok: false, error: "bad_upload" }, 400); }
  const action = data.action;
  if (!["upload", "read", "delete"].includes(action)) return reply({ ok: false, error: "bad_action" }, 400);
  /* Absent means instruction, which is what every caller predating r62 sends.
     Anything else must be a purpose this Worker knows. */
  const purpose = data.purpose === undefined || data.purpose === null || data.purpose === ""
    ? "instruction" : String(data.purpose);
  const prefix = PHOTO_PURPOSES[purpose];
  if (!prefix) return reply({ ok: false, error: "bad_upload" }, 400);
  const completion = purpose === "completion";
  if (completion && action === "delete") return reply({ ok: false, error: "bad_action" }, 400);
  // Caller-supplied storage keys, internal actions, and bridge tokens are ignored.
  const auth = { event_type: "booking_photo", bridge_token: env.PHOTO_BRIDGE_SECRET,
    auth_kind: String(data.auth_kind || ""), contact_id: String(data.contact_id || ""),
    job_id: String(data.job_id || ""), room_key: String(data.room_key || ""),
    photo_id: String(data.photo_id || ""), t: String(data.t || ""),
    vendor_id: String(data.vendor_id || ""),
    /* r62. Which request this belongs to, for purpose "request". Blank for the
       other two, and the sheet ignores it there. */
    request_id: String(data.request_id || ""), purpose: purpose };
  if (Object.values(auth).some(v => v.length > 256)) return reply({ ok: false, error: "bad_upload" }, 400);
  const authorize = async (operation, extra = {}) => {
    const upstream = await relay(env.WEBHOOK_URL, { method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ ...auth, ...extra, action: operation }) }, UPSTREAM_TIMEOUT_MS.submit);
    if (!upstream.ok) throw new Error("photo_unavailable");
    const answer = JSON.parse(upstream.text);
    if (!answer || answer.ok !== true) return answer || { ok: false, error: "photo_unavailable" };
    // Old webhook health responses must never authorize storage.
    if (answer.object_key !== prefix + auth.photo_id + ".jpg" ||
        !/^[a-f0-9-]{36}$/.test(auth.photo_id) ||
        !answer.photo || answer.photo.id !== auth.photo_id || answer.photo.roomKey !== auth.room_key) {
      throw new Error("photo_unavailable");
    }
    return answer;
  };
  try {
    if (action === "upload") {
      if (!file) return reply({ ok: false, error: "bad_upload" }, 400);
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216 ||
          bytes[bytes.length - 2] !== 255 || bytes[bytes.length - 1] !== 217) {
        return reply({ ok: false, error: "bad_upload" }, 400);
      }
      const reservation = await authorize("begin", { bytes: bytes.length });
      if (!reservation.ok) return reply(reservation);
      if (reservation.status === "READY") return reply({ ok: true, photo: reservation.photo });
      // First write wins on retries: an acknowledged photo is immutable.
      // Locked completion objects cannot be overwritten. A retry after a lost
      // commit skips the existing object and finalizes its original reservation.
      if (!completion || !(await env.BOOKING_PHOTOS.head(reservation.object_key))) await env.BOOKING_PHOTOS.put(reservation.object_key, bytes, {
        onlyIf: { etagDoesNotMatch: "*" }, httpMetadata: { contentType: "image/jpeg" }
      });
      const committed = await authorize("commit");
      if (!committed.ok) return reply(committed);
      return reply({ ok: true, photo: committed.photo });
    }
    const allowed = await authorize(action);
    if (!allowed.ok) return reply(allowed);
    if (action === "delete") {
      await env.BOOKING_PHOTOS.delete(allowed.object_key);
      return reply({ ok: true });
    }
    const object = await env.BOOKING_PHOTOS.get(allowed.object_key);
    if (!object) return reply({ ok: false, error: "not_found" }, 404);
    return new Response(object.body, { headers: {
      "Content-Type": "image/jpeg", "Cache-Control": "no-store, private",
      "X-Content-Type-Options": "nosniff", "Content-Disposition": "inline; filename=room-photo.jpg",
      "Content-Security-Policy": "default-src 'none'; sandbox", "Referrer-Policy": "no-referrer"
    } });
  } catch (_) {
    // No upstream response, credentials, storage keys or customer data in logs.
    return reply({ ok: false, error: "photo_unavailable" }, 502);
  }
}

async function photoRequestBytes(request, limit) {
  if (Number(request.headers.get("Content-Length")) > limit || !request.body) throw new Error();
  const reader = request.body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    length += part.value.byteLength;
    if (length > limit) { await reader.cancel(); throw new Error(); }
    chunks.push(part.value);
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}


/* ============================================================
   KEEPING THE APPS SCRIPT APPS WARM
   ============================================================

   Both upstreams are Apps Script web apps, and Apps Script puts an app to sleep
   when nobody has called it for a while. The first request after that has to
   cold start, which can take longer than the budgets above allow — so THE FIRST
   VISITOR AFTER A QUIET SPELL is the one who pays for it.

   What they see is not an error, which is what makes this worth fixing rather
   than watching. Every caller treats a failed feed as "no times available" by
   design, so a cold start is indistinguishable from genuine unavailability: the
   booking form quietly drops to the earlier/later radios, the plan card says it
   has no times, and a customer trying to move a visit is told to call. Observed
   2026-09-13 — `upstream_unreachable` on one probe and 14 slots moments later,
   with the feed itself healthy both times.

   LOW TRAFFIC MAKES THIS WORSE, NOT BETTER. Idle is the normal state of a site
   with few visitors, so "the first visitor after idle" is close to every
   visitor. It improves on its own as real traffic arrives, which is the reverse
   of how these things usually go.

   A PING IS THE FIX, NOT A LONGER VISITOR-FACING TIMEOUT. Raising that budget
   would not remove the wait — it would move it into the customer's browser and
   make them watch it.

   BOTH UPSTREAMS, not just the feed. The webhook is the slower and more
   expensive one to lose: it backs /api/submit, /api/portal, /api/job,
   /api/photos and /api/vendor, so a cold webhook is a slow portal for everyone
   and, at worst, a booking that exceeds its 12s budget and fails outright.
   ============================================================ */
async function warmUpstreams(env) {
  /* Settled rather than all(): the two are independent, and one being
     unreachable must not skip the other's ping. */
  await Promise.allSettled([
    warmOne(env.AVAILABILITY_URL, "availability"),
    warmOne(env.WEBHOOK_URL, "webhook"),
    sweepBookingNotify(env),
  ]);
}

/**
 * r55. The backstop for sendBookingNotify: any booking text or email parked
 * for over a minute is sent now. A POST, unlike the pings, because it can send
 * messages — but only messages a booking already decided to send, each once.
 */
async function sweepBookingNotify(env) {
  if (!env.WEBHOOK_URL) return;
  const res = await relay(env.WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ event_type: "booking_notify", action: "sweep" }),
  }, WARM_TIMEOUT_MS);
  if (!res.ok) console.error("notify sweep failed: " + res.error);
  else if (!/"sent":0\b/.test(res.text)) console.log("notify sweep: " + res.text);
}

/**
 * One GET, purely to keep the container alive. Never throws — this runs inside
 * waitUntil, where an unhandled rejection buys nothing a log line does not.
 *
 * A PLAIN GET ON PURPOSE. The availability feed caches its own response for
 * five minutes, and `?nocache=1` would force a full recompute on every ping;
 * what is wanted is a warm CONTAINER, and a cache hit still runs the script.
 * The webhook's bare GET is its health stamp, which writes nothing at all.
 */
async function warmOne(url, label) {
  if (!url) return;
  const started = Date.now();
  const res = await relay(url, { method: "GET" }, WARM_TIMEOUT_MS);
  const ms = Date.now() - started;
  /* Error level on failure, deliberately: a ping that fails means the next real
     visitor eats the cold start, and this log line is the only place that would
     ever be visible. */
  if (res.ok) console.log("warm " + label + ": ok in " + ms + "ms");
  else console.error("warm " + label + " failed after " + ms + "ms: " + res.error);
}

async function cleanupPhotoStorage(env) {
  if (!env.BOOKING_PHOTOS || !env.PHOTO_BRIDGE_SECRET || !env.WEBHOOK_URL) return;
  async function step(action, extra = {}) {
    const up = await relay(env.WEBHOOK_URL, { method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ ...extra, event_type: "booking_photo", action,
        bridge_token: env.PHOTO_BRIDGE_SECRET }) }, UPSTREAM_TIMEOUT_MS.submit);
    if (!up.ok) throw new Error("Photo maintenance unavailable");
    const d = JSON.parse(up.text);
    if (!d.ok || !Array.isArray(d.photos)) throw new Error("Photo maintenance unavailable");
    return d.photos;
  }
  const photos = await step("cleanup");
  if (!photos.length) return;
  if (photos.length > 100 || photos.some(p =>
      !/^[a-f0-9-]{36}$/.test(p.id) || p.object_key !== "booking-photos/" + p.id + ".jpg")) {
    throw new Error("Invalid photo maintenance response");
  }
  await env.BOOKING_PHOTOS.delete(photos.map(p => p.object_key));
  await step("purged", { photo_ids: photos.map(p => p.id) });
}
