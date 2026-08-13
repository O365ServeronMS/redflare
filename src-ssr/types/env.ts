export interface Env {
  DB: D1Database;
  SELF: Fetcher;
  ASSETS: Fetcher;
  CRON_KEY?: string;
  TMDB_API_TOKEN?: string;
  TURNSTILE_SECRET?: string;
  TURNSTILE_HOSTNAMES?: string;
  /** 'free' (governed, cron-paced) | 'burst' (Paid, throttled only by upstream politeness). */
  BACKFILL_MODE?: 'free' | 'burst';
  /** Global cap on stub-tier movies (ADR-0002 Finding 3) -- a string
   * because wrangler.toml [vars] are always strings; parsed with Number()
   * where used. Left at "0" while on the Workers Paid trial (plan §0.2b:
   * stubs are the one thing that could push D1 storage past the 500MB
   * Free-plan ceiling before a planned downgrade). */
  MAX_STUBS?: string;
  /** On/off switch for the backfill Workflow (services/sync/orchestrator.ts
   * runBackfillTick), editable from the Cloudflare dashboard's "Variables
   * and secrets" without a redeploy (docs/plan-free-plan-migration.md).
   * "true" to (re)enable; anything else (including unset) is off. Default
   * off -- the initial catalog backfill is complete
   * (docs/state-free-plan-migration.md Phase 0). */
  BACKFILL_ENABLED?: string;
  /** Restricts a backfill run to one listing type
   * ('phim-le'|'phim-bo'|'hoat-hinh'|'tv-shows') instead of walking all of
   * them in sequence. Empty/unrecognized = all types (default). */
  BACKFILL_TYPE?: string;
  /** Starting page for the next backfill run, overriding the stored D1
   * cursor -- only takes effect when a previous run has finished
   * (backfill:done = '1'); ignored mid-walk. Empty = resume from the
   * stored cursor as usual. */
  BACKFILL_PAGE_FROM?: string;
  /** Stop the current type's walk once page exceeds this value, regardless
   * of the upstream's own totalPages -- lets an operator bound a targeted
   * re-crawl without waiting for full exhaustion. Empty = walk until
   * upstream reports exhausted (default). */
  BACKFILL_PAGE_TO?: string;
  INCREMENTAL_SYNC_WORKFLOW: Workflow;
  HERO_SNAPSHOT_WORKFLOW: Workflow;
  RECOMMENDATION_RESOLVE_WORKFLOW: Workflow;
  RECOMMENDATION_REFRESH_WORKFLOW: Workflow;
  BACKFILL_WORKFLOW: Workflow;
}
