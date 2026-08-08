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

export interface TmdbTrendingMovie {
  /** Original index in TMDB's first page. Gaps are intentional after
   * rejecting a malformed/non-movie result. */
  rank: number;
  id: number;
  mediaType: 'movie';
}

export interface TmdbTrendingMoviesResult {
  /** Number of raw entries inspected from TMDB's first page, capped at 20. */
  fetchedCount: number;
  /** Entries explicitly rejected because they are not TMDB movies. */
  rejectedTypeCount: number;
  movies: TmdbTrendingMovie[];
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
  private readonly token: string;
  private readonly limiter: RateLimiter;

  constructor(token: string, limiter: RateLimiter) {
    this.token = token;
    this.limiter = limiter;
  }

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

  /** TMDB's weekly movie window is the sole Hero candidate source. Keep the
   * original first-page rank: callers must not backfill a rejected item from
   * page 2 or outside these first 20 results. `null` means an operational or
   * payload-shape failure, distinct from a valid empty result list. */
  async getTrendingMovies(period: 'week'): Promise<TmdbTrendingMoviesResult | null> {
    if (!this.token) return null;
    await this.limiter.wait();
    const res = await fetchWithTimeout(`${TMDB_API}/trending/movie/${period}?language=vi-VN`, this.token);
    if (!res) return null;
    const data = await res.json<{ results?: unknown }>().catch(() => null);
    if (!data || !Array.isArray(data.results)) return null;

    const firstTwenty = data.results.slice(0, 20);
    const movies: TmdbTrendingMovie[] = [];
    let rejectedTypeCount = 0;
    for (const [index, raw] of firstTwenty.entries()) {
      if (!isTrendingMovie(raw)) {
        rejectedTypeCount++;
        continue;
      }
      movies.push({ rank: index + 1, id: raw.id, mediaType: 'movie' });
    }
    return { fetchedCount: firstTwenty.length, rejectedTypeCount, movies };
  }
}

function isTrendingMovie(value: unknown): value is { id: number; media_type?: 'movie' } {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  // `/trending/movie/week` is already the movie-specific endpoint. TMDB
  // may omit media_type on that response, but an explicitly mismatched
  // value is malformed and must never become a Hero candidate.
  return Number.isInteger(candidate.id) && (candidate.id as number) > 0
    && (candidate.media_type === undefined || candidate.media_type === 'movie');
}
