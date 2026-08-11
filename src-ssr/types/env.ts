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
}
