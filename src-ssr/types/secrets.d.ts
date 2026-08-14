// Secrets set via `wrangler secret put` never appear in wrangler.toml, so
// `wrangler types` (worker-configuration.d.ts, repo root -- regenerate with
// `npm run cf-typegen` after any wrangler.toml binding/var change) has no
// way to know about them. This file has no top-level import/export, so
// TypeScript treats it as a global script and merges its `Env` declaration
// into the generated one instead of shadowing it -- every binding/var stays
// defined in exactly one place (the generated file), secrets in this one.
// All three are optional: unset in local `.dev.vars`, or (CRON_KEY,
// TURNSTILE_SECRET) intentionally treated as "feature off" when absent by
// their own gates (middleware/cronKey.ts, api/routes.ts search handler).
interface Env {
  CRON_KEY?: string;
  TMDB_API_TOKEN?: string;
  TURNSTILE_SECRET?: string;
}
