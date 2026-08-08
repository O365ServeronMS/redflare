import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { afterEach, test } from 'node:test';
import { Miniflare } from 'miniflare';
import { HeroSnapshotRepository } from '../src-ssr/repositories/heroSnapshotRepository.ts';

const instances = [];
afterEach(async () => Promise.all(instances.splice(0).map((mf) => mf.dispose())));

async function setup() {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok"); } };',
    d1Databases: { DB: crypto.randomUUID() },
  });
  instances.push(mf);
  const db = await mf.getD1Database('DB');
  await db.batch([
    db.prepare('CREATE TABLE movie (slug TEXT PRIMARY KEY, title TEXT NOT NULL)'),
    db.prepare('CREATE TABLE sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)'),
    db.prepare("INSERT INTO movie VALUES ('alpha', 'Alpha'), ('beta', 'Beta'), ('gamma', 'Gamma')"),
  ]);
  const migration = await readFile(new URL('../migrations/0010_hero_snapshot.sql', import.meta.url), 'utf8');
  await db.prepare(migration).run();
  return { db, repo: new HeroSnapshotRepository(db) };
}

const metadata = {
  lastSuccessAt: 1_800_000_000,
  lastAttemptAt: 1_800_000_005,
  result: { tmdbCount: 20, matchedCount: 2, notFoundCount: 18, failedCount: 0 },
};

test('keeps sparse rank order, rejects duplicate TMDB IDs, and accepts empty snapshots', async () => {
  const { db, repo } = await setup();
  await repo.replaceSnapshot(
    [{ rank: 9, tmdbId: 109, slug: 'beta' }, { rank: 2, tmdbId: 102, slug: 'alpha' }],
    metadata
  );
  assert.deepEqual((await repo.getRankedMovies()).map(({ slug }) => slug), ['alpha', 'beta']);
  assert.deepEqual((await db.prepare('SELECT rank FROM hero_snapshot ORDER BY rank').all()).results, [{ rank: 2 }, { rank: 9 }]);
  assert.deepEqual(await repo.getRefreshState(), {
    lastSuccessAt: metadata.lastSuccessAt,
    lastAttemptAt: metadata.lastAttemptAt,
    lastResult: metadata.result,
  });

  await assert.rejects(
    repo.replaceSnapshot(
      [{ rank: 1, tmdbId: 202, slug: 'beta' }, { rank: 2, tmdbId: 202, slug: 'gamma' }],
      metadata
    ),
    /Duplicate Hero snapshot TMDB ID/
  );
  assert.deepEqual((await repo.getRankedMovies()).map(({ slug }) => slug), ['alpha', 'beta']);

  const empty = {
    lastSuccessAt: metadata.lastSuccessAt + 60,
    lastAttemptAt: metadata.lastAttemptAt + 60,
    result: { tmdbCount: 0, matchedCount: 0, notFoundCount: 0, failedCount: 0 },
  };
  await repo.replaceSnapshot([], empty);
  assert.deepEqual(await repo.getRankedMovies(), []);
  assert.deepEqual(await repo.getRefreshState(), {
    lastSuccessAt: empty.lastSuccessAt,
    lastAttemptAt: empty.lastAttemptAt,
    lastResult: empty.result,
  });
});

test('failed batch leaves the previous snapshot and metadata intact', async () => {
  const { db, repo } = await setup();
  await repo.replaceSnapshot([{ rank: 1, tmdbId: 101, slug: 'alpha' }], metadata);
  await db.prepare(`CREATE TRIGGER reject_gamma BEFORE INSERT ON hero_snapshot WHEN NEW.slug = 'gamma'
    BEGIN SELECT RAISE(ABORT, 'intentional test failure'); END`).run();

  await assert.rejects(
    repo.replaceSnapshot(
      [{ rank: 2, tmdbId: 202, slug: 'beta' }, { rank: 3, tmdbId: 203, slug: 'gamma' }],
      { ...metadata, lastSuccessAt: metadata.lastSuccessAt + 60, lastAttemptAt: metadata.lastAttemptAt + 60 }
    ),
    /intentional test failure/
  );
  assert.deepEqual((await repo.getRankedMovies()).map(({ slug }) => slug), ['alpha']);
  assert.deepEqual(await repo.getRefreshState(), {
    lastSuccessAt: metadata.lastSuccessAt,
    lastAttemptAt: metadata.lastAttemptAt,
    lastResult: metadata.result,
  });
});
