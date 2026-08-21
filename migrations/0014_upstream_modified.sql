-- Fixes home/list rail ordering (Phim Mới Cập Nhật / Phim Lẻ / Phim Bộ
-- showing the same titles as the HeroSlider). Root cause: every rail
-- ordered by `last_synced` -- the time THIS Worker last wrote the row --
-- not the upstream feed's own `modified.time`. The hero snapshot refresh
-- (services/sync/heroSnapshot.ts) re-syncs ~20 trending titles every 30
-- minutes; their vote_average/vote_count drift often enough that the hash
-- changes and last_synced jumps to "now", pushing them to the top of every
-- other rail even though nothing upstream-new happened to them.
--
-- upstream_modified stores the source's own modified.time (epoch seconds).
-- Existing rows are seeded from last_synced (best available approximation)
-- so ordering doesn't regress to NULL-first before the next sync tick
-- populates the real value for each title.
ALTER TABLE movie ADD COLUMN upstream_modified INTEGER;
UPDATE movie SET upstream_modified = last_synced WHERE upstream_modified IS NULL;

-- Replaces idx_movie_synced / idx_movie_type, which ordered on last_synced
-- and are no longer queried against.
DROP INDEX IF EXISTS idx_movie_synced;
DROP INDEX IF EXISTS idx_movie_type;
CREATE INDEX IF NOT EXISTS idx_movie_upstream_modified ON movie(upstream_modified DESC);
CREATE INDEX IF NOT EXISTS idx_movie_type_upstream_modified ON movie(type, upstream_modified DESC);
