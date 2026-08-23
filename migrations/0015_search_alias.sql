-- Search could not find a title by its own Vietnamese name whenever TMDB
-- supplied the display title. services/sync/normalize.ts builds `title` as
-- first(tmdbTitle, kkphimName), so KKPhim's alias-carrying name is dropped
-- before SearchRepository.indexMovie ever sees it:
--
--   slug   sat-thu-noi-tro-vo-toi-la-sat-thu
--   KKPhim "Sát Thủ Nội Trợ (Vợ Tôi Là Sát Thủ)"
--   D1     title = "Sát Thủ Nội Trợ"        <- alias gone
--   FTS    "sat thu noi tro"                <- "vo toi la" indexed nowhere
--
-- Worse when TMDB's title isn't Vietnamese at all: slug
-- `vua-ma-thu-dua-tre-dinh-menh-va-anh-hung-bat-tu-phan-2` indexes as just
-- "Clevatess", so searching "vua ma thu" cannot find it. Measured on
-- production: ~5,650 of 30,596 indexed rows carry slug text meaningfully
-- longer than their indexed title.
--
-- The fix is an `alias` column fed from the slug. The slug is already in
-- exactly the normalized space lib/vietnamese.ts produces -- ASCII, no
-- combining marks, Đ folded to d (KKPhim generates it that way) -- so
-- REPLACE(slug,'-',' ') is directly usable as search text with no
-- application-side normalization pass, which is what lets this backfill run
-- as pure SQL against the existing index instead of needing a full re-sync.
--
-- FTS5 has no ALTER TABLE ADD COLUMN, hence the build-copy-swap.
CREATE VIRTUAL TABLE IF NOT EXISTS fts_movie_v2 USING fts5(
  title,
  original_title,
  alias,
  slug UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);

INSERT INTO fts_movie_v2 (title, original_title, alias, slug)
  SELECT title, original_title, REPLACE(slug, '-', ' '), slug FROM fts_movie;

DROP TABLE fts_movie;
ALTER TABLE fts_movie_v2 RENAME TO fts_movie;
