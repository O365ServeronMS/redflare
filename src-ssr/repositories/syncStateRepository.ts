// Sync bookkeeping: incremental cursor, per-day write governor counter,
// backfill cursor (docs/plan-ssr-rearchitecture.md Phase 2).
export class SyncStateRepository {
  constructor(private readonly db: D1Database) {}

  async get(key: string): Promise<string | null> {
    const row = await this.db.prepare('SELECT value FROM sync_state WHERE key = ?').bind(key).first<{ value: string }>();
    return row?.value ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    await this.db
      .prepare(
        'INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
      )
      .bind(key, value, Math.floor(Date.now() / 1000))
      .run();
  }

  private rowsKey(date = new Date()): string {
    return `rows:${date.toISOString().slice(0, 10)}`;
  }

  /** Today's row-write count, per the governor described in ADR-0002
   * Finding 2 / plan §2.2. Free-mode sync must check this BEFORE writing;
   * burst mode (Paid, no daily D1 cap) never calls it. */
  async getRowsWrittenToday(): Promise<number> {
    const v = await this.get(this.rowsKey());
    return v ? Number(v) : 0;
  }

  /** Not exact under concurrent shards (read-then-write race), which is
   * fine here: the governor only needs to stop runaway writes well before
   * the 100,000/day quota, not account to the row. */
  async addRowsWrittenToday(n: number): Promise<void> {
    const current = await this.getRowsWrittenToday();
    await this.set(this.rowsKey(), String(current + n));
  }
}
