// mirror.js — copies TMDB/OPhim artwork into R2 via the Worker's own binding
// (Phase 6), replacing catalog-api/src/r2.js. THE point of this phase: the
// VPS's r2.js signed every upload with hand-rolled AWS SigV4, which sha256's
// the entire image body in JS — the single heaviest CPU cost on the VPS. The
// R2 binding (env.BUCKET.put) does none of that: Cloudflare handles integrity
// internally, and the body streams straight through (res.body → put) with no
// JS-side hashing or buffering. So that CPU cost doesn't move to the Worker —
// it disappears.
//
// A Worker keeps no state between invocations, so r2.js's in-memory `known`
// Set / work queue become two D1 tables:
//   mirror_queue — images seen (during a build) but not yet copied.
//   mirrored     — keys known to be in the bucket (so we don't re-copy).
//
// Flow:
//   build (list/detail/home/rec) → enqueueMirror(targets)   [fire-and-forget]
//   cron */10 → drainMirrorQueue() → for each queued key:
//     HEAD R2 — already there (e.g. mirrored by the VPS before we took over)?
//       → just record it in `mirrored`, no fetch/put.
//     else → fetch upstream (streaming) → BUCKET.put(key, res.body) → record.
//
// NO 150-day re-queue is implemented: the bucket has no expiry lifecycle rule
// (checked 2026-08-01 — only the default multipart-abort), so objects never
// vanish and there's nothing to re-mirror. IF a TMDB-compliance expiry rule is
// ever added to redflare-r2, a re-queue of `mirrored` rows older than the
// expiry MUST be added here (else `mirrored` says "have it" forever while the
// object is gone → client falls back to upstream permanently). `created_at` is
// stored in `mirrored` precisely so that re-queue can be added later.

const MIRROR_BATCH = 20;          // queue rows pulled per cron run
const MIRROR_CONCURRENCY = 6;     // Worker's simultaneous-connection cap
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
// Immutable + 1-year browser/CDN cache — the key carries the upstream size, so
// an object at a given key never changes. This header is what keeps R2 Class B
// reads off the bucket (served from CDN cache instead) — see plan §5.
const OBJECT_CACHE_CONTROL = 'public, max-age=31536000, immutable';

// Accept: image/webp negotiates a WebP response from image.tmdb.org (it does
// content negotiation; img.ophim.live does not, so this is a no-op for it —
// harmless). cacheTtl: 0 bypasses Cloudflare's shared subrequest cache: TMDB
// sends no `Vary: Accept`, so a JPEG cached from an older request could
// otherwise be handed back here despite the Accept header (see state.md
// "Constraints discovered while planning" #2).
async function fetchWithTimeout(url, ms = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'user-agent': 'redflare-worker/1.0 (+phim.bluesia.net)',
        accept: 'image/webp,image/*,*/*',
      },
      cf: { cacheTtl: 0 },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function mapLimit(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        await fn(items[idx]);
      } catch {
        /* per-item; failures are counted inside fn */
      }
    }
  });
  await Promise.all(workers);
}

// --- enqueue (called fire-and-forget from build paths) ----------------------

// D1 caps bound parameters at 100 per query. The INSERT below binds 3 per
// target, so a batch must stay <= 33 targets; the SELECT binds 1 per target.
// A single list page yields ~48 targets, so chunk. (This was a real bug: an
// unchunked 48-target INSERT = 144 params, silently rejected by D1 — movies,
// with 2 targets, worked, masking it.)
const ENQUEUE_CHUNK = 30;

// targets: [{ key, sourceUrl }] (already deduped by key — see
// images.js mirrorTargets). Per chunk: skip keys already recorded as mirrored,
// then INSERT OR IGNORE the rest (the PK on `key` dedupes against what's
// already queued). Cheap enough to run on every cache-miss build via
// ctx.waitUntil.
export async function enqueueMirror(env, targets) {
  if (!targets || !targets.length) return;
  for (let i = 0; i < targets.length; i += ENQUEUE_CHUNK) {
    const chunk = targets.slice(i, i + ENQUEUE_CHUNK);
    const keys = chunk.map((t) => t.key);
    const ph = keys.map(() => '?').join(', ');
    const { results } = await env.DB.prepare(`SELECT key FROM mirrored WHERE key IN (${ph})`)
      .bind(...keys)
      .all();
    const have = new Set((results || []).map((r) => r.key));
    const todo = chunk.filter((t) => !have.has(t.key));
    if (!todo.length) continue;

    const now = Date.now();
    const values = todo.map(() => '(?, ?, ?)').join(', ');
    const binds = [];
    for (const t of todo) binds.push(t.key, t.sourceUrl, now);
    await env.DB.prepare(
      `INSERT OR IGNORE INTO mirror_queue (key, source_url, queued_at) VALUES ${values}`
    )
      .bind(...binds)
      .run();
  }
}

// --- drain (called from the mirror cron) ------------------------------------

async function markMirrored(env, key) {
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO mirrored (key, created_at) VALUES (?1, ?2)').bind(key, Date.now()),
    env.DB.prepare('DELETE FROM mirror_queue WHERE key = ?1').bind(key),
  ]);
}

// How long to keep insisting on WebP before settling for whatever TMDB serves.
// The Accept-negotiation check below is worth a few retries (TMDB sends no
// `Vary: Accept`, so a JPEG cached upstream can be handed back for a while),
// but not forever: some images never negotiate at all — 4 of them as of
// 2026-08-04, unchanged across ~50 consecutive attempts. Retrying those
// forever costs twice over: the object never lands, so every view of that
// title falls back to the TMDB origin; and since drainMirrorQueue pulls
// `ORDER BY queued_at`, the stuck rows are the oldest and therefore reoccupy
// a slot in *every* drain, permanently eating that share of the batch.
const WEBP_GRACE_MS = 60 * 60 * 1000;

// Returns 'exists' | 'mirrored' | 'mirrored-nonwebp' | 'give-up' | 'retry'.
async function mirrorOne(env, key, sourceUrl, queuedAt) {
  // 1. Already in the bucket (the VPS mirrored it before we took over, or a
  //    previous run did)? Record it, no fetch/put. R2 HEAD is a cheap Class B
  //    op — this is what stops us re-downloading the ~734 objects already there.
  let head;
  try {
    head = await env.BUCKET.head(key);
  } catch {
    return 'retry'; // transient R2 error — leave queued
  }
  if (head) {
    await markMirrored(env, key);
    return 'exists';
  }

  // 2. Not there — fetch upstream and stream it in.
  let res;
  try {
    res = await fetchWithTimeout(sourceUrl);
  } catch {
    return 'retry'; // network blip — try next cron
  }
  if (!res || !res.ok) {
    // A permanent 4xx (image genuinely gone) — give up so it doesn't clog the
    // queue forever. It'll re-enqueue naturally if an item still references it,
    // and the client falls back to upstream meanwhile.
    if (res && res.status >= 400 && res.status < 500) {
      await env.DB.prepare('DELETE FROM mirror_queue WHERE key = ?1').bind(key).run();
      return 'give-up';
    }
    return 'retry';
  }
  const ct = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!ct.startsWith('image/')) {
    await env.DB.prepare('DELETE FROM mirror_queue WHERE key = ?1').bind(key).run();
    return 'give-up';
  }
  // A key we're queuing as `<original>.webp` should hold WebP bytes, so a
  // non-WebP response is worth retrying (see WEBP_GRACE_MS) — but only for a
  // while. Past the grace window, store what we were given: the object carries
  // its REAL content-type below, so browsers render it correctly regardless of
  // the `.webp` in the key, and a slightly larger mirrored image beats one that
  // never mirrors at all.
  const nonWebp = key.endsWith('.webp') && ct !== 'image/webp';
  if (nonWebp && Date.now() - queuedAt < WEBP_GRACE_MS) {
    return 'retry';
  }
  const clen = Number(res.headers.get('content-length') || 0);
  if (clen && clen > MAX_IMAGE_BYTES) {
    await env.DB.prepare('DELETE FROM mirror_queue WHERE key = ?1').bind(key).run();
    return 'give-up';
  }

  try {
    // Streaming put — res.body is a ReadableStream; no JS-side hashing or full
    // buffering. This is the CPU cost that used to dominate the VPS, gone.
    await env.BUCKET.put(key, res.body, {
      httpMetadata: { contentType: ct, cacheControl: OBJECT_CACHE_CONTROL },
    });
  } catch {
    return 'retry';
  }
  await markMirrored(env, key);
  return nonWebp ? 'mirrored-nonwebp' : 'mirrored';
}

export async function drainMirrorQueue(env) {
  const { results } = await env.DB.prepare(
    'SELECT key, source_url, queued_at FROM mirror_queue ORDER BY queued_at LIMIT ?1'
  )
    .bind(MIRROR_BATCH)
    .all();
  const rows = results || [];
  if (!rows.length) return { drained: 0 };

  const counts = { exists: 0, mirrored: 0, 'give-up': 0, retry: 0 };
  await mapLimit(rows, MIRROR_CONCURRENCY, async (row) => {
    const outcome = await mirrorOne(env, row.key, row.source_url, row.queued_at);
    counts[outcome] = (counts[outcome] || 0) + 1;
  });
  console.log('[mirror drain]', { pulled: rows.length, ...counts });
  return { drained: rows.length, ...counts };
}
