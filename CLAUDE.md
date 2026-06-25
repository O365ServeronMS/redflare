# CLAUDE.md — film-bluesia-red

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
(no framework), built with Vite, served from a Cloudflare Worker that also acts
as an edge API/cache in front of the OPhim catalog API. `hls.js` handles playback.

There are **no tests** and **no TypeScript**. Plain ES modules + imperative DOM.

## Stack & commands

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server (frontend only, hits deployed `/api/*`) |
| `npm start` | `wrangler dev` — runs the Worker + assets locally |
| `npm run build` | Vite build → `dist/` |

**Deploy = `git push origin main`** (Cloudflare auto-deploys). Confirm before
committing/pushing unless told otherwise.

## Architecture

- **`src/main.js`** — entry point. Mounts global UI (Header, Search), wires the
  router, defines one async page-render function per route.
- **`src/router.js`** — History API SPA router. `:param` patterns. A handler may
  return a cleanup fn (sync or a Promise resolving to one); the router calls it
  on navigation. Internal `<a href="/...">` clicks are intercepted globally.
- **`src/api/ophim.js`** — OPhim client. Exports `getMovieDetail`, list fetchers,
  `posterUrl`/`thumbUrl` (CDN: `img.ophim.live`), and `normalizeListItem`
  (smooths over the differing shapes of OPhim's `/api/list` vs `/v1/api/*`).
- **`src/components/*.js`** — each exports `renderX(container, ...)` that builds
  DOM imperatively and appends it. No virtual DOM, no templating lib.
- **`src/styles/`** — `variables.css` (CSS custom props), `global.css`,
  `components.css` (the bulk). Class naming is BEM-ish:
  `block__element--modifier`.
- **`worker.js`** — edge API + the hero-ranking algorithm. **`trending.js`** —
  TMDB trending refresh (needs `TMDB_API_TOKEN` env binding).

## Data flow & caching (important)

Two distinct cache layers — know which one backs the page you're touching:

1. **Home page** → `GET /api/home-data` → Worker → **KV** (`MOVIES_KV`,
   id `10670a45ffa54b21bbb40cecc47ae1c5`). Stale-while-revalidate, 30-min TTL.
   The payload key is **`CACHE_KEY` in `worker.js`** (currently `home_data_v4`).
   - To force a refresh: bump `CACHE_KEY` (e.g. `_v4` → `_v5`) and push — this is
     the normal invalidation path. Old keys expire on their own.
   - Or purge directly:
     `npx wrangler kv key delete --remote --namespace-id=10670a45ffa54b21bbb40cecc47ae1c5 home_data_v4`
     (`--remote` is required — without it wrangler hits the local store).
2. **List / genre / country** → `/api/list`, `/api/genre`, `/api/country` →
   Worker proxy → OPhim, cached in the **Cloudflare Cache API** (`caches.default`,
   per-PoP, no KV quota).
3. **Movie detail** (`/phim/:slug`) → frontend calls OPhim **directly**
   (`getMovieDetail`). **Not** KV-cached — detail-only changes never need a purge.

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
