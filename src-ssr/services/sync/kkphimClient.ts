import { RateLimiter } from './throttle';

const KKPHIM_BASE = 'https://phimapi.com';

export interface KkphimTaxonomy {
  name: string;
  slug: string;
  id: string;
}

export interface KkphimEpisodeServerData {
  name: string;
  slug: string;
  filename: string;
  link_embed: string;
  link_m3u8: string;
}

export interface KkphimEpisodeServer {
  server_name: string;
  server_data: KkphimEpisodeServerData[];
}

export interface KkphimMovie {
  tmdb: { id: string | null; type: 'movie' | 'tv' | null; season: number | null } | null;
  imdb: { id: string | null } | null;
  modified: { time: string };
  slug: string;
  name: string;
  origin_name: string;
  content: string;
  type: string;
  status: string;
  thumb_url: string | null;
  poster_url: string | null;
  trailer_url: string | null;
  time: string;
  episode_current: string;
  quality: string;
  lang: string;
  year: number;
  category: KkphimTaxonomy[];
  country: KkphimTaxonomy[];
}

export interface KkphimDetailResponse {
  status: boolean;
  movie: KkphimMovie;
  episodes: KkphimEpisodeServer[];
}

export interface KkphimListItem {
  slug: string;
  modified: { time: string };
}

// Cron egress, not a user request -- a short timeout with no retry is the
// right trade here. The previous architecture's 8s x 2-attempt timeout in
// the request path produced a measured ~11.4% 504 rate
// (docs/state-hit-rate.md Phase 10); skipping a slow item this tick and
// catching it next tick is strictly better than blocking the shard.
async function fetchWithTimeout(url: string, ms = 5000): Promise<Response | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return res.ok ? res : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export class KkphimClient {
  constructor(private readonly limiter: RateLimiter) {}

  async getDetail(slug: string): Promise<KkphimDetailResponse | null> {
    await this.limiter.wait();
    const res = await fetchWithTimeout(`${KKPHIM_BASE}/phim/${slug}`);
    if (!res) return null;
    const data = await res.json<KkphimDetailResponse>().catch(() => null);
    return data?.status && data.movie ? data : null;
  }

  /** One page of the "recently updated" feed, used by the incremental sync
   * cursor (plan §2.1). */
  async getRecentPage(page: number): Promise<KkphimListItem[]> {
    await this.limiter.wait();
    const res = await fetchWithTimeout(`${KKPHIM_BASE}/danh-sach/phim-moi-cap-nhat?page=${page}`);
    if (!res) return [];
    const data = await res.json<{ items?: KkphimListItem[] }>().catch(() => null);
    return data?.items ?? [];
  }

  /** One page of a taxonomy listing, used by backfill (plan Phase 7). */
  async getListingPage(type: string, page: number): Promise<KkphimListItem[]> {
    await this.limiter.wait();
    const res = await fetchWithTimeout(`${KKPHIM_BASE}/v1/api/danh-sach/${type}?page=${page}`);
    if (!res) return [];
    const data = await res.json<{ data?: { items?: KkphimListItem[] } }>().catch(() => null);
    return data?.data?.items ?? [];
  }
}
