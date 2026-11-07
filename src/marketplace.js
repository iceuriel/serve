/* ============================================================
   THE MARKETPLACE — /providers, /providers/<slug>, /api/providers,
   /api/estimate. Cloudflare D1, binding MARKET_DB.
   ============================================================

   Founder decisions, 2026-11-06 (docs/HANDOFF.md):
     - The marketplace is built at /providers. The homepage is not swapped until
       enough owners have approved their profiles.
     - A business's own phone, email and website are NEVER shown. Every
       estimate request goes through Serve.
     - Marketplace data lives in D1, not Sheets.

   THREE RULES THIS FILE KEEPS, and the tests in tests/marketplace.test.js hold
   it to each:

   1. PUBLIC MEANS WHITELISTED. publicProvider() builds the public object field
      by field from a row. A column added to `providers` next month reaches no
      page and no JSON until somebody adds it here on purpose. internal_phone,
      internal_email, website_url and internal_notes are never read by it.

   2. EVERYTHING RENDERED IS ESCAPED. Profile text comes from a database the
      vendor will one day edit, so every interpolation goes through esc() and
      every URL through a same-origin or http(s) check.

   3. listed = 1 IS THE ONLY THING THAT PUBLISHES A COMPANY. An unlisted profile
      is a 404 to the public. The founder can preview one with
      ?preview=<MARKET_PREVIEW_KEY>, and a preview is never cached and never
      indexed.

   Without the binding nothing breaks: the pages say the directory is coming
   soon and /api/estimate answers `unavailable`. The rest of the site does not
   know this file exists. */

export const SERVICE_TAGS = ["Recurring", "Deep clean", "Move in / out", "Post-construction", "Airbnb"];
export const REGIONS = [
  ["core", "Boston & Cambridge"],
  ["north", "North of Boston"],
  ["west", "Newton & West"],
  ["south", "South Shore"],
];
const REGION_KEYS = REGIONS.map((r) => r[0]);

const PAGE_TTL_S = 300;            // an edit in D1 reaches the public within five minutes
const ESTIMATE_IP_PER_HOUR = 6;    // a person asks a few companies, not dozens
const ESTIMATE_MAX_BODY = 4096;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/* ---------- small, pure helpers (exported for the tests) ---------- */

export function esc(v) {
  return String(v === null || v === undefined ? "" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function jsonList(v) {
  try {
    const a = JSON.parse(v || "[]");
    return Array.isArray(a) ? a.map((x) => String(x)).filter(Boolean) : [];
  } catch (_) { return []; }
}

/* An image a page may load: a file this site serves, under /images/, with no
   way out of that folder. Anything else is dropped, so a profile can never be
   made to pull a tracker or a script from another host. */
export function safeImagePath(p) {
  const s = String(p || "").trim();
  if (!/^\/images\/[A-Za-z0-9._\/-]+$/.test(s)) return "";
  if (s.includes("..") || s.includes("//")) return "";
  return s;
}

export function safeHttpUrl(u) {
  const s = String(u || "").trim();
  return /^https?:\/\/[^\s"'<>]+$/i.test(s) ? s : "";
}

function safeHex(v, fallback) {
  return HEX_RE.test(String(v || "")) ? String(v) : fallback;
}

/* US numbers only — Serve texts and calls Massachusetts homes. */
export function normalizePhone(raw) {
  let d = String(raw || "").replace(/\D/g, "");
  if (d.length === 11 && d[0] === "1") d = d.slice(1);
  if (d.length !== 10) return "";
  if (d[0] === "0" || d[0] === "1" || d[3] === "0" || d[3] === "1") return "";
  return "+1" + d;
}

function prettyPhone(e164) {
  const d = String(e164 || "").replace(/^\+1/, "");
  return d.length === 10 ? "(" + d.slice(0, 3) + ") " + d.slice(3, 6) + "-" + d.slice(6) : "";
}

/** The ONLY shape of a provider any public surface ever sees. */
export function publicProvider(row, photos, quotes) {
  if (!row) return null;
  const ratingShown = !!String(row.rating_checked_on || "").trim() &&
    typeof row.rating === "number" && row.rating > 0 && row.rating <= 5 &&
    typeof row.review_count === "number" && row.review_count > 0;
  return {
    slug: String(row.slug || ""),
    name: String(row.name || ""),
    tagline: String(row.tagline || ""),
    about: String(row.about || ""),
    brandColor: safeHex(row.brand_color, "#1f2937"),
    logo: safeImagePath(row.logo_path),
    logoBg: safeHex(row.logo_bg, "#ffffff"),
    yearsLabel: String(row.years_label || ""),
    ownerName: String(row.owner_public_name || ""),
    teamLabel: String(row.team_label || ""),
    serviceArea: String(row.service_area || ""),
    areaShort: String(row.area_short || ""),
    regions: jsonList(row.regions).filter((r) => REGION_KEYS.includes(r)),
    services: jsonList(row.services),
    serviceTags: jsonList(row.service_tags).filter((t) => SERVICE_TAGS.includes(t)),
    claims: jsonList(row.claims),
    policies: jsonList(row.policies),
    pricingText: String(row.pricing_text || ""),
    deals: jsonList(row.deals),
    priceLabel: String(row.price_label || "Pricing"),
    priceValue: String(row.price_value || "Free estimate"),
    cardNote: String(row.card_note || ""),
    estimatePhone: Number(row.estimate_phone) !== 0,
    estimateWalkthrough: Number(row.estimate_walkthrough) !== 0,
    /* A third-party rating is shown only once Serve has checked it, and then
       always with its source and date. Unchecked research numbers stay in the
       row and out of every page. */
    rating: ratingShown ? row.rating : null,
    reviewCount: ratingShown ? row.review_count : null,
    ratingSource: ratingShown ? String(row.rating_source || "") : "",
    ratingCheckedOn: ratingShown ? String(row.rating_checked_on || "") : "",
    insuranceVerified: Number(row.insurance_verified) === 1,
    registrationVerified: Number(row.registration_verified) === 1,
    photos: (photos || []).map((p) => ({ src: safeImagePath(p.path), caption: String(p.caption || "") }))
      .filter((p) => p.src),
    quotes: (quotes || []).map((q) => ({
      quote: String(q.quote || ""), author: String(q.author || ""),
      source: String(q.source || ""), sourceUrl: safeHttpUrl(q.source_url),
    })).filter((q) => q.quote),
  };
}

/** Validates an estimate request. Returns { ok, value } or { ok:false, error, field }. */
export function validateEstimate(input) {
  const b = input || {};
  const slug = String(b.provider || "").trim().toLowerCase();
  if (!SLUG_RE.test(slug) || slug.length > 80) return { ok: false, error: "bad_provider", field: "provider" };
  const method = String(b.method || "").trim().toLowerCase();
  if (method !== "phone" && method !== "walkthrough") return { ok: false, error: "bad_method", field: "method" };
  const phone = normalizePhone(b.phone);
  if (!phone) return { ok: false, error: "bad_phone", field: "phone" };
  let address = "";
  let zip = "";
  if (method === "walkthrough") {
    address = String(b.address || "").replace(/\s+/g, " ").trim();
    if (address.length < 6 || address.length > 200) return { ok: false, error: "bad_address", field: "address" };
    const zips = address.match(/\b\d{5}\b/g);
    zip = zips ? zips[zips.length - 1] : "";
  }
  const time = String(b.time_pref || "").trim().toLowerCase();
  if (time !== "earlier" && time !== "later") return { ok: false, error: "bad_time", field: "time_pref" };
  const ref = String(b.client_ref || "").trim();
  return {
    ok: true,
    value: {
      slug, method, phone, address, zip, time,
      smsConsent: ["yes", "on", "true", "1"].includes(String(b.sms_consent || "").toLowerCase()),
      clientRef: /^[A-Za-z0-9-]{8,64}$/.test(ref) ? ref : "",
      source: String(b.source || "").replace(/[^\w.:\/-]/g, "").slice(0, 80),
      honeypot: String(b.website || "").trim(),
    },
  };
}

const ERROR_TEXT = {
  bad_provider: "That company isn't taking requests through Serve right now.",
  bad_method: "Choose a phone estimate or a walkthrough.",
  bad_phone: "Enter a 10-digit US phone number.",
  bad_address: "Enter the street address for the walkthrough, with the ZIP code.",
  bad_time: "Choose earlier or later in the day.",
  rate_limited: "Too many requests from this connection. Try again in an hour.",
  unavailable: "Requests aren't open yet. Try again soon.",
  save_failed: "We couldn't save that. Try again in a minute.",
};

/* ---------- routing ---------- */

/** Returns a Response for a marketplace path, or null for anything else. */
export async function handleMarketplace(request, env, ctx, url) {
  const p = url.pathname.replace(/\/+$/, "") || "/";
  if (p === "/api/estimate") return handleEstimate(request, env, ctx);
  if (p === "/api/providers") return handleProvidersJson(request, env);
  /* A PREVIEW NEVER GOES THROUGH cached(). The cache key drops the query
     string, so a preview answered through it would be stored as the PUBLIC
     page and served to everyone for five minutes — every draft published by
     one founder click. The preview branches are therefore checked first and
     return without touching the cache in either direction. */
  if (p === "/providers") {
    if (previewAllowed(url, env)) return directoryPage(env, previewKeyOf(env));
    return cached(request, ctx, () => directoryPage(env, ""));
  }
  const m = p.match(/^\/providers\/([^\/]+)$/);
  if (m) {
    const slug = m[1].toLowerCase();
    if (previewAllowed(url, env)) return profilePage(env, slug, previewKeyOf(env));
    return cached(request, ctx, () => profilePage(env, slug, ""));
  }
  return null;
}

function previewKeyOf(env) {
  return String((env && env.MARKET_PREVIEW_KEY) || "").trim();
}

/* Carries the preview key onto a link, so the founder can move between
   drafts. Only ever rendered into a page that was itself opened with the key. */
function withPreview(href, key) {
  if (!key) return href;
  const i = href.indexOf("#");
  const base = i === -1 ? href : href.slice(0, i);
  const hash = i === -1 ? "" : href.slice(i);
  return base + (base.includes("?") ? "&" : "?") + "preview=" + encodeURIComponent(key) + hash;
}

function previewAllowed(url, env) {
  const offered = url.searchParams.get("preview") || "";
  const key = String((env && env.MARKET_PREVIEW_KEY) || "").trim();
  if (!key || !offered || offered.length !== key.length) return false;
  let diff = 0;
  for (let i = 0; i < key.length; i++) diff |= key.charCodeAt(i) ^ offered.charCodeAt(i);
  return diff === 0;
}

/* Public GETs only, keyed on the URL without its query string so a campaign
   tag cannot make a cache miss. A preview never comes through here. */
async function cached(request, ctx, build) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: { Allow: "GET" } });
  }
  const cache = (typeof caches !== "undefined" && caches.default) ? caches.default : null;
  const keyUrl = new URL(request.url);
  keyUrl.search = "";
  const key = new Request(keyUrl.toString(), { method: "GET" });
  if (cache) {
    const hit = await cache.match(key).catch(() => null);
    if (hit) return hit;
  }
  const res = await build();
  if (cache && res.status === 200) {
    const put = cache.put(key, res.clone()).catch(() => {});
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(put);
  }
  return res;
}

/* ---------- data ---------- */

async function listedProviders(db) {
  const { results } = await db.prepare(
    "SELECT * FROM providers WHERE listed = 1 AND status = 'approved' ORDER BY sort_rank, name").all();
  return (results || []).map((r) => publicProvider(r, [], []));
}

/* Founder preview only: every company that has not been removed, each marked
   with whether the public can see it. `isDraft` is added BESIDE the whitelist
   output rather than inside publicProvider, so the public shape stays exactly
   what /api/providers returns. */
async function allProvidersForPreview(db) {
  const { results } = await db.prepare(
    "SELECT * FROM providers WHERE status <> 'removed' ORDER BY sort_rank, name").all();
  return (results || []).map((r) => Object.assign(publicProvider(r, [], []),
    { isDraft: !(Number(r.listed) === 1 && r.status === "approved") }));
}

async function providerBySlug(db, slug, includeUnlisted) {
  if (!SLUG_RE.test(slug)) return null;
  const row = await db.prepare("SELECT * FROM providers WHERE slug = ?").bind(slug).first();
  if (!row) return null;
  const isPublic = Number(row.listed) === 1 && row.status === "approved";
  if (!isPublic && !includeUnlisted) return null;
  const [photos, quotes] = await Promise.all([
    db.prepare("SELECT path, caption FROM provider_photos WHERE provider_id = ? AND visible = 1 ORDER BY sort LIMIT 8")
      .bind(row.id).all(),
    db.prepare("SELECT quote, author, source, source_url FROM provider_quotes WHERE provider_id = ? AND visible = 1 ORDER BY sort LIMIT 3")
      .bind(row.id).all(),
  ]);
  return { id: row.id, isPublic, pub: publicProvider(row, photos.results, quotes.results) };
}

async function handleProvidersJson(request, env) {
  if (request.method !== "GET") return jsonRes({ ok: false, error: "method" }, 405);
  if (!env || !env.MARKET_DB) return jsonRes({ ok: false, error: "unavailable" }, 503);
  try {
    const providers = await listedProviders(env.MARKET_DB);
    return jsonRes({ ok: true, providers }, 200, "public, max-age=" + PAGE_TTL_S);
  } catch (err) {
    console.error("providers_json failed: " + err);
    return jsonRes({ ok: false, error: "unavailable" }, 503);
  }
}

/* ---------- POST /api/estimate ---------- */

async function handleEstimate(request, env, ctx) {
  const wantsHtml = !(request.headers.get("Accept") || "").includes("application/json");
  if (request.method !== "POST") return jsonRes({ ok: false, error: "method" }, 405);
  if (!env || !env.MARKET_DB) return estimateAnswer(wantsHtml, { ok: false, error: "unavailable" }, 503);

  const raw = await request.text();
  if (raw.length > ESTIMATE_MAX_BODY) return estimateAnswer(wantsHtml, { ok: false, error: "save_failed" }, 413);
  const type = request.headers.get("Content-Type") || "";
  let body;
  try {
    body = type.includes("application/json") ? JSON.parse(raw)
      : Object.fromEntries(new URLSearchParams(raw));
  } catch (_) { return estimateAnswer(wantsHtml, { ok: false, error: "save_failed" }, 400); }

  const v = validateEstimate(body);
  if (!v.ok) return estimateAnswer(wantsHtml, { ok: false, error: v.error, field: v.field }, 400, body.provider);
  const val = v.value;

  /* A bot that fills the hidden field is told it succeeded and nothing is
     stored — telling it otherwise teaches it which field to leave alone. */
  if (val.honeypot) return estimateAnswer(wantsHtml, { ok: true, request_id: "", provider_name: "" }, 200);

  const kv = env.PROPERTY_CACHE;
  if (kv) {
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const key = "estip:" + (await hash10(ip)) + ":" + new Date().toISOString().slice(0, 13);
    const seen = Number(await kv.get(key).catch(() => 0)) || 0;
    if (seen >= ESTIMATE_IP_PER_HOUR) {
      console.warn("estimate rate_limited");
      return estimateAnswer(wantsHtml, { ok: false, error: "rate_limited" }, 429, val.slug);
    }
    await kv.put(key, String(seen + 1), { expirationTtl: 3600 }).catch(() => {});
  }

  const db = env.MARKET_DB;
  let provider;
  try { provider = await providerBySlug(db, val.slug, false); }
  catch (err) {
    console.error("estimate provider lookup failed: " + err);
    return estimateAnswer(wantsHtml, { ok: false, error: "save_failed" }, 503, val.slug);
  }
  if (!provider) return estimateAnswer(wantsHtml, { ok: false, error: "bad_provider", field: "provider" }, 404);
  if ((val.method === "phone" && !provider.pub.estimatePhone) ||
      (val.method === "walkthrough" && !provider.pub.estimateWalkthrough)) {
    return estimateAnswer(wantsHtml, { ok: false, error: "bad_method", field: "method" }, 400, val.slug);
  }

  const now = new Date().toISOString();
  let record;
  try {
    if (val.clientRef) {
      const prior = await db.prepare("SELECT id FROM estimate_requests WHERE client_ref = ?").bind(val.clientRef).first();
      if (prior) {
        return estimateAnswer(wantsHtml, { ok: true, request_id: prior.id, provider_name: provider.pub.name,
          method: val.method, duplicate: true }, 200, val.slug);
      }
    }
    const client = await db.prepare(
      "INSERT INTO clients (id, phone_e164, sms_consent, sms_consent_at, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(phone_e164) DO UPDATE SET updated_at = excluded.updated_at, " +
      "sms_consent = MAX(clients.sms_consent, excluded.sms_consent), " +
      "sms_consent_at = CASE WHEN excluded.sms_consent = 1 AND clients.sms_consent = 0 " +
      "THEN excluded.sms_consent_at ELSE clients.sms_consent_at END " +
      "RETURNING id")
      .bind("CLI-" + randomId(10), val.phone, val.smsConsent ? 1 : 0, val.smsConsent ? now : "", now, now)
      .first();
    record = {
      id: "EST-" + randomId(12), providerId: provider.id, providerName: provider.pub.name,
      providerSlug: provider.pub.slug, clientId: client.id, method: val.method, phone: val.phone,
      address: val.address, zip: val.zip, timePref: val.time, smsConsent: val.smsConsent,
      source: val.source, createdAt: now,
    };
    await db.prepare(
      "INSERT INTO estimate_requests (id, provider_id, client_id, method, phone_e164, address, zip, time_pref, " +
      "status, sms_consent, source, client_ref, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, ?, ?)")
      .bind(record.id, record.providerId, record.clientId, record.method, record.phone, record.address, record.zip,
        record.timePref, record.smsConsent ? 1 : 0, record.source, val.clientRef, now, now)
      .run();
  } catch (err) {
    /* Never the request itself in the log — it carries a phone number and,
       for a walkthrough, a home address. */
    console.error("estimate save failed: " + String(err && err.message || err).slice(0, 200));
    return estimateAnswer(wantsHtml, { ok: false, error: "save_failed" }, 503, val.slug);
  }

  console.log("estimate saved provider=" + record.providerId + " method=" + record.method + " zip=" + (record.zip || "-"));
  const notify = notifyFounder(env, record);
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(notify);
  else await notify;

  return estimateAnswer(wantsHtml, { ok: true, request_id: record.id, provider_name: record.providerName,
    method: record.method, time_pref: record.timePref }, 200, record.providerSlug);
}

/* The founder hears about every request by email, through the booking webhook
   (Apps Script r63, event_type "estimate_request"). The request is ALREADY
   SAVED when this runs: a failed email is logged and the row keeps a blank
   notified_at, which is the founder's list of requests nobody was told about.
   MARKET_BRIDGE_SECRET is this surface's own key — not the payment or photo
   one — so a leak of either of those cannot be used to write here. */
async function notifyFounder(env, r) {
  if (!env.WEBHOOK_URL || !env.MARKET_BRIDGE_SECRET) {
    console.error("estimate notify skipped: WEBHOOK_URL or MARKET_BRIDGE_SECRET is not bound");
    return;
  }
  try {
    const res = await fetchWithTimeout(env.WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({
        event_type: "estimate_request",
        bridge_token: env.MARKET_BRIDGE_SECRET,
        request: {
          request_id: r.id, provider_id: r.providerId, provider_name: r.providerName,
          method: r.method, phone: prettyPhone(r.phone), address: r.address, zip: r.zip,
          time_pref: r.timePref, sms_consent: r.smsConsent, source: r.source, created_at: r.createdAt,
        },
      }),
    }, 15000);
    const reply = await res.json().catch(() => null);
    if (!reply || reply.ok !== true) {
      console.error("estimate notify not confirmed for " + r.id + ": " + JSON.stringify(reply && reply.error || res.status));
      return;
    }
    await env.MARKET_DB.prepare("UPDATE estimate_requests SET notified_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), r.id).run();
  } catch (err) {
    console.error("estimate notify failed for " + r.id + ": " + String(err && err.message || err).slice(0, 200));
  }
}

async function fetchWithTimeout(target, init, ms) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try { return await fetch(target, Object.assign({}, init, { signal: ac.signal })); }
  finally { clearTimeout(timer); }
}

function estimateAnswer(wantsHtml, payload, status, slug) {
  if (!wantsHtml) return jsonRes(Object.assign({}, payload, payload.ok ? {} : { message: ERROR_TEXT[payload.error] || ERROR_TEXT.save_failed }), status);
  const back = slug && SLUG_RE.test(String(slug)) ? "/providers/" + slug : "/providers";
  const body = payload.ok
    ? `<section class="mk-done"><div class="mk-done__check" aria-hidden="true">&#10003;</div>
<h1 class="mk-hl">Request sent</h1>
<p>${payload.provider_name ? "Serve has your request for <strong>" + esc(payload.provider_name) + "</strong>. " : ""}We'll pass it on and they'll reach you during the time you picked.</p>
<p><a class="btn btn--primary" href="/providers">Back to providers</a></p></section>`
    : `<section class="mk-done"><h1 class="mk-hl">That didn't go through</h1>
<p>${esc(ERROR_TEXT[payload.error] || ERROR_TEXT.save_failed)}</p>
<p><a class="btn btn--primary" href="${esc(back)}">Go back</a></p></section>`;
  return htmlRes(shell({ title: payload.ok ? "Request sent — Serve" : "Request not sent — Serve", noindex: true, body }), status);
}

/* ---------- pages ---------- */

async function directoryPage(env, previewKey) {
  if (!env || !env.MARKET_DB) return htmlRes(comingSoon(), 200);
  let providers;
  try {
    providers = previewKey ? await allProvidersForPreview(env.MARKET_DB) : await listedProviders(env.MARKET_DB);
  } catch (err) {
    console.error("directory read failed: " + err);
    return htmlRes(comingSoon(), 503, "no-store");
  }
  if (previewKey) return previewRes(renderDirectory(providers, { previewKey }));
  return htmlRes(renderDirectory(providers), 200, "public, max-age=" + PAGE_TTL_S);
}

async function profilePage(env, slug, previewKey) {
  if (!env || !env.MARKET_DB) return htmlRes(comingSoon(), 404, "no-store");
  let found;
  try { found = await providerBySlug(env.MARKET_DB, slug, !!previewKey); }
  catch (err) {
    console.error("profile read failed: " + err);
    return htmlRes(comingSoon(), 503, "no-store");
  }
  if (!found) return htmlRes(notFound(), 404, previewKey ? "no-store" : "public, max-age=60");
  if (previewKey) return previewRes(renderProfile(found.pub, { preview: !found.isPublic, previewKey }));
  return htmlRes(renderProfile(found.pub, {}), 200, "public, max-age=" + PAGE_TTL_S);
}

/* Every page opened with the preview key: never stored anywhere, never
   indexed — said in the header as well as the markup, because a crawler that
   finds the URL reads the header before the page. */
function previewRes(html) {
  const res = htmlRes(html, 200, "no-store");
  res.headers.set("X-Robots-Tag", "noindex, nofollow");
  return res;
}

const LOGO_SVG = (color, width) =>
  `<svg role="img" aria-label="Serve, Greater Boston" width="${width}" height="${Math.round(width * 1.14)}" viewBox="45 10 200 228" class="mk-mark"><path d="M 88 150 L 88 78 L 145 30 L 202 78 L 202 118" fill="none" stroke="${color}" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"></path><text x="145.5" y="196" text-anchor="middle" font-family="'Times New Roman', Times, serif" font-size="64" letter-spacing="1" fill="${color}">Serve</text><text x="147.2" y="228" text-anchor="middle" font-family="'Times New Roman', Times, serif" font-size="16" letter-spacing="4.3" fill="${color}">GREATER BOSTON</text></svg>`;

function shell({ title, description, canonical, noindex, body, jsonLd }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
${description ? `<meta name="description" content="${esc(description)}">` : ""}
${canonical ? `<link rel="canonical" href="${esc(canonical)}">` : ""}
${noindex ? `<meta name="robots" content="noindex">` : ""}
<meta property="og:title" content="${esc(title)}">
${description ? `<meta property="og:description" content="${esc(description)}">` : ""}
<link rel="icon" type="image/svg+xml" href="/images/favicon.svg">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/style.css">
<link rel="stylesheet" href="/marketplace.css">
${jsonLd ? `<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, "\\u003c")}</script>` : ""}
</head>
<body class="mk">
<nav class="nav">
<div class="nav__inner">
<a href="/" class="nav__logo">Serve</a>
<ul class="nav__links">
<li><a href="/providers">Find a Provider</a></li>
<li><a href="/#how-it-works">How Serve Works</a></li>
<li><a href="/services">Services</a></li>
<li><a href="/#quote" class="nav__cta">Instant Booking</a></li>
</ul>
<button class="nav__hamburger" aria-label="Open menu" aria-expanded="false"><span></span><span></span><span></span></button>
</div>
<div class="nav__mobile-menu" id="mobile-menu">
<ul>
<li><a href="/providers">Find a Provider</a></li>
<li><a href="/#how-it-works">How Serve Works</a></li>
<li><a href="/services">Services</a></li>
<li><a href="/#quote">Instant Booking</a></li>
</ul>
</div>
</nav>
<main id="main">
${body}
</main>
<footer class="mk-footer">
<div class="mk-wrap mk-footer__inner">
<div><span class="mk-footer__brand">Serve</span><span>Greater Boston's home service network</span></div>
<div class="mk-footer__links"><a href="/providers">Providers</a><a href="/#quote">Instant Booking</a><a href="/terms">Terms</a><a href="/privacy">Privacy</a><a href="/sms-terms">SMS Terms</a></div>
</div>
</footer>
<script src="/marketplace-client.js" defer></script>
</body>
</html>`;
}

function comingSoon() {
  return shell({
    title: "Find a Provider — Serve", noindex: true,
    body: `<section class="mk-hero mk-hero--small"><div class="mk-wrap">${LOGO_SVG("#ffffff", 96)}
<h1 class="mk-hl">Our provider directory is opening soon</h1>
<p class="mk-hero__sub">We're adding Greater Boston's local cleaning companies now.</p>
<p><a class="btn btn--primary" href="/#quote">Book a clean instantly instead</a></p></div></section>`,
  });
}

function notFound() {
  return shell({
    title: "Provider not found — Serve", noindex: true,
    body: `<section class="mk-done"><h1 class="mk-hl">We couldn't find that company</h1>
<p>It may not be listed on Serve yet.</p><p><a class="btn btn--primary" href="/providers">See all providers</a></p></section>`,
  });
}

export function renderDirectory(providers, opts) {
  const list = providers || [];
  const key = (opts && opts.previewKey) || "";
  const href = (slug, hash) => esc(withPreview("/providers/" + slug + (hash || ""), key));
  const drafts = list.filter((p) => p.isDraft).length;
  const chips = (name, items) => items.map(([k, label], i) =>
    `<button type="button" class="mk-chip" data-filter="${name}" data-value="${esc(k)}" aria-pressed="${i === 0 ? "true" : "false"}">${esc(label)}</button>`).join("");
  const cards = list.map((p) => {
    const tags = p.serviceTags.slice(0, 3).length ? p.serviceTags.slice(0, 3) : p.services.slice(0, 3);
    return `<article class="mk-card" data-regions="${esc(p.regions.join(" "))}" data-tags="${esc(p.serviceTags.join("|"))}">
${p.isDraft ? `<span class="mk-draft">Draft · not public</span>` : ""}
<a class="mk-card__logo" href="${href(p.slug)}" style="background:${p.logoBg};border-top-color:${p.brandColor}" aria-label="${esc(p.name)}">${p.logo ? `<img src="${esc(p.logo)}" alt="" loading="lazy">` : `<span class="mk-card__mono">${esc(p.name.charAt(0))}</span>`}</a>
<div class="mk-card__body">
<h2 class="mk-card__name"><a href="${href(p.slug)}">${esc(p.name)}</a></h2>
${p.areaShort ? `<p class="mk-card__area">${esc(p.areaShort)}</p>` : ""}
<p class="mk-card__meta">${p.rating ? `<strong>&#9733; ${esc(p.rating.toFixed(1))}</strong> <span>${esc(p.reviewCount)} ${esc(p.ratingSource)} reviews</span>` : ""}${p.yearsLabel ? `<span>${esc(p.yearsLabel)}</span>` : ""}</p>
<p class="mk-card__tagline">${esc(p.tagline)}</p>
<ul class="mk-tags">${tags.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>
<div class="mk-card__foot"><div><span class="mk-label">${esc(p.priceLabel)}</span><strong>${esc(p.priceValue)}</strong></div>${p.cardNote ? `<span class="mk-card__note">&#10003; ${esc(p.cardNote)}</span>` : ""}</div>
<div class="mk-card__actions"><a class="btn btn--ghost" href="${href(p.slug)}">View Profile</a><a class="btn btn--primary" href="${href(p.slug, "#estimate")}">Get Estimate</a></div>
</div>
</article>`;
  }).join("\n");

  const banner = key ? `<div class="mk-preview" role="note"><strong>Preview.</strong> Showing every company, including ${drafts} ${drafts === 1 ? "draft" : "drafts"} the public cannot see. This page is not indexed and not cached. Don't share this link.</div>` : "";
  const body = `${banner}<section class="mk-hero"><div class="mk-wrap">
${LOGO_SVG("#ffffff", 104)}
<h1 class="mk-hl">Boston's Most Trusted Cleaners</h1>
<form class="mk-find" action="/providers" method="get" role="search" data-find>
<label class="sr-only" for="mk-near">Neighborhood or ZIP</label>
<input id="mk-near" type="text" placeholder="Neighborhood or ZIP" maxlength="40" autocomplete="off" enterkeyhint="search">
<button class="btn btn--primary" type="submit">Find Providers</button>
</form>
<p class="mk-hero__instant">No time to waste? <a href="/#quote">Instantly book in under 1 minute</a> and we'll handle your booking.</p>
</div></section>
<section class="mk-section" id="providers"><div class="mk-wrap">
<div class="mk-filters" role="group" aria-label="Filter providers">
<div class="mk-filters__row"><span class="mk-label">Area</span>${chips("region", [["all", "All areas"]].concat(REGIONS))}</div>
<div class="mk-filters__row"><span class="mk-label">Service</span>${chips("tag", [["all", "All"]].concat(SERVICE_TAGS.map((t) => [t, t])))}</div>
</div>
<p class="mk-count" aria-live="polite">Showing <strong data-count>${list.length}</strong> of ${list.length} ${list.length === 1 ? "company" : "companies"}<span class="mk-near" data-near hidden></span></p>
${list.length ? `<div class="mk-grid">${cards}</div>` : `<p class="mk-empty">Companies are being added now. <a href="/#quote">Book instantly</a> in the meantime.</p>`}
<p class="mk-empty" data-empty hidden>No companies match both filters yet. <a href="/#quote">Try Instant Booking</a> and Serve will find one.</p>
</div></section>`;

  return shell({
    title: "Find a Home Cleaning Provider in Greater Boston — Serve",
    description: "Compare local, owner-run cleaning companies across Greater Boston and request a free estimate by phone or walkthrough through Serve.",
    canonical: key ? "" : "https://servecleaning.com/providers",
    noindex: !!key,
    body,
    jsonLd: key ? null : {
      "@context": "https://schema.org", "@type": "ItemList",
      itemListElement: list.map((p, i) => ({ "@type": "ListItem", position: i + 1,
        url: "https://servecleaning.com/providers/" + p.slug, name: p.name })),
    },
  });
}

export function renderProfile(p, opts) {
  const o = opts || {};
  const facts = [
    p.serviceArea && ["Service area", p.serviceArea],
    p.ownerName && ["Owner", p.ownerName],
    p.teamLabel && ["Team", p.teamLabel],
    ["Estimates", [p.estimatePhone && "By phone", p.estimateWalkthrough && "walkthrough"].filter(Boolean).join(" or ")],
  ].filter(Boolean);
  const verified = [p.insuranceVerified && "Insurance verified by Serve", p.registrationVerified && "MA registration verified by Serve"].filter(Boolean);
  const methods = [p.estimatePhone && ["phone", "Over the phone", "They call you and quote."],
    p.estimateWalkthrough && ["walkthrough", "Walkthrough", "They visit and quote in person."]].filter(Boolean);

  const body = `${o.preview ? `<div class="mk-preview" role="note"><strong>Preview.</strong> This profile is not public. Only people with the preview link can see it.</div>` : ""}
<header class="mk-phead" style="border-bottom-color:${p.brandColor}"><div class="mk-wrap">
<a class="mk-phead__back" href="${esc(withPreview("/providers", o.previewKey || ""))}">&larr; All providers</a>
<div class="mk-phead__row">
<div class="mk-phead__logo" style="background:${p.logoBg}">${p.logo ? `<img src="${esc(p.logo)}" alt="${esc(p.name)} logo">` : `<span class="mk-card__mono">${esc(p.name.charAt(0))}</span>`}</div>
<div class="mk-phead__text">
<h1 class="mk-hl">${esc(p.name)}</h1>
<p class="mk-phead__tagline">${esc(p.tagline)}</p>
${p.claims.length ? `<p class="mk-phead__claims"><span class="mk-phead__from">From ${esc(p.name)}:</span> ${p.claims.map((c) => `<span>&#10003; ${esc(c)}</span>`).join(" ")}</p>` : ""}
${verified.length ? `<p class="mk-phead__verified">${verified.map((v) => `<span>&#10003; ${esc(v)}</span>`).join(" ")}</p>` : ""}
</div>
<div class="mk-phead__stats">
${p.rating ? `<div><strong>&#9733; ${esc(p.rating.toFixed(1))}</strong><span>${esc(p.reviewCount)} ${esc(p.ratingSource)} reviews</span></div>` : ""}
${p.yearsLabel ? `<div><strong>${esc(p.yearsLabel.split(" ")[0])}</strong><span>${esc(p.yearsLabel.split(" ").slice(1).join(" "))}</span></div>` : ""}
</div>
</div></div></header>
<div class="mk-wrap mk-profile">
<div class="mk-profile__main">
<section class="mk-sec"><h2>About</h2><p>${esc(p.about)}</p>
<dl class="mk-facts">${facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl></section>
${p.services.length ? `<section class="mk-sec"><h2>Services</h2><ul class="mk-tags mk-tags--lg">${p.services.map((s) => `<li>${esc(s)}</li>`).join("")}</ul></section>` : ""}
${p.policies.length ? `<section class="mk-sec"><h2>How They Work</h2><ul class="mk-checks">${p.policies.map((x) => `<li><span style="background:${p.brandColor}" aria-hidden="true">&#10003;</span>${esc(x)}</li>`).join("")}</ul></section>` : ""}
<section class="mk-sec"><h2>Pricing</h2><p>${esc(p.pricingText || "Free estimate by phone or walkthrough.")}</p>
${p.deals.length ? `<ul class="mk-deals">${p.deals.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>` : ""}
<p class="mk-note">Your price comes after a phone call or walkthrough. Serve keeps it on record.</p></section>
${p.photos.length ? `<section class="mk-sec"><h2>Their Work</h2><div class="mk-photos">${p.photos.map((ph) => `<figure><img src="${esc(ph.src)}" alt="${esc(ph.caption || p.name + " work photo")}" loading="lazy"><figcaption>${esc(ph.caption)}</figcaption></figure>`).join("")}</div><p class="mk-note">Photos from ${esc(p.name)}.</p></section>` : ""}
<section class="mk-sec"><h2>Reviews</h2>
<div class="mk-revbox"><div><strong>No reviews on Serve yet.</strong><span>Reviews appear here after clients book through Serve.</span></div>${p.rating ? `<div>&#9733; ${esc(p.rating.toFixed(1))} on ${esc(p.ratingSource)} &middot; ${esc(p.reviewCount)} reviews <span class="mk-note">checked ${esc(p.ratingCheckedOn)}</span></div>` : ""}</div>
${p.quotes.length ? `<p class="mk-label mk-quotes__label">As shown on ${esc(p.quotes[0].source || "their website")}</p><div class="mk-quotes">${p.quotes.map((q) => `<blockquote style="border-left-color:${p.brandColor}"><p>&ldquo;${esc(q.quote)}&rdquo;</p><footer>${esc(q.author)}${q.sourceUrl ? ` &middot; <a href="${esc(q.sourceUrl)}" rel="nofollow noopener" target="_blank">source</a>` : ""}</footer></blockquote>`).join("")}</div>` : ""}
</section>
</div>
<aside class="mk-profile__side" id="estimate">
<form class="mk-form" method="post" action="/api/estimate" novalidate data-estimate>
<h2 class="mk-hl">Get a Free Estimate</h2>
<input type="hidden" name="provider" value="${esc(p.slug)}">
<input type="hidden" name="client_ref" value="">
<input type="hidden" name="source" value="">
<div class="mk-hp" aria-hidden="true"><label>Leave this empty <input type="text" name="website" tabindex="-1" autocomplete="off"></label></div>
<fieldset><legend class="mk-label">How would you like your estimate?</legend>
${methods.map(([v, label, hint], i) => `<label class="mk-choice"><input type="radio" name="method" value="${v}"${i === 0 ? " checked" : ""}><span><strong>${label}</strong><small>${hint}</small></span></label>`).join("")}
</fieldset>
<div class="mk-field" data-walk-only><label class="mk-label" for="mk-address">Address <small>(for walkthroughs)</small></label><input class="flow-input" id="mk-address" name="address" type="text" autocomplete="street-address" placeholder="Street, city, ZIP"></div>
<div class="mk-field"><label class="mk-label" for="mk-phone">Phone number</label><input class="flow-input" id="mk-phone" name="phone" type="tel" autocomplete="tel" placeholder="(617) 555-0123" required></div>
<fieldset><legend class="mk-label">When works best?</legend>
<label class="mk-choice"><input type="radio" name="time_pref" value="earlier" checked><span><strong>Earlier in the day</strong><small>Typically 8:00 AM – 12:00 PM</small></span></label>
<label class="mk-choice"><input type="radio" name="time_pref" value="later"><span><strong>Later in the day</strong><small>Typically 12:00 PM – 5:00 PM</small></span></label>
</fieldset>
<label class="mk-consent"><input type="checkbox" name="sms_consent" value="yes"><span>I agree to receive text messages from Serve about this estimate request, including scheduling updates, at the number provided. Consent is not a condition of purchase. Message frequency varies. Message and data rates may apply. Reply STOP to opt out or HELP for help. <a href="/privacy" target="_blank" rel="noopener">Privacy</a> &middot; <a href="/sms-terms" target="_blank" rel="noopener">SMS Terms</a></span></label>
<p class="mk-form__error" data-error aria-live="polite"></p>
<button type="submit" class="btn btn--primary btn--full">Request Estimate</button>
<p class="mk-note">Free, with no obligation. Serve shares your number${p.estimateWalkthrough ? " (and address, for a walkthrough)" : ""} with ${esc(p.name)} only to arrange this estimate.</p>
<div class="mk-form__done" data-done hidden><strong>Request sent.</strong> We'll pass it to ${esc(p.name)} and they'll reach you during the time you picked.</div>
</form>
<p class="mk-side-instant">Not shopping around? <a href="/#quote">Book instantly</a> and Serve matches you.</p>
</aside>
</div>`;

  return shell({
    title: p.name + " — Home Cleaning in Greater Boston | Serve",
    description: (p.tagline || p.about).slice(0, 155),
    canonical: "https://servecleaning.com/providers/" + p.slug,
    noindex: !!(o.preview || o.previewKey),
    body,
    jsonLd: (o.preview || o.previewKey) ? null : Object.assign({
      "@context": "https://schema.org", "@type": "HouseCleaningService",
      name: p.name, description: p.about, areaServed: p.serviceArea || "Greater Boston, MA",
      url: "https://servecleaning.com/providers/" + p.slug,
    }, p.logo ? { image: "https://servecleaning.com" + p.logo } : {},
    p.rating ? { aggregateRating: { "@type": "AggregateRating", ratingValue: p.rating, reviewCount: p.reviewCount } } : {}),
  });
}

/* ---------- plumbing ---------- */

function htmlRes(html, status, cacheControl) {
  return new Response(html, {
    status: status || 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": cacheControl || "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
    },
  });
}

function jsonRes(obj, status, cacheControl) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": cacheControl || "no-store" },
  });
}

function randomId(n) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  let s = "";
  for (let i = 0; i < n; i++) s += alphabet[bytes[i] % alphabet.length];
  return s;
}

async function hash10(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(s)));
  return [...new Uint8Array(buf)].slice(0, 5).map((b) => b.toString(16).padStart(2, "0")).join("");
}
