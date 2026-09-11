/** Classic Cron Trigger dispatcher (docs/plan-incremental-sync-stall.md
 * Phase 3), the single trigger that replaces the per-Workflow `schedules`
 * in wrangler.toml.
 *
 * Those `schedules` stopped creating instances at 2026-09-07 00:00 UTC when
 * the account's Workers Paid plan lapsed, and never self-recovered --
 * `next_instance` kept advancing but `triggered_on` froze and no
 * workflow/scheduled event fired for days. A classic [triggers] cron IS
 * supported on the Free plan (the account was using 0 of its 5), so this
 * runs every 30 minutes and `create()`s the Workflow instances the cron
 * expressions used to.
 *
 * Instance ids are derived from `scheduledTime`, so a double-fire for one
 * tick has the second `create()` rejected as a duplicate id rather than
 * doubling the work. Each `create()` is isolated in try/catch and this
 * function never throws: one binding being unavailable must not stop the
 * others from starting. */

// Workflows requires instance ids to match this; ours always do (a job
// prefix + a decimal timestamp), the guard is just belt-and-braces.
const WORKFLOW_ID_RE = /^[a-zA-Z0-9_][a-zA-Z0-9-_]*$/;

// Staleness thresholds for /__sync/status and /api/health/sync (Phase 4).
// The cron fires every 30 min and hero runs hourly, so each threshold is
// "one missed tick plus slack" -- long enough not to page on a single slow
// run, short enough to catch a stall like 2026-09-07's within the hour.
export const INCREMENTAL_STALE_SECONDS = 45 * 60;
export const HERO_STALE_SECONDS = 90 * 60;

function isEnabled(value: string | undefined): boolean {
  return (value ?? '').trim().toLowerCase() === 'true';
}

async function start(name: string, workflow: Workflow, id: string): Promise<void> {
  if (!WORKFLOW_ID_RE.test(id)) {
    console.error(JSON.stringify({ message: 'workflow dispatch failed', workflow: name, error: `invalid instance id: ${id}` }));
    return;
  }
  try {
    await workflow.create({ id });
  } catch (error) {
    console.error(JSON.stringify({
      message: 'workflow dispatch failed',
      workflow: name,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}

export async function dispatchScheduledWorkflows(env: Env, scheduledTime: number): Promise<void> {
  const topOfHour = new Date(scheduledTime).getUTCMinutes() === 0;
  // Q3 (CTE requeue ~77k rows/tick) and Q6 (getDueSources ~33k rows/tick)
  // in the Phase 1 audit -- fixed by docs/plan-recommendation-d1-reads.md
  // Phases 1-4, but both recommendation jobs stay off until that plan's
  // Phase 6 (migration apply + smoke test + 24h monitoring) is signed off.
  // Existing recommendation rails keep serving what's already resolved;
  // only refresh stops.
  const recommendationJobs = isEnabled(env.RECOMMENDATION_JOBS_ENABLED);
  const backfill = isEnabled(env.BACKFILL_ENABLED);

  // Every */30 tick.
  await start('incremental-sync', env.INCREMENTAL_SYNC_WORKFLOW, `incremental-${scheduledTime}`);
  // Hourly (matches the old `0 * * * *` schedule).
  if (topOfHour) {
    await start('hero-snapshot', env.HERO_SNAPSHOT_WORKFLOW, `hero-${scheduledTime}`);
  }
  if (recommendationJobs) {
    // resolve every tick, refresh hourly -- same cadence as the old schedules.
    await start('recommendation-resolve', env.RECOMMENDATION_RESOLVE_WORKFLOW, `rec-resolve-${scheduledTime}`);
    if (topOfHour) {
      await start('recommendation-refresh', env.RECOMMENDATION_REFRESH_WORKFLOW, `rec-refresh-${scheduledTime}`);
    }
  }
  if (backfill) {
    await start('backfill', env.BACKFILL_WORKFLOW, `backfill-${scheduledTime}`);
  }
}
