// images.js — maps a raw TMDB/KKPhim image URL to its Cloudflare R2 URL, and
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
// original TMDB/KKPhim URL directly on <img onerror>.
//
// Catalog source switched OPhim (img.ophim.live) -> KKPhim (phimimg.com) on
// 2026-08-06 (docs/plan-kkphim-migration.md) after OPhim started 500ing on
// every endpoint. KKPhim's image host behaves differently enough that the
// KKPhim branch below is NOT a copy of the old OPhim branch with the
// hostname swapped:
//   - KKPhim source images are NOT uniformly .jpg (measured: a mix of
//     .webp/.jpg/.png across pages) and live under TWO path prefixes
//     (`uploads/movies/` and `upload/vod/` — note the second has no "s").
//     So unlike OPhim, extension can't be assumed or normalized.
//   - KKPhim images are already correctly sized (tens of KB, not multi-MB),
//     so there's no resize-at-mirror-time need the way OPhim required.
//   - wsrv.nl (see worker/lib/mirror.js) actively BLOCKS phimimg.com
//     ("Domain or TLD blocked by policy", measured 2026-08-06) — moot here
//     since resize/WebP-convert isn't needed anyway, but it means the KKPhim
//     key must not claim a `.webp` extension it doesn't actually have.
// Net effect: KKPhim keys keep their source path AND source extension
// as-is (`kkphim/<original path>`), no `w<width>/` segment, no forced
// `.webp`. TMDB keys are completely unchanged by this migration.

const IMAGE_HOSTS = new Set(['image.tmdb.org', 'phimimg.com']);
const BLOCKED_MEDIA_PATH = /\.(?:m3u8|mpd|ts|m4s|mp4|mkv|avi|mov|webm|vtt|srt|svg)$/i;
const R2_PUBLIC_BASE = 'https://img.bluesia.net';

// Mirrors sign.js's normalizeOphimImageUrl: handle protocol-relative and bare
// upload paths, then canonicalize via the URL constructor.
function normalizeSourceImageUrl(raw) {
  if (!raw) return '';
  const src = String(raw).trim();
  if (!src) return '';
  if (src.startsWith('//')) return `https:${src}`;
  if (!src.startsWith('http')) {
    const path = src.replace(/^\/+/, '');
    // KKPhim's /v1/api/* list endpoints already return the path WITH its
    // uploads/upload prefix (e.g. "uploads/movies/x.webp" or
    // "upload/vod/20260622-1/x.jpg" — both prefixes seen in the wild,
    // measured 2026-08-06); only bare filenames need uploads/movies/
    // prepended. Prepending unconditionally double-appended the prefix for
    // the former, producing 404s like uploads/movies/uploads/movies/<file>
    // — see redflare CLAUDE.md incident log (an OPhim-era bug; the same
    // guard now has to recognize KKPhim's second prefix too).
    const rel = /^uploads?\//.test(path) ? path : `uploads/movies/${path}`;
    return `https://phimimg.com/${rel}`;
  }
  try {
    return new URL(src).toString();
  } catch {
    return '';
  }
}

function canonicalizeImageUrl(raw) {
  const normalized = normalizeSourceImageUrl(raw);
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
// original TMDB/KKPhim URL from this same key. Changing this breaks the
// fallback for every object not yet mirrored.
//
// TMDB keys carry no prefix/width segment: TMDB source URLs already bake
// size into the path (/t/p/w500/, /t/p/w1280/), so the SAME upstream URL
// never needs two differently-sized R2 objects.
//
// KKPhim keys get a `kkphim/` prefix and otherwise keep the source path AND
// extension verbatim — no `w<width>/` segment (KKPhim needs no mirror-time
// resize, see module comment) and no forced `.webp` (KKPhim source
// extensions aren't uniform — see module comment). Neither host takes a
// `width` any more — the old OPhim branch needed one to bake into its key
// segment; that branch no longer exists.
function objectKeyFor(canonicalUrl) {
  const url = new URL(canonicalUrl);
  const path = url.pathname.replace(/^\/+/, '');
  if (!path) return '';
  if (url.hostname === 'image.tmdb.org') return path;
  if (url.hostname === 'phimimg.com') return `kkphim/${path}`;
  return '';
}

// Public: raw upstream URL -> R2 URL, or '' if the host isn't mirrored.
//
// Since 2026-08-06 (bluesiaOM plan-redflare-webp-wsrv.md) every MIRRORED TMDB
// key is `.webp` (wsrv.nl replacing content negotiation). KKPhim keys are NOT
// forced to `.webp` — they keep whatever extension the source actually has
// (see module comment: KKPhim source images aren't uniformly one format, and
// wsrv.nl blocks phimimg.com outright, so there's no conversion step that
// could normalize it even if we wanted to).
export function r2ImageUrl(rawUrl) {
  const canonical = canonicalizeImageUrl(rawUrl);
  if (!canonical) return '';
  const key = objectKeyFor(canonical);
  if (!key) return '';
  const servedKey = key.startsWith('kkphim/') ? key : webpKeyFor(key);
  return `${R2_PUBLIC_BASE}/${servedKey}`;
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

// Reconstruct the upstream source URL for an R2 object key — the exact inverse
// of objectKeyFor / the client's upstreamFallback(). Only the two mirrored
// hosts are reversible; anything else returns ''.
//
// The `kkphim/` branch MUST run before any `.webp`->`.jpg` swap: KKPhim keys
// keep their source extension as-is (see module comment — sources aren't
// uniformly .jpg the way TMDB's are), so swapping first would corrupt the
// extension for every KKPhim key that is genuinely `.webp`.
//
// TMDB source images are confirmed always `.jpg` (verified against every key
// in D1 `mirrored` during the 2026-08 domain migration), so a `.webp` TMDB
// key's origin is rebuilt by swapping the suffix back to `.jpg`, not
// stripping it — see webpKeyFor. That guarantee does NOT extend to KKPhim.
export function upstreamForKey(key) {
  if (!key) return '';
  if (key.startsWith('kkphim/')) {
    return `https://phimimg.com/${key.slice('kkphim/'.length)}`;
  }
  const base = key.endsWith('.webp') ? `${key.slice(0, -'.webp'.length)}.jpg` : key;
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
// TMDB keys land as `.webp` (worker/lib/mirror.js fetches every TMDB `.webp`
// key through wsrv.nl for guaranteed-real WebP bytes + the w154 hero sibling,
// see addW154Sibling). KKPhim keys are a PASS-THROUGH — served key IS the
// mirror target key, extension untouched — because wsrv.nl blocks
// phimimg.com outright and KKPhim needs no conversion anyway (see module
// comment). Restoring a `.jpg`-shaped base key before re-deriving only
// applies to the TMDB branch; forcing it on a KKPhim key would corrupt a
// genuinely-`.webp` source's extension.
export function mirrorTargets(items) {
  const out = new Map();
  const prefix = `${R2_PUBLIC_BASE}/`;
  for (const it of items || []) {
    for (const u of [it?.thumb_url, it?.poster_url]) {
      if (typeof u !== 'string' || !u.startsWith(prefix)) continue;
      const servedKey = u.slice(prefix.length).split('?')[0];
      if (!servedKey) continue;

      if (servedKey.startsWith('kkphim/')) {
        if (out.has(servedKey)) continue;
        const sourceUrl = upstreamForKey(servedKey);
        if (sourceUrl) out.set(servedKey, { key: servedKey, sourceUrl });
        continue;
      }

      // TMDB branch: thumb_url/poster_url carry the SERVED (.webp) key.
      // Restore the .jpg-shaped base key before re-deriving the webp target
      // key — webpKeyFor/upstreamForKey's TMDB branch both expect a
      // .jpg-shaped input.
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
