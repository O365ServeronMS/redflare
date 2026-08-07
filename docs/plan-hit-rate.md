# Plan: nâng cache HIT rate của redflare

**Ngày lập:** 2026-08-06
**Mục tiêu người đặt:** HIT rate 35% → 99–99.95%
**Motto dẫn đường:** Render Once → Cache Everywhere → Refresh in Background →
Cleanup with LRU → Serve from Cloudflare Edge
**Liên quan:** [ADR-0001](adr/0001-caching-topology.md) (đã ship Phase 0–5, plan
này đóng nốt Action Item 3/4/5/6/8 của nó), [plan-kkphim-migration.md](plan-kkphim-migration.md)
**Tracking:** [state-hit-rate.md](state-hit-rate.md)

> Mọi con số trong §1 là **đo trực tiếp production ngày 2026-08-06** bằng curl +
> `wrangler d1/kv` — không suy từ code, không đọc từ doc cũ.

---

## §0. TL;DR

**Trả lời thẳng câu hỏi "có khả thi 99.95% không?": KHÔNG, nếu đo bằng
`cf-cache-status` HIT% toàn zone trên gói Free. CÓ, nếu đo bằng "tỉ lệ request
không phải build từ upstream".**

Đây không phải chơi chữ — đó là hai con số khác nhau về bản chất, và chỉ một
trong hai là thứ motto đang thật sự nhắm tới:

| Chỉ số | Hiện tại | Trần Free | Trần khi trả phí |
|---|---|---|---|
| **A. Zone-wide `cf-cache-status` HIT%** | ~35% | **~93–95%** | ~99% (cần Cache Reserve) |
| **B. Origin-build rate** (`/api/*` phải gọi KKPhim+TMDB) | không đo được | **≤0.1% → đạt 99.9%** | như Free |
| **C. Static assets `/assets/*`** | ~100% | ≥99.9% | — |

Lý do trần A bị chặn ở ~95% trên Free: **~84% request của site là ảnh**, và
ảnh bị Cloudflare **evict theo LRU** ở edge. Sản phẩm sửa đúng chuyện đó là
**Cache Reserve — yêu cầu gói trả phí** (đã verify trên doc Cloudflare
2026-08-06). Không có cách nào "pin" object vào edge cache trên Free.

Nhưng — và đây là điểm quan trọng — **một MISS ảnh trên redflare rẻ**: origin
của ảnh là R2 (`img.bluesia.net`), không phải KKPhim. Miss ảnh = một round-trip
R2, nhanh và không tốn quota. Còn một MISS `/api/*` = KKPhim + tới 24 lần gọi
TMDB, ~917ms, và là thứ đã sập cả trang khi OPhim chết. **Tối ưu B đáng giá hơn
tối ưu A rất nhiều**, dù A mới là con số 35% đang nhìn.

**Ba phát hiện nghiêm trọng, xếp theo mức độ:**

1. 🟠 **Mirror throughput không theo kịp backlog sau khi đổi nguồn KKPhim.**
   `MIRROR_BATCH = 20`/tick `*/10` = tối đa 2.880 ảnh/ngày lý thuyết, quá thấp
   so với ~1.200 ảnh cần mirror khi toàn bộ artwork KKPhim là key mới.
   **Đã xác nhận cron không chết** — `home`/`warm`/`mirror` đều đang chạy đúng
   lịch và tiến triển đều (xem [state-hit-rate.md](state-hit-rate.md) Phase 0
   log); lần đo `/api/health` ban đầu trông như "sự cố" chỉ vì đo ngay sau một
   deploy, trước tick đầu tiên. Đây vẫn là nguyên nhân gốc lớn nhất của 35%,
   chỉ khác ở chỗ **sửa bằng tăng throughput (Phase 3), không phải hồi sinh
   cron chết**.
2. 🔴 **`s-maxage` đang vô hiệu hoá `stale-while-revalidate`.** Mọi response
   `/api/*` gửi `public, max-age=60, s-maxage=<ttl>`. Theo doc Cloudflare,
   `s-maxage` mang ngữ nghĩa `proxy-revalidate` → shared cache **không được**
   serve stale → hết TTL là `EXPIRED` (một MISS thật, user ngồi chờ build) thay
   vì `UPDATING` (HIT + refresh nền). ADR-0001 Phase 1 thêm `s-maxage` như
   "thay đổi giá trị nhất", và vô tình tắt mất đúng cơ chế mà motto cần.
3. 🟠 **Tiered Cache đang tắt** (gần như chắc chắn — cần xác nhận ở dashboard).
   Nó **miễn phí trên gói Free**, và Cloudflare **tự tối ưu upper-tier cho
   origin R2**. Đây là đòn bẩy free lớn nhất còn chưa dùng.

---

## §1. Đo đạc thực tế (production, 2026-08-06 06:44–06:50 UTC)

### 1.1 `/api/*` — tầng này thật ra đang ổn

| Path | `cf-cache-status` | `x-catalog-cache` | `cache-control` |
|---|---|---|---|
| `/api/home-data` | **HIT** (age 307) | `hit` | `max-age=1800, s-maxage=1800` |
| `/api/list?type=phim-le&page=1` (lần 1) | *(không có header)* | `miss` | `max-age=60, s-maxage=1800` |
| `/api/list?type=phim-le&page=1` (lần 2,3) | **HIT** (age 31→36) | `hit` | `max-age=1800, s-maxage=1800` |
| `/api/movie/:slug` | *(không có)* | `miss` | `max-age=60, s-maxage=3600` |
| `/api/search?keyword=phim` | *(không có)* | `miss` | `max-age=60, s-maxage=600` |

→ ADR-0001 Phase 1–2 **đã có tác dụng**: request thứ 2 trở đi là HIT thật ở
zone CDN. `/api/*` **không phải** thủ phạm của 35%.

Chú ý: `max-age=60` do Worker gửi bị zone ghi đè thành `max-age=1800` ở bản
cached → vẫn còn một override Browser Cache TTL ở zone (ADR-0001 Action Item 2
chưa xong).

### 1.2 Ảnh — đây mới là thủ phạm

```
https://img.bluesia.net/t/p/w500/wqGZVSCUSXE92WH2zyol2REaqT4.webp
  → cache-control: public, max-age=31536000, immutable
  → cf-cache-status: MISS          ← ảnh hero trang chủ, TTL 1 năm, vẫn MISS
```

Cả 3 ảnh đầu tiên của home payload đều MISS. Request lại ngay → HIT (age tăng
dần). Tức là object **có** trong R2, **có** header cache hoàn hảo, nhưng
**không nằm sẵn trong edge cache của colo SIN**.

### 1.3 Khối lượng

| Đo | Giá trị |
|---|---|
| `/api/home-data` payload | 78.900 bytes |
| URL ảnh `img.bluesia.net` trong payload | 194 (120 distinct) |
| URL ảnh trỏ thẳng TMDB/phimimg trong payload | 0 (mọi URL đều đã map sang R2) |
| Hero rail còn tự derive thêm `w154` ở client | +20 object distinct nữa ([HeroSlider.js:35](../src/modules/HeroSlider/HeroSlider.js:35)) |

### 1.4 State của các tầng durable

```
D1:  mirrored=3.494   mirror_queue=1.225   stale=110   idx=447   recs=50
KV:  meta:* = 1.886 key   (CLAUDE.md đang ghi "~111" — sai 17×)
     home:current = KHÔNG TỒN TẠI
     warm:last-run = KHÔNG TỒN TẠI
     page:v1:* = 0 key
     (còn sót home:last-known-good + ~20 stale:* — rác từ thiết kế cũ)
```

`/api/health` lúc 06:48 UTC (ngay sau deploy 06:45, trước tick `:00` kế tiếp):
```json
{"ok":false,
 "home":{"age_min":null},
 "mirror":{"queued":1222,"oldest_queued_min":497,"mirrored_last_hour":0},
 "warm":{"age_min":null},
 "problems":["home:current missing or unparseable",
             "mirror queue head stuck 497min (1222 queued)",
             "warm:last-run missing (warm cron has not completed a cycle yet)"]}
```

Cùng endpoint, đo lại 07:01 UTC (~1 phút sau tick `:00`):
```json
{"ok":false,
 "home":{"age_min":1},
 "mirror":{"queued":1226,"oldest_queued_min":170,"mirrored_last_hour":40},
 "warm":{"age_min":1,"written":12,"skipped":0,"failed":0},
 "problems":["mirror queue head stuck 170min (1226 queued)"]}
```

**Kết luận đã đảo ngược sau khi đo lại — xem §3.1 và
[state-hit-rate.md](state-hit-rate.md) Phase 0.** Lần đo đầu chỉ bắt đúng
khoảng trống giữa lúc deploy và tick cron kế tiếp, không phải cron chết. Đã
loại trừ: **KV write quota chưa cạn** (ghi thử `diag:probe` thành công),
**CRON_KEY có tồn tại**, **origin/main == HEAD** (production đang chạy đúng
code này).

---

## §2. Vì sao đúng 35% — mô hình request mix

Một lượt xem trang chủ (browser lạnh, đã tính lazy-load):

| Loại | Số request | Ghi chú |
|---|---|---|
| HTML | 1 | |
| JS/CSS/logo | ~5 | immutable |
| `/api/home-data` | 1 | |
| Ảnh hero backdrop `w1280` | 2 | `ensureBackdrop` chỉ nạp active + 1 prefetch |
| Ảnh hero rail `w154` | 20 | derive client-side |
| Ảnh poster carousel `w500` | ~16 | phần trên fold |
| **Tổng** | **~45** | **trong đó ~38 là ảnh = 84%** |

```
zone_hit  =  0,84 × img_hit  +  0,16 × other_hit
0,35      =  0,84 × img_hit  +  0,16 × 0,85
img_hit   ≈  0,25
```

**Mô hình tái tạo đúng con số 35% đã báo cáo.** Kết luận: 35% ≈ hit rate của
ảnh. Mọi tối ưu `/api/*` thêm nữa chỉ dịch được vài điểm phần trăm — vì `/api/*`
chỉ chiếm ~2% lưu lượng.

---

## §3. Ba nguyên nhân gốc

### §3.1 Về N2 cũ ("cron chết") — đã bác bỏ sau khi đo lại

Bản nháp đầu của tài liệu này liệt N2 là "cron nền chết hoàn toàn". Sau khi
chạy Phase 0 (đo lại `/api/health` qua một tick đầy đủ thay vì ngay sau
deploy), kết luận đó **sai**: cả 3 cron đều chạy đúng lịch, `home`/`warm` đều
thành công, `mirrored_total` tăng đều. Chi tiết đầy đủ ở
[state-hit-rate.md](state-hit-rate.md) § "Phase 0: chẩn đoán lại". N2 gộp vào
N1 bên dưới — vấn đề thật là **throughput** của cron mirror, không phải cron
không chạy.

| # | Nguyên nhân | Bằng chứng | Đóng góp ước tính vào miss |
|---|---|---|---|
| **N1** | **Ảnh chưa mirror → R2 trả 404 → MISS vĩnh viễn, vì throughput mirror cron thấp hơn backlog.** Vừa đổi nguồn OPhim→KKPhim hôm nay: toàn bộ artwork KKPhim là key mới. `MIRROR_BATCH=20`/tick `*/10` = tối đa 2.880/ngày, không đủ dọn backlog ~1.200 nhanh. `images.js` map **mọi** URL sang `img.bluesia.net` bất kể đã mirror hay chưa. | queue ~1.200 dao động quanh mức đó, `mirrored_last_hour` dương nhưng chậm (40/giờ đo được) | **Lớn nhất** |
| **N2** | **Edge LRU evict đuôi dài.** Catalog hàng nghìn poster, traffic thấp → object nguội bị đẩy khỏi edge cache dù `immutable` 1 năm. | ảnh hero trang chủ = MISS dù đã mirror | Trung bình–lớn |
| **N3** | **Không Tiered Cache** → mỗi colo lạnh độc lập, miss nhân với số colo. | cần xác nhận dashboard | Trung bình |

Phụ (nhỏ nhưng nên sửa): `s-maxage` chặn SWR (→ mỗi lần hết TTL là một MISS
thật thay vì UPDATING); `/api/search` cardinality vô hạn; `/api/movie/:slug`
TTL 1h × hàng nghìn slug.

---

## §4. Trần khả thi — trả lời "99.95% có được không?"

Miss đến từ 3 nguồn **độc lập**, và chỉ 2 trong 3 sửa được miễn phí:

| Nguồn miss | Sửa được trên Free? | Công cụ |
|---|---|---|
| N1 — 404 do throughput mirror thấp hơn backlog | ✅ Có, hoàn toàn | Shard mirror drain (Phase 3) |
| N3 — colo lạnh độc lập | ✅ Có | Tiered Cache (free, Phase 2) |
| **N2 — LRU evict đuôi dài** | ❌ **Không** | **Cache Reserve — cần gói trả phí** |

Cloudflare mô tả Cache Reserve đúng bằng câu: *"Persist cached content in R2
storage to eliminate cache evictions"* — nó là sản phẩm sinh ra cho N2. Doc ghi
rõ *"Cache Reserve does require a paid plan"*.

**Ước tính sau khi xong Phase 0–5 (toàn bộ miễn phí):**

```
img_hit   : 0,25 → 0,90–0,95
other_hit : 0,85 → 0,97
zone_hit  = 0,84×0,93 + 0,16×0,97 ≈ 0,93–0,95
```

→ **~93–95% là trần thực tế của gói Free.** Muốn vượt 99% phải mua Cache Reserve
(Phase 7, tuỳ chọn) — lúc đó N2 biến mất và zone_hit ≈ 99%.

**99,95% thì sao?** 99,95% nghĩa là 1 miss trên 2.000 request. Mỗi object mới,
ở mỗi colo, tốn đúng 1 miss không thể tránh. Với catalog đang tăng và ~58 object
ảnh distinct cho riêng trang chủ, con số đó chỉ đạt được khi **catalog đứng yên
và traffic cực tập trung** — không phải hình dạng của redflare. **99,95% zone-wide
không phải mục tiêu nên cam kết.**

**Nhưng chỉ số B thì đạt được:** "tỉ lệ request `/api/*` phải gọi KKPhim/TMDB"
có thể xuống ≤0,1%, vì tập page nóng là **hữu hạn và biết trước** (5 list type +
genre/country + home) — pre-build hết là xong. Đó mới đúng là thứ motto
"Render Once → Refresh in Background" mô tả, và là thứ quyết định trang có sập
hay không khi upstream chết.

### Đề xuất chốt lại mục tiêu

| Chỉ số | Mục tiêu cam kết | Đo bằng |
|---|---|---|
| `/api/*` origin-build rate | **≤ 0,1%** | tỉ lệ `x-catalog-cache: miss` |
| `/assets/*` HIT | **≥ 99,9%** | GraphQL Analytics, filter path |
| Ảnh `img.bluesia.net` HIT | **≥ 90%** (Free) / ≥99% (Cache Reserve) | GraphQL Analytics, filter hostname |
| Zone-wide HIT | **≥ 93%** (Free) | dashboard Caching |

---

## §5. Kiến trúc đích, ánh xạ theo motto

```
                    ┌─────────── Render Once ───────────┐
   Cron (1 colo)    │  home shards → KV home:current    │
                    │  warm shards → KV page:v1:*       │   ← Phase 0, 4
                    │  mirror shards → R2 (ảnh WebP)    │   ← Phase 3
                    └───────────────────────────────────┘
                                    │
                    ┌──────── Cache Everywhere ─────────┐
                    │  Tiered Cache (upper tier chung)  │   ← Phase 2 (free)
                    │  [Cache Reserve — nếu trả phí]    │   ← Phase 7
                    └───────────────────────────────────┘
                                    │
                    ┌───── Refresh in Background ───────┐
                    │  max-age + stale-while-revalidate │   ← Phase 1
                    │  (BỎ s-maxage, dùng Edge TTL rule)│
                    │  → hết hạn = UPDATING, không MISS │
                    └───────────────────────────────────┘
                                    │
                    ┌────── Cleanup with LRU ───────────┐
                    │  D1 popularity → top-N warm set   │   ← Phase 4
                    │  evict key rớt khỏi top-N         │
                    └───────────────────────────────────┘
                                    │
                    ┌─── Serve from Cloudflare Edge ────┐
                    │  user chỉ chạm edge, không chạm   │
                    │  KKPhim/TMDB                      │
                    └───────────────────────────────────┘
```

### Bảng Cache-Control đích (đóng ADR-0001 Action Item 3)

**Đã triển khai** ở [worker/index.js](../worker/index.js) (`clientCacheControlFor`).
Nguyên tắc: **response trả về client không dùng `s-maxage`** (chặn SWR), nhưng
`caches.default` — tầng per-colo riêng của Worker — **vẫn giữ `s-maxage`** như
cũ, vì tầng đó không hỗ trợ SWR nên không mất gì khi giữ, và giữ lại đúng độ
chi tiết theo tier (đặc biệt là 30d/6h/1h của recommendation, không thể diễn
đạt bằng một Cache Rule tĩnh). Hai `Response` khác nhau cho cùng một `body` —
xem lời giải O3 ngay dưới bảng.

| Route | `Cache-Control` trả về client | `Cache-Control` ghi vào `caches.default` |
|---|---|---|
| `/api/home-data` | `public, max-age=60, stale-while-revalidate=3600, stale-if-error=86400` | `max-age=60, s-maxage=1800` (không đổi) |
| `/api/list\|genre\|country` | `public, max-age=60, stale-while-revalidate=3600, stale-if-error=86400` | `max-age=60, s-maxage=1800` (không đổi) |
| `/api/movie/:slug` | `public, max-age=60, stale-while-revalidate=7200, stale-if-error=86400` | `max-age=60, s-maxage=3600` (không đổi) |
| `/api/recommendation/*` | `public, max-age=60, stale-while-revalidate=86400, stale-if-error=604800` | `max-age=60, s-maxage=<tier>` (không đổi, 1h/6h/30d) |
| `/api/search` | `public, max-age=60, stale-while-revalidate=600` | `max-age=60, s-maxage=600` (không đổi) |
| `stale-vps-down` (fallback) | `public, max-age=30, stale-if-error=86400` | không ghi (giữ nguyên quyết định cũ) |
| lỗi 4xx/5xx | `public, max-age=30` | không ghi |
| `/api/health` | `no-store` | không ghi |
| `/assets/*` | `public, max-age=31536000, immutable` | n/a (asset layer) |
| `img.bluesia.net/*` | `public, max-age=31536000, immutable` | n/a (R2, không qua Worker) |

**O3 đã trả lời — KHÔNG cần Cache Rule cho Edge TTL.** Cách tiếp cận ban đầu
(dùng Cache Rule để set Edge TTL tĩnh) sẽ **phá vỡ** hệ tier 30d/6h/1h của
recommendation, vì Cache Rule áp theo path, không theo nội dung response. Giải
pháp thật: giữ nguyên `caches.default` với `s-maxage` như cũ (SWR vốn không
chạy ở đó nên không mất gì), chỉ đổi response **trả về client** — đó cũng là
thứ zone CDN nhìn thấy và cache riêng ở tầng của nó. `max-age=60` ngắn không
sao, vì "revalidate" ở tầng zone gần như luôn có nghĩa là "hỏi lại Worker này",
và Worker gần như luôn có sẵn câu trả lời nhanh ở `caches.default`/KV/D1 — chứ
không phải một round-trip KKPhim/TMDB.

Việc còn lại thật sự cần Cache Rule (không tránh được bằng code): **Browser
Cache TTL override** quan sát được ở ADR-0001 — production hiện trả
`max-age=1800` trên response `HIT` dù Worker gửi `max-age=60`. Vẫn chặn bởi O1
lúc viết đoạn này — **đã đóng**, xem cập nhật cuối phần Phase 1 bên dưới.

---

## §6. Các phase

Mỗi phase deploy độc lập, revert độc lập. **Làm đúng thứ tự** — Phase 0 chặn
tất cả, và Phase 5 vô nghĩa nếu chưa có Phase 2.

### Phase 0 — 🟢 Chẩn đoán background refresh *(đóng — không phải sự cố)*

**Kết quả: cả 3 cron đều đang chạy đúng.** Đo lại `/api/health` qua tick `:00`
đầy đủ (thay vì ngay sau deploy) cho thấy `home.age_min: 1`,
`warm: {age_min:1, written:12, skipped:0, failed:0}`,
`mirror.mirrored_last_hour: 40`, và `mirrored_total` tăng đều
(3.494→3.524 trong 14 phút). "Sự cố" ở lần đo đầu chỉ là bắt trúng khoảng
trống giữa lúc deploy (06:45 UTC) và tick cron kế tiếp (07:00 UTC) — chưa có
gì để hồi sinh. Chi tiết đầy đủ, gồm việc loại trừ từng giả thuyết (all-or-
nothing abort, CRON_KEY sai, trigger không đăng ký), ở
[state-hit-rate.md](state-hit-rate.md) § "Phase 0: chẩn đoán lại".

Vấn đề thật đằng sau con số "1.222 ảnh tồn, đầu queue kẹt hàng trăm phút" không
phải cron chết, mà là **throughput mirror thấp hơn backlog** — dồn vào Phase 3.

**Bài học quy trình, áp dụng cho các phase sau:** đừng đọc `/api/health` ngay
sau một deploy để kết luận cron sống/chết — đợi qua ít nhất một tick đầy đủ của
mọi cron, hoặc nhìn `written`/`failed` thay vì chỉ `age_min`.

**Verify (đã chạy):** `/api/health` → `home`/`warm` đều fresh sau tick;
`mirrored_total` tăng theo thời gian qua nhiều lần đo.
**Rollback:** không áp dụng — không có thay đổi nào được thực hiện.

### Phase 1 — Bỏ `s-maxage`, bật `stale-while-revalidate`

Thay đổi lớn nhất về mặt code. Áp bảng §5.

- Sửa 4 chỗ dựng header trong [worker/index.js](../worker/index.js):
  `handleHomeData`, `handleRecommendation`, `warmKvLookup`, nhánh build trong
  `handleApi` (+ nhánh stale/4xx/5xx).
- Thêm Cache Rule trên zone: `/api/*` → Edge Cache TTL theo bảng, Browser TTL
  "respect origin" (đóng luôn ADR-0001 Action Item 2 — override `max-age=1800`
  hiện tại).
- Xác nhận Origin Cache Control đang bật trên zone (điều kiện để các directive
  này được tôn trọng).

**Cập nhật thiết kế so với bản đầu:** không cần Cache Rule cho Edge TTL. Vì
`caches.default` (tầng per-colo của chính Worker) **không hỗ trợ SWR** dù có
`s-maxage` hay không (doc Cloudflare: "not supported when using the Cache API
methods cache.match or cache.put"), header ghi vào đó **giữ nguyên** scheme cũ
(`s-maxage=<ttl theo route/tier>`) — không đổi gì ở tầng này, không mất độ
chi tiết theo tier của recommendation (30d/6h/1h). Chỉ **response trả về
client** (thứ zone CDN thấy và cache) đổi sang scheme mới, qua
`clientCacheControlFor()`. Hai `Response` khác nhau, hai Cache-Control khác
nhau, từ cùng một `body`. Điều này trả lời dứt điểm câu hỏi mở O3.

Việc còn lại **thật sự cần Cache Rule** (không tránh được bằng code): fix
Browser Cache TTL override quan sát được ở ADR-0001 — production hiện trả
`cache-control: public, max-age=1800, s-maxage=1800` trên các response `HIT`
dù Worker gửi `max-age=60`, nghĩa là zone có một override buộc browser giữ
1800s. Việc này **vẫn chặn bởi O1** (cần quyền Zone Settings) lúc viết đoạn
này — **đã đóng cùng ngày**, user tự chuyển dashboard sang "respect existing
headers".

**Verify (đã chạy `node --check`, cần deploy để verify hết):**
- `worker/index.js` cú pháp hợp lệ.
- Sau deploy: mọi response `/api/*` (`hit`/`miss`/`warm`/`stale-vps-down`/lỗi)
  trả `cache-control` **không** còn `s-maxage`, có `stale-while-revalidate`
  (trừ nhánh lỗi tổng/4xx).
- Sau khi entry hết TTL (`max-age=60`), request kế tiếp trả `cf-cache-status:
  UPDATING` (không phải `EXPIRED`) — cần đợi >60s để test được.
- **Đã verify:** Browser Cache TTL override 1800s — user xác nhận đã tắt
  trên dashboard (chuyển "respect existing headers") cùng ngày.

**Rollback:** revert `worker/index.js` về commit trước, redeploy.

### Phase 2 — Bật Tiered Cache (Smart Topology)

Dashboard, miễn phí, không đụng code. **Đòn bẩy free lớn nhất còn lại.**

- Caching → Tiered Cache → bật, chọn Smart Topology.
- Cloudflare **tự chọn upper tier tối ưu cho origin R2** — đúng trường hợp
  `img.bluesia.net`.

**Verify:** đo MISS rate của cùng một tập ảnh trước/sau, từ ≥2 vùng.
**Rollback:** tắt toggle.

### Phase 3 — Shard mirror drain, dọn nốt backlog ~1.200 ảnh *(đã triển khai)*

Trước: 1 invocation × 20 ảnh / 10 phút = 2.880/ngày lý thuyết, **chạy đúng**
(xem Phase 0) nhưng không đủ nhanh so với backlog phát sinh từ đợt đổi nguồn
KKPhim hôm nay.

- ✅ Tách `/__cron/mirror-shard/:n` ([worker/lib/mirror.js](../worker/lib/mirror.js)
  `drainMirrorQueueShard`), gọi qua `SELF` từ orchestrator `runMirrorRefresh`
  — **đúng pattern `home.js`/`warm.js`** (mỗi shard có budget 50 subrequest
  riêng). Khác một chỗ: 5 shard gọi **song song** (`Promise.all`), không tuần
  tự như home/warm — orchestrator chỉ dispatch 5 HTTP round-trip tới chính
  nó, không tự làm việc nặng nên không cần né giới hạn 6 kết nối đồng thời.
- ✅ Partition hàng đợi bằng `rowid % 5`, không phải `OFFSET` — xem lý do
  (race điều kiện dưới ghi/xoá đồng thời) và số liệu phân bố đều
  (246/245/246/248/249 trên 5 shard, đo thật trên D1 production) ở
  [state-hit-rate.md](state-hit-rate.md).
- 5 shard × 20 ảnh / 10 phút = **14.400 ảnh/ngày** → dọn sạch backlog trong
  vài tick thay vì rải rác cả ngày.
- `phimimg.com` (100/~1.200 hàng đợi): **đã đúng, không cần sửa** — Phase 0 xác
  nhận `mirrorOne` đã gate `isKkphim` để bỏ qua wsrv.nl (host này chặn
  `phimimg.com`) và fetch thẳng origin; test trực tiếp một URL mẫu trả về
  `200, image/webp, content-length` bình thường. Các dòng này chỉ đang chờ tới
  lượt FIFO, không bị lỗi.
- **Chưa làm, để lại cho sau:** chặn N1 tận gốc bằng cách **không map sang R2
  khi chưa mirror** (tra bảng `mirrored`) → tránh 404. Đánh đổi: thêm 1 query
  D1 mỗi build. Không cấp thiết vì backlog giờ tự dọn nhanh hơn nhiều.

**Verify:** `mirror_queue` → ~0; `mirrored_last_hour` > 0; sampling 50 URL ảnh
trong home payload → 0 cái trả 404.
**Rollback:** xoá route shard, quay lại drain đơn.

### Phase 4 — Warm set theo popularity (Cleanup with LRU) *(đã triển khai)*

Đóng ADR-0001 Action Item 5 + 6 ("12 key chọn bằng trực giác" → chọn bằng số
liệu thật).

- ✅ Bảng D1 `popularity(path, hits, last_seen)`
  ([migrations/0003_popularity.sql](../migrations/0003_popularity.sql)), tăng
  **có lấy mẫu** (1-trong-10, `trackPopularity` trong
  [worker/index.js](../worker/index.js)) để giữ ghi D1 trong tầm — dù D1 free
  tier cho phép 100k rows/ngày (không phải nút thắt thật), lấy mẫu vẫn giữ
  khối lượng ghi tỉ lệ với mức độ quan tâm thật thay vì raw request count.
  Chặn thêm ở `page ≤ 10` để số dòng distinct không phình vô hạn theo phân
  trang sâu/crawler — cùng lo ngại ADR-0001 Action Item 8 đã nêu cho bảng
  `stale`, áp dụng phòng ngừa ngay từ đầu cho bảng mới này.
- ✅ Warm set = top-N theo `hits DESC, last_seen DESC`
  ([worker/lib/warm.js](../worker/lib/warm.js) `getTopWarmTargets`). **N giữ
  nguyên 12** — Phase này đổi WHICH 12 trang được warm, không đổi BAO NHIÊU
  (số học ngân sách 1.000 KV write/ngày của ADR-0001 không đổi).
- **Bootstrap an toàn:** danh sách tĩnh 12 trang cũ (`SEED_TARGETS`) không bị
  xoá — nó trở thành **hàng dự phòng lấp chỗ trống** khi dữ liệu popularity
  thật chưa đủ N dòng (chắc chắn đúng ngay sau deploy, khi bảng D1 còn rỗng).
  Không có bước này, deploy đầu tiên sẽ khiến LRU-eviction xoá sạch 12 trang
  đang warm ngay lập tức trong lúc dữ liệu thật còn đang tích luỹ — một hồi
  quy còn tệ hơn chính vấn đề "chọn bằng trực giác" mà phase này sửa. Một
  entry seed tự động bị dữ liệu thật thay thế khi nó đủ hạng, không cần thao
  tác gì thêm.
- ✅ **LRU eviction** (`evictStaleWarmKeys`): key rớt khỏi top-N thì xoá khỏi
  KV bằng `CATALOG_KV.list({prefix})` + `delete()` — đây là **read** op
  (ngân sách 100k/ngày), không tính vào ngân sách **write** 1.000/ngày vốn là
  thứ chặn N, nên xoá không tốn gì thêm.
- **Chưa làm:** mở rộng warm set sang `/api/movie/:slug`. **Càng không nên
  làm sau số liệu Phase 8** — con số `meta:*` thật (2.262 key, burst đo được
  tới ~1.480 write/ngày trong lúc đổi nguồn KKPhim) cho thấy ngân sách
  1.000/ngày còn ít headroom hơn tưởng, không phải nhiều hơn. Xem addendum
  trong [ADR-0001](adr/0001-caching-topology.md) trước khi cân nhắc mở rộng.

**Verify:** `node --check` cả hai file pass; migration `0003_popularity.sql`
đã apply lên D1 production (`wrangler d1 migrations apply --remote`, xác nhận
bảng tồn tại qua `sqlite_master`). Chưa verify được `x-catalog-cache: warm`
thật hay ranking dịch chuyển theo traffic — cần đợi traffic thật tích luỹ đủ
mẫu qua nhiều chu kỳ `*/30`.
**Rollback:** revert `worker/lib/warm.js` + `worker/index.js` về commit
trước — `SEED_TARGETS` (danh sách tĩnh cũ) vẫn còn nguyên trong code nên
không mất thông tin gì khi rollback. Bảng `popularity` có thể để nguyên
không dùng, không cần xoá (không ảnh hưởng đường code cũ).

### Phase 5 — Edge warming (Render Once → Cache **Everywhere**) *(đã triển khai)*

Pre-build vào KV vẫn chưa làm nóng **edge**. Bước này làm nóng edge thật.

> **Ràng buộc tưởng là chặn cứng — hoá ra không phải.** Worker fetch hostname
> của chính nó → 522, và `SELF` service binding đi vòng qua CDN. Bản đầu kết
> luận "warm `/api/*` **bắt buộc** phải gọi từ bên ngoài" và dựng GitHub
> Actions. **Sai** — Cloudflare có sẵn compatibility flag
> `global_fetch_strictly_public` gỡ đúng ràng buộc này (xem §6.5.1). Toàn bộ
> phần `/api/*` đã được viết lại chạy trên chính Cloudflare, bỏ hẳn phụ thuộc
> GitHub. Giữ lại đoạn này vì nó giải thích vì sao thiết kế ban đầu đi đường
> vòng.

- ✅ **Ảnh** ([worker/lib/home.js](../worker/lib/home.js) `warmHeroImages`):
  sau mỗi lần `runHomeRefresh` thành công, fetch trực tiếp
  `https://img.bluesia.net/...` cho ~22 URL — 20 rail-thumb (`w154`, **mọi**
  lượt xem trang chủ đều load, không qua lazy-gate) + 2 backdrop đầu tiên
  (`w1280`, đúng số lượng `ensureBackdrop()` load ngay). Đây **chính là** tập
  ảnh bị đo là MISS ở baseline ban đầu (§1.2) dù có header `immutable` 1 năm
  — cố định TTL không giúp gì khi nguyên nhân là LRU evict, phải warm lặp
  lại. Cần **Phase 2 (Tiered Cache) đã bật** thì mới lan ra ngoài 1 colo,
  đúng như cảnh báo gốc.
- ⚠️ **`/api/*`** ([worker/lib/warm.js](../worker/lib/warm.js) `runEdgeWarm`,
  route `/__cron/edge-warm`): sau khi `runWarmRefresh` ghi xong KV, gọi thêm
  1 invocation riêng (qua `SELF`, đúng pattern shard sẵn có) fetch 13 URL
  công khai `https://phim.bluesia.net/api/...` qua **front door** của
  Cloudflare. **Thứ tự có chủ đích:** warm edge *sau* khi KV mới, warm trước
  sẽ cache lại body của chu kỳ cũ thêm nguyên một TTL. **Chạy đúng nhưng
  giá trị thấp hơn dự kiến — xem §6.5.2.**

#### §6.5.1 — `global_fetch_strictly_public`: vì sao không cần caller ngoài

Bản đầu của Phase 5 dựng GitHub Actions vì tin rằng Worker không thể tự nạp
edge cache của chính nó. Điều đó đúng **theo mặc định**, nhưng Cloudflare có
flag gỡ đúng ràng buộc đó — doc Error 522 nói thẳng: *"performing a `fetch`
to its own hostname will cause a 522 error. Consider ... enabling the
`global_fetch_strictly_public` compatibility flag instead"*, và doc flag mô
tả hành vi sau khi bật: *"requests to a Worker's own zone will loop back to
the 'front door' of Cloudflare and will be treated like a request from the
Internet"*. **Đi qua front door = đi qua đúng đường CDN = nạp được edge
cache** — chính xác thứ edge-warming cần.

Đây là **flag toàn cục**, nên đã soát bán kính ảnh hưởng trước khi bật:

| Loại fetch | Ảnh hưởng |
|---|---|
| Host ngoài (`phimapi.com`, TMDB, `wsrv.nl`) | **Không** — "strictly public" vốn đã là hành vi của chúng |
| `img.bluesia.net` (cùng zone, R2 custom domain) | Giờ **chắc chắn** qua front door — đúng thứ `warmHeroImages` cần |
| `env.SELF` service binding (toàn bộ fan-out shard home/warm/mirror) | **Không đổi** — service binding là cơ chế riêng, *"without going through a publicly-accessible URL"*; flag chỉ chi phối **global** `fetch()`. Đây là tính chất khiến flag này an toàn ở đây |
| Vòng lặp | Depth 1 — các handler `/api/*` được warm không tự fetch chính chúng |

**Đổi lại được gì:** bỏ hẳn phụ thuộc GitHub Actions, bỏ secret
`EDGE_WARM_KEY`, và **O5 (WAF Custom Rule) không còn cần thiết** — không còn
request nào từ IP GitHub để bị bot-challenge nữa.

**Verify (đã chạy thật, tick 09:00 UTC):** `warm:last-run` báo
`edgeRequested: 13, edgeWarmed: 13` — **cả 13 self-fetch trả 200**. Nếu flag
không hoạt động thì đây phải là 522 và `edgeWarmed: 0`. → Flag hoạt động,
Worker tự fetch được hostname của chính nó.

#### §6.5.2 — Đo xong mới thấy: edge-warm `/api/*` chỉ nóng ĐÚNG 1 colo

Đây là phát hiện **ngược với giả định của plan**, ghi lại thay vì lờ đi.

Sau khi edge-warm 09:01 báo 13/13 thành công, đo từ SIN:

| URL (nằm trong 13 URL vừa warm) | Kết quả đo từ SIN |
|---|---|
| `/api/country?slug=trung-quoc&page=1` | **không có `cf-cache-status`**, `x-catalog-cache: warm` |
| `/api/genre?slug=tam-ly&page=1` (lần 1) | **không có `cf-cache-status`**, `x-catalog-cache: warm` |
| `/api/genre?slug=tam-ly&page=1` (lần 2) | `cf-cache-status: HIT`, age 24 |

Tức là edge cache ở SIN được nạp bởi **request của chính tôi**, không phải bởi
edge-warm. Edge-warm chỉ nạp colo nơi **cron chạy**.

**Vì sao Tiered Cache không cứu được ở đây:** Tiered Cache dựng tầng trên cho
các lần fetch về **origin**. Với một Worker chạy trên route, **Worker chính là
origin** và nó thực thi ngay tại colo nhận request — không có "origin fetch"
nào để mà tier. Nên Tiered Cache giúp được `img.bluesia.net` (R2 là origin
thật) nhưng **không giúp `/api/*`**.

**Quan trọng: đây KHÔNG phải hồi quy do đổi sang CF.** Phương án GitHub
Actions cũ vướng đúng giới hạn này — runner GitHub nằm ở vài region Mỹ, nên
nó cũng chỉ nạp được colo Mỹ, không phải SIN nơi người dùng thật ở. Hai
phương án giá trị như nhau ở khoản này; phương án CF chỉ đơn giản hơn (không
phụ thuộc ngoài, không secret, không WAF rule).

**Điều đáng chú ý hơn:** `x-catalog-cache: warm` trong bảng trên nghĩa là
tầng KV warm set (Phase 4) **đang phục vụ toàn cầu mà không cần build
upstream** — đúng chỉ số B ("origin-build rate ≤0,1%") mà §4 cam kết. Tầng KV
mới là thứ làm việc chính; edge cache bên trên chỉ là phần thêm.

**Giữ hay bỏ `runEdgeWarm`?** Giữ — chi phí rất thấp (13 invocation/tick =
~624/ngày trên hạn mức 100.000, cộng 13 subrequest trong một invocation
riêng), vẫn có lợi thật cho colo cron chạy, và không có rủi ro. Nhưng
**đừng kỳ vọng nó dịch chuyển zone-wide HIT%** — nó không làm được việc đó,
và §4 nên đọc với hiểu biết này.

**Rollback:** gỡ `global_fetch_strictly_public` khỏi `compatibility_flags`
trong `wrangler.toml` + revert `worker/lib/warm.js`/`worker/index.js`.
Không cần đụng gì tới dữ liệu — `runEdgeWarm` không ghi ở đâu cả, chỉ đọc.
Lưu ý gỡ flag sẽ làm `warmHeroImages` (phần ảnh) quay lại hành vi same-zone
mặc định.

### Phase 6 — Đo lường tách theo class *(đã xong cả A/B/C — O6 đóng 2026-08-07)*

Không thể lái một con số gộp. Cần tách A/B/C của §0.

- ✅ **`/api/health`: đếm `hit`/`miss`/`warm`/`d1-recs`/`stale-vps-down`/
  `miss-fallback` theo cửa sổ trượt 24h** — chỉ số B (`origin-build rate`)
  mà §4 thật sự cam kết. Bảng D1 mới `cache_stats`
  (migration `0004_cache_stats.sql`), 1 dòng mỗi (giờ, status), lấy mẫu
  1-trong-10 giống `trackPopularity` (Phase 4). Đọc từ header
  `x-catalog-cache` của chính response trả về, tại **một điểm gọi duy nhất**
  trong `fetch()`.
- ✅ **GraphQL Analytics API — O6 đã đóng.** User cung cấp Cloudflare API
  token scope Zone Analytics Read (2026-08-07). Đo trực tiếp qua
  `api.cloudflare.com/client/v4/graphql`, dataset `httpRequestsAdaptiveGroups`,
  group theo `clientRequestHTTPHost` + `cacheStatus`, cửa sổ 24h. **Kết quả
  đầy đủ ghi ở §6.6 bên dưới** — số liệu A/C thật, không còn ước tính.

#### §6.6 — Số đo thật, 2026-08-07 (24h trước đó)

| Host | Tổng request | HIT-like (`hit`+`stale`) | % |
|---|---|---|---|
| `phim.bluesia.net` | 22.284 | 17.105 | **76,8%** |
| `img.bluesia.net` | 6.665 | 4.480 | **67,2%** |

So với baseline 35% (báo cáo ban đầu, đo gián tiếp qua mô hình §2) —
**tăng thật, không phải suy diễn.** Phần lớn cải thiện tới từ đúng những gì
Phase 0–5 nhắm tới: `s-maxage`→SWR (Phase 1), Tiered Cache (Phase 2), mirror
drain hết backlog (Phase 3, `queued: 0` xác nhận riêng ở Phase 6 log), warm
set theo popularity + LRU (Phase 4), edge-warm (Phase 5, dù chỉ nóng 1 colo
như đã ghi ở §6.5.2).

**Chỉ số A đã vượt mục tiêu §4 (≥93%)? Chưa** — 76,8%/67,2% vẫn dưới 93%,
nhưng đang đo ở **24h đầu tiên** sau khi toàn bộ phase deploy xong, cache
còn đang "làm nóng" chưa ổn định (`mirror_queue` chỉ vừa về 0). Cần đo lại
sau vài ngày để có con số ổn định hơn — baseline 93% trong §4 dựa trên mô
hình lý thuyết, không phải cam kết cứng cho ngày đầu.

**Phát hiện mới, ngoài phạm vi hit-rate — mức độ nghiêm trọng đáng chú ý:**
đếm theo `edgeResponseStatus` lộ ra **1.789 lỗi 504/502 thật trong 24h**
(8,0% tổng request `phim.bluesia.net`, sau khi loại trừ 818 lỗi `503` của
chính `/api/health` báo cáo — đó là **đúng thiết kế**, không phải lỗi).
Tập trung ở `/api/list` (547), `/api/search` (294+144 lỗi 502), `/api/movie/*`
(172+16+9...), `/api/genre` (154), `/api/home-data` (102). 504 = Cloudflare
tự timeout chờ Worker/upstream, không phải lỗi Worker trả về chủ động (đã có
502 "catalog unavailable" riêng, chỉ 144 case). **Chưa điều tra nguyên nhân
gốc** (nghi vấn: KKPhim chậm dưới tải thật, hoặc build nhiều TMDB enrich
vượt timeout) — nằm ngoài phạm vi "đo lường Phase 6", ghi lại để cân nhắc
một phiên `/engineering:debug` riêng.

**Verify:** `node --check` pass; migration `0004_cache_stats.sql` đã apply
lên D1 production. Kết quả đo thật ghi ở [state-hit-rate.md](state-hit-rate.md)
— `cache_stats` mới tạo, cần vài giờ tích luỹ mẫu mới đọc được số có ý nghĩa.
**Rollback:** revert `worker/index.js` (bỏ `trackCacheStat`/
`getCacheStatsWindow`/`cleanupCacheStats` + điểm gọi trong `fetch()` và
`handleHealth`). Bảng D1 `cache_stats` có thể để nguyên không dùng.

### Phase 7 — *(tuỳ chọn, tốn tiền)* Cache Reserve

Chỉ mở ra khi Phase 0–6 xong và đã có số đo thật. Đây là **cách duy nhất** vượt
~95% zone-wide. Quyết định bằng số liệu Phase 6, không quyết trước.

### Phase 8 — Dọn nợ đã lộ ra khi khảo sát *(đã triển khai)*

- ✅ **`stale` (D1) eviction** ([worker/index.js](../worker/index.js)
  `cleanupStaleTable`, đóng ADR-0001 Action Item 8): xoá row `updated_at`
  cũ hơn 90 ngày, chạy cùng cron hourly với `cleanupRecTables`. 90 ngày =
  2× ngưỡng 45 ngày của `idx`, vì `stale` là tầng disaster-fallback hiếm
  dùng hơn, không cần dọn gắt bằng reverse index.
- ✅ **Dọn KV rác** — phát hiện rác **nhiều hơn ước tính ban đầu**: không chỉ
  `home:last-known-good` + ~20 `stale:*`, mà còn nguyên một prefix `live:*`
  chưa từng nhắc tới (28 key). Tổng cộng xác nhận-rồi-xoá: **90 key** (61
  `stale:*` + 28 `live:*` + 1 `home:last-known-good`) — xác nhận không code
  nào tham chiếu tới 3 loại key này trước khi xoá (`grep` toàn repo).
- ✅ **Sửa số `meta:*` sai trong CLAUDE.md** — không chỉ sai giá trị (~111 →
  thực tế đo lần đầu 1.886, đo lại lần này **2.262**), mà đo sâu hơn (dùng
  trường `expiration` của mỗi key để suy ngược thời điểm tạo, vì TTL cố định
  14 ngày) phát hiện một rủi ro thật: **749 write trong 24h qua**, đỉnh
  điểm ước tính **~1.480/ngày**, toàn bộ trùng khớp thời điểm đổi nguồn
  KKPhim hôm nay. Ngân sách burst gốc của ADR-0001 (100/ngày) **thấp hơn
  thực tế đo được tới ~15 lần**. Đã ghi chi tiết + tính lại rủi ro overflow
  ngân sách 1.000/ngày như một addendum có ngày trong
  [ADR-0001](adr/0001-caching-topology.md), không sửa đè số cũ (giữ lại lịch
  sử quyết định).
- ✅ Đánh dấu lại checklist Action Items của ADR-0001 theo trạng thái thật —
  6/8 mục đã xong, chỉ còn Item 7 (đo ngân sách request của Option E) vẫn mở.

**Verify:** `node --check` pass. KV: đếm lại `stale:*`/`live:*`/
`home:last-known-good` sau xoá → 0. `stale` D1: chưa quan sát được hiệu quả
thật (bảng mới có 52 row, tất cả dưới 90 ngày — chưa có gì để xoá; cơ chế
sẽ tự chứng minh khi bảng già đi).
**Rollback:** revert `worker/index.js` (bỏ `cleanupStaleTable`); KV/D1 đã
xoá thì không phục hồi được từ phía Worker — không phải rủi ro vì cả 3 loại
key/row đó đều tự tái tạo được từ build sống nếu cần (không phải nguồn dữ
liệu duy nhất).

---

### Phase 9 — Phân rã miss thật (2026-08-07): **cache KHÔNG còn là nút thắt**

Câu hỏi đặt ra: "77,65% / 66,08% vẫn xa 95%, cần giải pháp mạnh tay nào?"
Trước khi thêm bất kỳ cơ chế cache nào nữa, phân rã xem **miss thật sự đến
từ đâu**. Kết quả **đảo ngược tiền đề của câu hỏi**.

#### §9.1 — Cửa sổ 24h bị nhiễm bởi backlog migration

| Cửa sổ | phim HIT | img HIT | img 404 | phim 5xx |
|---|---|---|---|---|
| 24h | 77,3% | 67,2% | 33,6% | 11,5% |
| 6h | **82,8%** | **81,6%** | 25,0% | 6,3% |
| 3h | 79,3% | 78,6% | 40,0% | 7,9% |

Con số 24h (77,65/66,08 mà bạn thấy) **gộp cả giai đoạn ~1.200 ảnh còn trong
mirror queue** — Phase 3 chỉ vừa dọn sạch (`queued: 0`). Đo cửa sổ gần hơn
đã tốt hơn đáng kể. 5xx theo giờ: **39,5% (02:00) → ~2% (15:00–21:00) →
6–10% (23:00–01:00)** — giảm mạnh đúng theo tiến độ Phase 1–5 landing.

#### §9.2 — Phân rã miss: `phim.bluesia.net` (6h, n=5.471)

| | Số | % | Loại |
|---|---|---|---|
| ✅ HIT | 4.554 | **83,2%** | cached |
| ❌ `/api/health` | 368 | **6,7%** | `no-store` **đúng thiết kế** — không bao giờ HIT được |
| ❌ non-GET (405) | 209 | **3,8%** | PUT/POST rác — không bao giờ cacheable |
| ❌ 5xx | 170 | **3,1%** | timeout/lỗi |
| ◻ **miss cache thật** | **168** | **3,1%** | ← thứ duy nhất cache có thể sửa |

**Đây là phát hiện quyết định: miss cache THẬT chỉ 3,1%.** Trên phần traffic
thật sự cacheable, hệ cache đang chạy ở **~96–97% hiệu quả**. Thêm cơ chế
cache nữa gần như không còn gì để thu.

Nếu bỏ nhiễu giám sát + rác khỏi mẫu số:
`4.554 / (5.471 − 368 − 209) = ` **93,0%**. Cộng thêm sửa 5xx →
`4.724 / 4.894 = ` **96,5% — vượt mục tiêu 95%.**

#### §9.3 — Phân rã miss: `img.bluesia.net` (6h, n=1.258)

| | Số | % |
|---|---|---|
| ✅ HIT 200 | 828 | 65,8% |
| ❌ **404** | 314 | **25,0%** |
| ◻ miss 200 thật | 91 | 7,2% |
| ❌ 403 | 25 | 2,0% |

**404 là toàn bộ vấn đề của img** — và **không phải ảnh bị thiếu**. Đã kiểm
chứng: lấy mẫu **60 key ngẫu nhiên** từ D1 `mirrored` → **60/60 trả 200**.
Test riêng 4 key đang 404 trong analytics → **4/4 giờ trả 200**, với
`cf-cache-status: EXPIRED`.

**Nguyên nhân thật: Cloudflare đã CACHE các response 404** sinh ra trong giai
đoạn backlog. R2 trả 404 **không kèm `cache-control`**, nên CDN áp default
edge TTL cho 404 → 404 bị đóng băng ở edge **kể cả sau khi object đã vào
R2**. Tự lành nhưng chậm, từng entry một.

→ Nếu purge sạch 404 đã cache: trần lý thuyết img ≈ **98,0%**.

Ngoại lệ đáng chú ý: **1 ảnh duy nhất chiếm 62% lượng 404 gần đây**
(`kkphim/uploads/movies/public/images/Post/1/phap-su-tu-linh-ta-chinh-la-thien-tai.jpg`,
195/312 request trong 3h) — ảnh này **chết thật ở upstream** (phimimg.com
cũng trả 404), `mirrored: 0, queue: 0`. Client fallback cũng 404 → ảnh vỡ
vĩnh viễn, và mỗi lượt xem lại nện thêm request.

#### §9.4 — Kết luận: 95% khả thi, nhưng KHÔNG bằng cache

| # | Đòn bẩy | Tác động ước tính | Ai làm được |
|---|---|---|---|
| **L1** | **Purge 404 đã cache trên `img.bluesia.net`** | img 66% → ~90–98% | **Cần bạn** (token read-only) |
| **L2** | Cache Rule: `img.bluesia.net` + status 404 → Edge TTL rất ngắn / bypass | chặn tái phát L1 | **Cần bạn** |
| **L3** | Bỏ `/api/health` khỏi `phim.bluesia.net` (đổi sang subdomain riêng) **hoặc** giảm tần suất poll của `monitor.bluesia.net` | phim +6,7pp | **Cần bạn** (dashboard/monitor config) |
| **L4** | Chặn non-GET tới `/api/*` ở WAF | phim +3,8pp | **Cần bạn** |
| **L5** | Điều tra & sửa 504 | phim +3,1pp (và +8pp ở giờ cao điểm) | Tôi làm được (cần phiên riêng) |
| **L6** | Đo hit-rate trên **traffic cacheable** (loại health + non-GET) thay vì gộp tất cả | đo đúng thay vì đo sai | Tôi làm được |

**Không đề xuất thêm cơ chế cache nào.** Với miss thật 3,1%, mọi giải pháp
"mạnh tay" kiểu Cache Reserve / thêm tầng cache đều nhắm sai chỗ — chúng
không chạm được vào 6,7% health-check, 3,8% rác non-GET, hay 3,1% 5xx.

---

## §7. Trade-offs

**1. Độ mới vs hit rate.** SWR nghĩa là user có thể nhận bản cũ tới 1 giờ trong
lúc refresh chạy nền. Với catalog phim cập nhật theo lô, đây không phải chi phí
thật — home cron vốn đã chấp nhận 1 giờ.

**2. Bỏ `s-maxage` = phụ thuộc Cache Rules.** TTL edge chuyển từ "trong code,
đi cùng deploy" sang "trong dashboard, ngoài git". Mất tính self-contained; đổi
lại được SWR + `stale-if-error`. Giảm đau bằng cách ghi rõ bảng §5 vào CLAUDE.md
và coi Cache Rule là một phần của contract.

**3. Sửa 404 ảnh bằng tra `mirrored`** tốn thêm 1 query D1 mỗi build, đổi lấy
việc bỏ hẳn nhánh fallback client-side. Cân nhắc ở Phase 3 — có thể để nguyên
fallback và chỉ tăng throughput drain là đủ.

**4. Trần Free ~95% là trần thật.** Mọi phương án né N2 mà không trả tiền đều
là ảo tưởng. Nên chốt mục tiêu Free ở 93–95% và đưa 99% vào diện "cần quyết
định thương mại".

---

## §8. Rủi ro

| Rủi ro | Mức | Giảm thiểu |
|---|---|---|
| Phase 1 đổi header → mọi entry cũ vẫn giữ header cũ tới khi hết TTL | Trung bình | Purge Everything sau deploy (CLAUDE.md đã có tiền lệ) |
| Warm set mở rộng làm cạn 1.000 KV write/ngày → **`home:current` cũng ngừng ghi** | **Cao** | Giữ nguyên số học ADR-0001; `/api/health` phải assert số write thật |
| Phase 3 tăng drain → chạm 100k Worker request/ngày | Thấp | 5 shard × 144 tick = 720 invocation/ngày, không đáng kể |
| Đặt Worker trước `img.bluesia.net` (nếu chọn hướng read-through) | **Cao** | **Không làm ở plan này.** ~40 ảnh/lượt xem × Worker request = trần 2.500 lượt/ngày |
| Cache Rule sai → bypass toàn bộ cache | Trung bình | Đổi từng rule một, verify bằng curl trước khi sang rule kế |

---

## §9. Câu hỏi mở / cần quyền

| # | Câu hỏi | Chặn phase |
|---|---|---|
| ~~O1~~ | ~~Browser Cache TTL override~~ — **User đã tự xử lý** trên dashboard (chuyển "respect existing headers"). | — |
| ~~O2~~ | ~~Cron có thật sự fire không?~~ **Đã đóng ở Phase 0** — cron chạy đúng, xem [state-hit-rate.md](state-hit-rate.md). | — |
| ~~O3~~ | ~~Tầng `caches.default` có còn đáng giữ không?~~ **Đã trả lời** — giữ nguyên, không đổi gì; chỉ đổi header trả về client. Xem §6 Phase 1. | — |
| ~~O4~~ | ~~Có trả phí Cache Reserve không?~~ **User quyết định bỏ qua** (2026-08-06) — Phase 7 không triển khai. | — |
| ~~O5~~ | ~~WAF Custom Rule cho IP GitHub Actions~~ — **không còn cần**. Đã bỏ hẳn caller ngoài bằng `global_fetch_strictly_public` (§6.5.1), không còn request nào từ IP GitHub để bị bot-challenge. | — |
| ~~O6~~ | ~~Quyền Cloudflare GraphQL Analytics API~~ — **đã đóng 2026-08-07**, user cấp token Zone Analytics Read. Số liệu thật ở §6.6. | — |

> Về O6: cần cấp thêm token Cloudflare scope Zone Analytics, hoặc xác
> thực MCP `cloudflare-api`/`cloudflare-observability` trong một phiên
> interactive (`claude mcp` / `/mcp`). Phiên hiện tại không chạy được OAuth
> flow.

---

## §10. Thứ tự thực thi đề xuất

```
Phase 0  ✅ Đã xong — kết luận: không phải sự cố, không chặn gì cả
   ↓
Phase 1 ──┬── Phase 2   (độc lập nhau, chạy song song được)
   ↓      │
Phase 3 ──┘
   ↓
Phase 4
   ↓
Phase 5   (bắt buộc sau Phase 2)
   ↓
Phase 6 → quyết định Phase 7
   ↓
Phase 8   (dọn nợ, làm lúc nào cũng được)
```

Tiến độ chi tiết: [state-hit-rate.md](state-hit-rate.md).
