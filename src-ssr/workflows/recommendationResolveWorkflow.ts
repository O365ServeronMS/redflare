import { WorkflowEntrypoint, type WorkflowStep, type WorkflowEvent } from 'cloudflare:workers';
import type { Env } from '../types/env';
import {
  buildRepos,
  buildClients,
  requeueOverflowGroups,
  resolveOneGroup,
  RESOLVE_BATCH_SIZE,
} from '../services/sync/orchestrator';

// docs/state-free-plan-migration.md Phase 0 measured this job at ~169
// external subrequests in one invocation against a real backlog -- over 3x
// the Free-plan 50/invocation cap. Chunking groups into small per-step
// batches instead of one wall-time-bounded loop keeps each step's own
// external-call count small regardless of backlog size.
const GROUPS_PER_STEP = 15;

/** Free-plan-safe replacement for orchestrator.ts's runRecommendationResolveTick,
 * which resolves up to RESOLVE_BATCH_SIZE groups in one wall-time-bounded
 * loop inside a single invocation. */
export class RecommendationResolveWorkflow extends WorkflowEntrypoint<Env> {
  override async run(_event: WorkflowEvent<unknown>, step: WorkflowStep) {
    const repos = buildRepos(this.env);
    const clients = buildClients(this.env, 1);
    const configuredMaxStubs = Number(this.env.MAX_STUBS ?? '0');
    const maxStubs = Number.isFinite(configuredMaxStubs) ? Math.max(0, Math.floor(configuredMaxStubs)) : 0;

    const initialStubCount = await step.do('count-stubs', () =>
      maxStubs > 0 ? repos.movie.countByTier('stub') : Promise.resolve(0)
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
    let cacheTagsPurged = 0;

    for (let i = 0; i < groups.length; i += GROUPS_PER_STEP) {
      const batch = groups.slice(i, i + GROUPS_PER_STEP);
      const batchResult = await step.do(`resolve-batch-${i / GROUPS_PER_STEP}`, async () => {
        let existing = 0;
        let stub = 0;
        let over = 0;
        let retry = 0;
        let purged = 0;
        for (const group of batch) {
          const outcome = await resolveOneGroup(this.env, repos, clients, group, maxStubs, stubCountRef);
          purged += outcome.cacheTagsPurged;
          if (outcome.kind === 'resolved_existing') existing++;
          else if (outcome.kind === 'resolved_stub') stub++;
          else if (outcome.kind === 'overflow') over++;
          else retry++;
        }
        return { existing, stub, over, retry, purged, stubCount: stubCountRef.count };
      });
      resolvedToExisting += batchResult.existing;
      resolvedToStub += batchResult.stub;
      overflow += batchResult.over;
      retryable += batchResult.retry;
      cacheTagsPurged += batchResult.purged;
      stubCountRef.count = batchResult.stubCount;
    }

    return {
      groupsSeen: groups.length,
      requeueCandidates: requeue.candidates,
      requeued: requeue.requeued,
      resolvedToExisting,
      resolvedToStub,
      overflow,
      retryable,
      cacheTagsPurged,
      stubCount: stubCountRef.count,
      maxStubs,
    };
  }
}
