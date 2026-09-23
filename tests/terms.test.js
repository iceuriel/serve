/**
 * General Terms of Service and the agent/connector contract surface.
 *
 * /sms-terms is deliberately not the product contract: it carries the narrow
 * carrier disclosures Twilio reviews. /terms is the public agreement a person
 * or an authorized agent sees before a booking becomes a request.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

const terms = read('terms.html');
const index = read('index.html');
const build = read('scripts/build-site.sh');
const headers = read('_headers');
const sitemap = read('sitemap.xml');

let bad = 0;
function t(label, condition, extra) {
  console.log((condition ? '  ok    ' : '  FAIL  ') + label +
    (extra === undefined ? '' : '  ->  ' + JSON.stringify(extra)));
  if (!condition) bad++;
}
function text(s) {
  return s.replace(/<[^>]+>/g, ' ').replace(/&(?:mdash|ndash);/g, '-')
    .replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

console.log('=== 1. /terms is a real published page ===');
t('canonical is extensionless',
  /<link rel="canonical" href="https:\/\/servecleaning\.com\/terms">/.test(terms));
t('build allow-list stages terms.html', /cp\s+[^\n]*\bterms\.html\b/.test(build));
t('sitemap includes /terms once',
  (sitemap.match(/<loc>https:\/\/servecleaning\.com\/terms<\/loc>/g) || []).length === 1);
['/terms', '/terms.html'].forEach(p => {
  const block = headers.split(/\n(?=\/)/).find(b => b.trim().startsWith(p + '\n'));
  t(p + ' has a UTF-8 revalidation rule',
    !!block && /Content-Type:\s*text\/html; charset=utf-8/i.test(block) &&
    /must-revalidate/.test(block));
});

console.log('\n=== 2. agreement is visible at the booking decision ===');
const noticeStart = index.indexOf('class="reserve-terms"');
const notice = index.slice(noticeStart,
  index.indexOf('class="step-actions"', noticeStart));
t('notice appears immediately before the final action',
  /Reserve my clean/.test(notice) && /href="\/terms"/.test(notice));
t('notice links the privacy policy too', /href="\/privacy"/.test(notice));
t('terms notice is outside the regulated SMS consent block',
  index.indexOf('class="reserve-terms"') > index.indexOf('class="sms-consent-links"'));

console.log('\n=== 3. every public page links the same agreement ===');
['index.html', 'pricing.html', 'services.html', 'privacy.html',
 'sms-terms.html', 'terms.html'].forEach(f => {
  const doc = read(f);
  const footer = doc.slice(doc.indexOf('<footer'));
  t(f + ' footer links /terms', /href="\/terms"/.test(footer));
});

console.log('\n=== 4. the agreement matches Serve\'s operating model ===');
const body = text(terms);
[
  ['a request is not accepted merely because it was submitted',
    /does not by itself mean that a service partner has accepted/i],
  ['confirmation follows partner acceptance',
    /confirmed only when Serve tells you that a service partner has accepted/i],
  ['full quoted amount is an authorization hold',
    /authorization hold for the full quoted amount/i],
  ['capture waits for partner acceptance',
    /captures the amount only after a service partner accepts/i],
  ['pre-capture cancellation releases the hold',
    /cancel before the authorization is captured[\s\S]*release or void the hold/i],
  ['scope changes cannot create an unapproved extra charge',
    /No additional charge will be made without your approval/i],
  ['local service companies perform the work',
    /established local service companies/i],
  ['property safety and access duties are explained',
    /provide reasonably safe access/i],
  ['privacy policy governs received information',
    /described in our Privacy Policy/i],
].forEach(([label, re]) => t(label, re.test(body)));

console.log('\n=== 5. agent use is authorized but bounded ===');
[
  ['authorized AI agents are permitted', /AI agent, assistant, or other third-party service/i],
  ['the customer reviews material details', /reviewing material details before approval/i],
  ['sensitive actions may require express confirmation', /may require your express confirmation/i],
  ['agents cannot bypass confirmation', /agent cannot bypass a required confirmation/i],
  ['Serve may stop suspicious automation', /appears unauthorized, inconsistent, unsafe, duplicative/i],
  ['agent provider terms remain separate', /agent provider is a separate service/i],
].forEach(([label, re]) => t(label, re.test(body)));

console.log('\n=== 6. consumer protections are not signed away ===');
t('Massachusetts Chapter 93A is preserved', /Chapter 93A/.test(body));
t('non-waivable remedies are preserved', /rights or remedies that cannot be waived/i.test(body));
t('there is no mandatory arbitration clause', !/mandatory arbitration|binding arbitration/i.test(body));
t('there is no invented cancellation fee or deadline',
  !/cancellation fee|cancel(?:lation)? within \d+|\d+ hours? before/i.test(body));
t('SMS terms remain their own narrow page',
  /SMS Terms &amp; Conditions/.test(read('sms-terms.html')) &&
  /Serve Cleaning Notifications/.test(read('sms-terms.html')));

console.log('\n' + (bad ? 'FAILURES: ' + bad : 'ALL CHECKS PASSED'));
process.exit(bad ? 1 : 0);
