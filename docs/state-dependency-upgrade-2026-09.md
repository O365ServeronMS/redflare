# State — Nâng dependency lên latest (2026-09-22)

Theo `docs/plan-dependency-upgrade-2026-09.md`. Plan đã chạy thử một lần trong
worktree `bridge-cse_01Gfwa6iDX4aL6VWa3fX6P2u` rồi revert; đây là lần chạy
thật trong worktree `bridge-cse_01MEpu3NsQyeDnJqpDN78CBm`, đã merge xong
Phase 0–7. Phase 8 (deploy) chưa chạy — cần xác nhận chủ dự án.

## Bảng version trước/sau

| Package | Trước | Sau |
|---|---|---|
| `hono` | 4.13.1 | 4.13.8 |
| `vite` | 8.2.1 | 8.3.0 |
| `wrangler` | 4.120.0 | 4.136.1 |
| `@cloudflare/workers-types` | 5.20260804.1 | **gỡ hẳn** (dependency chết) |
| `hls.js` | 1.6.17 | 1.7.3 |
| `compatibility_date` | 2026-08-01 | 2026-09-21 |

## npm audit

- Trước (Phase 0): **5 vulnerabilities (1 moderate, 4 high)** — hono (3
  advisory: parseBody dot-notation, query-parser sau URL fragment, toSSG
  incomplete fix), nanoid <3.3.18 (qua vite→postcss), sharp <0.35.4 (qua
  wrangler→miniflare).
- Sau Phase 3: **0 vulnerabilities**.

## Quyết định kỹ thuật

- **`convertV4MiniflareOptions()`** dùng để migrate 9 chỗ gọi `new
  Miniflare({...})` trong 8 file test sang shape v5 (`{ workers: [...] }`)
  mà không phải viết tay shape native dài dòng cho từng chỗ. **Nợ kỹ thuật:**
  đây là lớp tương thích chuyển tiếp của miniflare, nhiều khả năng bị gỡ ở
  miniflare 6 — lúc đó phải migrate sang shape native thật.
- **`@cloudflare/workers-types` bị gỡ hẳn**, không nâng version: không nơi
  nào trong repo nạp nó (không có trong `tsconfig.worker.json`
  `compilerOptions.types`, không có `/// <reference>`). Runtime types thật
  đến từ `worker-configuration.d.ts` do `wrangler types` sinh.
- **`esbuild` không phải devDependency khai báo** — các script `test:*` ăn ké
  bản transitive của wrangler được hoist ra `node_modules/.bin`. Nợ kỹ thuật
  có thật, ngoài phạm vi plan này, version không đổi trong lần nâng này
  (vẫn `esbuild@0.28.1`).

## Delta bundle

- `dist/assets/hls.light-*.js`: 331.689 B → 359.301 B (+27,6 KB, +8,3%).
  Dynamic-import khi bấm play, không ảnh hưởng initial load/LCP.
- `dist/assets/index-*.js`: 52.791 B → 52.806 B (không đáng kể, do vite
  8.3.0).
- Tổng `dist/`: 884K → 912K.

## QA Phase 6 (hls.js 1.7.3)

Manual QA thực hiện bởi chủ dự án qua `npm run dev` (agent không có công cụ
điều khiển trình duyệt trong phiên này). Kết quả: **pass đủ 7/7 mục** (play,
xem liên tục ≥2 phút, seek giữa phim → gần 0:00, đổi tập, rời trang khi đang
phát, mobile landscape, console không có `hls fatal error:` lặp lại). Không
ghi tên phim/tập cụ thể đã test.

## Git log Phase 1–6

```
46b8623 chore(deps): hls.js 1.7.3
0e2e58d chore(worker): compatibility_date 2026-09-21
94cfc11 chore(deps): gỡ @cloudflare/workers-types — không được tsconfig nạp
93e5407 chore(deps): wrangler 4.136.1 + migrate test sang miniflare 5 options
064c9f3 chore(deps): vite 8.3.0 — vá advisory nanoid qua postcss
6c64fe2 chore(deps): hono 4.13.8 — vá 3 advisory (query parser, parseBody, toSSG)
```

## Ngoài phạm vi (theo plan, cố ý không làm)

`artplayer`, `@fontsource/inter`, `typescript` đã ở bản latest. `.nvmrc` giữ
nguyên (Node 26 = major hiện hành). Không migrate test sang miniflare 5 API
native. Không khai báo `esbuild` thành devDependency. Không chạy `npm audit
fix`.

## Phase 8 — chưa chạy

Deploy (merge vào `main`, `git push origin main`) cần xác nhận chủ dự án
trước, theo đúng plan và theo quy tắc chung của repo (không tự push/deploy).

## Follow-up 2026-10-17 — trả nợ kỹ thuật

- `wrangler` 4.151.1, `hono` 4.13.13, `vite` 8.3.4, `compatibility_date`
  2026-10-12 (khớp workerd; không có compat flag mới bật mặc định từ
  2026-09-21). `npm audit`: 5 high (undici qua miniflare) → 0.
- `esbuild` 0.28.2 khai báo thành devDependency, pin exact.
- Test bỏ `convertV4MiniflareOptions()`: dùng chung helper
  `tests/miniflareD1.mjs` (`newD1Miniflare()`, shape native miniflare 5).
- 11 script `test:*` bundle-rồi-chạy gom về `scripts/run-bundled-test.mjs`.
