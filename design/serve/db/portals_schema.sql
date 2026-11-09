-- =====================================================================
-- Serve portals: schema + row-level security (Supabase / Postgres)
-- DRAFT: review, then apply as a migration (supabase/migrations/<ts>_portals.sql).
-- Safe to run on a project that already has a `partners` table: it only
-- adds missing columns there.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------- Partners (cleaning companies) ----------------------------
create table if not exists public.partners (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  name text not null,
  created_at timestamptz not null default now()
);
alter table public.partners add column if not exists phone text;
alter table public.partners add column if not exists tagline text not null default '';
alter table public.partners add column if not exists about text not null default '';
alter table public.partners add column if not exists service_areas text[] not null default '{}';
alter table public.partners add column if not exists services text[] not null default '{}';
alter table public.partners add column if not exists price_label text not null default 'Pricing';
alter table public.partners add column if not exists price text not null default '';
alter table public.partners add column if not exists highlight text not null default '';
alter table public.partners add column if not exists logo_url text;
alter table public.partners add column if not exists logo_bg text not null default '#ffffff';
alter table public.partners add column if not exists brand_color text not null default '#1f2937';
alter table public.partners add column if not exists rating numeric(2,1);          -- set by Serve only
alter table public.partners add column if not exists review_count int;             -- set by Serve only
alter table public.partners add column if not exists review_source text default 'Google';
alter table public.partners add column if not exists years_label text;
alter table public.partners add column if not exists published boolean not null default false;

-- Who can sign in to a partner's business portal
create table if not exists public.partner_members (
  partner_id uuid not null references public.partners(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'owner' check (role in ('owner','staff')),
  primary key (partner_id, user_id)
);

create table if not exists public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);

-- ---------- Clients + My Home ----------------------------------------
create table if not exists public.clients (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  phone text,
  email text,
  neighborhood text,
  street_address text,           -- shared with a company ONLY for walkthrough requests
  unit text,
  contact_pref text not null default 'text' check (contact_pref in ('text','call','either')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.homes (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null unique references public.clients(id) on delete cascade,
  whole_notes text not null default '',
  updated_at timestamptz not null default now()
);

create table if not exists public.home_floors (
  id uuid primary key default gen_random_uuid(),
  home_id uuid not null references public.homes(id) on delete cascade,
  name text not null,
  position int not null default 0
);

create table if not exists public.home_rooms (
  id uuid primary key default gen_random_uuid(),
  floor_id uuid not null references public.home_floors(id) on delete cascade,
  type text not null check (type in ('bedroom','bathroom','half_bath','kitchen','living_room',
                                     'dining_room','office','laundry','entryway','other')),
  name text not null,
  notes text not null default '',
  position int not null default 0
);

-- ---------- Requests + quotes ----------------------------------------
create table if not exists public.quote_requests (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  partner_id uuid not null references public.partners(id) on delete cascade,
  method text not null check (method in ('phone','walkthrough')),
  time_window text not null check (time_window in ('earlier','later')),
  status text not null default 'new' check (status in ('new','contacted','quoted','booked','closed')),
  created_at timestamptz not null default now(),
  contacted_at timestamptz,
  quoted_at timestamptz
);
create index if not exists quote_requests_partner_idx on public.quote_requests (partner_id, created_at desc);
create index if not exists quote_requests_client_idx on public.quote_requests (client_id, created_at desc);

-- Append-only: "every quote kept on record". Editing a quote = inserting a new row.
create table if not exists public.quotes (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.quote_requests(id) on delete cascade,
  partner_id uuid not null references public.partners(id),
  amount_cents int not null check (amount_cents > 0),
  frequency text not null check (frequency in ('one_time','one_time_deep','move_in_out','weekly','biweekly','monthly')),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index if not exists quotes_request_idx on public.quotes (request_id, created_at desc);

-- ---------- Business profile edits (reviewed by Serve) ----------------
create table if not exists public.partner_profile_edits (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null references public.partners(id) on delete cascade,
  submitted_by uuid not null references auth.users(id),
  changes jsonb not null,        -- only editable keys: name, phone, tagline, about, service_areas, services, price_label, price, highlight
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  review_note text,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users(id)
);

-- ---------- Helpers ---------------------------------------------------
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from admins where user_id = auth.uid());
$$;

create or replace function public.is_partner_member(p uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from partner_members where partner_id = p and user_id = auth.uid());
$$;

-- A company may read a client's home only after that client sent it a request
create or replace function public.partner_can_see_client(c uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from quote_requests qr
    join partner_members pm on pm.partner_id = qr.partner_id
    where qr.client_id = c and pm.user_id = auth.uid()
  );
$$;

-- ---------- Row-level security ---------------------------------------
alter table public.partners              enable row level security;
alter table public.partner_members       enable row level security;
alter table public.admins                enable row level security;
alter table public.clients               enable row level security;
alter table public.homes                 enable row level security;
alter table public.home_floors           enable row level security;
alter table public.home_rooms            enable row level security;
alter table public.quote_requests        enable row level security;
alter table public.quotes                enable row level security;
alter table public.partner_profile_edits enable row level security;

-- partners: public sees published; members see their own; admins manage. No direct edits by members.
create policy partners_public_read on public.partners for select using (published or public.is_partner_member(id) or public.is_admin());
create policy partners_admin_all   on public.partners for all using (public.is_admin()) with check (public.is_admin());

create policy members_self_read on public.partner_members for select using (user_id = auth.uid() or public.is_admin());
create policy members_admin_all on public.partner_members for all using (public.is_admin()) with check (public.is_admin());
create policy admins_self_read  on public.admins for select using (user_id = auth.uid());

-- clients: own row only. Companies never read this table directly (see get_partner_requests()).
create policy clients_own on public.clients for all using (id = auth.uid()) with check (id = auth.uid());

-- My Home: owner has full access; a company with a request from this client can read it.
create policy homes_own on public.homes for all using (client_id = auth.uid()) with check (client_id = auth.uid());
create policy homes_partner_read on public.homes for select using (public.partner_can_see_client(client_id));

create policy floors_own on public.home_floors for all
  using (exists (select 1 from homes h where h.id = home_id and h.client_id = auth.uid()))
  with check (exists (select 1 from homes h where h.id = home_id and h.client_id = auth.uid()));
create policy floors_partner_read on public.home_floors for select
  using (exists (select 1 from homes h where h.id = home_id and public.partner_can_see_client(h.client_id)));

create policy rooms_own on public.home_rooms for all
  using (exists (select 1 from home_floors f join homes h on h.id = f.home_id where f.id = floor_id and h.client_id = auth.uid()))
  with check (exists (select 1 from home_floors f join homes h on h.id = f.home_id where f.id = floor_id and h.client_id = auth.uid()));
create policy rooms_partner_read on public.home_rooms for select
  using (exists (select 1 from home_floors f join homes h on h.id = f.home_id where f.id = floor_id and public.partner_can_see_client(h.client_id)));

-- requests: clients create/read their own; companies read theirs; status changes only via RPCs below.
create policy requests_client_read   on public.quote_requests for select using (client_id = auth.uid());
create policy requests_client_insert on public.quote_requests for insert with check (client_id = auth.uid() and status = 'new');
create policy requests_partner_read  on public.quote_requests for select using (public.is_partner_member(partner_id) or public.is_admin());

-- quotes: read-only for both sides; written only via send_quote().
create policy quotes_client_read  on public.quotes for select using (exists (select 1 from quote_requests r where r.id = request_id and r.client_id = auth.uid()));
create policy quotes_partner_read on public.quotes for select using (public.is_partner_member(partner_id) or public.is_admin());

-- profile edits: members submit + read their own; admins review.
create policy edits_member_insert on public.partner_profile_edits for insert with check (public.is_partner_member(partner_id) and submitted_by = auth.uid() and status = 'pending');
create policy edits_member_read   on public.partner_profile_edits for select using (public.is_partner_member(partner_id) or public.is_admin());
create policy edits_admin_update  on public.partner_profile_edits for update using (public.is_admin()) with check (public.is_admin());

-- ---------- RPCs ------------------------------------------------------
-- Business inbox: requests + client contact, with street address ONLY for walkthroughs.
create or replace function public.get_partner_requests(p_partner uuid)
returns table (
  id uuid, status text, method text, time_window text, created_at timestamptz,
  client_id uuid, client_name text, neighborhood text, phone text, contact_pref text,
  street_address text, unit text, latest_amount_cents int, latest_frequency text, latest_quoted_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select r.id, r.status, r.method, r.time_window, r.created_at,
         c.id,
         split_part(c.full_name, ' ', 1) || coalesce(' ' || left(nullif(split_part(c.full_name, ' ', 2), ''), 1) || '.', ''),
         c.neighborhood, c.phone, c.contact_pref,
         case when r.method = 'walkthrough' then c.street_address end,
         case when r.method = 'walkthrough' then c.unit end,
         q.amount_cents, q.frequency, q.created_at
  from quote_requests r
  join clients c on c.id = r.client_id
  left join lateral (select amount_cents, frequency, created_at from quotes where request_id = r.id order by created_at desc limit 1) q on true
  where r.partner_id = p_partner and public.is_partner_member(p_partner)
  order by r.created_at desc;
$$;

create or replace function public.mark_contacted(p_request uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  update quote_requests set status = 'contacted', contacted_at = now()
  where id = p_request and status = 'new' and public.is_partner_member(partner_id);
  if not found then raise exception 'not allowed or not new'; end if;
end $$;

create or replace function public.send_quote(p_request uuid, p_amount_cents int, p_frequency text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_partner uuid; v_id uuid;
begin
  select partner_id into v_partner from quote_requests where id = p_request;
  if v_partner is null or not public.is_partner_member(v_partner) then raise exception 'not allowed'; end if;
  insert into quotes (request_id, partner_id, amount_cents, frequency, created_by)
  values (p_request, v_partner, p_amount_cents, p_frequency, auth.uid()) returning id into v_id;
  update quote_requests set status = 'quoted', quoted_at = now(),
         contacted_at = coalesce(contacted_at, now())
  where id = p_request;
  return v_id;
end $$;

create or replace function public.approve_profile_edit(p_edit uuid) returns void
language plpgsql security definer set search_path = public as $$
declare e record;
begin
  if not public.is_admin() then raise exception 'admins only'; end if;
  select * into e from partner_profile_edits where id = p_edit and status = 'pending';
  if not found then raise exception 'no pending edit'; end if;
  update partners set
    name          = coalesce(e.changes->>'name', name),
    phone         = coalesce(e.changes->>'phone', phone),
    tagline       = coalesce(left(e.changes->>'tagline', 120), tagline),
    about         = coalesce(e.changes->>'about', about),
    service_areas = coalesce((select array_agg(x) from jsonb_array_elements_text(e.changes->'service_areas') x), service_areas),
    services      = coalesce((select array_agg(x) from jsonb_array_elements_text(e.changes->'services') x), services),
    price_label   = coalesce(e.changes->>'price_label', price_label),
    price         = coalesce(e.changes->>'price', price),
    highlight     = coalesce(e.changes->>'highlight', highlight)
  where id = e.partner_id;
  update partner_profile_edits set status = 'approved', reviewed_at = now(), reviewed_by = auth.uid() where id = p_edit;
end $$;

grant execute on function public.get_partner_requests(uuid), public.mark_contacted(uuid),
  public.send_quote(uuid, int, text), public.approve_profile_edit(uuid) to authenticated;
