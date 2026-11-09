# Serve design kit — handoff to Claude Code

## Install (2 minutes)

1. Copy this folder into your marketplace repo as `design/serve/`.
2. Drop the partner logo files into `design/serve/logos/` (names in `logos/README.md`).
3. Paste the block below into the repo's `CLAUDE.md` (create it at the repo root if it doesn't exist).
4. Open `design/serve/reference/waitlist.html` in a browser to confirm it renders.

## Paste into CLAUDE.md

```markdown
## Design system (required for all UI work)

Serve uses the "Boston Night" design system in `design/serve/`.
Before building or changing any UI:
1. Read `design/serve/DESIGN.md` in full.
2. Use the tokens from `design/serve/tokens.css` (import it once at the app root) and `design/serve/tailwind.preset.js`. Never hard-code a hex value that exists as a token.
3. Match the reference implementation `design/serve/reference/waitlist.html` for look, motion and voice.
   It is framework-free on purpose: port it into our components; don't paste raw HTML.

The client and business portals follow `design/serve/PORTALS_SPEC.md` and `design/serve/db/portals_schema.sql`.
The marketplace home follows `design/serve/HOME_SPEC.md` exactly (reference: `design/serve/reference/home.html`).
HOME_SPEC.md wins wherever it disagrees with DESIGN.md: the marketplace uses white accents and no gold.

Rules that matter most:
- Hero/landing screens use the Boston Night hero (skyline, the Charles with sailboats, partner logos drifting left to right).
- On the marketplace home the search panel (Area combobox + Service chips) sits directly under the one-line H1, and results start right below the hero; Area and Service filter the heading, grid and sky logos together.
- App screens (portals, booking, settings) use the slate nav + white workspace; no ambient motion there.
- Gold (#c9a96e) appears only on the waitlist and print pieces, never on marketplace screens.
- Headlines in Times New Roman (serif); everything functional in Inter.
- Honor prefers-reduced-motion. Every page works from 360px to 1440px.
- Never invent counts, ratings or reviews: data comes from the database or is omitted.
- Partner logos and counts come from the partners table, not hard-coded lists.

When asked to build a new screen, first state which DESIGN.md §8 treatment applies.
```

## First prompts to give Claude Code

- "Read design/serve/DESIGN.md and set up the tokens and Tailwind preset in this app. Then build a reusable `<BostonNightHero>` component from reference/waitlist.html, with props for the form slot, the partner logos (from the DB), and a motion speed."
- "Build the /waitlist page using `<BostonNightHero>`, wired to a `waitlist` table (hood, phone, consent_at, invite_code, referred_by)."
- "Restyle the marketplace home and provider profile to DESIGN.md §8."

## Files

| File | What it is |
|---|---|
| `DESIGN.md` | The system: color, type, layout, hero layers, components, motion, voice, don'ts |
| `tokens.css` | CSS variables, keyframes, component classes (`.serve-glass`, `.serve-btn-gold`, ...) |
| `tailwind.preset.js` | The same tokens for Tailwind |
| `HOME_SPEC.md` | Exact build spec + acceptance checklist for the marketplace home |
| `PORTALS_SPEC.md` | Client + business portals: routes, auth, screens, build order, checklist |
| `db/portals_schema.sql` | Supabase tables, row-level security and RPCs for the portals |
| `reference/portals/*.dc.html` | Portal design source (template markup + logic; port, don't run) |
| `reference/home.html` | Working marketplace home (search flows into providers) |
| `reference/waitlist.html` | Working waitlist page (vanilla HTML/JS) |
| `logos/` | Partner logo files go here |

The live design canvas (all marketplace screens, partner profiles and print) stays the place to explore new ideas; this folder is what ships.
