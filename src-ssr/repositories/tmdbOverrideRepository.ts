import type { TmdbRef } from '../types/movie';

/**
 * Version-controlled corrections for catalog items whose upstream metadata
 * lacks a TMDB identity. This is deliberately an exact slug lookup: title
 * matching is too ambiguous to run in the sync or request path.
 */
export class TmdbOverrideRepository {
  constructor(private readonly db: D1Database) {}

  async getBySlug(slug: string): Promise<TmdbRef | null> {
    const row = await this.db.prepare(
      `SELECT tmdb_id, tmdb_type, tmdb_season
       FROM tmdb_override WHERE slug = ?`
    ).bind(slug).first<{ tmdb_id: number; tmdb_type: string; tmdb_season: number | null }>();
    if (!row || (row.tmdb_type !== 'movie' && row.tmdb_type !== 'tv')) return null;
    return {
      tmdbId: row.tmdb_id,
      tmdbType: row.tmdb_type,
      tmdbSeason: row.tmdb_season,
      source: 'override',
    };
  }
}
