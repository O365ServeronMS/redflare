<div align="center">

# 🎬 redflare

**[`phim.bluesia.net`](https://phim.bluesia.net)** — web xem phim tiếng Việt, nhanh & gọn.

🪶 Vanilla JS SPA · ⚡ Vite · ☁️ Cloudflare (Worker + KV + R2) · 🎞️ hls.js + ArtPlayer

**[Sống ngay cả khi VPS chết.](#kiến-trúc)**

</div>

---

## ✨ Tính năng

- 🏠 **Hero "Phim Hot Trong Tuần"** + rails cuộn ngang
- 🔥 **Trending TMDB** cho tuần/ngày
- 🎥 **Chi tiết phim** — thông tin, tập, gợi ý "Bạn cũng có thể thích"
- ▶️ **Phát HLS** — ArtPlayer tự khôi phục khi lỗi
- 🔎 **Tìm kiếm** + duyệt **thể loại / quốc gia**
- 📱 **Responsive** — all devices

## 🚀 Bắt đầu

```bash
npm ci && npm run dev
```

💡 Cần **Node 26**. `npm run dev` gọi VPS thật (không có backend local).

---

## 🛠️ Lệnh

| | |
|---|---|
| `npm run dev` | Dev server (Vite proxy `/api/*` → VPS) |
| `npm run build` | Build `dist/` |
| `npm start` | **Worker thật** — test KV cache & SPA routing |

---

## 🧩 Kiến trúc

```
  Cloudflare (phim.bluesia.net)
  ├─ static assets (images, JS, CSS)
  ├─ Worker (worker/index.js) → /api/*
  │  └─ KV cache-aside
  │     ├─ miss → fetch VPS img.bluesia.net
  │     ├─ live → cached response (home 30m, detail 60m, rec. 30d…)
  │     └─ stale → fallback khi VPS chết ⚡ (sống ngay!)
  └─ R2 bucket (redflarer2.bluesia.net)
     └─ ảnh TMDB/OPhim, cache 1 năm

  VPS img.bluesia.net (catalog-api, OPhim)
  ├─ route `/api/*`
  ├─ proxy OPhim + TMDB enrich
  ├─ rank hero (TMDB trending)
  └─ mirror ảnh vào R2 (background)
```

**Worker không làm việc nặng** — chỉ cache JSON, không tái build hay gọi TMDB. Nếu VPS chết, tiếp tục trả cache cũ thay vì error. `phim.bluesia.net` **sống độc lập**.

| Thành phần | Dùng cho |
|---|---|
| **Worker** | KV cache `/api/*`, fallback VPS-down |
| **KV** | Cached JSON responses, fallback stale |
| **R2** | Images (TMDB w500/w1280, OPhim originals) |
| **VPS** | OPhim proxy, TMDB enrich, hero rank, image mirror |

---

## 🔧 Debug

**Kiểm tra dữ liệu có lỗi:**

```bash
curl -s -D - https://phim.bluesia.net/api/home-data | grep x-catalog-cache
```

- `kv-live` / `miss` → bình thường ✅
- `stale-vps-down` → VPS chết nhưng vẫn phục vụ cache cũ ✅ (đây là thiết kế!)
- `502` → VPS chết + chưa từng cache → lỗi thật ❌

**Trang trắng sau deploy?** Mở devtools. Thường là script lỗi — kiểm tra Cloudflare Workers Builds log.

---

## 🚀 Deploy

```bash
git push origin main
```

Cloudflare Workers Builds tự chạy `npm run build` & deploy cả **Worker** (`worker/index.js`) lẫn **assets** (`dist/`). 

Mỗi lần deploy tự gắn lại custom domain `phim.bluesia.net` (pin trong `wrangler.toml`).

---

## 📖 Đọc thêm

- **[`CLAUDE.md`](CLAUDE.md)** — Data flow chi tiết, caching layers, RR (resolved risks)
- **[`MODULES.md`](MODULES.md)** — Quy ước đặt tên UI modules

---

<div align="center">

🇻🇳 UI Vietnamese · 🚫 No framework · 🚫 No TS · 🚫 No tests · 🚫 No CI

**Mục tiêu:** Site sống, VPS có thể chết. ⚡

</div>
