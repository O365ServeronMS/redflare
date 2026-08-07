import type { Context } from 'hono';

// Bump when render/*.ts output changes shape in a way that should
// invalidate every cached page at once (plan §5.2's ETag scheme) --
// cheaper than a body hash on every request, since it costs nothing to
// compute.
export const TEMPLATE_VERSION = 1;

export function buildEtag(slug: string, lastSynced: number): string {
  return `W/"${slug}-${lastSynced}-${TEMPLATE_VERSION}"`;
}

// No s-maxage (ADR-0002 Finding 5 / plan §5.2) -- this project already
// found and fixed exactly this bug once (docs/state-hit-rate.md Decision
// 2): s-maxage implies proxy-revalidate, which disables
// stale-while-revalidate and stale-if-error on the same response.
const PAGE_CACHE_CONTROL = 'public, max-age=60, stale-while-revalidate=86400, stale-if-error=604800';

/** Standard policy for every real content page (detail/list/genre/country/
 * player). `tags` become the Cache-Tag header -- comma-separated, consumed
 * and stripped by Cloudflare before the response reaches the client. */
export function applyPageCache(c: Context, tags: string[]): void {
  c.header('Cache-Control', PAGE_CACHE_CONTROL);
  c.header('Cache-Tag', tags.join(','));
}

/** 404s get a short cache instead of none -- matches the old architecture's
 * convention (CLAUDE.md: "public, max-age=30" for a missing movie) so a
 * title that just got synced doesn't take an hour to stop 404ing, while
 * still not hammering D1 on a repeated bad request. */
export function apply404Cache(c: Context): void {
  c.header('Cache-Control', 'public, max-age=30');
}

/** Ops/status/sync routes -- never cache these, they're either gated,
 * mutating, or meant to reflect current state on every call. */
export function applyNoStore(c: Context): void {
  c.header('Cache-Control', 'private, no-store');
}
