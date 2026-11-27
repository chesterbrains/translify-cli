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
# Watch: a saved source file is pushed by itself, and Ctrl-C ends the watch with 0.
$CLI push --watch --debounce 500 > watch.log 2>&1 &
watch_pid=$!
# Never leave a watch pushing to the server behind a failed run.
trap 'kill "$watch_pid" 2>/dev/null || true' EXIT
# Wait for the start push to finish, not only for the "Watching" line: a file saved while it runs goes up
# inside it and is counted in its summary, not on a line of its own.
for _ in $(seq 1 150); do grep -q ' pushed [0-9]* namespace' watch.log && break; sleep 0.2; done
grep -q ' pushed [0-9]* namespace' watch.log || { echo "watch did not finish its start push"; cat watch.log; exit 1; }
# A key name of its own per run, so the script can run again on the same project.
printf '{"cart":{"title":"Cart","total":"Total","watched%s":"Watched"}}' "$(date +%s)" > locales/en/shop.json
for _ in $(seq 1 100); do grep -q 'shop: 1 created' watch.log && break; sleep 0.2; done
grep -q 'shop: 1 created' watch.log || { echo "watch did not push the new key"; cat watch.log; exit 1; }
kill -INT "$watch_pid"
wait "$watch_pid" || { echo "watch did not exit 0"; cat watch.log; exit 1; }
trap - EXIT

echo "smoke OK in $work"
