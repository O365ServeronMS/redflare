import type { TmdbType } from '../types/movie';

export interface RecommendationRefreshCandidate {
  slug: string;
  tmdbId: number;
  tmdbType: TmdbType;
}

export class RecommendationFreshnessRepository {
  constructor(private readonly db: D1Database) {}

  /** Q6 fix (docs/plan-recommendation-d1-reads.md Phase 2): the old query
   * anti-joined `movie` -> `recommendation_freshness` to define "never
   * refreshed" as "has no freshness row", which forced a scan of almost the
   * entire ~30k-row `movie` table (~29,435 rows read/call). Migration 0018 +
   * syncOneMovie's freshness write (Phase 2.2) make "every eligible source
   * has a freshness row" an invariant, so this can walk
   * recommendation_freshness through its own index instead -- two
   * sequential queries (CROSS JOIN forces SQLite to keep driving from `f`,
   * not `m`) rather than one UNION, so LIMIT still caps total rows read.
   * A movie that loses its tmdb_id or leaves the catalog keeps its
   * freshness row but is filtered out by the `m` predicates below -- an
   * extra per-row lookup, not a scan, so the cost stays proportional to
   * `limit`. */
  async getDueSources(
    ttlSeconds: number,
    retryAfterSeconds: number,
    limit: number
  ): Promise<RecommendationRefreshCandidate[]> {
    const now = Math.floor(Date.now() / 1000);
    const map = (row: { slug: string; tmdb_id: number; tmdb_type: string }): RecommendationRefreshCandidate => ({
      slug: row.slug, tmdbId: row.tmdb_id, tmdbType: row.tmdb_type as TmdbType,
    });

    // A: never succeeded, and the retry backoff has elapsed.
    const neverSucceeded = await this.db.prepare(
      `SELECT m.slug, m.tmdb_id, m.tmdb_type
       FROM recommendation_freshness f CROSS JOIN movie m
       WHERE m.slug = f.slug
         AND f.last_success_at IS NULL AND f.last_attempt_at <= ?
         AND m.tier = 'catalog' AND m.tmdb_id IS NOT NULL AND m.tmdb_type IN ('movie', 'tv')
       ORDER BY f.slug
       LIMIT ?`
    ).bind(now - retryAfterSeconds, limit)
      .all<{ slug: string; tmdb_id: number; tmdb_type: string }>();
    const results = (neverSucceeded.results ?? []).map(map);
    if (results.length >= limit) return results;

    // B: succeeded before, but the TTL has expired.
    const expired = await this.db.prepare(
      `SELECT m.slug, m.tmdb_id, m.tmdb_type
       FROM recommendation_freshness f CROSS JOIN movie m
       WHERE m.slug = f.slug
         AND f.last_success_at <= ?
         AND m.tier = 'catalog' AND m.tmdb_id IS NOT NULL AND m.tmdb_type IN ('movie', 'tv')
       ORDER BY f.last_success_at, f.slug
       LIMIT ?`
    ).bind(now - ttlSeconds, limit - results.length)
      .all<{ slug: string; tmdb_id: number; tmdb_type: string }>();
    results.push(...(expired.results ?? []).map(map));
    return results;
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
