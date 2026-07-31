<div align="center">

# 🎬 redflare

**[`phim.bluesia.net`](https://phim.bluesia.net)** — web xem phim tiếng Việt, nhanh & gọn.

🪶 Vanilla JS SPA · ⚡ Vite · ☁️ Cloudflare (static, zero-Worker) · 🎞️ hls.js

</div>

---

## ✨ Tính năng

- 🏠 **Trang chủ** — Hero "Phim Hot Trong Tuần" + các hàng phim cuộn ngang
- 🔥 **Trending** — top phim theo TMDB (tuần → hero, ngày → hàng trending)
- 🎥 **Chi tiết phim** — thông tin, tập phim, gợi ý "Bạn cũng có thể thích"
- ▶️ **Trình phát HLS** — ArtPlayer + `hls.js`, tự khôi phục khi lỗi segment
- 🔎 **Tìm kiếm** + duyệt theo **thể loại / quốc gia / danh sách**
- 📱 **Responsive** — desktop landscape, mobile portrait

## 🚦 Bắt đầu

Cần **Node 26** (đã pin trong [`.nvmrc`](.nvmrc) — Cloudflare build cũng đọc file này).

```bash
npm ci && npm run dev
```

> ⚠️ **Không có backend chạy local.** `npm run dev` gọi thẳng API production
> (`img.bluesia.net/api/*`), nên VPS phải đang sống. Không có `.env` nào cần đặt.

## 🛠️ Lệnh

| Lệnh | Việc | Khi nào dùng |
|---|---|---|
| 🧪 `npm run dev` | Vite dev server `:3000` | Mặc định, gần như luôn dùng cái này |
| 📦 `npm run build` | Build production → `dist/` | Trước khi test bản build |
| 👀 `npm run preview` | Vite serve `dist/` | Xem nhanh bản build |
| ☁️ `npm start` | `wrangler dev` — serve `dist/` qua lớp asset của Cloudflare | Khi cần **kiểm tra SPA fallback** giống production (vào thẳng `/phim/<slug>` rồi F5 phải không 404). Chạy `npm run build` trước |

## 🚀 Deploy

```bash
git push origin main
```

Cloudflare **Workers Builds** tự nhận commit, chạy `npm run build`, publish `dist/`
dưới dạng **static assets** — không có Worker script nào trong repo này
([`wrangler.toml`](wrangler.toml) không có `main`, chỉ có `[assets]`).

- 🔒 Custom domain được **pin trong `wrangler.toml`** (`routes` + `custom_domain = true`)
  để mỗi lần deploy tự gắn lại `phim.bluesia.net` — đừng xoá, mất nó là site sập
  khi Git integration bị ngắt/nối lại.
- ↩️ **Rollback**: revert commit rồi push (hoặc *Rollback* trong Cloudflare dashboard).
- 🚫 Không `wrangler deploy` thủ công — deploy đi qua git để lịch sử khớp với bản live.

## 🧩 Kiến trúc

```
┌─────────────────────┐        ┌──────────────────────────────┐
│  Cloudflare         │        │  VPS  img.bluesia.net        │
│  phim.bluesia.net   │  api/* │  catalog-api (Node)          │
│  static assets only │ ─────► │  proxy OPhim · rank hero     │
│  0 compute/request  │        │  TMDB trending · ký HMAC ảnh │
└─────────────────────┘        │  cache Valkey                │
                               └──────────────────────────────┘
```

```
src/
├── main.js            # 🚪 entry — mount UI, wire router, render từng route
├── router.js          # 🧭 SPA router (History API)
├── api/ophim.js       # 📡 module DUY NHẤT gọi mạng → img.bluesia.net/api/*
├── modules/<Name>/    # 🎨 UI modules (DOM thuần, không virtual DOM)
├── components/        # 🧱 còn lại MovieDetail.js (sẽ chuyển sang pages/)
└── styles/            # 💅 CSS (variables · global · components, BEM-ish)
```

Toàn bộ **CPU work nằm ở VPS**, không phải Cloudflare: `worker.js` và `trending.js`
cũ đã bị xoá khỏi repo khi logic chuyển sang `catalog-api` (commit `81e498a`).

> 📖 Quy ước đặt tên module: [`MODULES.md`](MODULES.md) · Hướng dẫn cho AI agent: [`CLAUDE.md`](CLAUDE.md)

## 📡 API frontend đang gọi

Tất cả cùng một origin `https://img.bluesia.net`, khai báo trong [`src/api/ophim.js`](src/api/ophim.js).

| Endpoint | Dùng cho |
|---|---|
| `GET /api/home-data` | Cả trang chủ trong 1 request (hero + mọi hàng phim) |
| `GET /api/list?type=&page=` | Danh sách: `phim-moi-cap-nhat`, `phim-le`, `phim-bo`, `hoat-hinh`, `tv-shows` |
| `GET /api/genre?slug=&page=` | Theo thể loại |
| `GET /api/country?slug=&page=` | Theo quốc gia |
| `GET /api/movie/:slug` | Chi tiết phim |
| `GET /api/search?keyword=&page=` | Tìm kiếm |
| `GET /api/recommendation/:mediaType/:tmdbId` | "Bạn cũng có thể thích" (`mediaType` = `movie`\|`tv`) |

## 🔧 Vận hành

**Ba tầng cache** — sửa dữ liệu mà không thấy đổi thì soi theo thứ tự này:

| Tầng | Ở đâu | TTL | Xoá kiểu gì |
|---|---|---|---|
| In-page | `src/api/ophim.js` (Map trong RAM) | 5 phút | Hard reload |
| Valkey | VPS | home ~20p (auto-refresh) · list 30p · detail 60p · recommendation 30 ngày | `DEL catalog:c1:home`, restart container, hoặc bump `CACHE_NS` trong `server.js` để xoá sạch |
| Cloudflare | Edge | — | Chỉ cache asset tĩnh, **không** đụng `/api/*` (khác host) |

**Phân định sự cố** — chạy cái này trước khi nghi frontend:

```bash
curl -s -o /dev/null -w "%{http_code} %{time_total}s\n" https://img.bluesia.net/api/home-data
```

- ❌ Lỗi / chậm / dữ liệu cũ → **vấn đề ở VPS**, không có gì trong repo này sửa được.
  Vào `/srv/filmbluesia/catalog-api` trên VPS.
- ✅ Bình thường mà web vẫn hỏng → mới là frontend.

**Trang trắng sau deploy?** Mở console — thường là lỗi chunk cũ; kiểm tra
Workers Builds log xem `npm run build` có pass không.

<div align="center">

🇻🇳 UI tiếng Việt · 🚫 No framework · 🚫 No TypeScript · 🚫 No tests · 🚫 No CI/lint

</div>
