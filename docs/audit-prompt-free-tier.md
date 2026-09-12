# Audit prompt: thành phần nào của redflare đang vượt Cloudflare Free tier?

> Prompt cho một audit độc lập (agent mới / phiên Claude Code mới, khuyến nghị
> **Opus, reasoning effort high**) — không dựa vào ngữ cảnh hội thoại đã tạo ra nó.
> Copy toàn bộ phần dưới `---` làm prompt.
>
> Khác với `docs/audit-prompt-free-plan-cpu.md` (chỉ soi CPU 10ms của cron cũ,
> viết khi kiến trúc còn chạy 5 job trong một `scheduled()`), prompt này soi
> **toàn bộ bề mặt Cloudflare** của dự án ở kiến trúc hiện tại (Workflows +
> cron dispatcher).

---

Bạn đang audit dự án `redflare` (`film.bluesia.net`, repo ở thư mục hiện tại).
Mục tiêu **duy nhất**: xác định — bằng bằng chứng thật, không suy đoán — **thành
phần nào của dự án đang chạy vượt (hoặc sắp vượt) giới hạn Cloudflare Free
plan**, và thành phần nào còn dư địa bao nhiêu.

Tài khoản hiện **đang ở Free** (Workers Paid đã hết hạn từ 2026-09-07). Đây là
audit **chỉ đọc**: không deploy, không sửa code production, không chạy migration.

## Bối cảnh: nguồn sự thật và những thứ KHÔNG được tin

- Kiến trúc thật: `README.md` → code trong `src-ssr/` + `wrangler.toml` →
  `docs/adr/0002-no-vps-ssr-architecture.md`. Khi mâu thuẫn, **code thắng tài liệu**.
- **Không còn** VPS, KV, R2, mirror ảnh, SSR page renderer. Chỉ còn **D1**
  (`redflare-db`) + Static Assets + Worker. Bất cứ chỗ nào trong doc/commit cũ
  nhắc KV/R2/`worker/` đều là lịch sử — đừng tính chúng vào audit.
- `docs/audit-prompt-free-plan-cpu.md` mô tả cron cũ (5 job tuần tự trong một
  `scheduled()`), **đã bị thay** bởi Workflows. Dùng nó làm tham khảo phương
  pháp, không làm mô tả hiện trạng.
- Ảnh được hotlink từ `image.tmdb.org` / `phimimg.com` — **không** đi qua
  Cloudflare Images/R2, nên không tính vào bất kỳ quota nào của tài khoản.

Bề mặt hiện tại, tóm tắt để bạn bắt đầu (vẫn phải tự verify bằng code):

- **Worker** `src-ssr/index.ts` (Hono): `/api/*`, `/sitemap*`, `/robots.txt`,
  `/__sync/*`, cộng các route document đi qua Worker theo `[assets]
  run_worker_first` trong `wrangler.toml`.
- **Static Assets** phục vụ SPA trong `dist/` (`not_found_handling =
  "single-page-application"`).
- **Workers Caching** bật ở `wrangler.toml` `[cache]`, chính sách ở
  `src-ssr/cache/control.ts`.
- **1 Cron Trigger** `*/30 * * * *` → `scheduled()` chỉ gọi
  `dispatchScheduledWorkflows` (`src-ssr/services/sync/dispatch.ts`).
- **5 Workflows** (`src-ssr/workflows/*.ts`): incremental-sync (mỗi tick),
  hero-snapshot (đầu giờ), recommendation-resolve (mỗi tick),
  recommendation-refresh (đầu giờ), backfill (tắt qua `BACKFILL_ENABLED`).
  Hai job recommendation vừa được bật 2026-09-12
  (`RECOMMENDATION_JOBS_ENABLED = "true"`) — xem
  `docs/state-recommendation-d1-reads.md`.
- **D1** là store duy nhất; schema ở `migrations/0005_ssr_schema.sql` trở đi.
- **Turnstile** dùng ở `/api/search` (`src-ssr/api/routes.ts`).

## Bước 0 — Lấy số giới hạn từ tài liệu, không từ trí nhớ

**Bắt buộc.** Trước khi kết luận bất cứ điều gì, tra lại từng giới hạn dưới đây
trên `developers.cloudflare.com` (dùng `search_cloudflare_documentation` nếu có,
nếu không thì WebFetch các trang `/workers/platform/limits/`,
`/workflows/reference/limits/`, `/d1/platform/limits/`,
`/workers/static-assets/`, `/workers/observability/logs/`,
`/workers/cache/`). Ghi lại **ngày bạn tra và giá trị đọc được**; nếu khác bảng
dưới thì lấy giá trị mới và nói rõ đã đổi.

Bảng khởi điểm (có thể đã lỗi thời — verify):

| Bề mặt | Giới hạn Free (cần verify) |
|---|---|
| Worker requests | 100.000 request/ngày, 1.000 request/phút |
| Worker CPU | 10 ms/invocation |
| Subrequests | 50 external/invocation (+ ~1.000 tới dịch vụ Cloudflare) |
| Kết nối đồng thời | 6/invocation |
| Cron Triggers | 5 cron/script |
| Workflows | 50 external subrequest **cho cả instance** (không phải mỗi step), giới hạn số instance/ngày và concurrency riêng — tra kỹ |
| D1 | 5.000.000 rows read/ngày, 100.000 rows written/ngày, 5 GB storage, 100 bound params/query |
| Static Assets | request tới asset tĩnh không tính vào quota Worker (verify) |
| Workers Logs | có trần events/ngày trên Free |
| Cache purge | có rate limit (~5 req/phút trên Free) |
| Turnstile | quota verify/tháng |

Hai cạm bẫy đã cắn dự án này rồi, đừng đọc nhầm lần nữa:

1. **Workflows: 50 external subrequest là ngân sách của cả INSTANCE**, không
   phải mỗi `step.do()`. Hiểu sai điều này gây sự cố 2026-09-11
   (`docs/state-incremental-sync-stall.md` §5.2b).
2. **`schedules` của Workflows ngừng chạy trên Free.** Đó là lý do có
   `[triggers] crons` + dispatcher. Nếu bạn thấy chỗ nào đề xuất quay lại
   `schedules`, đó là lỗi.

## Phần 1 — Audit tĩnh: lập bảng chi phí cho từng bề mặt

Với **mỗi** hạng mục dưới, đọc code và ước lượng mức tiêu thụ/ngày ở trạng thái
ổn định, kèm `file:line` cho mọi con số:

### 1.1 Worker requests/ngày

- Route nào **bắt buộc** đi qua Worker (`run_worker_first` trong
  `wrangler.toml`) và route nào được Static Assets phục vụ thẳng?
- Một lượt xem trang điển hình (home → chi tiết phim → xem tập) tạo bao nhiêu
  request **tới Worker** (đếm `/api/*` trong `src/api/ophim.js` + các document
  route)? Nhân với lưu lượng thật (xem Phần 2) để so với 100k/ngày.
- Cache HIT có tính là Worker invocation không? Kiểm tra chính xác hành vi của
  Workers Caching (`[cache] enabled`) — trả lời bằng trích dẫn docs, vì đây là
  yếu tố quyết định đầu số này.

### 1.2 Worker CPU 10 ms

- Route `/api/*` nào nặng CPU nhất? Nghi vấn: dựng JSON lớn
  (`src-ssr/api/homeData.ts`), normalize/slugify tiếng Việt
  (`src-ssr/lib/vietnamese.ts`, `slugify.ts`), sitemap
  (`src-ssr/render/sitemap.ts`), FTS search (`migrations/0007_fts_search.sql`,
  `src-ssr/repositories/searchRepository.ts`).
- Nhớ: thời gian chờ I/O (fetch, D1) **không** tính vào CPU time.

### 1.3 Workflows: subrequest, step, instance

Với từng Workflow trong `src-ssr/workflows/`:

- Số **external fetch worst-case cho cả một instance** (KKPhim + TMDB), đối
  chiếu trần 50. Chú ý `syncBudgetForPages` trong
  `src-ssr/services/sync/orchestrator.ts` — verify công thức còn đúng với số
  fetch thực tế mỗi phim.
- Số **instance/ngày** do dispatcher tạo (`dispatch.ts`): incremental 48,
  hero 24, rec-resolve 48, rec-refresh 24, backfill 0 — verify lại từ code và
  so với trần instance/ngày của Free.
- Số step, thời gian chạy, retry policy — có vượt giới hạn nào của Workflows không?

### 1.4 D1 rows read/ngày (đây là chỗ dễ vỡ nhất)

- Liệt kê mọi truy vấn trong `src-ssr/repositories/*` và `src-ssr/services/*`,
  ước lượng rows read mỗi lần gọi (dựa trên index có thật trong `migrations/`
  — tìm full scan, `COUNT(*)` toàn bảng, `LIKE '%...%'`, `ORDER BY` không có
  index phù hợp).
- Tách riêng **read do request người dùng** và **read do Workflows**.
- Bối cảnh lịch sử bắt buộc đọc: `docs/plan-recommendation-d1-reads.md`
  (Q3 ~77k rows/tick, Q6 ~33k rows/tick — đã sửa),
  `docs/plan-sync-status-d1-reads.md` (COUNT toàn bảng ở `/__sync/status` và
  sitemap), `docs/plan-incremental-sync-stall.md`.
  Verify các fix này **đã thật sự nằm trong code hiện tại**, đừng tin doc.
- Có bảng nào chỉ có index thiếu/thừa gây đọc dư? (`idx_gm_list` / `idx_cm_list`
  được ghi nhận là trùng prefix PK — xác nhận ảnh hưởng, không sửa.)

### 1.5 D1 rows written/ngày + storage

- Governor `MAX_ROWS_PER_DAY = 85_000` trong `orchestrator.ts` so với trần thật
  100k — margin có đủ không, và nó có chặn **mọi** đường ghi không, hay chỉ
  backfill? (Kiểm tra các đường ghi khác: hero snapshot, recommendation
  refresh/resolve, sync episodes.)
- Ước lượng storage hiện tại so với 5 GB (Phần 2 lấy số thật).

### 1.6 Các bề mặt còn lại

- **Cron Triggers**: đang dùng mấy trên trần 5?
- **Cache purge**: `GET /__sync/purge-cache` và mọi `cache.purge()` còn sót
  trong pipeline — có nguy cơ đụng rate limit purge không?
- **Workers Logs**: `[observability.logs] head_sampling_rate = 1` — ước lượng
  số log event/ngày so với trần Free.
- **Turnstile**: số verify/tháng suy từ lưu lượng `/api/search`.
- **Service binding SELF**: mỗi `env.SELF.fetch` là một Worker invocation MỚI —
  nó có tính vào 100k request/ngày không? Verify bằng docs, đây là câu hỏi quan
  trọng và dễ trả lời sai.
- Bất kỳ binding/sản phẩm nào khác xuất hiện trong `wrangler.toml` mà bảng trên
  chưa nhắc.

## Phần 2 — Bằng chứng thật từ production (chỉ đọc)

Không đoán lưu lượng. Lấy số thật:

1. `GET https://film.bluesia.net/__sync/status` với header `x-cron-key: $CRON_KEY`
   (key lấy từ env hoặc `~/.config/redflare/cron_key`). Ghi lại
   `rowsWrittenToday`, `backfill.done`, `quota.*`, tuổi các job.
   Lưu ý: `estimatedRequestsToday` ở đây là **ước lượng của chính worker**, không
   phải số Cloudflare đếm — nói rõ điều đó trong báo cáo.
2. `GET /api/health/sync` — sync có đang sống không.
3. `bash scripts/rf-status.sh` — tóm tắt sức khoẻ + deployment + instance
   Workflow gần nhất.
4. `npx wrangler d1 info redflare-db --remote` (và `d1 insights` nếu có) — lấy
   **rows read/written thật theo ngày** và **database size**. Đây là số quan
   trọng nhất của toàn bộ audit.
5. `npx wrangler workflows instances list <name>` cho cả 5 Workflow — đếm
   instance thật/ngày, tỉ lệ `errored`/`terminated`.
6. Nếu truy cập được GraphQL Analytics API hoặc dashboard: lấy **Worker
   requests/ngày, CPU time p50/p99, subrequest, error rate** trong 7 ngày gần
   nhất. Nếu không truy cập được, **nói rõ là không có** thay vì ước lượng rồi
   trình bày như số đo.

**Cấm trong bước này:** đừng kích hoạt job sync để "thử" (`scripts/rf-kick.sh`
cần `--force` là có lý do) — mỗi lần chạy tốn D1 read/write thật trên ngân sách
đang audit. Nếu bắt buộc phải chạy, hỏi chủ dự án trước và giải thích chi phí.

## Phần 3 — Mô phỏng an toàn (chỉ khi Phần 1 + 2 chưa kết luận được)

Không deploy `[limits]` lên production. Dùng `npm start`
(`wrangler dev --remote`: binding D1 thật, không publish) với `wrangler.toml`
sửa **tạm, không commit**:

```toml
[limits]
cpu_ms = 10
```

Gọi các route nghi ngờ nặng nhất và đọc lỗi trong terminal
(`exceededCpu`, `Too many subrequests`). Nhớ hoàn nguyên `wrangler.toml`
(`git diff` phải sạch khi kết thúc).

## Phần 4 — Báo cáo

Một bảng duy nhất, sắp theo mức rủi ro giảm dần:

| Thành phần | Giới hạn Free (đã verify, kèm ngày tra) | Mức dùng thật/ước lượng | % ngân sách | Nguồn bằng chứng | Trạng thái |
|---|---|---|---|---|---|

`Trạng thái` chỉ được nhận một trong bốn giá trị: **VƯỢT** / **SÁT TRẦN (>70%)** /
**AN TOÀN** / **KHÔNG ĐO ĐƯỢC**. Không có "chắc là ổn".

Sau bảng:

- Với mỗi mục **VƯỢT** hoặc **SÁT TRẦN**: chỉ đúng đoạn code gây ra
  (`file:line`), và đề xuất hướng sửa rẻ nhất — **chỉ mô tả, không sửa code**
  trong audit này.
- Phân biệt rõ **đã vượt** với **sẽ vượt nếu lưu lượng tăng N lần** (nêu N).
- Nêu rõ những gì **không đo được** và cần quyền/công cụ gì để đo.
- Nếu phát hiện tài liệu trong repo mô tả sai hiện trạng, liệt kê ra (đừng sửa).

Mọi con số phải truy vết được về một trong: trích dẫn docs Cloudflare, output
lệnh thật (kèm lệnh đã chạy), hoặc `file:line`. Con số không có nguồn thì phải
gọi thẳng là ước lượng.
