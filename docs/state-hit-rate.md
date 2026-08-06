# State: nâng cache HIT rate của redflare

File tracking cho [plan-hit-rate.md](plan-hit-rate.md). **Cập nhật file này mỗi
khi một phase đổi trạng thái** — nó là nguồn sự thật về tiến độ, không phải git log.

**Bắt đầu:** 2026-08-06
**Trạng thái tổng:** 🟡 Phase 0 đóng, Phase 2 xong (dashboard), Phase 1 code
xong chờ deploy — xem bảng phase bên dưới

---

## Bảng phase

| Phase | Nội dung | Trạng thái | Ngày | Ghi chú |
|---|---|---|---|---|
| **0** | Khôi phục background refresh (cron chết) | 🟢 **Đóng — không phải sự cố** | 2026-08-06 | Chẩn đoán ban đầu sai, xem nhật ký bên dưới |
| **1** | Bỏ `s-maxage`, bật `stale-while-revalidate` | 🟢 **Deploy xong, verify production OK** | 2026-08-06 | Còn 1 phần chặn O1 (Browser TTL override) |
| **2** | Bật Tiered Cache (Smart Topology) | 🟢 **Xong** | 2026-08-06 | User đã bật trên dashboard |
| **3** | Shard mirror drain + dọn ~1.200 ảnh tồn | 🟢 **Deploy xong** | 2026-08-06 | 5x throughput (100/tick thay vì 20/tick); backlog tự dọn dần |
| **4** | Warm set theo popularity (LRU) | 🟢 **Deploy xong** | 2026-08-06 | Bootstrap qua seed list cũ, chưa có dữ liệu popularity thật |
| **5** | Edge warming | 🟡 **Nửa ảnh xong (Worker); nửa `/api/*` chờ user thêm GitHub Actions workflow** | 2026-08-06 | File đã sẵn `.github/workflows/edge-warm.yml`, token thiếu scope `workflow` để tôi tự push |
| **6** | Đo lường tách theo class | ⚪ Chưa bắt đầu | — | Cần quyền Analytics |
| **7** | *(tuỳ chọn, tốn tiền)* Cache Reserve | ⚪ Chưa quyết | — | Quyết sau Phase 6 |
| **8** | Dọn nợ khảo sát lộ ra | ⚪ Chưa bắt đầu | — | Làm lúc nào cũng được |

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
| `mirror_queue` depth | **1.225** | ~0 | — |
| `mirror` đầu queue kẹt | **497 phút** | <60 phút | — |
| `mirrored` trong 1h | **0** | >0 | — |
| `mirrored` tổng | **3.494** | tăng dần | — |
| KV `page:v1:*` | **0 key** | 12–13 key | — |
| KV `home:current` | **KHÔNG TỒN TẠI** | tồn tại, <60 phút tuổi | — |
| KV `warm:last-run` | **KHÔNG TỒN TẠI** | tồn tại, <90 phút tuổi | — |
| KV `meta:*` | **1.886 key** | — (CLAUDE.md ghi sai là ~111) | — |
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
| O1 | Tắt Browser Cache TTL override (1800s) trên dashboard, chuyển "respect origin" — phạm vi đã thu hẹp, không còn cần Cache Rules cho Edge TTL (xem O3) | chủ repo | Phase 1 (một phần), 6 |
| ~~O2~~ | ~~Cron có fire không~~ | — | **Đã đóng** — cron chạy đúng |
| ~~O3~~ | ~~Giữ tầng `caches.default` không~~ | — | **Đã trả lời** — giữ nguyên |
| O4 | Quyết: có trả phí Cache Reserve không, nếu Phase 6 xác nhận trần Free ~95% | chủ repo | Phase 7 |
