import type { KkphimDetailResponse } from './kkphimClient';
import type { TmdbDetail } from './tmdbClient';
import type { EpisodeRecord, NormalizedMovie, TaxonomyRef, TmdbType } from '../../types/movie';

const TMDB_IMG = 'https://image.tmdb.org/t/p';
const BACKDROP_SIZE = 'w1280';
const POSTER_SIZE = 'w500';

// Same rule as worker/lib/enrich.js readableTitle -- TMDB falls back to the
// original title when a vi-VN translation is missing, which can surface
// non-Latin script (Hangul/CJK/Thai/Cyrillic) as the headline title. Ported
// verbatim rather than reinvented: this exact regex is what keeps card
// titles Vietnamese/Latin across the existing site.
function readableTitle(s: string | undefined): string {
  return typeof s === 'string' && !/[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u.test(s) ? s : '';
}

function first(...vals: (string | undefined | null)[]): string {
  for (const v of vals) if (v != null && v !== '') return v;
  return '';
}

function mapTaxonomy(items: { name: string; slug: string }[] | undefined): TaxonomyRef[] {
  return (items ?? []).map((i) => ({ slug: i.slug, name: i.name }));
}

function mapEpisodes(kk: KkphimDetailResponse): EpisodeRecord[] {
  const out: EpisodeRecord[] = [];
  let order = 0;
  for (const server of kk.episodes ?? []) {
    for (const ep of server.server_data ?? []) {
      out.push({
        server: server.server_name,
        epSlug: ep.slug,
        epName: ep.name,
        sortOrder: order++,
        linkM3u8: ep.link_m3u8 || null,
        linkEmbed: ep.link_embed || null,
      });
    }
  }
  return out;
}

/** Field ownership follows CLAUDE.md's "Field ownership: OPhim vs TMDB"
 * table, ported to the KKPhim replacement source: TMDB overrides
 * name/origin_name/poster/thumb/vote/overview/year/trailer when present;
 * everything else (taxonomy, slug, episodes, badges) is KKPhim-owned. */
export function normalizeMovie(
  kk: KkphimDetailResponse,
  tmdb: TmdbDetail | null,
  recommendationTmdbIds: number[]
): NormalizedMovie {
  const m = kk.movie;
  const tmdbId = m.tmdb?.id ? Number(m.tmdb.id) : null;
  const tmdbType: TmdbType | null = m.tmdb?.type === 'tv' ? 'tv' : m.tmdb?.type === 'movie' ? 'movie' : null;
  const tmdbSeason = tmdbType === 'tv' && m.tmdb?.season ? Number(m.tmdb.season) : null;

  const tmdbTitle = tmdb ? readableTitle(tmdb.title || tmdb.name) : '';
  const tmdbOriginal = tmdb ? readableTitle(tmdb.original_title || tmdb.original_name) : '';
  const tmdbDate = tmdb?.release_date || tmdb?.first_air_date || '';
  const trailer = tmdb?.videos?.results?.find(
    (v) => v.site === 'YouTube' && v.type === 'Trailer' && v.official
  ) ?? tmdb?.videos?.results?.find((v) => v.site === 'YouTube' && v.type === 'Trailer');

  const posterFromTmdb = tmdb?.backdrop_path ? `${TMDB_IMG}/${BACKDROP_SIZE}${tmdb.backdrop_path}` : '';
  const thumbFromTmdb = tmdb?.poster_path ? `${TMDB_IMG}/${POSTER_SIZE}${tmdb.poster_path}` : '';

  const posterPath = first(posterFromTmdb, m.poster_url ?? undefined);
  const usesTmdbPoster = posterPath === posterFromTmdb && posterFromTmdb !== '';

  const episodes = mapEpisodes(kk);
  const hasStream = episodes.length > 0;

  return {
    slug: m.slug,
    tmdbId,
    tmdbType,
    tmdbSeason,
    title: first(tmdbTitle, m.name),
    originalTitle: first(tmdbOriginal, m.origin_name),
    overview: first(tmdb?.overview, stripHtml(m.content)),
    posterPath,
    thumbPath: thumbFromTmdb || null,
    posterHost: usesTmdbPoster ? 'tmdb' : 'phimimg',
    releaseYear: tmdbDate ? Number(tmdbDate.slice(0, 4)) : m.year || null,
    runtime: m.time,
    voteAverage: tmdb?.vote_average ?? null,
    voteCount: tmdb?.vote_count ?? null,
    status: m.status,
    episodeCurrent: m.episode_current,
    quality: m.quality,
    lang: m.lang,
    type: m.type,
    genres: mapTaxonomy(m.category),
    countries: mapTaxonomy(m.country),
    hasStream,
    streamCount: episodes.length,
    youtubeTrailerKey: trailer?.key || null,
    tier: 'catalog',
    episodes,
    recommendationTargets:
      tmdbType && tmdbId
        ? recommendationTmdbIds.map((id) => ({ tmdbId: id, tmdbType: tmdbType as TmdbType }))
        : [],
  };
}

function stripHtml(html: string | undefined): string {
  return (html ?? '').replace(/<[^>]+>/g, '').trim();
}

/** Stub tier (ADR-0002 Finding 3, plan §4) -- a TMDB-only title that isn't
 * on KKPhim at all, materialized only because >=2 catalog movies
 * recommend it, so it gets a real (if trailer-only) detail page instead of
 * the recommendation block silently dropping it. No KKPhim record exists
 * to own taxonomy/episodes/etc, so almost everything here is TMDB or
 * empty -- has_stream is always false, there are never episodes, and (by
 * design, services/sync/resolveRecommendations.ts) a stub never gets
 * recommendations of its own, so recommendationTargets is always []. */
export function normalizeStubMovie(slug: string, tmdb: TmdbDetail, tmdbId: number, tmdbType: TmdbType): NormalizedMovie {
  const title = readableTitle(tmdb.title || tmdb.name);
  const originalTitle = readableTitle(tmdb.original_title || tmdb.original_name);
  const date = tmdb.release_date || tmdb.first_air_date || '';
  const trailer = tmdb.videos?.results?.find(
    (v) => v.site === 'YouTube' && v.type === 'Trailer' && v.official
  ) ?? tmdb.videos?.results?.find((v) => v.site === 'YouTube' && v.type === 'Trailer');
  const posterPath = tmdb.backdrop_path ? `${TMDB_IMG}/${BACKDROP_SIZE}${tmdb.backdrop_path}` : '';
  const thumbPath = tmdb.poster_path ? `${TMDB_IMG}/${POSTER_SIZE}${tmdb.poster_path}` : null;

  return {
    slug,
    tmdbId,
    tmdbType,
    tmdbSeason: null,
    title: first(title, originalTitle),
    originalTitle,
    overview: tmdb.overview ?? '',
    posterPath,
    thumbPath,
    posterHost: 'tmdb',
    releaseYear: date ? Number(date.slice(0, 4)) : null,
    runtime: '',
    voteAverage: tmdb.vote_average ?? null,
    voteCount: tmdb.vote_count ?? null,
    status: '',
    episodeCurrent: '',
    quality: '',
    lang: '',
    type: tmdbType === 'tv' ? 'tvshows' : 'single',
    genres: [],
    countries: [],
    hasStream: false,
    streamCount: 0,
    youtubeTrailerKey: trailer?.key || null,
    tier: 'stub',
    episodes: [],
    recommendationTargets: [],
  };
}
