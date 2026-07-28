/**
 * Runs every *.test.js in this directory as a separate process and reports a
 * summary. Each test file exits non-zero on failure; this exits non-zero if any
 * of them did, so CI or a pre-push hook can gate on it.
 *
 * Deliberately dependency-free — no test framework. The site itself ships no
 * dependencies and no build step, and the tests should not be the thing that
 * introduces one.
 */
const { spawnSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const DIR   = __dirname;
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.test.js')).sort();
const only  = process.argv[2];               // node tests/run-all.js leads   -> substring filter
const run   = only ? files.filter(f => f.includes(only)) : files;

if (!run.length) {
  console.error(only ? `no test matches "${only}"` : 'no *.test.js files found');
  process.exit(1);
}

const results = [];
let failed = 0;

run.forEach(file => {
  const started = Date.now();
  const res = spawnSync(process.execPath, [path.join(DIR, file)], { encoding: 'utf8' });
  const ms  = Date.now() - started;
  const out = (res.stdout || '') + (res.stderr || '');
  const ok  = res.status === 0;
  if (!ok) failed++;

  results.push({ file, ok, ms, out });

  // Only echo full output for failures — a green run stays readable.
  console.log((ok ? '  PASS  ' : '  FAIL  ') + file.padEnd(34) + ms + 'ms');
  if (!ok) {
    console.log('\n' + '-'.repeat(70));
    console.log(out.trimEnd());
    console.log('-'.repeat(70) + '\n');
  }
});

const total = results.length;
console.log('\n' + (failed
  ? `${failed} of ${total} test files FAILED`
  : `all ${total} test files passed`));

process.exit(failed ? 1 : 0);
