import { WorkflowEntrypoint, type WorkflowStep, type WorkflowEvent } from 'cloudflare:workers';
import {
  buildRepos,
  buildClients,
  requeueOverflowGroups,
  resolveOneGroup,
  getStubCount,
  RESOLVE_BATCH_SIZE,
} from '../services/sync/orchestrator';

// docs/state-free-plan-migration.md Phase 0 measured this job at ~169
// external subrequests in one invocation against a real backlog -- over 3x
// the Free-plan 50/invocation cap. Chunking groups into small per-step
// batches instead of one wall-time-bounded loop keeps each step's own
// external-call count small regardless of backlog size. resolveOneGroup's
// worst case (kkphim.getByTmdbRef + syncOneMovie's kkphim detail + TMDB
// detail + season + recommendations) is ~5 external calls/group, so 15
// was already over the 50/step cap (15*5=75) whenever the overflow-heavy
// stub-not-full branch actually runs -- 8 keeps the worst case (8*5=40)
// under it. See docs/state-free-plan-migration.md Phase 6.
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

    for (let i = 0; i < groups.length; i += GROUPS_PER_STEP) {
      const batch = groups.slice(i, i + GROUPS_PER_STEP);
      const batchResult = await step.do(`resolve-batch-${i / GROUPS_PER_STEP}`, async () => {
        let existing = 0;
        let stub = 0;
        let over = 0;
        let retry = 0;
        for (const group of batch) {
          const outcome = await resolveOneGroup(this.env, repos, clients, group, maxStubs, stubCountRef);
          if (outcome.kind === 'resolved_existing') existing++;
          else if (outcome.kind === 'resolved_stub') stub++;
          else if (outcome.kind === 'overflow') over++;
          else retry++;
        }
        return { existing, stub, over, retry, stubCount: stubCountRef.count };
      });
      resolvedToExisting += batchResult.existing;
      resolvedToStub += batchResult.stub;
      overflow += batchResult.over;
      retryable += batchResult.retry;
      stubCountRef.count = batchResult.stubCount;
    }

    // Only a new stub changes any catalog_stats count (a stub gets a real
    // `type` value, see normalizeStubMovie) -- resolving to an existing
    // target just rewrites a foreign key, never a movie row.
    if (resolvedToStub > 0) {
      await step.do('refresh-catalog-stats', () => repos.catalogStats.refresh());
    }

    return {
      groupsSeen: groups.length,
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
