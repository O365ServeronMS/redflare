# Plan: khôi phục Recommendation TMDB trên trang detail

**Ngày lập:** 2026-08-10  
**Tracking:** [state-recommendation-tmdb.md](state-recommendation-tmdb.md)  
**Phạm vi:** pipeline TMDB recommendation → D1 resolve → `/api/recommendation/*` → rail
“Bạn cũng có thể thích” trên trang `/phim/:slug`.

---

## 0. Kết luận và mục tiêu sản phẩm

Recommendation hiện không hỏng ở một điểm UI riêng lẻ. Rail chỉ render các edge TMDB đã có
`target_slug`; mọi edge chưa resolve bị JOIN loại bỏ, còn frontend biến cả API error lẫn danh sách
rỗng thành “không render gì”. Production ngày 2026-08-10 cho thấy:

- 189.139 edge TMDB; chỉ 52.538 edge đã resolve (**27,8%**);
- 136.601 edge overflow (**72,2%**), không còn edge pending;
- 12.627 phim có recommendation edge, trong đó 5.818 phim chỉ hiện 0–3 card;
- 137 phim có TMDB ID nhưng không có edge nào;
- 18.270 target TMDB unique; 14.772 target unique đang overflow;
- catalog backfill đã xong (`backfill:done=1`), D1 đang khoảng 169,4 MB;
- `MAX_STUBS=0`, dù code và ADR đã thiết kế cap 20.000;
- nếu mở stub cho target có `refCount >= 2`, mô phỏng read-only dự đoán 12.594/12.627 nguồn
  hiện có edge sẽ đạt ít nhất 8 candidate; 10.202 nguồn có đủ 15 candidate trước limit API.

### Outcome bắt buộc

1. Rail giữ đúng thứ tự TMDB và trả tối đa 12 card.
2. Phim có trên KKPhim ưu tiên dùng row catalog/playable hiện có.
3. Phim chưa có trên KKPhim nhưng được ít nhất 2 nguồn cùng recommend được materialize thành
   TMDB-only stub, có detail/trailer nhưng không có recommendation riêng.
4. Runtime `/api/*` và browser không gọi TMDB/KKPhim; upstream chỉ chạy trong cron/sync.
5. Lỗi tạm thời không được xóa last-good edge, không được biến thành not-found vĩnh viễn.
6. API/UI phải phân biệt loading, valid-empty và retryable error; lỗi request không còn bị nuốt.
7. Không redesign trang detail hoặc card; tái dùng `Carousel`/`PosterCard` và design tokens hiện có.

### KPI đóng feature

- `resolved_edges / total_edges >= 95%` sau khi repair hoàn tất.
- Ít nhất 95% nguồn có từ 8 TMDB candidate hợp lệ trở lên phải render được ≥8 card.
- Nguồn có TMDB ID và đã refresh thành công nhưng 0 edge phải <1%.
- `stub_count <= MAX_STUBS` tuyệt đối; không tạo recommendation cho stub.
- 0 edge `target_slug` dangling; 0 duplicate `(slug, target_type, target_tmdb_id)`.
- Một lỗi TMDB/KKPhim fixture không làm giảm số edge last-good của source.
- API recommendation không gọi upstream và trả đúng thứ tự `sort_order`.

---

## 1. Root cause đã xác nhận

### R1 — Stub tier bị tắt ở production

`wrangler.toml` đặt `MAX_STUBS="0"`. Resolver vì vậy chỉ giữ target đã có trong local catalog hoặc
exact-match được trên KKPhim; phần lớn TMDB recommendation không thuộc hai nhóm này và bị overflow.
Đây là nguyên nhân chính của số card quá ít.

### R2 — Retryable failure bị đồng nhất với “không có dữ liệu”

- `TmdbClient.getRecommendationIds()` trả `[]` cho token thiếu, timeout, HTTP error, JSON lỗi và
  valid-empty.
- `KkphimClient.getByTmdbRef()` trả `null` cho cả not-found và retryable error, dù Hero client đã
  có union type phân biệt hai trường hợp.
- `syncOneMovie()` có thể replace last-good targets bằng `[]` sau lỗi TMDB.
- Resolver có thể gọi `markAttempted()` sau outage KKPhim/TMDB và khóa edge khỏi các tick sau.

### R3 — Overflow không có lifecycle requeue

`resolve_attempted=1` loại edge khỏi query pending. Comment nói policy có thể thay đổi về sau,
nhưng code không có đường requeue khi catalog có phim mới, `MAX_STUBS` tăng hoặc lần trước chỉ là
lỗi tạm thời. Production đã có 28 edge overflow trỏ tới 6 target nay đã có trong catalog.

### R4 — Recommendation cũ không có lịch refresh độc lập

Recommendation chỉ refresh khi `syncOneMovie()` chạy và hash thay đổi. Phim cũ ngoài incremental
window có thể giữ recommendation cũ mãi; 137 phim có TMDB ID hiện không có edge. Không có
`last_recommendation_success_at` để xếp hàng repair theo tuổi dữ liệu.

### R5 — Cache và UI che mất trạng thái thật

- Khi target được resolve, cache tag của các source recommendation liên quan không được purge.
- `renderRecommendation()` catch mọi lỗi thành `[]`, rồi return im lặng.
- Placeholder lazy-mount không có loading/error state, nên người dùng thấy rail “biến mất”.

### R6 — Resolver có thể mark slug trước khi sync target thành công

Nhánh KKPhim gọi `syncOneMovie()` nhưng không kiểm tra `outcome`, sau đó vẫn `markResolved()`.
Production hiện chưa có dangling edge, nhưng flow này không có invariant bảo vệ.

---

## 2. Decision ledger

| ID | Quyết định | Trạng thái |
|---|---|---|
| D1 | TMDB `/recommendations`, tối đa 15 candidate/source, giữ nguyên rank | Giữ nguyên |
| D2 | API/UI render tối đa 12 card | Giữ nguyên |
| D3 | Bật bounded stub với `MAX_STUBS=20000`, chỉ target `refCount >= 2` | Plan mặc định |
| D4 | Stub có detail/trailer, không stream và không recommendation riêng | Giữ ADR-0002 |
| D5 | Không dùng local-similarity để “giả” TMDB trong rollout đầu | Plan mặc định |
| D6 | Retryable error giữ last-good; valid-empty mới được replace bằng empty | Bắt buộc |
| D7 | Requeue theo policy/batch, không reset toàn bảng mù quáng | Bắt buộc |
| D8 | Không gọi upstream trong browser/API request | Bắt buộc |
| D9 | Không deploy, apply migration hoặc mutate production trong lượt lập plan | Bắt buộc |

Nếu sau rollout bounded stub KPI ≥8 card vẫn không đạt, mới mở decision mới về fallback local
catalog. Không trộn fallback vào phase đầu vì sẽ làm rail không còn thuần TMDB và che lỗi dữ liệu.

---

## 3. Thứ tự phase

| Phase | Mục tiêu | Exit gate |
|---|---|---|
| **F0** | Baseline + contract + plan/state | Số production và decision ledger được ghi lại |
| **F1** | Sửa failure semantics, bảo vệ last-good | Fixture outage không xóa/khóa edge |
| **F2** | Requeue + kích hoạt bounded stub | Resolver idempotent; projected guardrails pass |
| **F3** | Refresh/repair source recommendation định kỳ | 137 source thiếu edge được repair; có freshness state |
| **F4** | Cache + API + UI resilience | Error không bị nuốt; rail giữ layout/order/accessibility |
| **F5** | Rollout, browser QA, đo KPI, close | Production đạt KPI và có rollback evidence |

Không bắt đầu F2 production rollout trước khi F1 đã deploy và verify; nếu không, một outage trong
lúc requeue có thể biến hàng trăm nghìn edge thành overflow lần nữa.

---

## F0 — Baseline, Product Design review và contract

### Việc làm

- Đọc flow `MovieDetail` → lazy mount → `Recommendation` → API → D1 JOIN.
- Đối chiếu ADR-0002, SSR plan/state, API contract và design system.
- Chạy D1 production query chỉ-đọc để đo baseline ở §0.
- Chốt product contract, KPI, phase order và rollback boundary.
- Tạo plan + state; chưa sửa runtime code.

### Evidence/exit

- Query remote đều `rows_written=0`.
- Working tree trước khi tạo docs sạch.
- Visual audit chưa được claim: Codex session hiện không có browser điều khiển/chụp screenshot.
  Browser QA bắt buộc thực hiện ở F5 khi capability sẵn sàng.

---

## F1 — Failure semantics và last-good safety

### Thay đổi dự kiến

1. Đổi TMDB recommendation client sang result phân loại rõ:
   - `{ kind: 'success', ids }` — bao gồm valid-empty;
   - `{ kind: 'retryable_error', status? }` — token/network/timeout/5xx/429/invalid payload.
2. Tổng quát hóa typed KKPhim TMDB lookup đang dùng cho Hero để resolver nhận:
   `found | not_found | retryable_error` cho cả movie và TV.
3. `syncOneMovie()` chỉ replace target khi TMDB recommendation trả `success`.
   - Khi retryable: giữ nguyên edge cũ và vẫn cho phép metadata/episode update an toàn.
   - Tách recommendation result khỏi việc dùng `[]` làm default trong hash gate; không để failure
     tạo hash giả khác last-good.
4. Resolver:
   - retryable KKPhim/TMDB → để pending, không `markAttempted()`;
   - KKPhim `found` → chỉ `markResolved()` khi `syncOneMovie().outcome` là `written|unchanged`
     **và** row target đọc lại tồn tại;
   - confirmed not-found + chưa đủ điều kiện stub → mới overflow.
5. Log summary theo count, không log token/payload: `success`, `validEmpty`, `retryable`,
   `preservedLastGood`, `confirmedNotFound`, `syncFailed`.

### Tests bắt buộc

- TMDB 200 + 15 IDs; 200 + empty; 429; 500; timeout; invalid JSON.
- Existing 12 edge + TMDB timeout → vẫn 12 edge, đúng order.
- Existing 12 edge + valid-empty → 0 edge sau atomic replace.
- KKPhim timeout không mark attempted; confirmed 404 mới đi nhánh stub/overflow.
- KKPhim found nhưng sync target error → không set dangling `target_slug`.
- Typecheck, full recommendation tests, Hero tests và build pass.

### Exit criteria

- Không code path nào biến retryable error thành empty/not-found.
- Last-good invariant được test ở repository/service level.
- Deploy A có thể chạy với `MAX_STUBS=0` mà không đổi lượng dữ liệu lớn.

---

## F2 — Overflow lifecycle và bounded stubs

### Thay đổi dự kiến

1. Thêm repository/service requeue theo target group, không update mù từng edge:
   - local catalog nay đã có target → requeue/resolve ngay, không network;
   - target `refCount >= 2` và còn stub budget → requeue;
   - target refCount 1 giữ overflow;
   - batch có cursor và wall-time budget, idempotent.
2. Dùng cap hiện có `MAX_STUBS=20000`, giữ `STUB_MIN_REFCOUNT=2`.
3. Requeue 10.743 target group eligible hiện tại theo batch. Ưu tiên refCount cao để tăng số card
   cho nhiều detail page sớm nhất.
4. Materialize stub từ TMDB detail; slug deterministic; upsert + FTS + edge resolve theo batch.
5. Ghi state/ops metrics: groups seen, requeued, existing, stubbed, retryable, overflow,
   current stub count, estimated DB growth và duration.
6. Purge cache recommendation của source bị thay đổi theo tag sau commit thành công.

### Guardrails

- Trước rollout: xác nhận account quota và D1 headroom tại thời điểm thật, không dựa vào số cũ.
- Stop tự động ở `stub_count == MAX_STUBS`.
- Stub không được vào incremental/backfill catalog và không sinh recommendation depth 2.
- Không delete overflow refCount 1; giữ để policy tương lai có thể requeue.

### Rollout/exit

- Dry-run query báo đúng 10.743 group eligible trên baseline hiện tại.
- Chạy local/fixture tới idempotent: tick sau không làm thêm write nếu state không đổi.
- Sau production soak: resolved edge ≥95%, stub ≤20.000, dangling=0.
- Rollback nhanh: đưa `MAX_STUBS` về 0 và dừng requeue; không xóa stub ngay trong incident.

---

## F3 — Freshness và repair source recommendation

### Vấn đề cần giải

Bounded stub sửa target coverage nhưng không sửa 137 source có TMDB ID mà không có edge, cũng
không refresh phim cũ khi TMDB đổi recommendation.

### Thay đổi dự kiến

1. Migration mới lưu freshness tối thiểu theo source, ưu tiên cột trên `movie` hoặc bảng state
   chuyên biệt:
   - `last_recommendation_success_at`;
   - `last_recommendation_attempt_at`;
   - `last_recommendation_result`/error class ngắn;
   - không lưu payload/log dài.
2. Tách `refreshRecommendationSource(slug)` khỏi full movie sync:
   - chỉ gọi TMDB recommendations;
   - success mới atomic replace;
   - retryable giữ last-good;
   - giữ rank, dedupe ID, validate positive integer/type.
3. Cron queue bounded:
   - ưu tiên source có TMDB ID nhưng chưa từng success;
   - sau đó oldest-success-first;
   - TTL mặc định 14 ngày; batch ban đầu nhỏ và điều chỉnh bằng metrics.
4. Khi replace source edge, tái dùng `target_slug` đã resolve cho target không đổi và pre-resolve
   local catalog target trong batch để rail không tụt về 0 giữa refresh và resolver tick.
5. Repair có checkpoint/cursor cho 137 source thiếu edge hiện tại.

### Exit criteria

- Source refresh failure không giảm card count.
- 137 source thiếu edge được phân loại: repaired, valid-empty hoặc retryable còn lịch retry.
- Không còn source “không rõ vì sao rỗng”.
- Mỗi source có freshness observable; cron không vượt upstream/write budget.

---

## F4 — Cache, API contract và UI resilience

### Backend/API

- Khi source targets đổi hoặc target group resolve, purge đúng
  `recommendation:{mediaType}:{tmdbId}` của source liên quan sau write thành công.
- `getResolvedForSlug` giữ TMDB `sort_order`, dedupe slug, không trả chính source.
- Giữ response `{ items: [...] }` và limit 12 để không phá SPA contract.
- Bổ sung observability response count ở server log/status, không thêm upstream call.

### Frontend/Product Design

- Giữ vị trí cuối detail, dùng lại `Carousel`/`PosterCard`, spacing và dark tokens hiện có.
- Khi placeholder gần viewport: render skeleton rail có chiều cao ổn định.
- API success + items: render rail như hiện tại.
- API success + valid-empty: ẩn rail có chủ đích; ghi analytics/diagnostic event nếu có.
- API/network error: hiện trạng thái gọn “Không tải được gợi ý” + một nút retry; không giả thành
  empty và không làm hỏng phần detail/player.
- Heading/controls có accessible name; keyboard và reduced-motion của carousel không hồi quy.

### Tests/exit

- API contract tests: invalid ID, source missing, 0/1/12/>12 resolved items, order/dedupe.
- UI tests hoặc browser checks: loading, success, empty, error, retry, route navigation.
- Không có layout shift lớn khi rail mount; Console sạch; browser không gọi upstream.

---

## F5 — Production rollout, browser QA và close

### Staged rollout

1. **Deploy A:** F1 safety + observability, `MAX_STUBS=0`; soak ít nhất một cron cycle.
2. Apply freshness migration và deploy F3 scheduler ở batch thấp.
3. **Deploy B:** đặt `MAX_STUBS=20000`, bật controlled requeue; không mass-update thủ công ngoài
   service đã test.
4. Theo dõi mỗi cron: resolved/pending/overflow/stub, retryable rate, rows written, DB size,
   duration và cache behavior.
5. Chỉ tăng batch khi error/quota/storage guardrails đều xanh.

### Browser QA bắt buộc

- Desktop 1440×900 và mobile 390×844.
- Ít nhất 6 detail samples: movie/TV, 0–3 cũ, 12 mới, multi-season, stub, TMDB-empty.
- Chụp accepted screenshot ở trạng thái loading, populated và retryable error.
- Kiểm tra card order với API, arrows/swipe/keyboard, focus, retry, deep-link và Console/Network.
- Không claim full accessibility compliance từ screenshot; test keyboard/focus riêng.

### Production acceptance queries

- resolved/pending/overflow và tỷ lệ resolved;
- distribution card count/source (0…12);
- source có TMDB nhưng chưa success/không edge;
- stub count và D1 size;
- dangling/duplicate/self edge;
- cache/API sample cho ít nhất 20 source stratified.

### Close/rollback

- Nếu retryable spike hoặc write/storage guardrail đỏ: dừng scheduler/requeue, giữ last-good.
- Nếu UI lỗi: rollback frontend/API deploy; D1 stub/edge vẫn tương thích và không cần xóa gấp.
- Cập nhật state, HANDOFF, README/ops nếu runtime contract thay đổi; chỉ đánh Complete khi browser
  evidence và production KPI cùng đạt.

---

## 4. File dự kiến chạm khi implement

- `src-ssr/services/sync/{tmdbClient,kkphimClient,syncMovie,orchestrator}.ts`
- `src-ssr/repositories/{recommendationRepository,movieRepository}.ts`
- `src-ssr/routes/sync.ts`, `src-ssr/api/routes.ts`, `src-ssr/cache/control.ts`
- migration `0011_*` cho freshness state (tên cuối chốt ở F3)
- `src/api/ophim.js`, `src/modules/Recommendation/Recommendation.js`
- tests recommendation mới + `package.json`
- `docs/contract-legacy-api.md`, `docs/HANDOFF.md`, state file này khi rollout

Không sửa CSS/design system trước F4 visual evidence; nếu skeleton/error state cần CSS, thay đổi phải
surgical và dùng token/class pattern hiện có.

---

## 5. Stop rules

1. Production state khác baseline lớn trước một write → dừng và đo lại, không dùng số trong plan mù quáng.
2. Retryable error bị map thành empty/not-found ở bất kỳ layer nào → không rollout F2.
3. Stub count/storage vượt guardrail → dừng requeue; không tự tăng cap.
4. Cần đổi D3/D4/D5 → cập nhật Decision ledger và state trước khi code tiếp.
5. Phase thiếu test/evidence tương ứng → không đánh Complete.
6. Deploy/migration/production mutation luôn cần authorization riêng; plan này không phải quyền publish.

