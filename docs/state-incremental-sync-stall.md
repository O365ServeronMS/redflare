# State — Incremental sync stall (docs/plan-incremental-sync-stall.md)

Running log of what each phase actually did, numbers measured, what is left.

---

## Phase 0 — Vận hành ngay

- **Hướng đi: A — ở lại Free.** Chủ dự án chọn 2026-09-10. Làm Phase 1 → 6
  theo thứ tự; recommendation jobs giữ tắt cho tới khi có plan riêng tối ưu
  Q3/Q6. Phim mới chỉ chảy lại sau khi deploy Phase 5.2 (chủ dự án duyệt
  từng push).
- **0.1** Không trigger workflow tay, không bật cron cho tới khi Phase 1
  deploy xong và đo D1 24h.
- **0.3** Notifications trên dashboard (D1 limit, Workers usage): chủ dự án
  tự bật — chưa xác nhận trong phiên này.

**Tiêu chí xong:** đạt (hướng A đã ghi vào state doc).

---

## Phần code (phiên 2026-09-10) — Phase 1–4

Session scope đã thống nhất với chủ dự án: viết toàn bộ code + test cho
Phase 1–4, chạy đủ bộ verify sau mỗi phase. **Không** apply migration,
**không** `git push`, **không** `wrangler deploy` — để lại cho Phase 5
(chủ dự án duyệt từng bước).

### Phase 1 — Cắt D1 rows read

Code xong 2026-09-10. Chưa apply migration, chưa deploy (Phase 5).

- **1.1** `migrations/0016_genre_movie_slug_index.sql` (`idx_gm_slug`),
  `migrations/0017_country_movie_slug_index.sql` (`idx_cm_slug`). Chưa
  `wrangler d1 migrations apply` — để Phase 5.1, apply từng file, đọc
  `rows_written` sau 0016 trước khi chạy 0017. `idx_gm_list`/`idx_cm_list`
  **không** xoá (cleanup để sau).
- **1.2** `searchRepository.ts`: `indexMovie` xoá FTS qua
  `DELETE … WHERE rowid IN (SELECT rowid … WHERE fts_movie MATCH ? AND slug = ?)`,
  MATCH = `alias : "<tokens>"`. Builder tách ra hàm export `buildAliasMatch`
  (trả `null` khi slug không có token → fallback `WHERE slug = ?`).
- **1.3** `movieRepository.ts` `getCanonicalTargetByTmdbRef`: OR-qua-LEFT-JOIN
  → `UNION ALL` (idx_movie_tmdb + join override theo PK). 4 tham số bind
  giữ nguyên. 2 test hành vi cũ trong `recommendationFailureSafety` vẫn xanh.
- **1.4** 3 rail query (dòng ~232/276/293): `COALESCE(upstream_modified,
  last_synced) DESC` → `upstream_modified DESC`. `toRow` (dòng ~46) bind
  `m.modifiedAt ?? now` để không bao giờ ghi NULL.
- **1.5** `catalogStatsRepository.refresh()`: đầu hàm đọc `sync_state`
  key `catalog_stats:refreshed_at`, còn mới < 6h thì return; cuối hàm ghi
  lại key. 3 caller cùng được giới hạn, không sửa caller.

**Test:** thêm `tests/catalogStats.test.mjs` + script `test:catalog-stats`
(dùng pattern esbuild-bundle vì repo dùng parameter-property constructor,
`node --test` thẳng .ts không strip được). Thêm 2 test `buildAliasMatch` +
1 test re-index FTS vào `tests/search.test.mjs`.

**Verify (Luật chung #4) — tất cả xanh:**
`worker:typecheck` ok · `build` ok · `test:incremental-sync` 12 ·
`test:home-rail-ordering` 3 · `test:search` 10 · `test:hero-refresh` 7 ·
`test:recommendation-safety` 13 · `test:recommendation-refresh` 3 ·
`test:catalog-stats` 2 · `wrangler deploy --dry-run` ok.

Còn phải làm (Phase 5.1): apply 0016/0017 rồi verify EXPLAIN QUERY PLAN
trên production (`SEARCH … USING INDEX idx_gm_slug` / `idx_cm_slug`), đo D1
rows read 24h.

### Phase 2 — Quét feed không phụ thuộc đồng hồ

Code xong 2026-09-10. Chưa deploy.

- **2.1** `movieRepository.ts`: thêm `getSyncMarkersBySlugs(slugs)` →
  `Map<slug, {sourceHash, upstreamModified}>` (SELECT qua PK, `chunkByParams`
  như `getHashesBySlugs`), và `setUpstreamModified(slug, modifiedAt)`
  (`UPDATE movie SET upstream_modified = ? WHERE slug = ?`).
  `getHashesBySlugs` **không sửa** — sau Phase 2 nó không còn caller trong
  `src-ssr/` (chỉ tự test dùng); giữ lại theo plan, đánh dấu là dead code
  để dọn sau.
- **2.2** `orchestrator.ts`: bỏ `RECENT_PAGE_LIMIT = 2`, thêm
  `DEFAULT_RECENT_PAGE_CAP = 30` + `resolveRecentPageCap(env)` (đọc
  `[vars] RECENT_PAGE_CAP`, `Number.parseInt`, kẹp `[1, 40]`, giá trị
  hỏng → 30). Thêm `'known_page'` vào `IncrementalStopReason`. Viết lại
  vòng lặp `scanRecentSlugs`: mỗi trang gọi `getSyncMarkersBySlugs`, item
  bị bỏ qua khi `marker.upstreamModified === Math.floor(Date.parse(feed
  time)/1000)` (so bằng, không so trước/sau — F3); trang mà mọi item đều
  known → `scanComplete=true`, stop `'known_page'`. Bỏ hết `cursorTime` /
  `crossedCursor` / tie-break theo `cursor.slug`. `cursor:recent` vẫn đọc
  (seed `newest`) và vẫn được caller ghi, chỉ còn để chẩn đoán.
- **2.3** `syncMovie.ts` (F4): dùng `getSyncMarkersBySlugs([slug])`. Khi
  `marker.sourceHash === hash` mà `movie.modifiedAt` khác
  `marker.upstreamModified` → `setUpstreamModified`, trả
  `{outcome:'unchanged', rowsWritten:1}`; ngược lại `rowsWritten:0`.
- **2.4** `incrementalSyncWorkflow.ts`: chỉ sửa comment cursor →
  "diagnostic-only".
- **2.5** `wrangler.toml`: thêm `RECENT_PAGE_CAP = "30"` vào `[vars]`
  (comment theo phong cách `BACKFILL_*`). `cf-typegen` chạy lại
  (worker-configuration.d.ts gitignore, build tự sinh).

**Test** (`tests/incrementalSyncSafety.test.mjs`): mock DB đổi
`SyncStateDb` → `MockDb` (thêm bảng `movie` cho
`SELECT slug, source_hash, upstream_modified … WHERE slug IN` và
`UPDATE movie SET upstream_modified`; harness nhận `known` + `cap`).
Viết lại 4 test ngữ nghĩa cursor cũ, thêm test: backlog 7 trang + trang 8
known → `known_page`/8 trang; trang 1 known hết → 1 fetch/0 slug; timestamp
feed lệch +7h vẫn tìm ra slug mới; `RECENT_PAGE_CAP="3"` → `page_limit`/3
fetch + clamp `"0"`→1; F4 bump `upstream_modified` (rowsWritten 1) + no-op
khi đã current. `tests/recommendationFailureSafety.test.mjs`: 3 mock
`getHashesBySlugs` → `getSyncMarkersBySlugs`.

**Đánh đổi đã biết:** slug alias / slug 404 vĩnh viễn không bao giờ "known"
→ thử lại mỗi tick (1 step + 1 call). Title chỉ đổi `modified.time` sẽ nhảy
lên đầu rail — khớp thứ tự feed KKPhim.

**Verify — tất cả xanh:** `worker:typecheck` · `build` ·
`test:incremental-sync` 17 · `test:home-rail-ordering` 3 · `test:search` 10 ·
`test:hero-refresh` 7 · `test:recommendation-safety` 13 ·
`test:recommendation-refresh` 3 · `test:catalog-stats` 2 ·
`wrangler deploy --dry-run` ok.

### Phase 3 — Cron cổ điển làm trigger chính

Code xong 2026-09-10. Chưa deploy.

- **3.1** `wrangler.toml`: thêm `[triggers] crons = ["*/30 * * * *"]`. Xoá
  `schedules = [...]` khỏi cả 5 `[[workflows]]`. Comment cũ ("each
  Workflow's `schedules` is its own cron budget") thay bằng comment kể sự
  cố 2026-09-07 + lý do một nguồn kích hoạt duy nhất (quay lại Paid mà giữ
  cả hai sẽ chạy đôi).
- **3.2** `src-ssr/services/sync/dispatch.ts` (mới):
  `dispatchScheduledWorkflows(env, scheduledTime)`. Mỗi tick tạo
  `incremental-${scheduledTime}`; `topOfHour` (UTC minute 0) thêm
  `hero-${scheduledTime}`. `RECOMMENDATION_RESOLVE`/`_REFRESH` chỉ khi
  `env.RECOMMENDATION_JOBS_ENABLED === "true"` (resolve mỗi tick, refresh
  topOfHour). `BACKFILL_WORKFLOW` chỉ khi `env.BACKFILL_ENABLED === "true"`.
  Id tất định theo `scheduledTime` (double-fire → Workflows từ chối id
  trùng), khớp `^[a-zA-Z0-9_][a-zA-Z0-9-_]*$`. Mỗi `create` bọc try/catch,
  lỗi → `console.error(JSON.stringify({message:'workflow dispatch failed',
  workflow, error}))`; hàm không bao giờ throw.
- **3.3** `src-ssr/index.ts`: thêm
  `scheduled(controller, env, ctx) { ctx.waitUntil(dispatchScheduledWorkflows(env, controller.scheduledTime)); }`.
  Comment "legacy scheduled() handler" viết lại: handler mới chỉ
  `Workflow.create()`, không làm việc nặng.
- **3.4** `wrangler.toml [vars]`: thêm `RECOMMENDATION_JOBS_ENABLED = "false"`
  (comment Q3/Q6). `cf-typegen` chạy lại.

**Gotcha đã sửa:** JSDoc trong `dispatch.ts` không được chứa chuỗi `*/N`
(kết thúc block comment sớm) — viết "every 30 minutes".

**Test:** `tests/cronDispatch.test.mjs` + script `test:cron-dispatch`
(esbuild pattern). 6 ca: mid-hour → chỉ incremental; top-of-hour → +hero;
recommendation off/on đúng cadence; backfill off/on; `create` throw →
các workflow khác vẫn tạo + log 1 dòng lỗi; id tất định + đúng grammar +
replay ra cùng id.

**Ngân sách steps dự kiến:** incremental ~400–700/ngày + hero ~550/ngày
≈ 1.000–1.300/ngày < 3.000.

**Verify — tất cả xanh:** `worker:typecheck` · `build` · 7 suite Luật #4 +
`test:cron-dispatch` 6 · `wrangler deploy --dry-run` ok (wrangler
4.120 không in `[triggers]` ở dry-run, nhưng TOML parse ok; xác nhận
`crons = ["*/30 * * * *"]` có mặt, 0 `schedules =` config còn lại).

### Phase 4 — Health check

Code xong 2026-09-10. Chưa deploy.

- **4.1** `src-ssr/routes/sync.ts` `/__sync/status`: thêm
  `recentSync.ageSeconds` (từ `recentSync.recordedAt`) và
  `stale: { incremental, hero }`. Ngưỡng `INCREMENTAL_STALE_SECONDS = 45*60`
  và `HERO_STALE_SECONDS = 90*60`, export từ `dispatch.ts`.
- **4.2** `src-ssr/api/routes.ts`: route mới `GET /api/health/sync`
  (public, không dưới `/__sync/*`). Trả
  `{ ok, incrementalAgeSeconds, heroAgeSeconds }`, HTTP 200 khi còn tươi
  (cả hai age ≤ ngưỡng), 503 khi cũ / chưa từng chạy. `applyNoStore(c)`.
  Chỉ đọc 2 key `sync_state` (`recent:last_run`, `hero:last_success_at`)
  qua `SyncStateRepository.get` (2 point read theo PK). Không trả cursor /
  slug.
- **4.3** Chủ dự án tự gắn monitor ngoài (UptimeRobot / cron-job.org /
  Better Stack) vào `https://film.bluesia.net/api/health/sync`, cảnh báo
  khi ≠ 200 — **chưa làm trong phiên này**.

**Test:** `tests/healthSync.test.mjs` + script `test:health-sync`
(Miniflare D1, gọi `apiRoute.fetch`). 4 ca: fresh → 200 + age nhỏ + header
`no-store` + body chỉ 3 khoá; incremental stale → 503; hero stale → 503;
chưa từng chạy → 503 + age `null`. `test:hero-home-data` (đang hit
`/__sync/status`) vẫn xanh — chỉ assert `body.hero`, không đụng field mới.

**Verify — tất cả xanh:** `worker:typecheck` · `build` · toàn bộ suite
(`incremental-sync` 17, `home-rail-ordering` 3, `search` 10,
`hero-refresh` 7, `hero-snapshot` 2, `hero-home-data` 3,
`recommendation-safety` 13, `recommendation-refresh` 3,
`recommendation-client` 2, `image-policy` 4, `season-poster` 4,
`catalog-stats` 2, `cron-dispatch` 6, `health-sync` 4) ·
`wrangler deploy --dry-run` ok.

---

## Phase 5 — Deploy theo từng nấc

### 5.1 — Phase 1 (đang chạy, 2026-09-10 ~12:25 UTC)

- **Commit tách đôi:** `cc8a076` = Phase 1 (request-path), `973460d` =
  Phase 2–4 (giữ local trên branch `worktree-bridge-cse_01GSVZFWrBmKCjkdb125t2Lm`,
  chưa push). `movieRepository.ts` / `package.json` tách hunk sạch; đã
  verify Phase 1 cô lập trong worktree tạm: `worker:typecheck` ok, `build`
  ok, 7 suite xanh (`test:incremental-sync` 12 — bản gốc, đúng vì test
  Phase 2 nằm ở `973460d`), `wrangler deploy --dry-run` ok.
- **Deploy:** `git push origin cc8a076:main` (`ee750f6..cc8a076`) lúc
  ~12:24 UTC 2026-09-10. Cloudflare Workers Builds tự build. Site còn sống
  (`/api/home-data` 200); `/api/health/sync` vẫn 404 → đúng, chỉ Phase 1
  lên, chưa Phase 4.
- **Migration 0016 applied `--remote`** lúc ~12:24 UTC: `idx_gm_slug` ✅.
  Đo: `genre_movie` = 77.664 row → 0016 ghi ~77,7k index-entry hôm nay.
  `country_movie` = 33.738 row.
- **0017 HOÃN sang ngày UTC sau (>= 2026-09-11 00:00 UTC).** Lý do: 77,7k
  (0016) + 33,7k (0017) ≈ 111k > ngưỡng 80k/ngày của plan và sát trần
  cứng 100k/ngày. Bộ đếm write D1 reset lúc 00:00 UTC.
- **`d1 insights --timePeriod=1d` lúc 2026-09-11 ~07:48 UTC** (≈19,5h sau
  deploy): không còn query request-path nào lặp lại với rows read cao —
  chỉ còn 1 lần chạy còn sót của câu `COALESCE(...)` cũ (trước deploy) và
  vài query kiểm tra tay của phiên trước. Tín hiệu đủ tốt để không cần chờ
  hết 24h mới sang 5.2 (chủ dự án đồng ý đi luôn).
- **0017 applied `--remote`** lúc 2026-09-11 ~07:50 UTC (ngày UTC mới, còn
  nguyên ngân sách write). Verify: `EXPLAIN QUERY PLAN DELETE FROM
  country_movie WHERE slug='x'` → `SEARCH country_movie USING INDEX
  idx_cm_slug (slug=?)`. **Phase 5.1 xong.**

### 5.2 — Phase 2–4 (2026-09-11 ~07:52 UTC)

- Code Phase 2–4 nằm trên branch `worktree-bridge-cse_01GSVZFWrBmKCjkdb125t2Lm`
  (commit `a6a1f41`), chưa từng lên `main`. Cherry-pick sạch (không conflict)
  vào worktree này trên nền `bcd5d15` (= Phase 1 đã deploy), verify lại toàn
  bộ Luật chung #4 (typecheck, build, 9 suite test, `deploy --dry-run`) —
  tất cả xanh, không cần sửa gì thêm.
- Deploy trước khi đủ 24h đo Phase 1 (chủ dự án chấp nhận rủi ro dựa trên
  tín hiệu `d1 insights` ở trên). Recommendation vẫn tắt
  (`RECOMMENDATION_JOBS_ENABLED = "false"`).
- **Theo dõi tiếp (chủ dự án hoặc phiên sau):** tick đầu tự bắt kịp backlog
  (`stopReason: 'known_page'`, `pagesScanned` ~8+); `/api/health/sync` phải
  chuyển từ 404 sang 200 trong vòng ~30 phút sau tick đầu. 24h đầu: rows
  read < 2M/ngày, rows written < 50k/ngày, steps < 2.000/ngày. Backlog dài
  hơn 30 trang (tick đầu ra `page_limit`) → đặt tạm `RECENT_PAGE_CAP = "40"`
  trên dashboard.
- **Phase 5.3:** giữ recommendation tắt tới khi có plan tối ưu Q3/Q6.
- **Deploy:** `git push origin 4516ca1:main` (`bcd5d15..4516ca1`) lúc
  ~07:56 UTC 2026-09-11. Build mới `d5c43a42` lên sau ~20s. Smoke test
  (`/`, `/api/home-data`, `/phim/rf-smoke`, `/sitemap.xml`, `/robots.txt`)
  đều 200. `GET /api/health/sync` → `503 {"ok":false,
  "incrementalAgeSeconds":374294,"heroAgeSeconds":374324}`, `cache-control:
  private, no-store` — đúng như kỳ vọng vì job dừng từ 2026-09-07, cron
  `*/30 * * * *` mới vừa đăng ký nên chưa tới tick đầu. **Cần theo dõi tick
  đầu** (trong vòng 30 phút): kỳ vọng `/__sync/status` báo `stopReason:
  'known_page'`, `pagesScanned` ≥ 8; sau đó `/api/health/sync` chuyển 200.
- **Phase 6:** cập nhật `README.md` (cron dispatcher, `/api/health/sync`,
  `RECENT_PAGE_CAP`, `RECOMMENDATION_JOBS_ENABLED`, bảng ngân sách Free,
  quy trình khi sync ngừng, ghi chú F3); sửa comment `wrangler.toml` còn
  nói "account is on Paid"; điền số liệu thật vào doc này.

### 5.2b — Sự cố quota subrequest theo instance (2026-09-11)

- **Tick đầu** (`incremental-1789113655000`, 08:00 UTC): quét 9 trang, dừng
  ở `known_page`, tìm ra 169 slug, nhưng chỉ `written: 11`, `failed: 158`.
  11 phim đầu ghi được, sau đó mọi phim đều lỗi, trong khi phimapi vẫn trả
  200 cho các slug lỗi. Hero cùng tick: 19 candidate ổn, candidate thứ 20
  `retryable_error` → cả snapshot bị bỏ → `/api/health/sync` 503.
- **Nguyên nhân:** tài liệu Workflows Limits ghi Free = **50 external
  subrequest cho mỗi Workflow instance**; plan (Phase 2) và README lại giả
  định là cho mỗi step. 9 trang + 11 phim × ~3,7 fetch ≈ 50. Trên Paid,
  giới hạn là 10.000 nên lỗi chưa từng lộ ra.
- **Sửa:**
  - `orchestrator.ts` thêm `syncBudgetForPages(pages) =
    floor((50 − pages) / 5)` (5 = KKPhim detail + 1 lần re-fetch alias + TMDB
    detail/season/recs).
  - `IncrementalSyncWorkflow` chỉ sync `slice(0, budget)`, phần còn lại để
    tick sau (vẫn "chưa biết" trong D1), và chỉ advance cursor khi
    `deferred === 0`.
  - `DEFAULT_RECENT_PAGE_CAP` / `[vars] RECENT_PAGE_CAP` 30 → 12.
  - Hero `resolveCandidate` bỏ qua `syncCanonical` khi D1 đã có đúng hàng
    catalog của `tmdb_id` đó.
- **Thông lượng:** 1–2 trang/tick → 9 phim/tick ≈ 430 phim/ngày, trong khi
  KKPhim cập nhật khoảng 40–50 phim/ngày. Backlog 158 phim tự hết sau
  khoảng 20 tick (~10h).
- **Test:** `test:incremental-sync` thêm ca Workflow (10 trang → sync 8,
  tổng 18 fetch); `test:hero-refresh` thêm ca "chỉ sync candidate chưa có
  trong D1".

### Dead code phát sinh (dọn sau, ngoài scope)

- `MovieRepository.getHashesBySlugs` — sau Phase 2 không còn caller trong
  `src-ssr/` (chỉ còn test cũ). Plan bảo "không sửa", nên giữ nguyên.
- `idx_gm_list` / `idx_cm_list` trùng prefix PK — giữ, dọn ở plan riêng.
- `orchestrator.ts` vẫn export `runIncrementalSync` /
  `runRecommendationResolveTick` cho các route `/__sync/*` thủ công —
  không phải dead code, giữ.
