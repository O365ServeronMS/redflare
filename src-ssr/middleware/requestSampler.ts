import type { MiddlewareHandler } from 'hono';
import { SyncStateRepository } from '../repositories/syncStateRepository';

// 1-in-20 -- bounds the D1 write cost of this counter itself regardless of
// real traffic volume (ADR-0002 Finding 7); multiply the stored count by
// this to estimate actual daily requests.
export const SAMPLE_RATE = 20;

/** Skips /__sync/* (ops traffic, not page views) and runs the D1 write in
 * ctx.waitUntil so it never adds latency to the response the user is
 * waiting on. Errors are caught explicitly -- an uncaught rejection inside
 * waitUntil has nothing to propagate to (the response is already sent), so
 * without this the failure would vanish silently instead of surfacing as a
 * log line. Losing one sampled count is harmless either way (estimate error,
 * ADR-0002 Finding 7). */
export const requestSampler: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  await next();
  if (c.req.path.startsWith('/__sync/')) return;
  if (Math.random() >= 1 / SAMPLE_RATE) return;
  c.executionCtx.waitUntil(
    new SyncStateRepository(c.env.DB).incrementSampledRequestsToday().catch((err: unknown) => {
      console.error(JSON.stringify({
        message: 'incrementSampledRequestsToday failed',
        error: err instanceof Error ? err.message : String(err),
      }));
    })
  );
};
