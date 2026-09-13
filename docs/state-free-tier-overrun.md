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

Phase 1 và Phase 2 đã gộp vào một commit (`17bc785`, "feat(sync): D1
write-budget governor and hero-snapshot subrequest cap") — plan §5 bước 2 đề
nghị tách riêng từng phase, nhưng đã gộp theo yêu cầu trực tiếp của chủ dự án.
Chưa `push` — chờ xác nhận riêng cho bước deploy (Phase 5).

## Phase 3 — Tài liệu (sửa V3)

Thực hiện đúng mục tiêu V3 ("tài liệu ghi sai trần D1 và thiếu một giới
hạn"), nhưng vị trí thực tế của các dòng sai khác với plan liệt kê ở một chỗ:
plan nói "`README.md` mục 🤖 Luật dành cho AI agent / bảng ngân sách Free",
nhưng README hiện không có bảng ngân sách Free nào ở mục đó (chỉ có luật code/
design). Dòng ngân sách D1 thật sự nằm ở `CLAUDE.md` ("Free-plan D1 budget"),
nên đã sửa ở đó thay vì README.

- `CLAUDE.md`: dòng "Free-plan D1 budget" trước đây chỉ có "5M rows read/day"
  + "100 bound parameters" — thêm **500 MB storage/database** (5 GB là tổng
  account, tối đa 10 database — không phải trần từng database), **50 D1
  query/invocation** (Paid: 1.000), và mốc đo thật 2026-09-12 (database_size
  180 MiB = 37,8% trần; rows_read_24h 32,9%; rows_written_24h 86,7% — xem
  Phase 0 ở trên).
- `wrangler.toml`: comment ở `[vars] BACKFILL_MODE` đang trỏ
  `MAX_ROWS_PER_DAY = 85_000 in orchestrator.ts` (đã dời sang
  `writeBudget.ts` ở Phase 2) — sửa lại đường dẫn, và ghi rõ governor giờ bao
  cả hero/recommendation-resolve/recommendation-refresh/catalog-stats, không
  chỉ backfill.
- `docs/audit-prompt-free-tier.md`: sửa 3 chỗ ở bảng khởi điểm Phần 0 và mục
  1.5 — Cron Triggers "5 cron/script" → "5 cron/**account**"; D1 storage
  "5 GB" → "**500 MB storage/database** (5 GB là tổng account, tối đa 10
  database)"; thêm **50 query/invocation** (Paid 1.000) vào hàng D1; sửa nốt
  câu "so với 5 GB" ở mục 1.5 thành "so với trần 500 MB/database".
- `docs/state-free-tier-overrun.md`: mục này.

**Verify:** `node scripts/rf-test.mjs all` → `OK: 18/18` (chỉ đổi
tài liệu/comment, không đổi code nghiệp vụ nào — `build` + `git diff --check`
sạch).

Chưa chạy `git commit`/`push` cho các thay đổi Phase 3 này trong phiên này —
chờ xác nhận trước khi commit.

## Phase 4 — V4: đo request rồi trình chủ dự án quyết (KHÔNG code)

**Bước 1 (lấy số request thật 7 ngày) vẫn KHÔNG làm được trong phiên này** —
đúng như plan đã lường trước ("Phiên audit 2026-09-12 không có quyền này").
Đã kiểm tra hai đường:

- `npx wrangler whoami`: token OAuth hiện tại **không có scope Analytics**
  (danh sách scope: account/user read, workers/workers_kv/workers_routes/
  workers_scripts write, d1 write, zone read, … — không có
  `Account Analytics: Read` hay tương đương).
- MCP server `Cloudflare_Developer_Platform` (có tool
  `workers_get_worker`/`d1_database_query`/…) yêu cầu authorize riêng qua
  `claude mcp`/`/mcp` — phiên này không tương tác được để chạy OAuth flow.

Không có cách nào khác để lấy request/ngày, tỉ lệ asset so với `/api/*`, hay
cache hit rate từ phiên agent hiện tại mà không đoán số — nên **không tự bịa
số**. Cần một trong hai:

1. Chủ dự án authorize MCP `Cloudflare_Developer_Platform` (hoặc cấp token
   mới có scope Analytics) để agent tự truy vấn GraphQL Analytics API; hoặc
2. Chủ dự án tự lấy số từ dashboard Cloudflare (Workers & Pages → tên worker
   → Metrics, khung 7 ngày) và dán lại: tổng request/ngày, request tới
   asset tĩnh so với `/api/*`, cache hit rate.

**Bước 2–4 (đối chiếu, trình 3 lựa chọn, ghi quyết định) đang chờ số thật ở
bước 1** — chưa thể làm vì không có dữ liệu để đối chiếu với trần
100.000 request/ngày. Khung 3 lựa chọn theo plan (chưa có số, chỉ nêu lại để
tiện chọn khi có số):

- **Giữ nguyên** `[cache] enabled = true` — nếu request/ngày còn xa trần.
- **Giảm số asset mỗi pageview** — gộp font subset, lazy-load
  `hls.js`/`artplayer` (theo plan ước tính `hls.light` ~332 KB +
  `artplayer` ~140 KB đang nằm trong bundle chung) chỉ ở route xem phim.
  Cần verify lại số KB thật từ `dist/` sau build trước khi trình, vì phiên
  này chưa đo bundle size thật.
- **Tắt `[cache] enabled`**, quay lại asset miễn phí — chấp nhận mọi `/api/*`
  đều chạm Worker + D1 (tăng CPU/subrequest, đổi lại asset không tính quota
  Worker).

Không tự chọn phương án nào — theo đúng luật của plan, đây là quyết định của
chủ dự án, không phải của agent.

**Cập nhật 2026-09-13 — chủ dự án tự xác nhận số thật (không cần agent
truy vấn GraphQL):** mọi chỉ số khác (Worker requests, CPU, subrequests,
cache hit rate) **đều dưới trần**, không có tín hiệu nào cho thấy request
layer đáng lo. Bằng chứng độc lập: email cảnh báo thật từ Cloudflare —

> Your account has used 90% of the daily D1 free tier limit of 100000
> rows_written. D1 requests will return errors if the limit is exceeded
> before 2026-09-13 at 00:00:00 UTC.

→ Xác nhận đúng chẩn đoán gốc của cả plan này: **điểm vượt/sát trần duy nhất
là D1 rows_written**, không phải request/asset/cache. Vì vậy:

- **Quyết định Phase 4**: giữ nguyên `[cache] enabled = true` (phương án 1) —
  không cần giảm asset mỗi pageview, không cần tắt cache. Chữ ký duyệt: chủ
  dự án, qua xác nhận trực tiếp trong hội thoại ngày 2026-09-13 (số liệu
  request/CPU/cache đều dưới ngưỡng).
- **Việc thật sự cần làm ngay là deploy Phase 1+2** (governor `writeBudget.ts`
  + trần subrequest hero-snapshot) — đây chính là bản vá cho đúng sự cố email
  này báo, nhưng tính đến giờ **vẫn đang nằm ở commit `17bc785` cục bộ, chưa
  `push`**, nên production hiện tại **chưa có bản vá này** và vẫn đang phơi
  ra rủi ro y hệt email cảnh báo (ghi hết 100k rows/ngày → D1 từ chối
  **mọi** query, kể cả đọc, cho tới 00:00 UTC hôm sau).
- Chưa rõ lúc viết dòng này (2026-09-13, sau mốc 00:00 UTC trong email) bộ
  đếm rows_written đã reset theo ngày mới hay chưa, và liệu có request nào
  đã thật sự bị D1 từ chối trong cửa sổ đó — không có quyền Analytics/CRON_KEY
  trong phiên này để tra hồi cứu; nếu cần xác nhận có lỗi thật xảy ra hay
  không, phải xem trực tiếp Cloudflare dashboard (Workers → Logs) hoặc
  D1 → Metrics.

Phase 4 xem như **xong** theo nghĩa "đo rồi trình chủ dự án quyết" — quyết
định giữ nguyên cache, không mở plan riêng cho asset/cache.
