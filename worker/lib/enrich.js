// enrich.js — TMDB enrichment ported from catalog-api/src/tmdb-enrich.js.
// Logic kept deliberately identical to the VPS version; only the cache
// backend changed (ioredis -> env.CATALOG_KV) and the card-enrich
// concurrency dropped from 10 to 6 (Workers free plan: max 6 simultaneous
// outgoing connections per invocation). See redflare/CLAUDE.md "Field
// ownership: OPhim vs TMDB" for the policy this implements.

const TMDB_IMG = 'https://image.tmdb.org/t/p';
// Same sizing rationale as the VPS version: cards render ~195px CSS wide in
// a 1280px/6-column grid (~390-585px at DPR 2-3); hero backdrops span the
// full 1280px shell.
const BACKDROP_SIZE = 'w1280'; // -> poster_url (wide backdrop)
const POSTER_SIZE = 'w500';    // -> thumb_url  (portrait poster)

const TTL_META = 14 * 24 * 60 * 60; // 14 days, seconds

// Workers free plan caps simultaneous outgoing connections per invocation at
// 6 (10 on paid) - the VPS used 10 since Node has no such per-request cap.
const CARD_CONCURRENCY = 6;

// First non-empty value: '' / null / [] are skipped so a missing TMDB field
// cleanly falls back to the OPhim value.
const first = (...vals) =>
  vals.find((v) => v != null && v !== '' && !(Array.isArray(v) && v.length === 0));

// Keep a title only if our audience can read it. Vietnamese and English are
// both Latin script, so anything carrying Hangul/CJK/Thai/Cyrillic/... is
// unreadable here. This matters because TMDB falls back to the ORIGINAL
// title when a vi-VN translation is missing — that is how Chinese and Thai
// titles ended up as the headline `name` on cards. Dropping the value lets
// first() fall back to OPhim, whose `name` is always Vietnamese and whose
// `origin_name` is Latin/English.
const readableTitle = (s) =>
  typeof s === 'string' &&
  !/[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u.test(s)
    ? s
    : '';

// fetch with abort timeout + one retry — TMDB egress is occasionally flaky.
async function fetchWithTimeout(url, opts = {}, ms = 8000) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      return await fetch(url, { ...opts, signal: ctrl.signal });
    } catch (err) {
      if (attempt === 1) throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

// env must provide CATALOG_KV (meta cache) and TMDB_API_TOKEN (secret).
export function createEnrich(env) {
  const TMDB_TOKEN = env.TMDB_API_TOKEN || '';
  const headers = { Authorization: `Bearer ${TMDB_TOKEN}`, accept: 'application/json' };
  const metaKey = (type, id, season) => `meta:${type}:${id}` + (season ? `:s${season}` : '');

  // Resolve OPhim item -> { id, type, season }. tmdb.id is dominant; imdb is
  // the fallback (resolved via TMDB /find). season (tv only, OPhim's
  // tmdb.season) selects per-season artwork — each OPhim season is its own
  // slug sharing one series-level tmdb.id.
  async function resolveRef(item) {
    const id = item?.tmdb?.id;
    const type = item?.tmdb?.type === 'tv' ? 'tv' : 'movie';
    const s = Number(item?.tmdb?.season);
    const season = type === 'tv' && Number.isInteger(s) && s > 0 ? s : 0;
    if (id) return { id: String(id), type, season };

    const imdb = item?.imdb?.id;
    if (!imdb || !TMDB_TOKEN) return null;
    try {
      const res = await fetchWithTimeout(
        `https://api.themoviedb.org/3/find/${imdb}?external_source=imdb_id`,
        { headers }
      );
      if (!res || !res.ok) return null;
      const d = await res.json();
      if (d?.movie_results?.length)
        return { id: String(d.movie_results[0].id), type: 'movie', season: 0 };
      if (d?.tv_results?.length) return { id: String(d.tv_results[0].id), type: 'tv', season };
    } catch {
      /* fall through to no-match */
    }
    return null;
  }

  // Map a raw TMDB detail response -> the OPhim-named fields we override.
  // Values are PURE TMDB (no OPhim fallback baked in — fallback is applied
  // at merge so the cached meta stays keyed by tmdb id (+season for tv),
  // reusable across slugs).
  function mapTmdb(t, season) {
    const sn = season && (t.number_of_seasons || 0) > 1 ? t[`season/${season}`] : null;
    const seasonPoster = sn?.poster_path || '';
    const seasonStill = (sn?.episodes || []).find((e) => e.still_path)?.still_path || '';
    const date = t.release_date || t.first_air_date || '';
    const cast = (t.credits?.cast || [])
      .slice()
      .sort((a, b) => (a.order ?? 99) - (b.order ?? 99))
      .slice(0, 15)
      .map((c) => c.name);
    const vids = t.videos?.results || [];
    const trailer =
      vids.find((v) => v.site === 'YouTube' && v.type === 'Trailer' && v.official) ||
      vids.find((v) => v.site === 'YouTube' && v.type === 'Trailer');

    const baseName = t.title || t.name || '';
    const baseOrigin = t.original_title || t.original_name || '';

    return {
      name: readableTitle(sn && baseName ? `${baseName} (Phần ${season})` : baseName),
      origin_name: readableTitle(
        sn && baseOrigin ? `${baseOrigin} (Season ${season})` : baseOrigin
      ),
      content: t.overview || '',
      year: date ? Number(date.slice(0, 4)) : null,
      poster_url: seasonStill
        ? `${TMDB_IMG}/${BACKDROP_SIZE}${seasonStill}`
        : t.backdrop_path ? `${TMDB_IMG}/${BACKDROP_SIZE}${t.backdrop_path}` : '',
      thumb_url: seasonPoster
        ? `${TMDB_IMG}/${POSTER_SIZE}${seasonPoster}`
        : t.poster_path ? `${TMDB_IMG}/${POSTER_SIZE}${t.poster_path}` : '',
      actor: cast,
      trailer_url: trailer ? `https://www.youtube.com/watch?v=${trailer.key}` : '',
      vote_average:
        typeof t.vote_average === 'number' ? Math.round(t.vote_average * 10) / 10 : null,
    };
  }

  // Cached (14d, KV) pure-TMDB meta for a { type, id, season }. Returns null
  // on no token / TMDB miss so enrichItem falls back to OPhim untouched.
  async function getMeta(ref) {
    if (!TMDB_TOKEN) return null;
    const key = metaKey(ref.type, ref.id, ref.season);
    try {
      const hit = await env.CATALOG_KV.get(key);
      if (hit) return JSON.parse(hit);
    } catch {
      /* ignore cache read errors */
    }

    let meta = null;
    try {
      const seasonAppend = ref.type === 'tv' && ref.season ? `,season/${ref.season}` : '';
      const res = await fetchWithTimeout(
        `https://api.themoviedb.org/3/${ref.type}/${ref.id}` +
          `?language=vi-VN&append_to_response=credits,videos${seasonAppend}`,
        { headers }
      );
      if (res && res.ok) meta = mapTmdb(await res.json(), ref.season);
    } catch (err) {
      console.error('[enrich tmdb]', err.message);
    }

    if (meta) {
      env.CATALOG_KV
        .put(key, JSON.stringify(meta), { expirationTtl: TTL_META })
        .catch((e) => console.error('[enrich meta put]', e.message));
    }
    return meta;
  }

  // Merge TMDB meta onto an OPhim detail item IN PLACE. TMDB wins per-field,
  // OPhim is the fallback. Raw image URLs are left for mapItemImages().
  async function enrichItem(item) {
    if (!item || typeof item !== 'object') return item;
    const ref = await resolveRef(item);
    if (!ref) return item;
    const m = await getMeta(ref);
    if (!m) return item;

    item.name = first(m.name, item.name);
    item.origin_name = first(m.origin_name, item.origin_name);
    item.content = first(m.content, item.content);
    item.year = first(m.year, item.year);
    item.poster_url = first(m.poster_url, item.poster_url);
    item.thumb_url = first(m.thumb_url, item.thumb_url);
    item.actor = first(m.actor, item.actor);
    item.trailer_url = first(m.trailer_url, item.trailer_url);
    if (m.vote_average != null) item.vote_average = m.vote_average;
    return item;
  }

  async function enrichDetailPayload(data) {
    const item = data?.data?.item || data?.item || data?.movie;
    if (item) await enrichItem(item);
    return data;
  }

  // Card-level enrich: swap TMDB title/original title/rating/artwork onto an
  // OPhim item, keeping OPhim's streaming fields. OPhim values are the
  // per-item fallback. Heavier metadata (overview/cast/trailer) is left to
  // enrichItem (detail only).
  async function enrichItemCard(item) {
    if (!item || typeof item !== 'object') return item;
    let m = null;
    try {
      const ref = await resolveRef(item);
      if (ref) m = await getMeta(ref);
    } catch {
      return item; // any failure -> keep KKPhim values
    }
    if (!m) return item;
    item.name = first(m.name, item.name);
    item.origin_name = first(m.origin_name, item.origin_name);
    item.poster_url = first(m.poster_url, item.poster_url);
    item.thumb_url = first(m.thumb_url, item.thumb_url);
    if (m.vote_average != null) item.vote_average = m.vote_average;
    return item;
  }

  // Bounded-concurrency map — caps the TMDB burst on a list build.
  async function mapLimit(items, limit, fn) {
    let i = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        try {
          await fn(items[idx]);
        } catch {
          /* per-item fallback already applied */
        }
      }
    });
    await Promise.all(workers);
    return items;
  }

  async function enrichItemsCards(items) {
    if (!Array.isArray(items) || !items.length) return items;
    return mapLimit(items, CARD_CONCURRENCY, enrichItemCard);
  }

  async function enrichListPayload(data) {
    const d = data?.data || data;
    if (Array.isArray(d?.items)) await enrichItemsCards(d.items);
    return data;
  }

  return { enrichItem, enrichDetailPayload, enrichItemsCards, enrichListPayload };
}
