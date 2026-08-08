import type { HeroRefreshResult, HeroRefreshState, HeroSnapshotEntry, HeroSnapshotMetadata } from '../types/heroSnapshot';
import type { MovieRow } from '../types/movie';

const LAST_SUCCESS_KEY = 'hero:last_success_at';
const LAST_ATTEMPT_KEY = 'hero:last_attempt_at';
const LAST_RESULT_KEY = 'hero:last_result';

const UPSERT_STATE_SQL = `
INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
`;

function validateRows(rows: readonly HeroSnapshotEntry[]): void {
  if (rows.length > 20) throw new RangeError('Hero snapshot cannot contain more than 20 rows');
  const ranks = new Set<number>();
  const tmdbIds = new Set<number>();
  for (const row of rows) {
    if (!Number.isInteger(row.rank) || row.rank < 1 || row.rank > 20) {
      throw new RangeError('Hero snapshot rank must be an integer between 1 and 20');
    }
    if (!Number.isInteger(row.tmdbId) || row.tmdbId <= 0) {
      throw new TypeError('Hero snapshot tmdbId must be a positive integer');
    }
    if (row.slug.trim().length === 0) throw new TypeError('Hero snapshot slug must not be empty');
    if (ranks.has(row.rank)) throw new TypeError(`Duplicate Hero snapshot rank: ${row.rank}`);
    if (tmdbIds.has(row.tmdbId)) throw new TypeError(`Duplicate Hero snapshot TMDB ID: ${row.tmdbId}`);
    ranks.add(row.rank);
    tmdbIds.add(row.tmdbId);
  }
}

function validateMetadata(metadata: HeroSnapshotMetadata): void {
  const values = [
    metadata.lastSuccessAt,
    metadata.lastAttemptAt,
    metadata.result.tmdbCount,
    metadata.result.matchedCount,
    metadata.result.notFoundCount,
    metadata.result.failedCount,
  ];
  if (values.some((value) => !Number.isInteger(value) || value < 0)) {
    throw new TypeError('Hero snapshot metadata values must be non-negative integers');
  }
}

function parseEpoch(value: string | null): number | null {
  const parsed = value === null ? NaN : Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parseResult(value: string | null): HeroRefreshResult | null {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const result = parsed as Record<string, unknown>;
    const fields = ['tmdbCount', 'matchedCount', 'notFoundCount', 'failedCount'] as const;
    if (!fields.every((field) => Number.isInteger(result[field]) && (result[field] as number) >= 0)) return null;
    return result as unknown as HeroRefreshResult;
  } catch {
    return null;
  }
}

export class HeroSnapshotRepository {
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  async getRankedMovies(): Promise<MovieRow[]> {
    const res = await this.db
      .prepare('SELECT m.* FROM hero_snapshot h JOIN movie m ON m.slug = h.slug ORDER BY h.rank')
      .all<MovieRow>();
    return res.results ?? [];
  }

  /** D1 batch() is documented as a SQL transaction that rolls back the
   * sequence on failure:
   * https://developers.cloudflare.com/d1/worker-api/d1-database/#batch */
  async replaceSnapshot(rows: readonly HeroSnapshotEntry[], metadata: HeroSnapshotMetadata): Promise<void> {
    validateRows(rows);
    validateMetadata(metadata);

    const statements: D1PreparedStatement[] = [this.db.prepare('DELETE FROM hero_snapshot')];
    const insert = this.db.prepare(
      'INSERT INTO hero_snapshot (rank, tmdb_id, slug, refreshed_at) VALUES (?, ?, ?, ?)'
    );
    for (const row of rows) {
      statements.push(insert.bind(row.rank, row.tmdbId, row.slug, metadata.lastSuccessAt));
    }
    const upsertState = this.db.prepare(UPSERT_STATE_SQL);
    statements.push(
      upsertState.bind(LAST_SUCCESS_KEY, String(metadata.lastSuccessAt), metadata.lastSuccessAt),
      upsertState.bind(LAST_ATTEMPT_KEY, String(metadata.lastAttemptAt), metadata.lastAttemptAt),
      upsertState.bind(LAST_RESULT_KEY, JSON.stringify(metadata.result), metadata.lastAttemptAt)
    );
    await this.db.batch(statements);
  }

  /** Records a failed refresh without touching the last-known-good
   * snapshot or its success timestamp. */
  async recordAttempt(lastAttemptAt: number, result: HeroRefreshResult): Promise<void> {
    validateMetadata({ lastSuccessAt: 0, lastAttemptAt, result });
    const upsertState = this.db.prepare(UPSERT_STATE_SQL);
    await this.db.batch([
      upsertState.bind(LAST_ATTEMPT_KEY, String(lastAttemptAt), lastAttemptAt),
      upsertState.bind(LAST_RESULT_KEY, JSON.stringify(result), lastAttemptAt),
    ]);
  }

  async getRefreshState(): Promise<HeroRefreshState> {
    const row = await this.db
      .prepare(
        `SELECT
           MAX(CASE WHEN key = ? THEN value END) AS last_success_at,
           MAX(CASE WHEN key = ? THEN value END) AS last_attempt_at,
           MAX(CASE WHEN key = ? THEN value END) AS last_result
         FROM sync_state WHERE key IN (?, ?, ?)`
      )
      .bind(
        LAST_SUCCESS_KEY, LAST_ATTEMPT_KEY, LAST_RESULT_KEY,
        LAST_SUCCESS_KEY, LAST_ATTEMPT_KEY, LAST_RESULT_KEY
      )
      .first<{ last_success_at: string | null; last_attempt_at: string | null; last_result: string | null }>();
    return {
      lastSuccessAt: parseEpoch(row?.last_success_at ?? null),
      lastAttemptAt: parseEpoch(row?.last_attempt_at ?? null),
      lastResult: parseResult(row?.last_result ?? null),
    };
  }
}
