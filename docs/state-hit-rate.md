# State: nâng cache HIT rate của redflare

File tracking cho [plan-hit-rate.md](plan-hit-rate.md). **Cập nhật file này mỗi
khi một phase đổi trạng thái** — nó là nguồn sự thật về tiến độ, không phải git log.

**Bắt đầu:** 2026-08-06
**Trạng thái tổng:** 🟢 Phase 0–6, 8, 9 xong. **Cache đã hết là nút thắt** —
Phase 9 phân rã cho thấy miss cache THẬT của `phim.bluesia.net` chỉ **3,1%**
(6h window: HIT 83,2%, `/api/health` 6,7%, non-GET rác 3,8%, 5xx 3,1%).
Loại nhiễu giám sát + rác → **93,0%**; cộng sửa 5xx → **96,5%, vượt mục tiêu
95%**. `img.bluesia.net`: 404 chiếm 25% nhưng **không phải ảnh thiếu** — là
404 bị CDN cache lại từ thời backlog (60/60 key mẫu đều trả 200); purge sạch
→ trần ~98%. **Phase 7 — user bỏ qua** (tốn tiền).

**Phase 10 (đang làm):** user đã chạy L1 (Purge Everything) — đang phục
hồi. L5 (điều tra 504) tìm ra **cơ chế thật** (`enrich.js` timeout TMDB 8s ×
2 lần thử = tối đa 16s/item, worst-case 64s/trang) — nhưng cũng phát hiện
**con số "8,0%/1.789 lỗi" ở Phase 6/9 bị chính tôi làm nhiễu một phần** (IP
test của tôi chiếm 26% mẫu). Đo lại trên cửa sổ sạch: 504 thật **~11,4%** —
vấn đề có thật, không phải ảo giác đo lường, chỉ là con số cũ không đáng
tin. Chưa sửa `enrich.js` — cần xác nhận trước.

---

## Bảng phase

| Phase | Nội dung | Trạng thái | Ngày | Ghi chú |
|---|---|---|---|---|
| **0** | Khôi phục background refresh (cron chết) | 🟢 **Đóng — không phải sự cố** | 2026-08-06 | Chẩn đoán ban đầu sai, xem nhật ký bên dưới |
| **1** | Bỏ `s-maxage`, bật `stale-while-revalidate` | 🟢 **Deploy xong, verify production OK** | 2026-08-06 | Browser TTL override (O1) đã đóng — user tự xử lý |
| **2** | Bật Tiered Cache (Smart Topology) | 🟢 **Xong** | 2026-08-06 | User đã bật trên dashboard |
| **3** | Shard mirror drain + dọn ~1.200 ảnh tồn | 🟢 **Deploy xong** | 2026-08-06 | 5x throughput (100/tick thay vì 20/tick); backlog tự dọn dần |
| **4** | Warm set theo popularity (LRU) | 🟢 **Deploy xong** | 2026-08-06 | Bootstrap qua seed list cũ, chưa có dữ liệu popularity thật |
| **5** | Edge warming | 🟢 **Xong, chạy 100% trên CF** (giá trị `/api/*` thấp hơn dự kiến — chỉ nóng 1 colo, xem §6.5.2) | 2026-08-06 | Đã bỏ GitHub Actions + secret + O5 nhờ `global_fetch_strictly_public` |
| **6** | Đo lường tách theo class | 🟢 **Xong hoàn toàn — A/B/C đều đo được** | 2026-08-07 | Zone-wide thật: phim 76,8%, img 67,2% (so baseline 35%) |
| **7** | *(tuỳ chọn, tốn tiền)* Cache Reserve | ⚫ **Bỏ qua** — user quyết định | 2026-08-06 | Không triển khai |
| **8** | Dọn nợ khảo sát lộ ra | 🟢 **Xong** | 2026-08-06 | 90 KV key rác đã xoá, `stale` D1 có eviction, ADR-0001 đã đính chính |
| **9** | Phân rã miss thật | 🟢 **Xong (phân tích)** | 2026-08-07 | Miss cache thật chỉ 3,1% — cache hết là nút thắt; 4/6 đòn bẩy cần quyền bạn |
| **10** | L1 verify + L5 điều tra 504 | 🟡 **L1 đang phục hồi; L5 tìm ra cơ chế, chưa sửa** | 2026-08-07 | 504 thật ~11%, không phải nhiễu test; cần xác nhận trước khi sửa `enrich.js` |

Ký hiệu: ⚪ chưa bắt đầu · 🟡 đang làm · 🟢 xong · 🔴 chặn/sự cố · ⚫ bỏ

---

## Baseline đo được (2026-08-06 06:44–06:50 UTC)

Mọi phase sau đều so delta với bảng này. **Đừng sửa các số này** — thêm dòng mới
khi đo lại.

| Chỉ số | Baseline | Mục tiêu | Đo lại lần cuối |
|---|---|---|---|
| Zone-wide HIT% | **35%** (người dùng báo) | ≥93% | — |
| Ảnh `img.bluesia.net` HIT% | **~25%** (suy từ mô hình §2) | ≥90% | — |
| `/api/*` origin-build rate | không đo được | ≤0,1% | — |
| `mirror_queue` depth | **1.225** | ~0 | **1.055** (11:54, đang giảm) |
| `mirror` đầu queue kẹt | **497 phút** | <60 phút | — |
| `mirrored` trong 1h | **0** | >0 | **203** (11:54) |
| `mirrored` tổng | **3.494** | tăng dần | — |
| KV `page:v1:*` | **0 key** | 12–13 key | — |
| KV `home:current` | **KHÔNG TỒN TẠI** | tồn tại, <60 phút tuổi | — |
| KV `warm:last-run` | **KHÔNG TỒN TẠI** | tồn tại, <90 phút tuổi | — |
| KV `meta:*` | **1.886 key** | — (CLAUDE.md ghi sai là ~111) | **2.262 key** (Phase 8, đã sửa CLAUDE.md + ADR-0001) |
| D1 `stale` / `idx` / `recs` | 110 / 447 / 50 | — | — |
| `/api/health` | `ok: false`, 3 problems | `ok: true` | — |

Lệnh tái lập baseline:

```bash
curl -sS https://phim.bluesia.net/api/health | python3 -m json.tool
```

```bash
npx wrangler d1 execute redflare-db --remote --command "SELECT (SELECT COUNT(*) FROM mirrored) mirrored, (SELECT COUNT(*) FROM mirror_queue) queued, (SELECT COUNT(*) FROM stale) stale, (SELECT COUNT(*) FROM idx) idx, (SELECT COUNT(*) FROM recs) recs;"
```

---

## Nhật ký quyết định

### 2026-08-07 — Phase 10: L1 verify + L5 điều tra 504 — tự sửa sai của chính mình

**L1 (Purge Everything, user chạy 02:39:52 UTC):** verify ngay — 2/3 ảnh
từng 404-đóng-băng nay trả `200 MISS`; 1/3 vẫn 404 đúng (ảnh chết thật ở
upstream). `/api/health` vẫn `ok: true` ngay sau purge (D1/KV không bị
đụng, chỉ CDN cache bị xoá). Đo 20 phút sau purge: img HIT 47,5%, 404 còn
12,5% (từ 25%) — đang phục hồi, chưa phải số cuối, cần đợi cache re-warm
vài giờ.

**L5 (điều tra 504) — phát hiện quan trọng nhất: tự làm nhiễu chính phép đo
của mình.** Lọc 504 theo `clientIP` → **`167.253.158.19` chính là IP
outbound của môi trường tôi** (xác nhận qua `api.ipify.org`), chiếm 26%
lượng 504 trong cửa sổ 3h dùng để kết luận "1.789 lỗi thật" ở nhật ký Phase
6/9 trước đó. Nguyên nhân: suốt phiên làm việc này tôi liên tục gửi burst
request đồng thời (40, 15, 20 request...) để verify từng phase — traffic đó
lẫn vào chính cửa sổ đo lường.

**Không phải toàn bộ là nhiễu — 504 là vấn đề thật.** Đo lại trên cửa sổ 20
phút **hoàn toàn sạch** (bắt đầu 02:50:05 UTC, xác nhận zero request từ IP
tôi): **53/466 = 11,4%** lỗi 504, từ 2 IP độc lập request path duyệt web
bình thường — không phải tôi.

**Tìm ra cơ chế:** [worker/lib/enrich.js](../worker/lib/enrich.js)
`fetchWithTimeout` — 8s timeout + 1 retry = tối đa **16s/lần gọi TMDB**.
`CARD_CONCURRENCY=6` (trần nền tảng) → trang 24 item chạy 4 đợt tuần tự →
worst case `4×16s=64s` nếu mỗi đợt đều dính ≥1 lần gọi chậm/treo. Khớp với
biến động 5xx theo giờ đã ghi ở Phase 6 (39,5%→~2%→6-10%) — hình dạng của
"TMDB thỉnh thoảng chậm", không phải bug cố định. Không tái hiện được bằng
test đơn lẻ của tôi vì tail latency phụ thuộc thời điểm TMDB, không theo
yêu cầu.

**Không đo được thêm:** `originResponseDurationMs`/`edgeTimeToFirstByteMsP95`
— cả hai chỉ dành cho gói trả phí (xác nhận qua GraphQL introspection,
`does not have access to the field`).

**Đề xuất sửa, chưa triển khai (cần xác nhận trước khi đụng logic lõi):**
giảm timeout/bỏ retry TMDB, và — giá trị nhất — thêm **deadline tổng cho cả
lượt enrich** để một vài item chậm không kéo cả trang treo tới 64s.

**Bài học quy trình:** khi đo hiệu năng production bằng cách gửi test
traffic liên tục trong nhiều giờ, phải **lọc IP của chính mình** trước khi
kết luận số liệu — nếu không, kết luận "phát hiện lỗi thật" có thể một phần
là do chính hoạt động verify gây ra. Chi tiết đầy đủ +bảng số ở
[plan-hit-rate.md](plan-hit-rate.md) §10.

---

### 2026-08-07 — Phase 9: phân rã miss — cache KHÔNG còn là nút thắt

**Câu hỏi đặt ra:** "77,65%/66,08% vẫn xa 95%, cần giải pháp mạnh tay nào?"
**Kết quả phân rã đảo ngược tiền đề của câu hỏi** — chi tiết đầy đủ +
bảng số ở [plan-hit-rate.md](plan-hit-rate.md) §9.

**Phát hiện 1 — con số 24h bị nhiễm.** 77,65/66,08 gộp cả giai đoạn ~1.200
ảnh còn kẹt trong mirror queue (Phase 3 chỉ vừa dọn xong). Cửa sổ 6h:
phim **82,8%**, img **81,6%**. 5xx theo giờ giảm từ **39,5% → ~2%** trong
ngày, đúng theo tiến độ Phase 1–5 landing.

**Phát hiện 2 — miss cache THẬT của `phim.bluesia.net` chỉ 3,1%.**
Phân rã 6h (n=5.471): HIT 83,2% | `/api/health` 6,7% (`no-store` đúng thiết
kế) | non-GET rác 3,8% | 5xx 3,1% | **miss cache thật 3,1%**. Nghĩa là trên
phần traffic thật sự cacheable, cache đang chạy ~96–97% hiệu quả. Bỏ nhiễu
giám sát + rác khỏi mẫu số → **93,0%**; cộng sửa 5xx → **96,5%, vượt mục
tiêu 95%**.

**Phát hiện 3 — 404 của img KHÔNG phải ảnh thiếu, mà là 404 bị CACHE.**
Kiểm chứng: lấy mẫu **60 key ngẫu nhiên** từ D1 `mirrored` → **60/60 trả
200**. 4 key đang 404 trong analytics → **4/4 giờ trả 200**, kèm
`cf-cache-status: EXPIRED`. R2 trả 404 **không có `cache-control`** nên CDN
áp default TTL → 404 sinh ra thời backlog bị đóng băng ở edge kể cả sau khi
object đã vào R2. Purge sạch → trần img ≈ **98%**.

Ngoại lệ: **1 ảnh chiếm 62% lượng 404 gần đây** — chết thật ở upstream
(phimimg.com cũng 404), `mirrored:0, queue:0`, client fallback cũng 404.

**Quyết định: KHÔNG thêm cơ chế cache nào.** Với miss thật 3,1%, mọi giải
pháp "mạnh tay" kiểu Cache Reserve/thêm tầng cache đều nhắm sai chỗ — không
chạm được vào 6,7% health-check, 3,8% rác non-GET, hay 3,1% 5xx. Đòn bẩy
đúng (L1–L6) liệt kê ở plan §9.4; **4/6 cần quyền tôi không có** (token chỉ
Analytics Read — đã verify: purge trả `Authentication error`, đọc chi tiết
ruleset cũng bị từ chối).

---

### 2026-08-07 — O6 đóng: đo thật bằng GraphQL Analytics, phát hiện 504 mới

**User cấp token Cloudflare qua 2 lần thử.** Lần 1 (`cfat_...`) xác thực
thất bại (`Invalid API Token`, độ dài 53/48 ký tự đều không khớp chuẩn 40
ký tự của Cloudflare) — nghi là token của dịch vụ khác (biến tên
`MONITOR_CF_API_TOKEN`, khả năng thuộc `monitor.bluesia.net`). Lần 2
(`cfut_...`) xác thực **thành công** qua `/user/tokens/verify` — hoá ra
tiền tố `cfut_` (không phải `cfat_`) **là một phần hợp lệ của token**, độ
dài 53 ký tự tổng. Bài học: token Cloudflare hiện đại có thể có tiền tố
chữ, không phải luôn 40 ký tự thuần hex — đừng tự ý bóc tiền tố khi verify
lần đầu thất bại, thử nguyên chuỗi trước.

**Đo qua `api.cloudflare.com/client/v4/graphql`, dataset
`httpRequestsAdaptiveGroups`, group theo `clientRequestHTTPHost` +
`cacheStatus`, cửa sổ 24h trước đó (2026-08-06 02:05 → 2026-08-07 02:05
UTC):**

```
phim.bluesia.net   tổng 22.284   hit 74,7% + stale 2,1% = 76,8% HIT-like
img.bluesia.net    tổng  6.665   hit 67,2%
```

So với baseline 35% (báo cáo ban đầu, suy từ mô hình §2 — chưa từng đo
trực tiếp) — **tăng thật, đo trực tiếp, không phải suy diễn.** Đóng dứt
điểm câu hỏi "Đối với redflare có khả thi tăng HIT rate không?" từ yêu cầu
gốc: **có, và đã tăng thật** — dù chưa chạm mục tiêu lý thuyết 93% (đang đo
ở 24h đầu tiên sau khi cache mới "nóng" lại từ Phase 3 vừa dọn sạch queue).

**Phát hiện phụ, ngoài phạm vi ban đầu nhưng đáng ghi lại:** khi lọc theo
`edgeResponseStatus`, lộ ra **1.789 lỗi 504/502 thật trong 24h** (8,0% tổng
request `phim.bluesia.net`) — sau khi loại trừ 818 lỗi `503` của chính
`/api/health` (đúng thiết kế, không phải lỗi thật). Tập trung ở
`/api/list` (547), `/api/search` (294 lỗi 504 + 144 lỗi 502 — 502 khớp
đúng nhánh "catalog unavailable" chủ động của code), `/api/movie/*`,
`/api/genre`, `/api/home-data`. 504 nghĩa là **Cloudflare tự timeout** chờ
Worker/upstream — không phải Worker chủ động trả lỗi. **Chưa điều tra
nguyên nhân gốc** — việc này không thuộc phạm vi "đo lường Phase 6" ban
đầu, cân nhắc một phiên riêng (`/engineering:debug`) nếu muốn theo đuổi.

**Dọn dẹp:** token lưu tạm trong scratchpad (`/tmp/.../cf_token.txt`), chỉ
tồn tại trong phiên này, không commit vào repo. Token đầu tiên (không hợp
lệ) đã xoá ngay sau khi phát hiện lỗi.

---

### 2026-08-06 — Phase 6: origin-build rate đo được bằng code; Phase 7 bỏ qua

**User quyết định bỏ qua Phase 7 (Cache Reserve)** — tốn tiền, không cần bàn
thêm. Đóng O4.

**Phase 6 tách làm hai nửa rõ ràng, chỉ một nửa làm được:**

- ❌ **Chỉ số A/C (zone-wide HIT%, tách theo hostname `img.`/`phim.`)** —
  vẫn cần GraphQL Analytics API, vẫn không có quyền Zone Analytics trong
  suốt phiên này (đặt tên **O6**, khác O1 gốc — O1 là Zone Settings, đã
  đóng). Không giả được bằng cách nào khác vì đây là số liệu **CDN edge**
  giữ, Worker không nhìn thấy được (đúng như phát hiện ở Phase 5 §6.5.2:
  Worker không phải nơi đứng để đo cache HIT của chính zone).
- ✅ **Chỉ số B (origin-build rate)** — đo được **hoàn toàn bằng code**,
  không cần quyền gì thêm. Đây mới là chỉ số plan thật sự cam kết (§4:
  "≤0,1%"), khác A ở chỗ B là *Worker tự biết* — mỗi response đã tự gắn
  `x-catalog-cache`, chỉ cần đếm lại chính giá trị đó.

**Thiết kế bộ đếm — 1 điểm gọi, không đụng logic có sẵn:** thay vì chèn
tracking vào từng nhánh return của `handleApi`/`handleHomeData`/
`handleRecommendation` (nhiều điểm, dễ sót), đọc `x-catalog-cache` từ chính
`Response` đã trả về, tại **một chỗ duy nhất** trong `fetch()` — bọc quanh
lệnh gọi `handleApi`. Bảng D1 mới `cache_stats(bucket_hour, status, count)`
— **1 dòng mỗi (giờ, status)**, không phải 1 dòng/request, nên số dòng gần
như hằng số bất kể traffic (~7 status khả dĩ × 24h ≈ 168 dòng/ngày). Lấy
mẫu 1-trong-10 giống `trackPopularity` (Phase 4) — cùng logic: tỉ lệ vẫn
đúng dù ghi ít hơn.

`/api/health` giờ trả thêm `cache_stats`: `{window_hours: 24, sampled_total,
by_status: {...}, origin_build_rate}`. `origin_build_rate` tính từ tập
status KHÔNG cần build (`hit`, `warm`, `d1-recs`) so với tổng — mọi status
còn lại (`miss`, `miss-fallback`, `stale-vps-down`, response lỗi không có
header) đều thật sự chạm KKPhim/TMDB nên tính là "build".

**Trạng thái: migration đã apply, code đã deploy, verify production OK.**
Gửi 40 request `/api/list?type=phim-le` song song rồi kiểm tra
`/api/health`:
```json
"cache_stats": {"window_hours": 24, "sampled_total": 2,
  "by_status": {"hit": 1, "warm": 1}, "origin_build_rate": 0}
```
2/40 được lấy mẫu (~1-trong-10, đúng biên độ ngẫu nhiên kỳ vọng ~4).
`origin_build_rate: 0` tính đúng — cả hai status mẫu được (`hit`, `warm`)
đều thuộc tập không-cần-build. Cần vài giờ tích luỹ thêm mẫu qua traffic
thật mới có con số đại diện đầy đủ mọi route family.

**Tin tốt phát hiện cùng lúc, không thuộc phạm vi Phase 6:** `/api/health`
lần đầu trả `"ok": true, "problems": []` trong suốt phiên này —
`mirror.queued: 0`, `oldest_queued_min: 0`. Phase 3 (sharded mirror drain)
đã dọn sạch hoàn toàn backlog ~1.200 ảnh từ đợt đổi nguồn KKPhim.

---

### 2026-08-06 — Phase 8: dọn nợ

**Xoá 90 KV key rác** (không phải ~20 như plan ước tính ban đầu). Ba loại,
xác nhận `grep` toàn repo không code nào tham chiếu trước khi xoá:
- `stale:*` — 61 key. Dùng `wrangler kv bulk delete`.
- `live:*` — **28 key, chưa từng được nhắc tới trong khảo sát trước.** Cùng
  thế hệ thiết kế với `stale:*`/`home:last-known-good` (namespace
  `/api/recommendation/*`, hẳn là bản trước khi D1 `recs` table thay thế).
- `home:last-known-good` — 1 key.

**Thêm eviction cho `stale` (D1)**, đóng ADR-0001 Action Item 8:
`worker/index.js` `cleanupStaleTable` — xoá row `updated_at` cũ hơn 90 ngày,
chạy cùng cron hourly với `cleanupRecTables` (`idx`/`recs`). 90 ngày = 2×
ngưỡng 45 ngày của `idx`, vì `stale` là tầng disaster-fallback hiếm dùng
hơn. Bảng hiện chỉ có 52 row, tất cả mới — cơ chế chưa có gì để chứng minh
ngay, sẽ tự thấy tác dụng khi bảng già đi.

**Sửa số `meta:*` sai — và đo sâu hơn yêu cầu ban đầu.** Không chỉ đếm lại
(1.886 ở Phase 0 → **2.262** giờ, tiếp tục tăng), mà dùng trường
`expiration` của mỗi key (TTL cố định 14 ngày → `created_at = expiration -
14d`) để tính **write RATE thật**, không chỉ key count:

```
749 write trong 24h qua
đỉnh ~1.480/ngày (ước tính) trong khung 6-12h
write mới nhất: 3,7 giờ trước lúc đo (rate đã về ~0/giờ)
```

Toàn bộ burst trùng khớp thời điểm đổi nguồn KKPhim hôm nay (mọi thẻ phim
cần enrich lại theo TMDB id mới). **Phát hiện quan trọng:** ngân sách burst
gốc ADR-0001 dành cho `meta:*` (100/ngày) **thấp hơn thực tế đo được tới
~15 lần**. Cộng với ngân sách đã cam kết cho warm set (tới 624/ngày ở N=13)
+ subtotal khác (~32/ngày) = ~656/ngày đã đặt trước — một lần đổi nguồn
catalog khác trùng ngày với chu kỳ warm có thể **thật sự vượt trần
1.000/ngày**, không còn là giả thuyết. Đã ghi chi tiết đầy đủ (số liệu +
phép tính) như một addendum có ngày trong
[ADR-0001](adr/0001-caching-topology.md) — không sửa đè số cũ, giữ nguyên
lịch sử quyết định ban đầu.

**Cập nhật checklist Action Items của ADR-0001 theo trạng thái thật:** 6/8
mục đã xong (1,2,3,4,5,6,8 — một số vốn đã xong từ trước mà chưa tick, như
mục 6 warm cron reporting). Chỉ còn Item 7 (đo ngân sách request của Option
E / Workers Caching) vẫn mở, không thuộc phạm vi plan này.

---

### 2026-08-06 — Phase 5 viết lại: bỏ GitHub Actions, chạy trên chính Cloudflare

**Giả thuyết được nêu:** "CF cũng có tính năng Workflows riêng nên cấm từ
GitHub qua." → **Không đúng**, và bằng chứng đã có sẵn trong chính log lỗi:

- Trang 403 trả về là **managed challenge** của bot management
  (`cType: 'managed'`, script từ `challenges.cloudflare.com`) — luồng chấm
  điểm bot, không phải luật chặn theo sản phẩm/đối thủ.
- Cùng một request y hệt, từ IP khác (môi trường của tôi) → `200`. Nếu là
  chặn GitHub có chủ đích thì phải chặn theo dải IP bất kể nội dung.
- Cloudflare Workflows là sản phẩm **bạn deploy lên**, không tham gia vào
  việc lọc traffic **đi vào** zone. Hai thứ không liên quan nhau.
- Nguyên nhân thật: dải IP GitHub Actions dùng chung cho hàng triệu job CI
  (có cả scraper/abuse) → điểm uy tín bot thấp → bị challenge. Chuyện thường
  gặp với mọi CI runner, không riêng Cloudflare.

**Nhưng hướng đi thì đúng.** Ý "đưa việc này về chạy trên CF" là hướng tốt —
chỉ là công cụ đề xuất (Workflows) không phải công cụ đúng:

- **Cloudflare Workflows** là engine *durable multi-step execution* (retry,
  giữ state qua nhiều bước, chạy dài). Việc cần làm là "bắn 13 GET mỗi 30
  phút" — dùng Workflows là dao mổ trâu.
- Quan trọng hơn: **Workflows cũng KHÔNG tự giải quyết vấn đề gốc.** Workflow
  chạy trên Workers runtime nên fetch tới `phim.bluesia.net` vẫn vướng đúng
  giới hạn same-zone. Nó cần đúng cái flag bên dưới — flag mới là thứ gỡ
  khoá, không phải Workflows.

**Giải pháp thật: compatibility flag `global_fetch_strictly_public`.**
Tìm ra khi tra doc Error 522 — chính doc Cloudflare chỉ thẳng flag này là
cách xử lý cho "fetch to its own hostname". Sau khi bật: *"requests to a
Worker's own zone will loop back to the 'front door' of Cloudflare and will
be treated like a request from the Internet"* → đi qua đúng đường CDN → **nạp
được edge cache**, đúng thứ edge-warming cần.

Soát bán kính ảnh hưởng trước khi bật (bảng đầy đủ ở
[plan-hit-rate.md](plan-hit-rate.md) §6.5.1). Điểm an toàn then chốt:
**`env.SELF` service binding KHÔNG bị ảnh hưởng** — doc nói rõ service
binding *"without going through a publicly-accessible URL"*, còn flag chỉ chi
phối **global** `fetch()`. Nhờ vậy toàn bộ fan-out shard home/warm/mirror
(thứ mọi cron phụ thuộc) chạy y nguyên.

**Thay đổi:** `wrangler.toml` thêm `compatibility_flags`;
[worker/lib/warm.js](../worker/lib/warm.js) thêm `runEdgeWarm()` +
`callEdgeWarm()`, gọi cuối `runWarmRefresh` **sau** khi KV đã mới (warm edge
trước sẽ cache lại body cũ thêm nguyên TTL);
[worker/index.js](../worker/index.js) thêm route `/__cron/edge-warm` (một
invocation riêng, ngân sách subrequest riêng — đúng pattern shard sẵn có).

**Thu được:** bỏ hẳn phụ thuộc GitHub Actions, bỏ secret `EDGE_WARM_KEY`,
và **O5 (WAF Custom Rule) không còn cần** — không còn request nào từ IP
GitHub để bị challenge. Ít bộ phận chuyển động hơn hẳn cả hai phương án
trước.

**Verify (tick 09:00 UTC, đã chạy thật):**
```
warm:last-run → edgeRequested: 13, edgeWarmed: 13
```
Cả 13 self-fetch trả 200. Nếu flag không hoạt động thì phải là 522 và
`edgeWarmed: 0`. → **Flag hoạt động, xác nhận Worker tự fetch được hostname
của chính nó.** Đã gỡ `.github/workflows/edge-warm.yml` và xoá GitHub secret
`EDGE_WARM_KEY`.

**Nhưng đo tiếp thì thấy điều ngược với giả định — ghi lại đầy đủ:**

| URL (nằm trong 13 URL vừa warm lúc 09:01) | Đo từ SIN ngay sau đó |
|---|---|
| `/api/country?slug=trung-quoc&page=1` | **không có `cf-cache-status`**, `x-catalog-cache: warm` |
| `/api/genre?slug=tam-ly&page=1` (lần 1) | **không có `cf-cache-status`**, `x-catalog-cache: warm` |
| `/api/genre?slug=tam-ly&page=1` (lần 2) | `cf-cache-status: HIT`, age 24 |

Edge cache ở SIN được nạp bởi **request của chính tôi**, không phải bởi
edge-warm → **edge-warm chỉ nạp đúng colo nơi cron chạy**. Lý do Tiered Cache
không cứu được: nó dựng tầng trên cho *origin fetch*, mà với Worker chạy trên
route thì **Worker chính là origin**, thực thi ngay tại colo nhận request —
không có origin fetch nào để tier. Tiered Cache vẫn giúp `img.bluesia.net`
(R2 là origin thật), nhưng không giúp `/api/*`.

**Không phải hồi quy do đổi sang CF:** phương án GitHub Actions cũ vướng đúng
giới hạn này (runner ở vài region Mỹ → chỉ nạp colo Mỹ, không phải SIN nơi
người dùng thật ở). Hai phương án giá trị ngang nhau ở khoản này; CF chỉ đơn
giản hơn. Chi tiết ở [plan-hit-rate.md](plan-hit-rate.md) §6.5.2.

**Điểm sáng thật sự trong cùng phép đo:** `x-catalog-cache: warm` nghĩa là
tầng KV warm set (Phase 4) đang phục vụ toàn cầu **không cần build upstream**
— đúng chỉ số B mà plan cam kết (origin-build rate ≤0,1%). Tầng KV mới là thứ
làm việc chính; edge cache bên trên chỉ là phần thêm.

**Kiểm tra thêm — ảnh hero:** 2 URL để dành (chưa từng tự request) trả HIT
với `age: 5426` (~90 phút), tức nạp lúc ~07:31 — **trước** khi Phase 5 deploy
(~08:1x). Nên đây là do traffic thật làm nóng, **chưa chứng minh được**
`warmHeroImages` có tác dụng hay không. Cần một ảnh hero mới xuất hiện trong
payload để đo sạch.

---

### 2026-08-06 — O1 phần Browser Cache TTL: user đã tự xử lý

User xác nhận đã chuyển Browser Cache TTL trên dashboard sang "respect
existing headers" (tương đương "respect origin" trong ADR-0001/plan). Phần
còn lại của O1 (Cache Rules cho Edge TTL) đã không còn cần thiết từ quyết
định O3 ở Phase 1 — nghĩa là **O1 coi như đóng** cho mục đích của plan này.
Chưa tự verify lại bằng curl (không có gì mới để đo — thay đổi này ảnh hưởng
browser cache, không đổi response header quan sát được qua curl).

### 2026-08-06 — Phase 5: edge warming

**Thay đổi:**
- [worker/lib/home.js](../worker/lib/home.js) — thêm `heroImageWarmUrls()` +
  `warmHeroImages()`, gọi cuối `runHomeRefresh()` sau khi ghi KV thành công.
  Warm ~22 URL: 2 backdrop `w1280` đầu (khớp `ensureBackdrop()`) + 20 rail
  thumb `w154` (khớp `HeroSlider.js` `toRailSize()`, mọi lượt xem đều load).
- [worker/lib/warm.js](../worker/lib/warm.js) — export `getTopWarmTargets`
  (trước là hàm nội bộ).
- [worker/index.js](../worker/index.js) — thêm route công khai (không gate
  CRON_KEY) `GET /api/warm-targets`, trả URL đầy đủ của home-data + warm set
  hiện tại.
- [.github/workflows/edge-warm.yml](../.github/workflows/edge-warm.yml) —
  workflow mới, chạy `:05`/`:35` mỗi giờ, gọi `/api/warm-targets` rồi curl
  từng URL thật.

**Quyết định thiết kế: `/api/warm-targets` không gate CRON_KEY.** Giống tiền
lệ `/api/health` (comment gốc: "exposes counts only") — endpoint này chỉ lộ
"đang warm trang nào", không có gì nhạy cảm, và để ungate thì GitHub Actions
workflow không cần biết `CRON_KEY` (không cần thêm GitHub Secret nào).

**Quyết định: warm ảnh nằm trong Worker, warm `/api/*` nằm ngoài (GitHub
Actions).** Bắt buộc bởi giới hạn nền tảng: Worker fetch chính hostname của
nó (`phim.bluesia.net`) luôn trả 522 (đã ghi trong `wrangler.toml`), và
`SELF` service binding đi thẳng vào handler, bỏ qua CDN — cả hai cách nội bộ
đều không thể nạp vào edge cache thật. `img.bluesia.net` là hostname khác
nên Worker fetch nó bình thường, không bị 522.

**Xảy ra đúng như lo ngại:** push bị GitHub từ chối —
`refusing to allow an OAuth App to create or update workflow
.github/workflows/edge-warm.yml without workflow scope`. Token hiện tại
(`gh auth status`) chỉ có `gist, read:org, repo`, thiếu `workflow`.

**Xử lý:** tách commit — phần Worker (warm ảnh trong `home.js`, endpoint
`/api/warm-targets`) **không phụ thuộc** GitHub Actions nên push/deploy bình
thường. File `.github/workflows/edge-warm.yml` giữ nguyên trên đĩa
(untracked, chưa commit) — cần **user tự thêm** bằng một trong hai cách:
1. `gh auth refresh -s workflow` rồi để tôi push lại, hoặc
2. Tự `git add .github/workflows/edge-warm.yml && git commit && git push` từ
   máy user (token cá nhân thường có sẵn scope `workflow`).

File đã sẵn sàng tại `.github/workflows/edge-warm.yml`, không cần viết lại —
chỉ cần commit+push nó. Cho tới lúc đó, nửa ảnh của Phase 5 hoạt động bình
thường; nửa `/api/*` (warm edge cho JSON) chưa có gì gọi
`/api/warm-targets` — endpoint đã sẵn sàng, chỉ thiếu người gọi định kỳ.

**Verify production (sau deploy 08:1x UTC):** `/api/warm-targets` trả `200`
ổn định qua nhiều lần gọi, đúng shape — và danh sách trả về đã trộn đúng
seed + dữ liệu popularity thật (`/api/genre?slug=tam-ly&page=1` xuất hiện —
chính là URL tôi test ở Phase 4, xác nhận `getTopWarmTargets` hoạt động
đúng end-to-end). Có một khoảng ngắn ngay sau deploy trả `404 {"error":"Not
found"}` — deploy propagation lag giữa các colo, tự hết sau vài giây, không
phải lỗi.

Chưa verify được: ảnh hero trả HIT ngay từ colo lạ (cần đợi tick
`runHomeRefresh` kế tiếp, tối đa 1 giờ vì cron này chạy hourly).

### 2026-08-06 — Chặn mới phát hiện: Cloudflare bot challenge chặn GitHub Actions

**User đã cấp `workflow` scope, đã add + push `.github/workflows/edge-warm.yml`
thành công.** Chạy thử bằng `gh workflow run` → **fail**:
```
jq: parse error: Invalid numeric literal at line 1, column 10
```
Thêm log debug rồi chạy lại → lộ nguyên nhân thật: `/api/warm-targets` trả
**403 "Just a moment..."** — trang managed challenge (bot protection) của
Cloudflare, dành riêng cho IP của GitHub Actions runner. Cùng lúc, curl từ
môi trường của tôi (IP khác) vẫn trả `200` bình thường — xác nhận đây là
**chấm điểm bot theo uy tín IP** (IP dùng chung của GitHub Actions bị nhiều
bot/scraper khác lạm dụng nên điểm thấp), không phải chặn toàn bộ `curl`.

**Không tự sửa được** — đây là cấu hình WAF/Bot Management ở cấp **Zone**,
xảy ra ở edge **trước khi** request chạm tới Worker, nên không có cách nào
sửa bằng code. Cùng nhóm với O1 (cần quyền Zone dashboard).

**Đã chuẩn bị sẵn phần tôi làm được:**
1. Tạo secret ngẫu nhiên, lưu vào GitHub Actions secret `EDGE_WARM_KEY`
   (`gh secret set`, đã xác nhận tồn tại qua `gh secret list`).
2. Sửa `.github/workflows/edge-warm.yml`: mọi request giờ gửi kèm header
   `x-edge-warm-key: <secret>`.
3. Worker **không** đọc/kiểm tra header này — nó chỉ để **WAF Custom Rule**
   nhận diện và bỏ qua bot-challenge cho đúng traffic của workflow này.

**Việc còn lại — cần user tạo 1 WAF Custom Rule trên dashboard** (Security →
WAF → Custom rules → Create rule), trên zone `bluesia.net`:
- **When incoming requests match:**
  `(http.request.uri.path contains "/api/" and http.request.headers["x-edge-warm-key"][0] eq "f38dd27b51a8fac9a5236ceb398dbe50fb1df11a86a70a0e")`
- **Then:** action **Skip** → tick tất cả các mục sẵn có (Bot Fight Mode /
  Super Bot Fight Mode / Managed Rules / Rate limiting — tuỳ mục nào đang
  bật trên zone, không chắc mục nào đang gây challenge cụ thể nên tick hết
  cho chắc, an toàn vì chỉ áp dụng cho request có đúng secret header này).
- Giá trị secret giống hệt giá trị đã lưu trong GitHub Actions secret
  `EDGE_WARM_KEY` — không cần đổi gì thêm ở phía code/CI sau khi tạo rule.

Sau khi tạo rule, chạy `gh workflow run "Edge warm"` để verify lại.

---

### 2026-08-06 — Phase 4: warm set theo popularity

**Thay đổi:** migration mới
[migrations/0003_popularity.sql](../migrations/0003_popularity.sql) (bảng
`popularity(path, hits, last_seen)`), đã `apply --remote` lên D1 production.
[worker/index.js](../worker/index.js) — thêm `trackPopularity()`, gọi ở đầu
`handleApi` (đếm mọi request list/genre/country, cả hit lẫn miss, lấy mẫu
1-trong-10, chặn ở `page ≤ 10`). [worker/lib/warm.js](../worker/lib/warm.js)
— viết lại: `WARM_TARGETS` (mảng tĩnh) → `getTopWarmTargets()` (truy vấn D1
DESC theo `hits`, lấp chỗ trống bằng `SEED_TARGETS` — chính là danh sách tĩnh
12 trang cũ, giữ lại làm hàng dự phòng); thêm `evictStaleWarmKeys()` (LRU).

**Quyết định thiết kế quan trọng nhất: không xoá danh sách tĩnh cũ, biến nó
thành seed/fallback.** Nếu chuyển thẳng sang 100% dữ liệu D1 mà không có
fallback, deploy đầu tiên (bảng `popularity` rỗng) sẽ khiến
`getTopWarmTargets` trả về mảng rỗng → LRU eviction xoá sạch 12 `page:v1:*`
key đang warm ngay lập tức, trong khi dữ liệu thật cần nhiều chu kỳ để tích
luỹ đủ N=12 dòng có ý nghĩa. Giải pháp: D1 top-N được ưu tiên trước
(`ORDER BY hits DESC`), phần còn thiếu mới lấp bằng seed — seed không tham
gia sắp hạng theo `hits` nên tự động bị dữ liệu thật đẩy ra khi đủ điều
kiện, không cần thao tác thủ công nào.

**Quyết định: partition SELECT lại theo mỗi shard, không truyền qua HTTP
body.** Giống pattern `home.js`/`warm.js` sẵn có — mỗi lần gọi
`/__cron/warm-shard/:n` là một invocation độc lập, tự truy vấn D1 top-N rồi
lấy phần tử thứ `n`. Có rủi ro nhỏ: nếu ranking đổi giữa lúc shard 0 và shard
11 gọi (vài giây), có thể lệch — chấp nhận được vì chu kỳ 30 phút tự làm lại
từ đầu mỗi lần, không cộng dồn sai số.

**Quyết định: LRU eviction dùng `KV.list()` (read), không dùng bookkeeping
key riêng.** Đơn giản hơn (không cần lưu trạng thái "danh sách cũ" giữa các
chu kỳ) và tự lành nếu một chu kỳ trước ghi bookkeeping thất bại.
`KV.list()` tính vào ngân sách đọc 100k/ngày, tách biệt hoàn toàn với ngân
sách ghi 1.000/ngày vốn là thứ chặn N=12 — xoá không tốn gì thêm.

**Chưa mở rộng sang `/api/movie/:slug`** như plan gốc gợi ý "nếu budget cho
phép" — chưa xác nhận budget thật còn dư bao nhiêu (con số `meta:*` trong
CLAUDE.md sai 17× so với thực tế đo được ở Phase 0, chưa sửa — xem Phase 8),
nên không mở rộng cho tới khi có số đúng.

**Trạng thái: migration đã apply, code đã deploy (08:04:17 UTC), verify
production OK.** Gửi 12 request `/api/genre?slug=tam-ly&page=1` song song rồi
kiểm tra D1 — bảng `popularity` đã có dòng thật:
```
path: /api/list?type=phim-moi-cap-nhat&page=1   hits: 1
path: /api/genre?slug=tam-ly&page=1             hits: 1
```
(chỉ 2 dòng dù gửi 12 request tới cùng 1 URL — đúng thiết kế lấy mẫu
1-trong-10, và dòng thứ hai đến từ traffic thật khác trong lúc chờ deploy).
Xác nhận `trackPopularity` chạy đúng end-to-end: canonical cache key đúng
định dạng, `hits`/`last_seen` đúng shape.

Ngay sau deploy, hành vi warm set **không đổi** so với trước (toàn bộ 12 slot
vẫn là seed cũ, vì D1 chưa đủ N=12 dòng có ý nghĩa) — đúng như thiết kế
bootstrap, không phải bug. Chưa verify được ranking thật sự dịch chuyển theo
traffic hay `x-catalog-cache: warm` phản ánh đúng trang mới — cần nhiều chu
kỳ `*/30` để tích luỹ đủ mẫu.

---

### 2026-08-06 — Phase 3: shard mirror drain

**Thay đổi:** [worker/lib/mirror.js](../worker/lib/mirror.js) — tách logic xử
lý per-row ra hàm dùng chung `drainRows(env, rows)`; thêm
`drainMirrorQueueShard(env, n)` (đọc một phần của hàng đợi) và
`runMirrorRefresh(env)` (orchestrator gọi 5 shard song song qua
`env.SELF`, cùng pattern `home.js`/`warm.js`). Xoá hàm `drainMirrorQueue`
đơn (single-shot) cũ — không còn nơi nào gọi nó sau khi thay thế, giữ lại là
dead code với comment sai sự thật nên xoá luôn thay vì để lại.
[worker/index.js](../worker/index.js) — thêm route
`/__cron/mirror-shard/:n`; `/__cron/mirror` (cron `*/10` + trigger tay) đổi
sang gọi `runMirrorRefresh` thay vì drain đơn.

**Quyết định thiết kế: partition theo `rowid % 5`, không phải `OFFSET`.**
Một hàng đợi FIFO dùng chung, nếu chia theo `OFFSET n*20` sẽ sai dưới ghi/xoá
đồng thời — khi shard 0 xoá xong các hàng nó xử lý, mọi hàng phía sau dịch
trái, khiến `OFFSET` của shard 1 đọc trúng hàng đã dịch vào phạm vi shard 0,
bỏ sót hoặc đọc trùng. `rowid % 5` ổn định: một hàng luôn thuộc đúng 1 shard
suốt vòng đời của nó trong hàng đợi, bất kể shard khác ghi/xoá gì.
`mirror_queue` không có `INTEGER PRIMARY KEY` (PK là `key TEXT`) nhưng SQLite
vẫn tự gán `rowid` ngầm định trừ khi khai báo `WITHOUT ROWID` — bảng này
không khai báo, nên lọc theo `rowid` an toàn.

**Verify trước khi deploy** (không có CRON_KEY để test route đầy đủ qua
`wrangler dev --remote`, vì `env.SELF` ở chế độ `--remote` trỏ thẳng vào
Worker **production**, không phải bản dev — nên `runMirrorRefresh` không thể
test full round-trip cục bộ khi route mới còn chưa có trên production):
- Route `/__cron/mirror-shard/0` tồn tại và bị chặn đúng bởi CRON_KEY (404
  với key sai) — xác nhận qua `wrangler dev --remote` cục bộ.
- Query `rowid % 5` chạy thật trên D1 production: phân bố đều
  246/245/246/248/249 trên 5 shard (~1.234 hàng lúc đo) — không lệch.
- `node --check` cả hai file pass.

**Trạng thái: đã commit, push `origin main`, deploy.** Ngân sách subrequest
không đổi so với trước (mỗi shard vẫn xử lý tối đa `MIRROR_BATCH=20` hàng,
y hệt batch size của drain đơn cũ) — cải thiện đến từ TẦN SUẤT (5 lần/tick
thay vì 1 lần/tick), không phải từ tăng kích thước batch mỗi invocation, nên
không tăng rủi ro chạm trần 50 subrequest/invocation so với hành vi đã chạy
ổn định trong production trước đó.

**Verify sau deploy (07:34:36 UTC):**
- Route `/__cron/mirror-shard/0` trả `404 text/plain` (đúng — bị `checkCronKey`
  chặn vì không gửi header) thay vì `200 text/html` (SPA fallback của code cũ,
  do route chưa tồn tại) — xác nhận deploy mới đã lên, route đã đăng ký đúng
  vị trí (trước nhánh `ASSETS.fetch` fallback).
- `mirrored_last_hour` tăng dần qua các lần đo: 40 (trước Phase 3) → 100
  (07:36) → 122 (07:41, 07:48 — ổn định, đúng vì chưa có tick `*/10` mới nào
  giữa hai lần đo này, tick kế tiếp là 07:50).
- `mirrored_total`: 3.524 (07:02, trước Phase 3) → 3.606 (07:41–07:48).
- `mirror.queued` dao động 1.297→1.311 — **chưa thấy giảm rõ**, vì traffic
  thật liên tục enqueue ảnh mới song song (mỗi build KKPhim mới lại thêm
  target). Số cần nhìn là `mirrored_last_hour`, không phải `queued` tuyệt đối.

**Chưa đo được:** một delta "1 tick sạch" dưới code sharded mới (cần đợi qua
tick 07:50 rồi so `mirrored_total`) để xác nhận đúng ~100/tick thay vì ~20-30/
tick cũ — phiên làm việc dừng lại trước khi tick đó xảy ra, không muốn block
lâu thêm. `/api/health` vẫn `ok:false` nhưng lý do là "mirror queue head stuck
217min" — **không phải lỗi**, đúng theo thiết kế `MAX_RETRY_AGE_MS=6h`
(360 phút), 217 phút vẫn trong ngưỡng bình thường (xem Phase 0 log về cơ chế
này). Người dùng có thể tự `curl .../api/health` sau vài tick nữa để xác nhận
`queued` bắt đầu giảm rõ.

---

### 2026-08-06 — Phase 1: triển khai, O3 trả lời được không cần Cache Rule

**Thay đổi:** [worker/index.js](../worker/index.js) — thêm `clientCacheControlFor(pathname)`,
dùng nó cho **response trả về client** ở 4 route (`handleHomeData`,
`handleRecommendation`, `warmKvLookup`, nhánh build trong `handleApi`) +
rút ngắn `max-age` các nhánh lỗi (60→30, bỏ `s-maxage=30` ở nhánh 502, đổi
`stale-vps-down` sang `max-age=30, stale-if-error=86400`).

**Quyết định thiết kế quan trọng nhất của phase này — trả lời O3:** ban đầu
dự tính dùng Cache Rule để set Edge TTL tĩnh cho zone CDN. **Sai** — điều đó sẽ
xoá mất hệ tier 30d/6h/1h của recommendation (`classifyTier`/`ttlForTier`),
vì một Cache Rule áp cố định theo path, không biết gì về nội dung response.
Giải pháp đúng: **`caches.default` giữ nguyên 100%** (vẫn `s-maxage=<ttl>`
như cũ) — tầng đó vốn không hỗ trợ SWR nên giữ `s-maxage` không mất gì; chỉ
đổi **response trả về client** (đối tượng `Response` thứ hai, cùng `body`
nhưng header khác) sang scheme mới. Hai `Response` khác nhau cho hai tầng
cache khác nhau, từ cùng một lần build — không cần deploy Cache Rule nào cả.

**Xác nhận qua doc Cloudflare trong lúc triển khai:**
- *"s-maxage disables stale-while-revalidate"* — xác nhận trực tiếp lý do gốc
  của Phase 1.
- *"Cache API... not supported when using cache.match or cache.put"* (cho
  SWR) — xác nhận giữ nguyên `caches.default` không mất gì.
- *"Free, Pro, and Business customers have [Origin Cache Control] enabled by
  default and cannot disable it"* — nghĩa là phần điều kiện tiên quyết "xác
  nhận Origin Cache Control đang bật" trong kế hoạch ban đầu **đã tự động
  thoả**, không cần làm gì thêm.

**Phạm vi còn lại của O1 thu hẹp:** không còn cần Cache Rules cho Edge TTL
nữa. Chỉ còn một việc dashboard duy nhất: zone đang override
`max-age=1800` bất kể Worker gửi gì (quan sát trong ADR-0001 và xác nhận lại
ở baseline §1.1 của plan) — cần chuyển Browser Cache TTL/Cache Rule đó sang
"respect origin" để `max-age=60` mới thật sự có tác dụng ở trình duyệt.

**Trạng thái: đã commit (`2aebc08`), push `origin main`, deploy xong, verify
production OK.** Fast-forward qua 1 commit mới trên `origin/main`
(`7ae7104`, sửa `worker/lib/recommendation.js`, không đụng `worker/index.js`
— merge sạch, không conflict) trước khi commit.

Verify production (curl trực tiếp sau deploy):
```
/api/list?type=phim-le&page=2 (miss)
  → cache-control: public, max-age=60, stale-while-revalidate=3600, stale-if-error=86400
/api/movie/bach-ho-diep (miss)
  → cache-control: public, max-age=60, stale-while-revalidate=7200, stale-if-error=86400
/api/search?keyword=rong&page=3 (miss)
  → cache-control: public, max-age=60, stale-while-revalidate=600
/api/movie/khong-ton-tai-xyz (404)
  → cache-control: public, max-age=30
```
Đúng như thiết kế cho mọi route family. `/api/home-data` vẫn trả header cũ
(`max-age=1800, s-maxage=1800`) ngay sau deploy — **đúng như dự kiến**: đó là
entry `caches.default` được ghi TRƯỚC deploy này, chưa hết TTL (tối đa 30
phút) nên chưa rebuild qua code mới. Tự lành, không cần hành động — sẽ đổi
header khi entry đó tự hết hạn.

**Chưa verify được** (cần đợi >60s để entry hết `max-age=60` mới thử):
`cf-cache-status: UPDATING` thay vì `EXPIRED` sau khi hết TTL, và liệu
Browser Cache TTL override 1800s ở zone có còn ghi đè `max-age=60` hay không
(vẫn cần O1).

---

### 2026-08-06 — Phase 0: chẩn đoán lại, KHÔNG phải sự cố

**Kết luận ngược lại với khảo sát ban đầu.** Chẩn đoán "3 cron đều chết" ở lần
đo đầu (06:44–06:51 UTC) là **sai**, vì lý do timing: bản deploy gần nhất là
06:45:50 UTC, tức là lúc đo nằm đúng trong khung "chưa tới tick kế tiếp"
(hourly + `*/30` cùng chạy ở `:00`, tức 07:00 UTC — gần 15 phút sau lần đo).
`home:current`/`warm:last-run` "không tồn tại" ở thời điểm đó chỉ phản ánh
"chưa có tick nào chạy sau deploy", không phải cron bị hỏng.

**Bằng chứng đảo ngược kết luận**, đo lại 07:01–07:04 UTC (~15 phút sau tick
07:00):

```
/api/health (07:01:55):
  home: age_min = 1        ← vừa refresh thành công
  warm: age_min = 1, written = 12, skipped = 0, failed = 0   ← 12/12 key ghi OK
  mirror: mirrored_last_hour = 40   ← đang drain, không phải 0 nữa
```

```
mirrored_total: 3.494 (06:48) → 3.524 (07:02, +30 trong 14 phút) → tiếp tục tăng
```

**Điều tra riêng "mirror queue kẹt 497 phút"** — cũng không phải kẹt, mà đúng
thiết kế: hàng đợi có `MAX_RETRY_AGE_MS = 6 giờ` ([mirror.js:215](../worker/lib/mirror.js#L215))
— một dòng cứ trả `retry` liên tục quá 6 tiếng sẽ bị **chủ động drop** để không
chặn đầu hàng đợi (dòng mới nhất tham chiếu key đó sẽ tự enqueue lại ở cuối).
Đo lại `MIN(queued_at)` của hàng đợi: dòng cũ nhất bây giờ được enqueue lúc
**2026-08-06 04:11:47 UTC** — tức tuổi thật là **~2,9 giờ**, chưa chạm ngưỡng
6 giờ, và **mới hơn nhiều** so với dòng cũ nhất ở lần đo trước (~22:31 UTC hôm
trước). Cơ chế expiry đã hoạt động đúng như thiết kế giữa hai lần đo.

**Kiểm tra riêng nhóm KKPhim (100 dòng, host `phimimg.com`)** — nghi ngờ ban
đầu (wsrv.nl chặn `phimimg.com`) **đúng nhưng không phải nguyên nhân kẹt**:
`mirrorOne` đã gate đúng — `isKkphim` bỏ qua wsrv.nl cho key `kkphim/*`, fetch
thẳng origin. Test thật một URL mẫu (`bach-ho-diep-poster.webp`) → origin trả
`200, image/webp, content-length` bình thường, R2 chưa có object này (đúng —
đang chờ tới lượt FIFO). Không có gì sai ở nhánh này, chỉ là chưa tới lượt.

**Nguyên nhân thật của backlog ~1.200 ảnh: throughput, không phải lỗi.**
`MIRROR_BATCH = 20` mỗi tick `*/10` = tối đa 2.880 ảnh/ngày lý thuyết, thấp hơn
nhiều so với nhu cầu khi mới đổi nguồn KKPhim (toàn bộ artwork là key mới).
Đây **chính là Phase 3** đã lên kế hoạch (shard mirror drain theo pattern
`home.js`/`warm.js`) — không cần thêm hành động sự cố nào ở Phase 0.

**Quyết định:** Đóng Phase 0 là 🟢, không phải sự cố. Đổi trọng tâm ưu tiên
sang Phase 3 (thật sự là nút thắt) và Phase 1 (đòn bẩy cao nhất, vẫn đúng như
phân tích ban đầu). **Bài học quy trình:** đo `/api/health` ngay sau một deploy
mới sẽ luôn trông như "cron chết" trong tối đa 1 giờ (chu kỳ hourly) — nên đợi
qua ít nhất 1 tick đầy đủ của mọi cron trước khi kết luận, hoặc dựa vào
`written`/`failed` counts thay vì chỉ `age_min`.

---

### 2026-08-06 — Khảo sát ban đầu

**Đã xác lập bằng đo đạc, không phải suy đoán:**

1. **35% ≈ hit rate của ảnh.** Ảnh chiếm ~84% lưu lượng request. Mô hình
   `0,84 × 0,25 + 0,16 × 0,85 = 0,35` tái tạo đúng con số báo cáo. → Mọi tối ưu
   `/api/*` thêm nữa chỉ dịch được vài điểm phần trăm.
2. **`/api/*` đang ổn.** ADR-0001 Phase 1–2 có tác dụng thật: request thứ 2 trở
   đi trả `cf-cache-status: HIT`. Không phải thủ phạm.
3. **Ba cron đều không ra kết quả.** `home:current` và `warm:last-run` **không
   tồn tại trong KV**; mirror 0 ảnh/giờ với 1.222 tồn. Trụ "Refresh in
   Background" của motto đang chết hoàn toàn.
4. **Đã loại trừ** KV write quota cạn (ghi thử thành công), CRON_KEY thiếu
   (secret có tồn tại), code cũ (origin/main == HEAD, deploy 06:45 UTC hôm nay).

**Quyết định 1 — Tách mục tiêu thành 2 chỉ số thay vì 1.**
99,95% zone-wide **không khả thi trên Free** và cũng không phải thứ đáng theo
đuổi: miss ảnh rẻ (origin là R2), miss `/api/*` đắt (KKPhim + tới 24 TMDB,
~917ms). Cam kết: `/api/*` origin-build rate ≤0,1% (đạt 99,9%), zone-wide ≥93%.

**Quyết định 2 — `s-maxage` phải bỏ.**
Doc Cloudflare: `s-maxage` mang ngữ nghĩa `proxy-revalidate` → shared cache
không được serve stale → `stale-while-revalidate` **và** `stale-if-error` đều bị
vô hiệu. Hiện mọi response `/api/*` đều gửi `s-maxage`. ADR-0001 Phase 1 thêm nó
như "thay đổi giá trị nhất" và vô tình tắt đúng cơ chế motto cần. Thay bằng
`max-age` + SWR + Edge TTL qua Cache Rules.
*(Cần verify Origin Cache Control đang bật trên zone — điều kiện để mệnh đề trên
đúng.)*

**Quyết định 3 — Tiered Cache trước, Cache Reserve sau.**
Tiered Cache: **free trên gói Free**, Cloudflare tự tối ưu upper tier cho origin
R2 → đúng trường hợp `img.bluesia.net`. Cache Reserve: **cần trả phí**, nhưng là
**cách duy nhất** trị LRU eviction (nguyên nhân N3) → trần Free là ~95%.

**Quyết định 4 — Mirror drain shard theo đúng pattern có sẵn.**
`home.js`/`warm.js` đã dùng `SELF` service binding để mỗi shard có budget 50
subrequest riêng. Áp lại cho mirror: 5 shard × 20 ảnh / 10 phút = 14.400/ngày.

**Quyết định 5 — KHÔNG đặt Worker trước `img.bluesia.net`.**
Hướng read-through mirror (miss → fetch upstream → stream + ghi R2) hấp dẫn về
mặt thiết kế nhưng biến traffic ảnh đang free thành Worker request tính vào
100k/ngày. Với ~40 ảnh/lượt xem → trần 2.500 lượt/ngày. Loại khỏi plan.

**Phát hiện phụ:**
- wsrv.nl **chặn `phimimg.com`** (verify: 400 với phimimg, 200 với TMDB).
  100/1.222 hàng đợi là phimimg → cần nhánh riêng ở Phase 3.
- CLAUDE.md ghi "~111 `meta:*`" — thực tế **1.886**, sai 17×. Ảnh hưởng trực
  tiếp tới số học budget KV write của ADR-0001.
- KV còn rác thiết kế cũ: `home:last-known-good`, ~20 key `stale:*`.
- Hero rail derive `w154` ở client ([HeroSlider.js:35](../src/modules/HeroSlider/HeroSlider.js:35))
  → **+20 object distinct** mỗi lượt xem trang chủ, ngoài 120 URL trong payload.
  Không phải bug, nhưng làm đuôi LRU dài thêm.

**Ghi chú vệ sinh:** key `diag:probe` ghi vào KV khi thử quota — **đã xoá**.

---

## Việc cần người quyết / cần quyền

| # | Việc | Ai | Chặn |
|---|---|---|---|
| ~~O1~~ | ~~Tắt Browser Cache TTL override~~ | — | **User đã tự xử lý** (chuyển "respect existing headers") |
| ~~O5~~ | ~~WAF Custom Rule cho IP GitHub Actions~~ | — | **Không còn cần** — đã bỏ caller ngoài bằng `global_fetch_strictly_public` |
| ~~O2~~ | ~~Cron có fire không~~ | — | **Đã đóng** — cron chạy đúng |
| ~~O3~~ | ~~Giữ tầng `caches.default` không~~ | — | **Đã trả lời** — giữ nguyên |
| ~~O4~~ | ~~Trả phí Cache Reserve?~~ | — | **User quyết định bỏ qua** (2026-08-06) |
| ~~O6~~ | ~~Cấp token Cloudflare scope Zone Analytics~~ | — | **Đã đóng 2026-08-07** — user cấp token, số liệu thật đã đo |
