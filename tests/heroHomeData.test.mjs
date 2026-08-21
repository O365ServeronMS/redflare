import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { afterEach, test } from 'node:test';
import { Miniflare } from 'miniflare';
import { buildHomeData } from '../src-ssr/api/homeData.ts';
import { HeroSnapshotRepository } from '../src-ssr/repositories/heroSnapshotRepository.ts';
import { syncRoute } from '../src-ssr/routes/sync.ts';

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
  for (const name of ['0005_ssr_schema.sql', '0008_recommendation_resolve.sql', '0009_actor_popularity.sql', '0010_hero_snapshot.sql', '0014_upstream_modified.sql']) {
    const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
    const statements = sql
      .replaceAll(/--.*$/gm, '')
      .split(';')
      .map((statement) => statement.trim())
      .filter(Boolean)
      .map((statement) => db.prepare(statement));
    await db.batch(statements);
  }
  return { db, hero: new HeroSnapshotRepository(db) };
}

async function seedMovie(db, slug, tmdbId, popularity) {
  await db.prepare(`INSERT INTO movie (
    slug, tmdb_id, tmdb_type, tmdb_season, title, original_title, overview,
    poster_path, thumb_path, poster_host, release_year, runtime, vote_average,
    vote_count, status, episode_current, quality, lang, type, genres_json,
    countries_json, has_stream, stream_count, youtube_trailer_key, tier,
    source_hash, last_synced, actor_json, popularity
  ) VALUES (?, ?, 'movie', NULL, ?, '', '', ?, ?, 'tmdb', 2026, '', 0, 0, '', '', '', '', 'single', '[]', '[]', 1, 1, NULL, 'catalog', ?, 100, '[]', ?)`)
    .bind(slug, tmdbId, slug, `https://image.tmdb.org/t/p/w1280/${slug}.jpg`, `https://image.tmdb.org/t/p/w500/${slug}.jpg`, slug, popularity)
    .run();
}

test('home-data reads Hero and Trending only from the weekly ranked snapshot', async () => {
  const { db, hero } = await setup();
  await seedMovie(db, 'ranked-weekly-movie', 101, 1);
  await seedMovie(db, 'popular-but-not-snapshot', 202, 99_999);
  await hero.replaceSnapshot([{ rank: 8, tmdbId: 101, slug: 'ranked-weekly-movie' }], {
    lastSuccessAt: 1_800_000_000,
    lastAttemptAt: 1_800_000_000,
    result: { tmdbCount: 20, matchedCount: 1, notFoundCount: 19, failedCount: 0 },
  });

  const homeData = await buildHomeData(db);
  assert.deepEqual(homeData.heroMovies.map((movie) => movie.slug), ['ranked-weekly-movie']);
  assert.deepEqual(homeData.trending.items.map((movie) => movie.slug), ['ranked-weekly-movie']);

  await hero.replaceSnapshot([], {
    lastSuccessAt: 1_800_001_800,
    lastAttemptAt: 1_800_001_800,
    result: { tmdbCount: 20, matchedCount: 0, notFoundCount: 20, failedCount: 0 },
  });
  const emptyHomeData = await buildHomeData(db);
  assert.deepEqual(emptyHomeData.heroMovies, []);
  assert.deepEqual(emptyHomeData.trending.items, []);
});

test('home-data caps Trending at 12 while preserving TMDB weekly order', async () => {
  const { db, hero } = await setup();
  const rows = [];
  for (let index = 1; index <= 13; index++) {
    const slug = `weekly-${index}`;
    await seedMovie(db, slug, 1_000 + index, 100_000 - index);
    rows.push({ rank: index, tmdbId: 1_000 + index, slug });
  }
  await seedMovie(db, 'popular-but-not-weekly', 9_999, 999_999);
  await hero.replaceSnapshot(rows, {
    lastSuccessAt: 1_800_000_000,
    lastAttemptAt: 1_800_000_000,
    result: { tmdbCount: 20, matchedCount: 13, notFoundCount: 7, failedCount: 0 },
  });

  const homeData = await buildHomeData(db);
  assert.deepEqual(
    homeData.trending.items.map((movie) => movie.slug),
    Array.from({ length: 12 }, (_, index) => `weekly-${index + 1}`)
  );
  assert.equal(homeData.heroMovies.length, 13);
});

test('Hero ops routes remain CRON_KEY-gated and status exposes only refresh metadata', async () => {
  const { db, hero } = await setup();
  const now = Math.floor(Date.now() / 1000);
  await hero.replaceSnapshot([], {
    lastSuccessAt: now,
    lastAttemptAt: now,
    result: { tmdbCount: 20, matchedCount: 0, notFoundCount: 20, failedCount: 0 },
  });
  const env = { DB: db, CRON_KEY: 'test-cron-key', BACKFILL_MODE: 'burst', MAX_STUBS: '0' };

  const denied = await syncRoute.fetch(new Request('https://worker.test/__sync/refresh-hero', { method: 'POST' }), env);
  assert.equal(denied.status, 404);
  assert.equal(denied.headers.get('cache-control'), 'private, no-store');

  const refresh = await syncRoute.fetch(new Request('https://worker.test/__sync/refresh-hero', {
    method: 'POST', headers: { 'x-cron-key': 'test-cron-key' },
  }), env);
  assert.equal(refresh.status, 200);
  assert.equal((await refresh.json()).skipped, true);

  const status = await syncRoute.fetch(new Request('https://worker.test/__sync/status', {
    headers: { 'x-cron-key': 'test-cron-key' },
  }), env);
  const body = await status.json();
  assert.deepEqual(body.hero, {
    lastSuccessAt: now,
    lastAttemptAt: now,
    matchedCount: 0,
    readSource: 'snapshot',
    snapshotAgeSeconds: body.hero.snapshotAgeSeconds,
  });
  assert.ok(body.hero.snapshotAgeSeconds >= 0);
});
