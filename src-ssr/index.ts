import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { apiRoute } from './api/routes';
import { sitemapRoute } from './routes/sitemap';
import { syncRoute } from './routes/sync';
import { securityHeaders } from './middleware/securityHeaders';
import { requestSampler } from './middleware/requestSampler';
import { dispatchScheduledWorkflows } from './services/sync/dispatch';

// Re-exported so wrangler's [[workflows]] class_name bindings
// (wrangler.toml) can resolve them -- Workflows must be exported from the
// main module. docs/plan-free-plan-migration.md Phase 3.
export { IncrementalSyncWorkflow } from './workflows/incrementalSyncWorkflow';
export { HeroSnapshotWorkflow } from './workflows/heroSnapshotWorkflow';
export { RecommendationResolveWorkflow } from './workflows/recommendationResolveWorkflow';
export { RecommendationRefreshWorkflow } from './workflows/recommendationRefreshWorkflow';
export { BackfillWorkflow } from './workflows/backfillWorkflow';

const app = new Hono<{ Bindings: Env }>();

const SPA_DOCUMENT_PATHS = [
  /^\/$/,
  /^\/phim\/[^/]+\/?$/,
  /^\/danh-sach\/[^/]+\/?$/,
  /^\/the-loai\/[^/]+\/?$/,
  /^\/quoc-gia\/[^/]+\/?$/,
  /^\/tim-kiem\/?$/,
];

app.use('*', securityHeaders);
app.use('*', requestSampler);

// Explicit error boundary (no ctx.passThroughOnException -- this project has
// no "origin" to fall back to anyway) so an unhandled exception anywhere in
// a route gets a structured log line instead of only Hono's default plain-
// text 500. HTTPException (thrown deliberately by a route, e.g. Hono's own
// validators) is passed through as its own response/status; anything else
// is an unexpected bug and always logged + reported as a generic 500 so
// internal error text never reaches a client.
app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse();
  console.error(JSON.stringify({
    message: 'unhandled error',
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
    method: c.req.method,
    path: c.req.path,
  }));
  return c.text('Internal server error', 500);
});

// Only routes listed in wrangler.toml assets.run_worker_first reach this
// Worker. Static files still bypass it; browser document requests pass
// through only so the response can opt out of Cloudflare HTML injection.
app.route('/', apiRoute);
app.route('/', sitemapRoute);
app.route('/', syncRoute);

app.notFound(async (c) => {
  const isSpaDocument = (c.req.method === 'GET' || c.req.method === 'HEAD')
    && SPA_DOCUMENT_PATHS.some((pattern) => pattern.test(c.req.path));

  if (!isSpaDocument) return c.text('Not found', 404);

  const assetResponse = await c.env.ASSETS.fetch(c.req.raw);
  const headers = new Headers(assetResponse.headers);
  headers.set('Cache-Control', 'public, max-age=0, must-revalidate, no-transform');

  return new Response(assetResponse.body, {
    status: assetResponse.status,
    statusText: assetResponse.statusText,
    headers,
  });
});

// scheduled() is back, but nothing like the pre-Phase-5 version that ran
// five jobs' worth of work inline in one Cron Trigger invocation (and blew
// the Free-plan CPU/subrequest budgets doing it). This handler ONLY calls
// Workflow.create() a few times -- all the heavy lifting still happens
// inside the [[workflows]] in wrangler.toml, each step with its own fresh
// CPU/subrequest budget. It exists because those Workflows' own
// `schedules` silently stopped firing when the account left Workers Paid
// (2026-09-07); a classic [triggers] cron works on Free, so it's the
// single trigger now. See src-ssr/services/sync/dispatch.ts.
export default {
  fetch: app.fetch,
  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(dispatchScheduledWorkflows(env, controller.scheduledTime));
  },
};
