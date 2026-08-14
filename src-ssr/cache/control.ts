import type { Context } from 'hono';
import { cache } from 'cloudflare:workers';

// No s-maxage (ADR-0002 Finding 5 / plan §5.2) -- this project already
// found and fixed exactly this bug once (docs/state-hit-rate.md Decision
// 2): s-maxage implies proxy-revalidate, which disables
// stale-while-revalidate and stale-if-error on the same response.
const PAGE_CACHE_CONTROL = 'public, max-age=60, stale-while-revalidate=86400, stale-if-error=604800';

/** Standard policy for cacheable API and sitemap responses. Invalidation is
 * deploy-time (Worker version is part of the cache key, wrangler.toml
 * [cache]) or on-demand via purgeEverything below -- no Cache-Tag, no
 * per-title purging. A changed title picks up within max-age=60 regardless. */
export function applyPageCache(c: Context): void {
  c.header('Cache-Control', PAGE_CACHE_CONTROL);
}

/** Ops/status/sync routes -- never cache these, they're either gated,
 * mutating, or meant to reflect current state on every call. */
export function applyNoStore(c: Context): void {
  c.header('Cache-Control', 'private, no-store');
}

/** Nukes every cached response this Worker owns -- the replacement for the
 * zone dashboard's "Purge Everything", which does NOT reach Workers
 * Caching (see the wrangler.toml [cache] note). One purge call regardless
 * of how much is cached, so it comfortably fits the Free plan's
 * 5-requests/minute purge budget.
 *
 * Must be called from the SAME entrypoint that stored the responses --
 * purges are entrypoint-scoped and the cache key includes the entrypoint,
 * so this is deliberately exposed as an HTTP route (routes/sync.ts), which
 * runs on the default export, exactly where every /api/* response is
 * cached. Calling it from a Workflow class instead would target that
 * class's own (empty) cache namespace. */
export async function purgeEverything(): Promise<boolean> {
  try {
    const result = await cache.purge({ purgeEverything: true });
    if (!result.success) {
      console.error(JSON.stringify({ message: 'purgeEverything rejected', errors: result.errors }));
      return false;
    }
    return true;
  } catch (err) {
    console.error(JSON.stringify({
      message: 'purgeEverything threw',
      error: err instanceof Error ? err.message : String(err),
    }));
    return false;
  }
}
