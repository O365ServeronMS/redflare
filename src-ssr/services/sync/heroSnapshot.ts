import type { Env } from '../../types/env';
import type { HeroRefreshResult, HeroSnapshotEntry } from '../../types/heroSnapshot';
import type { MovieRow } from '../../types/movie';
import { HeroSnapshotRepository } from '../../repositories/heroSnapshotRepository';
import { MovieRepository } from '../../repositories/movieRepository';
import { EpisodeRepository } from '../../repositories/episodeRepository';
import { RecommendationRepository } from '../../repositories/recommendationRepository';
import { TaxonomyRepository } from '../../repositories/taxonomyRepository';
import { SearchRepository } from '../../repositories/searchRepository';
import { TmdbOverrideRepository } from '../../repositories/tmdbOverrideRepository';
import { KkphimClient, type KkphimDetailResponse } from './kkphimClient';
import { TmdbClient, type TmdbTrendingMovie } from './tmdbClient';
import { PHIMAPI_AGGREGATE_RPS, RateLimiter, TMDB_AGGREGATE_RPS } from './throttle';

export const HERO_REFRESH_INTERVAL_SECONDS = 30 * 60;
const HERO_LOOKUP_CONCURRENCY = 4;

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
  durationMs: number;
}

export type CandidateOutcome =
  | { kind: 'matched'; row: HeroSnapshotEntry }
  | { kind: 'not_found' }
  | { kind: 'filtered_type' }
  | { kind: 'filtered_no_stream' }
  | { kind: 'filtered_no_backdrop' }
  | { kind: 'retryable_error' };

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
  const results = await mapLimit(candidates, HERO_LOOKUP_CONCURRENCY, (candidate) => resolveCandidate(candidate, deps));
  const rows: HeroSnapshotEntry[] = [];
  let notFound = 0;
  let filteredType = trending.rejectedTypeCount;
  let filteredNoStream = 0;
  let filteredNoBackdrop = 0;
  let failed = 0;
  for (const result of results) {
    if (result.kind === 'matched') rows.push(result.row);
    else if (result.kind === 'not_found') notFound++;
    else if (result.kind === 'filtered_type') filteredType++;
    else if (result.kind === 'filtered_no_stream') filteredNoStream++;
    else if (result.kind === 'filtered_no_backdrop') filteredNoBackdrop++;
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
 * 50/invocation cap on its own. */
export async function resolveCandidate(candidate: TmdbTrendingMovie, deps: HeroRefreshDependencies): Promise<CandidateOutcome> {
  const lookup = await deps.kkphim.getMovieByTmdbId(candidate.id);
  if (lookup.kind === 'not_found') return lookup;
  if (lookup.kind === 'retryable_error') return lookup;

  if (!isExactMovieMatch(lookup.data, candidate.id)) return { kind: 'retryable_error' };
  if (lookup.data.movie.type !== 'single') return { kind: 'filtered_type' };
  if (!hasPlayableEpisode(lookup.data)) return { kind: 'filtered_no_stream' };

  const synced = await deps.syncCanonical(lookup.data.movie.slug);
  if (synced.outcome === 'error') return { kind: 'retryable_error' };

  const movie = await deps.movie.getBySlug(lookup.data.movie.slug);
  if (!movie || movie.tmdb_id !== candidate.id || movie.tmdb_type !== 'movie' || movie.tier !== 'catalog') {
    return { kind: 'retryable_error' };
  }
  if (movie.type !== 'single') return { kind: 'filtered_type' };
  if (movie.has_stream !== 1) return { kind: 'filtered_no_stream' };
  if (!hasBackdrop(movie)) return { kind: 'filtered_no_backdrop' };

  return { kind: 'matched', row: { rank: candidate.rank, tmdbId: candidate.id, slug: movie.slug } };
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
  };
}

function summary(values: Partial<HeroRefreshSummary>): HeroRefreshSummary {
  const fetched = values.fetched ?? 0;
  const matched = values.matched ?? 0;
  const notFound = values.notFound ?? 0;
  const failed = values.failed ?? 0;
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

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index] as T);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function buildDependencies(env: Env): Promise<HeroRefreshDependencies> {
  const movie = new MovieRepository(env.DB);
  const episode = new EpisodeRepository(env.DB);
  const recommendation = new RecommendationRepository(env.DB);
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
      return syncOneMovie(env, slug, { kkphim, tmdb }, { movie, episode, recommendation, taxonomy, search, tmdbOverride });
    },
  };
}
