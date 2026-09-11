---
name: rf-deploy
description: Deploy redflare to production via git push to main (Cloudflare Workers Builds). Args "redeploy" = republish origin/main unchanged; "-y" = skip confirmation.
disable-model-invocation: true
model: sonnet
effort: low
argument-hint: "[redeploy] [-y]"
---
Deploy = push to `origin main`; Workers Builds builds and publishes. Never run `wrangler deploy` by hand.
Every deploy also empties the Workers cache (version is part of the cache key).

Args: `$ARGUMENTS`

1. `git fetch -q origin` then `PREV=$(bash scripts/rf-wait-deploy.sh --latest)`.
2. **redeploy** (no code change): create an empty commit on origin/main without touching the local branch, then go to step 5:
   `SHA=$(git commit-tree 'origin/main^{tree}' -p origin/main -m "chore: redeploy" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>")` → push `$SHA:main`.
3. **normal deploy**, stop and report at any failure:
   - `git status --porcelain` is empty. If not, stop and ask whether to commit.
   - `git merge-base --is-ancestor origin/main HEAD`. If that fails, stop: rebase needed.
   - `node scripts/rf-test.mjs all` (Bash timeout 600000). Must print `OK`.
4. Unless `-y`: show `git log --oneline origin/main..HEAD` + `git diff --stat origin/main..HEAD`, ask to confirm.
   Then `git push origin HEAD:main`.
5. `bash scripts/rf-wait-deploy.sh "$PREV"` (Bash timeout 660000).
6. Reply ≤6 lines: pushed commits, new deployment id, smoke result. On SMOKE FAIL suggest `wrangler rollback` (don't run it).
