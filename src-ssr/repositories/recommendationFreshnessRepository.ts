import type { TmdbType } from '../types/movie';

export interface RecommendationRefreshCandidate {
  slug: string;
  tmdbId: number;
  tmdbType: TmdbType;
}

export class RecommendationFreshnessRepository {
  constructor(private readonly db: D1Database) {}

  async getDueSources(
    ttlSeconds: number,
    retryAfterSeconds: number,
    limit: number
  ): Promise<RecommendationRefreshCandidate[]> {
    const now = Math.floor(Date.now() / 1000);
    const res = await this.db.prepare(
      `SELECT m.slug, m.tmdb_id, m.tmdb_type
       FROM movie m LEFT JOIN recommendation_freshness f ON f.slug = m.slug
       WHERE m.tier = 'catalog' AND m.tmdb_id IS NOT NULL
         AND m.tmdb_type IN ('movie', 'tv')
         AND (
           (f.last_success_at IS NULL AND (f.last_attempt_at IS NULL OR f.last_attempt_at <= ?))
           OR f.last_success_at <= ?
         )
       ORDER BY CASE WHEN f.last_success_at IS NULL THEN 0 ELSE 1 END,
                f.last_success_at ASC, m.slug ASC
       LIMIT ?`
    ).bind(now - retryAfterSeconds, now - ttlSeconds, limit)
      .all<{ slug: string; tmdb_id: number; tmdb_type: string }>();
    return (res.results ?? []).map((row) => ({
      slug: row.slug, tmdbId: row.tmdb_id, tmdbType: row.tmdb_type as TmdbType,
    }));
  }

  async markAttempt(slug: string, result: 'success' | 'valid_empty' | 'retryable_error'): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    await this.db.prepare(
      `INSERT INTO recommendation_freshness (slug, last_success_at, last_attempt_at, result)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(slug) DO UPDATE SET
         last_success_at = CASE WHEN excluded.result IN ('success', 'valid_empty') THEN excluded.last_success_at ELSE recommendation_freshness.last_success_at END,
         last_attempt_at = excluded.last_attempt_at, result = excluded.result`
    ).bind(slug, result === 'retryable_error' ? null : now, now, result).run();
  }
}
