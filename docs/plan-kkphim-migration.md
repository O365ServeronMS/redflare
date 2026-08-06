# Plan: chuyển nguồn catalog OPhim → KKPhim (phimapi.com)

**Ngày lập:** 2026-08-06
**Lý do:** `ophim1.com` trả HTTP 500 trên mọi endpoint (`/danh-sach/*`, `/v1/api/*`,
`/phim/:slug`) — nguồn catalog đã chết hoàn toàn, không phải sự cố tạm thời.
**Nguồn thay thế:** KKPhim — API base `https://phimapi.com`, doc tại
https://kkphim.com/api-document

> Mọi con số / shape trong tài liệu này là **đo trực tiếp** ngày 2026-08-06 bằng
> curl, không phải đọc từ doc. Doc KKPhim thiếu đúng 3 thứ quan trọng nhất
> (extension ảnh không đồng nhất, wsrv.nl chặn `phimimg.com`, slug khác
> namespace) — xem §0.3.

---

## §0. Khảo sát: cái gì giống, cái gì gãy

### 0.1 Endpoint — gần như drop-in

Đã verify từng cái. Shape JSON **trùng khớp** OPhim, chỉ đổi host:

| Dùng ở | OPhim (chết) | KKPhim | Shape |
|---|---|---|---|
| `/api/list` (`phim-moi-cap-nhat`) | `ophim1.com/danh-sach/phim-moi-cap-nhat` | `phimapi.com/danh-sach/phim-moi-cap-nhat` | `{status,msg,items,pagination}` ✅ giống |
| `/api/list` (type khác) | `/v1/api/danh-sach/{type}` | `/v1/api/danh-sach/{type}` | `{status,msg,data:{items,params.pagination,titlePage,seoOnPage,breadCrumb}}` ✅ giống |
| `/api/genre` | `/v1/api/the-loai/{slug}` | `/v1/api/the-loai/{slug}` | ✅ giống |
| `/api/country` | `/v1/api/quoc-gia/{slug}` | `/v1/api/quoc-gia/{slug}` | ✅ giống |
| `/api/search` | `/v1/api/tim-kiem?keyword=` | `/v1/api/tim-kiem?keyword=` | ✅ giống (nhưng chất lượng match kém hơn — §0.4) |
| `/api/movie/:slug` | `/phim/{slug}` | `/phim/{slug}` | `{status,msg,movie,episodes}` ✅ **đã được handle sẵn** |

**Type slug giống hệt:** `phim-le`, `phim-bo`, `hoat-hinh`, `tv-shows`,
`phim-chieu-rap` — và giá trị `item.type` cũng giống (`single` / `series` /
`hoathinh` / `tvshows`), nên logic lọc `item.type !== 'hoathinh'` ở
`buildHeroShard` không cần đổi.

**Taxonomy giống hệt:** 26 genre slug + 36 country slug của KKPhim bao trọn mọi
slug đang hardcode ở [Footer.js:9-25](../src/modules/Footer/Footer.js) và
[MovieDetail.js:253-259](../src/components/MovieDetail.js). `au-my` (dùng ở
`POOL_URLS`) có. → **frontend nav không cần đổi gì.**

**Field ownership không đổi:** KKPhim trả đủ `tmdb.{id,type,season}`, `imdb.id`,
`category[]`, `country[]`, `episodes[].server_data[].link_m3u8`, `director[]`,
`actor[]`, `type`, `status`, `quality`, `lang`, `episode_current`, `time`.
→ Bảng "Field ownership: OPhim vs TMDB" trong CLAUDE.md giữ nguyên logic, chỉ
đổi tên cột "OPhim" → "KKPhim".

Shape detail của KKPhim đặt `episodes` **ngang hàng** `movie` (không lồng trong
`movie`). Code hiện tại **đã handle sẵn** cả hai:
[`enrichDetailPayload`](../worker/lib/enrich.js#L186) và
[`mapDetailPayloadImages`](../worker/index.js#L147) đều có nhánh `data.movie`;
[`getMovieDetail`](../src/api/ophim.js#L86) đã fallback `item.episodes || data.episodes`.
→ **không cần sửa.**

### 0.2 Bonus: KKPhim có endpoint OPhim không có

`GET /tmdb/{movie|tv}/{tmdb_id}` — tra cứu **chính xác theo TMDB id**, trả về
shape detail đầy đủ. Verified:

```
/tmdb/tv/94997     → gia-toc-rong-phan-1  (tmdb.season = 1)
/tmdb/movie/278    → nha-tu-shawshank
/tmdb/movie/1212763→ ma-cay-lua-dia-nguc
```

Đây là **nâng cấp thật** cho `matchViaSearch` trong
[recommendation.js:199](../worker/lib/recommendation.js#L199), vốn đang đoán mò
bằng keyword search (2 subrequest/candidate, match sai được). Xem Phase 4.

### 0.3 Ba thứ THỰC SỰ gãy (không có trong doc KKPhim)

#### (A) `wsrv.nl` CHẶN `phimimg.com` — nghiêm trọng nhất

```
GET https://wsrv.nl/?url=https%3A%2F%2Fphimimg.com%2F...&output=webp&q=75&w=500&we
→ 400 {"status":"error","code":400,"message":"Domain or TLD blocked by policy"}
```

(cùng lúc đó `image.tmdb.org` qua wsrv.nl vẫn `200 image/webp 41040` — nên đây
là policy nhắm vào domain, không phải wsrv.nl hỏng.)

Toàn bộ pipeline mirror ảnh non-TMDB vừa được xây **hôm qua** (2026-08-06,
`plan-redflare-webp-wsrv.md`) dựa trên giả định wsrv.nl fetch được host ảnh của
nguồn catalog. Với KKPhim giả định đó **sai**. Nếu chỉ đổi host mà không sửa
`mirror.js`, mọi key `kkphim/...webp` sẽ:
`fetch wsrv → 400` → `isUpstreamDead(phimimg.com)` → origin sống → `retry` →
lặp lại mỗi 10 phút cho tới `MAX_RETRY_AGE_MS` (6h) rồi bị drop → **không ảnh
KKPhim nào từng vào được R2**, và `/api/health` sẽ kêu `RedflareMirrorStuck`.

**Nhưng:** ảnh KKPhim **không cần** wsrv.nl, vì lý do wsrv.nl tồn tại đã biến mất:

| | OPhim | KKPhim (đo thật) |
|---|---|---|
| Format gốc | luôn `.jpg` → cần convert | **đa số đã là `.webp`** |
| Kích thước | tới vài MB → **cần resize** | **42–110 KB**, đã đúng cỡ |
| `content-length` | không có (chunked) | có với `.webp`; **không có** với path `upload/vod/*.jpg` |

→ **Quyết định: mirror RAW cho KKPhim.** Không wsrv.nl, không resize, không
convert. Nhánh buffer-khi-thiếu-content-length ở
[mirror.js:297](../worker/lib/mirror.js#L297) đã có sẵn, xử lý được path
`upload/vod/*.jpg`.

#### (B) Extension ảnh KHÔNG đồng nhất → phá contract key ↔ URL

Đo trên 3 page ngẫu nhiên của `/danh-sach/phim-moi-cap-nhat`:

```
page 1   → {".webp": 42, ".jpg": 6}
page 20  → {".webp": 36, ".jpg": 11, ".png": 1}
page 200 → {".jpg": 48}
```

Và **hai path prefix** cùng tồn tại: `uploads/movies/...` và `upload/vod/...`
(chú ý: `upload` không có `s` — nên check `path.startsWith('uploads/')` ở
[images.js:32](../worker/lib/images.js#L32) sẽ **trượt**, biến
`upload/vod/x.jpg` thành `uploads/movies/upload/vod/x.jpg` → 404).

Đây là điều phá vỡ invariant đang được ghi rõ trong CLAUDE.md và trong comment
của [`upstreamForKey`](../worker/lib/images.js#L122):

> "source images are confirmed always `.jpg`, both hosts"

Với KKPhim câu đó **không còn đúng**. `upstreamForKey` / `upstreamFallback` swap
`.webp` → `.jpg` vô điều kiện, nên với ảnh gốc vốn đã là `.webp` nó sẽ dựng ra
URL sai → client fallback hỏng.

→ **Quyết định: key KKPhim giữ nguyên path gốc, giữ nguyên extension gốc,
không có segment `w<width>/`.**

```
https://phimimg.com/uploads/movies/20260805/x-thumb.webp
  → key: kkphim/uploads/movies/20260805/x-thumb.webp
https://phimimg.com/upload/vod/20260622-1/abc.jpg
  → key: kkphim/upload/vod/20260622-1/abc.jpg
```

Đảo ngược: bỏ prefix `kkphim/`, prepend `https://phimimg.com/`. **Lossless, không
cần đoán extension.** Key TMDB (`t/p/w500/<hash>.webp`) **giữ nguyên không đổi
một chữ** — vẫn wsrv.nl, vẫn swap `.jpg`→`.webp`, vẫn có sibling `w154`. Toàn bộ
~n nghìn object TMDB đã mirror **không phải re-mirror**.

Không có segment `w<width>/` vì không còn resize ở mirror-time. Nếu sau này cần
resize lại, đó là Cloudflare Image Transformation ở serve-time (nguồn same-zone
R2 — đúng cách nó chạy trước 2026-08-06), **không phải** đổi key shape. Ghi rõ
ở Phase 3 để không ai nhầm.

Lưu ý: ảnh KKPhim chỉ hiện khi **TMDB không match được title** — vì
`enrichItemCard`/`enrichItem` ghi đè `poster_url`/`thumb_url` bằng TMDB bất cứ
khi nào có match. Nên đây là đường ít traffic; không đáng đánh đổi thêm phức tạp.

#### (C) Slug khác namespace hoàn toàn → mọi cache & deep link chết

```
/phim/ket-thuc-that     → 404   (slug OPhim)
/phim/gia-toc-rong      → 404   (slug OPhim)
/phim/gia-toc-rong-phan-2 → 200 (slug KKPhim, tmdb.season = 2)
```

KKPhim tách **mỗi season thành một slug riêng** (`-phan-N`), OPhim thì không.
Hệ quả:

1. **Mọi deep link `/phim/<slug-ophim>` đang tồn tại sẽ 404** — bookmark, link
   đã share, index của search engine. Không né được nếu đổi nguồn; xem §5 để
   quyết định có làm redirect hay không.
2. **D1 `stale`, `idx`, `recs` + KV `home:current` + Cache API đều chứa slug và
   image URL của OPhim** → toàn bộ phải purge, không thể để tự hết hạn. Nhắc
   lại bài học đã ghi trong CLAUDE.md ("Caching layers" #2): **Cache API hit trả
   về TRƯỚC khi builder chạy, nên entry sai KHÔNG bao giờ tự lành**, dù có bao
   nhiêu traffic đi qua. Entry `recs` tier `full` sống 30 ngày.
3. Cột `idx` lưu **full JSON của item** (không chỉ id) → nếu quên purge `idx`,
   recommendation sẽ tiếp tục trả item OPhim với slug 404 và URL ảnh cũ, kể cả
   sau khi đã purge Cache API và `recs`. Đây **đúng cái bẫy đã dính** trong lần
   migration domain ảnh 2026-08-04.

### 0.4 Một hồi quy chấp nhận được: search theo tên tiếng Anh yếu hơn

```
keyword="Evil Dead Burn"  → 0 kết quả   (dù phim này CÓ trên KKPhim,
                                          origin_name đúng là "Evil Dead Burn")
keyword="Ma Cây"          → 9 kết quả
keyword="Squid Game"      → 5 kết quả
```

KKPhim index nghiêng hẳn về **tên tiếng Việt**. Ảnh hưởng hai chỗ:

- **`/api/search`** (user-facing): user gõ tên tiếng Anh sẽ ra ít kết quả hơn
  thời OPhim. Không chặn migration, nhưng nên biết trước. Cải thiện được (fallback
  qua TMDB search → `/tmdb/{type}/{id}`) — **để ngoài scope**, ghi vào §5.
- **`matchViaSearch`** trong recommendation: hàm này thử `rec.keyword`
  (= TMDB `original_title`, tức tên tiếng **Anh**) **trước tiên** → trên KKPhim
  gần như luôn trượt. Phase 4 giải quyết triệt để bằng `/tmdb/{type}/{id}`, tốt
  hơn cả bản OPhim cũ.

---

## §1. Nguyên tắc xuyên suốt

1. **Ảnh TMDB không đụng vào.** Key shape, wsrv.nl, sibling `w154`, `mirrored`
   rows — giữ y nguyên. Migration này chỉ thêm nhánh `kkphim/` bên cạnh nhánh
   `t/p/` đã có. Không re-mirror TMDB, không purge `meta:*`.
2. **Các cặp hàm đảo ngược nhau phải sửa cùng lúc**, chúng là contract:
   `objectKeyFor` ↔ `upstreamForKey` (worker) ↔ `upstreamFallback` (client).
   Sửa lệch = client fallback hỏng âm thầm với mọi ảnh chưa mirror xong.
3. **Đổi tên `ophim` → `kkphim` chỉ ở chỗ mang nghĩa "nguồn dữ liệu"**, không
   rename file `src/api/ophim.js` (5 module import nó — đổi tên là 5 file diff
   không liên quan tới việc chuyển nguồn; ghi vào §5 nếu muốn dọn sau).
4. **Deploy = `git push origin main`** → Cloudflare Workers Builds. Hỏi trước khi
   push, theo CLAUDE.md.
5. Mỗi phase có **verify cụ thể chạy được**, không phải "kiểm tra xem có ổn không".

---

## Phase 1 — Đổi nguồn catalog (chỉ swap host + endpoint)

**Mục tiêu:** `/api/list`, `/api/genre`, `/api/country`, `/api/search`,
`/api/movie/:slug` chạy trên KKPhim. Chưa động tới ảnh, chưa động tới
recommendation.

### Bước

1. **`worker/index.js`**
   - L85: `const OPHIM_BASE = 'https://ophim1.com'` → `const KKPHIM_BASE = 'https://phimapi.com'`
   - L125 `fetchOphimJson` → `fetchCatalogJson`; L129 message `OPhim upstream` → `KKPhim upstream`
   - L175–176, 185, 193, 203, 212: đổi tên biến. **Path giữ nguyên 100%** —
     `/danh-sach/phim-moi-cap-nhat`, `/v1/api/danh-sach/{type}`,
     `/v1/api/the-loai/{slug}`, `/v1/api/quoc-gia/{slug}`, `/v1/api/tim-kiem`,
     `/phim/{slug}` đều tồn tại y hệt trên KKPhim.
   - Comment đầu file (L1–63) và L602–603: đổi "OPhim" → "KKPhim". Header
     `x-catalog-cache: stale-vps-down` **giữ nguyên tên** (đã là legacy name
     được document, đổi sẽ phá contract debug đang ghi trong CLAUDE.md).

2. **`worker/lib/home.js`**
   - L44 base; L59–65 `fetchOphimJson`; `POOL_URLS` L76–85; `CRON_SHARD_BUILDERS`
     L209–211; `buildHomeFallback` L279. Path giữ nguyên toàn bộ.
   - Xác nhận `au-my` và `phim-chieu-rap` có trên KKPhim — **đã verify, có**.

3. **`worker/lib/recommendation.js`** — L39, L72–78, L205 (Phase 4 sẽ thay hẳn
   `matchViaSearch`; ở phase này chỉ đổi host để không để lại reference chết).

4. **`worker/lib/enrich.js`** — chỉ comment (L202). Logic TMDB **không đổi gì**:
   `resolveRef` đọc `item.tmdb.{id,type,season}` + `item.imdb.id`, KKPhim trả đủ.

**Không đụng:** `src/**` (frontend không biết nguồn là gì), `wrangler.toml`,
`migrations/`.

### Verify

```bash
npm run build && npm start
```

Rồi với mỗi endpoint, check `items.length > 0` **và** `items[0].tmdb.id` tồn tại
(nếu thiếu `tmdb.id` thì enrichment sẽ im lặng bỏ qua toàn bộ — đó là failure
mode dễ lọt nhất ở phase này):

```bash
for u in "/api/list?type=phim-moi-cap-nhat&page=1" "/api/list?type=phim-le&page=1" \
         "/api/list?type=phim-bo&page=1" "/api/list?type=hoat-hinh&page=1" \
         "/api/list?type=tv-shows&page=1" "/api/genre?slug=hanh-dong&page=1" \
         "/api/country?slug=han-quoc&page=1" "/api/search?keyword=rong&page=1"; do
  echo -n "$u -> "
  curl -s "http://localhost:8787$u" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const d=JSON.parse(s);const i=d.data?.items||d.items||[];console.log("n="+i.length,"tmdb="+(i[0]?.tmdb?.id??"MISSING"),"name="+i[0]?.name)})'
done
curl -s "http://localhost:8787/api/movie/ma-cay-lua-dia-nguc" | \
  node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const d=JSON.parse(s);const m=d.movie||d.data?.item;console.log("name="+m.name,"| ep servers="+(d.episodes||[]).length,"| m3u8="+!!(d.episodes?.[0]?.server_data?.[0]?.link_m3u8))})'
```

**Pass khi:** mọi list `n=24`, `tmdb` không `MISSING`, `name` là tiếng Việt (chứng
tỏ enrich TMDB chạy), detail có `link_m3u8`.

**Lưu ý khi test local:** ảnh sẽ trỏ tới key R2 sai/không tồn tại — **đúng như dự
kiến**, Phase 2 mới sửa. Đừng coi đó là lỗi của Phase 1.

---

## Phase 2 — Pipeline ảnh: nhận `phimimg.com`

**Mục tiêu:** URL ảnh KKPhim map được sang R2 và đảo ngược được, cả ở worker lẫn
client. Chưa bật mirror (Phase 3).

### `worker/lib/images.js`

1. **L14** `IMAGE_HOSTS`: `img.ophim.live` → `phimimg.com`.
   (Giữ `image.tmdb.org`.)

2. **L20–40 `normalizeOphimImageUrl` → `normalizeSourceImageUrl`:** nhánh
   relative phải chấp nhận **cả `uploads/` và `upload/`** (§0.3B — thiếu `s` là
   path thật của KKPhim, không phải typo):

   ```js
   const rel = /^uploads?\//.test(path) ? path : `uploads/movies/${path}`;
   return `https://phimimg.com/${rel}`;
   ```

   Cần thiết vì `/v1/api/*` trả path **relative** (`uploads/movies/...` hoặc
   `upload/vod/...`) còn `/danh-sach/*` và `/v1/api/tim-kiem` trả **URL đầy đủ** —
   đã verify cả ba dạng.

3. **L70–77 `objectKeyFor`:** thêm nhánh KKPhim, **không** width, **không** đổi
   extension:

   ```js
   if (url.hostname === 'image.tmdb.org') return path;      // giữ nguyên
   if (url.hostname === 'phimimg.com') return `kkphim/${path}`;
   ```

   Tham số `width` giờ chỉ còn TMDB dùng (mà TMDB vốn đã bỏ qua nó) → cân nhắc
   bỏ hẳn tham số, nhưng **để nguyên cũng được** cho diff nhỏ. Chọn bỏ nếu muốn
   sạch: khi đó `mapItemImages` L107–108 bỏ luôn `THUMB_WIDTH`/`POSTER_WIDTH`.

4. **L88–95 `r2ImageUrl`:** `webpKeyFor()` **chỉ được áp cho key TMDB**. Với key
   `kkphim/` nó vô hại về mặt kỹ thuật (chỉ swap `.jpg`→`.webp`) nhưng **sai về
   ngữ nghĩa** — sẽ sinh URL `.webp` cho object thực tế lưu bytes JPEG:

   ```js
   const servedKey = key.startsWith('kkphim/') ? key : webpKeyFor(key);
   ```

5. **L122–133 `upstreamForKey`:** nhánh `kkphim/` phải đứng **trước** bước swap
   `.webp`→`.jpg` (nếu không sẽ phá extension gốc):

   ```js
   export function upstreamForKey(key) {
     if (!key) return '';
     if (key.startsWith('kkphim/')) {
       return `https://phimimg.com/${key.slice('kkphim/'.length)}`;
     }
     const base = key.endsWith('.webp') ? `${key.slice(0, -5)}.jpg` : key;
     return `https://image.tmdb.org/${base}`;
   }
   ```

   Cập nhật comment "always `.jpg`, both hosts" → chỉ còn đúng với TMDB.

6. **L167–190 `mirrorTargets`:** logic hiện tại restore `.webp`→`.jpg` rồi
   `webpKeyFor` lại — chỉ đúng cho TMDB. Key `kkphim/` phải **pass-through**:

   ```js
   let targetKey;
   if (servedKey.startsWith('kkphim/')) {
     targetKey = servedKey;                       // giữ nguyên extension gốc
   } else {
     const key = servedKey.endsWith('.webp') ? `${servedKey.slice(0,-5)}.jpg` : servedKey;
     targetKey = webpKeyFor(key);
   }
   ```

   `addW154Sibling` gate sẵn bằng `key.startsWith('t/p/w500/')` → tự động no-op
   với `kkphim/`, **không cần sửa**.

### `src/api/ophim.js` (client — phải khớp tuyệt đối với #5 ở trên)

**L190–205 `upstreamFallback`:** cùng thứ tự nhánh:

```js
export function upstreamFallback(url) {
  if (!url || !url.startsWith(R2_BASE)) return '';
  const key = url.slice(R2_BASE.length);
  if (key.startsWith('kkphim/')) {
    return `https://phimimg.com/${key.slice('kkphim/'.length)}`;
  }
  const base = key.endsWith('.webp') ? `${key.slice(0, -5)}.jpg` : key;
  return `https://image.tmdb.org/${base}`;
}
```

`posterUrl`/`thumbUrl` **giữ nguyên passthrough** — không quay lại Cloudflare
Image Transformation, vì ảnh KKPhim đã đúng cỡ sẵn (§0.3A).

### Verify (unit-level, chạy bằng node, không cần deploy)

Viết script tạm trong scratchpad — **không** thêm file test vào repo (project
không có test suite, đừng tự dựng một cái):

```js
// round-trip phải là identity với CẢ BA dạng extension và CẢ HAI path prefix
const cases = [
  'https://phimimg.com/uploads/movies/20260805/ma-cay-lua-dia-nguc-thumb.webp',
  'https://phimimg.com/upload/vod/20260622-1/344ec2281ef56c96894e787a834f0ace.jpg',
  'https://phimimg.com/uploads/movies/x.png',
  'https://image.tmdb.org/t/p/w500/abc.jpg',   // hồi quy: TMDB không được đổi
];
for (const src of cases) {
  const r2 = r2ImageUrl(src);
  const key = r2.slice('https://img.bluesia.net/'.length);
  console.assert(upstreamForKey(key) === src.replace('.jpg','.jpg'), src);
  console.assert(upstreamFallback(r2) === upstreamForKey(key), 'worker/client lệch: ' + src);
}
```

**Pass khi:** 3 case KKPhim round-trip **identity tuyệt đối**; case TMDB ra
`t/p/w500/abc.webp` (không đổi so với trước); worker và client **luôn** trả cùng
kết quả.

---

## Phase 3 — Mirror: bypass wsrv.nl cho KKPhim

**Mục tiêu:** ảnh KKPhim vào được R2. Đường TMDB không đổi.

### `worker/lib/mirror.js`

1. **L107** `OPHIM_WIDTH_RE` → **xoá**. Không còn segment `w<width>/` (§0.3B).

2. **L239–241** — đây là dòng quyết định. Hiện tại:

   ```js
   const useWsrv = WSRV_ENABLED && key.endsWith('.webp');
   ```

   Key KKPhim `.webp` sẽ lọt vào nhánh này → wsrv.nl trả 400 "Domain blocked"
   → retry vĩnh viễn (§0.3A). Sửa thành gate theo **nguồn**, không theo extension:

   ```js
   // wsrv.nl chặn phimimg.com ("Domain or TLD blocked by policy", đo 2026-08-06).
   // Ảnh KKPhim cũng không cần nó: nguồn đã là WebP 42-110KB, đúng cỡ sẵn.
   // Chỉ TMDB đi qua wsrv.nl (nguồn luôn .jpg, luôn cần convert).
   const isKkphim = key.startsWith('kkphim/');
   const useWsrv = WSRV_ENABLED && !isKkphim && key.endsWith('.webp');
   const fetchUrl = useWsrv ? wsrvWebpUrl(sourceUrl) : sourceUrl;
   ```

3. **L280–282** — invariant `.webp` ⇒ bytes WebP. Với key `kkphim/*.webp` lấy
   thẳng từ origin, `content-type` trả về **đúng là** `image/webp` (đã verify),
   nên check này **tự đúng, không cần sửa** — và giữ lại là có lợi: nó bắt được
   trường hợp phimimg.com đổi hành vi. Ghi comment cho rõ vì sao check vẫn đúng
   khi không còn wsrv.nl bảo đảm.

4. **L297–308 nhánh buffer** — path `upload/vod/*.jpg` của phimimg.com **không
   gửi `content-length`** (đã verify). Nhánh này đã có sẵn cho OPhim chunked →
   dùng lại nguyên vẹn. Cập nhật comment: `img.ophim.live` → `phimimg.com
   (path upload/vod/)`.

5. **L38 `OBJECT_CACHE_CONTROL`** (`immutable`, 1 năm) — vẫn hợp lệ: key KKPhim
   chứa path + filename gốc, một key không bao giờ đổi nội dung.

6. Cập nhật block comment WSRV L65–104: nói rõ nó **chỉ còn áp dụng cho TMDB**,
   và **vì sao** KKPhim không dùng (bị chặn + không cần).

### Verify

Sau khi deploy Phase 1–3 (Phase 4 có thể làm sau), force drain nhiều lần:

```bash
curl -s -H "x-cron-key: $CRON_KEY" https://phim.bluesia.net/__cron/mirror | jq
```

**Pass khi:** `mirrored > 0`, và trong mảng `retries` **không có** key nào
`kkphim/` kèm `why: "wsrv 400"`. Rồi lấy 1 key `kkphim/` bất kỳ, GET thẳng
`https://img.bluesia.net/<key>` → `200` + `content-type` **khớp extension của key**
(`.webp`→`image/webp`, `.jpg`→`image/jpeg`).

```bash
npx wrangler d1 execute redflare-db --remote \
  --command "SELECT COUNT(*) n FROM mirrored WHERE key LIKE 'kkphim/%'"
```

---

## Phase 4 — Recommendation: dùng `/tmdb/{type}/{id}` thay keyword search

**Mục tiêu:** sửa hồi quy §0.4 và đồng thời làm pipeline **tốt hơn** bản OPhim cũ.

### `worker/lib/recommendation.js`

Thay [`matchViaSearch`](../worker/lib/recommendation.js#L199) bằng
`matchViaTmdbLookup`:

```js
// KKPhim tra cứu THẲNG bằng TMDB id — chính xác, 1 subrequest, không đoán keyword.
// Thay cho keyword search của bản OPhim: KKPhim index nghiêng về tên tiếng Việt,
// nên tìm bằng TMDB original_title (tiếng Anh) gần như luôn trượt
// (đo 2026-08-06: "Evil Dead Burn" → 0 kết quả, dù phim đó CÓ trên KKPhim).
async function matchViaTmdbLookup(env, enrich, rec, type) {
  try {
    const data = await fetchCatalogJson(`${KKPHIM_BASE}/tmdb/${type}/${rec.id}`);
    const hit = data?.movie || data?.data?.item;
    if (!hit || !hit.slug) return { item: null, error: false };
    await enrich.enrichItemsCards([hit]);
    return { item: mapItemImages(hit), error: false };
  } catch {
    return { item: null, error: true };
  }
}
```

Giữ nguyên **hoàn toàn** phần còn lại — `classifyTier`/`ttlForTier`, thứ tự
rank, mảng `slots` theo vị trí, dedupe theo slug, `indexItems` warm, và **đặc
biệt là comment L249–257 giải thích vì sao KHÔNG early-stop**. Cái bẫy đó vẫn
còn nguyên giá trị.

Ghi chú phân biệt error rất quan trọng cho `classifyTier`, giữ đúng semantics cũ:
- `{item: null, error: false}` = "KKPhim trả lời, phim này thật sự không có" → cacheable dài
- `{item: null, error: true}` = "gọi KKPhim thất bại" → transient, không được tin để cache 30 ngày

Đổi tên hằng `SEARCH_FALLBACK_BUDGET`/`SEARCH_CONCURRENCY` →
`LOOKUP_FALLBACK_BUDGET`/`LOOKUP_CONCURRENCY` (giờ là lookup, không phải search).
**Giữ nguyên giá trị 10 và 6** ở lần deploy đầu — lookup rẻ hơn search cũ (1
subrequest thay vì tối đa 2), nên budget cũ là an toàn tuyệt đối. Nâng lên chỉ
sau khi **đo** trên `wrangler dev --remote`, đúng cách con số 10 được chốt lần
trước.

Lưu ý về season: `/tmdb/tv/94997` trả `gia-toc-rong-phan-1` (KKPhim tách mỗi
season 1 slug — §0.3C). Recommendation mỗi tmdb id chỉ cần **một** entry, nên
lấy cái endpoint trả về là đủ. Không cần logic chọn season.

### Verify

```bash
curl -s "https://phim.bluesia.net/api/recommendation/tv/94997" | \
  jq '{n: (.items|length), resolved, candidates, skippedBudget, searchErrors,
       slugs: [.items[].slug]}'
```

**Pass khi:** `n` ≥ 6, mọi slug GET `/api/movie/<slug>` đều `200`, và
`searchErrors == 0`. So sánh: test cùng title bằng đường keyword-search cũ để
xác nhận `resolved` **tăng** — nếu không tăng thì lookup chưa thực sự được gọi.

---

## Phase 5 — Cutover: deploy + purge toàn bộ state cũ

**Đây là phase dễ làm hỏng nhất.** Purge thiếu một layer = dữ liệu OPhim chết
tiếp tục được phục vụ tới **30 ngày**, và **không tự lành** (§0.3C).

Vì OPhim đã chết sẵn, hiện site đang phục vụ `stale-vps-down` từ D1 — **không có
trạng thái tốt nào cần bảo vệ**, nên cứ purge mạnh tay.

### Thứ tự (không đảo)

**5.1 — Deploy trước.** Purge trước deploy sẽ khiến worker cũ rebuild từ OPhim
(đã chết) → 502.

```bash
git push origin main   # HỎI user trước, theo CLAUDE.md
```

**5.2 — Purge D1.** Ba bảng chứa payload OPhim (slug + URL ảnh):

```bash
npx wrangler d1 execute redflare-db --remote --command "DELETE FROM stale"
npx wrangler d1 execute redflare-db --remote --command "DELETE FROM idx"
npx wrangler d1 execute redflare-db --remote --command "DELETE FROM recs"
```

`idx` là cái **dễ quên nhất** — nó lưu full JSON của item, không phải chỉ id.
Đúng cái bẫy đã dính trong migration 2026-08-04.

**5.3 — Dọn bookkeeping mirror của OPhim.** Key `ophim/` giờ mồ côi (không item
nào tham chiếu, `img.ophim.live` đằng nào cũng 403):

```bash
npx wrangler d1 execute redflare-db --remote --command "DELETE FROM mirror_queue WHERE key LIKE 'ophim/%'"
npx wrangler d1 execute redflare-db --remote --command "DELETE FROM mirrored    WHERE key LIKE 'ophim/%'"
```

**Không đụng row `t/p/%`** — ảnh TMDB vẫn đúng nguyên và là phần lớn bucket.
Đây là lý do chính key TMDB được giữ nguyên shape ở §1.1.

**5.4 — KV.** Xoá **đúng một** key:

```bash
npx wrangler kv key delete --remote --binding CATALOG_KV "home:current"
```

**KHÔNG xoá `meta:*`** (~111 key TMDB enrichment) và **không xoá**
`trending:week`/`trending:day` — chúng key theo **TMDB id**, hoàn toàn độc lập
với việc nguồn catalog là OPhim hay KKPhim. Xoá đi chỉ tốn ~111 lần gọi TMDB
để dựng lại y hệt.

**5.5 — Cache API: Purge Everything trên dashboard.** Bắt buộc, thủ công:

> Cloudflare dashboard → zone `bluesia.net` → Caching → Configuration →
> **Purge Everything**

`cache.delete()` trong code chỉ evict **trong colo phục vụ request đó** — vô
dụng cho thay đổi toàn cục. Đây là bước đã bị bỏ sót trong migration 2026-08-04
và phải quay lại sửa.

**5.6 — Dựng lại home + mồi mirror.**

```bash
curl -s -H "x-cron-key: $CRON_KEY" https://phim.bluesia.net/__cron/refresh-home | jq
for i in $(seq 1 10); do
  curl -s -H "x-cron-key: $CRON_KEY" https://phim.bluesia.net/__cron/mirror | jq -c '{drained,mirrored,retry,"give-up"}'
done
```

**5.7 — R2 cleanup (tuỳ chọn, sau khi mọi thứ đã xanh vài ngày).** Xoá object
prefix `ophim/` (~38 object theo log 2026-08-06). Không gấp, không ảnh hưởng gì.

### Verify cutover

```bash
curl -s https://phim.bluesia.net/api/health | jq
# ok:true, home.age_min < 60, mirror.oldest_queued_min < 60

curl -sD- https://phim.bluesia.net/api/home-data -o /dev/null | grep -i x-catalog-cache
# hit hoặc miss — KHÔNG được là stale-vps-down

curl -s https://phim.bluesia.net/api/home-data | \
  jq '{hero: (.heroMovies|length), new: (.newMovies.items|length),
       le: (.phimLe.items|length), bo: (.phimBo.items|length),
       trend: (.trending.items|length),
       ophim_leftover: ([.. | strings | select(test("ophim"))] | length)}'
```

**Pass khi:** `ophim_leftover == 0` (không còn URL/slug OPhim sót ở bất kỳ đâu
trong payload) và cả 5 rail đều non-empty.

Smoke test thủ công trên `phim.bluesia.net`: trang chủ → hero xoay được → click
1 phim → detail có poster + tập → bấm play ra stream → khối "Bạn cũng có thể
thích" có item → click 1 item trong đó → mở được. Kiểm tra **DevTools Network**:
ảnh phải trả từ `img.bluesia.net`; một ít fallback sang `phimimg.com` là **bình
thường** trong 1–2 giờ đầu (mirror chạy `*/10`, ≤20 ảnh/lần).

---

## Phase 6 — Tài liệu

CLAUDE.md là **self-contained và load mỗi session** — để lệch là bảo đảm session
sau sẽ debug sai hướng.

- **`CLAUDE.md`** — các mục cần sửa:
  - "What this is" + "Architecture": OPhim → KKPhim (`phimapi.com`).
  - Bảng **"Field ownership: OPhim vs TMDB"** → "KKPhim vs TMDB". Nội dung
    từng dòng **không đổi** (đã verify KKPhim trả đủ mọi field).
  - Mục **"Images"**: viết lại — hai đường mirror khác nhau kể từ nay
    (TMDB qua wsrv.nl có convert; KKPhim raw, **không** wsrv.nl vì bị chặn),
    key shape `kkphim/<path gốc, ext gốc>`, và **xoá** mọi khẳng định
    "source images are always `.jpg`" (chỉ còn đúng với TMDB).
  - "Endpoints the frontend calls": bảng path `/api/*` **không đổi** (frontend
    không hề biết nguồn) — nhưng ghi chú upstream mới.
  - "Ranking is TMDB, availability is OPhim" → "…is KKPhim".
  - **Thêm mục mới:** "KKPhim migration 2026-08-06" — ba breakage ở §0.3, và
    ghi rõ **slug là namespace mới**: deep link OPhim cũ 404 vĩnh viễn.
  - Ghi lại lệnh purge ở Phase 5 như checklist tái sử dụng.
- **`MODULES.md`** — "Axis C — Service modules" đã lỗi thời sẵn (còn tả VPS
  `catalog-api`). **Không sửa trong PR này** (ngoài scope, §3 behavioral
  guideline); ghi vào §5 dưới.
- Nếu `bluesiaOM/context/` có mặt: thêm `state-redflare-kkphim.md` ghi log từng
  phase, theo đúng nếp `state-redflare-webp-wsrv.md`. (Thư mục đó **không có**
  trong worktree hiện tại.)

---

## §5. Ngoài scope — ghi lại, không làm trong PR này

Theo behavioral guideline §3 (surgical changes), những việc dưới đây **liên
quan** nhưng không trace thẳng về "chuyển nguồn API":

1. **Deep link cũ 404.** Có thể làm redirect: `/api/movie/:slug` khi 404 thì
   thử `/v1/api/tim-kiem?keyword=<slug bỏ dấu gạch>` rồi 301 sang slug KKPhim
   khớp nhất. **Chi phí:** thêm 1 subrequest trên đường lỗi, heuristic có thể
   khớp sai. **Đề xuất:** chỉ làm nếu analytics cho thấy có traffic thật vào
   slug cũ. Nếu không, để 404.
2. **`/api/search` yếu với tên tiếng Anh** (§0.4). Sửa được bằng: TMDB
   `/search/multi` → lấy tmdb id → `/tmdb/{type}/{id}`. Đáng làm, nhưng là
   **tính năng mới**, không phải chuyển nguồn.
3. **Rename `src/api/ophim.js` → `src/api/catalog.js`.** 5 file import nó. Diff
   cơ học, dễ review riêng, không nên trộn vào PR này.
4. **`MODULES.md` "Axis C"** đã lỗi thời từ trước migration này.
5. **Resize ảnh KKPhim.** Hiện không resize (nguồn 42–110 KB, chấp nhận được).
   Nếu sau này cần: Cloudflare Image Transformation ở **serve-time** với nguồn
   same-zone R2 — quota hiện dùng ~2% của 5.000/tháng. **Không** đổi key shape
   để nhét width vào; đó là bài học từ đường `ophim/w<width>/` vừa bị gỡ.
6. **Rate limit của KKPhim chưa rõ** — response không có header rate-limit nào.
   Budget subrequest hiện tại (≤36/invocation ở shard nặng nhất) giống hệt thời
   OPhim, nên rủi ro thấp, nhưng nên theo dõi `/api/health` vài ngày sau cutover.

---

## §6. Tóm tắt rủi ro

| Rủi ro | Mức | Giảm thiểu |
|---|---|---|
| Quên purge `idx` → recommendation trả slug OPhim 404 tới 45 ngày | **Cao** | Phase 5.2, verify bằng `ophim_leftover == 0` |
| Quên Purge Everything → Cache API phục vụ payload cũ tới 30 ngày, **không tự lành** | **Cao** | Phase 5.5 (bước thủ công, dashboard) |
| `useWsrv` không gate → mirror KKPhim retry vĩnh viễn, âm thầm | **Cao** | Phase 3.2, verify không có `wsrv 400` trong `retries` |
| `upstreamForKey`/`upstreamFallback` lệch nhau → fallback client hỏng âm thầm | Trung bình | Phase 2 verify round-trip cả worker lẫn client |
| Regex `uploads/` trượt path `upload/vod/` → 404 ảnh | Trung bình | Phase 2.2 dùng `/^uploads?\//` |
| Deep link OPhim cũ 404 | Trung bình | Không né được; §5.1 nếu có traffic thật |
| Search tiếng Anh yếu hơn | Thấp | §5.2 |
| KKPhim cũng chết trong tương lai | Thấp | `KKPHIM_BASE` là hằng số duy nhất; D1 `stale` vẫn phục vụ last-known-good |

## §7. Thứ tự đề xuất

Phase 1 → 2 → 3 gộp **một** PR/deploy (Phase 2 không verify được đầy đủ nếu
thiếu Phase 1; Phase 3 không thể verify nếu thiếu Phase 2). Ngay sau deploy chạy
Phase 5. Phase 4 tách deploy riêng — nó **độc lập** và có verify riêng, gộp vào
sẽ khiến lỗi recommendation lẫn với lỗi đổi nguồn. Phase 6 đi cùng PR đầu.
