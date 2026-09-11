import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { afterEach, test } from 'node:test';
import { Miniflare } from 'miniflare';
import { apiRoute } from '../src-ssr/api/routes.ts';
import { INCREMENTAL_STALE_SECONDS, HERO_STALE_SECONDS } from '../src-ssr/services/sync/dispatch.ts';

// docs/plan-incremental-sync-stall.md Phase 4: GET /api/health/sync is a
// public 200/503 probe an external monitor can watch, so a stall like
// 2026-09-07's trips an alert within the hour instead of being noticed
// weeks later.
const instances = [];
afterEach(async () => Promise.all(instances.splice(0).map((mf) => mf.dispose())));

async function setup() {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok"); } };',
    d1Databases: { DB: crypto.randomUUID() },
  });
  instances.push(mf);
  const db = await mf.getD1Database('DB');
  const sql = await readFile(new URL('../migrations/0005_ssr_schema.sql', import.meta.url), 'utf8');
  await db.batch(
    sql.replaceAll(/--.*$/gm, '').split(';').map((s) => s.trim()).filter(Boolean).map((s) => db.prepare(s))
  );
  return db;
}

async function seedState(db, key, value) {
  await db.prepare('INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, value, Math.floor(Date.now() / 1000))
    .run();
}

const call = (db) => apiRoute.fetch(new Request('https://worker.test/api/health/sync'), { DB: db });

test('200 with small ages while both jobs are fresh', async () => {
  const db = await setup();
  const now = Math.floor(Date.now() / 1000);
  await seedState(db, 'recent:last_run', JSON.stringify({ stopReason: 'known_page', recordedAt: new Date().toISOString() }));
  await seedState(db, 'hero:last_success_at', String(now - 120));

  const res = await call(db);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('cache-control') ?? '', /no-store/);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(body.incrementalAgeSeconds >= 0 && body.incrementalAgeSeconds < 60);
  assert.ok(body.heroAgeSeconds >= 120 && body.heroAgeSeconds < 180);
  // No internal detail leaks.
  assert.deepEqual(Object.keys(body).sort(), ['heroAgeSeconds', 'incrementalAgeSeconds', 'ok']);
});

test('503 when the incremental sync has gone stale', async () => {
  const db = await setup();
  const now = Math.floor(Date.now() / 1000);
  const stale = new Date(Date.now() - (INCREMENTAL_STALE_SECONDS + 300) * 1000).toISOString();
  await seedState(db, 'recent:last_run', JSON.stringify({ recordedAt: stale }));
  await seedState(db, 'hero:last_success_at', String(now - 60));

  const res = await call(db);
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.ok(body.incrementalAgeSeconds > INCREMENTAL_STALE_SECONDS);
});

test('503 when the hero snapshot has gone stale', async () => {
  const db = await setup();
  await seedState(db, 'recent:last_run', JSON.stringify({ recordedAt: new Date().toISOString() }));
  await seedState(db, 'hero:last_success_at', String(Math.floor(Date.now() / 1000) - (HERO_STALE_SECONDS + 300)));

  const res = await call(db);
  assert.equal(res.status, 503);
  assert.equal((await res.json()).ok, false);
});

test('503 with null ages when neither job has ever recorded a success', async () => {
  const db = await setup();
  const res = await call(db);
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.deepEqual(body, { ok: false, incrementalAgeSeconds: null, heroAgeSeconds: null });
});
