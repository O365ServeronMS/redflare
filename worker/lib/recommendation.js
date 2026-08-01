// recommendation.js — "Bạn cũng có thể thích", ported from
// catalog-api/src/recommendation.js. TMDB recommendations cross-referenced to
// the OPhim catalog via a tmdb.id → item reverse index (D1 table `idx`), with
// a live OPhim keyword-search fallback. Results are cached in D1 table `recs`
// with a conditional TTL (30d for real results, 1h for empties — re-resolve
// TMDB hiccups / titles not yet in OPhim), matching the VPS exactly.
//
// DELIBERATE DEVIATIONS FROM THE VPS VERSION (see state.md Phase 5 log before
// assuming a difference from VPS output is a bug):
//
// 1. Reverse index lives in D1 (table `idx`), not Valkey. Bounded write volume
//    is the whole reason (plan §3): indexing every served item into KV would
//    blow the 1,000/day write quota; D1's 100,000/day absorbs it comfortably.
// 2. idx is populated from a SMALLER set than the VPS's "index everything
//    served": only the hourly home cron shards (the popular titles that
//    recommendations actually point at — the VPS's own indexHomePayload
//    rationale), plus movie-detail builds, plus recommendation search-fallback
//    hits. NOT list/genre/country/search results. Keeps D1 writes bounded and
//    predictable, and avoids re-introducing the /api/search unbounded-
//    cardinality problem on the write side.
// 3. The OPhim search fallback is capped at SEARCH_FALLBACK_BUDGET candidates
//    per request (the VPS fired up to 15×2 OPhim searches concurrently via
//    Promise.all) to stay under the Worker's 6 simultaneous-connection and 50
//    external-subrequest limits.
// 4. Stored items are R2-mapped (mapItemImages), not HMAC-signed — r2 mode is
//    the only mode this site runs now (worker/lib/images.js).

import { createEnrich } from './enrich.js';
import { mapItemImages } from './images.js';

const OPHIM_BASE = 'https://ophim1.com';

const RELATED_LIMIT = 8;
const TMDB_CANDIDATES = 15;          // top-N TMDB recs to consider (matches VPS)
const SEARCH_FALLBACK_BUDGET = 6;    // max index-miss candidates to OPhim-search (Worker limits)
export const TTL_RELATED = 30 * 24 * 60 * 60;   // 30 days, seconds
export const TTL_RELATED_EMPTY = 60 * 60;       // 1 hour
const IDX_MAX_AGE_MS = 45 * 24 * 60 * 60 * 1000; // 45 days — matches VPS TTL_IDX

async function fetchWithTimeout(url, opts = {}, ms = 8000) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      return await fetch(url, { ...opts, signal: ctrl.signal });
    } catch (err) {
      if (attempt === 1) throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

async function fetchOphimJson(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': 'redflare-worker/1.0 (+phim.bluesia.net)' },
  });
  if (!res.ok) throw Object.assign(new Error(`OPhim upstream ${res.status}`), { status: res.status });
  return res.json();
}

// --- Reverse index (D1 table `idx`) -----------------------------------------

// Keep only items carrying a usable tmdb id + type + slug.
function indexable(items) {
  const out = [];
  const seen = new Set();
  for (const it of items || []) {
    const id = it?.tmdb?.id;
    const type = it?.tmdb?.type;
    if (!id || !it?.slug || (type !== 'movie' && type !== 'tv')) continue;
    const key = `${type}:${id}`;
    if (seen.has(key)) continue; // dedupe within a batch — D1 rejects dup PKs in one INSERT
    seen.add(key);
    out.push({ type, id: String(id), item: it });
  }
  return out;
}

// Batched upsert (plan §6 — D1 bills per row, but batching saves round-trips).
// D1 caps bound parameters at 100/query and this binds 4 per row, so chunk at
// <= 25 rows/INSERT (a full 24-item shard is right at the edge). Fire-and-
// forget from callers via ctx.waitUntil; failures are logged, never thrown.
const IDX_CHUNK = 20;

export async function indexItems(env, items) {
  const rows = indexable(items);
  if (!rows.length) return;
  const now = Date.now();
  for (let i = 0; i < rows.length; i += IDX_CHUNK) {
    const chunk = rows.slice(i, i + IDX_CHUNK);
    const placeholders = chunk.map(() => '(?, ?, ?, ?)').join(', ');
    const binds = [];
    for (const r of chunk) binds.push(r.type, r.id, JSON.stringify(r.item), now);
    await env.DB.prepare(
      `INSERT INTO idx (type, tmdb_id, item, updated_at) VALUES ${placeholders} ` +
        `ON CONFLICT(type, tmdb_id) DO UPDATE SET item = excluded.item, updated_at = excluded.updated_at`
    )
      .bind(...binds)
      .run();
  }
}

// Batched lookup: one SELECT with an IN-list, filtered to fresh rows (<45d).
// Returns Map(tmdb_id → parsed item).
async function lookupIndexBatch(env, type, ids) {
  if (!ids.length) return new Map();
  const placeholders = ids.map(() => '?').join(', ');
  const cutoff = Date.now() - IDX_MAX_AGE_MS;
  const { results } = await env.DB.prepare(
    `SELECT tmdb_id, item FROM idx WHERE type = ? AND updated_at > ? AND tmdb_id IN (${placeholders})`
  )
    .bind(type, cutoff, ...ids)
    .all();
  const map = new Map();
  for (const row of results || []) {
    try {
      map.set(String(row.tmdb_id), JSON.parse(row.item));
    } catch {
      /* skip a corrupt row */
    }
  }
  return map;
}

// --- TMDB recommendations ----------------------------------------------------

// Top TMDB recs for a title. media type matters: a TMDB id is NOT unique across
// movie/tv (tv 94997 = House of the Dragon, movie 94997 is unrelated), so hit
// the right endpoint. Falls back to /similar when /recommendations is empty
// (mirrors TMDB's own UI). Direct port of the VPS version.
async function fetchTmdbRecommendations(env, type, tmdbId) {
  if (!env.TMDB_API_TOKEN) return [];
  const media = type === 'tv' ? 'tv' : 'movie';
  const headers = { Authorization: `Bearer ${env.TMDB_API_TOKEN}`, accept: 'application/json' };
  const get = async (kind) => {
    const res = await fetchWithTimeout(
      `https://api.themoviedb.org/3/${media}/${tmdbId}/${kind}?language=vi-VN&page=1`,
      { headers }
    );
    if (!res.ok) throw new Error(`TMDB upstream ${res.status}`);
    const data = await res.json();
    return Array.isArray(data?.results) ? data.results : [];
  };
  let results = await get('recommendations');
  if (!results.length) results = await get('similar');
  return results.slice(0, TMDB_CANDIDATES).map((r) => ({
    id: String(r.id),
    keyword: r.original_title || r.original_name || '',
    viTitle: r.title || r.name || '',
  }));
}

// Live OPhim keyword search for one index-miss candidate: original title then
// localized title, filtered by tmdb id + type. On a hit, enrich + R2-map (to
// match the rest of the catalog) and index it for next time. Direct port of
// the VPS matchOphimByTmdb fallback branch, minus signItem.
async function matchViaSearch(env, enrich, rec, type) {
  for (const kw of [rec.keyword, rec.viTitle]) {
    if (!kw) continue;
    try {
      const data = await fetchOphimJson(
        `${OPHIM_BASE}/v1/api/tim-kiem?keyword=${encodeURIComponent(kw)}&limit=10`
      );
      const items = data?.data?.items || data?.items || [];
      const hit = items.find(
        (it) => String(it?.tmdb?.id) === rec.id && (!it?.tmdb?.type || it.tmdb.type === type)
      );
      if (hit) {
        await enrich.enrichItemsCards([hit]);
        const mapped = mapItemImages(hit);
        return mapped;
      }
    } catch {
      // try the next keyword
    }
  }
  return null;
}

// Build the recommendation list for a title. Resolution mirrors the VPS: each
// candidate resolves index-first (D1, cheap, no external call), then a live
// OPhim search fallback — and results are emitted in strict TMDB rank order
// (the VPS's Promise.all(recs.map(...)) preserves position; so do we, via a
// positional slots array). Returns { items }.
export async function buildRecommendation(env, type, tmdbId) {
  const recs = await fetchTmdbRecommendations(env, type, tmdbId);
  if (!recs.length) return { items: [] };

  // 1. Batch index lookup for every candidate (one D1 query).
  const indexHits = await lookupIndexBatch(env, type, recs.map((r) => r.id));

  // 2. Positional slots, one per candidate. Index hits fill immediately; the
  //    first SEARCH_FALLBACK_BUDGET index-misses are queued for a live OPhim
  //    search (the cap keeps OPhim fan-out under the Worker's connection /
  //    subrequest limits). Remaining misses stay null.
  const enrich = createEnrich(env);
  const slots = new Array(recs.length).fill(null);
  const toSearch = []; // { idx, rec }
  for (let i = 0; i < recs.length; i++) {
    const hit = indexHits.get(recs[i].id);
    if (hit) slots[i] = hit;
    else if (toSearch.length < SEARCH_FALLBACK_BUDGET) toSearch.push({ idx: i, rec: recs[i] });
  }

  // 3. Resolve the queued searches (bounded set) — enrichItemsCards' own
  //    mapLimit(6) caps TMDB connections; toSearch is already
  //    <= SEARCH_FALLBACK_BUDGET so OPhim fan-out is bounded too.
  if (toSearch.length) {
    await Promise.all(
      toSearch.map(async ({ idx, rec }) => {
        slots[idx] = await matchViaSearch(env, enrich, rec, type);
      })
    );
  }

  // 4. Emit in rank order, dedupe by slug, cap at RELATED_LIMIT. Warm the index
  //    with items that came from the search fallback (weren't index hits).
  const items = [];
  const seenSlug = new Set();
  const newlyResolved = [];
  for (let i = 0; i < slots.length; i++) {
    const it = slots[i];
    if (!it || !it.slug || seenSlug.has(it.slug)) continue;
    seenSlug.add(it.slug);
    items.push(it);
    if (!indexHits.has(recs[i].id)) newlyResolved.push(it);
    if (items.length >= RELATED_LIMIT) break;
  }
  if (newlyResolved.length) {
    indexItems(env, newlyResolved).catch((err) => console.error('[rec idx warm]', err.message));
  }

  return { items };
}

// --- recs cache (D1 table `recs`) -------------------------------------------

export async function readRecsCache(env, type, tmdbId) {
  const row = await env.DB.prepare('SELECT body, expires_at FROM recs WHERE type = ?1 AND tmdb_id = ?2')
    .bind(type, tmdbId)
    .first();
  if (!row) return null;
  if (row.expires_at < Date.now()) return null; // expired — treat as miss
  return row.body;
}

export async function writeRecsCache(env, type, tmdbId, body, hasItems) {
  const ttl = hasItems ? TTL_RELATED : TTL_RELATED_EMPTY;
  const expiresAt = Date.now() + ttl * 1000;
  await env.DB.prepare(
    'INSERT INTO recs (type, tmdb_id, body, expires_at) VALUES (?1, ?2, ?3, ?4) ' +
      'ON CONFLICT(type, tmdb_id) DO UPDATE SET body = excluded.body, expires_at = excluded.expires_at'
  )
    .bind(type, tmdbId, body, expiresAt)
    .run();
  return ttl;
}

// --- periodic cleanup (called from the hourly home cron) --------------------
// D1 has no TTL, so old idx rows (>45d) and expired recs rows are swept
// explicitly. Deletes count as row-writes, but the volume is tiny and bounded.

export async function cleanupRecTables(env) {
  const idxCutoff = Date.now() - IDX_MAX_AGE_MS;
  await env.DB.prepare('DELETE FROM idx WHERE updated_at < ?1').bind(idxCutoff).run();
  await env.DB.prepare('DELETE FROM recs WHERE expires_at < ?1').bind(Date.now()).run();
}
