import { escapeHtml } from './escape';
import { renderPage } from './layout';
import { movieGrid } from './card';
import { breadcrumbJsonLd, SITE_ORIGIN, truncateDescription } from './seo';
import type { MovieRow } from '../types/movie';

// No pagination -- unlike list/genre/country, search result ordering is
// FTS5's `rank` relevance score, not a stable (last_synced, slug) keyset,
// so there's no cheap way to hand out a "next page" cursor. A single top-N
// page covers the case that matters.
export function renderSearchPage(query: string, results: MovieRow[]): string {
  const canonical = `${SITE_ORIGIN}/tim-kiem?q=${encodeURIComponent(query)}`;
  const h1 = `Kết quả tìm kiếm: "${query}"`;

  const body = `<h1 class="page-title">${escapeHtml(h1)}</h1>
${
  results.length === 0
    ? `<p class="empty">Không tìm thấy phim nào khớp với "${escapeHtml(query)}".</p>`
    : movieGrid(results)
}`;

  return renderPage(
    {
      title: `${h1} — Film Bluesia`,
      description: truncateDescription(`Kết quả tìm kiếm cho "${query}" trên Film Bluesia.`),
      canonical,
      noindex: true, // query-dependent, not a stable page worth indexing
      jsonLd: [
        breadcrumbJsonLd([
          { name: 'Trang chủ', url: SITE_ORIGIN },
          { name: 'Tìm kiếm', url: canonical },
        ]),
      ],
    },
    body,
    { searchQuery: query }
  );
}
