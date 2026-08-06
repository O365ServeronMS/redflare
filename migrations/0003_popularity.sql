-- Sampled request-popularity counter for /api/list, /api/genre, /api/country
-- (plan-hit-rate.md Phase 4 — ADR-0001 Action Item 5: pick warm-set
-- membership from real traffic instead of intuition). `path` is the same
-- canonical cache key worker/index.js's canonicalCacheKey() computes, so a
-- row here maps 1:1 onto a page:v1:* KV key. Written by a SAMPLED subset of
-- requests (worker/index.js trackPopularity, 1-in-10) to keep D1 write
-- volume bounded regardless of real traffic volume.
CREATE TABLE IF NOT EXISTS popularity (
  path TEXT PRIMARY KEY,
  hits INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER NOT NULL
);
