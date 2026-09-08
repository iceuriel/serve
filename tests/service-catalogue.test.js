/* The service catalogue — data file vs. what the homepage actually says.
   ==================================================================
   serve-services.js is the source of truth for which categories exist and
   which of them Serve can deliver today. The homepage renders that list as
   STATIC HTML, on purpose: crawlers and Twilio's A2P reviewers read served
   markup, and a service list that only appears after JavaScript runs is one
   some of them never see.

   Static markup and a data file are two copies of the same fact, and two
   copies drift. This file is what makes "edit one place" true rather than
   merely intended — flip a status in the data and the page has to follow, or
   the suite goes red.

   THE ASSERTION THAT MATTERS MOST is the last section: a category Serve cannot
   deliver must not be clickable, must not be orderable, and must not say
   anything a visitor could read as "available". Overstating one category costs
   more than the five it impresses. */

const REPO_ROOT = require('path').resolve(__dirname, '..');
const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(REPO_ROOT, 'index.html'), 'utf8');
const CATALOGUE = require(path.join(REPO_ROOT, 'serve-services.js'));

let bad = 0;
const t = (label, got, want) => {
  const okp = JSON.stringify(got) === JSON.stringify(want);
  console.log((okp ? '  ok    ' : '  FAIL  ') + label + '  ->  ' + JSON.stringify(got));
  if (!okp) { console.log('        expected ' + JSON.stringify(want)); bad++; }
};
const ok   = (m) => console.log('  ok    ' + m);
const fail = (m) => { console.log('  FAIL  ' + m); bad++; };
const head = (m) => console.log('\n=== ' + m + ' ===');

/* ------------------------------------------------------------------ */
head('1. The data file is well formed');

const all = CATALOGUE.all();
t('the catalogue is not empty', all.length > 0, true);

const VALID = ['live', 'request', 'planned'];
const badStatus = all.filter(s => VALID.indexOf(s.status) === -1);
badStatus.length
  ? fail('unknown status: ' + badStatus.map(s => s.id + '=' + s.status).join(', '))
  : ok('every status is one of ' + VALID.join(' / '));

const ids = all.map(s => s.id);
t('ids are unique', ids.length === new Set(ids).size, true);
all.filter(s => !s.name || !s.blurb).length
  ? fail('a service is missing a name or a blurb')
  : ok('every service has a name and a blurb');

/* A live service needs somewhere to send someone. A planned one must not have
   anywhere, or the card grows a link the business cannot honour. */
all.forEach(s => {
  if (s.status === 'live' && !s.href) fail(s.id + ' is live but has no href');
  if (s.status === 'planned' && s.href) fail(s.id + ' is planned but carries an href');
});
ok('hrefs exist on live services and only on live services');

/* ------------------------------------------------------------------ */
head('2. Cleaning, and only cleaning, is live');
/* Not a style rule — the whole page is written around it. The hero says
   "starting with home cleaning", the catalogue subhead says "home care starts
   with cleaning", and /pricing quotes cleaning. Turning a second category on
   means revisiting all of that, and this is the tripwire that says so. */
t('exactly one live category', CATALOGUE.live().map(s => s.id), ['cleaning']);
t('the chooser stays dormant while there is nothing to choose',
  CATALOGUE.needsCategoryStep(), false);
t('byId finds a known service', (CATALOGUE.byId('cleaning') || {}).status, 'live');
t('byId returns null for a service that does not exist', CATALOGUE.byId('roofing'), null);

/* ------------------------------------------------------------------ */
head('3. The homepage grid mirrors the data file');

const gridStart = HTML.indexOf('<ul class="cat-grid">');
const gridEnd   = HTML.indexOf('</ul>', gridStart);
if (gridStart === -1 || gridEnd === -1) throw new Error('cat-grid not found in index.html');
const grid = HTML.slice(gridStart, gridEnd);

const cardNames = [...grid.matchAll(/<span class="cat-card__name">([^<]+)<\/span>/g)]
  .map(m => m[1].replace(/&amp;/g, '&').trim());
t('every service in the data file has a card, in the same order',
  cardNames, all.map(s => s.name));

const cardBlurbs = [...grid.matchAll(/<span class="cat-card__blurb">([^<]+)<\/span>/g)]
  .map(m => m[1].replace(/&rsquo;/g, '’').replace(/&amp;/g, '&').trim());
t('the card copy matches the data file', cardBlurbs, all.map(s => s.blurb));

const cardStatus = [...grid.matchAll(/<span class="cat-card__status[^"]*">([^<]+)<\/span>/g)]
  .map(m => m[1].trim());
t('every card shows the label its status maps to',
  cardStatus, all.map(s => CATALOGUE.label(s.status)));

/* ------------------------------------------------------------------ */
head('4. A card cannot promise more than the business can deliver');

/* One card per service, and the live modifier on exactly the live ones. */
const cards = grid.split('<li class="cat-card').slice(1);
t('one card per service', cards.length, all.length);

const liveCards = cards.filter(c => c.startsWith(' cat-card--live'));
t('only live services get the live treatment', liveCards.length, CATALOGUE.live().length);

/* THE ONE THAT MATTERS. A "Coming to Serve" card with a link in it is an order
   form for something nobody can fulfil. */
cards.forEach((c, i) => {
  const svc = all[i];
  const hasLink = /<a\b/.test(c);
  if (svc.status === 'planned' && hasLink) {
    fail(svc.id + ' is "' + CATALOGUE.label(svc.status) + '" but its card is a link');
  }
  if (svc.status === 'live' && !hasLink) {
    fail(svc.id + ' is live but its card goes nowhere');
  }
});
ok('planned categories are inert; live ones are reachable');

/* No unlisted category may appear as available anywhere in the grid. */
const liveLabel = CATALOGUE.label('live');
const liveMentions = (grid.match(new RegExp(liveLabel, 'g')) || []).length;
t('"' + liveLabel + '" appears once per live service and no more',
  liveMentions, CATALOGUE.live().length);

/* ------------------------------------------------------------------ */
head('5. No second, disagreeing list of services');
/* The hero used to carry a home card listing three services, and this section
   held it to the catalogue. That card was removed on 2026-09-07, so rather
   than delete the check it is generalised to the risk it was really guarding:
   a SECOND place on the page pairing a service name with an availability
   label, which is how the page starts contradicting itself.

   Counting label occurrences outright was the obvious version and it was
   wrong — "Coming to Serve" is also the honest label on the job record's
   feature list (rooms, photos, history), which is not a service at all. What
   makes a claim about availability is a status label sitting NEXT TO A SERVICE
   NAME, so that adjacency is what is tested. */
const outsideGrid = HTML.slice(0, gridStart) + HTML.slice(gridEnd);
const labels = [liveLabel, CATALOGUE.label('planned'), CATALOGUE.label('request')].filter(Boolean);
const NEAR = 160;

let strays = 0;
all.forEach(svc => {
  const name = svc.name.replace(/&/g, '&amp;');
  let at = outsideGrid.indexOf(name);
  while (at !== -1) {
    const window_ = outsideGrid.slice(Math.max(0, at - NEAR), at + name.length + NEAR);
    labels.forEach(lab => {
      if (window_.indexOf(lab) !== -1) {
        fail('"' + svc.name + '" appears outside the catalogue next to "' + lab + '"');
        strays++;
      }
    });
    at = outsideGrid.indexOf(name, at + 1);
  }
});
strays === 0
  ? ok('no service name outside the grid carries an availability claim')
  : fail(strays + ' stray availability claim(s)');

/* And the grid is the only place a live claim is made at all. */
t('"' + liveLabel + '" appears nowhere outside the catalogue grid',
  (outsideGrid.match(new RegExp(liveLabel, 'g')) || []).length, 0);

/* ------------------------------------------------------------------ */
head('6. The page never advertises an unavailable category as bookable');
/* A blunt sweep over the whole page: no planned category name may appear in
   the same breath as the booking CTA. This is the check that would catch a
   well-meaning edit to a headline six months from now. */
const planned = all.filter(s => s.status === 'planned').map(s => s.name);
const ctaTags = HTML.match(/<a[^>]*href="\/?#quote"[^>]*>[^<]+<\/a>/g) || [];
const offending = ctaTags.filter(tag =>
  planned.some(n => tag.replace(/&amp;/g, '&').indexOf(n) !== -1));
offending.length
  ? fail('a booking CTA names a category that is not available: ' + offending.join(' | '))
  : ok('no booking CTA names an unavailable category');

console.log('\n' + (bad ? bad + ' FAILURES' : 'all service-catalogue checks passed'));
process.exit(bad ? 1 : 0);
