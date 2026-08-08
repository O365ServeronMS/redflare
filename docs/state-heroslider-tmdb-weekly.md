# State: HeroSlider TMDB Weekly + KKPhim

> F3 status (2026-08-08): **Deploy B ready to publish**. Deploy A (`26cec11`)
> is active, migration `0010` is applied, and the production snapshot contains
> 14 valid Hero movies. Deploy B is the remaining rollout action.

## Current F3 board (overrides legacy blocked/pending rows below)

| Item | Status |
|---|---|
| Cron order, error-safe Hero logging, stale comments | Complete locally |
| `POST /__sync/refresh-hero` and private Hero status | Complete locally |
| Snapshot-only `/api/home-data` and no popularity fallback | Complete locally |
| Local D1/API simulation, tests, build, typecheck, dry-run | Complete locally |
| Deploy A checkpoint | Pushed to `origin/main` as `26cec11` |
| Remote migration, seed and D1 query | Complete: 14 rows, 14 unique IDs, 0 invalid rows |
| Deploy B, production API verification and rollback version evidence | Ready to push |

The current snapshot-reading worktree is the Deploy B artifact. Deploy A must
be built from a separate pre-cutover checkpoint where `buildHomeData()` still
uses `getHeroPool(20)`; do not deploy this worktree before migration `0010`
has been applied and seeded.

**Plan:** [plan-heroslider-tmdb-weekly.md](plan-heroslider-tmdb-weekly.md)
**Ngày tạo:** 2026-08-08
**Overall:** In progress — needs production verification
**Current phase:** F3 — Needs production verification
**Next primary agent:** `terra-medium` (F4, after authorized production rollout)
**Publish authorized:** Yes

> Đây là nguồn trạng thái duy nhất cho dự án. Agent mới đọc file này + phần phase tương ứng trong plan;
> không cần đọc lại chat hoặc toàn bộ tài liệu lịch sử.

---

## 1. Snapshot hiện tại

| Mục | Giá trị |
|---|---|
| Branch hiện tại | `codex/heroslider-tmdb-weekly` |
| Git baseline F1 | Tạo từ `main`; `.codex/` và `docs/recommendation/` có sẵn, không bị sửa/xóa |
| Migration mới | `0010_hero_snapshot.sql` — đã review/test local, chưa apply remote |
| Cron production trong repo | `*/15 * * * *` |
| Hero hiện tại | D1 catalog `popularity DESC`, tối đa 20 |
| API contract | `heroMovies` là mảng trần |
| CSS policy | Không sửa `src/styles/*.css` |
| Runtime upstream policy | `/api/*` chỉ đọc D1 |

### Audit baseline 2026-08-08

- Production từng hiển thị nhiều phim bộ trong Hero.
- Sau reload, danh sách đổi mạnh và có hai mục cùng tên “The Odyssey”.
- Code không gọi TMDB Trending Movies; chỉ dùng popularity snapshot.
- Query Hero không có `type='single'`, `tmdb_type='movie'`, `has_stream=1`.
- UI desktop hoạt động và Console sạch trong audit.
- Mobile audit chưa có evidence hợp lệ; bắt buộc làm lại ở F4.

---

## 2. Decision ledger — đã chốt, không hỏi lại

| ID | Quyết định | Trạng thái |
|---|---|---|
| D1 | TMDB source là `/trending/movie/week`, chỉ 20 item đầu trang 1 | Accepted |
| D2 | Provider là KKPhim exact lookup `/tmdb/movie/:id`, không phải TMDB Watch Providers | Accepted |
| D3 | Chỉ `movie` + `single` + `has_stream=1` + backdrop hợp lệ | Accepted |
| D4 | Không bù slot ngoài top 20; hiển thị đúng số match | Accepted |
| D5 | Dedupe theo TMDB ID, giữ rank xuất hiện đầu tiên | Accepted |
| D6 | Dùng cron 15 phút hiện có, success gate 30 phút | Accepted |
| D7 | Upstream lỗi giữ last-good snapshot | Accepted |
| D8 | Home request chỉ đọc D1 snapshot | Accepted |
| D9 | Không sửa CSS/không redesign | Accepted |
| D10 | Rollout hai bước: seed snapshot trước, rồi cut home API | Accepted |

---

## 3. Progress board

| Phase | Primary | Status | Token target / cap | Checkpoint |
|---|---|---|---:|---|
| F1 Contract/schema/repository | `sol` | Complete | 6k / 8k | migration chưa apply; typecheck + tests pass |
| F2 Refresh pipeline | `terra-high` | Complete | 12k / 16k | mock/fixture pass; chưa nối cron |
| F3 Cron/API rollout | `terra-medium` | Needs production verification | 8k / 10k | local wiring pass; remote seed/cutover pending |
| F4 Browser QA/docs | `terra-medium` | Blocked by F3 production verification | 8k / 10k | desktop/mobile/Console pass |

Allowed status values: `Not started`, `In progress`, `Needs review`, `Blocked`, `Complete`.

---

## 4. Phase checklists và evidence

## F1 — Contract/schema/repository

- [x] Tạo branch sau khi reconfirm working tree và phân biệt rõ file có sẵn với file của feature.
- [x] Chốt D1 atomic replacement strategy.
- [x] Thêm migration snapshot.
- [x] Thêm repository + types.
- [x] Cập nhật API contract docs.
- [x] Test rank/unique/empty/atomic behavior.
- [x] `npm run worker:typecheck` pass.
- [x] `git diff --check` pass.
- [x] Migration chưa apply remote.
- [x] Cập nhật handoff F1.

**Evidence:** [Cloudflare D1 `batch()`](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)
xác nhận batch là SQL transaction và rollback toàn sequence khi một statement lỗi;
`tests/heroSnapshotRepository.test.mjs` chạy trên Miniflare D1 bằng chính migration `0010`.
**Files changed:** `migrations/0010_hero_snapshot.sql`,
`src-ssr/types/heroSnapshot.ts`, `src-ssr/repositories/heroSnapshotRepository.ts`,
`tests/heroSnapshotRepository.test.mjs`, `package.json`, `docs/contract-legacy-api.md`, file state này.
**Commands run:** `npm run worker:typecheck` (pass); `npm run test:hero-snapshot` (2/2 pass);
`git diff --check` (pass, chỉ có warning CRLF của Git); checker `terra-low` chạy lại cùng checklist và pass.
**Open issues:** Không có blocker F1; migration chưa được apply ở local/remote runtime theo đúng scope.

## F2 — Refresh pipeline

- [x] TMDB weekly client trả first 20.
- [x] KKPhim lookup phân biệt not-found và retryable error.
- [x] Service lọc movie/single/stream/backdrop.
- [x] Dedupe và preserve order.
- [x] Last-good behavior pass.
- [x] Observability summary ngắn.
- [x] Fixtures failure matrix pass.
- [x] Typecheck/diff-check pass.
- [x] Cập nhật handoff F2.

**Evidence:** `tests/heroSnapshotRefresh.test.mjs` mocks TMDB/KKPhim through `fetch`; the bundled test fixture is
removed after each successful run. The F1 snapshot test was also rerun and still passes.
**Files changed:** `src-ssr/services/sync/tmdbClient.ts`, `src-ssr/services/sync/kkphimClient.ts`,
`src-ssr/services/sync/heroSnapshot.ts`, `src-ssr/repositories/heroSnapshotRepository.ts`,
`tests/heroSnapshotRefresh.test.mjs`, `tests/cloudflareWorkersMock.mjs`, `package.json`, this state file.
**Commands run:** `npm run worker:typecheck` (pass); `npm run test:hero-refresh` (7/7 pass);
`npm run test:hero-snapshot` (2/2 pass); `git diff --check` (pass).
**Open issues:** F3 must not wire `scheduled()`, an ops route, apply the migration, or deploy/push before publish is authorized.

## F3 — Cron/API rollout

- [x] Nối scheduled handler đúng thứ tự.
- [x] Sửa comment cron stale.
- [x] Thêm gated refresh route/status.
- [ ] Deploy A + apply migration khi được phép.
- [ ] Seed snapshot và verify D1.
- [x] Cut home API sang snapshot (Deploy B artifact; chưa production).
- [ ] Deploy B khi được phép.
- [x] API contract + dry-run pass (local).
- [x] Ghi rollback evidence (local ops doc).
- [x] Cập nhật handoff F3.

**Evidence:** local D1/API simulation + full Hero test suite pass; production evidence pending authorization.
**Deploy A version:** pending
**Deploy B version:** pending
**Rollback point:** pending

## F4 — Browser QA/docs/close

- [ ] Desktop 1440×900 accepted screenshot.
- [ ] Mobile 390×844 accepted screenshot.
- [ ] Rail interactions pass.
- [ ] Không series/duplicate/no-stream.
- [ ] Console sạch.
- [ ] Browser không gọi upstream.
- [ ] Cron 30-minute gate verified.
- [ ] HANDOFF/README/state updated.
- [ ] `src/styles/*.css` diff rỗng.
- [ ] Publish/smoke test chỉ khi authorized.

**Evidence:** blocked by F3
**Screenshot folder:** pending
**Production smoke:** pending

---

## 5. Handoff template — bắt buộc điền trước khi đổi agent

```md
### Handoff F? — YYYY-MM-DD HH:mm ICT

- Primary/model:
- Status: Complete | Needs review | Blocked
- Token usage estimate:
- Objective completed:
- Exact files changed:
- Decisions made (IDs from Decision ledger):
- Commands + results:
- Evidence paths/URLs:
- Known risks/blockers:
- Safe rollback/checkpoint:
- Next agent:
- Next exact action (one action only):
```

Handoff tối đa 1.500 token. Không copy plan, không paste log dài; lưu log vào file và trỏ path.

---

### Handoff F3 — 2026-08-08 ICT

- Primary/model: `terra-medium`
- Status: Needs production verification
- Objective completed: Cron wiring, authenticated refresh/status operations,
  snapshot-only home-data cutover, local D1 route/API simulation, and rollback
  documentation.
- Exact files changed: `src-ssr/index.ts`, `src-ssr/routes/sync.ts`,
  `src-ssr/api/homeData.ts`, `src-ssr/api/routes.ts`,
  `src-ssr/services/sync/heroSnapshot.ts`, `tests/heroHomeData.test.mjs`,
  `package.json`, `docs/heroslider-tmdb-weekly-ops.md`, this state file.
- Decisions made: D6 runs refresh after incremental sync; D7 isolates an
  unexpected refresh throw so recommendation/backfill continue; D8 removes
  popularity fallback from the home Hero read path.
- Commands + results: `npm run test:hero-home-data` 2/2 pass;
  `npm run test:hero-snapshot` 2/2 pass; `npm run test:hero-refresh` 7/7
  pass; `npm run worker:typecheck`, `npm run build`, `npx wrangler deploy
  --dry-run`, and `git diff --check` pass. Dry-run compiled the Worker and
  assets without deployment.
- Production evidence: migration `0010` applied remotely; cron seeded 14
  snapshot rows from TMDB's first 20. D1 verification found 14 unique TMDB
  IDs, ranks 2–20, and 0 rows outside catalog/movie/single/has_stream=1.
- Safe rollback/checkpoint: Deploy A is the separately built pre-cutover
  checkpoint using `getHeroPool(20)`; rollback Deploy B returns to that
  version while retaining the migration and snapshot table.
- Next agent: `terra-medium` (F4 after authorized production A/B rollout)
- Publish checkpoint: Deploy A commit `26cec11` was pushed to `origin/main`.
  Migration `0010` is applied and its cron refresh succeeded.
- Next exact action (one action only): push Deploy B snapshot-only home-data
  cutover, then verify the production API and browser.

### 2026-08-08 — Root verification after F3 handoff

- Re-ran all local feature suites: home-data 2/2, refresh 7/7, and repository 2/2; Worker typecheck and Vite build pass.
- Wrangler `deploy --dry-run` passes using project-local `XDG_CONFIG_HOME` and `XDG_CACHE_HOME`; no remote write occurred.
- Confirmed the Deploy B worktree reads only `hero_snapshot`, and the Deploy A requirement remains an explicit pre-cutover build before migration/seed.

## 6. Token accounting

| Phase | Agent/model | Start estimate | End estimate | Result |
|---|---|---:|---:|---|
| F1 | `sol` | 0 | ~6k | Complete |
| F2 | `terra-high` | 0 | ~12k | Complete |
| F3 | `terra-medium` | 0 | ~8k | Needs production verification |
| F4 | pending | 0 | 0 | — |

### Stop rules

1. Còn dưới 20% budget phase → không bắt đầu checklist item mới.
2. Một lỗi lặp lại 3 lần → ghi blocker + evidence, bàn giao; không tiếp tục thử ngẫu nhiên.
3. Phát hiện phải đổi Decision ledger → dừng và chuyển cho `sol`, không tự đổi bằng terra.
4. Production state không khớp repo → dừng trước mọi write/deploy.
5. Phase chưa có verify command pass → không đánh `Complete`.

---

## 7. Risk register

| Risk | Owner | Mitigation | Status |
|---|---|---|---|
| D1 batch không atomic như giả định | F1 `sol` | Cloudflare docs + Miniflare rollback test xác nhận atomic batch | Closed |
| KKPhim client đang gộp 404 và network error thành null | F2 `terra-high` | typed lookup result + 404/429 fixture | Closed |
| Nhiều slug cùng một TMDB ID | F2 `terra-high` | exact canonical lookup + dedupe + unique tmdb_id snapshot | Closed |
| Backfill đang thay đổi catalog khi audit | F3 `terra-medium` | snapshot tách khỏi popularity/catalog order | Open |
| Không có CRON_KEY để force production | F3 | chờ cron + query D1; không rotate secret chỉ để test | Open |
| Mobile viewport capture lỗi như audit trước | F4 | dùng browser surface hợp lệ; không nhận ảnh sai viewport | Open |
| Working tree có file untracked không thuộc feature | F1 | status trước khi branch; không stage/sửa/xoá file của user | Open |

---

## 8. Append-only execution log

### 2026-08-08 — Plan created

- Tạo plan tối đa 4 phase và state tracking riêng.
- Chưa sửa source code, migration hoặc cấu hình runtime.
- Chưa tạo branch, chưa apply migration, chưa deploy/push.
- Next action: F1 do `sol` thực hiện sau khi reconfirm Git state.

### Handoff F1 — 2026-08-08 ICT

- Primary/model: `sol`
- Status: Complete
- Token usage estimate: ~6k (target 6k, cap 8k)
- Objective completed: Chốt schema snapshot, atomic repository contract, types, contract docs và test D1 tối thiểu.
- Exact files changed: `migrations/0010_hero_snapshot.sql`; `src-ssr/types/heroSnapshot.ts`;
  `src-ssr/repositories/heroSnapshotRepository.ts`; `tests/heroSnapshotRepository.test.mjs`;
  `package.json`; `docs/contract-legacy-api.md`; file state này.
- Decisions made: D1–D5, D7–D8 được mã hóa ở schema/repository; dùng một `DB.batch()` cho
  `DELETE + INSERT + 3 sync_state UPSERT`, không cần generation pointer.
- Commands + results: `npm run worker:typecheck` pass; `npm run test:hero-snapshot` 2/2 pass;
  `npm run build` pass; `git diff --check` pass.
- Evidence: Cloudflare D1 batch URL ở F1 Evidence; test dùng migration thật và chứng minh failed
  insert giữ nguyên cả snapshot lẫn metadata cũ.
- Known risks/blockers: F2 phải phân biệt KKPhim `not_found` với retryable error; chỉ gọi
  `replaceSnapshot()` sau khi cả 20 candidate đã được phân loại chắc chắn.
- Safe rollback/checkpoint: Chưa apply migration hoặc nối runtime; source hiện tại vẫn dùng
  `MovieRepository.getHeroPool()`. Có thể bỏ riêng các file F1 và revert ba file docs/package mà
  không ảnh hưởng production.
- Next agent: `terra-high`
- Next exact action (one action only): Bắt đầu F2 bằng typed TMDB weekly client + KKPhim lookup result,
  chưa nối cron hoặc `homeData`.

### 2026-08-08 — Root verification after F1 handoff

- Re-ran typecheck and the Miniflare repository suite independently: pass, 2/2 tests.
- Production Vite build passed; no runtime wiring, remote migration, deployment or push was performed.

### Handoff F2 — 2026-08-08 ICT

- Primary/model: `terra-high`
- Status: Complete
- Token usage estimate: ~12k (target 12k, cap 16k)
- Objective completed: Typed TMDB weekly candidates, typed exact KKPhim lookup, refresh service, last-good attempt
  recording, and mocked-fetch fixture matrix. No runtime wiring was added.
- Exact files changed: `src-ssr/services/sync/tmdbClient.ts`; `src-ssr/services/sync/kkphimClient.ts`;
  `src-ssr/services/sync/heroSnapshot.ts`; `src-ssr/repositories/heroSnapshotRepository.ts`;
  `tests/heroSnapshotRefresh.test.mjs`; `tests/cloudflareWorkersMock.mjs`; `package.json`; this state file.
- Decisions made: D1–D8 applied. TMDB inspects only `results.slice(0, 20)` and retains source rank;
  non-movie media types, duplicate IDs, non-single KKPhim records, missing playable links, and absent D1 backdrops
  never receive a replacement slot. 404/status-false is `not_found`; timeout/429/5xx/parse/shape inconsistency is
  `retryable_error`, which records the attempt while preserving the prior snapshot.
- Commands + results: `npm run worker:typecheck` pass; `npm run test:hero-refresh` 7/7 pass;
  `npm run test:hero-snapshot` 2/2 pass; `git diff --check` pass.
- Evidence: The F2 fixture covers a 25-result TMDB payload (only 20 lookups), seven ordered matches, TMDB TV
  rejection, duplicate IDs, two D1 rows sharing a TMDB ID with only the exact canonical slug selected,
  single/stream/backdrop filtering, KKPhim 429 last-good, invalid TMDB payload last-good, and the 30-minute
  no-fetch gate plus `force=true` bypass.
- Known risks/blockers: Real upstream behaviour is not exercised locally. F3 requires publish authorization before
  migration application or Deploy A.
- Safe rollback/checkpoint: This service is not imported by `scheduled()` or `/api/home-data`; reverting F2 source
  files and the repository attempt method cannot alter current runtime behaviour.
- Next agent: `terra-medium`
- Next exact action (one action only): Prepare F3 runtime wiring for the A/B rollout, but stop before every
  apply/deploy/push action until publish authorization is granted.

### 2026-08-08 — Root verification after F2 handoff

- Reviewer-required fixtures passed: exact canonical slug wins over a duplicate D1 TMDB row; the 30-minute
  gate makes zero upstream calls and `force=true` bypasses it.
- TMDB guard accepts a missing `media_type` from the movie-specific endpoint, but rejects an explicitly
  non-movie value; this preserves valid `/trending/movie/week` payloads without admitting TV data.
- Re-ran `npm run test:hero-refresh` (7/7), `npm run worker:typecheck`, `npm run test:hero-snapshot` (2/2),
  `npm run build`, and `git diff --check`: all pass. No CSS or F3 runtime wiring changed.
