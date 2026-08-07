# State: khôi phục giao diện SPA cũ trên backend D1

File tracking cho [plan-restore-spa-frontend.md](plan-restore-spa-frontend.md).
**Cập nhật file này mỗi khi một phase đổi trạng thái** — nguồn sự thật về tiến độ,
không phải git log.

> 🔀 **Session mới bắt đầu từ đây:** [HANDOFF.md](HANDOFF.md) — bàn giao 2026-08-07, gồm cả
> các bẫy vận hành (deploy tay, CRON_KEY, `wrangler dev` hot-reload) không nằm trong plan.

**Bắt đầu:** 2026-08-07
**Trạng thái tổng:** 🟡 **F1–F7 xong; chỉ còn F8.** SPA cũ đã được user xác nhận đúng frontend
Netflix premium trên production; toàn bộ checklist chức năng và Console CSP đều pass. `/api/*`,
sitemap và sync route vẫn đi qua Worker đúng contract. Inter đã self-host mà **không sửa CSS
design**. Còn lại F8 (đồng bộ tài liệu kiến trúc).

---

## Bảng phase

| Phase | Nội dung | Trạng thái | Ngày | Ghi chú |
|---|---|---|---|---|
| **F1** | Chốt contract legacy API (`docs/contract-legacy-api.md`) | 🟢 **Xong** | 2026-08-07 | Đọc hết `Grid.js`/`SearchOverlay.js`/`Player.js`/`HeroSlider.js`/`PosterCard.js`/`Carousel.js`. **Sửa 1 chỗ so với plan gốc:** `director` không được FE render ở đâu — bỏ khỏi scope F4 |
| **F2** | `/api/*` JSON trên D1 (6 endpoint + alias) | 🟢 **Xong, verify thật trên production** | 2026-08-07 | Deploy qua `wrangler deploy` tay (Git integration vẫn đứt) |
| **F3** | Migration 0009: `actor_json` + `popularity` + sync capture | 🟢 **Xong, verify thật trên D1 production** | 2026-08-07 | Bắt được + sửa 1 bug thật có sẵn từ Phase 5 (`cache.purge()` ném lỗi đồng bộ) — xem log |
| **F4** | `/api/home-data` (dùng `popularity`) | 🟢 **Xong, verify thật trên D1 production** | 2026-08-07 | Shape bất đối xứng đúng (hero mảng trần, 4 rail `{items}`); hero/trending còn thưa vì popularity đang backfill dần |
| **F5** | Self-host Inter, bỏ Google Fonts | 🟢 **Xong, build verify local** | 2026-08-07 | 8 subset/weight được bundle thành 8 `.woff2`; không đụng dòng CSS design nào. CSP SPA chuyển đúng sang `public/_headers` |
| **F6** | **Cutover**: `[assets]`→`dist` + `run_worker_first`, CSP mới, xoá SSR render | 🟢 **Xong, verify local + production** | 2026-08-07 | Deploy version `2979e564-970f-4c56-bccd-60b6bc021565`; SPA fallback và mọi Worker route đều pass smoke test |
| **F7** | **Verify bằng mắt** — ảnh chụp thật, user duyệt | 🟢 **Xong, user duyệt + Console sạch** | 2026-08-07 | Desktop + mobile đủ 5 luồng; user xác nhận đúng frontend; CSP `0 errors, 0 warnings` |
| **F8** | Đồng bộ tài liệu (ADR-0002 amendment, README, CLAUDE.md, MODULES.md) | ⚪ Chưa bắt đầu | — | |

Ký hiệu: ⚪ chưa bắt đầu · 🟡 đang làm · 🟢 xong · 🔴 chặn/sự cố · ⚫ bỏ

---

## Ràng buộc thi công (nhắc lại từ plan §0.3, vi phạm là làm lại)

0. **Không sửa `src/styles/*.css`** — kể cả trong ngoại lệ. 2.485 dòng CSS đó *chính là* giao
   diện cũ (quyết định #1 của user: giống hệt 100%).
1. **Không sửa `src/`** ngoài 4 ngoại lệ tường minh ở F5/F6 (import font ×2, preconnect, inline
   onclick) — không cái nào đụng CSS.
2. Contract-first — mâu thuẫn thì code FE thắng, sửa contract doc.
3. Deploy = **`npx wrangler deploy` tay** (Git integration đứt).
4. Verify bằng dữ liệu thật + curl, claim nào cũng kèm bằng chứng.

---

## Nhật ký quyết định

### 2026-08-07 — Phase F7: visual QA production, user duyệt, Console CSP sạch

Đã kiểm production bằng browser thật ở desktop `1440×900` và mobile `390×844`, chụp đủ: home
(hero + carousel), detail, ArtPlayer đang phát, search overlay, grid + phân trang. Không sửa
`src/styles/*.css`, không chỉnh frontend trong phase kiểm thử này.

**Checklist chức năng đã pass:** hero đổi slide và toàn bộ 20 slug hero hiện trả detail API 200;
nút cuộn carousel hoạt động; click card mở detail; ArtPlayer phát m3u8 thật; search có dấu/không
dấu cùng trả “Bạch Hồ Điệp” và lưu lịch sử; recommendation có dữ liệu hiển thị (“Thị Trưởng
Kingstown” → “Ông Trùm Giang Hồ”); `?page=2` đổi dữ liệu + active page; deep-link reload không
trắng trang.

User đã xác nhận bộ ảnh đúng frontend yêu cầu. Hai CSP error ban đầu đến từ HTML do Cloudflare chèn
sau deploy: inline `/cdn-cgi/challenge-platform/scripts/jsd/main.js` bootstrap và Web Analytics
beacon `static.cloudflareinsights.com`. Không nới `script-src` sang `unsafe-inline`. Vì Workers
Static Assets loại bỏ `no-transform` khi khai báo trực tiếp trong `_headers`, các route tài liệu SPA
(`/`, `/phim/*`, `/danh-sach/*`, `/the-loai/*`, `/quoc-gia/*`, `/tim-kiem`) nay đi qua Worker,
fetch SPA shell từ binding `ASSETS` rồi trả `Cache-Control: public, max-age=0, must-revalidate,
no-transform`. Asset fingerprinted vẫn bypass Worker và giữ immutable cache.

**Verify sau fix:** production version `80ef8e71-f3c1-446e-9a2b-01001a624fad`; home, detail và
grid deep-link đều 200 + SPA shell + CSP + `no-transform`, không còn challenge/beacon trong HTML.
Playwright trên home và deep-link detail: `0 errors, 0 warnings`; điều hướng SPA sang “Phim Bộ”
render đúng. `/api/home-data` vẫn JSON 200, `/api/not-exist` vẫn text 404, hashed asset vẫn
`max-age=31536000, immutable`. Client-side Web Analytics/JavaScript Detection không chạy trên HTML;
Cloudflare edge analytics vẫn còn. Không sửa `src/styles/*.css`.

### 2026-08-07 — Phase F6: cutover SPA lên production

`wrangler.toml` nay phục vụ `dist/` bằng Static Assets với SPA fallback; `run_worker_first` chỉ giữ
`/api/*`, `/__sync/*`, sitemap và robots đi qua Worker. Đã bỏ toàn bộ SSR page renderer/route cũ,
giữ sitemap renderer và tách `SITE_ORIGIN` sang `src-ssr/lib/site.ts`. CSP của Static Assets và
response động đã đồng bộ; nonce SSR không còn tồn tại. `index.html` preconnect đúng hai host ảnh thật,
và error reload trong `src/main.js` không còn inline handler.

Trước khi chốt CSP hẹp, đã kiểm dữ liệu D1 production và toàn bộ trang API: ảnh chỉ dùng
`image.tmdb.org` và `phimimg.com`. Không sửa file nào trong `src/styles/`.

**Verify:** `npm run build`, `npm run ssr:typecheck`, `wrangler deploy --dry-run`, local Wrangler
route smoke test và `git diff --check` đều pass. Deploy production thành công với version
`2979e564-970f-4c56-bccd-60b6bc021565`. Production smoke test pass: `/` và deep-link đều nhận cùng
SPA bundle; asset có immutable cache; `/api/home-data` là JSON; API không tồn tại là 404 thay vì SPA;
sitemap/robots đúng; `/__sync/status` không key là 404 `no-store`; CSP có trên cả Static Assets và
Worker response. Cache HTML SSR cũ xuất hiện trong lần request đầu, sau đó revalidate và URL chính
trả SPA mới với `CF-Cache-Status: MISS`.

---

### 2026-08-07 — Phase F5: self-host Inter + sửa vị trí CSP cho Static Assets

Chạy `npm ci` để đồng bộ dependency sau pull, sau đó cài `@fontsource/inter`. `src/main.js` chỉ thêm
8 import (Latin + Vietnamese × weight 400/500/700/900); `index.html` bỏ 3 thẻ Google Fonts. Không
sửa bất kỳ file nào trong `src/styles/`.

**Sửa một giả định kiến trúc trong plan F6:** với `run_worker_first` dạng danh sách chọn lọc, SPA được
Static Assets phục vụ trực tiếp nên CSP/security headers của SPA phải nằm trong `public/_headers`.
`securityHeaders.ts` chỉ bao phủ các response thực sự do Worker tạo. Đã thêm CSP tương thích
ArtPlayer/hls.js cùng HSTS, `nosniff`, Referrer Policy và Permissions Policy vào `_headers`; F6 vẫn
phải giữ middleware tương ứng cho `/api/*`, sitemap và `/__sync/*`.

**Verify local:** `npm run build` pass; `npm run ssr:typecheck` pass; `dist/assets/` có 8 file
`.woff2`; `dist/index.html` không còn `fonts.googleapis`/`fonts.gstatic`; `dist/_headers` chứa CSP;
`git diff -- src/styles` rỗng. Chưa deploy và chưa cutover production.

---

### 2026-08-07 — Phase F4: `/api/home-data` từ D1, verify shape bất đối xứng

**Vẫn thuần backend, chưa đụng giao diện.** `src-ssr/api/homeData.ts` (`buildHomeData` — hàm
thuần, 5 truy vấn D1 song song, không gọi KKPhim/TMDB runtime), route mount trong `routes.ts`.
Repository thêm 2 method: `getTrending` (`popularity DESC`, `NULLS LAST` bằng cách lọc
`popularity IS NOT NULL`) và `getHeroPool` (lọc `type != 'hoathinh'` + `poster_path LIKE
'%image.tmdb.org%'` để chỉ lấy phim có backdrop landscape w1280 — poster dọc phimimg sẽ méo
trong khung hero; xếp theo `popularity`).

**Verify thật trên D1 production** — đúng cái bẫy #2 (shape bất đối xứng):
- Top-level đủ 5 key. `newMovies`/`phimLe`/`phimBo`/`trending` là `{items}` (24/12/12/12),
  **`heroMovies` là MẢNG TRẦN** (13 phần tử) — không bọc `{items}`.
- `heroMovies[0].poster_url` chứa `/t/p/w1280/`; **toàn bộ** hero có backdrop w1280 (bất biến
  LCP preload của HeroSlider).
- Không phần tử hero nào `type === 'hoathinh'`.
- `trending` xếp theo popularity thật ("Cậu bé mất tích", "Xác Sống", "Nhật Ký Ma Cà Rồng").
- Mỗi phần tử là legacy item đầy đủ (`_id`/`name`/`slug`/`thumb_url`/`poster_url`/`tmdb`/
  `category`/`vote_average`).

**Ghi chú thực trạng (không phải bug):** hiện chỉ 14/132 phim có `popularity` (resync sau F3
mới bắt đầu, cron `*/30` điền dần), nên hero pool = 13 phần tử và toàn `type='series'` tình cờ.
Khi backfill điền đủ popularity, hero sẽ đầy 20 slot và đa dạng type — đúng đánh đổi "cutover
ngay với 132 phim" (quyết định #4). Không chặn F5/F6.

---

### 2026-08-07 — Phase F3: migration `actor_json` + `popularity`, bắt được bug thật của Phase 5

**Thuần backend, chưa đụng giao diện** — nhắc lại rõ với user trước khi làm (câu hỏi "đã đảm
bảo giống giao diện cũ chưa" nhận được từ user lúc bắt đầu phase này).

Xác nhận `popularity` là field thật trong TMDB Movie/TV Details response (kiểu `number`) qua
tài liệu TMDB chính thức trước khi code — đúng luật của plan "kiểm tra thật, không tin trí nhớ".

**Migration `0009_actor_popularity.sql`** gộp 2 cột cùng lúc (tránh 2 lần resync toàn catalog):
`actor_json`, `popularity`. Cập nhật dây chuyền: `kkphimClient.ts` (`KkphimMovie.actor?`),
`tmdbClient.ts` (`TmdbDetail.popularity?`), `types/movie.ts` (`NormalizedMovie.actors`/
`popularity`, `MovieRow.actor_json`/`popularity`), `normalize.ts` (capture ở cả
`normalizeMovie` và `normalizeStubMovie`), `hash.ts` (**`actors` vào hash** để ép resync 1 lần;
**`popularity` cố ý KHÔNG vào hash** — float TMDB trôi mỗi ngày, đưa vào hash sẽ ghi lại toàn bộ
catalog mỗi tick, thổi bay quota 100k row/ngày), `movieRepository.ts`
(`MOVIE_COLUMNS` 27→29, đã tính lại: 29×3=87 ≤ 100 ✅), `legacyItem.ts` (`actor: JSON.parse(...)`
thay `[]` cứng).

**Bắt được 1 bug thật có sẵn từ Phase 5, không liên quan F3, chặn hẳn việc verify:** lần sync
thử đầu tiên báo `errors:1` dù dữ liệu D1 thực ra **đã ghi đúng** — dùng `console.error` tạm
thời (`syncMovie.ts`) + `wrangler dev --remote` để bắt exception thật:
`TypeError: cache.purge is not a function`. Nguyên nhân: `cache.purge({...}).catch(() => {})`
chỉ bắt được **promise reject**, nhưng lỗi này ném **đồng bộ** ngay lúc gọi hàm (API purge
không được giả lập đầy đủ trong môi trường `wrangler dev --remote`) — exception thoát ra trước
khi `.catch()` kịp gắn vào. Sửa: bọc `try { await cache.purge(...) } catch {}` thay vì chỉ
`.catch()` trên promise. Xác nhận **production thật không hề bị ảnh hưởng** — cron đã sync
thành công liên tục (movie count tăng dần 91→104→118→132 qua các lần kiểm tra trước đó trong
session), vì cron chạy trên worker đã deploy thật, không qua tunnel dev preview.

**Verify thật trên D1 production** (sau khi sửa bug purge): sync `bach-ho-diep` (có tmdb_id
1176229) → `actor_json` có tên diễn viên thật, `popularity: 2.4264` — số thật từ TMDB.
`/api/movie/bach-ho-diep` trả `actor` đúng, không còn `[]`. Phim không có `tmdb_id` →
`popularity: null` đúng như thiết kế (không gọi TMDB khi không có id để tra) — không phải bug.

Migration đã áp lên D1 production (`redflare-db`). Code sẽ deploy cùng đợt.

---

### 2026-08-07 — Sửa lớn plan sau khi user chốt 4 quyết định (dừng F3 giữa chừng)

User dừng việc thi công, yêu cầu lập plan riêng cho phần migrate giao diện và **không làm gì cho
tới khi đảm bảo giống giao diện cũ**. Khảo sát lại `/public` + `/src` thật, rồi hỏi 4 câu.

**Bốn quyết định (đều chọn phương án tôi khuyến nghị):**

| # | Quyết định | Hệ quả lên plan |
|---|---|---|
| 1 | Giống hệt 100%, **không động vào CSS** | Thêm ràng buộc 0.3.2 cứng: cấm sửa `src/styles/*`. Bỏ mọi ý định "tinh chỉnh theo DESIGN.md" |
| 2 | **Self-host Inter** vào `/public` | Thêm phase F5 riêng. Xoá luôn 2 trong 7 chỗ CSP sẽ vỡ |
| 3 | Lưu **`popularity`** từ TMDB lúc sync | Gộp vào migration 0009 cùng `actor_json`; F4 (home-data) chuyển xuống sau F3 vì phụ thuộc cột này |
| 4 | **Cutover ngay** với 132 phim | Không chờ backfill. Không bật burst |

**Khảo sát mới — 7 chỗ CSP hiện tại sẽ phá giao diện cũ** (đo thật từ `index.html`, `Player.js`,
`node_modules/artplayer/dist`): khối `<style>` chống FOUC, CSS Google Fonts, file font gstatic,
ArtPlayer `createElement('style')`, hls.js blob worker, fetch m3u8/ts từ domain kkphimplayer động,
iframe `player.phimapi.com`. Plan gốc chỉ lường được 4/7. Quyết định #2 xoá 2 chỗ; 5 chỗ còn lại
xử ở F6.

**Phát hiện nguy hiểm nhất — tra docs Cloudflare, không suy đoán:**
`not_found_handling = "single-page-application"` khiến assets layer trả `index.html` cho **mọi**
path không khớp file — kể cả `/api/*`. Docs khuyến nghị **bắt buộc** đi kèm `run_worker_first`.
`wrangler.toml` trước cutover SSR có đúng setting này mà **không** có `run_worker_first` → nếu bê
nguyên lại, **toàn bộ `/api/*` vừa xây ở F2 sẽ bị nuốt sạch**, cùng với sitemap và `/__sync/*`.
Đã ghi thành §3 riêng trong plan với cấu hình đúng. `run_worker_first` cần wrangler ≥4.20 — đang
dùng 4.116 ✅.

**Cũng ghi vào plan:** cách verify "giống giao diện cũ" khi site cũ không còn chạy ở đâu để so —
build local, chụp 5 màn (desktop + mobile), gửi user duyệt **trước** khi coi F7 là xong.

**Phase F3 (cũ) chưa bắt đầu** — không có code nào bị bỏ dở. Đánh số lại: F3 migration →
F4 home-data → F5 font → F6 cutover → F7 verify mắt → F8 docs.

---

### 2026-08-07 — Phase F2: `/api/*` JSON trên D1, verify thật với dữ liệu thật

**Xây mới:** `src-ssr/api/legacyItem.ts` (`toLegacyItem`/`toLegacyDetail`/`toLegacyEpisodes` —
mapper duy nhất, dùng chung mọi route trả list), `src-ssr/api/pagination.ts` (clamp
`page ∈ [1,200]`, builder `{totalItems, totalItemsPerPage, currentPage, totalPages}`),
`src-ssr/api/routes.ts` (6 endpoint + alias). Repository thêm method OFFSET-pagination
(`getRecentMoviesOffset`, `getPageByTypeOffset`, `getMoviesByGenreOffset`,
`getMoviesByCountryOffset` + các hàm `count*`) — **ngoại lệ có chủ ý thứ ba** với luật
"không OFFSET" của ADR-0002 (sau sitemap, sau legacy list ở SSR cũ), lý do: `Grid.js`
(`src/modules/Grid/Grid.js`) tự build link `?page=N`, không sửa được vì luật "không sửa
`src/`". Chi phí bị chặn bởi clamp 200 trang × 24 = tối đa 4.800 rows/query.

**Verify thật trên D1 production** (không phải chỉ đọc code, từng endpoint):
- `/api/movie/bach-ho-diep` — khớp contract 100%: `content` là text đã strip, `actor: []`
  đúng dự kiến (F4 chưa chạy), `episodes` regroup đúng theo `server_name`.
- `/api/list?type=phim-le` — shape `data.{items,params.pagination,titlePage}` đúng.
- `/api/list?type=phim-moi-cap-nhat` — xác nhận **shape phẳng khác hẳn**, đúng bẫy #2 đã
  ghi trong plan.
- `/api/genre?slug=chinh-kich` — `titlePage: "Chính Kịch"` (tên thật có dấu từ D1, không
  phải title-case slug — đúng bẫy #10).
- **Bắt được 1 phát hiện thú vị lúc test `/api/search`:** query đầu tiên (`keyword=bach`,
  `keyword=thien+than`) trả rỗng — tưởng là bug, hoá ra do đoán sai tên phim thật (slug
  `thien-than-dem` thật ra có `title = "Malaikat Malam"`, tiếng Indonesia, không phải
  "Thiên Thần Đêm" như suy từ slug). Test lại với tên thật lấy từ D1
  (`toi-pham-thi-tran-nho` → "Tội Phạm Thị Trấn Nhỏ") xác nhận search **hoạt động đúng**,
  cả có dấu lẫn không dấu ra cùng 1 kết quả — không phải bug, là bài học "đừng đoán dữ
  liệu test từ slug".
- `/api/recommendation/tv/272059` + alias `/api/related/tv/272059` — cả hai trả **giống
  hệt nhau**, 9 phim thật. tmdb id không tồn tại → `200 {"items":[]}`, **không 404** (đúng
  contract §6 — client không catch lỗi riêng cho route này).
- `/api/home-data` → 404 (đúng — chưa build, đó là scope F3).

**Deploy:** Git integration vẫn đứt (chưa nối lại từ sự cố trước) — dùng
`npx wrangler deploy` tay.

---

### 2026-08-07 — Phase F1: chốt contract, sửa 1 sai sót của plan gốc

Đọc hết 6 module còn lại chưa xem lúc lập plan: `Grid.js` (pagination — xác nhận
`totalItems`/`totalItemsPerPage` được ưu tiên trước `totalPages`, đúng dự đoán ban đầu),
`SearchOverlay.js` (thuần client — localStorage, debounce 400ms, AbortController; không
phát sinh field mới), `Player.js` (xác nhận `artplayer` dist thật sự gọi
`createElement('style')` — CSP `style-src 'unsafe-inline'` ở F5 không phải suy đoán, đã
verify bằng grep vào `node_modules/artplayer/dist/artplayer.js`), `HeroSlider.js` +
`PosterCard.js` + `Carousel.js` (không field mới ngoài legacy item chuẩn).

**Phát hiện quan trọng, sửa scope F4:** `grep -n "director" src/components/MovieDetail.js`
ra **0 kết quả** — `director` được CLAUDE.md liệt là field OPhim sở hữu nhưng **chưa từng
được FE render**. Bỏ `director_json` khỏi migration 0009 — chỉ còn `actor_json`. Giảm 1
cột nghĩa là `MOVIE_COLUMNS` chỉ tăng 27→28 (không phải 27→29), vẫn nằm gọn dưới trần
100 tham số D1 ở batch 3 dòng (28×3=84).

**Cũng xác nhận `_id`** (`grep -rn "\._id" src/`) chưa từng được đọc lại sau khi
`normalizeListItem` gán nó — giá trị gì cũng được, dùng `slug` cho gọn.

Kết quả: [`docs/contract-legacy-api.md`](contract-legacy-api.md), mọi field đều trích
`file:line` thật, không đoán.

---

### 2026-08-07 — Lập plan (Fable 5)

**Bối cảnh:** sau cutover SSR (xem [state-ssr-rearchitecture.md](state-ssr-rearchitecture.md)),
giao diện tự chế trong `src-ssr/render/` + `public-ssr/styles.css` hỏng nặng so với SPA
cũ. User quyết định dùng lại giao diện cũ nguyên vẹn, giữ backend D1.

**Đã trích contract trực tiếp từ code FE** (không đoán): `ophim.js` (6 endpoint + mapper
`normalizeListItem` + image passthrough/fallback), `main.js` (shape home-data — phát
hiện `heroMovies` là mảng trần trong khi 4 rail kia bọc `{items}`), `MovieDetail.js`
(`content` vào `innerHTML`, cần `actor[]` — D1 chưa có, cần `trailer_url` URL đầy đủ —
D1 lưu key), `HeroSlider.js` (derive w154 từ URL TMDB w500 bằng regex — tương thích sẵn
với URL TMDB trực tiếp, không cần sửa), `upstreamFallback` (chỉ kích hoạt với
`img.bluesia.net` → thành no-op an toàn).

**Quyết định giữ/bỏ:** giữ toàn bộ data-layer D1 + sync/backfill/resolve + FTS5 +
sitemap + Workers Caching; bỏ toàn bộ SSR page render. Nguyên tắc "No SPA" của handoff
v1.0 chính thức đảo ngược (amendment ADR-0002 ở F8); nguyên tắc "runtime không gọi
API ngoài" **giữ nguyên** — `/api/*` mới đọc D1, không đọc KKPhim/TMDB.

**Rủi ro lớn nhất đã nhận diện:** CSP hiện tại sẽ giết ArtPlayer (inject `<style>`) và
hls.js (blob worker + fetch m3u8 từ domain động `*.kkphimplayer*`) — F5.4 có spec CSP
riêng; tiêu chí F7 là console 0 lỗi CSP trên browser thật.
