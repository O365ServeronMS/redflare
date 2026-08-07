-- Cutover to the SSR rearchitecture (docs/plan-ssr-rearchitecture.md,
-- docs/adr/0002-no-vps-ssr-architecture.md) at user's explicit request,
-- 2026-08-07, ahead of the plan's own Phase 8/9 sequencing (which called
-- for a gradual per-route cutover and a >=7 day soak before removing the
-- old schema). Drops every table the SPA-era worker (worker/index.js,
-- removed same commit) used -- none of it is read by src-ssr/.
--
-- Irreversible: this is real data (KV/D1 last-known-good copies, the
-- reverse index, recommendation cache, R2-mirror bookkeeping, popularity
-- samples, hit-rate counters) built up over the entire life of the SPA
-- architecture, including the work tracked in docs/plan-hit-rate.md and
-- docs/state-hit-rate.md.
DROP TABLE IF EXISTS stale;
DROP TABLE IF EXISTS idx;
DROP TABLE IF EXISTS recs;
DROP TABLE IF EXISTS mirrored;
DROP TABLE IF EXISTS mirror_queue;
DROP TABLE IF EXISTS popularity;
DROP TABLE IF EXISTS cache_stats;
