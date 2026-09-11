#!/usr/bin/env bash
# Read-only production health probe. Prints a compact summary; never mutates.
# CRON_KEY: from env, else ~/.config/redflare/cron_key (optional — skips /__sync/status without it).
set -u
ORIGIN="${RF_ORIGIN:-https://film.bluesia.net}"
KEY="${CRON_KEY:-$(cat ~/.config/redflare/cron_key 2>/dev/null)}"
W="timeout 60 npx --no-install wrangler"

echo "== /api/home-data"
curl -sI -m 15 "$ORIGIN/api/home-data" | grep -iE '^(HTTP/|cf-cache-status:|age:)' | tr -d '\r'

echo "== SPA deep link"
curl -s -o /dev/null -m 15 -w 'HTTP %{http_code}\n' "$ORIGIN/phim/rf-status-probe"

echo "== /__sync/status"
if [ -n "$KEY" ]; then
  curl -s -m 20 -H "x-cron-key: $KEY" "$ORIGIN/__sync/status" | head -c 1500; echo
else
  echo "(skipped: no CRON_KEY)"
fi

echo "== latest deployments"
$W deployments list --json 2>/dev/null | node -e '
  const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
  d.sort((a, b) => b.created_on.localeCompare(a.created_on));
  for (const x of d.slice(0, 3)) console.log(x.created_on, x.source, x.versions.map(v => v.version_id.slice(0, 8) + "@" + v.percentage + "%").join(","));
' || echo "(wrangler failed)"

echo "== workflows (last instance each)"
for wf in incremental-sync hero-snapshot recommendation-resolve recommendation-refresh backfill; do
  printf '%s: ' "$wf"
  $W workflows instances list "$wf" 2>/dev/null | grep -E '│|\|' | sed -n 2p | tr -s ' ' || echo "?"
done
