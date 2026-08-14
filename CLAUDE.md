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

## Data flow & caching (important) — corrected 2026-08-14

**Everything above this point through "Architecture" describes the retired
`worker/index.js` + `worker/lib/*` design (KV, R2 image mirroring, wsrv.nl,
the Cache API).** None of that exists in this checkout. ADR-0002
(`docs/adr/0002-no-vps-ssr-architecture.md`) replaced it: the backend is now
`src-ssr/` (Hono + TypeScript), storage is **D1 only** (no KV, no R2), and
images are hotlinked from TMDB/phimimg rather than mirrored. That ADR itself
says it "supersedes the SPA + JSON-API topology described in CLAUDE.md" —
the rest of this file was never updated to match. Treat any `worker/`,
KV-key, or R2/wsrv.nl reference above as historical, not current. **README.md
is the maintained, accurate reference for the current architecture, API
contract, ops routes, and cache layers** — read it, not the sections above,
for anything backend-related. This section replaces just the caching part.

### Caching layers, current

One layer for `/api/*`, `/sitemap*.xml`, and `/robots.txt`: **Workers
Caching**, enabled via `[cache] enabled = true` in `wrangler.toml` — this is
a cache *owned by the Worker itself*, not the zone's CDN cache. Policy is
set once in `src-ssr/cache/control.ts` (`applyPageCache`):
`public, max-age=60, stale-while-revalidate=86400, stale-if-error=604800`.
No `s-maxage` — deliberately: it implies `proxy-revalidate`, which disables
`stale-while-revalidate`/`stale-if-error` on the same response (this project
hit that bug once already, see the ADR and `docs/state-hit-rate.md`).

**Invalidation is deploy-time, not tag-based.** `cross_version_cache` is
left at its default (`false`), so the Worker version is part of the cache
key — every `git push origin main` starts every cached path from empty
automatically, at no cost. There is no per-title `Cache-Tag` purging: it was
built, then removed 2026-08-14 after finding the resolve pipeline could
issue up to ~300 purge calls in one tick, several times over the Free
plan's 5-requests/minute purge rate limit — and because `cache.purge()`
resolves `{success: false}` on rejection rather than throwing, those
rejected purges were silently being counted as done. A changed title now
just rides out `max-age=60` like everything else.

**`GET /__sync/purge-cache`** (`x-cron-key` header, see `routes/sync.ts`)
purges everything immediately, for when you don't want to wait for a
deploy. **The Cloudflare dashboard's zone-level "Purge Everything" does
NOT work for this** — Workers Caching is the Worker's own cache, and "no
zone-level purge (via the dashboard, API, or Terraform) affects Workers
Caching content" (Cloudflare docs, `/workers/cache/purge/`). That dashboard
button only ever worked back when this project cached via `caches.default`
(pre-ADR-0002); don't reach for it now, use the route above.

**If `cross_version_cache` ever needs to change** (e.g. to keep a warm
cache across deploys instead of relying on deploy-time invalidation): it
was evaluated and rejected in this same change — full reasoning is in the
`[cache]` block comment in `wrangler.toml`. Re-enabling it means adding
back a `version_metadata` binding and a way to purge one version's entries
on rollback (both were built and then removed alongside the tag machinery;
git history around 2026-08-14 has a working reference implementation if
this is ever revisited).

`/api/search` is the one uncacheable endpoint (`applyNoStore` — every
Turnstile token is single-use) and `/__sync/*` ops routes are always
`private, no-store`.

See README.md's "🛡️ Bảo mật và cache" section for the full cache-layer
table (including static asset / logo Cache-Control policy from
`public/_headers`, which this section doesn't repeat) and "🛠️ Vận hành"
for the full ops-route list.

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
- **Responsive TMDB portrait images (mandatory).** Use the shared
  `src/lib/image.js` `<picture>` policy; do not hand-roll `srcset` or
  viewport checks in components.
  - At `max-width: 768px`: Hero rail = `w154`; PosterCard = `w185`.
  - At `min-width: 769px`: Hero rail = `w185`; PosterCard = `w500`.
  - Apply variants only to `image.tmdb.org/t/p/w154|w185|w500` poster URLs.
    KKPhim/phimimg URLs and the existing `w500` mobile backdrop / `w1280`
    desktop backdrop contracts pass through unchanged.
  - This is browser-only presentation policy: keep D1/API/sync canonical
    URLs unchanged and never run a backfill for a display-size change.
  - If a desktop `<source>` fails, remove it before assigning the image fallback.

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
