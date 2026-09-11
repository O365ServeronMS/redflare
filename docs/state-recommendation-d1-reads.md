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
