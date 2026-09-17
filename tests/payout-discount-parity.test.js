/* ============================================================
   THE PAYOUT SHARE AND THE DISCOUNT ARE ONE RULE IN TWO LANGUAGES
   Added 2026-09-16
   ============================================================

   Serve's cut is 15%. The first-clean discount is 50%. A 50% discount cannot
   be funded out of a 15% margin, so the half-price first clean pays the
   partner a different share — 0.98 rather than 0.85 — and the recurring visits
   that follow earn it back.

   WHICH MEANS TWO SEPARATE PIECES OF CODE HAVE TO AGREE ABOUT ONE QUESTION:
   "did this booking get the half price?"

     - pricing-engine.js decides it for the CUSTOMER  (`discountApplies`)
     - apps-script/webhook.gs decides it for the PARTNER (`payoutRateFor`)

   Apps Script cannot require() the engine, so the rule is genuinely written
   twice. If the two copies ever drift, nothing breaks loudly: the customer is
   charged half price while the partner is paid 85% of that half — Serve keeps
   its margin and the cleaning company silently absorbs the whole discount. No
   error, no failed write, no log line. Just a partner being underpaid on a
   class of job until somebody notices.

   SO THIS TEST DRIVES BOTH HALVES AND ASSERTS THEM AGAINST EACH OTHER, which
   is the lesson from the Stripe-metadata bug in HANDOFF: fixtures written from
   the same assumption as the code can only ever confirm it. Nothing here
   hardcodes which homes are half price. The engine is asked, the webhook is
   asked, and the two answers must match on every home in the grid.

   Break either copy of the rule — change the bedroom threshold on one side,
   drop the `heavy` check, route the recurring stamp through payoutRateFor —
   and this goes red naming the exact home that disagrees.
   ============================================================ */

const path = require('path');
const fs   = require('fs');
const vm   = require('vm');

const REPO_ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(REPO_ROOT, 'apps-script', 'webhook.gs'), 'utf8');

const { computeQuote, PRICING } = require(path.join(REPO_ROOT, 'pricing-engine.js'));

let bad = 0;
function t(label, ok, detail) {
  if (!ok) bad++;
  console.log((ok ? '  ok   ' : '  FAIL ') + label +
              (detail !== undefined ? '   ' + JSON.stringify(detail) : ''));
}

/* ------------------------------------------------------------
   The webhook, loaded with just enough of Apps Script to reach payoutRateFor.

   opsBook() is DELIBERATELY NOT STUBBED. readPayoutRate wraps its lookup and
   falls back to the code default on any failure, so an absent Ops workbook
   exercises exactly the path a real request takes when SETTINGS has no such
   row — which is the state the founder's sheet is in until they add one.
   ------------------------------------------------------------ */
const logs = [];
const sandbox = {
  console: { log: m => logs.push(String(m)),
             warn: m => logs.push('WARN ' + m),
             error: m => logs.push('ERR ' + m) },
  SpreadsheetApp: { openById: () => { throw new Error('no workbook in this harness'); },
                    getActiveSpreadsheet: () => { throw new Error('no workbook in this harness'); } },
  ContentService: { MimeType: { JSON: 'json' },
    createTextOutput: s => ({ getContent: () => s, setMimeType() { return this; } }) },
  MailApp: { sendEmail: () => {} },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  Session: { getScriptTimeZone: () => 'America/New_York',
             getEffectiveUser: () => ({ getEmail: () => 'ops@example.com' }) },
  PropertiesService: (() => {
    const store = {};
    return { getScriptProperties: () => ({
      getProperty: k => (k in store ? store[k] : null),
      setProperty: (k, v) => { store[k] = String(v); },
    }) };
  })(),
  Utilities: {
    formatDate: () => '',
    getUuid: () => require('crypto').randomUUID(),
    computeHmacSha256Signature: () => [],
  },
};
vm.createContext(sandbox);
vm.runInContext(SRC, sandbox);

console.log('=== 1. both halves are actually reachable ===');
t('the engine exposes computeQuote', typeof computeQuote === 'function');
t('the webhook exposes payoutRateFor', typeof sandbox.payoutRateFor === 'function');
t('and the two shares it picks between',
  typeof sandbox.currentPayoutRate === 'function' &&
  typeof sandbox.currentPayoutRateFirstClean === 'function');

const ORDINARY   = sandbox.currentPayoutRate();
const PASSTHROUGH = sandbox.currentPayoutRateFirstClean();

t('the ordinary share is 85% — Serve keeps 15%', ORDINARY === 0.85, ORDINARY);
t('the half-price share is 98% — Serve keeps 2%', PASSTHROUGH === 0.98, PASSTHROUGH);
t('and they are genuinely different, or this whole file proves nothing',
  PASSTHROUGH > ORDINARY, [ORDINARY, PASSTHROUGH]);

/* ------------------------------------------------------------
   2. THE PARITY GRID — the point of the file.
   ------------------------------------------------------------ */
console.log('\n=== 2. the engine and the webhook agree on every home ===');

const ZIPS       = ['02134', '02210', '02155', '99999'];   // core, premium, extended, unknown
const SERVICES   = ['first_clean', 'move_out'];
const CONDITIONS = ['light', 'standard', 'heavy'];
const BEDROOMS   = [0, 1, 2, 3, 4];
const LEVELS     = [1, 2];

const disagreements = [];
const seen = { passthrough: 0, ordinary: 0 };

for (const zip of ZIPS) {
  for (const service of SERVICES) {
    for (const condition of CONDITIONS) {
      for (const bedrooms of BEDROOMS) {
        for (const levels of LEVELS) {
          const home = { zip, bedrooms, bathrooms: 2, levels, condition, service };

          /* What the CUSTOMER is charged, from the engine. */
          const q = computeQuote(Object.assign({ frequency: 'biweekly' }, home));

          /* What the PARTNER is paid, from the webhook — driven through the
             payload the browser actually sends, field names included, so a
             renamed field fails here rather than in production. */
          const rate = sandbox.payoutRateFor({
            zip:       String(zip),
            bedrooms:  bedrooms,
            bathrooms: 2,
            levels:    levels,
            condition: condition,
            service:   service,
          });

          const enginesSaysHalfPrice  = q.discountApplies;
          const webhookSaysPassthrough = rate === PASSTHROUGH;

          if (enginesSaysHalfPrice !== webhookSaysPassthrough) {
            disagreements.push({ home, engine: enginesSaysHalfPrice,
                                 webhook: webhookSaysPassthrough, rate });
          }
          if (webhookSaysPassthrough) seen.passthrough++; else seen.ordinary++;

          /* AND THE DISCOUNT IS REALLY THE ONE THE FLAG CLAIMS. `discountApplies`
             agreeing with the payout is worthless if the flag itself has come
             loose from the arithmetic. */
          const expectedFactor = enginesSaysHalfPrice
            ? PRICING.FIRST_CLEAN_FACTOR : PRICING.SECONDARY_FACTOR;
          if (q.discountFactor !== expectedFactor) {
            disagreements.push({ home, note: 'discountApplies disagrees with discountFactor',
                                 factor: q.discountFactor, expected: expectedFactor });
          }
        }
      }
    }
  }
}

const total = ZIPS.length * SERVICES.length * CONDITIONS.length * BEDROOMS.length * LEVELS.length;
t('the grid is big enough to be worth running', total >= 200, total);
t('BOTH outcomes actually occur in it — a grid that never sees a passthrough ' +
  'would pass while the feature was entirely broken',
  seen.passthrough > 0 && seen.ordinary > 0, seen);
t('the engine and the webhook agree on all ' + total + ' homes',
  disagreements.length === 0, disagreements.slice(0, 5));

/* ------------------------------------------------------------
   3. The specific cases that motivated the change.
   ------------------------------------------------------------ */
console.log('\n=== 3. the cases this was built for ===');

const rateFor = (o) => sandbox.payoutRateFor(Object.assign(
  { zip: '02134', bedrooms: 2, bathrooms: 1, levels: 1,
    condition: 'standard', service: 'first_clean' }, o));

t('an ordinary first clean is passed through at 98%',
  rateFor({}) === PASSTHROUGH, rateFor({}));
t('a move clean pays the ordinary 85% — it is discounted 15%, not 50%',
  rateFor({ service: 'move_out' }) === ORDINARY, rateFor({ service: 'move_out' }));
t('a 4BR heavy first clean pays the ordinary 85% — the no-stack rule put it on '
  + 'the 15% ticket, so there is nothing to pass through',
  rateFor({ bedrooms: 4, condition: 'heavy' }) === ORDINARY,
  rateFor({ bedrooms: 4, condition: 'heavy' }));
t('a 4BR that is NOT heavy still gets the passthrough',
  rateFor({ bedrooms: 4, condition: 'standard' }) === PASSTHROUGH);
t('a heavy home under 4BR still gets the passthrough',
  rateFor({ bedrooms: 3, condition: 'heavy' }) === PASSTHROUGH);

/* service_type is what the sheet column is called, and some callers send that
   name instead. Both spellings have to reach the same answer. */
t('service_type is accepted as well as service',
  sandbox.payoutRateFor({ service_type: 'move_out', bedrooms: 2, condition: 'standard' }) === ORDINARY);

/* THE PAYLOAD MUST NOT BE ABLE TO BUY ITSELF A BETTER RATE. */
console.log('\n=== 4. the rate cannot be talked out of Serve ===');
t('a payload claiming a discount on a move clean is ignored',
  sandbox.payoutRateFor({ service: 'move_out', bedrooms: 2, condition: 'standard',
                          discount_applied: 'First clean 50% off',
                          payout_rate: 1.0 }) === ORDINARY);
t('and one claiming the rate outright is ignored',
  sandbox.payoutRateFor({ service: 'move_out', payout_rate: 1.0,
                          payout_rate_first_clean: 1.0 }) === ORDINARY);
t('a junk service falls to the ordinary share rather than the generous one',
  sandbox.payoutRateFor({ service: 'FIRST_CLEAN' }) === ORDINARY &&
  sandbox.payoutRateFor({}) === ORDINARY,
  [sandbox.payoutRateFor({ service: 'FIRST_CLEAN' }), sandbox.payoutRateFor({})]);
/* A missing or unparseable bedroom count must not turn a heavy home into a
   half-price one by making the >= 4 test fail. It is safe here only because
   heavy-and-large is the case that LOSES the passthrough — assert it so the
   direction cannot be flipped without a red test. */
t('a blank bedroom count on a heavy first clean errs toward the passthrough, '
  + 'which is the direction that cannot underpay a partner',
  sandbox.payoutRateFor({ service: 'first_clean', condition: 'heavy' }) === PASSTHROUGH);

/* ------------------------------------------------------------
   4b. The LABEL that lands in the sheet tracks the arithmetic.

   `discount_applied` is read months later to work out what a booking earned,
   so a label naming a percentage the factor does not produce is a quiet
   reporting error rather than a visible bug. Asserted against the constants
   rather than against the strings, so moving a factor cannot leave a stale
   number behind in the sheet.
   ------------------------------------------------------------ */
console.log('\n=== 4b. the sheet label cannot drift from the factor ===');
{
  const home = { zip: '02134', bathrooms: 2, levels: 1, frequency: 'once' };
  const half = computeQuote(Object.assign({}, home,
    { bedrooms: 2, condition: 'standard', service: 'first_clean' }));
  const move = computeQuote(Object.assign({}, home,
    { bedrooms: 2, condition: 'standard', service: 'move_out' }));
  const heavy = computeQuote(Object.assign({}, home,
    { bedrooms: 4, condition: 'heavy', service: 'first_clean' }));

  const pctOf = (f) => Math.round((1 - f) * 100);

  t('the half-price label names the FIRST_CLEAN_FACTOR percentage',
    half.discountLabel.indexOf(pctOf(PRICING.FIRST_CLEAN_FACTOR) + '% off') !== -1,
    half.discountLabel);
  t('both 15% labels name the SECONDARY_FACTOR percentage',
    move.discountLabel.indexOf(pctOf(PRICING.SECONDARY_FACTOR) + '% off') !== -1 &&
    heavy.discountLabel.indexOf(pctOf(PRICING.SECONDARY_FACTOR) + '% off') !== -1,
    [move.discountLabel, heavy.discountLabel]);
  t('the three labels are distinguishable — reporting has to tell a move clean '
    + 'from a large heavy home, and both from a half price',
    new Set([half.discountLabel, move.discountLabel, heavy.discountLabel]).size === 3,
    [half.discountLabel, move.discountLabel, heavy.discountLabel]);
  t('and the shown price really is the anchor times the factor',
    Math.ceil(half.deepAnchorDisplay * half.discountFactor) === half.displayPrice &&
    Math.ceil(move.deepAnchorDisplay * move.discountFactor) === move.displayPrice,
    [half.deepAnchorDisplay, half.displayPrice, move.deepAnchorDisplay, move.displayPrice]);
  /* `None` was the old value for these two and must not come back — a report
     summing discounts would read it as "no discount applied". */
  t('no path produces the retired "None" label',
    [half, move, heavy].every(x => x.discountLabel !== 'None'));
}

/* ------------------------------------------------------------
   5. PARTNERS NEVER SEE A SHARE — only a dollar amount.
   ------------------------------------------------------------ */
console.log('\n=== 5. no partner surface exposes a rate or a customer price ===');

/* The payout arithmetic is Serve's business. A partner learning they are on
   0.85 while another is on 0.98 turns every dispatch into a negotiation, and
   the customer's price is not theirs to see at all. Both partner view models
   are whitelists, so this is asserted by reading what they BUILD rather than
   by trusting the comment above them. */
const partnerModelSrc = (name) => {
  const at = SRC.indexOf('function ' + name);
  if (at === -1) return '';
  return SRC.slice(at, at + 6000);
};

for (const fn of ['buildVendorTicketModel', 'buildVendorPortalModel']) {
  const body = partnerModelSrc(fn);
  if (!body) { t(fn + ' is present', false); continue; }
  t(fn + ' is present', true);
  t(fn + ' exposes a dollar payout', /payout:\s*partnerPayoutFor\(/.test(body));
  t(fn + ' never exposes the SHARE',
    !/payoutRate/.test(body), (body.match(/.*payoutRate.*/g) || []).slice(0, 2));
  t(fn + ' never exposes the customer price',
    !/\bprice:/.test(body), (body.match(/.*\bprice:.*/g) || []).slice(0, 2));
}

/* The partner ticket's own copy must not name a percentage either — a "you get
   85%" line would leak the split just as effectively as a field would. */
const TICKET_JS = fs.readFileSync(path.join(REPO_ROOT, 'ticket.js'), 'utf8');
const payoutCopy = (() => {
  const at = TICKET_JS.indexOf("'Your payout'");
  return at === -1 ? '' : TICKET_JS.slice(at, at + 1200);
})();
t('the partner ticket has a payout block', payoutCopy.length > 0);
t('and its copy names no percentage',
  !/%|percent|\bshare\b|\bsplit\b/i.test(payoutCopy),
  (payoutCopy.match(/.*(%|percent|share|split).*/gi) || []).slice(0, 2));

/* ------------------------------------------------------------
   6. THE PUBLISHED PAGES ADVERTISE THE PERCENTAGE THE ENGINE APPLIES.

   A page promising "15% off" while the engine charges something else is worse
   than a page promising nothing: the customer sees a number, gets a different
   one in the calculator, and the site looks broken or dishonest. The <th> in
   pricing.html is a HAND-MAINTAINED no-JS fallback — script.js re-renders it
   from SERVE_SERVICES — so it is exactly the kind of literal that rots.
   ------------------------------------------------------------ */
console.log('\n=== 6. the pages promise what the engine charges ===');
{
  const read = (f) => fs.readFileSync(path.join(REPO_ROOT, f), 'utf8');
  const pct  = (f) => Math.round((1 - f) * 100);
  const first = pct(PRICING.FIRST_CLEAN_FACTOR);      // 50
  const secondary = pct(PRICING.SECONDARY_FACTOR);    // 15

  const PRICING_HTML  = read('pricing.html');
  const SERVICES_HTML = read('services.html');
  const INDEX_HTML    = read('index.html');
  const SCRIPT_JS     = read('script.js');

  /* The no-JS fallback row. Asserted against the factor, not against "15". */
  const headRow = (PRICING_HTML.match(/<tr data-serve-price-head>[\s\S]*?<\/tr>/) || [''])[0];
  t('the /pricing header row is the one script.js re-renders',
    headRow.length > 0);
  t('its First Clean column names the FIRST_CLEAN_FACTOR percentage',
    new RegExp('First Clean <span>' + first + '% off</span>').test(headRow),
    headRow.match(/First Clean <span>[^<]*</) || null);
  t('its Move In / Out column names the SECONDARY_FACTOR percentage — it said '
    + '"empty home" before 2026-09-16 and advertised no discount at all',
    new RegExp('Move In / Out <span>' + secondary + '% off</span>').test(headRow),
    headRow.match(/Move In \/ Out <span>[^<]*</) || null);

  /* The service cards on both pages. The First Clean card has always led with
     its discount; the move card led with "Empty homes". */
  for (const [name, html] of [['services.html', SERVICES_HTML], ['index.html', INDEX_HTML]]) {
    /* Anchored on the CARD TITLE, not on the bare phrase — index.html says
       "Move In / Move Out Clean" in the service radio 800 lines earlier, and
       searching for the phrase finds that one instead. */
    const at = html.search(/serve-card__title">Move In \/ Move Out</);
    const moveCard = at === -1 ? '' : html.slice(Math.max(0, at - 500), at);
    t(name + ' move card carries the ' + secondary + '% badge',
      new RegExp('serve-card__badge">' + secondary + '% off<').test(moveCard),
      moveCard.match(/serve-card__badge[^>]*>[^<]*</) || null);
  }

  /* Computed, not typed — in the one place both the <th> and the mobile
     data-label are generated from. */
  t('script.js derives both subtitles from the factors rather than literals',
    /servePct\(PRICING\.FIRST_CLEAN_FACTOR\)/.test(SCRIPT_JS) &&
    /servePct\(PRICING\.SECONDARY_FACTOR\)/.test(SCRIPT_JS));

  /* Below 640px the <thead> is display:none, so a discount announced only in
     the header is invisible on a phone. */
  t('the mobile data-label carries the subtitle, since the header row is hidden '
    + 'under 640px', /data-label="'\s*\+\s*service\.label\s*\+[\s\S]{0,120}service\.sub/.test(SCRIPT_JS));
  t('and the CSS really does hide that header row',
    /@media \(max-width: 639px\)[\s\S]{0,600}\.serve-table thead \{\s*display: none/
      .test(read('style.css')));

  /* "$50 OFF VISITS 2-4" IS GONE FROM THE WHOLE SITE — removed 2026-09-16 on
     the founder's instruction.

     It was promised in five customer-facing places and NOTHING EVER APPLIED
     IT: recurringPriceFor prices a recurring visit at steady state with no
     deduction anywhere. One of the five was inside the JSON-LD FAQ, so Google
     could surface an offer the checkout would never honour.

     THE RULE THIS PINS: every discount the site advertises is one computeQuote
     actually applies. A number in the markup that no code produces is the
     failure mode, and it is invisible until a customer asks why they were not
     given it.

     Comments are stripped before matching, so the HTML comments recording the
     removal do not count as a promise — and a real one cannot hide in one. */
  const stripComments = (s) => s
    .replace(/<!--[\s\S]*?-->/g, '')      // HTML
    .replace(/\/\*[\s\S]*?\*\//g, '')     // JS block
    .replace(/^\s*\/\/.*$/gm, '');        // JS line
  const priceNote = (SCRIPT_JS.match(/<p class="price-note">[\s\S]*?<\/p>/) || [''])[0];
  t('the no-stack branch renders a price-note at all', priceNote.length > 0);
  t('it names a real percentage, computed from the factor',
    /discountPercent/.test(priceNote), priceNote.slice(0, 160));

  /* Every surface the offer appeared on, plus the two it never did, so a
     reappearance anywhere in the shipped site fails here. */
  const SURFACES = ['index.html', 'services.html', 'pricing.html', 'script.js',
                    'portal.js', 'ticket.js'];
  for (const f of SURFACES) {
    const clean = stripComments(read(f));
    t(f + ' promises no $50-off-visits offer',
      !/\$50/.test(clean) && !/visits two through four/i.test(clean),
      (clean.match(/.{0,60}\$50.{0,60}/) || [null])[0]);
  }

  /* The JSON-LD and the visible FAQ answer the same question and MUST say the
     same thing — structured data that contradicts the page is worse than none,
     and this pair drifted apart exactly once already by holding the offer in
     two places. Compared on the shared sentence rather than character for
     character, since one is JSON and the other is markup. */
  const FAQ_TAIL = 'recurring visits are priced well below a one-time clean '
                 + 'because the home is already at baseline';
  const faqHits = (PRICING_HTML.match(new RegExp(FAQ_TAIL, 'g')) || []).length;
  t('the contract FAQ appears in both the JSON-LD and the visible page',
    faqHits === 2, faqHits);
  t('and neither copy mentions the retired offer',
    !new RegExp(FAQ_TAIL + '[^"<]*\\$50').test(PRICING_HTML));
}

console.log('\n' + (bad ? bad + ' FAILED' : 'all passed'));
process.exit(bad ? 1 : 0);
