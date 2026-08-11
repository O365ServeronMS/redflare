# State: Recommendation TMDB trên trang detail

**Plan:** [plan-recommendation-tmdb.md](plan-recommendation-tmdb.md)  
**Ngày tạo:** 2026-08-10  
**Overall:** F2 stub pilot deployed and healthy; F3 production repair continues; corrective track C is production-verified for Game of Thrones in House of the Dragon recommendations.
**Current phase:** F3 — In progress (corrective track C complete)
**Publish authorized:** Deploy A + F3 migration/scheduler + F2 pilot (`MAX_STUBS=1000`)

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
| Stub policy production | F2 pilot `MAX_STUBS=1000`, deployed version `83e0c69e-5b54-4b29-bdee-4da8a5b96b14` |
| F2 first verified cycle | 43 stub; 146 resolve-to-existing; 0 retryable; resolver 185s at 2026-08-10 07:00 UTC |
| F3 production version | `62c7e9b5-438f-4fa0-98d1-76d155ef3df3` |
| F3 first verified cycle | 16/16 success; 0 valid-empty; 0 retryable error at 2026-08-10 06:33 UTC |
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
| F1 | Failure semantics + last-good | **Needs review** | Deploy A published; cron-cycle evidence pending |
| F2 | Requeue + bounded stubs | **In progress** | First pilot cron healthy; 43/1.000 stubs; soak continues |
| F3 | Source freshness + repair | **In progress** | Migration deployed; first cron cycle wrote 16/16 success |
| F4 | Cache/API/UI resilience | **Needs review** | Contract + UI states tested; browser QA pending |
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
- [x] Deploy A authorized và published với `MAX_STUBS=0`.

**Evidence:** `tests/recommendationFailureSafety.test.mjs` 7/7 pass: TMDB success/empty/429/500/invalid JSON/timeout; last-good preserve; KKPhim retryable vs confirmed not-found; failed target sync; TMDB stub retry. `npm run worker:typecheck`, `npm run build`, Hero 11/11 và season-poster 3/3 pass. Deploy A production: version `f8a24d18-b7ba-4b77-8241-08fc712c9cbc`, published 2026-08-10 05:23 UTC; `MAX_STUBS=0` verified by Wrangler deployment output.
**Blocker:** cần evidence một cron cycle/status trước rollout cap stub.
**Rollback:** rollback Worker version; `MAX_STUBS` vẫn 0 nên không có stub write từ Deploy A.
**Next exact action:** wait một cron cycle, đọc counters `recommendation_resolve`/status, rồi mới authorize Deploy B.

## F2 — Requeue + bounded stubs

- [x] Viết dry-run/query test cho eligible group.
- [x] Implement cursor/batch requeue idempotent.
- [x] Ưu tiên local-existing rồi refCount cao.
- [x] Giữ overflow refCount 1.
- [x] Chốt pilot cap 1.000 sau F1/F3 production verify.
- [ ] Requeue 10.743 baseline groups theo batch.
- [x] Purge source recommendation cache sau commit.
- [x] Theo dõi `requeueCandidates`, `requeued`, `stubCount`, cap, cache tags và duration.
- [ ] Verify resolved ≥95%, stub ≤ cap, dangling=0.

**Evidence:** `tests/recommendationFailureSafety.test.mjs` 9/9 pass, bao gồm dry-run policy refCount≥2 và overflow→local requeue idempotent không gọi upstream. `npm run worker:typecheck`, `npm run build`, `git diff --check` pass. Production version `83e0c69e-5b54-4b29-bdee-4da8a5b96b14`: cron 07:00 UTC requeued 100 groups, resolved 146 vào catalog hiện hữu và tạo 43 stub; retryable=0; resolver 185s; cache tags purged 14.178. D1 read-back: 43 stub, 62.315 resolved edges, 0 refresh retryable error.
**Blocker:** tiếp tục soak 3–6 giờ trước khi xét tăng cap; resolver sát ngân sách 3 phút nên không tăng cap vội. Preflight trước rollout: 0 stub hiện hữu, 10.026 overflow group đủ điều kiện `refCount>=2`, D1 khoảng 173 MB.
**Rollback:** đặt `MAX_STUBS=0`, dừng requeue, không xóa stub trong incident.
**Next exact action:** theo dõi ít nhất một chu kỳ cron nữa; chỉ cân nhắc cap 5.000 sau 3–6 giờ không retryable/error và resolver không vượt ngân sách.

## F3 — Source freshness + repair

- [x] Chốt migration freshness schema.
- [x] Implement source-only refresh, atomic last-good semantics.
- [x] Reuse resolved target/local lookup để tránh rail tụt tạm thời.
- [x] Scheduler oldest-first, TTL mặc định 14 ngày, batch bounded; retry backoff 30 phút.
- [x] Apply migration `0011_recommendation_freshness.sql` trên production.
- [x] Deploy scheduler version `62c7e9b5-438f-4fa0-98d1-76d155ef3df3` với `MAX_STUBS=0`.
- [x] Verify cron đầu tiên ghi 16 source: 16 success, 0 valid-empty, 0 retryable error.
- [ ] Repair 137 baseline source thiếu edge trên production.
- [x] Phân loại repaired/valid-empty/retryable.
- [x] Metrics log + tests + migration fixture verification pass.

**Evidence:** `tests/recommendationRefresh.test.mjs` 3/3 pass: retryable giữ last-good và backoff; success giữ rank/resolved slug + pre-resolve local; valid-empty được ghi rõ. Recommendation safety 9/9, Hero 11/11, season-poster 4/4, Worker typecheck, Vite build và `git diff --check` pass. PR #5 squash-merged tại `9f0d082`; migration `0011` applied; production version `62c7e9b5-438f-4fa0-98d1-76d155ef3df3`. D1 read-only verification lúc 2026-08-10 06:33 UTC: 16 freshness rows, toàn bộ `success`, query ghi 0 row.
**Blocker:** chưa đủ chu kỳ để phân loại/repair toàn bộ 137 source baseline; F2 bounded stubs vẫn chủ động tắt (`MAX_STUBS=0`).
**Rollback:** disable scheduler; freshness table giữ nguyên, không ảnh hưởng read path.
**Next exact action:** theo dõi các cron kế tiếp cho đến khi 137 source baseline được repair hoặc phân loại `valid_empty`/`retryable_error`.

## F4 — Cache/API/UI resilience

- [x] Purge exact source recommendation tags khi edge/resolution đổi.
- [x] API order/dedupe/self-exclusion/limit tests.
- [x] Frontend phân biệt success-empty và request error.
- [x] Loading skeleton khi lazy mount bắt đầu.
- [x] Error state gọn + retry một lần theo user action.
- [x] Reuse Carousel/PosterCard/tokens; không redesign.
- [ ] Keyboard/focus/reduced-motion checks.

**Evidence:** recommendation client 2/2; safety suite 10/10 gồm self-exclusion/dedupe/TMDB order; refresh suite 3/3; Worker typecheck, Vite build và diff-check pass. UI loading, valid-empty, error/retry được implement trong Recommendation.js.
**Blocker:** Browser plugin không có và Playwright CLI thiếu runtime module, nên chưa có screenshot/interaction QA desktop/mobile.
**Rollback:** API contract giữ `{items}`; frontend có thể rollback độc lập.
**Next exact action:** chạy browser QA desktop/mobile cho loading, populated, valid-empty, error/retry và keyboard/focus trước production deploy.

## F5 — Rollout + QA + close

- [ ] Deploy A safety soak ít nhất một cron cycle.
- [x] Apply freshness migration khi authorized.
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

## Corrective track C — TMDB override: House of the Dragon → Game of Thrones

| Phase | Mục tiêu | Status | Checkpoint |
|---|---|---|---|
| C1 | Confirm root cause and preserve existing canonical slug | **Complete** | `tv/1399` candidates could not match because all eight catalog seasons lack upstream TMDB identity; no duplicate stub is created. |
| C2 | Add reviewed slug-to-TMDB override data and effective identity in sync | **Complete** | Migration `0012_tmdb_override.sql`; exact mapping seasons 1–8 to TMDB `tv/1399`. |
| C3 | Resolve edges through local override even when stub cap is full | **Complete** | Canonical resolver/requeue joins `tmdb_override`; regression suite covers an override before catalog re-sync. |
| C4 | Apply migration, deploy Worker, and verify production recommendation output | **Complete** | `0012` applied; Worker `94c17d2e-697b-497a-9c8a-cb3656a2b183` deployed; production API/D1 read-back pass. |

**Root cause:** KKPhim and phimapi return `tmdb: null` for the existing Game of Thrones catalog records. The original resolver used only `movie.tmdb_type/tmdb_id`, so the 23 pending `tv/1399` edges from House of the Dragon could never resolve to the already-streamable `tro-choi-vuong-quyen-phan-1` page. Raising `MAX_STUBS` risks a duplicate placeholder and does not repair identity.

**C4 acceptance:** all `tv/1399` House of the Dragon edges resolve to the existing season 1 slug; the recommendation API returns that slug at TMDB rank 0; no `game-of-thrones-tv-1399` stub is created. Re-syncing the eight catalog rows is a follow-up only if an authenticated batch trigger is available; it is not required for the render path after C3.

**C4 production evidence — 2026-08-11 03:16 UTC:** migration `0012_tmdb_override.sql` applied remotely; Worker `94c17d2e-697b-497a-9c8a-cb3656a2b183` deployed with dashboard `MAX_STUBS=1000` preserved. Read-back: 8 verified override rows, 23/23 `tv/1399` edges resolve to `tro-choi-vuong-quyen-phan-1`; `gia-toc-rong-phan-3` keeps `sort_order=0`; public API returns that slug first; duplicate `game-of-thrones-tv-1399` stub count is 0.

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

