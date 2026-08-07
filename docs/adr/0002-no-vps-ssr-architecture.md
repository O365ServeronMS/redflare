# ADR-0002: Redflare "No VPS Edition" — SEO-first SSR on Cloudflare free tier

**Status:** Proposed
**Date:** 2026-08-07
**Deciders:** repo owner (sole maintainer)
**Supersedes:** the SPA + JSON-API topology described in `CLAUDE.md`; closes ADR-0001 Action Item 7 (Workers Caching)
**Input:** "REDFLARE — Architecture & System Design Handoff v1.0" (No VPS Edition)
**Tracking:** [plan-ssr-rearchitecture.md](../plan-ssr-rearchitecture.md) → [state-ssr-rearchitecture.md](../state-ssr-rearchitecture.md)

---

## Context

The handoff proposes replacing today's architecture wholesale:

| | Today (measured) | Handoff v1.0 |
|---|---|---|
| Delivery | Vanilla-JS SPA, client renders | SSR HTML, no SPA |
| Backend | Worker builds `/api/*` JSON on demand | Worker reads D1, renders HTML |
| Runtime external calls | KKPhim + up to 24 TMDB per build | **none** |
| Storage | KV + D1 + R2 + Cache API | D1 only |
| Images | mirrored to R2 (`img.bluesia.net`) | hotlink TMDB/phimimg CDN |
| Language | JS, no types, no tests | TypeScript + Hono |

The direction is sound, and one number justifies it on its own. `docs/state-hit-rate.md`
Phase 10 measured **~11.4% of `/api/*` responses returning 504** in a clean window, traced to
`worker/lib/enrich.js` — an 8s TMDB timeout × 2 attempts = up to 16s per item, worst case 64s
for a page. That failure mode is structural: it exists *because* a user request can fan out to
a third-party API. The handoff's Principle 3 ("Runtime không gọi API ngoài") deletes the entire
class of bug rather than tuning the timeout. That alone is worth the rewrite.

Nine phases of cache work already landed (ADR-0001 + `plan-hit-rate.md`), ending at a measured
**96.5% adjusted hit rate** with the explicit conclusion *"cache đã hết là nút thắt"* — caching
is no longer the bottleneck. The remaining wins are architectural, not configurational. This
ADR is the architecture.

### What I verified rather than assumed

Every number below was read from Cloudflare docs during this review (2026-08-07), not recalled:

| Limit | Free plan value | Source |
|---|---|---|
| Worker requests | **100,000/day**, resets midnight UTC, then Error 1027 | `workers/platform/limits` |
| **Cache hits still bill a request** | yes — "requests served from the Worker's cache are billed at the same per-request rate"; only CPU is spared | `workers/cache/`, `workers/platform/pricing` |
| Static asset requests | free and unlimited — **unless Workers Cache is enabled**, which makes them billable | `workers/static-assets/billing-and-limitations` |
| CPU per invocation | 10 ms (fetch **and** cron alike) | `workers/platform/limits` |
| Wall time, cron | 15 min | `workers/platform/limits` |
| Subrequests | 50/request — **D1, KV, R2 calls all count** | `workers/platform/limits` |
| Cron triggers | 5 per account | `workers/platform/limits` |
| D1 rows read | **5,000,000/day** | `d1/platform/pricing` |
| D1 rows written | **100,000/day** | `d1/platform/pricing` |
| D1 storage | 500 MB/database, 5 GB/account, 10 databases | `d1/platform/limits` |
| D1 bound params | 100 per query | `d1/platform/limits` |

The handoff's own limits appendix quotes `d1/platform/limits` but that page **omits the daily
row-read and row-write quotas**, which live on the pricing page. Those two numbers turn out to
govern the design more than anything on the page that was quoted. See Finding 2.

---

## Decision

Adopt the handoff's architecture with **six corrections**, three of which are blocking
(the design does not work without them) and three of which are optimizations.

Blocking:

1. **`movie` is keyed by `slug`, not `tmdb_id`.** (Finding 1)
2. **Sync is budgeted against D1 rows-written, not against subrequests.** (Finding 2)
3. **Recommendation targets are bounded to the local catalog + a capped stub tier.** (Finding 3)

Non-blocking but strongly recommended:

4. **Use Workers Caching (`[cache] enabled`), not the Cache API.** (Finding 4)
5. **Drop the suggested `s-maxage=1800` — it disables the `stale-while-revalidate` beside it.** (Finding 5)
6. **Add D1 FTS5 search + sitemaps; both are missing and both are load-bearing for "SEO-first".** (Finding 6)

And one goal must be restated honestly: **1,000,000 daily page views is not reachable on the
free plan** — not for performance reasons, but because cache hits bill requests. See Finding 7.

---

## Findings

### Finding 1 — `tmdb_id` cannot be the primary key (blocking)

The handoff makes `tmdb_id` the PK of `movie`. Three independent reasons this breaks, all
grounded in data this repo has already measured:

**(a) TMDB ids collide across media types.** `CLAUDE.md` states it outright: *"`mediaType` must
be `movie`/`tv` — TMDB ids collide across the two."* The current recommendation cache already
carries a composite `(type, tmdb_id)` PK in `migrations/0002_recs_idx_mirror.sql` for exactly
this reason.

**(b) One TMDB id maps to many catalog entries.** `docs/plan-kkphim-migration.md` §0.2 records a
verified lookup: `/tmdb/tv/94997 → gia-toc-rong-phan-1 (tmdb.season = 1)`. Season 2 is a
*different* KKPhim slug, a different page, a different set of episodes — and the same
`tmdb_id`. A PK on `tmdb_id` silently collapses every multi-season series into one row.

**(c) Not every title has a TMDB id at all.** The same doc notes *"nếu thiếu `tmdb.id` thì
enrichment sẽ im lặng bỏ qua toàn bộ"*. Under a `tmdb_id` PK those titles cannot be stored,
so they cannot have a detail page — deleting exactly the long-tail pages an SEO-first site
exists to own.

**Correction.** The catalog's identity comes from the stream source, which is also the URL
identity the site already uses (`/phim/:slug`, live since launch):

```sql
CREATE TABLE movie (
  slug            TEXT PRIMARY KEY,          -- KKPhim slug == URL identity
  tmdb_id         INTEGER,                   -- nullable, NOT unique
  tmdb_type       TEXT,                      -- 'movie' | 'tv'
  tmdb_season     INTEGER,
  ...
);
CREATE INDEX idx_movie_tmdb ON movie(tmdb_type, tmdb_id) WHERE tmdb_id IS NOT NULL;
```

This also keeps the rewrite URL-compatible with the live site, which matters more than it
looks: the existing `/phim/:slug`, `/danh-sach/:type`, `/the-loai/:slug`, `/quoc-gia/:slug`
paths (`src/main.js:301-306`) already carry whatever ranking the site has. Preserving them
turns a rewrite into an upgrade rather than a reset.

### Finding 2 — the binding constraint on sync is D1 rows-written, not subrequests (blocking)

The handoff plans sync around subrequest and CPU budgets. Those are not what runs out first.

Per cron invocation the ceilings are 50 subrequests and 10 ms CPU. A movie costs ~3 external
calls (phimimg detail, TMDB detail, TMDB recommendations), so **~15 movies per invocation** —
subrequest-bound, comfortably inside 15 min of wall time. Fan-out through a `SELF` service
binding (the pattern `worker/lib/home.js` already uses) multiplies that freely; 45 children ×
15 movies = ~675 movies per tick, ~32,000/day. Subrequests are not the problem.

Rows written *is*. One movie touches roughly:

| Table | Rows per movie |
|---|---|
| `movie` | 1 |
| `episode` | ~12 (series average, across servers) |
| `recommendation` | ~20 |
| `genre_movie` | ~3 |
| `country_movie` | ~2 |
| Subtotal, table rows | ~38 |
| **Index writes** (see below) | **~35** |
| **Total** | **~73** |

**Index writes count as separate rows written.** Cloudflare's pricing page: *"Indexes will add
an additional written row when writes include the indexed column, as there are two rows
written: one to the table itself, and one to the index."* The schema in
`plan-ssr-rearchitecture.md` §1.2 carries 3 indexes on `movie`, 1 on `episode`, 2 on
`recommendation` and 2 on the join tables — so the real cost is roughly **double** the table
rows, not the table rows alone.

At the free quota of **100,000 rows written/day**, ~73 rows/movie is **~1,370 movies/day**, so a
40,000-movie cold backfill takes **~30 days** on the free plan. No amount of sharding, fan-out
or CPU tuning changes it — the quota is account-wide and per-day.

**On Workers Paid the wall disappears entirely.** D1 Paid includes **50 million rows
written/month with no daily cap**; the whole backfill is ~2.9M rows, i.e. **6% of the included
monthly quota, $0 in overage**. The binding constraint moves off Cloudflare and onto upstream
politeness — see Finding 2b.

### Finding 2b — on Paid, the throttle is phimapi.com, not Cloudflare

With the quota wall gone, per-invocation ceilings on Paid are 10,000 subrequests, 5 min CPU and
15 min wall time. The one limit that does **not** change between plans is **6 simultaneous
outgoing connections per invocation**, so a single invocation sustains roughly 12 req/s. Fanned
out across N children via service bindings, aggregate throughput is `N × 12` req/s and 40,000
movies (~120,000 calls) completes in **1–2 hours**.

That is fast enough to be dangerous. `phimapi.com` is a free community API, and this project
has already lost one catalog source to an outage it did not control — `ophim1.com` returned 500
on every endpoint on 2026-08-06 and took the site down with it. Getting IP-banned from the
replacement is the worst available outcome, and it is self-inflicted.

**Cap aggregate outbound at ~20–30 req/s regardless of plan.** At 25 req/s the backfill takes
~80 minutes, which is still "today", and leaves the source intact. TMDB tolerates more, so
throttle the two sources separately rather than applying one global limit.

**Corrections:**

- **Skip no-op writes with a content hash.** Store `source_hash` (FNV-1a over the normalized
  upstream payload) on `movie`. If the hash is unchanged, write nothing — not the movie row,
  not its episodes, not its recommendations. Steady state on this catalog is a few hundred
  changed titles/day, so this is the difference between ~10,000 rows/day and blowing the quota.
- **Version the child rows instead of delete-then-insert.** `DELETE FROM episode WHERE
  slug = ?` followed by re-INSERT bills *both* the deletes and the inserts. Diff against the
  stored hash per episode-set and rewrite only when it actually changed.
- **Backfill is a distinct, rate-limited mode.** A `sync_state` cursor table, a hard
  `MAX_ROWS_PER_DAY` self-governor read from a counter, and the explicit expectation that first
  fill takes ~2 weeks. Plan for it rather than discovering it.
- **Respect the 100-bound-param cap.** `CLAUDE.md` records this as one of the two platform bugs
  that ate the most debugging time in the last migration. At ~20 columns, a batched movie
  INSERT carries **5 rows per statement**, maximum. Encode that as a constant, not a guess.

### Finding 3 — recommendations to non-catalog titles are unbounded (blocking)

The handoff asks for two things that conflict:

> *Recommendation: `movie_tmdb_id, recommend_tmdb_id, sort_order`*
> *Always display every recommendation. Never hide movies without stream. Movies without stream:
> detail page still exists.*

Rendering a recommendation requires a `movie` row for the target. TMDB `/recommendations`
returns mostly titles the stream source does not carry. So "always display every
recommendation" implies storing every TMDB title reachable at depth 1 from the catalog:
40,000 × 20 = 800,000 references, perhaps 150,000 unique. Each needs its own TMDB fetch and its
own row — which multiplies the backfill in Finding 2 by ~4× (to ~2 months) and pushes storage
past the 500 MB per-database limit.

Worse, it is recursive in spirit: those stub pages have recommendations too.

**Correction — three tiers, explicitly bounded:**

1. **In-catalog** (`has_stream = 1` or simply present): render fully. Always.
2. **Stub tier**: TMDB-only titles, capped globally (`MAX_STUBS`, start at 20,000), populated
   lowest-cost-first and only for targets referenced by ≥2 catalog movies. Stubs get a detail
   page, JSON-LD, and a "Watch Trailer" CTA — the handoff's SEO argument holds for these.
   Stubs **do not** get recommendations of their own; crawl depth stops there.
3. **Overflow**: referenced but not materialized → not rendered. Not an error, just absent.

Store the tier so the renderer never needs a second query:

```sql
CREATE TABLE recommendation (
  slug           TEXT NOT NULL,       -- source movie
  target_slug    TEXT,                -- resolved; NULL until/unless materialized
  target_tmdb_id INTEGER NOT NULL,
  target_type    TEXT NOT NULL,
  sort_order     INTEGER NOT NULL,
  PRIMARY KEY (slug, target_tmdb_id, target_type)
);
```

Keeping `target_tmdb_id` alongside a nullable `target_slug` means a later backfill can resolve
overflow rows in place, without re-fetching TMDB.

### Finding 4 — use Workers Caching, not the Cache API (recommended)

ADR-0001 left this open as Action Item 7. The docs now settle it. Cloudflare's own guidance:
*"For new Workers, prefer Workers Caching. The Cache API, by design, is a lower-level
primitive."* Three differences matter here:

| | Cache API (`caches.default`, today) | Workers Caching (`[cache] enabled = true`) |
|---|---|---|
| On hit | Worker still runs; 10 ms CPU still at risk | **Worker does not run**; no CPU billed |
| Concurrent misses | one Worker invocation *per request* | **request collapsing** — one invocation |
| Tiered cache | does not participate | participates |
| Invalidation | `cache.delete()`, colo-local only | `ctx.cache.purge()` by tag or path prefix |

Request collapsing is the one that protects this design. D1 is single-threaded — the docs are
explicit that each database is one Durable Object processing queries serially. A cold-cache
burst on a popular title under the Cache API means N simultaneous Worker invocations all
querying D1 for the same rows. Under Workers Caching it is one.

`ctx.cache.purge()` also fixes an invalidation gap the handoff never addresses: cron updates D1,
but nothing tells the edge. Tag each rendered page with `Cache-Tag: movie:<slug>` and have the
sync job purge exactly the titles it changed. This is strictly better than the lesson recorded
in `CLAUDE.md` — *"the Cache API entries will not fix themselves… Purge Everything on the
Cloudflare dashboard"* — which cost this project a real incident during the 2026-08-04 image
migration.

**Caveat to accept knowingly:** enabling Workers Caching makes static-asset requests billable,
and they are free today. With CSS/JS as a handful of files and images hotlinked off-platform,
the added request volume is small — but it is not zero, and it lands in the same 100k/day
bucket as page views. Quantify it in Phase 5 before committing.

### Finding 5 — the suggested `Cache-Control` header defeats itself (recommended)

The handoff suggests:

```
public, s-maxage=1800, stale-while-revalidate=86400
```

This project already found and fixed this exact bug. `docs/state-hit-rate.md`, Decision 2:

> *`s-maxage` mang ngữ nghĩa `proxy-revalidate` → shared cache không được serve stale →
> `stale-while-revalidate` **và** `stale-if-error` đều bị vô hiệu.*

`s-maxage` implies `proxy-revalidate`, so a shared cache may not serve stale — which disables
the `stale-while-revalidate` sitting right next to it. Phase 1 of `plan-hit-rate.md` removed
`s-maxage` from client-facing responses for precisely this reason and verified the fix in
production. Re-adding it would silently undo that work.

**Correction:**

```
Cache-Control: public, max-age=60, stale-while-revalidate=86400, stale-if-error=604800
Cache-Tag: movie:<slug>, tier:detail
```

`max-age=60` keeps browsers from pinning a stale page while the edge serves the same body for
up to 24h and revalidates behind the request. `stale-if-error` is what keeps the site up if D1
is briefly overloaded — the "no origin to fall back to" property the current `stale` table
provides today, obtained for free from the cache layer instead of a D1 table.

**ETag:** cheap and worth it, but do not hash the body — that costs CPU on every miss for a
benefit only repeat visitors see. Derive it: `W/"<slug>-<last_synced>-<TEMPLATE_VERSION>"`.
Bump `TEMPLATE_VERSION` on any renderer change; it doubles as the cache-busting key for a
template deploy.

### Finding 6 — two SEO-critical pieces are missing from the handoff (recommended)

**Search.** The handoff has no search route, but the live site does (`/tim-kiem`,
`src/main.js:306`) and `src/api/ophim.js` exports `searchMovies`. Dropping it is a regression.
It cannot call phimimg at runtime (Principle 3), so it must be local — and D1 supports SQLite
**FTS5**. An `fts_movie` virtual table over `title, original_title, slug` gives sub-millisecond
prefix search with zero external calls, and it fixes a known quality problem at the same time:
`plan-kkphim-migration.md` §0.4 records KKPhim's own search as *"chất lượng match kém hơn"*
than the source it replaced. Owning the index means owning the ranking.

Cost: ~30% of indexed text size, and FTS writes count toward the 100k/day row quota — so
populate it from the same hash-gated path as `movie`, never separately.

**Sitemaps.** "SEO-first" with 40,000+ pages and no sitemap is a contradiction. Needed: a
`sitemap.xml` index plus `sitemap-<n>.xml` shards of 50,000 URLs, generated on demand from D1
and edge-cached like any other page, with `<lastmod>` from `movie.last_synced`. Add `robots.txt`
pointing at it. Both are ~40 lines and belong in the first shipping phase, not "later".

**Also add while in there:** `genre` and `country` dimension tables. The handoff has
`genre_movie`/`country_movie` join tables but nothing holding the display name for
`/the-loai/:slug`'s `<h1>` and `<title>`. Today those are hardcoded in
`src/modules/Footer/Footer.js`; that does not survive the rewrite.

### Finding 7 — 1M page views/day is not a free-tier target (must be restated)

This is the one goal the architecture cannot deliver as specified, and the reason is billing,
not engineering.

A Worker on the free plan gets **100,000 requests/day**. Cloudflare's pricing page is explicit
that under Workers Caching, *"requests served from the Worker's cache are billed at the same
per-request rate as requests that invoke the Worker"*. A 99% edge hit rate does not help: the
1% that miss and the 99% that hit both count. At 1,000,000 page views the Worker is at **10×
the daily quota**, and past the cap Cloudflare returns Error 1027 — on a custom domain with no
separate origin, that is a hard outage, not a degradation.

So the two stated goals — *"Chi phí vận hành ≈ 0 USD"* and *"1,000,000 daily page views"* — are
mutually exclusive on this platform. Pick one:

| | Ceiling | Cost |
|---|---|---|
| **Free** | ~100,000 page views/day (≈95k after cron + health + sitemap traffic) | $0 |
| **Workers Paid** | 1M pv/day ≈ 30M req/month: 10M included + 20M × $0.30/M | **~$11/month** |

**Recommendation: build free-first, and treat Paid as a documented flag flip.** Nothing in this
architecture changes between the two — same code, same schema, same cache strategy. The design
is "free-tier-first" in the sense that matters: it *runs* on free, and it *scales* on $11.

What the plan does add for the free tier is a self-defence measure the handoff lacks: a
lightweight daily request counter, and a `/api/health` field that reports percentage-of-quota
consumed, so hitting 1027 is something seen coming rather than discovered from a support
ticket.

### Scalability at the three requested scales

| | 40,000 movies | 200,000 movies | 1M pv/day |
|---|---|---|---|
| D1 storage | ~180 MB ✅ | **~900 MB ❌** (500 MB/DB cap) | n/a |
| Rows read/day | ~225k of 5M ✅ | ~225k ✅ (reads are per-view, not per-title) | ~2.3M ✅ *if* requests allowed |
| Rows written/day | ~10k steady ✅ / 15-day backfill ⚠️ | ~10k steady ✅ / **75-day backfill ❌** | n/a |
| Worker requests | ✅ under 100k pv | ✅ under 100k pv | **❌ needs Paid** |

Storage estimate for 40k: movie ~44 MB (1.1 KB/row, overview dominates), episode ~72 MB
(480k rows), recommendation ~16 MB, join tables ~3 MB, FTS ~15 MB, indexes ~30 MB.

**200,000 movies exceeds the 500 MB per-database free cap** and cannot be fixed by pruning
columns — episodes alone are ~360 MB. The escape hatch, in preference order: (a) Workers Paid
raises the cap to 10 GB per database and solves it outright; (b) on free, shard by
`hash(slug) % N` across up to 10 databases (5 GB account total) — but every read must then know
its shard, and cross-shard queries (search, listing) stop being possible without fan-out.
**Do not build sharding now.** It is the single largest complexity increase available and it
buys nothing at 40k. Note it, gate it behind a measured storage threshold.

### Answers to the remaining review questions

**Normalize vs denormalize.** Keep the handoff's split — it is already right. `genres_json` on
`movie` for detail rendering (no join on the hot path) *and* `genre_movie` for listing pages.
Duplication is safe here because there is exactly one writer, the cron. Do not add a trigger
to keep them in sync; sync them in the same batch that writes the movie.

**Streaming HTML.** Not worth it. Streaming's benefit is overlapping origin latency with
transfer, but the target is a 95%+ hit rate where the Worker never runs, and on a miss the D1
read is ~1-3 ms. It also complicates caching (the response body must be teed to be stored).
Build the string; 15-30 KB of concatenation is well under 1 ms. Revisit only if p99 miss TTFB
exceeds 150 ms in production.

**Repository pattern.** Endorsed, with one constraint the handoff does not state: repositories
must expose **batch** methods, never per-item ones. `getMovie(slug)` in a loop over 20
recommendations is 20 sequential round-trips to a single-threaded database. `getMoviesBySlugs(
slugs[])` is one. Given the 100-param cap, that method chunks at 100 and the type system should
make the chunking impossible to forget.

**Security.** Concretely:
- *Input validation:* `slug` and taxonomy params match `^[a-z0-9-]{1,120}$` before touching D1;
  reject rather than sanitize. `page` is an integer clamped to `[1, 500]` — unbounded `page`
  is both a cache-poisoning surface and a deep-`OFFSET` D1 cost.
- *Cache poisoning:* the real risk is query-param cardinality. Normalize the cache key —
  strip everything except a known allow-list (`page`, `q`) — so `?utm_source=…` cannot mint
  unbounded cache entries, and 301 to the canonical URL. Never reflect an unvalidated param
  into HTML; the search page echoing `q` is the one place stored XSS could become
  *cached* stored XSS.
- *Cron endpoints:* keep the existing `x-cron-key` gate (`worker/index.js` `checkCronKey`),
  compare in constant time, and return 404 rather than 403 so the routes are not discoverable.
- *Headers:* `Content-Security-Policy` with no `unsafe-inline` (achievable — SSR means no
  inline handlers; the HLS player is one external script), `Strict-Transport-Security`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`,
  `Permissions-Policy`. CSP `img-src` must list `image.tmdb.org` and `phimimg.com` explicitly,
  which is a live dependency of Finding 8.

### Finding 8 — hotlinking images is the accepted risk worth naming

Dropping R2 deletes real complexity: `worker/lib/mirror.js`, `worker/lib/images.js`, the
`mirrored`/`mirror_queue` tables, the wsrv.nl dependency, a 10-minute cron, and the entire
class of bug that produced *"~1.7% of already-mirrored objects silently held JPEG bytes under a
`.webp` key"*. That is a good trade and I endorse it.

What it costs, stated plainly: **LCP moves onto a third party you cannot purge, resize, or
monitor.** Specific known risks from this repo's own history — phimimg serves originals at
native resolution, *"sometimes several MB"*, with no size variants; and wsrv.nl already
**blocks phimimg.com by policy**, so the obvious CDN-shaped workaround is closed. TMDB paths
keep their `/t/p/w500/` sizing, so TMDB-covered titles are fine; phimimg-only titles will ship
multi-MB images to mobile.

Mitigation that costs nothing and stays inside the constraints: prefer TMDB paths whenever
present (already the handoff's stated priority), set explicit `width`/`height` to protect CLS,
`loading="lazy"` below the fold, and `<link rel="preconnect">` to both image hosts. Accept the
rest. If phimimg-only LCP proves bad in production, that is a *measured* reason to revisit R2 —
not a reason to keep it now.

---

## Consequences

**Easier:**
- The 504 class of failure disappears — no runtime dependency can time out a user request.
- Worker CPU per request drops to ~0 on cache hits (Workers Caching does not run the Worker).
- TypeScript + repositories make the 100-param cap and batch-vs-loop enforceable at compile time.
- Content invalidation becomes precise (`Cache-Tag` purge) instead of "Purge Everything".
- Deleting KV + R2 removes 3 of 5 caching layers, ~1,000 lines of Worker code, and 2 crons.

**Harder:**
- Cold start is a two-week backfill. There is no way to launch with a full catalog on day one.
- Image quality/latency is no longer controllable.
- Losing the SPA means losing client-side route transitions; every navigation is a round-trip
  (mitigated to ~10-30 ms by edge cache, but it is a real change).
- The free plan now has a hard traffic ceiling that is *visible* rather than theoretical.

**To revisit:**
- Storage at 200k titles (sharding vs Paid) — gate on measured DB size ≥ 400 MB.
- Workers Paid — gate on measured daily requests ≥ 80,000.
- R2 reinstatement — gate on measured LCP regression attributable to phimimg-only titles.

---

## Action items

1. [ ] Re-key `movie` on `slug`; composite `(tmdb_type, tmdb_id)` index, both nullable (F1)
2. [ ] `source_hash` no-op gating + `sync_state` cursor + daily row-write governor (F2)
3. [ ] Three-tier recommendation with `MAX_STUBS` cap (F3)
4. [ ] `[cache] enabled = true` + `Cache-Tag` + `ctx.cache.purge()` from sync (F4)
5. [ ] `max-age=60, stale-while-revalidate, stale-if-error`; no `s-maxage` (F5)
6. [ ] FTS5 search, sitemap index, `genre`/`country` dimension tables (F6)
7. [ ] Daily request counter + quota percentage in `/api/health` (F7)
8. [ ] CSP/HSTS/nosniff, cache-key normalization, param validation (F-security)
9. [ ] Preconnect + explicit dimensions on hotlinked images (F8)
