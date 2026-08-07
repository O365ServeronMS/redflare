import type { Env } from '../../types/env';
import { MovieRepository } from '../../repositories/movieRepository';
import { EpisodeRepository } from '../../repositories/episodeRepository';
import { RecommendationRepository } from '../../repositories/recommendationRepository';
import { TaxonomyRepository } from '../../repositories/taxonomyRepository';
import { SyncStateRepository } from '../../repositories/syncStateRepository';
import { KkphimClient } from './kkphimClient';
import { TmdbClient } from './tmdbClient';
import { syncOneMovie, type SyncOneResult } from './syncMovie';
import { RateLimiter, PHIMAPI_AGGREGATE_RPS, TMDB_AGGREGATE_RPS } from './throttle';

// Free-plan-only governor (ADR-0002 Finding 2 / plan §2.2). 85,000, not
// 100,000: leaves ~15% headroom for FTS writes (Phase 6), the Phase 4
// recommendation-resolve step, and estimate error -- discovered the hard
// way once already in this project's history (D1's undocumented param cap;
// this time the margin is deliberate, not a retrofit).
const MAX_ROWS_PER_DAY = 85_000;

// Matches the production worker's shard fan-out pattern (worker/lib/home.js,
// worker/lib/mirror.js) rather than inventing a new one.
const SHARD_COUNT = 5;
const PER_SHARD_CONCURRENCY = 6; // Workers free/paid: 6 simultaneous outgoing connections/invocation
const RECENT_PAGE_LIMIT = 20; // pages of /danh-sach/phim-moi-cap-nhat to scan before giving up on this tick

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i] as T);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function buildRepos(env: Env) {
  return {
    movie: new MovieRepository(env.DB),
    episode: new EpisodeRepository(env.DB),
    recommendation: new RecommendationRepository(env.DB),
    taxonomy: new TaxonomyRepository(env.DB),
    syncState: new SyncStateRepository(env.DB),
  };
}

function buildClients(env: Env, shardDivisor = SHARD_COUNT) {
  return {
    kkphim: new KkphimClient(new RateLimiter(PHIMAPI_AGGREGATE_RPS / shardDivisor)),
    tmdb: new TmdbClient(env.TMDB_API_TOKEN ?? '', new RateLimiter(TMDB_AGGREGATE_RPS / shardDivisor)),
  };
}

export interface ShardResult {
  processed: number;
  written: number;
  unchanged: number;
  errors: number;
  rowsWritten: number;
  governed: boolean;
}

/** Syncs one shard's worth of slugs. Called both directly (single-shard
 * dev/test) and via the /__sync/batch/:n route reached through env.SELF
 * from runIncrementalSync's fan-out. */
export async function syncSlugBatch(env: Env, slugs: readonly string[]): Promise<ShardResult> {
  const repos = buildRepos(env);
  const clients = buildClients(env);

  const governed = env.BACKFILL_MODE !== 'burst';
  if (governed) {
    const rowsToday = await repos.syncState.getRowsWrittenToday();
    if (rowsToday >= MAX_ROWS_PER_DAY) {
      return { processed: 0, written: 0, unchanged: 0, errors: 0, rowsWritten: 0, governed: true };
    }
  }

  const outcomes = await mapLimit(slugs, PER_SHARD_CONCURRENCY, (slug) =>
    syncOneMovie(env, slug, clients, repos)
  );

  const summary = outcomes.reduce(
    (acc, r: SyncOneResult) => {
      acc.processed++;
      acc.rowsWritten += r.rowsWritten;
      if (r.outcome === 'written') acc.written++;
      else if (r.outcome === 'unchanged') acc.unchanged++;
      else acc.errors++;
      return acc;
    },
    { processed: 0, written: 0, unchanged: 0, errors: 0, rowsWritten: 0 }
  );

  if (summary.rowsWritten > 0) await repos.syncState.addRowsWrittenToday(summary.rowsWritten);

  return { ...summary, governed: false };
}

function chunkInto<T>(items: readonly T[], parts: number): T[][] {
  const out: T[][] = Array.from({ length: parts }, () => []);
  items.forEach((item, i) => out[(i % parts) as number]!.push(item));
  return out.filter((c) => c.length > 0);
}

/** Incremental sync (plan §2.1): scan /danh-sach/phim-moi-cap-nhat pages
 * newest-first until we cross the last-seen cursor, fan the collected slugs
 * out across shards via the SELF service binding (same reasoning as
 * worker/lib/home.js: a Worker fetch()-ing its own Custom Domain 522s; a
 * service binding does not touch the public network at all), then advance
 * the cursor only if the whole pass completed cleanly -- a partial failure
 * re-scans the same window next tick rather than silently skipping items. */
export async function runIncrementalSync(env: Env): Promise<{ slugsFound: number; shards: ShardResult[] }> {
  const repos = buildRepos(env);
  const clients = buildClients(env);
  const cursor = await repos.syncState.get('cursor:recent');
  const cursorTime = cursor ? new Date(cursor).getTime() : 0;

  const slugs: string[] = [];
  let newest = cursor ?? '';
  for (let page = 1; page <= RECENT_PAGE_LIMIT; page++) {
    const items = await clients.kkphim.getRecentPage(page);
    if (items.length === 0) break;
    let crossedCursor = false;
    for (const item of items) {
      const t = item.modified?.time;
      if (t && new Date(t).getTime() <= cursorTime) {
        crossedCursor = true;
        break;
      }
      slugs.push(item.slug);
      if (!newest || (t && t > newest)) newest = t;
    }
    if (crossedCursor) break;
  }

  if (slugs.length === 0) return { slugsFound: 0, shards: [] };

  const batches = chunkInto(slugs, SHARD_COUNT);
  const shardResults = await Promise.all(
    batches.map((batch, n) =>
      // Hostname here is cosmetic -- a service binding routes directly to
      // this Worker regardless of what URL is given (same pattern as
      // worker/lib/home.js's SELF usage). Kept as the real prod hostname
      // for consistency with that file, not because it's reachable.
      env.SELF.fetch(`https://phim.bluesia.net/__sync/batch/${n}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-cron-key': env.CRON_KEY ?? '' },
        body: JSON.stringify({ slugs: batch }),
      })
        .then((r) => r.json<ShardResult>())
        .catch(
          (): ShardResult => ({ processed: 0, written: 0, unchanged: 0, errors: batch.length, rowsWritten: 0, governed: false })
        )
    )
  );

  const anyGoverned = shardResults.some((r) => r.governed);
  if (!anyGoverned && newest) await repos.syncState.set('cursor:recent', newest);

  return { slugsFound: slugs.length, shards: shardResults };
}

/** One page of one taxonomy listing (plan §7). Not sharded -- called either
 * standalone (the /__sync/backfill-page route) or in a loop by
 * runBackfillTick below, so the KKPhim/TMDB rate limiters use the full
 * aggregate budget (PHIMAPI_AGGREGATE_RPS), not a shard fraction of it. */
export async function runBackfillPage(
  env: Env,
  type: string,
  page: number
): Promise<{ slugsFound: number; result: ShardResult }> {
  const clients = buildClients(env, 1);
  const items = await clients.kkphim.getListingPage(type, page);
  const slugs = items.map((i) => i.slug);
  if (slugs.length === 0) return { slugsFound: 0, result: { processed: 0, written: 0, unchanged: 0, errors: 0, rowsWritten: 0, governed: false } };
  const result = await syncSlugBatch(env, slugs);
  return { slugsFound: slugs.length, result };
}

// Crawl order for the backfill walk -- every /danh-sach/:type the site
// exposes (src-ssr/lib/listTypes.ts), same set the old SPA's Footer.js
// linked. Not hoat-hinh-first or any particular priority; plan §7 doesn't
// call for ranking, just full coverage.
const BACKFILL_TYPES = ['phim-le', 'phim-bo', 'hoat-hinh', 'tv-shows'];
// Leaves ~2 min of the Cron Trigger's 15-min wall-time ceiling
// (developers.cloudflare.com/workers/platform/limits, verified 2026-08-07)
// as margin -- a tick that ran right up to the limit would get killed
// mid-write instead of persisting its cursor cleanly.
const BACKFILL_TICK_BUDGET_MS = 13 * 60 * 1000;
// Guards against an unbounded loop if a taxonomy listing somehow never
// returns an empty page (shouldn't happen, but the cost of being wrong here
// is a stuck cron forever, not a slow one).
const BACKFILL_MAX_PAGES_PER_TYPE = 5000;

/** Cron-driven backfill (Phase 7) -- deliberately NOT invoked over HTTP.
 * ADR-0002's own principle ("Cron is the ONLY component allowed to call
 * TMDB/phimimg") argues against a design that needs a human to keep curling
 * a CRON_KEY-gated route by hand; this instead resumes from a D1 cursor
 * every scheduled() tick until the whole catalog is walked, then no-ops
 * forever. `env.BACKFILL_MODE === 'burst'` only changes what syncSlugBatch
 * does inside this loop (governor on/off, plan §7 table) -- the walking
 * logic itself is identical either way, just faster or slower to finish. */
export async function runBackfillTick(env: Env): Promise<{ ticked: boolean; pagesProcessed: number; done: boolean }> {
  const repos = buildRepos(env);
  if ((await repos.syncState.get('backfill:done')) === '1') {
    return { ticked: false, pagesProcessed: 0, done: true };
  }

  let typeIndex = Number((await repos.syncState.get('backfill:type_index')) ?? '0');
  let page = Number((await repos.syncState.get('backfill:page')) ?? '1');
  const deadline = Date.now() + BACKFILL_TICK_BUDGET_MS;
  let pagesProcessed = 0;

  while (Date.now() < deadline && typeIndex < BACKFILL_TYPES.length) {
    const type = BACKFILL_TYPES[typeIndex] as string;
    if (page > BACKFILL_MAX_PAGES_PER_TYPE) {
      typeIndex++;
      page = 1;
      continue;
    }

    const { slugsFound, result } = await runBackfillPage(env, type, page);
    pagesProcessed++;

    if (slugsFound === 0) {
      // This type's listing is exhausted -- move to the next one.
      typeIndex++;
      page = 1;
      continue;
    }

    if (result.governed) {
      // Daily D1 write quota hit (free mode only, plan §2.2) -- stop for
      // this tick without advancing `page`, so the same page is retried
      // once tomorrow's quota resets.
      break;
    }

    page++;
  }

  await repos.syncState.set('backfill:type_index', String(typeIndex));
  await repos.syncState.set('backfill:page', String(page));

  const done = typeIndex >= BACKFILL_TYPES.length;
  if (done) await repos.syncState.set('backfill:done', '1');

  return { ticked: true, pagesProcessed, done };
}
