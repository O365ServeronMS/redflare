import { WorkflowEntrypoint, type WorkflowStep, type WorkflowEvent } from 'cloudflare:workers';
import { runBackfillTick } from '../services/sync/orchestrator';

// Small enough that each step's own external-call count (KKphim listing +
// TMDB/KKphim detail calls for whatever slugs that page contains) stays
// well clear of the Free-plan subrequest cap, regardless of backlog.
const PAGES_PER_STEP = 5;
// Ceiling on one Workflow instance's own step count (~200 pages/run at 5
// pages/step); if more remains, the next scheduled instance picks up
// exactly where the D1 cursor (services/sync/orchestrator.ts
// runBackfillTick) left off -- same resumable-cursor design the legacy
// wall-time-bounded loop already relied on, just chunked into steps.
const MAX_STEPS_PER_RUN = 40;

/** On/off + page-range controlled backfill
 * (docs/plan-free-plan-migration.md Phase 3, explicit user requirement):
 * inert (a single near-free step) unless env.BACKFILL_ENABLED is "true" on
 * the Cloudflare dashboard's "Variables and secrets" -- no redeploy needed
 * to flip it. When enabled, walks env.BACKFILL_TYPE (or all listing types
 * in sequence) from env.BACKFILL_PAGE_FROM (or the stored D1 cursor) up to
 * env.BACKFILL_PAGE_TO (or until upstream reports exhausted) -- see
 * runBackfillTick's own doc comment in services/sync/orchestrator.ts for
 * exact on/off + range semantics. The initial catalog backfill is already
 * complete (docs/state-free-plan-migration.md Phase 0); this exists for a
 * future targeted re-crawl (a new listing type, a spot re-check of a page
 * range), not for routine operation. */
export class BackfillWorkflow extends WorkflowEntrypoint<Env> {
  override async run(_event: WorkflowEvent<unknown>, step: WorkflowStep) {
    let totalPagesProcessed = 0;
    let done = false;
    let enabled = true;

    for (let i = 0; i < MAX_STEPS_PER_RUN; i++) {
      const tick = await step.do(`backfill-tick-${i}`, () => runBackfillTick(this.env, PAGES_PER_STEP));
      enabled = tick.enabled;
      done = tick.done;
      totalPagesProcessed += tick.pagesProcessed;
      if (!tick.ticked || tick.done) break;
    }

    return { enabled, done, totalPagesProcessed };
  }
}
