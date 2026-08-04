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
