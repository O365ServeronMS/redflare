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
are served from **R2** (`img.bluesia.net`), mirrored there by the
Worker itself — see "Data flow & caching" below.

**This used to run differently, twice over.** Through 2026-08-01 the Worker
was a thin KV cache-aside shim in front of a VPS Node service (`catalog-api`,
at `img.bluesia.net/api/*` — **the same hostname R2 uses today, a different
thing**; see the callout below) that did all the real work; the VPS also
mirrored images into R2 and ran Valkey as its own cache. That VPS backend
(`bluefilm-backend`) was migrated onto the Worker in phases and the VPS
stack was fully retired 2026-08-01 — see
[`bluesiaOM/context/state-redflare-cf-worker.md`](../bluesiaOM/context/state-redflare-cf-worker.md)
for the phase-by-phase history and the gotchas hit along the way (D1's
100-bound-param cap, a Worker `fetch()`-ing its own Custom Domain always
returning 522, etc). The retired VPS source is archived, not deleted, at
`github.com/O365ServeronMS/bluefilm-backend` — it's the reference if the
enrichment/ranking logic ever needs cross-checking.

Separately, images themselves moved domain later that same day: R2 originally
served artwork at `redflarer2.bluesia.net`; a 2026-08-04 migration moved it to
`img.bluesia.net` — the exact hostname the retired VPS used to own, now
reused for something unrelated (R2 image serving, not a catalog API). Don't
confuse the two: if you're reading old commit history or archived docs and see
`img.bluesia.net`, check the date — before 2026-08-04 it means the VPS;
2026-08-04 onward it means the R2 bucket.

There are **no tests**, **no TypeScript**, and **no linter/CI**. Plain ES modules
+ imperative DOM.

## Stack & commands

Node **26** (pinned in `.nvmrc` — Cloudflare's build image reads it too).

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server on `:3000`. Default loop. `src/api/ophim.js` calls same-origin `/api/*`; `vite.config.js`'s `server.proxy` forwards that straight to the **live production Worker** at `phim.bluesia.net/api/*` (the Worker is the only backend now — there is no local backend to run instead). |
| `npm run build` | Vite build → `dist/` |
| `npm run preview` | Vite's own static preview of `dist/` (no SPA fallback, no Worker — but `preview.proxy` forwards `/api/*` to the live production Worker same as `dev`) |
| `npm start` | `wrangler dev --remote` — runs the **actual Worker** (`worker/index.js`) with **real bindings** (KV/D1/R2/service binding), serving `dist/` through the asset layer. `--remote` is in the npm script on purpose — plain `wrangler dev` uses local simulated bindings that are empty/stale and will not reproduce real cache/D1/R2 behavior (see "Platform gotchas" — `wrangler kv/r2/d1` commands need `--remote` too, for the same reason). Use this to verify `not_found_handling = "single-page-application"` (deep link like `/phim/<slug>` reloads correctly) **and** to test the Worker's own builders (`worker/lib/*`) and Cache API / D1 fallback behavior. Requires `npm run build` first. |

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
  Caveat: its "Axis C — Service modules" table still describes `catalog-api`
  on the VPS (Valkey cache namespaces, `sign.js`), i.e. the pre-2026-08-01
  world. The naming convention in that doc is current; its backend map is not.
- **`src/components/MovieDetail.js`** — the last legacy resident; it is
  page-level, so it moves to `pages/DetailPage.js` in the planned `pages/` step,
  not into `modules/`.
- **`src/lib/`** — shared helpers, no DOM ownership of their own: `image.js`
  and `lazyMount.js` (see "Lazy loading" below) plus `mediaSession.js`
  (Media Session API metadata, called from `Player.js` — puts **tên phim +
  tập và ảnh poster lên màn hình khoá iPhone**: `title` = `"<tên phim> -
  <tập>"`, `artist` = `Film Bluesia`, `artwork` = the w500 poster. Without
  it iOS falls back to `document.title` + favicon. Keep the title short —
  it's the only line iOS reliably shows).
- **`migrations/`** — the D1 schema: `0001_stale.sql`, `0002_recs_idx_mirror.sql`,
  `0003_popularity.sql`. Source of truth for the 6 tables described under
  "Caching layers" #4. Not applied automatically by any build step —
  `wrangler d1 migrations apply redflare-db --remote` by hand.
- **`src/styles/`** — `variables.css` (CSS custom props), `global.css`,
  `components.css` (the bulk, still monolithic). Class naming is BEM-ish:
  `block__element--modifier`.
- **`docs/DESIGN.md` + `docs/tokens.json` + `docs/theme.css`** — the
  Netflix-style design reference the tokens in `variables.css` derive from.
  Reference only, not built or imported.
- **`catalog-api`** (retired 2026-08-01) — used to be a separate Node service
  on the VPS doing everything `worker/lib/*` does now (OPhim proxying, hero
  ranking, TMDB enrichment, R2 mirroring, Valkey cache), served at
  `img.bluesia.net/api/*` (VPS-era meaning of that hostname — see the callout
  in "What this is"; today `img.bluesia.net` is the R2 image host and has no
  `/api/*` route at all). Fully ported to the Worker across Phases 3–6 of
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
- **Images** — `img.bluesia.net` (R2), never proxied through the
  Worker at read time. Served from that domain since a 2026-08-04 migration
  off the original `redflarer2.bluesia.net` (a hard cutover, not a gradual
  soak — see "Images: 2026-08-04 domain + key-shape migration" below for what
  that entailed). The Worker mirrors TMDB/OPhim artwork into R2 itself
  (`worker/lib/mirror.js`): every build enqueues new image URLs into a D1
  queue (`mirror_queue`), and a cron every 10 minutes drains up to 20 at a
  time — `env.BUCKET.head()` to skip ones already mirrored, otherwise fetch
  upstream and `env.BUCKET.put(key, res.body)` streamed straight through (no
  in-JS hashing). **No lifecycle expiry rule on the bucket** — objects don't
  expire on their own once mirrored (an earlier version of this doc claimed a
  150-day TMDB cache-duration expiry; that was never actually configured on
  the bucket — corrected 2026-08-01).

  **Every mirrored image is WebP, TMDB and OPhim alike, sourced from
  wsrv.nl (since 2026-08-06).** Earlier this relied on `image.tmdb.org`'s
  content negotiation (`Accept: image/webp`) — but TMDB sends **no `Vary:
  Accept`**, so a JPEG cached anywhere in front of it could be handed back
  regardless of the header. That made the `.webp` key an unreliable promise:
  measured 2026-08-06, ~1.7% of already-mirrored objects silently held JPEG
  bytes under a `.webp` key (browsers render by content-type, not extension,
  so nothing looked broken until you checked). wsrv.nl
  (`worker/lib/mirror.js` `wsrvWebpUrl()`, open source, BSD-3-Clause,
  self-hostable — https://wsrv.nl) makes format a property of the URL
  (`&output=webp&q=75`) instead of a negotiated header, so it can't disagree
  with itself. **Invariant, no exceptions: a key ending `.webp` holds WebP
  bytes, or the row stays queued** — there is no fallback path that saves
  something else under that key anymore (the old `WEBP_GRACE_MS` grace
  window / `mirrored-nonwebp` outcome are gone as of the same date; a
  non-WebP response from wsrv.nl is always `retry`, never saved).
  `WSRV_ENABLED` in `mirror.js` is a rollback flag — flip to `false` and
  deploy to fall back to fetching origins directly, no data migration
  needed.

  wsrv.nl also does the RESIZE in the same pass via `&w=<width>&we`
  (`&we` = without-enlargement, load-bearing: without it wsrv.nl upscales
  past native resolution by default when `&w=` exceeds it, which came out
  *larger* than the old Cloudflare-transform output for OPhim's often-small
  landscape "poster" images — with it, smaller in every sample tested,
  TMDB and OPhim alike). TMDB URLs pass no `&w=` — their own path already
  encodes size (`/t/p/w500/`, `/t/p/w1280/`). **OPhim URLs always pass a
  width**, because OPhim has no TMDB-style size variants of its own — one
  URL, one native resolution (sometimes several MB) — so sizing has to
  happen somewhere, and it now happens once, at mirror time, instead of on
  every request the way a Cloudflare Image Transformation used to.

  A 4xx/5xx from wsrv.nl doesn't mean the image is gone — `isUpstreamDead()`
  checks the real origin (TMDB/OPhim) directly before a queue row is ever
  deleted, so a wsrv.nl hiccup retries instead of wrongly giving up on a
  still-live image.

  R2 keys **swap** the extension — `t/p/w500/<hash>.jpg` →
  `t/p/w500/<hash>.webp`, and for OPhim additionally gain a `w<width>/`
  segment ahead of the path — `ophim/uploads/movies/<name>.jpg` →
  `ophim/w500/uploads/movies/<name>.webp` (`objectKeyFor` in
  `worker/lib/images.js`; width is baked into the key precisely so
  `drainMirrorQueue` can recover it at mirror time without a D1 schema
  change — TMDB keys need no such segment). The inverse
  (`upstreamForKey` in `worker/lib/images.js`, `upstreamFallback` in
  `src/api/ophim.js`) reconstructs the original URL by swapping `.webp`
  back to `.jpg` (source images are confirmed always `.jpg`, both hosts)
  and, for OPhim, additionally stripping the `w<width>/` bookkeeping
  segment — that segment isn't part of the real upstream path. These
  functions are a load-bearing contract, keep them in lockstep;
  `webpKeyFor()`/`r2ImageUrl()` are idempotent on a key that's already
  `.webp`.

  Every `w500` TMDB poster (`thumb_url`) also gets a `w154` sibling mirrored
  alongside it (`worker/lib/images.js` `addW154Sibling`) — the hero rail
  (`HeroSlider.js`) renders at 42px/30px wide and would otherwise load a
  500px poster into a slot 12-16x smaller than the image. OPhim doesn't get
  a `w154` variant (not in scope — the hero rail rarely shows OPhim-only
  artwork, since TMDB owns `poster_url`/`thumb_url` whenever it has a match).

  **`posterUrl`/`thumbUrl` in `src/api/ophim.js` are now pure passthroughs**
  for both hosts. Before 2026-08-06 they wrapped OPhim R2 URLs in a
  same-zone Cloudflare Image Transformation
  (`phim.bluesia.net/cdn-cgi/image/width=...,format=auto/<r2-url>`) at
  serve time — the only way to resize OPhim art, since Image
  Transformations only accept same-zone sources (a transform request with
  `image.tmdb.org` or `img.ophim.live` as the source 403s). Resizing moved
  to mirror time (wsrv.nl `&w=`, above), so the R2 object is already the
  right size and there's nothing left to wrap. **This project no longer
  uses Cloudflare Image Transformations at all** — freed intentionally, not
  because of quota pressure (usage was ~2% of the 5,000/month free tier
  when this was decided), to reserve the feature for something else later.

  If a mirror hasn't landed yet (or R2 is somehow unreachable) the
  frontend's `<img onerror>` handler rebuilds the original TMDB/OPhim URL
  from the R2 URL and retries it directly — see
  `upstreamFallback`/`attachImageFallback` in `src/api/ophim.js`. This
  fallback goes straight to the real origin, never through wsrv.nl —
  wsrv.nl is a mirror-time-only dependency, kept out of the request path a
  real user's browser ever waits on.

  **Images: 2026-08-04 domain + key-shape migration.** Moved image serving
  from `redflarer2.bluesia.net` to `img.bluesia.net` in one hard cutover (no
  dual-domain soak period — R2 lets one bucket answer multiple custom
  domains, but the old domain was retired the same day rather than kept
  around, since every reader/writer of the URL lives in this repo's own code
  and the client-side upstream fallback covers any gap). Bundled into the
  same deploy: finished a key-shape migration that had stalled partway
  (`t/p/w500/<hash>.jpg.webp`, an appended suffix from an earlier WebP
  rollout, swapped to `t/p/w500/<hash>.webp`) since a hard cutover was the
  only point where redoing that swap was free. Rollout was: repoint
  `R2_PUBLIC_BASE`/`R2_BASE` and swap `webpKeyFor`/`upstreamForKey`, deploy,
  then re-mirror every object under the new host+shape (queued directly from
  D1 `mirrored`, drained via repeated `/__cron/mirror` calls rather than
  waiting for the 10-min cron), then purge caches that had baked in the old
  URL — **including D1 `idx`**, easy to miss: it stores each item's full
  mapped JSON (not just IDs), so recommendation responses kept serving the
  old domain until `idx` itself was cleared, even after Cache API and D1
  `recs` were purged. Finished by GC-ing the ~2,300 old-shape R2 objects
  (temporary `/__cron/gc-old-keys` route, removed once drained).

  One thing that migration got wrong and had to come back and fix: the
  pre-deploy **Cache API** entries were left to expire on the assumption they
  would rebuild once someone opened the title. They don't — see "Caching
  layers" #2. Recommendations kept serving `redflarer2` URLs against a host
  whose DNS was already gone, so every image in them silently fell through to
  `attachImageFallback`'s TMDB origin (visibly fine, just unmirrored and
  un-WebP'd). The takeaway for any future change to how image URLs are built:
  **Purge Everything on the Cloudflare dashboard as part of that deploy** —
  the Cache API entries will not fix themselves. See "Caching layers" #2.

  **2026-08-06 wsrv.nl migration.** Full rationale, every number measured,
  and the phased rollout: `bluesiaOM/context/plan-redflare-webp-wsrv.md` +
  `context/state-redflare-webp-wsrv.md` (progress/decisions log). Unlike the
  2026-08-04 domain migration, **R2 keys for TMDB didn't change** (same
  `.webp` suffix, same host) — only *how* the bytes get there changed, so no
  re-mirror, no Cache API purge was strictly required for TMDB. OPhim keys
  DID change shape (gained the `w<width>/` segment above), so the ~38
  pre-existing OPhim objects were deleted from R2 + D1 `mirrored` outright
  (not re-mirrored under the old shape — new builds compute the new key from
  scratch; the client-side fallback covers the gap in between). Also cleaned
  up ~53 TMDB objects left over from the old grace-window bug (JPEG bytes
  under a `.webp` key) the same way. **Rollback**, if wsrv.nl ever needs to
  be pulled out: set `WSRV_ENABLED = false` in `worker/lib/mirror.js` and
  deploy — TMDB reverts to direct-fetch (content negotiation, no grace
  window to reinstate — non-WebP responses just retry forever, which is a
  regression but not a silent one, `RedflareMirrorStuck` on
  `monitor.bluesia.net` will fire). OPhim reverts to plain-JPEG raw mirrors
  the same way, but note `posterUrl`/`thumbUrl` no longer apply a
  Cloudflare Image Transformation — a rollback that also needs images
  resized again would have to reinstate that serve-time wrapper, not just
  flip the flag.

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

   **A hit returns before the builder runs — so a wrong entry never
   self-heals by being visited.** It survives until its own TTL expires (up
   to 30 days for a `full`-tier recommendation), no matter how much traffic
   it gets. This matters because cached bodies embed **absolute image URLs**:
   anything that changes those URLs makes every pre-existing entry wrong, not
   merely stale. **Clearing them is a manual Cloudflare-dashboard step:**
   Caching → Purge Everything on the `bluesia.net` zone. `caches.default` is
   the same zone cache the CDN uses, so a dashboard purge does drop these
   entries; the Cache API key here is the plain request URL
   (`worker/index.js` `handleApi`), so purge-by-URL matches too. In-code
   `cache.delete()` (the `/__cron/purge-recs` route) only evicts in the colo
   that served the purge request — fine for spot-fixing one title, useless
   for a fleet-wide URL change. A `CACHE_VERSION` key-versioning scheme
   (`<url>?__v=N`) was tried for this and reverted (`a4826f7`) as redundant
   with the dashboard purge.
3. **KV** (`CATALOG_KV`) — one key (`home:current`, plus TTL'd
   `trending:week`/`trending:day`) written only by the hourly cron, never
   per-request; `page:v1:*` (12 keys, popularity-ranked warm set,
   `worker/lib/warm.js`) + `warm:last-run` metadata written every `*/30`;
   and **several thousand** `meta:*` TMDB-enrichment entries (14-day TTL,
   `worker/lib/enrich.js`) — measured 2026-08-06: **2,262 and still growing**,
   not the ~111 an earlier version of this doc assumed (that number was never
   re-measured after the catalog grew; corrected here since it fed
   `docs/adr/0001-caching-topology.md`'s KV-write-budget arithmetic, which
   should be re-derived from the real count before adding anything else to
   the warm set — see `docs/plan-hit-rate.md` Phase 4/8). `/api/home-data`
   reads `home:current` directly — no build happens on that request path at
   all, see below.
4. **D1** (`redflare-db`) — 6 tables, all live: `stale` (last-known-good copy
   per path for list/genre/country/movie/recommendation, upserted on every
   successful build — this is what would get served if OPhim/TMDB itself were
   ever unreachable, `x-catalog-cache: stale-vps-down` despite the header name
   predating the VPS's retirement); `idx` (reverse index, OPhim item keyed by
   `tmdb.id`+media type, built by the hourly-shard cron + on-demand during
   detail/recommendation builds — this is what makes recommendation matching
   possible without a full OPhim search); `recs` (TMDB recommendation
   results, TTL by **result completeness**, not just presence — see
   "Recommendation cache TTL" below); `mirrored` + `mirror_queue` (R2
   image-mirror bookkeeping, see "Images" above); `popularity` (sampled
   request counts per canonical `/api/list|genre|country` cache key —
   `worker/index.js` `trackPopularity`, drives which pages `worker/lib/warm.js`
   keeps warm, see `docs/plan-hit-rate.md` Phase 4).
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
`fetch()`; a Worker fetching its own Custom Domain 522s by default, a
documented Cloudflare behavior), concatenates the resulting JSON without
reparsing, and writes one KV key. The request path only ever reads that key.

**Nuance added 2026-08-06:** that 522 is the *default*, not an absolute.
`wrangler.toml` now sets the `global_fetch_strictly_public` compatibility
flag, under which a global `fetch()` to this Worker's own zone loops back
through Cloudflare's front door and succeeds. That is deliberately **not**
how the shard fan-out works and must not be changed to it — service bindings
skip the public network entirely and are unaffected by the flag, which is
what keeps the fan-out cheap and loop-free. The flag exists for exactly one
job: edge-warming (`worker/lib/warm.js` `runEdgeWarm`), where going through
the front door is the whole point, because that is what populates the zone
edge cache. See `docs/plan-hit-rate.md` §6.5.1.

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
purge the Cache API entry from the Cloudflare dashboard (Caching → Purge
Everything, or purge-by-URL — the key is the plain request URL), use a
cache-busting query param, or just let the next distinct request rebuild it
(Cache API misses are cheap, there's no upstream to protect anymore). Recommendation has its own purge
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

## Lazy loading (images + below-fold sections)

Two shared helpers make this consistent app-wide — route every new image and
every new below-fold section through them rather than setting `loading`/
`decoding`/`IntersectionObserver` ad hoc per module.

- **`src/lib/image.js`** — `applyImagePolicy(img, { priority })`. Every
  `<img>` in the app goes through this: `lazy` + `decoding="async"` by
  default, `eager` + `fetchPriority="high"` only when `priority: true` (the
  image is the page's LCP candidate — above the fold on first paint).
  - `PosterCard.js` takes a `priority` param; `Carousel.js` takes a
    `priorityCount` (marks the first N cards); `Grid.js` marks its first 6
    cards priority (covers the widest desktop row). Home's first carousel
    ("Phim Mới Cập Nhật") gets `priorityCount: 3`; the detail page's
    `.detail__thumb` is always `priority: true` (it *is* the LCP element on
    `/phim/:slug`). Everything else — rail thumbs past index 0, search
    overlay results, recommendation cards — stays default (lazy).
  - **HeroSlider is the one exception, not `<img>`-based.** Its 20 backdrops
    are CSS `background-image`, so they can't use `loading="lazy"` at all —
    instead `ensureBackdrop()` only ever loads the active slide + one
    idle-prefetched neighbor; `goToSlide()` loads the new active + its next
    neighbor on demand as the user rotates through. Don't revert this to
    "set backdrop for all slides on mount" — that was firing ~20 full-size
    image requests on every home page load.
  - The hero's first backdrop is also the page's actual LCP element, so
    `renderHomePage` (`src/main.js`) additionally injects a dynamic
    `<link rel="preload" as="image" fetchpriority="high">` for it as soon as
    `/api/home-data` resolves (its URL isn't known until then, so it can't be
    a static tag in `index.html`).
- **`src/lib/lazyMount.js`** — `mountWhenVisible(placeholder, renderFn)`.
  IntersectionObserver-backed, self-disconnecting, `rootMargin: 600px`. Used
  for sections that are reliably below the fold, to defer both DOM
  construction and (where relevant) the network request that section makes:
  home's 3rd/4th carousel rows (Phim Lẻ, Phim Bộ), and the detail page's
  Recommendation block (`Recommendation.js`'s `/api/recommendation/*` fetch
  previously fired unconditionally on every detail-page load regardless of
  scroll position — now it only fires once the block nears the viewport).
  Returns a disconnect fn — always wire it into the page handler's cleanup
  (see `renderHomePage`'s returned cleanup, `renderDetailPage` awaiting
  `renderMovieDetail`'s returned cleanup) so navigating away before the
  section ever became visible doesn't leave an observer watching a detached
  node.
- Don't lazy-mount cheap, no-network sections (e.g. `Footer`) — the
  IntersectionObserver/cleanup bookkeeping isn't worth it for a section with
  no image/network payload.
- `index.html`'s `<link rel="preconnect">` must point at the actual image
  origin, `https://img.bluesia.net` — get this wrong (e.g. pointing at a
  retired host) and it silently does nothing useful, no error either way.

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
