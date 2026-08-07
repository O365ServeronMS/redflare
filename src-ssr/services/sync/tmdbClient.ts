import { RateLimiter } from './throttle';
import type { TmdbType } from '../../types/movie';

const TMDB_API = 'https://api.themoviedb.org/3';

export interface TmdbDetail {
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  overview?: string;
  backdrop_path?: string | null;
  poster_path?: string | null;
  release_date?: string;
  first_air_date?: string;
  vote_average?: number;
  vote_count?: number;
  popularity?: number;
  videos?: { results?: { site: string; type: string; official: boolean; key: string }[] };
}

export interface TmdbRecommendation {
  id: number;
}

async function fetchWithTimeout(url: string, token: string, ms = 5000): Promise<Response | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Authorization: `Bearer ${token}`, accept: 'application/json' },
    });
    return res.ok ? res : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export class TmdbClient {
  constructor(private readonly token: string, private readonly limiter: RateLimiter) {}

  async getDetail(type: TmdbType, id: number): Promise<TmdbDetail | null> {
    if (!this.token) return null;
    await this.limiter.wait();
    const res = await fetchWithTimeout(
      `${TMDB_API}/${type}/${id}?language=vi-VN&append_to_response=videos`,
      this.token
    );
    if (!res) return null;
    return res.json<TmdbDetail>().catch(() => null);
  }

  /** Top-N recommendation ids in rank order -- the raw ids only. Resolving
   * them to catalog slugs (or promoting to stubs) is Phase 4's job, not
   * this client's. */
  async getRecommendationIds(type: TmdbType, id: number, limit: number): Promise<number[]> {
    if (!this.token) return [];
    await this.limiter.wait();
    const res = await fetchWithTimeout(`${TMDB_API}/${type}/${id}/recommendations?language=vi-VN`, this.token);
    if (!res) return [];
    const data = await res.json<{ results?: TmdbRecommendation[] }>().catch(() => null);
    return (data?.results ?? []).slice(0, limit).map((r) => r.id);
  }
}
