import { Hono } from 'hono';
import type { Env } from './types/env';
import { apiRoute } from './api/routes';
import { homeRoute } from './routes/home';
import { detailRoute } from './routes/detail';
import { listRoute } from './routes/list';
import { genreRoute } from './routes/genre';
import { countryRoute } from './routes/country';
import { playerRoute } from './routes/player';
import { searchRoute } from './routes/search';
import { sitemapRoute } from './routes/sitemap';
import { syncRoute } from './routes/sync';
import { securityHeaders } from './middleware/securityHeaders';
import { requestSampler } from './middleware/requestSampler';
import { apply404Cache } from './cache/control';
import { runIncrementalSync, runBackfillTick, runRecommendationResolveTick } from './services/sync/orchestrator';

const app = new Hono<{ Bindings: Env; Variables: { nonce: string } }>();

app.use('*', securityHeaders);
app.use('*', requestSampler);

// /api/* mounted first -- docs/plan-restore-spa-frontend.md Phase F2. Not a
// routing-precedence necessity in Hono (paths don't overlap with the SSR
// routes below), just keeps the "this is the layer that matters for F5's
// cutover" grouping visible in one place.
app.route('/', apiRoute);

app.route('/', homeRoute);
app.route('/', detailRoute);
app.route('/', listRoute);
app.route('/', genreRoute);
app.route('/', countryRoute);
app.route('/', playerRoute);
app.route('/', searchRoute);
app.route('/', sitemapRoute);
app.route('/', syncRoute);

// Every route-level 404 already sets its own short cache (cache/control.ts
// apply404Cache); this is the catch-all for paths no route even attempted
// to match.
app.notFound((c) => {
  apply404Cache(c);
  return c.text('Not found', 404);
});

export default {
  fetch: app.fetch,

  // */30, three jobs sharing one 15-min Cron Trigger wall-time budget:
  // incremental sync (small, bounded, keeps recent titles fresh) ->
  // recommendation resolve (Phase 4, ~3 min budget -- cheap, high UX
  // value per minute, so it runs before backfill) -> backfill (Phase 7,
  // ~10 min budget, resumes from its own D1 cursor next tick). All three
  // are cron-driven rather than CRON_KEY-HTTP-driven for the same reason
  // (see runBackfillTick's doc comment in services/sync/orchestrator.ts).
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        await runIncrementalSync(env);
        await runRecommendationResolveTick(env);
        await runBackfillTick(env);
      })()
    );
  },
};
