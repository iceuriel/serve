# Marketplace Home — build spec

Reference implementation: `reference/home.html` (open it in a browser and use it as the visual source of truth).
This page **supersedes DESIGN.md wherever they disagree**. In particular: **no gold anywhere on the marketplace.** Accents are white on dark and slate on light.

The goal is **one continuous flow**: headline → search → results. The search panel sits directly under the headline and the provider cards start right under the hero, so there is almost no scroll between typing an area and seeing companies.

---

## 1. Page structure (top to bottom)

1. **Hero** (night sky, ~500px tall on desktop)
   - Nav: house-mark + "Serve" wordmark (left); "Find a Provider" (anchors to results) + ghost "Instant Booking" button (right).
   - Eyebrow `GREATER BOSTON`: 12px Inter 700, 0.32em tracking, `#e5e7eb`, 32px white hairlines either side at 60% opacity. Sits directly under the nav (no extra top padding).
   - H1 **"Boston's most trusted home cleaners."**: Times New Roman 800, 54px, line-height 1.12, `#f9fafb`, **one line, no italics**, `white-space: nowrap` on desktop (wraps at 34px under 760px). 6px below the eyebrow.
   - **Search panel** 20px below the H1 (see §2).
   - Ambient scene behind: stars, partner logos drifting, two-layer skyline, river with sailboats (see §4).
2. **Results** section, directly after the hero
   - Background `#fcfcfc` (near-white, **not cream**), top corners rounded 24px, 1px top border `rgba(255,255,255,.6)`, page background behind the corners `#111a2c` so the river color shows.
   - Padding 24px top. Header row: H2 (dynamic, §3) + "Show all of Greater Boston" link when an area is set (left); live count with a green dot (right).
   - Card grid 18px below the header: `repeat(auto-fill, minmax(330px, 1fr))`, 20px gap, max content width 1200px.
   - Empty state when nothing matches: dashed card, "Not in {Area} yet." + Instant Booking and Join the waitlist buttons. **Never a dead end.**
3. **Instant Booking** band (`#111827`): white eyebrow, serif H2 "No time to compare?", white button "Get an Instant Price".
4. **Footer** (`#0b1220`).

There is **no subheading sentence** under the H1.

---

## 2. Search panel

- Container: `width: fit-content; max-width: 100%`, centered, padding 12px 14px, radius 16px, background `rgba(11,18,32,.9)` with 14px backdrop blur, 1px border `rgba(255,255,255,.2)`. Its width is set by the Service row, so **the right edge of Find Providers lines up with the right edge of the Airbnb chip.**
- Two rows with a shared 76px label column (`AREA`, `SERVICE`: 12px Inter 700 uppercase, 0.14em tracking, `#d1d5db`):

**Row 1: Area**
- A combobox: white 52px input, radius 10px, location-pin icon at left, placeholder **"Neighborhood or ZIP"**, chevron button at right that toggles the dropdown.
- Users can **type** a neighborhood/ZIP **or pick** from a dropdown of popular areas. The dropdown opens on focus, on typing and on chevron click, and closes on blur, Escape or pick.
- Dropdown: white, radius 12px, heading "POPULAR AREAS", first option "All of Greater Boston", then Somerville, Cambridge, Boston, Brookline, Newton, Medford, Arlington, Quincy, Chelsea, Everett, Waltham, Melrose. **Each option shows how many companies serve it** ("3 companies"), computed live. The list filters as the user types.
- To the right: white **Find Providers** button with an arrow (52px, dark text). It closes the dropdown and scrolls to the results.

**Row 2: Service**
- Pill chips in this order: **All** (default) · Recurring · Deep clean · Move in / out · Post-construction · Airbnb.
- Unselected: transparent background, 1px `rgba(255,255,255,.24)` border, `#e5e7eb` text. Selected: white fill, `#111827` text, 600 weight. Use `aria-pressed`.

Mobile (<760px): labels go above their controls, the button wraps under the input, and the panel fills the width.

---

## 3. Filtering behaviour (the "flow")

Area and Service filter **everything at once, live, with no submit needed**:
- **Results H2**: "{n} trusted companies across Greater Boston" → "{n} trusted companies near {Area}" → "… for {service}". Singular "company" when n = 1.
- **Live count** (right of the header): "14 trusted companies, live now" when unfiltered → "{n} of {total} companies match".
- **Card grid** shows only the matches.
- **Sky logos**: the matching companies' logos turn fully opaque, unblurred, with a white ring (`0 0 0 3px rgba(255,255,255,.45)`). Non-matching logos fade to 15% of their lane opacity. Update styles only; **don't restart the drift animations.**

Area matching:
1. A 5-digit ZIP maps to a place via a ZIP table (other `021xx` codes map to "boston").
2. Direct match: companies whose service area contains the place name.
3. If there's no direct match, fall back to region (core / north / west / south).
4. If there's still none, show the empty state.

In production, move this to the database: `partners.service_areas` (array of neighborhoods + ZIPs) and a `neighborhoods` table with a region. The dropdown counts come from the same query.

---

## 4. Ambient scene (hero background)

Stack, back to front:
- **Sky gradient** `#0b1220 → #141d2e (50%) → #24304a (82%) → #2e3448`, about 40 twinkling stars in the top 70%, and a soft **white** horizon glow (`rgba(255,255,255,.08)`).
- **Drifting partner logos** in a 240px band starting 70px from the top, moving **left → right**. The band has a horizontal mask (`#000 0–12%, transparent 22–78%, #000 88–100%`) so logos show on the sides and fade out behind the headline and search. Seven lanes, 38–60px tall cards, 78–128s per crossing, far = smaller, dimmer, blurred. The cards use each partner's own background color.
- **Skyline**: back layer mirrored, 150px, `#2a3550` at 85%; front layer 180px, `#0b1220`. Both sit 88px above the bottom. Use the skyline path in DESIGN.md §5.
- **River**: 90px, `#0b1220 → #111a2c`, skyline reflection in **white** at 5%, about 10 shimmer lines, and **four sailboats** (24/34/46/56px; two going each way; 96–160s; all sails white/gray, **none gold**).
- `prefers-reduced-motion`: all of it stops.

---

## 5. Provider card

- White, 1px `#e5e7eb` border, radius 14px, small shadow; hover lifts 3px with a deeper shadow.
- **Logo plate**: 108px tall, the partner's own background color, a 4px top border in the partner's brand color, logo `object-fit: contain`, 1px `#f0f0f0` bottom border. The whole plate links to the profile.
- Body (16/20px padding, 8px gap):
  - Name: Times New Roman 800 22px.
  - Areas: 13.5px muted.
  - Rating line: **★ rating** · "{n} {source} reviews" · years.
  - Tagline: 15px `#4b5563`.
  - Tag pills: `#f3f4f6` background, `#e5e7eb` border.
  - Footer row (top border `#f0f0f0`): price label and price on the left, green ✓ note on the right.
  - Buttons: **View Profile** (white outline) + **Get Estimate** (slate `#1f2937`).
- No "Draft / Not public" badges on live cards. If a listing is unpublished, don't render it.

---

## 6. Colors used on this page

| Use | Value |
|---|---|
| Night / hero | #0b1220, #141d2e, #24304a, #2e3448 |
| River / page backing | #111a2c |
| Slate buttons, dark text | #1f2937, #111827 |
| Results background | **#fcfcfc** |
| Card border / tag | #e5e7eb / #f3f4f6 |
| Primary button on dark | **#ffffff** with #111827 text |
| Text on dark | #f9fafb, #e5e7eb, #d1d5db |
| Status | green #16a34a (live dot), #166534 (✓ notes) |

**No #c9a96e (gold) anywhere on the marketplace.**

---

## 7. Acceptance checklist

- [ ] H1 is on one line at 1280px+, with no italics.
- [ ] Search panel is directly under the H1, and the first row of cards is visible without scrolling on a 1440×900 screen.
- [ ] Find Providers' right edge aligns with the Airbnb chip's right edge.
- [ ] Area: typing works, the dropdown works, each option shows a company count, and ZIPs resolve.
- [ ] Changing Area or Service updates the H2, live count, grid and sky logos together.
- [ ] Empty state appears for uncovered areas with Instant Booking + waitlist actions.
- [ ] No gold anywhere; results background is #fcfcfc.
- [ ] Works at 360px; reduced motion stops all animation; every control is keyboard reachable with visible focus.
- [ ] Partner data, counts and ratings come from the database, never hard-coded in production.
