# Plan — Tối ưu D1 reads của Recommendation (Q3/Q6) để bật lại job

**Người thực hiện:** Sonnet (effort medium). **Người duyệt:** chủ dự án.
**Nhánh:** làm trên worktree hiện tại, commit theo từng phase. **Không** `git push`,
**không** `wrangler deploy`, **không** `wrangler d1 migrations apply` và **không** đổi
`RECOMMENDATION_JOBS_ENABLED` khi chưa có chủ dự án duyệt ở đúng bước đó (xem Phase 6).

Liên quan: `docs/plan-incremental-sync-stall.md` (Q1–Q6 audit), `docs/state-incremental-sync-stall.md`
(5.2b: trần 50 subrequest **mỗi instance** Workflow trên Free).

---

## 0. Bối cảnh & số liệu đo (2026-09-11, production)

Hai job recommendation (`RecommendationResolveWorkflow`, `RecommendationRefreshWorkflow`)
đang tắt bằng `[vars] RECOMMENDATION_JOBS_ENABLED = "false"` vì chi phí đọc D1 vượt
ngân sách Free (5M rows read/ngày, vượt là D1 từ chối **mọi** query tới 00:00 UTC).

**Quy mô bảng:**

| Bảng / tập | Số dòng |
|---|---|
| `recommendation` | 195.783 |
| — chưa resolve, `resolve_attempted = 0` (pending) | 540 |
| — chưa resolve, `resolve_attempted = 1` (overflow) | 77.646 |
| — overflow mà target **nay đã có** trong `movie` | **4** |
| `recommendation_freshness` | 6.268 (success 6.215, valid_empty 33, retryable 20) |
| movie catalog đủ điều kiện refresh (`tier='catalog'`, có tmdb) nhưng **chưa có** dòng freshness | 6.931 |
| `movie` / stub | 30.834 / 1.000 (`MAX_STUBS = "1000"` → **stub đã đầy**) |

**`wrangler d1 insights --timePeriod=31d`:**

| # | Query | Số lần | Rows read TB/lần | Tổng |
|---|---|---|---|---|
| **Q3** | CTE `WITH grouped` — `getOverflowGroupsForRequeue` (`recommendationRepository.ts:145`) | 1.356 | **94.024** | **127,5M** |
| Q7 | `getUnresolvedGroupedByTarget` (`recommendationRepository.ts:119`) | 1.247 | 37.752 (lúc còn backlog pending) | 47,1M |
| **Q6** | `getDueSources` (`recommendationFreshnessRepository.ts:12`) | 574 | **29.435** | 16,9M |

**EXPLAIN QUERY PLAN hiện tại:**
- Q3: `SCAN r USING INDEX idx_rec_overflow` (đọc **toàn bộ** ~77,6k dòng overflow) + lookup
  `movie`/`tmdb_override` cho từng dòng + `TEMP B-TREE FOR ORDER BY`.
- Q6: `SEARCH m USING INDEX idx_movie_tmdb (tmdb_type=? AND tmdb_id>?)` (đọc gần hết ~30k
  movie) + lookup freshness từng dòng + `TEMP B-TREE`.
- Q7: `SCAN r USING INDEX idx_rec_pending` — tỉ lệ với số dòng pending (nay 540 → vài nghìn
  rows/lần, chấp nhận được). **Không sửa trong plan này**, chỉ theo dõi.

**Nếu bật lại nguyên trạng:** resolve chạy mỗi tick `*/30` (48/ngày) → Q3 ≈ 94k × 48 ≈
**4,5M/ngày** — một mình Q3 đã chạm trần 5M. Q6 chạy hourly ≈ 0,7M/ngày.

### Vì sao Q3 gần như vô ích
Q3 tìm các nhóm overflow nên "mở lại" (`resolve_attempted = 1 → 0`) vì:
1. target **đã có trong catalog** (`has_local_target = 1`), hoặc
2. còn chỗ stub (`maxStubs > stubCount`) và `ref_count >= 2`.

Stub đang đầy (1000/1000) → nhánh 2 tắt. Nhánh 1 chỉ đổi khi **một movie có
`tmdb_id` được ghi vào D1** — một sự kiện đã biết trước ở `syncOneMovie`. Quét 77,6k dòng
mỗi 30 phút để tìm **4** dòng là thừa. → Thay bằng requeue theo sự kiện (Phase 1).

### Vì sao Q6 đắt
"Nguồn chưa từng refresh" được định nghĩa bằng **không có dòng freshness** → phải anti-join
từ `movie` (quét ~30k). 6.931 movie đủ điều kiện chưa có dòng vì `syncOneMovie` **có** gọi
TMDB recommendations khi ghi movie nhưng **không** ghi `recommendation_freshness`.
→ Seed dòng freshness cho mọi nguồn đủ điều kiện, `syncOneMovie` tự ghi freshness, rồi viết
lại Q6 để đi từ `recommendation_freshness` qua index (Phase 2).

### Hai vấn đề phụ phải sửa cùng lúc (không thì bật lại vẫn hỏng)
- **Subrequest theo instance (5.2b):** `RecommendationResolveWorkflow` giả định "50/step"
  (`GROUPS_PER_STEP = 8`). Thực tế 50 là cho **cả instance** → sau vài nhóm phải gọi KKPhim,
  mọi fetch còn lại lỗi và bị tính `retryable`. Phase 3.
- **Write budget:** `refreshOneSource` luôn `DELETE` + `INSERT` lại ~15 edge (~75 rows written
  tính cả index) kể cả khi TMDB trả đúng danh sách cũ. 20 nguồn × 24 lần/ngày ≈ 36k writes/ngày
  trên trần 100k/ngày. Phase 4: bỏ qua ghi khi danh sách không đổi.

---

## Luật chung (áp cho mọi phase)

1. Sau mỗi phase: `npm run worker:typecheck`, test của file đã sửa, rồi cuối cùng
   `npm test` (full gate phải in `OK`). Dùng agent `rf-test` nếu muốn tiết kiệm token.
2. Mỗi query mới/sửa: chạy **EXPLAIN QUERY PLAN trên production** (không tốn rows read):
   ```
   npx wrangler d1 execute redflare-db --remote --json --command "EXPLAIN QUERY PLAN <sql với literal>"
   ```
   Ghi output vào state doc. Nếu thấy `SCAN <bảng lớn>` hoặc `TEMP B-TREE` ngoài dự kiến → dừng,
   báo lại, không tự "sáng tạo" index mới ngoài plan.
3. **Không** chạy query `COUNT(*)`/aggregate trên `recommendation` (mỗi lần ~200–460k rows read).
   Cần số liệu thì dùng `wrangler d1 insights`.
4. Giữ đúng style file đang sửa (comment dài, giải thích lý do + số liệu, tiếng Anh trong code).
5. Ghi nhật ký vào `docs/state-recommendation-d1-reads.md` (tạo mới, cùng format các
   `docs/state-*.md` khác): mỗi phase làm gì, EXPLAIN, số test, việc còn lại.

---

## Phase 1 — Q3: requeue theo sự kiện thay cho quét định kỳ

### 1.1 `RecommendationRepository.requeueTarget`
File `src-ssr/repositories/recommendationRepository.ts`, thêm ngay dưới `requeueAttemptedGroups`:

```ts
/** Event-driven replacement for the periodic overflow scan: when a movie
 * with this TMDB identity is written to D1, its overflow edges become
 * resolvable locally. Reads only this group's rows via idx_rec_overflow. */
async requeueTarget(targetType: TmdbType, targetTmdbId: number): Promise<void> {
  await this.db
    .prepare(
      `UPDATE recommendation SET resolve_attempted = 0
       WHERE target_tmdb_id = ? AND target_type = ?
         AND target_slug IS NULL AND resolve_attempted = 1`
    )
    .bind(targetTmdbId, targetType)
    .run();
}
```
EXPLAIN kỳ vọng: `SEARCH recommendation USING INDEX idx_rec_overflow (target_tmdb_id=? AND target_type=?)`.

### 1.2 Gọi từ `syncOneMovie`
File `src-ssr/services/sync/syncMovie.ts`, nhánh **written** (sau `repos.search.indexMovie(...)`),
khi `tmdbId && tmdbType` (biến local đã có sẵn trong hàm):
```ts
await repos.recommendation.requeueTarget(tmdbType, tmdbId);
```
Kèm comment ngắn: lý do (thay Q3, số liệu 94k rows/lần), và rằng nhánh `unchanged` không cần
vì identity TMDB không đổi thì hash cũng không đổi… **Kiểm tra lại giả định này**: nếu
`hashMovie` không bao gồm `tmdbId`, ghi rõ trong comment rằng một title đổi tmdb mà hash không đổi
sẽ không được requeue (chấp nhận, cực hiếm).

Không cần sửa `resolveOneGroup` (nhánh stub tự `markResolved`).

### 1.3 `requeueOverflowGroups` chỉ chạy khi còn chỗ stub, tối đa 1 lần/24h
File `src-ssr/services/sync/orchestrator.ts` (`requeueOverflowGroups`, ~dòng 701):
- Đầu hàm: nếu `maxStubs <= stubCount` → `return { candidates: 0, requeued: 0 }` **không đọc D1**.
- Nếu còn chỗ stub: đọc key `sync_state` `recommendation:requeue_scan_at`; nếu < 24h → return 0/0.
  Chạy xong (kể cả phân trang cursor như cũ) thì ghi lại key. Cursor logic giữ nguyên.
- Comment: lý do + "khi nâng `MAX_STUBS`, lần quét đầu tiên xảy ra trong ≤24h; muốn ngay thì
  xoá key `recommendation:requeue_scan_at`".
- `getOverflowGroupsForRequeue` giữ nguyên SQL (chỉ còn chạy tối đa 1 lần/ngày khi có chỗ stub).

### 1.4 Catch-up một lần (ops, Phase 6)
4 dòng overflow đã có target local sẽ không được hook 1.2 bắt (movie đã ghi từ trước).
SQL chạy **một lần** khi deploy (≈78k rows read, ~12 rows written):
```sql
UPDATE recommendation SET resolve_attempted = 0
WHERE target_slug IS NULL AND resolve_attempted = 1
  AND EXISTS (SELECT 1 FROM movie m WHERE m.tmdb_type = recommendation.target_type AND m.tmdb_id = recommendation.target_tmdb_id);
```
Không đưa vào migration (không cần lặp lại). Ghi vào state doc khi chạy.

### 1.5 Tài liệu ops
README, mục ops/recommendation: `tmdb_override` chỉ được ghi tay (không có code nào insert).
Sau khi thêm một override, chạy `UPDATE ... SET resolve_attempted = 0 WHERE target_tmdb_id = ?
AND target_type = ? AND target_slug IS NULL` cho đúng target đó.

### 1.6 Test (`tests/recommendationFailureSafety.test.mjs`)
- **Sửa** test `requeues a local target at the stub cap, then resolves idempotently without upstream`
  (~dòng 268): hành vi mới là tick **không** tự requeue khi stub đầy. Viết lại thành:
  (a) tick đầu: `requeueCandidates === 0`, target vẫn overflow, **không** fetch;
  (b) gọi `new RecommendationRepository(db).requeueTarget('movie', 42)`;
  (c) tick sau: `resolvedToExisting === 1`, không fetch upstream; (d) tick thứ ba: 0 việc.
- **Thêm:** `syncOneMovie` ghi một movie có tmdb (movie, 42) → edge overflow trỏ (42, movie) chuyển
  `resolve_attempted = 0`. Dùng lại harness `setupResolver`/fetch mock sẵn có trong file.
- **Thêm:** còn chỗ stub → lần 1 quét (có candidate), lần 2 trong 24h → `requeueCandidates === 0`.
- Test `dry-run selects only overflow groups...` (~dòng 293) gọi thẳng repo → giữ nguyên, phải xanh.

**Xong khi:** typecheck + `test:recommendation-safety` xanh; EXPLAIN 1.1 đúng kỳ vọng.

---

## Phase 2 — Q6: freshness đầy đủ + query đi từ index

### 2.1 Migration `migrations/0018_recommendation_freshness_seed.sql`
Comment đầu file: lý do (Q6, 29k rows/lần; 6.931 nguồn thiếu dòng), ngữ nghĩa seed.
```sql
INSERT OR IGNORE INTO recommendation_freshness (slug, last_success_at, last_attempt_at, result)
SELECT slug, last_synced, last_synced, 'seeded'
FROM movie
WHERE tier = 'catalog' AND tmdb_id IS NOT NULL AND tmdb_type IN ('movie', 'tv');
```
- Seed `last_success_at = last_synced`: `syncOneMovie` gọi TMDB recommendations mỗi lần ghi movie
  có tmdb, nên lần ghi gần nhất ≈ lần có recs gần nhất. Tránh "6.931 nguồn cùng hạn ngay" dồn một cục.
- Chi phí dự kiến: ~30k rows read, ~14k rows written (6.931 dòng + index
  `idx_recommendation_freshness_success`). **Chưa apply** — Phase 6.
- `result = 'seeded'` là giá trị mới; kiểm tra (grep) không có code nào switch trên
  `recommendation_freshness.result` ngoài `markAttempt` (đã kiểm: chỉ `markAttempt` dùng
  `excluded.result`). Ghi nhận vào state doc.

### 2.2 `syncOneMovie` ghi freshness
File `src-ssr/services/sync/syncMovie.ts`, nhánh **written**, khi `tmdbId && tmdbType`:
- `recommendation.kind === 'success'` → `markAttempt(slug, ids.length === 0 ? 'valid_empty' : 'success')`.
- `recommendation.kind === 'retryable_error'` → `markAttempt(slug, 'retryable_error')` (giữ
  `last_success_at` cũ nhờ CASE trong upsert; nguồn mới sẽ có `last_success_at NULL` → Q6 nhánh A nhặt).
- Cần thêm `RecommendationFreshnessRepository` vào `repos` của `syncOneMovie`. Tìm **mọi** caller
  (`grep -rn "syncOneMovie(" src-ssr tests`) và cập nhật: `buildRepos` trong `orchestrator.ts`,
  `buildDependencies` trong `heroSnapshot.ts`, các test harness. Không đổi hành vi nhánh `unchanged`
  (vẫn 0–1 row written).

### 2.3 Viết lại `getDueSources`
File `src-ssr/repositories/recommendationFreshnessRepository.ts`. Giữ chữ ký + thứ tự kết quả
(chưa-từng-thành-công trước, rồi `last_success_at` cũ nhất). Hai query tuần tự:

```sql
-- A: chưa từng thành công, hết thời gian chờ retry
SELECT m.slug, m.tmdb_id, m.tmdb_type
FROM recommendation_freshness f CROSS JOIN movie m
WHERE m.slug = f.slug
  AND f.last_success_at IS NULL AND f.last_attempt_at <= ?
  AND m.tier = 'catalog' AND m.tmdb_id IS NOT NULL AND m.tmdb_type IN ('movie', 'tv')
ORDER BY f.slug
LIMIT ?

-- B: hết TTL (chỉ chạy nếu A trả < limit, LIMIT = limit - A.length)
SELECT m.slug, m.tmdb_id, m.tmdb_type
FROM recommendation_freshness f CROSS JOIN movie m
WHERE m.slug = f.slug
  AND f.last_success_at <= ?
  AND m.tier = 'catalog' AND m.tmdb_id IS NOT NULL AND m.tmdb_type IN ('movie', 'tv')
ORDER BY f.last_success_at, f.slug
LIMIT ?
```
`CROSS JOIN` ép SQLite đi từ `f` (SQLite giữ thứ tự bảng với CROSS JOIN).
EXPLAIN kỳ vọng: `SEARCH f USING INDEX idx_recommendation_freshness_success (last_success_at=?)`
/ `(last_success_at<?)`, `SEARCH m USING INDEX sqlite_autoindex_movie_1 (slug=?)`, **không** có
`TEMP B-TREE`. Có TEMP B-TREE → báo lại trước khi làm tiếp.

Comment trong code: số liệu cũ (29.435 rows/lần), giả định "mọi nguồn đủ điều kiện đều có dòng
freshness" (seed 0018 + 2.2), và hệ quả: movie mất tmdb/đổi tier vẫn còn dòng freshness nhưng bị
lọc bởi điều kiện trên `m` (rows đọc thêm không đáng kể).

### 2.4 `getRecommendationSourceByTmdbRef` (`movieRepository.ts:150`)
Không sửa SQL. Chỉ ghi vào state doc: sau seed, dòng `seeded` có `last_success_at` non-NULL nên
được ưu tiên hơn dòng NULL khi một TMDB id có nhiều bản catalog — chấp nhận (đúng nghĩa "có recs").

### 2.5 Test (`tests/recommendationRefresh.test.mjs`)
Harness đang tạo schema bằng tay + đọc `0011`. Thêm đọc `0018` sau khi insert movie (hoặc
insert dòng freshness tương ứng) để khớp giả định mới. Thêm các ca:
- nguồn `last_success_at NULL` + `last_attempt_at` quá hạn đứng trước nguồn hết TTL;
- nguồn `NULL` nhưng vừa retry (< 30 phút) bị bỏ qua;
- nguồn hết TTL sắp theo `last_success_at` tăng dần; `limit` cắt đúng qua A+B;
- movie `tier='stub'` hoặc không có tmdb (dù có dòng freshness) không được trả về.
Thêm ca trong `recommendationFailureSafety`: `syncOneMovie` nhánh written ghi dòng freshness
`success` (và `retryable_error` khi TMDB recs lỗi).

**Xong khi:** typecheck + `test:recommendation-refresh` + `test:recommendation-safety` +
`test:incremental-sync` + `test:hero-refresh` xanh; EXPLAIN 2.3 đúng kỳ vọng.

---

## Phase 3 — Resolve: ngân sách subrequest theo instance

File `src-ssr/services/sync/orchestrator.ts` + `src-ssr/workflows/recommendationResolveWorkflow.ts`.

- `orchestrator.ts`: export hằng `INSTANCE_SUBREQUEST_BUDGET` (hiện là `const` private, = 50,
  dùng bởi `syncBudgetForPages`). Thêm `RESOLVE_MAX_CALLS_PER_GROUP = 6`
  (KKPhim `/tmdb` lookup 1 + `syncOneMovie` tối đa 5; nhánh stub = 1 + TMDB detail 1).
- `ResolveGroupOutcome` thêm `externalCalls: number` — **ước lượng trên**: local = 0;
  lookup lỗi/not-found→overflow = 1; found → 1 + 5; stub = 2 (kể cả khi TMDB lỗi). Cập nhật mọi
  `return` trong `resolveOneGroup`.
- Workflow: giữ batch step (`GROUPS_PER_STEP`), nhưng mỗi batch step nhận `callsUsedBefore`
  và trả thêm `{ callsUsed, stopped }`; trong batch, **trước** mỗi group: nếu
  `callsUsed + RESOLVE_MAX_CALLS_PER_GROUP > INSTANCE_SUBREQUEST_BUDGET` → dừng, `stopped = true`.
  Vòng ngoài cộng dồn `callsUsed` **từ output của step** (replay-safe, giống `stubCount`) và
  `break` khi `stopped`. Group chưa xử lý vẫn pending → tick sau.
- Kết quả instance thêm `deferred` (số group chưa xử lý) — hoặc nếu không muốn đổi shape, ghi
  trong comment rằng `groupsSeen - (existing+stub+overflow+retryable)` là số bị hoãn.
- Sửa comment `GROUPS_PER_STEP` (hiện nói "50/step" — sai, dẫn 5.2b).
- `runRecommendationResolveTick` (route tay `/__sync/resolve-recommendations`) chạy trong một
  invocation `fetch` → cùng trần 50: áp cùng ngân sách (dừng vòng lặp khi hết).
- `RecommendationRefreshWorkflow`: 20 nguồn × 1 TMDB call = 20 ≤ 50 → không đổi logic, chỉ sửa
  comment đầu file cho đúng ("50 per instance").

**Test:** thêm vào `recommendationFailureSafety`: 20 group non-local, KKPhim trả found cho tất cả,
ngân sách chỉ cho phép `floor(50/6) = 8` group; group thứ 9+ không bị gọi fetch và vẫn pending.
Group local (0 call) không tiêu ngân sách: 30 group local + 20 non-local → 30 resolved local + 8 upstream.

---

## Phase 4 — Refresh: không ghi lại khi danh sách không đổi

File `src-ssr/repositories/recommendationRepository.ts`, `replaceTargetsPreservingResolvedForSlug`:
- Sau khi đọc `current` (đã có), nếu `current` có cùng số phần tử và từng edge
  `(target_type, target_tmdb_id, sort_order)` trùng khớp `edges` → **return** không batch.
  (Cần thêm `sort_order` vào SELECT `current`.)
- Trả `Promise<boolean>` (`true` = đã ghi) nếu tiện cho test; caller hiện tại bỏ qua giá trị.
- Comment: số liệu (~75 rows written/lần ghi lại, 36k/ngày ở cadence hiện tại).

**Test** (`recommendationRefresh.test.mjs`): refresh 2 lần với cùng id → lần 2 không đổi
`rowid`/không có DELETE (kiểm bằng cách so `SELECT rowid, * FROM recommendation` trước/sau, hoặc
spy `db.batch`). Ca đổi thứ tự hoặc thêm id → vẫn ghi.

---

## Phase 5 — Tài liệu

- `README.md`: bảng Workflows (hàng Resolve/Refresh): requeue theo sự kiện, freshness seed,
  ngân sách 50/instance, refresh bỏ qua ghi khi không đổi; mục ops 1.5.
- `wrangler.toml`: comment trên `RECOMMENDATION_JOBS_ENABLED` — thay "Q3/Q6 still un-optimised"
  bằng trỏ tới plan này (giá trị vẫn `"false"` ở phase này).
- `src-ssr/services/sync/dispatch.ts:52`: cập nhật comment Q3/Q6.
- `docs/plan-incremental-sync-stall.md` Phase 5.3: thêm một dòng trỏ tới plan này.

---

## Phase 6 — Deploy & bật lại (từng bước, **mỗi bước chờ chủ dự án duyệt**)

Đo trước: `npx wrangler d1 insights redflare-db --timePeriod=1d --sort-by=reads --limit=15`
(ghi baseline vào state doc).

1. **Push code Phase 1–5** (job vẫn tắt). `/rf-deploy`. Smoke pass.
2. **Apply `0018`** (`npx wrangler d1 migrations apply redflare-db --remote`). Đọc `rows_written`
   (kỳ vọng ~14k). Kiểm: `EXPLAIN QUERY PLAN` 2.3 lại trên prod.
3. **Catch-up 1.4** (một lần).
4. **Chạy thử mỗi job một lần bằng tay:** `bash scripts/rf-kick.sh recs --force`, rồi
   `bash scripts/rf-kick.sh recs-refresh --force`. Xem output instance
   (`npx wrangler workflows instances describe recommendation-resolve latest`) và
   `d1 insights --timePeriod=1d`:
   - requeue step: **0 rows read** (stub đầy);
   - `getUnresolvedGroupedByTarget` < 10k rows/lần;
   - `getDueSources` (2 query mới) tổng < 1k rows/lần;
   - resolve instance không có group `retryable` do hết subrequest.
   Không đạt → dừng, báo lại.
5. **Bật:** đổi `RECOMMENDATION_JOBS_ENABLED = "true"` trong `wrangler.toml` (không sửa trên
   dashboard — deploy sau sẽ ghi đè), commit riêng, `/rf-deploy`.
6. **Theo dõi 24h:** tổng D1 rows read/ngày < 2M, rows written/ngày < 50k (cả hệ thống),
   `/api/health/sync` vẫn 200. Ghi số thật vào state doc.

**Rollback:** đặt lại `RECOMMENDATION_JOBS_ENABLED = "false"` + deploy. Migration 0018 chỉ thêm
dòng, không cần rollback.

---

## Ngoài phạm vi (ghi nhận, không làm)

- `/__sync/status`: `getResolveStats` quét toàn bảng `recommendation` (~190k rows/lần) và
  `countByTier` quét `movie` — mỗi lần `rf-status.sh` có `CRON_KEY` là ~250k rows. Plan riêng:
  `docs/plan-sync-status-d1-reads.md`.
- Q7 (`getUnresolvedGroupedByTarget`) tỉ lệ với số pending; ổn khi pending vài trăm–vài nghìn.
  Nếu pending tăng > 20k (vd. sau khi nâng `MAX_STUBS` hoặc sync hàng loạt) → cần plan riêng.
- Throughput refresh: 20 nguồn/giờ = 480/ngày trên ~13k nguồn, TTL 14 ngày → mỗi nguồn thực tế
  ~27 ngày mới refresh. Chấp nhận; tăng limit phải tính lại write budget.
- Dọn `idx_gm_list`/`idx_cm_list`, `getHashesBySlugs` (đã ghi ở state doc sync-stall).
