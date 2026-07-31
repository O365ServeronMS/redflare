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
(no framework), built with Vite, deployed to Cloudflare as **static assets only
— there is no Worker script in this repo** (`wrangler.toml` has no `main`, only
`[assets]`). Every request that needs CPU (catalog proxying, hero ranking, TMDB
trending, HMAC image signing, caching) is handled by the **VPS `catalog-api`** at
`img.bluesia.net/api/*`. `hls.js` + `artplayer` handle playback.

There are **no tests**, **no TypeScript**, and **no linter/CI**. Plain ES modules
+ imperative DOM.

## Stack & commands

Node **26** (pinned in `.nvmrc` — Cloudflare's build image reads it too).

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server on `:3000`. Default loop. Hits the **live** `img.bluesia.net/api/*` — there is no local backend, so the VPS must be up. |
| `npm run build` | Vite build → `dist/` |
| `npm run preview` | Vite's own static preview of `dist/` (no SPA fallback config) |
| `npm start` | `wrangler dev` — serves `dist/` through Cloudflare's asset layer. Use this (not `preview`) to verify `not_found_handling = "single-page-application"`, i.e. that a deep link like `/phim/<slug>` reloads correctly. Requires `npm run build` first. |

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
  fetch goes to `CATALOG_BASE` (= `img.bluesia.net`); nothing here calls OPhim
  directly. Also exports `posterUrl`/`thumbUrl` (pass-throughs — URLs arrive
  pre-signed) and `normalizeListItem` (smooths over OPhim's two list shapes).
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
- **`catalog-api`** (separate Node service on the VPS, *not* in this repo) —
  proxies OPhim, HMAC-signs images, runs the hero-ranking algorithm + TMDB
  trending/enrichment, caches in Valkey. Served at `img.bluesia.net/api/*`.
  Source: `/srv/filmbluesia/catalog-api`. The old `worker.js` and `trending.js`
  were deleted from this repo when that logic moved there (commit `81e498a`).

## Data flow & caching (important)

Every network call the SPA makes goes to **one origin**: `img.bluesia.net` (VPS
`catalog-api`) — data *and* images. Cloudflare only serves the static bundle; it
runs **zero** compute per request.

### Endpoints the frontend calls

All defined in `src/api/ophim.js`. Keep this table in sync when adding one.

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
TMDB supplies the metadata."* Not how it works. catalog-api fetches the **whole
OPhim record**, then **overrides a fixed set of fields** with TMDB
(`catalog-api/src/tmdb-enrich.js`). OPhim is the per-field fallback, so a title
that TMDB can't resolve still renders — just with OPhim values.

| Field | Owner | Notes |
|---|---|---|
| `name` | TMDB vi-VN title → OPhim | See readability rule below |
| `origin_name` | TMDB `original_title` → OPhim | Same rule; OPhim's is reliably English |
| `poster_url` | TMDB `w1280` backdrop → OPhim | Wide image. Signed after enrich |
| `thumb_url` | TMDB `w780` poster → OPhim | Portrait image |
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
2. **Valkey on the VPS** — `catalog:c1:*`. `home` is kept warm by a background
   refresh (~20 min); lists 30 min; detail 60 min; recommendations 30 days
   (`catalog:c1:related:*` + reverse index `catalog:c1:idx:*` — key names kept
   legacy on purpose, renaming would orphan a warm 30-day cache).
3. **Cloudflare** — assets only. Never caches `/api/*`, which is a different host.

**To force fresh data:** restart the `catalog-api` container (drops the warm home
build), `DEL catalog:c1:home` in Valkey for just the home page, or bump `CACHE_NS`
in catalog-api `server.js` to invalidate *everything* at once. Changing anything
in the enrichment table above needs more than that: the TMDB values are frozen in
`catalog:c1:meta:*` for 14 days, and *already-enriched* items sit inside
`catalog:c1:idx:*` (45 d) and `catalog:c1:related:*` (30 d) — purge those too or
stale titles keep resurfacing in "Bạn cũng có thể thích".

**Why this shape:** each SPA data fetch used to bill a Cloudflare Worker request.
Moving catalog + signing to the VPS — which holds the HMAC secret and isn't
quota-limited — keeps `phim.bluesia.net` a zero-Worker static deployment. Full
backend docs: the `catalog-api` README on the VPS (`/srv/filmbluesia/catalog-api`).

**Debugging a data problem:** hit the endpoint directly first
(`curl -s https://img.bluesia.net/api/home-data | head -c 400`). If that's stale
or broken, it's a VPS/Valkey problem, not a frontend one — nothing in this repo
can fix it.

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
