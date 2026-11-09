# Client + Business Portals: build spec

Design source: `reference/portals/ClientPortal.dc.html` and `reference/portals/ProviderPortal.dc.html`.
These are canvas design files. The markup and inline styles are the visual spec; `{{x}}` are data holes, `<sc-for>` is a loop, `<sc-if>` is a conditional, and the logic lives in `renderVals()` at the bottom. **Port them into our components; they don't run standalone.**
Database: `db/portals_schema.sql` (tables, row-level security, RPCs).
Style: DESIGN.md + HOME_SPEC.md (marketplace rules: slate header with a faint skyline, `#fcfcfc` workspace, serif headings, **no gold, no ambient motion**).

Keep it simple: every number and list on these screens comes from data we actually store (requests, quotes, My Home, profiles). **No invented metrics, charts or revenue figures.**

---

## 1. Where they live

| Route | Who | Content |
|---|---|---|
| `/account` → redirects to `/account/home` | Signed-in client | Client portal shell (header + tabs) |
| `/account/home` | Client | **My Home** (default tab) |
| `/account/requests` | Client | Quote requests |
| `/account/profile` | Client | Profile |
| `/business` → `/business/requests` | Partner member | Business portal shell |
| `/business/requests` | Partner member | Requests inbox (+ `?status=new|contacted|quoted`) |
| `/business/profile` | Partner member | Business profile editor with live preview |
| `/admin/edits` | Admin | Minimal list of pending profile edits with Approve / Reject (approve calls `approve_profile_edit`) |
| `/sign-in` | Everyone | Phone code for clients; email link for businesses |

Tabs are real routes (shareable, back-button friendly), rendered inside a shared portal layout.

**Auth (Supabase Auth)**
- **Clients:** phone + SMS one-time code. We already collect a mobile number on the estimate request. *Needs an SMS provider configured in Supabase (Twilio / MessageBird / Vonage); until then, fall back to email magic link.*
- **Businesses:** email magic link. Access = a row in `partner_members` (added by a Serve admin).
- After sign-in: if the user is in `partner_members`, go to `/business`; otherwise go to `/account`. On first client sign-in, create the `clients` row, a `homes` row and one floor named "First floor".
- Middleware guards `/account/*` (signed in), `/business/*` (partner member) and `/admin/*` (admin).

**Hooking into what exists**
- The **estimate request** flow (Get Estimate on a provider card/profile) now requires a client session (inline phone-code sign-in), then inserts a `quote_requests` row (`method`, `time_window`) and sends the client to `/account/requests`.
- Header buttons: client "Find a company" → marketplace home; business "View public profile" → `/providers/[slug]`.

---

## 2. Shared portal shell

- Draft banner: **remove in production.**
- Header: gradient `#0b1220 → #1a2338`, static skyline silhouette along the bottom (70px, black at 35%), house mark + "Serve". The business side adds a "FOR BUSINESSES" outline pill and the company logo on a white chip; the client side shows avatar initials.
- Eyebrow ("YOUR ACCOUNT" / "BUSINESS PORTAL"), then a serif H1 ("Welcome back, {first name}." / company name), then tabs.
- Tabs: white text with a 3px white underline when active, `#cbd5e1` when inactive, 46px tall, `aria-current="page"`. The business Requests tab shows "(n new)".
- Workspace: max width 1200px, 24px gutters, `#fcfcfc`. Cards are white with a 1px `#e5e7eb` border and 14px radius. Section headings are Times New Roman 800, 28px.
- Buttons: primary slate `#1f2937`; secondary white outline. Status pills: **New** `#eff6ff/#1e40af`, **Contacted** `#fef3c7/#92400e`, **Quoted** `#dcfce7/#166534`.

---

## 3. Client portal

### My Home (`/account/home`, default)
- Header row: "My Home" + one-line explainer; summary chips on the right: `{levels} · {beds} · {baths} · {rooms} · {notes}`. Half baths count 0.5, and "notes" counts rooms with notes. **The chips update live.**
- **Notes for every visit**: one textarea (`homes.whole_notes`).
- One section per floor (`home_floors`, ordered by `position`):
  - Header: layers icon, the floor name as an inline-editable serif input, room count, and "Remove level" (hidden when only one level is left; confirm if the floor has rooms).
  - Room grid (`minmax(280px,1fr)`). Each room card has a colored type tag, an inline-editable name, a remove (×) button and a notes textarea. Cards with notes get a 3px slate left border.
  - The last tile is a dashed "Add a room" card: a type `<select>` + Add button.
- Under the floors: "+ Add a floor" (named "Second floor", "Third floor", … by count) and "+ Add a basement" (inserted as the first floor), plus "Changes save automatically."
- Room types: Bedroom, Bathroom, Half bath, Kitchen, Living room, Dining room, Office, Laundry, Entryway, Other (DB values in `home_rooms.type`). Tag colors are in the design file (`TONE`).
- **Autosave:** text edits save debounced (~600ms) on change and on blur; structural changes (add/remove) save immediately, optimistically, with a quiet "Saved" / "Couldn't save, retry" status. Keep `position` contiguous.

### Quote requests (`/account/requests`)
- Three tiles: **Open requests** (status new or contacted), **Quotes received** (status quoted), and a **My Home** tile with the summary that links to the tab, captioned "Shared with every company you contact".
- "Quote requests" heading + "Request another estimate" button (→ marketplace home).
- One card per request, newest first:
  - Logo plate (partner bg + brand-color top border), company name, "Sent {date} · {Walkthrough | Over the phone}", status pill.
  - 3-step progress: **Request sent** (`created_at`) → **Company reached out** (`contacted_at`) → **Quote received** (`quoted_at`).
  - Right side: once quoted, a green box "Their quote / ${amount} / visit · {frequency}"; otherwise the preferred time window.
  - Actions: "Book at this price" (quoted only; for now it opens a confirm step that texts/calls the company, since booking is phase 2), "Call {company}", "View profile".

### Profile (`/account/profile`)
- Fields: Full name, Mobile number, Email, Neighborhood, Street address (walkthroughs only), Unit. Contact preference chips: Text / Call / Either.
- Explainer: companies see name, phone and neighborhood; the street address is shared only for walkthroughs (enforced in `get_partner_requests`).
- Save button with a "Saved" confirmation.

---

## 4. Business portal

### Requests (`/business/requests`)
- Four tiles that **also act as filters**: All requests · New · Contacted · Quoted (counts from `get_partner_requests`). The active tile has a 2px slate border.
- Request card, newest first:
  - Avatar initials, client name as **first name + last initial** (from the RPC), "{neighborhood} · received {time}", status pill. New requests get a 4px blue left border.
  - Grid: Estimate · Preferred time · "Phone · prefers {text|call|either}" · Address (only for walkthroughs, otherwise "Shared for walkthroughs only").
  - **"Their home" bar**: `{levels} · {beds} · {baths} · {rooms} · {notes}` + "View rooms & notes" toggle. Expanded, it shows the every-visit note and then each floor with its room tiles; rooms with notes get a slate left border and show the note. Data comes from homes/floors/rooms, which RLS lets the partner read only after the client has sent them a request.
  - Actions by status:
    - **New** → "Call {first}" + **Mark as contacted** (`mark_contacted`).
    - **Contacted** → quote form: amount ($, digits only) + "For" select (One-time clean, One-time deep clean, Move in / out, Weekly, Biweekly, Monthly) + **Send quote** (`send_quote`), with validation "Enter a dollar amount." and the line "Serve keeps every quote on record for you and the client."
    - **Quoted** → green box "Quote sent {date} / ${amount} / visit · {frequency}" + **Edit quote** (re-opens the form; sending inserts a *new* quote row, so history is kept) + "Waiting for {first} to book."
- Empty filter: dashed "No requests in this stage."

### Business profile (`/business/profile`)
- Two columns (form `flex 999 1 560px`, preview `flex 1 1 340px`; they stack on mobile).
- Form: logo plate + "Replace logo" (upload to Supabase Storage, saved as part of the edit). Company name, Business phone, Tagline (120-character limit with a counter), About, **Service areas** (removable chips + "Add a neighborhood" input), **Services** (toggle chips: Recurring, Deep clean, Move in / out, Post-construction, Airbnb, Organizing, Commercial), Pricing label (select: Pricing, Starts at, Current offer, New clients, Recurring plans), Price or offer, Highlight.
- **Live preview** is the exact marketplace `ProviderCard` component, fed by the form state, with the caption "Ratings and review counts come from your verified listings and can't be edited here."
- Status pill: "Unsaved changes" (amber) → "Sent to Serve for review" (green) after **Submit changes**, which inserts a `partner_profile_edits` row with only the changed keys. **Discard** resets the form. If an edit is pending, show "Pending review since {date}".
- **Partners never write `partners` directly.** Admin approval applies the edit (`approve_profile_edit`).

---

## 5. Notifications (phase 2; wire the hooks now)
- New request → text the partner (via the existing 10DLC/OpenPhone number).
- Quote sent → text the client "{Company} sent your quote: $X. See it: /account/requests".
- Put these in one `notify()` server function that's a no-op until SMS is configured.

---

## 6. Build order (do these as separate PRs)

1. **DB**: apply `db/portals_schema.sql` as a migration; generate types; seed script with 2 partners, 1 partner member, 1 client with a 2-floor home, and 4 requests across statuses (matching the design's sample data).
2. **Auth + shells**: sign-in, role redirect, guarded layouts, shared header and tabs.
3. **My Home**: CRUD + autosave + summary chips.
4. **Requests**: estimate-request insert from the marketplace; client requests page; business inbox with tiles/filters, home expansion, mark contacted, send/edit quote.
5. **Profiles**: client profile; business profile editor + live preview + edit submission; `/admin/edits`.
6. **Polish**: empty, loading and error states; mobile pass; accessibility pass; remove the draft banners.

---

## 7. Acceptance checklist

- [ ] Clients land on `/account/home`; businesses on `/business/requests`; wrong-role URLs redirect.
- [ ] My Home: add/rename/remove floors and rooms, add a basement on top, edit notes; reload keeps everything; the summary chips are correct (half bath = 0.5).
- [ ] A partner can read a client's home **only** after that client sent them a request (RLS test with two partners).
- [ ] Street address is visible to a partner only for walkthrough requests.
- [ ] Mark contacted → Send quote moves the status, the tiles update, and the client sees the quote and the 3-step progress.
- [ ] Editing a quote creates a new `quotes` row; the old one remains.
- [ ] Business profile edits create a pending edit; nothing public changes until an admin approves; the preview matches the marketplace card exactly.
- [ ] Ratings and review counts aren't editable by partners.
- [ ] No gold; no animation in the portals; works at 360px; keyboard reachable with visible focus; labels on every input.
- [ ] No hard-coded sample data in production paths (seed only).
