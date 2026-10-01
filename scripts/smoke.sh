#!/usr/bin/env bash
# Manual smoke test against a local translify-be. Needs a project with `en` as default locale plus `it`,
# an environment named `production`, and a secret key with PULL, PUSH and PUBLISH scopes.
# Build first (pnpm build), then:
#   TRANSLIFY_SECRET_KEY=sk_... API_URL=http://localhost:3000/api ./scripts/smoke.sh
set -euo pipefail
: "${TRANSLIFY_SECRET_KEY:?set TRANSLIFY_SECRET_KEY}"
: "${API_URL:?set API_URL}"
export TRANSLIFY_SECRET_KEY

CLI="node $(pwd)/dist/index.js"
work=$(mktemp -d)
cd "$work"
mkdir -p locales/en locales/it
printf '{"cart":{"title":"Cart","total":"Total"}}' > locales/en/shop.json
printf '{"cart":{"title":"Carrello"}}' > locales/it/shop.json
printf '{"apiUrl":"%s","files":[{"pattern":"locales/{locale}/{namespace}.json","format":"json"}]}' "$API_URL" > translify.json

$CLI push --dry-run
$CLI push

# A second push changes nothing.
$CLI push --json | node -e '
  const s = JSON.parse(require("fs").readFileSync(0, "utf8")).summary;
  if (s.created !== 0 || s.updated !== 0) { console.error("second push was not a no-op", s); process.exit(1); }
'

rm -rf locales/it
$CLI pull
test -f locales/it/shop.json
$CLI status
$CLI publish production || echo "(create a 'production' environment to test publish)"
echo "smoke OK in $work"
