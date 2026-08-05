// images.js — maps a raw TMDB/OPhim image URL to its Cloudflare R2 URL, and
// (Phase 6) extracts the {key, sourceUrl} targets the Worker's own mirror
// pipeline needs.
//
// Replaces catalog-api's sign.js for IMAGE_URL_MODE=r2 (the only mode this
// site runs — see redflare/CLAUDE.md "Data flow & caching"). The old signed
// mode (HMAC via image-api) is gone entirely; there is no fallback path back
// to it here. Since Phase 6 the Worker also OWNS mirroring into R2 (see
// worker/lib/mirror.js) — this file still only builds/parses URLs, the actual
// bucket writes live in mirror.js. Until a copy lands, the client's
// attachImageFallback() (src/api/ophim.js) covers the gap by refetching the
// original TMDB/OPhim URL directly on <img onerror>.

const IMAGE_HOSTS = new Set(['image.tmdb.org', 'img.ophim.live']);
const BLOCKED_MEDIA_PATH = /\.(?:m3u8|mpd|ts|m4s|mp4|mkv|avi|mov|webm|vtt|srt|svg)$/i;
const R2_PUBLIC_BASE = 'https://img.bluesia.net';

// Mirrors sign.js's normalizeOphimImageUrl: handle protocol-relative and bare
// upload paths, then canonicalize via the URL constructor.
function normalizeOphimImageUrl(raw) {
  if (!raw) return '';
  const src = String(raw).trim();
  if (!src) return '';
  if (src.startsWith('//')) return `https:${src}`;
  if (!src.startsWith('http')) {
    const path = src.replace(/^\/+/, '');
    // OPhim's own list endpoints (/v1/api/danh-sach|the-loai|quoc-gia) already
    // return the path WITH the uploads/ prefix (e.g. "uploads/movies/x.jpg");
    // only /v1/api/tim-kiem returns a bare filename. Prepending unconditionally
    // double-appended the prefix for the former, producing 404s like
    // uploads/movies/uploads/movies/<file> — see redflare CLAUDE.md incident log.
    const rel = path.startsWith('uploads/') ? path : `uploads/movies/${path}`;
    return `https://img.ophim.live/${rel}`;
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
//
// OPhim keys carry a `w<width>/` segment TMDB keys don't need: TMDB source
// URLs already bake size into the path (/t/p/w500/, /t/p/w1280/), so the
// SAME upstream URL never needs two differently-sized R2 objects. OPhim has
// no size variants at all — one URL, one native resolution — so sizing has
// to happen at mirror time (wsrv.nl `&w=`, see worker/lib/mirror.js) and the
// key has to say which size a given object is, the same way TMDB's path
// does natively. `width` is REQUIRED for img.ophim.live, ignored for TMDB.
function objectKeyFor(canonicalUrl, width) {
  const url = new URL(canonicalUrl);
  const path = url.pathname.replace(/^\/+/, '');
  if (!path) return '';
  if (url.hostname === 'image.tmdb.org') return path;
  if (url.hostname === 'img.ophim.live') return `ophim/w${width}/${path}`;
  return '';
}

// Public: raw upstream URL -> R2 URL, or '' if the host isn't mirrored.
// `width` is the target display width — required for OPhim (see
// objectKeyFor), ignored for TMDB (already sized by its own path).
//
// Since 2026-08-06 (bluesiaOM plan-redflare-webp-wsrv.md) EVERY mirrored key
// is `.webp` — TMDB (via wsrv.nl replacing content negotiation) and now
// OPhim too (wsrv.nl doing resize+convert in one pass, replacing the
// serve-time `cdn-cgi/image/` transform this file used to require the
// client to wrap around a plain R2 url). No more per-host branching here.
export function r2ImageUrl(rawUrl, width) {
  const canonical = canonicalizeImageUrl(rawUrl);
  if (!canonical) return '';
  const key = objectKeyFor(canonical, width);
  if (!key) return '';
  const servedKey = webpKeyFor(key);
  return `${R2_PUBLIC_BASE}/${servedKey}`;
}

// Matches the two contexts src/api/ophim.js's posterUrl()/thumbUrl() used to
// apply at serve time (wide/backdrop vs portrait/card) — same numbers, same
// meaning, just decided here now instead of per-request on the client.
const THUMB_WIDTH = 500;
const POSTER_WIDTH = 1280;

// Maps an item's thumb_url/poster_url in place, mirroring sign.js's
// signItem() fallback order (thumb falls back to poster and vice versa).
export function mapItemImages(item) {
  if (!item || typeof item !== 'object') return item;
  const thumb_url = r2ImageUrl(item.thumb_url || item.poster_url || '', THUMB_WIDTH);
  const poster_url = r2ImageUrl(item.poster_url || item.thumb_url || '', POSTER_WIDTH);
  return { ...item, thumb_url, poster_url };
}

export function mapItemsImages(items) {
  return (items || []).map(mapItemImages);
}

// Reconstruct the upstream source URL for an R2 object key — the exact inverse
// of objectKeyFor / the client's upstreamFallback(). Only the two mirrored
// hosts are reversible; anything else returns ''. TMDB source images are
// confirmed always `.jpg` (verified against every key in D1 `mirrored` during
// the 2026-08 domain migration), so a `.webp` key's origin is rebuilt by
// swapping the suffix back to `.jpg`, not stripping it — see webpKeyFor.
export function upstreamForKey(key) {
  if (!key) return '';
  const base = key.endsWith('.webp') ? `${key.slice(0, -'.webp'.length)}.jpg` : key;
  if (base.startsWith('ophim/')) {
    // Strip BOTH the `ophim/` prefix AND the `w<width>/` segment
    // objectKeyFor adds — that segment is our own bookkeeping (OPhim has no
    // size variants of its own), not part of the real upstream path.
    const rest = base.slice('ophim/'.length).replace(/^w\d+\//, '');
    return `https://img.ophim.live/${rest}`;
  }
  return `https://image.tmdb.org/${base}`;
}

// R2 key for the WebP copy of a given `.jpg`-shaped key. Swaps rather than
// appends the extension (2026-08 domain migration, replacing the earlier
// appended-suffix `.jpg.webp` shape) — idempotent, since a key already ending
// `.webp` has no `.jpg` to swap.
export function webpKeyFor(key) {
  return key.endsWith('.jpg') ? `${key.slice(0, -'.jpg'.length)}.webp` : key;
}

// Derives the `w154` sibling of a `w500` poster target — used by
// mirrorTargets so a newly discovered title's w154 mirror gets queued
// alongside its w500 one. w154 feeds the hero rail (HeroSlider renders that
// rail at 42px/30px wide, not the 500px poster it loaded before). No-op for
// anything that isn't a `t/p/w500/...` key.
function addW154Sibling(out, key, sourceUrl) {
  if (!key.startsWith('t/p/w500/')) return;
  const w154Key = webpKeyFor(key.replace('t/p/w500/', 't/p/w154/'));
  if (out.has(w154Key)) return;
  out.set(w154Key, { key: w154Key, sourceUrl: sourceUrl.replace('/t/p/w500/', '/t/p/w154/') });
}

// From ALREADY-MAPPED items (whose thumb_url/poster_url are R2 URLs), extract
// the deduped [{ key, sourceUrl }] targets to mirror. Used by the Worker's
// mirror pipeline (worker/lib/mirror.js) to enqueue images for copying into
// R2. Runs on mapped items so every build path (list/detail/home/rec) feeds
// the queue uniformly without re-deriving upstream URLs.
//
// Both hosts land as `.webp` now (worker/lib/mirror.js fetches every `.webp`
// key through wsrv.nl — TMDB for guaranteed-real WebP bytes, OPhim for that
// PLUS the resize wsrv.nl's `&w=` does in the same pass, replacing the
// serve-time `cdn-cgi/image/` transform this project used to need). Every
// w500 TMDB poster also gets its w154 sibling queued (see addW154Sibling) so
// newly discovered titles stay covered for the hero rail.
export function mirrorTargets(items) {
  const out = new Map();
  const prefix = `${R2_PUBLIC_BASE}/`;
  for (const it of items || []) {
    for (const u of [it?.thumb_url, it?.poster_url]) {
      if (typeof u !== 'string' || !u.startsWith(prefix)) continue;
      const servedKey = u.slice(prefix.length).split('?')[0];
      if (!servedKey) continue;
      // thumb_url/poster_url already carry the SERVED (.webp) key. Restore
      // the .jpg-shaped base key before re-deriving the webp target key —
      // webpKeyFor/upstreamForKey both expect a .jpg-shaped input.
      const key = servedKey.endsWith('.webp')
        ? `${servedKey.slice(0, -'.webp'.length)}.jpg`
        : servedKey;
      const targetKey = webpKeyFor(key);
      const sourceUrl = out.has(targetKey) ? null : upstreamForKey(key);
      if (sourceUrl) {
        out.set(targetKey, { key: targetKey, sourceUrl });
        addW154Sibling(out, key, sourceUrl); // no-op unless key is TMDB t/p/w500/
      }
    }
  }
  return [...out.values()];
}
