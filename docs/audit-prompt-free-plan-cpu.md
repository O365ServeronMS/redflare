# Audit prompt: redflare cron jobs có vượt giới hạn CPU 10ms (Free plan) không?

> Dùng prompt này để chạy một audit độc lập (agent mới, hoặc phiên Claude Code mới) —
> không phụ thuộc ngữ cảnh hội thoại đã tạo ra nó. Copy toàn bộ phần dưới `---` làm
> prompt.

---

Bạn đang audit worker `redflare` (`phim.bluesia.net`, repo tại thư mục hiện tại) để
xác minh — bằng bằng chứng thật, không suy đoán — liệu các cron job hiện tại có vượt
giới hạn Cloudflare Workers **Free plan** hay không, trước khi hạ tài khoản từ Paid
xuống Free.

## Bối cảnh bắt buộc phải biết trước khi đọc code

`CLAUDE.md` ở root repo mô tả kiến trúc **cũ** (`worker/index.js` + `worker/lib/*`,
KV + R2 + Cache API). Kiến trúc đó **không còn tồn tại** — thư mục `worker/` đã bị xoá.
Backend thật hiện nay là `src-ssr/` (Hono + TypeScript, D1-only, không R2, không KV cho
catalog). Đừng tin `CLAUDE.md` cho phần backend/cron — đọc code trong `src-ssr/` làm
nguồn sự thật. Tham khảo `docs/adr/0002-no-vps-ssr-architecture.md` để hiểu lý do kiến
trúc đổi.

Entry point cron: `src-ssr/index.ts` — hàm `scheduled()` chạy **5 job tuần tự trong
một invocation duy nhất**, kích hoạt bởi một Cron Trigger duy nhất
(`wrangler.toml` `[triggers] crons = ["*/15 * * * *"]`):

1. `runIncrementalSync` — `src-ssr/services/sync/orchestrator.ts`
2. `refreshHeroSnapshot` — `src-ssr/services/sync/heroSnapshot.ts`
3. `runRecommendationResolveTick` — `orchestrator.ts`
4. `runRecommendationRefreshTick` — `src-ssr/services/sync/recommendationRefresh.ts`
5. `runBackfillTick` — `orchestrator.ts`

`wrangler.toml` `[vars] BACKFILL_MODE = "burst"` — tài khoản hiện đang chạy ở chế độ
Paid (bỏ qua D1 row-write governor). Backfill toàn catalog đã hoàn tất.

## Giới hạn Free plan cần đối chiếu (xác nhận qua Cloudflare docs, không phải trí nhớ)

Trước khi audit, tự search lại (`search_cloudflare_documentation` nếu có, hoặc
`developers.cloudflare.com/workers/platform/limits/`) để chắc các con số dưới đây vẫn
đúng tại thời điểm audit — chúng có thể đã đổi:

| Giới hạn | Free | Paid |
|---|---|---|
| CPU time / invocation (cron **và** HTTP) | **10ms** | 30s (mặc định), tới 5 phút nếu set `cpu_ms` |
| Subrequests / invocation | **50 external** + 1.000 tới Cloudflare services (D1/KV/service binding) | 10.000 |
| Kết nối đồng thời / invocation | 6 | 6 (không đổi) |
| Wall time / Cron Trigger | 15 phút | 15 phút (không đổi) |
| CPU time không tính thời gian chờ I/O | fetch(), D1 query, KV — chờ mạng không tính vào CPU time, chỉ JS thực thi mới tính | (như nhau) |

## Việc cần làm

### Phần 1 — Audit tĩnh (đọc code)

Với **từng job** trong 5 job trên, xác định và ghi lại:

- Số **external subrequest** (fetch ra `phimapi.com` KKphim hoặc TMDB) phát sinh
  **trực tiếp trong invocation top-level** — tức là *không* qua `env.SELF.fetch(...)`
  fan-out, vì mỗi lần gọi qua service binding SELF là một invocation Worker MỚI với
  ngân sách CPU/subrequest riêng, KHÔNG cộng dồn vào invocation gốc.
- Số D1 query (gọi qua các class trong `src-ssr/repositories/*`) phát sinh trực tiếp.
- Bất kỳ vòng lặp nào chạy CPU-bound: JSON.parse/stringify payload lớn, string
  processing (`src-ssr/services/sync/normalize.ts`, `src-ssr/lib/slugify.ts`,
  `src-ssr/lib/vietnamese.ts`), hash (`src-ssr/services/sync/hash.ts` — FNV-1a, nên rẻ
  nhưng verify), `cache.purge()` theo batch.

Các điểm nghi vấn cụ thể — verify đúng/sai bằng cách đọc code, đừng tin số liệu này mù
quáng (được ghi lại từ một audit sơ bộ, có thể đã lỗi thời tại thời điểm bạn đọc):

- `runIncrementalSync`: vòng `for (page = 1; page <= RECENT_PAGE_LIMIT; page++)` gọi
  `clients.kkphim.getRecentPage(page)` tuần tự — kiểm tra giá trị `RECENT_PAGE_LIMIT`
  hiện tại trong `orchestrator.ts`; nếu > 1, đây là nhiều external fetch tuần tự ngay
  trong invocation gốc, trước khi fan-out qua SELF.
- `refreshHeroSnapshot`: khi KHÔNG bị chặn bởi `HERO_REFRESH_INTERVAL_SECONDS` (cổng
  30 phút), job này gọi 1 TMDB trending + tới ~20 candidate × `kkphim.getMovieByTmdbId`
  (concurrency `HERO_LOOKUP_CONCURRENCY`), và với mỗi candidate match còn gọi
  `syncCanonical` → `syncOneMovie` (thêm nhiều external call/candidate: kkphim detail,
  TMDB detail, TMDB season, TMDB recommendations). Ước tính worst-case số external
  subrequest của riêng job này khi thực sự chạy (không bị skip).
- `runRecommendationResolveTick`: loop tới `RESOLVE_BATCH_SIZE` group chưa resolve,
  mỗi group *có thể* gọi thêm `kkphim.getByTmdbRef` / `syncOneMovie` /
  `tmdb.getDetailResult` tuỳ tier. Ước tính worst-case.
- `runRecommendationRefreshTick`: loop tới `RECOMMENDATION_REFRESH_LIMIT` source, mỗi
  source 1 TMDB call + D1 write + `cache.purge()`.
- `runBackfillTick`: nếu D1 key `backfill:done` **chưa** bằng `'1'`, job này chạy vòng
  lặp trang được ngân sách theo *wall-time* (`BACKFILL_TICK_BUDGET_MS`), gọi
  `runBackfillPage` → `syncSlugBatch` **không** qua SELF fan-out (chạy thẳng trong
  invocation gốc). Xác nhận thực tế `backfill:done` đã là `'1'` chưa bằng cách gọi
  `GET /__sync/status` (route trong `src-ssr/routes/sync.ts`, cần header
  `x-cron-key: <CRON_KEY>`) — field `backfill.done`.

### Phần 2 — Audit động: mô phỏng Free plan AN TOÀN, không đụng production

**Không** deploy `[limits] cpu_ms = 10` lên production (`git push origin main`) để
test — không cần thiết và rủi ro. Thay vào đó dùng `wrangler dev --remote` (script có
sẵn: `npm start`) — chạy local nhưng dùng binding D1 thật, không publish gì lên
production:

1. Sửa **tạm, không commit** `wrangler.toml`: thêm

   ```toml
   [limits]
   cpu_ms = 10
   subrequests = 50
   ```

2. Chạy `npm start`.
3. Gọi từng route thủ công (cần header `x-cron-key`, giá trị lấy từ secret `CRON_KEY`
   — xem `src-ssr/middleware/cronKey.ts` để biết cách nó được kiểm tra):
   - `GET /__sync/run` — incremental sync riêng lẻ
   - `POST /__sync/refresh-hero?force=true` — ép hero chạy thật, không bị skip bởi
     cổng 30 phút
   - `GET /__sync/resolve-recommendations`
   - Không có route thủ công riêng cho recommendation-refresh-tick hay backfill-tick —
     dùng `curl "http://localhost:8787/cdn-cgi/handler/scheduled?format=json"` để chạy
     **toàn bộ** `scheduled()` y hệt cron thật (cả 5 job tuần tự) — đây là test quan
     trọng nhất vì nó mô phỏng đúng invocation thật sẽ chạy trên Free plan.
4. Đọc output của `wrangler dev` — lỗi CPU/subrequest hiện trực tiếp trong terminal
   (`Worker exceeded resource limits`, outcome `exceededCpu`, hoặc lỗi
   `Too many subrequests`). Ghi lại: job nào fail, ở bước nào, số liệu ước tính tại
   thời điểm fail nếu log có.
5. Test cả hai chiều: (a) từng job riêng lẻ qua route thủ công, (b) cả 5 job chạy
   chung qua `/cdn-cgi/handler/scheduled`. Giả thuyết cần kiểm chứng: từng job có thể
   riêng lẻ lọt qua ngưỡng, nhưng cộng dồn cả 5 trong một invocation thì vượt — hoặc
   ngược lại, một job đơn lẻ (nhiều khả năng là `refreshHeroSnapshot` khi không bị
   skip, hoặc `runBackfillTick` nếu `backfill:done` chưa thật sự `'1'`) đã tự vượt
   ngưỡng một mình.
6. Gọi `GET /__sync/status` trước và sau để đối chiếu `rowsWrittenToday`,
   `backfill.done`, `quota.estimatedPercentUsed`.
7. Chạy lại 3-5 lần ở các thời điểm khác nhau (số lượng slug mới/thay đổi trên
   KKphim biến động theo giờ) — một lần pass không đủ kết luận "luôn pass".

### Phần 3 — Báo cáo kết quả

Trả về một bảng:

| Job | External subrequests (ước tính, worst-case quan sát được) | CPU: pass/fail ở cpu_ms=10 | D1 rows written | Ghi chú |
|---|---|---|---|---|

Kết luận rõ ràng: pass toàn bộ hay fail — nếu fail, chỉ đúng job nào và bước code nào
gây ra (trích dẫn file:line), kèm bằng chứng cụ thể (log `wrangler dev`, số liệu
`/__sync/status`) — không suy đoán, không làm tròn "chắc là ổn".
