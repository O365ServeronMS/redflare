/**
 * TMDB weekly trending — refresh ids into KV and read them back.
 * Ids are stored in MOVIES_KV under a single key with a 6h TTL.
 */

const TRENDING_KEY = 'tmdb:trending:week';
const TRENDING_TTL = 6 * 60 * 60; // seconds

/**
 * Fetch TMDB weekly trending, dedupe the ids, and cache them in KV.
 * @param {Object} env - Worker env (provides MOVIES_KV)
 * @param {string} [token] - TMDB v4 read access token
 * @returns {Promise<{skipped: boolean, reason?: string, count?: number}>}
 */
export async function refreshTrendingMovies(env, token) {
  if (!token) return { skipped: true, reason: 'missing-token' };

  const res = await fetch('https://api.themoviedb.org/3/trending/all/week?language=en-US', {
    headers: { Authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`TMDB upstream error: ${res.status}`);

  const data = await res.json();
  const results = Array.isArray(data?.results) ? data.results : [];
  const ids = [...new Set(
    results
      .filter(item => item?.media_type === 'movie' || item?.media_type === 'tv')
      .map(item => (item?.id != null ? String(item.id) : null))
      .filter(Boolean)
  )];

  await env.MOVIES_KV?.put(TRENDING_KEY, JSON.stringify(ids), { expirationTtl: TRENDING_TTL });
  return { skipped: false, count: ids.length };
}

/**
 * Read the cached set of trending TMDB ids.
 * @param {Object} env - Worker env (provides MOVIES_KV)
 * @returns {Promise<Set<string>>}
 */
export async function getTrendingTmdbIds(env) {
  const raw = env?.MOVIES_KV ? await env.MOVIES_KV.get(TRENDING_KEY) : null;
  if (!raw) return new Set();
  try {
    const ids = JSON.parse(raw);
    return new Set(Array.isArray(ids) ? ids : []);
  } catch {
    return new Set();
  }
}
