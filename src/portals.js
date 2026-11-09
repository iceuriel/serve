/* ============================================================
   THE PORTALS' DATA — /account (clients), /business (companies), /admin/edits.
   Cloudflare D1, binding MARKET_DB. Schema: migrations/0003_portals.sql.
   ============================================================

   design/serve/db/portals_schema.sql protects these tables with Postgres
   row-level security. D1 has none, so THIS FILE IS THE POLICY: no portal route
   may touch a portal table except through a function here, and every function
   takes the ACTOR first and decides from it alone what may be read or written.
   tests/portals.test.js holds each one to the kit's policy of the same name.

   Actors (who is asking), built by the routes, never by a request body:
     { kind: "client",   clientId }    a signed-in client (sign-in: PR 2+)
     { kind: "provider", providerId }  a company's owner preview link today;
                                       a provider_members sign-in later
     { kind: "admin" }                 the founder (MARKET_PREVIEW_KEY)

   THE RULES, with the kit policy each one replaces:
   1. A company reads a client's home ONLY after that client sent it a request
      (partner_can_see_client).
   2. A company sees a client's street address ONLY on a walkthrough request
      (get_partner_requests). The name is first name + last initial.
   3. A company never writes providers or quotes directly: a status change is
      markContacted / sendQuote on its OWN request, a quote is a new row (the
      table refuses UPDATE and DELETE), and a profile change is a pending
      edit that only the founder can apply (partners_admin_all,
      quotes_*_read, edits_member_insert, approve_profile_edit).
   4. Everything returned is built field by field (the marketplace's rule):
      no row is ever handed out whole. */

/**
 * @typedef {{ kind: "client", clientId: string } | { kind: "provider", providerId: string } | { kind: "admin" }} Actor
 * @typedef {"bedroom"|"bathroom"|"half_bath"|"kitchen"|"living_room"|"dining_room"|"office"|"laundry"|"entryway"|"other"} RoomType
 * @typedef {{ id?: string, type: RoomType, name: string, notes: string }} Room
 * @typedef {{ id?: string, name: string, rooms: Room[] }} Floor
 * @typedef {{ levels: number, beds: number, baths: number, rooms: number, notes: number }} HomeSummary
 * @typedef {{ wholeNotes: string, floors: Floor[], summary: HomeSummary }} HomeView
 * @typedef {"one_time"|"one_time_deep"|"move_in_out"|"weekly"|"biweekly"|"monthly"} Frequency
 * @typedef {{ amountCents: number, frequency: Frequency, createdAt: string }} QuoteView
 * @typedef {{
 *   id: string, status: string, method: "phone"|"walkthrough", timePref: "earlier"|"later",
 *   createdAt: string, contactedAt: string, quotedAt: string,
 *   clientName: string, neighborhood: string, phone: string, contactPref: "text"|"call"|"either",
 *   address: string, latestQuote: QuoteView|null, home: HomeView|null
 * }} PartnerRequestView
 * @typedef {{ ok: true } | { ok: false, error: string }} Result
 */

export const ROOM_TYPES = ["bedroom", "bathroom", "half_bath", "kitchen", "living_room",
  "dining_room", "office", "laundry", "entryway", "other"];
export const FREQUENCIES = ["one_time", "one_time_deep", "move_in_out", "weekly", "biweekly", "monthly"];
/* The business profile's service chips (PORTALS_SPEC.md §4). The first five
   are the marketplace's filter tags (marketplace.js SERVICE_TAGS); a test
   holds the two lists together. */
export const PORTAL_SERVICES = ["Recurring", "Deep clean", "Move in / out", "Post-construction", "Airbnb", "Organizing", "Commercial"];
const FILTER_TAGS = PORTAL_SERVICES.slice(0, 5);
export const PRICE_LABELS = ["Pricing", "Starts at", "Current offer", "New clients", "Recurring plans"];
const AREA_RE = /^[a-z]+(?:-[a-z]+)*$/;
const MAX_QUOTE_CENTS = 10000000;

const isProvider = (a, providerId) => !!a && a.kind === "provider" && !!providerId && a.providerId === providerId;
const isAdmin = (a) => !!a && a.kind === "admin";
const isClient = (a, clientId) => !!a && a.kind === "client" && !!clientId && a.clientId === clientId;
const fail = (error) => ({ ok: false, error });
const now = () => new Date().toISOString();

/* ---------- My Home ---------- */

/** Policy homes_own + homes_partner_read: the client, a company the client
    has sent a request to, or the founder. Anyone else gets null, exactly as
    if there were no home. Floor and room ids go to the client only. */
export async function getHome(db, actor, clientId) {
  if (!(await canSeeHome(db, actor, clientId))) return null;
  return loadHome(db, clientId, isClient(actor, clientId));
}

async function canSeeHome(db, actor, clientId) {
  if (isClient(actor, clientId) || isAdmin(actor)) return true;
  if (!actor || actor.kind !== "provider" || !actor.providerId) return false;
  const hit = await db.prepare("SELECT 1 AS ok FROM estimate_requests WHERE client_id = ? AND provider_id = ? LIMIT 1")
    .bind(clientId, actor.providerId).first();
  return !!hit;
}

async function loadHome(db, clientId, withIds) {
  const home = await db.prepare("SELECT id, whole_notes FROM homes WHERE client_id = ?").bind(clientId).first();
  if (!home) return null;
  const [floors, rooms] = await Promise.all([
    db.prepare("SELECT id, name FROM home_floors WHERE home_id = ? ORDER BY position, id").bind(home.id).all(),
    db.prepare("SELECT r.id, r.floor_id, r.room_type, r.label, r.notes FROM home_rooms r " +
      "JOIN home_floors f ON f.id = r.floor_id WHERE f.home_id = ? ORDER BY r.sort, r.id").bind(home.id).all(),
  ]);
  const view = {
    wholeNotes: String(home.whole_notes || ""),
    floors: (floors.results || []).map((f) => Object.assign(withIds ? { id: String(f.id) } : {}, {
      name: String(f.name || ""),
      rooms: (rooms.results || []).filter((r) => r.floor_id === f.id).map((r) => Object.assign(withIds ? { id: String(r.id) } : {}, {
        type: ROOM_TYPES.includes(r.room_type) ? r.room_type : "other",
        name: String(r.label || ""),
        notes: String(r.notes || ""),
      })),
    })),
  };
  view.summary = homeSummary(view);
  return view;
}

/** The summary chips: half baths count 0.5; "notes" counts rooms with notes. */
export function homeSummary(home) {
  const rooms = [].concat(...(home.floors || []).map((f) => f.rooms || []));
  const count = (t) => rooms.filter((r) => r.type === t).length;
  return {
    levels: (home.floors || []).length,
    beds: count("bedroom"),
    baths: count("bathroom") + count("half_bath") * 0.5,
    rooms: rooms.length,
    notes: rooms.filter((r) => String(r.notes || "").trim()).length,
  };
}

/* ---------- the business inbox ---------- */

/** Policy get_partner_requests: one company's requests, newest first, each
    with what that company may know about the client. */
export async function partnerRequests(db, actor, providerId) {
  if (!isProvider(actor, providerId) && !isAdmin(actor)) return null;
  const { results } = await db.prepare(
    "SELECT r.id, r.client_id, r.status, r.method, r.time_pref, r.address, r.created_at, r.contacted_at, r.quoted_at, " +
    "c.full_name, c.neighborhood, c.phone_e164, c.contact_pref, c.street_address, c.unit, " +
    "(SELECT amount_cents FROM quotes q WHERE q.request_id = r.id ORDER BY q.created_at DESC, q.rowid DESC LIMIT 1) AS q_amount, " +
    "(SELECT frequency FROM quotes q WHERE q.request_id = r.id ORDER BY q.created_at DESC, q.rowid DESC LIMIT 1) AS q_frequency, " +
    "(SELECT created_at FROM quotes q WHERE q.request_id = r.id ORDER BY q.created_at DESC, q.rowid DESC LIMIT 1) AS q_at " +
    "FROM estimate_requests r JOIN clients c ON c.id = r.client_id " +
    "WHERE r.provider_id = ? ORDER BY r.created_at DESC").bind(providerId).all();
  const homes = {};
  const out = [];
  for (const r of results || []) {
    if (!(r.client_id in homes)) homes[r.client_id] = await loadHome(db, r.client_id, false);
    const walk = r.method === "walkthrough";
    out.push({
      id: String(r.id),
      status: String(r.status),
      method: walk ? "walkthrough" : "phone",
      timePref: r.time_pref === "later" ? "later" : "earlier",
      createdAt: String(r.created_at || ""),
      contactedAt: String(r.contacted_at || ""),
      quotedAt: String(r.quoted_at || ""),
      clientName: shortName(r.full_name),
      neighborhood: String(r.neighborhood || ""),
      phone: prettyPhone(r.phone_e164),
      contactPref: ["text", "call", "either"].includes(r.contact_pref) ? r.contact_pref : "text",
      /* The request's own walkthrough address wins (the estimate form asks
         for it); otherwise the client's profile address. Never for phone. */
      address: walk ? (String(r.address || "").trim() || [r.street_address, r.unit].map((s) => String(s || "").trim()).filter(Boolean).join(", ")) : "",
      latestQuote: r.q_amount ? { amountCents: Number(r.q_amount), frequency: String(r.q_frequency), createdAt: String(r.q_at) } : null,
      home: homes[r.client_id],
    });
  }
  return out;
}

/** "Alex Rivera" → "Alex R." */
export function shortName(full) {
  const parts = String(full || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "";
  return parts[0] + (parts[1] ? " " + parts[1].charAt(0).toUpperCase() + "." : "");
}

function prettyPhone(e164) {
  const d = String(e164 || "").replace(/^\+1/, "");
  return d.length === 10 ? "(" + d.slice(0, 3) + ") " + d.slice(3, 6) + "-" + d.slice(6) : "";
}

/** Policy mark_contacted: the company's own request, and only from "new". */
export async function markContacted(db, actor, requestId) {
  if (!actor || actor.kind !== "provider") return fail("not_allowed");
  const t = now();
  const row = await db.prepare(
    "UPDATE estimate_requests SET status = 'contacted', contacted_at = ?, updated_at = ? " +
    "WHERE id = ? AND provider_id = ? AND status = 'new' RETURNING id")
    .bind(t, t, String(requestId || ""), actor.providerId).first();
  return row ? { ok: true } : fail("not_allowed");
}

/** Policy send_quote: a NEW quotes row on the company's own request, and the
    request moves to "quoted" in the same batch. Editing a quote is calling
    this again; the old row stays. */
export async function sendQuote(db, actor, requestId, amountCents, frequency) {
  if (!actor || actor.kind !== "provider") return fail("not_allowed");
  const cents = Number(amountCents);
  if (!Number.isInteger(cents) || cents <= 0 || cents > MAX_QUOTE_CENTS) return fail("bad_amount");
  if (!FREQUENCIES.includes(frequency)) return fail("bad_frequency");
  const req = await db.prepare("SELECT provider_id, status FROM estimate_requests WHERE id = ?").bind(String(requestId || "")).first();
  if (!req || req.provider_id !== actor.providerId) return fail("not_allowed");
  if (!["new", "contacted", "quoted"].includes(req.status)) return fail("not_open");
  const t = now();
  const id = "QTE-" + randomId(10);
  await db.batch([
    db.prepare("INSERT INTO quotes (id, request_id, provider_id, amount_cents, frequency, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(id, requestId, actor.providerId, cents, frequency, String(actor.email || ""), t),
    db.prepare("UPDATE estimate_requests SET status = 'quoted', quoted_at = ?, " +
      "contacted_at = CASE WHEN contacted_at = '' THEN ? ELSE contacted_at END, " +
      "quoted_price_cents = ?, quoted_frequency = ?, updated_at = ? WHERE id = ? AND provider_id = ?")
      .bind(t, t, cents, frequency, t, requestId, actor.providerId),
  ]);
  return { ok: true, id };
}

/* ---------- business profile edits ---------- */

/* The only keys a company may change, each with its check and the providers
   column(s) it lands in on approval. Ratings, reviews, logos, listing and
   every internal field are absent on purpose: a key not here is refused. */
const str = (max, min) => (v) => {
  if (typeof v !== "string") return undefined;
  const s = v.replace(/\s+/g, " ").trim();
  return s.length >= (min || 0) && s.length <= max ? s : undefined;
};
const EDITABLE = {
  name:          { check: str(80, 2),   columns: ["name"] },
  phone:         { check: (v) => { const s = str(20)(v); return s !== undefined && /^[\d\s().+-]*$/.test(s) ? s : undefined; }, columns: ["internal_phone"] },
  tagline:       { check: str(120),     columns: ["tagline"] },
  about:         { check: (v) => typeof v === "string" && v.trim().length <= 1500 ? v.trim() : undefined, columns: ["about"] },
  service_areas: { check: (v) => Array.isArray(v) && v.length <= 40 && v.every((a) => typeof a === "string" && AREA_RE.test(a)) ? [...new Set(v)] : undefined, columns: ["service_areas"] },
  services:      { check: (v) => Array.isArray(v) && v.every((s) => PORTAL_SERVICES.includes(s)) ? PORTAL_SERVICES.filter((s) => v.includes(s)) : undefined, columns: ["services", "service_tags"] },
  price_label:   { check: (v) => PRICE_LABELS.includes(v) ? v : undefined, columns: ["price_label"] },
  price:         { check: str(60),      columns: ["price_value"] },
  highlight:     { check: str(60),      columns: ["card_note"] },
};
export const EDITABLE_KEYS = Object.keys(EDITABLE);

function currentValue(row, key) {
  const col = EDITABLE[key].columns[0];
  if (key === "service_areas" || key === "services") {
    try { return JSON.parse(row[col] || "[]"); } catch (_) { return []; }
  }
  return String(row[col] || "");
}

/** Policy edits_member_insert: a company files a PENDING edit to its own
    profile holding only the keys that actually changed. providers is not
    touched. */
export async function submitProfileEdit(db, actor, providerId, changes) {
  if (!isProvider(actor, providerId)) return fail("not_allowed");
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) return fail("bad_changes");
  const row = await db.prepare("SELECT * FROM providers WHERE id = ? AND status <> 'removed'").bind(providerId).first();
  if (!row) return fail("not_allowed");
  const clean = {};
  for (const key of Object.keys(changes)) {
    if (!EDITABLE[key]) return fail("not_editable:" + key);
    const v = EDITABLE[key].check(changes[key]);
    if (v === undefined) return fail("bad_value:" + key);
    if (JSON.stringify(v) !== JSON.stringify(currentValue(row, key))) clean[key] = v;
  }
  if (clean.service_areas && clean.service_areas.length) {
    const marks = clean.service_areas.map(() => "?").join(",");
    const { results } = await db.prepare("SELECT slug FROM neighborhoods WHERE slug IN (" + marks + ")").bind(...clean.service_areas).all();
    if ((results || []).length !== clean.service_areas.length) return fail("bad_value:service_areas");
  }
  if (!Object.keys(clean).length) return fail("no_changes");
  const id = "EDT-" + randomId(8);
  await db.prepare("INSERT INTO provider_profile_edits (id, provider_id, submitted_by, changes, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)")
    .bind(id, providerId, String(actor.email || ""), JSON.stringify(clean), now()).run();
  return { ok: true, id };
}

/** Policy approve_profile_edit: the founder only. The provider row changes
    and the edit is marked approved in one batch, and only while it is still
    pending, so approving twice applies nothing twice. */
export async function approveProfileEdit(db, actor, editId) {
  if (!isAdmin(actor)) return fail("not_allowed");
  const edit = await db.prepare("SELECT id, provider_id, changes FROM provider_profile_edits WHERE id = ? AND status = 'pending'")
    .bind(String(editId || "")).first();
  if (!edit) return fail("no_pending_edit");
  let changes;
  try { changes = JSON.parse(edit.changes); } catch (_) { return fail("bad_changes"); }
  const sets = [];
  const vals = [];
  for (const key of Object.keys(changes)) {
    if (!EDITABLE[key]) continue;                       // re-checked: never trust the stored JSON
    const v = EDITABLE[key].check(changes[key]);
    if (v === undefined) continue;
    const [col, tagsCol] = EDITABLE[key].columns;
    sets.push(col + " = ?");
    vals.push(Array.isArray(v) ? JSON.stringify(v) : v);
    if (tagsCol) { sets.push(tagsCol + " = ?"); vals.push(JSON.stringify(v.filter((s) => FILTER_TAGS.includes(s)))); }
  }
  const t = now();
  const stmts = [];
  if (sets.length) {
    stmts.push(db.prepare("UPDATE providers SET " + sets.join(", ") + ", updated_at = ? WHERE id = ? AND EXISTS " +
      "(SELECT 1 FROM provider_profile_edits WHERE id = ? AND status = 'pending')")
      .bind(...vals, t, edit.provider_id, edit.id));
  }
  stmts.push(db.prepare("UPDATE provider_profile_edits SET status = 'approved', reviewed_at = ? WHERE id = ? AND status = 'pending'")
    .bind(t, edit.id));
  await db.batch(stmts);
  return { ok: true };
}

/** The founder turns an edit down; nothing public changes. */
export async function rejectProfileEdit(db, actor, editId, note) {
  if (!isAdmin(actor)) return fail("not_allowed");
  const row = await db.prepare("UPDATE provider_profile_edits SET status = 'rejected', review_note = ?, reviewed_at = ? " +
    "WHERE id = ? AND status = 'pending' RETURNING id").bind(str(500)(note || "") || "", now(), String(editId || "")).first();
  return row ? { ok: true } : fail("no_pending_edit");
}

function randomId(n) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  let s = "";
  for (let i = 0; i < n; i++) s += alphabet[bytes[i] % alphabet.length];
  return s;
}
