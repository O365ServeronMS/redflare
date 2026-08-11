import { chunkByParams } from '../db/chunk';
import type { MovieRow, TmdbType } from '../types/movie';

const REC_COLUMNS = 5;

export interface RecommendationEdge {
  targetTmdbId: number;
  targetType: TmdbType;
  sortOrder: number;
}
export interface RecommendationTargetGroup {
  targetTmdbId: number;
  targetType: TmdbType;
  refCount: number;
  hasLocalTarget: boolean;
}

export interface RecommendationRequeueCursor {
  hasLocalTarget: boolean;
  refCount: number;
  targetType: TmdbType;
  targetTmdbId: number;
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

  /** Source-only refresh preserves slugs TMDB still returns, so rank refresh
   * does not temporarily turn an already-rendering rail into pending edges. */
  async replaceTargetsPreservingResolvedForSlug(slug: string, edges: readonly RecommendationEdge[]): Promise<void> {
    const current = await this.db.prepare(
      'SELECT target_tmdb_id, target_type, target_slug FROM recommendation WHERE slug = ?'
    ).bind(slug).all<{ target_tmdb_id: number; target_type: string; target_slug: string | null }>();
    const resolved = new Map((current.results ?? []).map((row) => [
      `${row.target_type}:${row.target_tmdb_id}`, row.target_slug,
    ]));
    if (edges.length > 0) {
      const predicates = edges.map(() => '(tmdb_type = ? AND tmdb_id = ?)').join(' OR ');
      const local = await this.db.prepare(
        `SELECT tmdb_id, tmdb_type, slug FROM movie
         WHERE ${predicates}
         ORDER BY CASE tier WHEN 'catalog' THEN 0 ELSE 1 END, slug ASC`
      ).bind(...edges.flatMap((edge) => [edge.targetType, edge.targetTmdbId]))
        .all<{ tmdb_id: number; tmdb_type: string; slug: string }>();
      for (const row of local.results ?? []) {
        const key = `${row.tmdb_type}:${row.tmdb_id}`;
        if (!resolved.get(key)) resolved.set(key, row.slug);
      }
    }
    const statements: D1PreparedStatement[] = [this.db.prepare('DELETE FROM recommendation WHERE slug = ?').bind(slug)];
    if (edges.length > 0) {
      const sql = `INSERT INTO recommendation (slug, target_slug, target_tmdb_id, target_type, sort_order) VALUES ${'(' + Array(REC_COLUMNS).fill('?').join(',') + ')'}`;
      for (const chunk of chunkByParams(edges, REC_COLUMNS)) {
        const statement = this.db.prepare(sql);
        for (const edge of chunk) {
          statements.push(statement.bind(slug, resolved.get(`${edge.targetType}:${edge.targetTmdbId}`) ?? null, edge.targetTmdbId, edge.targetType, edge.sortOrder));
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
         WHERE r.slug = ? AND r.target_slug != ?
         GROUP BY r.target_slug
         ORDER BY MIN(r.sort_order) ASC, m.slug ASC
         LIMIT ?`
      )
      .bind(slug, slug, limit)
      .all<MovieRow>();
    return res.results ?? [];
  }

  /** Unresolved groups are processed local-first, then by fan-out. That
   * keeps a title that has just reached the catalog off the upstream path. */
  async getUnresolvedGroupedByTarget(limit: number): Promise<RecommendationTargetGroup[]> {
    const res = await this.db
      .prepare(
        `SELECT r.target_tmdb_id, r.target_type, COUNT(*) AS ref_count,
                MAX(CASE WHEN m.slug IS NOT NULL OR override_movie.slug IS NOT NULL THEN 1 ELSE 0 END) AS has_local_target
         FROM recommendation r
         LEFT JOIN movie m ON m.tmdb_id = r.target_tmdb_id AND m.tmdb_type = r.target_type
         LEFT JOIN tmdb_override o ON o.tmdb_id = r.target_tmdb_id AND o.tmdb_type = r.target_type
         LEFT JOIN movie override_movie ON override_movie.slug = o.slug
         WHERE r.target_slug IS NULL AND r.resolve_attempted = 0
         GROUP BY r.target_tmdb_id, r.target_type
         ORDER BY has_local_target DESC, ref_count DESC, r.target_type ASC, r.target_tmdb_id ASC
         LIMIT ?`
      )
      .bind(limit)
      .all<{ target_tmdb_id: number; target_type: string; ref_count: number; has_local_target: number }>();
    return (res.results ?? []).map((r) => ({
      targetTmdbId: r.target_tmdb_id,
      targetType: r.target_type as TmdbType,
      refCount: r.ref_count,
      hasLocalTarget: r.has_local_target === 1,
    }));
  }

  /** Pages only overflow groups that have become actionable. The cursor is
   * over the aggregate priority order, avoiding a table-wide reset. */
  async getOverflowGroupsForRequeue(
    limit: number,
    minStubRefCount: number,
    includeStubEligible: boolean,
    cursor: RecommendationRequeueCursor | null
  ): Promise<RecommendationTargetGroup[]> {
    const cursorClause = cursor
      ? `AND (
           has_local_target < ? OR
           (has_local_target = ? AND ref_count < ?) OR
           (has_local_target = ? AND ref_count = ? AND target_type > ?) OR
           (has_local_target = ? AND ref_count = ? AND target_type = ? AND target_tmdb_id > ?)
         )`
      : '';
    const binds: (number | string)[] = [includeStubEligible ? 1 : 0, minStubRefCount];
    if (cursor) {
      const local = cursor.hasLocalTarget ? 1 : 0;
      binds.push(local, local, cursor.refCount, local, cursor.refCount, cursor.targetType, local, cursor.refCount, cursor.targetType, cursor.targetTmdbId);
    }
    binds.push(limit);
    const res = await this.db
      .prepare(
        `WITH grouped AS (
           SELECT r.target_tmdb_id, r.target_type, COUNT(*) AS ref_count,
                  MAX(CASE WHEN m.slug IS NOT NULL OR override_movie.slug IS NOT NULL THEN 1 ELSE 0 END) AS has_local_target
           FROM recommendation r
           LEFT JOIN movie m ON m.tmdb_id = r.target_tmdb_id AND m.tmdb_type = r.target_type
           LEFT JOIN tmdb_override o ON o.tmdb_id = r.target_tmdb_id AND o.tmdb_type = r.target_type
           LEFT JOIN movie override_movie ON override_movie.slug = o.slug
           WHERE r.target_slug IS NULL AND r.resolve_attempted = 1
           GROUP BY r.target_tmdb_id, r.target_type
         )
         SELECT target_tmdb_id, target_type, ref_count, has_local_target
         FROM grouped
         WHERE (has_local_target = 1 OR (? = 1 AND ref_count >= ?))
         ${cursorClause}
         ORDER BY has_local_target DESC, ref_count DESC, target_type ASC, target_tmdb_id ASC
         LIMIT ?`
      )
      .bind(...binds)
      .all<{ target_tmdb_id: number; target_type: string; ref_count: number; has_local_target: number }>();
    return (res.results ?? []).map((r) => ({
      targetTmdbId: r.target_tmdb_id,
      targetType: r.target_type as TmdbType,
      refCount: r.ref_count,
      hasLocalTarget: r.has_local_target === 1,
    }));
  }

  async requeueAttemptedGroups(groups: readonly RecommendationTargetGroup[]): Promise<void> {
    if (groups.length === 0) return;
    await this.db.batch(groups.map((group) => this.db
      .prepare(
        `UPDATE recommendation SET resolve_attempted = 0
         WHERE target_tmdb_id = ? AND target_type = ?
           AND target_slug IS NULL AND resolve_attempted = 1`
      )
      .bind(group.targetTmdbId, group.targetType)));
  }

  /** Source detail API tags to purge after a target-group edge write commits. */
  async getSourceCacheTagsForTarget(targetTmdbId: number, targetType: TmdbType): Promise<string[]> {
    const res = await this.db
      .prepare(
        `SELECT DISTINCT m.tmdb_type, m.tmdb_id
         FROM recommendation r JOIN movie m ON m.slug = r.slug
         WHERE r.target_tmdb_id = ? AND r.target_type = ?
           AND m.tmdb_id IS NOT NULL AND m.tmdb_type IN ('movie', 'tv')`
      )
      .bind(targetTmdbId, targetType)
      .all<{ tmdb_type: TmdbType; tmdb_id: number }>();
    return (res.results ?? []).map((row) => `recommendation:${row.tmdb_type}:${row.tmdb_id}`);
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
