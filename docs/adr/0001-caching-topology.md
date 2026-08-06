# ADR-0001: Caching topology for /api/* on the Workers free plan

**Status:** Accepted — Action Items 1–6 and 8 implemented 2026-08-06 (see inline notes below and `docs/plan-hit-rate.md`, which continues this ADR's numbering as its own Phase 1–5/8); Item 7 (Option E / Workers Caching) remains open.
**Date:** 2026-08-06
**Deciders:** repo owner (sole maintainer)
**Supersedes:** the ad-hoc layering described in `CLAUDE.md` § "Caching layers"

---

## Context

`phim.bluesia.net` is a vanilla-JS SPA whose entire backend is one Cloudflare Worker on the
**free** plan. The Worker builds every `/api/*` response itself — fetching OPhim
(`ophim1.com`) and TMDB directly, enriching, mapping artwork to R2 — and also serves `dist/`
through `env.ASSETS`. There is no other server.

The goal that triggered this ADR: **pre-build the main pages' JSON on a 10–30 minute cadence
so a real user request never pays for an OPhim+TMDB build.**

### What was measured (production, 2026-08-06)

| Path | Result |
|---|---|
| `/api/home-data` (KV-backed, cron-built) | TTFB **76 ms**, `cf-cache-status: HIT`, `age: 788` |
| `/api/list?type=phim-le&page=1` (built on miss) | TTFB **917 ms**, `x-catalog-cache: stale-vps-down` |
| `ophim1.com/v1/api/**` | **HTTP 500 on every endpoint** during the review |
| `/api/health` | 503 — `home:current is 190min old`, mirror queue head stuck 197 min |

The contrast between rows 1 and 2 is the entire case for this ADR: the one path that is
pre-built is 12× faster and survived a total upstream outage; every other path did not.

### Free-plan limits, verified against Cloudflare docs on 2026-08-06

| Resource | Free limit | Note |
|---|---|---|
| Worker requests | **100,000 / day** (Error 1027 past it) | **Requests to static assets are free and unlimited** and do not consume this |
| CPU time | 10 ms / invocation | Waiting on I/O does not count |
| Subrequests | 50 / invocation | R2/KV/D1 binding calls count as subrequests |
| Simultaneous outgoing connections | 6 / invocation | |
| KV | **100,000 reads/day**, **1,000 writes/day**, 1 GB stored | Resets 00:00 UTC; past the cap, operations of that type *fail* |
| D1 | 5,000,000 rows read/day, 100,000 rows written/day, 5 GB | |
| Cron triggers | 5 per Worker | |

Two of these reshape the decision and were not in the original framing:

1. **KV's read budget (100k/day) is the same order of magnitude as the Worker's entire
   request budget (100k/day).** KV can therefore never be the *first* layer consulted on a
   hot path — it must always sit behind a cache tier, or the two quotas exhaust together.
2. **Static asset requests are free and unlimited today.** Anything that changes that
   accounting is a availability risk on this plan, not merely a cost question.

### The framing error in the original brief

Options A–D conflated two orthogonal decisions. Separating them is what makes the answer
obvious:

- **Axis 1 — where pre-built JSON is stored durably.** KV, D1, or nowhere.
- **Axis 2 — how a pre-built response reaches an edge colo the cron never ran in.**

`caches.default` is per-datacenter and a cron runs in exactly one colo, so it can only ever
serve Axis 2 opportunistically, never by warming. Axis 2 has three real candidates: the zone
CDN (driven by `Cache-Control`), Workers Caching (a per-Worker tiered cache in front of the
Worker), or nothing.

---

## Decision

**Adopt Option A, with the warm set stored as per-page KV keys and a write-if-changed guard.**

Concretely:

1. **Axis 1 — KV is the pre-built store.** A `*/30` cron writes `page:v1:<canonical-path>`
   keys for a bounded warm set. D1 `stale` remains the *disaster* fallback for everything,
   unchanged in role.
2. **Axis 2 — the zone CDN carries global coverage.** Every `/api/*` response — hit *and*
   miss, success *and* stale — must carry a correct `Cache-Control`. This is the single
   highest-value change in this ADR and is independent of everything else.
3. `caches.default` stays as the per-colo hot tier in front of KV. It is never warmed by
   cron and no design may assume it is.
4. **KV is never the first layer consulted.** Order is always cache-tier → KV → build.

**Workers Caching (Option E below) is recorded as the designated successor**, gated on one
unresolved free-plan question. See "Revisit triggers".

### Layer authority and consult order

Authoritative source per path, and the exact order the Worker consults layers:

| Path | Consult order | Authoritative durable source | `x-catalog-cache` |
|---|---|---|---|
| `/api/home-data` | zone CDN → `caches.default` → KV `home:current` → inline fallback build | **KV** | `hit` / `warm` / `miss-fallback` |
| `/api/list\|genre\|country`, page 1, **in warm set** | zone CDN → `caches.default` → KV `page:v1:*` → live build → D1 `stale` | **KV** (fresh), D1 (disaster only) | `hit` / `warm` / `miss` / `stale-vps-down` |
| same, **not in warm set**, or page ≥ 2 | zone CDN → `caches.default` → live build → D1 `stale` | **D1 `stale`** | `hit` / `miss` / `stale-vps-down` |
| `/api/movie/:slug` | zone CDN → `caches.default` → live build → D1 `stale` | **D1 `stale`** | `hit` / `miss` / `stale-vps-down` |
| `/api/recommendation/*` | zone CDN → `caches.default` → D1 `recs` → live build | **D1 `recs`** | `hit` / `d1-recs` / `miss` |
| `/api/search` | zone CDN → `caches.default` → live build | **none, by design** | `hit` / `miss` |
| `/api/health` | never cached (`no-store`) | — | n/a |

`warm` is a **new** value in the `x-catalog-cache` contract, meaning "served from the
pre-built KV copy without building". It exists so `warm` vs `miss` distinguishes "the cron is
doing its job" from "the cron is not", which is exactly the failure the current design cannot
see. The existing `hit` / `miss` / `stale-vps-down` values keep their meanings; `stale-vps-down`
keeps its misleading name because it is a documented contract and renaming it buys nothing.

---

## Options considered

### Option A — KV pre-build + `Cache-Control` on every response *(chosen)*

| Dimension | Assessment |
|---|---|
| Complexity | Low–Medium — extends a pattern already in production for `home-data` |
| Cost | $0; constrained by the 1,000 KV writes/day budget |
| Global propagation | Good — KV is globally replicated; zone CDN fills per-colo on first request |
| Blast radius if wrong | Small — rollback is deleting the warm cron |

**Pros**
- The read path is byte-for-byte the shape `/api/home-data` already runs at 76 ms TTFB in
  production. Nothing speculative.
- Fixing `Cache-Control` is valuable on its own even if pre-building were abandoned entirely.
- KV read latency is globally cached, so a distant colo's KV miss is still fast.
- Fails visibly: a stalled warm cron shows up as `x-catalog-cache: miss` where `warm` was
  expected, and as an ageing timestamp `/api/health` can assert on.

**Cons**
- The KV write budget hard-caps the warm set. Arithmetic below.
- Exceeding the KV write budget fails *all* KV writes for the rest of the UTC day, including
  `home:current` — the blast radius of overshooting is the homepage freezing, not just the
  warm set going stale.
- Does nothing for the invalidation problem; "Purge Everything" on the dashboard remains the
  only fleet-wide lever.

### Option B — D1 as the pre-built store

| Dimension | Assessment |
|---|---|
| Complexity | Low — the `stale` table already stores exactly this shape |
| Cost | $0; 100k row-writes/day means cadence is effectively unconstrained |
| Global propagation | Poor — D1 is region-homed |
| Blast radius if wrong | Medium — puts D1 on the hot request path |

**Rejected because** it moves D1 from the failure path to the hot path. D1 is region-homed;
read replication exists and costs nothing extra, but requires the Sessions API
(`env.DB.withSession(bookmark)`) and places one replica per D1 *region*, which is still far
coarser than KV's edge caching. Trading KV's write budget for worse p95 latency on every
cache miss is the wrong trade for a site whose entire complaint is page-load latency. The
write-budget problem it solves is real but has a cheaper fix (write-if-changed, below).

### Option C — no pre-building, `Cache-Control` fix only

| Dimension | Assessment |
|---|---|
| Complexity | Very low — a header change |
| Cost | $0 |
| Global propagation | Good |
| Blast radius if wrong | None |

**Rejected as the *whole* answer, adopted as its first phase.** The header fix alone leaves
the first request per colo per TTL paying a measured ~917 ms build, and leaves OPhim on the
critical path of a real user's request. During the outage observed while writing this ADR,
that first request would have failed rather than been slow. But it is genuinely the highest
value-per-line change here, so it ships first and independently — see Action Items.

### Option D — hybrid KV hot set + D1 long tail

**Rejected as a distinct option because it is what Option A already is.** D1 `stale` continues
to back every path as the disaster fallback; A only adds KV in front for the warm set. Naming
it separately implies a design difference that does not exist.

### Option E — Workers Caching (`[cache] enabled = true`)

Not in the original brief; surfaced while verifying the free-plan limits. Workers Caching is a
**tiered cache that sits in front of the Worker itself**: on a hit the Worker does not run at
all (no CPU, no subrequests). It is configured entirely by the `Cache-Control` the Worker
returns, is zone-independent, and — decisively for this project — supports a `Cache-Tag`
response header plus programmatic `ctx.cache.purge()`.

| Dimension | Assessment |
|---|---|
| Complexity | Medium — replaces the hand-rolled `caches.default` layer |
| Cost | $0 in dollars; **unquantified in free-plan request accounting** |
| Global propagation | Best of all options — genuinely tiered |
| Blast radius if wrong | **High** — see below |

**Why it is attractive.** It solves the one wound this project keeps reopening. `CLAUDE.md`
documents that changing how image URLs are built requires a manual dashboard "Purge
Everything", that `cache.delete()` only evicts one colo, and that a `CACHE_VERSION`
query-param scheme was tried and reverted (`a4826f7`) as redundant with that dashboard purge.
`Cache-Tag` + `ctx.cache.purge()` is a *third* answer that neither of those was: fleet-wide,
programmatic, and scoped to the affected tag rather than the whole zone. That is a strictly
better invalidation story than anything Option A can offer, and it is the reason this option
is recorded as the successor rather than simply rejected.

**Why it is not chosen now.** The docs state that with caching enabled, *"every request to
your Worker is charged at the standard Workers request rate, including requests that are
normally free: static asset requests and worker-to-worker invocations."* This project serves
roughly four static-asset requests per page view and makes five service-binding calls per home
refresh. On the free plan the analogue of "charged" is the **100,000 requests/day cap**, so
enabling this could convert today's free, unlimited asset traffic into capped traffic and take
the site down with Error 1027. The docs describe a per-entrypoint escape hatch
(`[exports.default.cache] enabled = false`), but whether that also restores free asset
accounting is **not stated** and must be measured before adopting. Prerequisites are otherwise
already met: wrangler `^4.116.0` ≥ 4.69.0, and `compatibility_date = "2026-08-01"`.

---

## Trade-off analysis

The decision reduces to three trades.

**1. KV write budget vs. warm-set size.** This is Option A's only hard constraint, so it gets
explicit arithmetic rather than a hand-wave.

Current committed KV writes per day:

| Writer | Writes/day |
|---|---|
| `home:current` (hourly cron) | 24 |
| `trending:week` + `trending:day` (6 h TTL) | ~8 |
| `meta:*` TMDB enrichment (14 d TTL, ~111 keys steady) | ~10 steady, **bursty** when OPhim adds titles — budget 100 |
| **Committed subtotal** | **~132** |

Leaving 10 % headroom against the 1,000/day cap gives ~770 writes for the warm set. Note
`/api/home-data` is **not** part of this budget — it already has its own hourly cron and
`home:current` KV key, counted in the committed subtotal above; the warm set below is
`page:v1:*` pages only, plus one small metadata key (`warm:last-run`, added in Phase 5 so
`/api/health` can judge the warm cron's own freshness the same way it judges `home:current`'s):

```
N_slots × (1440 / cadence_minutes) ≤ 770        (N_slots = page:v1:* keys + 1 meta key)
```

| Cadence | Max slots | At N = 13 (12 pages + 1 meta) | Total incl. committed |
|---|---|---|---|
| 30 min | 16 | 624/day | ~756/day (**~76 %**) |
| 15 min | 8 | — | — |
| 10 min | 5 | — | — |

**Chosen: 30-minute cadence, warm set of 12 `page:v1:*` keys** — the five
`/api/list?type=…&page=1` types, and seven genre/country page-1 pages chosen by actual traffic
(implemented as 4 genre + 3 country, see `worker/lib/warm.js`). Plus the 1 metadata key, 13
slots land at ~76 % of quota, leaving real room for a `meta:*` burst. Sixteen slots is the
mathematical ceiling; thirteen is the operational one, and the gap is deliberate.

**Write-if-changed guard.** The cron compares each freshly-built body against the current KV
value and skips the write when identical. Genre and country page 1 change slowly, so
steady-state writes land well under the worst case above. The comparison costs one KV read per
key per cycle — 12 × 48 = 576 reads/day against a 100,000/day budget, i.e. free.

**Correction, 2026-08-06 (plan-hit-rate.md Phase 8):** the `~111 keys steady` figure above was
never re-measured after the catalog grew and is wrong — actual count that date was **2,262**,
confirmed via `wrangler kv key list --prefix meta:`. Measuring the real *write rate* (not just
key count) by back-computing creation time from each key's `expiration` (TTL is a fixed 14
days, so `created_at = expiration - 14d`) found something more concerning than the stale count
alone: **749 meta:\* writes in the preceding 24h**, peaking at an extrapolated **~1,480/day** in
the 6–12h window, all tracking the 2026-08-06 OPhim→KKPhim catalog-source swap (every card
needed re-enrichment against KKPhim's TMDB ids). The rate had returned to ~0/hour by the time of
measurement (last write ~3.7h prior) — so steady-state *between* migrations is close to the
original assumption, but the **burst ceiling this ADR reserved (100/day) is roughly 15x too
small** for what an actual catalog-source change produces.

This matters because of what it stacks against: committed subtotal (~32/day) + the warm set's
own writes (up to 624/day at N=13) = **~656/day already reserved** before any `meta:*` burst.
A repeat of the measured 2026-08-06 burst (750–1,480/day) on top of that would exceed the
1,000/day cap and trigger the "Overflow behavior" below **for real** — not hypothetically. The
warm set was sized against a burst assumption that a real migration already disproved.
**Revisit before enabling anything that adds more scheduled KV writes** (e.g. extending the
warm set to `/api/movie/:slug`, flagged as a stretch goal in `docs/plan-hit-rate.md` Phase 4 and
deliberately not done for this reason) — the 76%-of-quota headroom this ADR claims does not
survive a second migration-scale burst landing in the same UTC day as a warm cycle.

**Overflow behavior, stated explicitly because it is nasty.** Past 1,000 writes, KV writes
*fail* until 00:00 UTC. `home:current` stops updating and the homepage freezes at whatever it
last held. `/api/health` already reports home age and would flag it, but only as "home is
stale", not "you are out of KV writes" — so the warm cron must report attempted-vs-skipped
write counts and health must assert on that directly.

**2. Latency vs. staleness.** A 30-minute cadence means catalog data can be up to 30 minutes
old before the CDN TTL is even applied. For a Vietnamese movie catalogue whose upstream itself
updates in batches, this is not a real cost — and the current hourly homepage cron already
accepts double that.

**3. Invalidation debt.** Option A leaves "Purge Everything" as the only fleet-wide lever, and
`CLAUDE.md` already records one incident where forgetting it left recommendations pointing at
a retired image host. Choosing A accepts carrying that debt for now in exchange for not
gambling the free-tier request cap on Option E. That debt is the explicit reason Option E has
a revisit trigger rather than a rejection.

---

## Consequences

**Becomes easier**
- Main pages stop paying build cost on the request path; the measured 917 ms → ~76 ms shape
  extends from one route to twelve.
- An OPhim outage degrades to "slightly stale" instead of "917 ms then a 502" for the warm set.
- `warm` vs `miss` in `x-catalog-cache` makes warm-cron health observable by `curl`, which
  matters in a repo with no tests and no CI.
- Fixing `Cache-Control` means any colo self-populates on its first request, so cold-colo
  performance stops depending on where the cron happened to run.

**Becomes harder**
- A new hard budget to respect. Adding a page to the warm set is no longer free — it costs
  48 KV writes/day and must be checked against the arithmetic above.
- One more layer that can serve a wrong body. Cached JSON embeds absolute image URLs, so the
  existing rule stands and gets wider: **any change to image URL construction requires a
  dashboard Purge Everything *and* a forced warm-cron run.**
- The browser now caches `/api/*` for a bounded window where previously (on a miss) it cached
  nothing. The zone is currently injecting `max-age=14400` into these responses via a Browser
  Cache TTL override; that must be corrected to "respect origin" as part of this work, or the
  header fix makes staleness worse rather than better.

**Needs revisiting**
- Warm-set membership, once real traffic data exists. Twelve keys chosen by guess is a
  placeholder.
- Option E, on the triggers below.

### Revisit triggers

Move to Option E (Workers Caching) when **both** hold:

1. A measurement confirms that `[exports.default.cache] enabled = false` keeps static-asset
   requests out of the free plan's 100,000/day request count — or the site moves to the paid
   plan, making the question moot.
2. An invalidation incident recurs, or an image-URL migration is planned, such that
   `Cache-Tag` + `ctx.cache.purge()` pays for the migration on its own.

Revisit Option B (D1 pre-build) if the KV warm set needs to exceed ~16 keys, since that is the
point where the write budget, not latency, becomes the binding constraint.

---

## Migration and rollback

Each phase is independently deployable and independently revertible. Ship in order; do not
bundle.

| Phase | Change | Verify | Rollback |
|---|---|---|---|
| 0 | `/assets/*` immutable rule in `public/_headers` | `curl -sD- .../assets/index-*.js \| grep cache-control` → `immutable` | revert 2 lines |
| 1 | `Cache-Control` on **every** `/api/*` response incl. miss, stale, 5xx; Cache Rule on `/api/*` → Browser TTL "respect origin" | Second request from a cold colo shows `cf-cache-status: HIT`; `max-age=14400` gone | revert header block; delete Cache Rule |
| 2 | Canonicalize the cache key (sorted param allow-list) | `?type=x&page=1` and `?page=1&type=x` return the same `cf-ray`-independent cached body | revert |
| 3 | `page:v1:*` KV read path + `warm` status, **read only**, no cron yet | Manually `wrangler kv key put --remote` one key, confirm `x-catalog-cache: warm` | revert; path falls back to live build |
| 4 | `*/30` warm cron with write-if-changed + write-count reporting | `/__cron/warm` returns `{written, skipped, failed}`; KV write count in dashboard tracks the arithmetic | delete the cron trigger — phase 3 degrades cleanly to live builds |
| 5 | `/api/health` asserts on warm-set age and KV write failures | `/api/health` returns 503 when the warm cron is stalled | revert health check |

Rollback of the whole ADR is deleting the `*/30` trigger and the `page:v1:*` read branch;
every path then falls back to the current live-build behavior, with phases 0–2 retained as
pure improvements.

---

## Action items

1. [x] **Phase 0 now, independent of everything else** — add `/assets/*` → `public, max-age=31536000, immutable` to `public/_headers`. Done — present in `public/_headers`.
2. [x] Audit the zone's Browser Cache TTL setting and add a Cache Rule for `/api/*` set to "respect origin". Done 2026-08-06 — repo owner switched the dashboard setting to "respect existing headers"; superseded the originally-planned Cache Rule approach once `docs/plan-hit-rate.md` §6.5 (Phase 1) found that response-level `stale-while-revalidate` didn't need one.
3. [x] Design the full `Cache-Control` policy table (per route, `s-maxage` / browser `max-age` / `stale-while-revalidate`, incl. negative caching for `stale-vps-down` and 5xx). Done — `docs/plan-hit-rate.md` §5/§6 Phase 1, implemented in `worker/index.js` `clientCacheControlFor`.
4. [x] Confirm Tiered Cache availability on this zone's plan; without it, Axis 2 coverage is per-colo-on-first-request rather than tiered. Confirmed free on Free/Pro/Business via Cloudflare docs and enabled on the zone 2026-08-06 (`docs/plan-hit-rate.md` Phase 2).
5. [x] Pick the 12 warm-set keys from real traffic rather than intuition. Done 2026-08-06 — `docs/plan-hit-rate.md` Phase 4, `worker/lib/warm.js` `getTopWarmTargets` ranks D1 `popularity` by sampled hits, falling back to this ADR's original static list only to fill slots real data hasn't reached yet.
6. [x] Add attempted/skipped/failed KV write counts to the warm cron's response and assert on them in `/api/health`. Already implemented pre-dating this correction pass — `runWarmRefresh`'s `{written, skipped, failed}` and `handleHealth`'s assertion on it.
7. [ ] Measure Option E's free-plan request accounting on a throwaway Worker before it is ever considered for this one. Still open — Option E (Workers Caching) was not pursued; `docs/plan-hit-rate.md` treats it as a separate, not-yet-triggered revisit (its own "Phase 7"-adjacent territory, gated on a Cache Reserve/paid-plan decision instead).
8. [x] Add `stale` table eviction — it is unbounded today and `cleanupRecTables` does not touch it. Done 2026-08-06 — `docs/plan-hit-rate.md` Phase 8, `worker/index.js` `cleanupStaleTable` (90-day cutoff on `updated_at`), run from the same hourly cron as `cleanupRecTables`.
