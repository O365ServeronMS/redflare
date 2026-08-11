import { cache } from 'cloudflare:workers';
import type { Env } from '../../types/env';
import { MovieRepository } from '../../repositories/movieRepository';
import { EpisodeRepository } from '../../repositories/episodeRepository';
import { RecommendationRepository } from '../../repositories/recommendationRepository';
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
    taxonomy: TaxonomyRepository;
    search: SearchRepository;
    tmdbOverride: TmdbOverrideRepository;
  }
): Promise<SyncOneResult> {
  try {
    const detail = await clients.kkphim.getDetail(slug);
    if (!detail) return { slug, outcome: 'error', rowsWritten: 0 };

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

    const existingHash = (await repos.movie.getHashesBySlugs([slug])).get(slug);
    if (existingHash === hash) return { slug, outcome: 'unchanged', rowsWritten: 0 };

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

    const rowsWritten =
      written
      + movie.episodes.length
      + (recommendation.kind === 'success' ? movie.recommendationTargets.length : 0)
      + movie.genres.length * 2
      + movie.countries.length * 2;

    // Purges detail + player (both tagged `movie:<slug>`, Phase 5). List/
    // genre/country pages that include this title are NOT purged here --
    // there's no bounded way to know every listing a movie could appear on
    // without querying them, so those rely on their own 60s max-age to
    // pick up the change instead of exact invalidation.
    //
    // Wrapped in try/catch, not just `.catch()` on the promise -- found
    // 2026-08-07 (Phase F3 verification) that cache.purge() throws
    // SYNCHRONOUSLY ("cache.purge is not a function") under
    // `wrangler dev --remote`, before it ever returns a promise for
    // `.catch()` to attach to. That crashed every single sync attempted
    // through dev preview, even though real deployed production has been
    // writing successfully the whole time (movie count climbing steadily
    // across this session) -- Workers Caching's purge API isn't fully
    // simulated in the preview tunnel. A purge failing should never cost a
    // real write that already succeeded.
    try {
      await cache.purge({ tags: [`movie:${slug}`] });
    } catch {
      /* best-effort -- see note above */
    }

    return { slug, outcome: 'written', rowsWritten };
  } catch {
    return { slug, outcome: 'error', rowsWritten: 0 };
  }
}
