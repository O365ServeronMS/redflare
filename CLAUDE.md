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
(no Worker)**. All catalog data (home/list/genre/country/detail) is fetched from
the **VPS `catalog-api`** at `img.bluesia.net/api/*`, which proxies the OPhim
catalog API, HMAC-signs image URLs, and caches in Valkey. `hls.js` handles playback.

There are **no tests** and **no TypeScript**. Plain ES modules + imperative DOM.

## Stack & commands

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server (frontend only, hits deployed `/api/*`) |
| `npm start` | `wrangler dev` — serves the built assets locally (no Worker) |
| `npm run build` | Vite build → `dist/` |

**Deploy = `git push origin main`** (Cloudflare auto-deploys). Confirm before
committing/pushing unless told otherwise.

## Architecture

- **`src/main.js`** — entry point. Mounts global UI (Header, Search), wires the
  router, defines one async page-render function per route.
- **`src/router.js`** — History API SPA router. `:param` patterns. A handler may
  return a cleanup fn (sync or a Promise resolving to one); the router calls it
  on navigation. Internal `<a href="/...">` clicks are intercepted globally.
- **`src/api/ophim.js`** — catalog client. Exports `getHomeData`, `getMovieDetail`,
  list fetchers (all hitting `CATALOG_BASE` = `img.bluesia.net/api/*`),
  `posterUrl`/`thumbUrl` (now pass-throughs — URLs arrive pre-signed), and
  `normalizeListItem` (smooths over OPhim's `/api/list` vs `/v1/api/*` shapes).
- **`src/components/*.js`** — each exports `renderX(container, ...)` that builds
  DOM imperatively and appends it. No virtual DOM, no templating lib.
- **`src/styles/`** — `variables.css` (CSS custom props), `global.css`,
  `components.css` (the bulk). Class naming is BEM-ish:
  `block__element--modifier`.
- **`catalog-api`** (separate VPS service, *not* in this repo) — proxies OPhim,
  HMAC-signs images, runs the hero-ranking algorithm + TMDB trending, caches in
  Valkey. Served at `img.bluesia.net/api/*`. This is where `worker.js` and
  `trending.js` logic moved to.

## Data flow & caching (important)

All catalog data flows through the **VPS `catalog-api`** (`img.bluesia.net/api/*`),
which proxies OPhim, signs images, and caches in **Valkey**. The frontend never
touches OPhim or a Cloudflare Worker for data.

1. **Home page** → `GET img.bluesia.net/api/home-data`. Built by catalog-api
   (hero ranking + TMDB trending), kept warm by a background refresh (~20 min) and
   stored in Valkey under `catalog:c1:home`. To force a refresh: restart the
   `catalog-api` container, or `DEL catalog:c1:home` in Valkey.
2. **List / genre / country / detail** → `img.bluesia.net/api/{list,genre,country,movie}`.
   catalog-api caches each signed payload in Valkey (`catalog:c1:*`, 30-min lists /
   60-min detail). Bump `CACHE_NS` in catalog-api `server.js` to invalidate all.
3. **Why this shape:** the SPA bills a Cloudflare Worker request per data fetch.
   Moving catalog+signing to the VPS (which holds the HMAC secret and isn't
   quota-limited) keeps `phim.bluesia.net` a zero-Worker static deployment. See the
   `catalog-api` README on the VPS (`/srv/filmbluesia/catalog-api`).

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
