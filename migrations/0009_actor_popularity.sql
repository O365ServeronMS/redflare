-- Phase F3 (docs/plan-restore-spa-frontend.md) -- two columns needed to
-- restore the old SPA's home page and detail page, gathered into one
-- migration so the catalog only pays for one full resync pass instead of
-- two.
--
-- actor_json: MovieDetail.js renders movie.actor[] (docs/contract-legacy-
-- api.md §4) -- KKPhim's own detail response already has this, it was just
-- never captured into NormalizedMovie.
--
-- popularity: hero/trending ranking (docs/plan-restore-spa-frontend.md F4)
-- needs SOME ordering signal, and the old architecture used TMDB's live
-- trending endpoint at build time -- not available here (ADR-0002
-- Principle 3: no runtime/cron call ranks against a live TMDB trending
-- call outside what's already fetched during sync). TMDB's own detail
-- response already includes `popularity` (verified against TMDB's public
-- API reference 2026-08-07, type "number") for every title synced, so it's
-- captured for free instead of adding a second TMDB call.
ALTER TABLE movie ADD COLUMN actor_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE movie ADD COLUMN popularity REAL;
