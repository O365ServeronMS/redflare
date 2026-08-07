import { escapeHtml } from './escape'; // same escaping rules cover XML's reserved chars too
import { SITE_ORIGIN } from './seo';

function isoDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

export function renderSitemapIndex(sitemapUrls: string[]): string {
  const entries = sitemapUrls
    .map((url) => `<sitemap><loc>${escapeHtml(url)}</loc></sitemap>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries}</sitemapindex>`;
}

export function renderUrlset(urls: { loc: string; lastmod?: number }[]): string {
  const entries = urls
    .map(
      (u) =>
        `<url><loc>${escapeHtml(u.loc)}</loc>${u.lastmod ? `<lastmod>${isoDate(u.lastmod)}</lastmod>` : ''}</url>`
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries}</urlset>`;
}

export function renderRobotsTxt(): string {
  return `User-agent: *
Allow: /
Sitemap: ${SITE_ORIGIN}/sitemap.xml
`;
}
