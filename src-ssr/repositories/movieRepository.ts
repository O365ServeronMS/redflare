import { chunkByParams } from '../db/chunk';
import type { Cursor } from '../lib/cursor';
import type { MovieRow, NormalizedMovie } from '../types/movie';

export interface Page<T> {
  items: T[];
  nextCursor: Cursor | null;
}

// Columns bound per row in the upsert below. At D1's 100-param cap that's
// 3 rows/statement (27 cols x 3 = 81, x4 would be 108 -- over) -- see
// db/chunk.ts.
const MOVIE_COLUMNS = 27;

function toRow(m: NormalizedMovie, hash: string, now: number) {
  return [
    m.slug,
    m.tmdbId,
    m.tmdbType,
    m.tmdbSeason,
    m.title,
    m.originalTitle,
    m.overview,
    m.posterPath,
    m.thumbPath,
    m.posterHost,
    m.releaseYear,
    m.runtime,
    m.voteAverage,
    m.voteCount,
    m.status,
    m.episodeCurrent,
    m.quality,
    m.lang,
    m.type,
    JSON.stringify(m.genres),
    JSON.stringify(m.countries),
    m.hasStream ? 1 : 0,
    m.streamCount,
    m.youtubeTrailerKey,
    m.tier,
    hash,
    now,
  ] as const;
}

const UPSERT_SQL = `
INSERT INTO movie (
  slug, tmdb_id, tmdb_type, tmdb_season, title, original_title, overview,
  poster_path, thumb_path, poster_host, release_year, runtime, vote_average,
  vote_count, status, episode_current, quality, lang, type, genres_json,
  countries_json, has_stream, stream_count, youtube_trailer_key, tier,
  source_hash, last_synced
) VALUES ${'(' + Array(MOVIE_COLUMNS).fill('?').join(',') + ')'}
ON CONFLICT(slug) DO UPDATE SET
  tmdb_id = excluded.tmdb_id,
  tmdb_type = excluded.tmdb_type,
  tmdb_season = excluded.tmdb_season,
  title = excluded.title,
  original_title = excluded.original_title,
  overview = excluded.overview,
  poster_path = excluded.poster_path,
  thumb_path = excluded.thumb_path,
  poster_host = excluded.poster_host,
  release_year = excluded.release_year,
  runtime = excluded.runtime,
  vote_average = excluded.vote_average,
  vote_count = excluded.vote_count,
  status = excluded.status,
  episode_current = excluded.episode_current,
  quality = excluded.quality,
  lang = excluded.lang,
  type = excluded.type,
  genres_json = excluded.genres_json,
  countries_json = excluded.countries_json,
  has_stream = excluded.has_stream,
  stream_count = excluded.stream_count,
  youtube_trailer_key = excluded.youtube_trailer_key,
  tier = excluded.tier,
  source_hash = excluded.source_hash,
  last_synced = excluded.last_synced
`;

export class MovieRepository {
  constructor(private readonly db: D1Database) {}

  /** Batch lookup, never call in a loop -- D1 is single-threaded, so N
   * sequential getBySlug() calls is N serialized round-trips. Chunks at the
   * param cap automatically. */
  async getBySlugs(slugs: readonly string[]): Promise<MovieRow[]> {
    if (slugs.length === 0) return [];
    const out: MovieRow[] = [];
    for (const chunk of chunkByParams(slugs, 1)) {
      const placeholders = chunk.map(() => '?').join(',');
      const res = await this.db
        .prepare(`SELECT * FROM movie WHERE slug IN (${placeholders})`)
        .bind(...chunk)
        .all<MovieRow>();
      out.push(...(res.results ?? []));
    }
    return out;
  }

  async getBySlug(slug: string): Promise<MovieRow | null> {
    const rows = await this.getBySlugs([slug]);
    return rows[0] ?? null;
  }

  /** Phase 4's cheapest resolve step -- check the local catalog before
   * ever calling KKPhim's /tmdb/ lookup. Uses idx_movie_tmdb
   * (migrations/0005_ssr_schema.sql), the same index that exists
   * specifically because tmdb_id isn't unique (ADR-0002 Finding 1). */
  async getByTmdbRef(tmdbType: 'movie' | 'tv', tmdbId: number): Promise<MovieRow | null> {
    return this.db
      .prepare('SELECT * FROM movie WHERE tmdb_type = ? AND tmdb_id = ? LIMIT 1')
      .bind(tmdbType, tmdbId)
      .first<MovieRow>();
  }

  /** Only rows whose source_hash differs get written -- callers should
   * already have filtered via existing hashes (see services/sync/syncMovie.ts),
   * this just performs the batched write. Returns rows actually written. */
  async upsertMany(movies: readonly { movie: NormalizedMovie; hash: string }[]): Promise<number> {
    if (movies.length === 0) return 0;
    const now = Math.floor(Date.now() / 1000);
    let written = 0;
    for (const chunk of chunkByParams(movies, MOVIE_COLUMNS)) {
      const stmt = this.db.prepare(UPSERT_SQL);
      const batch = chunk.map(({ movie, hash }) => stmt.bind(...toRow(movie, hash, now)));
      await this.db.batch(batch);
      written += chunk.length;
    }
    return written;
  }

  /** Existing hashes for a set of slugs, used to skip no-op writes before
   * ever building the full upsert payload (ADR-0002 Finding 2). */
  async getHashesBySlugs(slugs: readonly string[]): Promise<Map<string, string>> {
    if (slugs.length === 0) return new Map();
    const out = new Map<string, string>();
    for (const chunk of chunkByParams(slugs, 1)) {
      const placeholders = chunk.map(() => '?').join(',');
      const res = await this.db
        .prepare(`SELECT slug, source_hash FROM movie WHERE slug IN (${placeholders})`)
        .bind(...chunk)
        .all<{ slug: string; source_hash: string }>();
      for (const row of res.results ?? []) out.set(row.slug, row.source_hash);
    }
    return out;
  }

  /** Keyset-paginated listing for /danh-sach/:type (plan §3.1: no OFFSET --
   * a deep-page crawl request would otherwise scan and bill every skipped
   * row against the D1 rows-read quota). Fetches limit+1 to know whether a
   * next page exists without a separate COUNT. */
  async getPageByType(type: string, cursor: Cursor | null, limit: number): Promise<Page<MovieRow>> {
    const sql = cursor
      ? `SELECT * FROM movie WHERE type = ? AND (last_synced < ? OR (last_synced = ? AND slug > ?))
         ORDER BY last_synced DESC, slug ASC LIMIT ?`
      : `SELECT * FROM movie WHERE type = ? ORDER BY last_synced DESC, slug ASC LIMIT ?`;
    const binds = cursor
      ? [type, cursor.lastSynced, cursor.lastSynced, cursor.slug, limit + 1]
      : [type, limit + 1];
    const res = await this.db.prepare(sql).bind(...binds).all<MovieRow>();
    const rows = res.results ?? [];
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    const nextCursor = rows.length > limit && last ? { lastSynced: last.last_synced, slug: last.slug } : null;
    return { items, nextCursor };
  }

  /** Sitemap generation only (routes/sitemap.ts) -- the one legitimate use
   * of OFFSET in this codebase. Every other listing route uses keyset
   * pagination to protect the D1 rows-read quota from real user traffic
   * (see getPageByType above); sitemaps are fetched by crawlers on a slow,
   * infrequent cadence, not on every page view, so the OFFSET cost here is
   * bounded and rare rather than proportional to site traffic. */
  async getSitemapPage(offset: number, limit: number): Promise<{ slug: string; last_synced: number }[]> {
    const res = await this.db
      .prepare('SELECT slug, last_synced FROM movie WHERE tier = ? ORDER BY slug LIMIT ? OFFSET ?')
      .bind('catalog', limit, offset)
      .all<{ slug: string; last_synced: number }>();
    return res.results ?? [];
  }

  async countByTier(tier: 'catalog' | 'stub'): Promise<number> {
    const row = await this.db
      .prepare('SELECT COUNT(*) as n FROM movie WHERE tier = ?')
      .bind(tier)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }
}
