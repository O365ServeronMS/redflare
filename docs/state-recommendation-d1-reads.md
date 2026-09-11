# State — Tối ưu D1 reads của Recommendation (docs/plan-recommendation-d1-reads.md)

Running log theo từng phase. **Không** deploy/migrate/bật job trong các phase
này — Phase 6 chờ chủ dự án duyệt riêng.

---

### Phase 1 — Q3: requeue theo sự kiện thay cho quét định kỳ

Code xong 2026-09-11. Chưa deploy, chưa apply gì (không có migration ở
phase này).

- **1.1** `recommendationRepository.ts`: thêm `requeueTarget(targetType,
  targetTmdbId)` — `UPDATE ... WHERE target_tmdb_id = ? AND target_type = ?
  AND target_slug IS NULL AND resolve_attempted = 1`, ngay dưới
  `requeueAttemptedGroups`.
- **1.2** `syncMovie.ts`: nhánh `written`, sau `search.indexMovie(...)`, khi
  `tmdbId && tmdbType` gọi `repos.recommendation.requeueTarget(tmdbType,
  tmdbId)`. Đã kiểm `hashMovie` (`hash.ts`): không hash `tmdbId`/`tmdbType`
  của chính movie (chỉ hash `recommendationTargets`, tức target của người
  khác) — comment tại chỗ gọi ghi rõ: một title đổi TMDB identity mà không
  đổi field nào khác trong hash sẽ ở nhánh `unchanged` và không kích hoạt
  hook này. Chấp nhận (cực hiếm, đúng như plan §1.2 dự đoán).
- **1.3** `orchestrator.ts` `requeueOverflowGroups`: thêm 2 guard đầu hàm,
  theo đúng thứ tự plan:
  1. `maxStubs <= stubCount` → return `{candidates:0, requeued:0}`, không
     đọc D1 (kể cả cursor).
  2. Còn chỗ stub nhưng `sync_state` key `recommendation:requeue_scan_at`
     mới hơn 24h → cũng return `{0,0}` không đọc thêm.
  Logic phân trang cursor cũ giữ nguyên phía dưới; cuối hàm ghi lại
  `requeue_scan_at = Date.now()` (cùng nhánh có/không có candidate — một
  lần chạy trong ngày là một lần chạy, kể cả khi nó ra 0 candidate).
  Hằng mới: `REQUEUE_SCAN_INTERVAL_MS = 24h`, `REQUEUE_SCAN_AT_KEY`.
- **1.4 (catch-up một lần)** — **chưa chạy**, để Phase 6 (ops, cần chủ dự án
  duyệt bước deploy). SQL nêu ở plan §1.4, ước tính ~78k rows read / ~12
  rows written, chạy một lần thủ công qua `wrangler d1 execute --remote`.
- **1.5 (tài liệu ops `tmdb_override`)** — gộp vào Phase 5 (tài liệu) thay vì
  làm riêng ở đây, để tránh một commit "docs" rời rạc giữa các phase code.

**EXPLAIN QUERY PLAN trên production (Luật chung #2), không tốn rows read:**

```
$ npx wrangler d1 execute redflare-db --remote --json --command \
  "EXPLAIN QUERY PLAN UPDATE recommendation SET resolve_attempted = 0 \
   WHERE target_tmdb_id = 42 AND target_type = 'movie' \
     AND target_slug IS NULL AND resolve_attempted = 1"
→ SEARCH recommendation USING INDEX idx_rec_overflow (target_tmdb_id=? AND target_type=?)
```

Đúng kỳ vọng plan §1.1 — không `SCAN`, không `TEMP B-TREE`.

**Test (`tests/recommendationFailureSafety.test.mjs`):**
- Viết lại `requeues a local target at the stub cap, then resolves
  idempotently without upstream` → đổi tên thành `...event-driven at the
  stub cap...`, 4 bước (a)-(d) đúng plan §1.6: tick đầu ở stub cap không tự
  requeue (`requeueCandidates: 0`) và không fetch; gọi `requeueTarget('movie',
  42)` trực tiếp; tick sau resolve local (không fetch); tick thứ ba 0 việc.
- Test mới `syncOneMovie requeues an overflow edge event-driven when its own
  tmdb identity lands`: dùng `setupResolver()` (Miniflare D1 thật) + mock
  nhẹ cho `movie/episode/taxonomy/search/tmdbOverride`, nhưng
  `recommendation` là `RecommendationRepository(db)` thật — insert sẵn một
  overflow edge `(other-source → 42, movie)`, gọi `syncOneMovie` với
  `tmdb.id = '42'`, xác nhận edge chuyển `resolve_attempted = 0`.
- Test mới `requeueOverflowGroups scans at most once per 24h once stub
  headroom opens`: gọi thẳng `requeueOverflowGroups(buildRepos(env), 2, 0)`
  hai lần liên tiếp — lần 1 thấy 1 candidate/1 requeued, lần 2 (`< 24h`)
  `{candidates:0, requeued:0}`.
- 3 test `syncOneMovie` cũ (mock repos tay) thêm `requeueTarget: async () =>
  undefined` vào mock `recommendation` — trước đó fail vì thiếu method này
  trên nhánh `written` mới.
- `incrementalSyncSafety.test.mjs`: không cần sửa — `kkDetail` ở file đó
  luôn có `tmdb: null` nên `tmdbId/tmdbType` null, hook không kích hoạt.

**Verify (Luật chung #1) — tất cả xanh:**
`worker:typecheck` ok (cf-typegen + tsc, 0 lỗi) ·
`test:recommendation-safety` 15 (12 cũ + 3 mới, không còn fail) ·
`test:incremental-sync` 18 · `test:hero-refresh` 8.
Chưa chạy `npm test` (full gate) — để sau Phase 2-5, chạy một lần cuối
trước khi dừng lại chờ duyệt (theo yêu cầu chủ dự án: dừng trước Phase 6).

**Việc còn lại:** 1.4 (catch-up SQL) và 1.5 (README ops note) chuyển sang
Phase 6 và Phase 5 tương ứng, xem ghi chú trên.

---

### Phase 2 — Q6: freshness đầy đủ + query đi từ index

Code xong 2026-09-12. **Chưa `wrangler d1 migrations apply`** (Phase 6).

- **2.1** `migrations/0018_recommendation_freshness_seed.sql`: `INSERT OR
  IGNORE INTO recommendation_freshness (slug, last_success_at,
  last_attempt_at, result) SELECT slug, last_synced, last_synced, 'seeded'
  FROM movie WHERE tier='catalog' AND tmdb_id IS NOT NULL AND tmdb_type IN
  ('movie','tv')` — đúng như plan §2.1. Grep xác nhận (như plan yêu cầu):
  không có code nào khác switch trên `recommendation_freshness.result`
  ngoài `markAttempt`'s `excluded.result` CASE — giá trị mới `'seeded'` an
  toàn. Chưa apply, ước tính ~30k rows read / ~14k rows written (Phase 6.2).
- **2.2** `syncMovie.ts`: thêm `recommendationFreshness:
  RecommendationFreshnessRepository` vào tham số `repos`; trong nhánh
  `written`, cùng khối `if (tmdbId && tmdbType)` với hook 1.2, gọi
  `markAttempt(slug, ...)`: `'success'`/`'valid_empty'` theo
  `recommendation.ids.length`, hoặc `'retryable_error'`. Cập nhật **mọi**
  caller của `syncOneMovie` (grep lại theo plan §2.2):
  - `orchestrator.ts` `buildRepos`: thêm
    `recommendationFreshness: new RecommendationFreshnessRepository(env.DB)`.
  - `heroSnapshot.ts` `buildDependencies`: thêm biến `recommendationFreshness`,
    truyền vào `syncCanonical`'s lời gọi `syncOneMovie`.
  - `incrementalSyncWorkflow.ts`: không cần sửa — đã dùng `buildRepos(this.env)`
    nguyên khối.
  - `tests/incrementalSyncSafety.test.mjs`: không cần sửa — `kkDetail` ở
    file đó luôn `tmdb: null` nên nhánh `if (tmdbId && tmdbType)` (cả hook
    1.2 lẫn 2.2) không bao giờ chạy.
- **2.3** `recommendationFreshnessRepository.ts` `getDueSources` viết lại
  thành 2 query tuần tự (A: chưa từng thành công + hết backoff, B: hết TTL,
  `LIMIT = limit - A.length`), cả hai `CROSS JOIN` từ `recommendation_freshness`
  sang `movie` như plan §2.3, giữ nguyên chữ ký + thứ tự kết quả.
- **2.4** `movieRepository.ts` `getRecommendationSourceByTmdbRef` — không sửa
  SQL, đúng plan. Ghi nhận: sau seed, một `tmdb_id` có nhiều bản catalog sẽ
  ưu tiên dòng có `last_success_at` seeded (non-NULL) hơn dòng chưa từng
  refresh — chấp nhận, đúng ngữ nghĩa "có recs hơn".

**EXPLAIN QUERY PLAN trên production (Luật chung #2), không tốn rows read:**

Query A (chưa từng thành công):
```
SEARCH f USING INDEX idx_recommendation_freshness_success (last_success_at=?)
SEARCH m USING INDEX sqlite_autoindex_movie_1 (slug=?)
```
Query B (hết TTL):
```
SEARCH f USING COVERING INDEX idx_recommendation_freshness_success (last_success_at<?)
SEARCH m USING INDEX sqlite_autoindex_movie_1 (slug=?)
```
Cả hai đúng kỳ vọng plan §2.3 — không `SCAN`, không `TEMP B-TREE`.

**Test:**
- `tests/recommendationRefresh.test.mjs`: `setup()` seed thêm một dòng
  `recommendation_freshness` cho `'source'` (`last_success_at = NULL,
  last_attempt_at = 0`) để khớp giả định mới (nếu không, 'source' không có
  dòng freshness nên 2 query mới không nhặt được nó — vì đi từ
  `recommendation_freshness`, không còn anti-join `movie`). Thêm 4 test đơn
  vị cho `getDueSources` qua helper `setupFreshnessOnly()` (chỉ bảng
  `movie` + migration 0011, không cần bảng `recommendation`): thứ tự
  never-succeeded trước expired; never-succeeded còn trong backoff bị loại;
  `limit` chia đúng giữa A và B, expired sort theo `last_success_at` tăng
  dần; movie `tier='stub'` hoặc thiếu `tmdb_id` bị loại dù có dòng freshness
  hết hạn.
- `tests/recommendationFailureSafety.test.mjs`: 4 mock `recommendation` (2
  test `syncOneMovie` cũ + 1 override test + 1 test event-driven mới) thêm
  `recommendationFreshness: { markAttempt: async () => undefined }` (hoặc
  `RecommendationFreshnessRepository(db)` thật ở 2 test dùng
  `setupResolver()`) — trước đó không có key này nên nhánh mới ở 2.2 throw.
  Thêm test `syncOneMovie records a freshness attempt on the written
  branch: success and retryable`: 1 sync thành công (`ids:[7]`) → dòng
  freshness `result='success'`, `last_success_at` non-null; 1 sync với TMDB
  recs `retryable_error` → `result='retryable_error'`, `last_success_at`
  vẫn `null` (CASE giữ nguyên giá trị cũ, không có dòng cũ nên vẫn null).

**Verify (Luật chung #1) — tất cả xanh:**
`worker:typecheck` ok · `test:recommendation-safety` 16 (15 cũ/Phase-1 + 1
mới) · `test:recommendation-refresh` 7 (3 cũ + 4 mới) · `test:incremental-sync`
18 · `test:hero-refresh` 8.

**Việc còn lại:** apply `0018` + đo `rows_written` thật (Phase 6.2).

---

### Phase 3 — Resolve: ngân sách subrequest theo instance

Code xong 2026-09-12. Không có migration/deploy ở phase này.

- **3.1** `orchestrator.ts`: `INSTANCE_SUBREQUEST_BUDGET` đổi thành `export
  const` (giữ nguyên giá trị 50). Thêm `export const
  RESOLVE_MAX_CALLS_PER_GROUP = 1 + MAX_FETCHES_PER_SYNC` (= 6, tính theo
  công thức thay vì literal để tự động khớp nếu `MAX_FETCHES_PER_SYNC` đổi).
- **3.2** `ResolveGroupOutcome` thêm `externalCalls: number` (ước lượng
  trên). Cập nhật mọi `return` trong `resolveOneGroup`:
  - local resolve: `0`.
  - KKPhim lookup `retryable_error`: `1`.
  - KKPhim `found` (dù `syncOneMovie` sau đó thành công hay fail): luôn
    `RESOLVE_MAX_CALLS_PER_GROUP` (6) — không biết trước
    `syncOneMovie` dùng bao nhiêu fetch thật, phải lấy giá trị trên.
  - Nhánh stub (đã gọi TMDB detail): `2`, dùng cho cả 3 kết cục (thành
    công/`retryable_error`/thành công nhưng thiếu title → vẫn rơi xuống
    overflow).
  - Overflow không qua nhánh stub (stub không đủ điều kiện): `1` (chỉ có
    lookup).
- **3.3** `recommendationResolveWorkflow.ts`: vòng ngoài giữ biến `callsUsed`
  (khởi tạo 0), truyền `callsUsedBefore` vào closure `step.do` của mỗi
  batch; trong batch, trước mỗi group kiểm `used + RESOLVE_MAX_CALLS_PER_GROUP
  > INSTANCE_SUBREQUEST_BUDGET` → `stopped = true`, `break`. Step trả thêm
  `callsUsed`/`stopped`; vòng ngoài đồng bộ lại `callsUsed` từ kết quả step
  (replay-safe, cùng pattern với `stubCountRef`) và `break` khi `stopped`.
  Kết quả instance thêm field `deferred = groups.length - (existing+stub+
  overflow+retryable)` (chọn phương án đổi shape thay vì chỉ ghi comment,
  vì rẻ và rõ ràng hơn cho việc theo dõi ở `/__sync/status`/log). Sửa lại
  comment đầu file `GROUPS_PER_STEP` — không còn nói "50/step cap" (sai);
  giải thích ngân sách giờ enforce tường minh qua `callsUsed`, batch chỉ
  còn quyết định CPU time/step.
- **3.4** `runRecommendationResolveTick` (`orchestrator.ts`, route tay
  `/__sync/resolve-recommendations`): thêm biến `callsUsed` cục bộ, cùng
  điều kiện dừng trước mỗi group trong vòng lặp (bên cạnh điều kiện
  deadline có sẵn).
- **3.5** `recommendationRefreshWorkflow.ts`: chỉ sửa comment
  `SOURCES_PER_STEP` — nói rõ trần 50 là **per-instance**, không phải per
  step, trỏ tới `INSTANCE_SUBREQUEST_BUDGET`. Không đổi logic (20 nguồn × 1
  TMDB call = 20 ≤ 50 vẫn đúng).

**Test (`tests/recommendationFailureSafety.test.mjs`):** thêm `resolve tick
caps upstream groups at floor(50/6) per instance; local resolves are free`
— 30 group local (mỗi group một `movie` catalog khớp `tmdb_id`, refCount=1)
+ 20 group non-local (KKPhim trả `found` nhưng `syncOneMovie` sau đó luôn
503 → `retryable`, tốn 6/group theo ước lượng trên). Assertions: 30 resolved
local (không tốn ngân sách), đúng `floor(50/6) = 8` group upstream được xử
lý, `groupsSeen = 38` (30 + 8), và **đếm số lần `fetch` thật** = 16 (8 ×
[1 lookup + 1 detail fail]) để chứng minh nhóm thứ 9 trở đi **không hề gọi
fetch**, chứ không chỉ là "không được tính".

**Verify (Luật chung #1) — tất cả xanh:**
`worker:typecheck` ok · `test:recommendation-safety` 17 (16 cũ + 1 mới) ·
`test:recommendation-refresh` 7 · `test:incremental-sync` 18 ·
`test:hero-refresh` 8.

Không có SQL mới ở phase này nên không có EXPLAIN QUERY PLAN để chạy (Luật
chung #2 chỉ áp dụng khi có query mới/sửa).

---

### Phase 4 — Refresh: không ghi lại khi danh sách không đổi

Code xong 2026-09-12. Không có migration/deploy ở phase này.

- `recommendationRepository.ts` `replaceTargetsPreservingResolvedForSlug`:
  SELECT `current` thêm cột `sort_order` + `ORDER BY sort_order` (đã có
  index `idx_rec_lookup(slug, sort_order)` — không thêm chi phí đọc). Nếu
  `current.length === edges.length` và từng cặp
  `(target_tmdb_id, target_type, sort_order)` khớp theo thứ tự (edges luôn
  đã sắp theo `sortOrder` từ nơi gọi) → `return false`, **không** chạm D1
  ghi (bỏ qua cả DELETE lẫn INSERT, kể cả khi `edges.length === 0` khớp
  bảng rỗng). Đổi chữ ký `Promise<void>` → `Promise<boolean>` (`true` =
  đã ghi); caller (`refreshOneSource`) vẫn bỏ qua giá trị trả về, không cần
  sửa.

**EXPLAIN QUERY PLAN trên production (Luật chung #2)** cho SELECT `current`
đã sửa (thêm cột + `ORDER BY`), không tốn rows read:
```
SEARCH recommendation USING INDEX idx_rec_lookup (slug=?)
```
Không `SCAN`, không `TEMP B-TREE` — `ORDER BY sort_order` được phục vụ trực
tiếp bởi thứ tự index, không cần sắp lại.

**Test (`tests/recommendationRefresh.test.mjs`):**
- `replaceTargetsPreservingResolvedForSlug: an identical rank list is not
  rewritten`: gọi lại với đúng edge đã có trong `setup()` (`target 42,
  sort_order 0`) → `wrote === false`, `rowid` **không đổi**, `target_slug`
  vẫn `'existing-target'` (chứng minh không có DELETE+INSERT chạy).
- `...a reordered or expanded list is still rewritten`: đổi thứ tự + thêm
  một target mới → `wrote === true`, thứ tự mới đúng, và `rowid` của target
  cũ (42) **đổi** — bằng chứng lần này đúng là đi qua nhánh DELETE+INSERT,
  không phải nhánh no-op bị lọt qua do so sai.

**Verify (Luật chung #1) — tất cả xanh:**
`worker:typecheck` ok · `test:recommendation-refresh` 9 (7 cũ + 2 mới) ·
`test:recommendation-safety` 17 (không đụng, chỉ sanity check).

---

### Phase 5 — Tài liệu

Code xong 2026-09-12. Chỉ đổi comment/docs, không đổi hành vi/giá trị nào.

- `README.md`: 2 hàng Workflow (Resolve/Refresh) cập nhật mô tả — requeue
  theo sự kiện + quét định kỳ tối đa 1 lần/24h khi còn chỗ stub, ngân sách
  50 subrequest/**instance**, freshness seed bởi `0018` + tự ghi ở
  `syncOneMovie`, refresh bỏ qua ghi khi danh sách không đổi. Thêm đoạn ops
  ngay dưới bảng "Ops routes": `tmdb_override` chỉ ghi tay, kèm câu lệnh
  `UPDATE ... SET resolve_attempted = 0` cần chạy sau khi thêm override
  (đúng plan §1.5).
- `wrangler.toml`: comment trên `RECOMMENDATION_JOBS_ENABLED` — bỏ "still
  un-optimised", trỏ tới `docs/plan-recommendation-d1-reads.md` (Phase 1-5
  đã xong, Phase 6 chờ duyệt). Giá trị **không đổi**, vẫn `"false"`.
- `src-ssr/services/sync/dispatch.ts:52`: comment Q3/Q6 cập nhật tương tự
  — "fixed by ... Phases 1-4" thay vì "both recommendation jobs stay off
  until a dedicated plan optimises them".
- `docs/plan-incremental-sync-stall.md` Phase 5.3: thêm một dòng trỏ tới
  `docs/plan-recommendation-d1-reads.md` kèm trạng thái hiện tại.

**Verify (Luật chung #1, full gate cuối cùng trước khi dừng ở Phase 6):**
```
npm test
→ OK: 18/18 passed
```
(`worker:typecheck`, `build`, toàn bộ `test:*`, `wrangler deploy --dry-run`,
`git diff --check` — tất cả xanh.)

---

## Tóm tắt trạng thái sau Phase 1-5

- Code xong, đã commit theo từng phase (5 commit riêng biệt trên nhánh
  worktree hiện tại). **Chưa `git push`.**
- **Chưa** `wrangler d1 migrations apply` — migration `0018` vẫn nằm trong
  `migrations/`, chưa chạy trên production.
- **Chưa** đổi `RECOMMENDATION_JOBS_ENABLED` — vẫn `"false"`.
- **Chưa** chạy catch-up SQL một lần (plan §1.4).
- Việc còn lại thuộc Phase 6 (deploy + apply migration + catch-up + chạy
  thử tay + bật job + theo dõi 24h) — toàn bộ cần chủ dự án duyệt từng
  bước theo đúng plan, dừng lại ở đây để báo cáo.
