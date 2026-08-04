# CLAUDE.md — redflare (film-bluesia-red)

This file is self-contained: it carries the shared behavioral guidelines (below)
plus project-specific guidance (further down). Keep both in sync if the parent
[`../CLAUDE.md`](../CLAUDE.md) changes.

---

# Behavioral guidelines

Behavioral guidelines to reduce common LLM coding mistakes. Merge with
project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks,
use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes,
simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it
work") require constant clarification.

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer
rewrites due to overcomplication, and clarifying questions come before
implementation rather than after mistakes.

---

# Project guide

## What this is

`phim.bluesia.net` — a Vietnamese movie-streaming front-end. **Vanilla JS SPA**
(no framework), built with Vite, deployed entirely to Cloudflare's free
tier: static assets **plus a Worker** (`worker/index.js`, `main` in
`wrangler.toml`) that does *all* the catalog work itself — OPhim proxying,
TMDB enrichment, hero/recommendation ranking, R2 image mirroring — with no
backend server anywhere else. `hls.js` + `artplayer` handle playback. Images
are served from **R2** (`redflarer2.bluesia.net`), mirrored there by the
Worker itself — see "Data flow & caching" below.

**This used to run differently.** Through 2026-08-01 the Worker was a thin
KV cache-aside shim in front of a VPS Node service (`catalog-api`, at
`img.bluesia.net/api/*`) that did all the real work; the VPS also mirrored
images into R2 and ran Valkey as its own cache. That VPS backend
(`bluefilm-backend`) was migrated onto the Worker in phases and the VPS
stack was fully retired 2026-08-01 — see
[`bluesiaOM/context/state-redflare-cf-worker.md`](../bluesiaOM/context/state-redflare-cf-worker.md)
for the phase-by-phase history and the gotchas hit along the way (D1's
100-bound-param cap, a Worker `fetch()`-ing its own Custom Domain always
returning 522, etc). The retired VPS source is archived, not deleted, at
`github.com/O365ServeronMS/bluefilm-backend` — it's the reference if the
enrichment/ranking logic ever needs cross-checking.

There are **no tests**, **no TypeScript**, and **no linter/CI**. Plain ES modules
+ imperative DOM.

## Stack & commands

Node **26** (pinned in `.nvmrc` — Cloudflare's build image reads it too).

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server on `:3000`. Default loop. `src/api/ophim.js` calls same-origin `/api/*`; `vite.config.js`'s `server.proxy` forwards that straight to the **live production Worker** at `phim.bluesia.net/api/*` (the Worker is the only backend now — there is no local backend to run instead). |
| `npm run build` | Vite build → `dist/` |
| `npm run preview` | Vite's own static preview of `dist/` (no SPA fallback, no Worker — but `preview.proxy` forwards `/api/*` to the live production Worker same as `dev`) |
| `npm start` | `wrangler dev --remote` — runs the **actual Worker** (`worker/index.js`) with **real bindings** (KV/D1/R2/service binding), serving `dist/` through the asset layer. Use `--remote`, not plain `wrangler dev` — local simulated bindings are empty/stale and will not reproduce real cache/D1/R2 behavior (see "Platform gotchas" — `wrangler kv/r2/d1` commands need `--remote` too, for the same reason). Use this to verify `not_found_handling = "single-page-application"` (deep link like `/phim/<slug>` reloads correctly) **and** to test the Worker's own builders (`worker/lib/*`) and Cache API / D1 fallback behavior. Requires `npm run build` first. |

**Deploy = `git push origin main`.** Cloudflare Workers Builds picks it up, runs
`npm run build`, and publishes `dist/` as static assets. No `wrangler deploy` by
hand. Confirm before committing/pushing unless told otherwise.

`wrangler.toml` pins the custom domain (`routes` with `custom_domain = true`) on
purpose — each deploy re-attaches `phim.bluesia.net` so the site doesn't go down
if the Git integration is disconnected/reconnected. Don't remove it.

## Architecture

- **`src/main.js`** — entry point. Mounts global UI (Header, Search), wires the
  router, defines one async page-render function per route.
- **`src/router.js`** — History API SPA router. `:param` patterns. A handler may
  return a cleanup fn (sync or a Promise resolving to one); the router calls it
  on navigation. Internal `<a href="/...">` clicks are intercepted globally.
- **`src/api/ophim.js`** — the **only** module that talks to the network. Every
  fetch goes to `CATALOG_BASE` (= `/api`, same-origin — handled by the Worker);
  nothing here calls OPhim directly. Also exports `posterUrl`/`thumbUrl`
  (pass-throughs — image URLs arrive as full R2 URLs already), `upstreamFallback`/
  `attachImageFallback` (retry the original TMDB/OPhim URL if the R2 mirror
  hasn't landed yet — see "Images: R2" below), and `normalizeListItem` (smooths
  over OPhim's two list shapes).
- **`worker/index.js`** + **`worker/lib/*`** — the Worker. Handles `/api/*`
  end to end: fetches OPhim + TMDB directly, runs enrichment/ranking
  (`worker/lib/enrich.js`, ported from the retired `catalog-api`), maintains
  the reverse index + recommendation cache in D1 (`worker/lib/recommendation.js`),
  maps/mirrors artwork into R2 (`worker/lib/images.js` for URL mapping,
  `worker/lib/mirror.js` for the mirror-queue drain). `/api/home-data` is
  pre-built by an hourly cron (`worker/lib/home.js`) rather than built
  per-request — see "Data flow & caching". Anything that isn't `/api/*` and
  isn't a literal file in `dist/` falls through to
  `env.ASSETS.fetch(request)`, which applies `not_found_handling` below (SPA
  fallback).
- **`src/modules/<Name>/<Name>.js`** — UI modules, each exporting
  `renderX(container, ...)` that builds DOM imperatively and appends it. No
  virtual DOM, no templating lib. Naming rules + migration status live in
  [`MODULES.md`](MODULES.md) — read it before adding or renaming a module.
- **`src/components/MovieDetail.js`** — the last legacy resident; it is
  page-level, so it moves to `pages/DetailPage.js` in the planned `pages/` step,
  not into `modules/`.
- **`src/styles/`** — `variables.css` (CSS custom props), `global.css`,
  `components.css` (the bulk, still monolithic). Class naming is BEM-ish:
  `block__element--modifier`.
- **`docs/DESIGN.md` + `docs/tokens.json`** — the Netflix-style design reference
  the tokens in `variables.css` derive from. Reference only, not built.
- **`catalog-api`** (retired 2026-08-01) — used to be a separate Node service
  on the VPS doing everything `worker/lib/*` does now (OPhim proxying, hero
  ranking, TMDB enrichment, R2 mirroring, Valkey cache), served at
  `img.bluesia.net/api/*`. Fully ported to the Worker across Phases 3–6 of
  the migration and shut down; source archived at
  `github.com/O365ServeronMS/bluefilm-backend` for reference, not imported by
  this repo. The original `worker.js`/`trending.js` in *this* repo were
  deleted when that logic first moved to the VPS (commit `81e498a`) — the
  current `worker/index.js` + `worker/lib/*` is a from-scratch reimplementation
  written for the Worker runtime, not a revert of that old code.

## Data flow & caching (important)

Two different paths, both entirely on Cloudflare — no other server involved:

- **Data** (`/api/*`) — same-origin. The frontend calls `phim.bluesia.net/api/*`,
  which the Worker (`worker/index.js` + `worker/lib/*`) handles directly: it
  fetches OPhim and TMDB itself, runs enrichment/ranking, and (for
  recommendations) reads/writes a reverse index in D1. `/api/home-data` is
  the one exception — it's pre-built by an hourly cron rather than per
  request, see below. The Cache API sits in front of everything as the hot
  tier — see "Caching layers" below for exactly how.
- **Images** — `redflarer2.bluesia.net` (R2), never proxied through the
  Worker at read time. The Worker mirrors TMDB/OPhim artwork into R2 itself
  (`worker/lib/mirror.js`): every build enqueues new image URLs into a D1
  queue (`mirror_queue`), and a cron every 10 minutes drains up to 20 at a
  time — `env.BUCKET.head()` to skip ones already mirrored, otherwise fetch
  upstream and `env.BUCKET.put(key, res.body)` streamed straight through (no
  in-JS hashing). **No lifecycle expiry rule on the bucket** — objects don't
  expire on their own once mirrored (an earlier version of this doc claimed a
  150-day TMDB cache-duration expiry; that was never actually configured on
  the bucket — corrected 2026-08-01).

  **TMDB artwork is mirrored as WebP** (2026-08-04 migration — the WHY/plan
  lived in a now-deleted `state.md` during the work; this doc is the durable
  record). `image.tmdb.org` does content negotiation — `Accept: image/webp`
  gets a ~30-36% smaller response than the default JPEG — but sends **no
  `Vary: Accept`**, so a cached JPEG can be handed back to a WebP request
  regardless of the header; `worker/lib/mirror.js` works around this with
  `cf: { cacheTtl: 0 }` on the fetch and asserts the response actually is
  `image/webp` before writing (retrying otherwise, since a permanent
  give-up would strand the object). R2 keys **append** rather than swap the
  extension — `t/p/w500/<hash>.jpg` → `t/p/w500/<hash>.jpg.webp` — so the
  inverse (`upstreamForKey` in `worker/lib/images.js`, `upstreamFallback` in
  `src/api/ophim.js`) never has to guess the original extension; these two
  functions are a load-bearing contract, keep them in lockstep. `img.ophim.live`
  does **not** negotiate WebP, so OPhim-sourced keys are mirrored as plain
  JPEG at their original extension, unmodified by this.

  Every `w500` poster (`thumb_url`) also gets a `w154` sibling mirrored
  alongside it (`worker/lib/images.js` `addW154Sibling`) — the hero rail
  (`HeroSlider.js`) renders at 42px/30px wide and would otherwise load a
  500px poster into a slot 12-16x smaller than the image.

  **OPhim artwork is NOT mirrored as WebP** — instead, `posterUrl`/`thumbUrl`
  in `src/api/ophim.js` wrap the plain R2 mirror in a same-zone Cloudflare
  Image Transformation (`phim.bluesia.net/cdn-cgi/image/width=...,
  format=auto/<r2-url>`) at serve time. This is a serve-time-only decision
  deliberately kept out of `r2ImageUrl()`: `thumb_url`/`poster_url` in API
  responses stay plain R2 URLs, which is what `mirrorTargets` keys off to
  enqueue the raw mirror the transform reads from. **Image Transformations
  only accept same-zone sources** — a transform request with
  `image.tmdb.org` or `img.ophim.live` as the source 403s; only a source
  already inside this account's R2/zone works, confirmed by direct test.
  Free tier is 5,000 unique transformations/month; this project is the sole
  consumer on the account.

  R2 object keys otherwise still mirror the upstream path
  (`t/p/w500/<hash>.jpg[.webp]`, `ophim/<path>`), so if a mirror hasn't
  landed yet (or R2 is somehow unreachable) the frontend's `<img onerror>`
  handler rebuilds the original TMDB/OPhim URL from the R2 URL (unwrapping
  the `.webp` suffix and/or the transform wrapper first, as applicable) and
  retries it directly — see `upstreamFallback`/`attachImageFallback` in
  `src/api/ophim.js`.

### Endpoints the frontend calls

All defined in `src/api/ophim.js`, all same-origin `/api/*`, all built by the
Worker itself now (no upstream to fall back to). Keep this table in sync when
adding one.

| Client fn | Endpoint | Notes |
|---|---|---|
| `getHomeData` | `GET /api/home-data` | Whole home page in one shot: hero ranking + all rails |
| `getNewMovies` | `GET /api/list?type=phim-moi-cap-nhat&page=` | |
| `getMoviesByType` | `GET /api/list?type=&page=` | `phim-le`, `phim-bo`, `hoat-hinh`, `tv-shows` |
| `getMoviesByGenre` | `GET /api/genre?slug=&page=` | |
| `getMoviesByCountry` | `GET /api/country?slug=&page=` | |
| `getMovieDetail` | `GET /api/movie/:slug` | |
| `searchMovies` | `GET /api/search?keyword=&page=` | |
| `getRecommendation` | `GET /api/recommendation/:mediaType/:tmdbId` | `mediaType` must be `movie`/`tv` — TMDB ids collide across the two. Legacy `/api/related` alias still served |

### Field ownership: OPhim vs TMDB

A recurring misreading: *"OPhim only tells us which titles exist + their TMDB id,
TMDB supplies the metadata."* Not how it works. The Worker fetches the **whole
OPhim record**, then **overrides a fixed set of fields** with TMDB
(`worker/lib/enrich.js`, ported from the retired `catalog-api/src/tmdb-enrich.js`).
OPhim is the per-field fallback, so a title that TMDB can't resolve still
renders — just with OPhim values.

| Field | Owner | Notes |
|---|---|---|
| `name` | TMDB vi-VN title → OPhim | See readability rule below |
| `origin_name` | TMDB `original_title` → OPhim | Same rule; OPhim's is reliably English |
| `poster_url` | TMDB `w1280` backdrop → OPhim | Wide image. R2-mapped after enrich (`worker/lib/images.js`) |
| `thumb_url` | TMDB `w500` poster → OPhim | Portrait image. `w154` sibling also mirrored for the hero rail — see "Images" above |
| `vote_average` | TMDB (1 dp) → OPhim | Detail badge is hardcoded "TMDB" even on fallback |
| `content` | TMDB `overview` vi-VN → OPhim | **Detail only** — cards never carry it |
| `year` | TMDB release/first-air → OPhim | Detail only |
| `actor` | TMDB credits, top 15 by `order` → OPhim | Detail only. Names come back in the original script (Korean, Chinese …) |
| `trailer_url` | TMDB YouTube trailer → OPhim | Detail only |
| `director` | **OPhim** | TMDB deliberately not read; no UI renders it either |
| `category`, `country` | **OPhim** | The taxonomy behind `/the-loai/*` and `/quoc-gia/*`. TMDB genres are never used |
| `slug`, `_id` | **OPhim** | URL identity — never touch |
| `episodes[]` (`link_m3u8`, `link_embed`, `server_name`) | **OPhim** | Playback. TMDB has no part in it |
| `type`, `status`, `quality`, `lang`, `episode_current`, `time` | **OPhim** | Card badges |
| `tmdb.{id,type,season}`, `imdb.id` | **OPhim** | The join keys that make enrichment possible at all |

Two enrich levels, deliberately different: **detail** (`enrichItem`) takes the
full set above; **cards / hero / list / search** (`enrichItemCard`) take only
`name`, `origin_name`, `poster_url`, `thumb_url`, `vote_average` — overview,
cast and trailer would be wasted bytes on a poster.

**Readability rule (`readableTitle`).** TMDB returns the *original* title when a
vi-VN translation is missing, which once put Chinese and Thai titles in the
headline `name` on cards. Any title carrying non-Latin script (Hangul, CJK,
Thai, Cyrillic …) is dropped so the OPhim value wins — OPhim's `name` is
always Vietnamese and its `origin_name` is Latin/English. Vietnamese
diacritics are Latin script, so they pass. Applied inside `mapTmdb`, i.e.
*before* the 14-day `catalog:c1:meta:*` cache — changing the rule means
purging those keys.

**Ranking is TMDB, availability is OPhim.** Hero + "Phim Trending" take their
order from TMDB trending (week / day), but only titles present in the fetched
OPhim pool can appear — hero often lands short of its 20 slots for that reason.
Recommendations work the same way: TMDB `/recommendations` (then `/similar`),
matched back to OPhim by `tmdb.id` + media type.

**Search queries OPhim, displays TMDB.** The keyword goes straight to OPhim's
index, so a title is findable under OPhim's naming while the card shows the TMDB
name. Expect the two to disagree occasionally.

### Caching layers

1. **In-page** — `src/api/ophim.js` memoizes every response by URL for **5 min**
   (`CACHE_TTL`). Cleared on hard reload; nothing else invalidates it.
2. **Cache API** (`caches.default`, `worker/index.js`) — the hot tier for
   **every** `/api/*` path, chosen deliberately over Workers KV because it has
   no daily write-quota (KV's 1,000 writes/day would be blown through by
   `/api/search`'s unbounded keyword cardinality alone). A hit is served
   straight from cache with no rebuild; a miss falls through to the Worker's
   own builder (OPhim + TMDB fetch, enrichment, D1 lookups as needed) and the
   fresh response is written back to cache before returning. `x-catalog-cache:
   hit`/`miss` on every response says which happened.
3. **KV** (`CATALOG_KV`) — deliberately minimal: one key
   (`home:current`, plus TTL'd `trending:week`/`trending:day`) written only by
   the hourly cron, never per-request, and ~111 `meta:*` TMDB-enrichment
   entries (14-day TTL) written by `worker/lib/enrich.js`. `/api/home-data`
   reads `home:current` directly — no build happens on that request path at
   all, see below.
4. **D1** (`redflare-db`) — 5 tables, all live: `stale` (last-known-good copy
   per path for list/genre/country/movie/recommendation, upserted on every
   successful build — this is what would get served if OPhim/TMDB itself were
   ever unreachable, `x-catalog-cache: stale-vps-down` despite the header name
   predating the VPS's retirement); `idx` (reverse index, OPhim item keyed by
   `tmdb.id`+media type, built by the hourly-shard cron + on-demand during
   detail/recommendation builds — this is what makes recommendation matching
   possible without a full OPhim search); `recs` (TMDB recommendation
   results, TTL by **result completeness**, not just presence — see
   "Recommendation cache TTL" below); `mirrored` + `mirror_queue` (R2
   image-mirror bookkeeping, see "Images" above).
5. **Cloudflare edge** — assets only (`dist/`), plus whatever CDN caching R2
   applies to images. `/api/*` JSON never reaches this layer as a distinct
   cache — that's the Cache API above (also edge-backed, but addressed
   explicitly via `caches.default` rather than implicit HTTP caching).

**Home page is special: cron-built, never built on request.**
`/api/home-data` would blow the 10ms CPU / 50-subrequest budget if built
synchronously (it needs OPhim + TMDB across many categories). Instead an
hourly cron (`0 * * * *` → `worker/lib/home.js` `runHomeRefresh`) calls 5
`/__cron/shard/:n` routes (shards 0,1,2,4,5 — 3 was `hoat-hinh`'s card rail,
removed 2026-08-04 since the Hoạt Hình rail was cut from the homepage; the
`hoat-hinh` OPhim list is still fetched as part of the 10-URL pool shards 4/5
match trending against, and shard 4's hero pool additionally filters out
`item.type === 'hoathinh'` so animation titles don't appear in "Phim Hot
Trong Tuần" — `/danh-sach/hoat-hinh` itself is unaffected) — each its own
Worker invocation with its own
CPU/subrequest budget — via the `SELF` **service binding** (not a public
`fetch()`; a Worker fetching its own Custom Domain always 522s, a documented
Cloudflare behavior), concatenates the resulting JSON without reparsing, and
writes one KV key. The request path only ever reads that key.

**Recommendation cache TTL (`worker/lib/recommendation.js` `classifyTier`/`ttlForTier`).**
Not just "has results / empty" — a result is `full` (30 days) only if it
either filled all `RELATED_LIMIT` (8) slots or every TMDB candidate was
actually attempted (no OPhim-search budget cutoff, no OPhim call failures);
otherwise `partial` (6 hours, so it self-heals soon instead of freezing a
short list for a month); truly empty stays 1 hour. Both the D1 `recs` row
and the Cache API entry in front of it are set from the *same*
`classifyTier()` call on the same payload — added because they used to
disagree: a title's D1 cache could get manually corrected while the Cache
API kept serving the old 30-day-pinned response to real users regardless
(see bluesiaOM/context/state-sua-loi-recommendation.md Phase 0 for how this
surfaced — "Gia Tộc Rồng" recommending without "Game of Thrones"). To force
one title's recommendation cache to rebuild immediately at *both* layers:
`GET /__cron/purge-recs?type=movie|tv&id=<tmdb id>` (header `x-cron-key:
<CRON_KEY>`, same gate as the other `/__cron/*` routes).

**To force fresh data:** for `/api/list`/`genre`/`country`/`search`/`movie`,
delete the specific Cache API entry (no dashboard UI for this — easiest is a
cache-busting query param, or wait out the response's `Cache-Control`) or
just let the next distinct request rebuild it (Cache API misses are cheap,
there's no upstream to protect anymore). Recommendation has its own purge
route, see above. For home, the KV key `home:current` only changes on the
next hourly cron tick — trigger it on demand with `GET /__cron/refresh-home`
(header `x-cron-key: <CRON_KEY>`). Changing the enrichment table above needs
more: TMDB values are frozen in KV `meta:*` for 14 days, and already-built
recommendation results sit in D1 `recs` (up to 30 days, see the TTL tiers
above) — both need clearing or stale data resurfaces in
"Bạn cũng có thể thích".

**Why this shape:** everything runs inside the Workers free tier (10ms CPU,
50 subrequests/request, 1,000 KV writes/day) — every design choice above
(Cache API over KV for the hot tier, D1 for the reverse index instead of KV,
cron-sharded home build instead of per-request, streamed R2 PUT instead of
in-JS hashing) traces back to one of those three limits. See
`bluesiaOM/context/plan-redflare-len-cf-worker.md` for the full reasoning per
constraint, and `bluesiaOM/context/state-redflare-cf-worker.md` for how each
phase actually turned out (including two platform bugs that ate most of the
debugging time: D1's undocumented 100-bound-param-per-query cap silently
rejecting large batch inserts, and `wrangler secret put` not reliably
attaching unless preceded immediately by a `wrangler deploy`).

**Debugging a data problem:** hit the Worker directly
(`curl -sD- https://phim.bluesia.net/api/home-data -o /dev/null | grep
x-catalog-cache` — `hit`/`miss` = normal; `stale-vps-down` = the live build
failed and D1's last-known-good copy is being served instead, worth
investigating why OPhim/TMDB itself is failing). `wrangler tail` shows
requests/responses/exceptions but **not** `console.log` output (verified —
don't rely on it for tracing logic; return debug info in the response body
instead). Remember `wrangler kv key list` / `d1 execute` / `r2 object`
commands need `--remote` to see real data — without it they read an empty
local simulation and make live resources look empty.

## Conventions & gotchas

- **CSS specificity + media-query source order bites here.** Media queries add
  *zero* specificity, so an override declared earlier loses to an equal-specificity
  rule declared later inside a `@media` block. When a responsive rule must win,
  raise its specificity (e.g. compound `.hero--detail.hero--has-thumb`) rather
  than relying on order.
- **Layout via flow, not stacked absolute anchors.** Independently
  absolute-positioning two elements (one to `top`, one to `bottom`) overlaps on
  short/landscape viewports. Prefer a flex flow so siblings can't collide.
- **Negative margins are load-bearing.** e.g. `.detail__episodes { margin-top }`
  tucks sections into hero dead-space. Changing hero spacing can break them —
  scope a reset with a marker class (`.detail--has-thumb`) instead of retuning
  magic numbers.
- UI copy is **Vietnamese**. Match it.
- OPhim list payloads come in two shapes — always route new list data through
  `normalizeListItem` before handing it to UI components.
