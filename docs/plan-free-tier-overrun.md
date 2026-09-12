# Plan — Sửa các điểm vượt/sát trần Cloudflare Free tier

> Nguồn: audit 2026-09-12 theo `docs/audit-prompt-free-tier.md`. Số liệu thật lấy
> từ `npx wrangler d1 info redflare-db --json` lúc ~08:32 UTC 2026-09-12:
>
> ```
> database_size     188,964,864 B (180 MiB)  → 37,8% của trần 500 MB/database
> rows_read_24h       1,646,970              → 32,9% của 5.000.000/ngày
> rows_written_24h       86,674              → 86,7% của 100.000/ngày
> read_queries_24h        1,995
> write_queries_24h       6,992
> ```
>
> Trạng thái thực thi ghi vào `docs/state-free-tier-overrun.md` (tạo ở Phase 0).

## Vấn đề

**V1 — Governor D1 không nhìn thấy phần lớn đường ghi.** `MAX_ROWS_PER_DAY = 85_000`
(`src-ssr/services/sync/orchestrator.ts:23`) chỉ được kiểm tra trong `syncSlugBatch`
(`orchestrator.ts:220-226`), và `addRowsWrittenToday` chỉ cộng `rowsWritten` do
`syncOneMovie` trả về (`orchestrator.ts:245`). Bốn đường ghi khác **không** được đếm và
**không** bị chặn:

| Đường ghi | Vị trí | Tần suất |
|---|---|---|
| recommendation refresh | `services/sync/recommendationRefresh.ts:26` | 20 source/giờ |
| recommendation resolve (tạo stub) | `orchestrator.ts` `resolveOneGroup` | mỗi tick 30' |
| hero snapshot | `repositories/heroSnapshotRepository.ts:86-88` | mỗi giờ |
| catalog stats | `repositories/catalogStatsRepository.ts:92-95` | tối đa 4 lần/ngày |

Hệ quả kép: `rowsWrittenToday` ở `/__sync/status` **báo thiếu** so với số D1 thật, và
nếu tổng chạm 100.000 thì **D1 từ chối mọi query** (đọc lẫn ghi) tới 00:00 UTC —
governor không có cách nào nổ kịp.

**V2 — `hero-snapshot` là Workflow duy nhất không có bộ đếm subrequest.**
`incremental-sync` chặn bằng `syncBudgetForPages`, `recommendation-resolve` chặn bằng
`callsUsed` vs `INSTANCE_SUBREQUEST_BUDGET` (`workflows/recommendationResolveWorkflow.ts:73`),
`recommendation-refresh` an toàn vì chỉ 20 fetch. Hero chỉ có heuristic "bỏ qua
`syncCanonical` nếu D1 đã có row" (`services/sync/heroSnapshot.ts:140-147`), không có
trần cứng. Worst case `1 + 20 + N×5`: chỉ cần **6 candidate trending chưa có trong D1**
là vượt 50 subrequest/instance. Khi vượt, fetch lỗi → `retryable_error` → `failed > 0` →
`heroSnapshotWorkflow.ts:60-66` **giữ snapshot cũ và bỏ toàn bộ kết quả**. Đây đúng là
sự cố 2026-09-11 (`docs/state-incremental-sync-stall.md` §5.2b: candidate thứ 20 lỗi,
`/api/health/sync` 503).

**V3 — Tài liệu ghi sai trần D1 và thiếu một giới hạn.** Trần Free là **500 MB cho mỗi
database** (5 GB là tổng account, 10 database/account). Ngoài ra Free giới hạn **50 D1
query/invocation** (Paid 1.000) — chưa chỗ nào trong repo nhắc; hot path hiện chỉ dùng
≤4 nên chưa vấn đề, nhưng phải ghi lại để không ai vô tình vượt.

**V4 — `[cache] enabled = true` khiến static asset bị tính vào 100.000 request/ngày.**
Docs Workers Cache: *"When caching is enabled, every request to your Worker is charged at
the standard Workers request rate, including requests that are normally free: static
asset requests and worker-to-worker invocations through service bindings."* Build ra 25
file; một lượt xem nguội ≈ 10–14 request → trần thật ~7.000–10.000 pageview nguội/ngày.
**Đây không phải bug và không sửa bằng code trong plan này** — nó là một đánh đổi kiến
trúc, xử lý ở Phase 4 (đo rồi trình chủ dự án quyết).

## Luật chung (áp cho mọi phase)

- **Không** `wrangler deploy` tay. Deploy = `git push origin main`, và **hỏi chủ dự án
  trước mỗi lần commit/push**.
- **Không** tạo migration mới. Không đường ghi nào trong plan này cần đổi schema.
- **Không** chạy `npm run db:migrate`.
- **Không** kích job sync (`scripts/rf-kick.sh`) để "thử" — mỗi lần chạy tiêu chính
  ngân sách D1 đang sửa. Nếu thật sự cần, hỏi chủ dự án trước.
- Gate trước mỗi commit: `node scripts/rf-test.mjs all` phải `OK: N/N`.
- Comment trong code viết bằng **tiếng Anh** (khớp `src-ssr/` hiện tại); tài liệu trong
  `docs/` viết **tiếng Việt**.
- Giữ nguyên phong cách file đang sửa. Không refactor kèm, không dọn dead code sẵn có
  (`getHashesBySlugs`, `idx_gm_list`/`idx_cm_list` — ghi nhận, không đụng).

## Quy ước đếm rows written (dùng chung Phase 2)

D1 tính **mỗi index cũng là một row written**. Giữ đúng quy ước đã có ở
`syncMovie.ts:132-137` (`movie.genres.length * 2` = 1 row + 1 index). Số index thật theo
`migrations/`:

| Bảng | Index (ngoài PK) | Rows/INSERT | Rows/DELETE+INSERT |
|---|---|---|---|
| `recommendation` | `idx_rec_lookup`, `idx_rec_target` | 3 | 6 |
| `recommendation_freshness` | `idx_recommendation_freshness_success` | 2 | — (upsert) |
| `hero_snapshot` | không | 1 | 2 |
| `catalog_stats` | không | 1 | 2 |

Đây là ước lượng có chủ ý, không cần chính xác tuyệt đối: governor là chốt an toàn ở
85.000 với 15.000 dư địa, và `addRowsWrittenToday` vốn đã "not exact under concurrent
shards" (`syncStateRepository.ts:36-38`).

---

## Phase 0 — Đo lại trước khi sửa (gate)

Mẫu 86.674 rows/ngày là **một mẫu 24h duy nhất**, và cửa sổ đó trùng đợt catch-up Phase 6
của `docs/plan-recommendation-d1-reads.md` (apply migration 0018 + trial thủ công +
backlog resolve). Ước lượng steady-state lý thuyết chỉ ~10–25k rows/ngày. Phải phân biệt
trước khi kết luận mức độ khẩn.

1. Chạy `npx wrangler d1 info redflare-db --json`, ghi cả 6 trường vào
   `docs/state-free-tier-overrun.md` kèm giờ UTC.
2. So với mốc 2026-09-12 08:32 UTC ở đầu file này.
   - `rows_written_24h` **giảm rõ về < 30.000** → V1 là rủi ro cấu trúc, không phải sự
     cố đang diễn ra. Vẫn làm Phase 2, nhưng ưu tiên sau Phase 1.
   - `rows_written_24h` **vẫn > 60.000** → V1 là sự cố đang diễn ra. Làm Phase 2 TRƯỚC
     Phase 1, và báo ngay chủ dự án.
3. Ghi kết luận rẽ nhánh vào state doc. Đây cũng chính là phép đo 24h mà
   `docs/state-recommendation-d1-reads.md` mục "6.6" đang hẹn — điền luôn vào đó.

**Verify:** state doc có số mới + một câu kết luận chọn nhánh.

---

## Phase 1 — Ngân sách subrequest cho `hero-snapshot` (sửa V2)

Mục tiêu: hero **không bao giờ** vượt 50 subrequest/instance, và khi hết ngân sách thì
**giảm chất lượng có kiểm soát** (bỏ qua việc sync candidate mới) thay vì tạo
`retryable_error` làm rơi cả snapshot.

Không dùng kiểu "dừng vòng lặp khi hết ngân sách" của resolve workflow: worst case
6 call/candidate sẽ chặn ở 8 candidate và làm rail hero ngắn lại trong khi steady state
mỗi candidate chỉ tốn 1 call. Thay vào đó truyền ngân sách còn lại xuống và chỉ cắt phần
`syncCanonical`.

### 1.1 `resolveCandidate` nhận ngân sách và báo cáo chi phí

`src-ssr/services/sync/heroSnapshot.ts`:

- Thêm hằng cạnh `HERO_LOOKUP_CONCURRENCY` (`heroSnapshot.ts:16`):
  ```ts
  // A candidate costs 1 (kkphim lookup) + up to MAX_FETCHES_PER_SYNC when it
  // still has to be synced. Free: 50 external subrequests per Workflow
  // instance (docs/state-incremental-sync-stall.md 5.2b).
  const HERO_SYNC_CALL_COST = MAX_FETCHES_PER_SYNC; // import từ orchestrator.ts
  ```
  `MAX_FETCHES_PER_SYNC` hiện là `const` private ở `orchestrator.ts:55` → đổi thành
  `export const` (chỉ thêm `export`, không đổi giá trị).
- Thêm biến thể kết quả mới vào `CandidateOutcome`: `{ kind: 'budget_skipped' }`.
- Đổi chữ ký:
  ```ts
  export async function resolveCandidate(
    candidate: TmdbTrendingMovie,
    deps: HeroRefreshDependencies,
    remainingCalls: number,
  ): Promise<CandidateOutcome & { externalCalls: number }>
  ```
  - Nếu `remainingCalls < 1` → trả `{ kind: 'budget_skipped', externalCalls: 0 }` ngay,
    không gọi gì.
  - `getMovieByTmdbId` → `externalCalls = 1`.
  - Tại nhánh `if (!isCatalogMovie(movie, candidate.id))` (`heroSnapshot.ts:146`): nếu
    `remainingCalls - 1 < HERO_SYNC_CALL_COST` → trả
    `{ kind: 'budget_skipped', externalCalls: 1 }` **thay vì** gọi `syncCanonical`.
  - Nếu có gọi `syncCanonical` → cộng `HERO_SYNC_CALL_COST` vào `externalCalls` (ước
    lượng worst case, đúng tinh thần `RESOLVE_MAX_CALLS_PER_GROUP`).
- `refreshHeroSnapshot` (`heroSnapshot.ts:78`): `mapLimit` chạy song song nên không đếm
  tuần tự được. Đổi sang vòng `for` tuần tự trên `candidates`, giữ một biến `used` khởi
  tạo `= 1` (đã tốn 1 fetch cho trending), truyền `INSTANCE_SUBREQUEST_BUDGET - used`.
  Bỏ `HERO_LOOKUP_CONCURRENCY` và `mapLimit` nếu không còn caller nào khác trong file
  (đây là orphan do thay đổi này tạo ra — được phép xoá theo CLAUDE.md §3).
- Đếm `budget_skipped` vào một biến riêng, **tuyệt đối không cộng vào `failed`** (vì
  `failed > 0` làm rơi snapshot). Thêm vào `HeroRefreshSummary` trường
  `budgetSkipped: number`.

### 1.2 `HeroSnapshotWorkflow` giữ ngân sách xuyên step

`src-ssr/workflows/heroSnapshotWorkflow.ts` — copy đúng pattern `callsUsed` của
`recommendationResolveWorkflow.ts:52-56, 73, 78`:

```ts
let callsUsed = 1; // fetch-trending above
for (const candidate of candidates) {
  const callsUsedBefore = callsUsed;
  const outcome = await step.do(`resolve-candidate-${candidate.id}`, () =>
    resolveCandidate(candidate, deps, INSTANCE_SUBREQUEST_BUDGET - callsUsedBefore)
  );
  callsUsed = callsUsedBefore + outcome.externalCalls;
  ...
}
```

`callsUsed` phải tái dựng từ giá trị step trả về (không phải từ biến ngoài) để replay
sau gián đoạn vẫn đúng — comment ở `recommendationResolveWorkflow.ts:53-56` giải thích
lý do, viết một comment tương tự ở đây.

Nhánh `if (failed > 0)` (`heroSnapshotWorkflow.ts:60`) giữ nguyên. Thêm
`budgetSkipped` vào object `result` để nó xuất hiện trong `recordAttempt`/`/__sync/status`.

### 1.3 Cập nhật comment sai

Comment đầu `heroSnapshotWorkflow.ts:14-20` và `heroSnapshot.ts:124-130` đang nói "mỗi
candidate một step … resolveCandidate skips re-syncing candidates already in D1" như thể
đó là cơ chế đủ. Viết lại: đó chỉ là heuristic, trần cứng nay do `callsUsed` vs
`INSTANCE_SUBREQUEST_BUDGET` giữ.

### 1.4 Test — `tests/heroSnapshotRefresh.test.mjs`

Thêm 3 ca (giữ nguyên các ca cũ):

1. **20 candidate đều chưa có trong D1** → tổng external fetch trong một instance **≤ 50**;
   số candidate được `syncCanonical` đúng `floor((50 - 1 - 20) / 5)`; các candidate còn
   lại là `budget_skipped`, `failed === 0`, và snapshot **vẫn được ghi**.
2. **20 candidate đều đã có trong D1** (steady state) → `budgetSkipped === 0`,
   `matched === 20`, tổng fetch = 21. Đây là ca chống hồi quy cho việc Phase 1 không
   được làm ngắn rail hero.
3. **`budget_skipped` không làm rơi snapshot**: 1 candidate `budget_skipped`,
   0 candidate lỗi → `replaceSnapshot` được gọi.

**Verify:** `npm run test:hero-refresh` xanh, `npm run worker:typecheck` xanh.

---

## Phase 2 — Governor bao mọi đường ghi D1 (sửa V1)

Mục tiêu: mọi đường ghi đều (a) kiểm tra ngân sách trước khi ghi, (b) cộng số rows đã
ghi vào cùng một counter. Không đổi ngưỡng `85_000`.

### 2.1 Tách module ngân sách

Tạo `src-ssr/services/sync/writeBudget.ts` — nhỏ, không thêm abstraction nào khác:

```ts
import type { SyncStateRepository } from '../../repositories/syncStateRepository';

/** Daily D1 row-write governor. Free plan hard cap is 100,000 rows
 * written/day, after which D1 rejects EVERY query (read included) until
 * 00:00 UTC; 85,000 leaves headroom for the writes this counter under-counts
 * (see the index accounting in docs/plan-free-tier-overrun.md). */
export const MAX_ROWS_PER_DAY = 85_000;

/** Every write path must call this before writing. Costs one indexed
 * sync_state read. */
export async function hasWriteBudget(syncState: SyncStateRepository): Promise<boolean> {
  return (await syncState.getRowsWrittenToday()) < MAX_ROWS_PER_DAY;
}
```

Xoá `const MAX_ROWS_PER_DAY = 85_000;` ở `orchestrator.ts:23`, import từ module mới, giữ
nguyên logic `syncSlugBatch` (chỉ đổi nguồn hằng số).

Lưu ý: `BACKFILL_MODE !== 'burst'` (`orchestrator.ts:220`) hiện là điều kiện bật governor.
Các đường ghi mới **luôn** kiểm tra, không phụ thuộc `BACKFILL_MODE` — burst chỉ có nghĩa
cho backfill trên Paid, còn hero/recommendation/stats chạy quanh năm.

### 2.2 `recommendation-refresh`

- `RecommendationRepository.replaceTargetsPreservingResolvedForSlug`
  (`recommendationRepository.ts:59`) đang trả `boolean`. Đổi thành `Promise<number>` =
  số rows đã ghi (`0` khi không đổi, ngược lại `edges.length * 6` theo bảng quy ước).
  Sửa mọi caller + test theo (`>0` thay cho `true`).
- `refreshOneSource` (`recommendationRefresh.ts:26`) trả thêm `rowsWritten`:
  số từ trên, cộng `2` cho `markAttempt` (`recommendation_freshness`, 1 index).
- `RecommendationRefreshWorkflow`: thêm một step `check-write-budget` ở đầu; nếu hết
  ngân sách thì return `{ skipped: 'write_budget' }` và không chạy gì. Cộng dồn
  `rowsWritten` qua các step theo đúng pattern `callsUsed`, và ở cuối gọi một step
  `record-rows-written` → `syncState.addRowsWrittenToday(total)` (chỉ khi `total > 0`).

### 2.3 `recommendation-resolve`

- `resolveOneGroup` (trong `orchestrator.ts`) trả thêm `rowsWritten` cạnh `externalCalls`
  đã có. Thành phần: rows do `syncOneMovie` trả về khi tạo stub, cộng số row
  `UPDATE recommendation SET target_slug …` × 3 (1 row + 2 index), cộng
  `resolve_attempted` update tương tự.
- `RecommendationResolveWorkflow`: step `check-write-budget` ở đầu (sau `count-stubs`);
  cộng dồn `rowsWritten` trong `batchResult` giống `callsUsed`; step
  `record-rows-written` ở cuối.

### 2.4 `hero-snapshot`

- `HeroSnapshotRepository.replaceSnapshot` (`heroSnapshotRepository.ts:86`) trả
  `Promise<number>` = `rows.length * 2` (DELETE + INSERT, bảng không index).
- `HeroSnapshotWorkflow`: step `check-write-budget` đặt ở **đầu**, ngay sau `check-gate`,
  return `{ skipped: 'write_budget', matched: 0, failed: 0 }`. Đặt ở đầu chứ không phải
  ngay trước `write-snapshot`: hết ngân sách ghi thì bỏ sớm để khỏi tốn cả 21+ subrequest
  lẫn quota TMDB cho một kết quả chắc chắn không ghi được.
- Cộng kết quả `replaceSnapshot` vào `addRowsWrittenToday`.

### 2.5 `catalog_stats`

- `CatalogStatsRepository.refresh()` (`catalogStatsRepository.ts:81`) trả
  `Promise<number>` = `rows.length * 2` (DELETE toàn bộ + INSERT lại) `+ 2` (stamp
  `sync_state` upsert). Trả `0` khi thoát sớm vì rate limit 6h.
- `getOrHeal` (`catalogStatsRepository.ts:41`) nhánh self-heal ghi 1 row — bỏ qua, không
  đếm (chạy cực hiếm, và nó nằm trên đường request người dùng nên không được thêm query).
- Hai caller (`IncrementalSyncWorkflow`, `RecommendationResolveWorkflow`) cộng số trả về
  vào tổng `rowsWritten` của mình. **Không** thêm `check-write-budget` riêng cho
  `refresh()` — nó đã nằm sau gate của hai workflow đó.

### 2.6 `/__sync/status` nói rõ counter là ước lượng

`src-ssr/routes/sync.ts:164` đang trả `rowsWrittenToday: rowsToday`. Thêm cạnh nó:

```ts
rowsWrittenTodayNote: 'estimate; counts row+index writes from sync/hero/recommendation/stats paths only',
```

và trong `quota`, thêm `rowsWrittenPercentUsed` = `rowsToday / 100000`. Đây là thứ
`scripts/rf-status.sh` và agent `rf-ops` đọc, nên đừng đổi tên trường cũ.

### 2.7 Test

- `tests/recommendationRefresh.test.mjs`: ca "hết ngân sách ghi → workflow không gọi
  TMDB và không ghi gì"; ca "ghi xong thì `addRowsWrittenToday` được gọi đúng một lần với
  tổng đúng".
- `tests/heroSnapshotRefresh.test.mjs`: ca "hết ngân sách ghi → không `replaceSnapshot`".
- `tests/catalogStats.test.mjs`: ca "`refresh()` trả đúng số rows", ca "thoát sớm vì rate
  limit → trả 0".
- `tests/recommendationFailureSafety.test.mjs`: ca resolve hết ngân sách ghi.

**Verify:** `node scripts/rf-test.mjs all` → `OK: N/N` (N tăng đúng bằng số script
`test:*` mới nếu có thêm; nếu chỉ thêm ca vào file cũ thì N không đổi).

---

## Phase 3 — Tài liệu (sửa V3)

- `README.md` "🤖 Luật dành cho AI agent" / bảng ngân sách Free: sửa trần D1 thành
  **500 MB/database** (5 GB là tổng account, 10 database/account), thêm dòng **50 D1
  query/invocation trên Free** (Paid 1.000), ghi mức dùng thật ngày 2026-09-12 làm mốc.
- `wrangler.toml`: comment ở block `[vars] BACKFILL_MODE` đang nói governor
  `MAX_ROWS_PER_DAY = 85_000 in orchestrator.ts` → đổi thành `writeBudget.ts` và ghi rõ
  nay nó bao cả hero/recommendation/stats.
- `docs/audit-prompt-free-tier.md`: sửa 3 dòng sai trong bảng khởi điểm (500 MB/database;
  thêm 50 query/invocation; Cron Triggers là 5/**account** chứ không phải 5/script).
- `docs/state-free-tier-overrun.md`: ghi kết quả từng phase.

**Verify:** `npm run build` + `git diff --check` sạch (nằm trong `rf-test.mjs all`).

---

## Phase 4 — V4: đo request rồi trình chủ dự án quyết (KHÔNG code)

Phase này **không sửa code**. `[cache] enabled = true` đang đổi static asset từ miễn phí
thành tính phí; gỡ nó đi là bỏ luôn lớp cache 60s/SWR trước Worker và mâu thuẫn với
ADR-0001/0002 — đó là quyết định của chủ dự án, không phải của agent.

1. Lấy số request thật 7 ngày (GraphQL Analytics API hoặc dashboard Workers → Metrics).
   Phiên audit 2026-09-12 **không có quyền** này (wrangler OAuth không đủ scope) nên đây
   vẫn là mảnh dữ liệu thiếu.
2. Đối chiếu: tổng request/ngày so với 100.000; tỉ lệ asset / `/api/*`; cache hit rate.
3. Trình chủ dự án 3 lựa chọn, kèm số, **không tự chọn**:
   - giữ nguyên (nếu còn xa trần);
   - giảm số asset mỗi pageview (gộp font subset, lazy-load `artplayer`/`hls.light`
     chỉ ở route xem phim — `hls.light` 332 KB + `artplayer` 140 KB hiện nằm trong
     bundle chung);
   - tắt `[cache]` và quay lại asset miễn phí, chấp nhận mọi `/api/*` đều chạm Worker + D1.
4. Ghi lựa chọn vào `docs/state-free-tier-overrun.md`. Nếu chọn phương án 2 hoặc 3 → mở
   plan riêng, không nhét vào plan này.

**Verify:** state doc có số thật + lựa chọn có chữ ký duyệt của chủ dự án.

---

## Phase 5 — Deploy

Từng bước, **mỗi bước chờ chủ dự án duyệt** (giống `plan-recommendation-d1-reads.md`
Phase 6):

1. `node scripts/rf-test.mjs all` → `OK: N/N`.
2. Commit tách bạch: một commit cho Phase 1, một cho Phase 2, một cho Phase 3.
3. `git push origin HEAD:main` (không `wrangler deploy`), chờ Workers Build.
4. Smoke: `bash scripts/rf-status.sh`; `/api/health/sync` phải 200.
5. Sau tick `*/30` kế tiếp: `/__sync/status` phải có `rowsWrittenToday` **tăng** (trước
   Phase 2 nó gần như đứng yên vì chỉ đếm sync) và `budgetSkipped` xuất hiện ở kết quả hero.
6. Sau 24h: `npx wrangler d1 info redflare-db --json`. Tiêu chí đạt:
   `rows_written_24h` < 50.000, `rows_read_24h` < 2.000.000, `/api/health/sync` luôn 200,
   và `rowsWrittenToday` ở `/__sync/status` đạt **ít nhất 60%** số `rows_written_24h`
   thật (chứng minh counter đã hết mù).

**Rollback:** revert commit tương ứng + push. Không có migration nên không cần rollback DB.

---

## Ngoài phạm vi (ghi nhận, không làm)

- **Luật "any failed candidate drops the whole hero snapshot"**
  (`heroSnapshotWorkflow.ts:60-66`). Phase 1 chỉ gỡ nguyên nhân do subrequest; luật
  all-or-nothing với 20 candidate độc lập vẫn mong manh trước lỗi mạng lẻ tẻ. Phương án
  thay thế (ghi snapshot khi `matched >= ngưỡng`) là đổi hành vi sản phẩm → cần plan riêng.
- `database_size` 189 MB / 500 MB (37,8%): còn dư địa nhưng tăng theo catalog. Chưa đo
  được tốc độ tăng (một mẫu duy nhất) → theo dõi ở mỗi lần chạy Phase 0, chưa hành động.
- Dead code sẵn có: `MovieRepository.getHashesBySlugs`, `idx_gm_list`/`idx_cm_list`.
- Workers Logs (200.000 event/ngày, vượt thì tự sample 1%), Cron Triggers (1/5),
  Turnstile, D1 rows read (32,9%), Workflow executions (144/100.000): đều AN TOÀN theo
  audit 2026-09-12, không cần làm gì.
