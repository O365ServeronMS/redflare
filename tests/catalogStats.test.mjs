import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { CatalogStatsRepository } from '../src-ssr/repositories/catalogStatsRepository.ts';

// Q8 in docs/plan-incremental-sync-stall.md: refresh() scans all of
// movie + genre_movie + country_movie (~140k rows read) and up to three
// callers can invoke it per tick. It must self-throttle to at most once
// per 6h using a sync_state stamp.

const realDateNow = Date.now;
afterEach(() => {
  Date.now = realDateNow;
});

/** Minimal D1 fake: records every prepared SQL string, serves canned
 * aggregate results, and keeps sync_state in a Map so the refresh stamp
 * survives between refresh() calls. */
function fakeDb() {
  const preparedSql = [];
  const syncState = new Map();
  const db = {
    preparedSql,
    syncState,
    prepare(sql) {
      preparedSql.push(sql);
      let binds = [];
      return {
        bind(...values) {
          binds = values;
          return this;
        },
        async first() {
          if (sql.includes('SELECT value FROM sync_state')) {
            const value = syncState.get(binds[0]);
            return value === undefined ? null : { value };
          }
          if (sql.includes("COUNT(*) AS n FROM movie WHERE tier = 'catalog'")) return { n: 5 };
          throw new Error(`Unexpected first(): ${sql}`);
        },
        async all() {
          if (sql.includes('GROUP BY type')) return { results: [{ type: 'single', n: 3 }] };
          if (sql.includes('GROUP BY genre_slug')) return { results: [{ genre_slug: 'hanh-dong', n: 2 }] };
          if (sql.includes('GROUP BY country_slug')) return { results: [{ country_slug: 'han-quoc', n: 1 }] };
          throw new Error(`Unexpected all(): ${sql}`);
        },
        async run() {
          if (sql.includes('INSERT INTO sync_state')) {
            syncState.set(binds[0], binds[1]);
            return { success: true };
          }
          throw new Error(`Unexpected run(): ${sql}`);
        },
      };
    },
    async batch(statements) {
      return statements.map(() => ({ success: true }));
    },
  };
  return db;
}

const recomputeCount = (db) =>
  db.preparedSql.filter((sql) => sql.includes('DELETE FROM catalog_stats')).length;

test('refresh() recomputes once, then no-ops within the 6h window', async () => {
  const db = fakeDb();
  const repo = new CatalogStatsRepository(db);

  Date.now = () => 1_000_000_000_000;
  await repo.refresh();
  assert.equal(recomputeCount(db), 1, "first call recomputes");
  assert.ok(db.syncState.has('catalog_stats:refreshed_at'), 'stamp written');

  Date.now = () => 1_000_000_000_000 + 5 * 60 * 60 * 1000; // +5h, still inside the window
  await repo.refresh();
  assert.equal(recomputeCount(db), 1, "second call within 6h is a no-op");
});

test('refresh() runs again once the 6h window has elapsed', async () => {
  const db = fakeDb();
  const repo = new CatalogStatsRepository(db);

  Date.now = () => 1_000_000_000_000;
  await repo.refresh();

  Date.now = () => 1_000_000_000_000 + 7 * 60 * 60 * 1000; // +7h
  await repo.refresh();
  assert.equal(recomputeCount(db), 2, "a stale stamp lets refresh recompute");
});

// Phase 2 (docs/plan-free-tier-overrun.md 2.5): refresh()'s return value
// feeds the write-budget counter, so it must match the row-accounting table
// exactly -- no secondary index on catalog_stats, so DELETE+INSERT costs 2
// rows/entry (1 tier + 1 type + 1 genre + 1 country = 4 entries from fakeDb's
// canned aggregates), +2 for the sync_state stamp upsert.
test("refresh() trả đúng số rows", async () => {
  const db = fakeDb();
  const repo = new CatalogStatsRepository(db);

  Date.now = () => 1_000_000_000_000;
  const rowsWritten = await repo.refresh();
  assert.equal(rowsWritten, 4 * 2 + 2);
});

test('thoát sớm vì rate limit → trả 0', async () => {
  const db = fakeDb();
  const repo = new CatalogStatsRepository(db);

  Date.now = () => 1_000_000_000_000;
  await repo.refresh();

  Date.now = () => 1_000_000_000_000 + 5 * 60 * 60 * 1000; // +5h, still inside the window
  const rowsWritten = await repo.refresh();
  assert.equal(rowsWritten, 0);
});
