/**
 * Catalog API client
 * Base: same-origin /api/* — the Worker (worker/index.js) builds every catalog
 * response itself (OPhim + TMDB, cached in Cache API / KV / D1). There is no
 * VPS behind it any more; img.bluesia.net is gone.
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

// Artwork lives in R2 (redflarer2.bluesia.net), mirrored there by the Worker's
// */10 cron (worker/lib/mirror.js). The copy is made in the background, so the
// first viewer of a new title can arrive before it lands. Object keys mirror the
// upstream path, so the origin URL is rebuildable from the R2 URL alone — that
// is the fallback below.
const R2_BASE = 'https://redflarer2.bluesia.net/';
const OPHIM_R2_PREFIX = `${R2_BASE}ophim/`;

// img.ophim.live doesn't negotiate WebP (unlike image.tmdb.org, see
// worker/lib/mirror.js), so OPhim art is mirrored into R2 as plain,
// full-size JPEG — one sampled object was 3.1MB. Cloudflare Image
// Transformations only accept same-zone sources (verified: a transform
// request to img.ophim.live or image.tmdb.org 403s; the R2 mirror, same zone
// as phim.bluesia.net, works — see state.md "Constraints" #1), so this reads
// from the raw R2 copy rather than the OPhim origin directly. Applied here
// rather than server-side in worker/lib/images.js r2ImageUrl() so
// thumb_url/poster_url stay plain R2 URLs — that's what mirrorTargets keys
// off to enqueue the raw mirror in the first place, and what upstreamFallback
// below needs to reconstruct the origin URL on a miss.
const CDN_CGI_PREFIX = 'https://phim.bluesia.net/cdn-cgi/image/';

function ophimTransform(url, width) {
  if (!url || !url.startsWith(OPHIM_R2_PREFIX)) return url || '';
  return `${CDN_CGI_PREFIX}width=${width},format=auto/${url}`;
}

// posterUrl (wide/backdrop context) and thumbUrl (portrait/card context) get
// different widths, mirroring the w1280/w500 split TMDB images already use
// (worker/lib/enrich.js BACKDROP_SIZE/POSTER_SIZE) — TMDB URLs pass through
// ophimTransform unchanged since they never start with OPHIM_R2_PREFIX.
export function posterUrl(path) {
  return ophimTransform(path, 1280);
}

export function thumbUrl(path) {
  return ophimTransform(path, 500);
}

export function upstreamFallback(url) {
  if (!url) return '';
  // Unwrap a transform URL back to the plain R2 URL it wraps (see
  // ophimTransform above) before the usual R2 -> origin reconstruction.
  let plain = url;
  if (plain.startsWith(CDN_CGI_PREFIX)) {
    const srcStart = plain.indexOf('https://', CDN_CGI_PREFIX.length);
    plain = srcStart === -1 ? '' : plain.slice(srcStart);
  }
  if (!plain || !plain.startsWith(R2_BASE)) return '';
  let key = plain.slice(R2_BASE.length);
  // TMDB images are served from the `.webp` variant (worker/lib/images.js
  // r2ImageUrl, Phase 3 of the WebP migration — see state.md); strip it back
  // off to rebuild the original TMDB URL. OPhim keys never carry the suffix.
  if (key.endsWith('.webp')) key = key.slice(0, -'.webp'.length);
  return key.startsWith('ophim/')
    ? `https://img.ophim.live/${key.slice(6)}`
    : `https://image.tmdb.org/${key}`;
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
