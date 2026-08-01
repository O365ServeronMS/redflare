// worker/index.js — fronts the VPS catalog-api with a caching layer that
// survives the VPS being unreachable. See bluesiaOM/context/state-redflare-cf-worker.md
// for the full migration state. Short version of what this file does today:
//
//   /api/list, /api/genre, /api/country, /api/search, /api/movie/:slug
//              → built HERE: fetch OPhim directly, enrich with TMDB
//              (worker/lib/enrich.js), map images to R2 (worker/lib/images.js).
//              No VPS involved on a cache miss (Phase 3).
//   /api/home-data, /api/recommendation/*, /api/related/*
//              → still proxied to the VPS catalog-api (img.bluesia.net) —
//              Phase 4 (home) and Phase 5 (recommendation) move these later.
//   anything else that isn't a static asset → env.ASSETS.fetch(request),
//              which applies wrangler.toml's not_found_handling (SPA fallback)
//
// Every /api/* response (built here or proxied) goes through the SAME
// caching shell: Cache API (hot tier, no daily write quota — see the Phase 2
// note below) in front, with a durable last-known-good fallback (KV for
// home-data, D1 for everything else except search) for when the origin
// (OPhim/TMDB directly, or the VPS) is unreachable.
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
//
// KV is used for exactly one thing: a single durable copy of /api/home-data.
// D1 holds the durable fallback for list/genre/country/movie/recommendation
// (table `stale`, migrations/0001_stale.sql). /api/search intentionally gets
// NO durable fallback: with unbounded keyword cardinality, persisting every
// query forever isn't safe on any quota, and a search miss during an outage
// degrading to empty results is an acceptable trade-off.

import { createEnrich } from './lib/enrich.js';
import { mapItemsImages, mapItemImages } from './lib/images.js';

const UPSTREAM = 'https://img.bluesia.net';
const OPHIM_BASE = 'https://ophim1.com';

// Mirrors catalog-api's own Valkey TTLs (catalog-api/src/server.js) — no
// reason to diverge, OPhim/TMDB freshness expectations haven't changed just
// because the fetch now happens here instead of on the VPS.
const TTL = {
  home: 30 * 60,
  movie: 60 * 60,
  search: 10 * 60,
  recommendation: 30 * 24 * 60 * 60,
  list: 30 * 60,
};

function ttlFor(pathname) {
  if (pathname === '/api/home-data') return TTL.home;
  if (pathname.startsWith('/api/movie/')) return TTL.movie;
  if (pathname.startsWith('/api/search')) return TTL.search;
  if (pathname.startsWith('/api/recommendation/') || pathname.startsWith('/api/related/')) {
    return TTL.recommendation;
  }
  return TTL.list; // list, genre, country
}

const HOME_PATH = '/api/home-data';
const HOME_KV_KEY = 'home:last-known-good';

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
// builder function, or null if this path should still be proxied to the VPS
// (home-data, recommendation, related — untouched in this phase).
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

  return null; // home-data, recommendation, related -> proxy to VPS
}

// --- Durable last-known-good read/write, split by path (unchanged from Phase 2) ---

async function readStale(env, pathname, cacheKey) {
  if (pathname === HOME_PATH) return env.CATALOG_KV.get(HOME_KV_KEY);
  if (isSearch(pathname)) return null;
  const row = await env.DB.prepare('SELECT body FROM stale WHERE path = ?1').bind(cacheKey).first();
  return row ? row.body : null;
}

function writeStale(env, pathname, cacheKey, body) {
  if (pathname === HOME_PATH) return env.CATALOG_KV.put(HOME_KV_KEY, body);
  if (isSearch(pathname)) return Promise.resolve();
  return env.DB.prepare(
    'INSERT INTO stale (path, body, updated_at) VALUES (?1, ?2, ?3) ' +
      'ON CONFLICT(path) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at'
  )
    .bind(cacheKey, body, Date.now())
    .run();
}

async function handleApi(request, env, ctx, url) {
  const method = request.method;
  if (method !== 'GET' && method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405 });
  }

  const cacheKey = url.pathname + url.search;
  const ttl = ttlFor(url.pathname);

  // Cache API keys are matched by request, always as GET so HEAD reuses the
  // same entry a prior GET populated (and vice versa).
  const cache = caches.default;
  const cacheReq = new Request(url.toString(), { method: 'GET' });

  const hit = await cache.match(cacheReq);
  if (hit) {
    const headers = new Headers(hit.headers);
    headers.set('x-catalog-cache', 'hit');
    return new Response(method === 'HEAD' ? null : hit.body, { headers, status: hit.status });
  }

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
    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, env, ctx, url);
    }
    return env.ASSETS.fetch(request);
  },
};
