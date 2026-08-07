import { Hono } from 'hono';
import type { Env } from './types/env';
import { detailRoute } from './routes/detail';
import { listRoute } from './routes/list';
import { genreRoute } from './routes/genre';
import { countryRoute } from './routes/country';
import { playerRoute } from './routes/player';
import { syncRoute } from './routes/sync';
import { runIncrementalSync } from './services/sync/orchestrator';

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

  // */30, same cadence as production's warm refresh (wrangler.ssr.toml).
  // Only handles incremental sync -- backfill (Phase 7) is triggered on
  // demand via /__sync/backfill-page, deliberately never on a schedule, so
  // burst mode can't accidentally overlap a governed tick.
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runIncrementalSync(env));
  },
};
