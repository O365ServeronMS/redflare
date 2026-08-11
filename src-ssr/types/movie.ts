export type PosterHost = 'tmdb' | 'phimimg';
export type MovieTier = 'catalog' | 'stub';
export type TmdbType = 'movie' | 'tv';

/** TMDB identity after applying a verified catalog override, if one exists. */
export interface TmdbRef {
  tmdbId: number;
  tmdbType: TmdbType;
  tmdbSeason: number | null;
  source: 'upstream' | 'override';
}

export interface TaxonomyRef {
  slug: string;
  name: string;
}

export interface EpisodeRecord {
  server: string;
  epSlug: string;
  epName: string;
  sortOrder: number;
  linkM3u8: string | null;
  linkEmbed: string | null;
}

/** Normalized shape a sync produces, independent of whether it came from
 * KKPhim+TMDB merge or (Phase 4) a TMDB-only stub. `sourceHash` is computed
 * over exactly these fields (services/sync/hash.ts) so re-running a sync
 * with unchanged upstream data writes zero rows (ADR-0002 Finding 2). */
export interface NormalizedMovie {
  slug: string;
  tmdbId: number | null;
  tmdbType: TmdbType | null;
  tmdbSeason: number | null;
  title: string;
  originalTitle: string;
  overview: string;
  posterPath: string;
  thumbPath: string | null;
  posterHost: PosterHost;
  releaseYear: number | null;
  runtime: string;
  voteAverage: number | null;
  voteCount: number | null;
  status: string;
  episodeCurrent: string;
  quality: string;
  lang: string;
  type: string;
  genres: TaxonomyRef[];
  countries: TaxonomyRef[];
  hasStream: boolean;
  streamCount: number;
  youtubeTrailerKey: string | null;
  tier: MovieTier;
  episodes: EpisodeRecord[];
  /** target (tmdbId, tmdbType) pairs, in rank order -- resolved to slugs in Phase 4. */
  recommendationTargets: { tmdbId: number; tmdbType: TmdbType }[];
  /** Present only for a verified mapping override. Keeps its sync fingerprint
   * distinct from the same upstream record with no TMDB identity. */
  tmdbOverrideKey?: string;
  /** MovieDetail.js renders this (docs/contract-legacy-api.md §4) -- KKPhim
   * detail already has it, just wasn't captured before Phase F3. */
  actors: string[];
  /** TMDB's own popularity score, captured for hero/trending ranking
   * (plan-restore-spa-frontend.md F4) -- never written into hashMovie
   * (services/sync/hash.ts): it drifts daily on TMDB's side independent of
   * anything else about the title, and hashing it would force a rewrite of
   * every synced movie on every tick. */
  popularity: number | null;
}

export interface MovieRow {
  slug: string;
  tmdb_id: number | null;
  tmdb_type: string | null;
  tmdb_season: number | null;
  title: string;
  original_title: string | null;
  overview: string | null;
  poster_path: string | null;
  thumb_path: string | null;
  poster_host: string;
  release_year: number | null;
  runtime: string | null;
  vote_average: number | null;
  vote_count: number | null;
  status: string | null;
  episode_current: string | null;
  quality: string | null;
  lang: string | null;
  type: string;
  genres_json: string;
  countries_json: string;
  has_stream: number;
  stream_count: number;
  youtube_trailer_key: string | null;
  tier: string;
  source_hash: string;
  last_synced: number;
  actor_json: string;
  popularity: number | null;
}
