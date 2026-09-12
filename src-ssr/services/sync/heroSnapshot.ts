import type { HeroRefreshResult, HeroSnapshotEntry } from '../../types/heroSnapshot';
import type { MovieRow } from '../../types/movie';
import { HeroSnapshotRepository } from '../../repositories/heroSnapshotRepository';
import { MovieRepository } from '../../repositories/movieRepository';
import { EpisodeRepository } from '../../repositories/episodeRepository';
import { RecommendationRepository } from '../../repositories/recommendationRepository';
import { RecommendationFreshnessRepository } from '../../repositories/recommendationFreshnessRepository';
import { TaxonomyRepository } from '../../repositories/taxonomyRepository';
import { SearchRepository } from '../../repositories/searchRepository';
import { TmdbOverrideRepository } from '../../repositories/tmdbOverrideRepository';
import { KkphimClient, type KkphimDetailResponse } from './kkphimClient';
import { TmdbClient, type TmdbTrendingMovie } from './tmdbClient';
import { PHIMAPI_AGGREGATE_RPS, RateLimiter, TMDB_AGGREGATE_RPS } from './throttle';
import { INSTANCE_SUBREQUEST_BUDGET, MAX_FETCHES_PER_SYNC } from './orchestrator';

export const HERO_REFRESH_INTERVAL_SECONDS = 30 * 60;
// A candidate costs 1 (kkphim lookup) + up to MAX_FETCHES_PER_SYNC when it
// still has to be synced. Free: 50 external subrequests per Workflow
// instance (docs/state-incremental-sync-stall.md 5.2b).
const HERO_SYNC_CALL_COST = MAX_FETCHES_PER_SYNC;

type CanonicalSyncOutcome = { outcome: 'written' | 'unchanged' | 'skipped' | 'error' };

export interface HeroRefreshDependencies {
  tmdb: Pick<TmdbClient, 'getTrendingMovies'>;
  kkphim: Pick<KkphimClient, 'getMovieByTmdbId'>;
  hero: Pick<HeroSnapshotRepository, 'getRefreshState' | 'replaceSnapshot' | 'recordAttempt'>;
  movie: Pick<MovieRepository, 'getBySlug'>;
  syncCanonical: (slug: string) => Promise<CanonicalSyncOutcome>;
}

export interface RefreshHeroSnapshotOptions {
  force?: boolean;
  /** Test-only clock injection; production uses epoch seconds. */
  now?: number;
  dependencies?: HeroRefreshDependencies;
}

export interface HeroRefreshSummary extends HeroRefreshResult {
  skipped: boolean;
  keptLastGood: boolean;
  fetched: number;
  matched: number;
  notFound: number;
  filteredType: number;
  filteredNoStream: number;
  filteredNoBackdrop: number;
  failed: number;
  budgetSkipped: number;
  durationMs: number;
}

export type CandidateOutcome =
  | { kind: 'matched'; row: HeroSnapshotEntry }
  | { kind: 'not_found' }
  | { kind: 'filtered_type' }
  | { kind: 'filtered_no_stream' }
  | { kind: 'filtered_no_backdrop' }
  | { kind: 'retryable_error' }
  | { kind: 'budget_skipped' };

/**
 * Builds the weekly Hero snapshot from TMDB's first 20 movie results. This
 * The scheduled handler runs this after incremental sync. Production rollout
 * deploys the cron/ops checkpoint and seeds first, then deploys the separate
 * home-data snapshot cutover.
 */
export async function refreshHeroSnapshot(env: Env, options: RefreshHeroSnapshotOptions = {}): Promise<HeroRefreshSummary> {
  const startedAt = Date.now();
  const now = options.now ?? Math.floor(startedAt / 1000);
  const deps = options.dependencies ?? (await buildDependencies(env));
  const previous = await deps.hero.getRefreshState();

  if (!options.force && previous.lastSuccessAt !== null && now - previous.lastSuccessAt < HERO_REFRESH_INTERVAL_SECONDS) {
    return summary({ skipped: true, keptLastGood: true, durationMs: Date.now() - startedAt });
  }

  const trending = await deps.tmdb.getTrendingMovies('week');
  if (!trending) {
    return keepLastGood(deps.hero, now, summary({ failed: 1, keptLastGood: true, durationMs: Date.now() - startedAt }));
  }

  const candidates = dedupeTrendingMovies(trending.movies);
  const rows: HeroSnapshotEntry[] = [];
  let notFound = 0;
  let filteredType = trending.rejectedTypeCount;
  let filteredNoStream = 0;
  let filteredNoBackdrop = 0;
  let failed = 0;
  let budgetSkipped = 0;
  // Sequential, not mapLimit's parallel workers -- external-call accounting
  // against INSTANCE_SUBREQUEST_BUDGET only works if `used` reflects calls
  // already spent before the next candidate starts.
  let used = 1; // fetch-trending above
  for (const candidate of candidates) {
    const result = await resolveCandidate(candidate, deps, INSTANCE_SUBREQUEST_BUDGET - used);
    used += result.externalCalls;
    if (result.kind === 'matched') rows.push(result.row);
    else if (result.kind === 'not_found') notFound++;
    else if (result.kind === 'filtered_type') filteredType++;
    else if (result.kind === 'filtered_no_stream') filteredNoStream++;
    else if (result.kind === 'filtered_no_backdrop') filteredNoBackdrop++;
    else if (result.kind === 'budget_skipped') budgetSkipped++;
    else failed++;
  }

  const result = summary({
    fetched: trending.fetchedCount,
    matched: rows.length,
    notFound,
    filteredType,
    filteredNoStream,
    filteredNoBackdrop,
    failed,
    budgetSkipped,
    keptLastGood: failed > 0,
    durationMs: Date.now() - startedAt,
  });
  if (failed > 0) return keepLastGood(deps.hero, now, result);

  await deps.hero.replaceSnapshot(rows, {
    lastSuccessAt: now,
    lastAttemptAt: now,
    result: toStoredResult(result),
  });
  return result;
}

export function dedupeTrendingMovies(movies: readonly TmdbTrendingMovie[]): TmdbTrendingMovie[] {
  const seen = new Set<number>();
  return movies.filter((movie) => {
    if (seen.has(movie.id)) return false;
    seen.add(movie.id);
    return true;
  });
}

/** Exported for src-ssr/workflows/heroSnapshotWorkflow.ts, which wraps one
 * call to this per candidate in its own step -- each candidate can trigger
 * a full syncOneMovie internally (kkphim + up to 3 TMDB calls), and the
 * whole batch of ~20 candidates run together in refreshHeroSnapshot below
 * was observed (docs/state-free-plan-migration.md Phase 0 audit) to cost
 * ~60+ external subrequests in one invocation -- over the Free-plan
 * 50/invocation cap on its own. Skipping re-sync for candidates already in
 * D1 (below) is only a heuristic that helps the common case; the hard cap
 * is `remainingCalls` vs INSTANCE_SUBREQUEST_BUDGET, enforced by the caller. */
export async function resolveCandidate(
  candidate: TmdbTrendingMovie,
  deps: HeroRefreshDependencies,
  remainingCalls: number
): Promise<CandidateOutcome & { externalCalls: number }> {
  if (remainingCalls < 1) return { kind: 'budget_skipped', externalCalls: 0 };

  const lookup = await deps.kkphim.getMovieByTmdbId(candidate.id);
  const externalCalls = 1;
  if (lookup.kind === 'not_found') return { ...lookup, externalCalls };
  if (lookup.kind === 'retryable_error') return { ...lookup, externalCalls };

  if (!isExactMovieMatch(lookup.data, candidate.id)) return { kind: 'retryable_error', externalCalls };
  if (lookup.data.movie.type !== 'single') return { kind: 'filtered_type', externalCalls };
  if (!hasPlayableEpisode(lookup.data)) return { kind: 'filtered_no_stream', externalCalls };

  // A row already in D1 as this exact catalog movie is kept fresh by
  // incremental sync; only sync the ones that aren't, and only if there's
  // remaining budget for syncCanonical's worst case (HERO_SYNC_CALL_COST).
  const slug = lookup.data.movie.slug;
  let movie = await deps.movie.getBySlug(slug);
  if (!isCatalogMovie(movie, candidate.id)) {
    if (remainingCalls - externalCalls < HERO_SYNC_CALL_COST) return { kind: 'budget_skipped', externalCalls };
    const synced = await deps.syncCanonical(slug);
    const afterSync = externalCalls + HERO_SYNC_CALL_COST;
    if (synced.outcome === 'error') return { kind: 'retryable_error', externalCalls: afterSync };
    movie = await deps.movie.getBySlug(slug);
    if (!isCatalogMovie(movie, candidate.id)) return { kind: 'retryable_error', externalCalls: afterSync };
    if (movie.type !== 'single') return { kind: 'filtered_type', externalCalls: afterSync };
    if (movie.has_stream !== 1) return { kind: 'filtered_no_stream', externalCalls: afterSync };
    if (!hasBackdrop(movie)) return { kind: 'filtered_no_backdrop', externalCalls: afterSync };
    return { kind: 'matched', row: { rank: candidate.rank, tmdbId: candidate.id, slug: movie.slug }, externalCalls: afterSync };
  }
  if (movie.type !== 'single') return { kind: 'filtered_type', externalCalls };
  if (movie.has_stream !== 1) return { kind: 'filtered_no_stream', externalCalls };
  if (!hasBackdrop(movie)) return { kind: 'filtered_no_backdrop', externalCalls };

  return { kind: 'matched', row: { rank: candidate.rank, tmdbId: candidate.id, slug: movie.slug }, externalCalls };
}

function isCatalogMovie(movie: MovieRow | null, tmdbId: number): movie is MovieRow {
  return movie !== null && movie.tmdb_id === tmdbId && movie.tmdb_type === 'movie' && movie.tier === 'catalog';
}

function isExactMovieMatch(detail: KkphimDetailResponse, tmdbId: number): boolean {
  return detail.movie.tmdb?.type === 'movie' && Number(detail.movie.tmdb.id) === tmdbId;
}

function hasPlayableEpisode(detail: KkphimDetailResponse): boolean {
  return detail.episodes.some((server) =>
    server.server_data?.some((episode) => Boolean(episode.link_m3u8?.trim() || episode.link_embed?.trim()))
  );
}

function hasBackdrop(movie: MovieRow): boolean {
  return typeof movie.poster_path === 'string' && movie.poster_path.startsWith('https://image.tmdb.org/t/p/w1280/');
}

function toStoredResult(value: HeroRefreshSummary): HeroRefreshResult {
  return {
    tmdbCount: value.fetched,
    matchedCount: value.matched,
    notFoundCount: value.notFound,
    failedCount: value.failed,
    budgetSkipped: value.budgetSkipped,
  };
}

function summary(values: Partial<HeroRefreshSummary>): HeroRefreshSummary {
  const fetched = values.fetched ?? 0;
  const matched = values.matched ?? 0;
  const notFound = values.notFound ?? 0;
  const failed = values.failed ?? 0;
  const budgetSkipped = values.budgetSkipped ?? 0;
  return {
    skipped: values.skipped ?? false,
    keptLastGood: values.keptLastGood ?? false,
    fetched,
    matched,
    notFound,
    filteredType: values.filteredType ?? 0,
    filteredNoStream: values.filteredNoStream ?? 0,
    filteredNoBackdrop: values.filteredNoBackdrop ?? 0,
    failed,
    budgetSkipped,
    durationMs: values.durationMs ?? 0,
    tmdbCount: fetched,
    matchedCount: matched,
    notFoundCount: notFound,
    failedCount: failed,
  };
}

async function keepLastGood(
  hero: Pick<HeroSnapshotRepository, 'recordAttempt'>,
  now: number,
  result: HeroRefreshSummary
): Promise<HeroRefreshSummary> {
  await hero.recordAttempt(now, toStoredResult(result));
  return result;
}

export async function buildDependencies(env: Env): Promise<HeroRefreshDependencies> {
  const movie = new MovieRepository(env.DB);
  const episode = new EpisodeRepository(env.DB);
  const recommendation = new RecommendationRepository(env.DB);
  const recommendationFreshness = new RecommendationFreshnessRepository(env.DB);
  const taxonomy = new TaxonomyRepository(env.DB);
  const search = new SearchRepository(env.DB);
  const tmdbOverride = new TmdbOverrideRepository(env.DB);
  const kkphim = new KkphimClient(new RateLimiter(PHIMAPI_AGGREGATE_RPS));
  const tmdb = new TmdbClient(env.TMDB_API_TOKEN ?? '', new RateLimiter(TMDB_AGGREGATE_RPS));
  return {
    tmdb,
    kkphim,
    hero: new HeroSnapshotRepository(env.DB),
    movie,
    syncCanonical: async (slug) => {
      const { syncOneMovie } = await import('./syncMovie');
      return syncOneMovie(env, slug, { kkphim, tmdb }, { movie, episode, recommendation, recommendationFreshness, taxonomy, search, tmdbOverride });
    },
  };
}
