import { WorkflowEntrypoint, type WorkflowStep, type WorkflowEvent } from 'cloudflare:workers';
import {
  buildRepos,
  buildClients,
  requeueOverflowGroups,
  resolveOneGroup,
  getStubCount,
  RESOLVE_BATCH_SIZE,
  RESOLVE_MAX_CALLS_PER_GROUP,
  INSTANCE_SUBREQUEST_BUDGET,
} from '../services/sync/orchestrator';

// docs/state-free-plan-migration.md Phase 0 measured this job at ~169
// external subrequests in one invocation against a real backlog -- over 3x
// the Free-plan 50/invocation cap. That cap is per Workflow *instance*, not
// per step (docs/state-incremental-sync-stall.md 5.2b) -- chunking into
// small per-step batches only bounds each step's own CPU time now. The
// actual subrequest ceiling is enforced explicitly below via `callsUsed`
// vs. INSTANCE_SUBREQUEST_BUDGET (Phase 3, docs/plan-recommendation-d1-reads.md),
// which persists across steps the same way `stubCountRef` does.
const GROUPS_PER_STEP = 8;

/** Free-plan-safe replacement for orchestrator.ts's runRecommendationResolveTick,
 * which resolves up to RESOLVE_BATCH_SIZE groups in one wall-time-bounded
 * loop inside a single invocation. */
export class RecommendationResolveWorkflow extends WorkflowEntrypoint<Env> {
  override async run(_event: WorkflowEvent<unknown>, step: WorkflowStep) {
    const repos = buildRepos(this.env);
    const clients = buildClients(this.env, 1);
    const configuredMaxStubs = Number(this.env.MAX_STUBS ?? '0');
    const maxStubs = Number.isFinite(configuredMaxStubs) ? Math.max(0, Math.floor(configuredMaxStubs)) : 0;

    // docs/state-free-plan-migration.md Phase 7: countByTier('stub') was a
    // full table scan reading all ~30k movie rows every run just to check
    // MAX_STUBS headroom -- getStubCount reads a maintained sync_state
    // counter instead (exact, since stubs are only ever created, never
    // deleted or promoted out of tier='stub').
    const initialStubCount = await step.do('count-stubs', () =>
      maxStubs > 0 ? getStubCount(repos) : Promise.resolve(0)
    );
    // Mutated in place by resolveOneGroup as stub slots get consumed within
    // this run; re-synced from each batch step's own stored result below so
    // a replay (resuming after an interruption) sees the right count
    // without re-running earlier steps' callbacks.
    const stubCountRef = { count: initialStubCount };

    const requeue = await step.do('requeue-overflow', () => requeueOverflowGroups(repos, maxStubs, stubCountRef.count));
    const groups = await step.do('fetch-unresolved-groups', () => repos.recommendation.getUnresolvedGroupedByTarget(RESOLVE_BATCH_SIZE));

    let resolvedToExisting = 0;
    let resolvedToStub = 0;
    let overflow = 0;
    let retryable = 0;
    // Persists across steps the same way stubCountRef.count does -- each
    // step re-derives it from its own stored return value on replay rather
    // than re-running earlier steps' callbacks.
    let callsUsed = 0;

    for (let i = 0; i < groups.length; i += GROUPS_PER_STEP) {
      const batch = groups.slice(i, i + GROUPS_PER_STEP);
      const callsUsedBefore = callsUsed;
      const batchResult = await step.do(`resolve-batch-${i / GROUPS_PER_STEP}`, async () => {
        let existing = 0;
        let stub = 0;
        let over = 0;
        let retry = 0;
        let used = callsUsedBefore;
        let stopped = false;
        for (const group of batch) {
          // Worst case first, since a group's actual cost (0 for a local
          // resolve) is only known after resolving it -- see
          // RESOLVE_MAX_CALLS_PER_GROUP.
          if (used + RESOLVE_MAX_CALLS_PER_GROUP > INSTANCE_SUBREQUEST_BUDGET) {
            stopped = true;
            break;
          }
          const outcome = await resolveOneGroup(this.env, repos, clients, group, maxStubs, stubCountRef);
          used += outcome.externalCalls;
          if (outcome.kind === 'resolved_existing') existing++;
          else if (outcome.kind === 'resolved_stub') stub++;
          else if (outcome.kind === 'overflow') over++;
          else retry++;
        }
        return { existing, stub, over, retry, stubCount: stubCountRef.count, callsUsed: used, stopped };
      });
      resolvedToExisting += batchResult.existing;
      resolvedToStub += batchResult.stub;
      overflow += batchResult.over;
      retryable += batchResult.retry;
      stubCountRef.count = batchResult.stubCount;
      callsUsed = batchResult.callsUsed;
      if (batchResult.stopped) break;
    }

    // Only a new stub changes any catalog_stats count (a stub gets a real
    // `type` value, see normalizeStubMovie) -- resolving to an existing
    // target just rewrites a foreign key, never a movie row.
    if (resolvedToStub > 0) {
      await step.do('refresh-catalog-stats', () => repos.catalogStats.refresh());
    }

    return {
      groupsSeen: groups.length,
      // Left unprocessed by the subrequest budget above -- still pending,
      // picked up by the next tick.
      deferred: groups.length - (resolvedToExisting + resolvedToStub + overflow + retryable),
      requeueCandidates: requeue.candidates,
      requeued: requeue.requeued,
      resolvedToExisting,
      resolvedToStub,
      overflow,
      retryable,
      stubCount: stubCountRef.count,
      maxStubs,
    };
  }
}
