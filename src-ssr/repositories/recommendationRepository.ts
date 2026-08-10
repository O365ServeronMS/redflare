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

  /** Reads last-good target refs when a TMDB recommendation request fails. */
  async getTargetsForSlug(slug: string): Promise<RecommendationEdge[]> {
    const res = await this.db
      .prepare(
        `SELECT target_tmdb_id, target_type, sort_order FROM recommendation
         WHERE slug = ? ORDER BY sort_order`
      )
      .bind(slug)
      .all<{ target_tmdb_id: number; target_type: string; sort_order: number }>();
    return (res.results ?? []).map((row) => ({
      targetTmdbId: row.target_tmdb_id,
      targetType: row.target_type as TmdbType,
      sortOrder: row.sort_order,
    }));
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
   * stubs for the targets that pay off the most first). Excludes edges
   * already marked resolve_attempted -- a target that resolved to nothing
   * (not in the local catalog, not on KKPhim, not stub-eligible) would
   * otherwise cost a fresh KKPhim/TMDB fetch on every single tick forever. */
  async getUnresolvedGroupedByTarget(
    limit: number
  ): Promise<{ targetTmdbId: number; targetType: TmdbType; refCount: number }[]> {
    const res = await this.db
      .prepare(
        `SELECT target_tmdb_id, target_type, COUNT(*) as ref_count
         FROM recommendation WHERE target_slug IS NULL AND resolve_attempted = 0
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

  /** Resolves every edge sharing this (target_tmdb_id, target_type) to a
   * real slug -- either an existing catalog title or a freshly-materialized
   * stub (both already written to `movie` by the caller before this runs). */
  async markResolved(targetTmdbId: number, targetType: TmdbType, slug: string): Promise<void> {
    await this.db
      .prepare(
        'UPDATE recommendation SET target_slug = ? WHERE target_tmdb_id = ? AND target_type = ? AND target_slug IS NULL'
      )
      .bind(slug, targetTmdbId, targetType)
      .run();
  }

  /** Resolve was attempted and came up empty (not in catalog, not on
   * KKPhim, not stub-eligible under the current MAX_STUBS budget) -- stop
   * re-trying it every tick. This is the overflow tier (ADR-0002 Finding
   * 3): the edge stays in the table, unrendered, in case a later change
   * (MAX_STUBS raised, or the title eventually lands on KKPhim) makes it
   * resolvable -- nothing here is permanent, just deprioritized. */
  async markAttempted(targetTmdbId: number, targetType: TmdbType): Promise<void> {
    await this.db
      .prepare(
        'UPDATE recommendation SET resolve_attempted = 1 WHERE target_tmdb_id = ? AND target_type = ? AND target_slug IS NULL'
      )
      .bind(targetTmdbId, targetType)
      .run();
  }

  /** For /__sync/status (Phase 4 visibility) -- how much of the
   * recommendation table is resolved vs. still pending vs. permanently
   * overflowed. */
  async getResolveStats(): Promise<{ resolved: number; pendingUnresolved: number; overflow: number }> {
    const row = await this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN target_slug IS NOT NULL THEN 1 ELSE 0 END) as resolved,
           SUM(CASE WHEN target_slug IS NULL AND resolve_attempted = 0 THEN 1 ELSE 0 END) as pending,
           SUM(CASE WHEN target_slug IS NULL AND resolve_attempted = 1 THEN 1 ELSE 0 END) as overflow
         FROM recommendation`
      )
      .first<{ resolved: number | null; pending: number | null; overflow: number | null }>();
    return {
      resolved: row?.resolved ?? 0,
      pendingUnresolved: row?.pending ?? 0,
      overflow: row?.overflow ?? 0,
    };
  }
}
