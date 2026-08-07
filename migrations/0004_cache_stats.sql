-- Hourly hit/miss/warm counters for /api/* (plan-hit-rate.md Phase 6).
-- Low-cardinality on purpose: one row per (hour, status), not per request —
-- the status set is small and fixed (hit, miss, warm, stale-vps-down,
-- miss-fallback, d1-recs, error), so row count grows by ~7/hour regardless
-- of traffic volume. Feeds /api/health's trailing-24h origin-build-rate
-- figure (the plan's committed metric B) without needing the zone-level
-- GraphQL Analytics API, which this session has no credentials for.
CREATE TABLE IF NOT EXISTS cache_stats (
  bucket_hour INTEGER NOT NULL,
  status TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket_hour, status)
);
