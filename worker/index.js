// worker/index.js — fronts the VPS catalog-api with a caching layer that
// survives the VPS being unreachable. See bluesiaOM/context/state-redflare-cf-worker.md
// for the full migration state. Short version of what this file does today:
//
//   /api/*   → handled here: Cache API (hot tier) in front of img.bluesia.net,
//              with a durable last-known-good fallback (KV for home-data, D1
//              for everything else except search) for when the VPS is down.
//   anything else that isn't a static asset → env.ASSETS.fetch(request),
//              which applies wrangler.toml's not_found_handling (SPA fallback)
//
// Requests that match a literal file in dist/ never reach this script at all
// — Cloudflare's default asset routing serves those directly.
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
// KV is used for exactly one thing: a single durable copy of /api/home-data
// (~24-48 writes/day at a 30-60 min refresh cadence). D1 holds the durable
// fallback for list/genre/country/movie/recommendation (table `stale`,
// migrations/0001_stale.sql) — D1's free write quota is 100,000/day, comfortably
// above what that bounded set of paths can generate. /api/search intentionally
// gets NO durable fallback: with unbounded keyword cardinality, persisting
// every query forever isn't safe on any quota, and a search miss during a VPS
// outage degrading to empty results is an acceptable trade-off.

const UPSTREAM = 'https://img.bluesia.net';

// Mirrors catalog-api's own Valkey TTLs (catalog-api/src/server.js) — no
// reason to diverge, the VPS is still the source of truth for freshness.
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

function jsonResponse(body, extraHeaders) {
  return new Response(body, {
    headers: { 'content-type': 'application/json', ...extraHeaders },
  });
}

// Durable last-known-good read/write, split by path per the comment above.
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

  try {
    const res = await fetch(UPSTREAM + cacheKey, {
      headers: { 'user-agent': 'redflare-worker/1.0 (+phim.bluesia.net)' },
    });
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    const body = await res.text();

    const cacheableRes = jsonResponse(body, {
      'x-catalog-cache': 'miss',
      'cache-control': `public, s-maxage=${ttl}`,
    });
    ctx.waitUntil(cache.put(cacheReq, cacheableRes.clone()));
    ctx.waitUntil(Promise.resolve(writeStale(env, url.pathname, cacheKey, body)).catch((err) => {
      console.error('[stale write]', url.pathname, err.message);
    }));

    return new Response(method === 'HEAD' ? null : body, {
      headers: { 'content-type': 'application/json', 'x-catalog-cache': 'miss' },
    });
  } catch (err) {
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
