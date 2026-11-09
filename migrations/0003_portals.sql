-- 0003: the client and business portals (design/serve/PORTALS_SPEC.md).
--
-- design/serve/db/portals_schema.sql is written for Supabase (Postgres, with
-- auth.users and row-level security). Serve runs on D1 (SQLite) inside the
-- Worker, so this is that schema ADAPTED, not copied:
--
--   kit table               here
--   partners                providers (exists; every column the portals need
--                           is already there, see docs/SCHEMA.md)
--   partner_members         provider_members (by email: there are no sign-ins
--                           yet; the owner preview link is the access for now)
--   admins                  none: the founder's MARKET_PREVIEW_KEY
--   clients                 clients (exists; profile columns added below)
--   homes                   homes (exists; whole_notes + one home per client)
--   home_floors             home_floors (new)
--   home_rooms              home_rooms (exists, unused until now; floor_id and
--                           notes added; type = room_type, name = label,
--                           position = sort)
--   quote_requests          estimate_requests (exists; contacted_at added)
--   quotes                  quotes (new; append-only, enforced by triggers)
--   partner_profile_edits   provider_profile_edits (new)
--
-- SQLite has no row-level security. The kit's policies and RPCs are the
-- functions in src/portals.js, which is the ONLY code that reads or writes
-- these tables for a portal; tests/portals.test.js holds it to each policy.
-- What the database itself can enforce, it does here: value checks on new
-- columns, one home per client, and quotes that can never be changed.
--
-- Timestamps are ISO-8601 UTC strings, as in 0001. Nothing here is seeded:
-- db/dev-seed-portals.sql is sample data for local databases only.

-- ---------- who may open a company's business portal (sign-in, later) ----------
CREATE TABLE provider_members (
  provider_id TEXT NOT NULL REFERENCES providers(id),
  email       TEXT NOT NULL CHECK (email = lower(email) AND email LIKE '%_@_%'),
  role        TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'staff')),
  created_at  TEXT NOT NULL,
  PRIMARY KEY (provider_id, email)
);

-- ---------- clients: the Profile tab ----------
ALTER TABLE clients ADD COLUMN full_name TEXT NOT NULL DEFAULT '';
ALTER TABLE clients ADD COLUMN email TEXT NOT NULL DEFAULT '';
ALTER TABLE clients ADD COLUMN neighborhood TEXT NOT NULL DEFAULT '';
-- Shared with a company ONLY for a walkthrough request (src/portals.js).
ALTER TABLE clients ADD COLUMN street_address TEXT NOT NULL DEFAULT '';
ALTER TABLE clients ADD COLUMN unit TEXT NOT NULL DEFAULT '';
ALTER TABLE clients ADD COLUMN contact_pref TEXT NOT NULL DEFAULT 'text'
  CHECK (contact_pref IN ('text', 'call', 'either'));

-- ---------- My Home ----------
ALTER TABLE homes ADD COLUMN whole_notes TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX homes_one_per_client ON homes (client_id);

CREATE TABLE home_floors (
  id        TEXT PRIMARY KEY,                         -- FLR-xxxxxxxx
  home_id   TEXT NOT NULL REFERENCES homes(id) ON DELETE CASCADE,
  name      TEXT NOT NULL,
  position  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX home_floors_by_home ON home_floors (home_id, position);

-- room_type: bedroom | bathroom | half_bath | kitchen | living_room |
-- dining_room | office | laundry | entryway | other. SQLite cannot add a
-- CHECK to an existing column; src/portals.js validates it.
ALTER TABLE home_rooms ADD COLUMN floor_id TEXT REFERENCES home_floors(id) ON DELETE CASCADE;
ALTER TABLE home_rooms ADD COLUMN notes TEXT NOT NULL DEFAULT '';
CREATE INDEX home_rooms_by_floor ON home_rooms (floor_id, sort);

-- ---------- requests + quotes ----------
-- status stays new | contacted | quoted | booked | closed (0001). The
-- quoted_* columns on the request keep the LATEST quote, written in the same
-- batch as its quotes row, so the founder's views need no join.
ALTER TABLE estimate_requests ADD COLUMN contacted_at TEXT NOT NULL DEFAULT '';

-- "Serve keeps every quote on record": editing a quote inserts a new row.
CREATE TABLE quotes (
  id            TEXT PRIMARY KEY,                     -- QTE-xxxxxxxxxx
  request_id    TEXT NOT NULL REFERENCES estimate_requests(id),
  provider_id   TEXT NOT NULL REFERENCES providers(id),
  amount_cents  INTEGER NOT NULL CHECK (amount_cents > 0 AND amount_cents <= 10000000),
  frequency     TEXT NOT NULL CHECK (frequency IN
                  ('one_time', 'one_time_deep', 'move_in_out', 'weekly', 'biweekly', 'monthly')),
  created_by    TEXT NOT NULL DEFAULT '',             -- member email; '' = owner preview link
  created_at    TEXT NOT NULL
);
CREATE INDEX quotes_by_request ON quotes (request_id, created_at);

CREATE TRIGGER quotes_no_update BEFORE UPDATE ON quotes
BEGIN SELECT RAISE(ABORT, 'quotes are append-only'); END;
CREATE TRIGGER quotes_no_delete BEFORE DELETE ON quotes
BEGIN SELECT RAISE(ABORT, 'quotes are append-only'); END;

-- ---------- business profile edits, reviewed by Serve ----------
-- changes: JSON object holding ONLY the keys the business changed, from
-- name, phone, tagline, about, service_areas, services, price_label, price,
-- highlight (src/portals.js EDITABLE). Nothing public changes until the
-- founder approves.
CREATE TABLE provider_profile_edits (
  id           TEXT PRIMARY KEY,                      -- EDT-xxxxxxxx
  provider_id  TEXT NOT NULL REFERENCES providers(id),
  submitted_by TEXT NOT NULL DEFAULT '',              -- member email; '' = owner preview link
  changes      TEXT NOT NULL CHECK (json_valid(changes) AND json_type(changes) = 'object'),
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  review_note  TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL,
  reviewed_at  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX provider_profile_edits_by_provider ON provider_profile_edits (provider_id, created_at);
CREATE INDEX provider_profile_edits_pending ON provider_profile_edits (status, created_at);
