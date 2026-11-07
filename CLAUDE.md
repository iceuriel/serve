# CLAUDE.md — Serve Website Development Guide

## Shared continuity — Codex and Claude Code (2026-09-09)

Both agents cover the full Serve remit. The founder switches between them for
usage availability; there is no permanent split of responsibilities. Continue
the latest authorized work from the shared record rather than starting over.

At the start of a session, and again when resuming after the other agent worked:
1. Read the newest entry in `docs/HANDOFF.md`, then `docs/SCHEMA.md` for the
   current system and data contracts.
2. Read `../.agent-memory/MEMORY.md` relative to this repository root. It is
   the shared PRIVATE memory outside the website repo: business direction,
   durable decisions, working preferences, and pointers to older private notes.
   If it is unavailable in another checkout, report that gap; do not invent
   context or copy private strategy into tracked files.
3. Inspect the current branch, recent commits, and working-tree diff. Existing
   changes may belong to the founder or the other agent. Preserve them and
   re-read a file before editing if it may have changed since inspection.
4. Continue the recorded task within the user's authorization. Ask only when
   an unresolved business decision or conflicting concurrent work requires it.

During and at the end of meaningful work:
- Keep a short current-work entry near the top of HANDOFF: agent, objective,
  affected files, completed work, remaining work, blockers, and the next action.
  Checkpoint before a long operation or a switch, not only at final completion.
- Record what was actually checked and its result. Distinguish local edits,
  commits, pushes, Apps Script deployments, sheet changes, and production
  verification; never equate one with another or claim an unrun check passed.
- Update SCHEMA alongside any column or ownership change. Update shared private
  memory for durable business decisions and preferences; do not store secrets,
  customer data, access codes, or signed links in either handoff or memory.
- Keep this continuity section identical in AGENTS.md and CLAUDE.md. Apply any
  other shared project-rule change to both files in the same pass.
- Agent-specific memories are indexes or supplements, not competing system
  histories. Put facts the other agent needs in the shared records. Older
  notes are historical when superseded; user instructions and verified current
  evidence take precedence, and unresolved contradictions must be called out.
- If both agents are active, record who is touching which files. Do not overwrite
  another agent's active edits. A note is coordination, not a file lock.
- Give a short plan, complete the authorized work, then summarize the outcome.
  Routine engineering decisions are yours; new prices, margins, payout terms,
  service coverage, and customer promises remain the founder's decisions.

These files provide continuity through saved context. They do not synchronize
live conversations or prove the other agent has already read an update.

## Design system — "Boston Night" (2026-11-07, required for all UI work)

Serve's design system lives in `design/serve/` (the founder's design kit).
Before building or changing any UI:
1. Read `design/serve/DESIGN.md` in full.
2. Use the tokens in `design/serve/tokens.css`. The build serves it as
   `/serve-tokens.css`; a Worker page loads it with `shell({ night: true })`.
   Never hard-code a hex value that exists as a token. This site has no
   Tailwind: `tailwind.preset.js` is kept as the kit shipped it, for reference.
3. Match the reference pages for look, motion and voice: `reference/home.html`
   (the marketplace home, built to `design/serve/HOME_SPEC.md`, which wins
   wherever it disagrees with DESIGN.md) and `reference/waitlist.html`. They
   are framework-free on purpose: port them, don't paste them.

The components are already ported, in `src/marketplace.js`:
`renderBostonNightHero()` (variants "home" and "waitlist"), `renderAreaCombobox()`,
`renderServiceChips()`, `renderProviderCard()` and `renderProviderGrid()`, with the
live filtering in `marketplace-client.js`. Use them; don't build second ones.

Rules that matter most:
- Hero/landing screens use the Boston Night hero. App screens (portals,
  booking, settings) use the slate nav + white workspace, with no ambient motion.
- No gold (#c9a96e) on any marketplace screen (home, search, profiles,
  booking, portals): accents are white on dark and slate on light. Gold is for
  the waitlist and print only.
- Headlines in Times New Roman; everything functional in Inter.
- Honor prefers-reduced-motion. Every page works from 360px to 1440px.
- Never invent counts, ratings or reviews: data comes from D1 or is omitted.
- Partner logos and counts come from the D1 `providers` table (`logo_path`,
  `logo_bg`) through `publicProvider()`, never a hard-coded list. Publicly,
  only listed companies (listed = 1 AND status = 'approved'). Area matching
  uses `providers.service_areas` and the `neighborhoods` / `neighborhood_zips`
  tables (migration 0002), never a list in the page script.

When asked to build a new screen, first state which DESIGN.md §8 treatment applies.

## Project Overview
Serve is a startup home cleaning business serving the Greater Boston area. The website is currently an early-stage MVP and should be improved into a polished, professional, high-converting landing page.

The immediate goal is not to build a full software platform. The immediate goal is to generate leads and validate demand.

## Where the project actually is (updated 2026-09-09)

**Read `/docs/HANDOFF.md` first, then `/docs/SCHEMA.md`.** Those are
authoritative and current. Everything below this section is still the right
*philosophy* — simple, lightweight, conversion-focused — but it was written
when the site was only a landing page, and it is no longer a complete
description of the system.

What exists beyond the landing page and the quote form:

- **Three signed-link surfaces.** `/h` customer portal (permanent, one per
  contact), `/j` per-job ticket (the cleaner's; dies when `completed_date` is
  filled), `/v` vendor portal (permanent, one per partner company). Four HMAC
  token audiences under one `TICKET_SECRET` — **none opens another**.
- **Two Google Sheets workbooks.** Leads MASTER is the customer side and is
  what the Apps Script is bound to. Ops MASTER is supply: `AVAILABILITY`,
  `VENDORS`, `VENDOR_SERVICES`, `OPERATORS`.
- **`apps-script/webhook.gs` is at r19** and deploys by hand — paste into Leads
  MASTER → Extensions → Apps Script. **When a change spans both, deploy the
  script BEFORE pushing the site.** The reverse order has caused a live
  outage and a day of broken tickets.
- **23 test files**, `node tests/run-all.js`. All must pass before committing.

Non-negotiables that are easy to break without noticing:

- **View models are whitelists built up field by field, never filtered down.**
  A column added to a sheet next month must not be able to reach a browser by
  default; somebody has to add it on purpose.
- **Door and entry codes are write-only.** Returned by no view model, present
  in no log line, ever.
- **Route to the vendor COMPANY, never a named individual** (Massachusetts
  §148B). `OPERATORS.show_to_customer` exists and is deliberately read by
  nothing.
- **Nothing personal in URLs or logs.** Addresses are never logged — ZIP plus a
  short hash only.
- **A green suite proves consistency, not correctness.** Break the code on
  purpose and confirm the test fails before trusting a new assertion.

## Current Business Stage
- Startup
- No clients yet
- Website is still unfinished
- Priority is simplicity, speed, and conversion
- We are building the cleanest possible MVP before adding advanced systems

## Primary Goal
Build a professional website that:
1. Clearly communicates Serve’s value proposition
2. Builds trust with potential customers
3. Captures leads through a quoting / estimate form
4. Makes it easy for visitors to request service

## Target Market
- Homeowners and renters in the Greater Boston area
- Customers looking for reliable, professional home cleaning
- Likely interested in recurring cleaning, move-out cleaning, or standard home cleaning

## Current MVP Priorities
Focus on these first:
- Strong landing page
- Clean and modern design
- Clear service offering
- Clear call-to-actions
- Lead capture quoting calculator / estimate form
- Mobile-first responsiveness
- Fast load times
- Simple maintainable code

## Future Roadmap (Do Not Overbuild Yet)
These features may come later, but should not complicate the MVP:
- Automated pricing logic
- Stripe payments
- Instant booking
- Client login / portal
- Booking tracking
- Cleaner assignment tracking
- Backend database
- CRM or workflow automations

When coding, keep the structure modular enough that these can be added later, but do not build for them prematurely.

## Tech Stack Constraints
For now, use:
- HTML
- CSS
- Vanilla JavaScript

Avoid:
- React
- frameworks
- heavy dependencies
- unnecessary libraries

Keep everything lightweight and easy to edit.

## Design Direction
The site should feel:
- professional
- modern
- clean
- trustworthy
- conversion-focused

Avoid:
- gimmicky effects
- clutter
- excessive animation
- overly “tech startup” styling
- anything that feels cheap or spammy

Design should be premium but simple.

## Branding / Theme Guidance
Improve the current site while staying consistent with its overall theme and direction.
Do not introduce a completely different visual identity unless explicitly requested.
Prefer refinement over reinvention.

## Conversion Priorities
Every page section should support one of these:
- trust
- clarity
- lead capture
- ease of action

Prioritize:
- strong headline
- clear subheadline
- clear CTA buttons
- benefits-focused copy
- service area clarity
- trust signals
- frictionless form experience

## Lead Capture / Quote Form
The lead capture tool is the most important feature in the MVP.

It should collect useful details such as:
- home size
- number of bedrooms / bathrooms
- frequency of service
- type of cleaning
- optional notes
- customer name
- phone number
- email

The form should be designed so it can eventually support automated quoting, but for now the main goal is capturing qualified leads.

Current storage plan:
- submissions may be sent to Google Sheets or a simple no-code integration

Do not tightly couple the form logic to a future backend yet.

## Coding Standards
- Write clean, modular, readable code
- Separate HTML, CSS, and JS clearly
- Use descriptive class and function names
- Avoid bloated code
- Avoid duplication
- Comment only where helpful
- Make updates easy for a non-engineer founder to edit later

## Responsive Standards
Must work well on:
- mobile phones
- tablets
- laptops
- large desktop screens

Mobile UX is especially important.

## Performance Standards
- Keep pages lightweight
- Minimize unnecessary assets
- Avoid large JS bundles
- Prefer simple implementations over clever ones

## Decision Rule
When choosing between:
- more advanced architecture
- simpler implementation

choose the simpler implementation unless the advanced version clearly improves conversions or maintainability in the near term.

## How to Help
When making suggestions:
- prioritize practical MVP improvements
- think like a conversion-focused product designer and startup operator
- suggest the highest ROI improvements first
- avoid overengineering
- explain tradeoffs briefly and clearly

## Output Preference
When proposing changes:
1. explain the goal
2. explain why it matters
3. show the code change
4. keep implementation practical and simple
