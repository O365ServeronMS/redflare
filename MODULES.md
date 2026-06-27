# MODULES.md — module registry (redflare / phim.bluesia.net)

Source of truth for **module naming**. The goal is sysadmin-friendly management:
**one module name threads through every layer** (UI → API client → backend route →
cache namespace → CSS → docs), so `grep -ri <module>` finds *everything* about a
feature in one shot.

## Naming convention

1. **PascalCase, singular, English, one word** where possible: `HeroSlider`,
   `Recommendation`, `Single`, `Series`.
2. **Three axes, never mixed** — a module belongs to exactly one:
   - **Section** — a visual block rendered onto a page.
   - **Content-type** — a domain entity (maps 1:1 to OPhim's `type` enum).
   - **Service** — a backend (catalog-api) endpoint + cache namespace.
3. **Public URLs are NOT module names.** Routes (`/phim/...`,
   `/danh-sach/phim-le`, `/the-loai/...`) are SEO + OPhim-compat contracts and stay
   in Vietnamese. Module names are an internal layer, decoupled from URLs.

## One name, all layers (example: `Recommendation`)

| Layer | Artifact |
|---|---|
| UI component | `src/modules/Recommendation/Recommendation.js` |
| CSS | *(none yet — reuses `Carousel` styles; add `Recommendation.css` when it diverges)* |
| API client | `getRelatedMovies()` in `src/api/ophim.js` |
| Backend route | `GET /api/related/:type/:id` (catalog-api `server.js`) |
| Backend logic | `fetchTmdbRecommendations` / `matchOphimByTmdb` in `server.js` |
| Cache namespace | `catalog:c1:related:*` + reverse index `catalog:c1:idx:*` (Valkey, VPS) |

> The route/cache still use the legacy word `related`. When convenient, migrate to
> `/api/recommendation` + `catalog:c1:recommendation:*` using the **add-alias →
> switch → retire** pattern (never a big-bang rename — FE+BE deploy separately).

## Module catalog

### Axis A — Section modules (UI blocks)

All moved into `modules/<Name>/<Name>.js` ✅ (exports renamed to match the module name).

| Module | Location | Export | Role |
|---|---|---|---|
| `Header` | `modules/Header/Header.js` | `renderHeader` | Global nav |
| `HeroSlider` | `modules/HeroSlider/HeroSlider.js` | `renderHeroSlider` | Rotating hero banner |
| `Carousel` | `modules/Carousel/Carousel.js` | `renderCarousel` | Horizontal poster rail |
| `Recommendation` | `modules/Recommendation/Recommendation.js` | `renderRecommendation` | "Bạn cũng có thể thích" |
| `Grid` | `modules/Grid/Grid.js` | `renderGrid` | Paginated grid |
| `PosterCard` | `modules/PosterCard/PosterCard.js` | `renderPosterCard` | Single poster tile |
| `Player` | `modules/Player/Player.js` | `renderPlayer` | HLS player |
| `SearchOverlay` | `modules/SearchOverlay/SearchOverlay.js` | `renderSearchOverlay` | Search UI |
| `Skeleton` | `modules/Skeleton/Skeleton.js` | `createSkeleton*` | Loading placeholders |
| `Footer` | `modules/Footer/Footer.js` | `renderFooter` | Footer |

### Axis B — Content-type modules (maps 1:1 to OPhim `type`)

| Module | OPhim `type` | Public URL (unchanged) |
|---|---|---|
| `Single` | `single` | `/danh-sach/phim-le` |
| `Series` | `series` | `/danh-sach/phim-bo` |
| `Anime` | `hoathinh` | `/danh-sach/hoat-hinh` |
| `Show` | `tvshows` | `/danh-sach/tv-shows` |

`DetailPage` branches on `type` (single = direct play, series/anime/show = episode
list) — that branch is where `Single` vs `Series` behaviour lives.

### Axis C — Service modules (catalog-api on the VPS — see memory `reference_vps_catalog_api`)

| Module | Endpoint | Source |
|---|---|---|
| `HomeData` | `/api/home-data` | `home.js` |
| `Catalog` | `/api/list`, `/api/genre`, `/api/country` | `server.js` *(to split out)* |
| `Detail` | `/api/movie` | `server.js` *(to split out)* |
| `Recommendation` | `/api/related` (→ `/api/recommendation`) | `server.js` *(to split out)* |
| `ImageSign` | *(internal)* | `sign.js` |

## Folder layout (frontend, target)

```
src/
  modules/          # self-contained UI modules: <Name>/<Name>.js (+ <Name>.css)
    Recommendation/ # ✅ first resident
  pages/            # route compositions: HomePage, DetailPage, CatalogPage, SearchPage
  components/        # legacy — being migrated into modules/
  api/  router.js  main.js
  styles/           # variables.css + global.css (tokens + reset only; per-module CSS co-locates)
```

Each module owns its JS **and** CSS in one folder, so editing e.g. `HeroSlider`
touches a single directory — important given the CSS-specificity gotchas in
`CLAUDE.md`.

## Migration status & next steps

- [x] `Recommendation` extracted from `MovieDetail.js` → `modules/Recommendation/` (pattern proof)
- [x] Move all Section modules `components/*` → `modules/<Name>/` + rename files & exports to convention
- [ ] Extract page functions from `main.js` → `pages/` (this also moves the last resident, `components/MovieDetail.js`, → `pages/DetailPage.js`)
- [ ] Split monolithic `styles/components.css` per module (co-locate) — higher risk (CSS specificity / source order)
- [ ] Split `catalog-api/server.js` into service modules + add `/api/recommendation` alias

> `components/MovieDetail.js` intentionally stays put for now — it is page-level
> (the detail page), so it migrates with the `pages/` step, not the Section move.

Do these incrementally (one module per PR). Do **not** build a runtime
config-driven module system — convention + co-location + this doc is enough.
