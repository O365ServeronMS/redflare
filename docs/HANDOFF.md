# HANDOFF — redflare, 2026-08-07

Bàn giao cho session mới. Session cũ hết ngân sách context giữa chừng dự án.
**Đọc file này trước tiên, sau đó theo thứ tự ở §2.**

---

## 1. Một câu tóm tắt

Đang khôi phục **giao diện SPA cũ** của redflare (đã bị một cuộc tái kiến trúc SSR làm hỏng
nặng) đặt lên trên **backend D1 mới** (thành quả tốt của cuộc tái kiến trúc đó, giữ nguyên).
Backend đã xong (F1–F4). Còn lại: nạp font, **cutover**, verify bằng mắt, dọn tài liệu.

**Trạng thái production ngay lúc này:** `phim.bluesia.net` vẫn đang phục vụ **giao diện SSR
hỏng** (HTML trần, không phải SPA cũ). `/api/*` mới đã sống song song và đúng contract. Chưa
có gì của giao diện bị đụng tới.

---

## 2. Đọc theo thứ tự này

| # | File | Vì sao |
|---|---|---|
| 1 | `docs/plan-restore-spa-frontend.md` | **Kế hoạch đang thi hành.** §0.4 = 4 quyết định user đã chốt; §2 = 7 chỗ CSP sẽ phá giao diện; §3 = bẫy `run_worker_first`; §5 = chi tiết từng phase |
| 2 | `docs/state-restore-spa-frontend.md` | Tiến độ + nhật ký quyết định từng phase (F1→F4). **Cập nhật file này mỗi khi phase đổi trạng thái** |
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
├── src-ssr/api/*        ✅ /api/* JSON đúng shape SPA cũ cần  (F2+F4, XONG)
├── src-ssr/render/*     ❌ SSR HTML tự chế — CHÍNH LÀ THỨ LÀM HỎNG GIAO DIỆN, xoá ở F6
├── src-ssr/routes/*     ❌ route SSR page — xoá ở F6 (trừ sitemap.ts, sync.ts)
├── src-ssr/services/sync/*  ✅ cron sync/backfill/resolve — giữ nguyên, đang chạy tốt
├── src-ssr/repositories/*   ✅ giữ
└── src/ + public/       🎯 SPA cũ — ĐÍCH ĐẾN, chưa được phục vụ (F6 mới bật lên)
```

**Không còn:** KV, R2, worker cũ (`worker/`), VPS. Chỉ còn **D1**.

**Cron `*/30`** chạy 3 việc trong 1 invocation: incremental sync → recommendation resolve →
backfill tick. Đang ở `BACKFILL_MODE=free` (governed, chậm).

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

## 5. Còn lại: F5 → F8

### F5 — Self-host Inter (nhỏ, không rủi ro)
`npm i @fontsource/inter` → import 4 weight (latin + vietnamese) trong `src/main.js` → xoá 3 thẻ
Google Fonts khỏi `index.html`.

**✅ Rủi ro đã được loại bỏ trong session này:** lo ngại "Inter không có trong font stack" là
**sai** — `global.css:53` và `components.css:1387,1812` đã khai báo `font-family: 'Inter'` trực
tiếp. `--font-netflix-sans` (`variables.css:15`) là **dead token, không dùng ở đâu**. Nên
self-host chạy ngay, **không cần sửa CSS, không cần hỏi user**.

### F6 — CUTOVER (điểm không quay lại)
Chi tiết đầy đủ ở plan §5. Ba thứ dễ chết nhất:

1. **`run_worker_first` bắt buộc** — thiếu là SPA fallback nuốt sạch `/api/*`, sitemap,
   `/__sync/*`. Xem plan §3.
2. **CSP phải nới đúng 5 chỗ** (`style-src 'unsafe-inline'` cho ArtPlayer + khối FOUC,
   `worker-src blob:`, `connect-src https:`, `media-src blob:`, `frame-src player.phimapi.com`).
   Thiếu 1 chỗ = player chết hoặc chớp trắng.
3. **Xoá `render/seo.ts` làm gãy `routes/sitemap.ts`** — trích `SITE_ORIGIN` ra `lib/` trước.

### F7 — Verify bằng mắt (**ràng buộc cứng của user**)
Build local → chụp 5 màn (trang chủ, detail, player đang phát, search overlay, grid phân trang)
× desktop + mobile → **gửi user duyệt**. Chưa được user gật thì **chưa xong**.
DevTools Console phải **0 lỗi CSP**.

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

> "Đã đọc handoff. Đang ở F5/8 (self-host font), backend đã xong, production vẫn đang hiển thị
> giao diện SSR hỏng cho tới khi cutover ở F6. Tiếp tục F5 chứ?"
