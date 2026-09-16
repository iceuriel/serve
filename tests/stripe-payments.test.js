/**
 * PAYMENT STATE — the write-back that makes a live Stripe key safe.
 *
 * Two halves, tested together because neither is safe alone:
 *
 *   src/worker.js        verifies Stripe's signature and relays the outcome
 *   apps-script/webhook.gs  writes payment_status, guarded against downgrades
 *
 * WHAT THIS FILE IS REALLY DEFENDING. Before it, /api/checkout placed real
 * holds and NOTHING recorded them, so every customer surface went on saying
 * "Not yet authorized" to somebody who had already paid — with the Authorize
 * button still there, inviting a second hold on the same card. On a test key
 * that was an annoyance. On a live key it is a customer being told their money
 * did not arrive.
 *
 * The single most important assertion here is that an UNSIGNED request writes
 * NOTHING. This route marks bookings paid; without the signature check it
 * would be a public endpoint for doing that to anybody's job id.
 */
const REPO_ROOT = require('path').resolve(__dirname, '..');
const fs     = require('fs');
const path   = require('path');
const vm     = require('vm');
const crypto = require('crypto');

let bad = 0;
const t = (label, cond, extra) => {
  console.log((cond ? '  ok    ' : '  FAIL  ') + label +
              (extra !== undefined ? '  ->  ' + JSON.stringify(extra) : ''));
  if (!cond) bad++;
};

/* ============================================================
   HARNESS 1 — the Worker, loaded exactly as worker-proxy does
   ============================================================ */
const SRC = fs.readFileSync(path.join(REPO_ROOT, 'src', 'worker.js'), 'utf8');
const ENGINE_MJS = fs.readFileSync(path.join(REPO_ROOT, 'src', 'engine.generated.mjs'), 'utf8');

const CJS_TAIL =
  'module.exports = { lookupGeo, ZIP_GEO, PARK_ADDER, DEFAULT_GEO, computeQuote,' +
  ' serveGeo, NEUTRAL_GEO, PRICING_VERSION, PRICING, WORK_MODEL, MARGIN,' +
  ' WORK_RATE, TARGET_WAGE, zipTier, ZIP_TIERS };';

function loadModule(source) {
  const box = { module: { exports: {} }, console: { log() {}, warn() {}, error() {} } };
  box.exports = box.module.exports;
  vm.createContext(box);
  vm.runInContext(source.replace(/^export \{[\s\S]*?\};\s*$/m, CJS_TAIL), box);
  return box.module.exports;
}
const engineExports = loadModule(ENGINE_MJS);

const importedNames = (SRC.match(/^import\s*\{([\s\S]*?)\}\s*from[^\n]*$/m) || [, ''])[1]
  .split(',').map(s => s.trim()).filter(Boolean);
if (!importedNames.length) throw new Error('could not read the worker import list');

const runnable =
  'const __m = globalThis.__engine;\n' +
  importedNames.map(n => 'const ' + n + ' = __m.' + n + ';').join('\n') + '\n' +
  SRC.replace(/^import\s*\{[\s\S]*?\}\s*from[^\n]*\n/m, '')
     .replace(/^import[^\n]*\n/gm, '')
     .replace(/export\s+default\s*\{/, 'globalThis.__worker = {');

function loadWorker(fetchImpl) {
  const logs = [], fetches = [];
  const box = {
    console: { log: m => logs.push(String(m)), warn() {}, error: m => logs.push(String(m)) },
    AbortController, setTimeout, clearTimeout, URL, URLSearchParams,
    Response, Request, Headers, JSON,
    crypto: crypto.webcrypto, TextEncoder, TextDecoder,
    fetch: async (target, init) => {
      fetches.push({ target: String(target), init });
      return fetchImpl(target, init);
    },
    globalThis: undefined,
    __engine: engineExports,
  };
  box.globalThis = box;
  vm.createContext(box);
  vm.runInContext(runnable, box);
  return { worker: box.__worker, logs, fetches };
}

const ASSETS = { fetch: async () => new Response('site', { status: 200 }) };
const WEBHOOK_URL = 'https://script.google.com/macros/s/WEBHOOK/exec';

/* A fully configured environment. Individual tests strip one key at a time. */
const PENV = {
  WEBHOOK_URL,
  AVAILABILITY_URL: 'https://script.google.com/macros/s/AVAIL/exec',
  STRIPE_SECRET_KEY: 'sk_test_fake_key_for_tests',
  STRIPE_WEBHOOK_SECRET: 'whsec_fake_signing_secret',
  PAYMENT_BRIDGE_SECRET: 'bridge-secret-value',
  ASSETS,
};

/* Stripe's scheme: HMAC-SHA256 over `<timestamp>.<raw body>`, hex. Built here
   with node's crypto rather than reusing the Worker's own hmac(), so a broken
   implementation cannot sign its own homework. */
function stripeSig(body, secret, tsSeconds) {
  const ts = tsSeconds === undefined ? Math.floor(Date.now() / 1000) : tsSeconds;
  const mac = crypto.createHmac('sha256', secret).update(ts + '.' + body).digest('hex');
  return { header: 't=' + ts + ',v1=' + mac, ts };
}

function hookRequest(body, header) {
  const h = { 'Content-Type': 'application/json' };
  if (header !== null) h['Stripe-Signature'] = header;
  return new Request('https://servecleaning.com/api/stripe-webhook',
    { method: 'POST', headers: h, body });
}

/* Apps Script accepts the write unless a test says otherwise. */
const acceptWrite = async () => new Response('{"ok":true,"applied":true}', { status: 200 });

/** Fire one event at the Worker and report what reached Apps Script. */
async function deliver(event, opts) {
  const o = opts || {};
  const body   = typeof event === 'string' ? event : JSON.stringify(event);
  const secret = o.secret || PENV.STRIPE_WEBHOOK_SECRET;
  const sig    = o.header !== undefined ? o.header
               : stripeSig(o.signBody === undefined ? body : o.signBody, secret, o.ts).header;

  const { worker, logs, fetches } = loadWorker(o.upstream || acceptWrite);
  const res  = await worker.fetch(hookRequest(body, sig), o.env || PENV);
  const text = await res.text();
  let out = {}; try { out = JSON.parse(text); } catch (_) { /* non-JSON is a result too */ }

  const writes = fetches.filter(f => f.target.includes('/macros/'));
  return {
    status: res.status, body: out, logs, fetches, writes,
    /* What the bridge was actually told, parsed. */
    wrote: writes.length ? JSON.parse(writes[0].init.body) : null,
  };
}

/* ============================================================ */
(async function run() {

console.log('=== 1. THE SIGNATURE IS THE WHOLE SECURITY MODEL ===');
{
  const event = { type: 'payment_intent.succeeded',
    data: { object: { object: 'payment_intent', id: 'pi_1', amount: 23900,
                      metadata: { job_id: 'SRV-1' } } } };

  const good = await deliver(event);
  t('a correctly signed event is accepted', good.status === 200 && good.body.ok === true, good.body);
  t('and only then does anything reach the sheet', good.writes.length === 1, good.writes.length);

  /* Each of these is a different way of not being Stripe, and every one of
     them must leave the sheet untouched. */
  const refusals = [
    ['no signature header at all',        { header: null }],
    ['an empty signature header',         { header: '' }],
    ['a header with no v1 digest',        { header: 't=' + Math.floor(Date.now()/1000) }],
    ['a header with no timestamp',        { header: 'v1=' + 'a'.repeat(64) }],
    ['a signature from the wrong secret',  { secret: 'whsec_someone_elses_secret' }],
    ['a plausible-looking forgery',        { header: 't=' + Math.floor(Date.now()/1000) + ',v1=' + 'a'.repeat(64) }],
  ];
  for (const [label, opts] of refusals) {
    const r = await deliver(event, opts);
    t('REFUSED — ' + label, r.status === 400 && r.body.error === 'bad_signature', r.body);
    t('   and nothing was written', r.writes.length === 0, r.writes.length);
  }

  /* THE BODY IS SIGNED, NOT THE EVENT. Swapping the job id after signing is
     the attack this actually stops: a real captured event for job A, replayed
     with the id changed to job B, would otherwise mark a stranger's booking
     paid. */
  const tampered = await deliver(
    JSON.stringify({ type: 'payment_intent.succeeded',
      data: { object: { object: 'payment_intent', id: 'pi_1', metadata: { job_id: 'SRV-VICTIM' } } } }),
    { signBody: JSON.stringify(event) });
  t('REFUSED — a body edited after signing', tampered.status === 400, tampered.body);
  t('   and the swapped job id never reached the sheet', tampered.writes.length === 0);

  /* Replay protection. Stripe's own default tolerance is five minutes. */
  const old = await deliver(event, { ts: Math.floor(Date.now() / 1000) - 3600 });
  t('REFUSED — an hour-old event is a replay, not news', old.status === 400, old.body);
  const future = await deliver(event, { ts: Math.floor(Date.now() / 1000) + 3600 });
  t('REFUSED — and so is one from the future', future.status === 400, future.body);
  const edge = await deliver(event, { ts: Math.floor(Date.now() / 1000) - 60 });
  t('but a minute of clock drift is fine', edge.status === 200, edge.body);

  /* Stripe sends two v1 digests while a signing secret is being rotated.
     Rejecting the pair would take payments offline during the rotation. */
  const body = JSON.stringify(event);
  const mine = stripeSig(body, PENV.STRIPE_WEBHOOK_SECRET);
  const rotated = await deliver(event,
    { header: mine.header + ',v1=' + 'b'.repeat(64) });
  t('a rotation pair is accepted when ONE digest matches', rotated.status === 200, rotated.body);

  const neither = await deliver(event,
    { header: 't=' + mine.ts + ',v1=' + 'c'.repeat(64) + ',v1=' + 'b'.repeat(64) });
  t('and refused when neither does', neither.status === 400, neither.body);

  /* The signature check must not be skippable by leaving a secret unset —
     that would turn a misconfiguration into an open endpoint. */
  const unconfigured = await deliver(event,
    { env: Object.assign({}, PENV, { STRIPE_WEBHOOK_SECRET: undefined }) });
  t('with no signing secret the route REFUSES rather than trusting',
    unconfigured.status === 503 && unconfigured.writes.length === 0, unconfigured.body);
  const noBridge = await deliver(event,
    { env: Object.assign({}, PENV, { PAYMENT_BRIDGE_SECRET: undefined }) });
  t('and with no bridge secret it refuses too, rather than writing unauthenticated',
    noBridge.status === 503 && noBridge.writes.length === 0, noBridge.body);
}

console.log('\n=== 2. WHAT EACH EVENT MEANS FOR A BOOKING ===');
{
  const pi = (type, extra) => ({ type,
    data: { object: Object.assign({ object: 'payment_intent', id: 'pi_9', amount: 23900,
                                    metadata: { job_id: 'SRV-7' } }, extra || {}) } });

  const cases = [
    ['checkout.session.completed',               'authorized'],
    ['payment_intent.amount_capturable_updated', 'authorized'],
    ['payment_intent.succeeded',                 'paid'],
    ['payment_intent.canceled',                  'released'],
    ['charge.refunded',                          'refunded'],
  ];
  for (const [type, expected] of cases) {
    const r = await deliver(pi(type));
    t(type + '  ->  ' + expected, r.wrote && r.wrote.state === expected,
      r.wrote && r.wrote.state);
  }

  /* THE DISTINCTION THE WHOLE FEATURE RESTS ON. A hold is not a charge, and
     an event that means "held" must never be written as "paid" — that is the
     line between telling a customer the truth and telling them their money is
     gone when it is not. */
  const held = await deliver(pi('payment_intent.amount_capturable_updated'));
  t('a HOLD is never recorded as paid', held.wrote.state !== 'paid', held.wrote.state);

  /* Everything else Stripe sends is acknowledged and ignored. Answering
     anything but 200 would have Stripe retrying routine noise for three days. */
  for (const noise of ['invoice.paid', 'customer.created', 'payout.paid', 'charge.succeeded']) {
    const r = await deliver(pi(noise));
    t('ignored, and acknowledged: ' + noise,
      r.status === 200 && r.body.ignored === noise && r.writes.length === 0, r.body);
  }

  /* The reconciliation handle differs by object shape, and getting it wrong
     means the cancellation path later voids nothing. */
  const sess = await deliver({ type: 'checkout.session.completed',
    data: { object: { object: 'checkout.session', id: 'cs_1', payment_intent: 'pi_from_session',
                      amount_total: 23900, metadata: { job_id: 'SRV-7' } } } });
  t('a session names its PaymentIntent, not its own id',
    sess.wrote.payment_ref === 'pi_from_session', sess.wrote.payment_ref);

  const chg = await deliver({ type: 'charge.refunded',
    data: { object: { object: 'charge', id: 'ch_1', payment_intent: 'pi_from_charge',
                      amount: 23900, metadata: { job_id: 'SRV-7' } } } });
  t('and so does a charge', chg.wrote.payment_ref === 'pi_from_charge', chg.wrote.payment_ref);

  const intent = await deliver(pi('payment_intent.succeeded'));
  t('a PaymentIntent names itself', intent.wrote.payment_ref === 'pi_9', intent.wrote.payment_ref);

  /* client_reference_id is the fallback when metadata is missing. */
  const viaRef = await deliver({ type: 'checkout.session.completed',
    data: { object: { object: 'checkout.session', id: 'cs_2', payment_intent: 'pi_2',
                      client_reference_id: 'SRV-FALLBACK', metadata: {} } } });
  t('a session with no metadata falls back to client_reference_id',
    viaRef.wrote.job_id === 'SRV-FALLBACK', viaRef.wrote.job_id);

  /* A payment that is genuinely not ours. 200, because retrying will not grow
     a job id, and no write because there is nothing to write to. */
  const orphan = await deliver({ type: 'payment_intent.succeeded',
    data: { object: { object: 'payment_intent', id: 'pi_x', metadata: {} } } });
  t('an event with no job id is acknowledged and ignored',
    orphan.status === 200 && orphan.writes.length === 0, orphan.body);
}

console.log('\n=== 3. THE BRIDGE CALL ITSELF ===');
{
  const r = await deliver({ type: 'payment_intent.succeeded',
    data: { object: { object: 'payment_intent', id: 'pi_5', amount: 23900,
                      metadata: { job_id: 'SRV-3' } } } });

  t('the write goes to the booking webhook', r.writes[0].target === WEBHOOK_URL, r.writes[0].target);
  t('as the payment_event action', r.wrote.event_type === 'payment_event', r.wrote.event_type);
  t('carrying the bridge secret, which is what authorises it upstream',
    r.wrote.bridge_token === 'bridge-secret-value', !!r.wrote.bridge_token);

  /* THE STRIPE KEY MUST NEVER LEAVE THE WORKER. Apps Script is deliberately
     not able to move money, and handing it the key would end that. */
  const everything = JSON.stringify(r.fetches);
  t('the Stripe secret key appears NOWHERE in anything sent upstream',
    !everything.includes('sk_test_fake_key_for_tests'), true);
  t('and neither does the signing secret',
    !everything.includes('whsec_fake_signing_secret'), true);

  /* Job, state, amount. Nothing about a person — the logging rule holds here
     exactly as it does everywhere else. */
  const logged = r.logs.join('\n');
  t('the log line names the job and the state', /SRV-3/.test(logged) && /paid/.test(logged), logged);
  t('and carries no card, no email and no address',
    !/@/.test(logged) && !/\d{4} ?\d{4} ?\d{4}/.test(logged), logged);
}

console.log('\n=== 4. A FAILED WRITE MUST BE RETRIED, NOT SWALLOWED ===');
{
  const event = { type: 'payment_intent.succeeded',
    data: { object: { object: 'payment_intent', id: 'pi_6', amount: 23900,
                      metadata: { job_id: 'SRV-4' } } } };

  /* Stripe retries a non-2xx with backoff for up to three days, which is a
     more durable queue than anything worth building here. A 200 on a failed
     write would lose the payment state permanently and silently. */
  const dead = await deliver(event, { upstream: async () => { throw new Error('ETIMEDOUT'); } });
  t('an unreachable sheet returns 500 so Stripe retries', dead.status === 500, dead.status);

  const refused = await deliver(event,
    { upstream: async () => new Response('{"ok":false,"error":"not_found"}', { status: 200 }) });
  t('an upstream refusal returns 500 too', refused.status === 500, refused.status);

  const garbage = await deliver(event,
    { upstream: async () => new Response('<html>Google says no</html>', { status: 200 }) });
  t('and so does an unreadable answer', garbage.status === 500, garbage.status);

  /* The rank guard declining is a SUCCESS — the row is already at least as
     advanced as the news. Retrying it forever would be wrong. */
  const stale = await deliver(event,
    { upstream: async () => new Response('{"ok":true,"applied":false,"reason":"stale"}', { status: 200 }) });
  t('but a deliberate no-change is a 200, not a retry', stale.status === 200, stale.status);
}

console.log('\n=== 5. THE ROUTE ITSELF ===');
{
  const { worker } = loadWorker(acceptWrite);
  const res = await worker.fetch(
    new Request('https://servecleaning.com/api/stripe-webhook', { method: 'GET' }), PENV);
  t('GET is refused — this is a webhook, not a page', res.status === 405, res.status);

  const big = await deliver('x'.repeat(300000));
  t('an oversized body is refused before it is hashed', big.status === 400, big.status);

  const empty = await deliver('');
  t('an empty body is refused', empty.status === 400, empty.status);

  const notJson = await deliver('not json at all');
  t('a signed but unparseable body is refused', notJson.status === 400, notJson.body);
}

console.log('\n=== 6. HEALTH REPORTS THE DANGEROUS COMBINATION ===');
{
  const { worker } = loadWorker(acceptWrite);
  const health = async env => (await (await worker.fetch(
    new Request('https://servecleaning.com/api/health'), env)).json());

  const full = await health(PENV);
  t('a fully wired Worker says it can record payments',
    full.can_charge === true && full.can_record_payments === true, full);

  /* THE COMBINATION WORTH ONE REQUEST TO SPOT: charging real cards while
     recording none of it. That is the state this whole file exists to keep the
     founder out of. */
  const halfWired = await health(Object.assign({}, PENV,
    { STRIPE_SECRET_KEY: 'sk_live_realmoney', STRIPE_WEBHOOK_SECRET: undefined }));
  t('a LIVE key with no write-back is visible as exactly that',
    halfWired.stripe_mode === 'LIVE' && halfWired.can_charge === true &&
    halfWired.can_record_payments === false, halfWired);

  t('and a live key is never quietly reported as test',
    halfWired.stripe_mode === 'LIVE', halfWired.stripe_mode);

  /* BOTH KINDS OF STRIPE SECRET KEY CARRY THE MODE. A standard key is
     `sk_test_`/`sk_live_`; a RESTRICTED key — the better practice, since it can
     be scoped to just what this Worker does — is `rk_test_`/`rk_live_`.
     Matching only `sk_test_` reported a restricted test key as LIVE. */
  const modeOf = async key => (await health(Object.assign({}, PENV,
    { STRIPE_SECRET_KEY: key }))).stripe_mode;

  t('a standard test key reads test',    await modeOf('sk_test_abc') === 'test');
  t('a standard live key reads LIVE',    await modeOf('sk_live_abc') === 'LIVE');
  t('a RESTRICTED test key reads test',  await modeOf('rk_test_abc') === 'test',
    await modeOf('rk_test_abc'));
  t('a RESTRICTED live key reads LIVE',  await modeOf('rk_live_abc') === 'LIVE');
  t('no key at all reads none',          await modeOf(undefined) === 'none');
  /* An unfamiliar key shape must never be assumed harmless. */
  t('and anything unrecognised reads LIVE, not test',
    await modeOf('something_else_entirely') === 'LIVE');

  const noValues = JSON.stringify(full);
  t('health still leaks no secret VALUE',
    !noValues.includes('whsec_fake_signing_secret') &&
    !noValues.includes('bridge-secret-value') &&
    !noValues.includes('sk_test_fake_key_for_tests'), true);
}

console.log('\n=== 7. A CANCELLED VISIT RELEASES ITS HOLD ===');
{
  /* Apps Script answers a cancellation and names the outstanding hold. The
     Worker is the only place that knows both the reply and the Stripe key. */
  const cancelReply = '{"ok":true,"job_id":"SRV-8","released":"released","payment_ref":"pi_held_42"}';

  function cancelWorker(reply) {
    const seen = { stripe: [] };
    const { worker, fetches } = loadWorker(async (target) => {
      if (String(target).includes('api.stripe.com')) {
        seen.stripe.push(String(target));
        return new Response('{"id":"pi_held_42","status":"canceled"}', { status: 200 });
      }
      return new Response(reply, { status: 200 });
    });
    return { worker, seen, fetches };
  }

  const waits = [];
  const ctx = { waitUntil: p => waits.push(p) };
  const cancelReq = () => new Request('https://servecleaning.com/api/portal', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event_type: 'portal_write', action: 'cancel', job_id: 'SRV-8' }) });

  {
    const { worker, seen } = cancelWorker(cancelReply);
    const res  = await worker.fetch(cancelReq(), PENV, ctx);
    const body = await res.json();
    await Promise.all(waits);

    t('the hold is cancelled at Stripe', seen.stripe.length === 1, seen.stripe);
    t('and it is the RIGHT intent that gets voided',
      /payment_intents\/pi_held_42\/cancel/.test(seen.stripe[0] || ''), seen.stripe[0]);

    /* The customer's page has no use for an internal Stripe handle, and view
       models are whitelists — a field reaches a browser on purpose or not at
       all. This one is used and dropped. */
    t('payment_ref NEVER reaches the browser', body.payment_ref === undefined, body);
    t('but the cancellation itself is passed through intact',
      body.ok === true && body.job_id === 'SRV-8' && body.released === 'released', body);
  }

  {
    /* No hold named — a booking that was never authorized, or one already
       captured, which Apps Script deliberately does not name because taking
       money back is a human's decision. */
    const { worker, seen } = cancelWorker('{"ok":true,"job_id":"SRV-9","released":"released"}');
    const res = await worker.fetch(cancelReq(), PENV, ctx);
    await res.json();
    await Promise.all(waits);
    t('a cancellation naming no hold touches Stripe not at all', seen.stripe.length === 0, seen.stripe);
  }

  {
    /* A hold release can only ever FREE money, never take it — so the worst
       case is the hold lingering exactly as long as it did before this
       existed. It must never fail the cancellation the customer was told
       succeeded. */
    const { worker } = loadWorker(async (target) => {
      if (String(target).includes('api.stripe.com')) throw new Error('stripe is down');
      return new Response(cancelReply, { status: 200 });
    });
    const res  = await worker.fetch(cancelReq(), PENV, ctx);
    const body = await res.json();
    await Promise.all(waits);
    t('a failed release still leaves the visit cancelled',
      res.status === 200 && body.ok === true, body);
    t('and still does not leak the handle', body.payment_ref === undefined, body);
  }

  {
    /* Anything that is not a PaymentIntent id must not be pasted into a Stripe
       URL. Apps Script is trusted, but the guard costs one regex. */
    const { worker, seen } = cancelWorker(
      '{"ok":true,"payment_ref":"../../v1/charges/ch_evil"}');
    await (await worker.fetch(cancelReq(), PENV, ctx)).json();
    await Promise.all(waits);
    t('a ref that is not a pi_ id is never sent to Stripe', seen.stripe.length === 0, seen.stripe);
  }

  {
    /* A normal portal read must not be slowed or altered by any of this. */
    const { worker, seen } = cancelWorker('{"ok":true,"view":"portal","bookings":[]}');
    const res  = await worker.fetch(cancelReq(), PENV, ctx);
    const body = await res.json();
    await Promise.all(waits);
    t('an ordinary portal write passes through untouched',
      body.view === 'portal' && seen.stripe.length === 0, body);
  }
}

/* ============================================================
   HARNESS 2 — the Apps Script side: the rank guard
   ============================================================ */
console.log('\n=== 8. THE RANK GUARD — a late event must not undo a capture ===');
{
  const GS = fs.readFileSync(path.join(REPO_ROOT, 'apps-script', 'webhook.gs'), 'utf8');

  const HEADERS = ['job_id', 'quoted_price', 'payment_status', 'payment_ref', 'job_status'];

  function sheet(rows) {
    const data = [HEADERS.slice()].concat(rows.map(r => r.slice()));
    return { _rows: data,
      getName: () => 'JOBS',
      getLastRow: () => data.length,
      getLastColumn: () => HEADERS.length,
      getDataRange: () => ({ getValues: () => data.map(r => r.slice()) }),
      getRange: (r, c, nr, nc) => ({
        getValues: () => { const o = []; for (let i = 0; i < (nr || 1); i++) {
          const row = data[r - 1 + i] || []; o.push(row.slice(c - 1, c - 1 + (nc || 1))); } return o; },
        getValue: () => { const row = data[r - 1] || []; return row[c - 1] === undefined ? '' : row[c - 1]; },
        setValue: v => { while (data[r - 1].length < c) data[r - 1].push(''); data[r - 1][c - 1] = v; },
      }) };
  }

  function build(rows, props) {
    const jobs = sheet(rows);
    const logs = [];
    const store = Object.assign({ PAYMENT_BRIDGE_SECRET: 'bridge-secret-value' }, props || {});
    const ssObj = { getSheetByName: n => (n === 'JOBS' ? jobs : null),
                    insertSheet: () => { throw new Error('should not create tabs'); },
                    getSheets: () => [jobs] };
    const sandbox = {
      console: { log: m => logs.push(String(m)), warn: m => logs.push(String(m)),
                 error: m => logs.push(String(m)) },
      SpreadsheetApp: { openById: () => ssObj, getActiveSpreadsheet: () => ssObj },
      ContentService: { MimeType: { JSON: 'json' },
        createTextOutput: s => ({ getContent: () => s, setMimeType() { return this; } }) },
      MailApp: { sendEmail() {} },
      LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
      Session: { getScriptTimeZone: () => 'America/New_York',
                 getEffectiveUser: () => ({ getEmail: () => 'ops@example.com' }) },
      PropertiesService: { getScriptProperties: () => ({
        getProperty: k => (k in store ? store[k] : null),
        setProperty: (k, v) => { store[k] = String(v); } }) },
      Utilities: { getUuid: () => crypto.randomUUID(),
        formatDate: d => String(d),
        computeHmacSha256Signature: (v, k) =>
          [...crypto.createHmac('sha256', String(k)).update(String(v)).digest()]
            .map(b => (b > 127 ? b - 256 : b)) },
    };
    vm.createContext(sandbox);
    vm.runInContext(GS, sandbox);
    const send = p => JSON.parse(
      sandbox.doPost({ postData: { contents: JSON.stringify(
        Object.assign({ event_type: 'payment_event',
                        bridge_token: 'bridge-secret-value' }, p)) } }).getContent());
    const statusOf = id => {
      const row = jobs._rows.find(r => r[0] === id) || [];
      return { status: row[2], ref: row[3] };
    };
    return { send, statusOf, jobs, logs };
  }

  const ROWS = [['SRV-1', 239, '', '', 'new']];

  /* ---- the ordinary progression ---- */
  {
    const B = build(ROWS);
    t('a blank cell accepts a hold',
      B.send({ job_id: 'SRV-1', state: 'authorized', payment_ref: 'pi_a' }).applied === true);
    t('and the row now reads authorized', B.statusOf('SRV-1').status === 'authorized',
      B.statusOf('SRV-1'));
    t('with the PaymentIntent recorded beside it', B.statusOf('SRV-1').ref === 'pi_a',
      B.statusOf('SRV-1').ref);

    t('a hold is then captured',
      B.send({ job_id: 'SRV-1', state: 'paid', payment_ref: 'pi_a' }).applied === true);
    t('and the row reads paid', B.statusOf('SRV-1').status === 'paid');
  }

  /* ---- THE ONE THAT MATTERS ----
     Stripe retries for days and promises no order, so amount_capturable_updated
     CAN arrive after succeeded. Written naively that turns a captured payment
     back into a mere hold — and re-offers the Authorize button to somebody who
     has already been charged. */
  {
    const B = build([['SRV-1', 239, 'paid', 'pi_a', 'new']]);
    const out = B.send({ job_id: 'SRV-1', state: 'authorized', payment_ref: 'pi_a' });
    t('a LATE hold event cannot undo a capture',
      out.applied === false && out.reason === 'stale', out);
    t('and the row still reads paid', B.statusOf('SRV-1').status === 'paid',
      B.statusOf('SRV-1').status);
  }

  /* ---- the two legitimate downgrades ---- */
  {
    const B = build([['SRV-1', 239, 'authorized', 'pi_a', 'new']]);
    t('a voided hold IS recorded',
      B.send({ job_id: 'SRV-1', state: 'released' }).applied === true);
    t('and the booking is back to needing authorization',
      B.statusOf('SRV-1').status === 'released', B.statusOf('SRV-1').status);
  }
  {
    const B = build([['SRV-1', 239, 'paid', 'pi_a', 'new']]);
    t('a refund IS recorded over a capture',
      B.send({ job_id: 'SRV-1', state: 'refunded' }).applied === true);
    t('and the row reads refunded', B.statusOf('SRV-1').status === 'refunded');
  }
  {
    /* A released hold is worth exactly as much as a blank one — the customer
       can authorize again and that must go through. */
    const B = build([['SRV-1', 239, 'released', 'pi_a', 'new']]);
    t('re-authorizing after a release works',
      B.send({ job_id: 'SRV-1', state: 'authorized', payment_ref: 'pi_b' }).applied === true);
    t('and the new intent replaces the old', B.statusOf('SRV-1').ref === 'pi_b',
      B.statusOf('SRV-1').ref);
  }

  /* ---- the bridge secret ---- */
  {
    const B = build(ROWS);
    const nope = B.send({ job_id: 'SRV-1', state: 'paid', bridge_token: 'wrong-secret' });
    t('a wrong bridge secret writes nothing', nope.ok === false, nope);
    t('and the row is untouched', B.statusOf('SRV-1').status === '', B.statusOf('SRV-1'));
    t('and it is told only "not_found" — never which part was wrong',
      nope.error === 'not_found', nope.error);
  }
  {
    const B = build(ROWS, { PAYMENT_BRIDGE_SECRET: null });
    const nope = B.send({ job_id: 'SRV-1', state: 'paid' });
    t('an UNCONFIGURED bridge refuses rather than accepting anyone',
      nope.ok === false && B.statusOf('SRV-1').status === '', nope);
  }

  /* ---- bad input ---- */
  {
    const B = build(ROWS);
    t('an unknown state is refused',
      B.send({ job_id: 'SRV-1', state: 'definitely_paid_trust_me' }).error === 'bad_state');
    t('an empty state is refused', B.send({ job_id: 'SRV-1', state: '' }).error === 'bad_state');
    t('and the row survived both', B.statusOf('SRV-1').status === '', B.statusOf('SRV-1'));

    const unknown = B.send({ job_id: 'SRV-NOPE', state: 'paid' });
    t('a payment for a job this sheet has never heard of is NOT a retryable failure',
      unknown.ok === true && unknown.applied === false, unknown);
  }

  /* ---- an operator's hand-typed value ---- */
  {
    /* Ops typing "paid" for a customer who paid by check still works, and
       Stripe must not undo it. The two sources coexist. */
    const B = build([['SRV-1', 239, 'PAID', 'pi_a', 'new']]);
    const out = B.send({ job_id: 'SRV-1', state: 'authorized' });
    t('a hand-typed PAID outranks a late hold, case and all',
      out.applied === false, out);

    /* But a typo must not outrank real news from Stripe. */
    const C = build([['SRV-1', 239, 'pending?', '', 'new']]);
    t('while an unrecognised scribble does not block a real payment',
      C.send({ job_id: 'SRV-1', state: 'paid' }).applied === true);
    t('and the cell now holds a value the code understands',
      C.statusOf('SRV-1').status === 'paid', C.statusOf('SRV-1').status);
  }

  /* ---- the optional column ---- */
  {
    /* payment_ref is a convenience. Refusing to record a payment because a
       nice-to-have column is missing would be the wrong trade — the state is
       what a customer sees. */
    const jobsNoRef = ['job_id', 'quoted_price', 'payment_status', 'job_status'];
    const saved = HEADERS.slice();
    HEADERS.length = 0; jobsNoRef.forEach(h => HEADERS.push(h));
    const B = build([['SRV-1', 239, '', 'new']]);
    const out = B.send({ job_id: 'SRV-1', state: 'paid', payment_ref: 'pi_a' });
    t('a sheet with no payment_ref column still records the payment',
      out.applied === true, out);
    t('and says so in the log rather than failing',
      B.logs.some(l => /payment_ref/.test(l)), B.logs.slice(-3));
    HEADERS.length = 0; saved.forEach(h => HEADERS.push(h));
  }
}

console.log('\n' + (bad ? 'FAILURES: ' + bad : 'all payment checks passed'));
process.exit(bad ? 1 : 0);
})();
