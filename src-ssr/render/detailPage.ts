import { escapeHtml } from './escape';
import type { EpisodeRecord, MovieRow } from '../types/movie';

// Deliberately minimal -- this exists to satisfy Phase 1's verify criterion
// ("wrangler dev returns one real detail page from D1") and to give Phase 2
// something to look at while sync is being built. Full SEO surface
// (canonical, OG/Twitter Card, JSON-LD, breadcrumb, meta description
// tuning, recommendation block) is Phase 3 scope (plan-ssr-rearchitecture.md
// §3.2) -- do not extend this file to cover that; Phase 3 replaces it.
export function renderDetailPage(movie: MovieRow, episodes: EpisodeRecord[]): string {
  const title = escapeHtml(movie.title);
  const overview = escapeHtml(movie.overview ?? '');
  const posterSrc = movie.poster_path ? escapeHtml(movie.poster_path) : '';
  const cta = movie.has_stream ? 'Xem Ngay' : 'Xem Trailer';

  const episodeList = episodes
    .map((ep) => `<li>${escapeHtml(ep.server)} — ${escapeHtml(ep.epName)}</li>`)
    .join('');

  return `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<title>${title}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body>
<h1>${title}</h1>
${posterSrc ? `<img src="${posterSrc}" alt="${title}" width="1280" height="720" loading="eager">` : ''}
<p>${overview}</p>
<p><a href="/xem/${escapeHtml(movie.slug)}">${cta}</a></p>
<ul>${episodeList}</ul>
</body>
</html>`;
}
