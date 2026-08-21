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
cp index.html pricing.html services.html privacy.html sms-terms.html serve-geo-data.js script.js style.css "$OUT"/
cp sitemap.xml "$OUT"/
cp -r images "$OUT"/

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
