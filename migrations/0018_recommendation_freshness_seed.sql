-- Q6 fix (docs/plan-recommendation-d1-reads.md Phase 2): getDueSources used
-- to anti-join movie -> recommendation_freshness to find "never refreshed"
-- sources (~29k rows read/call) because 6,931 catalog movies with a tmdb_id
-- have no freshness row at all -- syncOneMovie fetches TMDB recommendations
-- on every write but never recorded that as a freshness attempt. Seeding one
-- row per eligible movie lets the rewritten query (Phase 2.3) go from
-- recommendation_freshness through its own index instead of scanning `movie`.
--
-- last_success_at = last_synced: the most recent write is also, in
-- practice, the most recent time this source's recommendations were
-- fetched (syncOneMovie always calls TMDB recommendations alongside the
-- detail fetch when a tmdb_id is present). Seeding real, spread-out
-- timestamps instead of "now" avoids putting all 6,931 sources on the same
-- refresh due-date at once.
INSERT OR IGNORE INTO recommendation_freshness (slug, last_success_at, last_attempt_at, result)
SELECT slug, last_synced, last_synced, 'seeded'
FROM movie
WHERE tier = 'catalog' AND tmdb_id IS NOT NULL AND tmdb_type IN ('movie', 'tv');
