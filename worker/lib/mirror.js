// mirror.js — copies TMDB/KKPhim artwork into R2 via the Worker's own binding
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
//     else → fetch upstream (streamed when the response carries a
//            content-length, buffered when it doesn't — see mirrorOne)
//            → BUCKET.put(key, body) → record.
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

// accept: image/webp is a holdover from when this fetch was the ONLY thing
// negotiating WebP out of TMDB directly (see WSRV block below for why that's
// no longer how a TMDB `.webp` key gets its bytes) — harmless to keep, since
// the only path still hitting an origin directly is WSRV_ENABLED=false
// (rollback) or a KKPhim fetch (never goes through wsrv.nl — see below).
// cacheTtl: 0 bypasses Cloudflare's shared
// subrequest cache: TMDB sends no `Vary: Accept`, so a JPEG cached from an
// older request could otherwise be handed back here despite the Accept
// header (see state.md "Constraints discovered while planning" #2).
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

// --- wsrv.nl: the actual source of every `.webp` object's bytes ------------
//
// TMDB negotiates WebP via `Accept`, but sends no `Vary: Accept` — a JPEG
// response cached anywhere in front of it can be handed back regardless of
// the header. That made the `.webp` key an unreliable promise: measured
// 2026-08-06, ~1.7% of already-mirrored objects held JPEG bytes under a
// `.webp` key, silently (browsers go by content-type, not the extension, so
// nothing looked broken).
//
// wsrv.nl (open source, BSD-3-Clause, self-hostable — https://wsrv.nl) makes
// format a property of the URL (`&output=webp`), not a negotiated header, so
// it can't disagree with itself the way content negotiation did. Verified
// 2026-08-06 against this project's real TMDB images: byte-identical output
// across 5 consecutive requests, `content-length` present (streams straight
// through below — no buffering needed, unlike OPhim's chunked responses),
// dimensions unchanged from source when no `w` is requested, q=75 came out
// smaller than TMDB's own negotiated WebP for every sample.
//
// OPhim (added same day, once the above held up in production): OPhim has no
// TMDB-style size variants — one URL, one native resolution, sometimes
// several MB (a raw thumb source sampled 2026-08-06 was 1.8MB). Old design
// mirrored that raw size and resized at SERVE time via a Cloudflare Image
// Transformation (`cdn-cgi/image/width=...`, see src/api/ophim.js history).
// wsrv.nl's `&w=` does the resize in the SAME pass as the WebP conversion, so
// the mirror step now stores an already-correctly-sized object and that
// serve-time transform is gone entirely — one less moving part, and it frees
// up the zone's Image Transformations quota for something else later.
// `&we` (without-enlargement) matters here: verified 2026-08-06 that wsrv.nl
// upscales past native resolution by default when `&w=` exceeds it (common
// for OPhim's landscape "poster" field, native as small as 500px wide) —
// without `&we` that came out LARGER than the old Cloudflare transform for
// every sample; with it, smaller in every case tested (thumb AND poster).
//
// Free-tier limit is 2,500 uncached images/10min/IP; MIRROR_BATCH below uses
// well under 1% of that even with OPhim included.
//
// OPhim's catalog died 2026-08-06 (500s on every endpoint) and was replaced
// by KKPhim same day (docs/plan-kkphim-migration.md) — the `ophim/w<width>/`
// key segment described above no longer exists (KKPhim keys are `kkphim/`,
// see worker/lib/images.js). wsrv.nl now applies to TMDB ONLY. KKPhim was
// deliberately NOT routed through it: (1) wsrv.nl actively rejects
// phimimg.com — "Domain or TLD blocked by policy" (measured 2026-08-06) —
// and (2) it wouldn't have helped anyway, since KKPhim source images arrive
// already correctly sized (tens of KB, not OPhim's multi-MB) and aren't
// missing WebP the way TMDB's negotiated ones sometimes were. See the
// isKkphim gate in mirrorOne below.
const WSRV_ENABLED = true; // flip to false + deploy to roll back instantly
const WSRV_QUALITY = 75; // chosen 2026-08-06 by eyeballing real posters/backdrops

function wsrvWebpUrl(upstreamUrl) {
  return `https://wsrv.nl/?url=${encodeURIComponent(upstreamUrl)}&output=webp&q=${WSRV_QUALITY}`;
}

// A 4xx/5xx from wsrv.nl is ambiguous: the ORIGIN image could genuinely be
// gone (safe to give up on) or wsrv.nl itself could be having a bad moment
// (should retry, not delete the queue row). This resolves that by checking
// the origin directly — one extra subrequest, only spent on the error path.
// `false` on our own network hiccup is deliberate: we can't prove the image
// is dead, so default to "still alive" and let the row retry rather than
// wrongly deleting it.
async function isUpstreamDead(url, ms = 5000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      signal: ctrl.signal,
      headers: { 'user-agent': 'redflare-worker/1.0 (+phim.bluesia.net)' },
    });
    return res.status >= 400 && res.status < 500;
  } catch {
    return false;
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

// How long a row may keep coming back `retry` before it is dropped from the
// queue entirely. Every retry path above is silent by design (transient R2 /
// network / wsrv.nl errors), so a row that fails *permanently* for a reason
// we didn't anticipate looks exactly like one that will succeed next tick —
// and, because drainMirrorQueue pulls `ORDER BY queued_at`, it reoccupies a
// slot in every subsequent drain, starving the head of the queue. Dropping
// the row is not "give up forever": the key isn't recorded in `mirrored`, so
// the next build referencing it re-enqueues it with a fresh queued_at — i.e.
// it retries from the BACK of the queue instead of blocking the front.
const MAX_RETRY_AGE_MS = 6 * 60 * 60 * 1000;

// Returns { outcome, detail } where outcome is
// 'exists' | 'mirrored' | 'give-up' | 'retry'.
// `detail` names the step that failed on a retry, so a drain can report WHY a
// row is stuck instead of just how many are (console.log isn't visible in
// `wrangler tail` here — see redflare/CLAUDE.md — so this rides back in the
// /__cron/mirror response body).
async function mirrorOne(env, key, sourceUrl) {
  // 1. Already in the bucket (the VPS mirrored it before we took over, or a
  //    previous run did)? Record it, no fetch/put. R2 HEAD is a cheap Class B
  //    op — this is what stops us re-downloading the ~734 objects already there.
  let head;
  try {
    head = await env.BUCKET.head(key);
  } catch (e) {
    return { outcome: 'retry', detail: `r2-head: ${e.message}` }; // transient R2 error — leave queued
  }
  if (head) {
    await markMirrored(env, key);
    return { outcome: 'exists' };
  }

  // 2. Not there — fetch upstream and stream it in. Only TMDB `.webp` keys go
  //    through wsrv.nl. KKPhim keys are gated OUT here even though they can
  //    also end in `.webp` — wsrv.nl blocks phimimg.com outright ("Domain or
  //    TLD blocked by policy", measured 2026-08-06), and KKPhim doesn't need
  //    the conversion/resize wsrv.nl provides anyway (see the WSRV block
  //    above and worker/lib/images.js module comment). Gating by key prefix
  //    rather than by extension is what makes this correct: a KKPhim source
  //    that happens to already be `.webp` must NOT be routed through a
  //    blocked domain.
  const isKkphim = key.startsWith('kkphim/');
  const useWsrv = WSRV_ENABLED && !isKkphim && key.endsWith('.webp');
  const fetchUrl = useWsrv ? wsrvWebpUrl(sourceUrl) : sourceUrl;
  let res;
  try {
    res = await fetchWithTimeout(fetchUrl);
  } catch (e) {
    return { outcome: 'retry', detail: `fetch: ${e.name}: ${e.message}` }; // network blip — try next cron
  }
  if (!res || !res.ok) {
    if (useWsrv) {
      // Don't trust a wsrv.nl error to mean the image is gone — check the
      // TMDB origin itself before deleting the queue row (see isUpstreamDead).
      const originDead = await isUpstreamDead(sourceUrl);
      if (originDead) {
        await env.DB.prepare('DELETE FROM mirror_queue WHERE key = ?1').bind(key).run();
        return { outcome: 'give-up', detail: `origin dead, wsrv ${res ? res.status : 'no-response'}` };
      }
      return { outcome: 'retry', detail: `wsrv ${res ? res.status : 'no-response'}` };
    }
    // A permanent 4xx (image genuinely gone) — give up so it doesn't clog the
    // queue forever. It'll re-enqueue naturally if an item still references it,
    // and the client falls back to upstream meanwhile.
    if (res && res.status >= 400 && res.status < 500) {
      await env.DB.prepare('DELETE FROM mirror_queue WHERE key = ?1').bind(key).run();
      return { outcome: 'give-up', detail: `upstream ${res.status}` };
    }
    return { outcome: 'retry', detail: `upstream ${res ? res.status : 'no-response'}` };
  }
  const ct = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!ct.startsWith('image/')) {
    await env.DB.prepare('DELETE FROM mirror_queue WHERE key = ?1').bind(key).run();
    return { outcome: 'give-up', detail: `content-type ${ct || 'none'}` };
  }
  // Invariant: a key ending `.webp` MUST hold WebP bytes — never save
  // anything else under it. For the TMDB (useWsrv) branch this mismatch
  // means wsrv.nl itself glitched — always worth a retry, never worth
  // settling for less. (Before 2026-08-06 this had a grace window that gave
  // up and saved whatever content-type TMDB negotiated; that's gone along
  // with content negotiation — see bluesiaOM plan-redflare-webp-wsrv.md.)
  // The check still applies verbatim to a KKPhim `.webp` key even though
  // that path skips wsrv.nl entirely (see isKkphim above): the key only
  // ever gets a `.webp` extension because the KKPhim source URL itself was
  // `.webp` (worker/lib/images.js keeps the source extension as-is), so a
  // mismatch here would mean phimimg.com is misreporting its own
  // content-type — equally worth catching, equally worth a retry.
  if (key.endsWith('.webp') && ct !== 'image/webp') {
    return { outcome: 'retry', detail: `not-webp (${ct})` };
  }
  const clen = Number(res.headers.get('content-length') || 0);
  if (clen && clen > MAX_IMAGE_BYTES) {
    await env.DB.prepare('DELETE FROM mirror_queue WHERE key = ?1').bind(key).run();
    return { outcome: 'give-up', detail: `too big (${clen})` };
  }

  // R2's put() only accepts a ReadableStream whose length is known up front (a
  // response body carrying content-length, or a FixedLengthStream). TMDB sends
  // content-length, so its body streams straight through; so does phimimg.com
  // for its `uploads/movies/` paths. Its `upload/vod/` paths, however, answer
  // CHUNKED with no content-length at all (measured 2026-08-06, same failure
  // mode img.ophim.live used to have) — streaming those fails with "Provided
  // readable stream must have a known length", invisibly, since the catch
  // below merely re-queues the row. Buffering is the only option without a
  // length; it's confined to that case, and images here are capped at
  // MAX_IMAGE_BYTES.
  let body = res.body;
  if (!clen) {
    try {
      body = await res.arrayBuffer();
    } catch (e) {
      return { outcome: 'retry', detail: `buffer: ${e.message}` };
    }
    if (body.byteLength > MAX_IMAGE_BYTES) {
      await env.DB.prepare('DELETE FROM mirror_queue WHERE key = ?1').bind(key).run();
      return { outcome: 'give-up', detail: `too big (${body.byteLength}, buffered)` };
    }
  }

  try {
    await env.BUCKET.put(key, body, {
      httpMetadata: { contentType: ct, cacheControl: OBJECT_CACHE_CONTROL },
    });
  } catch (e) {
    return { outcome: 'retry', detail: `r2-put: ${e.message}` };
  }
  await markMirrored(env, key);
  return { outcome: 'mirrored' };
}

export async function drainMirrorQueue(env) {
  const { results } = await env.DB.prepare(
    'SELECT key, source_url, queued_at FROM mirror_queue ORDER BY queued_at LIMIT ?1'
  )
    .bind(MIRROR_BATCH)
    .all();
  const rows = results || [];
  if (!rows.length) return { drained: 0 };

  const counts = { exists: 0, mirrored: 0, 'give-up': 0, retry: 0, expired: 0 };
  // Why each retried row is stuck, returned to the caller (/__cron/mirror) —
  // one line per row, so a single manual drain diagnoses the queue.
  const retries = [];
  await mapLimit(rows, MIRROR_CONCURRENCY, async (row) => {
    let { outcome, detail } = await mirrorOne(env, row.key, row.source_url);
    if (outcome === 'retry') {
      const ageMs = Date.now() - row.queued_at;
      retries.push({ key: row.key, why: detail || 'unknown', ageMin: Math.round(ageMs / 60000) });
      // Stuck too long — drop it so it stops starving the head of the queue.
      // A later build that still references the key re-queues it at the back.
      if (ageMs > MAX_RETRY_AGE_MS) {
        await env.DB.prepare('DELETE FROM mirror_queue WHERE key = ?1').bind(row.key).run();
        outcome = 'expired';
      }
    }
    counts[outcome] = (counts[outcome] || 0) + 1;
  });
  console.log('[mirror drain]', { pulled: rows.length, ...counts });
  return { drained: rows.length, ...counts, retries };
}
