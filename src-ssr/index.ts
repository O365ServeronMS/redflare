import { Hono } from 'hono';
import type { Env } from './types/env';
import { apiRoute } from './api/routes';
import { sitemapRoute } from './routes/sitemap';
import { syncRoute } from './routes/sync';
import { securityHeaders } from './middleware/securityHeaders';
import { requestSampler } from './middleware/requestSampler';
import { runIncrementalSync, runBackfillTick, runRecommendationResolveTick } from './services/sync/orchestrator';
import { runRecommendationRefreshTick } from './services/sync/recommendationRefresh';
import { refreshHeroSnapshot } from './services/sync/heroSnapshot';

// Re-exported so wrangler's [[workflows]] class_name bindings
// (wrangler.toml) can resolve them -- Workflows must be exported from the
// main module. docs/plan-free-plan-migration.md Phase 3.
export { IncrementalSyncWorkflow } from './workflows/incrementalSyncWorkflow';
export { HeroSnapshotWorkflow } from './workflows/heroSnapshotWorkflow';
export { RecommendationResolveWorkflow } from './workflows/recommendationResolveWorkflow';
export { RecommendationRefreshWorkflow } from './workflows/recommendationRefreshWorkflow';
export { BackfillWorkflow } from './workflows/backfillWorkflow';

const app = new Hono<{ Bindings: Env }>();

const SPA_DOCUMENT_PATHS = [
  /^\/$/,
  /^\/phim\/[^/]+\/?$/,
  /^\/danh-sach\/[^/]+\/?$/,
  /^\/the-loai\/[^/]+\/?$/,
  /^\/quoc-gia\/[^/]+\/?$/,
  /^\/tim-kiem\/?$/,
];

app.use('*', securityHeaders);
app.use('*', requestSampler);

// Only routes listed in wrangler.toml assets.run_worker_first reach this
// Worker. Static files still bypass it; browser document requests pass
// through only so the response can opt out of Cloudflare HTML injection.
app.route('/', apiRoute);
app.route('/', sitemapRoute);
app.route('/', syncRoute);

app.notFound(async (c) => {
  const isSpaDocument = (c.req.method === 'GET' || c.req.method === 'HEAD')
    && SPA_DOCUMENT_PATHS.some((pattern) => pattern.test(c.req.path));

  if (!isSpaDocument) return c.text('Not found', 404);

  const assetResponse = await c.env.ASSETS.fetch(c.req.raw);
  const headers = new Headers(assetResponse.headers);
  headers.set('Cache-Control', 'public, max-age=0, must-revalidate, no-transform');

  return new Response(assetResponse.body, {
    status: assetResponse.status,
    statusText: assetResponse.statusText,
    headers,
  });
});

export default {
  fetch: app.fetch,

  // LEGACY PATH (docs/plan-free-plan-migration.md Phase 4/5): */15, four
  // jobs sharing one Cron Trigger wall-time budget -- incremental sync ->
  // Hero snapshot refresh (30-minute success gate, so it normally skips) ->
  // recommendation resolve (~3 min budget) -> backfill (~10 min budget,
  // resumes from its own D1 cursor next tick; inert by default now that
  // env.BACKFILL_ENABLED defaults to "false", services/sync/orchestrator.ts
  // runBackfillTick). docs/state-free-plan-migration.md Phase 0 measured
  // this shape -- five jobs, no per-job invocation boundary -- exceeding
  // the Free-plan 50-external-subrequest cap on two of the jobs
  // individually. Running in parallel, on purpose, with the
  // [[workflows]] schedules in wrangler.toml during the migration soak
  // period; remove this handler and the [triggers] cron once those have
  // been observed stable for a few days (plan Phase 5).
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        try {
          const incremental = await runIncrementalSync(env);
          console.info('incremental_sync', incremental);
        } catch (error) {
          console.error('incremental_sync_failed', {
            message: error instanceof Error ? error.message : String(error),
          });
        }
        try {
          const hero = await refreshHeroSnapshot(env);
          console.info('hero_snapshot_refresh', hero);
        } catch (error) {
          // Do not let an unexpected Hero failure starve later cron jobs.
          console.error('hero_snapshot_refresh_failed', error);
        }
        const recommendation = await runRecommendationResolveTick(env);
        console.info('recommendation_resolve', recommendation);
        const recommendationRefresh = await runRecommendationRefreshTick(env);
        console.info('recommendation_refresh', recommendationRefresh);
        await runBackfillTick(env);
      })()
    );
  },
};
