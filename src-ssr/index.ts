import { Hono } from 'hono';
import type { Env } from './types/env';
import { detailRoute } from './routes/detail';
import { listRoute } from './routes/list';
import { genreRoute } from './routes/genre';
import { countryRoute } from './routes/country';
import { playerRoute } from './routes/player';
import { syncRoute } from './routes/sync';
import { runIncrementalSync, runBackfillTick } from './services/sync/orchestrator';

const app = new Hono<{ Bindings: Env }>();

app.route('/', detailRoute);
app.route('/', listRoute);
app.route('/', genreRoute);
app.route('/', countryRoute);
app.route('/', playerRoute);
app.route('/', syncRoute);

// Home page (/) isn't built yet -- Phase 3 covers detail/list/genre/country
// only (docs/plan-ssr-rearchitecture.md §3). Search is explicitly deferred
// to Phase 6 (FTS5), not reimplemented here.
app.get('/', (c) => c.text('redflare-ssr: Phase 3 -- see /phim/:slug, /danh-sach/:type, /the-loai/:slug, /quoc-gia/:slug, /xem/:slug.'));

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
