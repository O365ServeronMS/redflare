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
`max-age=1800` trên response `HIT` dù Worker gửi `max-age=60`. Vẫn chặn bởi O1.

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
1800s. Việc này **vẫn chặn bởi O1** (cần quyền Zone Settings).

**Verify (đã chạy `node --check`, cần deploy để verify hết):**
- `worker/index.js` cú pháp hợp lệ.
- Sau deploy: mọi response `/api/*` (`hit`/`miss`/`warm`/`stale-vps-down`/lỗi)
  trả `cache-control` **không** còn `s-maxage`, có `stale-while-revalidate`
  (trừ nhánh lỗi tổng/4xx).
- Sau khi entry hết TTL (`max-age=60`), request kế tiếp trả `cf-cache-status:
  UPDATING` (không phải `EXPIRED`) — cần đợi >60s để test được.
- **Chưa verify được:** liệu Browser Cache TTL override 1800s ở zone có còn
  ghi đè `max-age=60` hay không (cần O1).

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
- **Chưa làm:** mở rộng warm set sang `/api/movie/:slug`. Không cấp thiết
  ngay — ngân sách write hiện đã dùng gần hết bởi 12 trang + 1 key meta +
  phần `meta:*`/`home:current`/`trending:*` khác; mở rộng cần tính lại số
  học trước (đặc biệt sau khi Phase 8 sửa con số `meta:*` sai trong CLAUDE.md
  từ ~111 thành 1.886 thật).

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

> **Ràng buộc quan trọng:** Worker **không thể** tự fetch hostname của chính nó
> (`phim.bluesia.net` → 522, đã ghi trong CLAUDE.md), và `SELF` service binding
> **đi vòng qua CDN** nên không làm nóng edge được. → **Warm `/api/*` bắt buộc
> phải gọi từ bên ngoài** (GitHub Actions). Warm **ảnh** thì Worker tự làm
> được, vì `img.bluesia.net` là hostname khác.

- ✅ **Ảnh** ([worker/lib/home.js](../worker/lib/home.js) `warmHeroImages`):
  sau mỗi lần `runHomeRefresh` thành công, fetch trực tiếp
  `https://img.bluesia.net/...` cho ~22 URL — 20 rail-thumb (`w154`, **mọi**
  lượt xem trang chủ đều load, không qua lazy-gate) + 2 backdrop đầu tiên
  (`w1280`, đúng số lượng `ensureBackdrop()` load ngay). Đây **chính là** tập
  ảnh bị đo là MISS ở baseline ban đầu (§1.2) dù có header `immutable` 1 năm
  — cố định TTL không giúp gì khi nguyên nhân là LRU evict, phải warm lặp
  lại. Cần **Phase 2 (Tiered Cache) đã bật** thì mới lan ra ngoài 1 colo,
  đúng như cảnh báo gốc.
- ✅ **`/api/*`**: thêm route công khai (không gate CRON_KEY, giống
  `/api/health` — chỉ lộ "đang warm trang nào", không có gì nhạy cảm)
  `GET /api/warm-targets` ([worker/index.js](../worker/index.js)
  `handleWarmTargets`) trả về URL đầy đủ của home-data + toàn bộ warm set
  hiện tại (đọc trực tiếp từ `getTopWarmTargets`, tự động theo kịp khi Phase
  4 đổi ranking — workflow không cần sửa khi warm set đổi). GitHub Actions
  workflow mới
  ([.github/workflows/edge-warm.yml](../.github/workflows/edge-warm.yml)),
  chạy phút `:05`/`:35` (5 phút sau tick `*/30` của Worker, đủ để KV có dữ
  liệu mới), gọi `/api/warm-targets` lấy danh sách rồi `curl` từng URL thật
  từ runner GitHub — request thật từ bên ngoài Cloudflare, nạp vào CDN edge
  đúng nghĩa "Cache Everywhere".

**Verify:** `node --check` 3 file pass. Chưa verify được ảnh hero trả HIT
ngay từ request đầu (cần đợi tick `runHomeRefresh` kế tiếp — hourly, tối đa
1 giờ); chưa verify được workflow GitHub Actions chạy thành công (phụ thuộc
token có scope `workflow` hay không — xem state-hit-rate.md).
**Rollback:** revert `worker/lib/home.js`/`worker/index.js`; xoá
`.github/workflows/edge-warm.yml` hoặc tắt trong tab Actions.

### Phase 6 — Đo lường tách theo class

Không thể lái một con số gộp. Cần tách A/B/C của §0.

- Dùng Cloudflare GraphQL Analytics API, tách theo hostname
  (`img.` vs `phim.`) và theo path prefix.
- Dựng baseline trước Phase 1 để mọi phase sau đo được delta.
- Bổ sung `/api/health`: đếm `miss` vs `hit` vs `warm` theo cửa sổ trượt.

### Phase 7 — *(tuỳ chọn, tốn tiền)* Cache Reserve

Chỉ mở ra khi Phase 0–6 xong và đã có số đo thật. Đây là **cách duy nhất** vượt
~95% zone-wide. Quyết định bằng số liệu Phase 6, không quyết trước.

### Phase 8 — Dọn nợ đã lộ ra khi khảo sát

- `stale` (D1) chưa có eviction — ADR-0001 Action Item 8, vẫn mở.
- KV còn rác: `home:last-known-good`, ~20 key `stale:*` từ thiết kế cũ.
- CLAUDE.md ghi "~111 `meta:*`" — thực tế **1.886**. Sửa lại, và tính lại budget
  KV write theo con số thật.

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
| **O1** | Cấu hình Browser Cache TTL override hiện tại của zone `bluesia.net` là gì, và tắt nó (chuyển "respect origin") được không? **Tôi không đọc/sửa được** — token wrangler chỉ có scope Workers/KV, các MCP Cloudflare khác chưa xác thực. Phạm vi đã thu hẹp: **không còn cần Cache Rules cho Edge TTL** (xem lời giải O3), chỉ còn đúng việc tắt override 1800s. | 1 (một phần) |
| ~~O2~~ | ~~Cron có thật sự fire không?~~ **Đã đóng ở Phase 0** — cron chạy đúng, xem [state-hit-rate.md](state-hit-rate.md). | — |
| ~~O3~~ | ~~Tầng `caches.default` có còn đáng giữ không?~~ **Đã trả lời** — giữ nguyên, không đổi gì; chỉ đổi header trả về client. Xem §6 Phase 1. | — |
| **O4** | Có sẵn sàng trả phí cho Cache Reserve nếu Phase 6 chứng minh trần Free là ~95%? | 7 |

> Về O1/O2: cần cấp thêm token Cloudflare (scope Zone: Cache Purge + Zone
> Settings + Analytics), hoặc xác thực MCP `cloudflare-api`/`cloudflare-observability`
> trong một phiên interactive (`claude mcp` / `/mcp`). Phiên hiện tại không chạy
> được OAuth flow.

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
