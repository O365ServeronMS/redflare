import { normalizeVietnamese } from './vietnamese';

/** Stub movies (Phase 4, ADR-0002 Finding 3) have no KKPhim slug -- they
 * never existed in that catalog to begin with. Derive a URL from the TMDB
 * title, with the tmdb id appended so two different titles that slugify
 * the same way can't collide. */
export function slugifyStub(title: string, tmdbType: 'movie' | 'tv', tmdbId: number): string {
  const base = normalizeVietnamese(title)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return `${base || 'phim'}-${tmdbType}-${tmdbId}`;
}
