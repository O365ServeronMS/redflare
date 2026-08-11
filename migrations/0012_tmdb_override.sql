-- Verified corrections for catalog titles whose KKPhim metadata has no
-- TMDB identity. Exact slug rows only: never auto-populate this table from
-- a title search in the request or sync path.
CREATE TABLE IF NOT EXISTS tmdb_override (
  slug TEXT PRIMARY KEY,
  tmdb_id INTEGER NOT NULL CHECK (tmdb_id > 0),
  tmdb_type TEXT NOT NULL CHECK (tmdb_type IN ('movie', 'tv')),
  tmdb_season INTEGER,
  reason TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Game of Thrones is present as eight streamable KKPhim season slugs but
-- upstream supplies tmdb:{id:null,type:null,season:null}. TMDB's series ID
-- is 1399, verified 2026-08-11.
INSERT INTO tmdb_override (slug, tmdb_id, tmdb_type, tmdb_season, reason, updated_at) VALUES
  ('tro-choi-vuong-quyen-phan-1', 1399, 'tv', 1, 'verified Game of Thrones TMDB mapping', 1786406400),
  ('tro-choi-vuong-quyen-phan-2', 1399, 'tv', 2, 'verified Game of Thrones TMDB mapping', 1786406400),
  ('tro-choi-vuong-quyen-phan-3', 1399, 'tv', 3, 'verified Game of Thrones TMDB mapping', 1786406400),
  ('tro-choi-vuong-quyen-phan-4', 1399, 'tv', 4, 'verified Game of Thrones TMDB mapping', 1786406400),
  ('tro-choi-vuong-quyen-phan-5', 1399, 'tv', 5, 'verified Game of Thrones TMDB mapping', 1786406400),
  ('tro-choi-vuong-quyen-phan-6', 1399, 'tv', 6, 'verified Game of Thrones TMDB mapping', 1786406400),
  ('tro-choi-vuong-quyen-phan-7', 1399, 'tv', 7, 'verified Game of Thrones TMDB mapping', 1786406400),
  ('tro-choi-vuong-quyen-phan-8', 1399, 'tv', 8, 'verified Game of Thrones TMDB mapping', 1786406400)
ON CONFLICT(slug) DO UPDATE SET
  tmdb_id = excluded.tmdb_id,
  tmdb_type = excluded.tmdb_type,
  tmdb_season = excluded.tmdb_season,
  reason = excluded.reason,
  updated_at = excluded.updated_at;
