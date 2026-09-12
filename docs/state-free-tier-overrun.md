# State — Sửa các điểm vượt/sát trần Cloudflare Free tier

Theo dõi thực thi `docs/plan-free-tier-overrun.md`.

## Phase 0 — Đo lại trước khi sửa

**Đo lúc 2026-09-12 00:55 UTC** (`npx wrangler d1 info redflare-db --json`):

```
database_size        188,964,864 B (180 MiB)  → 37,8% của trần 500 MB/database
rows_read_24h         1,646,970                → 32,9% của 5.000.000/ngày
rows_written_24h         86,674                → 86,7% của 100.000/ngày
read_queries_24h          1,995
write_queries_24h         6,992
```

Số liệu **giống hệt** mốc baseline ghi ở đầu `docs/plan-free-tier-overrun.md`
("~08:32 UTC 2026-09-12"). Đối chiếu giờ commit thật: mốc baseline đó gắn với
commit `97a179d` (`2026-09-12T08:51:54+08:00` = `2026-09-12T00:51:54Z`) — tức
nhãn "08:32 UTC" trong plan là giờ local +08 ghi nhầm thành UTC, chứ không phải
hai lần đo cách nhau 8 giờ. Giờ đo lần này (00:55 UTC) chỉ cách mốc đó ~23
phút, và cách lúc deploy commit `98b4c1c` (job recommendation-resolve/-refresh
được bật, `2026-09-11T20:12:05Z`) mới **~4 giờ 43 phút** — chưa đủ 24h.

**Kết luận rẽ nhánh:** chưa thể phân biệt steady-state so với đợt catch-up
Phase 6, vì đây gần như là cùng một phép đo (D1 tính cửa sổ trượt 24h, và mới
~23 phút trôi qua từ baseline). Áp dụng nguyên văn ngưỡng của plan
(`rows_written_24h` vẫn > 60.000) thì rơi vào nhánh **"V1 là sự cố đang diễn
ra"** → làm Phase 2 TRƯỚC Phase 1, báo ngay chủ dự án. Nhưng vì phép đo này
không độc lập với baseline (khoảng cách quá ngắn), đây là kết luận **thận
trọng theo ngưỡng cứng của plan**, không phải bằng chứng chắc chắn có sự cố
mới — cần đo lại sau khi cửa sổ 24h dịch qua khỏi đợt catch-up Phase 6 (tức
sau ~2026-09-12 20:12 UTC, 24h kể từ deploy `98b4c1c`) để có số steady-state
thật.

Mục "6.6" ở `docs/state-recommendation-d1-reads.md` (đo 24h sau deploy
`98b4c1c`) **vẫn chưa đến hạn** — mới ~4h43m trôi qua, chưa đủ 24h — nên chưa
điền số vào đó; giữ nguyên trạng thái "chưa làm trong phiên này" ở file đó.

**Nhánh áp dụng cho các phase sau:** theo ngưỡng cứng, làm **Phase 2 trước
Phase 1**.

## Phase 2 — Governor bao mọi đường ghi D1 (sửa V1)

Thực hiện đúng §2.1–2.7 của plan:

- `src-ssr/services/sync/writeBudget.ts` (mới): `MAX_ROWS_PER_DAY = 85_000` +
  `hasWriteBudget(syncState)`. `orchestrator.ts` xoá hằng số cục bộ, import từ
  đây; logic governor sẵn có của `syncSlugBatch` giữ nguyên.
- `recommendation-refresh`: `replaceTargetsPreservingResolvedForSlug` trả
  `Promise<number>` (`0` hoặc `edges.length * 6`); `refreshOneSource` cộng
  thêm `2` cho `markAttempt`; `RecommendationRefreshWorkflow` có step
  `check-write-budget` ở đầu, cộng dồn `rowsWritten` qua các step theo đúng
  pattern `callsUsed`, step `record-rows-written` ở cuối.
- `recommendation-resolve`: `resolveOneGroup` trả thêm `rowsWritten`;
  `RecommendationResolveWorkflow` có `check-write-budget` ngay sau
  `count-stubs`, cộng dồn `rowsWritten`, `record-rows-written` ở cuối.
- `hero-snapshot`: `HeroSnapshotRepository.replaceSnapshot` trả
  `Promise<number>` (`rows.length * 2`); `HeroSnapshotWorkflow` có
  `check-write-budget` ngay sau `check-gate` (trước `fetch-trending`, để
  khỏi tốn subrequest TMDB/KKPhim khi chắc chắn không ghi được).
- `catalog_stats`: `CatalogStatsRepository.refresh()` trả `Promise<number>`
  (`rows.length * 2 + 2`, hoặc `0` khi thoát sớm vì rate-limit 6h). Không
  thêm `check-write-budget` riêng — nằm sau gate của hai Workflow gọi nó.
- `/__sync/status`: thêm `rowsWrittenTodayNote` và `quota.rowsWrittenPercentUsed`
  (giữ nguyên tên trường `rowsWrittenToday` cũ cho `rf-status.sh`/`rf-ops`).
- Test: thêm ca vào 4 file test có sẵn (`recommendationRefresh.test.mjs`,
  `heroSnapshotRefresh.test.mjs`, `catalogStats.test.mjs`,
  `recommendationFailureSafety.test.mjs`) — không thêm script `test:*` mới.
  `node scripts/rf-test.mjs all` → `OK: 18/18`.

**Vượt phạm vi liệt kê của §2.1–2.7 (nhưng đúng mục tiêu "mọi đường ghi đều"
của Phase 2):** `IncrementalSyncWorkflow` gọi `syncOneMovie` trực tiếp theo
từng slug thay vì `syncSlugBatch` đã có governor — tra `grep` xác nhận
`syncSlugBatch` chỉ được gọi từ `runIncrementalSync` (hàm thủ công/đã nghỉ) và
route thủ công `/__sync/batch`, **chưa bao giờ** từ Workflow sản xuất (chạy
mỗi 30 phút, khối lượng ghi lớn nhất hệ thống). Đây là một lỗ hổng governor
thật, không phải diễn giải rộng — nên đã vá thêm: `IncrementalSyncWorkflow`
có step `check-write-budget` sau `scan-recent-pages`; hết ngân sách thì bỏ
qua toàn bộ vòng lặp sync-per-slug (danh sách `deferred` bao hết, tick sau
lấy lại); cộng dồn `rowsWritten` từ `syncOneMovie` mỗi slug + từ
`refresh-catalog-stats`; `record-rows-written` ở cuối.

Chưa chạy `git commit`/`push` cho các thay đổi Phase 2 này trong phiên này —
chờ xác nhận trước khi commit.

## Phase 1 — Ngân sách subrequest cho hero-snapshot (sửa V2)

Thực hiện đúng §1.1–1.4 của plan:

- `orchestrator.ts`: chỉ thêm `export` cho `MAX_FETCHES_PER_SYNC` (không đổi
  giá trị `5`); `INSTANCE_SUBREQUEST_BUDGET = 50` đã export sẵn từ trước.
- `types/heroSnapshot.ts`: thêm `budgetSkipped: number` vào `HeroRefreshResult`
  (schema JSON lưu ở `sync_state` key `hero:last_result`).
  `heroSnapshotRepository.ts`: `validateMetadata`/`parseResult` theo đó thêm
  trường này vào danh sách kiểm tra bắt buộc.
- `heroSnapshot.ts`: `resolveCandidate` nhận thêm tham số `remainingCalls`
  (ngân sách subrequest còn lại của **instance**, không phải của step) và trả
  thêm `externalCalls`; thêm outcome mới `budget_skipped` — **không** gộp vào
  `failed` (gộp vào sẽ tái tạo đúng sự cố 2026-09-11 mà phase này sửa: một lần
  chạy dở dang làm rớt cả snapshot). Chỉ cắt cụ thể bước `syncCanonical` khi
  ngân sách còn lại sau lookup KKPhim nhỏ hơn `HERO_SYNC_CALL_COST` (=
  `MAX_FETCHES_PER_SYNC`, chi phí tệ nhất của một lần `syncCanonical`) — ứng
  viên đã có sẵn trong D1 đúng catalog movie thì không tốn thêm subrequest nào
  nên không bị cắt. `refreshHeroSnapshot` đổi từ `mapLimit` song song
  (`HERO_LOOKUP_CONCURRENCY`, đã xoá) sang vòng lặp tuần tự, cộng dồn `used`
  qua từng ứng viên — kế toán ngân sách chỉ đúng nếu ứng viên sau thấy đúng số
  subrequest ứng viên trước đã tiêu.
- `heroSnapshotWorkflow.ts`: mỗi ứng viên một `step.do()` riêng, `callsUsed`
  được suy lại từ `externalCalls` mà chính step đó trả về (không dùng biến
  đóng bên ngoài) — cùng pattern `callsUsed`/`stubCountRef` đã dùng ở
  `recommendationResolveWorkflow.ts`, để chịu được replay sau khi bị ngắt.
- Test — `heroSnapshotRefresh.test.mjs`: sửa lại mọi literal
  `HeroRefreshResult` có sẵn (thêm `budgetSkipped: 0`) cho khớp field bắt buộc
  mới, và ba file test khác cũng dựng loại literal này
  (`heroSnapshotRepository.test.mjs`, `heroHomeData.test.mjs`,
  `homeRailOrdering.test.mjs`). Thêm 3 ca mới vào `heroSnapshotRefresh.test.mjs`:
  1. 20 ứng viên hoàn toàn mới (không có trong D1) → tổng subrequest cả lần
     chạy vẫn ≤ 50 (dùng đúng hết 50); mô phỏng tay xác nhận đúng 8 ứng viên
     được `syncCanonical` (mỗi ứng viên tốn 1 lookup + 5 sync = 6, tuần tự đến
     khi hết ngân sách), 12 ứng viên còn lại `budget_skipped`, `failed = 0`,
     và snapshot **vẫn được ghi** (8 dòng), không bị rớt toàn bộ.
  2. 20 ứng viên đã có sẵn trong D1 (steady state) — bảo vệ hồi quy: chứng
     minh Phase 1 không rút ngắn hero rail ở trường hợp thường gặp
     (`budgetSkipped = 0`, `matched = 20`, không `syncCanonical` lần nào).
  3. Riêng `budget_skipped` (không có `failed`) không làm rớt snapshot cũ —
     dùng 9 ứng viên mới để tạo đúng 1 `budget_skipped` ở cuối, xác nhận
     `getRefreshState().lastSuccessAt` cập nhật sang lần chạy mới (không giữ
     nguyên `lastSuccessAt` cũ) và `hero_snapshot` chứa đúng 8 dòng mới, không
     còn dòng "last good" đã seed trước đó.
- `npm run worker:typecheck` → 0 lỗi (khớp toàn bộ thay đổi kiểu liên quan:
  `HeroRefreshResult.budgetSkipped`, `CandidateOutcome` thêm biến thể,
  `resolveCandidate` đổi chữ ký, `MAX_FETCHES_PER_SYNC` export).
- `node scripts/rf-test.mjs all` → `OK: 18/18`.

Chưa chạy `git commit`/`push` cho các thay đổi Phase 1 này trong phiên này —
chờ xác nhận trước khi commit.
