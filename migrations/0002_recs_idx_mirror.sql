-- Reverse index (tmdb.id -> signed catalog item), recommendation cache, and
-- the R2 image-mirroring bookkeeping. Tables created now (Phase 1) but not
-- read/written until Phase 5 (idx, recs) and Phase 6 (mirrored, mirror_queue)
-- port that logic from the VPS catalog-api onto the Worker.

CREATE TABLE IF NOT EXISTS idx (
  type TEXT NOT NULL,
  tmdb_id TEXT NOT NULL,
  item TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (type, tmdb_id)
);

CREATE TABLE IF NOT EXISTS recs (
  type TEXT NOT NULL,
  tmdb_id TEXT NOT NULL,
  body TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (type, tmdb_id)
);

-- Keys known to already exist in the R2 bucket -- replaces the in-memory
-- Set in the VPS's r2.js (a Worker has no persistent memory between
-- invocations, so this bookkeeping has to live somewhere durable).
CREATE TABLE IF NOT EXISTS mirrored (
  key TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

-- Images seen but not yet copied into R2; a cron drains this in bounded
-- batches (Phase 6).
CREATE TABLE IF NOT EXISTS mirror_queue (
  key TEXT PRIMARY KEY,
  source_url TEXT NOT NULL,
  queued_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_queue_age ON mirror_queue(queued_at);
