# Serve Design System — "Boston Night"

The source of truth for how every Serve screen looks, moves and talks.
The reference implementation is `reference/waitlist.html`; open it in a browser before building anything new.
Tokens live in `tokens.css` (CSS variables, keyframes, component classes) and `tailwind.preset.js`.

---

## 1. The idea

Serve is **Greater Boston's home cleaning concierge**: a members-only network of the cleaning companies your neighbors already trust.
Every screen should feel like a **private club at night on the Charles**: deep navy sky, the Boston skyline, a little gold, calm motion.
It should feel exclusive and local, and it should never read like a generic SaaS page or a discount directory.

Three feelings, in priority order:
1. **Exclusive.** Members by invitation, opening neighborhood by neighborhood.
2. **Trusted and local.** Real companies, real neighborhoods, quotes on record.
3. **Effortless.** One concierge for every clean, so the user tells us once and we handle the rest.

---

## 2. Color

| Role | Token | Hex | Use |
|---|---|---|---|
| Deepest night | `--serve-night-950` | #0b1220 | Top of sky, water, footer, front skyline |
| Night | `--serve-night-900` | #111827 | Dark sections, text on gold buttons |
| Slate | `--serve-night-800` | #1f2937 | Nav, dark cards, icon tiles, primary slate |
| Low sky | `--serve-night-700` | #24304a | Sky gradient |
| Back skyline | `--serve-night-600` | #2a3550 | Rear skyline layer |
| Horizon | `--serve-dusk` | #3a3a4a | Bottom of sky gradient |
| **Gold** | `--serve-gold` | #c9a96e | Waitlist and print only. **Not used on the marketplace** (home, search, profiles, booking, portals), where the accent is white on dark and slate on light; see HOME_SPEC.md. |
| Gold ink | `--serve-gold-ink` | #8a6d3b | Gold text on cream/white |
| Cream | `--serve-cream` | #f7f4ee | Light feature sections |
| Cream line | `--serve-cream-line` | #e7e1d4 | Card borders on cream |
| Live | `--serve-live` | #4ade80 | "Now opening" status dot only |

Rules:
- Pages alternate **dark (night) and light (cream or white)** bands. The hero is always night.
- Gold makes up at most ~5% of any screen. One gold CTA per viewport.
- Body text: `#d1d5db` on dark, `#4b5563` on light. Muted: `#9ca3af` on dark, `#6b7280` on light. Every pair passes WCAG AA (4.5:1).
- Partner brand colors appear **only** inside that partner's logo card or profile header, never in Serve chrome.

---

## 3. Typography

| Role | Font | Size / weight | Notes |
|---|---|---|---|
| Hero display | Times New Roman | 62px / 800, line-height 1.02, -0.5px tracking | One accented word in *italic 400 gold* ("*concierge.*") |
| Section headline | Times New Roman | 40–48px / 800, lh 1.1 | |
| Card title | Times New Roman | 22–24px / 800 | |
| Big numerals | Times New Roman | 44px / 400 italic, gold-ink | Step numbers "01 02 03" |
| Eyebrow | Inter | 12.5px / 700, uppercase, 0.32em tracking, gold | Optional 36px hairlines either side (`.serve-eyebrow.ruled`) |
| Body | Inter | 15.5–18px / 400, lh 1.6 | |
| UI / labels | Inter | 14–16px / 500–700 | |
| Wordmark | Times New Roman | 29px / 800 + roof-line house mark | |

Serif = voice of the brand. Sans = everything functional. Never set body copy in the serif.
Mobile: hero display drops to 42px.

---

## 4. Layout

- Max content width **1120px** (`max-w-page`), 20px side gutters, sections padded 80–96px vertically.
- 3-column grids for perks and steps (`repeat(3, minmax(0,1fr))`, 22–36px gap), collapsing to 1 column under 760px.
- The hero is `min-height: 960px` on desktop: nav, a centered glass card, then 300px of clear sky above the skyline.
- Radii: 10px controls, 14px cards, 20px glass card, pills 999px.

---

## 5. Signature: the Boston Night hero

Use it on the waitlist, the marketplace home and search landing pages. **Don't** use it on dense app screens (portal, quotes, settings); those get the slate nav and a short skyline band (see §8).

Layers, back to front (z-index):
0. **Sky** `.serve-sky` gradient + ~46 twinkling stars (1.4–2.5px white dots, 3–7s twinkle, random negative delays).
0. **Horizon glow**: radial gold at 22% alpha behind the skyline.
1. **Floating partner logos**: every partner's logo in a `.serve-logo-card` drifting **left → right** across a 560px band starting 96px from the top. Seven depth lanes:

   | Lane top | Card height | Opacity | Blur | Duration |
   |---|---|---|---|---|
   | 6px | 46 | .38 | 1.2px | 120s |
   | 62px | 52 | .46 | 0.9px | 108s |
   | 128px | 62 | .62 | 0.4px | 92s |
   | 182px | 44 | .34 | 1.3px | 130s |
   | 236px | 76 | .85 | 0 | 74s |
   | 330px | 50 | .44 | 1px | 112s |
   | 412px | 66 | .70 | 0.2px | 84s |

   Logo *i* goes in lane *i mod 7*; start offset = `-(((i*0.618) + (i odd ? .5 : 0)) mod 1) × duration` so they're spread out on load. Each card also bobs ±10px over 5–9s.
   Far = small, dim, blurred, slow. Near = big, crisp, faster. Logos pass **behind** the glass card. Logo data comes from the partners table, so the sky grows as the network grows.
2. **Skyline, back layer**: the skyline path mirrored horizontally (`scaleX(-1)`), 200px tall, `#2a3550` at 85%.
2. **Skyline, front layer**: the same path, 250px tall, `#0b1220`, sitting on the water line (118px from the bottom).
3. **The Charles**: 120px water band (`#0b1220 → #111a2c`) with the skyline reflected (`scaleY(-1)`, gold at 7% opacity), 14 shimmering ripple lines, and **four sailboats**:

   | Bottom | Size | Direction | Duration | Mainsail |
   |---|---|---|---|---|
   | 70px | 30px | ← | 160s | #cbd5e1 |
   | 52px | 44px | → | 118s | #e5e7eb |
   | 34px | 58px | → | 96s | **gold** |
   | 16px | 74px | ← | 140s | #f3f4f6 |

   Higher = farther = smaller, slower and dimmer. Boats rock ±2° over ~5s.
5. **Glass card** `.serve-glass`: max-width 740px, padding 46/52px, centered.
6. **Nav**: transparent over the sky; wordmark left; "For cleaning companies" and a ghost "Member sign in" right.

Skyline path (viewBox `0 0 1200 300`, `preserveAspectRatio="none"`):
```
M0,300 V240 H36 V222 H78 V255 H108 V196 H126 V150 H162 V196 H186 V244 H214 V120 H236 V96 H262 V88 H300 V132 H322 V174 H344 V150 H372 V210 H396 V250 H430 V168 H448 V120 L458,92 L468,120 H486 V168 H500 V236 H540 V206 H612 A28,28 0 0 1 668,206 H690 V240 H720 V214 H744 V150 L754,110 L764,150 H784 V214 H800 V246 H840 V190 H878 V210 H906 V160 H944 V128 H980 V186 H1010 V232 H1046 V204 H1080 V226 H1120 V246 H1160 V236 H1200 V300 Z
```

Sailboat (viewBox `0 0 60 60`): mast `30,5 → 30,45`; mainsail `M31.5 7 L31.5 43 L53 43 Z`; jib `M28.5 13 L28.5 43 L11 43 Z`; hull `M5 45 H55 L49 53 H11 Z` (#cbd5e1); wake line `M14 56 H46` at 35%. Mirror with `scaleX(-1)` for boats sailing left.

Wordmark house mark: `M 88 150 L 88 78 L 145 30 L 202 78 L 202 118`, white stroke, round caps (viewBox `45 10 200 228`, with "Serve" and "GREATER BOSTON" set in Times beneath).

---

## 6. Components

- **Primary CTA**: `.serve-btn.serve-btn-gold`, 56px tall, night text, trailing arrow icon. Labels are invitations: "Request access", "Request your invitation", "Get my estimate".
- **Secondary on dark**: `.serve-btn-ghost`. **On light**: slate fill `.serve-btn-slate`.
- **Inputs**: `.serve-input`, white on dark, 56px, gold focus ring. Every input has a real `<label>` (visually hidden is fine). Phone numbers auto-format to `(617) 555-0123`.
- **Inline form**: `[Neighborhood or ZIP] [Mobile number] [CTA]` on one row (1.15fr / 1fr / auto); stacks under 760px.
- **Status line**: green live dot with a halo + "Now opening in {neighborhood}" · shield icon + "{N} trusted local companies in the network" (N is live from the DB).
- **Perk card**: `.serve-card-paper` on cream, a 48px slate icon tile with a gold stroke icon, a serif title and a 15.5px body.
- **Service pills**: `.serve-chip-gold` on a slate strip, under the title "Every clean, one place".
- **Steps**: 2px slate top rule, italic gold-ink serif numeral, sans title, body.
- **Success state**: gold outlined check circle, "You're on the list.", masked phone `(617) •••-0123`, then a dashed-gold "Skip the line" referral box with a copyable invite link. Content enters with `.serve-rise`.
- **Partner logo card**: `.serve-logo-card` with the partner's own background (most are white; Cambridge Clean Co teal #0ca9bb; JMA black).

Icons: 24px inline **stroke** SVGs, 1.8–2.2 stroke width, round caps and joins, gold on slate or `currentColor`. **No emoji. No filled icon sets.**

---

## 7. Motion

- Everything ambient is **slow** (74–160s crossings, 3–9s bobs and twinkles). If it draws the eye away from the form, it's too fast.
- Only `left`, `transform` and `opacity` animate. Expose one global speed multiplier.
- **Always** honor `prefers-reduced-motion`: all ambient motion stops and the scene renders still.
- UI transitions: 200ms ease-out; state changes rise in (`serve-rise`, 500ms).

---

## 8. Applying it beyond the waitlist

| Screen | Treatment |
|---|---|
| Marketplace home / search landing | Full Boston Night hero; the search form replaces the waitlist form; results on white below |
| Provider profile | Night header band (no logos drifting, single static skyline 80px), partner logo card + serif name; body on white |
| Estimate request / booking flow | Slate nav, white body, gold primary CTA, step numerals in serif |
| Client portal / dashboards | Slate nav + white workspace; gold only for the single primary action; no ambient motion |
| Business portal | Same as client portal; partner's brand color allowed in their own header |
| Emails / SMS landing pages | Night header with skyline silhouette, cream body |
| Print (flyers, door hangers) | Night or cream sheet, gold hairline frame, serif headline (already drafted on the design canvas) |

---

## 9. Voice

- Second person, warm and concise. "Your home cleaning concierge." "You're on the list."
- Exclusive without being snobby: *members, invitation, early access, opening neighborhood by neighborhood*.
- Local: name the neighborhood ("Somerville", "Union Square") whenever we know it.
- Trust is shown with specifics ("every quote kept on record", "reviewed by Serve before they're listed"), never with vague superlatives.
- **Never invent numbers.** Counts, ratings and member numbers come from the database or are left out.
- Avoid: "Uber for cleaning", "cheap", "deals", exclamation marks, emoji.

---

## 10. Don'ts

- No generic purple/blue SaaS gradients, glowing blobs or left-border accent cards.
- No gold backgrounds, gold body text, or more than one gold CTA per screen.
- No stock photos of smiling cleaners; real partner photos only.
- No placeholder ratings or fake activity in production.
- No fixed-pixel page widths: every page works from 360px to 1440px+.
