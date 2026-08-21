import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { afterEach, test } from 'node:test';
import { Miniflare } from 'miniflare';
import { buildHomeData } from '../src-ssr/api/homeData.ts';
import { HeroSnapshotRepository } from '../src-ssr/repositories/heroSnapshotRepository.ts';

// Regression coverage for the "every rail shows the same titles as the
// HeroSlider" bug: every rail used to ORDER BY last_synced (when this
// Worker wrote the row), not the upstream feed's own modified.time. The
// hero snapshot refresh re-syncs ~20 trending titles every 30 minutes and
// their vote_average/vote_count drift often enough to change last_synced
// without the title actually being new upstream, which pushed those
// titles to the top of every other rail too.
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

async function seedMovie(db, { slug, tmdbId, type = 'single', tier = 'catalog', lastSynced, upstreamModified }) {
  await db.prepare(`INSERT INTO movie (
    slug, tmdb_id, tmdb_type, tmdb_season, title, original_title, overview,
    poster_path, thumb_path, poster_host, release_year, runtime, vote_average,
    vote_count, status, episode_current, quality, lang, type, genres_json,
    countries_json, has_stream, stream_count, youtube_trailer_key, tier,
    source_hash, last_synced, actor_json, popularity, upstream_modified
  ) VALUES (?, ?, 'movie', NULL, ?, '', '', ?, ?, 'tmdb', 2026, '', 0, 0, '', '', '', '', ?, '[]', '[]', 1, 1, NULL, ?, ?, ?, '[]', 100, ?)`)
    .bind(
      slug, tmdbId, slug,
      `https://image.tmdb.org/t/p/w1280/${slug}.jpg`, `https://image.tmdb.org/t/p/w500/${slug}.jpg`,
      type, tier, slug, lastSynced, upstreamModified
    )
    .run();
}

test('newMovies/phimLe order by upstream_modified, not last_synced', async () => {
  const { db } = await setup();
  // Hero-drift victim: rewritten most recently by this Worker (last_synced),
  // but its actual upstream update happened long ago.
  await seedMovie(db, { slug: 'hero-drift-victim', tmdbId: 1, lastSynced: 2_000, upstreamModified: 1_000 });
  // Genuinely new upstream, but this Worker synced it earlier in wall-clock
  // terms (e.g. it was the first item processed in an older tick).
  await seedMovie(db, { slug: 'genuinely-new', tmdbId: 2, lastSynced: 1_500, upstreamModified: 3_000 });

  const homeData = await buildHomeData(db);
  assert.deepEqual(homeData.newMovies.items.map((m) => m.slug), ['genuinely-new', 'hero-drift-victim']);
  assert.deepEqual(homeData.phimLe.items.map((m) => m.slug), ['genuinely-new', 'hero-drift-victim']);
});

test('trending always mirrors heroMovies, never the upstream_modified-ordered rails', async () => {
  const { db, hero } = await setup();
  await seedMovie(db, { slug: 'rail-newest', tmdbId: 10, lastSynced: 500, upstreamModified: 5_000 });
  await seedMovie(db, { slug: 'hero-pick', tmdbId: 11, lastSynced: 500, upstreamModified: 100 });
  await hero.replaceSnapshot([{ rank: 1, tmdbId: 11, slug: 'hero-pick' }], {
    lastSuccessAt: 1_800_000_000,
    lastAttemptAt: 1_800_000_000,
    result: { tmdbCount: 20, matchedCount: 1, notFoundCount: 19, failedCount: 0 },
  });

  const homeData = await buildHomeData(db);
  assert.deepEqual(homeData.trending.items.map((m) => m.slug), ['hero-pick']);
  assert.deepEqual(homeData.heroMovies.map((m) => m.slug), ['hero-pick']);
  assert.ok(homeData.newMovies.items.map((m) => m.slug).includes('rail-newest'));
});

test('phimLe/phimBo exclude stub-tier rows (no stream, nothing to watch)', async () => {
  const { db } = await setup();
  await seedMovie(db, { slug: 'real-single', tmdbId: 20, type: 'single', tier: 'catalog', lastSynced: 100, upstreamModified: 100 });
  await seedMovie(db, { slug: 'stub-single', tmdbId: 21, type: 'single', tier: 'stub', lastSynced: 200, upstreamModified: 200 });
  await seedMovie(db, { slug: 'real-series', tmdbId: 22, type: 'series', tier: 'catalog', lastSynced: 100, upstreamModified: 100 });
  await seedMovie(db, { slug: 'stub-series', tmdbId: 23, type: 'series', tier: 'stub', lastSynced: 200, upstreamModified: 200 });

  const homeData = await buildHomeData(db);
  assert.deepEqual(homeData.phimLe.items.map((m) => m.slug), ['real-single']);
  assert.deepEqual(homeData.phimBo.items.map((m) => m.slug), ['real-series']);
});
