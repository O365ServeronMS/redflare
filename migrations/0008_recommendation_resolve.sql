-- Phase 4 (docs/plan-ssr-rearchitecture.md §4, ADR-0002 Finding 3): tracks
-- whether a resolve attempt was already made for an unresolved
-- recommendation edge, independent of whether it succeeded. Without this,
-- an edge that resolves to neither the local catalog nor KKPhim's /tmdb/
-- lookup (a target this site will never be able to show) would get
-- re-attempted -- and re-cost a KKPhim/TMDB fetch -- on every single
-- resolve tick forever.
ALTER TABLE recommendation ADD COLUMN resolve_attempted INTEGER NOT NULL DEFAULT 0;
