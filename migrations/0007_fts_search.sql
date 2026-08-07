-- Phase 6 (docs/plan-ssr-rearchitecture.md §6): local search, no runtime
-- call to KKPhim's own search (ADR-0002 Principle 3) -- and a real quality
-- fix at the same time, since plan-kkphim-migration.md §0.4 recorded
-- KKPhim's own search as "chất lượng match kém hơn" than what it replaced.
--
-- `title`/`original_title` are indexed with application-normalized text
-- (lib/vietnamese.ts strips diacritics AND folds đ/Đ -> d/D before writing
-- here) -- unicode61's remove_diacritics=2 handles combining-mark accents
-- but NOT đ, which is its own Unicode codepoint, not "d + stroke". Relying
-- on the tokenizer alone would leave "dien vien" failing to match
-- "diễn viên". `slug` is UNINDEXED (not searchable text, just the join key
-- back to `movie` for rendering real data -- FTS storage never becomes the
-- source of truth for display).
CREATE VIRTUAL TABLE IF NOT EXISTS fts_movie USING fts5(
  title,
  original_title,
  slug UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);
