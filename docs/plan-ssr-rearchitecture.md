# Plan: Redflare "No VPS Edition" — SPA + JSON API → SSR trên D1

**Ngày lập:** 2026-08-07
**Nguồn yêu cầu:** "REDFLARE — Architecture & System Design Handoff v1.0"
**Quyết định kiến trúc:** [ADR-0002](adr/0002-no-vps-ssr-architecture.md) — đọc trước, plan này
chỉ là cách thi hành 9 action item của nó
**Tracking:** [state-ssr-rearchitecture.md](state-ssr-rearchitecture.md) — **cập nhật file đó
mỗi khi một phase đổi trạng thái**, không dựa vào git log
**Liên quan:** [ADR-0001](adr/0001-caching-topology.md) (plan này đóng nốt Action Item 7),
[plan-hit-rate.md](plan-hit-rate.md) (đã xong Phase 0–6, 8, 9),
[plan-kkphim-migration.md](plan-kkphim-migration.md) (nguồn catalog hiện tại)

> Mọi giới hạn Cloudflare trong plan này **đã tra lại doc ngày 2026-08-07**, không đọc từ
> trí nhớ — xem bảng trong ADR-0002 § "What I verified rather than assumed". Đặc biệt: 2 hạn
> mức quyết định nhất (**D1 100.000 rows written/ngày**, **cache HIT vẫn tính request**)
> **không có** trong tài liệu limit mà handoff trích dẫn.

---

## §0. Ba điều cần thống nhất trước khi gõ dòng code đầu tiên

### 0.1 Mục tiêu 1.000.000 pv/ngày ≠ 0 USD

Không phải vấn đề kỹ thuật, là vấn đề tính tiền. Free = 100.000 request/ngày, và
**cache HIT vẫn bị tính là 1 request** (doc Cloudflare: *"requests served from the Worker's
cache are billed at the same per-request rate"*). Hit rate 99% cũng không cứu được: 1M pv =
1M request = **10× hạn mức**, vượt thì Error 1027 — mất trang, không phải chậm trang.

- **Free:** trần ~100.000 pv/ngày.
- **Workers Paid:** 1M pv/ngày ≈ 30M req/tháng = $5 + 20M × $0.30/M ≈ **$11/tháng**.

**Plan này build free-first.** Code, schema, cache strategy **giống hệt nhau** ở cả hai gói —
lên Paid là bật công tắc, không phải viết lại. Phase 6 thêm bộ đếm quota để nhìn thấy trần
trước khi đâm vào nó.

### 0.2 Backfill lạnh: ~30 ngày trên Free, ~1–2 giờ trên Paid

~73 row ghi/phim × 40.000 phim ≈ **2,9 triệu row**.

> **Đính chính 2026-08-07:** bản đầu plan này ghi 38 row/phim → ~15 ngày. **Sai, thiếu một
> nửa.** Doc pricing Cloudflare: *"Indexes will add an additional written row when writes
> include the indexed column"* — mỗi index là **1 row ghi riêng**. Schema §1.2 có 8 index, nên
> chi phí thật gấp ~2 lần. Con số đúng là ~73 row/phim.

| Gói | Hạn mức ghi | Backfill 40.000 phim | Phát sinh |
|---|---|---|---|
| **Free** | 100.000 row/**ngày** | ~1.370 phim/ngày → **~30 ngày** | $0 |
| **Paid $5** | 50 triệu row/**tháng**, không cap ngày | giới hạn bởi throughput → **~1–2 giờ** | **$0** (2,9M = 6% quota tháng) |

Trên Paid, nút thắt rời khỏi Cloudflare. Ceiling mỗi invocation thành 10.000 subrequest / 5 phút
CPU / 15 phút wall. Thứ **không** đổi giữa hai gói là **6 kết nối ra đồng thời** — nên 1
invocation ≈ 12 req/s, fan-out N con ≈ `N × 12` req/s.

**Nhưng phải tự bóp ga ở ~20–30 req/s.** `phimapi.com` là API cộng đồng miễn phí, và dự án này
**đã mất một nguồn catalog rồi** — `ophim1.com` 500 toàn bộ endpoint ngày 2026-08-06, kéo cả
site sập theo. Bị ban IP khỏi nguồn thay thế là kết cục tệ nhất có thể, và là tự gây ra. Ở
25 req/s, 120.000 call ≈ **80 phút** — vẫn là "trong hôm nay", mà nguồn còn nguyên. Throttle
TMDB và phimapi riêng (TMDB chịu tải cao hơn nhiều).

Hệ quả cho thứ tự phase: **site cũ phải sống song song trong suốt backfill.** Không cutover
được cho tới khi D1 có đủ dữ liệu.

### 0.2b Nếu chỉ giữ Paid 1 tháng rồi về Free — điều kiện bắt buộc

Về Free an toàn **chỉ khi DB < 500 MB**. Free giới hạn 500 MB/database và doc D1 nói rõ: vượt
→ lỗi `Exceeded maximum DB size`, **ghi hỏng** (đọc vẫn được — trang vẫn render, nhưng ngừng
cập nhật im lặng, đúng loại lỗi khó thấy nhất).

- 40.000 phim catalog ≈ **~180 MB** ước tính → an toàn.
- **Tầng stub (Phase 4) là thứ đẩy qua ngưỡng.** Trong tháng Paid này: **để `MAX_STUBS = 0`**,
  bật sau khi đã đo dung lượng thật.
- Ghi thường ngày sau khi về Free: ~10k row × 2 (index) ≈ **20k/ngày** trên hạn mức 100k → an toàn.
- **Đo `SELECT COUNT(*)` + dung lượng DB trước khi hạ gói.** Không đoán.

Lưu ý hoá đơn: quota tháng của Paid reset theo **ngày đăng ký**, không theo ngày 1. Đăng ký
07-08 ⇒ chu kỳ tới 07-09 — huỷ trước ngày đó nếu không muốn bị tính tháng thứ hai.

### 0.3 Đây là viết lại, không phải refactor

Ngôn ngữ đổi (JS → TS), mô hình render đổi (client → server), storage đổi (KV+R2+D1 → D1).
Cách an toàn duy nhất: **worker mới nằm cạnh worker cũ**, cùng repo, khác entry point, chuyển
route dần bằng `routes` trong `wrangler.toml`. Không sửa tại chỗ `worker/index.js`.

**URL phải giữ nguyên 100%.** `/`, `/phim/:slug`, `/danh-sach/:type`, `/the-loai/:slug`,
`/quoc-gia/:slug`, `/tim-kiem` ([src/main.js:301-306](../src/main.js:301)) — đây là toàn bộ vốn
SEO đang có. Đổi URL = reset từ đầu.

---

## §1. Bản đồ phase

| Phase | Nội dung | Kết quả kiểm chứng được | Phụ thuộc |
|---|---|---|---|
| **1** | Khung TS + Hono, schema D1, repository | `wrangler dev` trả 1 trang detail từ D1 seed tay | — |
| **2** | Cron sync: metadata + episode | 500 phim thật trong D1, `source_hash` chặn ghi lặp | 1 |
| **3** | SSR + SEO đầy đủ (detail, list, genre, country) | 4 route render HTML hợp lệ, JSON-LD pass Rich Results | 1, 2 |
| **4** | Recommendation 3 tầng + stub | Trang detail có block gợi ý, không phim nào bị ẩn sai | 2, 3 |
| **5** | Workers Caching + purge theo tag + header bảo mật | `cf-cache-status: HIT` mà Worker không chạy; purge 1 slug hiệu lực | 3 |
| **6** | Search FTS5 + sitemap + robots + health/quota | `/tim-kiem` không gọi mạng ngoài; sitemap index đủ URL | 2, 3 |
| **7** | Backfill toàn catalog (~15 ngày, chạy nền) | `movie` ≥ 40.000 row, governor không vượt quota ngày nào | 2 |
| **8** | Cutover: chuyển route sang worker mới | 6 URL cũ trả SSR; SPA cũ tắt | 3–7 |
| **9** | Dọn nợ: xoá R2, KV, mirror, `dist/` cũ | binding còn lại đúng 1 (D1); wrangler.toml sạch | 8 |

Phase 1–6 làm được song song với site cũ đang chạy. Phase 7 tốn thời gian thực (lịch, không
phải công). Phase 8 là điểm không quay lại — làm sau cùng.

---

## Phase 1 — Khung dự án + schema D1

**Mục tiêu:** dựng bộ xương chạy được, chưa có dữ liệu thật.

### 1.1 Cấu trúc

Theo đúng handoff, đặt dưới `src-ssr/` để không đụng `src/` (SPA cũ vẫn phải build được):

```
src-ssr/
  index.ts            entry, export default { fetch, scheduled }
  routes/             home, detail, list, genre, country, search, sitemap
  render/             layout.ts, components/*.ts  (template literal, không JSX)
  repositories/       movie, episode, recommendation, genre, country
  services/sync/      kkphim.ts, tmdb.ts, normalize.ts, upsert.ts
  seo/                jsonld.ts, meta.ts, canonical.ts
  middleware/         security-headers.ts, validate.ts, cache-key.ts
  db/                 client.ts, chunk.ts
  cache/              tags.ts, control.ts
  types/
```

`render/` dùng **template literal có escape bắt buộc**, không JSX/framework — 15-30 KB HTML
không cần runtime render nào cả, và mỗi KB bundle đều ăn vào startup time 1s.

### 1.2 Schema — `migrations/0005_ssr_schema.sql`

Khác handoff ở 3 chỗ, lý do đầy đủ ở ADR-0002 Finding 1/3/6:

```sql
CREATE TABLE movie (
  slug               TEXT PRIMARY KEY,        -- F1: KKPhim slug, KHÔNG phải tmdb_id
  tmdb_id            INTEGER,                 -- nullable, KHÔNG unique
  tmdb_type          TEXT,                    -- 'movie' | 'tv'
  tmdb_season        INTEGER,
  title              TEXT NOT NULL,
  original_title     TEXT,
  overview           TEXT,
  poster_path        TEXT,                    -- TMDB path HOẶC phimimg URL đầy đủ
  backdrop_path      TEXT,
  poster_host        TEXT NOT NULL,           -- 'tmdb' | 'phimimg'  (F8: CSP + chọn host)
  release_year       INTEGER,
  runtime            TEXT,                    -- KKPhim trả chuỗi ("120 phút"), không phải số
  vote_average       REAL,
  vote_count         INTEGER,
  status             TEXT,
  episode_current    TEXT,
  quality            TEXT,
  lang               TEXT,
  type               TEXT NOT NULL,           -- single|series|hoathinh|tvshows
  genres_json        TEXT NOT NULL DEFAULT '[]',
  countries_json     TEXT NOT NULL DEFAULT '[]',
  has_stream         INTEGER NOT NULL DEFAULT 0,
  stream_count       INTEGER NOT NULL DEFAULT 0,
  youtube_trailer_key TEXT,
  tier               TEXT NOT NULL DEFAULT 'catalog',  -- F3: 'catalog' | 'stub'
  source_hash        TEXT NOT NULL,           -- F2: chặn ghi no-op
  last_synced        INTEGER NOT NULL
);
CREATE INDEX idx_movie_tmdb   ON movie(tmdb_type, tmdb_id) WHERE tmdb_id IS NOT NULL;
CREATE INDEX idx_movie_type   ON movie(type, last_synced DESC);
CREATE INDEX idx_movie_synced ON movie(last_synced DESC);

CREATE TABLE episode (
  slug        TEXT NOT NULL,
  server      TEXT NOT NULL,
  ep_slug     TEXT NOT NULL,
  ep_name     TEXT NOT NULL,
  sort_order  INTEGER NOT NULL,
  link_m3u8   TEXT,
  link_embed  TEXT,
  PRIMARY KEY (slug, server, ep_slug)
);
CREATE INDEX idx_episode_movie ON episode(slug, sort_order);

CREATE TABLE recommendation (               -- F3
  slug           TEXT NOT NULL,
  target_slug    TEXT,                      -- NULL = chưa materialize
  target_tmdb_id INTEGER NOT NULL,
  target_type    TEXT NOT NULL,
  sort_order     INTEGER NOT NULL,
  PRIMARY KEY (slug, target_tmdb_id, target_type)
);
CREATE INDEX idx_rec_lookup ON recommendation(slug, sort_order);
CREATE INDEX idx_rec_target ON recommendation(target_tmdb_id, target_type);

CREATE TABLE genre   (slug TEXT PRIMARY KEY, name TEXT NOT NULL);   -- F6
CREATE TABLE country (slug TEXT PRIMARY KEY, name TEXT NOT NULL);   -- F6
CREATE TABLE genre_movie   (genre_slug   TEXT NOT NULL, slug TEXT NOT NULL, PRIMARY KEY (genre_slug, slug));
CREATE TABLE country_movie (country_slug TEXT NOT NULL, slug TEXT NOT NULL, PRIMARY KEY (country_slug, slug));
CREATE INDEX idx_gm_list ON genre_movie(genre_slug, slug);
CREATE INDEX idx_cm_list ON country_movie(country_slug, slug);

CREATE TABLE sync_state (                   -- F2
  key        TEXT PRIMARY KEY,              -- 'cursor:recent' | 'cursor:backfill' | 'rows:YYYY-MM-DD'
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

**Chưa tạo `fts_movie` ở phase này** — Phase 6, vì mỗi row FTS cũng ăn quota ghi và không nên
trả giá đó trong lúc còn đang đổi schema.

### 1.3 `db/chunk.ts` — hàng rào 100 tham số

Bài học đắt nhất của lần migration trước (`CLAUDE.md`: *"D1's undocumented 100-bound-param-per-
query cap silently rejecting large batch inserts"*). Lần này nó là hằng số, không phải phát hiện:

```ts
export const D1_MAX_PARAMS = 100;
export function chunkByParams<T>(rows: T[], paramsPerRow: number): T[][]
```

`movie` có ~26 cột → **3 row/statement**. Repository không được phép build SQL nhiều row mà
không đi qua hàm này.

**Verify Phase 1:** `npx wrangler d1 migrations apply redflare-db --remote`; INSERT tay 1 phim;
`wrangler dev --remote` trả HTML detail có `<h1>` đúng tên phim.

---

## Phase 2 — Cron sync (metadata + episode)

**Mục tiêu:** dữ liệu thật vào D1, ghi đúng ngân sách.

### 2.1 Thuật toán incremental

```
cron */30
  ├─ đọc sync_state 'cursor:recent'
  ├─ GET phimapi.com/danh-sach/phim-moi-cap-nhat?page=1..N
  │    dừng khi gặp slug có modified.time <= cursor  → chỉ phim đổi
  ├─ fan-out qua SELF: /__sync/batch/:n  (mỗi shard ≤ 15 phim)
  │    └─ mỗi phim: GET /phim/{slug} → nếu tmdb.id: GET TMDB detail
  │                 normalize → FNV-1a → so source_hash
  │                 khác  → UPSERT (movie + episode + genre_movie + country_movie)
  │                 giống → bỏ qua HOÀN TOÀN, 0 row ghi
  └─ ghi cursor mới + cộng dồn sync_state 'rows:YYYY-MM-DD'
```

**Ngân sách mỗi invocation:** 50 subrequest (D1 cũng tính!) → ~15 phim × 3 call HTTP = 45,
chừa 5 cho D1 batch. CPU 10ms là đủ; wall time 15 phút thừa thãi.

### 2.2 Governor ghi — bắt buộc

Trước mỗi shard, đọc `rows:<hôm nay>`. Nếu ≥ `MAX_ROWS_PER_DAY` (đặt **85.000**, chừa 15% cho
Phase 4/6/7 và cho sai số) → shard return ngay, không ghi gì. Không có governor thì backfill sẽ
ăn hết quota và **sync thường ngày chết im lặng** — đúng loại lỗi khó thấy nhất, vì trang vẫn
render bình thường bằng dữ liệu cũ.

### 2.3 Idempotency + phục hồi lỗi

- UPSERT `ON CONFLICT DO UPDATE` — chạy lại cùng payload không tạo row mới.
- `source_hash` làm luôn nhiệm vụ idempotency key: chạy lại lần 2 ghi **0 row**.
- Một phim lỗi (TMDB 500, timeout) → bỏ qua phim đó, **không** rollback cả shard, **không**
  đẩy cursor qua nó. Lần cron sau tự gặp lại.
- Cursor chỉ tiến khi cả shard xong sạch. Thà làm lại 15 phim còn hơn bỏ sót 1.
- **`AbortSignal.timeout(5000)`, không retry.** Đây là cron, không phải request người dùng —
  bỏ qua rồi thử lại sau 30 phút rẻ hơn nhiều so với cơ chế 8s × 2 lần thử đã sinh ra 11,4%
  504 ở kiến trúc cũ ([state-hit-rate.md](state-hit-rate.md) Phase 10).

**Verify Phase 2:** chạy `/__sync/batch/0` 2 lần liên tiếp → lần 2 báo `written: 0`.
`SELECT COUNT(*) FROM movie` ≥ 500 sau vài tick.

---

## Phase 3 — SSR + SEO

**Mục tiêu:** 4 route render HTML thật từ D1, đủ tín hiệu SEO.

### 3.1 Ngân sách truy vấn mỗi trang

Trang detail = **đúng 3 truy vấn**, không hơn:

1. `SELECT * FROM movie WHERE slug = ?`
2. `SELECT * FROM episode WHERE slug = ? ORDER BY sort_order`
3. `SELECT m.* FROM recommendation r JOIN movie m ON m.slug = r.target_slug WHERE r.slug = ? ORDER BY r.sort_order LIMIT 12`

Truy vấn 3 là JOIN, **không phải** vòng lặp `getMovie()` — D1 đơn luồng, 12 round-trip tuần tự
là 12× độ trễ. Đây là lý do repository chỉ được expose method batch (ADR-0002).

Trang list/genre/country: 1 COUNT + 1 SELECT LIMIT 24. **Keyset pagination** theo
`(last_synced, slug)`, không `OFFSET` — `OFFSET 10000` bắt D1 quét 10.000 row và **tính đủ
10.000 vào quota đọc**.

### 3.2 SEO tối thiểu mỗi trang

`<title>`, meta description (cắt từ overview, ≤160 ký tự), canonical tuyệt đối, OG + Twitter
Card, JSON-LD (`Movie`/`TVSeries` + `BreadcrumbList`), `<h1>` duy nhất, internal link sang
genre/country/recommendation.

`hreflang` bỏ qua — site chỉ có tiếng Việt.

### 3.3 Player

- `has_stream = 1` → CTA "▶ Xem Ngay", route `/xem/:slug/:ep`, **đây là trang duy nhất được
  hydrate** (hls.js + artplayer). `noindex` trang xem — nội dung trùng trang detail.
- `has_stream = 0` → CTA "▶ Xem Trailer", nhúng YouTube bằng `<lite-youtube>` facade (ảnh tĩnh
  + click mới load iframe). Nhúng iframe thẳng kéo ~700 KB JS bên thứ ba vào trang mà mục đích
  cả kiến trúc này là làm cho nhẹ.

**Verify Phase 3:** `curl` 4 route → HTML hợp lệ, không có `<script>` nào ngoài trang xem;
JSON-LD pass Google Rich Results Test; HTML ≤ 30 KB.

---

## Phase 4 — Recommendation 3 tầng

Theo ADR-0002 Finding 3. Sync ghi `recommendation` với `target_slug = NULL`, rồi một bước
resolve riêng:

```
resolve: SELECT target_tmdb_id, target_type, COUNT(*) c
         FROM recommendation WHERE target_slug IS NULL
         GROUP BY 1,2 ORDER BY c DESC           -- được nhiều phim trỏ tới nhất trước
  ├─ GET phimapi.com/tmdb/{type}/{id}           -- endpoint KKPhim, §0.2 plan-kkphim
  │    có   → phim trong catalog, UPDATE target_slug
  │    không→ nếu c >= 2 và stub_count < MAX_STUBS (20.000) → tạo row tier='stub' từ TMDB
  │           ngược lại → để NULL (tầng overflow, không render)
```

`/tmdb/{movie|tv}/{tmdb_id}` là nâng cấp thật so với `matchViaSearch` hiện tại
([recommendation.js:199](../worker/lib/recommendation.js:199)) vốn *"đoán mò bằng keyword
search, match sai được"*.

Stub **không có recommendation của riêng nó** — crawl depth dừng ở đó, nếu không cây sẽ nở vô hạn.

**Verify Phase 4:** trang detail của 1 phim nhiều tập hiện ≥ 6 gợi ý; `SELECT COUNT(*) FROM
movie WHERE tier='stub'` ≤ MAX_STUBS.

---

## Phase 5 — Workers Caching + bảo mật

### 5.1 Bật Workers Caching

```toml
[cache]
enabled = true
```

Đây là Action Item 7 còn treo của ADR-0001. Khác Cache API ở 3 điểm quyết định (bảng đầy đủ
trong ADR-0002 Finding 4): **HIT không chạy Worker** (không tốn CPU, không rủi ro 10ms),
**gộp request đồng thời** (bảo vệ D1 đơn luồng khỏi thundering herd), và **purge theo tag**.

### 5.2 Header

```
Cache-Control: public, max-age=60, stale-while-revalidate=86400, stale-if-error=604800
Cache-Tag: movie:<slug>, tier:detail
```

**Không `s-maxage`** — handoff đề xuất `s-maxage=1800` nhưng chính nó vô hiệu hoá
`stale-while-revalidate` đứng ngay cạnh (`s-maxage` mang ngữ nghĩa `proxy-revalidate`). Dự án
này đã tìm ra và sửa đúng lỗi đó ở [state-hit-rate.md](state-hit-rate.md) Quyết định 2 — thêm
lại là quay ngược công đã làm.

ETag suy ra, không hash body: `W/"<slug>-<last_synced>-<TEMPLATE_VERSION>"`.

### 5.3 Purge chính xác

Cron sync gom slug đã đổi → `ctx.cache.purge({ tags: ['movie:a', 'movie:b'] })`. Thay hẳn bài
học cũ trong `CLAUDE.md` (*"Purge Everything trên dashboard"*) vốn đã gây một sự cố thật ở lần
migration ảnh 2026-08-04.

### 5.4 Bảo mật

- Validate: slug `^[a-z0-9-]{1,120}$`, page integer clamp `[1,500]`, `q` ≤ 100 ký tự — **từ
  chối**, không sanitize.
- Chuẩn hoá cache key: chỉ giữ allow-list `page`, `q`; 301 về canonical. Chặn `?utm_*` sinh
  cache entry vô hạn (cache poisoning qua cardinality).
- Escape mọi giá trị vào HTML. Chỗ nguy hiểm nhất là trang search echo lại `q` — XSS ở đó sẽ
  được **cache lại**, tức là XSS lưu trữ.
- CSP không `unsafe-inline`; `img-src` liệt kê `image.tmdb.org` + `phimimg.com`. Kèm HSTS,
  `nosniff`, `Referrer-Policy`, `Permissions-Policy`.
- Cron route giữ `x-cron-key`, so sánh constant-time, trả **404** (không 403) để không lộ route.

**Verify Phase 5:** request 2 → `cf-cache-status: HIT` **và** không có log Worker chạy;
purge 1 tag → chỉ trang đó rebuild; `curl -I` đủ 5 header bảo mật.

---

## Phase 6 — Search, sitemap, quota

- **FTS5**: `CREATE VIRTUAL TABLE fts_movie USING fts5(title, original_title, slug UNINDEXED,
  tokenize='unicode61 remove_diacritics 2')` — `remove_diacritics 2` là bắt buộc cho tiếng
  Việt (gõ "hanh dong" phải ra "hành động"). **Lưu ý `đ`/`Đ`**: unicode61 chỉ bỏ dấu tổ hợp,
  `đ` là chữ cái riêng nên không tự thành `d` — cần chuẩn hoá tay khi ghi index *và* khi
  parse query, nếu không "dien vien" sẽ không khớp "diễn viên". Ghi cùng batch với `movie`,
  không tách riêng.
- **Sitemap**: `/sitemap.xml` (index) + `/sitemap-<n>.xml` (50.000 URL/shard), `<lastmod>` từ
  `last_synced`, cache như mọi trang khác. `/robots.txt` trỏ tới nó.
- **Quota**: bộ đếm request/ngày + `/api/health` báo `% of 100k`. Nhìn thấy trần trước khi
  đâm vào Error 1027 (ADR-0002 Finding 7).

---

## Phase 7 — Backfill

`cursor:backfill` quét toàn bộ `/danh-sach/*` phân trang, cùng đường ghi như Phase 2, chạy
**sau** governor của sync thường ngày (sync mới ưu tiên hơn backfill — dữ liệu mới quan trọng
hơn dữ liệu cũ).

**Hai chế độ, chọn bằng biến môi trường, cùng một đoạn code:**

| | `BACKFILL_MODE=free` | `BACKFILL_MODE=burst` (Paid) |
|---|---|---|
| Trigger | cron `*/30` | route tay `/__sync/backfill` + `waitUntil` |
| Fan-out | 5 shard | 40–60 shard qua `SELF` |
| Governor ghi | 85.000 row/ngày | tắt (quota tháng, không phải ngày) |
| Throttle ra | không cần | **bắt buộc ~25 req/s tổng** (§0.2) |
| Thời gian | ~30 ngày | ~80 phút |

Chế độ `burst` là lý do duy nhất để trả $5. Viết nó ngay từ đầu ở Phase 2 (chỉ là tham số của
orchestrator), đừng để thành việc riêng.

**Theo dõi trong lúc burst chạy:** `movie` count mỗi 5 phút, tỉ lệ lỗi theo nguồn (phimapi vs
TMDB tách riêng), và **dừng ngay nếu phimapi bắt đầu trả 429/403** — đó là dấu hiệu sắp bị ban,
không phải lỗi tạm thời.

**Sau khi burst xong, trước khi hạ gói:** đo dung lượng DB thật, đối chiếu ngưỡng 500 MB ở
§0.2b, rồi mới quyết định bật `MAX_STUBS`.

---

## Phase 8 — Cutover

Điểm không quay lại. Thứ tự:

1. Thêm route worker mới cho **1 path ít traffic trước** (`/quoc-gia/*`), quan sát 24h.
2. Rồi `/the-loai/*`, `/danh-sach/*`, `/phim/*`, `/tim-kiem`, cuối cùng `/`.
3. Mỗi bước: so TTFB + tỉ lệ lỗi với trang tương ứng của SPA cũ trước khi đi tiếp.
4. **Purge Everything một lần** ở bước cuối — URL ảnh đổi host (R2 → TMDB/phimimg), và
   `CLAUDE.md` đã ghi rõ entry Cache API cũ *"sẽ không tự lành"*.
5. Submit lại sitemap trong Search Console.

Rollback: đổi `routes` về worker cũ. Giữ được chừng nào Phase 9 chưa chạy — nên **đợi ít nhất
1 tuần** giữa Phase 8 và 9.

---

## Phase 9 — Dọn nợ

Sau khi Phase 8 ổn định ≥ 7 ngày: xoá `worker/` cũ, `src/` SPA, binding KV + R2 + service
`SELF` không còn dùng, cron `*/10` (mirror), bảng D1 `stale`/`idx`/`recs`/`mirrored`/
`mirror_queue`/`popularity`/`cache_stats`, và ~3.600 object trong R2. Viết lại `CLAUDE.md`.

**Chỉ còn 1 binding: D1.** Đó là thước đo thành công của cả plan.

---

## §2. Rủi ro đã biết

| Rủi ro | Xác suất | Giảm thiểu |
|---|---|---|
| Backfill ăn hết quota ghi, sync ngày chết im | Cao (Free) / Không (Paid) | Governor Phase 2.2, sync ưu tiên hơn backfill |
| **Bị phimapi.com ban IP vì burst quá nhanh** | **Trung bình nếu không throttle** | Trần 25 req/s; dừng ngay khi thấy 429/403. Mất nguồn = mất tất cả (OPhim đã chết 1 lần) |
| Hạ Paid → Free khi DB > 500 MB, ghi hỏng im lặng | Trung bình | `MAX_STUBS = 0` tháng này; đo dung lượng trước khi hạ (§0.2b) |
| Ảnh phimimg nhiều MB làm hỏng LCP mobile | Trung bình | Ưu tiên path TMDB; đo trước khi tính lại R2 (ADR-0002 F8) |
| 200k phim vượt 500 MB/DB | Thấp ở 40k | Gate ở 400 MB đo được; **không build shard sớm** |
| Chạm 100k request/ngày | Trung bình | Bộ đếm Phase 6; đường thoát là Paid $11/tháng |
| Mất traffic sau cutover | Trung bình | Giữ nguyên URL; cutover từng path; rollback 1 tuần |
| KKPhim chết như OPhim đã chết | Đã xảy ra 1 lần | Kiến trúc này **miễn nhiễm ở runtime** — nguồn chết chỉ làm dữ liệu cũ đi, trang vẫn render |

Ô cuối là lợi ích lớn nhất và ít được nói tới nhất của cả thiết kế: 2026-08-06 OPhim chết sạch,
site sập theo. Với kiến trúc này, nguồn chết = dữ liệu ngừng cập nhật. Trang vẫn phục vụ.
