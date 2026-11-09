-- SAMPLE DATA FOR LOCAL / DEV DATABASES ONLY. NEVER RUN WITH --remote.
--
-- The portals' design sample (design/serve/reference/portals/ProviderPortal.dc.html):
-- four estimate requests to Taskforce Cleaning Services, one in each stage
-- the inbox shows (two new, one contacted, one quoted), from four clients,
-- each with the home the design draws. Cambridge Clean Co is the second
-- company: it has a member and NO requests, which is what the access tests
-- need. Every id starts with DEV and every phone is a 555-01xx number, so a
-- row from this file is recognisable anywhere it turns up.
--
-- Needs migrations 0001-0003 and db/seed-first-partners.sql (for PRV-0003 and
-- PRV-0006). Local apply:
--   npx.cmd wrangler d1 execute serve-marketplace --local --file db/dev-seed-portals.sql

INSERT OR IGNORE INTO provider_members (provider_id, email, role, created_at) VALUES
  ('PRV-0003', 'taskforce.owner@example.com', 'owner', '2026-11-01T12:00:00.000Z'),
  ('PRV-0006', 'cambridge.owner@example.com', 'owner', '2026-11-01T12:00:00.000Z');

INSERT OR IGNORE INTO clients (id, phone_e164, sms_consent, sms_consent_at, full_name, email, neighborhood, street_address, unit, contact_pref, created_at, updated_at) VALUES
  ('CLI-DEV00001', '+16175550123', 1, '2026-11-09T14:14:00.000Z', 'Alex Rivera',     'alex@example.com',   'Union Square, Somerville', '[Street], Somerville, MA 02143', 'Unit 2', 'text',   '2026-11-09T14:14:00.000Z', '2026-11-09T14:14:00.000Z'),
  ('CLI-DEV00002', '+16175550147', 0, '',                         'Priya Shah',      'priya@example.com',  'Inman Square, Cambridge',  '[Street], Cambridge, MA 02139',  '',       'call',   '2026-11-08T23:40:00.000Z', '2026-11-08T23:40:00.000Z'),
  ('CLI-DEV00003', '+18575550189', 1, '2026-11-05T15:00:00.000Z', 'Marcus Thompson', 'marcus@example.com', 'Everett',                  '[Street], Everett, MA 02149',    '',       'text',   '2026-11-05T15:00:00.000Z', '2026-11-05T15:00:00.000Z'),
  ('CLI-DEV00004', '+17815550162', 0, '',                         'Dana Reyes',      'dana@example.com',   'Ball Square, Somerville',  '[Street], Somerville, MA 02144', '',       'either', '2026-11-04T13:00:00.000Z', '2026-11-04T13:00:00.000Z');

INSERT OR IGNORE INTO estimate_requests (id, provider_id, client_id, method, phone_e164, address, zip, time_pref, status, quoted_price_cents, quoted_frequency, quoted_at, contacted_at, sms_consent, source, created_at, updated_at) VALUES
  ('EST-DEV0000001', 'PRV-0003', 'CLI-DEV00001', 'walkthrough', '+16175550123', '', '02143', 'earlier', 'new',       NULL,  '',              '',                         '',                         1, 'dev-seed', '2026-11-09T14:14:00.000Z', '2026-11-09T14:14:00.000Z'),
  ('EST-DEV0000002', 'PRV-0003', 'CLI-DEV00002', 'phone',       '+16175550147', '', '',      'later',   'contacted', NULL,  '',              '',                         '2026-11-09T13:00:00.000Z', 0, 'dev-seed', '2026-11-08T23:40:00.000Z', '2026-11-09T13:00:00.000Z'),
  ('EST-DEV0000003', 'PRV-0003', 'CLI-DEV00003', 'walkthrough', '+18575550189', '', '02149', 'later',   'quoted',    24000, 'one_time_deep', '2026-11-06T16:00:00.000Z', '2026-11-05T18:00:00.000Z', 1, 'dev-seed', '2026-11-05T15:00:00.000Z', '2026-11-06T16:00:00.000Z'),
  ('EST-DEV0000004', 'PRV-0003', 'CLI-DEV00004', 'phone',       '+17815550162', '', '',      'earlier', 'new',       NULL,  '',              '',                         '',                         0, 'dev-seed', '2026-11-04T13:00:00.000Z', '2026-11-04T13:00:00.000Z');

INSERT OR IGNORE INTO quotes (id, request_id, provider_id, amount_cents, frequency, created_by, created_at) VALUES
  ('QTE-DEV0000001', 'EST-DEV0000003', 'PRV-0003', 24000, 'one_time_deep', 'taskforce.owner@example.com', '2026-11-06T16:00:00.000Z');

INSERT OR IGNORE INTO homes (id, client_id, label, address, zip, whole_notes, created_at, updated_at) VALUES
  ('HOM-DEV00001', 'CLI-DEV00001', 'My home', '', '02143', 'One cat (Miso): please keep the basement door closed. Lockbox code is texted the morning of.', '2026-11-09T14:14:00.000Z', '2026-11-09T14:14:00.000Z'),
  ('HOM-DEV00002', 'CLI-DEV00002', 'My home', '', '02139', '', '2026-11-08T23:40:00.000Z', '2026-11-08T23:40:00.000Z'),
  ('HOM-DEV00003', 'CLI-DEV00003', 'My home', '', '02149', 'Moving out Nov 30: inside of oven and fridge too.', '2026-11-05T15:00:00.000Z', '2026-11-05T15:00:00.000Z'),
  ('HOM-DEV00004', 'CLI-DEV00004', 'My home', '', '02144', '', '2026-11-04T13:00:00.000Z', '2026-11-04T13:00:00.000Z');

INSERT OR IGNORE INTO home_floors (id, home_id, name, position) VALUES
  ('FLR-DEV00011', 'HOM-DEV00001', 'First floor', 0),
  ('FLR-DEV00012', 'HOM-DEV00001', 'Second floor', 1),
  ('FLR-DEV00021', 'HOM-DEV00002', 'Apartment', 0),
  ('FLR-DEV00031', 'HOM-DEV00003', 'First floor', 0),
  ('FLR-DEV00032', 'HOM-DEV00003', 'Second floor', 1),
  ('FLR-DEV00041', 'HOM-DEV00004', 'Basement', 0),
  ('FLR-DEV00042', 'HOM-DEV00004', 'First floor', 1),
  ('FLR-DEV00043', 'HOM-DEV00004', 'Second floor', 2);

-- Fixed ids from 900001 (home_rooms.id is otherwise AUTOINCREMENT), so a
-- re-run is ignored like every other row here. One plain VALUES list: D1
-- caps compound SELECTs well below this many UNION ALL terms.
INSERT OR IGNORE INTO home_rooms (id, home_id, floor_id, room_type, label, notes, sort) VALUES
  (900001, 'HOM-DEV00001', 'FLR-DEV00011', 'kitchen', 'Kitchen', 'Gas stove: please degrease the hood. Butcher-block counter, no bleach.', 0),
  (900002, 'HOM-DEV00001', 'FLR-DEV00011', 'living_room', 'Living room', '', 1),
  (900003, 'HOM-DEV00001', 'FLR-DEV00011', 'dining_room', 'Dining room', '', 2),
  (900004, 'HOM-DEV00001', 'FLR-DEV00011', 'half_bath', 'Half bath', '', 3),
  (900005, 'HOM-DEV00001', 'FLR-DEV00012', 'bedroom', 'Primary bedroom', 'Hardwood floors: dry mop only, no wet mop.', 0),
  (900006, 'HOM-DEV00001', 'FLR-DEV00012', 'bedroom', 'Kids'' room', 'Skip the desk and art table.', 1),
  (900007, 'HOM-DEV00001', 'FLR-DEV00012', 'bathroom', 'Hall bathroom', 'Glass shower door: squeegee, nothing abrasive.', 2),
  (900008, 'HOM-DEV00001', 'FLR-DEV00012', 'office', 'Office', '', 3),
  (900009, 'HOM-DEV00002', 'FLR-DEV00021', 'kitchen', 'Kitchen', '', 0),
  (900010, 'HOM-DEV00002', 'FLR-DEV00021', 'living_room', 'Living room', 'Velvet sofa: vacuum only.', 1),
  (900011, 'HOM-DEV00002', 'FLR-DEV00021', 'bedroom', 'Bedroom', '', 2),
  (900012, 'HOM-DEV00002', 'FLR-DEV00021', 'bathroom', 'Bathroom', '', 3),
  (900013, 'HOM-DEV00003', 'FLR-DEV00031', 'kitchen', 'Kitchen', 'Inside oven and fridge.', 0),
  (900014, 'HOM-DEV00003', 'FLR-DEV00031', 'living_room', 'Living room', '', 1),
  (900015, 'HOM-DEV00003', 'FLR-DEV00031', 'bathroom', 'Bathroom', '', 2),
  (900016, 'HOM-DEV00003', 'FLR-DEV00032', 'bedroom', 'Bedroom', '', 0),
  (900017, 'HOM-DEV00003', 'FLR-DEV00032', 'bedroom', 'Bedroom', '', 1),
  (900018, 'HOM-DEV00003', 'FLR-DEV00032', 'bathroom', 'Bathroom', '', 2),
  (900019, 'HOM-DEV00004', 'FLR-DEV00041', 'laundry', 'Laundry', '', 0),
  (900020, 'HOM-DEV00004', 'FLR-DEV00042', 'kitchen', 'Kitchen', '', 0),
  (900021, 'HOM-DEV00004', 'FLR-DEV00042', 'living_room', 'Living room', '', 1),
  (900022, 'HOM-DEV00004', 'FLR-DEV00042', 'half_bath', 'Half bath', '', 2),
  (900023, 'HOM-DEV00004', 'FLR-DEV00043', 'bedroom', 'Bedroom', '', 0),
  (900024, 'HOM-DEV00004', 'FLR-DEV00043', 'bedroom', 'Bedroom', '', 1),
  (900025, 'HOM-DEV00004', 'FLR-DEV00043', 'bedroom', 'Bedroom', 'Nursery: fragrance-free products only.', 2),
  (900026, 'HOM-DEV00004', 'FLR-DEV00043', 'bathroom', 'Bathroom', '', 3);
