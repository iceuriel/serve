/**
 * Privacy guard.
 *
 * On the free plan GitHub Pages requires a PUBLIC repository, so everything
 * committed here is permanently public — including in history, where deleting a
 * file does not remove it. This test fails the build rather than letting
 * personal material reach that state again.
 *
 * NOTE ON DESIGN: this file deliberately contains no names, schools, employers
 * or personal addresses. An earlier version listed them as search patterns,
 * which published exactly what it was meant to protect. Instead it checks
 * structural invariants plus a generic "no email outside the allow-list" sweep,
 * and reads any name-specific patterns from tests/.private-patterns — a
 * gitignored file that never enters the repo.
 */
const REPO_ROOT = require('path').resolve(__dirname, '..');
const fs   = require('fs');
const path = require('path');

let bad = 0;
const t = (label, cond, extra) => {
  console.log((cond ? '  ok    ' : '  FAIL  ') + label + (extra !== undefined ? '  ->  ' + JSON.stringify(extra) : ''));
  if (!cond) bad++;
};

/**
 * Addresses that are allowed to appear. Anything else is a finding.
 * Kept deliberately tight: `example.com` and `example.org` are RFC-reserved and
 * can never be a real person, and the two form placeholders are visible on the
 * page already. A real address that is not the business one should fail here.
 */
const PUBLIC_CONTACTS = [
  /servehomecleaning@gmail\.com/gi,              // printed in the footer
  /[A-Za-z0-9._%+-]+@example\.(com|org)/gi,      // RFC-reserved, test fixtures
  /you@email\.com/gi,                            // form placeholder
];

const SKIP_DIRS  = new Set(['.git', 'node_modules', 'images', '_site', '.claude']);
const SKIP_FILES = new Set(['package-lock.json', '.private-patterns']);

function walk(dir, out) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach(e => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(full, out); }
    else if (!SKIP_FILES.has(e.name)) out.push(full);
  });
  return out;
}

function readable(f) {
  try {
    const text = fs.readFileSync(f, 'utf8');
    return /�/.test(text.slice(0, 200)) ? null : text;   // skip binaries
  } catch (e) { return null; }
}

const files = walk(REPO_ROOT, []);
const rel = f => path.relative(REPO_ROOT, f).replace(/\\/g, '/');
console.log('scanning ' + files.length + ' files\n');

/* ---------- 1. no email address outside the allow-list ---------- */
console.log('=== 1. no email address beyond the published business ones ===');
const strayEmails = [];
files.forEach(f => {
  let text = readable(f);
  if (text === null) return;
  PUBLIC_CONTACTS.forEach(re => { text = text.replace(re, ''); });
  const found = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || [];
  found.forEach(e => strayEmails.push(rel(f) + ' -> ' + e));
});
t('no unexpected email address in any file', strayEmails.length === 0, strayEmails);

/* ---------- 2. personal files absent and permanently ignored ---------- */
console.log('\n=== 2. personal material cannot re-enter the repo ===');
t('no IDENTITY.md in the repo', !fs.existsSync(path.join(REPO_ROOT, 'IDENTITY.md')));

const giPath = path.join(REPO_ROOT, '.gitignore');
const gi = fs.existsSync(giPath) ? fs.readFileSync(giPath, 'utf8') : '';
t('.gitignore exists', gi.length > 0);
[['IDENTITY.md', /^IDENTITY\.md$/m],
 ['.claude/',    /^\.claude\/$/m],
 ['env files',   /\.env/],
 ['secrets',     /secrets/]].forEach(([label, re]) =>
  t('.gitignore blocks ' + label, re.test(gi)));

/* ---------- 3. Apps Script holds no personal address ---------- */
console.log('\n=== 3. notification recipient is not in source ===');
const wh = fs.readFileSync(path.join(REPO_ROOT, 'apps-script', 'webhook.gs'), 'utf8');
t('recipient read from Script Properties',
  /PropertiesService\.getScriptProperties\(\)\.getProperty\("NOTIFY_EMAIL"\)/.test(wh));
t('no hardcoded NOTIFY_EMAIL constant', !/const\s+NOTIFY_EMAIL\s*=\s*["']/.test(wh));

/* ---------- 4. the deploy artifact is an allow-list ---------- */
console.log('\n=== 4. deploy workflow publishes an allow-list ===');
const wf = fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'deploy-pages.yml'), 'utf8');
t('does NOT upload the whole repo', !/path:\s*\.\s*$/m.test(wf));
t('uploads a staged directory', /path:\s*\.\/_site/.test(wf));
t('has a guard step that fails on private file types', /Fail if anything private/.test(wf));

['index.html', 'script.js', 'style.css', 'images', 'CNAME'].forEach(a =>
  t('artifact includes ' + a, wf.includes(a)));
['docs', 'tests', 'apps-script', 'CLAUDE.md', 'package.json'].forEach(p => {
  const staged = new RegExp('cp\\s+(-r\\s+)?[^\\n]*\\b' + p.replace('.', '\\.') + '\\b[^\\n]*_site').test(wf);
  t('artifact excludes ' + p, !staged);
});

/* ---------- 5. optional local pattern list ---------- */
console.log('\n=== 5. local pattern list (tests/.private-patterns) ===');
const ppPath = path.join(__dirname, '.private-patterns');
if (!fs.existsSync(ppPath)) {
  console.log('  --    not present; skipping. Add one regex per line to scan for');
  console.log('        names or identifiers. It is gitignored and never committed.');
} else {
  const pats = fs.readFileSync(ppPath, 'utf8').split('\n')
    .map(s => s.trim()).filter(s => s && !s.startsWith('#'))
    .map(s => new RegExp(s, 'i'));
  const hits = [];
  files.forEach(f => {
    const text = readable(f);
    if (text === null) return;
    pats.forEach(re => { const m = text.match(re); if (m) hits.push(rel(f) + ' -> ' + m[0]); });
  });
  t('no local-pattern match in any file (' + pats.length + ' patterns)', hits.length === 0, hits);
}

console.log('\n' + (bad ? 'FAILURES: ' + bad : 'ALL CHECKS PASSED'));
process.exit(bad ? 1 : 0);
