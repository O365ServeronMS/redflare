// images.js — maps a raw TMDB/OPhim image URL to its Cloudflare R2 URL.
//
// Replaces catalog-api's sign.js for IMAGE_URL_MODE=r2 (the only mode this
// site runs — see redflare/CLAUDE.md "Data flow & caching"). The old signed
// mode (HMAC via image-api) is gone entirely; there is no fallback path back
// to it here. Mirroring the images into R2 is still the VPS's job today
// (catalog-api/src/r2.js) — this file only builds the URL a mirrored object
// would live at, it never writes to the bucket. That split matters: a title
// this Worker enriches before the VPS has mirrored its artwork will 404 on
// R2 until the VPS's own background refresh (or, from Phase 6 on, the
// Worker's own mirror cron) catches up. The client's attachImageFallback()
// (src/api/ophim.js) covers that gap by refetching the original TMDB/OPhim
// URL directly on <img onerror>.

const IMAGE_HOSTS = new Set(['image.tmdb.org', 'img.ophim.live']);
const BLOCKED_MEDIA_PATH = /\.(?:m3u8|mpd|ts|m4s|mp4|mkv|avi|mov|webm|vtt|srt|svg)$/i;
const R2_PUBLIC_BASE = 'https://redflarer2.bluesia.net';

// Mirrors sign.js's normalizeOphimImageUrl: handle protocol-relative and bare
// upload paths, then canonicalize via the URL constructor.
function normalizeOphimImageUrl(raw) {
  if (!raw) return '';
  const src = String(raw).trim();
  if (!src) return '';
  if (src.startsWith('//')) return `https:${src}`;
  if (!src.startsWith('http')) {
    const path = src.replace(/^\/+/, '');
    return `https://img.ophim.live/uploads/movies/${path}`;
  }
  try {
    return new URL(src).toString();
  } catch {
    return '';
  }
}

function canonicalizeImageUrl(raw) {
  const normalized = normalizeOphimImageUrl(raw);
  if (!normalized) return '';
  let url;
  try {
    url = new URL(normalized);
  } catch {
    return '';
  }
  if (url.protocol !== 'https:') return '';
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (BLOCKED_MEDIA_PATH.test(url.pathname)) return '';
  if (!IMAGE_HOSTS.has(host)) return '';
  return url.toString();
}

// Mirrors r2.js's objectKeyFor EXACTLY — the key shape is a contract with
// the client's upstreamFallback() (src/api/ophim.js), which rebuilds the
// original TMDB/OPhim URL from this same key. Changing this breaks the
// fallback for every object not yet mirrored.
function objectKeyFor(canonicalUrl) {
  const url = new URL(canonicalUrl);
  const path = url.pathname.replace(/^\/+/, '');
  if (!path) return '';
  if (url.hostname === 'image.tmdb.org') return path;
  if (url.hostname === 'img.ophim.live') return `ophim/${path}`;
  return '';
}

// Public: raw upstream URL -> R2 URL, or '' if the host isn't mirrored.
export function r2ImageUrl(rawUrl) {
  const canonical = canonicalizeImageUrl(rawUrl);
  if (!canonical) return '';
  const key = objectKeyFor(canonical);
  return key ? `${R2_PUBLIC_BASE}/${key}` : '';
}

// Maps an item's thumb_url/poster_url in place, mirroring sign.js's
// signItem() fallback order (thumb falls back to poster and vice versa).
export function mapItemImages(item) {
  if (!item || typeof item !== 'object') return item;
  const thumb_url = r2ImageUrl(item.thumb_url || item.poster_url || '');
  const poster_url = r2ImageUrl(item.poster_url || item.thumb_url || '');
  return { ...item, thumb_url, poster_url };
}

export function mapItemsImages(items) {
  return (items || []).map(mapItemImages);
}
