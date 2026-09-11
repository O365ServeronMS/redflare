import { MovieRepository } from '../../repositories/movieRepository';
import { EpisodeRepository } from '../../repositories/episodeRepository';
import { RecommendationRepository } from '../../repositories/recommendationRepository';
import { RecommendationFreshnessRepository } from '../../repositories/recommendationFreshnessRepository';
import { TaxonomyRepository } from '../../repositories/taxonomyRepository';
import { SearchRepository } from '../../repositories/searchRepository';
import { KkphimClient } from './kkphimClient';
import { TmdbClient, type TmdbRecommendationResult } from './tmdbClient';
import { getUpstreamTmdbRef, normalizeMovie } from './normalize';
import { hashMovie } from './hash';

import { TmdbOverrideRepository } from '../../repositories/tmdbOverrideRepository';
const TMDB_RECOMMENDATION_CANDIDATES = 15;

export interface SyncOneResult {
  slug: string;
  outcome: 'written' | 'unchanged' | 'skipped' | 'error';
  rowsWritten: number;
}

/** Syncs exactly one movie: fetch KKPhim detail (+ TMDB detail/recs if a
 * tmdb_id is present), normalize, hash, and write only if the hash changed
 * from what's already stored (ADR-0002 Finding 2 -- this is the no-op-write
 * gate that makes the daily D1 row-write quota survivable). Never throws --
 * a failed item is reported as 'error' and the caller moves on; the
 * previous architecture's in-request TMDB retry loop is exactly the
 * failure mode this avoids (docs/state-hit-rate.md Phase 10's ~11.4% 504
 * rate traced to enrich.js's 8s x 2-attempt timeout). */
export async function syncOneMovie(
  env: Env,
  slug: string,
  clients: { kkphim: KkphimClient; tmdb: TmdbClient },
  repos: {
    movie: MovieRepository;
    episode: EpisodeRepository;
    recommendation: RecommendationRepository;
    recommendationFreshness: RecommendationFreshnessRepository;
    taxonomy: TaxonomyRepository;
    search: SearchRepository;
    tmdbOverride: TmdbOverrideRepository;
  },
  reconciled = false
): Promise<SyncOneResult> {
  try {
    const detail = await clients.kkphim.getDetail(slug);
    if (!detail) return { slug, outcome: 'error', rowsWritten: 0 };
    if (detail.movie.slug !== slug) {
      // A feed entry can briefly retain an old alias while /phim/{slug}
      // already answers with the canonical KKPhim slug. Never write that
      // payload under the requested alias. Re-fetch once under the canonical
      // identity and let the normal idempotent pipeline write that row; a
      // second mismatch is treated as an upstream contract failure.
      const canonicalSlug = detail.movie.slug;
      if (reconciled || !/^[a-z0-9-]{1,120}$/.test(canonicalSlug)) {
        return { slug, outcome: 'error', rowsWritten: 0 };
      }
      return syncOneMovie(env, canonicalSlug, clients, repos, true);
    }

    const tmdbRef = (await repos.tmdbOverride.getBySlug(slug)) ?? getUpstreamTmdbRef(detail.movie);
    const tmdbId = tmdbRef?.tmdbId ?? null;
    const tmdbType = tmdbRef?.tmdbType ?? null;
    const tmdbSeason = tmdbRef?.tmdbSeason ?? null;

    const [tmdbDetail, tmdbSeasonDetail, recommendation] =
      tmdbId && tmdbType
        ? await Promise.all([
            clients.tmdb.getDetail(tmdbType, tmdbId),
            tmdbSeason ? clients.tmdb.getSeasonDetail(tmdbId, tmdbSeason) : null,
            clients.tmdb.getRecommendationIds(tmdbType, tmdbId, TMDB_RECOMMENDATION_CANDIDATES),
          ])
        : [null, null, { kind: 'success', ids: [] } as TmdbRecommendationResult];

    // Retryable failures keep the last-good refs: they are not valid empty
    // results and must not remove an already-populated recommendation rail.
    const recIds = recommendation.kind === 'success'
      ? recommendation.ids
      : (await repos.recommendation.getTargetsForSlug(slug)).map((target) => target.targetTmdbId);

    const movie = normalizeMovie(detail, tmdbDetail, tmdbSeasonDetail, recIds, tmdbRef);
    const hash = hashMovie(movie);

    const marker = (await repos.movie.getSyncMarkersBySlugs([slug])).get(slug);
    if (marker?.sourceHash === hash) {
      // Nothing hash-relevant changed, but KKPhim's modified.time may have
      // moved (F4: hashMovie deliberately excludes modifiedAt). Bump
      // upstream_modified alone -- one indexed write, no full upsert -- so
      // the row's rail position keeps tracking the feed.
      if (movie.modifiedAt !== null && movie.modifiedAt !== marker.upstreamModified) {
        await repos.movie.setUpstreamModified(slug, movie.modifiedAt);
        return { slug, outcome: 'unchanged', rowsWritten: 1 };
      }
      return { slug, outcome: 'unchanged', rowsWritten: 0 };
    }

    const written = await repos.movie.upsertMany([{ movie, hash }]);
    await repos.episode.replaceForSlug(slug, movie.episodes);
    if (recommendation.kind === 'success') {
      await repos.recommendation.replaceTargetsForSlug(
        slug,
        movie.recommendationTargets.map((t, i) => ({ targetTmdbId: t.tmdbId, targetType: t.tmdbType, sortOrder: i }))
      );
    }
    await repos.taxonomy.syncMovieTaxonomy(slug, movie.genres, movie.countries);
    await repos.search.indexMovie(slug, movie.title, movie.originalTitle);
    // Q3 fix (docs/plan-recommendation-d1-reads.md Phase 1): this movie's
    // TMDB identity may be exactly what an overflow edge elsewhere has been
    // waiting for -- reopen just that group instead of relying on the
    // periodic full-table scan. Only reachable on the `written` branch
    // (this function's own tmdb_id/tmdb_type are not part of hashMovie, so
    // a title whose TMDB identity changes with nothing else hash-relevant
    // changing stays `unchanged` and won't retrigger this -- accepted,
    // extremely rare).
    if (tmdbId && tmdbType) {
      await repos.recommendation.requeueTarget(tmdbType, tmdbId);
      // Q6 fix (docs/plan-recommendation-d1-reads.md Phase 2): this fetch
      // above already called TMDB recommendations for `slug` -- record it
      // as a freshness attempt so getDueSources never needs to anti-join
      // `movie` to find sources that have never been recorded (0018 seeds
      // the backlog; this keeps every future write in sync going forward).
      // A retryable TMDB response leaves last_success_at untouched
      // (RecommendationFreshnessRepository.markAttempt's CASE), same
      // semantics as refreshOneSource.
      await repos.recommendationFreshness.markAttempt(
        slug,
        recommendation.kind === 'success'
          ? (recommendation.ids.length === 0 ? 'valid_empty' : 'success')
          : 'retryable_error'
      );
    }

    const rowsWritten =
      written
      + movie.episodes.length
      + (recommendation.kind === 'success' ? movie.recommendationTargets.length : 0)
      + movie.genres.length * 2
      + movie.countries.length * 2;

    // No per-title cache purge -- a changed title just rides out
    // cache/control.ts's max-age=60 like every other /api/* response. Exact
    // invalidation was tried and dropped: it needed per-item purge calls
    // that risked the Free plan's purge rate limit, and there was no
    // bounded way to also purge the list/genre/country pages a title
    // appears on anyway. `GET /__sync/purge-cache` (routes/sync.ts) covers
    // the "I need it gone right now" case globally instead.
    return { slug, outcome: 'written', rowsWritten };
  } catch (err) {
    console.error(JSON.stringify({
      message: 'syncOneMovie failed',
      slug,
      error: err instanceof Error ? err.message : String(err),
    }));
    return { slug, outcome: 'error', rowsWritten: 0 };
  }
}
