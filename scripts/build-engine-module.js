#!/usr/bin/env node
/**
 * Generate src/engine.generated.mjs from the two classic scripts.
 *
 * WHY THIS EXISTS
 *
 * serve-geo-data.js and pricing-engine.js are loaded by plain <script> tags in
 * the browser, so they cannot contain `export` syntax. They publish through
 * `if (typeof module !== "undefined") module.exports = …` instead, which works
 * for Node but not for a bundler: Wrangler treats .js as an ES module, ES
 * modules have no `module` object, so that line never runs and the files export
 * nothing at all. A Worker importing them — named or default — silently gets
 * undefined.
 *
 * That shipped on 2026-09-02. Every geo-mapped ZIP priced at the neutral factor
 * and real bookings were rejected. Three separate attempts to negotiate with the
 * bundler failed, each one needing a deploy to disprove.
 *
 * So this stops negotiating. It concatenates the same two files and appends a
 * real `export` statement. The output is unambiguously an ES module and cannot
 * half-resolve.
 *
 * STILL ONE SOURCE OF TRUTH. Nothing is retyped here — the generated file is
 * the two originals verbatim plus one line. tests/worker-proxy.test.js asserts
 * the committed copy matches what this produces, so a stale one fails the suite
 * rather than shipping.
 *
 * Concatenating them into ONE module scope has a second benefit: serveGeo()
 * resolves lookupGeo lexically, the way it does in a browser, instead of
 * depending on a global that a bundle does not have.
 */
const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT  = path.join(ROOT, 'src', 'engine.generated.mjs');

const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

const BANNER = `/* ============================================================
   GENERATED FILE — DO NOT EDIT
   ============================================================

   Produced by scripts/build-engine-module.js from:

       serve-geo-data.js
       pricing-engine.js

   Edit those. Running the build regenerates this, and the test suite fails if
   this file has drifted from them.

   It exists because the two sources are classic <script> files with no export
   syntax, and Wrangler bundles .js as ES modules — where their conditional
   module.exports never executes. This is the same code with a real export.
   ============================================================ */

`;

/* The order matters: geo first, so lookupGeo is in scope for serveGeo below. */
const body = read('serve-geo-data.js') + '\n\n' + read('pricing-engine.js');

const EXPORTS = `

/* The whole point of this file. */
export {
    lookupGeo, ZIP_GEO, PARK_ADDER, DEFAULT_GEO,
    computeQuote, serveGeo, NEUTRAL_GEO,
    PRICING_VERSION, PRICING, WORK_MODEL, MARGIN,
    WORK_RATE, TARGET_WAGE, zipTier, ZIP_TIERS,
};
`;

const generated = BANNER + body + EXPORTS;

/* Only write when it actually changed, so a no-op build leaves the mtime alone
   and `git status` stays quiet. */
const existing = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n') : null;
if (existing === generated) {
  console.log('engine.generated.mjs already current');
} else {
  fs.writeFileSync(OUT, generated);
  console.log('engine.generated.mjs written (' + generated.split('\n').length + ' lines)');
}

module.exports = { generate: () => generated };
