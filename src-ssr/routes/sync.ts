import { Hono } from 'hono';
import type { Env } from '../types/env';
import { requireCronKey } from '../middleware/cronKey';
import { syncSlugBatch, runIncrementalSync, runBackfillPage } from '../services/sync/orchestrator';
import { SyncStateRepository } from '../repositories/syncStateRepository';
import { MovieRepository } from '../repositories/movieRepository';
import { applyNoStore } from '../cache/control';
import { SAMPLE_RATE } from '../middleware/requestSampler';

const FREE_PLAN_DAILY_REQUEST_LIMIT = 100_000;

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
// same path on the */30 schedule (index.ts scheduled handler).
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

syncRoute.get('/__sync/status', async (c) => {
  const syncState = new SyncStateRepository(c.env.DB);
  const [cursor, rowsToday, catalogCount, backfillDone, backfillTypeIndex, backfillPage, sampledRequests] =
    await Promise.all([
      syncState.get('cursor:recent'),
      syncState.getRowsWrittenToday(),
      new MovieRepository(c.env.DB).countByTier('catalog'),
      syncState.get('backfill:done'),
      syncState.get('backfill:type_index'),
      syncState.get('backfill:page'),
      syncState.getSampledRequestsToday(),
    ]);

  // ADR-0002 Finding 7: an estimate, not an exact count -- see
  // middleware/requestSampler.ts for why it's sampled instead of counted
  // per-request.
  const estimatedRequestsToday = sampledRequests * SAMPLE_RATE;

  return c.json({
    cursorRecent: cursor,
    rowsWrittenToday: rowsToday,
    backfillMode: c.env.BACKFILL_MODE ?? 'free',
    catalogMovieCount: catalogCount,
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
