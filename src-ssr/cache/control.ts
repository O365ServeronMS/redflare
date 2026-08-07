import type { Context } from 'hono';

// No s-maxage (ADR-0002 Finding 5 / plan §5.2) -- this project already
// found and fixed exactly this bug once (docs/state-hit-rate.md Decision
// 2): s-maxage implies proxy-revalidate, which disables
// stale-while-revalidate and stale-if-error on the same response.
const PAGE_CACHE_CONTROL = 'public, max-age=60, stale-while-revalidate=86400, stale-if-error=604800';

/** Standard policy for cacheable API and sitemap responses. `tags` become
 * the Cache-Tag header -- comma-separated, consumed and stripped by
 * Cloudflare before the response reaches the client. */
export function applyPageCache(c: Context, tags: string[]): void {
  c.header('Cache-Control', PAGE_CACHE_CONTROL);
  c.header('Cache-Tag', tags.join(','));
}

/** Ops/status/sync routes -- never cache these, they're either gated,
 * mutating, or meant to reflect current state on every call. */
export function applyNoStore(c: Context): void {
  c.header('Cache-Control', 'private, no-store');
}
