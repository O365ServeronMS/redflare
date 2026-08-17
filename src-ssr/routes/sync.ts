import { Hono } from 'hono';
import { requireCronKey } from '../middleware/cronKey';
import {
  syncSlugBatch,
  runIncrementalSync,
  runBackfillPage,
  runRecommendationResolveTick,
} from '../services/sync/orchestrator';
import { SyncStateRepository } from '../repositories/syncStateRepository';
import { MovieRepository } from '../repositories/movieRepository';
import { RecommendationRepository } from '../repositories/recommendationRepository';
import { HeroSnapshotRepository } from '../repositories/heroSnapshotRepository';
import { applyNoStore, purgeEverything } from '../cache/control';
import { SAMPLE_RATE } from '../middleware/requestSampler';
import { refreshHeroSnapshot } from '../services/sync/heroSnapshot';

const FREE_PLAN_DAILY_REQUEST_LIMIT = 100_000;

function parseStoredJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return { invalid: true };
  }
}

export const syncRoute = new Hono<{ Bindings: Env }>();
// Ops routes reflect live/mutating state -- never cache-eligible, including
// the CRON_KEY rejection itself (requireCronKey returns 404 without calling
// next(), so this has to run BEFORE it, not as a separate after-the-fact
// middleware, or an unauthorized 404 could get cached and served to the
// next caller who DOES have the right key).
syncRoute.use('/__sync/*', async (c, next) => {
  applyNoStore(c);
  await next();
});
syncRoute.use('/__sync/*', requireCronKey);

// Reached via env.SELF from runIncrementalSync's fan-out -- see
// services/sync/orchestrator.ts. Not meant to be called directly except for
// manual verification (e.g. `curl -X POST .../__sync/batch/0 -d
// '{"slugs":["..."]}'` with the cron key header).
syncRoute.post('/__sync/batch/:n', async (c) => {
  const body = await c.req.json<{ slugs?: string[] }>().catch(() => ({ slugs: [] }));
  const result = await syncSlugBatch(c.env, body.slugs ?? []);
  return c.json(result);
});

// Manual trigger for the incremental sync pass (plan §2.1). Cron calls this
// same path on the */15 schedule (index.ts scheduled handler).
syncRoute.get('/__sync/run', async (c) => {
  const result = await runIncrementalSync(c.env);
  return c.json(result);
});

// One page of one taxonomy listing, for backfill (Phase 7). Driving the
// full crawl (paging through every type until exhausted, both free-mode
// governed and Paid-mode burst) is orchestrated externally by repeated
// calls to this route -- kept that way deliberately so a stuck/slow page
// can't wedge an entire invocation's wall-time budget.
syncRoute.get('/__sync/backfill-page', async (c) => {
  const type = c.req.query('type');
  const page = Number(c.req.query('page') ?? '1');
  if (!type || !Number.isInteger(page) || page < 1) return c.json({ error: 'type and page required' }, 400);
  const result = await runBackfillPage(c.env, type, page);
  return c.json(result);
});

// Manual trigger for one recommendation-resolve tick (Phase 4). Cron calls
// this same path every */15 tick (index.ts scheduled handler).
syncRoute.get('/__sync/resolve-recommendations', async (c) => {
  const result = await runRecommendationResolveTick(c.env);
  return c.json(result);
});

// Manual, authenticated seed/retry for the Hero snapshot. The regular cron
// does not need CRON_KEY; `force=true` only bypasses the 30-minute success
// gate here so operations can seed Deploy A before the home API cutover.
syncRoute.post('/__sync/refresh-hero', async (c) => {
  const result = await refreshHeroSnapshot(c.env, { force: c.req.query('force') === 'true' });
  return c.json(result);
});

// The "Purge Everything" button for this Worker's cache. The Cloudflare
// dashboard's zone-level Purge Everything does NOT affect Workers Caching
// ("no zone-level purge ... affects Workers Caching content", Cloudflare
// docs /workers/cache/purge/) -- that only worked back when this project
// cached via caches.default. This route is the equivalent, and it runs on
// the default entrypoint, which is where every /api/* response is actually
// cached, so the entrypoint scoping is correct by construction.
//
//   curl -sH "x-cron-key: $CRON_KEY" https://film.bluesia.net/__sync/purge-cache
//
// A deploy (`git push origin main`) also clears everything on its own --
// the Worker version is part of the cache key (wrangler.toml [cache]).
// Use this when you want it cleared WITHOUT shipping a deploy.
syncRoute.get('/__sync/purge-cache', async (c) => {
  const ok = await purgeEverything();
  return c.json({ purgedEverything: ok }, ok ? 200 : 503);
});

syncRoute.get('/__sync/status', async (c) => {
  const syncState = new SyncStateRepository(c.env.DB);
  const movieRepo = new MovieRepository(c.env.DB);
  const heroSnapshot = new HeroSnapshotRepository(c.env.DB);
  const [
    cursor,
    recentLastRun,
    rowsToday,
    catalogCount,
    stubCount,
    backfillDone,
    backfillTypeIndex,
    backfillPage,
    sampledRequests,
    recommendationStats,
    heroRefresh,
  ] = await Promise.all([
    syncState.get('cursor:recent'),
    syncState.get('recent:last_run'),
    syncState.getRowsWrittenToday(),
    movieRepo.countByTier('catalog'),
    movieRepo.countByTier('stub'),
    syncState.get('backfill:done'),
    syncState.get('backfill:type_index'),
    syncState.get('backfill:page'),
    syncState.getSampledRequestsToday(),
    new RecommendationRepository(c.env.DB).getResolveStats(),
    heroSnapshot.getRefreshState(),
  ]);

  // ADR-0002 Finding 7: an estimate, not an exact count -- see
  // middleware/requestSampler.ts for why it's sampled instead of counted
  // per-request.
  const estimatedRequestsToday = sampledRequests * SAMPLE_RATE;

  return c.json({
    cursorRecent: cursor,
    recentSync: parseStoredJson(recentLastRun),
    rowsWrittenToday: rowsToday,
    backfillMode: c.env.BACKFILL_MODE ?? 'free',
    catalogMovieCount: catalogCount,
    stubMovieCount: stubCount,
    maxStubs: Number(c.env.MAX_STUBS ?? '0'),
    recommendation: recommendationStats,
    hero: {
      lastSuccessAt: heroRefresh.lastSuccessAt,
      lastAttemptAt: heroRefresh.lastAttemptAt,
      matchedCount: heroRefresh.lastResult?.matchedCount ?? null,
      readSource: 'snapshot',
      snapshotAgeSeconds: heroRefresh.lastSuccessAt === null
        ? null
        : Math.max(0, Math.floor(Date.now() / 1000) - heroRefresh.lastSuccessAt),
    },
    backfill: {
      done: backfillDone === '1',
      typeIndex: backfillTypeIndex ? Number(backfillTypeIndex) : 0,
      page: backfillPage ? Number(backfillPage) : 1,
    },
    quota: {
      estimatedRequestsToday,
      freeplanDailyLimit: FREE_PLAN_DAILY_REQUEST_LIMIT,
      estimatedPercentUsed: Math.round((estimatedRequestsToday / FREE_PLAN_DAILY_REQUEST_LIMIT) * 1000) / 10,
    },
  });
});
