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
  /management@servecos.com/gi,              // printed in the footer
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

/* ---------- 4. no dormant publisher can wake up and republish ---------- */
console.log('\n=== 4. no second publish path exists ===');
/* The GitHub Pages workflow was removed at the Cloudflare cutover. A dormant
   workflow is dangerous: pushing to master would re-publish the repo root from
   a config nobody is looking at any more. If one is ever re-added, it must use
   the same allow-list. */
const wfDir = path.join(REPO_ROOT, '.github', 'workflows');
const workflows = fs.existsSync(wfDir) ? fs.readdirSync(wfDir) : [];
t('no GitHub Pages workflow (Cloudflare is the only publisher)',
  !workflows.some(f => /pages/i.test(f)), workflows);
workflows.forEach(f => {
  const y = fs.readFileSync(path.join(wfDir, f), 'utf8');
  t(f + ' does not upload the repo root', !/path:\s*\.\s*$/m.test(y));
});
t('no CNAME file (GitHub Pages artifact, misleading on Cloudflare)',
  !fs.existsSync(path.join(REPO_ROOT, 'CNAME')));

/* ---------- 4b. the shared build script is an allow-list ---------- */
console.log('\n=== 4b. scripts/build-site.sh publishes an allow-list ===');
const bs = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'build-site.sh'), 'utf8');
['index.html', 'script.js', 'style.css', 'images'].forEach(a =>
  t('stages ' + a, new RegExp('cp\\s+(-r\\s+)?[^\\n]*' + a.replace('.', '\\.')).test(bs)));
/* MATCHED AS A WHOLE ARGUMENT, NOT AS A SUBSTRING. `\bdocs\b` also matches
   inside `api-docs.html`, which is a published page — so the guard failed on a
   file it was never meant to be about, on 2026-09-25. What it is actually
   forbidding is the DIRECTORY: `docs`, `docs/`, `./docs`. Anchoring on the
   whitespace before the argument keeps `api-docs.html` out of it while still
   catching every real way of staging the folder. */
['docs', 'apps-script', 'tests', 'CLAUDE.md'].forEach(p =>
  t('never stages ' + p,
    /* The middle group is OPTIONAL so the name is caught as the FIRST argument
       too — `cp CLAUDE.md "$OUT"/` has its boundary eaten by `cp\s+` and
       survived an earlier draft of this very fix. */
    !new RegExp('cp\\s+(-r\\s+)?([^\\n]*[\\s"\'])?\\.?/?' +
                p.replace('.', '\\.') + '[/\\s"\']').test(bs)));
t('guards against private file types', /ERROR: private-looking files/.test(bs));
t('fails the build on a guard hit', /exit 1/.test(bs));

/**
 * The live publish path. `wrangler deploy` auto-detects the output directory as
 * "." when unconfigured, which on the first attempt tried to publish 2235 files
 * from the repo root and only failed on an unrelated size limit. This is the
 * single most important assertion in this file.
 */
console.log('\n=== 4c. Cloudflare publishes _site, never the repo root ===');
const wrPath = path.join(REPO_ROOT, 'wrangler.jsonc');
if (!fs.existsSync(wrPath)) {
  console.log('  --    no wrangler.jsonc (not the active host)');
} else {
  const raw = fs.readFileSync(wrPath, 'utf8');
  // strip // comments so the config can be parsed as JSON
  const wr = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''));
  t('assets.directory is set at all', !!(wr.assets && wr.assets.directory),
    wr.assets);
  t('assets.directory is ./_site, NOT the repo root',
    wr.assets && /^\.\/?_site\/?$/.test(wr.assets.directory), wr.assets && wr.assets.directory);
  t('no stray build output dir pointing at root',
    !/"directory"\s*:\s*"\.?"/.test(raw));
}

console.log('\n=== 4d. other host configs defer to that one script ===');
const ntPath = path.join(REPO_ROOT, 'netlify.toml');
if (fs.existsSync(ntPath)) {
  const nt = fs.readFileSync(ntPath, 'utf8');
  t('netlify.toml publishes _site', /publish\s*=\s*"_site"/.test(nt));
  t('netlify.toml calls build-site.sh', /scripts\/build-site\.sh/.test(nt));
} else {
  console.log('  --    no netlify.toml');
}

/* _headers is read from the publish dir by both Cloudflare Pages and Netlify. */
console.log('\n=== 4e. response headers are portable and correct ===');
const hd = fs.readFileSync(path.join(REPO_ROOT, '_headers'), 'utf8');
t('_headers is staged by the build', /cp _headers/.test(bs));
t('index.html must revalidate — a stale script.js keeps POSTing to a dead endpoint',
  /\/index\.html[\s\S]{0,120}must-revalidate/.test(hd));
t('script.js must revalidate', /\/script\.js[\s\S]{0,120}must-revalidate/.test(hd));
t('images are cached', /\/images\/\*[\s\S]{0,120}max-age=\d{4,}/.test(hd));
t('nosniff set', /X-Content-Type-Options:\s*nosniff/.test(hd));
t('referrer policy set', /Referrer-Policy:/.test(hd));

/* script.js contains user-facing non-ASCII (a check mark and an ellipsis).
   Cloudflare serves text/javascript with no charset, so it must be declared
   here or those strings can render as mojibake. */
['/index.html', '/script.js', '/style.css'].forEach(p => {
  const block = hd.split(/\n(?=\/)/).find(b => b.trim().startsWith(p));
  t('charset declared for ' + p, !!block && /charset=utf-8/i.test(block));
});
const siteJs = fs.readFileSync(path.join(REPO_ROOT, 'script.js'), 'utf8');
const nonAscii = (siteJs.match(/textContent\s*=\s*'[^']*[^\x00-\x7F][^']*'/g) || []);
t('non-ASCII UI strings exist, so the charset header is load-bearing',
  nonAscii.length > 0, nonAscii.map(s => s.slice(0, 46)));

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
