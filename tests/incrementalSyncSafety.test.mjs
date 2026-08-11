import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { runIncrementalSync } from '../src-ssr/services/sync/orchestrator.ts';
import { syncOneMovie } from '../src-ssr/services/sync/syncMovie.ts';

const originalFetch = globalThis.fetch;
const T0 = '2026-08-11T00:00:00.000Z';
const T1 = '2026-08-11T00:10:00.000Z';
const T2 = '2026-08-11T00:09:00.000Z';

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

class SyncStateDb {
  constructor(cursor) {
    this.state = new Map(cursor ? [['cursor:recent', cursor]] : []);
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
      async run() {
        if (!sql.includes('INSERT INTO sync_state')) throw new Error(`Unexpected run(): ${sql}`);
        db.state.set(binds[0], binds[1]);
        return { success: true };
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

function createIncrementalHarness({ cursor = T0, recentPage, shardResponse }) {
  const db = new SyncStateDb(cursor);
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

test('does not advance cursor when a later recent-feed page times out', async () => {
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
  assert.equal(second.result.slugsFound, 3, 'the recovered page and equal-time boundary must be scanned and retried');
  assert.equal(second.result.processed, 3);
  assert.equal(second.result.failed, 0);
  assert.equal(second.result.stopReason, 'empty_page');
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

test('does not advance cursor after reaching the recent-page cap before crossing it', async () => {
  const harness = createIncrementalHarness({
    recentPage: async (page) => {
      if (page <= 21) {
        const minute = 41 - page;
        return [item(`page-${page}`, `2026-08-11T00:${String(minute).padStart(2, '0')}:00.000Z`)];
      }
      return [item('old-cursor', T0)];
    },
    shardResponse: async (slugs) => successfulShard(slugs),
  });

  const result = await harness.tick();
  assert.equal(result.cursorAfter, T0, 'page 21 must remain reachable on a later tick');
});

test('processes an unseen slug at the cursor timestamp boundary', async () => {
  const harness = createIncrementalHarness({
    cursor: T1,
    recentPage: async (page) => page === 1
      ? [item('unseen-but-equal', T1), item('older', T2)]
      : [],
    shardResponse: async (slugs) => successfulShard(slugs),
  });

  const result = await harness.tick();
  assert.equal(result.result.slugsFound, 1);
  assert.deepEqual(harness.dispatched, [{ run: 1, slugs: ['unseen-but-equal'] }]);
});

test('scans all equal-timestamp items even when the feed reorders the boundary', async () => {
  const harness = createIncrementalHarness({
    cursor: JSON.stringify({ time: T1, slug: 'boundary-seen' }),
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
      getHashesBySlugs: async () => new Map(),
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
    movie: { getHashesBySlugs: async () => new Map(), upsertMany: async (rows) => { writes.push(...rows); return rows.length; } },
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
