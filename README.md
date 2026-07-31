<div align="center">

# 🎬 redflare

**[`phim.bluesia.net`](https://phim.bluesia.net)** — web xem phim tiếng Việt, nhanh & gọn.

🪶 Vanilla JS SPA · ⚡ Vite · ☁️ Cloudflare (static + thin cache Worker) · 🎞️ hls.js

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

> ⚠️ **Không có backend chạy local.** `npm run dev` gọi `/api/*` cùng-origin,
> Vite proxy thẳng sang API production (`img.bluesia.net/api/*`), nên VPS phải
> đang sống. Không có `.env` nào cần đặt.

## 🛠️ Lệnh

| Lệnh | Việc | Khi nào dùng |
|---|---|---|
| 🧪 `npm run dev` | Vite dev server `:3000` | Mặc định, gần như luôn dùng cái này |
| 📦 `npm run build` | Build production → `dist/` | Trước khi test bản build |
| 👀 `npm run preview` | Vite serve `dist/` | Xem nhanh bản build |
| ☁️ `npm start` | `wrangler dev` — chạy **Worker thật** (`worker/index.js`) local, serve `dist/` qua lớp asset | Khi cần **kiểm tra SPA fallback** giống production (vào thẳng `/phim/<slug>` rồi F5 phải không 404), hoặc test cache KV / fallback khi VPS chết. Chạy `npm run build` trước |

## 🚀 Deploy

```bash
git push origin main
```

Cloudflare **Workers Builds** tự nhận commit, chạy `npm run build`, deploy cả
**static assets** (`dist/`) lẫn **Worker** (`worker/index.js`,
[`wrangler.toml`](wrangler.toml) có `main`). Worker chỉ lo `/api/*` — cache-aside
KV trước VPS `catalog-api`, không tự làm việc nặng nào.

- 🔒 Custom domain được **pin trong `wrangler.toml`** (`routes` + `custom_domain = true`)
  để mỗi lần deploy tự gắn lại `phim.bluesia.net` — đừng xoá, mất nó là site sập
  khi Git integration bị ngắt/nối lại.
- ↩️ **Rollback**: revert commit rồi push (hoặc *Rollback* trong Cloudflare dashboard).
- 🚫 Không `wrangler deploy` thủ công — deploy đi qua git để lịch sử khớp với bản live.

## 🧩 Kiến trúc

```
┌────────────────────────────┐  miss   ┌──────────────────────────────┐
│  Cloudflare                 │  api/* │  VPS  img.bluesia.net        │
│  phim.bluesia.net           │ ─────► │  catalog-api (Node)          │
│  static assets              │        │  proxy OPhim · rank hero     │
│  + Worker: KV cache /api/*  │        │  TMDB trending · mirror ảnh  │
└──────────────┬───────────────┘        │  vào R2 · cache Valkey      │
               │ ảnh                    └──────────────────────────────┘
               ▼
   redflarer2.bluesia.net (R2) — không qua VPS, không qua Worker khi đọc
```

Worker (`worker/index.js`) **không** tự làm việc nặng — chỉ cache JSON của
`catalog-api` trong KV, và nếu VPS chết thì tiếp tục trả bản cache cuối cùng
còn tốt thay vì báo lỗi. Chi tiết cơ chế: [`CLAUDE.md`](CLAUDE.md) mục
"Data flow & caching".

```
src/
├── main.js            # 🚪 entry — mount UI, wire router, render từng route
├── router.js          # 🧭 SPA router (History API)
├── api/ophim.js       # 📡 module DUY NHẤT gọi mạng → /api/* (same-origin)
├── modules/<Name>/    # 🎨 UI modules (DOM thuần, không virtual DOM)
├── components/        # 🧱 còn lại MovieDetail.js (sẽ chuyển sang pages/)
└── styles/            # 💅 CSS (variables · global · components, BEM-ish)

worker/
└── index.js           # ☁️ Worker — KV cache-aside cho /api/*, fallback khi VPS chết
```

CPU work nặng (proxy OPhim, rank hero, TMDB enrich, mirror ảnh) vẫn nằm ở VPS.
`worker.js` và `trending.js` cũ đã bị xoá khỏi repo khi logic đó chuyển sang
`catalog-api` (commit `81e498a`); Worker quay lại sau đó (`worker/index.js`)
chỉ với vai trò cache/fallback, không viết lại logic nào của VPS.

> 📖 Quy ước đặt tên module: [`MODULES.md`](MODULES.md) · Hướng dẫn cho AI agent: [`CLAUDE.md`](CLAUDE.md)

## 📡 API frontend đang gọi

Tất cả cùng-origin `/api/*` trên chính `phim.bluesia.net` (Worker xử lý, xem
kiến trúc ở trên), khai báo trong [`src/api/ophim.js`](src/api/ophim.js).

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

**Bốn tầng cache** — sửa dữ liệu mà không thấy đổi thì soi theo thứ tự này:

| Tầng | Ở đâu | TTL | Xoá kiểu gì |
|---|---|---|---|
| In-page | `src/api/ophim.js` (Map trong RAM) | 5 phút | Hard reload |
| Worker KV | Cloudflare (`CATALOG_KV`) | `live:*` theo TTL từng loại · `stale:*` không hết hạn (fallback khi VPS chết) | Xoá key `live:<path>` trong dashboard KV để ép fetch lại ngay |
| Valkey | VPS | home ~20p (auto-refresh) · list 30p · detail 60p · recommendation 30 ngày | `DEL catalog:c1:home`, restart container, hoặc bump `CACHE_NS` trong `server.js` để xoá sạch (Worker KV `stale:*` chỉ đổi theo ở lần fetch thành công kế tiếp) |
| Cloudflare | Edge | — | Chỉ cache asset tĩnh; `/api/*` do tầng KV ở trên lo, không phải cache edge thường |

**Phân định sự cố** — chạy cái này trước khi nghi frontend:

```bash
curl -s -D - -o /dev/null https://phim.bluesia.net/api/home-data | grep -i x-catalog-cache
```

- `kv-live` / `miss` → bình thường.
- `stale-vps-down` → **VPS đang chết**, Worker đang phục vụ bản cache cuối cùng.
  Không có gì trong repo này sửa được — vào `/srv/filmbluesia/catalog-api` trên VPS.
- `502` → VPS chết **và** chưa từng cache route này — cùng chỗ cần vào kiểm tra.
- Web vẫn hỏng dù `kv-live`/`miss` → mới là frontend.

**Trang trắng sau deploy?** Mở console — thường là lỗi chunk cũ; kiểm tra
Workers Builds log xem `npm run build` có pass không.

<div align="center">

🇻🇳 UI tiếng Việt · 🚫 No framework · 🚫 No TypeScript · 🚫 No tests · 🚫 No CI/lint

</div>
