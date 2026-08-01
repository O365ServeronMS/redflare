-- Durable last-known-good cache for /api/list, /api/genre, /api/country,
-- /api/movie/:slug, /api/recommendation/:type/:id — served when the VPS
-- catalog-api is unreachable and the edge cache (Cache API) has no copy.
-- /api/home-data uses a dedicated KV key instead (see worker/index.js).
-- /api/search intentionally has no durable fallback — unbounded keyword
-- cardinality makes it unsafe to persist every query indefinitely.
CREATE TABLE IF NOT EXISTS stale (
  path TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
