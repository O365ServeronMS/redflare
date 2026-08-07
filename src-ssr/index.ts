import { Hono } from 'hono';
import type { Env } from './types/env';
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
import { runIncrementalSync, runBackfillTick } from './services/sync/orchestrator';

const app = new Hono<{ Bindings: Env; Variables: { nonce: string } }>();

app.use('*', securityHeaders);
app.use('*', requestSampler);

app.route('/', detailRoute);
app.route('/', listRoute);
app.route('/', genreRoute);
app.route('/', countryRoute);
app.route('/', playerRoute);
app.route('/', searchRoute);
app.route('/', sitemapRoute);
app.route('/', syncRoute);

// Home page (/) isn't built yet -- Phase 3 covers detail/list/genre/country,
// Phase 6 adds search/sitemap (docs/plan-ssr-rearchitecture.md §3, §6).
app.get('/', (c) =>
  c.text(
    'redflare-ssr: see /phim/:slug, /danh-sach/:type, /the-loai/:slug, /quoc-gia/:slug, /xem/:slug, /tim-kiem?q=, /sitemap.xml.'
  )
);

// Every route-level 404 already sets its own short cache (cache/control.ts
// apply404Cache); this is the catch-all for paths no route even attempted
// to match.
app.notFound((c) => {
  apply404Cache(c);
  return c.text('Not found', 404);
});

export default {
  fetch: app.fetch,

  // */30, same cadence for both jobs. Incremental sync runs first (small,
  // bounded, keeps recent titles fresh); backfill (Phase 7) gets the rest
  // of this invocation's 15-min wall-time budget and resumes from its own
  // D1 cursor next tick -- see services/sync/orchestrator.ts
  // runBackfillTick for why this replaced the "curl a CRON_KEY route
  // repeatedly" design the plan originally sketched.
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        await runIncrementalSync(env);
        await runBackfillTick(env);
      })()
    );
  },
};
