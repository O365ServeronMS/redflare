import { escapeHtml } from './escape';
import { renderPage } from './layout';
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

function cardHtml(m: MovieRow): string {
  const title = escapeHtml(m.title);
  const img = m.thumb_path ?? m.poster_path ?? '';
  return `<li>
  <a href="/phim/${escapeHtml(m.slug)}">
    ${img ? `<img src="${escapeHtml(img)}" alt="${title}" width="342" height="513" loading="lazy">` : ''}
    <span>${title}</span>
  </a>
</li>`;
}

/** Shared by /danh-sach/:type, /the-loai/:slug, /quoc-gia/:slug (plan §3:
 * "Trang list/genre/country: 1 COUNT + 1 SELECT LIMIT 24" -- the COUNT is
 * skipped here since keyset pagination doesn't need a total to produce a
 * next-page link, only the movie repository's limit+1 probe). */
export function renderListPage(input: ListPageInput): string {
  const canonical = `${SITE_ORIGIN}${input.canonicalPath}`;
  const nextHref = input.nextCursor
    ? `${input.canonicalPath}?cursor=${encodeURIComponent(encodeCursor(input.nextCursor))}`
    : null;

  const body = `<h1>${escapeHtml(input.h1)}</h1>
<ul>${input.items.map(cardHtml).join('')}</ul>
${nextHref ? `<a href="${escapeHtml(nextHref)}" rel="next">Trang sau</a>` : ''}`;

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
