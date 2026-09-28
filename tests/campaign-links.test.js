/* Printed QR short links — /newhome and whatever is printed after it.
 *
 * These assertions exist because the URL on a mailed postcard cannot be
 * corrected. If one of them fails, cards are already in mailboxes pointing at
 * a 404 or at the wrong hero, and there is no patch for paper.
 *
 * Runs the real Worker through worker-proxy's harness. The attribution half is
 * read out of the shipped script.js, because the tags are only worth anything
 * if the page actually records them.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert/strict');
const root = path.resolve(__dirname, '..');

function harness(file, marker, exports) {
    const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
    const end = source.indexOf(marker); assert.ok(end > 0);
    return vm.runInNewContext(source.slice(0, end) + '\n(' + exports + ');', {
        require, __dirname, console, AbortController, setTimeout, clearTimeout,
        URL, URLSearchParams, Response, Request, Headers, TextEncoder, TextDecoder
    });
}
const W = harness('worker-proxy.test.js', 'const ASSETS =', '{ loadWorker }');

let bad = 0;
const t = (label, cond, extra) => {
    console.log((cond ? '  ok    ' : '  FAIL  ') + label +
        (extra !== undefined ? '  ->  ' + JSON.stringify(extra) : ''));
    if (!cond) bad++;
};

const ENV = {
    WEBHOOK_URL: 'https://script.google.com/macros/s/WEBHOOK/exec',
    ASSETS: { fetch: async () => new Response('<html>site</html>', { status: 200 }) },
};
const scan = async (p) => {
    const { worker, calls } = W.loadWorker(async () => new Response('{}', { status: 200 }));
    const res = await worker.fetch(new Request('https://servecleaning.com' + p), ENV);
    return { res, calls, to: res.headers.get('Location') };
};

(async function run() {

console.log('=== 1. the printed path answers ===');
{
    const { res, to, calls } = await scan('/newhome');
    t('/newhome redirects, not 404s', res.status === 302, res.status);
    t('costs no upstream call', calls.length === 0);

    const dest = new URL(to || 'https://x.invalid/');
    t('lands on the home page', dest.origin + dest.pathname === 'https://servecleaning.com/', to);

    /* src is what `source`, src_first and src_chain record. Without it the scan
       is credited to nothing. */
    t('carries a src tag', !!dest.searchParams.get('src'), to);
    t('utm_source', dest.searchParams.get('utm_source') === 'thanksio');
    t('utm_medium', dest.searchParams.get('utm_medium') === 'direct_mail');
    t('utm_campaign', dest.searchParams.get('utm_campaign') === 'boston_new_homeowners_2026');

    /* 301 is cached by the scanning phone; a re-point would then miss exactly
       the people who already scanned the card. */
    t('302, never 301', res.status !== 301);
    t('not cached at the edge either', /no-store/.test(res.headers.get('Cache-Control') || ''),
        res.headers.get('Cache-Control'));
}

console.log('=== 2. how it will really be scanned ===');
{
    const trailing = await scan('/newhome/');
    t('trailing slash still works', trailing.res.status === 302, trailing.res.status);

    const shouted = await scan('/NewHome');
    t('case-insensitive — cards get typed by hand', shouted.res.status === 302, shouted.res.status);

    /* A mail vendor appends its own per-recipient token. Stripping it would
       destroy the recipient-level scan reporting the vendor is paid for. */
    const tagged = await scan('/newhome?r=abc123');
    const kept = new URL(tagged.to).searchParams;
    t('unknown params pass through', kept.get('r') === 'abc123', tagged.to);
    t('and the campaign tags survive alongside', kept.get('utm_source') === 'thanksio');

    const override = await scan('/newhome?src=newhome-02');
    t('an explicit src wins, so a variant can be tested',
        new URL(override.to).searchParams.get('src') === 'newhome-02', override.to);
}

console.log('=== 3. nothing else moved ===');
{
    const home = await scan('/');
    t('/ still serves the site, no redirect loop', home.res.status === 200, home.res.status);
    const other = await scan('/terms.html');
    t('real pages untouched', other.res.status === 200, other.res.status);
    const missing = await scan('/nosuchcampaign');
    t('an unprinted path is not invented', missing.res.status === 200, missing.res.status);
}

console.log('=== 4. the page records what the link sends ===');
{
    const script = fs.readFileSync(path.join(root, 'script.js'), 'utf8');
    const keys = (script.match(/const\s+keys\s*=\s*\[([^\]]*)\]/) || [, ''])[1];
    t('readAttribution reads src', /'src'/.test(keys), keys);
    t('...and the utm trio', /utm_source/.test(keys) && /utm_medium/.test(keys) &&
        /utm_campaign/.test(keys), keys);

    /* If this ever starts failing, utm_content became real and may be printed.
       Until then a link carrying it is claiming tracking that does not exist. */
    t('utm_content is still NOT read — so no printed link may rely on it',
        !/utm_content/.test(keys), keys);

    const worker = fs.readFileSync(path.join(root, 'src', 'worker.js'), 'utf8');
    const links = (worker.match(/const SHORT_LINKS = \{[\s\S]*?\n\};/) || [''])[0];
    t('no printed link carries utm_content', !/utm_content/.test(links));
}

console.log('=== 5. a printed card lands on the hero that guesses nothing ===');
{
    /* THE REAL segmentFor(), lifted out of the shipped script.js and run
       against the tags the Worker actually sends. A copy of the taxonomy here
       would agree with itself forever while the page disagreed.
       Founder's call 2026-09-28: a mailing list says a household probably
       moved, not what they came for, so printed media gets the default hero.
       Adding `mv-` (or dh-, qr-, deed-…) to a printed tag silently swaps it. */
    const script = fs.readFileSync(path.join(root, 'script.js'), 'utf8');
    const from = script.indexOf('const SRC_SEGMENTS');
    const to   = script.indexOf('}', script.indexOf('function segmentFor')) + 1;
    assert.ok(from > 0 && to > from, 'could not find segmentFor in script.js');
    const { segmentFor } = vm.runInNewContext(
        script.slice(from, to) + '\n({ segmentFor });', {});

    t('sanity: the lifted function still classifies a known tag',
        segmentFor('mv-deedlist-04') === 'movein', segmentFor('mv-deedlist-04'));

    for (const p of ['/newhome']) {
        const src = new URL((await scan(p)).to).searchParams.get('src');
        t(p + ' -> default hero (segment "direct")',
            segmentFor(src) === 'direct', { src, segment: segmentFor(src) });
    }
}

console.log(bad ? '\n' + bad + ' FAILED' : '\nall campaign-link checks passed');
process.exit(bad ? 1 : 0);
})();
