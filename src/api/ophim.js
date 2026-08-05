/**
 * Catalog API client
 * Base: same-origin /api/* — the Worker (worker/index.js) builds every catalog
 * response itself (OPhim + TMDB, cached in Cache API / KV / D1). There is no
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
 * Search movies by keyword
 * @param {string} keyword
 * @param {number} page
 * @returns {Promise<{items: Array, pagination: Object}>}
 */
export async function searchMovies(keyword, page = 1) {
  const data = await fetchJson(
    `${CATALOG_BASE}/api/search?keyword=${encodeURIComponent(keyword)}&page=${page}`
  );
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
// The Worker already emits full https:// R2 URLs. For TMDB artwork these are
// still pass-throughs; for OPhim artwork, posterUrl/thumbUrl below layer a
// serve-time Cloudflare Image Transformation on top (Phase 5 of the WebP
// migration — see state.md).

// Artwork lives in R2 (img.bluesia.net), mirrored there by the Worker's
// */10 cron (worker/lib/mirror.js). The copy is made in the background, so the
// first viewer of a new title can arrive before it lands. Object keys mirror the
// upstream path, so the origin URL is rebuildable from the R2 URL alone — that
// is the fallback below.
const R2_BASE = 'https://img.bluesia.net/';

// posterUrl/thumbUrl used to wrap OPhim R2 urls in a Cloudflare Image
// Transformation (`cdn-cgi/image/width=...`) here at serve time — OPhim has
// no TMDB-style size variants of its own, so resizing had to happen
// somewhere, and this was the only same-zone source Image Transformations
// would accept (a transform request straight to img.ophim.live 403s).
//
// Since 2026-08-06 (bluesiaOM plan-redflare-webp-wsrv.md) that resize
// happens once, at MIRROR time, via wsrv.nl's `&w=` — the R2 object worker/
// lib/images.js points at is already the right size. Both functions are now
// pure passthroughs, same as they always were for TMDB urls (which never
// matched the old OPhim-only wrapper). Kept as named functions rather than
// inlined at every call site: every image-rendering call in this codebase
// goes through one of these two, which is where serve-time processing would
// go again if this project ever needs it.
export function posterUrl(url) {
  return url || '';
}

export function thumbUrl(url) {
  return url || '';
}

export function upstreamFallback(url) {
  if (!url || !url.startsWith(R2_BASE)) return '';
  let key = url.slice(R2_BASE.length);
  // Both hosts are mirrored as `.webp` (worker/lib/images.js r2ImageUrl);
  // swap back to `.jpg` to rebuild the real origin URL — TMDB source images
  // are confirmed always `.jpg`, and so is everything OPhim serves.
  if (key.endsWith('.webp')) key = `${key.slice(0, -'.webp'.length)}.jpg`;
  if (key.startsWith('ophim/')) {
    // Strip the `w<width>/` bookkeeping segment worker/lib/images.js adds —
    // OPhim has no size variants of its own, that segment isn't part of the
    // real upstream path (see upstreamForKey, the server-side twin of this).
    const rest = key.slice('ophim/'.length).replace(/^w\d+\//, '');
    return `https://img.ophim.live/${rest}`;
  }
  return `https://image.tmdb.org/${key}`;
}

// Point an <img> at its upstream origin if the R2 copy is not there yet.
export function attachImageFallback(img) {
  img.addEventListener('error', () => {
    const upstream = upstreamFallback(img.src);
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
