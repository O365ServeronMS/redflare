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

**README.md is the maintained reference** for architecture, API contract,
schema, Workflows, ops routes, cache layers, and the AI-agent rules
("🤖 Luật dành cho AI agent"). Read the relevant README section before
backend work. This file only carries what an agent needs on every task.

## What this is

`film.bluesia.net`, a Vietnamese movie-streaming site, runs entirely on
Cloudflare. Per ADR-0002 (`docs/adr/0002-no-vps-ssr-architecture.md`):

- **Frontend:** a vanilla JS SPA (`src/`, no framework, built by Vite into
  `dist/`), served as Static Assets with the SPA fallback. Playback uses
  `hls.js` + `artplayer`.
- **Backend:** a Hono + TypeScript Worker (`src-ssr/index.ts`). It handles
  `/api/*`, sitemap/robots, and the `/__sync/*` ops routes.
- **Storage:** **D1 only** (`redflare-db`). There is no KV and no R2.
- **Data freshness:** 5 Cloudflare Workflows (`src-ssr/workflows/`) keep the
  catalog up to date from KKPhim/phimapi and TMDB. User requests only ever
  read D1.
- **Images:** hotlinked from `image.tmdb.org` and `phimimg.com`, never
  mirrored.

**History:** the VPS `catalog-api`, `worker/`, KV, R2 mirroring, wsrv.nl and
`img.bluesia.net` are all retired. Anything in old commits or `docs/plan-*`
that mentions them is history; don't recreate it.

## Commands

Node **26** (`.nvmrc`).

| Command | What it does |
|---|---|
| `npm run dev` | Vite on `:3000`; `/api/*` is proxied to the **live production Worker**. |
| `npm run build` | Builds the SPA into `dist/`. |
| `npm start` | `wrangler dev --remote`: the real Worker with **real remote bindings**. Needs a build first. Other `wrangler kv/d1` commands also need `--remote`. |
| `npm run worker:typecheck` | Type-checks the Worker. |
| `npm test` | Runs the full gate (`scripts/rf-test.mjs all`): every `test:*` script, typecheck, build, `wrangler deploy --dry-run`, `git diff --check`. |
| `npm run db:migrate` | Applies `migrations/*.sql` to **production** D1. Never run by any build step. |

**Deploy = `git push origin main`** (Cloudflare Workers Builds). Never run
`wrangler deploy` by hand. Confirm before committing/pushing unless told
otherwise. `wrangler.toml` pins the custom domain (`routes`,
`custom_domain = true`) on purpose; don't remove it.

## Automation (`.claude/`, `scripts/`)

Tuned for low token use: shell scripts do the work, and agents/skills only
summarize the output.

| Name | Model | Purpose |
|---|---|---|
| agent `rf-ops` | haiku | Read-only production probe (`scripts/rf-status.sh`) |
| agent `rf-test` | haiku | Test gate (`scripts/rf-test.mjs changed\|all`); reports failures only |
| `/rf-deploy [redeploy] [-y]` | sonnet/low | Runs the gate, pushes to main, waits for the build, smoke-tests (`scripts/rf-wait-deploy.sh`) |
| `/rf-kick <target>` | haiku | `purge`, `hero`, or a Workflow trigger (`scripts/rf-kick.sh`, which needs `--force` for sync jobs) |

The scripts read `CRON_KEY` from the environment or from
`~/.config/redflare/cron_key`.

**Free-plan D1 budget:** 5M rows read/day. Once that's exceeded, D1 rejects
every query until 00:00 UTC. Before triggering sync jobs or adding queries,
see `docs/plan-incremental-sync-stall.md`. D1 also caps each query at 100
bound parameters.

## Caching

Only one layer applies: **Workers Caching** (`[cache] enabled = true`), a
cache owned by the Worker, not the zone CDN. The policy lives in
`src-ssr/cache/control.ts`:
`public, max-age=60, stale-while-revalidate=86400, stale-if-error=604800`.

- **No `s-maxage`.** It implies `proxy-revalidate`, which disables SWR/SIE.
- **Invalidation happens at deploy time.** The Worker version is part of the
  cache key (`cross_version_cache = false`). The reasons are in
  `wrangler.toml`.
- **To purge now,** use `GET /__sync/purge-cache` (or `/rf-kick purge`). The
  dashboard's "Purge Everything" does **not** affect Workers Caching.
- **Never cached:** `/api/search` (`applyNoStore`, because Turnstile tokens are
  single-use) and `/__sync/*`.

## Frontend architecture

- `src/main.js` is the entry point: it mounts the global UI and has one
  render function per route. `src/router.js` is a History API router; a
  handler may return a cleanup function (sync or Promise), which runs on
  navigation.
- `src/api/ophim.js` is the **only** network module, and it calls same-origin
  `/api`. Route list data through `normalizeListItem` before it reaches UI
  components.
- `src/modules/<Name>/<Name>.js` modules export `renderX(container, …)` and
  build DOM imperatively. Read [`MODULES.md`](MODULES.md) before adding or
  renaming one; its backend map is outdated. `src/components/MovieDetail.js`
  is legacy and page-level.
- `src/lib/`:
  - `image.js` — image policy
  - `lazyMount.js`
  - `mediaSession.js` — iOS lock-screen `title` = `"<tên phim> - <tập>"`,
    `artist` = `Film Bluesia`, w500 poster; keep the title short
  - `movieTitle.js`
- CSS lives in `src/styles/` (`variables.css`, `global.css`, `components.css`)
  and uses BEM-ish class names. `docs/DESIGN.md` and the tokens are reference
  only.

## Lazy loading

- **Every `<img>` goes through `applyImagePolicy(img, { priority })`**
  (`src/lib/image.js`). The default is `lazy` + `decoding="async"`;
  `priority` means `eager` + `fetchPriority="high"`, for LCP candidates only:
  - `PosterCard(priority)`
  - `Carousel` `priorityCount` (Home's first rail = 3)
  - `Grid`: the first 6 cards
  - `.detail__thumb`: always priority
- **HeroSlider uses CSS backgrounds.** `ensureBackdrop()` loads only the
  active slide plus one neighbour; don't revert to loading all 20.
  `renderHomePage` injects a `<link rel="preload">` for the first backdrop.
- **Below-fold sections with a network or image cost go through
  `mountWhenVisible`** (`src/lib/lazyMount.js`, `rootMargin: 600px`). This
  covers Home rails 3–4 and Recommendation. Always wire the returned
  disconnect into the page cleanup. Don't lazy-mount cheap sections like
  Footer.
- **`index.html` preconnects to the real image origins**
  (`image.tmdb.org`, `phimimg.com`).

## Conventions & gotchas

- **Responsive TMDB portrait images (mandatory).** Use the `<picture>` policy
  in `src/lib/image.js`; no hand-rolled `srcset` or viewport checks.
  - `max-width: 768px`: Hero rail `w154`, PosterCard `w185`.
  - `min-width: 769px`: Hero rail `w185`, PosterCard `w500`.
  - Only `image.tmdb.org/t/p/w154|w185|w500` poster URLs get variants.
    phimimg URLs and the backdrop contracts (w500 mobile / w1280 desktop)
    pass through unchanged.
  - This is browser-only policy: never change D1/API canonical URLs, and
    never backfill for a display-size change.
  - If a desktop `<source>` fails, remove it before assigning the fallback.
- **KKPhim `modified.time` is +07 but labelled `Z`.** Compare it by
  equality, never by ordering.
- **Media queries add zero specificity.** To make a responsive override
  win, raise its specificity (e.g. `.hero--detail.hero--has-thumb`); don't
  rely on source order.
- **Lay out via flex flow, not stacked absolute `top`/`bottom` anchors.**
  Anchored elements collide on short or landscape viewports.
- **Negative margins are load-bearing** (e.g. `.detail__episodes`). Scope
  resets with a marker class (`.detail--has-thumb`) instead of retuning
  them.
- **UI copy is Vietnamese.**
- **Design invariants and "don't break" rules** (no framework, no hash
  routing, no `public/_redirects`, pagination, overlays, and so on) are
  listed in README → "🤖 Luật dành cho AI agent".
