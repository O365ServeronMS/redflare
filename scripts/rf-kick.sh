#!/usr/bin/env bash
# Poke production without a deploy. Usage: scripts/rf-kick.sh <target> [--force]
#   purge   GET  /__sync/purge-cache              (safe)
#   hero    POST /__sync/refresh-hero?force=true  (small)
#   sync | recs | recs-refresh | backfill         trigger the Workflow — needs --force:
#           on the Free plan one sync run can blow the 5M D1 rows/day limit and lock
#           the site's D1 until 00:00 UTC (docs/plan-incremental-sync-stall.md).
set -u
ORIGIN="${RF_ORIGIN:-https://film.bluesia.net}"
KEY="${CRON_KEY:-$(cat ~/.config/redflare/cron_key 2>/dev/null)}"
target="${1:-}"; force="${2:-}"

call() { # method path
  [ -n "$KEY" ] || { echo "ERROR: no CRON_KEY (env or ~/.config/redflare/cron_key)"; exit 2; }
  curl -s -m 60 -X "$1" -H "x-cron-key: $KEY" -w '\nHTTP %{http_code}\n' "$ORIGIN$2" | tail -c 800
}
wf() {
  [ "$force" = "--force" ] || { echo "REFUSED: '$target' costs D1 reads/Workflow steps. Re-run with --force."; exit 3; }
  timeout 60 npx --no-install wrangler workflows trigger "$1"
}

case "$target" in
  purge)        call GET  /__sync/purge-cache ;;
  hero)         call POST '/__sync/refresh-hero?force=true' ;;
  sync)         wf incremental-sync ;;
  recs)         wf recommendation-resolve ;;
  recs-refresh) wf recommendation-refresh ;;
  backfill)     wf backfill ;;
  *) echo "usage: $0 purge|hero|sync|recs|recs-refresh|backfill [--force]"; exit 1 ;;
esac
