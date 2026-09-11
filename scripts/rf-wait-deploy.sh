#!/usr/bin/env bash
# After `git push origin main`: wait for Workers Builds to publish a new deployment, then smoke test.
# Usage: scripts/rf-wait-deploy.sh <previous-deployment-id>   (get it with: scripts/rf-wait-deploy.sh --latest)
set -u
ORIGIN="${RF_ORIGIN:-https://film.bluesia.net}"
latest() {
  timeout 60 npx --no-install wrangler deployments list --json 2>/dev/null | node -e '
    const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
    d.sort((a, b) => b.created_on.localeCompare(a.created_on));
    console.log(d[0]?.id ?? "");'
}
[ "${1:-}" = "--latest" ] && { latest; exit 0; }
prev="${1:?previous deployment id required}"

for i in $(seq 1 30); do  # ~10 min
  cur="$(latest)"
  [ -n "$cur" ] && [ "$cur" != "$prev" ] && { echo "NEW DEPLOYMENT $cur (after ~$((i * 20))s)"; break; }
  sleep 20
done
[ "${cur:-}" != "$prev" ] || { echo "TIMEOUT: no new deployment after 10 min — check Workers Builds in the dashboard"; exit 1; }

fail=0
for p in / /api/home-data /phim/rf-smoke /sitemap.xml /robots.txt; do
  code="$(curl -s -o /dev/null -m 20 -w '%{http_code}' "$ORIGIN$p")"
  echo "$code $p"; [ "$code" = 200 ] || fail=1
done
[ $fail = 0 ] && echo "SMOKE PASS" || { echo "SMOKE FAIL"; exit 1; }
