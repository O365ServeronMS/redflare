import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { Miniflare } from 'miniflare';

import { TmdbClient } from '../src-ssr/services/sync/tmdbClient.ts';
import { RateLimiter } from '../src-ssr/services/sync/throttle.ts';
import { syncOneMovie } from '../src-ssr/services/sync/syncMovie.ts';
import { runRecommendationResolveTick } from '../src-ssr/services/sync/orchestrator.ts';

const originalFetch = globalThis.fetch;
const instances = [];

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await Promise.all(instances.splice(0).map((mf) => mf.dispose()));
});

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function kkDetail(slug = 'source') {
  return {
    status: true,
    movie: {
      tmdb: { id: '101', type: 'movie', season: null },
      imdb: null,
      modified: { time: '2026-08-10T00:00:00Z' },
      slug,
      name: 'Source',
      origin_name: 'Source',
      content: '',
      type: 'single',
      status: 'completed',
      thumb_url: null,
      poster_url: null,
      trailer_url: null,
      time: '',
      episode_current: 'Full',
      quality: 'HD',
      lang: 'Vietsub',
      year: 2026,
      category: [],
      country: [],
    },
    episodes: [],
  };
}

test('classifies TMDB recommendation success, valid-empty, and retryable failures', async () => {
  const client = new TmdbClient('test-token', new RateLimiter(100_000));
  const cases = [
    [{ results: [{ id: 8 }, { id: 8 }, { id: -1 }, { id: 9 }] }, { kind: 'success', ids: [8, 9] }],
    [{ results: [] }, { kind: 'success', ids: [] }],
    [{ malformed: true }, { kind: 'retryable_error' }],
  ];

  for (const [body, expected] of cases) {
    globalThis.fetch = async () => json(body);
    assert.deepEqual(await client.getRecommendationIds('movie', 101, 15), expected);
  }

  globalThis.fetch = async () => json({ message: 'busy' }, 429);
  assert.deepEqual(await client.getRecommendationIds('movie', 101, 15), { kind: 'retryable_error' });

  globalThis.fetch = async () => {
  globalThis.fetch = async () => json({ message: 'upstream unavailable' }, 500);
  assert.deepEqual(await client.getRecommendationIds('movie', 101, 15), { kind: 'retryable_error' });

    throw new Error('timeout');
  };
  assert.deepEqual(await client.getRecommendationIds('movie', 101, 15), { kind: 'retryable_error' });
});

test('preserves last-good targets when the TMDB recommendation request is retryable', async () => {
  const replaced = [];
  const written = [];
  const repos = {
    movie: {
      getHashesBySlugs: async () => new Map([['source', 'old-hash']]),
      upsertMany: async (rows) => {
        written.push(...rows);
        return 1;
      },
    },
    episode: { replaceForSlug: async () => undefined },
    recommendation: {
      getTargetsForSlug: async () => [
        { targetTmdbId: 701, targetType: 'movie', sortOrder: 0 },
        { targetTmdbId: 702, targetType: 'movie', sortOrder: 1 },
      ],
      replaceTargetsForSlug: async (...args) => replaced.push(args),
    },
    taxonomy: { syncMovieTaxonomy: async () => undefined },
    search: { indexMovie: async () => undefined },
  };
  const clients = {
    kkphim: { getDetail: async () => kkDetail() },
    tmdb: {
      getDetail: async () => null,
      getSeasonDetail: async () => null,
      getRecommendationIds: async () => ({ kind: 'retryable_error' }),
    },
  };

  const result = await syncOneMovie({}, 'source', clients, repos);
  assert.equal(result.outcome, 'written');
  assert.equal(replaced.length, 0);
  assert.deepEqual(
    written[0].movie.recommendationTargets,
    [{ tmdbId: 701, tmdbType: 'movie' }, { tmdbId: 702, tmdbType: 'movie' }]
  );
});

test('replaces targets with an empty list only after a valid TMDB empty result', async () => {
  const replaced = [];
  const repos = {
    movie: {
      getHashesBySlugs: async () => new Map([['source', 'old-hash']]),
      upsertMany: async () => 1,
    },
    episode: { replaceForSlug: async () => undefined },
    recommendation: {
      getTargetsForSlug: async () => {
        throw new Error('must not read last-good targets for a valid empty result');
      },
      replaceTargetsForSlug: async (...args) => replaced.push(args),
    },
    taxonomy: { syncMovieTaxonomy: async () => undefined },
    search: { indexMovie: async () => undefined },
  };
  const clients = {
    kkphim: { getDetail: async () => kkDetail() },
    tmdb: {
      getDetail: async () => null,
      getSeasonDetail: async () => null,
      getRecommendationIds: async () => ({ kind: 'success', ids: [] }),
    },
  };

  const result = await syncOneMovie({}, 'source', clients, repos);
  assert.equal(result.outcome, 'written');
  assert.deepEqual(replaced, [['source', []]]);
});

async function setupResolver(maxStubs = '0') {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok"); } };',
    d1Databases: { DB: crypto.randomUUID() },
  });
  instances.push(mf);
  const db = await mf.getD1Database('DB');
  await db.batch([
    db.prepare('CREATE TABLE movie (slug TEXT PRIMARY KEY, tmdb_id INTEGER, tmdb_type TEXT, tier TEXT)'),
    db.prepare(
      'CREATE TABLE recommendation (slug TEXT NOT NULL, target_slug TEXT, target_tmdb_id INTEGER NOT NULL, target_type TEXT NOT NULL, sort_order INTEGER NOT NULL, resolve_attempted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (slug, target_tmdb_id, target_type))'
    ),
  ]);
  await db.prepare(
    'INSERT INTO recommendation (slug, target_slug, target_tmdb_id, target_type, sort_order) VALUES (?, NULL, ?, ?, 0)'
  ).bind('source', 42, 'movie').run();
  return { db, env: { DB: db, TMDB_API_TOKEN: 'test-token', MAX_STUBS: maxStubs } };
}

async function resolveState(db) {
  return db.prepare('SELECT target_slug, resolve_attempted FROM recommendation WHERE slug = ?').bind('source').first();
}

test('KKPhim retryable failure leaves a recommendation target pending', async () => {
  const { db, env } = await setupResolver();
  globalThis.fetch = async () => json({ message: 'busy' }, 503);

  const result = await runRecommendationResolveTick(env);
  assert.deepEqual(result, {
    groupsSeen: 1, resolvedToExisting: 0, resolvedToStub: 0, overflow: 0, retryable: 1,
  });
  assert.deepEqual(await resolveState(db), { target_slug: null, resolve_attempted: 0 });
});

test('KKPhim confirmed not-found is eligible for overflow when stubs are disabled', async () => {
  const { db, env } = await setupResolver();
  globalThis.fetch = async () => json({ status: false }, 404);

  const result = await runRecommendationResolveTick(env);
  assert.deepEqual(result, {
    groupsSeen: 1, resolvedToExisting: 0, resolvedToStub: 0, overflow: 1, retryable: 0,
  });
  assert.deepEqual(await resolveState(db), { target_slug: null, resolve_attempted: 1 });
});

test('a found KKPhim target is not resolved when its sync fails', async () => {
  const { db, env } = await setupResolver();
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes('/tmdb/movie/42')) return json(kkDetail('target'));
    if (value.includes('/phim/target')) return json({ message: 'busy' }, 503);
    throw new Error('unexpected request: ' + value);
  };

  const result = await runRecommendationResolveTick(env);
  assert.deepEqual(result, {
    groupsSeen: 1, resolvedToExisting: 0, resolvedToStub: 0, overflow: 0, retryable: 1,
  });
  assert.deepEqual(await resolveState(db), { target_slug: null, resolve_attempted: 0 });
});

test('TMDB retryable failure while building a stub leaves the target pending', async () => {
  const { db, env } = await setupResolver('1');
  await db.prepare(
    'INSERT INTO recommendation (slug, target_slug, target_tmdb_id, target_type, sort_order) VALUES (?, NULL, ?, ?, 0)'
  ).bind('second-source', 42, 'movie').run();
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes('phimapi.com')) return json({ status: false }, 404);
    if (value.includes('api.themoviedb.org')) return json({ message: 'busy' }, 503);
    throw new Error('unexpected request: ' + value);
  };

  const result = await runRecommendationResolveTick(env);
  assert.deepEqual(result, {
    groupsSeen: 1, resolvedToExisting: 0, resolvedToStub: 0, overflow: 0, retryable: 1,
  });
  assert.deepEqual(await resolveState(db), { target_slug: null, resolve_attempted: 0 });
});

