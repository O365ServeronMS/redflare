import { cache } from 'cloudflare:workers';
import type { Env } from '../../types/env';
import { MovieRepository } from '../../repositories/movieRepository';
import { EpisodeRepository } from '../../repositories/episodeRepository';
import { RecommendationRepository } from '../../repositories/recommendationRepository';
import { TaxonomyRepository } from '../../repositories/taxonomyRepository';
import { SearchRepository } from '../../repositories/searchRepository';
import { SyncStateRepository } from '../../repositories/syncStateRepository';
import { TmdbOverrideRepository } from '../../repositories/tmdbOverrideRepository';
import { KkphimClient } from './kkphimClient';
import { TmdbClient } from './tmdbClient';
import { syncOneMovie, type SyncOneResult } from './syncMovie';
import { normalizeStubMovie } from './normalize';
import { hashMovie } from './hash';
import { slugifyStub } from '../../lib/slugify';
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

/** Versioned cursor for the recent feed. `slug` is a deterministic
 * tie-breaker/diagnostic value; equal-timestamp items are still scanned on
 * every pass so feed reordering cannot hide a title at the boundary. */
export interface RecentCursor {
  time: string;
  slug: string;
}

export type IncrementalStopReason =
  | 'cursor_crossed'
  | 'empty_page'
  | 'page_limit'
  | 'upstream_error'
  | 'shard_error'
  | 'governed'
  | 'cursor_write_error'
  | 'no_new_slugs';

export interface IncrementalSyncResult {
  slugsFound: number;
  fetched: number;
  processed: number;
  written: number;
  unchanged: number;
  failed: number;
  rowsWritten: number;
  pagesScanned: number;
  stopReason: IncrementalStopReason;
  cursorBefore: RecentCursor | null;
  cursorAfter: RecentCursor | null;
  shards: ShardResult[];
}

function parseRecentCursor(value: string | null): RecentCursor | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed === 'object' && parsed !== null
      && typeof (parsed as Record<string, unknown>).time === 'string'
      && !Number.isNaN(Date.parse((parsed as Record<string, unknown>).time as string))
      && typeof (parsed as Record<string, unknown>).slug === 'string'
    ) {
      return {
        time: (parsed as Record<string, unknown>).time as string,
        slug: (parsed as Record<string, unknown>).slug as string,
      };
    }
  } catch {
    // Pre-Phase 3 deployments stored the raw ISO timestamp. Keep those
    // cursors readable so rollout does not require a reset or migration.
  }
  return Number.isNaN(Date.parse(value)) ? null : { time: value, slug: '' };
}

function newerCursor(a: RecentCursor, b: RecentCursor): RecentCursor {
  const aTime = Date.parse(a.time);
  const bTime = Date.parse(b.time);
  if (aTime !== bTime) return aTime > bTime ? a : b;
  return a.slug >= b.slug ? a : b;
}

async function persistRecentSummary(repos: ReturnType<typeof buildRepos>, result: IncrementalSyncResult): Promise<void> {
  try {
    await repos.syncState.set('recent:last_run', JSON.stringify({ ...result, recordedAt: new Date().toISOString() }));
  } catch {
    // Observability must never turn a completed sync into a failed sync. The
    // structured console log remains available when this best-effort write is
    // unavailable (for example during a transient D1 outage).
  }
}

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
    search: new SearchRepository(env.DB),
    syncState: new SyncStateRepository(env.DB),
    tmdbOverride: new TmdbOverrideRepository(env.DB),
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

function isShardResult(value: unknown): value is ShardResult {
  if (typeof value !== 'object' || value === null) return false;
  const result = value as Record<string, unknown>;
  return ['processed', 'written', 'unchanged', 'errors', 'rowsWritten']
    .every((key) => typeof result[key] === 'number' && Number.isFinite(result[key] as number) && (result[key] as number) >= 0)
    && typeof result.governed === 'boolean';
}

/** Syncs one shard's worth of slugs. Called both directly (single-shard
 * dev/test) and via the /__sync/batch/:n route reached through env.SELF
 * from runIncrementalSync's fan-out. */
export async function syncSlugBatch(
  env: Env,
  slugs: readonly string[],
  shardDivisor = SHARD_COUNT
): Promise<ShardResult> {
  const repos = buildRepos(env);
  const clients = buildClients(env, shardDivisor);

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
 * re-scans the same window next tick rather than silently skipping items.
 * Items sharing the cursor timestamp are deliberately re-scanned: KKPhim can
 * reorder ties between pages, and a timestamp-only stop at the first tie
 * loses titles at that boundary. */
export async function runIncrementalSync(env: Env): Promise<IncrementalSyncResult> {
  const repos = buildRepos(env);
  const clients = buildClients(env);
  const rawCursor = await repos.syncState.get('cursor:recent');
  const cursor = parseRecentCursor(rawCursor);
  const cursorTime = cursor ? Date.parse(cursor.time) : 0;
  const finish = async (result: IncrementalSyncResult): Promise<IncrementalSyncResult> => {
    await persistRecentSummary(repos, result);
    return result;
  };

  const slugs: string[] = [];
  const seenSlugs = new Set<string>();
  let newest = cursor;
  let scanComplete = false;
  let scanFailed = false;
  let pagesScanned = 0;
  let fetched = 0;
  let discoveryStopReason: IncrementalStopReason | null = null;
  for (let page = 1; page <= RECENT_PAGE_LIMIT; page++) {
    pagesScanned++;
    const pageResult = await clients.kkphim.getRecentPage(page);
    if (pageResult.kind !== 'success') {
      scanFailed = true;
      discoveryStopReason = 'upstream_error';
      break;
    }
    const items = pageResult.items;
    fetched += items.length;
    if (items.length === 0) {
      scanComplete = true;
      discoveryStopReason = 'empty_page';
      break;
    }
    let crossedCursor = false;
    for (const item of items) {
      const t = item.modified?.time;
      const itemTime = t ? Date.parse(t) : Number.NaN;
      if (cursorTime > 0 && itemTime < cursorTime) {
        crossedCursor = true;
        // Do not abandon the rest of this page: an upstream reorder can put
        // an equal-timestamp item after the first older item.
        continue;
      }
      // A v2 cursor identifies one item already committed at the boundary.
      // Skip that exact slug, but continue scanning every other equal-time
      // item so a reordered page cannot hide a newly inserted title.
      if (cursor && itemTime === cursorTime && item.slug === cursor.slug) continue;
      if (seenSlugs.has(item.slug)) continue;
      seenSlugs.add(item.slug);
      slugs.push(item.slug);
      const candidate = { time: t, slug: item.slug } satisfies RecentCursor;
      newest = newest ? newerCursor(newest, candidate) : candidate;
    }
    if (crossedCursor) {
      scanComplete = true;
      discoveryStopReason = 'cursor_crossed';
      break;
    }
  }
  if (!discoveryStopReason) discoveryStopReason = 'page_limit';

  if (slugs.length === 0) {
    return finish({
      slugsFound: 0,
      fetched,
      processed: 0,
      written: 0,
      unchanged: 0,
      failed: scanFailed ? 1 : 0,
      rowsWritten: 0,
      pagesScanned,
      stopReason: discoveryStopReason === 'page_limit' ? 'no_new_slugs' : discoveryStopReason,
      cursorBefore: cursor,
      cursorAfter: cursor,
      shards: [],
    });
  }

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
        .then(async (r) => {
          if (!r.ok) throw new Error(`SELF shard returned HTTP ${r.status}`);
          const result = await r.json<unknown>();
          if (!isShardResult(result)) throw new Error('SELF shard returned an invalid result');
          return result;
        })
        .catch(
          (): ShardResult => ({ processed: 0, written: 0, unchanged: 0, errors: batch.length, rowsWritten: 0, governed: false })
        )
    )
  );

  const allShardsSucceeded = shardResults.every(
    (result, index) => !result.governed && result.errors === 0 && result.processed === batches[index]!.length
  );
  const totals = shardResults.reduce(
    (acc, result, index) => {
      acc.processed += result.processed;
      acc.written += result.written;
      acc.unchanged += result.unchanged;
      acc.rowsWritten += result.rowsWritten;
      if (!result.governed) acc.failed += Math.max(result.errors, batches[index]!.length - result.processed);
      return acc;
    },
    { processed: 0, written: 0, unchanged: 0, failed: scanFailed ? 1 : 0, rowsWritten: 0 }
  );
  let cursorAfter = cursor;
  let cursorWriteFailed = false;
  if (!scanFailed && scanComplete && allShardsSucceeded && newest) {
    try {
      await repos.syncState.set('cursor:recent', JSON.stringify(newest));
      cursorAfter = newest;
    } catch {
      cursorWriteFailed = true;
      totals.failed++;
    }
  }

  let stopReason: IncrementalStopReason = discoveryStopReason ?? 'no_new_slugs';
  if (cursorWriteFailed) stopReason = 'cursor_write_error';
  else if (scanFailed) stopReason = 'upstream_error';
  else if (!scanComplete) stopReason = 'page_limit';
  else if (!allShardsSucceeded) stopReason = shardResults.some((result) => result.governed) ? 'governed' : 'shard_error';

  return finish({
    slugsFound: slugs.length,
    fetched,
    processed: totals.processed,
    written: totals.written,
    unchanged: totals.unchanged,
    failed: totals.failed,
    rowsWritten: totals.rowsWritten,
    pagesScanned,
    stopReason,
    cursorBefore: cursor,
    cursorAfter,
    shards: shardResults,
  });
}

/** One page of one taxonomy listing (plan §7). Not sharded -- called either
 * standalone (the /__sync/backfill-page route) or in a loop by
 * runBackfillTick below, so the KKPhim/TMDB rate limiters use the full
 * aggregate budget (PHIMAPI_AGGREGATE_RPS), not a shard fraction of it. */
export async function runBackfillPage(
  env: Env,
  type: string,
  page: number
): Promise<{ slugsFound: number; totalPages: number | null; result: ShardResult }> {
  const clients = buildClients(env, 1);
  const { items, totalPages } = await clients.kkphim.getListingPage(type, page);
  const slugs = items.map((i) => i.slug);
  if (slugs.length === 0) {
    return {
      slugsFound: 0,
      totalPages,
      result: { processed: 0, written: 0, unchanged: 0, errors: 0, rowsWritten: 0, governed: false },
    };
  }
  // Backfill runs in this one scheduled invocation rather than across the
  // five incremental-sync shards, so it can safely use the full aggregate
  // KKPhim/TMDB allowance. The shared limiter still caps KKPhim at 25 RPS.
  const result = await syncSlugBatch(env, slugs, 1);
  return { slugsFound: slugs.length, totalPages, result };
}

// Crawl order for the backfill walk -- every /danh-sach/:type the site
// exposes (src-ssr/lib/listTypes.ts), same set the old SPA's Footer.js
// linked. Not hoat-hinh-first or any particular priority; plan §7 doesn't
// call for ranking, just full coverage.
const BACKFILL_TYPES = ['phim-le', 'phim-bo', 'hoat-hinh', 'tv-shows'];
// Budget split across the one scheduled() invocation (index.ts), which has
// a 15-min Cron Trigger wall-time ceiling total: incremental sync (usually
// fast, unbounded here) + this + RESOLVE_TICK_BUDGET_MS (below) + ~2 min
// margin so a tick that ran right up to the limit gets killed AFTER
// persisting its cursor, not mid-write.
const BACKFILL_TICK_BUDGET_MS = 10 * 60 * 1000;
// Guards against an unbounded loop if a taxonomy listing somehow never
// returns an empty page (shouldn't happen, but the cost of being wrong here
// is a stuck cron forever, not a slow one).
const BACKFILL_MAX_PAGES_PER_TYPE = 5000;
// A page coming back empty is NOT proof a listing is exhausted -- it can
// also mean a single fetch failed/timed out (kkphimClient.ts returns
// totalPages: null in that case). Only conclude "this type is done" when
// the API's own pagination metadata says so (page > totalPages); an
// unexplained empty page gets a few immediate retries before the tick
// gives up and leaves the cursor exactly where it was, to be retried next
// tick. This is the fix for the bug the first production backfill run hit
// 2026-08-07: treating any empty page as "exhausted" marked the whole
// catalog done after ~1 page/type (91 movies synced against a real
// phim-le listing alone reporting 16,920 items / 705 pages).
const MAX_CONSECUTIVE_EMPTY_RETRIES = 3;

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
  let consecutiveEmpty = 0;

  while (Date.now() < deadline && typeIndex < BACKFILL_TYPES.length) {
    const type = BACKFILL_TYPES[typeIndex] as string;
    if (page > BACKFILL_MAX_PAGES_PER_TYPE) {
      typeIndex++;
      page = 1;
      consecutiveEmpty = 0;
      continue;
    }

    const { slugsFound, totalPages, result } = await runBackfillPage(env, type, page);
    pagesProcessed++;

    if (slugsFound === 0) {
      if (totalPages !== null && page > totalPages) {
        // Confirmed exhausted by the API's own pagination metadata, not
        // guessed from an empty response.
        typeIndex++;
        page = 1;
        consecutiveEmpty = 0;
        continue;
      }
      // Unexplained empty page (transient failure, or totalPages unknown).
      // Retry a bounded number of times, then leave the cursor where it is
      // and let the NEXT tick retry -- never silently advance past a page
      // we never actually confirmed was empty for a real reason.
      consecutiveEmpty++;
      if (consecutiveEmpty >= MAX_CONSECUTIVE_EMPTY_RETRIES) break;
      continue;
    }
    consecutiveEmpty = 0;

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

// See BACKFILL_TICK_BUDGET_MS above for how this fits in the same 15-min
// cron invocation.
const RESOLVE_TICK_BUDGET_MS = 3 * 60 * 1000;
// Groups considered per tick, upper bound -- the wall-time budget above is
// what actually cuts a tick short in practice.
const RESOLVE_BATCH_SIZE = 300;
// Overflow is reopened separately before the resolver reads pending work. A
// smaller page keeps D1 writes and cache invalidation bounded per cron.
const REQUEUE_BATCH_SIZE = 100;
const REQUEUE_CURSOR_KEY = 'recommendation:requeue_cursor';
const CACHE_PURGE_TAGS_PER_CALL = 100;
// ADR-0002 Finding 3: only materialize a stub for a target enough catalog
// movies actually point at to be worth a whole extra D1 row + TMDB fetch.
const STUB_MIN_REFCOUNT = 2;

export interface ResolveTickResult {
  groupsSeen: number;
  requeueCandidates: number;
  requeued: number;
  resolvedToExisting: number;
  resolvedToStub: number;
  overflow: number;
  retryable: number;
  cacheTagsPurged: number;
  stubCount: number;
  maxStubs: number;
  durationMs: number;
}

type Repositories = ReturnType<typeof buildRepos>;

function parseRequeueCursor(value: string | null) {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed !== 'object' || parsed === null
      || typeof (parsed as Record<string, unknown>).hasLocalTarget !== 'boolean'
      || !Number.isInteger((parsed as Record<string, unknown>).refCount)
      || !['movie', 'tv'].includes((parsed as Record<string, unknown>).targetType as string)
      || !Number.isInteger((parsed as Record<string, unknown>).targetTmdbId)
    ) return null;
    return parsed as {
      hasLocalTarget: boolean;
      refCount: number;
      targetType: 'movie' | 'tv';
      targetTmdbId: number;
    };
  } catch {
    return null;
  }
}

async function requeueOverflowGroups(repos: Repositories, maxStubs: number, stubCount: number) {
  let cursor = parseRequeueCursor(await repos.syncState.get(REQUEUE_CURSOR_KEY));
  const includeStubEligible = maxStubs > stubCount;
  let candidates = await repos.recommendation.getOverflowGroupsForRequeue(
    REQUEUE_BATCH_SIZE, STUB_MIN_REFCOUNT, includeStubEligible, cursor
  );

  // An old cursor can point beyond a changed aggregate ordering. Restart once
  // in the same tick; this is still a scoped group query, never a blind reset.
  if (candidates.length === 0 && cursor) {
    cursor = null;
    await repos.syncState.delete(REQUEUE_CURSOR_KEY);
    candidates = await repos.recommendation.getOverflowGroupsForRequeue(
      REQUEUE_BATCH_SIZE, STUB_MIN_REFCOUNT, includeStubEligible, null
    );
  }

  let stubSlots = Math.max(0, maxStubs - stubCount);
  const requeue = candidates.filter((group) => {
    if (group.hasLocalTarget) return true;
    if (stubSlots === 0) return false;
    stubSlots--;
    return true;
  });
  await repos.recommendation.requeueAttemptedGroups(requeue);

  const last = candidates[candidates.length - 1];
  if (last && candidates.length === REQUEUE_BATCH_SIZE) {
    await repos.syncState.set(REQUEUE_CURSOR_KEY, JSON.stringify(last));
  } else {
    await repos.syncState.delete(REQUEUE_CURSOR_KEY);
  }

  return { candidates: candidates.length, requeued: requeue.length };
}

async function purgeRecommendationCache(repos: Repositories, targetTmdbId: number, targetType: 'movie' | 'tv') {
  const tags = await repos.recommendation.getSourceCacheTagsForTarget(targetTmdbId, targetType);
  let purged = 0;
  for (let i = 0; i < tags.length; i += CACHE_PURGE_TAGS_PER_CALL) {
    try {
      const chunk = tags.slice(i, i + CACHE_PURGE_TAGS_PER_CALL);
      await cache.purge({ tags: chunk });
      purged += chunk.length;
    } catch {
      break; // edge commit is already durable; the normal 60s TTL is safe fallback
    }
  }
  return purged;
}

async function resolveTarget(
  repos: Repositories,
  targetTmdbId: number,
  targetType: 'movie' | 'tv',
  slug: string
): Promise<number> {
  await repos.recommendation.markResolved(targetTmdbId, targetType, slug);
  try {
    return await purgeRecommendationCache(repos, targetTmdbId, targetType);
  } catch {
    return 0;
  }
}

/** Phase 4 (plan §4, ADR-0002 Finding 3) -- the three-tier recommendation
 * resolve. Cron-driven for the same reason backfill is (services/sync/
 * orchestrator.ts runBackfillTick doc comment): no CRON_KEY needed to
 * operate it. For each (target_tmdb_id, target_type) still unresolved,
 * most-referenced first:
 *   1. Already in the local catalog (idx_movie_tmdb)? -> resolve directly,
 *      no network call.
 *   2. On KKPhim but not synced yet (/tmdb/{type}/{id} lookup)? -> sync it
 *      for real via syncOneMovie (a second fetch of the same detail this
 *      lookup already has, but reuses the fully-tested sync pipeline
 *      instead of duplicating its write logic) and resolve to that slug.
 *   3. Not on KKPhim at all -- stub-eligible (env.MAX_STUBS > 0, refCount
 *      >= STUB_MIN_REFCOUNT, under the stub budget)? -> materialize a
 *      TMDB-only stub row (tier='stub', no episodes, no recommendations of
 *      its own -- crawl depth stops here on purpose) and resolve to it.
 *   4. Otherwise -- overflow. markAttempted so it isn't re-fetched every
 *      tick; the edge stays in the table, unrendered, not deleted. */
export async function runRecommendationResolveTick(env: Env): Promise<ResolveTickResult> {
  const startedAt = Date.now();
  const repos = buildRepos(env);
  const clients = buildClients(env, 1);
  const configuredMaxStubs = Number(env.MAX_STUBS ?? '0');
  const maxStubs = Number.isFinite(configuredMaxStubs) ? Math.max(0, Math.floor(configuredMaxStubs)) : 0;
  let stubCount = maxStubs > 0 ? await repos.movie.countByTier('stub') : 0;
  const requeue = await requeueOverflowGroups(repos, maxStubs, stubCount);
  const groups = await repos.recommendation.getUnresolvedGroupedByTarget(RESOLVE_BATCH_SIZE);
  const deadline = Date.now() + RESOLVE_TICK_BUDGET_MS;

  let resolvedToExisting = 0;
  let resolvedToStub = 0;
  let overflow = 0;
  let retryable = 0;
  let cacheTagsPurged = 0;
  let groupsSeen = 0;

  for (const { targetTmdbId, targetType, refCount } of groups) {
    if (Date.now() >= deadline) break;
    groupsSeen++;

    const local = await repos.movie.getCanonicalTargetByTmdbRef(targetType, targetTmdbId);
    if (local) {
      cacheTagsPurged += await resolveTarget(repos, targetTmdbId, targetType, local.slug);
      resolvedToExisting++;
      continue;
    }

    const onKkphim = await clients.kkphim.getByTmdbRef(targetType, targetTmdbId);
    if (onKkphim.kind === 'retryable_error') {
      retryable++;
      continue;
    }
    if (onKkphim.kind === 'found') {
      const synced = await syncOneMovie(env, onKkphim.data.movie.slug, clients, repos);
      if (synced.outcome !== 'written' && synced.outcome !== 'unchanged') {
        retryable++;
        continue;
      }
      const target = await repos.movie.getBySlug(onKkphim.data.movie.slug);
      if (!target) {
        retryable++;
        continue;
      }
      cacheTagsPurged += await resolveTarget(repos, targetTmdbId, targetType, target.slug);
      resolvedToExisting++;
      continue;
    }

    if (maxStubs > 0 && refCount >= STUB_MIN_REFCOUNT && stubCount < maxStubs) {
      const tmdbDetail = await clients.tmdb.getDetailResult(targetType, targetTmdbId);
      const rawTitle = tmdbDetail.kind === 'success' ? tmdbDetail.data.title || tmdbDetail.data.name : '';
      if (tmdbDetail.kind === 'success' && rawTitle) {
        const slug = slugifyStub(rawTitle, targetType, targetTmdbId);
        const stub = normalizeStubMovie(slug, tmdbDetail.data, targetTmdbId, targetType);
        const hash = hashMovie(stub);
        await repos.movie.upsertMany([{ movie: stub, hash }]);
        await repos.search.indexMovie(slug, stub.title, stub.originalTitle);
        cacheTagsPurged += await resolveTarget(repos, targetTmdbId, targetType, slug);
        stubCount++;
        resolvedToStub++;
        continue;
      }
      if (tmdbDetail.kind === 'retryable_error') {
        retryable++;
        continue;
      }
    }

    await repos.recommendation.markAttempted(targetTmdbId, targetType);
    overflow++;
  }

  return {
    groupsSeen,
    requeueCandidates: requeue.candidates,
    requeued: requeue.requeued,
    resolvedToExisting,
    resolvedToStub,
    overflow,
    retryable,
    cacheTagsPurged,
    stubCount,
    maxStubs,
    durationMs: Date.now() - startedAt,
  };
}
