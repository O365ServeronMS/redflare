// recommendation.js — "Bạn cũng có thể thích", ported from
// catalog-api/src/recommendation.js. TMDB recommendations cross-referenced to
// the KKPhim catalog via a tmdb.id → item reverse index (D1 table `idx`), with
// a live KKPhim /tmdb/{type}/{id} lookup fallback. Results are cached in D1 table `recs`
// with a 3-tier TTL based on how COMPLETE the result was, not just whether it
// was non-empty — see "Result quality + TTL tiers" below. This is a deliberate
// change from the VPS's 2-tier (30d real / 1h empty) TTL — see
// bluesiaOM/context/state-sua-loi-recommendation.md Phase 1 for why: a result
// that only resolved 1 of 15 candidates was getting cached for 30 days
// identically to a complete one, which is how "Gia Tộc Rồng" recommending
// without "Game of Thrones" survived undetected.
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
// 3. The KKPhim lookup fallback is capped at LOOKUP_FALLBACK_BUDGET (10)
//    candidates per request — total attempts, to stay under the Worker's
//    ~50 external-subrequest limit; the VPS had no such cap. Simultaneous
//    connections are a SEPARATE bound (LOOKUP_CONCURRENCY=6, enforced by
//    mapLimit below) — the two used to be conflated when budget happened to
//    equal 6, which meant a raw Promise.all only stayed under the
//    connection limit by coincidence. See state.md Phase 2 log.
// 4. Stored items are R2-mapped (mapItemImages), not HMAC-signed — r2 mode is
//    the only mode this site runs now (worker/lib/images.js).
// 5. The fallback used to be a live OPhim keyword search (2 subrequests/
//    candidate: original title, then localized title, filtered by tmdb id +
//    type). KKPhim's search index leans heavily Vietnamese — a keyword search
//    on a TMDB original_title (usually English) came back empty even for
//    titles that ARE on KKPhim (measured 2026-08-06: "Evil Dead Burn" -> 0
//    results, despite the title existing under slug ma-cay-lua-dia-nguc).
//    KKPhim's GET /tmdb/{type}/{id} exists precisely to sidestep that: an
//    exact TMDB-id lookup, 1 subrequest, no keyword guessing at all. See
//    docs/plan-kkphim-migration.md Phase 4.

import { createEnrich } from './enrich.js';
import { mapItemImages } from './images.js';

const KKPHIM_BASE = 'https://phimapi.com';

const RELATED_LIMIT = 8;
const TMDB_CANDIDATES = 15;          // top-N TMDB recs to consider (matches VPS)
// Phase 2 (state.md): raised from 6 for the old OPhim keyword-search
// fallback, which needed up to 2 subrequests/candidate. KKPhim's
// /tmdb/{type}/{id} lookup (deviation #5 above) needs only 1, so this value
// is now a safety margin with headroom to spare rather than a measured
// edge — kept at 10 anyway on first deploy rather than raised further,
// since the ~50-subrequest/invocation cap is shared with TMDB enrich calls
// and there's no need to push it without a measured reason to. LOOKUP_CONCURRENCY
// (below) is what actually bounds simultaneous KKPhim connections — this
// only bounds total attempts.
const LOOKUP_FALLBACK_BUDGET = 10;
const LOOKUP_CONCURRENCY = 6;        // Workers free plan: 6 simultaneous outgoing connections
export const TTL_RELATED = 30 * 24 * 60 * 60;         // 30 days — full result
export const TTL_RELATED_PARTIAL = 6 * 60 * 60;       // 6 hours — incomplete result, re-check soon
export const TTL_RELATED_EMPTY = 60 * 60;             // 1 hour — no matches at all
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

async function fetchCatalogJson(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': 'redflare-worker/1.0 (+phim.bluesia.net)' },
  });
  if (!res.ok) throw Object.assign(new Error(`KKPhim upstream ${res.status}`), { status: res.status });
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

// Bounded-concurrency map — mirrors enrich.js's own mapLimit. The lookup
// fan-out below used to be a raw Promise.all over `toLookup`, which only
// ever respected the Workers free plan's 6-simultaneous-connection cap by
// coincidence: the budget happened to be 6. Raising the budget without this
// would silently blow past that limit under real concurrency.
async function mapLimit(items, limit, fn) {
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// Exact KKPhim lookup by TMDB id for one index-miss candidate — replaces the
// old OPhim keyword-search fallback (deviation #5 above). GET /tmdb/{type}/{id}
// resolves directly, no keyword guessing, 1 subrequest instead of up to 2. On
// a hit, enrich + R2-map (to match the rest of the catalog) and index it for
// next time.
//
// Returns { item, error }. `error` distinguishes "KKPhim answered, this title
// genuinely isn't in the catalog" (item: null, error: false — a legitimate,
// cacheable-long-term outcome) from "the KKPhim call itself failed" (item:
// null, error: true — transient, should NOT be trusted for a 30-day cache;
// see classifyTier below). Collapsing these into one empty `catch {}` was the
// original OPhim-era bug this distinction exists to avoid.
//
// A genuine miss on KKPhim is a plain HTTP 404 (verified 2026-08-06:
// {"status":false,"msg":"hmmm!"}), not a 200 with an empty body — so this
// does NOT go through fetchCatalogJson (which throws on any !res.ok,
// indistinguishable from a real network failure). 404 is handled as the
// legitimate-miss case; anything else non-ok is treated as transient.
async function matchViaTmdbLookup(env, enrich, rec, type) {
  let res;
  try {
    res = await fetchWithTimeout(`${KKPHIM_BASE}/tmdb/${type}/${rec.id}`, {
      headers: { 'user-agent': 'redflare-worker/1.0 (+phim.bluesia.net)' },
    });
  } catch {
    return { item: null, error: true }; // network/timeout — transient
  }
  if (res.status === 404) return { item: null, error: false }; // genuine miss
  if (!res.ok) return { item: null, error: true }; // transient (5xx etc.)
  try {
    const data = await res.json();
    const hit = data?.movie || data?.data?.item;
    if (!hit || !hit.slug) return { item: null, error: false };
    await enrich.enrichItemsCards([hit]);
    const mapped = mapItemImages(hit);
    return { item: mapped, error: false };
  } catch {
    return { item: null, error: true }; // malformed response body — transient
  }
}

// Build the recommendation list for a title. Resolution mirrors the VPS: each
// candidate resolves index-first (D1, cheap, no external call), then a live
// KKPhim /tmdb/{type}/{id} lookup fallback — and results are emitted in
// strict TMDB rank order (the VPS's Promise.all(recs.map(...)) preserves
// position; so do we, via a positional slots array).
//
// Returns { items, candidates, resolved, skippedBudget, searchErrors } — the
// three extra fields are the quality signal classifyTier() below uses to pick
// a TTL. Without them, a result that only resolved 1 of 15 candidates (e.g.
// because the one that mattered — Game of Thrones for Gia Tộc Rồng — hadn't
// entered the `idx` reverse index yet) was indistinguishable from a complete
// one and got cached for 30 days either way (see state.md Phase 1 log).
export async function buildRecommendation(env, type, tmdbId) {
  const recs = await fetchTmdbRecommendations(env, type, tmdbId);
  if (!recs.length) return { items: [], candidates: 0, resolved: 0, skippedBudget: 0, searchErrors: 0 };

  // 1. Batch index lookup for every candidate (one D1 query).
  const indexHits = await lookupIndexBatch(env, type, recs.map((r) => r.id));

  // 2. Positional slots, one per candidate. Index hits fill immediately; the
  //    first LOOKUP_FALLBACK_BUDGET index-misses are queued for a live
  //    KKPhim /tmdb/{type}/{id} lookup (the cap keeps KKPhim fan-out under
  //    the Worker's connection/subrequest limits, enforced for real by
  //    mapLimit below). Misses beyond the budget stay null and count
  //    toward skippedBudget.
  //
  //    NOT early-stopping once index hits reach RELATED_LIMIT (an earlier
  //    version of this did, and looked like a Phase 2 win in isolated
  //    testing) — it's WRONG: queued lookups aren't guaranteed to succeed,
  //    so treating them as certain and skipping lower-ranked candidates on
  //    that assumption drops candidates that would have matched. Caught
  //    concretely on movie/278 (against the old OPhim keyword-search
  //    fallback this replaced): candidates ranked #9+ were never even
  //    attempted because higher-ranked candidates were optimistically
  //    "reserved" and then some of them failed to resolve. Still applies
  //    with a per-id lookup, since a lookup can still fail transiently
  //    (network/timeout) — see state.md Phase 2 log for the original trace.
  const enrich = createEnrich(env);
  const slots = new Array(recs.length).fill(null);
  const toLookup = []; // { idx, rec }
  let skippedBudget = 0;
  for (let i = 0; i < recs.length; i++) {
    const hit = indexHits.get(recs[i].id);
    if (hit) {
      slots[i] = hit;
      continue;
    }
    if (toLookup.length < LOOKUP_FALLBACK_BUDGET) toLookup.push({ idx: i, rec: recs[i] });
    else skippedBudget++;
  }

  // 3. Resolve the queued lookups through mapLimit(LOOKUP_CONCURRENCY) —
  //    toLookup can now exceed 6 (LOOKUP_FALLBACK_BUDGET > LOOKUP_CONCURRENCY),
  //    so this is what actually keeps simultaneous KKPhim connections at the
  //    platform's cap, not the budget size.
  let searchErrors = 0;
  if (toLookup.length) {
    await mapLimit(toLookup, LOOKUP_CONCURRENCY, async ({ idx, rec }) => {
      const result = await matchViaTmdbLookup(env, enrich, rec, type);
      slots[idx] = result.item;
      if (result.error) searchErrors++;
    });
  }

  // 4. Count how many candidates resolved at all (over every slot, before
  //    dedup/cap below) — the quality signal cares about this, not just the
  //    final emitted count.
  let resolved = 0;
  for (const s of slots) if (s) resolved++;

  // 5. Emit in rank order, dedupe by slug, cap at RELATED_LIMIT. Warm the index
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

  return { items, candidates: recs.length, resolved, skippedBudget, searchErrors };
}

// --- Result quality + TTL tiers ---------------------------------------------
// "Sufficient" means either the list is already full (RELATED_LIMIT reached
// — nothing was left on the table) or every candidate was actually
// considered (no budget cutoff, no KKPhim call failures) so a short list is
// short because KKPhim genuinely doesn't have more, not because the Worker
// gave up early. Anything short of that is "partial": real items, but the
// list may be missing something and deserves a much shorter TTL so it
// self-heals instead of being frozen for 30 days (state.md Phase 1 log has
// the concrete case: 1/15 candidates resolved, cached 30 days regardless).
export function classifyTier({ items, skippedBudget, searchErrors }) {
  if (!items || !items.length) return 'empty';
  const sufficient = items.length >= RELATED_LIMIT || (skippedBudget === 0 && searchErrors === 0);
  return sufficient ? 'full' : 'partial';
}

export function ttlForTier(tier) {
  if (tier === 'full') return TTL_RELATED;
  if (tier === 'partial') return TTL_RELATED_PARTIAL;
  return TTL_RELATED_EMPTY;
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

// ttl is seconds, from ttlForTier() above — caller decides the tier, this
// function just persists it. (Used to take a `hasItems` boolean and pick
// between 2 TTLs itself; that collapsed "1/15 resolved" and "15/15 resolved"
// into the same 30-day bucket — see classifyTier's doc comment.)
export async function writeRecsCache(env, type, tmdbId, body, ttl) {
  const expiresAt = Date.now() + ttl * 1000;
  await env.DB.prepare(
    'INSERT INTO recs (type, tmdb_id, body, expires_at) VALUES (?1, ?2, ?3, ?4) ' +
      'ON CONFLICT(type, tmdb_id) DO UPDATE SET body = excluded.body, expires_at = excluded.expires_at'
  )
    .bind(type, tmdbId, body, expiresAt)
    .run();
  return ttl;
}

// Purge one title's durable D1 cache — the D1 half of the two-tier cache
// (state.md Phase 0 finding: fixing D1 alone doesn't reach real users, the
// Cache API copy in worker/index.js also has to be evicted; see
// handleCronPurgeRecs there). Returns the number of rows actually deleted
// (0 or 1 — (type, tmdb_id) is the primary key).
export async function deleteRecsCache(env, type, tmdbId) {
  const res = await env.DB.prepare('DELETE FROM recs WHERE type = ?1 AND tmdb_id = ?2')
    .bind(type, tmdbId)
    .run();
  return res.meta?.changes ?? 0;
}

// --- periodic cleanup (called from the hourly home cron) --------------------
// D1 has no TTL, so old idx rows (>45d) and expired recs rows are swept
// explicitly. Deletes count as row-writes, but the volume is tiny and bounded.

export async function cleanupRecTables(env) {
  const idxCutoff = Date.now() - IDX_MAX_AGE_MS;
  await env.DB.prepare('DELETE FROM idx WHERE updated_at < ?1').bind(idxCutoff).run();
  await env.DB.prepare('DELETE FROM recs WHERE expires_at < ?1').bind(Date.now()).run();
}
