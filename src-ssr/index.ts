import { Hono } from 'hono';
import type { Env } from './types/env';
import { detailRoute } from './routes/detail';
import { syncRoute } from './routes/sync';
import { runIncrementalSync } from './services/sync/orchestrator';

const app = new Hono<{ Bindings: Env }>();

app.route('/', detailRoute);
app.route('/', syncRoute);

app.get('/', (c) => c.text('redflare-ssr: Phase 1/2 skeleton. See /phim/:slug and /__sync/status.'));

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
