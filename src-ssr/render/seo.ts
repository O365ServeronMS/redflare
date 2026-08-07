import { escapeHtml } from './escape';
import type { MovieRow } from '../types/movie';

export const SITE_ORIGIN = 'https://phim.bluesia.net';
export const SITE_NAME = 'Film Bluesia';

export function truncateDescription(text: string, max = 160): string {
  const clean = text.trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, max - 1).trimEnd() + '…';
}

export interface HeadMeta {
  title: string;
  description: string;
  canonical: string;
  ogType?: string;
  ogImage?: string | null;
  noindex?: boolean;
  jsonLd?: unknown[];
}

/** Every SSR page's <head> goes through this -- the one place canonical,
 * OG, Twitter Card and JSON-LD are assembled, so no route can forget one
 * (ADR-0002 / plan §3.2: every page must carry the full SEO set). */
export function renderHead(meta: HeadMeta): string {
  const title = escapeHtml(meta.title);
  const description = escapeHtml(meta.description);
  const canonical = escapeHtml(meta.canonical);
  const ogImageTag = meta.ogImage ? `<meta property="og:image" content="${escapeHtml(meta.ogImage)}">` : '';
  const jsonLdTags = (meta.jsonLd ?? [])
    .map((obj) => `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, '\\u003c')}</script>`)
    .join('\n');

  return `<meta charset="utf-8">
<title>${title}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="${description}">
${meta.noindex ? '<meta name="robots" content="noindex, nofollow">' : ''}
<link rel="canonical" href="${canonical}">
<meta property="og:site_name" content="${escapeHtml(SITE_NAME)}">
<meta property="og:type" content="${escapeHtml(meta.ogType ?? 'website')}">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:url" content="${canonical}">
${ogImageTag}
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${description}">
${jsonLdTags}`;
}

export function movieJsonLd(movie: MovieRow, url: string): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': movie.tmdb_type === 'tv' ? 'TVSeries' : 'Movie',
    name: movie.title,
    description: movie.overview ?? undefined,
    image: movie.poster_path ?? undefined,
    dateCreated: movie.release_year ? String(movie.release_year) : undefined,
    aggregateRating:
      movie.vote_average && movie.vote_count
        ? {
            '@type': 'AggregateRating',
            ratingValue: movie.vote_average,
            ratingCount: movie.vote_count,
            bestRating: 10,
          }
        : undefined,
    url,
  };
}

export function breadcrumbJsonLd(items: { name: string; url: string }[]): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: item.name,
      item: item.url,
    })),
  };
}
