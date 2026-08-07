import { escapeHtml } from './escape';
import { renderPage } from './layout';
import { SITE_ORIGIN, SITE_NAME } from './seo';
import { LIST_TYPE_LABELS } from '../lib/listTypes';
import type { MovieRow } from '../types/movie';

function cardHtml(m: MovieRow): string {
  const title = escapeHtml(m.title);
  const img = m.thumb_path ?? m.poster_path ?? '';
  const cta = m.has_stream ? 'Xem Ngay' : 'Xem Trailer';
  return `<li>
  <a href="/phim/${escapeHtml(m.slug)}">
    ${img ? `<img src="${escapeHtml(img)}" alt="${title}" width="342" height="513" loading="lazy">` : ''}
    <span>${title}</span>
    <em>${cta}</em>
  </a>
</li>`;
}

/** The one page Phase 3 deliberately left as a placeholder (it covered
 * detail/list/genre/country only, plan §3) -- built once the catalog had
 * real synced data to show instead of an empty shell. Same rendering
 * primitives as every other page: no framework, no client JS, full SEO. */
export function renderHomePage(recent: MovieRow[]): string {
  const navLinks = Object.entries(LIST_TYPE_LABELS)
    .map(([slug, { label }]) => `<li><a href="/danh-sach/${escapeHtml(slug)}">${escapeHtml(label)}</a></li>`)
    .join('');

  const body = `<h1>${escapeHtml(SITE_NAME)}</h1>
<nav><ul>${navLinks}</ul></nav>
<form action="/tim-kiem" method="get" role="search">
  <input type="text" name="q" placeholder="Tìm phim..." maxlength="100" required>
  <button type="submit">Tìm</button>
</form>
<section aria-label="Phim mới cập nhật">
  <h2>Phim Mới Cập Nhật</h2>
  <ul>${recent.map(cardHtml).join('')}</ul>
</section>`;

  return renderPage(
    {
      title: `${SITE_NAME} — Xem Phim Online`,
      description: 'Xem phim online miễn phí, cập nhật liên tục. Phim lẻ, phim bộ, hoạt hình, TV Shows.',
      canonical: SITE_ORIGIN,
      ogType: 'website',
      jsonLd: [
        {
          '@context': 'https://schema.org',
          '@type': 'WebSite',
          name: SITE_NAME,
          url: SITE_ORIGIN,
          potentialAction: {
            '@type': 'SearchAction',
            target: `${SITE_ORIGIN}/tim-kiem?q={search_term_string}`,
            'query-input': 'required name=search_term_string',
          },
        },
      ],
    },
    body
  );
}
