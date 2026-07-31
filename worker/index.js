// worker/index.js — fronts the VPS catalog-api with a KV cache that survives
// the VPS being unreachable. See state.md Phase 3 for the full picture; the
// short version:
//
//   /api/*   → handled here: KV cache-aside in front of img.bluesia.net
//   anything else that isn't a static asset → env.ASSETS.fetch(request),
//              which applies wrangler.toml's not_found_handling (SPA fallback)
//
// Requests that match a literal file in dist/ never reach this script at all
// — Cloudflare's default asset routing serves those directly.
//
// Every /api/* response is written to KV under two keys: a short-TTL "live"
// key that drives normal freshness, and a TTL-less "stale" key that is the
// last-known-good copy. KV deletes keys outright once their TTL lapses, so the
// live key alone can't serve as a during-outage fallback past its own TTL —
// that's what the stale key is for.

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

async function handleApi(request, env, url) {
  if (request.method !== 'GET') {
    return new Response('Method not allowed', { status: 405 });
  }

  const cacheKey = url.pathname + url.search;
  const liveKey = `live:${cacheKey}`;
  const staleKey = `stale:${cacheKey}`;

  const live = await env.CATALOG_KV.get(liveKey);
  if (live != null) {
    return new Response(live, {
      headers: { 'content-type': 'application/json', 'x-catalog-cache': 'kv-live' },
    });
  }

  try {
    const res = await fetch(UPSTREAM + cacheKey, {
      headers: { 'user-agent': 'redflare-worker/1.0 (+phim.bluesia.net)' },
    });
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    const body = await res.text();

    // KV requires expirationTtl >= 60s.
    await env.CATALOG_KV.put(liveKey, body, { expirationTtl: Math.max(ttlFor(url.pathname), 60) });
    await env.CATALOG_KV.put(staleKey, body); // no TTL — the VPS-is-down fallback

    return new Response(body, {
      headers: { 'content-type': 'application/json', 'x-catalog-cache': 'miss' },
    });
  } catch (err) {
    const stale = await env.CATALOG_KV.get(staleKey);
    if (stale != null) {
      return new Response(stale, {
        headers: { 'content-type': 'application/json', 'x-catalog-cache': 'stale-vps-down' },
      });
    }
    return new Response(JSON.stringify({ error: 'catalog unavailable' }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, env, url);
    }
    return env.ASSETS.fetch(request);
  },
};
