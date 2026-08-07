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

const TMDB_W500_URL_RE = /^(https:\/\/image\.tmdb\.org\/t\/p\/)w500\//;

/** Use TMDB's smaller poster variant for movie cards. */
export function toTmdbW185(url) {
  return (url || '').replace(TMDB_W500_URL_RE, '$1w185/');
}
