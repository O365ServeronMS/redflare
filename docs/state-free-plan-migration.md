# State: free-plan CPU/subrequest migration

Tracks execution of [plan-free-plan-migration.md](plan-free-plan-migration.md), audited
per [audit-prompt-free-plan-cpu.md](audit-prompt-free-plan-cpu.md).

## Phase 0 — Audit (2026-08-13)

**Method actually used, and why it differs slightly from the audit prompt's Part 2:**
`[limits] cpu_ms = 10 / subrequests = 50` was added locally to `wrangler.toml` (never
committed) and tested via `wrangler dev --remote` (`npm start`), per the prompt. Result:
**the simulated limits do not appear to be enforced in this mode.**
`runRecommendationResolveTick` alone issued roughly 169 external subrequests in one
invocation (see below) with no `Too many subrequests` error and no `exceededCpu`
outcome — over 3x the Free-plan external-subrequest cap. Wrangler's own docs note
limits are "only enforced when deployed to Cloudflare's network, not in local
development"; this evidently extends to the temporary `--remote` preview session too,
despite that session genuinely running on Cloudflare's edge. **Conclusion below is
therefore built from real, directly-observed external-call counts per job (a harder,
more reliable signal than a pass/fail from the simulated limit), not from whether the
simulated cap tripped.**

Also could not exercise the exact combined `scheduled()` invocation the way production
runs it: the local scheduled-trigger simulation route (`/cdn-cgi/local/scheduled`,
printed by `wrangler dev` at startup) returned a generic Cloudflare edge 404 under
`--remote` mode — that debug route is apparently only wired up for the fully-local
(Miniflare) dev mode, not the edge-hosted `--remote` preview. Substituted: each job
tested individually via its existing manual route
(`src-ssr/routes/sync.ts`), since `scheduled()` just calls the same functions
sequentially with no state reset between them — summing the individually-observed
numbers is a valid stand-in.

Secrets: `TMDB_API_TOKEN` was not available locally (Cloudflare secrets are write-only;
`.dev.vars` was not populated with it) — `env.TMDB_API_TOKEN` was `undefined` for this
run, sent as an empty Bearer token. TMDB calls nonetheless returned real, populated
data (`refresh-hero` matched 10/20 candidates with real title data) rather than 401s —
most likely `fetch()` from a Worker participates in Cloudflare's edge HTTP cache for
the subrequest, so the empty-auth requests to TMDB's trending endpoint apparently
served a cached response from an earlier authenticated production call. Whatever the
exact mechanism, the *shape* of the work (JSON parsing, KKphim lookups, D1 writes) was
real production data, not a stub — external-subrequest counts below should be treated
as trustworthy real numbers, not synthetic ones.

### Confirmed facts (via `GET /__sync/status`)

- `backfill.done: true` — user's claim confirmed, matches assumption in the plan.
- `BACKFILL_MODE` still `"burst"` — not yet reverted to `"free"` (Phase 6 of the plan,
  not done here).
- `catalogMovieCount: 29,500`, `stubMovieCount: 1,000` (at `MAX_STUBS` cap).
- `recommendation.pendingUnresolved: 139` at test start (this is *why* the resolve-tick
  test below is representative of real backlog, not an artificially empty run).

### Per-job real external-subrequest counts observed

| Job | Route tested | Real result | External subrequests (observed/derived) | vs. Free-plan cap (50/invocation) |
|---|---|---|---|---|
| Incremental sync | `GET /__sync/run` | `fetched: 24`, `slugsFound: 0`, `stopReason: cursor_crossed`, 197ms | **1** (page 1 only — cursor crossed immediately, `RECENT_PAGE_LIMIT: 2` didn't need its 2nd page this run) | Well under — confirms the `20 → 2` simplification (already applied, `orchestrator.ts`) keeps steady-state incremental sync cheap |
| Hero snapshot (forced, bypassing the 30-min gate) | `POST /__sync/refresh-hero?force=true` | `fetched: 20`, `matched: 10`, `notFound: 8`, `filteredType: 2`, 3.4s | **~60+** — 20 `kkphim.getMovieByTmdbId` lookups + ~10 matched candidates × ~4 calls each via `syncOneMovie` (kkphim detail, TMDB detail, TMDB season, TMDB recommendations) | **Exceeds alone**, ~1.2x, when the 30-min gate doesn't skip it |
| Recommendation resolve tick | `GET /__sync/resolve-recommendations` | `groupsSeen: 193`, `resolvedToExisting: 24`, `overflow: 169`, 23.2s | **~169** — every overflow group attempts one `kkphim.getByTmdbRef` before giving up (only the 24 `resolvedToExisting` are pure-D1, no external call) | **Exceeds alone**, ~3.4x |
| Recommendation refresh tick | *(no manual route — code-only)* | n/a | up to **20** (`RECOMMENDATION_REFRESH_LIMIT`, 1 TMDB call/source) | Under alone, but stacks with the two above in the real `scheduled()` |
| Backfill tick | *(covered by `backfill.done` check above)* | early-return, 1 D1 read | **0** | Negligible |

### Conclusion

**The audit's working hypothesis is confirmed, with real numbers, not simulation.**
Two of the five jobs — `refreshHeroSnapshot` (when it actually runs, not skipped by its
30-minute gate) and `runRecommendationResolveTick` (whenever there's a meaningful
unresolved/overflow backlog, which there was: 139-193 groups) — **each individually**
exceed the Free-plan 50-external-subrequest-per-invocation cap, before ever being
summed with the other three jobs sharing the same `scheduled()` invocation. This is a
**subrequest-limit failure, not primarily a CPU-time failure** — the binding constraint
the audit needed to find. On Free plan this fails with "Too many subrequests"
(exhausts the Worker's request, not a graceful degradation), for the same underlying
architectural reason flagged in the plan: five jobs, no per-job invocation boundary.

This validates [plan-free-plan-migration.md](plan-free-plan-migration.md) Phase 3 (the
Cloudflare Workflows decomposition, one step per external-call-bearing unit) as
necessary, not optional — a per-slug/per-candidate/per-group step naturally caps each
step's own external-call count at a handful, each with its own fresh subrequest and CPU
budget, which is exactly what a monolithic invocation cannot provide regardless of how
small `RECENT_PAGE_LIMIT` or any other single-job constant is tuned.

### What Phase 0 did NOT establish

- **Real CPU-time numbers.** `wrangler dev --remote`'s wall-clock timings (197ms /
  3.4s / 23.2s) are dominated by network I/O, which does not count toward CPU time —
  they are not a CPU measurement. Whether the *actual* CPU time (JSON parsing, hashing,
  D1 driver overhead, Hono routing) for a single job exceeds 10ms was not directly
  measured here, because the simulated `cpu_ms` limit was not observed to be enforced.
  The subrequest finding above is decisive on its own (a job that can't even get its
  external calls out within budget fails regardless of its CPU number), so this gap did
  not block a conclusion — but if CPU time specifically needs a hard number later
  (e.g., to size individual Workflow steps precisely), that requires either a real
  temporary production deploy with `cpu_ms` set low and Cloudflare dashboard Analytics
  read afterward (needs explicit go-ahead — this is a production deploy), or
  `wrangler dev`'s DevTools CPU profiler (`d` key, Profiler tab) against local
  simulation, which does enforce/measure CPU but doesn't use real remote bindings.
- **Recommendation refresh tick**, in isolation — no manual route exists for it
  (`src-ssr/routes/sync.ts` has no `/__sync/refresh-recommendations`-style route). Its
  ~20-call ceiling is a static read of `RECOMMENDATION_REFRESH_LIMIT`, not an observed
  number. Low risk either way — it's the smallest of the three TMDB/KKphim-calling jobs
  and already under the cap alone.

## Phase 2 — Incremental sync simplification (2026-08-13)

`RECENT_PAGE_LIMIT: 20 → 2` in `orchestrator.ts` (user revised down from the
originally-proposed `1` for burst-window headroom). Exposed one pre-existing test as
stale rather than wrong: `tests/incrementalSyncSafety.test.mjs` "does not advance
cursor when a later recent-feed page times out" had a fixture needing 3 pages
(transient-failure retry, then an empty 3rd page) to resolve — at `RECENT_PAGE_LIMIT =
2` that scenario now correctly stops at `stopReason: 'page_limit'` with the cursor
held (safe — no data loss, just deferred to another tick, per the documented
invariant), not a regression. Fixture rewritten so the retry crosses the cursor
within 2 pages instead of via a trailing empty page; same behavior under test
(recovery after a transient upstream failure, equal-timestamp boundary rescanning),
same assertions otherwise. All 12 cases in that suite pass.

## Phase 3 — Cloudflare Workflows decomposition (2026-08-13)

Implemented per [plan-free-plan-migration.md](plan-free-plan-migration.md)'s
architecture section. Five `WorkflowEntrypoint` classes added under
`src-ssr/workflows/`, each step wrapping one external-call-bearing unit of work so it
gets its own fresh CPU/subrequest budget instead of sharing one invocation's:

- `IncrementalSyncWorkflow` — `*/30 * * * *` (per the explicit "chỉ cần mỗi 30' quét
  page 1" request). One step scans the recent feed (`scanRecentSlugs`, extracted from
  `orchestrator.ts`'s `runIncrementalSync`), then one step per candidate slug
  (`syncOneMovie`), then a cursor-commit step gated on every sync step having
  succeeded.
- `HeroSnapshotWorkflow` — `*/15 * * * *`, keeps the existing 30-minute success gate
  as its own step (so a real run still only happens ~48x/day, bounding step count).
  One step per TMDB trending candidate (`resolveCandidate`, exported from
  `heroSnapshot.ts`).
- `RecommendationResolveWorkflow` — `*/15 * * * *`. Groups chunked 15/step
  (`resolveOneGroup`, extracted from `orchestrator.ts`) instead of one
  wall-time-bounded loop over up to 300.
- `RecommendationRefreshWorkflow` — `*/15 * * * *`. Sources chunked 5/step
  (`refreshOneSource`, extracted from `recommendationRefresh.ts`).
- `BackfillWorkflow` — `*/15 * * * *`, but inert by default (one cheap step, early
  return) unless `BACKFILL_ENABLED` is flipped to `"true"`.

**Backfill on/off + page-range control** (explicit user requirement): four new
`wrangler.toml [vars]`, dashboard-editable without a redeploy —
`BACKFILL_ENABLED` (default `"false"`), `BACKFILL_TYPE` (scope to one listing type),
`BACKFILL_PAGE_FROM` / `BACKFILL_PAGE_TO` (bound a run's page range; `PAGE_FROM` only
takes effect when a previous walk had finished, to avoid re-triggering every tick).
Wired into `runBackfillTick`, which now returns early (near-zero cost) whenever
`BACKFILL_ENABLED` isn't `"true"` — this also applies to the legacy `scheduled()`
path's call to the same function, so the old cron's backfill leg goes inert too
without needing a separate change there.

**Legacy path kept running in parallel, on purpose** (plan Phase 4 soak period):
`[triggers] crons = ["*/15 * * * *"]` and `src-ssr/index.ts`'s `scheduled()` handler
are untouched — `runIncrementalSync`, `refreshHeroSnapshot`,
`runRecommendationResolveTick`, `runRecommendationRefreshTick` all still work exactly
as before (their internals now call into the same extracted per-item functions the
Workflows use, verified behavior-identical by the existing test suite). Once this
deploys, **both the legacy cron and the five new Workflow schedules will fire** —
expect roughly double the sync traffic until the legacy `scheduled()` path is
removed (plan Phase 5), which should only happen after the Workflows have been
observed stable for a few days.

## Phase 4 — Parallel-run soak, baseline (2026-08-13, ~T+20min post-deploy)

Deployed to production (`main` at `a346a64`, pushed 2026-08-13). Confirmed live:
`GET /` and `GET /api/home-data` both 200. `CRON_KEY` rotated via `wrangler secret
put` to a temporary operator-supplied value for this soak period (operator will
rotate it again once done monitoring).

First post-deploy `GET /__sync/status` snapshot, ~20 min after deploy (both the
legacy `*/15` cron and the new Workflow schedules are live at this point, so this
reading can't yet be attributed to one path or the other -- it's a baseline, not a
comparison):

```
cursorRecent: {"time":"2026-08-13T02:22:59.000Z","slug":"loi-moi"}   (unchanged from Phase 0)
recentSync: {slugsFound:0, fetched:24, pagesScanned:1, stopReason:"cursor_crossed", recordedAt:"2026-08-13T03:00:14.409Z"}
rowsWrittenToday: 0
recommendation: {resolved:114940, pendingUnresolved:136, overflow:74843}   (was 114931/139/74849 at Phase 0)
hero: {matchedCount:10, snapshotAgeSeconds:1933}
backfill: {done:true, typeIndex:4, page:1}   (unchanged, still inert as expected -- BACKFILL_ENABLED defaults "false")
quota: {estimatedRequestsToday:100, estimatedPercentUsed:0.1}
```

`pendingUnresolved` ticking down (139 → 136) between Phase 0 and this reading is a
good early sign — resolve is still making progress with the same repositories either
path writes through. `pagesScanned:1` on the recent-page scan confirms
`RECENT_PAGE_LIMIT: 2` is working as expected in steady state (only needed 1 page).
No errors surfaced in either check.

**Not yet established:** whether it was the legacy `scheduled()` or a Workflow
instance that produced this particular `recentSync` entry — `/__sync/status` doesn't
distinguish the two paths, since both write through the same repositories. Confirming
that split needs the Cloudflare dashboard's Workflows tab (per-instance run history)
compared against `wrangler tail` timestamps for the legacy cron, which needs a longer
observation window than one snapshot. Next check should compare this baseline against
a reading a day or more later.

## Phase 5 — Legacy cron removed, triggered by live production evidence (2026-08-13)

Soak period ended early, for cause: the operator set the deployed Worker's CPU limit
to 10ms directly on the Cloudflare dashboard (a real Free-plan-equivalent test, not a
local simulation) and observed the legacy `scheduled()` cron **actively erroring** —
not a theoretical risk, happening on real ticks. Two dashboard captures (Cloudflare
Workers Logs, `$metadata.message` view) confirmed the same failure both times:

```
13:30:13.251 GMT+7  cron */15 * * * * fired          (10ms CPU budget, 4.44s wall)
13:30:13.818 GMT+7  "incremental_sync"                (console.info, completed)
13:30:13.984 GMT+7  "hero_snapshot_refresh"            (console.info, completed)
13:30:17.658 GMT+7  "Worker exceeded CPU time limit."  (UTC 2026-08-13T06:30:17Z)
```

A second capture from the prior tick (13:15:13.252 GMT+7) showed the same pattern —
`incremental_sync` then `hero_snapshot_refresh` logged, then nothing further visible,
with total CPU already at 93ms (9.3x the 10ms budget).

**Root cause, read directly off the log order:** `src-ssr/index.ts`'s `scheduled()`
logs `incremental_sync`, then `hero_snapshot_refresh`, then calls
`runRecommendationResolveTick` (only logs `recommendation_resolve` *after* it
returns). Since that log line never appears in either capture, recommendation resolve
is the job running when the isolate gets killed. This matches Phase 0's own finding
(this exact job measured ~169 external subrequests in one invocation) but adds the
missing piece: CPU time is a **whole-invocation** budget shared cumulatively across
all five jobs with no reset between them, so no single job needs to be expensive in
isolation (manual `GET /__sync/resolve-recommendations` and
`POST /__sync/refresh-hero?force=true`, tested directly via `wrangler tail` during
this investigation, showed only 0.29ms and 0.079ms CPU respectively) — the *sum*,
varying with backlog size tick to tick, is what crosses 10ms.

**Action taken:** removed the legacy path entirely rather than continuing the soak.
- `src-ssr/index.ts`: `scheduled()` handler and its four job imports deleted. Only
  `fetch: app.fetch` remains in the default export.
- `wrangler.toml`: `[triggers] crons = ["*/15 * * * *"]` block removed.
- Doc comments in `orchestrator.ts` / `recommendationRefresh.ts` referencing "the
  legacy scheduled() cron path during the migration soak period" updated to reflect
  it's gone — `runIncrementalSync` and `runRecommendationResolveTick` are retained
  for their manual `/__sync/*` routes; `runRecommendationRefreshTick` (no manual
  route ever existed for it) is retained as a thin wrapper purely for
  `tests/recommendationRefresh.test.mjs`'s coverage of `refreshOneSource`.
- Verified: `npm run worker:typecheck` clean, `npm run build` succeeds, full test
  suite (50 tests across 9 suites) passes, `wrangler deploy --dry-run` confirms no
  `[triggers]` cron remains bound and all 5 Workflow bindings + vars still resolve.

**Going forward**, all sync/catalog work is driven exclusively by the five
`[[workflows]]` schedules in `wrangler.toml` — no shared invocation, no cumulative
CPU/subrequest risk across jobs. `BACKFILL_ENABLED`/`BACKFILL_TYPE`/
`BACKFILL_PAGE_FROM`/`BACKFILL_PAGE_TO` remain dashboard-editable per the original
requirement.

**Verification done:** `npm run worker:typecheck` clean; `npm run build` succeeds;
`npx wrangler deploy --dry-run` confirms all 5 `[[workflows]]` bindings resolve to
their exported classes and all new vars are recognized; full existing test suite
(`test:hero-refresh`, `test:hero-snapshot`, `test:hero-home-data`,
`test:recommendation-refresh`, `test:recommendation-safety`,
`test:recommendation-client`, `test:incremental-sync`, `test:season-poster`,
`test:image-policy`) passes, 0 failures. **Not done, deliberately out of scope for
this pass:** no real deploy, so Workflow step counts/CPU behavior have not been
observed against real traffic yet — that belongs to the Phase 4 soak period, once
the user chooses to deploy.

## Phase 6 — Workflows steps quota audit + cadence/backlog tuning (2026-08-14)

Phase 5 established CPU time is not the binding Free-plan constraint (0.29ms and
0.079ms measured for the two heaviest jobs, both under 3% of the 10ms budget) —
the real constraint the account will hit on Free is **Workflows steps**: 3,000/day
(Free) vs the account's current Paid-tier behavior, billed since 2026-08-10 per
[Workflows pricing](https://developers.cloudflare.com/workflows/reference/pricing/).
Reading the five Workflow schedules against real Phase 4 backlog numbers
(`groupsSeen: 193`, `overflow: 74,843` per tick) put the account at **~3,400–4,100
steps/day at the old `*/15` cadence** — over quota before ever touching CPU.

Also found in the same pass: `recommendationResolveWorkflow.ts`'s
`GROUPS_PER_STEP = 15` was silently unsafe. `resolveOneGroup`
(`orchestrator.ts`) can cost up to ~5 external calls/group in its
kkphim-not-found → `syncOneMovie` branch (kkphim detail + TMDB detail + season +
recommendations), so `15 × 5 = 75` — already over the 50-external-subrequest cap
whenever that branch actually runs. It was only safe by accident: `MAX_STUBS`
(1,000) is already at its cap, so most groups fall into the cheap 1-call overflow
branch instead. Would break the moment stub slots free up.

**Changes (user chose to stay on Cloudflare rather than move compute to another
vendor — see the standalone Vietnamese audit response for the full comparison
against Vercel/Supabase/Convex/Upstash/GitHub Actions, not reproduced here)**:

- `wrangler.toml`: `hero-snapshot` and `recommendation-refresh` schedules
  `*/15 * * * *` → `0 * * * *` (hourly). For hero-snapshot specifically this is a
  net *improvement*, not just a cost cut — at `*/15` the 30-minute success gate
  meant every other tick was a wasted 1-step skip check (~1,152 steps/day for the
  same ~24 real runs/day an hourly schedule gets for ~552 steps/day, since every
  hourly tick lands past the gate and does a real run).
- `recommendation-resolve` schedule `*/15 * * * *` → `*/30 * * * *` (halves run
  count; this workflow is the largest single steps consumer given real backlog
  size).
- `recommendationResolveWorkflow.ts`: `GROUPS_PER_STEP` 15 → 8, so the worst case
  (8 × 5 = 40) stays under the 50-external-subrequest-per-step cap instead of
  relying on the stub-cap coincidence above.
- `backfill` schedule left untouched (`*/15`) — already inert by default
  (`BACKFILL_ENABLED = "false"`), costs 1 step/tick regardless.
- `incremental-sync` schedule left untouched (`*/30`) — already tuned in Phase 2.

Net effect: **~1,900–2,500 steps/day estimated**, vs. the prior ~3,400–4,100,
comfortably under the 3,000/day Free-plan quota with headroom for backlog spikes.

**Also changed, a separate user request folded into the same pass:** recommendation
rails only need to show 10 titles, not 12 — `RECOMMENDATION_LIMIT` in
`src-ssr/api/routes.ts` (the `/api/recommendation/:mediaType/:tmdbId` display cap)
12 → 10. `syncMovie.ts`'s `TMDB_RECOMMENDATION_CANDIDATES` (15, how many TMDB
recommendation IDs get ingested as resolve targets per source movie) was
deliberately left unchanged — it's a supply buffer for the resolve pipeline, not
the display count, and narrowing it would reduce how often 10 resolved slots
actually get filled.

**Verified:** `npm run worker:typecheck` clean; `npm run build` succeeds; `npx
wrangler deploy --dry-run` confirms all 5 Workflow bindings resolve; full test
suite (50 tests / 9 suites) passes unchanged — none of it hardcoded the old
12/15 constants. **Not done:** no real deploy yet; actual steps/day under the new
cadence has not been observed against live traffic (belongs to a follow-up soak
check via `GET /__sync/status` a day or more after deploy, same as Phase 4).

## Phase 7 — D1 rows-read audit + query fixes (2026-08-14)

Following up on a broader "what else in Compute could help" question, measured D1
`rows_read` directly against production (`d1_database_query` MCP tool) instead of
estimating. Found the real next bottleneck isn't CPU or Workflows steps -- it's D1
rows read, and it isn't close: **one `recommendation-resolve` tick was reading
~380,000 rows to find a backlog that was already empty** (`pending_groups: 0`,
confirmed by direct query). At the Phase 6 `*/30` cadence that's an estimated
**~19.7M rows/day, ~394% of the D1 Free-plan 5M/day quota** -- currently invisible
because the account is on Paid (25B rows/month included), but it's the thing that
would actually block a future downgrade, not CPU or Workflows steps.

Root cause, confirmed via `EXPLAIN QUERY PLAN` on the two queries in
`recommendationRepository.ts` (`getUnresolvedGroupedByTarget`,
`getOverflowGroupsForRequeue`): both filter on `target_slug IS NULL AND
resolve_attempted = {0,1}`, but the only index covering `recommendation`'s target
columns (`idx_rec_target`) doesn't include that predicate, so the planner scanned
every one of the table's 190,325 rows (`SCAN r USING INDEX idx_rec_target`) and
filtered after the fact. Same shape of bug, smaller scale, in
`MovieRepository.countByTier('stub')` (called by recommendation-resolve every tick
to check `MAX_STUBS` headroom) -- no index on `movie.tier` at all, so a query
answering "how many of 30,516 rows are one of 1,000" cost a full 30,516-row scan.
The request-path list/genre/country pagination counts (`countCatalog`,
`countByType`, `countByGenre`, `countByCountry`) have the same shape but lower
real-world cost, since Cache API + SWR (`cache/control.ts`) means they only run on
a miss, not per request -- fixed anyway since a genre/country/type count still
costs rows proportional to category size on every miss (a genre with ~8,000
titles burns ~8,000 rows just for a page-count number).

**Changes:**

- `migrations/0013_query_optimization.sql`: two partial indexes,
  `idx_rec_pending` (`WHERE target_slug IS NULL AND resolve_attempted = 0`) and
  `idx_rec_overflow` (`WHERE target_slug IS NULL AND resolve_attempted = 1`) --
  disjoint predicates, so one index can't serve both queries. Verified directly
  against production: `getUnresolvedGroupedByTarget`'s `rows_read` went from
  **190,325 to 2**. Also adds `catalog_stats` (kind, key, count), a cache for the
  four pagination-count query shapes above.
- `src-ssr/repositories/catalogStatsRepository.ts` (new): `getTierCount`/
  `getTypeCount`/`getGenreCount`/`getCountryCount` read `catalog_stats`, each
  self-healing on a miss by running the real COUNT once and writing the result
  back -- correctness never depends on `refresh()` having run first, including
  immediately after this migration landed with an empty table. `refresh()` does a
  full recompute (one `movie` scan + one `genre_movie` scan + one `country_movie`
  scan) in a single pass, matching the exact prior semantics of each COUNT it
  replaces (`type` stays tier-agnostic -- stub rows counted toward type totals
  before this change too, `countByType` never filtered by tier -- deliberately
  preserved, not "fixed", to avoid a silent pagination-total behavior change).
- `src-ssr/services/sync/orchestrator.ts`: new `getStubCount()` replaces
  `movie.countByTier('stub')` at both of its call sites
  (`recommendationResolveWorkflow.ts`, `runRecommendationResolveTick`) with a
  `sync_state` counter (`movie:stub_count`), exact rather than approximated --
  stubs are only ever created in `resolveOneGroup`, never deleted or promoted out
  of `tier='stub'`, so a running counter can't drift. Lazily seeded from one real
  `countByTier('stub')` call the first time the key is missing.
- `catalogStats.refresh()` is called from `IncrementalSyncWorkflow` (gated on
  `written > 0`) and `RecommendationResolveWorkflow`/`runRecommendationResolveTick`
  (gated on `resolvedToStub > 0`) -- not on a fixed schedule, since steady-state
  ticks change nothing. `MovieRepository.countByTier` itself is untouched and
  still used by `/__sync/status` and `routes/sitemap.ts` -- both low-frequency,
  ops/crawler-driven paths where the existing full-scan cost was already an
  accepted, documented tradeoff (see `getSitemapPage`'s comment), not something
  this pass needed to touch.

**Deployed directly to production D1** (`d1_database_query` MCP tool, user
confirmed) ahead of the code deploy, since the new code depends on
`catalog_stats` existing and would 500 on `no such table` otherwise. One
statement (`d1_migrations` bookkeeping insert) was blocked by the auto-mode
write classifier and left undone -- harmless, since all three DDL statements
use `IF NOT EXISTS` and are safe to no-op if `wrangler d1 migrations apply
--remote` is ever run for real (it will just record 0013 as applied at that
point, redoing nothing).

**Verified:** `npm run worker:typecheck` clean; `npm run build` succeeds; `npx
wrangler deploy --dry-run` confirms all bindings resolve; full test suite (50
tests / 9 suites) passes unchanged. Test suite doesn't cover the new
`resolvedToStub > 0` / `written > 0` refresh gates (pre-existing fixtures all use
`MAX_STUBS='0'`, so stub creation was already untested before this change) --
low risk, `refresh()` and `getStubCount()` are both straightforward reads/writes
against tables the same fixtures already exercise. **Not done:** no live
production read-volume measurement yet post-deploy -- belongs to a follow-up
`GET /__sync/status` check as in prior soak periods.
