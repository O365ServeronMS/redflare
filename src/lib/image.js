/**
 * Single policy for every <img> in the app: lazy + async-decoded by default,
 * eager + high-priority only for images explicitly marked as LCP candidates
 * (first screen of a page). Keep every <img> going through this instead of
 * setting `loading`/`decoding` ad hoc per module.
 */
export function applyImagePolicy(img, { priority = false } = {}) {
  img.decoding = 'async';
  img.loading = priority ? 'eager' : 'lazy';
  img.fetchPriority = priority ? 'high' : 'auto';
}

export const DESKTOP_IMAGE_MEDIA = '(min-width: 769px)';

export const RESPONSIVE_IMAGE_VARIANTS = Object.freeze({
  heroRail: Object.freeze({ mobile: 'w154', desktop: 'w185' }),
  posterCard: Object.freeze({ mobile: 'w185', desktop: 'w500' }),
});

// Poster variants are interchangeable. Do not include w1280: that is the
// landscape backdrop contract and must remain untouched by card/rail policy.
const TMDB_POSTER_VARIANT_RE = /^(https:\/\/image\.tmdb\.org\/t\/p\/)w(?:154|185|500)\//;

/** Returns a TMDB poster URL at the requested width; other image hosts pass through. */
export function toTmdbImageSize(url, size) {
  return (url || '').replace(TMDB_POSTER_VARIANT_RE, `$1${size}/`);
}

/**
 * Source contract for a responsive <picture>. Phase 2 owns rendering this
 * object; keeping selection here makes the mobile/desktop policy testable
 * without changing the current UI yet.
 */
export function getResponsiveTmdbSources(url, variants) {
  return {
    mobileSrc: toTmdbImageSize(url, variants.mobile),
    desktopSrc: toTmdbImageSize(url, variants.desktop),
    desktopMedia: DESKTOP_IMAGE_MEDIA,
  };
}

/** Wraps an image in <picture> only when desktop needs a distinct source. */
export function createResponsivePicture(img, sources) {
  const picture = document.createElement('picture');
  if (sources.desktopSrc !== sources.mobileSrc) {
    const desktopSource = document.createElement('source');
    desktopSource.media = sources.desktopMedia;
    desktopSource.srcset = sources.desktopSrc;
    picture.appendChild(desktopSource);
  }
  picture.appendChild(img);
  return picture;
}
