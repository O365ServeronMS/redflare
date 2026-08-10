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

export interface TmdbSeasonDetail {
  poster_path?: string | null;
}

export interface TmdbRecommendation {
  id: number;
}

export type TmdbDetailResult =
  | { kind: 'success'; data: TmdbDetail }
  | { kind: 'retryable_error'; status?: number };

export type TmdbRecommendationResult =
  | { kind: 'success'; ids: number[] }
  | { kind: 'retryable_error'; status?: number };

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
    const result = await this.getDetailResult(type, id);
    return result.kind === 'success' ? result.data : null;
  }

  /** Preserve a transient failure so recommendation resolve can retry later. */
  async getDetailResult(type: TmdbType, id: number): Promise<TmdbDetailResult> {
    if (!this.token) return { kind: 'retryable_error' };
    await this.limiter.wait();
    const res = await fetchWithTimeout(
      `${TMDB_API}/${type}/${id}?language=vi-VN&append_to_response=videos`,
      this.token
    );
    if (!res) return { kind: 'retryable_error' };
    const data: unknown = await res.json().catch(() => null);
    if (!isRecord(data)) return { kind: 'retryable_error' };
    return { kind: 'success', data: data as TmdbDetail };
  }

  async getSeasonDetail(seriesId: number, seasonNumber: number): Promise<TmdbSeasonDetail | null> {
    if (!this.token) return null;
    await this.limiter.wait();
    const res = await fetchWithTimeout(
      `${TMDB_API}/tv/${seriesId}/season/${seasonNumber}?language=vi-VN`,
      this.token
    );
    if (!res) return null;
    return res.json<TmdbSeasonDetail>().catch(() => null);
  }

  /** Top-N recommendation ids in rank order -- the raw ids only. Resolving
   * them to catalog slugs (or promoting to stubs) is Phase 4's job, not
   * this client's. */
  async getRecommendationIds(type: TmdbType, id: number, limit: number): Promise<TmdbRecommendationResult> {
    if (!this.token) return { kind: 'retryable_error' };
    await this.limiter.wait();
    const res = await fetchWithTimeout(`${TMDB_API}/${type}/${id}/recommendations?language=vi-VN`, this.token);
    if (!res) return { kind: 'retryable_error' };
    const data: unknown = await res.json().catch(() => null);
    if (!isRecord(data) || !Array.isArray(data.results)) return { kind: 'retryable_error' };
    const ids: number[] = [];
    const seen = new Set<number>();
    for (const item of data.results) {
      const candidate = isRecord(item) ? item.id : undefined;
      if (!Number.isInteger(candidate) || (candidate as number) <= 0 || seen.has(candidate as number)) continue;
      seen.add(candidate as number);
      ids.push(candidate as number);
      if (ids.length === limit) break;
    }
    return { kind: 'success', ids };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
