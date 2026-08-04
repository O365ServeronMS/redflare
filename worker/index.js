// worker/index.js — fronts the VPS catalog-api with a caching layer that
// survives the VPS being unreachable. See bluesiaOM/context/state-redflare-cf-worker.md
// for the full migration state. Short version of what this file does today:
//
//   /api/list, /api/genre, /api/country, /api/search, /api/movie/:slug
//              → built HERE: fetch OPhim directly, enrich with TMDB
//              (worker/lib/enrich.js), map images to R2 (worker/lib/images.js).
//              No VPS involved on a cache miss (Phase 3).
//   /api/home-data
//              → built HERE too, but NOT per-request (Phase 4). A Cron
//              Trigger (scheduled() below) rebuilds it hourly across 6
//              sharded invocations (worker/lib/home.js) and stores the
//              result in KV; this route just reads that KV key. See
//              worker/lib/home.js for why home-data can't be built
//              synchronously per-request the way list/genre/etc. are.
//   /api/recommendation/:type/:id, /api/related/:type/:id, /api/related/:id
//              → built HERE (Phase 5): TMDB recommendations matched to OPhim
//              via a tmdb.id → item reverse index in D1 (table `idx`), with a
//              bounded live OPhim search fallback, cached in D1 table `recs`
//              with a 3-tier TTL based on result completeness (30d full / 6h
//              partial / 1h empty — see worker/lib/recommendation.js
//              classifyTier/ttlForTier, added in the Phase 1 fix for
//              bluesiaOM/context/state-sua-loi-recommendation.md).
//   /__cron/purge-recs?type=&id=
//              → internal, gated by CRON_KEY like the other /__cron/* routes.
//              Evicts one title's recommendation cache at BOTH layers (D1
//              `recs` and the Cache API) — see handleCronPurgeRecs below for
//              why both are required.
//   /__cron/shard/:n, /__cron/refresh-home, /__cron/mirror
//              → internal, gated by the CRON_KEY secret. Not part of the
//              public API surface — see worker/lib/home.js and
//              worker/lib/mirror.js. The shards also opportunistically populate
//              the `idx` reverse index; the hourly cron sweeps expired idx/recs
//              rows; a */10 cron drains the R2 image-mirror queue (Phase 6).
//   /__cron/backfill-webp
//              → internal, gated by CRON_KEY. One-off (WebP migration Phase 2,
//              see state.md): enqueues a `.webp` mirror target for every
//              pre-Phase-1 jpg key in D1 `mirrored`, plus a `w154` variant of
//              each `w500` poster key. Drains through the normal mirror cron.
//   /__cron/rekey-webp
//              → internal, gated by CRON_KEY. Key-shape migration Phase A
//              (see git log / CLAUDE.md "Images"): forces a batch of the
//              `.jpg.webp` -> `.webp` in-bucket re-key on demand. Also runs
//              unattended every */10 tick alongside the mirror drain
//              (worker/lib/mirror.js drainRekeyBatch) — no manual trigger
//              needed for the migration itself, this route just forces a
//              batch immediately instead of waiting for the next tick.
//   Images: every build (list/detail/home/rec) enqueues its artwork into the
//              `mirror_queue` D1 table; the mirror cron copies them into R2 via
//              the binding (worker/lib/mirror.js) — the VPS no longer mirrors.
//   anything else that isn't a static asset → env.ASSETS.fetch(request),
//              which applies wrangler.toml's not_found_handling (SPA fallback)
//
// Every /api/* response (built here or proxied) goes through the SAME
// caching shell: Cache API (hot tier, no daily write quota — see the Phase 2
// note below) in front, with a durable last-known-good fallback (D1 for
// list/genre/country/movie/recommendation, nothing for search) for when the
// origin (OPhim/TMDB directly, or the VPS) is unreachable. /api/home-data no
// longer goes through that generic fallback — see handleHomeData() below,
// its durable copy IS the KV value the cron maintains, there's no separate
// "upstream fetch failed" case to fall back from anymore.
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
import { mapItemsImages, mapItemImages, mirrorTargets, webpBackfillTargets } from './lib/images.js';
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
import { enqueueMirror, drainMirrorQueue, drainRekeyBatch } from './lib/mirror.js';

const UPSTREAM = 'https://img.bluesia.net';
const OPHIM_BASE = 'https://ophim1.com';

// Mirrors catalog-api's own Valkey TTLs (catalog-api/src/server.js) — no
// reason to diverge, OPhim/TMDB freshness expectations haven't changed just
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

const HOME_PATH = '/api/home-data';

function isSearch(pathname) {
  return pathname.startsWith('/api/search');
}

// --- OPhim fetch + local list/detail builders (Phase 3) ---------------------
// Ported from catalog-api/src/server.js's route handlers. Each builder does
// exactly one OPhim fetch, then enrich.enrichListPayload/enrichDetailPayload
// (up to ~24 TMDB fetches, bounded to 6 concurrent — worker/lib/enrich.js)
// runs against it. Worst case subrequest budget for a 24-item page: 1 OPhim +
// 24 TMDB meta + (rare) up to 24 IMDB-resolve fallbacks = 49, under the free
// plan's 50/invocation cap — see state.md Phase 3 log for how this was sized.

function httpError(message, status) {
  return Object.assign(new Error(message), { status });
}

async function fetchOphimJson(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': 'redflare-worker/1.0 (+phim.bluesia.net)' },
  });
  if (!res.ok) throw httpError(`OPhim upstream ${res.status}`, res.status);
  return res.json();
}

// Map images inside an OPhim list payload ({ items } or { data: { items } }),
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
  const data = await fetchOphimJson(upstreamUrl);
  await enrich.enrichListPayload(data);
  return mapListPayloadImages(data);
}

// Resolve a request the Worker now builds itself. Returns a zero-arg async
// builder function, or null to fall through to the VPS proxy. home-data and
// recommendation are intercepted in handleApi() before this is ever called
// (unless LEGACY_UPSTREAM=1, in which case everything falls through here to
// null → proxy).
function localBuilder(env, url) {
  const pathname = url.pathname;

  if (pathname === '/api/list') {
    const type = url.searchParams.get('type') || '';
    const page = url.searchParams.get('page') || '1';
    if (!type) throw httpError('Missing type', 400);
    const upstream = type === 'phim-moi-cap-nhat'
      ? `${OPHIM_BASE}/danh-sach/phim-moi-cap-nhat?page=${page}`
      : `${OPHIM_BASE}/v1/api/danh-sach/${type}?page=${page}`;
    return () => buildEnrichedList(createEnrich(env), upstream);
  }

  if (pathname === '/api/genre') {
    const slug = url.searchParams.get('slug') || '';
    const page = url.searchParams.get('page') || '1';
    if (!slug) throw httpError('Missing slug', 400);
    return () =>
      buildEnrichedList(createEnrich(env), `${OPHIM_BASE}/v1/api/the-loai/${slug}?page=${page}`);
  }

  if (pathname === '/api/country') {
    const slug = url.searchParams.get('slug') || '';
    const page = url.searchParams.get('page') || '1';
    if (!slug) throw httpError('Missing slug', 400);
    return () =>
      buildEnrichedList(createEnrich(env), `${OPHIM_BASE}/v1/api/quoc-gia/${slug}?page=${page}`);
  }

  if (pathname === '/api/search') {
    const keyword = (url.searchParams.get('keyword') || '').trim();
    const page = url.searchParams.get('page') || '1';
    if (keyword.length < 2) return async () => ({ data: { items: [] } });
    return () =>
      buildEnrichedList(
        createEnrich(env),
        `${OPHIM_BASE}/v1/api/tim-kiem?keyword=${encodeURIComponent(keyword)}&page=${page}`
      );
  }

  if (pathname.startsWith('/api/movie/')) {
    const slug = pathname.slice('/api/movie/'.length);
    if (!slug) throw httpError('Missing slug', 400);
    return async () => {
      const enrich = createEnrich(env);
      const data = await fetchOphimJson(`${OPHIM_BASE}/phim/${slug}`);
      await enrich.enrichDetailPayload(data);
      return mapDetailPayloadImages(data);
    };
  }

  return null; // recommendation, related -> proxy to VPS
}

// --- Durable last-known-good read/write for list/genre/country/movie
// (unchanged from Phase 2/3). home-data (KV, see handleHomeData) and
// recommendation (D1 `recs`, see handleRecommendation) have their own durable
// layers and no longer flow through this generic `stale` table — except when
// LEGACY_UPSTREAM=1 routes them back through the proxy path below. ---

async function readStale(env, pathname, cacheKey) {
  if (isSearch(pathname)) return null;
  const row = await env.DB.prepare('SELECT body FROM stale WHERE path = ?1').bind(cacheKey).first();
  return row ? row.body : null;
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
// maintains — no per-request OPhim/TMDB fetch, no JSON.parse of the ~150KB
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
    // window don't each redo the same OPhim fetch; the next successful cron
    // cycle overwrites this with the real trending-matched build regardless.
    ctx.waitUntil(env.CATALOG_KV.put(HOME_KV_KEY, body));
  }

  const cacheableRes = new Response(body, {
    headers: {
      'content-type': 'application/json',
      'x-catalog-cache': cacheStatus,
      'cache-control': 'public, s-maxage=1800',
    },
  });
  ctx.waitUntil(cache.put(cacheReq, cacheableRes.clone()));

  return new Response(method === 'HEAD' ? null : body, {
    headers: { 'content-type': 'application/json', 'x-catalog-cache': cacheStatus },
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

  const cacheableRes = new Response(body, {
    headers: {
      'content-type': 'application/json',
      'x-catalog-cache': cacheStatus,
      'cache-control': `public, s-maxage=${ttl}`,
    },
  });
  ctx.waitUntil(cache.put(cacheReq, cacheableRes.clone()));

  return new Response(method === 'HEAD' ? null : body, {
    headers: { 'content-type': 'application/json', 'x-catalog-cache': cacheStatus },
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

// Manual trigger for the R2 mirror drain — same call the */10 cron makes.
// Exposed so a drain can be forced on demand (verifying Phase 6 without waiting
// for the cron tick).
async function handleCronMirror(request, env) {
  if (!checkCronKey(request, env)) return new Response('Not found', { status: 404 });
  const result = await drainMirrorQueue(env);
  return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
}

// Manual trigger for the R2 re-key drain (.jpg.webp -> .webp key-shape
// migration, Phase A) — same call the */10 cron makes. Exposed to force a
// batch on demand without waiting for the cron tick.
async function handleCronRekeyWebp(request, env) {
  if (!checkCronKey(request, env)) return new Response('Not found', { status: 404 });
  const result = await drainRekeyBatch(env);
  return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
}

// One-off: enqueue WebP (+ w154 poster) targets for every jpg-shaped key
// already in D1 `mirrored` from before Phase 1 shipped. Drains through the
// normal */10 mirror cron like any other queued target — this route only
// enqueues, it doesn't fetch/put itself. See state.md Phase 2. Safe to call
// more than once: enqueueMirror skips keys already in `mirrored`, and this
// route's own SELECT already excludes keys ending `.webp`.
async function handleCronBackfillWebp(request, env) {
  if (!checkCronKey(request, env)) return new Response('Not found', { status: 404 });
  const { results } = await env.DB.prepare(
    "SELECT key FROM mirrored WHERE key NOT LIKE '%.webp' AND key NOT LIKE 'ophim/%'"
  ).all();
  const keys = (results || []).map((r) => r.key);
  const targets = webpBackfillTargets(keys);
  await enqueueMirror(env, targets);
  return new Response(JSON.stringify({ scanned: keys.length, queued: targets.length }), {
    headers: { 'content-type': 'application/json' },
  });
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

async function handleApi(request, env, ctx, url) {
  const method = request.method;
  if (method !== 'GET' && method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405 });
  }

  const cache = caches.default;
  const cacheReq = new Request(url.toString(), { method: 'GET' });

  const hit = await cache.match(cacheReq);
  if (hit) {
    const headers = new Headers(hit.headers);
    headers.set('x-catalog-cache', 'hit');
    return new Response(method === 'HEAD' ? null : hit.body, { headers, status: hit.status });
  }

  // LEGACY_UPSTREAM=1 pulls home-data AND recommendation back into the generic
  // proxy path below (falls through to `fetch(UPSTREAM + cacheKey)`, build
  // stays null since localBuilder doesn't know these paths either) — one flag
  // for "go back to full VPS dependency", covering Phase 3/4/5 at once.
  if (env.LEGACY_UPSTREAM !== '1') {
    if (url.pathname === HOME_PATH) {
      return handleHomeData(env, ctx, cache, cacheReq, method);
    }
    const rec = parseRecommendationPath(url.pathname);
    if (rec) {
      return handleRecommendation(env, ctx, cache, cacheReq, method, rec.type, rec.tmdbId);
    }
  }

  const cacheKey = url.pathname + url.search;
  const ttl = ttlFor(url.pathname);

  // env.LEGACY_UPSTREAM = '1' forces every path back through the VPS proxy,
  // bypassing the local builders below entirely — the documented Phase 3
  // rollback, no redeploy needed (just `wrangler deploy --var LEGACY_UPSTREAM:1`
  // or flip it in the dashboard).
  let build = null;
  try {
    build = env.LEGACY_UPSTREAM === '1' ? null : localBuilder(env, url);
  } catch (err) {
    // Thrown synchronously by localBuilder for a malformed request (missing
    // required query param) — matches catalog-api's own validation, which
    // also returns 4xx directly with no caching.
    return new Response(JSON.stringify({ error: err.message }), {
      status: err.status || 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  try {
    let body;
    if (build) {
      const payload = await build();
      body = JSON.stringify(payload);
      const items =
        payload?.data?.items ||
        payload?.items ||
        [payload?.data?.item || payload?.item || payload?.movie].filter(Boolean);
      // Opportunistically index a freshly-built movie detail into the `idx`
      // reverse index (Phase 5) so recommendations can resolve it by tmdb.id
      // without a live OPhim search — same side effect the VPS did on every
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
    } else {
      const res = await fetch(UPSTREAM + cacheKey, {
        headers: { 'user-agent': 'redflare-worker/1.0 (+phim.bluesia.net)' },
      });
      if (!res.ok) throw new Error(`upstream ${res.status}`);
      body = await res.text();
    }

    const cacheableRes = new Response(body, {
      headers: {
        'content-type': 'application/json',
        'x-catalog-cache': 'miss',
        'cache-control': `public, s-maxage=${ttl}`,
      },
    });
    ctx.waitUntil(cache.put(cacheReq, cacheableRes.clone()));
    ctx.waitUntil(Promise.resolve(writeStale(env, url.pathname, cacheKey, body)).catch((err) => {
      console.error('[stale write]', url.pathname, err.message);
    }));

    return new Response(method === 'HEAD' ? null : body, {
      headers: { 'content-type': 'application/json', 'x-catalog-cache': 'miss' },
    });
  } catch (err) {
    // A genuine 4xx from OPhim itself (e.g. an unknown genre/country slug) —
    // matches catalog-api's own behavior: return the real status, no caching,
    // no durable-fallback lookup (a 404 isn't "the origin is down").
    if (err.status && err.status >= 400 && err.status < 500) {
      return new Response(method === 'HEAD' ? null : JSON.stringify({ error: err.message }), {
        status: err.status,
        headers: { 'content-type': 'application/json' },
      });
    }

    let stale = null;
    try {
      stale = await readStale(env, url.pathname, cacheKey);
    } catch (readErr) {
      console.error('[stale read]', url.pathname, readErr.message);
    }
    if (stale != null) {
      return new Response(method === 'HEAD' ? null : stale, {
        headers: { 'content-type': 'application/json', 'x-catalog-cache': 'stale-vps-down' },
      });
    }
    return new Response(method === 'HEAD' ? null : JSON.stringify({ error: 'catalog unavailable' }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
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
    if (url.pathname === '/__cron/backfill-webp') {
      return handleCronBackfillWebp(request, env);
    }
    if (url.pathname === '/__cron/rekey-webp') {
      return handleCronRekeyWebp(request, env);
    }
    if (url.pathname === '/__cron/purge-recs') {
      return handleCronPurgeRecs(request, env, url);
    }
    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, env, ctx, url);
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    // Two schedules share this handler (see wrangler.toml [triggers]); dispatch
    // by which one fired. Both can coincide at :00 — event.cron disambiguates.
    if (event.cron === '0 * * * *') {
      ctx.waitUntil(runHomeRefresh(env));
      // Sweep expired idx (>45d) / recs rows in the same hourly cron (Phase 5).
      ctx.waitUntil(cleanupRecTables(env).catch((e) => console.error('[rec cleanup]', e.message)));
    }
    if (event.cron === '*/10 * * * *') {
      // Drain the R2 image-mirror queue (Phase 6).
      ctx.waitUntil(drainMirrorQueue(env).catch((e) => console.error('[mirror drain]', e.message)));
      // Drain the .jpg.webp -> .webp re-key batch (key-shape migration Phase
      // A). Runs unattended alongside the mirror drain; once every
      // `mirrored` row ends in .webp with no .jpg.webp left, this becomes a
      // no-op every tick (drainRekeyBatch returns immediately) until the
      // route/hook is removed in Phase C.
      ctx.waitUntil(drainRekeyBatch(env).catch((e) => console.error('[rekey drain]', e.message)));
    }
  },
};
