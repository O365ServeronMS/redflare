# Plan: khôi phục giao diện SPA cũ trên backend D1 mới

**Ngày lập:** 2026-08-07 · **Sửa lớn:** 2026-08-07 (sau khi user chốt 4 quyết định, xem §0.4)
**Bối cảnh:** Cuộc tái kiến trúc SSR (ADR-0002, `plan-ssr-rearchitecture.md`) thay toàn bộ
frontend SPA bằng HTML/CSS tự viết trong `src-ssr/render/` + `public-ssr/styles.css` — **hỏng
nặng giao diện**. User quyết định dùng lại giao diện cũ nguyên vẹn, giữ backend D1.
**Tracking:** [state-restore-spa-frontend.md](state-restore-spa-frontend.md)
**Contract API:** [contract-legacy-api.md](contract-legacy-api.md) (sản phẩm của F1, đã xong)
**Đọc bắt buộc:** [README.md](../README.md), [CLAUDE.md](../CLAUDE.md), [MODULES.md](../MODULES.md),
[docs/DESIGN.md](DESIGN.md) (Netflix Spain style reference — nguồn của mọi token màu/chữ).

---

## §0. Quyết định kiến trúc

### 0.1 Giữ (thành quả thật của đợt tái kiến trúc)

D1 làm nguồn dữ liệu runtime duy nhất (**nguyên tắc quý nhất của ADR-0002** — xoá lớp lỗi 504
~11,4% của kiến trúc cũ), toàn bộ `src-ssr/services/sync/` + repositories + migrations 0005–0008,
`src-ssr/api/*` (F2), FTS5 search, sitemap, `/__sync/*`, Workers Caching.

### 0.2 Bỏ / thay

`src-ssr/render/*` (trừ phần sitemap cần), `src-ssr/routes/{home,detail,list,genre,country,player,search}.ts`,
`public-ssr/`, `[assets] → public-ssr`. Nguyên tắc "No SPA" của handoff v1.0 **chính thức đảo
ngược** (amendment ADR-0002 ở F8) — nguyên tắc "runtime không gọi API ngoài" **giữ nguyên**.

### 0.3 Ràng buộc thi công (vi phạm là làm lại)

1. **KHÔNG sửa file nào trong `src/`**, trừ **3 ngoại lệ** được liệt kê tường minh ở F5/F6.
   Giao diện cũ là chuẩn vàng — backend uốn theo FE, không ngược lại.
2. **KHÔNG sửa `src/styles/*.css`** — kể cả ngoại lệ. 2.485 dòng CSS đó *chính là* giao diện cũ.
3. Contract-first. Mâu thuẫn giữa contract và code FE thật → **code FE thắng**.
4. Deploy = **`npx wrangler deploy` tay** (Git integration đứt từ 2026-08-07, chưa nối lại).
5. Verify bằng dữ liệu thật + curl. Từ F7 trở đi: **verify bằng mắt trên ảnh chụp thật**.

### 0.4 Bốn quyết định user đã chốt (2026-08-07)

| # | Quyết định | Ảnh hưởng |
|---|---|---|
| 1 | **Giống hệt 100%, không động vào CSS** | Không tinh chỉnh design. Việc của ta chỉ là làm backend + CSP không phá nó |
| 2 | **Self-host Inter vào `/public`** | Bỏ Google Fonts. CSP giữ chặt, nhanh hơn, không phụ thuộc bên thứ ba. Chữ hiển thị y hệt |
| 3 | **Lưu `popularity` từ TMDB lúc sync** | Thêm 1 cột D1; hero + rail "Trending" xếp hạng gần nhất với hành vi cũ mà vẫn không gọi API runtime |
| 4 | **Cutover ngay với 132 phim** | Ưu tiên sửa giao diện hỏng. Chấp nhận vài ngày đầu trang chủ thưa |

---

## §1. Contract API

Đã chốt ở F1 → **[contract-legacy-api.md](contract-legacy-api.md)**. Mọi shape trích `file:line`
từ `src/`. F2 đã triển khai đúng 6 endpoint + alias và verify thật trên production.

---

## §2. Khảo sát giao diện — 7 chỗ CSP sẽ phá (đo thật, không suy đoán)

Đọc `index.html`, `src/modules/Player/Player.js`, và `node_modules/artplayer/dist/artplayer.js`:

| # | Thứ bị chặn | Nguyên nhân | Hậu quả |
|---|---|---|---|
| 1 | `<style>` inline trong `index.html` | `style-src 'self'` | Mất nền đen chống FOUC → **chớp trắng mỗi lần load** |
| 2 | CSS Google Fonts | `style-src 'self'` | **Mất font Inter** |
| 3 | File font `fonts.gstatic.com` | **thiếu hẳn `font-src`** | như trên |
| 4 | ArtPlayer `createElement('style')` | `style-src 'self'` | **Player vỡ giao diện** |
| 5 | hls.js blob worker | thiếu `worker-src blob:` | **Không phát được HLS** |
| 6 | fetch `.m3u8`/`.ts` từ `*.kkphimplayer*` | thiếu `connect-src` | **Không phát được** |
| 7 | iframe `player.phimapi.com` | `frame-src` chỉ có YouTube | Mất fallback embed |

Quyết định #2 (self-host font) xoá luôn #2 và #3. Năm cái còn lại xử ở F6.

**Tin tốt:** `src/styles/components.css` (2.162 dòng) còn nguyên, build ra 30.88 kB — bộ CSS
Netflix-style thật, không mất gì.

---

## §3. Bẫy lớn nhất của cutover: `not_found_handling` nuốt `/api/*`

Tra docs Cloudflare (2026-08-07, `workers/static-assets/`):

> *"`not_found_handling = "single-page-application"`: Sets your application to return a 200 OK
> response with `index.html` for requests which don't match a static asset. **We recommend
> pairing this with selective routing using `run_worker_first`**."*

`wrangler.toml` **trước cutover SSR** có đúng `not_found_handling = "single-page-application"`
mà **không** có `run_worker_first`. Bê nguyên lại = assets layer trả `index.html` cho mọi path
không khớp file → **nuốt sạch `/api/*`, `/sitemap.xml`, `/robots.txt`, `/__sync/*`** vừa xây ở F2.

**Cách làm đúng** (docs khuyến nghị, wrangler 4.116 hỗ trợ — cần ≥4.20):

```toml
[assets]
directory = "dist"
binding = "ASSETS"
not_found_handling = "single-page-application"
run_worker_first = ["/api/*", "/__sync/*", "/sitemap.xml", "/sitemap-*", "/robots.txt"]
```

Hệ quả phụ có lợi: worker **không** cần `app.notFound → ASSETS.fetch` nữa — path không nằm
trong `run_worker_first` không bao giờ tới worker. Bỏ được `apply404Cache` catch-all.

---

## §4. Bản đồ phase

| Phase | Nội dung | Kết quả kiểm chứng được | Trạng thái |
|---|---|---|---|
| **F1** | Chốt contract legacy API | `contract-legacy-api.md` có `file:line` cho mọi shape | 🟢 Xong |
| **F2** | `/api/*` JSON trên D1 (6 endpoint + alias) | curl production từng route khớp contract | 🟢 Xong |
| **F3** | Migration 0009: `actor_json` + `popularity` + sync capture | Resync 1 phim → cả 2 cột có dữ liệu thật | ⚪ |
| **F4** | `/api/home-data` (dùng `popularity`) | curl đủ 5 key; `heroMovies` là **mảng trần**; hero có backdrop TMDB, không `hoathinh` | ⚪ |
| **F5** | Self-host Inter, bỏ Google Fonts | `dist/assets/*.woff2` tồn tại; `index.html` không còn link tới Google | ⚪ |
| **F6** | **Cutover**: `[assets]`→`dist` + `run_worker_first`, CSP mới, xoá SSR render | Production: `/` = SPA shell; `/api/*` + sitemap + `/__sync/*` KHÔNG bị nuốt | ⚪ |
| **F7** | **Verify bằng mắt** — ảnh chụp thật, user duyệt | User xác nhận giống giao diện cũ; DevTools **0 lỗi CSP** | ⚪ |
| **F8** | Đồng bộ tài liệu (ADR amendment, README, CLAUDE.md, MODULES.md) | Không doc nào còn mô tả kiến trúc không tồn tại | ⚪ |

F3–F5 deploy được mà **không đụng giao diện** (SSR cũ vẫn phục vụ song song). **F6 là điểm không
quay lại.**

---

## §5. Chi tiết phase

### F3 — Migration 0009: `actor_json` + `popularity`

Gộp 2 cột vào 1 migration (thay vì 2 lần resync toàn catalog).

- `migrations/0009_actor_popularity.sql`:
  `ALTER TABLE movie ADD COLUMN actor_json TEXT NOT NULL DEFAULT '[]';`
  `ALTER TABLE movie ADD COLUMN popularity REAL;`
- `tmdbClient.ts`: thêm `popularity?: number` vào interface `TmdbDetail` (TMDB detail trả sẵn
  trường này — **xác minh bằng curl thật trước khi code**, đừng tin trí nhớ).
- `normalize.ts`: capture `actor` (KKPhim `movie.actor[]`) + `popularity` (TMDB) vào
  `NormalizedMovie`. Stub (`normalizeStubMovie`) cũng cần 2 field này để typecheck qua.
- **`hash.ts` — điểm tinh tế nhất của phase này:**
  - `actor` **CÓ** vào `hashMovie` → hash đổi → **toàn catalog tự resync 1 vòng**, chính là cách
    backfill dữ liệu cột mới mà không cần script riêng.
  - `popularity` **KHÔNG** vào `hashMovie`. Đây là float TMDB thay đổi mỗi ngày; đưa vào hash sẽ
    khiến **mọi phim bị ghi lại mỗi tick sync**, thổi bay quota ghi 100k row/ngày. Nó "đi nhờ"
    vòng resync do `actor` kích hoạt. Đánh đổi: `popularity` chỉ mới lại khi phim có thay đổi
    khác — chấp nhận được cho mục đích xếp hạng.
- `movieRepository.ts`: `MOVIE_COLUMNS` 27→29. **Kiểm lại phép chia 100 tham số: 29×3 = 87 ≤ 100 ✅**
  (nếu sau này thêm cột nữa phải tính lại — 29×4 = 116 ✗).
- `legacyItem.ts`: `toLegacyDetail` đọc `actor: JSON.parse(row.actor_json)` thay cho `[]` hard-code.

**Verify:** áp migration → chờ/ép 1 tick sync → `SELECT actor_json, popularity FROM movie WHERE
actor_json != '[]' LIMIT 1` có dữ liệu thật → `curl /api/movie/<slug đó>` trả `actor` không rỗng.

### F4 — `/api/home-data`

`src-ssr/api/homeData.ts`, mount vào `apiRoute`. Shape theo contract §1 — **`heroMovies` là mảng
trần, 4 rail kia bọc `{items}`**; cả 5 đều trả legacy item đầy đủ (`newMovies` không qua
`normalizeListItem` phía client nên server phải tự đủ).

| Key | Nguồn |
|---|---|
| `newMovies` | 24 phim `last_synced DESC` (mọi type) |
| `phimLe` | 12 phim `type='single'`, `last_synced DESC` |
| `phimBo` | 12 phim `type='series'`, `last_synced DESC` |
| `trending` | 12 phim `popularity DESC NULLS LAST` |
| `heroMovies` | **mảng trần**, 20 phim: `tier='catalog'` AND `poster_path LIKE '%image.tmdb.org%'` AND `type != 'hoathinh'`, `popularity DESC` |

Điều kiện `poster_path LIKE '%image.tmdb.org%'` là vì hero cần **backdrop landscape w1280**;
phim chỉ có ảnh phimimg là poster dọc, đặt vào hero sẽ méo. Lọc `hoathinh` giữ đúng hành vi cũ
(CLAUDE.md: shard 4 hero pool lọc `item.type === 'hoathinh'`).

**Verify:** `curl /api/home-data | python3 -m json.tool` → đủ 5 key; `heroMovies` là array (không
phải object); `heroMovies[0].poster_url` chứa `/t/p/w1280/`; không phần tử nào `type === 'hoathinh'`.

### F5 — Self-host Inter (quyết định #2)

**Ngoại lệ #1 và #2 với luật "không sửa `src/`"** — cả hai đều **không đụng một dòng CSS design nào**:

1. `npm i @fontsource/inter` → package ship sẵn woff2 + `@font-face` có `unicode-range`, **gồm
   subset `vietnamese`**. **Xác minh subset vietnamese thật sự tồn tại trong package trước khi
   dựa vào nó** (`ls node_modules/@fontsource/inter/files/ | grep vietnamese`) — nếu không có,
   fallback sang tải thủ công từ Google Fonts API vào `public/fonts/`.
2. **Ngoại lệ #1:** `src/main.js` thêm 8 dòng `import '@fontsource/inter/...'` (4 weight ×
   latin+vietnamese) ở đầu file. Vite bundle font vào `dist/assets/` với tên có hash.
3. **Ngoại lệ #2:** `index.html` xoá 3 thẻ Google Fonts (`preconnect` ×2 + `<link href=...css2>`).
   **Giữ nguyên** khối `<style>` chống FOUC (CSP ở F6 sẽ cho phép nó).

**✅ Đã kiểm tra 2026-08-07 — không còn rủi ro ở đây, không cần hỏi user.** Lo ngại ban đầu
("`--font-netflix-sans` không chứa Inter") hoá ra **không liên quan**: token đó khai báo trong
`variables.css:15` nhưng **không được dùng ở bất kỳ đâu** (dead token). Font thật được áp trực
tiếp bằng tên:

- `src/styles/global.css:53` → `font-family: 'Inter', sans-serif;`
- `src/styles/components.css:1387` và `:1812` → cùng vậy

Nghĩa là self-host Inter **hoạt động ngay, không cần sửa một dòng CSS nào** — đúng ràng buộc
0.3.2. Chỉ cần đảm bảo `@font-face` khai báo `font-family: 'Inter'` (đúng những gì
`@fontsource/inter` làm).

**Verify:** `npm run build` → `ls dist/assets/*.woff2` có file; `grep -c "fonts.googleapis" dist/index.html` = 0.

### F6 — Cutover (điểm không quay lại)

1. `npm run build`.
2. **Ngoại lệ #3:** `index.html` sửa preconnect: bỏ `img.bluesia.net` (host đã chết — CLAUDE.md
   cảnh báo preconnect trỏ host chết là "im lặng vô dụng"), thêm `image.tmdb.org` + `phimimg.com`.
3. **Ngoại lệ #4:** `src/main.js` error-path `onclick="location.reload()"` → `addEventListener`
   (CSP không có `'unsafe-inline'` cho **script**; inline handler sẽ chết im lặng).
   *(Ngoại lệ #3/#4 nằm trong 2 ngoại lệ plan gốc đã cho phép — không phát sinh mới.)*
4. `wrangler.toml`: `[assets]` như §3, **có `run_worker_first`**.
5. **CSP viết lại** (`securityHeaders.ts`) — xử 5 chỗ còn lại của §2:
   ```
   default-src 'self';
   script-src 'self';
   style-src 'self' 'unsafe-inline';     ← ArtPlayer + khối FOUC. Đánh đổi có chủ ý, ghi chú vào code
   font-src 'self';                       ← self-host, không cần gstatic
   img-src 'self' https://image.tmdb.org https://phimimg.com data:;
   media-src 'self' blob: https:;         ← hls.js MSE + native HLS iOS
   connect-src 'self' https:;             ← m3u8/ts từ domain kkphimplayer ĐỘNG, không allow-list tĩnh được
   worker-src blob:;                      ← hls.js blob worker
   frame-src https://player.phimapi.com https://www.youtube.com;
   object-src 'none'; base-uri 'none'; frame-ancestors 'self';
   ```
   **Trước khi chốt `img-src` hẹp:** query D1 xem thật sự có bao nhiêu host ảnh phân biệt
   (`SELECT DISTINCT substr(poster_path,1,30) FROM movie`). Sai chỗ này = **ảnh vỡ = giao diện
   hỏng lần nữa** — đúng thứ ta đang đi sửa. Nếu có host lạ → nới thành `img-src 'self' https: data:`.
6. Bỏ `nonce` khỏi `securityHeaders.ts` (chỉ tồn tại cho trang player SSR sắp xoá) và
   `Variables: { nonce: string }` khỏi type của app.
7. **Xoá:** `src-ssr/render/{layout,seo,card,homePage,listPage,detailPage,playerPage,searchPage}.ts`,
   `src-ssr/routes/{home,detail,list,genre,country,player,search}.ts`, `public-ssr/`.
   **Kiểm phụ thuộc trước khi xoá:** `routes/sitemap.ts` đang import `render/sitemap.ts` và
   `SITE_ORIGIN` từ `render/seo.ts` → phải giữ `render/sitemap.ts` + trích `SITE_ORIGIN` ra chỗ
   khác (vd `lib/site.ts`) trước khi xoá `seo.ts`. `render/escape.ts` cũng có thể còn được
   `render/sitemap.ts` dùng.
8. Typecheck → `wrangler dev --remote` verify → `npx wrangler deploy` → verify production.

**Verify production:**
```
curl -I /                    → 200 text/html, body có <div id="app">
curl -I /phim/<slug>         → 200, CÙNG index.html (SPA fallback), KHÔNG phải SSR
curl /assets/index-*.js      → 200
curl /api/home-data          → JSON hợp lệ (KHÔNG bị nuốt thành index.html!)
curl /api/movie/<slug>       → JSON
curl /sitemap.xml            → XML
curl /robots.txt             → text
curl -H "x-cron-key: sai" /__sync/status → 404 (không phải index.html)
```

### F7 — Verify bằng mắt (ràng buộc cứng của user)

Site cũ **không còn chạy ở đâu** để so sánh — production hiện là bản SSR hỏng. Nên:

1. Chạy `npm run dev` (Vite proxy `/api/*` → production, tức backend D1 thật) hoặc
   `wrangler dev --remote` với dist đã build.
2. **Chụp màn hình thật** 5 màn: trang chủ (hero + carousel), detail, player đang phát, search
   overlay, grid có phân trang. Cả desktop + mobile viewport.
3. **Gửi user duyệt trước khi coi là xong.** Đây là bài học đắt nhất của cả dự án: mọi phase SSR
   đều "verified bằng curl" nhưng giao diện hỏng nặng — vì curl không nhìn thấy cái người dùng nhìn thấy.
4. Checklist DevTools: **Console 0 lỗi CSP**. Có lỗi nào = F6.5 sót.
5. Checklist chức năng: hero xoay 8s; carousel cuộn mượt; click card → detail; bấm tập → ArtPlayer
   phát m3u8; server không m3u8 → rớt iframe embed; search có dấu/không dấu ra cùng kết quả;
   lịch sử tìm kiếm; "Bạn cũng có thể thích" ≥1 phim; `?page=2`; deep-link reload không trắng trang.

### F8 — Tài liệu

ADR-0002 amendment ("No SPA" đảo ngược, các nguyên tắc khác giữ), README (phần Backend viết lại:
không còn KV/R2/3 tầng cache/mirror ảnh; Deploy = `wrangler deploy` tay đến khi nối lại Git),
CLAUDE.md (đại tu "Data flow & caching" + "Caching layers" + bảng endpoint → trỏ contract;
**giữ nguyên** mục Lazy loading / CSS gotchas / Conventions — FE cũ quay lại nên chúng **đúng trở
lại**), MODULES.md (Axis C → `src-ssr/api/`).

---

## §6. Bẫy đã biết

1. **`not_found_handling` nuốt `/api/*`** nếu thiếu `run_worker_first` — §3. Nguy hiểm nhất.
2. **`heroMovies` mảng trần** vs 4 rail `{items}` — sai là hero trắng.
3. **`phim-moi-cap-nhat` shape phẳng** khác mọi type khác.
4. **`popularity` KHÔNG vào hash** — vào là thổi bay quota ghi D1.
5. **CSP giết ArtPlayer/hls.js** nếu thiếu `style-src 'unsafe-inline'`, `worker-src blob:`,
   `connect-src https:`, `media-src blob:`. Console sạch là tiêu chí F7.
6. **`img-src` quá hẹp = ảnh vỡ** — query D1 xác nhận host trước.
7. **`MOVIE_COLUMNS` 27→29**: 29×3=87 ✅, nhưng 29×4=116 ✗ — thêm cột nữa phải tính lại.
8. **Xoá `render/seo.ts` làm gãy `routes/sitemap.ts`** — trích `SITE_ORIGIN` ra trước.
9. ~~**Font nạp nhưng không được tham chiếu**~~ — **đã kiểm tra, không phải vấn đề**:
   `global.css:53` + `components.css:1387,1812` đã áp `font-family: 'Inter'` trực tiếp.
   `--font-netflix-sans` là dead token, không dùng ở đâu.
10. **Deploy phải `npx wrangler deploy` tay** — push xong production KHÔNG đổi.
11. **`movie.content` vào `innerHTML`** — chỉ trả plain text (D1 đã strip sẵn, đừng phá bảo đảm đó).
12. **`trailer_url` phải là URL đầy đủ**, không phải key.

---

## §7. Định nghĩa "xong"

Checklist F7 pass + **user xác nhận bằng mắt** rằng đó là giao diện redflare cũ (hero/carousel/
overlay/ArtPlayer) + `docs/` không còn mô tả kiến trúc không tồn tại. Khi đó: **frontend = SPA cũ
nguyên vẹn, backend = D1-only, gặp nhau ở `/api/*` contract đã ghi thành văn.**
