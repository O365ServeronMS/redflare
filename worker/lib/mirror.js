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

// Returns 'exists' | 'mirrored' | 'give-up' | 'retry'.
async function mirrorOne(env, key, sourceUrl) {
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
  // A key we're queuing as `<original>.webp` must actually be WebP bytes —
  // otherwise a JPEG would land under a .webp key (e.g. TMDB serving JPEG
  // despite the Accept header some future day). Retry rather than give-up:
  // this is expected to be transient, not a permanent 4xx.
  if (key.endsWith('.webp') && ct !== 'image/webp') {
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
  return 'mirrored';
}

export async function drainMirrorQueue(env) {
  const { results } = await env.DB.prepare(
    'SELECT key, source_url FROM mirror_queue ORDER BY queued_at LIMIT ?1'
  )
    .bind(MIRROR_BATCH)
    .all();
  const rows = results || [];
  if (!rows.length) return { drained: 0 };

  const counts = { exists: 0, mirrored: 0, 'give-up': 0, retry: 0 };
  await mapLimit(rows, MIRROR_CONCURRENCY, async (row) => {
    const outcome = await mirrorOne(env, row.key, row.source_url);
    counts[outcome] = (counts[outcome] || 0) + 1;
  });
  console.log('[mirror drain]', { pulled: rows.length, ...counts });
  return { drained: rows.length, ...counts };
}

// --- rekey (Phase A of the .jpg.webp -> .webp key-shape migration) ---------
//
// The Phase 3-5 mirror used an APPENDED suffix (t/p/w500/<hash>.jpg.webp) so
// upstreamForKey never had to guess the original extension while both jpg and
// webp objects coexisted. Now that TMDB source images are confirmed always
// .jpg (verified against every key in D1 `mirrored`), a SWAPPED suffix
// (t/p/w500/<hash>.webp) is safe and strictly better: webpKeyFor becomes
// idempotent, which makes the double-.webp bug from the earlier migration
// (see CLAUDE.md/git history) structurally impossible rather than
// guarded-against.
//
// This is an IN-BUCKET COPY (BUCKET.get -> BUCKET.put), not a re-fetch from
// TMDB: the WebP bytes already exist and are correct, so there's no reason to
// touch TMDB/BunnyCDN again (and no exposure to the Vary:Accept caching issue
// mirrorOne above works around). The old .jpg.webp object and its `mirrored`
// row are left untouched here — deleting them is a separate, later step
// (Phase C) run only once every reader has been confirmed to use the new key
// (worker/lib/images.js webpKeyFor still emits .jpg.webp until that flip
// ships), so both names resolve throughout this phase.
const REKEY_SUFFIX_OLD = '.jpg.webp';
const REKEY_SUFFIX_NEW = '.webp';
const REKEY_CHECK_CHUNK = 90; // D1's 100-bound-param cap, same margin as ENQUEUE_CHUNK above

function rekeyedKeyFor(oldKey) {
  return `${oldKey.slice(0, -REKEY_SUFFIX_OLD.length)}${REKEY_SUFFIX_NEW}`;
}

async function alreadyRekeyed(env, newKeys) {
  const done = new Set();
  for (let i = 0; i < newKeys.length; i += REKEY_CHECK_CHUNK) {
    const chunk = newKeys.slice(i, i + REKEY_CHECK_CHUNK);
    const ph = chunk.map(() => '?').join(', ');
    const { results } = await env.DB.prepare(`SELECT key FROM mirrored WHERE key IN (${ph})`)
      .bind(...chunk)
      .all();
    for (const r of results || []) done.add(r.key);
  }
  return done;
}

// Returns 'rekeyed' | 'exists' | 'give-up' | 'retry'.
async function rekeyOne(env, oldKey) {
  const newKey = rekeyedKeyFor(oldKey);
  let head;
  try {
    head = await env.BUCKET.head(newKey);
  } catch {
    return 'retry';
  }
  if (!head) {
    let obj;
    try {
      obj = await env.BUCKET.get(oldKey);
    } catch {
      return 'retry';
    }
    // The .jpg.webp object this row claims to exist doesn't (shouldn't
    // happen — mirrored rows are only ever written after a successful put —
    // but nothing to copy from if it's somehow gone). Give up rather than
    // retry forever; if the title is still referenced it re-enqueues via the
    // normal mirror path under its now-current key shape once Phase B ships.
    if (!obj) return 'give-up';
    try {
      await env.BUCKET.put(newKey, obj.body, { httpMetadata: obj.httpMetadata });
    } catch {
      return 'retry';
    }
  }
  try {
    await env.DB.prepare('INSERT OR IGNORE INTO mirrored (key, created_at) VALUES (?1, ?2)')
      .bind(newKey, Date.now())
      .run();
  } catch {
    return 'retry';
  }
  return head ? 'exists' : 'rekeyed';
}

export async function drainRekeyBatch(env) {
  // Over-fetch and filter out rows already processed by a previous tick —
  // there's no separate progress-tracking table, `mirrored` itself (checked
  // via alreadyRekeyed) is the source of truth for what's done.
  const { results } = await env.DB.prepare(
    "SELECT key FROM mirrored WHERE key LIKE '%.jpg.webp' ORDER BY key LIMIT ?1"
  )
    .bind(MIRROR_BATCH * 3)
    .all();
  const oldKeys = (results || []).map((r) => r.key);
  if (!oldKeys.length) return { drained: 0, remaining: 0 };

  const newKeys = oldKeys.map(rekeyedKeyFor);
  const done = await alreadyRekeyed(env, newKeys);

  const todo = [];
  for (let i = 0; i < oldKeys.length && todo.length < MIRROR_BATCH; i++) {
    if (!done.has(newKeys[i])) todo.push(oldKeys[i]);
  }
  if (!todo.length) return { drained: 0, remaining: 0 };

  const counts = { rekeyed: 0, exists: 0, 'give-up': 0, retry: 0 };
  await mapLimit(todo, MIRROR_CONCURRENCY, async (oldKey) => {
    const outcome = await rekeyOne(env, oldKey);
    counts[outcome] = (counts[outcome] || 0) + 1;
  });
  console.log('[rekey drain]', { pulled: todo.length, ...counts });
  return { drained: todo.length, ...counts };
}
