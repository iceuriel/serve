#!/usr/bin/env bash
#
# Stage the public site into _site/.
#
# The site has no build step — this exists to publish an ALLOW-LIST rather than
# the repository. Pointing a host at the repo root is what put engineering docs,
# the Apps Script source and a personal profile on servecleaning.com under
# GitHub Pages. Staging means a new file is private by default and has to be
# added here deliberately.
#
# Host-agnostic on purpose: Netlify, Cloudflare Pages and GitHub Actions all
# call this same script, so the published set cannot differ between them.
#
#   Netlify           netlify.toml  ->  bash scripts/build-site.sh, publish _site
#   Cloudflare Pages  build command ->  bash scripts/build-site.sh, output _site
#   local             bash scripts/build-site.sh && open _site/index.html
#
# ADDING AN ASSET TO THE SITE MEANS ADDING IT TO THE LIST BELOW.

set -euo pipefail

OUT="_site"

# Regenerate the Worker's copy of the pricing engine BEFORE anything else, so a
# deploy can never bundle a stale one. See scripts/build-engine-module.js for
# why the Worker cannot simply import the two classic <script> files.
node scripts/build-engine-module.js

rm -rf "$OUT"
mkdir -p "$OUT"

# --- the allow-list ---
# privacy.html and sms-terms.html are served at /privacy and /sms-terms. Both
# are REQUIRED to stay reachable: Twilio's A2P 10DLC registration lists them and
# carriers re-check them, so a 404 here can get the number's campaign revoked,
# not merely rejected. They are plain HTML with no JS by design.
#
# pricing.html and services.html are served at /pricing and /services. Both are
# linked from the nav of every page and listed in sitemap.xml — a page that is
# advertised everywhere and staged nowhere 404s in production while working
# perfectly on a local file open, which is the failure mode this list exists to
# make impossible to reach by accident.
#
# serve-geo-data.js is loaded by a <script> tag on all three script-bearing
# pages and read by the pricing engine. Staged but not listed, every page would
# still render — the engine falls back to neutral pricing when it is absent —
# so the failure would be silent: correct-looking prices with the entire
# geographic adjustment quietly switched off in production only.
#
# serve-services.js is the service catalogue: which categories exist and which
# of them Serve can actually deliver today. The homepage's service grid is
# static HTML that mirrors it (crawlers read served markup), so a missing file
# here does not blank the page — the booking flow just loses its category
# chooser, which is dormant while cleaning is the only live service. Listed
# anyway, because that stops being harmless the day a second category ships.
cp index.html pricing.html services.html privacy.html sms-terms.html serve-geo-data.js pricing-engine.js serve-services.js script.js style.css "$OUT"/

# j.html is served at /j and renders ONE job from an id in the query string.
# It is not in the sitemap and carries noindex both in the markup and as an
# X-Robots-Tag in _headers, because the URL exposes a home address and when the
# house is empty. ticket.js is its only script.
cp j.html ticket.js "$OUT"/
cp sitemap.xml "$OUT"/
cp -r images "$OUT"/

# Favicon at the ROOT as well as in images/.
#
# Crawlers and browsers request /favicon.ico by convention, regardless of the
# <link rel="icon"> tags in the markup. Google's search-result icon is one of
# them: servecleaning.com/favicon.ico returned 404 while
# /images/favicon.ico returned 200, and the result showed a generic globe
# instead of the Serve house.
#
# Copied, not moved. The <link> tags point at /images/, so the file has to
# exist in both places, and images/favicon.ico stays the one source of truth —
# editing it updates both on the next build.
cp images/favicon.ico "$OUT"/favicon.ico

# Response headers and vanity redirects. Both Cloudflare and Netlify read
# _headers and _redirects from the publish directory, so behaviour is identical
# across hosts.
cp _headers _redirects "$OUT"/

echo "--- published files ---"
find "$OUT" -type f | sort

# --- guard: nothing private may reach the artifact ---
if find "$OUT" -type f \( -name '*.md' -o -name '*.gs' -o -name '*.json' -o -name '*.toml' -o -name '*.sh' \) | grep -q .; then
  echo ""
  echo "ERROR: private-looking files staged for publication:"
  find "$OUT" -type f \( -name '*.md' -o -name '*.gs' -o -name '*.json' -o -name '*.toml' -o -name '*.sh' \)
  exit 1
fi

echo ""
echo "ok: $(find "$OUT" -type f | wc -l | tr -d ' ') files staged, nothing private"
