import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { afterEach, test } from 'node:test';
import { Miniflare } from 'miniflare';

import { runRecommendationRefreshTick } from '../src-ssr/services/sync/recommendationRefresh.ts';
import { RecommendationFreshnessRepository } from '../src-ssr/repositories/recommendationFreshnessRepository.ts';

const originalFetch = globalThis.fetch;
const instances = [];

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await Promise.all(instances.splice(0).map((mf) => mf.dispose()));
});

async function setup() {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok"); } };',
    d1Databases: { DB: crypto.randomUUID() },
  });
  instances.push(mf);
  const db = await mf.getD1Database('DB');
  await db.batch([
    db.prepare('CREATE TABLE movie (slug TEXT PRIMARY KEY, tmdb_id INTEGER, tmdb_type TEXT, tier TEXT)'),
    db.prepare('CREATE TABLE recommendation (slug TEXT NOT NULL, target_slug TEXT, target_tmdb_id INTEGER NOT NULL, target_type TEXT NOT NULL, sort_order INTEGER NOT NULL, resolve_attempted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (slug, target_tmdb_id, target_type))'),
  ]);
  const migration = await readFile(new URL('../migrations/0011_recommendation_freshness.sql', import.meta.url), 'utf8');
  await db.batch(migration.replaceAll(/--.*$/gm, '').split(';').map((sql) => sql.trim()).filter(Boolean).map((sql) => db.prepare(sql)));
  await db.prepare("INSERT INTO movie (slug, tmdb_id, tmdb_type, tier) VALUES ('source', 101, 'movie', 'catalog')").run();
  await db.prepare("INSERT INTO recommendation (slug, target_slug, target_tmdb_id, target_type, sort_order) VALUES ('source', 'existing-target', 42, 'movie', 0)").run();
  // Phase 2 invariant (docs/plan-recommendation-d1-reads.md): every eligible
  // source has a freshness row (0018 seed + syncOneMovie's own write) --
  // getDueSources no longer anti-joins `movie` to find rows missing one.
  // last_attempt_at = 0 keeps 'source' due (never succeeded, backoff long past).
  await db.prepare("INSERT INTO recommendation_freshness (slug, last_success_at, last_attempt_at, result) VALUES ('source', NULL, 0, 'seeded')").run();
  return { db, env: { DB: db, TMDB_API_TOKEN: 'test-token' } };
}

async function setupFreshnessOnly() {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok"); } };',
    d1Databases: { DB: crypto.randomUUID() },
  });
  instances.push(mf);
  const db = await mf.getD1Database('DB');
  await db.prepare('CREATE TABLE movie (slug TEXT PRIMARY KEY, tmdb_id INTEGER, tmdb_type TEXT, tier TEXT)').run();
  const migration = await readFile(new URL('../migrations/0011_recommendation_freshness.sql', import.meta.url), 'utf8');
  await db.batch(migration.replaceAll(/--.*$/gm, '').split(';').map((sql) => sql.trim()).filter(Boolean).map((sql) => db.prepare(sql)));
  return db;
}

test('retryable refresh preserves last-good edges and backs off the source', async () => {
  const { db, env } = await setup();
  globalThis.fetch = async () => new Response('{}', { status: 503 });

  const result = await runRecommendationRefreshTick(env);
  assert.equal(result.retryable, 1);
  assert.deepEqual(await db.prepare('SELECT target_slug, target_tmdb_id FROM recommendation WHERE slug = ?').bind('source').first(), {
    target_slug: 'existing-target', target_tmdb_id: 42,
  });
  assert.deepEqual(await db.prepare('SELECT last_success_at, result FROM recommendation_freshness WHERE slug = ?').bind('source').first(), {
    last_success_at: null, result: 'retryable_error',
  });

  const immediate = await runRecommendationRefreshTick(env);
  assert.equal(immediate.due, 0);
});

test('successful refresh preserves resolved targets and ranks new targets', async () => {
  const { db, env } = await setup();
  await db.prepare("INSERT INTO movie (slug, tmdb_id, tmdb_type, tier) VALUES ('local-target', 43, 'movie', 'catalog')").run();
  await db.prepare("INSERT INTO recommendation_freshness (slug, last_success_at, last_attempt_at, result) VALUES ('local-target', ?, ?, 'success')")
    .bind(Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000)).run();
  globalThis.fetch = async () => Response.json({ results: [{ id: 42 }, { id: 43 }] });

  const result = await runRecommendationRefreshTick(env);
  assert.equal(result.refreshed, 1);
  assert.equal(result.validEmpty, 0);
  const rows = await db.prepare(
    'SELECT target_tmdb_id, target_slug, sort_order FROM recommendation WHERE slug = ? ORDER BY sort_order'
  ).bind('source').all();
  assert.deepEqual(rows.results, [
    { target_tmdb_id: 42, target_slug: 'existing-target', sort_order: 0 },
    { target_tmdb_id: 43, target_slug: 'local-target', sort_order: 1 },
  ]);
  assert.equal((await db.prepare('SELECT result FROM recommendation_freshness WHERE slug = ?').bind('source').first()).result, 'success');
});

test('valid empty is explicit success and replaces old edges', async () => {
  const { db, env } = await setup();
  globalThis.fetch = async () => Response.json({ results: [] });

  const result = await runRecommendationRefreshTick(env);
  assert.equal(result.validEmpty, 1);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM recommendation WHERE slug = ?').bind('source').first()).n, 0);
  assert.equal((await db.prepare('SELECT result FROM recommendation_freshness WHERE slug = ?').bind('source').first()).result, 'valid_empty');
});

test('getDueSources: a never-succeeded source past its retry backoff sorts before an expired one', async () => {
  const db = await setupFreshnessOnly();
  const now = Math.floor(Date.now() / 1000);
  await db.batch([
    db.prepare("INSERT INTO movie (slug, tmdb_id, tmdb_type, tier) VALUES ('never-tried', 1, 'movie', 'catalog')"),
    db.prepare("INSERT INTO recommendation_freshness (slug, last_success_at, last_attempt_at, result) VALUES ('never-tried', NULL, ?, 'retryable_error')").bind(now - 1000),
    db.prepare("INSERT INTO movie (slug, tmdb_id, tmdb_type, tier) VALUES ('expired', 2, 'movie', 'catalog')"),
    db.prepare("INSERT INTO recommendation_freshness (slug, last_success_at, last_attempt_at, result) VALUES ('expired', ?, ?, 'success')").bind(now - 1000, now - 1000),
  ]);

  const due = await new RecommendationFreshnessRepository(db).getDueSources(500, 100, 10);
  assert.deepEqual(due.map((d) => d.slug), ['never-tried', 'expired']);
});

test('getDueSources: a never-succeeded source still inside the retry backoff is excluded', async () => {
  const db = await setupFreshnessOnly();
  const now = Math.floor(Date.now() / 1000);
  await db.batch([
    db.prepare("INSERT INTO movie (slug, tmdb_id, tmdb_type, tier) VALUES ('just-tried', 1, 'movie', 'catalog')"),
    db.prepare("INSERT INTO recommendation_freshness (slug, last_success_at, last_attempt_at, result) VALUES ('just-tried', NULL, ?, 'retryable_error')").bind(now),
  ]);

  assert.deepEqual(await new RecommendationFreshnessRepository(db).getDueSources(500, 100, 10), []);
});

test('getDueSources: expired sources sort by last_success_at ascending, and limit is shared across never-succeeded and expired', async () => {
  const db = await setupFreshnessOnly();
  const now = Math.floor(Date.now() / 1000);
  await db.batch([
    db.prepare("INSERT INTO movie (slug, tmdb_id, tmdb_type, tier) VALUES ('never-tried', 1, 'movie', 'catalog')"),
    db.prepare("INSERT INTO recommendation_freshness (slug, last_success_at, last_attempt_at, result) VALUES ('never-tried', NULL, ?, 'retryable_error')").bind(now - 1000),
    db.prepare("INSERT INTO movie (slug, tmdb_id, tmdb_type, tier) VALUES ('older', 2, 'movie', 'catalog')"),
    db.prepare("INSERT INTO recommendation_freshness (slug, last_success_at, last_attempt_at, result) VALUES ('older', ?, ?, 'success')").bind(now - 2000, now - 2000),
    db.prepare("INSERT INTO movie (slug, tmdb_id, tmdb_type, tier) VALUES ('newer', 3, 'movie', 'catalog')"),
    db.prepare("INSERT INTO recommendation_freshness (slug, last_success_at, last_attempt_at, result) VALUES ('newer', ?, ?, 'success')").bind(now - 1500, now - 1500),
  ]);

  // limit=2: the one due never-succeeded source takes a slot, leaving room
  // for only the older (not the newer) of the two expired sources.
  const due = await new RecommendationFreshnessRepository(db).getDueSources(500, 100, 2);
  assert.deepEqual(due.map((d) => d.slug), ['never-tried', 'older']);
});

test('getDueSources: a stub-tier or tmdb-less movie is excluded even with an expired freshness row', async () => {
  const db = await setupFreshnessOnly();
  const now = Math.floor(Date.now() / 1000);
  await db.batch([
    db.prepare("INSERT INTO movie (slug, tmdb_id, tmdb_type, tier) VALUES ('a-stub', 1, 'movie', 'stub')"),
    db.prepare("INSERT INTO recommendation_freshness (slug, last_success_at, last_attempt_at, result) VALUES ('a-stub', ?, ?, 'success')").bind(now - 1000, now - 1000),
    db.prepare("INSERT INTO movie (slug, tmdb_id, tmdb_type, tier) VALUES ('no-tmdb', NULL, NULL, 'catalog')"),
    db.prepare("INSERT INTO recommendation_freshness (slug, last_success_at, last_attempt_at, result) VALUES ('no-tmdb', ?, ?, 'success')").bind(now - 1000, now - 1000),
  ]);

  assert.deepEqual(await new RecommendationFreshnessRepository(db).getDueSources(500, 100, 10), []);
});
