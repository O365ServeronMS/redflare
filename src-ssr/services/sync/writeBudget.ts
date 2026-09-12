import type { SyncStateRepository } from '../../repositories/syncStateRepository';

/** Daily D1 row-write governor. Free plan hard cap is 100,000 rows
 * written/day, after which D1 rejects EVERY query (read included) until
 * 00:00 UTC; 85,000 leaves headroom for the writes this counter under-counts
 * (see the index accounting in docs/plan-free-tier-overrun.md). */
export const MAX_ROWS_PER_DAY = 85_000;

/** Every write path must call this before writing. Costs one indexed
 * sync_state read. */
export async function hasWriteBudget(syncState: SyncStateRepository): Promise<boolean> {
  return (await syncState.getRowsWrittenToday()) < MAX_ROWS_PER_DAY;
}
