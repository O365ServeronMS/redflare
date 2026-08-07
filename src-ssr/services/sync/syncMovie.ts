import { cache } from 'cloudflare:workers';
import type { Env } from '../../types/env';
import { MovieRepository } from '../../repositories/movieRepository';
import { EpisodeRepository } from '../../repositories/episodeRepository';
import { RecommendationRepository } from '../../repositories/recommendationRepository';
import { TaxonomyRepository } from '../../repositories/taxonomyRepository';
import { SearchRepository } from '../../repositories/searchRepository';
import { KkphimClient } from './kkphimClient';
import { TmdbClient } from './tmdbClient';
import { normalizeMovie } from './normalize';
import { hashMovie } from './hash';

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
  }
): Promise<SyncOneResult> {
  try {
    const detail = await clients.kkphim.getDetail(slug);
    if (!detail) return { slug, outcome: 'error', rowsWritten: 0 };

    const tmdbId = detail.movie.tmdb?.id ? Number(detail.movie.tmdb.id) : null;
    const tmdbType = detail.movie.tmdb?.type === 'tv' ? 'tv' : detail.movie.tmdb?.type === 'movie' ? 'movie' : null;

    const [tmdbDetail, recIds] =
      tmdbId && tmdbType
        ? await Promise.all([
            clients.tmdb.getDetail(tmdbType, tmdbId),
            clients.tmdb.getRecommendationIds(tmdbType, tmdbId, TMDB_RECOMMENDATION_CANDIDATES),
          ])
        : [null, []];

    const movie = normalizeMovie(detail, tmdbDetail, recIds);
    const hash = hashMovie(movie);

    const existingHash = (await repos.movie.getHashesBySlugs([slug])).get(slug);
    if (existingHash === hash) return { slug, outcome: 'unchanged', rowsWritten: 0 };

    const written = await repos.movie.upsertMany([{ movie, hash }]);
    await repos.episode.replaceForSlug(slug, movie.episodes);
    await repos.recommendation.replaceTargetsForSlug(
      slug,
      movie.recommendationTargets.map((t, i) => ({ targetTmdbId: t.tmdbId, targetType: t.tmdbType, sortOrder: i }))
    );
    await repos.taxonomy.syncMovieTaxonomy(slug, movie.genres, movie.countries);
    await repos.search.indexMovie(slug, movie.title, movie.originalTitle);

    const rowsWritten =
      written + movie.episodes.length + movie.recommendationTargets.length + movie.genres.length * 2 + movie.countries.length * 2;

    // Purges detail + player (both tagged `movie:<slug>`, Phase 5). List/
    // genre/country pages that include this title are NOT purged here --
    // there's no bounded way to know every listing a movie could appear on
    // without querying them, so those rely on their own 60s max-age to
    // pick up the change instead of exact invalidation.
    await cache.purge({ tags: [`movie:${slug}`] }).catch(() => {});

    return { slug, outcome: 'written', rowsWritten };
  } catch {
    return { slug, outcome: 'error', rowsWritten: 0 };
  }
}
