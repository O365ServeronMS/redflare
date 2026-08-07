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
  actor?: string[];
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

  /** Exact TMDB-id lookup (plan-kkphim-migration.md §0.2, verified
   * 2026-08-07 against the real endpoint -- same response shape as
   * getDetail). Used by the recommendation resolver (Phase 4) to check
   * whether a TMDB recommendation target exists on KKPhim at all, without
   * guessing via keyword search. */
  async getByTmdbRef(type: 'movie' | 'tv', tmdbId: number): Promise<KkphimDetailResponse | null> {
    await this.limiter.wait();
    const res = await fetchWithTimeout(`${KKPHIM_BASE}/tmdb/${type}/${tmdbId}`);
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

  /** One page of a taxonomy listing, used by backfill (plan Phase 7).
   * Returns `totalPages` from the API's own pagination metadata --
   * deliberately NOT inferred from "did this page come back empty", which
   * conflates two different things: genuinely reaching the last page vs. a
   * transient fetch failure/timeout on some page in the middle. The first
   * production run of the backfill (2026-08-07) got this wrong the other
   * way and silently marked the whole catalog "done" after ~1 page/type
   * (91 movies synced against a real catalog phimapi.com reports as
   * 16,920 items for phim-le ALONE) -- see docs/state-ssr-rearchitecture.md
   * for the full account. `totalPages: null` means the response didn't
   * parse at all (network/shape failure), which the caller must treat as
   * "retry this same page later", never as "this type is exhausted". */
  async getListingPage(type: string, page: number): Promise<{ items: KkphimListItem[]; totalPages: number | null }> {
    await this.limiter.wait();
    const res = await fetchWithTimeout(`${KKPHIM_BASE}/v1/api/danh-sach/${type}?page=${page}`);
    if (!res) return { items: [], totalPages: null };
    const data = await res
      .json<{ data?: { items?: KkphimListItem[]; params?: { pagination?: { totalPages?: number } } } }>()
      .catch(() => null);
    if (!data) return { items: [], totalPages: null };
    return {
      items: data.data?.items ?? [],
      totalPages: data.data?.params?.pagination?.totalPages ?? null,
    };
  }
}
