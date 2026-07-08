/**
 * Stream (VIP) source client
 * Index files (movies.json / tvshows.json) are rebuilt every 30 minutes on the
 * VPS from the SharePoint mount and served by Caddy at stream.bluesia.net.
 */

const STREAM_BASE = 'https://stream.bluesia.net';

// In-memory index cache with TTL (5 minutes — matches the edge Cache-Control)
const indexCache = new Map();
const INDEX_TTL = 5 * 60 * 1000;

async function getIndex(kind) {
  const entry = indexCache.get(kind);
  if (entry && Date.now() - entry.time < INDEX_TTL) return entry.items;

  const res = await fetch(`${STREAM_BASE}/${kind}.json`);
  if (!res.ok) throw new Error(`Stream index error: ${res.status}`);
  const data = await res.json();
  const items = data.items || {};
  indexCache.set(kind, { items, time: Date.now() });
  return items;
}

function qualityRank(q) {
  if (q === '4k') return 2160;
  return parseInt(q, 10) || 0;
}

// Playback URL for one entry: master playlist when present, else best quality.
function variantUrl(basePath, entry) {
  if (entry.master) return `${basePath}/master.m3u8`;
  const best = [...(entry.qualities || [])].sort(
    (a, b) => qualityRank(b) - qualityRank(a)
  )[0];
  return best ? `${basePath}/${best}/index.m3u8` : null;
}

/**
 * Resolve the VIP source for an OPhim title.
 * @param {Object} tmdb OPhim `movie.tmdb` — { type, id, season }
 * @returns {Promise<{episodes: Array<{name: string, url: string}>} | null>}
 *          null when the title is not available on stream.bluesia.net.
 */
export async function getVipSource(tmdb) {
  const id = tmdb?.id;
  if (!id) return null;

  try {
    if (tmdb.type === 'tv') {
      const items = await getIndex('tvshows');
      const show = items[String(id)];
      const season = 's' + String(tmdb.season || 1).padStart(2, '0');
      const eps = show?.seasons?.[season];
      if (!eps) return null;

      const episodes = Object.keys(eps)
        .sort((a, b) => parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10))
        .map((key) => {
          const url = variantUrl(
            `${STREAM_BASE}/tvshows/${id}/${season}/${key}`,
            eps[key]
          );
          return url ? { name: `Tập ${parseInt(key.slice(1), 10)}`, url } : null;
        })
        .filter(Boolean);
      return episodes.length ? { episodes } : null;
    }

    const items = await getIndex('movies');
    const entry = items[String(id)];
    if (!entry) return null;
    const url = variantUrl(`${STREAM_BASE}/movies/${id}`, entry);
    return url ? { episodes: [{ name: 'Full', url }] } : null;
  } catch (err) {
    // Index unreachable — treat as "not on VIP" so the page still renders OPhim.
    console.warn('VIP index unavailable:', err);
    return null;
  }
}
