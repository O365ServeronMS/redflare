import { escapeHtml } from './escape';
import { renderPage } from './layout';
import { breadcrumbJsonLd, SITE_ORIGIN, truncateDescription } from './seo';
import type { MovieRow } from '../types/movie';

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

// No pagination -- unlike list/genre/country, search result ordering is
// FTS5's `rank` relevance score, not a stable (last_synced, slug) keyset,
// so there's no cheap way to hand out a "next page" cursor. A single top-N
// page covers the case that matters; deep search pagination is a rare
// enough behavior on a catalog site to not be worth the complexity here.
export function renderSearchPage(query: string, results: MovieRow[]): string {
  const canonical = `${SITE_ORIGIN}/tim-kiem?q=${encodeURIComponent(query)}`;
  const h1 = `Kết quả tìm kiếm: "${query}"`;

  const body = `<h1>${escapeHtml(h1)}</h1>
${results.length === 0 ? '<p>Không tìm thấy kết quả.</p>' : `<ul>${results.map(cardHtml).join('')}</ul>`}`;

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
    body
  );
}
