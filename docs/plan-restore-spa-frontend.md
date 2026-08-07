# Plan: khôi phục giao diện SPA cũ trên backend D1 mới

**Ngày lập:** 2026-08-07
**Người lập:** Fable 5 (planning) — **người thực hiện: Sonnet 5**
**Bối cảnh:** Cuộc tái kiến trúc SSR (ADR-0002, `plan-ssr-rearchitecture.md`) đã thay toàn bộ
frontend SPA cũ bằng HTML/CSS tự viết trong `src-ssr/render/` + `public-ssr/styles.css` —
kết quả **hỏng nặng về giao diện** so với SPA cũ (hero slider, carousel, search overlay,
ArtPlayer, skeleton... đều biến mất, thay bằng lưới thô). User quyết định: **dùng lại giao
diện cũ nguyên vẹn**, giữ backend D1 mới.
**Tracking:** [state-restore-spa-frontend.md](state-restore-spa-frontend.md) — cập nhật mỗi
khi một phase đổi trạng thái.
**Đọc bắt buộc trước khi code:** [README.md](../README.md), [CLAUDE.md](../CLAUDE.md)
(§"Endpoints the frontend calls", §"Field ownership"), [MODULES.md](../MODULES.md),
[ADR-0002](adr/0002-no-vps-ssr-architecture.md), [state-ssr-rearchitecture.md](state-ssr-rearchitecture.md).

---

## §0. Quyết định kiến trúc — cái gì GIỮ, cái gì BỎ

### Giữ (thành quả thật của đợt tái kiến trúc, không đụng vào)

| Thứ | Vì sao giữ |
|---|---|
| **D1 làm nguồn dữ liệu duy nhất lúc runtime** | Nguyên tắc quý nhất của ADR-0002: request người dùng **không bao giờ** gọi KKPhim/TMDB → xoá sạch lớp lỗi 504 ~11,4% của kiến trúc cũ. `/api/*` mới sẽ đọc D1, không đọc upstream |
| **Toàn bộ `src-ssr/services/sync/` + repositories + migrations 0005–0008** | Sync/backfill/resolve đang chạy nền qua cron, đã verify thật. Không liên quan giao diện |
| **FTS5 search, sitemap.xml, robots.txt, `/__sync/*`** | Không đụng giao diện, có giá trị SEO/vận hành thật |
| **Workers Caching + purge tag** (Phase 5) | Áp cho `/api/*` JSON y như từng áp cho trang SSR |
| **Schema D1 hiện tại** | `slug` PK, recommendation 3 tầng — không đổi |

### Bỏ / thay

| Thứ | Số phận |
|---|---|
| `src-ssr/render/*` (trừ `sitemap.ts`), `src-ssr/routes/{home,detail,list,genre,country,player,search}.ts` | **Xoá ở Phase F5** — SSR HTML tự chế là chính cái làm hỏng giao diện |
| `public-ssr/styles.css` | **Xoá** — SPA có CSS riêng trong `dist/` |
| `[assets] → public-ssr` | **Đổi về `dist/` + SPA fallback** như wrangler.toml trước cutover |
| Nguyên tắc "No SPA" của handoff v1.0 | **Chính thức bỏ.** Ghi amendment vào ADR-0002 ở Phase F7. SEO-per-page của SSR mất — đánh đổi user đã chọn có ý thức; sitemap + JSON-LD *không* mất hẳn (sitemap giữ nguyên) |

### Nguyên tắc thi công (Sonnet 5 phải tuân thủ)

1. **KHÔNG sửa bất kỳ file nào trong `src/`**, trừ đúng 2 ngoại lệ được liệt kê ở F5
   (preconnect trong `index.html`, inline `onclick` trong `main.js`). Giao diện cũ là
   chuẩn vàng — backend phải uốn theo FE, không phải ngược lại.
2. **Contract-first:** F1 viết xong `docs/contract-legacy-api.md` thì các phase sau code
   theo đúng file đó. Gặp mâu thuẫn giữa contract và code FE thật → **code FE thắng**,
   sửa contract doc.
3. Mỗi phase: typecheck sạch → verify qua `wrangler dev --remote` với D1 thật → deploy
   bằng **`npx wrangler deploy`** (Git integration đang đứt — push xong KHÔNG tự deploy,
   xem state-ssr-rearchitecture.md) → verify production bằng curl → cập nhật state doc
   → commit + push.
4. Verify = dữ liệu thật, không phải đọc code. Mọi claim "xong" phải kèm bằng chứng curl/D1.

---

## §1. Contract đã trích sẵn từ code FE (Fable 5 đọc trực tiếp `src/`, 2026-08-07)

Đây là phần lớn việc của F1 đã làm trước. Sonnet 5 ở F1 chỉ cần **kiểm chứng lại + bổ sung
phần Grid/pagination còn thiếu**, rồi chốt thành `docs/contract-legacy-api.md`.

### 1.1 `GET /api/home-data` — shape KHÔNG đồng nhất, giữ đúng từng key

Từ [main.js](../src/main.js) `renderHomePage`:

```jsonc
{
  "newMovies":  { "items": [ /* legacy item, KHÔNG qua normalize ở FE */ ] },
  "phimLe":     { "items": [ /* FE tự normalizeListItem */ ] },
  "phimBo":     { "items": [ ... ] },
  "trending":   { "items": [ ... ] },
  "heroMovies": [ /* MẢNG TRẦN, không bọc {items} */ ]
}
```

- Hero: FE preload `getBackdropUrl(heroMovies[0])` = `poster_url` (landscape) desktop /
  `thumb_url` (portrait) mobile → hero item **bắt buộc có `poster_url` là backdrop TMDB
  w1280** (D1: cột `poster_path`). Theo CLAUDE.md cũ: hero loại `type === 'hoathinh'`.
- HeroSlider tự derive w154 từ URL chứa `/t/p/w500/` — URL TMDB trực tiếp thoả sẵn,
  **không cần làm gì**.

### 1.2 `GET /api/list|genre|country|search` — shape "v1"

`ophim.js` đọc `const d = data.data || data` → trả **flat** là hợp lệ:

```jsonc
{
  "items": [ /* legacy item */ ],
  "params": { "pagination": { "totalItems": N, "totalItemsPerPage": 24, "currentPage": p, "totalPages": M } },
  "titlePage": "Phim Lẻ",
  "breadCrumb": [],
  "seoOnPage": {}
}
```

**Ngoại lệ:** `/api/list?type=phim-moi-cap-nhat` trả shape phẳng kiểu OPhim gốc:
`{ "items": [...], "pagination": {...} }` (xem `getNewMovies`).

**F1 phải đọc thêm `src/modules/Grid/Grid.js`** để chốt chính xác field pagination nào
Grid thực dùng (totalPages? totalItems?) — mục duy nhất §1 này chưa pin xong.

### 1.3 `GET /api/movie/:slug`

`getMovieDetail` đọc `data.movie` + `data.episodes` → trả:

```jsonc
{
  "movie": { /* legacy item ĐẦY ĐỦ, xem 1.5, thêm các field detail-only bên dưới */ },
  "episodes": [
    { "server_name": "Vietsub", "server_data": [
        { "name": "Tập 1", "slug": "tap-1", "link_m3u8": "https://...", "link_embed": "https://..." }
    ]}
  ]
}
```

Detail-only fields FE thực dùng ([MovieDetail.js](../src/components/MovieDetail.js)):
- `content` — render bằng **`innerHTML`** → server BẮT BUỘC chỉ trả text đã strip HTML
  (D1 `overview` đã strip sẵn ở `normalize.ts` — giữ nguyên bảo đảm đó).
- `trailer_url` — **URL YouTube đầy đủ**, không phải key. D1 lưu `youtube_trailer_key`
  → map: `https://www.youtube.com/watch?v=<key>`, key rỗng → bỏ field.
- `actor` — mảng tên. **D1 chưa có** → Phase F4 thêm cột. Trước F4: trả `[]` (FE đã
  guard `Array.isArray(movie.actor) && movie.actor.length > 0`).
- `year`, `vote_average`, `category[]`, `country[]`, `time`, `episode_current`,
  `quality`, `lang`, `status`, `type` — D1 có đủ.
- `tmdb: { "id": ..., "type": "movie"|"tv", "season": ... }` — **bắt buộc**, FE dùng để
  gọi recommendation. `episodes` regroup từ bảng `episode` theo `server`, giữ
  `sort_order`.

### 1.4 `GET /api/recommendation/:mediaType/:tmdbId` (+ alias `/api/related/...`)

Trả `{ "items": [ /* legacy item */ ] }`. Backend: `movieRepo.getByTmdbRef(mediaType,
tmdbId)` → `recommendationRepo.getResolvedForSlug(slug, 12)`. Không tìm thấy phim → 
`{ "items": [] }`, đừng 404 (FE không catch riêng).

### 1.5 Legacy item — mapper `MovieRow → item` (một hàm duy nhất, dùng chung mọi route)

Theo `normalizeListItem` FE:

| Field FE | Nguồn D1 (`MovieRow`) |
|---|---|
| `_id` | `slug` (FE không dùng làm gì ngoài truthy — dùng slug cho đơn giản; F1 verify bằng grep `_id` trong src/) |
| `name` | `title` |
| `slug` | `slug` |
| `origin_name` | `original_title` |
| `poster_url` | `poster_path` (backdrop/landscape) |
| `thumb_url` | `thumb_path \|\| poster_path` (portrait) |
| `year` | `release_year` |
| `type` / `status` / `quality` / `lang` / `episode_current` | cùng tên |
| `time` | `runtime` |
| `category` / `country` | `JSON.parse(genres_json / countries_json)` |
| `tmdb` | `{ id: tmdb_id, type: tmdb_type, season: tmdb_season }` |
| `imdb` | `{}` (D1 không lưu — FE chỉ default `{}`) |
| `vote_average` | `vote_average` |
| `modified` | `{ time: new Date(last_synced*1000).toISOString() }` |

### 1.6 Ảnh — đã tự tương thích, không cần sửa FE

- `posterUrl`/`thumbUrl` là passthrough → URL TMDB/phimimg trực tiếp chạy thẳng.
- `upstreamFallback` chỉ kích hoạt với prefix `img.bluesia.net` → giờ luôn trả `''` →
  `attachImageFallback` thành no-op an toàn. **Không sửa.**

---

## §2. Bản đồ phase

| Phase | Nội dung | Kết quả kiểm chứng được | Phụ thuộc |
|---|---|---|---|
| **F1** | Chốt contract: verify §1 + đọc `Grid.js`/`SearchOverlay.js`/`Player.js`, viết `docs/contract-legacy-api.md` | File contract tồn tại, mọi shape có trích dẫn `file:line` từ FE | — |
| **F2** | `/api/*` JSON trên D1: movie, list, genre, country, search, recommendation (+`/api/related` alias) | curl từng route qua `wrangler dev --remote` khớp contract từng field; search có kết quả thật từ FTS5 | F1 |
| **F3** | `/api/home-data` từ D1 | curl trả đủ 5 key đúng shape; hero ≥1 item có `poster_url` TMDB backdrop, không có `hoathinh` | F2 |
| **F4** | Migration 0009: `actor_json` + sync capture (F1 xác nhận `director` không được FE render ở đâu — bỏ khỏi scope) | Cột tồn tại; sync 1 phim thật → actor có dữ liệu; `/api/movie/:slug` trả `actor[]` thật | F2 |
| **F5** | Cutover giao diện: build `dist/`, `[assets]`→dist + SPA fallback, nới CSP cho player, xoá SSR render/routes + `public-ssr/` | Production: `/` trả SPA shell, deep-link `/phim/:slug` reload được, `/api/*` + `/sitemap.xml` + `/__sync/*` không bị assets nuốt | F2, F3 |
| **F6** | E2E verify + hardening | Checklist §5 pass hết trên production; user xác nhận bằng mắt trên browser thật | F5 |
| **F7** | Đồng bộ tài liệu: amendment ADR-0002, viết lại phần backend README/CLAUDE.md, cập nhật MODULES.md Axis C, đóng state docs | Không tài liệu nào còn mô tả SSR-page hay Cache-API/KV/R2 như hiện trạng | F6 |

F2→F3→F4 deploy được **trước** F5 mà không ảnh hưởng gì: SSR page cũ vẫn đang phục vụ,
`/api/*` mới nằm cạnh, không tranh route. Điểm không quay lại duy nhất là F5.

---

## §3. Chi tiết từng phase

### Phase F1 — chốt contract (không code runtime)

1. Đọc `src/modules/Grid/Grid.js`: pagination dùng field nào, build link `?page=N` ra sao.
2. Đọc `src/modules/SearchOverlay/SearchOverlay.js`: có dùng field nào ngoài
   `normalizeListItem` không; debounce/lịch sử — thuần client, chỉ cần xác nhận.
3. Đọc `src/modules/Player/Player.js` + `HeroSlider.js` + `Carousel.js` +
   `PosterCard.js`: field ảnh/nhãn nào được đọc (`episode_current`, `quality`,
   `vote_average`, `showRank`...).
4. `grep -rn "_id" src/` — xác nhận `_id` không được dùng làm key logic.
5. Viết `docs/contract-legacy-api.md` = §1 ở trên + phần Grid, mỗi shape kèm `file:line`.

**Verify:** file contract đầy đủ 6 endpoint + mapper table + phần pagination có trích dẫn.

### Phase F2 — legacy JSON API trên D1

Tạo `src-ssr/api/` (tách khỏi `routes/` SSR sắp xoá):

- `src-ssr/api/legacyItem.ts` — mapper §1.5, **một hàm duy nhất** `toLegacyItem(row:
  MovieRow)`, và `toLegacyDetail(row, episodes)` (thêm detail-only fields + regroup
  episodes theo `server_name`).
- `src-ssr/api/routes.ts` — Hono sub-app:
  - `GET /api/movie/:slug` — validate slug, 404 text khi không có (FE throw theo
    `res.ok`, hiện error state — đúng hành vi cũ).
  - `GET /api/list` — `type=phim-moi-cap-nhat` → mọi phim mới nhất (shape phẳng
    `{items, pagination}`); type khác → map qua `LIST_TYPE_LABELS` (shape v1 §1.2).
  - `GET /api/genre?slug=&page=`, `GET /api/country?slug=&page=` — qua
    `TaxonomyRepository`, `titlePage` lấy từ bảng `genre`/`country` (tên hiển thị thật,
    không title-case slug).
  - `GET /api/search?keyword=&page=` — `SearchRepository.search()` (FTS5). Page > 1 trả
    items rỗng (FTS không phân trang — contract ghi rõ; SearchOverlay chủ yếu dùng
    page 1).
  - `GET /api/recommendation/:mediaType/:tmdbId` + `GET /api/related/:mediaType/:tmdbId`
    (alias, CLAUDE.md ghi FE bundle cũ có thể còn gọi).
- **Pagination `?page=N`:** Grid cần số trang → dùng OFFSET **có clamp** (`page ∈ [1, 200]`).
  Đây là ngoại lệ có chủ ý thứ hai (sau sitemap) với luật "không OFFSET" của ADR-0002 —
  lý do: không được sửa FE, và chi phí rows-read bị chặn bởi clamp (200 × 24 = tối đa
  4.800 rows/query, so với quota đọc 5M/ngày). Ghi chú này vào code.
  Cần thêm `MovieRepository.getPageByTypeOffset(type, page, limit)` +
  `countByType(type)`, tương tự cho taxonomy (COUNT để build `totalPages`).
- Cache: `applyPageCache(c, ['api', 'movie:<slug>'...])` như trang SSR từng làm;
  `syncMovie.ts` purge `movie:<slug>` sẵn rồi — thêm tag `api` vào purge nếu cần
  purge rộng.
- Mount vào `index.ts` TRƯỚC các route SSR page.

**Verify (wrangler dev --remote, D1 thật):**
```
curl /api/movie/<slug thật>        → movie.name, movie.tmdb.id, episodes[0].server_data[0].link_m3u8
curl /api/list?type=phim-le&page=1 → items[0].name, params.pagination.totalPages
curl /api/list?type=phim-moi-cap-nhat → items + pagination (shape phẳng!)
curl /api/genre?slug=hanh-dong     → titlePage = "Hành Động" (từ D1, có dấu)
curl /api/search?keyword=<từ có dấu và không dấu> → cùng kết quả
curl /api/recommendation/movie/<tmdb id thật>     → items ≥ 1 (dùng phim đã resolve ở Phase 4)
curl /api/related/movie/<cùng id>  → giống hệt
```

### Phase F3 — `/api/home-data`

`src-ssr/api/homeData.ts`:
- `newMovies` = 24 phim `last_synced DESC` (mọi type).
- `phimLe` = 12 phim `type='single'`; `phimBo` = 12 `type='series'`.
- `trending` = 12 phim có `vote_count` cao nhất trong 500 phim mới nhất (D1 không có
  TMDB-trending — đây là xấp xỉ chấp nhận được, ghi vào contract; đừng gọi TMDB runtime).
- `heroMovies` = **mảng trần** 10 phim mới nhất có `poster_path` chứa `image.tmdb.org`
  (bảo đảm là backdrop w1280 thật) và `type != 'hoathinh'` và `tier='catalog'`.
- Tag cache `home`, TTL như control.ts chuẩn; purge không cần riêng (max-age 60 tự lành).

**Verify:** curl đủ 5 key; `heroMovies[0].poster_url` chứa `/t/p/w1280/`;
không item nào `type==='hoathinh'` trong hero; `python3 -m json.tool` pass.

### Phase F4 — actor/director

- `migrations/0009_actor.sql`: `ALTER TABLE movie ADD COLUMN actor_json TEXT NOT NULL
  DEFAULT '[]'`. (F1 xác nhận `director` không được `MovieDetail.js` render ở đâu — grep
  0 kết quả — nên **không thêm `director_json`**, tránh tốn ghi D1 cho field không ai đọc.)
- `normalize.ts`: KKPhim detail có sẵn `actor[]` — capture vào `NormalizedMovie`;
  **thêm vào `hashMovie`** (chấp nhận: toàn bộ catalog sẽ resync một vòng vì hash đổi —
  chính là cách backfill dữ liệu cột mới, không cần script riêng; với governor free
  85k rows/ngày vẫn an toàn, ghi rõ vào state doc).
- `movieRepository` upsert thêm 1 cột (**`MOVIE_COLUMNS` 27→28 → chunk 3 rows vẫn
  ≤100 params? 28×3=84 ✅**); `toLegacyItem` map `actor`.

**Verify:** sau 1 tick sync, `SELECT actor_json FROM movie WHERE actor_json != '[]'
LIMIT 1` có dữ liệu; `/api/movie/:slug` của phim đó trả `actor` không rỗng.

### Phase F5 — cutover giao diện (điểm không quay lại)

1. `npm run build` → `dist/` (SPA cũ nguyên vẹn, không sửa gì trước đó).
2. **2 ngoại lệ được phép sửa trong `src/`** (sửa xong build lại):
   - `index.html`: `<link rel="preconnect" href="https://img.bluesia.net">` → 2 dòng
     `https://image.tmdb.org` + `https://phimimg.com` (CLAUDE.md từng cảnh báo preconnect
     trỏ host chết = im lặng vô dụng).
   - `main.js` error-path `onclick="location.reload()"` → `addEventListener` (CSP không
     có `'unsafe-inline'` cho script — inline handler sẽ chết im lặng).
3. `wrangler.toml`: `[assets] directory = "dist", binding = "ASSETS",
   not_found_handling = "single-page-application"`. Hono `app.notFound` →
   `c.env.ASSETS.fetch(c.req.raw)` (worker xử lý `/api/*`, `/sitemap*`, `/robots.txt`,
   `/__sync/*` trước; còn lại rơi xuống assets → SPA fallback — đúng topology
   wrangler.toml cũ mô tả).
4. **CSP viết lại cho SPA** (`securityHeaders.ts`) — đây là chỗ dễ chết ngầm nhất:
   - `script-src 'self'` (bundle Vite; **bỏ jsdelivr** — hls.js/ArtPlayer đã bundle
     trong dist, không còn trang SSR player load CDN).
   - `style-src 'self' 'unsafe-inline'` — **bắt buộc**: ArtPlayer inject `<style>`
     runtime. Ghi chú đánh đổi vào code.
   - `connect-src 'self' https:` — hls.js fetch `.m3u8`/`.ts` từ
     `*.kkphimplayer*.com` (đuôi domain thay đổi theo server phim → không allow-list
     tĩnh được).
   - `media-src 'self' blob: https:`; `worker-src blob:` — hls.js dùng blob Worker.
   - `img-src 'self' https: data:` — poster từ TMDB/phimimg + fallback đa nguồn cũ.
   - `frame-src https://player.phimapi.com https://www.youtube.com` — iframe embed
     fallback của Player.js + trailer.
   - Giữ nguyên: HSTS, nosniff, Referrer-Policy, Permissions-Policy, frame-ancestors.
5. Xoá: `src-ssr/render/` (trừ `sitemap.ts` — đang được `routes/sitemap.ts` dùng;
   `escape.ts` giữ nếu sitemap cần), `src-ssr/routes/{home,detail,list,genre,country,
   player,search}.ts`, `public-ssr/`, references trong `index.ts`. `cache/control.ts`,
   `middleware/*` giữ (API dùng). Route `/xem/:slug` SSR xoá — SPA route `/phim/:slug`
   tự chứa player (MODULES.md: "single = direct play").
6. Typecheck + `wrangler dev --remote` verify + **`npx wrangler deploy`** + commit/push.

**Verify production:**
```
curl -I /                          → 200 text/html, có <div id="app"> (SPA shell)
curl -I /phim/<slug>               → 200, CÙNG index.html (SPA fallback), KHÔNG phải SSR
curl /assets/index-*.js            → 200 (đúng tên file build ra trong dist/assets/)
curl /api/home-data | json.tool    → pass
curl /sitemap.xml, /robots.txt     → 200 XML/text (worker, không bị assets nuốt)
curl -H "x-cron-key: sai" /__sync/status → 404
```

### Phase F6 — E2E + hardening

Checklist browser thật (**user xác nhận bằng mắt** — bài học đắt nhất của đợt SSR:
"curl pass ≠ giao diện đúng"; Sonnet 5 chuẩn bị sẵn, user bấm):

- [ ] Trang chủ: hero slider xoay, 4 carousel, skeleton lúc load
- [ ] Click card → detail: poster, badge TMDB, thể loại/quốc gia chip, nội dung, tập
- [ ] Bấm tập → ArtPlayer phát m3u8 thật; server không m3u8 → rớt xuống iframe embed
- [ ] Search overlay: gõ có dấu + không dấu ra cùng kết quả; lịch sử tìm kiếm hiện
- [ ] "Bạn cũng có thể thích" hiện ≥1 phim (phim đã resolve Phase 4)
- [ ] `/danh-sach/phim-le?page=2` phân trang hoạt động
- [ ] Deep-link reload `/phim/<slug>` + `/the-loai/hanh-dong` không trắng trang
- [ ] DevTools Console: **0 lỗi CSP** — nếu có lỗi CSP nào, F5.4 sửa thiếu
- [ ] Mobile viewport: hero dùng thumb_url portrait

Hardening cùng phase: bảng list/taxonomy cần COUNT — kiểm `rows_read` thực tế bằng
`wrangler d1 insights` hoặc meta trong response `d1 execute`, xác nhận clamp hoạt động.

### Phase F7 — tài liệu

1. **ADR-0002**: thêm khối `## Amendment 2026-08-07` — "No SPA/No hydration" bị đảo
   ngược theo quyết định user sau khi thấy SSR tự chế phá giao diện; các nguyên tắc
   còn lại (D1-only runtime, no KV/R2, sync qua cron) **giữ nguyên hiệu lực**.
2. **README.md**: phần Backend viết lại — không còn KV/R2/Cache API 3 tầng/mirror ảnh;
   giờ là D1 + Workers Caching + cron sync/backfill/resolve. Phần Frontend giữ nguyên
   (đúng trở lại!). Sửa "Deploy = git push" → ghi chú Git integration đứt, deploy =
   `npx wrangler deploy` (đến khi user nối lại).
3. **CLAUDE.md**: đại tu các mục đã chết — "Data flow & caching" (bỏ R2/mirror/KV/wsrv),
   "Caching layers" (giờ: in-page 5' → Workers Caching → D1), bảng endpoint trỏ về
   contract-legacy-api.md, "Field ownership" cập nhật KKPhim+TMDB→D1. **Không xoá** các
   mục Lazy loading / CSS gotchas / Conventions — FE cũ quay lại nên chúng **đúng trở lại**.
4. **MODULES.md**: Axis C đổi từ "catalog-api (VPS)" → route D1 mới trong
   `src-ssr/api/`; Axis A/B giữ nguyên.
5. Đóng `state-restore-spa-frontend.md`, cập nhật tổng trạng thái
   `state-ssr-rearchitecture.md` trỏ sang.

---

## §4. Bẫy đã biết (đọc trước khi code, mỗi cái từng gây sự cố thật hoặc sẽ gây)

1. **`heroMovies` mảng trần** vs 4 rail kia `{items}` — làm sai là hero trắng.
2. **`phim-moi-cap-nhat` shape phẳng** khác các type khác — `getNewMovies` không đọc
   `data.data`.
3. **`movie.content` đi vào `innerHTML`** — chỉ được trả text đã strip (D1 overview đã
   strip; đừng bao giờ nối HTML vào field này).
4. **CSP giết ArtPlayer/hls.js** nếu thiếu `style-src 'unsafe-inline'`, `worker-src
   blob:`, `connect-src https:`, `media-src blob:`. Console sạch là tiêu chí F6.
5. **`trailer_url` phải là URL đầy đủ** — trả key trần là nút trailer mở tab rác.
6. **Đừng để assets nuốt route worker**: `/sitemap.xml`, `/robots.txt`, `/api/*`,
   `/__sync/*` phải do worker trả; thứ tự route trong Hono + notFound→ASSETS là chốt.
7. **`MOVIE_COLUMNS` đổi thì kiểm lại phép chia 100-param** (F4: 29×3=87 ✅; thêm cột
   nữa thì tính lại).
8. **Hash đổi ở F4 = toàn catalog resync một vòng** — trên free governor là hành vi
   mong muốn (tự backfill cột mới) nhưng đừng hoảng khi thấy `rowsWrittenToday` tăng vọt.
9. **Deploy phải `npx wrangler deploy` tay** — push xong production KHÔNG đổi (Git
   integration đứt). Đã mất 15 phút debug đúng cái này hôm nay.
10. **`titlePage` genre/country lấy tên thật từ D1** — title-case slug ("hanh dong" →
    "Hanh Dong") là lỗi nhìn thấy ngay bằng mắt trên UI tiếng Việt.

---

## §5. Định nghĩa "xong"

Toàn bộ checklist F6 pass trên production + user xác nhận bằng mắt giao diện là giao
diện redflare cũ (hero/carousel/overlay/player) + `docs/` không còn mô tả kiến trúc nào
không tồn tại. Khi đó cập nhật state doc tổng: **frontend = SPA cũ nguyên vẹn, backend =
D1-only, hai thứ gặp nhau ở `/api/*` contract đã ghi thành văn.**
