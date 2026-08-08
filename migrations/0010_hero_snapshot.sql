-- HeroSlider TMDB weekly snapshot (docs/plan-heroslider-tmdb-weekly.md F1).
-- `rank` is the original position in TMDB's first 20 weekly movie results;
-- gaps are valid when a title has no playable KKPhim match. `tmdb_id` is
-- unique so multiple KKPhim slugs cannot duplicate one TMDB title in Hero.
CREATE TABLE IF NOT EXISTS hero_snapshot (
  rank         INTEGER PRIMARY KEY CHECK(rank BETWEEN 1 AND 20),
  tmdb_id      INTEGER NOT NULL UNIQUE,
  slug         TEXT NOT NULL,
  refreshed_at INTEGER NOT NULL,
  FOREIGN KEY (slug) REFERENCES movie(slug)
);
