import { WorkflowEntrypoint, type WorkflowStep, type WorkflowEvent } from 'cloudflare:workers';
import {
  scanRecentSlugs,
  commitRecentCursor,
  persistRecentSummary,
  buildRepos,
  buildClients,
  type IncrementalSyncResult,
} from '../services/sync/orchestrator';
import { syncOneMovie } from '../services/sync/syncMovie';

/** Free-plan-safe replacement for orchestrator.ts's runIncrementalSync
 * SELF-fan-out shape (docs/plan-free-plan-migration.md Phase 3): one step
 * scans the recent feed, then every candidate slug gets its own step --
 * each step gets a fresh CPU/subrequest budget instead of all of them
 * sharing one invocation's (docs/state-free-plan-migration.md Phase 0
 * measured this exact invocation shape blowing the Free-plan subrequest cap
 * for the other jobs sharing the old scheduled() invocation). Scheduled
 * independently (wrangler.toml [[workflows]] schedules) so this one's
 * cadence -- every 30 min, per the explicit "chỉ cần mỗi 30' quét page 1
 * của api" request -- doesn't have to match the other four sync
 * Workflows'. */
export class IncrementalSyncWorkflow extends WorkflowEntrypoint<Env> {
  override async run(_event: WorkflowEvent<unknown>, step: WorkflowStep): Promise<IncrementalSyncResult> {
    const scan = await step.do('scan-recent-pages', () => scanRecentSlugs(this.env));

    const repos = buildRepos(this.env);
    // shardDivisor 1: no more SELF fan-out to split the aggregate rate
    // limit across, so this one Workflow instance gets the full budget.
    const clients = buildClients(this.env, 1);

    let written = 0;
    let unchanged = 0;
    let failed = 0;
    let rowsWritten = 0;
    for (const slug of scan.slugs) {
      const result = await step.do(`sync-${slug}`, () => syncOneMovie(this.env, slug, clients, repos));
      if (result.outcome === 'written') {
        written++;
        rowsWritten += result.rowsWritten;
      } else if (result.outcome === 'unchanged') {
        unchanged++;
      } else {
        failed++;
      }
    }

    // Advance the cursor only after every slug from this scan synced
    // cleanly -- same "no partial advance" invariant runIncrementalSync
    // enforces inline, just checked here instead.
    let cursorAfter = scan.cursorBefore;
    if (!scan.scanFailed && scan.scanComplete && failed === 0 && scan.newest) {
      const newest = scan.newest;
      await step.do('advance-cursor', () => commitRecentCursor(this.env, newest));
      cursorAfter = newest;
    }

    // catalog_stats (migrations/0013_query_optimization.sql) only needs
    // recomputing when a movie row actually changed -- steady-state ticks
    // write nothing (docs/state-free-plan-migration.md Phase 4 observed
    // `written: 0` in typical runs), so this step is skipped far more often
    // than it runs.
    if (written > 0) {
      await step.do('refresh-catalog-stats', () => repos.catalogStats.refresh());
    }

    const result: IncrementalSyncResult = {
      slugsFound: scan.slugs.length,
      fetched: scan.fetched,
      processed: scan.slugs.length,
      written,
      unchanged,
      failed: failed + (scan.scanFailed ? 1 : 0),
      rowsWritten,
      pagesScanned: scan.pagesScanned,
      stopReason: scan.stopReason,
      cursorBefore: scan.cursorBefore,
      cursorAfter,
      shards: [],
    };
    await step.do('persist-summary', () => persistRecentSummary(repos, result));
    return result;
  }
}
