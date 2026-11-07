-- Serve marketplace, phase 1. Cloudflare D1 (SQLite).
--
-- Applied with:  npx wrangler d1 migrations apply serve-marketplace --remote
-- Documented in docs/SCHEMA.md under "The marketplace — Cloudflare D1".
--
-- THE PUBLIC PAGES ARE BUILT FROM A WHITELIST, NEVER FROM A ROW. A column added
-- here next month reaches no browser until src/marketplace.js publicProvider()
-- names it on purpose — the same rule the Sheets view models follow.
--
-- Timestamps are ISO-8601 UTC strings. JSON columns hold arrays of strings.

CREATE TABLE IF NOT EXISTS providers (
  id                  TEXT PRIMARY KEY,               -- PRV-0001
  slug                TEXT NOT NULL UNIQUE,           -- URL: /providers/<slug>
  name                TEXT NOT NULL,

  -- Public profile. Every one of these is shown to the public once listed = 1.
  tagline             TEXT NOT NULL DEFAULT '',
  about               TEXT NOT NULL DEFAULT '',
  brand_color         TEXT NOT NULL DEFAULT '#1f2937', -- #rrggbb only
  logo_path           TEXT NOT NULL DEFAULT '',       -- same-origin /images/providers/... only
  logo_bg             TEXT NOT NULL DEFAULT '#ffffff', -- #rrggbb only
  years_label         TEXT NOT NULL DEFAULT '',       -- "18 yrs in business"; '' = not shown
  owner_public_name   TEXT NOT NULL DEFAULT '',
  team_label          TEXT NOT NULL DEFAULT '',
  service_area        TEXT NOT NULL DEFAULT '',       -- human-readable town list
  area_short          TEXT NOT NULL DEFAULT '',       -- "Cambridge · Somerville" for cards
  regions             TEXT NOT NULL DEFAULT '[]',     -- JSON: core | north | west | south
  services            TEXT NOT NULL DEFAULT '[]',     -- JSON: display names, free text
  service_tags        TEXT NOT NULL DEFAULT '[]',     -- JSON: filter vocabulary, see SERVICE_TAGS
  claims              TEXT NOT NULL DEFAULT '[]',     -- JSON: what THEY say (insured, guarantee...)
  policies            TEXT NOT NULL DEFAULT '[]',     -- JSON
  pricing_text        TEXT NOT NULL DEFAULT '',
  deals               TEXT NOT NULL DEFAULT '[]',     -- JSON
  price_label         TEXT NOT NULL DEFAULT 'Pricing',
  price_value         TEXT NOT NULL DEFAULT 'Free estimate',
  card_note           TEXT NOT NULL DEFAULT '',
  estimate_phone      INTEGER NOT NULL DEFAULT 1,     -- offers phone estimates
  estimate_walkthrough INTEGER NOT NULL DEFAULT 1,    -- offers walkthroughs

  -- Third-party rating. Shown only with its source and the date it was checked.
  rating              REAL,
  review_count        INTEGER,
  rating_source       TEXT NOT NULL DEFAULT '',       -- "Google"
  rating_checked_on   TEXT NOT NULL DEFAULT '',       -- YYYY-MM-DD; blank = not shown

  -- Serve's own checks. Shown as verified ONLY when Serve has done the check.
  insurance_verified  INTEGER NOT NULL DEFAULT 0,
  registration_verified INTEGER NOT NULL DEFAULT 0,

  -- Serve-only. NEVER rendered, NEVER returned by /api/providers. Founder
  -- decision 2026-11-06: every request goes through Serve, so the business's
  -- own phone, email and website stay internal.
  internal_contact    TEXT NOT NULL DEFAULT '',
  internal_phone      TEXT NOT NULL DEFAULT '',
  internal_email      TEXT NOT NULL DEFAULT '',
  website_url         TEXT NOT NULL DEFAULT '',
  internal_notes      TEXT NOT NULL DEFAULT '',
  vendor_id           TEXT NOT NULL DEFAULT '',       -- Ops VENDORS id, for the brokered lane

  -- Publication. listed = 1 is the ONLY thing that makes a profile public.
  status              TEXT NOT NULL DEFAULT 'prospect', -- prospect | approved | paused | removed
  listed              INTEGER NOT NULL DEFAULT 0,
  owner_approved_at   TEXT NOT NULL DEFAULT '',
  sort_rank           INTEGER NOT NULL DEFAULT 1000,  -- ascending; placeholder ordering
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS providers_listed ON providers (listed, sort_rank);

CREATE TABLE IF NOT EXISTS provider_photos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id TEXT NOT NULL REFERENCES providers(id),
  path        TEXT NOT NULL,                          -- same-origin /images/providers/... only
  caption     TEXT NOT NULL DEFAULT '',
  sort        INTEGER NOT NULL DEFAULT 0,
  visible     INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS provider_photos_by_provider ON provider_photos (provider_id, sort);

-- Other people's words about a company, with where they came from. Shown under
-- "As shown on their website" (or whatever source says), never as Serve reviews.
CREATE TABLE IF NOT EXISTS provider_quotes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id TEXT NOT NULL REFERENCES providers(id),
  quote       TEXT NOT NULL,
  author      TEXT NOT NULL DEFAULT '',               -- first name only
  source      TEXT NOT NULL DEFAULT '',               -- "their website", "Google"
  source_url  TEXT NOT NULL DEFAULT '',               -- http(s) only
  sort        INTEGER NOT NULL DEFAULT 0,
  visible     INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS provider_quotes_by_provider ON provider_quotes (provider_id, sort);

-- One row per person who has asked for an estimate. Keyed by phone because the
-- estimate form asks for nothing else that identifies them.
CREATE TABLE IF NOT EXISTS clients (
  id          TEXT PRIMARY KEY,                       -- CLI-xxxxxxxx
  phone_e164  TEXT NOT NULL UNIQUE,
  sms_consent INTEGER NOT NULL DEFAULT 0,
  sms_consent_at TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS estimate_requests (
  id            TEXT PRIMARY KEY,                     -- EST-xxxxxxxxxx
  provider_id   TEXT NOT NULL REFERENCES providers(id),
  client_id     TEXT NOT NULL REFERENCES clients(id),
  method        TEXT NOT NULL,                        -- phone | walkthrough
  phone_e164    TEXT NOT NULL,
  address       TEXT NOT NULL DEFAULT '',             -- walkthrough only; never logged
  zip           TEXT NOT NULL DEFAULT '',
  time_pref     TEXT NOT NULL,                        -- earlier | later
  status        TEXT NOT NULL DEFAULT 'new',          -- new | contacted | quoted | booked | closed
  -- The quote, once the business gives one. The one number Serve exists to keep.
  quoted_price_cents INTEGER,
  quoted_frequency   TEXT NOT NULL DEFAULT '',
  quote_note         TEXT NOT NULL DEFAULT '',
  quoted_at          TEXT NOT NULL DEFAULT '',
  sms_consent   INTEGER NOT NULL DEFAULT 0,
  source        TEXT NOT NULL DEFAULT '',             -- utm_source / page, for attribution
  -- Minted by the page before it sends. A retry after a timeout carries the
  -- same value and gets the original row back instead of filing a second
  -- request — the r58 lesson from the Sheets side.
  client_ref    TEXT NOT NULL DEFAULT '',
  notified_at   TEXT NOT NULL DEFAULT '',             -- founder email confirmed by the webhook
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS estimate_requests_client_ref
  ON estimate_requests (client_ref) WHERE client_ref <> '';
CREATE INDEX IF NOT EXISTS estimate_requests_by_provider ON estimate_requests (provider_id, created_at);
CREATE INDEX IF NOT EXISTS estimate_requests_by_client   ON estimate_requests (client_id, created_at);

-- My home (phase 2 UI; the tables exist now so the shape is settled once).
CREATE TABLE IF NOT EXISTS homes (
  id          TEXT PRIMARY KEY,                       -- HOM-xxxxxxxx
  client_id   TEXT NOT NULL REFERENCES clients(id),
  label       TEXT NOT NULL DEFAULT 'My home',
  address     TEXT NOT NULL DEFAULT '',
  zip         TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS homes_by_client ON homes (client_id);

CREATE TABLE IF NOT EXISTS home_rooms (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  home_id     TEXT NOT NULL REFERENCES homes(id),
  room_type   TEXT NOT NULL,                          -- bedroom | bathroom | kitchen | living | other
  label       TEXT NOT NULL DEFAULT '',
  sort        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS home_rooms_by_home ON home_rooms (home_id, sort);
