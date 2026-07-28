# Tests

Run with `npm test` from the repo root. No dependencies, no framework, no build
step — the site ships none and the tests should not be what introduces one.
Everything here is plain Node against the real source files, so a test can never
drift from an out-of-date copy of the code. `npm test leads` runs a subset by
substring.

**Nothing in this directory is referenced by `index.html`.** It is dev-only and
is not deployed by the Pages workflow.

The Apps Script tests work by reading `apps-script/*.gs` and executing it inside
a `vm` context with hand-built stand-ins for `SpreadsheetApp`, `MailApp`,
`LockService`, `Utilities` and friends, plus a controllable clock. Sheets are
simulated as arrays with an audit trail, so a test can assert not just the
resulting values but *how many writes happened and to which columns* — which is
how the atomicity and immutability guarantees are checked. Sheet fixtures are
built from the real header rows recorded in `/docs/SCHEMA.md`; they are
simulations, not the live workbook, so a fixture that drifts from the real sheet
is the one failure mode these tests cannot catch. `reportLeadsSchema()` in the
Apps Script editor is the check for that.

| File | Covers |
|---|---|
| `static-checks.test.js` | Every `getElementById` in `script.js` resolves against `index.html`; no duplicate ids; in-page anchors have targets; images exist on disk and lazy-load; new CSS classes are both used and styled; the "After you book" section sits outside the step-switching logic; markup tags balance; the availability constant is isolated; CTA copy is consistent. |
| `attribution.test.js` | `src` prefix → segment derivation; first-touch persistence across refresh and back-button; a second tagged link moves last-touch but never first-touch; `serve_src_chain` ordering; graceful degradation when `sessionStorage` throws; pets keyword detection including the "carpet"/"category" false-positive traps; submission-id uniqueness. |
| `webhook-routing.test.js` | Reservations → JOBS, other events → EVENTS, never LEADS; protected tabs untouched; `submission_id` idempotency; the LEADS upsert's create and match paths; per-tab header maps. Runs against a 32-column JOBS fixture, so it doubles as the regression that the writer degrades correctly on a sheet that has not caught up. |
| `webhook-atomicity.test.js` | `reportLeadsSchema()` is read-only, proven against a mock that throws on every mutating call; the JOBS row is one `appendRow` of a fully-built array; a forced failure mid-write leaves no partial row; a retry after the failure writes cleanly and a later replay is deduped. |
| `webhook-schema.test.js` | The 36-column JOBS contract: tab-name normalisation so underscores or spaces cannot disarm the guard; `address`/`unit`/`zip` in real columns rather than `quote_meta`; `received_at` in the business timezone; `start_time` carrying the preference label on non-slot bookings. |
| `leads-upsert.test.js` | The live 19-column LEADS tab: `address` → `service_address` mapping; `first_touch`/`last_touch` written as real `Date` objects; `last_touch` bumps on a match while `first_touch` is never touched — enforced by `setLeadCell()` throwing, not merely by omission; operator-owned columns left blank; text-in-a-date-column warning. |
| `availability-contract.test.js` | `availability.gs` output fed through the site's own `filterSlots()` sliced live out of `script.js`, so the two halves of the scheduler cannot drift: aggregation, chronological ordering across noon, real Sheets time values, lead-time and horizon exclusion, `ok:false` on a bad header, and published values proven identical under a wrong timezone setting. |
| `live-slots.test.js` | A snapshot of a real feed response rendered through the site's grouping logic — weekday correctness, no repeated day headings, noon as `12:00 PM`. Update the fixture when the feed shape changes. |

## Not carried over

The original `gs-harness.js` asserted the pre-Part-7 contract, where `notes` was
a multi-line blob holding pets, contact details and attribution. That was
deliberately replaced — `notes` is the schedule summary alone, and the rest moved
to their own columns. The file tested a contract that no longer exists and is
superseded by `webhook-routing` and `webhook-schema`.
