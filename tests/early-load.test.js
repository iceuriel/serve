/* r44 — the pages start loading sooner, and show their shape while they wait.
   ==================================================================
   Three things are proved here, for all three signed-link pages (/h, /j, /v)
   and for the booking form:

     1. THE EARLY REQUEST AND THE PAGE ASK FOR THE SAME ADDRESS. Each page's
        <head> starts its data request before the stylesheet and scripts have
        downloaded, and the page script adopts that answer. If the two ever
        built the address differently the page would still work — it asks
        again — but the whole head start would be gone and nothing would say
        so. So this runs the real inline script and the real page script
        together and counts the requests: exactly one.

     2. THE EARLY REQUEST CAN ONLY HELP. A different address, a failed request,
        a link with no token, or no early script at all must each leave the
        page behaving exactly as it did before r44.

     3. THE BOOKING FORM STILL GETS ITS SECOND CHANCE. Times are now fetched at
        the first touch of step 1 instead of at step 2. An attempt that fails
        that early must not use up the only try.

   Plus the static contract for the skeleton itself: present, labelled for
   screen readers, styled, and still for anyone who has asked for less motion. */

const REPO_ROOT = require('path').resolve(__dirname, '..');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = (f) => fs.readFileSync(path.join(REPO_ROOT, f), 'utf8').replace(/\r\n/g, '\n');
const CSS = read('style.css');

let bad = 0;
const t = (label, cond, extra) => {
  console.log((cond ? '  ok    ' : '  FAIL  ') + label +
              (extra !== undefined ? '  ->  ' + JSON.stringify(extra) : ''));
  if (!cond) bad++;
};
const head = (m) => console.log('\n=== ' + m + ' ===');
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); };

/* The smallest DOM the three page scripts touch on their failure path. */
function node(tag) {
  return {
    tagName: tag, className: '', children: [], _text: '', hidden: false, attrs: {},
    set textContent(v) { this._text = String(v); if (String(v) === '') this.children.length = 0; },
    get textContent() { return this._text; },
    appendChild(c) { this.children.push(c); return c; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    addEventListener() {},
    querySelectorAll() { return []; },
    querySelector() { return null; },
    classList: { add() {}, remove() {}, toggle() {} },
  };
}

const PAGES = [
  { html: 'h.html', js: 'portal.js', state: 'p-state', api: '/api/portal',
    search: '?id=CON-0007&t=0123456789abcdef0123',
    notFound: /could not open that link/, offline: /could not load your account just now/ },
  { html: 'j.html', js: 'ticket.js', state: 't-state', api: '/api/job',
    search: '?id=SRV-20261001-ABCDEF&t=0123456789abcdef0123&view=partner',
    notFound: /could not find that ticket/, offline: /could not load this ticket just now/ },
  { html: 'j.html', js: 'ticket.js', state: 't-state', api: '/api/job', label: 'j.html (client view, no view= in the link)',
    search: '?id=SRV-20261001-ABCDEF&t=0123456789abcdef0123',
    notFound: /could not find that ticket/, offline: /could not load this ticket just now/ },
  { html: 'v.html', js: 'vendor.js', state: 'v-state', api: '/api/vendor',
    search: '?id=VEN-0001&t=0123456789abcdef0123',
    notFound: /could not open that link/, offline: /could not load your account just now/ },
];

function inlineScript(html) {
  const found = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  return found.length === 1 ? found[0][1] : null;
}

/* Run the page the way a browser would: the inline <head> script first (unless
   told not to), then the page script. `reply` decides what the network says. */
async function open(page, opts) {
  opts = opts || {};
  const els = {};
  const fetches = [];
  const box = {
    console: { log() {}, warn() {}, error() {}, info() {} },
    location: { search: opts.search !== undefined ? opts.search : page.search, href: '' },
    URLSearchParams,
    document: { getElementById(id) { return (els[id] = els[id] || node('div')); }, createElement: node },
    sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    setTimeout, clearTimeout,
    fetch(url) {
      fetches.push(String(url));
      return opts.offline
        ? Promise.reject(new Error('offline'))
        : Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: false, error: 'not_found' }) });
    },
  };
  box.window = box;
  vm.createContext(box);
  if (!opts.noEarly) vm.runInContext(inlineScript(read(page.html)), box);
  const earlyUrl = box.ServeFirstLoad ? box.ServeFirstLoad.url : null;
  if (opts.tamper && box.ServeFirstLoad) box.ServeFirstLoad.url += '&different=1';
  vm.runInContext(read(page.js), box);
  await settle();
  return { fetches, earlyUrl, box, state: (els[page.state] || node('div'))._text };
}

(async function () {
  /* ------------------------------------------------------------------ */
  head('1. The early request and the page ask for the same address');
  for (const page of PAGES) {
    const name = page.label || page.html;
    const html = read(page.html);
    const script = inlineScript(html);
    t(name + ' has exactly one inline <head> script', script !== null);
    const headEnd = html.indexOf('</head>');
    t(name + ': it sits in <head>, ABOVE the stylesheet (a script after one waits for it)',
      html.indexOf('<script>') !== -1 && html.indexOf('<script>') < html.indexOf('<link rel="stylesheet"') &&
      html.indexOf('<script>') < headEnd);

    const R = await open(page);
    t(name + ': the early request goes to ' + page.api, String(R.earlyUrl).indexOf(page.api + '?id=') === 0, R.earlyUrl);
    t(name + ': the page adopts it — ONE request in total, not two', R.fetches.length === 1, R.fetches);
    t(name + ': and renders from that answer', page.notFound.test(R.state), R.state);
    t(name + ': the early answer is taken once, then forgotten', R.box.ServeFirstLoad === null);
  }

  /* ------------------------------------------------------------------ */
  head('2. The early request can only help');
  for (const page of PAGES) {
    const name = page.label || page.html;

    const M = await open(page, { tamper: true });
    t(name + ': a different early address is ignored and the page asks itself',
      M.fetches.length === 2, M.fetches);
    t(name + ': and what the page asks for is exactly what <head> would have',
      M.fetches[1] === M.earlyUrl, { head: M.earlyUrl, page: M.fetches[1] });

    const N = await open(page, { noEarly: true });
    t(name + ': with no early script at all, the page asks as it always did',
      N.fetches.length === 1 && page.notFound.test(N.state), { fetches: N.fetches, state: N.state });

    const O = await open(page, { offline: true });
    t(name + ': a failed early request shows the page\'s own "try again" message',
      O.fetches.length === 1 && page.offline.test(O.state), { fetches: O.fetches, state: O.state });

    const I = await open(page, { search: '?id=ONLY-AN-ID' });
    t(name + ': a link with no token starts nothing early', I.earlyUrl === null && I.fetches.length === 0, I.fetches);
  }

  /* ------------------------------------------------------------------ */
  head('3. The skeleton');
  [['h.html', 'p-state'], ['j.html', 't-state'], ['v.html', 'v-state']].forEach(([file, id]) => {
    const html = read(file);
    const at = html.indexOf('id="' + id + '"');
    const block = at === -1 ? '' : html.slice(html.lastIndexOf('<div', at), html.indexOf('</div>\n        </div>', at) + 20);
    t(file + ': the state element carries the skeleton', /class="skel"/.test(block));
    t(file + ': it is announced as a status, with words for a screen reader',
      /role="status"/.test(block) && /class="sr-only">Loading [^<]+</.test(block));
    t(file + ': the bars themselves are hidden from assistive tech', /class="skel" aria-hidden="true"/.test(block));
    t(file + ': "Loading…" alone is gone', html.indexOf('>Loading&hellip;</p>') === -1);
    const classes = [...new Set([...block.matchAll(/class="([^"]+)"/g)]
      .map(m => m[1].split(/\s+/)).flat().filter(c => /^skel/.test(c)))];
    const unstyled = classes.filter(c => !new RegExp('\\.' + c + '(?![\\w-])').test(CSS));
    t(file + ': every skeleton class is styled', classes.length > 0 && unstyled.length === 0, unstyled);
  });
  t('the pulse stops for anyone who asked for less motion',
    /@media \(prefers-reduced-motion: reduce\) \{\s*\.skel__bar \{ animation: none; \}/.test(CSS));
  ['portal.js', 'ticket.js', 'vendor.js'].forEach((file) => {
    const js = read(file);
    t(file + ': fail() writes over the whole state element, skeleton included',
      /function fail\(msg\) \{\s*stateEl\.textContent = msg;/.test(js));
  });
  t('portal.js and vendor.js hide it once the page has painted',
    /function start\(\) \{\s*stateEl\.hidden = true;/.test(read('portal.js')) &&
    /function start\(\) \{\s*stateEl\.hidden = true;/.test(read('vendor.js')));
  t('ticket.js hides it once the page has painted', /stateEl\.hidden = true;/.test(read('ticket.js')));

  /* ------------------------------------------------------------------ */
  head('4. The booking form asks for times at first touch, and keeps a second try');
  const SITE = read('script.js');
  const focusAt  = SITE.indexOf("buildForm.addEventListener('focusin', () => prefetchAvailability(), { once: true });");
  const submitAt = SITE.indexOf("buildForm.addEventListener('submit', (e) => {");
  t('the first touch of step 1 starts the request, once', focusAt !== -1);
  t('and step 2 still asks too (a no-op unless the first try failed)',
    submitAt > focusAt && SITE.indexOf('prefetchAvailability();', submitAt) !== -1);

  const from = SITE.indexOf('    let availSlots  = null;');
  const to   = SITE.indexOf('    /* Bookable = open > 0');
  t('the scheduler block can be found in script.js', from !== -1 && to > from);

  async function scheduler(replies) {
    const calls = [];
    const box = {
      console: { log() {}, warn() {}, info() {} },
      AVAILABILITY_SOURCE_URL: '/api/slots', AVAILABILITY_TIMEOUT_MS: 5000,
      setTimeUi(mode) { box.timeUi = mode; },
      renderSchedulerDays() {},
      filterSlots: (s) => s,
      setTimeout, clearTimeout, AbortController,
      fetch() {
        const r = replies[calls.length] || replies[replies.length - 1];
        calls.push(r.kind);
        if (r.kind === 'error') return Promise.reject(new Error('down'));
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, slots: r.slots }) });
      },
    };
    vm.createContext(box);
    vm.runInContext(SITE.slice(from, to) + '\n;globalThis.__pf = prefetchAvailability;', box);
    return { calls, pf: box.__pf };
  }

  const E = await scheduler([{ kind: 'error' }, { kind: 'ok', slots: [{ date: '2026-10-01', time: '9:00 AM', open: 1 }] }]);
  E.pf(); E.pf();
  t('two touches before an answer make one request', E.calls.length === 1, E.calls);
  await settle();
  E.pf();
  await settle();
  t('a request that FAILED leaves step 2 its own try', E.calls.length === 2, E.calls);
  E.pf();
  await settle();
  t('once times have arrived, nothing asks again', E.calls.length === 2, E.calls);

  const Z = await scheduler([{ kind: 'ok', slots: [] }]);
  Z.pf();
  await settle();
  Z.pf();
  await settle();
  t('an EMPTY answer also leaves a second try', Z.calls.length === 2, Z.calls);

  console.log('\n' + (bad ? 'FAILURES: ' + bad : 'all early-load checks passed'));
  process.exit(bad ? 1 : 0);
})();
