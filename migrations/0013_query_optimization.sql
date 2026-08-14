-- D1 rows-read optimization, driven by direct production measurement
-- (docs/state-free-plan-migration.md Phase 7): the recommendation-resolve
-- workflow was reading ~380,000 rows per tick to find a backlog that was
-- already empty (0 pending, 0 actionable overflow), because both queries
-- filtered on target_slug/resolve_attempted with no index covering that
-- predicate -- idx_rec_target only covers the join key, so the planner had
-- to scan every row in the table (SCAN r USING INDEX idx_rec_target,
-- confirmed via EXPLAIN QUERY PLAN) and filter after the fact.
--
-- Partial indexes: only rows matching the predicate are indexed at all, so
-- a query already restricted to that predicate touches just those rows
-- instead of the whole table. Two separate indexes because
-- getUnresolvedGroupedByTarget (recommendationRepository.ts) and
-- getOverflowGroupsForRequeue filter on resolve_attempted = 0 and = 1
-- respectively -- disjoint predicates, so one partial index can't serve both.
CREATE INDEX IF NOT EXISTS idx_rec_pending
  ON recommendation(target_tmdb_id, target_type)
  WHERE target_slug IS NULL AND resolve_attempted = 0;

CREATE INDEX IF NOT EXISTS idx_rec_overflow
  ON recommendation(target_tmdb_id, target_type)
  WHERE target_slug IS NULL AND resolve_attempted = 1;

-- Cached pagination totals for /api/list, /api/genre, /api/country
-- (src-ssr/api/routes.ts). Without this, every cache miss on those routes
-- ran a COUNT(*) against `movie` (no index on `tier` -- full table scan) or
-- against genre_movie/country_movie (index-covered, but still costs rows
-- read proportional to category size -- a genre with 8,000 titles burns
-- 8,000 rows read on every miss just for a page-count number). Refreshed
-- by IncrementalSyncWorkflow/RecommendationResolveWorkflow only when the
-- underlying counts could actually have changed (see
-- src-ssr/services/sync/catalogStats.ts) -- not on a fixed schedule, since
-- steady-state ticks write nothing.
--
-- `kind`/`key` pairs, matching the exact semantics of the COUNT queries
-- they replace (see catalogStats.ts for why tier/type filters differ):
--   ('tier', 'catalog')  -- movie.tier = 'catalog' (any type)
--   ('type', <type>)     -- movie.type = <type> (any tier, matches the
--                            pre-existing countByType behavior, which
--                            never filtered by tier)
--   ('genre', <slug>)    -- genre_movie.genre_slug = <slug>
--   ('country', <slug>)  -- country_movie.country_slug = <slug>
CREATE TABLE IF NOT EXISTS catalog_stats (
  kind  TEXT NOT NULL,
  key   TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (kind, key)
);
