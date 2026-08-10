import { cache } from 'cloudflare:workers';
import type { Env } from '../../types/env';
import { RecommendationRepository } from '../../repositories/recommendationRepository';
import { RecommendationFreshnessRepository } from '../../repositories/recommendationFreshnessRepository';
import { RateLimiter, TMDB_AGGREGATE_RPS } from './throttle';
import { TmdbClient } from './tmdbClient';

const RECOMMENDATION_REFRESH_LIMIT = 20;
const RECOMMENDATION_TTL_SECONDS = 14 * 24 * 60 * 60;
const RECOMMENDATION_RETRY_AFTER_SECONDS = 30 * 60;

export interface RecommendationRefreshTickResult {
  due: number;
  refreshed: number;
  validEmpty: number;
  retryable: number;
  cacheTagsPurged: number;
}

/** Refreshes source recommendation IDs without fetching KKPhim/movie detail.
 * A retryable TMDB response leaves both the existing edges and success time
 * intact, so it remains eligible on the next bounded cron tick. */
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
    const result = await tmdb.getRecommendationIds(source.tmdbType, source.tmdbId, 15);
    if (result.kind === 'retryable_error') {
      await freshness.markAttempt(source.slug, 'retryable_error');
      retryable++;
      continue;
    }
    await recommendation.replaceTargetsPreservingResolvedForSlug(
      source.slug,
      result.ids.map((targetTmdbId, sortOrder) => ({
        targetTmdbId, targetType: source.tmdbType, sortOrder,
      }))
    );
    await freshness.markAttempt(source.slug, result.ids.length === 0 ? 'valid_empty' : 'success');
    refreshed++;
    if (result.ids.length === 0) validEmpty++;
    try {
      await cache.purge({ tags: [`recommendation:${source.tmdbType}:${source.tmdbId}`] });
      cacheTagsPurged++;
    } catch {
      // Edge write succeeded; the normal API TTL remains a safe fallback.
    }
  }

  return { due: sources.length, refreshed, validEmpty, retryable, cacheTagsPurged };
}
