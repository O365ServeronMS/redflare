import type { EpisodeRecord, MovieRow, TaxonomyRef } from '../types/movie';

/** The shape src/api/ophim.js's normalizeListItem() produces client-side --
 * every list-returning route must emit exactly this, because /api/list's
 * "newMovies" rail is fed straight into renderCarousel() WITHOUT going
 * through normalizeListItem (docs/contract-legacy-api.md §1), so the
 * server has to be the one guaranteeing the full shape, not rely on the
 * client to fill gaps. */
export interface LegacyItem {
  _id: string;
  name: string;
  slug: string;
  origin_name: string;
  thumb_url: string;
  poster_url: string;
  year: number | null;
  type: string;
  status: string;
  quality: string;
  lang: string;
  episode_current: string;
  time: string;
  category: TaxonomyRef[];
  country: TaxonomyRef[];
  tmdb: { id: number | null; type: string | null; season: number | null };
  imdb: Record<string, never>;
  vote_average: number | null;
  modified: { time: string };
}

// _id is never read anywhere downstream in src/ (verified by grep,
// docs/contract-legacy-api.md §8) -- slug is a fine stand-in, just needs
// to be a non-empty string.
export function toLegacyItem(row: MovieRow): LegacyItem {
  return {
    _id: row.slug,
    name: row.title,
    slug: row.slug,
    origin_name: row.original_title ?? '',
    thumb_url: row.thumb_path ?? row.poster_path ?? '',
    poster_url: row.poster_path ?? '',
    year: row.release_year,
    type: row.type,
    status: row.status ?? '',
    quality: row.quality ?? '',
    lang: row.lang ?? '',
    episode_current: row.episode_current ?? '',
    time: row.runtime ?? '',
    category: JSON.parse(row.genres_json || '[]'),
    country: JSON.parse(row.countries_json || '[]'),
    tmdb: { id: row.tmdb_id, type: row.tmdb_type, season: row.tmdb_season },
    imdb: {},
    vote_average: row.vote_average,
    modified: { time: new Date(row.last_synced * 1000).toISOString() },
  };
}

export function toLegacyItems(rows: readonly MovieRow[]): LegacyItem[] {
  return rows.map(toLegacyItem);
}

export interface LegacyDetail extends LegacyItem {
  content: string;
  trailer_url: string;
  actor: string[];
}

// Detail-only fields, docs/contract-legacy-api.md §4. `content` MUST stay
// plain text -- MovieDetail.js assigns it via innerHTML
// (src/components/MovieDetail.js:272), and overview is already
// HTML-stripped at sync time (services/sync/normalize.ts stripHtml), so no
// extra work is needed here -- just don't undo that guarantee.
export function toLegacyDetail(row: MovieRow): LegacyDetail {
  return {
    ...toLegacyItem(row),
    content: row.overview ?? '',
    trailer_url: row.youtube_trailer_key ? `https://www.youtube.com/watch?v=${row.youtube_trailer_key}` : '',
    // actor_json doesn't exist on MovieRow yet -- Phase F4 adds the column
    // and this becomes a real JSON.parse. MovieDetail.js guards with
    // Array.isArray(...) && length > 0, so [] is a safe, correct default.
    actor: [],
  };
}

export interface LegacyEpisodeServer {
  server_name: string;
  server_data: { name: string; slug: string; link_m3u8: string; link_embed: string }[];
}

// Regroups the flat `episode` table rows back into the server-grouped
// shape MovieDetail.js expects (docs/contract-legacy-api.md §4). `name` is
// ep_name verbatim -- MovieDetail.js displays it directly, not epSlug.
export function toLegacyEpisodes(episodes: readonly EpisodeRecord[]): LegacyEpisodeServer[] {
  const byServer = new Map<string, LegacyEpisodeServer>();
  for (const ep of episodes) {
    let server = byServer.get(ep.server);
    if (!server) {
      server = { server_name: ep.server, server_data: [] };
      byServer.set(ep.server, server);
    }
    server.server_data.push({
      name: ep.epName,
      slug: ep.epSlug,
      link_m3u8: ep.linkM3u8 ?? '',
      link_embed: ep.linkEmbed ?? '',
    });
  }
  return [...byServer.values()];
}
