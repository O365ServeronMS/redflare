// home.js — builds /api/home-data as 6 independently-invoked shards instead
// of catalog-api's single buildHomeData() (home.js on the VPS). Ported logic:
// getItems, buildTrendingItems (unchanged), the TMDB trending-window refresh
// (unchanged 6h TTL semantics, now via KV's native expirationTtl instead of a
// manual Valkey EX + age check).
//
// WHY SHARDED: the VPS's buildHomeData() does 10 OPhim fetches + 2 TMDB
// trending fetches + up to ~140 TMDB enrich calls in one process with no
// per-request budget. A Worker HTTP/Cron invocation gets 10ms CPU and 50
// external subrequests, TOTAL, no exceptions — nowhere close to enough for
// that in one shot. So this is split into 6 independent Worker invocations
// (each a real HTTP round-trip to this Worker's own /__cron/shard/:n route,
// NOT a function call — that's what gives each one its own separate 10ms/50
// budget), and an orchestrator (runHomeRefresh, called from a Cron Trigger)
// that fetches all 6 and concatenates their pre-serialized JSON as STRINGS —
// see buildHomePayload() below for why that matters.
//
// DELIBERATE DEVIATIONS FROM THE VPS VERSION (all documented in
// bluesiaOM/context/state-redflare-cf-worker.md Phase 4 log — read that
// before assuming a difference from VPS output is a bug):
//
// 1. Hero (shard 4) and trending (shard 5) each independently re-fetch the
//    FULL 10-URL pool (all 6 categories: new/le/bo/hoatHinh/auMy/cinema),
//    matching the VPS's pool composition exactly, rather than only their
//    "own" category — an earlier version tried single-source pools (au-my
//    only for hero, cinema only for trending) to save subrequests, but that
//    measured 6-10 matched items against a live VPS baseline of 13-15 for
//    the same window — a real usability loss, not a rounding difference.
//    Budget re-checked: 10 OPhim + <=2 TMDB-trending + <=24 enrich = <=36,
//    still comfortably under 50/invocation. Costs some duplicate OPhim
//    fetching across shards (each of the 10 URLs gets fetched by its own
//    card-rail shard AND once each by shards 4 and 5) — OPhim isn't
//    rate-limited or billed, so that's a non-issue.
// 2. newMovies drops `pagination`/`pathImage` (confirmed unused by
//    src/main.js — grepped before removing).
// 3. idx/mirror_queue population (VPS side effect of every signed payload)
//    is NOT done here — deferred entirely to Phase 5/6, which own populating
//    AND consuming those tables as one verified unit, rather than splitting
//    "write" (here, unverifiable in isolation) from "read" (Phase 5/6).

import { createEnrich } from './enrich.js';
import { mapItemsImages } from './images.js';

const OPHIM_BASE = 'https://ophim1.com';

const HERO_COUNT = 20;
const TRENDING_COUNT = 24;

const TRENDING_WEEK_KEY = 'trending:week';
const TRENDING_DAY_KEY = 'trending:day';
const TRENDING_TTL = 6 * 60 * 60; // seconds — matches the VPS's 6h window

export const HOME_KV_KEY = 'home:current';

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

// Handles both OPhim list-payload shapes (mirrors home.js's getItems).
function getItems(payload) {
  return payload?.data?.items || payload?.items || [];
}

// The full pool the VPS matches hero/trending against — see the module
// comment's deviation note #1. Bounded to 6 concurrent fetches (Workers free
// plan's simultaneous-outgoing-connection cap), not Promise.all(10) directly.
const POOL_URLS = [
  `${OPHIM_BASE}/danh-sach/phim-moi-cap-nhat?page=1`,
  `${OPHIM_BASE}/v1/api/danh-sach/phim-le?page=1`,
  `${OPHIM_BASE}/v1/api/danh-sach/phim-bo?page=1`,
  `${OPHIM_BASE}/v1/api/danh-sach/hoat-hinh?page=1`,
  `${OPHIM_BASE}/v1/api/quoc-gia/au-my?page=1`,
  `${OPHIM_BASE}/v1/api/quoc-gia/au-my?page=2`,
  `${OPHIM_BASE}/v1/api/quoc-gia/au-my?page=3`,
  `${OPHIM_BASE}/v1/api/danh-sach/phim-chieu-rap?page=1`,
  `${OPHIM_BASE}/v1/api/danh-sach/phim-chieu-rap?page=2`,
  `${OPHIM_BASE}/v1/api/danh-sach/phim-chieu-rap?page=3`,
];
const POOL_FETCH_CONCURRENCY = 6;

async function fetchPool() {
  const results = new Array(POOL_URLS.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(POOL_FETCH_CONCURRENCY, POOL_URLS.length) }, async () => {
    while (i < POOL_URLS.length) {
      const idx = i++;
      try {
        results[idx] = getItems(await fetchOphimJson(POOL_URLS[idx]));
      } catch (err) {
        console.error('[home pool]', POOL_URLS[idx], err.message);
        results[idx] = [];
      }
    }
  });
  await Promise.all(workers);
  return results.flat();
}

// KV's own expirationTtl does the "refresh only if >6h old" job for free: a
// GET on an expired key returns null, which triggers a refresh below; a GET
// on a still-valid key returns the cached ids and skips TMDB entirely.
async function getOrRefreshTrendingIds(env, window, kvKey) {
  const cached = await env.CATALOG_KV.get(kvKey);
  if (cached) {
    try {
      const ids = JSON.parse(cached);
      if (Array.isArray(ids)) return ids;
    } catch {
      /* fall through to refresh */
    }
  }
  if (!env.TMDB_API_TOKEN) return [];

  const headers = { Authorization: `Bearer ${env.TMDB_API_TOKEN}`, accept: 'application/json' };
  const pages = await Promise.all(
    [1, 2].map(async (page) => {
      const res = await fetch(
        `https://api.themoviedb.org/3/trending/all/${window}?language=en-US&page=${page}`,
        { headers }
      );
      if (!res.ok) throw new Error(`TMDB trending ${window} upstream ${res.status}`);
      return res.json();
    })
  );
  const results = pages.flatMap((data) => (Array.isArray(data?.results) ? data.results : []));
  const ids = [
    ...new Set(
      results
        .filter((item) => item?.media_type === 'movie' || item?.media_type === 'tv')
        .map((item) => (item?.id != null ? String(item.id) : null))
        .filter(Boolean)
    ),
  ];
  await env.CATALOG_KV.put(kvKey, JSON.stringify(ids), { expirationTtl: TRENDING_TTL });
  return ids;
}

// Match an ordered list of TMDB ids to catalog items, emitting in TMDB rank
// order — direct port of home.js's buildTrendingItems, unchanged.
function buildTrendingItems(itemGroups, orderedIds, limit) {
  if (!orderedIds || orderedIds.length === 0) return [];
  const byTmdbId = new Map();
  for (const group of itemGroups) {
    for (const item of group) {
      const id = item?.tmdb?.id;
      if (id == null || !item?.slug) continue;
      const tmdbKey = String(id);
      if (!byTmdbId.has(tmdbKey)) byTmdbId.set(tmdbKey, item);
    }
  }
  const picked = [];
  const seenSlug = new Set();
  for (const id of orderedIds) {
    const item = byTmdbId.get(String(id));
    if (!item || seenSlug.has(item.slug)) continue;
    seenSlug.add(item.slug);
    picked.push(item);
    if (picked.length >= limit) break;
  }
  return picked;
}

// --- Per-shard builders. Each returns a JS array (caller decides whether to
// serialize) so buildHomeFallback() below can reuse the same pipeline. ---

async function buildCardRail(env, upstreamUrl) {
  const enrich = createEnrich(env);
  const data = await fetchOphimJson(upstreamUrl);
  const items = getItems(data);
  await enrich.enrichItemsCards(items);
  return mapItemsImages(items);
}

async function buildHeroShard(env) {
  const enrich = createEnrich(env);
  const pool = await fetchPool();
  const weekIds = await getOrRefreshTrendingIds(env, 'week', TRENDING_WEEK_KEY);
  const hero = buildTrendingItems([pool], weekIds, HERO_COUNT);
  await enrich.enrichItemsCards(hero);
  return mapItemsImages(hero);
}

async function buildTrendingShard(env) {
  const enrich = createEnrich(env);
  const pool = await fetchPool();
  const dayIds = await getOrRefreshTrendingIds(env, 'day', TRENDING_DAY_KEY);
  const trending = buildTrendingItems([pool], dayIds, TRENDING_COUNT);
  await enrich.enrichItemsCards(trending);
  return mapItemsImages(trending);
}

// Shard budget per invocation (all well under the free plan's 50 external
// subrequests/invocation):
//   0-3 (card rails): 1 OPhim + <=24 TMDB enrich           = <=25
//   4   (hero):       10 OPhim + <=2 TMDB trending + <=20  = <=32
//   5   (trending):   10 OPhim + <=2 TMDB trending + <=24  = <=36
export const CRON_SHARD_BUILDERS = {
  0: (env) => buildCardRail(env, `${OPHIM_BASE}/danh-sach/phim-moi-cap-nhat?page=1`),
  1: (env) => buildCardRail(env, `${OPHIM_BASE}/v1/api/danh-sach/phim-le?page=1`),
  2: (env) => buildCardRail(env, `${OPHIM_BASE}/v1/api/danh-sach/phim-bo?page=1`),
  3: (env) => buildCardRail(env, `${OPHIM_BASE}/v1/api/danh-sach/hoat-hinh?page=1`),
  4: (env) => buildHeroShard(env),
  5: (env) => buildTrendingShard(env),
};

// --- Orchestrator: calls all 6 shards through the SELF service binding
// (each still gets its own independent invocation budget — a function call
// would NOT), then concatenates their pre-serialized JSON as STRINGS.
// Parsing 6 fragments and re-stringifying a combined ~150KB object here
// would cost 3-5ms of CPU on its own, eating most of this invocation's 10ms
// budget for no reason — the whole point of shipping each shard as raw JSON
// text.
//
// Why a service binding (env.SELF) and not a plain fetch() to
// https://phim.bluesia.net/...: Cloudflare Workers on a Custom Domain
// return a 522 for a fetch() to their own hostname — documented platform
// behavior, confirmed by reproducing it 2026-08-01 (see wrangler.toml's
// [[services]] comment). A service binding routes directly to this
// Worker's own fetch handler without touching the public network, so the
// self-hostname restriction doesn't apply.

async function callShard(env, n) {
  const res = await env.SELF.fetch(`https://phim.bluesia.net/__cron/shard/${n}`, {
    headers: { 'x-cron-key': env.CRON_KEY },
  });
  if (!res.ok) throw new Error(`shard ${n} failed: ${res.status}`);
  return res.text();
}

export async function runHomeRefresh(env) {
  try {
    const s0 = await callShard(env, 0);
    const s1 = await callShard(env, 1);
    const s2 = await callShard(env, 2);
    const s3 = await callShard(env, 3);
    const s4 = await callShard(env, 4);
    const s5 = await callShard(env, 5);

    const body =
      '{"timestamp":' + Date.now() +
      ',"heroMovies":' + s4 +
      ',"newMovies":{"items":' + s0 + '}' +
      ',"phimLe":{"items":' + s1 + '}' +
      ',"phimBo":{"items":' + s2 + '}' +
      ',"hoatHinh":{"items":' + s3 + '}' +
      ',"trending":{"items":' + s5 + '}}';

    // A failed shard throws before this line, so a partial/broken home
    // payload never overwrites the last good one — see runHomeRefresh's
    // catch below.
    await env.CATALOG_KV.put(HOME_KV_KEY, body);
    console.log('[home refresh] ok, bytes=', body.length);
    return { ok: true, bytes: body.length };
  } catch (err) {
    // Deliberately don't touch HOME_KV_KEY on failure — a stale-but-complete
    // home page beats a fresh-but-broken one. Next cron tick (or a manual
    // /__cron/refresh-home call) retries from scratch.
    console.error('[home refresh] failed, keeping previous home:current:', err.message);
    return { ok: false, error: err.message };
  }
}

// --- Bootstrap fallback: only reached if HOME_KV_KEY has never been written
// (fresh deploy, before the first successful cron cycle). Cheap on purpose —
// reuses the newMovies fetch+enrich (already budget-safe) and uses its first
// 20 items as a hero stand-in (zero extra subrequests) rather than doing the
// full trending-matched hero pipeline synchronously on a user's request. The
// real trending-matched hero replaces this the moment cron completes once. ---

export async function buildHomeFallback(env) {
  const mapped = await buildCardRail(env, `${OPHIM_BASE}/danh-sach/phim-moi-cap-nhat?page=1`);
  return {
    timestamp: Date.now(),
    heroMovies: mapped.slice(0, HERO_COUNT),
    newMovies: { items: mapped },
    phimLe: { items: [] },
    phimBo: { items: [] },
    hoatHinh: { items: [] },
    trending: { items: [] },
  };
}
