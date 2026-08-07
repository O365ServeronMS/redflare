export interface Env {
  DB: D1Database;
  SELF: Fetcher;
  CRON_KEY?: string;
  TMDB_API_TOKEN?: string;
  /** 'free' (governed, cron-paced) | 'burst' (Paid, throttled only by upstream politeness). */
  BACKFILL_MODE?: 'free' | 'burst';
}
