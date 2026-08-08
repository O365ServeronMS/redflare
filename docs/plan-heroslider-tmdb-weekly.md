# Plan: sửa HeroSlider “Phim Hot Trong Tuần” theo TMDB + KKPhim

**Ngày lập:** 2026-08-08
**Giới hạn:** tối đa 4 phase, mỗi phase phải kết thúc ở một checkpoint chạy được
**Tracking:** [state-heroslider-tmdb-weekly.md](state-heroslider-tmdb-weekly.md)
**Bối cảnh audit:** Hero hiện lấy `popularity DESC` từ toàn catalog D1, có phim bộ, có bản trùng,
không phải giao của top 20 `trending/movie/week` với phim có nguồn phát KKPhim.

---

## 0. Mục tiêu và contract không được diễn giải lại

### 0.1 Kết quả sản phẩm

HeroSlider hiển thị **theo đúng thứ tự TMDB Trending Movies trong tuần**, nhưng chỉ giữ các phim:

1. nằm trong **20 kết quả đầu tiên của trang đầu** `GET /trending/movie/week`;
2. có mapping chính xác trên KKPhim qua `GET /tmdb/movie/{tmdbId}`;
3. là **Phim lẻ** (`tmdb_type='movie'`, KKPhim `type='single'`);
4. có nguồn phát thật (`has_stream=1`, ít nhất một episode/link phát hợp lệ);
5. có backdrop landscape dùng được cho Hero;
6. không trùng `tmdb_id`.

Giữ nguyên thứ tự TMDB. **Không lấy trang 2 và không lấy phim ngoài top 20 để bù slot.** Nếu top 20
chỉ có 7 phim đạt điều kiện thì `heroMovies` có đúng 7 phần tử.

### 0.2 Chu kỳ cập nhật được chọn

Dùng cron hiện có `*/15 * * * *`, nhưng refresh Hero tối đa **mỗi 30 phút**:

- lần thành công gần nhất chưa đủ 30 phút: skip;
- lần trước thất bại: retry ở tick 15 phút kế tiếp;
- không tạo thêm Cron Trigger riêng;
- không gọi TMDB/KKPhim trong request `/api/home-data`.

Lý do: tiết kiệm vận hành và giữ nguyên nguyên tắc upstream chỉ được gọi từ cron/sync. Endpoint TMDB
dùng cửa sổ `week`, còn refresh 30 phút chỉ cập nhật snapshot của cùng cửa sổ đó.

### 0.3 Hành vi khi upstream lỗi

- TMDB fetch lỗi, parse lỗi, hoặc trả payload không hợp lệ → giữ snapshot tốt gần nhất.
- KKPhim trả **not found hợp lệ** cho một TMDB ID → phim đó không thuộc Provider, tiếp tục xử lý.
- Timeout/429/5xx/parse lỗi của KKPhim → coi là lỗi vận hành, **không replace snapshot** vì chưa biết phim
  thật sự không tồn tại hay Provider chỉ đang lỗi.
- Chỉ replace snapshot khi cả 20 candidate đã được phân loại chắc chắn `found` hoặc `not_found`.
- Snapshot hợp lệ được phép rỗng nếu TMDB thành công và cả 20 lookup đều thành công nhưng không có phim
  đạt điều kiện.

### 0.4 Ràng buộc thi công

1. Không sửa `src/styles/*.css`; không redesign HeroSlider.
2. `heroMovies` trong `/api/home-data` vẫn là **mảng trần**, không bọc `{items}`.
3. Runtime API chỉ đọc D1; không thêm fallback gọi upstream trong request người dùng.
4. Không dùng `popularity` làm fallback sau khi cutover snapshot.
5. Không deploy/push trong F1–F2. Hai rollout production A/B ở F3 chỉ được chạy khi user cho phép
   publish; nếu chưa có quyền thì dừng ở `Needs production verification`. Push/commit cuối cùng vẫn
   phải theo đúng yêu cầu publish của user.
6. Mỗi phase phải cập nhật state file trước khi bàn giao.
7. Không chạy nhiều agent code song song trên cùng phase.

### 0.5 Ngoài phạm vi

- Không thay đổi rail “Phim Trending” bên dưới Hero.
- Không thay đổi CSS, bố cục, thời gian auto-rotate hoặc thiết kế rail.
- Không sửa hệ thống recommendation/backfill ngoài điểm nối cron bắt buộc.
- Không mở rộng sang TMDB TV hoặc TMDB Watch Providers; “Provider” ở plan này là KKPhim.

---

## 1. Chiến lược agent và ngân sách token

| Model | Chỉ dùng cho | Không giao |
|---|---|---|
| `sol` | chốt schema/atomicity, review contract và diff rủi ro cao | chạy QA lặp, viết log dài, sửa cơ học |
| `terra-high` | logic TMDB↔KKPhim, phân loại lỗi, concurrency, snapshot atomic | đọc lại toàn bộ lịch sử dự án |
| `terra-medium` | nối cron/API theo thiết kế đã chốt, browser QA, regression | tự đổi contract hoặc schema |
| `terra-low` | typecheck/build/diff-check, cập nhật state, gom evidence | quyết định kiến trúc, xử lý lỗi mơ hồ |

### Luật tiết kiệm token

- Một phase chỉ có **một primary agent**; reviewer chỉ đọc diff và file liên quan.
- Handoff tối đa 1.500 token, ghi vào state thay vì kể lại trong chat.
- Mỗi agent chỉ đọc danh sách “Must read” của phase; không mở toàn bộ `docs/`.
- Nếu chạm trần token của phase: dừng ở checkpoint, cập nhật state, không bắt đầu mục kế tiếp.
- Không để migration đã áp nhưng code chưa hiểu schema. Migration chỉ apply ở Phase 3 sau khi Phase 1–2
  typecheck và test xong.
- Tổng ngân sách mục tiêu: **34k–44k token**, chia nhỏ để phase nào cũng có thể resume độc lập.

| Phase | Primary | Reviewer/checker | Ngân sách mục tiêu | Trần cứng |
|---|---|---|---:|---:|
| F1 | `sol` | `terra-low` | 6k | 8k |
| F2 | `terra-high` | `terra-medium` | 12k | 16k |
| F3 | `terra-medium` | `sol` chỉ review diff | 8k | 10k |
| F4 | `terra-medium` | `terra-low` | 8k | 10k |

---

## 2. Bản đồ 4 phase

| Phase | Mục tiêu | Checkpoint an toàn |
|---|---|---|
| **F1** | Chốt contract, schema snapshot và repository | migration chưa apply; typecheck + test repository contract pass |
| **F2** | Xây refresh pipeline TMDB→KKPhim→D1 | service chạy bằng mock/fixture; chưa nối cron, chưa ảnh hưởng production |
| **F3** | Nối cron, seed snapshot, cut `/api/home-data` sang snapshot | API contract pass với dữ liệu thật; có rollback query rõ ràng |
| **F4** | Browser QA, ops docs, rollout/publish khi được phép | desktop/mobile/Console pass; state đóng; không sửa CSS |

---

## 3. Chi tiết từng phase

## F1 — Contract, schema và repository snapshot

**Primary:** `sol`
**Checker:** `terra-low` chỉ chạy command/checklist
**Token:** mục tiêu 6k, trần 8k

### Must read

- `docs/plan-heroslider-tmdb-weekly.md`
- `docs/state-heroslider-tmdb-weekly.md`
- `src-ssr/api/homeData.ts`
- `src-ssr/repositories/movieRepository.ts`
- `src-ssr/repositories/syncStateRepository.ts`
- `src-ssr/types/movie.ts`
- `migrations/0005_ssr_schema.sql`
- `docs/contract-legacy-api.md` §1

### Việc cần làm

1. Thêm migration kế tiếp, dự kiến `0010_hero_snapshot.sql`:
   - `rank INTEGER PRIMARY KEY CHECK(rank BETWEEN 1 AND 20)`;
   - `tmdb_id INTEGER NOT NULL UNIQUE`;
   - `slug TEXT NOT NULL`;
   - `refreshed_at INTEGER NOT NULL`;
   - index chỉ thêm khi query plan chứng minh cần; tránh ghi D1 thừa.
2. Chốt metadata trong `sync_state`:
   - `hero:last_success_at`;
   - `hero:last_attempt_at`;
   - `hero:last_result` JSON ngắn: `tmdbCount`, `matchedCount`, `notFoundCount`, `failedCount`.
3. Tạo `HeroSnapshotRepository` với API nhỏ:
   - `getRankedMovies()` — join snapshot→movie, `ORDER BY rank`;
   - `replaceSnapshot(rows, metadata)` — delete+insert+state update trong một batch atomic;
   - `getRefreshState()` — phục vụ gate 30 phút và status.
4. Xác minh D1 `batch()` có atomic semantics từ tài liệu chính thức trước khi dùng. Nếu không thể bảo đảm,
   đổi sang cơ chế versioned snapshot (`generation`) và chỉ flip generation sau khi insert đủ.
5. Cập nhật `docs/contract-legacy-api.md` §1 bằng invariant mới, không đổi JSON shape.
6. Viết test tập trung vào:
   - rank được giữ nguyên;
   - không trùng TMDB ID;
   - snapshot rỗng hợp lệ;
   - replace thất bại không để trạng thái nửa cũ/nửa mới.

### Không làm trong F1

- Không gọi TMDB/KKPhim.
- Không nối cron.
- Không đổi `buildHomeData()`.
- Không apply migration remote.

### Verify và exit criteria

- `npm run worker:typecheck` pass.
- Test repository/selection fixture pass.
- `git diff --check` pass.
- Migration được review nhưng **chưa apply**.
- State ghi rõ schema cuối cùng, test command và file đã đổi.

### Handoff F1 → F2

Tối đa 1.500 token: schema đã chốt, method signatures, atomicity decision, test command, known risks. Không
chép lại nội dung plan.

---

## F2 — Refresh pipeline TMDB → KKPhim → snapshot

**Primary:** `terra-high`
**Reviewer:** `terra-medium` đọc diff + chạy fixture
**Token:** mục tiêu 12k, trần 16k

### Must read

- plan + state này
- `src-ssr/services/sync/tmdbClient.ts`
- `src-ssr/services/sync/kkphimClient.ts`
- `src-ssr/services/sync/syncMovie.ts`
- `src-ssr/services/sync/orchestrator.ts`
- repository/type mới từ F1

### Việc cần làm

1. Mở rộng `TmdbClient` bằng method đúng endpoint:
   - `getTrendingMovies('week')`;
   - `language=vi-VN` nếu không làm thay đổi ID/rank;
   - validate `results` và cắt đúng `slice(0, 20)`.
2. Không dùng `null` chung cho mọi lỗi KKPhim. Thêm lookup result có phân loại rõ:
   - `{ kind: 'found', data }`;
   - `{ kind: 'not_found' }` cho 404/response hợp lệ không có movie;
   - `{ kind: 'retryable_error', status? }` cho timeout, 429, 5xx, parse/shape lỗi.
3. Tạo service `refreshHeroSnapshot(env, { force? })`:
   - gate theo `hero:last_success_at` 30 phút, trừ `force=true` ở route ops;
   - dedupe TMDB candidate trước lookup nhưng giữ rank đầu tiên;
   - lookup KKPhim với concurrency nhỏ, tối đa 4–6;
   - chỉ gọi `/tmdb/movie/{id}`, tuyệt đối không TV;
   - lọc `movie.type === 'single'`;
   - xác nhận có episode/link phát trước khi chấp nhận;
   - sync canonical KKPhim slug để D1 có metadata/backdrop mới;
   - đọc lại row và bắt buộc `tier='catalog'`, `tmdb_type='movie'`, `type='single'`, `has_stream=1`;
   - lưu đúng rank TMDB gốc, cho phép rank snapshot có khoảng trống; UI hiện tại tự hiển thị rank liên tục
     1..N theo vị trí array nên không cần sửa frontend hoặc làm sai source rank;
   - một retryable error bất kỳ → không replace snapshot, ghi attempt result và trả `keptLastGood=true`.
4. Bổ sung observability ngắn gọn, không log token hoặc payload dài:
   - `fetched`, `matched`, `notFound`, `filteredType`, `filteredNoStream`, `failed`, `durationMs`.
5. Test/fixture tối thiểu:
   - 20 TMDB → 7 KKPhim single có stream → snapshot đúng 7 và đúng order;
   - candidate TV không thể lọt dù payload sai shape;
   - duplicate TMDB ID chỉ xuất hiện một lần;
   - KKPhim 404 được loại hợp lệ;
   - KKPhim timeout/429/5xx giữ last-good;
   - TMDB fail/invalid payload giữ last-good;
   - hai KKPhim slug cùng TMDB ID chọn canonical từ exact lookup, không tạo hai slide.

### Không làm trong F2

- Không nối `scheduled()`.
- Không đổi API home.
- Không deploy/apply migration remote.

### Verify và exit criteria

- Fixture xác nhận mọi invariant §0.1–0.3.
- `npm run worker:typecheck`, test feature và `git diff --check` pass.
- Reviewer `terra-medium` chỉ ra được đường đi của một ID từ TMDB tới snapshot trong diff.
- State ghi sample summary và mọi lỗi còn mở.

---

## F3 — Cron integration, seed và API cutover

**Primary:** `terra-medium`
**Reviewer:** `sol` chỉ review diff rủi ro cao, tối đa 2k token
**Token:** mục tiêu 8k, trần 10k

### Must read

- plan + state này
- `src-ssr/index.ts`
- `src-ssr/routes/sync.ts`
- `src-ssr/api/homeData.ts`
- `src-ssr/api/routes.ts`
- `wrangler.toml`
- service/repository mới từ F1–F2

### Việc cần làm

1. Nối `refreshHeroSnapshot()` vào `scheduled()`:
   - sau incremental sync;
   - trước recommendation/backfill để Hero có UX priority;
   - success gate 30 phút, failure retry tick sau;
   - cập nhật comment `*/30` cũ cho khớp cron `*/15` thực tế.
2. Thêm route ops gated bằng `CRON_KEY`, dự kiến `POST /__sync/refresh-hero`:
   - `force=true` chỉ ở route này;
   - response trả summary ngắn;
   - `Cache-Control: private, no-store`;
   - không lộ token/upstream body.
3. Khi đã có quyền publish, dùng hai bước rollout để tránh API đọc snapshot chưa seed:
   - **Deploy A:** migration + repository + service + cron/ops route, nhưng home API vẫn dùng query cũ;
   - apply migration remote;
   - force refresh hoặc chờ cron, query D1 xác nhận snapshot hợp lệ;
   - **Deploy B:** đổi `buildHomeData()` sang `getRankedMovies()`.
   Nếu chưa được phép publish: hoàn tất code/dry-run, ghi `Needs production verification` vào state và
   không giả lập rằng snapshot production đã được seed.
4. Khi cutover API:
   - bỏ `getHeroPool(HERO_COUNT)` khỏi home path;
   - giữ nguyên `heroMovies: LegacyItem[]`;
   - không fallback `popularity` nếu snapshot rỗng;
   - cache contract vẫn giữ 60s trừ khi đo đạc chứng minh phải đổi.
5. Bổ sung status ops với `lastSuccess`, `lastAttempt`, `matchedCount`, tuổi snapshot; không biến status
   thành endpoint công khai.
6. Chuẩn bị rollback:
   - rollback code chỉ quay `buildHomeData()` về query cũ;
   - không drop migration/table trong sự cố;
   - ghi commit/deploy version A/B vào state.

### Verify và exit criteria

- Local scheduled simulation hoặc service invocation pass.
- Snapshot production có `1 <= rank <= 20`, `tmdb_id` unique, toàn bộ join row là `single/movie/has_stream=1`.
- Đối chiếu thứ tự snapshot với top 20 TMDB cùng thời điểm.
- `/api/home-data`: `heroMovies` là array, số lượng đúng matched count, không series, không duplicate.
- `npm run build`, `npm run worker:typecheck`, `npx wrangler deploy --dry-run`, `git diff --check` pass.
- Không coi F3 hoàn thành nếu mới deploy A mà chưa cutover B; state phải ghi đúng checkpoint.

---

## F4 — Browser QA, vận hành và đóng dự án

**Primary:** `terra-medium`
**Checker/state:** `terra-low`
**Token:** mục tiêu 8k, trần 10k

### Must read

- plan + state này
- `src/modules/HeroSlider/HeroSlider.js`
- `src/main.js` phần `renderHomePage`
- `src-ssr/api/homeData.ts`
- `docs/HANDOFF.md`
- skill/browser workflow được môi trường cung cấp

### Việc cần làm

1. Không sửa UI nếu data contract đã render đúng. Chỉ sửa frontend khi phát hiện regression trực tiếp do snapshot.
2. Browser QA production:
   - desktop 1440×900;
   - mobile 390×844;
   - ảnh đầu tiên preload và không méo;
   - rail hiển thị đúng N phim, rank liên tục 1..N;
   - chọn rail item, prev/next, auto-rotate, “Xem Phim”, “Chi tiết” hoạt động;
   - không có phim bộ/season badge;
   - không có title/TMDB ID trùng;
   - Console 0 error/warning liên quan feature;
   - không có request TMDB/KKPhim từ browser.
3. API/ops QA:
   - gọi home API hai lần qua cache vẫn cùng snapshot generation;
   - refresh thành công đổi `last_success_at`;
   - mô phỏng upstream fail giữ snapshot cũ ở test/local, không phá production;
   - cron status chứng minh gate 30 phút hoạt động.
4. Cập nhật docs:
   - `docs/HANDOFF.md`: nguồn/rank/filter/failure behavior;
   - README phần cron/home-data nếu mô tả cũ;
   - state: evidence, screenshot paths, deploy version, commit hash.
5. Publish chỉ khi user yêu cầu:
   - fetch trước khi publish;
   - stage đúng file feature;
   - commit rõ nghĩa;
   - push theo workflow user đã chọn;
   - smoke test production sau deploy.

### Exit criteria cuối dự án

- Tất cả invariant §0 pass bằng dữ liệu thật.
- Desktop + mobile screenshots được inspect, Console sạch.
- `src/styles/*.css` không đổi.
- State chuyển `Overall: Complete`, không còn blocker/next step bắt buộc.
- Plan và state đủ để agent mới hiểu hệ thống mà không đọc lại chat/audit.

---

## 4. Definition of Done tổng

Một rollout chỉ được gọi là hoàn tất khi:

```text
TMDB /trending/movie/week page 1, first 20
  -> exact KKPhim /tmdb/movie/:id lookup
  -> movie + single + real stream + backdrop
  -> dedupe by TMDB id, preserve TMDB order
  -> atomic D1 snapshot
  -> /api/home-data.heroMovies[]
  -> existing HeroSlider UI unchanged
```

Và có bằng chứng:

- snapshot age ≤ 30 phút sau tick thành công;
- số slide bằng số match thực tế trong top 20;
- không series, không duplicate, không item thiếu stream;
- upstream fail không làm Hero rỗng hoặc đổi sang danh sách sai;
- build/typecheck/dry-run/browser QA pass.
