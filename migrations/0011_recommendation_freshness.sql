-- Source-level recommendation refresh state. Kept separate from movie so
-- upstream retry metadata never causes a catalog movie rewrite.
CREATE TABLE recommendation_freshness (
  slug TEXT PRIMARY KEY,
  last_success_at INTEGER,
  last_attempt_at INTEGER NOT NULL,
  result TEXT NOT NULL
);
CREATE INDEX idx_recommendation_freshness_success
  ON recommendation_freshness(last_success_at, slug);
