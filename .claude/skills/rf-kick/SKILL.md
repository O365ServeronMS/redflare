---
name: rf-kick
description: Poke redflare production without a deploy — purge Worker cache, force hero refresh, or trigger a sync/recommendation/backfill Workflow. Replaces "restart" (there is no process to restart).
disable-model-invocation: true
model: haiku
argument-hint: "purge|hero|sync|recs|recs-refresh|backfill [--force]"
---
Run `bash scripts/rf-kick.sh $ARGUMENTS` and report the result in ≤3 lines.

- `purge` and `hero` are cheap, so run them directly.
- `sync`, `recs`, `recs-refresh` and `backfill` are refused without `--force`. They cost D1 reads and Workflow steps, and on the Free plan one sync run can exceed 5M rows/day, which locks the site's D1 until 00:00 UTC. If refused, relay that and don't add `--force` yourself.
- `ERROR: no CRON_KEY` means the user must export `CRON_KEY` or put it in `~/.config/redflare/cron_key`. Never ask them to paste the key into chat.
