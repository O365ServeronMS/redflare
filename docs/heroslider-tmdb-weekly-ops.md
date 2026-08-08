# Hero weekly snapshot operations

Status: F3 code is ready, but production verification has not been authorized.

The existing `*/15` cron runs Hero refresh immediately after incremental sync
and before recommendation/backfill. A successful snapshot is gated for 30
minutes; an upstream error preserves the last-good snapshot and retries at the
next 15-minute tick.

`hero_snapshot` contains only ranked TMDB weekly movie candidates that pass
the KKPhim single-film, playable-stream, and TMDB-backdrop filters.
`/api/home-data` returns these rows as bare `heroMovies`; an empty snapshot is
intentionally an empty Hero, never a popularity or upstream fallback.

## Authenticated operations

All `/__sync/*` routes require `x-cron-key` and send `Cache-Control: private,
no-store`.

- `POST /__sync/refresh-hero?force=true` bypasses only the 30-minute success
  gate. Use it to seed or retry after a confirmed migration.
- `GET /__sync/status` reports `hero.lastSuccessAt`, `lastAttemptAt`,
  `matchedCount`, and `snapshotAgeSeconds`; it does not expose upstream
  payloads or secrets.

Do not rotate `CRON_KEY` merely to test production.

## Production rollout and rollback

1. Deploy A: deploy the explicit pre-cutover checkpoint where `buildHomeData()`
   still uses `getHeroPool(20)`, plus the migration/repository/service/cron/ops
   changes. This checkpoint must be a separately built version; do not deploy
   the current snapshot-reading tree before migration `0010` exists remotely.
2. Apply migration `0010_hero_snapshot.sql`; force refresh or wait for cron.
3. Query D1 to verify sparse ranks 1..20, unique TMDB IDs, and eligible joined
   rows.
4. Deploy B: deploy the current snapshot-reading home-data change, so it reads
   only the snapshot (including an intentionally empty one).

If Deploy B must be rolled back, restore `getHeroPool(20)` in
`buildHomeData()`. Do not drop `hero_snapshot` or the applied migration; the
table is harmless while the old read path is active.
