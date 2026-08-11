/**
 * Catalog API client
 * Base: same-origin /api/* — the Worker (worker/index.js) builds every catalog
 * response itself (KKPhim + TMDB, cached in Cache API / KV / D1). There is no
 * VPS behind it any more; the old VPS host was img.bluesia.net (retired
 * 2026-08-01), a different thing from the R2 image host reusing that same
 * hostname since the 2026-08 domain migration — see R2_BASE below.
 */

// Empty on purpose: every call site below already prefixes its path with
// '/api/...', so this just makes the fetch same-origin relative.
const CATALOG_BASE = '';

// Simple in-memory cache with TTL (5 minutes)
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

function getCached(key) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.time < CACHE_TTL) return entry.data;
  cache.delete(key);
  return null;
}

function setCache(key, data) {
  cache.set(key, { data, time: Date.now() });
}

async function fetchJson(url) {
  const cached = getCached(url);
  if (cached) return cached;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`API Error: ${res.status} ${res.statusText}`);
  const data = await res.json();
  setCache(url, data);
  return data;
}

/**
 * Get newly updated movies
 * @param {number} page
 * @returns {Promise<{items: Array, pagination: Object}>}
 */
export async function getNewMovies(page = 1) {
  const data = await fetchJson(`${CATALOG_BASE}/api/list?type=phim-moi-cap-nhat&page=${page}`);
  return {
    items: data.items || [],
    pagination: data.pagination || {},
  };
}

/**
 * Get movies by type (phim-le, phim-bo, hoat-hinh, tv-shows)
 * @param {string} type
 * @param {number} page
 * @returns {Promise<{items: Array, pagination: Object, titlePage: string}>}
 */
export async function getMoviesByType(type, page = 1) {
  const data = await fetchJson(`${CATALOG_BASE}/api/list?type=${type}&page=${page}`);
  const d = data.data || data;
  return {
    items: (d.items || []).map(normalizeListItem),
    pagination: d.params?.pagination || {},
    titlePage: d.titlePage || type,
    breadCrumb: d.breadCrumb || [],
    seoOnPage: d.seoOnPage || {},
  };
}

/**
 * Get home-page data (hero ranking + carousels). Built by the Worker's hourly
 * cron into KV; this route just reads it.
 * @returns {Promise<Object>}
 */
export async function getHomeData() {
  return fetchJson(`${CATALOG_BASE}/api/home-data`);
}

/**
 * Get full movie detail by slug
 * @param {string} slug
 * @returns {Promise<Object>}
 */
export async function getMovieDetail(slug) {
  const data = await fetchJson(`${CATALOG_BASE}/api/movie/${slug}`);
  const item = data.data?.item || data.item || data.movie || {};
  return {
    ...item,
    episodes: item.episodes || data.episodes || data.data?.episodes || [],
  };
}

/**
 * Search movies by keyword. Search intentionally bypasses the shared GET
 * cache because every Turnstile token can be redeemed only once.
 * @param {string} keyword
 * @param {string} turnstileToken
 * @param {{page?: number, signal?: AbortSignal}} [options]
 * @returns {Promise<{items: Array, pagination: Object}>}
 */
export async function searchMovies(keyword, turnstileToken, { page = 1, signal } = {}) {
  const body = new URLSearchParams({
    keyword,
    page: String(page),
    'cf-turnstile-response': turnstileToken,
  });
  const res = await fetch(`${CATALOG_BASE}/api/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal,
  });
  if (!res.ok) throw new Error(`API Error: ${res.status} ${res.statusText}`);

  const data = await res.json();
  const d = data.data || data;
  return {
    items: (d.items || []).map(normalizeListItem),
    pagination: d.params?.pagination || {},
  };
}

/**
 * Get movies by genre slug
 */
export async function getMoviesByGenre(genreSlug, page = 1) {
  const data = await fetchJson(`${CATALOG_BASE}/api/genre?slug=${genreSlug}&page=${page}`);
  const d = data.data || data;
  return {
    items: (d.items || []).map(normalizeListItem),
    pagination: d.params?.pagination || {},
    titlePage: d.titlePage || genreSlug,
    seoOnPage: d.seoOnPage || {},
  };
}

/**
 * Get movies by country slug
 */
export async function getMoviesByCountry(countrySlug, page = 1) {
  const data = await fetchJson(`${CATALOG_BASE}/api/country?slug=${countrySlug}&page=${page}`);
  const d = data.data || data;
  return {
    items: (d.items || []).map(normalizeListItem),
    pagination: d.params?.pagination || {},
    titlePage: d.titlePage || countrySlug,
    seoOnPage: d.seoOnPage || {},
  };
}

/**
 * Get recommendations ("Bạn cũng có thể thích") for a TMDB title.
 * Resolved by the Worker from TMDB recommendations, cached 30 days in D1.
 * Media type matters: TMDB ids are not unique across movie/tv, so the Worker
 * must know which endpoint (/movie or /tv) to query.
 * @param {string|number} tmdbId
 * @param {string} [type] OPhim tmdb.type — 'tv' or 'movie' (default)
 * @returns {Promise<Array>}
 */
export async function getRecommendation(tmdbId, type = 'movie') {
  if (!tmdbId) return [];
  const mediaType = type === 'tv' ? 'tv' : 'movie';
  const data = await fetchJson(`${CATALOG_BASE}/api/recommendation/${mediaType}/${tmdbId}`);
  return (data.items || []).map(normalizeListItem);
}

// --- Image URL helpers ---
// The Worker already emits full https:// R2 URLs; posterUrl/thumbUrl are pure
// passthroughs for both TMDB and KKPhim artwork (see below).

// Artwork lives in R2 (img.bluesia.net), mirrored there by the Worker's
// */10 cron (worker/lib/mirror.js). The copy is made in the background, so the
// first viewer of a new title can arrive before it lands. Object keys mirror the
// upstream path, so the origin URL is rebuildable from the R2 URL alone — that
// is the fallback below.
const R2_BASE = 'https://img.bluesia.net/';

// posterUrl/thumbUrl used to wrap OPhim R2 urls in a Cloudflare Image
// Transformation (`cdn-cgi/image/width=...`) here at serve time — OPhim had
// no TMDB-style size variants of its own, so resizing had to happen
// somewhere, and this was the only same-zone source Image Transformations
// would accept (a transform request straight to img.ophim.live 403s). Since
// 2026-08-06 that resize happened once, at MIRROR time, via wsrv.nl's `&w=`.
//
// Catalog source moved OPhim -> KKPhim same day (docs/plan-kkphim-migration.md,
// OPhim was 500ing on every endpoint). KKPhim artwork arrives already
// correctly sized, so it never needed the wsrv.nl resize step either — both
// functions stay pure passthroughs. Kept as named functions rather than
// inlined at every call site: every image-rendering call in this codebase
// goes through one of these two, which is where serve-time processing would
// go again if this project ever needs it.
export function posterUrl(url) {
  return url || '';
}

export function thumbUrl(url) {
  return url || '';
}

// Exact client-side twin of worker/lib/images.js's upstreamForKey — the two
// MUST stay in lockstep, or a not-yet-mirrored image's fallback breaks
// silently. The kkphim/ branch runs before any .webp->.jpg swap for the same
// reason it does server-side: KKPhim source extensions aren't uniformly
// .jpg (see worker/lib/images.js module comment), so swapping first would
// corrupt a genuinely-.webp KKPhim source's extension.
export function upstreamFallback(url) {
  if (!url || !url.startsWith(R2_BASE)) return '';
  const key = url.slice(R2_BASE.length);
  if (key.startsWith('kkphim/')) {
    return `https://phimimg.com/${key.slice('kkphim/'.length)}`;
  }
  // TMDB source images are confirmed always `.jpg`; a `.webp` key is
  // rebuilt by swapping the suffix back, not stripping it.
  const base = key.endsWith('.webp') ? `${key.slice(0, -'.webp'.length)}.jpg` : key;
  return `https://image.tmdb.org/${base}`;
}

// Point an <img> at its upstream origin if the R2 copy is not there yet.
export function attachImageFallback(img) {
  img.addEventListener('error', () => {
    const failedSrc = img.currentSrc || img.src;
    img.closest('picture')?.querySelector('source')?.remove();
    const upstream = upstreamFallback(failedSrc);
    if (upstream) img.src = upstream;
  });
}

// --- Normalize list item ---
// The v1/api endpoints return slightly different shapes; normalize them

export function normalizeListItem(item) {
  return {
    _id: item._id,
    name: item.name,
    slug: item.slug,
    origin_name: item.origin_name,
    thumb_url: item.thumb_url || item.poster_url || '',
    poster_url: item.poster_url || item.thumb_url || '',
    year: item.year,
    type: item.type,
    status: item.status,
    quality: item.quality,
    lang: item.lang,
    episode_current: item.episode_current,
    time: item.time,
    category: item.category || [],
    country: item.country || [],
    tmdb: item.tmdb || {},
    imdb: item.imdb || {},
    vote_average: item.vote_average,
    modified: item.modified || {},
  };
}
