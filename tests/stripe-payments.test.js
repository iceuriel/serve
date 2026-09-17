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

console.log('\n=== 2b. THE ROUND TRIP — what /api/checkout ASKS FOR is what the events CARRY ===');
{
  /* THE BUG THIS SECTION EXISTS FOR, found in production 2026-09-16.
     Section 2 above hand-builds PaymentIntent events carrying metadata and
     proves the handler reads it. That proved the handler right about a message
     Stripe was never going to send: /api/checkout set `metadata[job_id]` on
     the CHECKOUT SESSION, and metadata does NOT propagate from a session to
     the PaymentIntent it creates. Four of the five subscribed events carry a
     PaymentIntent or a charge, so four of five arrived with no job id —
     INCLUDING payment_intent.succeeded, which is the capture. The founder
     captured, the money moved, and the portal never found out.

     So this asserts the two halves against each other instead of separately. */
  const { worker, fetches } = loadWorker(async (target) => {
    if (String(target).includes('api.stripe.com')) {
      return new Response(JSON.stringify(
        { id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true, view: 'portal', bookings: [
      { bookingId: 'SRV-1', price: 239, serviceLabel: 'First clean',
        date: '2026-10-01', paid: false, completed: '' }] }), { status: 200 });
  });

  await worker.fetch(new Request('https://servecleaning.com/api/checkout', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ job_id: 'SRV-1', contact_id: 'CON-1',
                           t: 'a-token-long-enough-to-pass' }) }), PENV);

  const form = new URLSearchParams(
    fetches.find(f => f.target.includes('api.stripe.com')).init.body);

  t('the SESSION carries the job id', form.get('metadata[job_id]') === 'SRV-1');
  /* The one that was missing. */
  t('and so does the PAYMENTINTENT the session creates',
    form.get('payment_intent_data[metadata][job_id]') === 'SRV-1',
    form.get('payment_intent_data[metadata][job_id]'));
  t('the contact id is set in both places too',
    form.get('metadata[contact_id]') === 'CON-1' &&
    form.get('payment_intent_data[metadata][contact_id]') === 'CON-1',
    form.get('payment_intent_data[metadata][contact_id]'));

  /* NOW FEED THE WEBHOOK AN EVENT SHAPED THE WAY STRIPE ACTUALLY SENDS IT —
     a PaymentIntent whose metadata is whatever /api/checkout asked for, and
     NOT what it set on the session. If those two ever drift apart again, the
     capture stops reaching the sheet and this goes red. */
  const piMetadata = {};
  for (const [k, v] of form.entries()) {
    const m = k.match(/^payment_intent_data\[metadata\]\[(.+)\]$/);
    if (m) piMetadata[m[1]] = v;
  }

  for (const type of ['payment_intent.succeeded',
                      'payment_intent.amount_capturable_updated',
                      'payment_intent.canceled']) {
    const r = await deliver({ type, data: { object: {
      object: 'payment_intent', id: 'pi_real', amount: 23900,
      metadata: piMetadata } } });
    t(type + ' finds its booking',
      r.wrote && r.wrote.job_id === 'SRV-1', r.body);
  }

  /* A refunded charge inherits the PaymentIntent's metadata, so it rides on
     the same fix. */
  const refund = await deliver({ type: 'charge.refunded', data: { object: {
    object: 'charge', id: 'ch_real', payment_intent: 'pi_real',
    amount: 23900, metadata: piMetadata } } });
  t('charge.refunded finds it too', refund.wrote && refund.wrote.job_id === 'SRV-1', refund.body);

  /* And the session event, which was the only one that ever worked. */
  const sessMeta = {};
  for (const [k, v] of form.entries()) {
    const m = k.match(/^metadata\[(.+)\]$/);
    if (m) sessMeta[m[1]] = v;
  }
  const sess = await deliver({ type: 'checkout.session.completed', data: { object: {
    object: 'checkout.session', id: 'cs_1', payment_intent: 'pi_real',
    amount_total: 23900, metadata: sessMeta } } });
  t('checkout.session.completed finds it', sess.wrote && sess.wrote.job_id === 'SRV-1', sess.body);

  t('ALL FIVE subscribed events can reach a booking', true);
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

  /* THE REASON MUST REACH STRIPE'S EVENT DELIVERIES TAB. The causes of a
     failed write need opposite fixes and are indistinguishable from outside;
     Stripe shows the response body of every attempt, so putting the reason
     there is what makes the founder's own dashboard a diagnostic. */
  t('and the 500 NAMES the cause, for the dashboard to show',
    refused.body.reason === 'not_found', refused.body);
  /* An unreachable upstream and a refusal need OPPOSITE fixes — one is the
     bridge secret, the other is Apps Script being cold or locked — so the two
     reasons must not read alike. `relay` reports a thrown fetch as the error
     itself and a blown budget as "timeout after Nms"; both are distinct from
     an upstream that answered and said no. */
  t('an unreachable sheet reads differently from a refusal',
    dead.body.reason && dead.body.reason !== refused.body.reason,
    { dead: dead.body.reason, refused: refused.body.reason });
  t('and names the transport failure rather than inventing a verdict',
    /ETIMEDOUT/.test(String(dead.body.reason)), dead.body.reason);

  const httpErr = await deliver(event,
    { upstream: async () => new Response('nope', { status: 503 }) });
  t('an unhappy /exec deployment reads as an HTTP status',
    /HTTP 503/.test(String(httpErr.body.reason)), httpErr.body.reason);

  /* Everything in that field is a short machine string about our own
     plumbing — never a customer, an amount, or a credential. */
  t('the reason carries nothing about a person or a secret',
    !/@|bridge-secret-value|whsec_|sk_test_/.test(
      String(refused.body.reason) + String(dead.body.reason)), true);

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
    t('and says so in the log, where only we can see it',
      B.logs.some(l => /not set/.test(l)), B.logs.slice(-2));
    t('but tells the CALLER nothing but not_found',
      nope.error === 'not_found' && nope.reason === undefined, nope);
  }

  /* r51. THE BUG THAT COST A LIVE DEBUGGING SESSION on 2026-09-16.
     Script Properties is a web form. A secret pasted into it arrives with a
     trailing space or newline more often than not, Google stores it verbatim,
     and an exact comparison then fails forever against a Cloudflare secret
     that is character-for-character identical on screen. The symptom was 500s
     in Stripe and a payment_status that never moved. */
  {
    const B = build(ROWS, { PAYMENT_BRIDGE_SECRET: 'bridge-secret-value\n' });
    t('a secret stored with a trailing newline still matches',
      B.send({ job_id: 'SRV-1', state: 'authorized' }).applied === true);
  }
  {
    const B = build(ROWS, { PAYMENT_BRIDGE_SECRET: '  bridge-secret-value  ' });
    t('and one stored with surrounding spaces matches too',
      B.send({ job_id: 'SRV-1', state: 'authorized' }).applied === true);
  }
  {
    const B = build(ROWS);
    t('a token OFFERED with stray whitespace matches as well',
      B.send({ job_id: 'SRV-1', state: 'authorized',
               bridge_token: ' bridge-secret-value\n' }).applied === true);
  }
  {
    /* Trimming must not become "close enough". Whitespace INSIDE the secret is
       a different string and stays refused. */
    const B = build(ROWS, { PAYMENT_BRIDGE_SECRET: 'bridge secret value' });
    const nope = B.send({ job_id: 'SRV-1', state: 'paid' });
    t('but internal whitespace is still a DIFFERENT secret',
      nope.ok === false && B.statusOf('SRV-1').status === '', nope);
    t('and a mismatch is logged with LENGTHS, never the values',
      B.logs.some(l => /mismatch/.test(l)) &&
      !B.logs.some(l => /bridge-secret-value/.test(l)), B.logs.slice(-2));
  }
  {
    const B = build(ROWS);
    t('a wholly wrong token of the SAME length is still refused',
      B.send({ job_id: 'SRV-1', state: 'paid',
               bridge_token: 'X'.repeat('bridge-secret-value'.length) }).ok === false);
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

console.log('\n=== 9. TEST MONEY AND REAL MONEY MUST NOT BE CONFUSED ===');
{
  /* GOING LIVE IS TWO SECRET SWAPS, NOT ONE. Stripe's test and live modes are
     separate worlds: separate keys, separate webhook endpoints, separate
     signing secrets. A half-done swap is not a broken request — the leftover
     endpoint keeps delivering events that verify PERFECTLY, because they really
     are from our account. The signature cannot catch this. Only `livemode` can.

     WHY THE FIXTURES BELOW SET `livemode` EXPLICITLY. Every other event in this
     file omits it, and that is the 2026-09-16 trap in miniature: a suite is no
     more honest than its fixtures, and a hand-built event that omits a field
     REAL STRIPE ALWAYS SENDS can only ever confirm whatever the code assumed.
     So each case here states the mode on purpose, and the last pair pins what
     happens to an event that carries no mode at all. */
  const LIVE_KEY = Object.assign({}, PENV, { STRIPE_SECRET_KEY: 'sk_live_realmoney' });

  const paidEvent = live => ({
    type: 'payment_intent.succeeded', livemode: live,
    data: { object: { object: 'payment_intent', id: 'pi_9', amount: 23900,
                      metadata: { job_id: 'SRV-REAL' } } },
  });

  /* ---- the dangerous direction: play money marking a real booking paid ---- */
  {
    const r = await deliver(paidEvent(false), { env: LIVE_KEY });
    t('a TEST event on a LIVE key writes NOTHING', r.writes.length === 0, r.writes.length);
    t('   and says which mismatch it was',
      r.body.ignored === 'test_event_on_live_key', r.body);
    /* 200, not 500. A retry cannot change the mode an event was born in, and
       three days of them would bury the real deliveries in the dashboard. */
    t('   answered 200 so Stripe stops rather than retrying for three days',
      r.status === 200, r.status);
    t('   and the reason is in the log for whoever goes looking',
      r.logs.some(l => /TEST Stripe event refused on a LIVE key/.test(l)), r.logs.slice(-3));
  }

  /* ---- the other direction, which must behave in the OPPOSITE way ---- */
  {
    /* The money is real. Refusing to record it over a configuration smell is
       exactly the bug this whole file exists to prevent, just reached by a
       different road — a customer who has paid, told they have not. */
    const r = await deliver(paidEvent(true), { env: PENV });
    t('a LIVE event on a test key IS still recorded — the money is real',
      r.writes.length === 1 && r.status === 200, r.body);
    t('   with the true state, not a softened one',
      r.wrote && r.wrote.state === 'paid', r.wrote);
    t('   and the misconfiguration is shouted into the log',
      r.logs.some(l => /LIVE Stripe event arrived while STRIPE_SECRET_KEY reads test/.test(l)),
      r.logs.slice(-3));
  }

  /* ---- the matched pairs, which must be entirely ordinary ---- */
  {
    const liveOnLive = await deliver(paidEvent(true), { env: LIVE_KEY });
    t('a LIVE event on a LIVE key is just a payment', liveOnLive.writes.length === 1, liveOnLive.body);
    const testOnTest = await deliver(paidEvent(false), { env: PENV });
    t('a test event on a test key is just a payment', testOnTest.writes.length === 1, testOnTest.body);
    t('   and neither matched pair logs a mismatch',
      !liveOnLive.logs.concat(testOnTest.logs).some(l => /mismatch|refused on a LIVE key/.test(l)),
      liveOnLive.logs.concat(testOnTest.logs).slice(-4));
  }

  /* ---- no mode at all is not a third case to invent handling for ---- */
  {
    const noMode = await deliver(paidEvent(undefined), { env: LIVE_KEY });
    t('an event carrying no livemode is recorded, not guessed at',
      noMode.writes.length === 1, noMode.body);
  }

  /* ---- and the check must not become a way to skip the signature ---- */
  {
    const forged = await deliver(paidEvent(false),
      { env: LIVE_KEY, secret: 'whsec_someone_elses_secret' });
    t('an UNSIGNED test-mode event is refused as a forgery, not as a mode slip',
      forged.status === 400 && forged.body.error === 'bad_signature', forged.body);
  }

  /* ---- the rejection body is the founder's diagnostic ---- */
  {
    /* r51 turned Stripe's Event deliveries tab into the diagnostic for a failed
       WRITE. This does the same for a failed SIGNATURE, because the likeliest
       cause on go-live day is a live endpoint added without swapping
       STRIPE_WEBHOOK_SECRET — and /api/health cannot see it. `can_record_
       payments` knows only that A secret is bound, never that it is the RIGHT
       one, so without this the symptom is silent 400s and portals that never
       notice a real payment. */
    const r = await deliver(paidEvent(true), { secret: 'whsec_wrong_one' });
    t('a rejected signature names the cause worth checking first',
      /STRIPE_WEBHOOK_SECRET/.test(r.body.hint || ''), r.body);
    t('   and still refuses, with nothing written',
      r.status === 400 && r.writes.length === 0, r.status);

    /* The hint must stay IDENTICAL across rejections. A body that varies is a
       free oracle for whoever is probing — the exact thing the original comment
       refused to give up, and it must not be given up here by accident. */
    const other = await deliver(paidEvent(true),
      { header: 't=' + Math.floor(Date.now() / 1000) + ',v1=' + 'a'.repeat(64) });
    t('   and every rejection says the SAME thing, separating no cases',
      JSON.stringify(other.body) === JSON.stringify(r.body), [r.body, other.body]);

    const shown = JSON.stringify(r.body);
    t('   while naming no secret VALUE, only a binding',
      !/whsec_|sk_live_|sk_test_|bridge-secret-value/.test(shown), shown);
  }
}

console.log('\n' + (bad ? 'FAILURES: ' + bad : 'all payment checks passed'));
process.exit(bad ? 1 : 0);
})();
