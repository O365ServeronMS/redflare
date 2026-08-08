# HANDOFF — redflare, 2026-08-07

Bàn giao cho session mới. Session cũ hết ngân sách context giữa chừng dự án.
**Đọc file này trước tiên, sau đó theo thứ tự ở §2.**

---

## 1. Một câu tóm tắt

Đang khôi phục **giao diện SPA cũ** của redflare (đã bị một cuộc tái kiến trúc SSR làm hỏng
nặng) đặt lên trên **backend D1 mới** (thành quả tốt của cuộc tái kiến trúc đó, giữ nguyên).
Backend, self-host font, cutover và visual QA đã xong (F1–F7). Chỉ còn dọn tài liệu F8.

**Trạng thái production ngay lúc này:** `phim.bluesia.net` đang phục vụ **SPA cũ đã khôi phục**
trên backend D1. `/api/*`, sitemap và sync route vẫn đi qua Worker đúng contract. F7 đang chạy ở
version `80ef8e71-f3c1-446e-9a2b-01001a624fad`; không sửa bất kỳ file CSS design nào.

---

## 2. Đọc theo thứ tự này

| # | File | Vì sao |
|---|---|---|
| 1 | `docs/plan-restore-spa-frontend.md` | **Kế hoạch đang thi hành.** §0.4 = 4 quyết định user đã chốt; §2 = 7 chỗ CSP sẽ phá giao diện; §3 = bẫy `run_worker_first`; §5 = chi tiết từng phase |
| 2 | `docs/state-restore-spa-frontend.md` | Tiến độ + nhật ký quyết định từng phase (F1→F7). **Cập nhật file này mỗi khi phase đổi trạng thái** |
| 3 | `docs/contract-legacy-api.md` | Hợp đồng `/api/*` trích `file:line` từ `src/` thật. Mâu thuẫn với bất kỳ tài liệu nào khác → **file này thắng** |
| 4 | `docs/adr/0002-no-vps-ssr-architecture.md` | Vì sao có D1-only runtime, vì sao không KV/R2. Vẫn hiệu lực trừ nguyên tắc "No SPA" (sẽ đảo ở F8) |
| 5 | `docs/state-ssr-rearchitecture.md` | Lịch sử cuộc tái kiến trúc SSR (đã ⏸️ dừng). Đọc khi cần hiểu vì sao code hiện tại như vậy |

⚠️ **`CLAUDE.md`, `README.md`, `MODULES.md` đang LỖI THỜI** — chúng mô tả kiến trúc cũ
(VPS/OPhim/KV/R2/mirror ảnh) đã chết. **Đừng tin phần backend của chúng.** Phần frontend
(Lazy loading, CSS gotchas, Conventions) thì **đúng trở lại** vì SPA cũ đang quay về. F8 sẽ dọn.

---

## 3. Kiến trúc hiện tại (thực tế, không phải theo tài liệu cũ)

```
phim.bluesia.net  (Cloudflare Worker "redflare", 1 binding duy nhất: D1)
├── dist/ Static Assets  ✅ SPA cũ + History API fallback (F6, XONG)
├── src-ssr/api/*        ✅ /api/* JSON đúng shape SPA cần (F2+F4, XONG)
├── src-ssr/routes/      ✅ chỉ còn sitemap.ts + sync.ts
├── src-ssr/render/      ✅ chỉ còn escape.ts + sitemap.ts; SSR page renderer đã xoá
├── src-ssr/services/sync/*  ✅ cron sync/backfill/resolve — giữ nguyên
└── src-ssr/repositories/*   ✅ D1-only runtime
```

**Không còn:** KV, R2, worker cũ (`worker/`), VPS. Chỉ còn **D1**.

**Cron `*/15`** chạy 3 việc trong 1 invocation: incremental sync → recommendation resolve →
backfill tick. Đang ở `BACKFILL_MODE=burst` (Workers Paid, không áp dụng D1 free-write governor).

---

## 4. Số liệu production (đo 2026-08-07, cuối session)

```
movies:         204      (đang tăng, backfill chạy nền)
with_pop:        14      ← popularity mới điền sau F3, cron điền dần
with_actor:      15      ← như trên
fts:            130      ← index tìm kiếm
recs_resolved:  436
episodes:      5629
backfill:       type_index=0 (phim-le), page=2
rows written today: 2741 / 85000 (governor)
```

**Hero pool hiện chỉ ~13 phần tử** vì lọc `popularity IS NOT NULL` — sẽ đầy dần. Không phải bug.

---

## 5. Còn lại: F8

### F5 — Self-host Inter ✅ xong
Đã cài `@fontsource/inter`, import 4 weight (Latin + Vietnamese) trong `src/main.js`, xoá 3 thẻ
Google Fonts khỏi `index.html`. Build tạo đủ 8 `.woff2`; typecheck pass; không sửa CSS.

**✅ Rủi ro đã được loại bỏ trong session này:** lo ngại "Inter không có trong font stack" là
**sai** — `global.css:53` và `components.css:1387,1812` đã khai báo `font-family: 'Inter'` trực
tiếp. `--font-netflix-sans` (`variables.css:15`) là **dead token, không dùng ở đâu**. Nên
self-host chạy ngay, **không cần sửa CSS, không cần hỏi user**.

### F6 — CUTOVER ✅ xong production
Static Assets phục vụ `dist/` với SPA fallback; `run_worker_first` bảo vệ `/api/*`, sitemap và
`/__sync/*`. SSR page routes/renderers đã xoá, `SITE_ORIGIN` đã tách sang `lib/site.ts`, CSP đã đồng
bộ cho cả Static Assets và Worker response. Build, typecheck, dry-run, local route test và production
smoke test đều pass. Lần request đầu từng gặp HTML SSR cũ trong cache; cache đã revalidate và URL
chính hiện trả SPA mới.

### F7 — Verify bằng mắt ✅ xong
Đã chụp production đủ 5 màn (trang chủ, detail, player đang phát, search overlay, grid phân trang)
× desktop + mobile và đã chạy checklist tương tác. Chức năng chính pass: hero/carousel/card,
ArtPlayer m3u8, search có dấu/không dấu + history, recommendation, `?page=2`, deep-link reload.

User đã xác nhận đúng frontend Netflix premium. Hai CSP error do Cloudflare inject đã được xử lý
không cần `unsafe-inline`: browser document routes đi qua Worker, fetch SPA shell từ `ASSETS` và trả
`Cache-Control: ... no-transform`; static JS/CSS/font/ảnh vẫn bypass Worker. Production version
`80ef8e71-f3c1-446e-9a2b-01001a624fad`; Playwright home + deep-link đều `0 errors, 0 warnings`.
API 200/404 contract và immutable hashed assets vẫn pass smoke test.

Site cũ không còn chạy ở đâu để so sánh trực tiếp — ảnh chụp là bằng chứng duy nhất.

### F8 — Dọn tài liệu
ADR-0002 amendment, viết lại phần backend của README/CLAUDE.md, MODULES.md Axis C.

---

## 6. Vận hành — những thứ chỉ có trong session cũ

### ⚠️ Deploy KHÔNG tự động
**Git integration GitHub → Cloudflare đã đứt** (phát hiện 2026-08-07, chưa nối lại).
`git push` **KHÔNG** làm production đổi. Phải:

```bash
npx wrangler deploy
```

Đã mất ~15 phút debug vì tưởng deploy chậm. Nếu user nối lại được integration thì quay về
`git push` như `README.md` mô tả.

### CRON_KEY
Đã bị rotate trong session cũ để test route `/__sync/*`. **Giá trị không ghi vào tài liệu**
(secret). Nếu cần gọi tay `/__sync/*`:

```bash
TS=$(date +%s); echo "dev-verify-$TS" | npx wrangler secret put CRON_KEY
# rồi RESTART wrangler dev (nó KHÔNG tự nhận secret mới), dùng key "dev-verify-$TS"
```

Cron tự động **không cần** key — nó gọi hàm trực tiếp, không qua HTTP.

### `wrangler dev --remote` — các bẫy đã gặp
- **Tự hot-reload** khi file đổi → server tắt/bật, port gián đoạn vài giây. Chờ bằng
  `until curl -sS -o /dev/null http://localhost:PORT/; do sleep 2; done` chứ đừng grep log.
- **Không nhận secret mới** cho tới khi restart.
- **`/cdn-cgi/handler/scheduled` không hoạt động** với `--remote` (chỉ local sim) → không
  trigger cron tay được; phải gọi route hoặc đợi cron thật.
- **`pkill wrangler` trả exit code 144** — vô hại, không phải lỗi.
- **`cache.purge()` ném lỗi ĐỒNG BỘ** trong dev preview ("not a function"). Đã sửa bằng
  `try/catch` (F3). Nếu thấy sync báo `errors` mà D1 vẫn có dữ liệu → nghi ngờ loại lỗi này.

### Parse output `wrangler d1 execute`
Output có preamble, không phải JSON thuần. Trích bằng:
```bash
npx wrangler d1 execute redflare-db --remote --command "SELECT ..." 2>&1 | python3 -c "
import json,sys,re
m=re.search(r'\[.*\]',sys.stdin.read(),re.DOTALL)
print(json.loads(m.group(0))[0]['results'])
"
```

### Luôn dùng `--remote`
Không có `--remote`, `wrangler d1/kv/r2` đọc bản mô phỏng local **rỗng** → tưởng mất dữ liệu.

---

## 7. Ràng buộc bất di bất dịch (user đặt ra, vi phạm là làm lại)

1. **KHÔNG sửa `src/styles/*.css`.** 2.485 dòng CSS đó *chính là* giao diện cũ. User chốt:
   "giống hệt 100%, không động vào CSS".
2. **KHÔNG sửa `src/`** ngoài đúng 4 ngoại lệ đã liệt kê ở plan F5/F6 (2 import font,
   preconnect, inline onclick) — không cái nào đụng CSS.
3. **Verify bằng dữ liệu thật**, không phải đọc code. Từ F7: verify **bằng mắt trên ảnh**.
4. Contract-first: mâu thuẫn → code FE thật thắng.

> **Bài học đắt nhất của cả dự án:** mọi phase SSR đều được báo "verified" bằng curl, và giao
> diện vẫn hỏng nặng — vì curl không nhìn thấy thứ người dùng nhìn thấy. Đó là lý do F7 tồn tại.

---

## 8. Lịch sử ngắn (vì sao lại ra nông nỗi này)

1. Dự án gốc: SPA vanilla JS + Worker gọi OPhim/TMDB runtime → **~11,4% response 504**.
2. Tái kiến trúc SSR (ADR-0002): chuyển sang D1-only runtime → **xoá sạch lỗi 504** ✅.
   Nhưng cũng tự viết lại HTML/CSS → **giao diện hỏng nặng** ❌.
3. Giữa chừng: user tự xoá D1 + R2 trên dashboard → production 500 vài phút → đã tạo D1 mới
   (`40c364b3-10a8-4d03-bd51-60debe94610a`) và khôi phục.
4. User quyết định: **giữ backend D1, lấy lại giao diện cũ** → kế hoạch hiện tại.

---

## 9. Câu đầu tiên nên nói với user

> "Đã đọc handoff. F1–F7 đã xong; user đã duyệt frontend và Console CSP sạch trên production.
> Tiếp tục F8 để đồng bộ ADR/README/CLAUDE.md/MODULES.md chứ?"

---

## 10. Backfill mode policy — user chốt 2026-08-08

- `BACKFILL_MODE=free`: áp dụng D1 write governor và giới hạn dung lượng của Workers Free.
- `BACKFILL_MODE=burst`: chỉ dùng khi tài khoản đang ở Workers Paid; bỏ qua D1 daily-write governor.
- Burst không có nghĩa hammer upstream: luôn giữ aggregate limiter KKPhim 25 RPS và TMDB 40 RPS.
- Backfill chạy một invocation nên dùng toàn bộ aggregate allowance (`shardDivisor=1`), không chia 5 như incremental sync.
- Cron burst là `*/15` để tận dụng gần hết cửa sổ 15 phút mà tránh cố ý chạy chồng job.
- `MAX_STUBS=0` trong lúc backfill: ưu tiên catalog KKPhim thật, chưa materialize TMDB-only stubs.
- Khi chuyển lại `free`, đổi `BACKFILL_MODE` và cron về cadence phù hợp rồi redeploy; không cần đổi schema.
- Dù Paid cho phép D1 lớn hơn Free, vẫn phải theo dõi database size và upstream 429/5xx trong observability.

## 11. Season label decision — user chốt 2026-08-08

- **Phase 1 là đủ và đã hoàn tất:** UI đọc `tmdb.season` hiện có và hiển thị `Phần N`.
- **Phase 2 season persistence không triển khai:** không đổi `movie.title`, không thêm suffix vào `original_title`, không re-index FTS chỉ để lưu nhãn season.
- Không chạy re-sync/backfill lại chỉ vì mục tiêu hiển thị season; các season mới vẫn được thêm bình thường khi upstream cung cấp slug mới.
- Chỉ xem xét Phase 2 riêng nếu sau này có yêu cầu mới về search theo `Phần N`, API title chuẩn hóa, hoặc SEO server-side.
