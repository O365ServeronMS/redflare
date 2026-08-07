# State: khôi phục giao diện SPA cũ trên backend D1

File tracking cho [plan-restore-spa-frontend.md](plan-restore-spa-frontend.md).
**Cập nhật file này mỗi khi một phase đổi trạng thái** — nguồn sự thật về tiến độ,
không phải git log.

**Bắt đầu:** 2026-08-07
**Trạng thái tổng:** 🟡 **F1 + F2 xong.** `/api/*` (6 endpoint + alias) đã sống trên production,
đọc D1 thật, verify từng field khớp `contract-legacy-api.md`. SSR page cũ (giao diện hỏng) vẫn
đang phục vụ song song — F2 không đụng gì tới giao diện. F5 là điểm cutover thật.

---

## Bảng phase

| Phase | Nội dung | Trạng thái | Ngày | Ghi chú |
|---|---|---|---|---|
| **F1** | Chốt contract legacy API (`docs/contract-legacy-api.md`) | 🟢 **Xong** | 2026-08-07 | Đọc hết `Grid.js`/`SearchOverlay.js`/`Player.js`/`HeroSlider.js`/`PosterCard.js`/`Carousel.js`. **Sửa 1 chỗ so với plan gốc:** `director` không được FE render ở đâu — bỏ khỏi scope F4 |
| **F2** | `/api/*` JSON trên D1 (6 endpoint + alias) | 🟢 **Xong, verify thật trên production** | 2026-08-07 | Deploy qua `wrangler deploy` tay (Git integration vẫn đứt) |
| **F3** | `/api/home-data` từ D1 | ⚪ Chưa bắt đầu | — | Chặn bởi F2 |
| **F4** | Cột `actor_json`/`director_json` + sync capture | ⚪ Chưa bắt đầu | — | Hash đổi → toàn catalog tự resync một vòng (chủ ý) |
| **F5** | Cutover: `dist/` + SPA fallback, CSP mới, xoá SSR render | ⚪ Chưa bắt đầu | — | **Điểm không quay lại.** 2 ngoại lệ sửa `src/` được phép: preconnect `index.html`, inline onclick `main.js` |
| **F6** | E2E browser thật + hardening | ⚪ Chưa bắt đầu | — | Cần user xác nhận bằng mắt — bài học "curl pass ≠ giao diện đúng" |
| **F7** | Đồng bộ tài liệu (ADR-0002 amendment, README, CLAUDE.md, MODULES.md) | ⚪ Chưa bắt đầu | — | |

Ký hiệu: ⚪ chưa bắt đầu · 🟡 đang làm · 🟢 xong · 🔴 chặn/sự cố · ⚫ bỏ

---

## Ràng buộc thi công (nhắc lại từ plan §0.3, vi phạm là làm lại)

1. **Không sửa `src/`** ngoài 2 ngoại lệ F5.
2. Contract-first — mâu thuẫn thì code FE thắng, sửa contract doc.
3. Deploy = **`npx wrangler deploy` tay** (Git integration đứt).
4. Verify bằng dữ liệu thật + curl, claim nào cũng kèm bằng chứng.

---

## Nhật ký quyết định

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
v1.0 chính thức đảo ngược (amendment ADR-0002 ở F7); nguyên tắc "runtime không gọi
API ngoài" **giữ nguyên** — `/api/*` mới đọc D1, không đọc KKPhim/TMDB.

**Rủi ro lớn nhất đã nhận diện:** CSP hiện tại sẽ giết ArtPlayer (inject `<style>`) và
hls.js (blob worker + fetch m3u8 từ domain động `*.kkphimplayer*`) — F5.4 có spec CSP
riêng; tiêu chí F6 là console 0 lỗi CSP trên browser thật.
