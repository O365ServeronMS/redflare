# State: Recommendation TMDB trên trang detail

**Plan:** [plan-recommendation-tmdb.md](plan-recommendation-tmdb.md)  
**Ngày tạo:** 2026-08-10  
**Overall:** F1 complete locally — production rollout pending authorization  
**Current phase:** F2 — Not started  
**Publish authorized:** No  

> Đây là nguồn tracking duy nhất cho feature này. Agent tiếp theo đọc snapshot, decision ledger và
> checklist của phase hiện tại; không suy trạng thái từ chat.

---

## 1. Snapshot hiện tại

| Mục | Giá trị / trạng thái |
|---|---|
| Git baseline | `main` tại `903f563` khi bắt đầu audit |
| Runtime | Cloudflare Worker + D1 + Vite SPA |
| UI | `MovieDetail` lazy-mount `Recommendation`; error/empty đều bị ẩn |
| API limit | 12 card |
| TMDB candidates/source | 15 |
| Stub policy production | `MAX_STUBS=0` |
| Backfill | Complete: `backfill:done=1`, type index 4 |
| Browser evidence | Chưa có; session F0 không có browser capture capability |
| Production writes F0 | Không; mọi D1 query `rows_written=0` |

### Production baseline — 2026-08-10

| Metric | Giá trị |
|---|---:|
| Catalog movies | 29.466 |
| Catalog có TMDB ID | 12.764 |
| Catalog thiếu TMDB ID | 16.702 |
| Source có recommendation edge | 12.627 |
| Source có TMDB ID nhưng không edge | 137 |
| Total recommendation edges | 189.139 |
| Resolved edges | 52.538 (27,8%) |
| Pending edges | 0 |
| Overflow edges | 136.601 (72,2%) |
| Unique targets | 18.270 |
| Unique overflow targets | 14.772 |
| Overflow target refCount=1 | 4.029 |
| Overflow target eligible refCount≥2 | 10.743 |
| Overflow edge eligible refCount≥2 | 132.572 |
| Source hiện chỉ có 0–3 resolved card | 5.818 / 12.627 |
| Stale overflow nay đã có trong catalog | 28 edge / 6 target |
| Dangling resolved edge | 0 |
| D1 size sau query | 169.443.328 bytes |

**Projection read-only:** nếu materialize target `refCount >= 2`, 12.594/12.627 source hiện có
edge sẽ đạt ít nhất 8 candidate; 10.202 source có 15 candidate trước API limit 12.

---

## 2. Root-cause board

| ID | Finding | Status | Evidence |
|---|---|---|---|
| R1 | `MAX_STUBS=0` làm phần lớn TMDB target không render | Confirmed | config + 72,2% overflow |
| R2 | TMDB failure bị map thành `[]` | Confirmed | `tmdbClient.ts` + `syncMovie.ts` |
| R3 | KKPhim failure bị map thành `null` và có thể mark attempted | Confirmed | `kkphimClient.ts` + resolver |
| R4 | `resolve_attempted=1` không có requeue lifecycle | Confirmed | repository + 28 stale edge |
| R5 | Source recommendation không có freshness scheduler | Confirmed | 137 TMDB source không edge |
| R6 | Resolve nhánh KKPhim không check sync outcome | Confirmed | `orchestrator.ts` |
| R7 | Cache source recommendation không purge khi target resolve | Confirmed | cache tags + resolver |
| R8 | Frontend catch error thành empty và ẩn rail | Confirmed | `Recommendation.js` |

---

## 3. Decision ledger

| ID | Quyết định | Trạng thái |
|---|---|---|
| D1 | Giữ TMDB rank; 15 candidate, render tối đa 12 | Accepted by current contract |
| D2 | Bật bounded stub cap 20.000, min refCount 2 | Proposed default in plan |
| D3 | Stub detail/trailer, không depth-2 recommendation | Accepted by ADR-0002 |
| D4 | Retryable failure giữ last-good | Required |
| D5 | Không local-similarity fallback ở rollout đầu | Proposed default in plan |
| D6 | Không runtime upstream trong browser/API | Required |
| D7 | Không redesign; chỉ thêm loading/error/retry state tối thiểu | Required |
| D8 | Không production mutation trong F0 | Enforced |

---

## 4. Progress board

Allowed status: `Not started`, `In progress`, `Needs review`, `Blocked`, `Complete`.

| Phase | Mục tiêu | Status | Checkpoint |
|---|---|---|---|
| F0 | Baseline + contract + plan/state | **Complete** | D1 read-only evidence + docs |
| F1 | Failure semantics + last-good | **Not started** | Tests outage/empty/sync guard |
| F2 | Requeue + bounded stubs | **Not started** | ≥95% resolved, stub ≤ cap |
| F3 | Source freshness + repair | **Not started** | 137 source được phân loại/repair |
| F4 | Cache/API/UI resilience | **Not started** | loading/empty/error/retry verified |
| F5 | Rollout + browser QA + close | **Not started** | screenshots + KPI + rollback evidence |

---

## 5. Phase checklists

## F0 — Baseline + plan/state

- [x] Dùng Product Design router và audit workflow để xác định flow cần kiểm tra.
- [x] Ghi rõ giới hạn: không claim visual audit khi không có browser screenshot.
- [x] Đọc UI/API/repository/sync/migration/cache/design docs liên quan.
- [x] Chạy production D1 queries chỉ-đọc; xác nhận `rows_written=0`.
- [x] Xác nhận backfill đã xong và đo D1 size.
- [x] Mô phỏng policy `refCount >= 2` bằng SQL chỉ-đọc.
- [x] Ghi root cause, KPI, phase order, rollback và stop rules.
- [x] Tạo plan + state.

**Evidence:** baseline ở §1; source files được liệt kê trong plan §4.  
**Open issue:** visual/browser evidence chuyển sang F5.  
**Next exact action:** bắt đầu F1 bằng tests tái hiện TMDB timeout xóa last-good edge.

## F1 — Failure semantics + last-good

- [x] Viết failing tests cho TMDB success/empty/429/500/timeout/invalid JSON.
- [x] Đổi TMDB result thành `success | retryable_error`.
- [x] Đổi KKPhim resolver lookup thành `found | not_found | retryable_error`.
- [x] Retryable recommendation giữ last-good edge.
- [x] Valid-empty mới được atomic replace thành empty.
- [x] Resolver không mark attempted khi retryable.
- [x] Resolver check sync outcome + target row trước mark resolved.
- [x] Log summary chỉ gồm resolver counters, không chứa secret/payload.
- [x] Typecheck/tests/build/diff-check pass.
- [ ] Deploy A chỉ khi được authorize; `MAX_STUBS` vẫn 0.

**Evidence:** `tests/recommendationFailureSafety.test.mjs` 7/7 pass: TMDB success/empty/429/500/invalid JSON/timeout; last-good preserve; KKPhim retryable vs confirmed not-found; failed target sync; TMDB stub retry. `npm run worker:typecheck`, `npm run build`, Hero 11/11 và season-poster 3/3 pass.  
**Blocker:** Deploy A/production verification cần authorization riêng.  
**Rollback:** code-only rollback; schema/config chưa đổi.  
**Next exact action:** F2 dry-run cho eligible overflow groups, chỉ sau khi F1 Deploy A được authorize và verify.

## F2 — Requeue + bounded stubs

- [ ] Viết dry-run/query test cho eligible group.
- [ ] Implement cursor/batch requeue idempotent.
- [ ] Ưu tiên local-existing rồi refCount cao.
- [ ] Giữ overflow refCount 1.
- [ ] Bật cap 20.000 chỉ sau F1 production verify.
- [ ] Requeue 10.743 baseline groups theo batch.
- [ ] Purge source recommendation cache sau commit.
- [ ] Theo dõi storage/write/upstream/duration guards.
- [ ] Verify resolved ≥95%, stub ≤ cap, dangling=0.

**Evidence:** pending  
**Blocker:** F1 chưa complete; production authorization chưa có.  
**Rollback:** `MAX_STUBS=0`, dừng requeue, không xóa stub trong incident.

## F3 — Source freshness + repair

- [ ] Chốt migration freshness schema.
- [ ] Implement source-only refresh, atomic last-good semantics.
- [ ] Reuse resolved target/local lookup để tránh rail tụt tạm thời.
- [ ] Scheduler oldest-first, TTL mặc định 14 ngày, batch bounded.
- [ ] Repair 137 baseline source thiếu edge.
- [ ] Phân loại repaired/valid-empty/retryable.
- [ ] Metrics/status + tests + migration verification pass.

**Evidence:** pending  
**Blocker:** F1 contracts chưa complete.  
**Rollback:** disable scheduler; freshness columns/table giữ nguyên, không ảnh hưởng read path.

## F4 — Cache/API/UI resilience

- [ ] Purge exact source recommendation tags khi edge/resolution đổi.
- [ ] API order/dedupe/self-exclusion/limit tests.
- [ ] Frontend phân biệt success-empty và request error.
- [ ] Loading skeleton khi lazy mount bắt đầu.
- [ ] Error state gọn + retry một lần theo user action.
- [ ] Reuse Carousel/PosterCard/tokens; không redesign.
- [ ] Keyboard/focus/reduced-motion checks.

**Evidence:** pending  
**Blocker:** cần browser capability để nghiệm thu visual/interaction.  
**Rollback:** API contract giữ `{items}`; frontend có thể rollback độc lập.

## F5 — Rollout + QA + close

- [ ] Deploy A safety soak ít nhất một cron cycle.
- [ ] Apply freshness migration khi authorized.
- [ ] Deploy B bounded-stub/requeue khi authorized.
- [ ] Monitor cron/error/write/storage/cache metrics.
- [ ] Desktop 1440×900 screenshots accepted.
- [ ] Mobile 390×844 screenshots accepted.
- [ ] 6 detail sample matrix pass.
- [ ] Console/Network/keyboard/focus pass.
- [ ] Production KPI queries pass.
- [ ] Update HANDOFF/README/contract/ops nếu cần.
- [ ] Ghi final rollback version/evidence và đánh Complete.

**Evidence:** pending  
**Blocker:** F1–F4 + production authorization + browser capability.

---

## 6. Risk register

| Risk | Mức | Mitigation |
|---|---|---|
| Mở stub trước khi sửa failure semantics làm overflow lại hàng loạt | Critical | F1 bắt buộc trước F2 |
| Stub tăng D1 size/write nhanh | High | cap 20k, batch, preflight quota, stop guard |
| Mass requeue tạo upstream burst | High | refCount priority, rate limit, cursor, wall budget |
| Refresh source làm rail rỗng tạm thời | High | last-good atomic replace + reuse resolved target |
| Cache giữ response rỗng sau resolve | Medium | exact source tag purge |
| Multi-season cùng TMDB ID chọn slug không ổn định | Medium | chốt canonical rule/test trước rollout |
| UI retry state lệch design | Low | reuse tokens/components, screenshot QA |
| Product metric đạt nhưng visual audit thiếu | Medium | F5 không close nếu thiếu browser evidence |

---

## 7. Handoff template

```md
### Handoff F? — YYYY-MM-DD HH:mm ICT

- Status: Complete | Needs review | Blocked
- Objective completed:
- Exact files changed:
- Decisions changed:
- Commands + results:
- Production reads/writes performed:
- Evidence paths/URLs:
- Metrics before/after:
- Known risks/blockers:
- Safe rollback/checkpoint:
- Next exact action (one action only):
```

Không đánh `Complete` chỉ vì code merge; phase phải có test/evidence và production/browser gate tương ứng.

