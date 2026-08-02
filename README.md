<div align="center">

# 🎬 redflare

**[`phim.bluesia.net`](https://phim.bluesia.net)** — web xem phim tiếng Việt, chạy gọn nhẹ 100% trên Cloudflare ☁️

🪶 Vanilla JS SPA · ⚡ Vite · 🧠 Cloudflare Worker (tự build mọi thứ) · 🎞️ hls.js + ArtPlayer

</div>

---

## 📚 Mục lục

1. [🍿 Người xem thấy gì](#-người-xem-thấy-gì)
2. [🧩 Frontend](#-frontend)
3. [🧠 Backend (Worker)](#-backend-worker)
4. [🚀 Lệnh nhanh](#-lệnh-nhanh)
5. [📖 Đọc thêm](#-đọc-thêm)

---

## 🍿 Người xem thấy gì

- 🏠 **Trang chủ** — Hero slider "Phim Hot Trong Tuần" + rails cuộn ngang (phim mới, phim lẻ, phim bộ, hoạt hình, trending)
- 🎥 **Trang chi tiết** — thông tin, diễn viên, trailer, danh sách tập
- ▶️ **Xem phim** — ArtPlayer + hls.js, tự động rớt xuống iframe nhúng nếu server không có link HLS
- 💡 **"Bạn cũng có thể thích"** — gợi ý xếp hạng theo TMDB, khớp phim thật đang có trên site
- 🔎 **Tìm kiếm** — overlay nhanh, nhớ lịch sử tìm gần đây
- 🗂️ **Duyệt** theo danh sách / thể loại / quốc gia, có phân trang
- 📱 **Responsive** mọi thiết bị, giao diện 100% tiếng Việt

## 🧩 Frontend

**Vanilla JS SPA** — không framework, không TypeScript, không tests. Build bằng **Vite**, router tự viết (History API, pattern `:param`).

| Thư mục | Vai trò |
|---|---|
| `src/main.js` | Điểm vào — mount UI chung, khai báo route |
| `src/router.js` | SPA router tự chế, click `<a>` nội bộ tự bắt |
| `src/api/ophim.js` | 🌐 **Module network DUY NHẤT** — mọi fetch đều qua đây, gọi thẳng `/api/*` cùng-origin |
| `src/modules/` | 9 module UI tái sử dụng: `Carousel` · `Footer` · `Grid` · `Header` · `HeroSlider` · `Player` · `PosterCard` · `Recommendation` · `SearchOverlay` · `Skeleton` |
| `src/components/MovieDetail.js` | Trang chi tiết phim |
| `src/styles/` | CSS thuần, đặt tên kiểu BEM |

🖼️ Ảnh luôn nhận về link R2 sẵn dùng — nếu ảnh chưa kịp mirror, `<img>` tự fallback về nguồn gốc TMDB/OPhim, không bao giờ vỡ ảnh.

## 🧠 Backend (Worker)

Một **Cloudflare Worker duy nhất** làm hết mọi việc — gọi thẳng OPhim + TMDB, ráp dữ liệu, ráp ảnh. Không có server nào khác đứng sau.

```
phim.bluesia.net
 ├─ 🖼️ dist/  (static assets, qua env.ASSETS)
 └─ ⚙️ worker/index.js  →  /api/*
     ├─ worker/lib/enrich.js         TMDB làm giàu dữ liệu OPhim (tên/ảnh/rating…)
     ├─ worker/lib/home.js           Build trang chủ theo cron, KHÔNG build lúc request
     ├─ worker/lib/recommendation.js Reverse-index + gợi ý phim, cache 3 mức
     └─ worker/lib/images.js|mirror.js  Map ảnh → R2, mirror nền qua hàng đợi
```

- ⏰ **Trang chủ build sẵn** — cron mỗi giờ chia 6 mảnh chạy song song, ghi 1 key KV. Bấm vào trang chủ chỉ là **đọc**, không ai phải chờ build.
- 🎯 **Gợi ý phim thông minh** — TMDB xếp hạng, khớp lại catalog qua reverse-index D1; cache 3 mức theo *độ đầy đủ* của kết quả (đủ 30 ngày / thiếu 6 giờ tự làm mới / rỗng 1 giờ) — không để một kết quả cụt lủn bị đóng băng cả tháng.
- 🌉 **Ảnh tự mirror vào R2** — mỗi lần build đẩy ảnh mới vào hàng đợi D1, cron rút dần 10 phút/lần, không mirror đồng bộ làm chậm request.
- 🗄️ **3 tầng lưu trữ**, mỗi tầng một việc:

  | Tầng | Dùng cho |
  |---|---|
  | **Cache API** | Tầng nóng cho mọi `/api/*`, không giới hạn ghi/ngày |
  | **KV** | Trang chủ đã build sẵn + cache dữ liệu TMDB đã enrich |
  | **D1** | Reverse-index gợi ý, cache gợi ý, hàng đợi mirror ảnh, bản dự phòng cuối cùng |

- 🛡️ **Không bao giờ trắng trang** — build lỗi vẫn có bản tốt nhất từng lưu để trả về.
- 🚀 **Deploy = `git push`** — Cloudflare Workers Builds tự build + deploy cả Worker lẫn assets, tự gắn lại custom domain mỗi lần.

## 🚀 Lệnh nhanh

```bash
npm ci                 # cài deps (cần Node 26)
npm run dev             # Vite dev server, gọi thẳng Worker production
npm run build            # build dist/
npm start                 # wrangler dev --remote — Worker THẬT, bindings thật
```

## 📖 Đọc thêm

- **[`CLAUDE.md`](CLAUDE.md)** — chi tiết luồng dữ liệu, các tầng cache, quy ước sở hữu field TMDB/OPhim
- **[`MODULES.md`](MODULES.md)** — quy ước đặt tên & di chuyển UI modules

---

<div align="center">

🇻🇳 UI tiếng Việt · 🪶 Không framework · 🧠 Không TS · ⚡ Không CI

**Một Worker. Một domain. Không backend nào khác.**

</div>
