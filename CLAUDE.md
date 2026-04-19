# CLAUDE.md — Serve Website Development Guide

## Project Overview
Serve is a startup home cleaning business serving the Greater Boston area. The website is currently an early-stage MVP and should be improved into a polished, professional, high-converting landing page.

The immediate goal is not to build a full software platform. The immediate goal is to generate leads and validate demand.

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