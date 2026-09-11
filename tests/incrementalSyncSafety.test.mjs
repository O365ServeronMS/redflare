import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { runIncrementalSync } from '../src-ssr/services/sync/orchestrator.ts';
import { syncOneMovie } from '../src-ssr/services/sync/syncMovie.ts';
import { hashMovie } from '../src-ssr/services/sync/hash.ts';
import { normalizeMovie } from '../src-ssr/services/sync/normalize.ts';

const originalFetch = globalThis.fetch;
const T0 = '2026-08-11T00:00:00.000Z';
const T1 = '2026-08-11T00:10:00.000Z';
const T2 = '2026-08-11T00:09:00.000Z';

const seconds = (iso) => Math.floor(Date.parse(iso) / 1000);

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function item(slug, time) {
  return { slug, modified: { time } };
}

/** Mock env.DB. Backs sync_state (cursor + recent:last_run) in `state`,
 * and the subset of `movie` the clock-free scan reads -- `known` maps slug
 * -> the upstream_modified (epoch seconds) a getSyncMarkersBySlugs lookup
 * should report for it. A slug absent from `known` reads as "not synced
 * yet" and is a scan candidate. */
class MockDb {
  constructor({ cursor, known = {} } = {}) {
    this.state = new Map(cursor ? [['cursor:recent', cursor]] : []);
    this.movies = new Map(
      Object.entries(known).map(([slug, v]) => [
        slug,
        typeof v === 'object' ? v : { source_hash: 'known-hash', upstream_modified: v },
      ])
    );
  }

  prepare(sql) {
    let binds = [];
    const db = this;
    return {
      bind(...values) {
        binds = values;
        return this;
      },
      async first() {
        if (!sql.includes('SELECT value FROM sync_state')) throw new Error(`Unexpected first(): ${sql}`);
        const value = db.state.get(binds[0]);
        return value === undefined ? null : { value };
      },
      async all() {
        if (!sql.includes('source_hash, upstream_modified FROM movie WHERE slug IN')) {
          throw new Error(`Unexpected all(): ${sql}`);
        }
        return {
          results: binds
            .filter((slug) => db.movies.has(slug))
            .map((slug) => ({ slug, ...db.movies.get(slug) })),
        };
      },
      async run() {
        if (sql.includes('INSERT INTO sync_state')) {
          db.state.set(binds[0], binds[1]);
          return { success: true };
        }
        if (sql.includes('UPDATE movie SET upstream_modified')) {
          db.movies.set(binds[1], { source_hash: 'known-hash', upstream_modified: binds[0] });
          return { success: true };
        }
        throw new Error(`Unexpected run(): ${sql}`);
      },
    };
  }
}

function successfulShard(slugs) {
  return {
    processed: slugs.length,
    written: slugs.length,
    unchanged: 0,
    errors: 0,
    rowsWritten: slugs.length,
    governed: false,
  };
}

function createIncrementalHarness({ cursor = T0, recentPage, shardResponse, known = {}, cap }) {
  const db = new MockDb({ cursor, known });
  const requestedPages = [];
  const dispatched = [];
  let run = 0;

  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname !== 'phimapi.com') throw new Error(`Unexpected fetch: ${url}`);
    const page = Number(url.searchParams.get('page'));
    requestedPages.push({ run, page });
    const value = await recentPage(page, run);
    if (value instanceof Error) throw value;
    if (value instanceof Response) return value;
    return json({ status: true, items: value });
  };

  const env = {
    DB: db,
    BACKFILL_MODE: 'burst',
    CRON_KEY: 'test-only',
    TMDB_API_TOKEN: '',
    ...(cap === undefined ? {} : { RECENT_PAGE_CAP: cap }),
    SELF: {
      async fetch(_url, init) {
        const slugs = JSON.parse(init.body).slugs;
        dispatched.push({ run, slugs });
        const value = await shardResponse(slugs, run);
        return value instanceof Response ? value : json(value);
      },
    },
  };

  return {
    state: db.state,
    requestedPages,
    dispatched,
    async tick() {
      run++;
      const cursorBefore = db.state.get('cursor:recent') ?? null;
      const result = await runIncrementalSync(env);
      return {
        cursorBefore,
        cursorAfter: db.state.get('cursor:recent') ?? null,
        result,
      };
    },
  };
}

test('holds the cursor when a later recent-feed page times out, then catches up next tick', async () => {
  const harness = createIncrementalHarness({
    recentPage: async (page, run) => {
      if (page === 1) return [item('new-page-1', T1)];
      if (page === 2 && run === 1) return new Error('timeout');
      if (page === 2) return [item('older-never-seen', T2), item('old-cursor', T0)];
      return [];
    },
    shardResponse: async (slugs) => successfulShard(slugs),
  });

  const first = await harness.tick();
  assert.equal(first.cursorAfter, T0, 'a failed discovery page must hold the old cursor');
  assert.equal(first.result.fetched, 1);
  assert.equal(first.result.pagesScanned, 2);
  assert.equal(first.result.stopReason, 'upstream_error');
  assert.equal(first.result.failed, 1);
  assert.equal(JSON.parse(harness.state.get('recent:last_run')).stopReason, 'upstream_error');

  const second = await harness.tick();
  // Nothing was persisted last tick (the shard is mocked), so the whole
  // window is re-scanned and everything on it synced -- a failed page is a
  // delay, never a skipped title.
  assert.equal(second.result.slugsFound, 3);
  assert.equal(second.result.processed, 3);
  assert.equal(second.result.failed, 0);
  assert.equal(second.result.stopReason, 'empty_page');
  assert.notEqual(second.cursorAfter, T0, 'a clean full pass advances the diagnostic cursor');
  assert.deepEqual(harness.requestedPages, [
    { run: 1, page: 1 }, { run: 1, page: 2 },
    { run: 2, page: 1 }, { run: 2, page: 2 }, { run: 2, page: 3 },
  ]);
});

test('reports a clean empty feed without moving the cursor', async () => {
  const harness = createIncrementalHarness({
    recentPage: async () => [],
    shardResponse: async (slugs) => successfulShard(slugs),
  });

  const result = await harness.tick();
  assert.equal(result.result.slugsFound, 0);
  assert.equal(result.result.fetched, 0);
  assert.equal(result.result.pagesScanned, 1);
  assert.equal(result.result.stopReason, 'empty_page');
  assert.equal(result.cursorAfter, T0);
});

test('does not advance cursor when any slug in a shard fails', async () => {
  const harness = createIncrementalHarness({
    recentPage: async (page) => page === 1
      ? [item('good', T1), item('failed', T2), item('old-cursor', T0)]
      : [],
    shardResponse: async (slugs, run) => {
      if (run === 1 && slugs.includes('failed')) {
        return { ...successfulShard(slugs), written: 0, errors: 1, rowsWritten: 0 };
      }
      return successfulShard(slugs);
    },
  });

  const first = await harness.tick();
  assert.equal(first.cursorAfter, T0, 'a shard error must hold the old cursor');

  const second = await harness.tick();
  assert.equal(second.result.slugsFound, 3, 'the failed slug and equal-time boundary must be retried next tick');
});

test('does not advance cursor when SELF returns non-2xx or malformed shard JSON', async (t) => {
  await t.test('non-2xx response', async () => {
    const harness = createIncrementalHarness({
      recentPage: async (page) => page === 1
        ? [item('self-failed', T1), item('old-cursor', T0)]
        : [],
      shardResponse: async () => new Response('unauthorized', { status: 401 }),
    });

    const result = await harness.tick();
    assert.equal(result.cursorAfter, T0);
  });

  await t.test('valid JSON with wrong schema', async () => {
    const harness = createIncrementalHarness({
      recentPage: async (page) => page === 1
        ? [item('not-processed', T1), item('old-cursor', T0)]
        : [],
      shardResponse: async () => ({ error: 'wrong shape' }),
    });

    const result = await harness.tick();
    assert.equal(result.cursorAfter, T0);
  });
});

test('does not advance cursor when shard processed count is short', async () => {
  const harness = createIncrementalHarness({
    recentPage: async (page) => page === 1
      ? [item('not-processed', T1), item('old-cursor', T0)]
      : [],
    shardResponse: async () => ({
      processed: 0,
      written: 0,
      unchanged: 0,
      errors: 0,
      rowsWritten: 0,
      governed: false,
    }),
  });

  const result = await harness.tick();
  assert.equal(result.cursorAfter, T0);
});

test('RECENT_PAGE_CAP bounds the scan and holds the cursor when no page comes back fully known', async () => {
  const harness = createIncrementalHarness({
    cap: '3',
    recentPage: async (page) => [item(`page-${page}`, `2026-08-11T00:${String(40 - page).padStart(2, '0')}:00.000Z`)],
    shardResponse: async (slugs) => successfulShard(slugs),
  });

  const result = await harness.tick();
  assert.equal(result.result.pagesScanned, 3, 'stops at the cap');
  assert.equal(result.result.stopReason, 'page_limit');
  assert.equal(result.cursorAfter, T0, 'an incomplete scan does not advance the cursor');
  assert.deepEqual(harness.requestedPages, [
    { run: 1, page: 1 }, { run: 1, page: 2 }, { run: 1, page: 3 },
  ]);
});

test('an out-of-range RECENT_PAGE_CAP is clamped to the [1, 40] range', async () => {
  const harness = createIncrementalHarness({
    cap: '0', // below the floor -> clamped up to 1
    recentPage: async (page) => [item(`page-${page}`, `2026-08-11T00:0${page}:00.000Z`)],
    shardResponse: async (slugs) => successfulShard(slugs),
  });

  const result = await harness.tick();
  assert.equal(result.result.pagesScanned, 1);
  assert.equal(result.result.stopReason, 'page_limit');
});

test('syncs a not-yet-known slug that shares a timestamp with an already-known one', async () => {
  const harness = createIncrementalHarness({
    // 'older' is already held at exactly its feed timestamp -> skipped.
    // 'unseen-but-equal' is not in D1 -> a candidate, regardless of when.
    known: { older: seconds(T2) },
    recentPage: async (page) => page === 1
      ? [item('unseen-but-equal', T1), item('older', T2)]
      : [],
    shardResponse: async (slugs) => successfulShard(slugs),
  });

  const result = await harness.tick();
  assert.equal(result.result.slugsFound, 1);
  assert.deepEqual(harness.dispatched, [{ run: 1, slugs: ['unseen-but-equal'] }]);
});

test('picks up newly inserted equal-timestamp items across a reordered page boundary', async () => {
  const harness = createIncrementalHarness({
    cursor: JSON.stringify({ time: T1, slug: 'boundary-seen' }),
    known: { 'boundary-seen': seconds(T1), older: seconds(T2) },
    recentPage: async (page) => {
      if (page === 1) return [item('boundary-seen', T1), item('new-equal-1', T1)];
      if (page === 2) return [item('older', T2), item('new-equal-2', T1)];
      return [];
    },
    shardResponse: async (slugs) => successfulShard(slugs),
  });

  const result = await harness.tick();
  assert.equal(result.result.slugsFound, 2);
  assert.deepEqual(harness.dispatched, [
    { run: 1, slugs: ['new-equal-1'] },
    { run: 1, slugs: ['new-equal-2'] },
  ]);
  assert.deepEqual(JSON.parse(result.cursorAfter), { time: T1, slug: 'new-equal-2' });
});

function kkDetail(slug) {
  return {
    status: true,
    movie: {
      tmdb: null,
      imdb: null,
      modified: { time: T1 },
      slug,
      name: slug,
      origin_name: slug,
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

test('reconciles a feed alias to the canonical detail slug', async () => {
  const writes = [];
  const repos = {
    movie: {
      getSyncMarkersBySlugs: async () => new Map(),
      upsertMany: async (rows) => {
        writes.push(...rows);
        return 1;
      },
    },
    episode: { replaceForSlug: async () => undefined },
    recommendation: { getTargetsForSlug: async () => [], replaceTargetsForSlug: async () => undefined },
    taxonomy: { syncMovieTaxonomy: async () => undefined },
    search: { indexMovie: async () => undefined },
    tmdbOverride: { getBySlug: async () => null },
  };
  const clients = {
    kkphim: { getDetail: async () => kkDetail('upstream-renamed-slug') },
    tmdb: {
      getDetail: async () => null,
      getSeasonDetail: async () => null,
      getRecommendationIds: async () => ({ kind: 'success', ids: [] }),
    },
  };

  const result = await syncOneMovie({}, 'feed-slug', clients, repos);
  assert.equal(result.outcome, 'written');
  assert.equal(result.slug, 'upstream-renamed-slug');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].movie.slug, 'upstream-renamed-slug');
});

test('keeps rejecting a second canonical-slug mismatch', async () => {
  const writes = [];
  const repos = {
    movie: { getSyncMarkersBySlugs: async () => new Map(), upsertMany: async (rows) => { writes.push(...rows); return rows.length; } },
    episode: { replaceForSlug: async () => undefined },
    recommendation: { getTargetsForSlug: async () => [], replaceTargetsForSlug: async () => undefined },
    taxonomy: { syncMovieTaxonomy: async () => undefined },
    search: { indexMovie: async () => undefined },
    tmdbOverride: { getBySlug: async () => null },
  };
  let calls = 0;
  const clients = {
    kkphim: { getDetail: async () => kkDetail(calls++ === 0 ? 'canonical-slug' : 'still-wrong-slug') },
    tmdb: {
      getDetail: async () => null,
      getSeasonDetail: async () => null,
      getRecommendationIds: async () => ({ kind: 'success', ids: [] }),
    },
  };

  const result = await syncOneMovie({}, 'feed-slug', clients, repos);
  assert.equal(result.outcome, 'error');
  assert.equal(writes.length, 0);
});

// ---- Phase 2: clock-free scan (docs/plan-incremental-sync-stall.md) ----

test('walks a multi-page backlog and stops at the first fully-known page', async () => {
  const known = { 'known-a': seconds(T0), 'known-b': seconds(T2) };
  const harness = createIncrementalHarness({
    recentPage: async (page) => {
      if (page <= 7) return [item(`backlog-${page}`, `2026-08-11T00:${String(20 - page).padStart(2, '0')}:00.000Z`)];
      if (page === 8) return [item('known-a', T0), item('known-b', T2)];
      return [];
    },
    known,
    shardResponse: async (slugs) => successfulShard(slugs),
  });

  const result = await harness.tick();
  assert.equal(result.result.pagesScanned, 8, 'scans the 7 backlog pages plus the known one that stops it');
  assert.equal(result.result.slugsFound, 7);
  assert.equal(result.result.stopReason, 'known_page');
  assert.notEqual(result.cursorAfter, T0);
});

test('a fully-known page 1 costs one fetch and zero candidates', async () => {
  const harness = createIncrementalHarness({
    known: { 'have-1': seconds(T1), 'have-2': seconds(T2) },
    recentPage: async (page) => (page === 1 ? [item('have-1', T1), item('have-2', T2)] : []),
    shardResponse: async (slugs) => successfulShard(slugs),
  });

  const result = await harness.tick();
  assert.equal(result.result.slugsFound, 0);
  assert.equal(result.result.pagesScanned, 1);
  assert.equal(result.result.stopReason, 'known_page');
  assert.deepEqual(harness.requestedPages, [{ run: 1, page: 1 }]);
  assert.deepEqual(harness.dispatched, []);
});

test('finds a new slug whose feed timestamp is skewed ahead of a real-UTC cursor (F3)', async () => {
  // KKPhim can label a modified.time +07 as Z, so the feed item looks
  // hours "newer" than a cursor written in real UTC. The scan never
  // compares the two -- it only asks "is this slug already in D1 at this
  // exact timestamp?" -- so the skew is a non-issue.
  const skewedAhead = '2026-08-11T07:05:00.000Z';
  const harness = createIncrementalHarness({
    cursor: JSON.stringify({ time: T1, slug: 'whatever' }),
    known: { 'already-have': seconds(skewedAhead) },
    recentPage: async (page) => (page === 1
      ? [item('brand-new', skewedAhead), item('already-have', skewedAhead)]
      : []),
    shardResponse: async (slugs) => successfulShard(slugs),
  });

  const result = await harness.tick();
  assert.equal(result.result.slugsFound, 1);
  assert.deepEqual(harness.dispatched, [{ run: 1, slugs: ['brand-new'] }]);
});

test('syncOneMovie bumps upstream_modified alone when only modified.time moved (F4)', async () => {
  const detail = kkDetail('catch-up-slug');
  const expectedHash = hashMovie(normalizeMovie(detail, null, null, [], null));
  const feedSeconds = seconds(detail.movie.modified.time);
  const bumped = [];

  const baseRepos = () => ({
    episode: { replaceForSlug: async () => { throw new Error('must not touch episodes'); } },
    recommendation: { getTargetsForSlug: async () => [], replaceTargetsForSlug: async () => undefined },
    taxonomy: { syncMovieTaxonomy: async () => { throw new Error('must not touch taxonomy'); } },
    search: { indexMovie: async () => { throw new Error('must not reindex'); } },
    tmdbOverride: { getBySlug: async () => null },
  });
  const clients = {
    kkphim: { getDetail: async () => kkDetail('catch-up-slug') },
    tmdb: { getDetail: async () => null, getSeasonDetail: async () => null, getRecommendationIds: async () => ({ kind: 'success', ids: [] }) },
  };

  // Hash unchanged, stored upstream_modified is stale -> one targeted UPDATE.
  const moved = await syncOneMovie({}, 'catch-up-slug', clients, {
    ...baseRepos(),
    movie: {
      getSyncMarkersBySlugs: async () => new Map([['catch-up-slug', { sourceHash: expectedHash, upstreamModified: 100 }]]),
      setUpstreamModified: async (slug, at) => bumped.push([slug, at]),
      upsertMany: async () => { throw new Error('must not upsert'); },
    },
  });
  assert.deepEqual(moved, { slug: 'catch-up-slug', outcome: 'unchanged', rowsWritten: 1 });
  assert.deepEqual(bumped, [['catch-up-slug', feedSeconds]]);

  // Hash unchanged AND upstream_modified already current -> pure no-op.
  const noop = await syncOneMovie({}, 'catch-up-slug', clients, {
    ...baseRepos(),
    movie: {
      getSyncMarkersBySlugs: async () => new Map([['catch-up-slug', { sourceHash: expectedHash, upstreamModified: feedSeconds }]]),
      setUpstreamModified: async () => { throw new Error('must not bump'); },
      upsertMany: async () => { throw new Error('must not upsert'); },
    },
  });
  assert.deepEqual(noop, { slug: 'catch-up-slug', outcome: 'unchanged', rowsWritten: 0 });
});
