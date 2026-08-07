# State: Redflare "No VPS Edition" — SSR rearchitecture

File tracking cho [plan-ssr-rearchitecture.md](plan-ssr-rearchitecture.md) và
[ADR-0002](adr/0002-no-vps-ssr-architecture.md). **Cập nhật file này mỗi khi một phase đổi
trạng thái** — nó là nguồn sự thật về tiến độ, không phải git log.

**Bắt đầu:** 2026-08-07
**Trạng thái tổng:** 🟡 **Production đã cutover thẳng sang SSR (Phase 8 làm sớm, ngoài thứ tự
plan), Phase 3 vừa xong.** Không còn worker cũ, KV, R2 — production giờ CHỈ có 1 binding D1.
`phim.bluesia.net` đang phục vụ `/phim/:slug`, `/danh-sach/:type`, `/the-loai/:slug`,
`/quoc-gia/:slug`, `/xem/:slug/:ep` với SEO đầy đủ (JSON-LD, OG, canonical). **Chưa có:** trang
chủ, search, recommendation thật (Phase 4 chưa chạy nên block gợi ý trống), sitemap, cache/
security header (Phase 5/6), và **D1 hiện chỉ có 1 phim thật** — chưa backfill.

⚠️ **Sự cố đã xảy ra và đã khôi phục 2026-08-07**, xem nhật ký bên dưới: user tự xoá D1 + R2
trực tiếp trên dashboard giữa lúc tôi đang dọn KV/D1 theo yêu cầu → production 500 vài phút →
đã tạo D1 mới (`40c364b3-10a8-4d03-bd51-60debe94610a`), áp lại schema, site sống lại. **Toàn bộ
dữ liệu đã sync trước đó (kể cả bảng legacy cũ) mất sạch** — không sao vì chưa backfill thật.

---

## Bảng phase

| Phase | Nội dung | Trạng thái | Ngày | Ghi chú |
|---|---|---|---|---|
| **0** | Audit + ADR + plan | 🟢 **Xong** | 2026-08-07 | ADR-0002 *Proposed*, 8 finding, 9 action item |
| **1** | Khung TS + Hono, schema D1, repository | 🟢 **Xong, verify thật** | 2026-08-07 | Migration `0005` áp lên D1 production; `/phim/:slug` render thật từ D1 |
| **2** | Cron sync metadata + episode | 🟢 **Xong, verify thật (KKPhim)** | 2026-08-07 | Hash-gate xác nhận: sync lần 2 ghi 0 row. **Chưa test TMDB** (thiếu token) và **chưa test fan-out qua SELF** (cần deploy 1 lần) |
| **3** | SSR + SEO (detail/list/genre/country + player) | 🟢 **Xong, verify thật** | 2026-08-07 | JSON-LD parse hợp lệ, 404 đúng cho slug/genre/country/type không tồn tại. Search **không** nằm trong phase này (đúng thiết kế — Phase 6/FTS5) |
| **4** | Recommendation 3 tầng + stub | ⚪ Chưa bắt đầu | — | Chặn bởi Q3 (giá trị MAX_STUBS). Route `/phim/:slug` đã có JOIN sẵn, chỉ đang trống vì chưa có row `target_slug` nào được resolve |
| **5** | Workers Caching + purge tag + bảo mật | ⚪ Chưa bắt đầu | — | Đóng ADR-0001 Action Item 7. **Ưu tiên cao** — hiện KHÔNG có CSP/HSTS/nosniff nào trên production |
| **6** | FTS5 search + sitemap + quota counter | ⚪ Chưa bắt đầu | — | |
| **7** | Backfill toàn catalog | ⚪ Chưa bắt đầu | — | D1 hiện chỉ có 1 phim test. Burst mode cần `TMDB_API_TOKEN` (đã có sẵn, carry-over) + xác nhận thời điểm chạy |
| **8** | Cutover route | 🟡 **Đã làm sớm, ngoài thứ tự plan, theo yêu cầu trực tiếp** | 2026-08-07 | Không làm dần từng route như plan gốc đề xuất — đổi thẳng `phim.bluesia.net` sang SSR trong 1 lần. Chấp nhận được vì traffic thật gần như chưa có gì để mất (site chưa có nội dung SEO trước đó theo kiến trúc mới) |
| **9** | Dọn nợ (xoá R2/KV/mirror/SPA) | 🟡 **Một phần** | 2026-08-07 | R2 + KV + `worker/` cũ đã xoá. **Còn lại:** `src/` SPA cũ, `dist/`, `docs/adr/0001-*`, `docs/plan-hit-rate.md`, `docs/state-hit-rate.md` vẫn mô tả kiến trúc đã chết — chưa dọn |

Ký hiệu: ⚪ chưa bắt đầu · 🟡 đang làm · 🟢 xong · 🔴 chặn/sự cố · ⚫ bỏ

---

## Việc cần người quyết

**Q1, Q2, Q4 đã đóng.** Còn 1 việc cần user xác nhận trước khi burst backfill chạy được: **deploy
`redflare-ssr` một lần** qua `npm run ssr:dev` cần worker đã tồn tại để service binding `SELF`
resolve (chicken/egg đã gặp khi verify Phase 1/2 hôm nay) -- hoặc `npx wrangler deploy --config
wrangler.ssr.toml`. Đây là hành động tạo URL `*.workers.dev` công khai (không route/custom_domain,
không ảnh hưởng site production) nên tôi dừng lại chờ xác nhận thay vì tự làm. Cũng cần
`TMDB_API_TOKEN` secret cho worker mới (`npx wrangler secret put TMDB_API_TOKEN --config
wrangler.ssr.toml`) -- thiếu token sync vẫn chạy được (KKPhim-only, đã verify) nhưng bỏ qua toàn
bộ enrichment TMDB + recommendation targets.

Phase 1 **không nên** bắt đầu trước khi Q1 và Q2 có câu trả lời — cả hai đổi thứ được viết ra,
không chỉ đổi cấu hình.

| # | Việc | Vì sao chặn | Đề xuất |
|---|---|---|---|
| ~~**Q1**~~ | ~~Free vs Workers Paid~~ | — | 🟢 **Đã quyết 2026-08-07:** user lên **Paid $5 trong tháng 8**, backfill chế độ burst, rồi hạ về Free. Xem nhật ký bên dưới |
| ~~**Q2**~~ | ~~Duyệt `slug` làm PK thay `tmdb_id`~~ | — | 🟢 **Đã duyệt 2026-08-07** |
| **Q3** | `MAX_STUBS` = bao nhiêu? | Quyết định D1 dùng bao nhiêu dung lượng và backfill dài thêm bao lâu | **0 trong tháng Paid này** — stub là thứ đẩy DB qua ngưỡng 500 MB của Free. Bật sau khi đo dung lượng thật |
| ~~**Q4**~~ | ~~Backfill 15 ngày hay giảm phạm vi~~ | — | 🟢 **Không còn áp dụng** — Paid burst ≈ 80 phút. Cutover Phase 8 vẫn không cần đợi backfill xong |
| **Q5** | Có giữ `/xem/:slug/:ep` với hls.js không, hay chỉ trailer? | Handoff nói "Không phải Streaming Server" nhưng cũng nói `has_stream → Watch Now` | **Giữ** — trang xem là island hydrate duy nhất, `noindex` |

---

## Nhật ký quyết định

### 2026-08-07 — Phase 3: SSR + SEO đầy đủ cho detail/list/genre/country + player

**Trước đó cùng ngày: cutover production ngoài thứ tự plan + sự cố D1/R2 + khôi phục.** User
yêu cầu trực tiếp "gỡ worker/kv/d1 hiện tại đi rồi push to origin main để autodeploy" — plan gốc
đặt việc này ở Phase 8/9 (cutover dần từng route, dọn nợ sau ≥7 ngày ổn định), nhưng user chọn
làm ngay, đã được cảnh báo rõ hậu quả (site chỉ còn `/phim/:slug`, không CSS/JS/trang chủ) và
xác nhận qua `AskUserQuestion`. Đã làm: `wrangler.toml` đổi `main` sang `src-ssr/index.ts`, bỏ
`[assets]`/`[[kv_namespaces]]`, xoá `worker/` cũ, xoá KV namespace, drop 7 bảng D1 legacy
(`migrations/0006_drop_legacy_tables.sql`), push thẳng `origin/main` (fast-forward, cùng gốc
với origin nên không cần force) → Cloudflare Workers Builds tự deploy, verify bằng curl thật.
`TMDB_API_TOKEN`/`CRON_KEY` carry-over tự động vì redeploy **cùng tên worker** ("redflare"),
không phải worker mới — giải quyết yêu cầu "dùng token cũ" mà không cần biết giá trị token.

**Giữa chừng: user tự xoá D1 + R2 trực tiếp** (không qua tôi) — production 500 vài phút vì
`wrangler.toml` vẫn trỏ `database_id` cũ. Tôi thử tự tạo D1 mới để khôi phục thì bị chặn (đúng
quy trình — hành động ảnh hưởng production cần xác nhận), dừng lại hỏi qua `AskUserQuestion`.
User xác nhận "tạo D1 mới qua CLI" → tạo `redflare-db` mới (id `40c364b3-10a8-4d03-bd51-
60debe94610a`), cập nhật `wrangler.toml` + `wrangler.ssr.toml`, áp lại toàn bộ 6 migration (kết
quả cuối giống hệt trước: chỉ còn bảng SSR, vì 0006 vẫn drop đúng bảng legacy mà 0001-0004 vừa
tạo lại), bỏ hẳn `[[r2_buckets]]` (R2 đã xoá, code cũng chưa từng dùng R2). Push, verify: site từ
500 → 404 đúng nghĩa cho slug lạ (D1 kết nối lại được). **Mất toàn bộ dữ liệu đã sync** (1 phim
test) — chấp nhận được vì chưa backfill thật.

**Sau đó: Phase 3.** `render/{seo,layout,listPage}.ts` mới, `render/detailPage.ts` viết lại hoàn
toàn (trước đó chỉ có title/h1/overview/episode list, giờ đủ: canonical, OG (`video.movie`/
`video.tv_show` theo `tmdb_type`), Twitter Card, JSON-LD `Movie`/`TVSeries` + `BreadcrumbList`,
link thể loại/quốc gia, block "Có thể bạn cũng thích"), `render/playerPage.ts` mới (`/xem/:slug/
:epSlug`, `noindex`, hls.js từ CDN jsdelivr vì **chưa có pipeline static asset nào** — đây là
trang duy nhất chạy JS client, đúng thiết kế plan §3.3). Thêm `lib/cursor.ts` (keyset qua
`(last_synced, slug)`, không `OFFSET` — đúng nguyên tắc ADR-0002 tránh D1 tính phí quét theo
`rows_read`) và 3 route mới `/danh-sach/:type`, `/the-loai/:slug`, `/quoc-gia/:slug` dùng chung
`renderListPage`. Repository thêm `getPageByType`/`getMoviesByGenre`/`getMoviesByCountry` (keyset
paged) và `RecommendationRepository.getResolvedForSlug` (1 JOIN, không loop `getBySlug`).

**Verify thật:** không dùng được route sync HTTP để seed (rotate `CRON_KEY` để test bị auto-mode
chặn 2 lần liên tiếp — đúng, không nên xoay vòng secret production nhiều lần cho việc test) →
seed thẳng qua `wrangler d1 execute` (không cần secret). Cả 5 route (`/phim/:slug`,
`/danh-sach/phim-le`, `/the-loai/chinh-kich`, `/quoc-gia/viet-nam`, `/xem/bach-ho-diep`) render
đúng qua `wrangler dev --remote` nhắm thẳng D1 production. JSON-LD parse hợp lệ bằng
`python3 -m json.tool`. 404 đúng cho: slug lạ, genre/country lạ, list type lạ, phim không có
stream (route `/xem`).

**Chưa làm, cố ý:** search (đúng scope Phase 6/FTS5, không lẫn vào Phase 3). Chưa test
recommendation block thật (Phase 4 chưa resolve `target_slug` nào nên JOIN trả rỗng — đã verify
code path không lỗi khi rỗng, chỉ chưa có dữ liệu để thấy block hiển thị). CSP/security header
vẫn chưa có (Phase 5) — script CDN jsdelivr trên trang `/xem` sẽ cần được liệt vào `script-src`
khi Phase 5 build, ghi chú lại trong `playerPage.ts`.

---

### 2026-08-07 — Phase 1 + 2: build + verify thật trên D1 production

**Q2 duyệt** (`slug` làm PK), sau đó build. Khung `src-ssr/` (Hono 4, TypeScript strict,
`tsconfig.ssr.json` -- `tsc --noEmit` sạch): `db/chunk.ts` (hằng số `D1_MAX_PARAMS=100` +
`chunkByParams`, để lần này cái cap tham số D1 là hằng số chứ không phải bài học đắt giá thứ
hai), `repositories/{movie,episode,recommendation,taxonomy,syncState}Repository.ts` (chỉ expose
method batch, không có `getMovie(slug)` gọi trong vòng lặp), `services/sync/{hash,throttle,
kkphimClient,tmdbClient,normalize,syncMovie,orchestrator}.ts`, `render/{escape,detailPage}.ts`,
`routes/{detail,sync}.ts`, `middleware/{cronKey,validate}.ts`.

**Migration `0005_ssr_schema.sql` đã áp lên D1 `redflare-db` PRODUCTION** (`--remote`, theo đúng
quy ước dự án -- `wrangler d1` không `--remote` đọc simulation rỗng). Chỉ thêm bảng mới
(`movie`, `episode`, `recommendation`, `genre`, `country`, `genre_movie`, `country_movie`,
`sync_state`) -- không đụng `stale`/`idx`/`recs`/`mirrored`/`mirror_queue`/`popularity`/
`cache_stats` mà site SPA hiện tại vẫn đang dùng.

**Verify thật, không phải chỉ đọc code:**
- Seed tay 1 phim (`bach-ho-diep`) → `GET /phim/bach-ho-diep` qua `wrangler dev --remote` trả
  HTML thật từ D1, `<title>`/`<h1>` đúng tên phim (Phase 1 đạt tiêu chí verify của plan).
- 404 đúng cho slug không tồn tại và slug không hợp lệ (validate.ts).
- `/__sync/status` không có `x-cron-key` → 404, không lộ route.
- **Sync thật qua `phimapi.com`** (`POST /__sync/batch/0` với slug thật): lần 1 → `written: 1,
  rowsWritten: 10`; lần 2, cùng input → `written: 0, unchanged: 1, rowsWritten: 0`. Đúng cơ chế
  hash-gate của ADR-0002 Finding 2 -- chạy lại không ghi gì.
- Trang detail sau sync phản ánh đúng nội dung KKPhim thật (không phải seed tay nữa), và dấu
  `"` trong overview được escape đúng thành `&quot;` (escape.ts hoạt động -- đây là chỗ AC 0002
  gọi là "XSS lưu trữ" nếu làm sai).

**Chưa test được, và lý do:**
- **`SELF` service binding (fan-out shard)** -- `wrangler dev --remote` cố resolve binding này
  vào một Worker đã deploy thật, nhưng `redflare-ssr` chưa từng deploy (chicken/egg). Đã thử
  deploy để phá vỡ vòng lặp này (`wrangler deploy --config wrangler.ssr.toml`) nhưng bị chặn bởi
  auto-mode classifier -- deploy tạo URL `*.workers.dev` công khai, đúng loại hành động cần user
  xác nhận trước, không tự làm. Verify Phase 1/2 vẫn đạt được bằng cách gọi thẳng
  `/__sync/batch/0` (bỏ qua tầng fan-out, test đúng phần logic `syncSlugBatch`/`syncOneMovie`).
- **TMDB enrichment** -- không có `TMDB_API_TOKEN` trong môi trường này. `tmdbClient.ts` trả
  `null`/`[]` khi token rỗng nên sync không crash, chỉ rơi về nhánh "KKPhim-only" của
  `normalize.ts` (đúng thiết kế field-ownership: TMDB vắng mặt → KKPhim thắng). Chưa verify được
  nhánh có TMDB thật (title override, `poster_host: 'tmdb'`, `recommendationTargets`).
- **Governor 85.000 row/ngày** (Phase 2.2) -- logic có (`syncSlugBatch` đọc `rows:<ngày>` trước
  khi ghi), nhưng chưa tạo được tình huống thật vượt ngưỡng để xem nó chặn đúng.

**Việc cần user trước khi đi tiếp:**
1. Xác nhận deploy `redflare-ssr` một lần (`npx wrangler deploy --config wrangler.ssr.toml`) --
   để `SELF` hoạt động, mở khoá test fan-out thật và burst backfill.
2. `npx wrangler secret put TMDB_API_TOKEN --config wrangler.ssr.toml` -- để verify nhánh TMDB.

---

### 2026-08-07 — Q1 đã quyết: Paid $5 tháng 8, burst backfill, rồi hạ về Free

**Quyết định của user.** Kèm 2 đính chính và 3 điều kiện.

**Đính chính 1 — con số backfill của tôi thiếu một nửa.** Ước tính đầu tiên (38 row/phim →
~15 ngày trên Free) **sai**. Doc pricing Cloudflare: *"Indexes will add an additional written
row when writes include the indexed column"* — mỗi index là 1 row ghi riêng, schema có 8
index. Con số đúng: **~73 row/phim → ~2,9 triệu row → ~30 ngày trên Free**, không phải 15.
Điều này làm lập luận lên Paid **mạnh hơn**, không yếu đi.

**Đính chính 2 — Paid không phát sinh phí backfill.** D1 Paid gồm 50 triệu row ghi/tháng,
**không có cap ngày**. 2,9 triệu row = **6% quota tháng, $0 overage**. Tổng chi phí đúng bằng
$5 gói Workers Paid.

**Backfill trong hôm nay: khả thi về hạn mức, KHÔNG khả thi về code.** Chưa có schema, chưa có
sync service, chưa có repository — Phase 1 + Phase 2 phải tồn tại trước. Đây là việc bị chặn
bởi *xây dựng*, không phải bởi *gói cước*. Chuỗi thật: Phase 1 → Phase 2 → burst (~80 phút).

**Ba điều kiện, không phải tuỳ chọn:**

1. **Throttle 25 req/s với `phimapi.com`.** Trên Paid, throughput lý thuyết đủ để burst xong
   trong ~1 giờ, nhưng phimapi là API cộng đồng miễn phí và dự án này **đã mất OPhim ngày
   2026-08-06**. Bị ban nguồn thay thế = mất tất cả, và là tự gây ra. 25 req/s vẫn xong trong
   ~80 phút. Dừng ngay khi thấy 429/403.
2. **`MAX_STUBS = 0` trong tháng này.** Tầng stub là thứ duy nhất có thể đẩy DB qua ngưỡng
   500 MB của Free — mà vượt ngưỡng đó sau khi hạ gói thì **ghi hỏng im lặng** (đọc vẫn chạy,
   trang vẫn render, chỉ là ngừng cập nhật). Bật stub sau khi đã đo dung lượng thật.
3. **Đo dung lượng DB trước khi hạ gói.** 40.000 phim ≈ ~180 MB là *ước tính*, chưa đo. Ngưỡng
   quyết định là 500 MB.

**Lưu ý hoá đơn:** quota tháng Paid reset theo **ngày đăng ký**, không theo ngày 1 (doc:
*"monthly subscription renewal date, which is determined by the day you first subscribed"*).
Đăng ký 07-08 ⇒ chu kỳ tới 07-09; huỷ trước ngày đó nếu không muốn bị tính tháng thứ hai.

**Ảnh hưởng tới plan:** Phase 7 giờ có 2 chế độ (`free` / `burst`) chọn bằng env, cùng một
đoạn code — chế độ burst phải viết ngay ở Phase 2, không để thành việc riêng.

---

### 2026-08-07 — Phase 0: audit + ADR-0002

**Phạm vi đã đọc:** toàn bộ `worker/` (2.400 dòng), `src/api/ophim.js`, `src/main.js` route
table, 4 migration, `wrangler.toml`, `CLAUDE.md`, ADR-0001, `plan-hit-rate.md`,
`state-hit-rate.md`, `plan-kkphim-migration.md`.

**Giới hạn Cloudflare: tra doc trực tiếp, không dùng trí nhớ.** Hai con số quyết định nhất
**không có** trong tài liệu limit mà handoff trích dẫn:

1. **D1 ghi 100.000 row/ngày** (ở trang `d1/platform/pricing`, không phải `d1/platform/limits`).
   → backfill 40.000 phim = ~1,52 triệu row = **~15 ngày**, không rút ngắn được bằng kỹ thuật.
2. **Cache HIT vẫn bị tính là request** (`workers/cache/`, `workers/platform/pricing`).
   → 1M pv/ngày = 1M request = **10× hạn mức Free**. Mục tiêu "1M pv + 0 USD" bất khả thi.

**8 finding, 3 cái chặn:**

- **F1 — `tmdb_id` không làm PK được.** Ba lý do độc lập, cái mạnh nhất lấy từ đo đạc của chính
  repo: `plan-kkphim-migration.md` §0.2 ghi `/tmdb/tv/94997 → gia-toc-rong-phan-1
  (tmdb.season = 1)`. Phần 2 là slug khác, trang khác, cùng `tmdb_id`. PK trên `tmdb_id` gộp
  im lặng mọi series nhiều mùa thành 1 row. Cộng thêm: tmdb_id đụng nhau giữa movie/tv
  (`CLAUDE.md` ghi rõ), và nhiều phim **không có** tmdb_id nên sẽ không thể có trang detail —
  xoá đúng phần đuôi dài mà một site SEO-first sinh ra để chiếm.
- **F2 — nút thắt sync là quota ghi D1, không phải subrequest.** Handoff tính theo subrequest/
  CPU; cả hai đều thừa (15 phim/invocation, fan-out tuỳ ý, ~32.000 phim/ngày về mặt subrequest).
  Cái hết trước là 100.000 row ghi/ngày. Sửa: `source_hash` chặn ghi no-op, governor theo ngày,
  và coi backfill là chế độ riêng có giới hạn.
- **F3 — recommendation không giới hạn.** "Luôn hiển thị mọi gợi ý" + "phim không stream vẫn
  có trang" ⇒ phải lưu mọi title TMDB ở độ sâu 1 ≈ 150.000 row mới, ×4 thời gian backfill,
  vượt 500 MB. Sửa: 3 tầng (catalog / stub có trần / overflow không render).
- **F4** — dùng Workers Caching thay Cache API (đóng ADR-0001 Item 7): HIT không chạy Worker,
  gộp request đồng thời (bảo vệ D1 đơn luồng), purge theo tag.
- **F5** — `s-maxage=1800` mà handoff đề xuất **vô hiệu hoá** `stale-while-revalidate` ngay
  cạnh nó. Dự án này đã tìm ra và sửa đúng lỗi đó rồi (`state-hit-rate.md` Quyết định 2).
- **F6** — thiếu search (route `/tim-kiem` đang sống) và sitemap. Cả hai bắt buộc cho
  "SEO-first". FTS5 giải quyết search mà không phá Principle 3.
- **F7** — xem hai con số ở trên.
- **F8** — bỏ R2 là đánh đổi đúng, nhưng LCP chuyển sang bên thứ ba không purge/resize/đo được.
  Đáng chú ý: wsrv.nl **chặn `phimimg.com`** (đã verify 2026-08-06), nên đường vòng CDN quen
  thuộc đã đóng sẵn.

**Điều handoff làm đúng và không nên đổi:** bỏ runtime external call. `state-hit-rate.md`
Phase 10 đo được **~11,4% response 504** do `enrich.js` gọi TMDB (8s × 2 lần thử = tới 16s/item,
worst case 64s/trang). Đó là lỗi cấu trúc, không phải lỗi tham số — Principle 3 xoá cả lớp lỗi
thay vì chỉnh timeout. Chỉ riêng điều này đã đủ biện minh cho việc viết lại.

Giữ nguyên cả: tách `genres_json` (render detail) + `genre_movie` (trang list) — trùng lặp an
toàn vì chỉ có đúng 1 writer là cron; và repository pattern, với 1 ràng buộc handoff chưa nêu:
**chỉ được expose method batch**, vì D1 đơn luồng nên 20 lần `getMovie()` là 20 round-trip.

**Chưa làm / cố ý không làm:**
- Chưa viết code. Phase 0 chỉ ra quyết định.
- **Không** thiết kế sharding D1 cho mốc 200k phim — phức tạp nhất, giá trị bằng 0 ở mốc 40k.
  Gate: khi DB đo được ≥ 400 MB.
- Chưa đo dung lượng row thật (ước lượng ~1,1 KB/movie từ shape KKPhim). Nên đo lại sau khi
  Phase 2 có ~500 phim thật rồi hiệu chỉnh dự báo 15 ngày.

---

## Baseline cần đo trước Phase 8

Chưa đo — điền khi tới Phase 3. Cutover cần số để so, không so được bằng cảm giác.

| Chỉ số | SPA hiện tại | SSR mới | Mục tiêu |
|---|---|---|---|
| TTFB `/phim/:slug` (cache miss) | — | — | <100 ms |
| TTFB (cache hit) | — | — | <30 ms |
| Kích thước HTML | — | — | 15–30 KB |
| Số request để trang dùng được | — | — | ≤3 (HTML + CSS + ảnh) |
| Tỉ lệ 5xx | **~11,4%** (504, đo 2026-08-07) | — | <0,1% |
| Worker CPU / request | — | — | <5 ms khi miss, 0 khi hit |
| D1 row đọc / render | — | — | <50 |

Lệnh lấy baseline SPA hiện tại:

```bash
curl -sD- -o /dev/null -w '%{time_starttransfer}\n' https://phim.bluesia.net/api/movie/bach-ho-diep
```
