import { renderPage } from './layout';
import { movieGrid } from './card';
import { SITE_ORIGIN, SITE_NAME } from './seo';
import type { MovieRow } from '../types/movie';

/** Header/nav/search live in the layout now (every page gets them), so this
 * is just the content. */
export function renderHomePage(recent: MovieRow[]): string {
  const body = `<h1 class="page-title">Phim Mới Cập Nhật</h1>
${
  recent.length === 0
    ? '<p class="empty">Chưa có phim nào. Dữ liệu đang được đồng bộ.</p>'
    : movieGrid(recent)
}`;

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
