# Plan — Incremental sync ngừng kéo phim mới từ KKPhim (audit 2026-09-10)

Người thực thi: **sonnet-low**. Đọc hết mục "Bối cảnh" và "Luật chung" trước khi
bắt đầu bất kỳ phase nào. Mỗi phase có **Tiêu chí xong**; chưa đạt tiêu chí thì
không sang phase sau. Các phase phải làm **đúng thứ tự**. Phase 1 (cắt số row
D1 đọc mỗi ngày) là điều kiện tiên quyết: chưa xong Phase 1 thì tuyệt đối không
chạy lại job sync nào.

---

## Bối cảnh — audit đã xác nhận gì

### Nguyên nhân gốc
**Gói Workers Paid hết hạn khoảng 2026-09-06/07** (chủ tài khoản đã xác nhận).
Đúng mốc **2026-09-07 00:00 UTC**, cả 5 Workflow `schedules` ngừng tạo
instance và không tự hồi phục. Lúc audit (2026-09-10 07:02 UTC),
`next_instance` vẫn nhảy tiếp nhưng `triggered_on` đứng yên ở 2026-09-07.
Log trên dashboard từ 07/09 08:34 đến 10/09 06:29 chỉ có 92 sự kiện `fetch`,
không có một sự kiện workflow hay scheduled nào.

| Bằng chứng | Kết quả |
|---|---|
| Instance `incremental-sync` cuối | `*/30 * * * *-1788739200000` (2026-09-07 00:00 UTC), `Completed` |
| Steps/ngày (GraphQL `workflowsAdaptiveGroups`) | 01–06/09 ≈ 1.300 · 07/09: 40 · 08–10/09: 0 |
| Phim mới nhất trong D1 | `MAX(last_synced)` = 2026-09-07 00:00:22 UTC |
| Deploy cuối | 2026-08-23, không liên quan |
| KKPhim | feed vẫn sống |
| Cron Trigger cổ điển | tài khoản đang dùng 0/5 (`bluesia: []`, `redflare: []`) |

### Rủi ro lớn nhất trên Free: D1 rows read — ĐỌC KỸ
Từ **2026-09-01**, D1 trên Workers Free **từ chối mọi query** khi tài khoản
vượt **5.000.000 rows read/ngày** hoặc **100.000 rows written/ngày**. Lỗi kéo dài
tới 00:00 UTC hôm sau, **kể cả query của website**, tức là site sập cả ngày.

| Ngày | rows read | rows written |
|---|---|---|
| 01–06/09 (job chạy) | **61–80 triệu/ngày** (12–16× quota) | 35–54k |
| 08–10/09 (job dừng, chỉ còn traffic) | 0,2–0,6 triệu | ~0 |

Top query theo `wrangler d1 insights --timePeriod=7d --sort-by=reads`, cùng cách
sửa **đã kiểm chứng bằng `EXPLAIN QUERY PLAN` trên production**:

| # | Query (file) | Rows / lần | Tổng 7 ngày | Cách sửa (đã verify) |
|---|---|---|---|---|
| Q1 | `getCanonicalTargetByTmdbRef` (`movieRepository.ts:119`): `OR` qua `LEFT JOIN tmdb_override` | ~30.800 | 175M | Viết lại thành `UNION ALL` → `SEARCH m USING INDEX idx_movie_tmdb` |
| Q2 | `DELETE FROM genre_movie WHERE slug = ?` (`taxonomyRepository.ts:19`) | ~77.600 | 37,5M | Thêm index `genre_movie(slug)`: PK là `(genre_slug, slug)` nên delete theo `slug` phải `SCAN` |
| Q3 | CTE `WITH grouped` (`recommendationRepository.ts:167`, requeue) | ~77.600 | 17M | Để sau: tắt các job recommendation (Phase 3), tối ưu ở một plan riêng |
| Q4 | `DELETE FROM country_movie WHERE slug = ?` | ~33.700 | 14,9M | Thêm index `country_movie(slug)` |
| Q5 | `DELETE FROM fts_movie WHERE slug = ?` (`searchRepository.ts:35`) | ~30.700 | 14,6M | Xoá theo rowid, tìm qua cột `alias` (FTS có index) → **đọc 1 row** (đã đo) |
| Q6 | `getDueSources` (`recommendationFreshnessRepository.ts:12`) | ~33.300 | 2,4M | Để sau: job recommendation bị tắt |
| Q7 | List/home `ORDER BY COALESCE(upstream_modified, last_synced)` (`movieRepository.ts:232,276,293`) | 25–60k mỗi lần cache miss | 2M | `ORDER BY upstream_modified DESC` → dùng index sẵn có. 0/30.821 row có `upstream_modified` NULL nên thứ tự không đổi |
| Q8 | `catalogStats.refresh()`: quét toàn bộ `movie` + `genre_movie` + `country_movie` | ~140k mỗi lần | — | Giới hạn tối đa 1 lần / 6 giờ |

Riêng Q2+Q4+Q5 cộng lại ≈ 142.000 rows đọc **mỗi phim được ghi**. Chỉ cần sync
~35 phim là cháy quota 5M. Vì vậy **một lần trigger tay lúc này (~48 phim)
cũng đủ khoá D1 và làm sập site tới nửa đêm UTC.**

### CPU 10 ms (giới hạn Free)
Trong log, 11/92 request vượt 10 ms CPU, cao nhất 15 ms: `/api/home-data`
(9–15 ms), `/api/list?...` (8–13 ms), `/api/movie/...` (10–11 ms). Tất cả là
cache miss. Nguyên nhân chính là Q7 (sort 30k row trong bộ nhớ). Hiện vẫn trả
`ok`, nhưng có nguy cơ gặp lỗi 1102. Phase 1 sẽ sửa nguyên nhân này.

### Các lỗi thiết kế khác
- **F1:** chỉ có một đường kích hoạt (Workflow `schedules`), và theo thực tế đã
  quan sát, nó ngừng chạy khi rời Paid. Không có cảnh báo dữ liệu cũ.
- **F2:** cursor kẹt vĩnh viễn sau sự cố. `RECENT_PAGE_LIMIT = 2`, trong khi
  backlog hiện là **7 trang** (~168 phim, đo lúc 06:40 UTC 10/09). Cursor chỉ
  tiến khi quét tới nó, nên các trang 3–7 bị bỏ sót mãi mãi.
- **F3:** KKPhim hiện ghi `modified.time` theo giờ VN (+07) nhưng gắn nhãn `Z`.
  Ví dụ lúc 06:37:53 UTC thật, feed đã có item `12:56:34Z`; ngày 06/09 vẫn còn
  là UTC thật. Vì vậy mọi logic so sánh trước/sau với cursor hay `Date.now()`
  đều mong manh.
- **F4:** `hashMovie` không băm `modifiedAt`. Nếu chỉ `modified.time` đổi thì
  kết quả là `unchanged` và `upstream_modified` không được cập nhật.
- **F5:** `upsertMany` bind thẳng `m.modifiedAt` (`movieRepository.ts:46`), có thể
  ra NULL. Sau Phase 1, NULL sẽ làm lệch thứ tự rail.

### Steps Workflows (Free: 3.000/ngày, 1.024/instance)
Đo 01–06/09: hero-snapshot ≈ 550/ngày, recommendation-resolve ≈ 342,
incremental-sync ≈ 216, recommendation-refresh ≈ 117, backfill ≈ 96.

---

## Luật chung cho sonnet-low

1. **Không** `git push`, `wrangler deploy`, `wrangler d1 migrations apply`,
   `wrangler workflows trigger`, hay sửa biến trên dashboard khi chưa được chủ
   dự án đồng ý rõ ràng trong phiên hiện tại. Deploy = `git push origin main`.
2. **Ngân sách D1 là luật cứng.** Trước mọi thao tác chạm production, ước lượng
   rows read/written. Thao tác nào có thể đẩy tổng trong ngày UTC vượt
   **4M read** hoặc **80k write** thì dừng lại và hỏi. Query production chỉ
   được là `SELECT` hoặc `EXPLAIN QUERY PLAN`. Không chạy `COUNT(*)` trên bảng
   lớn nếu không cần.
3. Sửa tối thiểu, chỉ trong các file được liệt kê. Giữ nguyên phong cách
   comment và tên biến xung quanh. Không refactor thêm.
4. Sau mỗi phase code, chạy đủ các lệnh sau:
   ```
   npm run worker:typecheck
   npm run build
   npm run test:incremental-sync && npm run test:home-rail-ordering && npm run test:search
   npm run test:hero-refresh && npm run test:recommendation-safety && npm run test:recommendation-refresh
   npx wrangler deploy --dry-run
   ```
   Test mới thêm trong phase nào thì chạy luôn trong phase đó. Test đỏ thì sửa,
   hoặc dừng lại và báo.
5. Gặp điều gì trái với plan thì **dừng và hỏi**, không đoán.
6. Mỗi phase xong, ghi lại vào `docs/state-incremental-sync-stall.md`: đã làm
   gì, số liệu đo được, còn gì chưa làm.

---

## Phase 0 — Vận hành ngay (chủ dự án, KHÔNG code)

0.1. **Không trigger workflow tay. Không bật cron.** Lý do: Q2+Q4+Q5 ở trên,
     một lần chạy đủ để khoá D1 cả ngày.
0.2. Chọn hướng đi:
   - **A. Ở lại Free** (mặc định của plan này, đúng mục tiêu Free-plan
     migration): làm Phase 1 → 6 theo thứ tự. Phim mới chỉ chảy lại sau Phase
     5.2, ước tính 1–2 ngày làm việc.
   - **B. Đăng ký lại Workers Paid (~5 USD/tháng):** gần như chắc chắn khôi phục
     ngay (quota D1 25 tỷ rows/tháng, schedules nhiều khả năng chạy lại). Vẫn
     nên làm Phase 1–4 để hệ thống bền hơn.
0.3. Kiểm tra *Notifications* trên dashboard: bật email cảnh báo cho D1
     (Cloudflare tự gửi khi chạm limit) và Workers usage.

**Tiêu chí xong:** chủ dự án đã chọn A hoặc B và ghi vào state doc.

---

## Phase 1 — Cắt D1 rows read (bắt buộc trước mọi job)

Deploy **riêng** phase này. Không bật job nào. Riêng request path của website
đã được lợi ngay: ít rows read hơn và CPU dưới 10 ms.

1. **`migrations/0016_genre_movie_slug_index.sql`**:
   `CREATE INDEX IF NOT EXISTS idx_gm_slug ON genre_movie(slug);`
   **`migrations/0017_country_movie_slug_index.sql`**:
   `CREATE INDEX IF NOT EXISTS idx_cm_slug ON country_movie(slug);`
   - Thêm comment đầu file: lý do (Q2/Q4) và số liệu audit.
   - **Apply từng file một** (chủ dự án duyệt):
     `npx wrangler d1 migrations apply redflare-db --remote`. Sau file 0016,
     đọc `rows_written` trong output. Tạo index có thể tính khoảng 77k write
     (một entry cho mỗi row). Nếu tổng write trong ngày cộng 34k vượt 80k thì
     để **0017 sang ngày UTC sau**.
   - **Không** xoá `idx_gm_list` / `idx_cm_list`, dù chúng trùng với PK. Ghi
     vào state doc là việc dọn dẹp để sau.
   - Verify:
     `EXPLAIN QUERY PLAN DELETE FROM genre_movie WHERE slug='x'` phải ra
     `SEARCH genre_movie USING INDEX idx_gm_slug`; tương tự với `country_movie`.

2. **`src-ssr/repositories/searchRepository.ts` → `indexMovie`**: thay câu
   `DELETE FROM fts_movie WHERE slug = ?` bằng:
   ```sql
   DELETE FROM fts_movie WHERE rowid IN (
     SELECT rowid FROM fts_movie WHERE fts_movie MATCH ? AND slug = ?
   )
   ```
   - Tham số MATCH: `alias : "<token1> <token2> …"`. Token lấy từ
     `slugToSearchText(slug)`, sau đó chỉ giữ `[a-z0-9]+`. Đây là cùng nguồn
     với cột `alias` lúc insert, nên luôn khớp.
   - Nếu không còn token nào (không xảy ra với slug hợp lệ), fallback về câu
     cũ `DELETE … WHERE slug = ?`.
   - Đã đo trên production: `MATCH 'alias : "cuoc goi khan cap 9 1 1 phan 9"'
     AND slug=…` đọc **1 row**, và plan dùng `VIRTUAL TABLE INDEX`.
   - Cập nhật comment của `indexMovie`.
   - Thêm test vào `tests/search.test.mjs`: kiểm tra chuỗi MATCH sinh ra từ
     slug, bao gồm slug có số, slug có ký tự lạ, và slug rỗng (ra fallback).
     Tách builder ra thành hàm export để test được.

3. **`src-ssr/repositories/movieRepository.ts` → `getCanonicalTargetByTmdbRef`**:
   viết lại như dưới đây, giữ nguyên thứ tự ORDER BY và cách bind 4 tham số:
   ```sql
   SELECT * FROM (
     SELECT m.* FROM movie m WHERE m.tmdb_type = ? AND m.tmdb_id = ?
     UNION ALL
     SELECT m.* FROM tmdb_override o JOIN movie m ON m.slug = o.slug
      WHERE o.tmdb_type = ? AND o.tmdb_id = ?
   )
   ORDER BY CASE tier WHEN 'catalog' THEN 0 ELSE 1 END,
            CASE WHEN has_stream = 1 THEN 0 ELSE 1 END,
            CASE WHEN tmdb_season = 1 THEN 0 ELSE 1 END,
            CASE WHEN tmdb_season IS NULL THEN 1 ELSE 0 END,
            tmdb_season ASC, slug ASC
   LIMIT 1
   ```
   `UNION ALL` có thể trả trùng một phim, nhưng vì `LIMIT 1` nên không ảnh
   hưởng kết quả. Plan trên production đã verify:
   `SEARCH m USING INDEX idx_movie_tmdb`. Sửa comment phía trên hàm cho đúng
   cách query mới.

4. **`movieRepository.ts` dòng 232, 276, 293**: đổi
   `ORDER BY COALESCE(upstream_modified, last_synced) DESC` thành
   `ORDER BY upstream_modified DESC`.
   - Plan đã verify: dùng `idx_movie_upstream_modified` /
     `idx_movie_type_upstream_modified`, không còn temp B-tree.
   - Sửa F5 ở dòng 46: bind `m.modifiedAt ?? now`. `now` đã có sẵn ở dòng 43.
     Cách này đảm bảo không bao giờ ghi NULL, nên thứ tự mới luôn khớp thứ tự
     cũ.
   - Cập nhật comment của 3 query, và `tests/homeRailOrdering.test.mjs` nếu
     test đang so khớp chuỗi SQL cũ.

5. **`src-ssr/repositories/catalogStatsRepository.ts` → `refresh()`** (Q8):
   - Đầu hàm: đọc `sync_state` key `catalog_stats:refreshed_at`. Nếu còn mới
     hơn **6 giờ** thì return luôn. Sau khi refresh xong thì ghi lại key.
   - Làm trong `refresh()` để cả 3 caller (`incrementalSyncWorkflow.ts:64`,
     `recommendationResolveWorkflow.ts:82`, `orchestrator.ts:831`) cùng được
     giới hạn mà không phải sửa caller.
   - Chấp nhận việc số trang của phân trang có thể cũ tối đa 6 giờ.
   - Viết test: gọi 2 lần liên tiếp thì chỉ query `movie` 1 lần.

**Tiêu chí xong:**
- Luật chung #4 xanh.
- Sau khi deploy (chủ dự án duyệt) được 24 giờ:
  `npx wrangler d1 insights redflare-db --timePeriod=1d --sort-by=reads`
  không còn query nào của request path có trung bình trên 1.000 rows.
- GraphQL `d1AnalyticsAdaptiveGroups` báo rows read trong ngày dưới 300k.
- Log dashboard: `/api/home-data` và `/api/list` có `cpuTimeMs` dưới 10.

---

## Phase 2 — Quét feed không phụ thuộc đồng hồ, tự bắt kịp backlog (F2, F3, F4)

Ý tưởng: **dừng quét khi gặp một trang mà mọi item đều đã có trong D1 với
đúng `upstream_modified`**. Phép so sánh là so bằng, không so trước/sau, nên
nhãn múi giờ của KKPhim không còn quan trọng. Slug nào sync lỗi thì vẫn bị coi
là "chưa biết" và tự được thử lại ở tick sau. `cursor:recent` vẫn được ghi,
nhưng chỉ để chẩn đoán (`/__sync/status` đọc nó).

1. **`movieRepository.ts`**: thêm 2 method, đặt ngay dưới `getHashesBySlugs` và
   theo đúng pattern `chunkByParams` của nó. **Không** sửa `getHashesBySlugs`.
   - `getSyncMarkersBySlugs(slugs)` → `Map<string, { sourceHash: string; upstreamModified: number | null }>`,
     dùng `SELECT slug, source_hash, upstream_modified FROM movie WHERE slug IN (...)`.
     Query này đi qua PK nên rẻ.
   - `setUpstreamModified(slug, modifiedAt)` → `UPDATE movie SET upstream_modified = ? WHERE slug = ?`.
2. **`src-ssr/services/sync/orchestrator.ts`**:
   - Xoá `RECENT_PAGE_LIMIT = 2`. Thêm `DEFAULT_RECENT_PAGE_CAP = 30`, kèm comment
     giải thích: 720 slug + ~4 step < 1.024 step/instance trên Free; 30 lần
     fetch < 50 external subrequest mỗi step. *(Sai: trên Free, 50 là quota
     của cả instance. Đã sửa ở 5.2b trong state doc; mặc định hạ về 12.)*
   - Cho phép override bằng biến `[vars] RECENT_PAGE_CAP`: parse số nguyên và
     kẹp vào khoảng `[1, 40]`. Giá trị không hợp lệ thì dùng default.
   - Thêm `'known_page'` vào `IncrementalStopReason`.
   - Viết lại vòng lặp của `scanRecentSlugs`. Giữ nguyên chữ ký hàm và
     `RecentScanResult`:
     ```
     for page in 1..cap:
       fetch → lỗi: scanFailed=true, stop 'upstream_error', break
       rỗng: scanComplete=true, stop 'empty_page', break
       markers = repos.movie.getSyncMarkersBySlugs(slug của trang)
       changedOnPage = 0
       for item:
         if seenSlugs.has(slug) continue
         feedSec = Math.floor(Date.parse(item.modified.time) / 1000)
         m = markers.get(slug)
         if (m && m.upstreamModified === feedSec) continue
         seenSlugs.add; slugs.push; changedOnPage++
         newest = newest ? newerCursor(newest, candidate) : candidate
       if changedOnPage === 0: scanComplete=true, stop 'known_page', break
     hết vòng mà không break → 'page_limit' (scanComplete=false)
     ```
     Bỏ toàn bộ logic `cursorTime` / `crossedCursor` / tie-break theo
     `cursor.slug`. `runIncrementalSync` tự hưởng thay đổi này; chỉ cần kiểm tra
     nó vẫn compile và nhánh `stopReason` vẫn đúng.
3. **`src-ssr/services/sync/syncMovie.ts`** (F4): đổi sang dùng
   `getSyncMarkersBySlugs([slug])`. Khi hash trùng, xét thêm:
   - `movie.modifiedAt !== null` và khác `upstreamModified` →
     `setUpstreamModified(slug, movie.modifiedAt)`, trả `{ outcome: 'unchanged', rowsWritten: 1 }`.
   - Ngược lại giữ như cũ, `rowsWritten: 0`.
4. **`src-ssr/workflows/incrementalSyncWorkflow.ts`**: chỉ sửa comment
   "Advance the cursor…" để nói rõ cursor giờ chỉ dùng cho chẩn đoán.
5. **`wrangler.toml`**: thêm `RECENT_PAGE_CAP = "30"` vào `[vars]`, comment theo
   phong cách các biến `BACKFILL_*`. Chạy `npm run cf-typegen`.
6. **Test** (`tests/incrementalSyncSafety.test.mjs`):
   - Mở rộng mock `SyncStateDb` để hỗ trợ `SELECT slug, source_hash,
     upstream_modified FROM movie WHERE slug IN` (`.all()`) và `UPDATE movie
     SET upstream_modified`.
   - Sửa các test đang dựa trên ngữ nghĩa cursor cũ:
     "…recent-page cap before crossing it", "…unseen slug at the cursor
     timestamp boundary", "…equal-timestamp items…". Giữ nguyên ý an toàn gốc
     của từng test.
   - Test mới:
     - (1) backlog 7 trang, trang 8 đã biết hết → quét 8 trang, `'known_page'`.
     - (2) timestamp feed +7h so với `Date.now()`, cursor cũ theo UTC thật →
       vẫn tìm ra slug mới.
     - (3) trang 1 đã biết hết → 1 lần fetch, 0 slug.
     - (4) `RECENT_PAGE_CAP="3"`, không có trang nào đã biết hết →
       `'page_limit'`, đúng 3 lần fetch.
     - (5) `syncOneMovie` với hash trùng nhưng `modifiedAt` khác →
       `setUpstreamModified`, `rowsWritten: 1`.
   - Giữ nguyên các test về timeout, shard lỗi và alias slug.

**Đánh đổi đã biết** (ghi vào state doc, không cần xử lý):
- Slug alias hoặc slug 404 vĩnh viễn sẽ bị thử lại ở mỗi tick, tốn 1 step và
  1 call mỗi lần.
- Title chỉ đổi `modified.time` sẽ nhảy lên đầu rail. Điều này khớp với thứ tự
  feed của KKPhim.

**Tiêu chí xong:** Luật chung #4 xanh; 5 test mới pass.

---

## Phase 3 — Cron cổ điển làm trigger chính (thay Workflow `schedules`, F1)

Trên Free, Workflow `schedules` đã ngừng chạy. Cron Trigger cổ điển thì được hỗ
trợ (tài khoản đang dùng 0/5).

1. **`wrangler.toml`**:
   - Thêm:
     ```toml
     [triggers]
     crons = ["*/30 * * * *"]
     ```
   - **Xoá dòng `schedules = [...]` ở cả 5 block `[[workflows]]`** để chỉ còn
     một nguồn kích hoạt duy nhất. Nếu sau này quay lại Paid, giữ cả hai sẽ làm
     job chạy đôi.
   - Viết comment ở cả hai chỗ: kể lại sự cố 2026-09-07 và lý do chọn cách này.
     Sửa luôn các comment cũ đang nói "each Workflow's `schedules` is its own
     cron budget".
2. **`src-ssr/services/sync/dispatch.ts`** (file mới), export
   `dispatchScheduledWorkflows(env, scheduledTime)`:
   - Mỗi tick: `INCREMENTAL_SYNC_WORKFLOW.create({ id: \`incremental-${scheduledTime}\` })`.
   - Tick nào có phút = 0 (tính theo UTC từ `scheduledTime`):
     `HERO_SNAPSHOT_WORKFLOW.create({ id: \`hero-${scheduledTime}\` })`.
   - `RECOMMENDATION_RESOLVE_WORKFLOW` / `RECOMMENDATION_REFRESH_WORKFLOW`:
     **chỉ chạy khi** `env.RECOMMENDATION_JOBS_ENABLED === "true"`. Thêm biến
     này vào `[vars]` với mặc định `"false"`, kèm comment về Q3/Q6. Cadence khi
     bật: resolve mỗi tick */30, refresh mỗi giờ, giống cũ.
   - `BACKFILL_WORKFLOW`: chỉ chạy khi `env.BACKFILL_ENABLED === "true"`.
   - Id tất định theo `scheduledTime` nên nếu cron bắn đôi thì Workflows tự từ
     chối. Id phải khớp `^[a-zA-Z0-9_][a-zA-Z0-9-_]*$`.
   - Bọc từng `create` trong try/catch, lỗi thì
     `console.error(JSON.stringify({ message: 'workflow dispatch failed', workflow, error }))`.
     Hàm **không bao giờ throw**.
3. **`src-ssr/index.ts`**:
   `export default { fetch: app.fetch, scheduled(controller, env, ctx) { ctx.waitUntil(dispatchScheduledWorkflows(env, controller.scheduledTime)); } }`.
   Sửa khối comment "legacy scheduled() handler…": handler mới **chỉ tạo
   instance**, không làm việc nặng nào của cron cũ. Chạy `npm run cf-typegen`.
4. **Test** `tests/cronDispatch.test.mjs`, kèm script `test:cron-dispatch` theo
   pattern esbuild giống `test:incremental-sync`. Các ca cần có:
   - `scheduledTime` rơi vào phút 30 → chỉ tạo incremental.
   - Phút 0 → tạo incremental và hero.
   - Recommendation tắt hoặc bật đúng theo biến.
   - Backfill tắt/bật đúng theo biến.
   - `create` ném lỗi → hàm vẫn resolve và các workflow khác vẫn được tạo.
   - Id đúng định dạng.

**Ngân sách steps dự kiến:** incremental 48 tick × (~4 + số phim đổi) ≈
400–700/ngày, hero ≈ 550/ngày. Tổng ≈ 1.000–1.300/ngày, dưới 3.000.

**Tiêu chí xong:** Luật chung #4 xanh, cộng `npm run test:cron-dispatch`.
`npx wrangler deploy --dry-run` phải hiện trigger `*/30 * * * *` và không còn
workflow `schedules` nào.

---

## Phase 4 — Health check để không im lặng thêm lần nào nữa

1. **`src-ssr/routes/sync.ts`** (`/__sync/status`): thêm `recentSync.ageSeconds`
   và `stale: { incremental, hero }`. Ngưỡng là 45 phút và 90 phút, khai báo
   thành hằng số export trong `dispatch.ts`.
2. **`src-ssr/api/routes.ts`**: route mới `GET /api/health/sync`, public, gọi
   `applyNoStore(c)`.
   - Trả `{ ok, incrementalAgeSeconds, heroAgeSeconds }`.
   - HTTP 200 khi còn tươi, 503 khi cũ.
   - Không trả cursor hay slug.
   - Chỉ đọc 2 key trong `sync_state` (theo PK, rẻ).
   - Verify bằng `curl -sI`: header phải có `no-store`.
3. **Chủ dự án** gắn một monitor ngoài miễn phí (UptimeRobot, cron-job.org,
   Better Stack…) vào `https://film.bluesia.net/api/health/sync`, cảnh báo khi
   trả khác 200.

**Tiêu chí xong:** test xanh; chạy `npm start` sau `npm run build`, endpoint trả
200 hoặc 503 đúng với trạng thái D1 thật.

---

## Phase 5 — Deploy theo từng nấc và đo (chủ dự án duyệt từng push)

5.1. **Deploy Phase 1.** Apply migration 0016/0017 theo mục 1.1, rồi push. Chờ
     24 giờ và đo lại theo Tiêu chí xong của Phase 1. **Chưa đạt thì không
     sang 5.2.**

5.2. **Deploy Phase 2–4.** Recommendation vẫn tắt. Tick đầu tiên sẽ tự bắt kịp
     backlog: dự kiến `stopReason: 'known_page'`, `pagesScanned` khoảng 8 trở
     lên.
   - Mỗi phim giờ chỉ tốn vài trăm rows, nên backlog ~200 phim tốn dưới 100k
     rows read.
   - Trong 30 phút đầu, chạy:
     ```
     npx wrangler workflows instances list incremental-sync | head -8
     npx wrangler d1 execute redflare-db --remote --command \
       "SELECT value FROM sync_state WHERE key='recent:last_run'"
     curl -s https://film.bluesia.net/api/health/sync
     ```
   - Theo dõi 24 giờ. Mục tiêu: rows read dưới 2M/ngày, rows written dưới
     50k/ngày, steps dưới 2.000/ngày. Kiểm tra bằng các query GraphQL
     `d1AnalyticsAdaptiveGroups` / `workflowsAdaptiveGroups` (xem mục Bối
     cảnh).
   - Nếu backlog đã dài hơn 30 trang (tick đầu trả `page_limit`): đặt tạm
     `RECENT_PAGE_CAP = "40"` trên dashboard. Vẫn chưa đủ thì dùng `BACKFILL_*`,
     cần chủ dự án duyệt.

5.3. **Recommendation jobs:** giữ `RECOMMENDATION_JOBS_ENABLED = "false"` cho tới
     khi có một plan riêng tối ưu Q3 (CTE requeue ~77k rows/lần) và Q6
     (`getDueSources` ~33k rows/lần). Rail gợi ý vẫn hiển thị dữ liệu đã có sẵn,
     chỉ không được làm mới. → `docs/plan-recommendation-d1-reads.md` (Phase
     1-5 code xong 2026-09-12, Phase 6 deploy/bật job chờ chủ dự án duyệt).

**Tiêu chí xong:** 24 giờ liên tục có instance mỗi 30 phút; `/api/health/sync`
luôn trả 200; phim mới lên home trong vòng 30 phút sau khi xuất hiện trên
KKPhim; D1 và steps nằm trong ngân sách ở 5.2.

---

## Phase 6 — Tài liệu

- **`README.md`**, mục "🛠️ Vận hành":
  - Cron dispatcher thay cho Workflow `schedules`.
  - `/api/health/sync`.
  - Biến `RECENT_PAGE_CAP` và `RECOMMENDATION_JOBS_ENABLED`.
  - Bảng ngân sách Free: D1 5M read / 100k write, 3.000 steps, 10 ms CPU.
  - Quy trình xử lý khi sync ngừng (tóm tắt Phase 0 và "không trigger tay khi
    chưa kiểm tra D1").
  - Ghi chú F3 (KKPhim dùng giờ +07 nhưng gắn nhãn `Z`).
- **`wrangler.toml`**: sửa các comment còn nói "the account is on Paid" hoặc mô
  tả `schedules` như trạng thái hiện tại.
- **`docs/state-incremental-sync-stall.md`**: số liệu thực tế của từng phase.
- **Việc để sau** (liệt kê, không làm):
  - Plan tối ưu Q3/Q6.
  - Xoá các index trùng `idx_gm_list` / `idx_cm_list`.
  - Kiểm tra xem UI có hiển thị thời gian tương đối từ `modified.time` không
    (F3).
