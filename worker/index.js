// worker/index.js — builds the whole /api/* catalog itself (KKPhim + TMDB
// fetched directly, D1/KV/R2 for caching and image mirroring). The VPS
// catalog-api this used to front is retired; see
// bluesiaOM/context/state-redflare-cf-worker.md for the migration history.
// Catalog source was OPhim (ophim1.com) through 2026-08-06, when it started
// returning HTTP 500 on every endpoint — dead, not a blip. Switched to
// KKPhim (phimapi.com) same day; see docs/plan-kkphim-migration.md for the
// full migration plan and the differences that mattered (image host/shape,
// slug namespace).
// Short version of what this file does today:
//
//   /api/list, /api/genre, /api/country, /api/search, /api/movie/:slug
//              → built HERE: fetch KKPhim directly, enrich with TMDB
//              (worker/lib/enrich.js), map images to R2 (worker/lib/images.js).
//              No VPS involved on a cache miss (Phase 3). For list/genre/
//              country specifically, a Cache API miss checks KV for a
//              pre-built `page:v1:*` copy (warmKvLookup, ADR-0001 Phase 3)
//              before falling through to this live build — read-only until
//              the warm cron (Phase 4) exists to write those keys.
//   /api/home-data
//              → built HERE too, but NOT per-request (Phase 4). A Cron
//              Trigger (scheduled() below) rebuilds it hourly across 6
//              sharded invocations (worker/lib/home.js) and stores the
//              result in KV; this route just reads that KV key. See
//              worker/lib/home.js for why home-data can't be built
//              synchronously per-request the way list/genre/etc. are.
//   /api/recommendation/:type/:id, /api/related/:type/:id, /api/related/:id
//              → built HERE (Phase 5): TMDB recommendations matched to KKPhim
//              via a tmdb.id → item reverse index in D1 (table `idx`), with a
//              bounded live KKPhim search fallback, cached in D1 table `recs`
//              with a 3-tier TTL based on result completeness (30d full / 6h
//              partial / 1h empty — see worker/lib/recommendation.js
//              classifyTier/ttlForTier, added in the Phase 1 fix for
//              bluesiaOM/context/state-sua-loi-recommendation.md).
//   /__cron/purge-recs?type=&id=
//              → internal, gated by CRON_KEY like the other /__cron/* routes.
//              Evicts one title's recommendation cache at BOTH layers (D1
//              `recs` and the Cache API) — see handleCronPurgeRecs below for
//              why both are required.
//   /__cron/shard/:n, /__cron/refresh-home, /__cron/mirror,
//   /__cron/mirror-shard/:n, /__cron/warm-shard/:n, /__cron/warm
//              → internal, gated by the CRON_KEY secret. Not part of the
//              public API surface — see worker/lib/home.js,
//              worker/lib/mirror.js, and worker/lib/warm.js. The home shards
//              also opportunistically populate the `idx` reverse index; the
//              hourly cron sweeps expired idx/recs rows; a */10 cron drains
//              the R2 image-mirror queue across 5 parallel shards
//              (plan-hit-rate.md Phase 3, same pattern as the home/warm
//              shards below); a */30 cron refreshes the page:v1:* warm set
//              (ADR-0001 Phase 4), sharded the same way home-data is, one
//              target per invocation.
//   Images: every build (list/detail/home/rec) enqueues its artwork into the
//              `mirror_queue` D1 table; the mirror cron copies them into R2 via
//              the binding (worker/lib/mirror.js) — served from
//              img.bluesia.net (redflare/CLAUDE.md "Images: 2026-08-04
//              domain + key-shape migration" has the full history).
//   anything else that isn't a static asset → env.ASSETS.fetch(request),
//              which applies wrangler.toml's not_found_handling (SPA fallback)
//
// Every /api/* response goes through the SAME caching shell: Cache API (hot
// tier, no daily write quota — see the note below) in front, with a durable
// last-known-good fallback (D1 for list/genre/country/movie/recommendation,
// nothing for search) for when KKPhim/TMDB itself is unreachable.
// /api/home-data no longer goes through that generic fallback — see
// handleHomeData() below, its durable copy IS the KV value the cron
// maintains, there's no separate "upstream fetch failed" case to fall back
// from anymore.
//
// Why Cache API and not KV for the hot tier: KV's free-plan write quota is
// 1,000/day, and /api/search has effectively unbounded keyword cardinality —
// a modest crawler hitting a few hundred distinct queries in a day could burn
// the whole daily KV write budget for the *entire* Worker (home-data included).
// Cache API has no per-operation daily cap, so it absorbs that cardinality for
// free. It's also per-datacenter and not tiered the way "Workers Caching"
// (Cache-Control-driven, invoked before the Worker even runs) is — but we need
// per-request control over the x-catalog-cache header (hit/miss/stale-vps-down
// is a documented debugging contract in redflare/CLAUDE.md), which Workers
// Caching's transparent replay wouldn't give us.

import { createEnrich } from './lib/enrich.js';
import { mapItemsImages, mapItemImages, mirrorTargets } from './lib/images.js';
import {
  HOME_KV_KEY,
  CRON_SHARD_BUILDERS,
  runHomeRefresh,
  buildHomeFallback,
} from './lib/home.js';
import {
  buildRecommendation,
  readRecsCache,
  writeRecsCache,
  deleteRecsCache,
  cleanupRecTables,
  indexItems,
  classifyTier,
  ttlForTier,
} from './lib/recommendation.js';
import { enqueueMirror, drainMirrorQueueShard, runMirrorRefresh } from './lib/mirror.js';
import {
  WARM_SET_SIZE,
  WARM_META_KEY,
  runWarmShard,
  runWarmRefresh,
  getTopWarmTargets,
  runEdgeWarm,
} from './lib/warm.js';

const KKPHIM_BASE = 'https://phimapi.com';

// Mirrors catalog-api's own Valkey TTLs (catalog-api/src/server.js) — no
// reason to diverge, KKPhim/TMDB freshness expectations haven't changed just
// because the fetch now happens here instead of on the VPS. home-data isn't
// in this table any more — handleHomeData() sets its own Cache-Control.
const TTL = {
  movie: 60 * 60,
  search: 10 * 60,
  recommendation: 30 * 24 * 60 * 60,
  list: 30 * 60,
};

function ttlFor(pathname) {
  if (pathname.startsWith('/api/movie/')) return TTL.movie;
  if (pathname.startsWith('/api/search')) return TTL.search;
  if (pathname.startsWith('/api/recommendation/') || pathname.startsWith('/api/related/')) {
    return TTL.recommendation;
  }
  return TTL.list; // list, genre, country
}

// --- Client/zone-facing Cache-Control (plan-hit-rate.md Phase 1) ------------
// `s-maxage` disables `stale-while-revalidate` for shared caches (Cloudflare
// docs, confirmed 2026-08-06: "s-maxage disables stale-while-revalidate") —
// so the header returned to the actual HTTP response (what the zone CDN
// caches) must NOT carry s-maxage, only max-age + SWR + stale-if-error.
// Edge freshness for the zone tier now comes from `max-age` alone (Origin
// Cache Control is on by default for Free/Pro/Business, confirmed via docs)
// rather than a per-response s-maxage — a short max-age is fine because SWR
// means "revalidate" here almost always means "ask this Worker", which is
// itself fast (KV/D1/Cache-API-backed), not a KKPhim/TMDB round-trip.
//
// This is DELIBERATELY separate from the s-maxage-bearing Cache-Control still
// written to `caches.default` below (unchanged) — that Worker-owned per-colo
// tier doesn't support SWR at all ("not supported when using the Cache API
// methods cache.match or cache.put", Cloudflare docs), so it keeps using
// s-maxage/ttl as its freshness signal exactly as before. Two different
// Response objects, two different jobs: caches.default shields origin builds
// (needs precise per-tier TTL, e.g. the 30d/6h/1h recommendation tiers);
// the client-facing header lets the zone edge serve stale + revalidate in
// the background instead of blocking on a MISS.
function clientCacheControlFor(pathname) {
  if (pathname.startsWith('/api/movie/')) {
    return 'public, max-age=60, stale-while-revalidate=7200, stale-if-error=86400';
  }
  if (pathname.startsWith('/api/search')) {
    return 'public, max-age=60, stale-while-revalidate=600';
  }
  if (pathname.startsWith('/api/recommendation/') || pathname.startsWith('/api/related/')) {
    return 'public, max-age=60, stale-while-revalidate=86400, stale-if-error=604800';
  }
  return 'public, max-age=60, stale-while-revalidate=3600, stale-if-error=86400'; // list, genre, country, home-data
}

const HOME_PATH = '/api/home-data';

function isSearch(pathname) {
  return pathname.startsWith('/api/search');
}

// --- KKPhim fetch + local list/detail builders (Phase 3) --------------------
// Ported from catalog-api/src/server.js's route handlers. Each builder does
// exactly one KKPhim fetch, then enrich.enrichListPayload/enrichDetailPayload
// (up to ~24 TMDB fetches, bounded to 6 concurrent — worker/lib/enrich.js)
// runs against it. Worst case subrequest budget for a 24-item page: 1 KKPhim +
// 24 TMDB meta + (rare) up to 24 IMDB-resolve fallbacks = 49, under the free
// plan's 50/invocation cap — see state.md Phase 3 log for how this was sized.

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

// Map images inside a KKPhim list payload ({ items } or { data: { items } }),
// mirrors catalog-api's signListPayload minus the signing (and minus the
// reverse-index side effect — that's Phase 5).
function mapListPayloadImages(data) {
  const d = data?.data || data;
  if (d?.items?.length) {
    d.items = mapItemsImages(d.items);
    if (data.data) data.data.items = d.items;
    else data.items = d.items;
  }
  return data;
}

function mapDetailPayloadImages(data) {
  const item = data?.data?.item || data?.item || data?.movie;
  if (item) {
    const mapped = mapItemImages(item);
    if (data.data?.item) data.data.item = mapped;
    else if (data.item) data.item = mapped;
    else if (data.movie) data.movie = mapped;
  }
  return data;
}

async function buildEnrichedList(enrich, upstreamUrl) {
  const data = await fetchCatalogJson(upstreamUrl);
  await enrich.enrichListPayload(data);
  return mapListPayloadImages(data);
}

// Resolve a request the Worker builds itself. Returns a zero-arg async
// builder function, or null for a path this Worker doesn't know how to build
// (handleApi returns 404 in that case). home-data and recommendation are
// intercepted in handleApi() before this is ever called.
function localBuilder(env, url) {
  const pathname = url.pathname;

  if (pathname === '/api/list') {
    const type = url.searchParams.get('type') || '';
    const page = url.searchParams.get('page') || '1';
    if (!type) throw httpError('Missing type', 400);
    const upstream = type === 'phim-moi-cap-nhat'
      ? `${KKPHIM_BASE}/danh-sach/phim-moi-cap-nhat?page=${page}`
      : `${KKPHIM_BASE}/v1/api/danh-sach/${type}?page=${page}`;
    return () => buildEnrichedList(createEnrich(env), upstream);
  }

  if (pathname === '/api/genre') {
    const slug = url.searchParams.get('slug') || '';
    const page = url.searchParams.get('page') || '1';
    if (!slug) throw httpError('Missing slug', 400);
    return () =>
      buildEnrichedList(createEnrich(env), `${KKPHIM_BASE}/v1/api/the-loai/${slug}?page=${page}`);
  }

  if (pathname === '/api/country') {
    const slug = url.searchParams.get('slug') || '';
    const page = url.searchParams.get('page') || '1';
    if (!slug) throw httpError('Missing slug', 400);
    return () =>
      buildEnrichedList(createEnrich(env), `${KKPHIM_BASE}/v1/api/quoc-gia/${slug}?page=${page}`);
  }

  if (pathname === '/api/search') {
    const keyword = (url.searchParams.get('keyword') || '').trim();
    const page = url.searchParams.get('page') || '1';
    if (keyword.length < 2) return async () => ({ data: { items: [] } });
    return () =>
      buildEnrichedList(
        createEnrich(env),
        `${KKPHIM_BASE}/v1/api/tim-kiem?keyword=${encodeURIComponent(keyword)}&page=${page}`
      );
  }

  if (pathname.startsWith('/api/movie/')) {
    const slug = pathname.slice('/api/movie/'.length);
    if (!slug) throw httpError('Missing slug', 400);
    return async () => {
      const enrich = createEnrich(env);
      const data = await fetchCatalogJson(`${KKPHIM_BASE}/phim/${slug}`);
      await enrich.enrichDetailPayload(data);
      return mapDetailPayloadImages(data);
    };
  }

  return null; // unknown /api/* path
}

// --- Durable last-known-good read/write for list/genre/country/movie
// (unchanged from Phase 2/3). home-data (KV, see handleHomeData) and
// recommendation (D1 `recs`, see handleRecommendation) have their own durable
// layers and no longer flow through this generic `stale` table. ---

async function readStale(env, pathname, cacheKey) {
  if (isSearch(pathname)) return null;
  const row = await env.DB.prepare('SELECT body FROM stale WHERE path = ?1').bind(cacheKey).first();
  return row ? row.body : null;
}

// plan-hit-rate.md Phase 8 / ADR-0001 Action Item 8: `stale` had no eviction
// at all — every distinct list/genre/country page number, movie slug, and
// recommendation id ever built left a row behind forever, unlike `idx`/`recs`
// (cleanupRecTables, 45-day/expires_at) or `mirror_queue`/`mirrored` (bounded
// by what's actually in the catalog). `updated_at` only advances when a path
// is actually rebuilt live, so a row that stops updating means nobody has
// hit that exact page in the cutoff window — safe to drop; a future request
// for it just rebuilds from KKPhim/TMDB and re-inserts. 90 days (2x idx's 45)
// since `stale` is the rarer disaster-fallback layer, not the primary cache
// — less urgent to prune aggressively than the reverse index.
const STALE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

async function cleanupStaleTable(env) {
  await env.DB.prepare('DELETE FROM stale WHERE updated_at < ?1')
    .bind(Date.now() - STALE_MAX_AGE_MS)
    .run();
}

function writeStale(env, pathname, cacheKey, body) {
  if (isSearch(pathname)) return Promise.resolve();
  return env.DB.prepare(
    'INSERT INTO stale (path, body, updated_at) VALUES (?1, ?2, ?3) ' +
      'ON CONFLICT(path) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at'
  )
    .bind(cacheKey, body, Date.now())
    .run();
}

// --- /api/home-data (Phase 4) ------------------------------------------------
// Reads the KV value the cron (worker/lib/home.js's runHomeRefresh) already
// maintains — no per-request KKPhim/TMDB fetch, no JSON.parse of the ~150KB
// payload. Still goes through the Cache API hot tier below it (cheaper than
// a KV read on every request, and free of any daily quota). The only case
// that does real work here is a KV miss, which should only ever happen once
// per Worker deployment, before the first cron cycle completes.

async function handleHomeData(env, ctx, cache, cacheReq, method) {
  let body = await env.CATALOG_KV.get(HOME_KV_KEY);
  let cacheStatus = 'miss';
  if (body == null) {
    const payload = await buildHomeFallback(env);
    body = JSON.stringify(payload);
    cacheStatus = 'miss-fallback';
    // Warms KV so concurrent/subsequent requests during this bootstrap
    // window don't each redo the same KKPhim fetch; the next successful cron
    // cycle overwrites this with the real trending-matched build regardless.
    ctx.waitUntil(env.CATALOG_KV.put(HOME_KV_KEY, body));
  }

  // ADR-0001 Phase 1: caches.default keeps s-maxage — that layer doesn't
  // support stale-while-revalidate, so it needs a plain TTL. plan-hit-rate.md
  // Phase 1: the client-facing response deliberately carries a DIFFERENT
  // Cache-Control (no s-maxage, has SWR) — see clientCacheControlFor above.
  const homeCacheControl = 'public, max-age=60, s-maxage=1800';
  const cacheableRes = new Response(body, {
    headers: {
      'content-type': 'application/json',
      'x-catalog-cache': cacheStatus,
      'cache-control': homeCacheControl,
    },
  });
  ctx.waitUntil(cache.put(cacheReq, cacheableRes.clone()));

  return new Response(method === 'HEAD' ? null : body, {
    headers: {
      'content-type': 'application/json',
      'x-catalog-cache': cacheStatus,
      'cache-control': clientCacheControlFor(HOME_PATH),
    },
  });
}

// --- /api/recommendation, /api/related (Phase 5) -----------------------------
// Built here now instead of proxied. Cache API hot tier (checked in handleApi)
// sits in front; this handler's durable layer is the D1 `recs` table, not the
// generic `stale` table. TTL is 3-tier based on result completeness (see
// classifyTier/ttlForTier in worker/lib/recommendation.js) — NOT just whether
// the result was empty. Both this D1 layer and the Cache API layer above it
// use the SAME classifyTier() call on the SAME stored payload, so a D1 hit
// and a fresh build always agree on how long to keep serving a given result.

function parseRecommendationPath(pathname) {
  // /api/recommendation/:type/:tmdb_id  |  /api/related/:type/:tmdb_id
  let m = pathname.match(/^\/api\/(?:recommendation|related)\/(movie|tv)\/([^/]+)$/);
  if (m) return { type: m[1], tmdbId: m[2] };
  // /api/related/:tmdb_id (legacy, no type — defaults to movie, matches VPS)
  m = pathname.match(/^\/api\/related\/([^/]+)$/);
  if (m) return { type: 'movie', tmdbId: m[1] };
  return null;
}

async function handleRecommendation(env, ctx, cache, cacheReq, method, type, tmdbId) {
  // Cache API was already checked (and missed) in handleApi. Next tier: the
  // durable D1 recs cache.
  let body = null;
  try {
    body = await readRecsCache(env, type, tmdbId);
  } catch (err) {
    console.error('[recs read]', err.message);
  }

  let cacheStatus;
  let ttl;
  let hasItems;
  if (body != null) {
    cacheStatus = 'd1-recs';
    let tier = 'full'; // parse failure on stored data: assume it's fine rather than force a rebuild storm
    try {
      const parsed = JSON.parse(body);
      hasItems = (parsed.items || []).length > 0;
      tier = classifyTier(parsed);
    } catch {
      hasItems = true;
    }
    ttl = ttlForTier(tier);
  } else {
    cacheStatus = 'miss';
    let payload;
    try {
      payload = await buildRecommendation(env, type, tmdbId);
    } catch (err) {
      console.error('[recommendation]', err.message);
      payload = { items: [], candidates: 0, resolved: 0, skippedBudget: 0, searchErrors: 0 };
    }
    body = JSON.stringify(payload);
    hasItems = payload.items.length > 0;
    ttl = ttlForTier(classifyTier(payload));
    ctx.waitUntil(
      writeRecsCache(env, type, tmdbId, body, ttl).catch((err) =>
        console.error('[recs write]', err.message)
      )
    );
    // Mirror the recommended titles' artwork too (Phase 6).
    if (hasItems) {
      ctx.waitUntil(
        enqueueMirror(env, mirrorTargets(payload.items)).catch((e) =>
          console.error('[mirror enqueue rec]', e.message)
        )
      );
    }
  }

  // ADR-0001 Phase 1 + plan-hit-rate.md Phase 1: caches.default keeps
  // s-maxage=ttl (the 30d/6h/1h completeness tier from classifyTier — SWR
  // isn't supported there anyway); the client-facing header uses a flat SWR
  // window instead (clientCacheControlFor) since per-tier granularity can't
  // flow through the zone edge's freshness signal without s-maxage.
  const recCacheControl = `public, max-age=60, s-maxage=${ttl}`;
  const cacheableRes = new Response(body, {
    headers: {
      'content-type': 'application/json',
      'x-catalog-cache': cacheStatus,
      'cache-control': recCacheControl,
    },
  });
  ctx.waitUntil(cache.put(cacheReq, cacheableRes.clone()));

  return new Response(method === 'HEAD' ? null : body, {
    headers: {
      'content-type': 'application/json',
      'x-catalog-cache': cacheStatus,
      'cache-control': clientCacheControlFor('/api/recommendation/'),
    },
  });
}

// --- /__cron/* (Phase 4) -----------------------------------------------------
// Internal-only. A wrong/missing x-cron-key returns 404, not 403 — a 403
// would confirm to a prober that this path exists at all.

function checkCronKey(request, env) {
  const key = request.headers.get('x-cron-key');
  return Boolean(env.CRON_KEY) && key === env.CRON_KEY;
}

async function handleCronShard(request, env, ctx, n) {
  if (!checkCronKey(request, env)) return new Response('Not found', { status: 404 });
  const builder = CRON_SHARD_BUILDERS[n];
  if (!builder) return new Response('Not found', { status: 404 });
  try {
    const items = await builder(env);
    // Seed the `idx` reverse index with this shard's items (Phase 5) — the
    // hourly home refresh is the primary source of index coverage for the
    // popular titles recommendations point at (VPS's indexHomePayload).
    // Fire-and-forget: the returned items don't depend on the write landing.
    ctx.waitUntil(indexItems(env, items).catch((e) => console.error('[shard idx]', n, e.message)));
    // Enqueue the shard's artwork for R2 mirroring (Phase 6).
    ctx.waitUntil(enqueueMirror(env, mirrorTargets(items)).catch((e) => console.error('[shard mirror]', n, e.message)));
    return new Response(JSON.stringify(items), { headers: { 'content-type': 'application/json' } });
  } catch (err) {
    console.error('[cron shard]', n, err.message);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    });
  }
}

// Manual trigger for runHomeRefresh — same orchestrator scheduled() calls,
// exposed so a refresh can be forced on demand (right after a deploy, or to
// debug a stuck home:current) instead of waiting for the next cron tick.
async function handleCronRefreshHome(request, env) {
  if (!checkCronKey(request, env)) return new Response('Not found', { status: 404 });
  const result = await runHomeRefresh(env);
  return new Response(JSON.stringify(result), {
    status: result.ok ? 200 : 502,
    headers: { 'content-type': 'application/json' },
  });
}

// One warm-set target, one invocation (ADR-0001 Phase 4) — see
// worker/lib/warm.js's module comment for why this is sharded the same way
// home-data's shards are. Builds+writes here; the R2-mirror enqueue is
// owned by THIS route handler (not warm.js, which has no ExecutionContext)
// so it happens in the same invocation as the build, same as every other
// build path in this file.
async function handleCronWarmShard(request, env, ctx, n) {
  if (!checkCronKey(request, env)) return new Response('Not found', { status: 404 });
  const result = await runWarmShard(env, Number(n));
  if (result.status === 'not-found') return new Response('Not found', { status: 404 });
  if (result.status === 'written' && result.items?.length) {
    ctx.waitUntil(
      enqueueMirror(env, mirrorTargets(result.items)).catch((e) =>
        console.error('[warm shard mirror]', n, e.message)
      )
    );
  }
  const { items, ...body } = result; // items was only needed for the mirror enqueue above
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}

// Manual trigger for runWarmRefresh — same orchestrator scheduled() calls
// on the */30 cron, exposed so a warm cycle can be forced on demand (right
// after a deploy, or to verify Phase 3's warmKvLookup end-to-end without
// waiting for the next tick).
async function handleCronWarmRefresh(request, env) {
  if (!checkCronKey(request, env)) return new Response('Not found', { status: 404 });
  const result = await runWarmRefresh(env);
  return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
}

// Pulls each warm page through Cloudflare's front door so the ZONE EDGE
// cache holds it, not just KV (plan-hit-rate.md Phase 5). Its own invocation,
// dispatched by runWarmRefresh via env.SELF, so its ~13 public fetches get a
// fresh 50-subrequest budget rather than sharing the orchestrator's. Depends
// on the global_fetch_strictly_public compatibility flag — see wrangler.toml
// for why, and for why env.SELF (which this route is reached through) is
// unaffected by it.
async function handleCronEdgeWarm(request, env) {
  if (!checkCronKey(request, env)) return new Response('Not found', { status: 404 });
  const result = await runEdgeWarm(env);
  return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
}

// Health of the cron jobs, judged by their OUTPUT rather than by whether
// they threw: Cloudflare's own Cron Events / Workers Logs report a run that
// completed without an exception as a success, which is exactly what the OPhim
// mirror bug looked like for a day (every drain "succeeded", every OPhim image
// silently failed to land — see worker/lib/mirror.js). So:
//   home    — how old the KV copy of /api/home-data is. The hourly cron leaves
//             the old key untouched when a refresh fails, so an ageing
//             timestamp IS the failure signal. >2h = missed 2 ticks.
//   mirror  — queue depth and the age of the OLDEST queued row. Depth alone is
//             meaningless (a build enqueues in bursts); a row older than an
//             hour means the */10 drain is not clearing the head of the queue.
//   warm    — how old warm:last-run is (ADR-0001 Phase 5), same ageing-
//             timestamp logic as home: a failed WRITE of that key (e.g. the
//             KV 1,000-writes/day cap exhausted — previously a SILENT
//             failure, which is the whole reason this check exists) shows
//             up here as the timestamp simply not advancing. Also flags a
//             last run that reported every target failed — the cron ran
//             and reported honestly, but something (KKPhim fully down,
//             CRON_KEY misconfigured) took out the whole cycle, not just
//             one flaky genre. A few partial failures are NOT flagged: the
//             per-key last-known-good design means a stale-but-real page:v1:*
//             key already degrades gracefully on its own — see warm.js.
// Returns 503 when unhealthy so a plain uptime monitor can watch it with no
// auth and no JSON parsing. Deliberately ungated: it exposes counts only.
const HOME_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const QUEUE_MAX_AGE_MS = 60 * 60 * 1000;
const WARM_MAX_AGE_MS = 90 * 60 * 1000; // 2 missed */30 ticks, same margin as home's "2 ticks"

async function handleHealth(env) {
  const now = Date.now();
  const problems = [];
  const out = { ok: true, checked_at: new Date(now).toISOString() };

  try {
    // The payload starts `{"timestamp":<ms>,` (worker/lib/home.js) — read it off
    // the head of the string rather than JSON.parse-ing the whole home page.
    const body = await env.CATALOG_KV.get(HOME_KV_KEY);
    const ts = body && Number((body.slice(0, 64).match(/"timestamp":(\d+)/) || [])[1]);
    const ageMs = ts ? now - ts : null;
    out.home = { age_min: ageMs == null ? null : Math.round(ageMs / 60000) };
    if (ageMs == null) problems.push('home:current missing or unparseable');
    else if (ageMs > HOME_MAX_AGE_MS) problems.push(`home:current is ${Math.round(ageMs / 60000)}min old`);
  } catch (e) {
    problems.push(`home check failed: ${e.message}`);
  }

  try {
    const row = await env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM mirror_queue) AS queued,
              (SELECT MIN(queued_at) FROM mirror_queue) AS oldest,
              (SELECT COUNT(*) FROM mirrored WHERE created_at > ?1) AS mirrored_1h`
    )
      .bind(now - 60 * 60 * 1000)
      .first();
    const oldestMs = row.oldest ? now - row.oldest : 0;
    out.mirror = {
      queued: row.queued,
      oldest_queued_min: Math.round(oldestMs / 60000),
      mirrored_last_hour: row.mirrored_1h,
    };
    if (oldestMs > QUEUE_MAX_AGE_MS) {
      problems.push(`mirror queue head stuck ${Math.round(oldestMs / 60000)}min (${row.queued} queued)`);
    }
  } catch (e) {
    problems.push(`mirror check failed: ${e.message}`);
  }

  try {
    const raw = await env.CATALOG_KV.get(WARM_META_KEY);
    if (!raw) {
      out.warm = { age_min: null, written: null, skipped: null, failed: null };
      problems.push('warm:last-run missing (warm cron has not completed a cycle yet)');
    } else {
      const meta = JSON.parse(raw);
      const ageMs = now - meta.ranAt;
      out.warm = {
        age_min: Math.round(ageMs / 60000),
        written: meta.written,
        skipped: meta.skipped,
        failed: meta.failed,
      };
      if (ageMs > WARM_MAX_AGE_MS) problems.push(`warm:last-run is ${Math.round(ageMs / 60000)}min old`);
      if (meta.failed >= WARM_SET_SIZE) {
        problems.push(`warm cron failed all ${meta.failed} targets on its last run`);
      }
    }
  } catch (e) {
    problems.push(`warm check failed: ${e.message}`);
  }

  out.ok = problems.length === 0;
  out.problems = problems;
  return new Response(JSON.stringify(out), {
    status: out.ok ? 200 : 503,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

// Read side of Phase 5 edge-warming (plan-hit-rate.md). A Worker can warm
// img.bluesia.net's edge cache itself (home.js's runHomeRefresh does — see
// its module comment), but NOT this Worker's own /api/* edge cache: a
// fetch() to phim.bluesia.net from inside this Worker 522s (documented
// Cloudflare behavior, see wrangler.toml's [[services]] comment), and the
// SELF service binding routes directly to the Worker's own handler,
// bypassing the zone CDN entirely — neither can populate the CDN's edge
// cache. So an EXTERNAL caller (.github/workflows/edge-warm.yml) has to make
// the real HTTP requests instead; this endpoint tells it what to request.
// Deliberately ungated (like /api/health) — it exposes only which pages are
// currently warm, no secrets, and ungating means the GitHub Actions workflow
// doesn't need a CRON_KEY secret at all.
async function handleWarmTargets(env, url) {
  let targets = [];
  try {
    targets = await getTopWarmTargets(env, WARM_SET_SIZE);
  } catch (err) {
    console.error('[warm targets]', err.message);
  }
  const urls = [`${url.origin}${HOME_PATH}`, ...targets.map((t) => `${url.origin}${t}`)];
  return new Response(JSON.stringify({ urls }), {
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

// Manual trigger for the R2 mirror drain — same call the */10 cron makes
// (plan-hit-rate.md Phase 3: now the SHARDED refresh, not the single-shot
// drain). Exposed so a drain can be forced on demand (verifying Phase 3/6
// without waiting for the cron tick).
async function handleCronMirror(request, env) {
  if (!checkCronKey(request, env)) return new Response('Not found', { status: 404 });
  const result = await runMirrorRefresh(env);
  return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
}

// One mirror-drain shard, one invocation (plan-hit-rate.md Phase 3) — same
// pattern as /__cron/shard/:n (home.js) and /__cron/warm-shard/:n (warm.js):
// each gets its own 50-subrequest budget via env.SELF, dispatched by
// runMirrorRefresh. Exposed standalone too, for testing one shard in
// isolation without running the whole refresh.
async function handleCronMirrorShard(request, env, n) {
  if (!checkCronKey(request, env)) return new Response('Not found', { status: 404 });
  const result = await drainMirrorQueueShard(env, Number(n));
  return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
}

// Purge one title's recommendation cache at BOTH layers — added in the Phase 1
// fix (state-sua-loi-recommendation.md) because the D1 `recs` row and the
// Cache API copy are independent: deleting only the D1 row leaves real users
// seeing the stale Cache API response for up to 30 more days (this is exactly
// what happened testing the original bug report — the D1 row rebuilt correctly
// but a plain curl still showed the old, incomplete list). Before this route
// existed, fixing one title required a manual `wrangler d1 execute DELETE`
// that STILL didn't reach the Cache API layer.
async function handleCronPurgeRecs(request, env, url) {
  if (!checkCronKey(request, env)) return new Response('Not found', { status: 404 });
  const type = url.searchParams.get('type');
  const id = url.searchParams.get('id');
  if ((type !== 'movie' && type !== 'tv') || !id) {
    return new Response(JSON.stringify({ error: 'query params required: type=movie|tv, id=<tmdb id>' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }
  const cache = caches.default;
  const paths = [`/api/recommendation/${type}/${id}`, `/api/related/${type}/${id}`];
  if (type === 'movie') paths.push(`/api/related/${id}`); // legacy alias, see parseRecommendationPath
  let cacheDeleted = 0;
  for (const p of paths) {
    const deleted = await cache.delete(new Request(url.origin + p, { method: 'GET' }));
    if (deleted) cacheDeleted++;
  }
  let dbDeleted = 0;
  try {
    dbDeleted = await deleteRecsCache(env, type, id);
  } catch (err) {
    console.error('[purge-recs d1]', err.message);
  }
  return new Response(JSON.stringify({ ok: true, type, id, paths, cacheDeleted, dbDeleted }), {
    headers: { 'content-type': 'application/json' },
  });
}

// ADR-0001 Phase 2: canonicalize the cache key. Before this, the Cache API
// key (and the D1 `stale` key, which reuses it) was the raw request URL —
// so `?type=x&page=1` and `?page=1&type=x` were two separate cache entries
// for identical content, and a tracking param like `?fbclid=...` minted a
// brand new entry (and a brand new `stale` row) on every visit instead of
// ever hitting the one that already existed. Each route below lists ONLY
// the query params that actually affect its response, in a fixed order —
// everything else (unknown params, empty values) is dropped. home-data,
// recommendation, and movie/:slug take no query params that matter, so
// they fall through to the `pathname`-only default.
const CACHE_PARAMS_BY_PATH = {
  '/api/list': ['type', 'page'],
  '/api/genre': ['slug', 'page'],
  '/api/country': ['slug', 'page'],
  '/api/search': ['keyword', 'page'],
};

function canonicalCacheKey(url) {
  const allowed = CACHE_PARAMS_BY_PATH[url.pathname];
  if (!allowed) return url.pathname;
  const params = new URLSearchParams();
  for (const name of allowed) {
    const v = url.searchParams.get(name);
    if (v) params.set(name, v);
  }
  const qs = params.toString();
  return qs ? `${url.pathname}?${qs}` : url.pathname;
}

// --- KV warm-set read path (ADR-0001 Phase 3) --------------------------------
// Read-only for now: no cron writes `page:v1:*` keys yet (that's Phase 4).
// This deliberately does NOT hardcode which pages are warm — it just checks
// whatever key the canonicalized request maps to. An unwarmed key means
// env.CATALOG_KV.get() returns null and the request falls through to the
// live build exactly as it did before this phase existed. That split (a
// generic read path landing before any cron writes to it) is what lets one
// key be seeded by hand — `wrangler kv key put --remote CATALOG_KV
// "page:v1:/api/list?type=phim-le&page=1" '<json>'` — to prove
// `x-catalog-cache: warm` end-to-end without deploying a cron at all.
//
// Scope: only list/genre/country — the three route types the eventual warm
// set (Phase 4/5) draws from. movie/:slug and search are deliberately never
// checked: movie isn't in the candidate warm set (KV write budget, see
// ADR-0001's arithmetic) and search has no durable layer at all, by design.
// Runs only on a Cache API MISS (handleApi already checked cache.match), so
// its KV-read cost is bounded by distinct-key miss traffic, not total
// requests — well inside the 100,000 KV reads/day free-plan budget even if
// every list/genre/country miss checks it, warmed or not.
const KV_WARM_PATHS = new Set(['/api/list', '/api/genre', '/api/country']);
const KV_WARM_PREFIX = 'page:v1:';

// --- Popularity tracking (plan-hit-rate.md Phase 4) --------------------------
// D1 `popularity` (migrations/0003_popularity.sql) — feeds warm.js's
// getTopWarmTargets, which ranks the warm set by real traffic instead of the
// static guess ADR-0001 Action Item 5 flagged as a placeholder. Sampled at
// 1-in-POPULARITY_SAMPLE_RATE (D1's free-plan write budget is 100k rows/day,
// far above what's needed here, but sampling keeps write VOLUME proportional
// to real interest rather than raw request count, and costs nothing to do).
// Capped at POPULARITY_MAX_PAGE to keep the table's distinct-row count
// bounded — deep pagination pages are never worth warming, and an unbounded
// table here would repeat the exact unbounded-D1-growth problem flagged for
// `stale` in ADR-0001 Action Item 8.
const POPULARITY_SAMPLE_RATE = 10;
const POPULARITY_MAX_PAGE = 10;

async function trackPopularity(env, pathname, cacheKey) {
  if (!KV_WARM_PATHS.has(pathname)) return;
  if (Math.floor(Math.random() * POPULARITY_SAMPLE_RATE) !== 0) return;
  const pageMatch = cacheKey.match(/[?&]page=(\d+)/);
  const page = pageMatch ? Number(pageMatch[1]) : 1;
  if (page > POPULARITY_MAX_PAGE) return;
  try {
    await env.DB.prepare(
      `INSERT INTO popularity (path, hits, last_seen) VALUES (?1, 1, ?2)
       ON CONFLICT(path) DO UPDATE SET hits = hits + 1, last_seen = excluded.last_seen`
    )
      .bind(cacheKey, Date.now())
      .run();
  } catch (err) {
    console.error('[popularity]', cacheKey, err.message);
  }
}

async function warmKvLookup(env, ctx, cache, cacheReq, cacheKey, pathname, ttl, method) {
  if (!KV_WARM_PATHS.has(pathname)) return null;
  let body;
  try {
    body = await env.CATALOG_KV.get(KV_WARM_PREFIX + cacheKey);
  } catch (err) {
    console.error('[kv warm read]', cacheKey, err.message);
    return null;
  }
  if (body == null) return null;

  // Same Cache-Control shape a live build would set (ADR-0001 Phase 1) — a
  // warm hit is a FRESHER source for this data, not a differently-scoped
  // one, so it gets the same TTL and also seeds the per-colo Cache API tier
  // for this colo's next request (KV is never the layer a plain cache hit
  // consults directly — see ADR-0001's "KV is never the first layer" rule).
  // plan-hit-rate.md Phase 1: caches.default entry keeps s-maxage=ttl; the
  // client-facing response uses the SWR scheme instead — see
  // clientCacheControlFor.
  const cacheControl = `public, max-age=60, s-maxage=${ttl}`;
  const cacheableRes = new Response(body, {
    headers: {
      'content-type': 'application/json',
      'x-catalog-cache': 'warm',
      'cache-control': cacheControl,
    },
  });
  ctx.waitUntil(cache.put(cacheReq, cacheableRes.clone()));

  return new Response(method === 'HEAD' ? null : body, {
    headers: {
      'content-type': 'application/json',
      'x-catalog-cache': 'warm',
      'cache-control': clientCacheControlFor(pathname),
    },
  });
}

async function handleApi(request, env, ctx, url) {
  const method = request.method;
  if (method !== 'GET' && method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405 });
  }

  const cache = caches.default;
  const cacheKey = canonicalCacheKey(url);
  const cacheReq = new Request(url.origin + cacheKey, { method: 'GET' });
  // Counts every request (hit and miss alike) — popularity ranks real
  // traffic volume, not rebuild frequency. Fire-and-forget, sampled.
  ctx.waitUntil(trackPopularity(env, url.pathname, cacheKey));

  const hit = await cache.match(cacheReq);
  if (hit) {
    const headers = new Headers(hit.headers);
    headers.set('x-catalog-cache', 'hit');
    return new Response(method === 'HEAD' ? null : hit.body, { headers, status: hit.status });
  }

  if (url.pathname === HOME_PATH) {
    return handleHomeData(env, ctx, cache, cacheReq, method);
  }
  const rec = parseRecommendationPath(url.pathname);
  if (rec) {
    return handleRecommendation(env, ctx, cache, cacheReq, method, rec.type, rec.tmdbId);
  }

  const ttl = ttlFor(url.pathname);

  const warm = await warmKvLookup(env, ctx, cache, cacheReq, cacheKey, url.pathname, ttl, method);
  if (warm) return warm;

  let build = null;
  try {
    build = localBuilder(env, url);
  } catch (err) {
    // Thrown synchronously by localBuilder for a malformed request (missing
    // required query param) — matches catalog-api's own validation, which
    // also returns 4xx directly with no durable-fallback lookup. Still worth
    // a short Cache-Control (ADR-0001 Phase 1, shortened in plan-hit-rate.md
    // Phase 1): the exact same malformed URL hitting this repeatedly (a
    // broken client, a crawler) shouldn't redo this work every time.
    return new Response(JSON.stringify({ error: err.message }), {
      status: err.status || 400,
      headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=30' },
    });
  }

  if (!build) {
    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=30' },
    });
  }

  try {
    const payload = await build();
    const body = JSON.stringify(payload);
    const items =
      payload?.data?.items ||
      payload?.items ||
      [payload?.data?.item || payload?.item || payload?.movie].filter(Boolean);
    // Opportunistically index a freshly-built movie detail into the `idx`
    // reverse index (Phase 5) so recommendations can resolve it by tmdb.id
    // without a live KKPhim search — same side effect the VPS did on every
    // signed movie payload. List/genre/country/search deliberately do NOT
    // index (see worker/lib/recommendation.js deviation #2).
    if (url.pathname.startsWith('/api/movie/') && items[0]?.tmdb?.id) {
      ctx.waitUntil(indexItems(env, [items[0]]).catch((e) => console.error('[movie idx]', e.message)));
    }
    // Enqueue this payload's artwork for mirroring into R2 (Phase 6). Every
    // build path feeds the queue; the mirror cron drains it. Fire-and-forget.
    if (items.length) {
      ctx.waitUntil(
        enqueueMirror(env, mirrorTargets(items)).catch((e) => console.error('[mirror enqueue]', e.message))
      );
    }

    // ADR-0001 Phase 1 + plan-hit-rate.md Phase 1: caches.default keeps
    // s-maxage=ttl (no SWR support there anyway); the client-facing response
    // uses the SWR scheme (clientCacheControlFor) instead — see the comment
    // on that function for why the two must differ. Before ADR-0001 Phase 1
    // every list/genre/country/movie/search miss returned with NO
    // Cache-Control at all, so the zone edge never cached a colo's first
    // request — only a later Cache API hit ever replayed a cacheable header.
    const buildCacheControl = `public, max-age=60, s-maxage=${ttl}`;
    const cacheableRes = new Response(body, {
      headers: {
        'content-type': 'application/json',
        'x-catalog-cache': 'miss',
        'cache-control': buildCacheControl,
      },
    });
    ctx.waitUntil(cache.put(cacheReq, cacheableRes.clone()));
    ctx.waitUntil(Promise.resolve(writeStale(env, url.pathname, cacheKey, body)).catch((err) => {
      console.error('[stale write]', url.pathname, err.message);
    }));

    return new Response(method === 'HEAD' ? null : body, {
      headers: {
        'content-type': 'application/json',
        'x-catalog-cache': 'miss',
        'cache-control': clientCacheControlFor(url.pathname),
      },
    });
  } catch (err) {
    // A genuine 4xx from KKPhim itself (e.g. an unknown genre/country slug) —
    // matches catalog-api's own behavior: return the real status, no
    // durable-fallback lookup (a 404 isn't "the origin is down"). Short
    // Cache-Control (shortened further in plan-hit-rate.md Phase 1) so a bad
    // slug hammered repeatedly doesn't redo the KKPhim round-trip every time.
    if (err.status && err.status >= 400 && err.status < 500) {
      return new Response(method === 'HEAD' ? null : JSON.stringify({ error: err.message }), {
        status: err.status,
        headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=30' },
      });
    }

    let stale = null;
    try {
      stale = await readStale(env, url.pathname, cacheKey);
    } catch (readErr) {
      console.error('[stale read]', url.pathname, readErr.message);
    }
    if (stale != null) {
      // plan-hit-rate.md Phase 1: no s-maxage (SWR/stale-if-error need it
      // absent), not written to caches.default (that stays a Phase-3
      // negative-caching decision, see the system-design brief). `max-age=30`
      // so the zone edge revalidates quickly once the origin recovers;
      // `stale-if-error=86400` lets the zone keep serving this same stale
      // body if the NEXT request also fails at the Worker, instead of
      // surfacing a fresh error to the client on every single miss during an
      // extended outage.
      return new Response(method === 'HEAD' ? null : stale, {
        headers: {
          'content-type': 'application/json',
          'x-catalog-cache': 'stale-vps-down',
          'cache-control': 'public, max-age=30, stale-if-error=86400',
        },
      });
    }
    // Total failure — no live build, no durable fallback either. Shorter TTL
    // than the stale-vps-down branch above: that one still serves real (if
    // old) data, this one serves nothing, so recover from it faster. No
    // stale-if-error: there is no prior good response for THIS request to
    // fall back to.
    return new Response(method === 'HEAD' ? null : JSON.stringify({ error: 'catalog unavailable' }), {
      status: 502,
      headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=30' },
    });
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/__cron/shard/')) {
      const n = url.pathname.slice('/__cron/shard/'.length);
      return handleCronShard(request, env, ctx, n);
    }
    if (url.pathname === '/__cron/refresh-home') {
      return handleCronRefreshHome(request, env);
    }
    if (url.pathname === '/__cron/mirror') {
      return handleCronMirror(request, env);
    }
    if (url.pathname.startsWith('/__cron/mirror-shard/')) {
      const n = url.pathname.slice('/__cron/mirror-shard/'.length);
      return handleCronMirrorShard(request, env, n);
    }
    if (url.pathname.startsWith('/__cron/warm-shard/')) {
      const n = url.pathname.slice('/__cron/warm-shard/'.length);
      return handleCronWarmShard(request, env, ctx, n);
    }
    if (url.pathname === '/__cron/warm') {
      return handleCronWarmRefresh(request, env);
    }
    if (url.pathname === '/__cron/edge-warm') {
      return handleCronEdgeWarm(request, env);
    }
    if (url.pathname === '/__cron/purge-recs') {
      return handleCronPurgeRecs(request, env, url);
    }
    // Ahead of the /api/ branch on purpose: handleApi would put this behind the
    // Cache API, and a cached health check reports the past, not the present.
    if (url.pathname === '/api/health') {
      return handleHealth(env);
    }
    // Same reason — must reflect the CURRENT warm set, not a cached one.
    if (url.pathname === '/api/warm-targets') {
      return handleWarmTargets(env, url);
    }
    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, env, ctx, url);
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    // Three schedules share this handler (see wrangler.toml [triggers]);
    // dispatch by which one fired. Can coincide at :00/:30 — event.cron
    // disambiguates.
    if (event.cron === '0 * * * *') {
      ctx.waitUntil(runHomeRefresh(env));
      // Sweep expired idx (>45d) / recs rows in the same hourly cron (Phase 5).
      ctx.waitUntil(cleanupRecTables(env).catch((e) => console.error('[rec cleanup]', e.message)));
      // Sweep stale rows (>90d) — plan-hit-rate.md Phase 8 / ADR-0001 Action Item 8.
      ctx.waitUntil(cleanupStaleTable(env).catch((e) => console.error('[stale cleanup]', e.message)));
    }
    if (event.cron === '*/10 * * * *') {
      // Drain the R2 image-mirror queue, sharded (Phase 6, sharded further in
      // plan-hit-rate.md Phase 3 — 5x the single-shot throughput).
      ctx.waitUntil(runMirrorRefresh(env).catch((e) => console.error('[mirror refresh]', e.message)));
    }
    if (event.cron === '*/30 * * * *') {
      // Refresh the page:v1:* warm set (ADR-0001 Phase 4).
      ctx.waitUntil(runWarmRefresh(env).catch((e) => console.error('[warm refresh]', e.message)));
    }
  },
};
