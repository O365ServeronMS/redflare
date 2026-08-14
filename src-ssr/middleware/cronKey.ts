import type { MiddlewareHandler } from 'hono';

// Constant-time compare -- a naive !== leaks key length/prefix via timing.
// Same gate as the production worker's checkCronKey (worker/index.js), one
// step tighter (ADR-0002 "Security"): 404, not 403, so the route doesn't
// announce its own existence to a probe.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const requireCronKey: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const key = c.req.header('x-cron-key') ?? '';
  if (!c.env.CRON_KEY || !timingSafeEqual(key, c.env.CRON_KEY)) {
    return c.text('Not found', 404);
  }
  await next();
};
