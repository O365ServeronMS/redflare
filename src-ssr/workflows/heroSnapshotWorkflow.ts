import { WorkflowEntrypoint, type WorkflowStep, type WorkflowEvent } from 'cloudflare:workers';
import type { Env } from '../types/env';
import {
  buildDependencies,
  resolveCandidate,
  dedupeTrendingMovies,
  HERO_REFRESH_INTERVAL_SECONDS,
} from '../services/sync/heroSnapshot';
import type { HeroSnapshotEntry } from '../types/heroSnapshot';

/** Free-plan-safe replacement for heroSnapshot.ts's refreshHeroSnapshot,
 * which does its ~20-candidate loop (each candidate can trigger a full
 * syncOneMovie internally) inside one function call. Wrapped in one
 * step.do() that would still be one invocation's worth of subrequests --
 * docs/state-free-plan-migration.md Phase 0 measured this exact job at
 * ~60+ external subrequests when it actually runs (not skipped by the
 * 30-minute gate), over the Free-plan 50/invocation cap on its own. Here
 * each candidate gets its own step instead. Keeps the same 30-minute gate
 * (HERO_REFRESH_INTERVAL_SECONDS) so a real run only happens roughly once
 * per hour even under a tighter cron schedule, bounding step count. */
export class HeroSnapshotWorkflow extends WorkflowEntrypoint<Env> {
  override async run(_event: WorkflowEvent<unknown>, step: WorkflowStep) {
    const deps = await buildDependencies(this.env);

    const gate = await step.do('check-gate', async () => {
      const state = await deps.hero.getRefreshState();
      const now = Math.floor(Date.now() / 1000);
      const due = state.lastSuccessAt === null || now - state.lastSuccessAt >= HERO_REFRESH_INTERVAL_SECONDS;
      return { due, now };
    });
    if (!gate.due) return { skipped: true, matched: 0, failed: 0 };

    const trending = await step.do('fetch-trending', () => deps.tmdb.getTrendingMovies('week'));
    if (!trending) {
      await step.do('record-failed-attempt', () =>
        deps.hero.recordAttempt(gate.now, { tmdbCount: 0, matchedCount: 0, notFoundCount: 0, failedCount: 1 })
      );
      return { skipped: false, matched: 0, failed: 1 };
    }

    const candidates = dedupeTrendingMovies(trending.movies);
    const rows: HeroSnapshotEntry[] = [];
    let notFound = 0;
    let filteredType = trending.rejectedTypeCount;
    let filteredNoStream = 0;
    let filteredNoBackdrop = 0;
    let failed = 0;

    for (const candidate of candidates) {
      const outcome = await step.do(`resolve-candidate-${candidate.id}`, () => resolveCandidate(candidate, deps));
      if (outcome.kind === 'matched') rows.push(outcome.row);
      else if (outcome.kind === 'not_found') notFound++;
      else if (outcome.kind === 'filtered_type') filteredType++;
      else if (outcome.kind === 'filtered_no_stream') filteredNoStream++;
      else if (outcome.kind === 'filtered_no_backdrop') filteredNoBackdrop++;
      else failed++;
    }

    const result = { tmdbCount: trending.fetchedCount, matchedCount: rows.length, notFoundCount: notFound, failedCount: failed };
    if (failed > 0) {
      // Same "don't replace a last-good snapshot with a partial one" rule
      // as refreshHeroSnapshot -- any retryable candidate failure keeps the
      // existing snapshot and just records the attempt.
      await step.do('record-failed-attempt', () => deps.hero.recordAttempt(gate.now, result));
      return { skipped: false, matched: rows.length, failed };
    }

    await step.do('write-snapshot', () =>
      deps.hero.replaceSnapshot(rows, { lastSuccessAt: gate.now, lastAttemptAt: gate.now, result })
    );
    return { skipped: false, matched: rows.length, notFound, filteredType, filteredNoStream, filteredNoBackdrop, failed };
  }
}
