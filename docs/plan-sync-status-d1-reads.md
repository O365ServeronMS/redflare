# Plan — `/__sync/status` không còn quét toàn bảng (~257k rows read/lần → < 1k)

**Người thực hiện:** Sonnet (effort medium). **Người duyệt:** chủ dự án.
**Nhánh:** làm trên worktree hiện tại, commit theo từng phase. **Không** `git push`,
**không** `wrangler deploy`, **không** gọi `/__sync/status` trên production cho tới khi
bản mới đã deploy (mỗi lần gọi bản cũ tốn ~257k rows read). Plan này **không có migration**.

Liên quan: `docs/plan-recommendation-d1-reads.md` (mục "Ngoài phạm vi" trỏ tới đây),
`docs/plan-incremental-sync-stall.md` (ngân sách D1 Free).

---

## 0. Bối cảnh & số liệu (2026-09-11, production)

`GET /__sync/status` (`src-ssr/routes/sync.ts:104`) chạy 11 query song song. 8 query là point
read vào `sync_state`/hero (~1 row mỗi query). **Ba query còn lại quét toàn bảng:**

| Query | Nguồn | Vì sao đắt | Rows read/lần |
|---|---|---|---|
| `countByTier('catalog')` | `movieRepository.ts:366` — `SELECT COUNT(*) FROM movie WHERE tier = ?` | không có index trên `tier` → `SCAN movie` | ~30,8k |
| `countByTier('stub')` | như trên | như trên | ~30,8k |
| `getResolveStats()` | `recommendationRepository.ts:277` — 3 `SUM(CASE …)` trên `recommendation` | không `WHERE` → `SCAN recommendation` | ~195,8k |
| **Tổng** | | | **~257k** |

Người gọi: `scripts/rf-status.sh` (agent `rf-ops`, mỗi lần có `CRON_KEY`), curl tay, smoke test
trong README. **Chỉ 20 lần gọi/ngày ≈ 5,1M rows, tức vượt trần Free 5M/ngày.** Khi vượt trần,
D1 từ chối **mọi** query tới 00:00 UTC, kể cả của site.

### Nguồn rẻ đã có sẵn (không cần thêm bảng/index)

| Trường | Nguồn rẻ | Chi phí | Độ tươi |
|---|---|---|---|
| `catalogMovieCount` | `catalog_stats` (`'tier','catalog'`), đọc qua `CatalogStatsRepository.getTierCount` — `/api/list` đang dùng đúng hàm này (`api/routes.ts:60`) | 1 row (PK) | trễ tối đa ~6h (`catalogStats.refresh()`, `REFRESH_MIN_INTERVAL_SECONDS`) |
| `stubMovieCount` | `sync_state` key `movie:stub_count` (`orchestrator.ts:672`). Đây là counter **chính xác**, do resolver duy trì và cũng dùng để so với `MAX_STUBS` | 1 row (PK) | tức thời |
| `recommendation.pendingUnresolved` | partial index `idx_rec_pending` (migration 0013) | = số dòng pending (nay ~540), chặn trần 10k | tức thời |
| `recommendation.resolved` / `.overflow` | **không có** nguồn rẻ: overflow qua `idx_rec_overflow` = 77,6k rows, resolved cần quét toàn bảng | — | — |

### Quyết định

1. `catalogMovieCount`: đọc từ `catalog_stats`.
2. `stubMovieCount`: đọc `sync_state.movie:stub_count`. Nếu key chưa có thì trả `null`.
   **Không** fallback sang `COUNT`, và route GET **không ghi** gì.
3. `recommendation`: chỉ còn `{ pendingUnresolved, pendingCapped }`. Đếm có trần 10.000, đi qua
   `idx_rec_pending`.
4. **Bỏ** `resolved` và `overflow` khỏi response, xoá `getResolveStats` (không còn ai gọi). Nếu cần
   số này thì chạy tay một lần (lệnh ở Phase 3, ghi rõ cost ~200k rows).
   - *Phương án đã loại:* cache 3 số vào `sync_state` và tính lại mỗi 24h. Cách này vẫn tốn
     ~196k rows/ngày cho một con số không dẫn tới hành động nào. Tín hiệu vận hành thật là
     backlog pending và `stubMovieCount` so với `maxStubs`, cả hai đều đã rẻ.
   - Nếu chủ dự án muốn giữ `overflow`, báo lại trước khi làm Phase 1. **Đừng tự thêm.**
5. `/sitemap.xml` cũng gọi `countByTier('catalog')` (`routes/sitemap.ts:17`). Cùng gốc và cùng
   cách sửa (Phase 2), tốn ~30,8k rows mỗi lần cache miss.

Ngoài phạm vi: `catalogStats.refresh()` (~140k rows, tối đa 1 lần/6h, Q8 của plan sync-stall),
`countByType`, `countByGenre` và `countByCountry` (đã cache). **Không** thêm index, **không**
thêm migration.

---

## Luật chung (áp cho mọi phase)

1. Sau mỗi phase: `npm run worker:typecheck`, test của file đã sửa, cuối cùng `npm test` (full
   gate phải in `OK`). Có thể dùng agent `rf-test`.
2. Mỗi query mới: chạy **EXPLAIN QUERY PLAN trên production** (không tốn rows read) và ghi output
   vào state doc:
   ```
   npx wrangler d1 execute redflare-db --remote --json --command "EXPLAIN QUERY PLAN <sql với literal>"
   ```
   Nếu thấy `SCAN movie` hoặc `SCAN recommendation` **không** kèm `USING INDEX
   idx_rec_pending` (có hay không chữ `COVERING` đều được): dừng và báo lại.
3. **Không** chạy `COUNT(*)`/aggregate trên `movie` hoặc `recommendation` để "kiểm tra số".
4. Giữ style file đang sửa: comment tiếng Anh, giải thích lý do kèm số liệu.
5. Ghi nhật ký vào `docs/state-sync-status-d1-reads.md` (tạo mới, cùng format các
   `docs/state-*.md` khác).

---

## Phase 0 — Kiểm tra tiền đề trên production (rẻ, vài rows)

```bash
npx wrangler d1 execute redflare-db --remote --json --command \
  "SELECT kind, key, count FROM catalog_stats WHERE kind = 'tier' AND key = 'catalog'"
npx wrangler d1 execute redflare-db --remote --json --command \
  "SELECT key, value, updated_at FROM sync_state WHERE key IN ('movie:stub_count', 'catalog_stats:refreshed_at')"
```

Kỳ vọng: có dòng `('tier','catalog', ~29.8k)` và key `movie:stub_count = 1000`. Ghi `meta.rows_read`
và giá trị vào state doc. Nếu **thiếu** `movie:stub_count` thì vẫn làm tiếp: status sẽ trả
`null` tới khi resolver chạy lại. Ghi chú điều này vào state doc.

EXPLAIN cho query pending (mục 1.1) trên prod:

```bash
npx wrangler d1 execute redflare-db --remote --json --command "EXPLAIN QUERY PLAN SELECT COUNT(*) AS n FROM (SELECT 1 FROM recommendation WHERE target_slug IS NULL AND resolve_attempted = 0 LIMIT 10001)"
```

Kỳ vọng (đã thử trên Miniflare D1 với migration 0005/0008/0013):

```
CO-ROUTINE (subquery-1)
SCAN recommendation USING INDEX idx_rec_pending
SCAN (subquery-1)
```

`idx_rec_pending` là partial index, nên chỉ chứa đúng các dòng pending. Nếu plan trên prod khác
(ví dụ `SCAN recommendation` không có index) thì dừng và báo lại.

---

## Phase 1 — `/__sync/status` chỉ đọc nguồn rẻ

### 1.1 `src-ssr/repositories/recommendationRepository.ts`

**Xoá** `getResolveStats()` (dòng 274–292), thay bằng:

```ts
  /** For /__sync/status -- the resolver's pending backlog, read through
   * idx_rec_pending (partial index, migration 0013) so the cost is the
   * number of pending rows, capped at `cap + 1`. Replaces the old
   * getResolveStats(), which scanned the whole table (~196k rows read per
   * status call). The predicate must stay literal (`resolve_attempted = 0`,
   * not a bound `?`): SQLite only uses a partial index when the query's
   * WHERE provably implies the index's WHERE at prepare time. */
  async countPendingCapped(cap: number): Promise<{ count: number; capped: boolean }> {
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT 1 FROM recommendation
           WHERE target_slug IS NULL AND resolve_attempted = 0
           LIMIT ?
         )`
      )
      .bind(cap + 1)
      .first<{ n: number }>();
    const n = row?.n ?? 0;
    return { count: Math.min(n, cap), capped: n > cap };
  }
```

Sau khi sửa, `grep -rn getResolveStats src-ssr tests` phải rỗng.

### 1.2 `src-ssr/services/sync/orchestrator.ts`

Chỉ đổi `const STUB_COUNT_KEY` thành `export const STUB_COUNT_KEY` (dòng 672). **Không** đổi
`getStubCount`: hàm này có fallback `COUNT` kèm ghi, là việc route GET không được làm.

### 1.3 `src-ssr/routes/sync.ts`

- Import `CatalogStatsRepository` (`../repositories/catalogStatsRepository`), và thêm
  `STUB_COUNT_KEY` vào import hiện có từ `../services/sync/orchestrator`.
- Hằng số cạnh `FREE_PLAN_DAILY_REQUEST_LIMIT`: `const STATUS_PENDING_COUNT_CAP = 10_000;`
- Trong `Promise.all`, thay đúng 3 phần tử (giữ nguyên thứ tự và tên biến còn lại):
  - `movieRepo.countByTier('catalog')` → `catalogStats.getTierCount('catalog', () => movieRepo.countCatalog())`
    (`const catalogStats = new CatalogStatsRepository(c.env.DB);`).
  - `movieRepo.countByTier('stub')` → `syncState.get(STUB_COUNT_KEY)` (đổi tên biến thành `stubCountRaw`).
  - `new RecommendationRepository(c.env.DB).getResolveStats()` →
    `new RecommendationRepository(c.env.DB).countPendingCapped(STATUS_PENDING_COUNT_CAP)` (biến `pendingRecommendations`).
- Response:
  - `catalogMovieCount: catalogCount` (giữ nguyên tên)
  - `stubMovieCount: stubCountRaw === null ? null : Number(stubCountRaw)`
  - `recommendation: { pendingUnresolved: pendingRecommendations.count, pendingCapped: pendingRecommendations.capped }`
- Một comment ngắn phía trên `Promise.all` giải thích: status không bao giờ `COUNT` toàn bảng
  (trước đây ~257k rows/lần, 20 lần là hết ngân sách ngày). Catalog count lấy từ
  `catalog_stats` nên có thể trễ ≤6h. Stub count là counter của resolver.
  Trỏ tới `docs/plan-sync-status-d1-reads.md`.

**Thay đổi response** (ghi vào state doc và commit message):

| Trường | Trước | Sau |
|---|---|---|
| `catalogMovieCount` | COUNT live | `catalog_stats` (trễ ≤6h) |
| `stubMovieCount` | COUNT live | counter `movie:stub_count`, `null` nếu chưa có |
| `recommendation` | `{ resolved, pendingUnresolved, overflow }` | `{ pendingUnresolved, pendingCapped }` |

`MovieRepository.countByTier` **giữ nguyên**, vì vẫn còn fallback của `getStubCount` và
`countCatalog` dùng.

### 1.4 Tests — `tests/heroHomeData.test.mjs` (file đã có test status, script `test:hero-home-data`)

- `setup()`: thêm `'0013_query_optimization.sql'` vào danh sách migration, **giữa**
  `0010_hero_snapshot.sql` và `0014_upstream_modified.sql`. Nó tạo `catalog_stats` và
  `idx_rec_pending`, cần có `resolve_attempted` từ 0008 (đã có trong danh sách).
- Test hiện có ('Hero ops routes remain CRON_KEY-gated…') phải xanh mà không sửa assert.
- **Thêm test** `'status reads cached counts and a capped pending backlog, never full-table COUNTs'`:
  - Seed một movie catalog bằng `seedMovie` để một `COUNT` live sẽ ra 1. Sau đó
    `INSERT INTO catalog_stats (kind, key, count) VALUES ('tier', 'catalog', 42)` và
    `INSERT INTO sync_state (key, value, updated_at) VALUES ('movie:stub_count', '7', 0)`.
  - Seed `recommendation`: 2 dòng pending (`target_slug NULL`, `resolve_attempted 0`), 1 dòng
    overflow (`NULL`, `1`), 1 dòng resolved (`target_slug 'x'`). Cột: `slug, target_slug,
    target_tmdb_id, target_type, sort_order, resolve_attempted`.
  - Gọi `/__sync/status` với `x-cron-key` và env như test cũ. Assert:
    - `catalogMovieCount === 42` (chứng minh lấy từ cache, không phải COUNT);
    - `stubMovieCount === 7`;
    - `recommendation` deepEqual `{ pendingUnresolved: 2, pendingCapped: false }`.
- **Thêm test** `'status reports stubMovieCount null without seeding the counter'`:
  - Không seed `movie:stub_count`. Gọi status, rồi assert `stubMovieCount === null` và
    `SELECT value FROM sync_state WHERE key = 'movie:stub_count'` trả `null` (route GET không ghi).
- **Thêm test** `'status caps the pending count at 10,000'`:
  - Seed 10.001 dòng pending bằng một câu duy nhất:
    ```sql
    WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < 10001)
    INSERT INTO recommendation (slug, target_tmdb_id, target_type, sort_order)
    SELECT 'cap-source', i, 'movie', i FROM s
    ```
  - Assert `recommendation` deepEqual `{ pendingUnresolved: 10000, pendingCapped: true }`.

Chạy `npm run test:hero-home-data`, `npm run worker:typecheck`, rồi commit:
`perf(ops): /__sync/status reads cached counts instead of full-table COUNTs`.

---

## Phase 2 — `/sitemap.xml` dùng `catalog_stats`

`src-ssr/routes/sitemap.ts:17`:

```ts
  const movieRepo = new MovieRepository(c.env.DB);
  const total = await new CatalogStatsRepository(c.env.DB).getTierCount('catalog', () => movieRepo.countCatalog());
```

Kèm import `CatalogStatsRepository`. Thêm comment 1–2 dòng: total chỉ dùng để tính số shard
(50k URL/shard), nên trễ ≤6h là vô hại. Trước đây mỗi cache miss tốn ~30,8k rows.

Không cần test mới vì gate đã có build, typecheck và dry-run. Nếu có sẵn test gọi `/sitemap.xml`
thì phải xanh (hiện không có). Commit: `perf(sitemap): shard count from catalog_stats`.

---

## Phase 3 — Tài liệu

- `README.md`, bảng "Ops routes", hàng `GET /__sync/status`, mô tả mới: catalog count (cache
  `catalog_stats`, trễ ≤6h), stub counter, backlog recommendation pending (trần 10k), quota,
  backfill. Không `COUNT` toàn bảng. Ngay dưới bảng thêm một ghi chú kèm lệnh tay khi thật sự
  cần số resolved/overflow. Ghi rõ **tốn ~200k rows read, không chạy thường xuyên**:
  ```bash
  npx wrangler d1 execute redflare-db --remote --command "SELECT SUM(target_slug IS NOT NULL) AS resolved, SUM(target_slug IS NULL AND resolve_attempted = 1) AS overflow FROM recommendation"
  ```
- `src-ssr/repositories/catalogStatsRepository.ts`, comment đầu file: thêm `/__sync/status` và
  `/sitemap.xml` vào danh sách người đọc (1 dòng).
- `docs/state-sync-status-d1-reads.md`: Phase 0 (giá trị, `rows_read`, EXPLAIN), bảng thay đổi
  response, số test, việc còn lại (Phase 4).

Commit: `docs: sync status D1 reads plan state`.

---

## Phase 4 — Deploy & kiểm chứng (**chờ chủ dự án duyệt**)

1. `/rf-deploy`, rồi smoke pass.
2. Sau deploy, gọi status **một lần**:
   `curl -s -H "x-cron-key: $(cat ~/.config/redflare/cron_key)" https://film.bluesia.net/__sync/status`.
   Kỳ vọng `catalogMovieCount` ≈ 29,8k trở lên, `stubMovieCount = 1000`, `maxStubs = 1000`,
   `recommendation.pendingUnresolved` vài trăm, `pendingCapped: false`.
3. Đo chi phí thật từng query mới (mỗi lệnh chỉ vài rows đến ~vài trăm rows), đọc
   `meta.rows_read`:
   ```bash
   npx wrangler d1 execute redflare-db --remote --json --command "SELECT COUNT(*) AS n FROM (SELECT 1 FROM recommendation WHERE target_slug IS NULL AND resolve_attempted = 0 LIMIT 10001)"
   ```
   Kỳ vọng `rows_read` ≈ `pendingUnresolved` (≤ 10.001).
4. Hôm sau: `npx wrangler d1 insights redflare-db --timePeriod=1d --sort-by=reads --limit=15`.
   Kể từ lúc deploy, không còn `SELECT COUNT(*) as n FROM movie WHERE tier = ?` và không còn
   `SUM(CASE WHEN target_slug …)`. Ghi số vào state doc.

**Rollback:** `git revert` các commit Phase 1–2 rồi deploy. Không có migration nên không cần
rollback dữ liệu.

---

## Phối hợp với `plan-recommendation-d1-reads.md`

Phase 1–5 của plan kia đã có trên main (`0089d41..4b45548`). Số dòng trong plan này đã được
cập nhật theo code sau các commit đó. Phase 6 của plan kia (apply `0018`, bật job) là việc riêng
của chủ dự án. **Không** đụng tới `RECOMMENDATION_JOBS_ENABLED` hay migration ở plan này. Nếu số
dòng lệch nữa thì tìm theo tên hàm.
