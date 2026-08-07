/** Simple interval-spaced rate limiter -- no burst allowance, one slot every
 * `1000 / requestsPerSecond` ms. Deliberately conservative (ADR-0002 Finding
 * 2b / plan §0.2): phimapi.com is a free community API this project has
 * already lost one catalog source to an outage of (ophim1.com, 2026-08-06);
 * getting banned from the replacement by hammering it during a burst
 * backfill is the worst available outcome, and it's self-inflicted.
 *
 * NOTE this is per-invocation, not account-wide -- Workers have no shared
 * memory across invocations and this project deliberately excludes Durable
 * Objects (handoff principle: no DO). The orchestrator (orchestrator.ts) is
 * responsible for picking a shard count such that (shards x per-shard rate)
 * stays under the aggregate cap; it does not average out automatically. */
export class RateLimiter {
  private nextSlot = 0;
  private readonly intervalMs: number;

  constructor(requestsPerSecond: number) {
    this.intervalMs = 1000 / requestsPerSecond;
  }

  async wait(): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, this.nextSlot);
    this.nextSlot = slot + this.intervalMs;
    const delay = slot - now;
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

/** Aggregate caps this project has decided on (plan §0.2): phimapi.com is
 * the fragile one worth protecting; TMDB tolerates far more. Kept as named
 * constants so the orchestrator's shard-count math has a single source of
 * truth. */
export const PHIMAPI_AGGREGATE_RPS = 25;
export const TMDB_AGGREGATE_RPS = 40;
