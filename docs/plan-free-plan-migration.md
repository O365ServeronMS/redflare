# Plan: tách nhỏ cron jobs bằng Cloudflare Workflows để hạ an toàn xuống Free plan

**Status:** Proposed
**Date:** 2026-08-13
**Deciders:** repo owner (sole maintainer)
**Tracking:** [audit-prompt-free-plan-cpu.md](audit-prompt-free-plan-cpu.md) (chạy trước, blocking gate) → `docs/state-free-plan-migration.md` (tạo khi bắt đầu Phase 1)
**Supersedes:** cách vận hành `BACKFILL_MODE = "burst"` hiện tại của `wrangler.toml`

---

## Vấn đề

`wrangler.toml` hiện có `[vars] BACKFILL_MODE = "burst"` — tài khoản đang chạy ở chế
độ Paid để backfill toàn bộ catalog từ KKphim. Backfill đã hoàn tất. Từ giờ trở đi,
việc cần làm chỉ còn là đồng bộ tăng trưởng (incremental) — nhưng cơ chế cron hiện tại
**không phân biệt** giữa "đang backfill" và "đã xong, chỉ theo dõi cái mới": một Cron
Trigger duy nhất (`*/15 * * * *`) gọi `scheduled()` trong `src-ssr/index.ts`, và trong
**một invocation** chạy tuần tự cả 5 job — `runIncrementalSync`,
`refreshHeroSnapshot`, `runRecommendationResolveTick`, `runRecommendationRefreshTick`,
`runBackfillTick`.

Thiết kế đó được xây cho Paid plan (10.000 subrequests, 30s CPU/invocation). Free plan
xuống còn **10ms CPU** và **50 external subrequests** cho **toàn bộ invocation**, cộng
dồn qua cả 5 job — không reset giữa chừng. Điều này cần verify trước bằng
[audit-prompt-free-plan-cpu.md](audit-prompt-free-plan-cpu.md); plan này giả định audit
xác nhận có ít nhất một job vượt ngưỡng khi chạy dồn (nếu audit cho kết quả "pass sạch",
phần lớn phase dưới vẫn đáng làm vì nó cũng giải quyết yêu cầu lịch chạy độc lập —
xem "Vì sao vẫn cần tách theo job" bên dưới).

## Thu hẹp phạm vi: incremental sync giờ chỉ cần 2 trang đầu

Vì backfill đã xong, tiêu chí đơn giản hoá của chủ dự án:

> *"chỉ cần mỗi 30' quét page 1 của api và crawl phim mới"*

`runIncrementalSync` hiện quét tới `RECENT_PAGE_LIMIT = 20` trang `/danh-sach/
phim-moi-cap-nhat` mỗi 15 phút để tìm cursor cũ (thiết kế cho backfill vừa bắt kịp vừa
chạy nền). Không cần nữa — 2 trang đầu (~40-48 item mới nhất) mỗi 30 phút là đủ bắt
được phim mới trong điều kiện vận hành bình thường, với một khoảng đệm an toàn nếu một
tick nào đó có nhiều hơn một trang item mới (thực hiện: `RECENT_PAGE_LIMIT: 20 → 2`,
đã áp dụng trong `orchestrator.ts`).

**An toàn khi giảm xuống 2 trang:** logic cursor hiện tại (`orchestrator.ts`
`runIncrementalSync`) chỉ advance cursor khi `scanComplete` (cursor bị "cross" trong
phạm vi đã quét, hoặc gặp trang rỗng). Nếu trong 30 phút có nhiều hơn ~40-48 item mới
(bất thường, nhưng có thể xảy ra), vòng quét dừng ở `stopReason: 'page_limit'` **mà
không advance cursor** — tick sau (30 phút sau) sẽ quét lại đúng những item đó. Không
mất dữ liệu, chỉ chậm bắt kịp thêm một chu kỳ; và việc sync lại một slug đã sync rồi là
no-op rẻ (so sánh hash trong `syncOneMovie`, xem `hash.ts`).

## Vì sao vẫn cần tách theo job (không chỉ đơn giản hoá incremental sync)

Yêu cầu của chủ dự án: *"các công việc khác như: refresh home; refresh data; etc vẫn
giữ nguyên"* — tức giữ nguyên **tần suất và logic** của hero snapshot / recommendation
resolve / recommendation refresh, chỉ đổi incremental sync sang 30 phút.

Nhưng cả 5 job hiện dùng **chung một Cron Trigger**. Đổi tần suất incremental sync
sang `*/30` mà không tách job sẽ kéo theo tần suất của cả 4 job kia — vi phạm đúng yêu
cầu "giữ nguyên". Đây là lý do bắt buộc phải tách lịch chạy theo từng job, không chỉ là
một lựa chọn tối ưu CPU.

## Giải pháp: Cloudflare Workflows — mỗi job một Workflow, mỗi Workflow tự lịch riêng

Đây chính là *"worker flows quản lý nối đuôi các công việc nhỏ"* mà yêu cầu nhắc tới —
[Cloudflare Workflows](https://developers.cloudflare.com/workflows/) là sản phẩm được
thiết kế đúng cho việc này, và đã **có sẵn trên Free plan**:

| Đặc tính Workflows | Vì sao khớp với yêu cầu |
|---|---|
| Mỗi `step.do(...)` có **ngân sách CPU riêng** (10ms Free, xác nhận qua Cloudflare docs: *"Individual steps are subject to the configured CPU time limit"*) | Chia nhỏ 1 job "nặng" thành nhiều step nhỏ, mỗi step tự fit trong 10ms — không còn CPU cộng dồn qua cả 5 job như hiện tại |
| State giữa các step được **persist tự động**, step nào xong không chạy lại khi retry | Đây chính là "tránh ngắt quãng giữa chừng" — nếu step thứ N lỗi/hết ngân sách, Workflow resume đúng tại step N khi retry, không cần tự viết lại cursor/checkpoint logic thủ công như `orchestrator.ts` đang làm |
| Mỗi `[[workflows]]` binding có `schedules` (cron) **riêng**, tách khỏi `[triggers] crons` cổ điển (giới hạn 5/account) — ngân sách riêng tới 100 cron expression/account | Cho phép incremental sync chạy `*/30`, còn hero/resolve/refresh giữ `*/15` — đúng yêu cầu "giữ nguyên" cho 3 job kia |
| Free plan: 100 Workflow instance đồng thời, 3.000 step/ngày, 1.024 step/instance, retention state 3 ngày | Đủ cho quy mô 4 job × vài chục lần chạy/ngày (xem tính toán step-budget bên dưới) |

### Kiến trúc đề xuất

Thay `src-ssr/index.ts` `scheduled()` (1 Cron Trigger, 5 job tuần tự) bằng 4 class
`WorkflowEntrypoint` độc lập, mỗi class 1 file trong `src-ssr/workflows/`:

```toml
# wrangler.toml — thêm, KHÔNG xoá [triggers] cho tới khi migrate xong toàn bộ (Phase 4)
[[workflows]]
name = "incremental-sync"
binding = "INCREMENTAL_SYNC_WORKFLOW"
class_name = "IncrementalSyncWorkflow"
schedules = ["*/30 * * * *"]   # ĐỔI — theo yêu cầu

[[workflows]]
name = "hero-snapshot"
binding = "HERO_SNAPSHOT_WORKFLOW"
class_name = "HeroSnapshotWorkflow"
schedules = ["*/15 * * * *"]   # GIỮ NGUYÊN tần suất hiện tại

[[workflows]]
name = "recommendation-resolve"
binding = "RECOMMENDATION_RESOLVE_WORKFLOW"
class_name = "RecommendationResolveWorkflow"
schedules = ["*/15 * * * *"]   # GIỮ NGUYÊN

[[workflows]]
name = "recommendation-refresh"
binding = "RECOMMENDATION_REFRESH_WORKFLOW"
class_name = "RecommendationRefreshWorkflow"
schedules = ["*/15 * * * *"]   # GIỮ NGUYÊN
```

`runBackfillTick` **không** lên lịch lại — xem "Backfill" bên dưới.

### Chia step bên trong từng Workflow

Nguyên tắc chung: **một step = một đơn vị công việc gọi tối đa vài external call**,
đủ nhỏ để chắc chắn nằm dưới 10ms CPU dù ở Free plan. Không cố nhồi cả một vòng lặp N
item vào một step — mỗi item (hoặc nhóm nhỏ 2-3 item) là một step riêng.

**`IncrementalSyncWorkflow`** (thay `runIncrementalSync`):
1. `step "scan-page-1"` — gọi `kkphim.getRecentPage(1)`, so với cursor lưu trong D1,
   trả về danh sách slug mới/đổi (kết quả step tự persist — thay cho biến `slugs[]`
   sống trong bộ nhớ của một invocation như code hiện tại).
2. `step "sync-<slug>"` — một step mỗi slug (hoặc batch 2-3 slug/step nếu số lượng
   lớn bất thường), gọi `syncOneMovie` y hệt logic hiện tại trong
   `src-ssr/services/sync/syncMovie.ts` — không đổi logic sync, chỉ đổi đơn vị đóng
   gói từ "cả batch trong 1 invocation SELF" sang "1 step".
3. `step "advance-cursor"` — chỉ chạy sau khi mọi step sync ở trên hoàn tất (Workflows
   đảm bảo thứ tự) — ghi cursor mới. Giữ nguyên bất biến hiện có: cursor chỉ tiến khi
   toàn bộ batch xử lý xong sạch.

**`HeroSnapshotWorkflow`** (thay `refreshHeroSnapshot`):
1. `step "check-gate"` — đọc `HeroSnapshotRepository.getRefreshState()`, nếu chưa đủ
   30 phút thì kết thúc sớm (giữ nguyên cổng hiện có — xem lưu ý ngân sách step bên
   dưới, đây là lý do KHÔNG bỏ cổng dù lịch đã là `*/15`).
2. `step "fetch-trending"` — 1 TMDB trending call.
3. `step "resolve-<candidate>"` — một step mỗi candidate (tối đa ~20), gọi
   `kkphim.getMovieByTmdbId` + `syncOneMovie` nếu match — y hệt `resolveCandidate`
   hiện tại, chỉ tách thành step riêng thay vì `mapLimit` trong một invocation.
4. `step "write-snapshot"` — ghi kết quả tổng hợp.

**`RecommendationResolveWorkflow`** (thay `runRecommendationResolveTick`):
- `step "requeue-overflow"` — 1 step, y hệt `requeueOverflowGroups`.
- `step "resolve-batch-<n>"` — chia `RESOLVE_BATCH_SIZE` group hiện tại (300) thành
  nhiều step nhỏ hơn (ví dụ 10-15 group/step) thay vì 1 vòng lặp lớn budget theo
  wall-time (`RESOLVE_TICK_BUDGET_MS`) — mỗi step tự có ngân sách CPU riêng nên không
  cần budget theo thời gian nữa, Workflows tự dừng-và-resume nếu instance chạm giới
  hạn step/ngày.

**`RecommendationRefreshWorkflow`** (thay `runRecommendationRefreshTick`):
- `step "refresh-<source>"` — một step mỗi source (tối đa
  `RECOMMENDATION_REFRESH_LIMIT` = 20 hiện tại), gọi TMDB + ghi D1 + `cache.purge()`
  y hệt logic hiện có.

### Backfill: không lên lịch lại

`runBackfillTick` đã tự gate bằng D1 key `backfill:done` (early-return gần như miễn
phí nếu đã `'1'`) — về mặt kỹ thuật không bắt buộc phải đụng vào. Nhưng vì công việc
này **không còn nhu cầu chạy định kỳ** (theo xác nhận của chủ dự án), khuyến nghị:

- Không thêm `runBackfillTick` vào bất kỳ `schedules` nào của 4 Workflow trên.
- Giữ route thủ công `GET /__sync/backfill-page` (`src-ssr/routes/sync.ts`) như một
  admin endpoint — dùng lại nếu sau này có nhu cầu (thêm type danh mục mới, tái crawl
  một phần catalog), nhưng gọi tay, không cron.
- Trước khi xoá hẳn `runBackfillTick` khỏi vòng lặp chạy tự động: xác nhận qua
  `GET /__sync/status` field `backfill.done === true` (bước này nằm trong audit prompt
  Phần 1, mục cuối).

## Ngân sách step/ngày (Free plan: 3.000 step/ngày, 1.024 step/instance)

| Workflow | Lịch | Lần chạy/ngày | Step/lần (ước tính) | Step/ngày (ước tính) |
|---|---|---|---|---|
| IncrementalSync | `*/30` | 48 | 2 (gate+cursor) + S (S = số slug mới, steady-state thường < 10) | ~500-1.000 |
| HeroSnapshot | `*/15` nhưng cổng 30' → chạy thật ~48 lần | 96 dispatch, ~48 thực thi đầy đủ | ~3 (nếu skip) hoặc ~23 (nếu chạy thật) | ~1.100-1.200 |
| RecommendationResolve | `*/15` | 96 | biến động theo số group unresolved — cần đo thực tế qua audit | cần đo |
| RecommendationRefresh | `*/15` | 96 | 1 + R (R ≤ 20) | tới ~2.000 nếu luôn đầy 20 |

**Đây là con số ước tính, không phải cam kết** — tổng cộng có thể áp sát hoặc vượt
3.000/ngày nếu Resolve + Refresh đều chạy full batch mỗi lần. Trước khi merge Phase 3,
đo thực tế bằng cách chạy các route thủ công tương ứng và đếm step qua Cloudflare
dashboard (Workflows → instance → step count), hoặc `wrangler workflows instances
describe`. Nếu vượt ngân sách: giảm `RECOMMENDATION_REFRESH_LIMIT`, hoặc giãn lịch
Refresh/Resolve xuống `*/20`/`*/30` (chấp nhận lệch nhẹ so với "giữ nguyên" nếu ngân
sách step bắt buộc — cần xác nhận lại với chủ dự án nếu tới bước này, đừng tự quyết).

## Các phase

1. **Audit** (blocking) — chạy [audit-prompt-free-plan-cpu.md](audit-prompt-free-plan-cpu.md)
   nguyên văn, xác nhận bằng bằng chứng thật job nào vượt ngưỡng Free plan hiện tại,
   và xác nhận `backfill.done === true`.
2. **Đơn giản hoá incremental sync** — `RECENT_PAGE_LIMIT: 20 → 2` trong
   `orchestrator.ts` (đã áp dụng). Đây là thay đổi nhỏ, độc lập, có thể deploy và quan
   sát riêng trước khi động tới Workflows.
3. **Viết 4 Workflow class** trong `src-ssr/workflows/*.ts`, tái dùng logic hiện có
   trong `orchestrator.ts` / `heroSnapshot.ts` / `recommendationRefresh.ts` /
   `syncMovie.ts` — đóng gói lại thành step, **không viết lại nghiệp vụ**. Giữ các
   route thủ công hiện có trong `src-ssr/routes/sync.ts` song song để không phá công
   cụ vận hành/test đang dùng.
4. **Deploy song song** — thêm `[[workflows]]` bindings, giữ `[triggers] crons` cũ
   chạy song song một thời gian ngắn (vài ngày) để so sánh kết quả 2 đường chạy ra
   giống nhau (đối chiếu `/__sync/status`, số liệu D1) trước khi tắt `scheduled()` cũ.
5. **Tắt cron cũ** — xoá `scheduled()` khỏi `src-ssr/index.ts`, xoá
   `[triggers] crons` khỏi `wrangler.toml` (hoặc giữ trống nếu Workers Free vẫn yêu
   cầu khai báo — kiểm tra khi tới bước này).
6. **`BACKFILL_MODE: "burst" → "free"`** — bật lại D1 row-write governor
   (`MAX_ROWS_PER_DAY = 85_000` đã có sẵn trong code). Steady-state ghi D1 sau backfill
   theo ADR-0002 chỉ còn vài trăm-vài nghìn dòng/ngày, nên gần như chắc chắn dưới
   ngưỡng — nhưng verify qua `/__sync/status` `rowsWrittenToday` vài ngày trước khi
   khẳng định.
7. **Soak test mô phỏng Free plan** — lặp lại Phần 2 của audit prompt (local
   `[limits] cpu_ms=10, subrequests=50` qua `wrangler dev --remote`) trên kiến trúc
   Workflows mới, xác nhận mỗi step riêng lẻ pass. Không cần test "5 job dồn 1
   invocation" nữa vì kiến trúc mới không còn tồn tại tình huống đó.
8. **Hạ plan thật** — sau khi Phase 7 sạch và ổn định vài ngày trên production (vẫn ở
   Paid, chỉ để `[limits]` tự nhiên theo Paid default), gỡ mọi `[limits]` override,
   rồi hạ subscription Cloudflare xuống Free. Đây là bước duy nhất có tác động tài
   khoản thật — cần xác nhận trực tiếp với chủ dự án trước khi thực hiện, không tự
   động hoá.

## Ngoài phạm vi plan này (ghi nhận, không xử lý ở đây)

- `CLAUDE.md` mô tả kiến trúc `worker/lib/*` đã không còn tồn tại — toàn bộ phần
  "Architecture", "Data flow & caching", "Endpoints" trong đó đang mô tả sai hệ thống
  thật (`src-ssr/`). Nên chạy một pass cập nhật `CLAUDE.md` riêng, không gộp vào plan
  CPU-budget này để tránh trộn hai việc không liên quan.
- Step-budget của Resolve/Refresh (bảng ở trên) cần số đo thực tế trước khi chốt —
  không đoán tiếp trong plan này.
