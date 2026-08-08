import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { Miniflare } from 'miniflare';
import { HeroSnapshotRepository } from '../src-ssr/repositories/heroSnapshotRepository.ts';
import { refreshHeroSnapshot } from '../src-ssr/services/sync/heroSnapshot.ts';
import { KkphimClient } from '../src-ssr/services/sync/kkphimClient.ts';
import { TmdbClient } from '../src-ssr/services/sync/tmdbClient.ts';
import { RateLimiter } from '../src-ssr/services/sync/throttle.ts';

const instances = [];
const originalFetch = globalThis.fetch;
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
    db.prepare(`CREATE TABLE movie (
      slug TEXT PRIMARY KEY, tmdb_id INTEGER, tmdb_type TEXT, tier TEXT,
      type TEXT, has_stream INTEGER, poster_path TEXT
    )`),
    db.prepare('CREATE TABLE sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)'),
    db.prepare(`CREATE TABLE hero_snapshot (
      rank INTEGER PRIMARY KEY CHECK(rank BETWEEN 1 AND 20),
      tmdb_id INTEGER NOT NULL UNIQUE, slug TEXT NOT NULL, refreshed_at INTEGER NOT NULL,
      FOREIGN KEY (slug) REFERENCES movie(slug)
    )`),
  ]);
  const hero = new HeroSnapshotRepository(db);
  const movie = {
    getBySlug: async (slug) => db.prepare('SELECT * FROM movie WHERE slug = ?').bind(slug).first(),
  };
  const synced = [];
  return {
    db,
    hero,
    synced,
    deps: {
      hero,
      movie,
      tmdb: new TmdbClient('test-token', new RateLimiter(100_000)),
      kkphim: new KkphimClient(new RateLimiter(100_000)),
      syncCanonical: async (slug) => {
        synced.push(slug);
        return { outcome: 'unchanged' };
      },
    },
  };
}

async function seedMovie(db, slug, id, overrides = {}) {
  const row = {
    tmdbType: 'movie',
    tier: 'catalog',
    type: 'single',
    hasStream: 1,
    posterPath: `https://image.tmdb.org/t/p/w1280/${slug}.jpg`,
    ...overrides,
  };
  await db
    .prepare('INSERT INTO movie (slug, tmdb_id, tmdb_type, tier, type, has_stream, poster_path) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(slug, id, row.tmdbType, row.tier, row.type, row.hasStream, row.posterPath)
    .run();
}

function kkMovie(id, slug, overrides = {}) {
  const movie = {
    tmdb: { id: String(id), type: 'movie', season: null },
    slug,
    type: 'single',
    ...overrides,
  };
  return {
    status: true,
    movie,
    episodes: [{ server_name: 'VIP', server_data: [{ link_m3u8: 'https://stream.test/master.m3u8', link_embed: '' }] }],
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('uses only the first 20 TMDB results and persists the seven valid KKPhim movies in TMDB rank order', async () => {
  const { db, hero, synced, deps } = await setup();
  for (let id = 1; id <= 7; id++) await seedMovie(db, `film-${id}`, id);
  const lookedUp = [];
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes('/trending/movie/week')) {
      return json({ results: Array.from({ length: 25 }, (_, index) => ({ id: index + 1, media_type: 'movie' })) });
    }
    const id = Number(value.match(/\/tmdb\/movie\/(\d+)/)?.[1]);
    lookedUp.push(id);
    return id <= 7 ? json(kkMovie(id, `film-${id}`)) : json({ status: false }, 404);
  };

  const result = await refreshHeroSnapshot({}, { now: 2_000, dependencies: deps });
  assert.deepEqual(result, {
    skipped: false, keptLastGood: false, fetched: 20, matched: 7, notFound: 13,
    filteredType: 0, filteredNoStream: 0, filteredNoBackdrop: 0, failed: 0, durationMs: result.durationMs,
    tmdbCount: 20, matchedCount: 7, notFoundCount: 13, failedCount: 0,
  });
  assert.deepEqual(lookedUp.sort((a, b) => a - b), Array.from({ length: 20 }, (_, index) => index + 1));
  assert.deepEqual(synced.sort(), Array.from({ length: 7 }, (_, index) => `film-${index + 1}`));
  assert.deepEqual(
    (await db.prepare('SELECT rank, tmdb_id, slug FROM hero_snapshot ORDER BY rank').all()).results,
    Array.from({ length: 7 }, (_, index) => ({ rank: index + 1, tmdb_id: index + 1, slug: `film-${index + 1}` }))
  );
  assert.equal((await hero.getRefreshState()).lastSuccessAt, 2_000);
});

test('rejects non-movie TMDB entries, dedupes duplicate IDs, and keeps the canonical exact-lookup slug', async () => {
  const { db, deps } = await setup();
  await seedMovie(db, 'canonical-one', 1);
  await seedMovie(db, 'canonical-three', 3);
  const lookedUp = [];
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes('/trending/movie/week')) {
      return json({ results: [
        { id: 1, media_type: 'movie' }, { id: 2, media_type: 'tv' },
        { id: 1, media_type: 'movie' }, { id: 3 },
      ] });
    }
    const id = Number(value.match(/\/tmdb\/movie\/(\d+)/)?.[1]);
    lookedUp.push(id);
    return json(kkMovie(id, id === 1 ? 'canonical-one' : 'canonical-three'));
  };

  const result = await refreshHeroSnapshot({}, { now: 3_000, dependencies: deps });
  assert.equal(result.filteredType, 1);
  assert.equal(result.matched, 2);
  assert.deepEqual(lookedUp.sort((a, b) => a - b), [1, 3]);
  assert.deepEqual(
    (await db.prepare('SELECT rank, tmdb_id, slug FROM hero_snapshot ORDER BY rank').all()).results,
    [{ rank: 1, tmdb_id: 1, slug: 'canonical-one' }, { rank: 4, tmdb_id: 3, slug: 'canonical-three' }]
  );
});

test('uses only the exact KKPhim canonical slug when D1 has multiple rows for one TMDB ID', async () => {
  const { db, deps } = await setup();
  await seedMovie(db, 'stale-duplicate', 1);
  await seedMovie(db, 'canonical-exact', 1);
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes('/trending/movie/week')) return json({ results: [{ id: 1, media_type: 'movie' }] });
    return json(kkMovie(1, 'canonical-exact'));
  };

  const result = await refreshHeroSnapshot({}, { now: 3_500, dependencies: deps });
  assert.equal(result.matched, 1);
  assert.deepEqual(
    (await db.prepare('SELECT rank, tmdb_id, slug FROM hero_snapshot').all()).results,
    [{ rank: 1, tmdb_id: 1, slug: 'canonical-exact' }]
  );
});

test('filters non-single, no-stream, and no-backdrop candidates after exact KKPhim lookup', async () => {
  const { db, deps } = await setup();
  await seedMovie(db, 'no-backdrop', 3, { posterPath: 'https://phimimg.com/poster.jpg' });
  await seedMovie(db, 'valid', 4);
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes('/trending/movie/week')) return json({ results: [1, 2, 3, 4].map((id) => ({ id, media_type: 'movie' })) });
    const id = Number(value.match(/\/tmdb\/movie\/(\d+)/)?.[1]);
    if (id === 1) return json(kkMovie(id, 'series', { type: 'series' }));
    if (id === 2) return json({ ...kkMovie(id, 'no-stream'), episodes: [{ server_name: 'VIP', server_data: [{ link_m3u8: '', link_embed: '' }] }] });
    return json(kkMovie(id, id === 3 ? 'no-backdrop' : 'valid'));
  };

  const result = await refreshHeroSnapshot({}, { now: 4_000, dependencies: deps });
  assert.equal(result.matched, 1);
  assert.equal(result.filteredType, 1);
  assert.equal(result.filteredNoStream, 1);
  assert.equal(result.filteredNoBackdrop, 1);
  assert.deepEqual((await db.prepare('SELECT rank, slug FROM hero_snapshot').all()).results, [{ rank: 4, slug: 'valid' }]);
});

test('a KKPhim retryable error records the attempt but keeps the prior snapshot unchanged', async () => {
  const { db, hero, deps } = await setup();
  await seedMovie(db, 'last-good', 99);
  await seedMovie(db, 'candidate-one', 1);
  await hero.replaceSnapshot([{ rank: 9, tmdbId: 99, slug: 'last-good' }], {
    lastSuccessAt: 1_000,
    lastAttemptAt: 1_000,
    result: { tmdbCount: 1, matchedCount: 1, notFoundCount: 0, failedCount: 0 },
  });
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes('/trending/movie/week')) return json({ results: [{ id: 1, media_type: 'movie' }, { id: 2, media_type: 'movie' }] });
    const id = Number(value.match(/\/tmdb\/movie\/(\d+)/)?.[1]);
    return id === 1 ? json(kkMovie(id, 'candidate-one')) : json({ message: 'busy' }, 429);
  };

  const result = await refreshHeroSnapshot({}, { now: 3_000, dependencies: deps });
  assert.equal(result.keptLastGood, true);
  assert.equal(result.failed, 1);
  assert.deepEqual((await db.prepare('SELECT rank, tmdb_id, slug FROM hero_snapshot').all()).results, [{ rank: 9, tmdb_id: 99, slug: 'last-good' }]);
  assert.deepEqual(await hero.getRefreshState(), {
    lastSuccessAt: 1_000,
    lastAttemptAt: 3_000,
    lastResult: { tmdbCount: 2, matchedCount: 1, notFoundCount: 0, failedCount: 1 },
  });
});

test('an invalid TMDB payload keeps the prior snapshot unchanged', async () => {
  const { db, hero, deps } = await setup();
  await seedMovie(db, 'last-good', 99);
  await hero.replaceSnapshot([{ rank: 1, tmdbId: 99, slug: 'last-good' }], {
    lastSuccessAt: 1_000,
    lastAttemptAt: 1_000,
    result: { tmdbCount: 1, matchedCount: 1, notFoundCount: 0, failedCount: 0 },
  });
  globalThis.fetch = async (url) => String(url).includes('/trending/movie/week') ? json({ nope: [] }) : json({ status: false }, 404);

  const result = await refreshHeroSnapshot({}, { now: 3_000, dependencies: deps });
  assert.equal(result.keptLastGood, true);
  assert.equal(result.failed, 1);
  assert.deepEqual((await db.prepare('SELECT rank, slug FROM hero_snapshot').all()).results, [{ rank: 1, slug: 'last-good' }]);
});

test('30-minute success gate makes no upstream request, while force bypasses it', async () => {
  const { db, hero, deps } = await setup();
  await seedMovie(db, 'last-good', 99);
  await hero.replaceSnapshot([{ rank: 1, tmdbId: 99, slug: 'last-good' }], {
    lastSuccessAt: 2_000,
    lastAttemptAt: 2_000,
    result: { tmdbCount: 1, matchedCount: 1, notFoundCount: 0, failedCount: 0 },
  });
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls++;
    assert.match(String(url), /\/trending\/movie\/week/);
    return json({ results: [] });
  };

  const gated = await refreshHeroSnapshot({}, { now: 2_500, dependencies: deps });
  assert.equal(gated.skipped, true);
  assert.equal(calls, 0);
  assert.deepEqual((await db.prepare('SELECT rank, slug FROM hero_snapshot').all()).results, [{ rank: 1, slug: 'last-good' }]);

  const forced = await refreshHeroSnapshot({}, { now: 2_500, force: true, dependencies: deps });
  assert.equal(forced.skipped, false);
  assert.equal(calls, 1);
  assert.deepEqual((await db.prepare('SELECT rank, slug FROM hero_snapshot').all()).results, []);
});
