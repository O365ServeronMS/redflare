import { escapeHtml } from './escape';
import { renderPage } from './layout';
import { movieGrid } from './card';
import { breadcrumbJsonLd, SITE_ORIGIN, truncateDescription } from './seo';
import { encodeCursor, type Cursor } from '../lib/cursor';
import type { MovieRow } from '../types/movie';

export interface ListPageInput {
  h1: string;
  description: string;
  canonicalPath: string; // e.g. /danh-sach/phim-le
  breadcrumb: { name: string; url: string }[];
  items: MovieRow[];
  nextCursor: Cursor | null;
}

/** Shared by /danh-sach/:type, /the-loai/:slug, /quoc-gia/:slug (plan §3:
 * "Trang list/genre/country: 1 COUNT + 1 SELECT LIMIT 24" -- the COUNT is
 * skipped since keyset pagination doesn't need a total to produce a
 * next-page link, only the movie repository's limit+1 probe). */
export function renderListPage(input: ListPageInput): string {
  const canonical = `${SITE_ORIGIN}${input.canonicalPath}`;
  const nextHref = input.nextCursor
    ? `${input.canonicalPath}?cursor=${encodeURIComponent(encodeCursor(input.nextCursor))}`
    : null;

  const body = `<h1 class="page-title">${escapeHtml(input.h1)}</h1>
${input.items.length === 0 ? '<p class="empty">Chưa có phim nào trong mục này.</p>' : movieGrid(input.items)}
${nextHref ? `<nav class="pager"><a class="pager__next" href="${escapeHtml(nextHref)}" rel="next">Trang sau →</a></nav>` : ''}`;

  return renderPage(
    {
      title: `${input.h1} — Film Bluesia`,
      description: truncateDescription(input.description),
      canonical,
      ogType: 'website',
      jsonLd: [breadcrumbJsonLd(input.breadcrumb)],
    },
    body
  );
}
