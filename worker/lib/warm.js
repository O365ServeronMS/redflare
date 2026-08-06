// warm.js — pre-builds a bounded set of list/genre/country page-1 responses
// into KV every 30 minutes (ADR-0001 Phase 4), so a real request for one of
// these pages never pays for a live KKPhim+TMDB build. worker/index.js's
// warmKvLookup() (Phase 3) is the read side of this; this file is the write
// side — read that function's comment first if you haven't.
//
// SHARDED, same reason and same mechanism as worker/lib/home.js: building
// all 12 targets in one Worker invocation would mean up to 12 × (1 KKPhim +
// up to 24 TMDB enrich) subrequests — hundreds, nowhere close to the free
// plan's 50/invocation cap. So each target gets its OWN invocation
// (/__cron/warm-shard/:n via the SELF service binding, exactly like
// home.js's /__cron/shard/:n — see that file's comment for why a plain
// fetch() to this Worker's own hostname can't be used instead), and the
// orchestrator below just calls all 12 sequentially and collects their
// small {status} responses — its own subrequest count is 12 (one per shard
// call), not 12×25.
//
// PER-KEY last-known-good, not all-or-nothing: unlike runHomeRefresh (which
// aborts the WHOLE home-data build rather than risk overwriting good data
// with a partial one), each warm target here is an independent KV key, so a
// single failed shard (e.g. KKPhim 500s for one genre) just leaves THAT
// key's previous value untouched — the other 11 still refresh normally.
// There is no shared payload to corrupt, so there's no reason to couple
// their fates the way home-data's 5 shards are coupled.
//
// Self-contained on purpose (duplicates a few lines of worker/index.js's
// buildEnrichedList/mapListPayloadImages) — worker/lib/*.js modules never
// import from worker/index.js, only the reverse; home.js already follows
// this same rule for the same KKPhim-fetch-and-enrich shape. If that shape
// ever changes in index.js, mirror the change here too.
//
// Catalog source was OPhim through 2026-08-06; this file was authored
// against a caching-topology branch that started before the OPhim ->
// KKPhim source swap (docs/plan-kkphim-migration.md) landed elsewhere in
// the Worker, so it needed the identical KKPHIM_BASE/fetchCatalogJson
// treatment applied to worker/index.js, worker/lib/home.js, and
// worker/lib/recommendation.js to avoid shipping a warm cron that
// permanently 500s against a dead catalog.

import { createEnrich } from './enrich.js';
import { mapItemsImages } from './images.js';

const KKPHIM_BASE = 'https://phimapi.com';
export const KV_WARM_PREFIX = 'page:v1:';

// Warm-set SIZE stays fixed at 12 (ADR-0001's KV-write-budget arithmetic —
// 12 pages + 1 meta key = 13 slots at */30 cadence, ~76% of the 1,000
// writes/day free-plan cap; see that ADR's "Trade-off analysis" for the
// numbers). What changed in plan-hit-rate.md Phase 4 is WHICH 12 —
// previously a static guess (ADR-0001 Action Item 5), now ranked by real
// sampled traffic (worker/index.js `popularity` table / trackPopularity).
export const WARM_SET_SIZE = 12;

// Builds the page:v1:* key the SAME way worker/index.js's canonicalCacheKey
// builds it for a real request with these params — MUST stay in lockstep
// with CACHE_PARAMS_BY_PATH there (param names AND order: URLSearchParams
// preserves insertion order in .toString()). A drift here means
// warmKvLookup() never finds what this file writes.
function pageKey(pathname, params) {
  const sp = new URLSearchParams();
  for (const [k, v] of params) sp.set(k, v);
  return `${pathname}?${sp.toString()}`;
}

// Original placeholder set (ADR-0001 Action Item 5, before real traffic data
// existed) — kept as a SEED/fallback, not the primary source anymore. Used
// by getTopWarmTargets to fill slots real popularity data hasn't reached
// yet. Without this fallback, a fresh deploy (empty `popularity` table)
// would instantly evict every currently-warm page via the Phase 4 LRU
// cleanup below while sampled data accumulates — a regression far worse
// than the stale-intuition problem this phase exists to fix. A seed entry
// is displaced automatically once real popularity data outranks it (see
// getTopWarmTargets — real rows always sort ahead of seed filler).
const SEED_LIST_TYPES = ['phim-moi-cap-nhat', 'phim-le', 'phim-bo', 'hoat-hinh', 'tv-shows'];
const SEED_GENRE_SLUGS = ['chinh-kich', 'phieu-luu', 'hanh-dong', 'vien-tuong'];
const SEED_COUNTRY_SLUGS = ['au-my', 'trung-quoc', 'han-quoc'];

const SEED_TARGETS = [
  ...SEED_LIST_TYPES.map((type) => pageKey('/api/list', [['type', type], ['page', '1']])),
  ...SEED_GENRE_SLUGS.map((slug) => pageKey('/api/genre', [['slug', slug], ['page', '1']])),
  ...SEED_COUNTRY_SLUGS.map((slug) => pageKey('/api/country', [['slug', slug], ['page', '1']])),
];

// Reconstructs a KKPhim upstream URL from a canonical cache key (the same
// string worker/index.js's canonicalCacheKey() produces) — the general
// counterpart to worker/index.js's localBuilder, needed now that warm
// targets come from real traffic (any page number, any slug) instead of a
// fixed list. Self-contained on purpose, same as the rest of this file (see
// module comment) — mirrors localBuilder's list/genre/country branches only
// (movie/search are never warmable, see worker/index.js KV_WARM_PATHS).
function upstreamForCacheKey(cacheKey) {
  const qIdx = cacheKey.indexOf('?');
  const pathname = qIdx === -1 ? cacheKey : cacheKey.slice(0, qIdx);
  const params = new URLSearchParams(qIdx === -1 ? '' : cacheKey.slice(qIdx + 1));
  const page = params.get('page') || '1';

  if (pathname === '/api/list') {
    const type = params.get('type') || '';
    if (!type) return null;
    return type === 'phim-moi-cap-nhat'
      ? `${KKPHIM_BASE}/danh-sach/phim-moi-cap-nhat?page=${page}`
      : `${KKPHIM_BASE}/v1/api/danh-sach/${type}?page=${page}`;
  }
  if (pathname === '/api/genre') {
    const slug = params.get('slug') || '';
    return slug ? `${KKPHIM_BASE}/v1/api/the-loai/${slug}?page=${page}` : null;
  }
  if (pathname === '/api/country') {
    const slug = params.get('slug') || '';
    return slug ? `${KKPHIM_BASE}/v1/api/quoc-gia/${slug}?page=${page}` : null;
  }
  return null;
}

// Ranks D1 `popularity` DESC by (sampled) hit count, then fills any
// remaining slots from SEED_TARGETS (skipping duplicates) — see the module
// comment on SEED_TARGETS for why the fallback exists. Called independently
// by each shard invocation (to pick its own index `n`) AND once by the
// orchestrator (for LRU eviction) — no state threading between them, same
// "each invocation is self-sufficient" shape as the rest of this pattern.
// A popularity row that changes rank between two calls a few seconds apart
// is a non-issue: the next 30-minute cycle re-ranks from scratch regardless.
async function getTopWarmTargets(env, limit) {
  let ranked = [];
  try {
    const { results } = await env.DB.prepare(
      'SELECT path FROM popularity ORDER BY hits DESC, last_seen DESC LIMIT ?1'
    )
      .bind(limit)
      .all();
    ranked = (results || []).map((r) => r.path);
  } catch (e) {
    console.error('[warm popularity]', e.message);
  }
  const seen = new Set(ranked);
  for (const seed of SEED_TARGETS) {
    if (ranked.length >= limit) break;
    if (!seen.has(seed)) {
      ranked.push(seed);
      seen.add(seed);
    }
  }
  return ranked.slice(0, limit);
}

function httpError(message, status) {
  return Object.assign(new Error(message), { status });
}

async function fetchCatalogJson(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': 'redflare-worker/1.0 (+phim.bluesia.net)' },
  });
  if (!res.ok) throw httpError(`KKPhim upstream ${res.status}`, res.status);
  return res.json();
}

// Mirrors worker/index.js's buildEnrichedList + mapListPayloadImages exactly
// — the KV value this writes must be byte-for-byte the same SHAPE a live
// build's response body would be, since warmKvLookup() in index.js returns
// it to the client unprocessed.
async function buildListPayload(env, upstreamUrl) {
  const enrich = createEnrich(env);
  const data = await fetchCatalogJson(upstreamUrl);
  await enrich.enrichListPayload(data);
  const d = data?.data || data;
  if (d?.items?.length) {
    d.items = mapItemsImages(d.items);
    if (data.data) data.data.items = d.items;
    else data.items = d.items;
  }
  return data;
}

// One target, one invocation (called via /__cron/warm-shard/:n). Never
// throws — a build failure is reported IN the returned status, not as an
// HTTP error, so the orchestrator's sequential loop below just moves on to
// the next target instead of aborting the whole warm cycle over one bad
// shard. `items` is included on success so the caller (worker/index.js,
// which owns ctx.waitUntil) can enqueue the page's artwork for R2 mirroring
// — same side effect every other build path already has, just orchestrated
// one layer up here since this file has no ExecutionContext of its own.
export async function runWarmShard(env, n) {
  const targets = await getTopWarmTargets(env, WARM_SET_SIZE);
  const target = targets[n];
  if (!target) return { status: 'not-found' };
  const upstream = upstreamForCacheKey(target);
  if (!upstream) {
    console.error('[warm shard]', n, target, 'unrecognized cache key');
    return { key: target, status: 'failed', error: 'unrecognized cache key' };
  }
  const kvKey = KV_WARM_PREFIX + target;
  try {
    const payload = await buildListPayload(env, upstream);
    const body = JSON.stringify(payload);
    const d = payload?.data || payload;
    const items = d?.items || [];
    // Write-if-changed: genre/country page 1 barely moves between 30-minute
    // ticks, so most cycles skip the write entirely — this is what keeps
    // the 12-key warm set well under its worst-case 576 writes/day (see
    // ADR-0001's arithmetic).
    const existing = await env.CATALOG_KV.get(kvKey);
    if (existing === body) return { key: target, status: 'skipped', bytes: body.length, items };
    await env.CATALOG_KV.put(kvKey, body);
    return { key: target, status: 'written', bytes: body.length, items };
  } catch (err) {
    // Deliberately don't touch kvKey — a stale-but-real warm copy beats no
    // warm copy at all. warmKvLookup() keeps serving whatever's already
    // there until a later cycle succeeds.
    console.error('[warm shard]', n, target, err.message);
    return { key: target, status: 'failed', error: err.message };
  }
}

// Orchestrator: sequential SELF calls, one per target, mirroring
// worker/lib/home.js's callShard/runHomeRefresh pattern (see that file for
// why env.SELF and not a plain fetch()). Sequential rather than
// Promise.all(12) on purpose — the orchestrator's own subrequest budget is
// 12 either way, but sequential keeps the free plan's separate 6-simultaneous-
// outgoing-connection cap from ever being a consideration here, at the cost
// of a slower overall cycle — acceptable for a 30-minute cadence.
async function callWarmShard(env, n) {
  const res = await env.SELF.fetch(`https://phim.bluesia.net/__cron/warm-shard/${n}`, {
    headers: { 'x-cron-key': env.CRON_KEY },
  });
  if (!res.ok) return { status: 'failed', error: `shard ${n} http ${res.status}` };
  return res.json();
}

// ADR-0001 Phase 5: a small metadata key /api/health reads to judge this
// cron's own freshness, deliberately separate from the 12 page:v1:* keys
// themselves — those bodies are served to real clients verbatim
// (warmKvLookup in worker/index.js) and must stay byte-for-byte what a live
// build would return, so bookkeeping can't live inside them the way
// home-data's leading `{"timestamp":...}` does. One more KV write per
// cycle (~48/day at */30) — folded into ADR-0001's budget arithmetic
// alongside the 12 page targets.
export const WARM_META_KEY = 'warm:last-run';

// Cleanup with LRU (plan-hit-rate.md Phase 4): delete any page:v1:* KV key
// that has fallen out of the current top-WARM_SET_SIZE ranking. Without
// this, a page that stops being popular keeps serving an ever-staler warm
// copy forever — warmKvLookup has no TTL of its own on that key, it just
// sits in KV until something overwrites it, and nothing else ever will once
// it's no longer a warm target. `list()` is a READ op (100k/day budget,
// distinct from the 1,000/day WRITE budget that caps WARM_SET_SIZE itself),
// so eviction is free against the constraint that actually matters here.
async function evictStaleWarmKeys(env, keepTargets) {
  const keep = new Set(keepTargets.map((t) => KV_WARM_PREFIX + t));
  let evicted = 0;
  try {
    const list = await env.CATALOG_KV.list({ prefix: KV_WARM_PREFIX });
    for (const k of list.keys) {
      if (!keep.has(k.name)) {
        await env.CATALOG_KV.delete(k.name);
        evicted++;
      }
    }
  } catch (e) {
    console.error('[warm lru]', e.message);
  }
  return evicted;
}

export async function runWarmRefresh(env) {
  const results = [];
  for (let n = 0; n < WARM_SET_SIZE; n++) {
    results.push(await callWarmShard(env, n));
  }
  const currentTargets = await getTopWarmTargets(env, WARM_SET_SIZE);
  const evicted = await evictStaleWarmKeys(env, currentTargets);

  const summary = { written: 0, skipped: 0, failed: 0 };
  for (const r of results) {
    if (r.status === 'written') summary.written++;
    else if (r.status === 'skipped') summary.skipped++;
    else summary.failed++;
  }
  const meta = {
    ranAt: Date.now(),
    ...summary,
    evicted,
    targets: results.map(({ items, ...rest }) => rest),
  };
  // Best-effort: if THIS write is what's failing (e.g. the 1,000/day KV
  // write cap is exhausted — the exact silent-failure scenario Phase 5
  // exists to surface), don't let it also take down the manual-trigger
  // response. /api/health will notice via ranAt going stale either way.
  try {
    await env.CATALOG_KV.put(WARM_META_KEY, JSON.stringify(meta));
  } catch (e) {
    console.error('[warm meta put]', e.message);
  }
  console.log('[warm refresh]', { ...summary, evicted });
  return meta;
}
