// Secrets set via `wrangler secret put` never appear in wrangler.toml, so
// `wrangler types` (worker-configuration.d.ts, repo root -- regenerate with
// `npm run cf-typegen` after any wrangler.toml binding/var change) has no
// way to know about them. This file has no top-level import/export, so
// TypeScript treats it as a global script and merges its `Env` declaration
// into the generated one instead of shadowing it -- every binding/var stays
// defined in exactly one place (the generated file), secrets in this one.
// Both are optional: unset in local `.dev.vars`, or (CRON_KEY) intentionally
// treated as "feature off" when absent by its own gate
// (middleware/cronKey.ts).
interface Env {
  CRON_KEY?: string;
  TMDB_API_TOKEN?: string;
}
