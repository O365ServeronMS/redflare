import type { MiddlewareHandler } from 'hono';
import type { Env } from '../types/env';

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

/** CSP with no 'unsafe-inline' (ADR-0002 "Security": "achievable — SSR
 * means no inline handlers; the HLS player is one external script"). The
 * player page's one inline bootstrap <script> (render/playerPage.ts) gets a
 * per-request nonce instead; everywhere else has zero script tags at all.
 *
 * Caveat worth stating plainly: this page is cache-eligible (Phase 5), and
 * Workers Caching stores the full response including this header. A cache
 * HIT replays the same nonce (and the same header) to every visitor for
 * the response's TTL, not a fresh one per request -- weaker than a true
 * per-visit nonce, but still categorically better than 'unsafe-inline' (an
 * attacker still cannot execute arbitrary injected script; they'd need to
 * control the cached response body itself, at which point the nonce is the
 * least of the problem). */
export const securityHeaders: MiddlewareHandler<{ Bindings: Env; Variables: { nonce: string } }> = async (
  c,
  next
) => {
  const nonce = randomNonce();
  c.set('nonce', nonce);
  await next();

  c.header(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      `script-src 'self' 'nonce-${nonce}' https://cdn.jsdelivr.net`,
      "style-src 'self'",
      "img-src 'self' https://image.tmdb.org https://phimimg.com",
      'frame-src https://www.youtube.com',
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'self'",
    ].join('; ')
  );
  c.header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
};
