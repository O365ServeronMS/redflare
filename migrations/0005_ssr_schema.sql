-- SSR rearchitecture schema (docs/plan-ssr-rearchitecture.md Phase 1,
-- docs/adr/0002-no-vps-ssr-architecture.md). Lives alongside the tables the
-- SPA-era Worker still uses (stale/idx/recs/mirrored/mirror_queue/
-- popularity/cache_stats) -- those are removed in Phase 9, after cutover.
--
-- Three deliberate deviations from the handoff's schema, all argued in
-- ADR-0002:
--   F1 -- movie is keyed by `slug` (the KKPhim/URL identity), not `tmdb_id`.
--         tmdb_id collides across movie/tv, is absent for some titles, and
--         one tmdb_id can map to several slugs (multi-season TV: each
--         season is its own slug sharing one series-level tmdb_id).
--   F3 -- recommendation carries a nullable `target_slug`, resolved by a
--         separate step (Phase 4), so an unbounded fan-out of TMDB-only
--         titles never has to be fetched to store the edge itself.
--   F6 -- genre/country dimension tables exist (the handoff has the join
--         tables but nowhere to keep the display name for a <h1>).
--
-- Every index here is a real, separately-billed D1 row write (Cloudflare:
-- "Indexes will add an additional written row when writes include the
-- indexed column"). Kept deliberately few -- see the row-cost arithmetic in
-- ADR-0002 Finding 2.

CREATE TABLE IF NOT EXISTS movie (
  slug                 TEXT PRIMARY KEY,
  tmdb_id              INTEGER,
  tmdb_type            TEXT,                 -- 'movie' | 'tv'
  tmdb_season          INTEGER,
  title                TEXT NOT NULL,
  original_title       TEXT,
  overview             TEXT,
  poster_path          TEXT,                 -- wide backdrop (KKPhim poster_url / TMDB w1280)
  thumb_path           TEXT,                 -- portrait poster (TMDB w500), nullable
  poster_host          TEXT NOT NULL,        -- 'tmdb' | 'phimimg' -- CSP img-src + hotlink choice
  release_year         INTEGER,
  runtime              TEXT,                 -- KKPhim returns a formatted string ("19 phút")
  vote_average         REAL,
  vote_count           INTEGER,
  status               TEXT,
  episode_current      TEXT,
  quality              TEXT,
  lang                 TEXT,
  type                 TEXT NOT NULL,        -- single|series|hoathinh|tvshows
  genres_json          TEXT NOT NULL DEFAULT '[]',
  countries_json       TEXT NOT NULL DEFAULT '[]',
  has_stream           INTEGER NOT NULL DEFAULT 0,
  stream_count         INTEGER NOT NULL DEFAULT 0,
  youtube_trailer_key  TEXT,
  tier                 TEXT NOT NULL DEFAULT 'catalog', -- 'catalog' | 'stub'
  source_hash          TEXT NOT NULL,        -- FNV-1a of the normalized upstream payload
  last_synced          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_movie_tmdb   ON movie(tmdb_type, tmdb_id) WHERE tmdb_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_movie_type   ON movie(type, last_synced DESC);
CREATE INDEX IF NOT EXISTS idx_movie_synced ON movie(last_synced DESC);

CREATE TABLE IF NOT EXISTS episode (
  slug        TEXT NOT NULL,
  server      TEXT NOT NULL,
  ep_slug     TEXT NOT NULL,
  ep_name     TEXT NOT NULL,
  sort_order  INTEGER NOT NULL,
  link_m3u8   TEXT,
  link_embed  TEXT,
  PRIMARY KEY (slug, server, ep_slug)
);
CREATE INDEX IF NOT EXISTS idx_episode_movie ON episode(slug, sort_order);

CREATE TABLE IF NOT EXISTS recommendation (
  slug           TEXT NOT NULL,
  target_slug    TEXT,                       -- NULL until Phase 4 resolves it
  target_tmdb_id INTEGER NOT NULL,
  target_type    TEXT NOT NULL,
  sort_order     INTEGER NOT NULL,
  PRIMARY KEY (slug, target_tmdb_id, target_type)
);
CREATE INDEX IF NOT EXISTS idx_rec_lookup ON recommendation(slug, sort_order);
CREATE INDEX IF NOT EXISTS idx_rec_target ON recommendation(target_tmdb_id, target_type);

CREATE TABLE IF NOT EXISTS genre   (slug TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS country (slug TEXT PRIMARY KEY, name TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS genre_movie (
  genre_slug TEXT NOT NULL,
  slug       TEXT NOT NULL,
  PRIMARY KEY (genre_slug, slug)
);
CREATE INDEX IF NOT EXISTS idx_gm_list ON genre_movie(genre_slug, slug);

CREATE TABLE IF NOT EXISTS country_movie (
  country_slug TEXT NOT NULL,
  slug         TEXT NOT NULL,
  PRIMARY KEY (country_slug, slug)
);
CREATE INDEX IF NOT EXISTS idx_cm_list ON country_movie(country_slug, slug);

-- Sync bookkeeping (Phase 2): incremental cursor, per-day write governor,
-- backfill cursor. `key` examples: 'cursor:recent', 'cursor:backfill',
-- 'rows:2026-08-07'.
CREATE TABLE IF NOT EXISTS sync_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
