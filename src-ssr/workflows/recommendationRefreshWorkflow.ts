import { WorkflowEntrypoint, type WorkflowStep, type WorkflowEvent } from 'cloudflare:workers';
import type { Env } from '../types/env';
import { RecommendationRepository } from '../repositories/recommendationRepository';
import { RecommendationFreshnessRepository } from '../repositories/recommendationFreshnessRepository';
import { RateLimiter, TMDB_AGGREGATE_RPS } from '../services/sync/throttle';
import { TmdbClient } from '../services/sync/tmdbClient';
import {
  refreshOneSource,
  RECOMMENDATION_REFRESH_LIMIT,
  RECOMMENDATION_TTL_SECONDS,
  RECOMMENDATION_RETRY_AFTER_SECONDS,
} from '../services/sync/recommendationRefresh';

// RECOMMENDATION_REFRESH_LIMIT is only 20, comfortably under the Free-plan
// 50-subrequest cap even in one step -- but batching keeps it consistent
// with the other Workflows and bounds a single step to a handful of TMDB
// calls regardless of a future limit increase.
const SOURCES_PER_STEP = 5;

/** Free-plan-safe replacement for recommendationRefresh.ts's
 * runRecommendationRefreshTick, which refreshes up to
 * RECOMMENDATION_REFRESH_LIMIT sources in one loop inside a single
 * invocation. */
export class RecommendationRefreshWorkflow extends WorkflowEntrypoint<Env> {
  override async run(_event: WorkflowEvent<unknown>, step: WorkflowStep) {
    const freshness = new RecommendationFreshnessRepository(this.env.DB);
    const recommendation = new RecommendationRepository(this.env.DB);
    const tmdb = new TmdbClient(this.env.TMDB_API_TOKEN ?? '', new RateLimiter(TMDB_AGGREGATE_RPS));

    const sources = await step.do('fetch-due-sources', () =>
      freshness.getDueSources(RECOMMENDATION_TTL_SECONDS, RECOMMENDATION_RETRY_AFTER_SECONDS, RECOMMENDATION_REFRESH_LIMIT)
    );

    let refreshed = 0;
    let validEmpty = 0;
    let retryable = 0;
    let cacheTagsPurged = 0;

    for (let i = 0; i < sources.length; i += SOURCES_PER_STEP) {
      const batch = sources.slice(i, i + SOURCES_PER_STEP);
      const batchResult = await step.do(`refresh-batch-${i / SOURCES_PER_STEP}`, async () => {
        let ok = 0;
        let empty = 0;
        let retry = 0;
        let purged = 0;
        for (const source of batch) {
          const outcome = await refreshOneSource(freshness, recommendation, tmdb, source);
          purged += outcome.cacheTagsPurged;
          if (outcome.kind === 'refreshed') ok++;
          else if (outcome.kind === 'valid_empty') { ok++; empty++; }
          else retry++;
        }
        return { ok, empty, retry, purged };
      });
      refreshed += batchResult.ok;
      validEmpty += batchResult.empty;
      retryable += batchResult.retry;
      cacheTagsPurged += batchResult.purged;
    }

    return { due: sources.length, refreshed, validEmpty, retryable, cacheTagsPurged };
  }
}
