import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { getRecommendation } from '../src/api/ophim.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('recommendation client returns normalized items for a successful response', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({
    items: [{ slug: 'target', name: 'Target', poster_url: 'poster.jpg' }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });

  const [item] = await getRecommendation(901, 'tv');
  assert.equal(item.slug, 'target');
  assert.equal(item.thumb_url, 'poster.jpg');
});

test('recommendation client keeps valid empty distinct from a request failure', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ items: [] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  assert.deepEqual(await getRecommendation(902), []);

  globalThis.fetch = async () => new Response('unavailable', { status: 503 });
  await assert.rejects(getRecommendation(903), /API Error: 503/);
});
