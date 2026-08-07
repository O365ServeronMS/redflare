import { escapeHtml } from './escape';
import { renderHead, SITE_NAME, type HeadMeta } from './seo';
import { LIST_TYPE_LABELS } from '../lib/listTypes';

// Bump when styles.css changes -- the file is served with a long
// browser-cache lifetime (public-ssr/_headers), so a query-string version
// is what actually busts it for returning visitors.
const STYLES_VERSION = 1;

// A handful of high-traffic taxonomy links for the footer. Kept as a fixed
// list rather than queried from D1 so the layout costs zero extra D1 reads
// on every single page render (the full set lives in /sitemap-static.xml).
const FOOTER_GENRES = [
  ['hanh-dong', 'Hành Động'],
  ['tinh-cam', 'Tình Cảm'],
  ['hai-huoc', 'Hài Hước'],
  ['kinh-di', 'Kinh Dị'],
  ['vien-tuong', 'Viễn Tưởng'],
  ['co-trang', 'Cổ Trang'],
];
const FOOTER_COUNTRIES = [
  ['viet-nam', 'Việt Nam'],
  ['han-quoc', 'Hàn Quốc'],
  ['trung-quoc', 'Trung Quốc'],
  ['nhat-ban', 'Nhật Bản'],
  ['au-my', 'Âu Mỹ'],
  ['thai-lan', 'Thái Lan'],
];

function siteHeader(query = ''): string {
  const navLinks = Object.entries(LIST_TYPE_LABELS)
    .map(([slug, { label }]) => `<li><a href="/danh-sach/${escapeHtml(slug)}">${escapeHtml(label)}</a></li>`)
    .join('');

  return `<header class="header">
  <div class="header__inner">
    <a class="header__logo" href="/">${escapeHtml(SITE_NAME)}</a>
    <nav class="header__nav" aria-label="Danh mục"><ul>${navLinks}</ul></nav>
    <form class="header__search" action="/tim-kiem" method="get" role="search">
      <input type="search" name="q" placeholder="Tìm phim..." maxlength="100" required
             aria-label="Tìm phim" value="${escapeHtml(query)}">
      <button type="submit">Tìm</button>
    </form>
  </div>
</header>`;
}

function siteFooter(): string {
  const col = (title: string, links: string[][], base: string) =>
    `<div class="footer__col">
      <h3>${escapeHtml(title)}</h3>
      <ul>${links
        .map(([slug, label]) => `<li><a href="${base}/${escapeHtml(slug as string)}">${escapeHtml(label as string)}</a></li>`)
        .join('')}</ul>
    </div>`;

  return `<footer class="footer">
  <div class="footer__inner">
    ${col('Thể Loại', FOOTER_GENRES, '/the-loai')}
    ${col('Quốc Gia', FOOTER_COUNTRIES, '/quoc-gia')}
    <div class="footer__col">
      <h3>${escapeHtml(SITE_NAME)}</h3>
      <p>Dự án cá nhân phi lợi nhuận, phục vụ mục đích học tập.</p>
    </div>
  </div>
</footer>`;
}

/** Every page shares this shell. The header used to exist only on the home
 * page, which meant anyone landing on a detail page from search had no
 * navigation at all -- bad for users and for internal linking/crawl depth. */
export function renderPage(meta: HeadMeta, bodyHtml: string, opts: { searchQuery?: string } = {}): string {
  return `<!doctype html>
<html lang="vi">
<head>
${renderHead(meta)}
<link rel="preconnect" href="https://image.tmdb.org" crossorigin>
<link rel="preconnect" href="https://phimimg.com" crossorigin>
<link rel="stylesheet" href="/styles.css?v=${STYLES_VERSION}">
</head>
<body>
${siteHeader(opts.searchQuery ?? '')}
<main class="main">
${bodyHtml}
</main>
${siteFooter()}
</body>
</html>`;
}
