import { cache } from 'cloudflare:workers';
import type { Env } from '../../types/env';
import { RecommendationRepository } from '../../repositories/recommendationRepository';
import { RecommendationFreshnessRepository, type RecommendationRefreshCandidate } from '../../repositories/recommendationFreshnessRepository';
import { RateLimiter, TMDB_AGGREGATE_RPS } from './throttle';
import { TmdbClient } from './tmdbClient';

export const RECOMMENDATION_REFRESH_LIMIT = 20;
export const RECOMMENDATION_TTL_SECONDS = 14 * 24 * 60 * 60;
export const RECOMMENDATION_RETRY_AFTER_SECONDS = 30 * 60;

export interface RecommendationRefreshTickResult {
  due: number;
  refreshed: number;
  validEmpty: number;
  retryable: number;
  cacheTagsPurged: number;
}

export interface RefreshSourceOutcome {
  kind: 'refreshed' | 'valid_empty' | 'retryable';
  cacheTagsPurged: number;
}

/** One source's worth of the refresh tick, extracted so a caller wanting
 * per-source step boundaries (src-ssr/workflows/recommendationRefreshWorkflow.ts)
 * can wrap this single TMDB call + writes in its own step. */
export async function refreshOneSource(
  freshness: RecommendationFreshnessRepository,
  recommendation: RecommendationRepository,
  tmdb: TmdbClient,
  source: RecommendationRefreshCandidate
): Promise<RefreshSourceOutcome> {
  const result = await tmdb.getRecommendationIds(source.tmdbType, source.tmdbId, 15);
  if (result.kind === 'retryable_error') {
    await freshness.markAttempt(source.slug, 'retryable_error');
    return { kind: 'retryable', cacheTagsPurged: 0 };
  }
  await recommendation.replaceTargetsPreservingResolvedForSlug(
    source.slug,
    result.ids.map((targetTmdbId, sortOrder) => ({ targetTmdbId, targetType: source.tmdbType, sortOrder }))
  );
  await freshness.markAttempt(source.slug, result.ids.length === 0 ? 'valid_empty' : 'success');
  let cacheTagsPurged = 0;
  try {
    await cache.purge({ tags: [`recommendation:${source.tmdbType}:${source.tmdbId}`] });
    cacheTagsPurged = 1;
  } catch {
    // Edge write succeeded; the normal API TTL remains a safe fallback.
  }
  return { kind: result.ids.length === 0 ? 'valid_empty' : 'refreshed', cacheTagsPurged };
}

/** Refreshes source recommendation IDs without fetching KKPhim/movie detail,
 * batched over refreshOneSource above. The scheduled() cron this used to
 * serve is retired as of docs/plan-free-plan-migration.md Phase 5 --
 * src-ssr/workflows/recommendationRefreshWorkflow.ts calls refreshOneSource
 * directly instead, chunked into small per-batch steps. Kept as a thin
 * batch wrapper for tests/recommendationRefresh.test.mjs's coverage of
 * refreshOneSource's behavior. A retryable TMDB response leaves both the
 * existing edges and success time intact, so it remains eligible on the
 * next tick either way. */
export async function runRecommendationRefreshTick(env: Env): Promise<RecommendationRefreshTickResult> {
  const freshness = new RecommendationFreshnessRepository(env.DB);
  const recommendation = new RecommendationRepository(env.DB);
  const tmdb = new TmdbClient(env.TMDB_API_TOKEN ?? '', new RateLimiter(TMDB_AGGREGATE_RPS));
  const sources = await freshness.getDueSources(
    RECOMMENDATION_TTL_SECONDS,
    RECOMMENDATION_RETRY_AFTER_SECONDS,
    RECOMMENDATION_REFRESH_LIMIT
  );
  let refreshed = 0;
  let validEmpty = 0;
  let retryable = 0;
  let cacheTagsPurged = 0;

  for (const source of sources) {
    const outcome = await refreshOneSource(freshness, recommendation, tmdb, source);
    cacheTagsPurged += outcome.cacheTagsPurged;
    if (outcome.kind === 'refreshed') refreshed++;
    else if (outcome.kind === 'valid_empty') { refreshed++; validEmpty++; }
    else retryable++;
  }

  return { due: sources.length, refreshed, validEmpty, retryable, cacheTagsPurged };
}
