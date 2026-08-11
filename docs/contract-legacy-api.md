# Contract: `/api/*` JSON mà SPA cũ (`src/`) cần từ backend D1

**Ngày lập:** 2026-08-07 (Phase F1 của [plan-restore-spa-frontend.md](plan-restore-spa-frontend.md))
**Nguồn:** đọc trực tiếp `src/api/ophim.js`, `src/main.js`, `src/components/MovieDetail.js`,
`src/modules/{Grid,SearchOverlay,Player,HeroSlider,PosterCard,Carousel}/*.js` — không đoán,
không suy từ CLAUDE.md cũ (tài liệu đó mô tả backend VPS/OPhim đã chết).

**Luật của tài liệu này:** mọi dòng đều trích được `file:line`. Gặp mâu thuẫn với plan gốc
hoặc CLAUDE.md → **file này thắng**, vì nó bám thẳng vào code sẽ chạy thật.

**Đã sửa 1 chỗ so với `plan-restore-spa-frontend.md` §1.3 khi đọc kỹ hơn ở F1:**
`director` — dù CLAUDE.md liệt là field OPhim sở hữu — **không được `MovieDetail.js` render ở
bất kỳ đâu** (grep xác nhận: 0 kết quả). Vậy F4 chỉ cần thêm cột `actor_json`, **không cần**
`director_json`. Bỏ field đó khỏi scope F4 để không tốn ghi D1 cho thứ không ai đọc.

---

## 1. `GET /api/home-data`

Nguồn: [main.js:134-206](../src/main.js#L134) `renderHomePage`.

```jsonc
{
  "newMovies":  { "items": [ /* legacy item, KHÔNG qua normalizeListItem ở client */ ] },
  "phimLe":     { "items": [ /* client tự map normalizeListItem */ ] },
  "phimBo":     { "items": [ ... ] },
  "trending":   { "items": [ ... ] },
  "heroMovies": [ /* ⚠️ MẢNG TRẦN — KHÔNG bọc {items} */ ]
}
```

- `newMovies.items` đi thẳng vào `renderCarousel` **không qua `normalizeListItem`** —
  server phải tự trả đúng shape legacy item luôn (không phụ thuộc client normalize).
  `phimLe`/`phimBo`/`trending` cũng đi qua `.map(normalizeListItem)` phía client nên có thể
  thiếu field lặt vặt mà `normalizeListItem` sẽ tự điền default — nhưng an toàn nhất là server
  luôn trả **đủ field của legacy item** (§5) cho cả 4 rail, không riêng gì `newMovies`.
- `heroMovies[0]` được dùng để build `<link rel="preload" as="image">` qua
  `getBackdropUrl()` ([HeroSlider.js:18-22](../src/modules/HeroSlider/HeroSlider.js#L18)) —
  desktop đọc `poster_url` (backdrop TMDB `w1280`), mobile đọc `thumb_url`. Item hero **phải
  có `poster_url`** không rỗng để LCP preload có tác dụng.
- Hero tối đa 20 slide ([HeroSlider.js:14](../src/modules/HeroSlider/HeroSlider.js#L14)
  `MAX_SLIDES = 20`) — server trả nhiều hơn cũng không sao, client tự cắt.
- Sau khi rollout Hero hoàn tất, nguồn của `heroMovies` là bảng `hero_snapshot`, không phải
  `movie.popularity`. Snapshot giữ nguyên `rank` gốc trong 20 kết quả đầu của TMDB
  `/trending/movie/week`, chỉ chứa phim `movie` + `single` + `has_stream=1` có bản KKPhim
  và backdrop hợp lệ. Rank có thể có khoảng trống, số slide có thể từ 0 đến 20 và không được
  bù bằng phim ngoài top 20. `tmdb_id` là duy nhất trong snapshot; JSON response vẫn là
  **mảng trần** gồm các legacy item với shape không đổi.
- Snapshot và ba key `sync_state` (`hero:last_success_at`, `hero:last_attempt_at`,
  `hero:last_result`) được replace trong cùng một D1 `batch()`. Cloudflare xác nhận batched
  statements là [SQL transaction rollback toàn bộ sequence khi một statement lỗi](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch).
- `getScore()`/`getImdbScore()` đọc `movie.imdb.*` nhưng **không được gọi ở bất kỳ đâu**
  trong luồng render thật (chỉ định nghĩa, dead code) — field `imdb` không ảnh hưởng hiển thị,
  giữ `{}` là đủ.
- `getTmdbScore()` — **field hiển thị điểm duy nhất** — đọc `movie.vote_average` trực tiếp
  (không phải `imdb`).

## 2. `GET /api/list`

Nguồn: [ophim.js:45-73](../src/api/ophim.js#L45).

### 2a. `?type=phim-moi-cap-nhat&page=N` — shape PHẲNG kiểu OPhim gốc

```jsonc
{ "items": [ /* legacy item */ ], "pagination": { /* xem §2c */ } }
```

`getNewMovies` đọc thẳng `data.items`/`data.pagination`, **không** đọc `data.data`.

### 2b. `?type=<phim-le|phim-bo|hoat-hinh|tv-shows>&page=N` — shape "v1"

```jsonc
{
  "data": {
    "items": [ /* legacy item */ ],
    "params": { "pagination": { /* xem §2c */ } },
    "titlePage": "Phim Lẻ",
    "breadCrumb": [],
    "seoOnPage": {}
  }
}
```

`getMoviesByType` đọc `const d = data.data || data` — **cho phép trả phẳng (không bọc
`data`) cũng chạy được**, nhưng để nhất quán với `titlePage` server nên bọc trong `data`.
`breadCrumb`/`seoOnPage` client nhận nhưng không render gì với chúng (kiểm tra:
không xuất hiện trong `main.js`/`Grid.js`) → trả `[]`/`{}` là đủ.

### 2c. Shape `pagination` — bắt buộc đúng để `Grid.js` tính `totalPages`

Nguồn: [Grid.js:133-138](../src/modules/Grid/Grid.js#L133):

```js
if (pagination.totalItems && pagination.totalItemsPerPage) {
  totalPages = Math.ceil(pagination.totalItems / pagination.totalItemsPerPage);
} else {
  totalPages = pagination.totalPages || pagination.totalPage || 1;
}
```

**Ưu tiên `totalItems` + `totalItemsPerPage`** (server nên luôn trả cả hai, đáng tin cậy
hơn `totalPages` có sẵn vì Grid tự tính lại). Field tối thiểu:

```jsonc
{ "totalItems": 16920, "totalItemsPerPage": 24, "currentPage": 1, "totalPages": 705 }
```

`Grid.js` build link `?page=N` bằng `navigate('${path}?page=${targetPage}')` — route
`/danh-sach/:type`, `/the-loai/:slug`, `/quoc-gia/:slug` đều nhận `query.page` qua
`main.js` router (`parseInt(query.page, 10)`, mặc định 1).

## 3. `GET /api/genre?slug=&page=`, `GET /api/country?slug=&page=`

Nguồn: [ophim.js:112-135](../src/api/ophim.js#L112). Cùng shape §2b (`data.items`,
`data.params.pagination`, `data.titlePage`). **`titlePage` phải là tên hiển thị thật có
dấu** (vd `"Hành Động"`) — nếu thiếu, client fallback title-case slug
([main.js:264-267](../src/main.js#L264): `params.slug.replace(/-/g, ' ')...toUpperCase()`)
ra chữ sai chính tả tiếng Việt, lỗi nhìn thấy ngay bằng mắt.

## 4. `GET /api/movie/:slug`

Nguồn: [ophim.js:85-93](../src/api/ophim.js#L85) + toàn bộ
[MovieDetail.js](../src/components/MovieDetail.js).

```jsonc
{
  "movie": {
    /* mọi field legacy item (§5) CỘNG THÊM: */
    "content": "text đã strip HTML",   // ⚠️ render bằng innerHTML — KHÔNG được lẫn thẻ HTML lạ
    "trailer_url": "https://www.youtube.com/watch?v=XXXX",  // ⚠️ URL ĐẦY ĐỦ, không phải key
    "actor": ["Tên diễn viên 1", "Tên diễn viên 2"]          // mảng string, [] nếu chưa có (F4)
  },
  "episodes": [
    {
      "server_name": "Vietsub",
      "server_data": [
        { "name": "Tập 1", "slug": "tap-1", "link_m3u8": "https://...", "link_embed": "https://..." }
      ]
    }
  ]
}
```

Chi tiết field detail-only, tất cả từ `MovieDetail.js`:

| Field | Dòng | Ghi chú |
|---|---|---|
| `content` | [L266,L272](../src/components/MovieDetail.js#L266) | `descBody.innerHTML = movie.content` — bắt buộc plain text, không tag |
| `trailer_url` | [L226-231](../src/components/MovieDetail.js#L226) | `window.open(movie.trailer_url, '_blank')` — phải là URL mở được trực tiếp |
| `actor` | [L300-311](../src/components/MovieDetail.js#L300) | guard `Array.isArray(...) && length > 0` — thiếu field/rỗng chỉ ẩn khối, không lỗi |
| `year`, `vote_average` | [L172-182](../src/components/MovieDetail.js#L172) | đã có trong legacy item, dùng lại |
| `category`, `country` | [L251-262](../src/components/MovieDetail.js#L251) | mảng `{name, slug}`, đã có trong legacy item |
| `director` | — | **KHÔNG được render ở đâu cả — bỏ khỏi scope, xem ghi chú đầu file** |

Episodes ([L320-434](../src/components/MovieDetail.js#L320)): server (bảng `episode`
D1) group theo `server_name`, mỗi server có `server_data[]` gồm `name` (tên hiển thị tập,
KHÔNG phải `ep_name` đổi tên tuỳ ý — dùng đúng giá trị đã lưu), `slug`, `link_m3u8`,
`link_embed`. Client kiểm `Array.isArray(server_data) && length > 0` mới hiện server đó —
server rỗng thì bỏ qua, không lỗi.

`getMovieDetail` ([ophim.js:85](../src/api/ophim.js#L85)) đọc `data.movie` ưu tiên,
fallback `data.item`; `episodes` đọc `item.episodes || data.episodes ||
data.data?.episodes` — cứ trả đúng shape trên là khớp nhánh đầu tiên, không cần lo các
nhánh fallback.

## 5. `POST /api/search`

Nguồn: [ophim.js](../src/api/ophim.js),
[SearchOverlay.js](../src/modules/SearchOverlay/SearchOverlay.js).

Body là `application/x-www-form-urlencoded`:

- `keyword`: từ khoá tìm kiếm.
- `page`: mặc định 1; overlay không có phân trang.
- `cf-turnstile-response`: token Turnstile action `search`, bắt buộc và single-use.

Worker gọi Siteverify trước khi chạy FTS5, yêu cầu `success === true`, action `search`
và hostname nằm trong `TURNSTILE_HOSTNAMES`. Thiếu/sai/hết hạn/replay token trả
`403 forbidden`; response luôn `private, no-store`. Khi hợp lệ, response giữ nguyên
shape §2b. SearchOverlay debounce 400ms, huỷ request cũ bằng `AbortController`, rồi
reset widget sau mỗi attempt để request sau nhận token mới.

## 6. `GET /api/recommendation/:mediaType/:tmdbId` (+ alias `/api/related/:mediaType/:tmdbId`)

Nguồn: [ophim.js:143-153](../src/api/ophim.js#L143).

```jsonc
{ "items": [ /* legacy item */ ] }
```

`mediaType` ∈ `{movie, tv}` (client tự chuẩn hoá: khác `'tv'` → luôn `'movie'`). Không tìm
thấy phim/không có gợi ý → `{ "items": [] }`, **không 404** (client không catch riêng
trường hợp lỗi cho route này — 404 sẽ throw và làm vỡ UI thay vì hiện "không có gợi ý").
Alias `/api/related/...` — không tìm thấy tham chiếu nào tới nó trong `src/` hiện tại
(khác với ghi chú cũ trong CLAUDE.md/MODULES.md về "legacy alias") — **vẫn nên giữ** vì
rẻ (route giống hệt route chính, chỉ khác path) và MODULES.md ghi rõ đây là hợp đồng
tương thích ngược có chủ ý.

## 7. Ảnh — không cần sửa gì phía FE

- `posterUrl`/`thumbUrl` ([ophim.js:180-186](../src/api/ophim.js#L180)) là **passthrough
  thuần** — trả nguyên `poster_url`/`thumb_url` server gửi.
- `upstreamFallback` ([ophim.js:194-201](../src/api/ophim.js#L194)) chỉ kích hoạt khi URL
  bắt đầu bằng `https://img.bluesia.net/` (R2_BASE, đã xoá) — với URL TMDB/phimimg trực
  tiếp, hàm luôn trả `''`, khiến `attachImageFallback` thành no-op an toàn (không lỗi,
  không side-effect). **Không cần sửa `ophim.js`.**
- `HeroSlider.js` tự derive ảnh rail nhỏ (`w154`) bằng regex trên chuỗi
  `/t/p/w500/` ([HeroSlider.js:28-35](../src/modules/HeroSlider/HeroSlider.js#L28)) — hoạt
  động đúng với URL TMDB gốc, **không cần sửa**.

## 8. Mapper `MovieRow (D1) → legacy item` — dùng chung mọi route trả list

Nguồn đối chiếu: [`normalizeListItem`, ophim.js:217-238](../src/api/ophim.js#L217) — đây
là shape *sau khi* client normalize; server nên trả đúng luôn để cả `newMovies.items`
(không qua normalize) lẫn các rail khác (qua normalize) đều hiển thị đúng.

| Field legacy item | Nguồn D1 (`MovieRow`, `src-ssr/types/movie.ts`) | Ghi chú |
|---|---|---|
| `_id` | `slug` | **Không được đọc ở đâu trong `src/`** (grep xác nhận) — giá trị gì cũng được, dùng `slug` cho gọn |
| `name` | `title` | |
| `slug` | `slug` | |
| `origin_name` | `original_title` | |
| `thumb_url` | `thumb_path \|\| poster_path` | portrait, dùng cho card/rail |
| `poster_url` | `poster_path` | landscape/backdrop, dùng cho hero |
| `year` | `release_year` | |
| `type` | `type` | `'single' \| 'series' \| 'hoathinh' \| 'tvshows'` |
| `status` | `status` | |
| `quality` | `quality` | |
| `lang` | `lang` | |
| `episode_current` | `episode_current` | badge trên card ([PosterCard.js:73-92](../src/modules/PosterCard/PosterCard.js#L73)) |
| `time` | `runtime` | |
| `category` | `JSON.parse(genres_json)` | `[{name, slug}]` |
| `country` | `JSON.parse(countries_json)` | `[{name, slug}]` |
| `tmdb` | `{ id: tmdb_id, type: tmdb_type, season: tmdb_season }` | dùng để gọi `getRecommendation` |
| `imdb` | `{}` | dead code phía client, không ảnh hưởng hiển thị |
| `vote_average` | `vote_average` | **field điểm số duy nhất thực sự hiển thị** |
| `modified` | `{ time: new Date(last_synced * 1000).toISOString() }` | không thấy dùng ở đâu ngoài shape — điền cho đủ |

---

## Việc còn lại trước khi sang F2

- [x] Đọc `Grid.js` — pagination contract đã chốt (§2c)
- [x] Đọc `SearchOverlay.js` — xác nhận thuần client, không cần field mới
- [x] Đọc `Player.js` — xác nhận CSP cần `blob:`/`https:`/`unsafe-inline` (dùng ở F5, đã
      verify `artplayer` dist thật sự `createElement('style')`)
- [x] Đọc `HeroSlider.js`/`PosterCard.js`/`Carousel.js` — không phát sinh field mới ngoài
      legacy item chuẩn
- [x] `grep -rn "\._id"` — xác nhận `_id` chưa từng được đọc lại
- [x] **Sửa scope F4**: bỏ `director_json`, chỉ còn `actor_json`
