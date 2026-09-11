import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { dispatchScheduledWorkflows } from '../src-ssr/services/sync/dispatch.ts';

// docs/plan-incremental-sync-stall.md Phase 3: the classic Cron Trigger's
// scheduled() handler fans one */30 tick out into Workflow.create() calls.
// Cadence and the RECOMMENDATION_JOBS_ENABLED / BACKFILL_ENABLED gates all
// live in dispatchScheduledWorkflows.

const WORKFLOW_ID_RE = /^[a-zA-Z0-9_][a-zA-Z0-9-_]*$/;
const BASE = Date.parse('2026-09-10T12:00:00.000Z'); // top of an hour

let restore = () => {};
afterEach(() => restore());

function harness({ minute = 0, recommendation = 'false', backfill = 'false', throwFor = null } = {}) {
  const created = [];
  const errors = [];
  const original = console.error;
  console.error = (line) => errors.push(JSON.parse(line));
  restore = () => {
    console.error = original;
  };

  const mkWorkflow = (name) => ({
    async create({ id } = {}) {
      if (throwFor === name) throw new Error(`${name} unavailable`);
      created.push({ name, id });
      return { id };
    },
  });

  const env = {
    RECOMMENDATION_JOBS_ENABLED: recommendation,
    BACKFILL_ENABLED: backfill,
    INCREMENTAL_SYNC_WORKFLOW: mkWorkflow('incremental-sync'),
    HERO_SNAPSHOT_WORKFLOW: mkWorkflow('hero-snapshot'),
    RECOMMENDATION_RESOLVE_WORKFLOW: mkWorkflow('recommendation-resolve'),
    RECOMMENDATION_REFRESH_WORKFLOW: mkWorkflow('recommendation-refresh'),
    BACKFILL_WORKFLOW: mkWorkflow('backfill'),
  };

  return { env, scheduledTime: BASE + minute * 60_000, created, errors };
}

const names = (created) => created.map((c) => c.name);

test('a mid-hour tick starts only incremental sync', async () => {
  const h = harness({ minute: 30 });
  await dispatchScheduledWorkflows(h.env, h.scheduledTime);
  assert.deepEqual(names(h.created), ['incremental-sync']);
  assert.equal(h.errors.length, 0);
});

test('a top-of-hour tick also starts the hero snapshot', async () => {
  const h = harness({ minute: 0 });
  await dispatchScheduledWorkflows(h.env, h.scheduledTime);
  assert.deepEqual(names(h.created), ['incremental-sync', 'hero-snapshot']);
});

test('recommendation jobs stay off unless RECOMMENDATION_JOBS_ENABLED is "true"', async () => {
  const off = harness({ minute: 0, recommendation: 'false' });
  await dispatchScheduledWorkflows(off.env, off.scheduledTime);
  assert.ok(!names(off.created).some((n) => n.startsWith('recommendation-')));

  const onHalfHour = harness({ minute: 30, recommendation: 'true' });
  await dispatchScheduledWorkflows(onHalfHour.env, onHalfHour.scheduledTime);
  assert.deepEqual(names(onHalfHour.created), ['incremental-sync', 'recommendation-resolve']);

  const onTopOfHour = harness({ minute: 0, recommendation: 'true' });
  await dispatchScheduledWorkflows(onTopOfHour.env, onTopOfHour.scheduledTime);
  assert.deepEqual(names(onTopOfHour.created), [
    'incremental-sync',
    'hero-snapshot',
    'recommendation-resolve',
    'recommendation-refresh',
  ]);
});

test('backfill runs only when BACKFILL_ENABLED is "true"', async () => {
  const off = harness({ minute: 30 });
  await dispatchScheduledWorkflows(off.env, off.scheduledTime);
  assert.ok(!names(off.created).includes('backfill'));

  const on = harness({ minute: 30, backfill: 'true' });
  await dispatchScheduledWorkflows(on.env, on.scheduledTime);
  assert.deepEqual(names(on.created), ['incremental-sync', 'backfill']);
});

test('one workflow create() throwing does not stop the others, and is logged', async () => {
  const h = harness({ minute: 0, throwFor: 'incremental-sync' });
  await assert.doesNotReject(() => dispatchScheduledWorkflows(h.env, h.scheduledTime));
  assert.deepEqual(names(h.created), ['hero-snapshot'], 'hero still starts after incremental threw');
  assert.equal(h.errors.length, 1);
  assert.equal(h.errors[0].message, 'workflow dispatch failed');
  assert.equal(h.errors[0].workflow, 'incremental-sync');
});

test('every instance id is deterministic in scheduledTime and matches the Workflows id grammar', async () => {
  const h = harness({ minute: 0, recommendation: 'true', backfill: 'true' });
  await dispatchScheduledWorkflows(h.env, h.scheduledTime);

  assert.equal(h.created.length, 5);
  for (const { id } of h.created) {
    assert.match(id, WORKFLOW_ID_RE);
    assert.ok(id.endsWith(String(h.scheduledTime)), `${id} carries the tick timestamp`);
  }
  // A replayed tick reuses the exact same ids, so Workflows dedupes it.
  const replay = harness({ minute: 0, recommendation: 'true', backfill: 'true' });
  await dispatchScheduledWorkflows(replay.env, replay.scheduledTime);
  assert.deepEqual(replay.created.map((c) => c.id), h.created.map((c) => c.id));
});
