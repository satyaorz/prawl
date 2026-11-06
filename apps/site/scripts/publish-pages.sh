#!/usr/bin/env bash
# Publish the site to GitHub Pages without GitHub Actions: build it for the /prawl/ sub-path, then force-push the
# result as the gh-pages branch (Pages is set to serve that branch's root). Re-run it to publish a new version.
#
#   pnpm --filter @prawl/site publish:pages
#
# Result: https://satyaorz.github.io/prawl/
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
REMOTE=${PAGES_REMOTE:-$(git -C "$ROOT" remote get-url origin)}
cd "$ROOT"
pnpm --filter @prawl/site build:pages
TMP=$(mktemp -d)
[ -n "$TMP" ] && [ -d "$TMP" ] || { echo "could not make a temp directory"; exit 1; }
cp -a "$ROOT/apps/site/dist/." "$TMP/"
rm -rf -- "$TMP/apk" # the APK is a GitHub release, never part of the site
cd "$TMP"
git init -q -b gh-pages
git add -A -f # .nojekyll starts with a dot
git -c user.name="$(git -C "$ROOT" config user.name)" -c user.email="$(git -C "$ROOT" config user.email)" \
  commit -q -m "Publish the site (built from $(git -C "$ROOT" rev-parse --short HEAD))"
git push -f "$REMOTE" gh-pages
cd "$ROOT"
rm -rf -- "$TMP"
echo "published: https://satyaorz.github.io/prawl/"
