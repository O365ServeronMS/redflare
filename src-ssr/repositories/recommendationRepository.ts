import { chunkByParams } from '../db/chunk';
import type { MovieRow, TmdbType } from '../types/movie';

const REC_COLUMNS = 5;

export interface RecommendationEdge {
  targetTmdbId: number;
  targetType: TmdbType;
  sortOrder: number;
}

export class RecommendationRepository {
  constructor(private readonly db: D1Database) {}

  /** Written with target_slug = NULL by sync (Phase 2); resolved to a slug
   * (or promoted to a stub, or left NULL/overflow) by the Phase 4 resolve
   * step. Only called when the source movie's hash changed, same reasoning
   * as EpisodeRepository.replaceForSlug. */
  async replaceTargetsForSlug(slug: string, edges: readonly RecommendationEdge[]): Promise<void> {
    const statements: D1PreparedStatement[] = [
      this.db.prepare('DELETE FROM recommendation WHERE slug = ?').bind(slug),
    ];
    if (edges.length > 0) {
      const insertSql = `INSERT INTO recommendation (slug, target_slug, target_tmdb_id, target_type, sort_order) VALUES ${'(' + Array(REC_COLUMNS).fill('?').join(',') + ')'}`;
      for (const chunk of chunkByParams(edges, REC_COLUMNS)) {
        const stmt = this.db.prepare(insertSql);
        for (const edge of chunk) {
          statements.push(stmt.bind(slug, null, edge.targetTmdbId, edge.targetType, edge.sortOrder));
        }
      }
    }
    await this.db.batch(statements);
  }

  /** The detail page's 3rd query (plan §3.1) -- a single JOIN, not a loop
   * over getBySlugs for each target. Rows with target_slug still NULL
   * (unresolved -- Phase 4 hasn't run, or the target never resolved) are
   * excluded by the JOIN itself, not filtered after the fact. */
  async getResolvedForSlug(slug: string, limit: number): Promise<MovieRow[]> {
    const res = await this.db
      .prepare(
        `SELECT m.* FROM recommendation r JOIN movie m ON m.slug = r.target_slug
         WHERE r.slug = ? ORDER BY r.sort_order LIMIT ?`
      )
      .bind(slug, limit)
      .all<MovieRow>();
    return res.results ?? [];
  }

  /** Unresolved edges grouped by target, most-referenced first -- the order
   * Phase 4's resolve step works through (ADR-0002 Finding 3: materialize
   * stubs for the targets that pay off the most first). */
  async getUnresolvedGroupedByTarget(
    limit: number
  ): Promise<{ targetTmdbId: number; targetType: TmdbType; refCount: number }[]> {
    const res = await this.db
      .prepare(
        `SELECT target_tmdb_id, target_type, COUNT(*) as ref_count
         FROM recommendation WHERE target_slug IS NULL
         GROUP BY target_tmdb_id, target_type
         ORDER BY ref_count DESC LIMIT ?`
      )
      .bind(limit)
      .all<{ target_tmdb_id: number; target_type: string; ref_count: number }>();
    return (res.results ?? []).map((r) => ({
      targetTmdbId: r.target_tmdb_id,
      targetType: r.target_type as TmdbType,
      refCount: r.ref_count,
    }));
  }
}
