/**
 * A2P 10DLC compliance surface.
 *
 * Twilio campaign registration was submitted against exactly what this test
 * asserts. Carriers re-check the pages and the opt-in flow AFTER approval, so a
 * regression here does not fail a form — it can get the number's campaign
 * revoked and stop every booking confirmation the business sends.
 *
 * The three rules that get campaigns rejected, all enforced below:
 *   1. transactional and promotional consent live on SEPARATE checkboxes
 *   2. neither box is pre-checked, and neither is required to submit
 *   3. the policy links are their own anchors, never inside the label text
 */
const REPO_ROOT = require('path').resolve(__dirname, '..');
const fs   = require('fs');
const path = require('path');

/* CRLF normalised on read — _headers is CRLF, and a pattern with a literal \n
   inside it matches nothing there even when the header is present. Two charset
   assertions below were failing for exactly that reason while _headers was
   correct. Do not "fix" _headers in response to a failure here without checking
   the file first. */
const read = f => fs.readFileSync(path.join(REPO_ROOT, f), 'utf8').replace(/\r\n/g, '\n');

const html      = read('index.html');
const privacy   = read('privacy.html');
const smsTerms  = read('sms-terms.html');
const js        = read('script.js');
const css       = read('style.css');
const webhook   = read('apps-script/webhook.gs');
const buildSh   = read('scripts/build-site.sh');
const headers   = read('_headers');
const redirects = read('_redirects');

let bad = 0;
const t = (label, cond, extra) => {
  console.log((cond ? '  ok    ' : '  FAIL  ') + label + (extra !== undefined ? '  ->  ' + JSON.stringify(extra) : ''));
  if (!cond) bad++;
};

/* Tags out, entities in, whitespace collapsed — so a line-wrapped paragraph
   compares equal to the sentence a reviewer reads on the page. */
const text = h => h
  .replace(/<[^>]+>/g, ' ')
  .replace(/&mdash;/g, '—').replace(/&ndash;/g, '–')
  .replace(/&amp;/g, '&').replace(/&middot;/g, '·')
  .replace(/\s+/g, ' ')
  .trim();

/* ============================================================ */
console.log('=== 1. the paragraph reviewers grep for, verbatim ===');
/* Do not reword this. It is the standard mobile-information disclosure and it
   is checked as an exact string, not a fuzzy match. */
const MOBILE_INFO =
  'No mobile information will be shared with third parties or affiliates for ' +
  'marketing or promotional purposes. Text messaging originator opt-in data and ' +
  'consent will not be shared with any third parties for any purpose.';

t('privacy.html carries it word for word', text(privacy).includes(MOBILE_INFO));
t('it is emphasised, not buried in body copy',
  /<strong>\s*No mobile information will be shared[\s\S]*?for any purpose\.\s*<\/strong>/.test(privacy));

console.log('\n=== 2. required SMS disclosures are present ===');
const pText = text(privacy);
[['collects mobile phone numbers',      /Serve collects mobile phone numbers/],
 ['STOP instruction',                   /replying STOP to any message/],
 ['HELP instruction',                   /Reply\s+HELP for assistance/],
 ['subcontractor sharing disclosure',   /prohibited from using your information for their own marketing/],
 ['links to the SMS terms',             /sms-terms/]].forEach(([label, re]) =>
  t('privacy: ' + label, re.test(pText) || re.test(privacy)));

const sText = text(smsTerms);
[['program name',        /Serve Cleaning Notifications/],
 ['program description', /booking confirmations, appointment reminders/],
 ['message frequency',   /2–6 messages per scheduled cleaning/],
 ['promo frequency cap', /limited to 4 per month/],
 ['cost disclosure',     /Message and data rates may apply/],
 ['STOP opt-out',        /Reply\s+STOP to any message/],
 ['opt-out != cancel',   /does not cancel your cleaning service/],
 ['HELP keyword',        /Reply\s+HELP to any message/],
 ['carrier liability',   /Carriers are not liable for delayed or undelivered messages/],
 ['links to privacy',    /\/privacy/]].forEach(([label, re]) =>
  t('sms-terms: ' + label, re.test(sText) || re.test(smsTerms)));

console.log('\n=== 3. both pages are reachable and on every footer ===');
[['index.html', html], ['privacy.html', privacy], ['sms-terms.html', smsTerms]].forEach(([name, doc]) => {
  const footer = doc.slice(doc.indexOf('<footer'));
  t(name + ' footer links /privacy',   /href="\/privacy"/.test(footer));
  t(name + ' footer links /sms-terms', /href="\/sms-terms"/.test(footer));
});
t('build-site.sh stages privacy.html',   /cp\s+[^\n]*\bprivacy\.html\b/.test(buildSh));
t('build-site.sh stages sms-terms.html', /cp\s+[^\n]*\bsms-terms\.html\b/.test(buildSh));
['/privacy', '/sms-terms'].forEach(p => {
  const block = headers.split(/\n(?=\/)/).find(b => b.trim().startsWith(p + '\n'));
  t('_headers declares charset for ' + p, !!block && /charset=utf-8/i.test(block));
});
t('_redirects sends /book to the booking form (/instant)', /^\/book\s+\/instant\s/m.test(redirects));

console.log('\n=== 4. the consent block — where campaigns get rejected ===');
const blockStart = html.indexOf('<div class="sms-consent">');
const blockEnd   = html.indexOf('</div>', html.indexOf('sms-consent-links'));
t('consent block exists', blockStart !== -1);
const block = html.slice(blockStart, blockEnd);

/* Adjacent to the phone field, per the registration answer. */
const phoneIdx = html.indexOf('id="r-phone"');
const addrIdx  = html.indexOf('id="r-address"');
t('sits directly after the phone field, before the address field',
  phoneIdx !== -1 && phoneIdx < blockStart && blockStart < addrIdx);

/* ---------- the intro may sell, but never at the cost of the promise ----------
   The intro sits ABOVE the labels as a sibling of them, and that is precisely
   what makes it allowed: a carrier reviews the LABEL. It is therefore the one
   place copy can move opt-in, and the one place a careless edit can imply that
   ticking a box is how you get your booking page.

   It is not. Since r58 the page is emailed on EVERY booking regardless of
   consent, which is a standing customer promise made in two places. An intro
   that stopped saying "either way" would turn an optional box into an apparent
   condition of getting what you paid for — the exact thing the labels below
   are required to disclaim. Asserted here because nothing asserted it before,
   and the intro was edited on 2026-09-23 to describe what the page does. */
const introMatch = block.match(/<p class="sms-consent__lede">([\s\S]*?)<\/p>/);
t('the consent intro exists', !!introMatch);
const introText = introMatch ? text(introMatch[1]) : '';
t('the intro still says the booking page arrives either way',
  /emailed to you\s+either way/.test(introText), introText);
t('the intro never makes a text the way to get the booking page',
  !/tick[^.]*\bto (get|receive)\b[^.]*booking page/i.test(introText), introText);

const boxes = block.match(/<input[^>]*type="checkbox"[^>]*>/g) || [];
t('exactly two checkboxes', boxes.length === 2, boxes.length);
t('transactional and promotional are SEPARATE boxes',
  /name="sms_transactional"/.test(block) && /name="sms_promotional"/.test(block));
t('neither box is pre-checked',   !boxes.some(b => /\bchecked\b/.test(b)), boxes.filter(b => /\bchecked\b/.test(b)));
t('neither box is required',      !boxes.some(b => /\brequired\b/.test(b)), boxes.filter(b => /\brequired\b/.test(b)));

/* The links must be siblings of the labels, not children of them. A reviewer
   who finds an <a> inside the consent label text rejects the campaign. */
/* Matches the modifier classes too. The labels carry --primary / --secondary
   as of 2026-09-19 so the appointment box can outweigh the marketing one
   visually; pinned to the bare class string, this found zero labels and
   reported the consent block as missing when it was simply restyled. What is
   under test is the CONTENT of each label, and that is unchanged below. */
const labels = block.match(/<label class="sms-consent__opt[^"]*">[\s\S]*?<\/label>/g) || [];
t('two consent labels', labels.length === 2, labels.length);
t('no anchor inside either label', !labels.some(l => /<a\s/.test(l)));
const linksBlock = block.slice(block.indexOf('sms-consent-links'));
t('policy links are separate anchors below the boxes',
  /href="\/privacy"/.test(linksBlock) && /href="\/sms-terms"/.test(linksBlock));

console.log('\n=== 5. consent language a carrier looks for ===');
const bText = text(block);
[['brand named',                 /text messages from Serve/],
 ['not a condition of purchase', /Consent is not a condition of purchase/],
 ['frequency varies',            /Message frequency varies/],
 ['rates may apply',             /Message and data rates may apply/],
 ['STOP',                        /Reply STOP to opt out/],
 ['HELP',                        /HELP for help/]].forEach(([label, re]) =>
  t(label, re.test(bText)));
/* Both boxes carry their own "not a condition of purchase" and rates language —
   a reviewer reads them independently, so neither may lean on the other. */
labels.forEach((l, i) => {
  const lt = text(l);
  t('box ' + (i + 1) + ' is self-contained',
    /Consent is not a condition of purchase/.test(lt) && /Message and data rates may apply/.test(lt));
});

console.log('\n=== 6. the form still submits without consent ===');
const validation = js.slice(js.indexOf("['r-name', 'r-email'"), js.indexOf('reserveSubmitting = true'));
t('consent boxes are absent from required-field validation',
  !/sms-transactional|sms-promotional/.test(validation));

console.log('\n=== 7. consent is captured, and never as "no" ===');
t('script.js sends sms_transactional', /p\.sms_transactional\s*=/.test(js));
t('script.js sends sms_promotional',   /p\.sms_promotional\s*=/.test(js));
/* Writing "no" would populate the cell, and the LEADS upsert is blank-fill-only
   — a real opt-in on a later booking could then never be recorded. */
t('script.js never sends the string "no"',
  !/sms_(transactional|promotional)\s*=\s*[^;]*['"]no['"]/.test(js));
t('site does NOT send its own consent timestamp (server stamps it)',
  !/p\.sms_consent_at\s*=/.test(js));

console.log('\n=== 8. webhook writes it to LEADS, server-stamped ===');
const leadsFields = webhook.slice(webhook.indexOf('const LEADS_FIELDS'), webhook.indexOf('const LEADS_HEADER_MAP'));
['sms_transactional', 'sms_promotional', 'sms_consent_at'].forEach(f =>
  t('LEADS_FIELDS includes ' + f, leadsFields.includes('"' + f + '"')));
t('quote_meta carries the per-booking snapshot',
  /QUOTE_META_KEYS[\s\S]*?"sms_transactional",\s*"sms_promotional"/.test(webhook));
t('consent timestamp comes from the server clock, not the payload',
  /sms_consent_at:\s*\(smsT \|\| smsP\) \? stamp : ""/.test(webhook));
t('webhook coerces anything that is not "yes" to blank',
  /data\.sms_transactional === "yes" \? "yes" : ""/.test(webhook) &&
  /data\.sms_promotional\s*=== "yes" \? "yes" : ""/.test(webhook));
/* What is under test is that the deployed webhook is r7 OR LATER — r7 is where
   SMS consent landed, and any revision after it still carries that code. Pinned
   to the exact string `r7`, this failed on the very next unrelated bump and
   reported the consent surface as broken when nothing about it had changed.
   The assertion is not weakened: below r7 still fails, and the stamp and the
   doGet response must still agree with each other. */
const stampRev = (webhook.match(/VERSION STAMP:[^\n]*\br(\d+)\b/) || [])[1];
const doGetRev = (webhook.match(/version:\s*"[^"]*\br(\d+)"/) || [])[1];
t('version stamp is r7 or later', Number(stampRev) >= 7, stampRev);
t('doGet reports the same revision as the stamp',
  doGetRev !== undefined && doGetRev === stampRev, [stampRev, doGetRev]);

console.log('\n=== 9. the block is styled (it is read, so it must be legible) ===');
['sms-consent', 'sms-consent__opt', 'sms-consent-links', 'footer__legal', 'legal__callout']
  .forEach(c => t('.' + c + ' has a rule in style.css', css.includes('.' + c)));

console.log('\n' + (bad ? bad + ' check(s) FAILED' : 'sms-consent: all checks passed'));
process.exit(bad ? 1 : 0);
