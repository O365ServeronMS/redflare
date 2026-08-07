import { escapeHtml } from './escape';
import { renderPage } from './layout';
import { breadcrumbJsonLd, movieJsonLd, SITE_ORIGIN, truncateDescription } from './seo';
import type { EpisodeRecord, MovieRow } from '../types/movie';

export interface DetailPageInput {
  movie: MovieRow;
  episodes: EpisodeRecord[];
  recommendations: MovieRow[];
}

function recommendationCard(m: MovieRow): string {
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

/** Full SEO detail page (plan §3.2/§3.3). Player strategy per ADR-0002:
 * has_stream -> "Xem Ngay" linking to the one hydrated route (/xem/:slug),
 * else "Xem Trailer" -- a movie with zero stream still gets a complete,
 * indexable detail page (the whole point of the handoff's "always show
 * recommendations, never hide unstreamed titles" rule for SEO/crawl
 * depth). */
export function renderDetailPage(input: DetailPageInput): string {
  const { movie, episodes, recommendations } = input;
  const canonical = `${SITE_ORIGIN}/phim/${movie.slug}`;
  const title = escapeHtml(movie.title);
  const overview = movie.overview ?? '';

  const cta = movie.has_stream
    ? `<a href="/xem/${escapeHtml(movie.slug)}">▶ Xem Ngay</a>`
    : movie.youtube_trailer_key
      ? `<div><iframe width="560" height="315" loading="lazy"
          src="https://www.youtube.com/embed/${escapeHtml(movie.youtube_trailer_key)}"
          title="${title} - Trailer" allowfullscreen></iframe></div>`
      : '';

  const episodeList =
    episodes.length > 0
      ? `<ul>${episodes.map((e) => `<li>${escapeHtml(e.server)} — ${escapeHtml(e.epName)}</li>`).join('')}</ul>`
      : '';

  const recBlock =
    recommendations.length > 0
      ? `<section aria-label="Có thể bạn cũng thích">
  <h2>Có thể bạn cũng thích</h2>
  <ul>${recommendations.map(recommendationCard).join('')}</ul>
</section>`
      : '';

  const genres: { slug: string; name: string }[] = JSON.parse(movie.genres_json || '[]');
  const countries: { slug: string; name: string }[] = JSON.parse(movie.countries_json || '[]');
  const genreLinks = genres.map((g) => `<a href="/the-loai/${escapeHtml(g.slug)}">${escapeHtml(g.name)}</a>`).join(', ');
  const countryLinks = countries
    .map((c) => `<a href="/quoc-gia/${escapeHtml(c.slug)}">${escapeHtml(c.name)}</a>`)
    .join(', ');

  const body = `<h1>${title}</h1>
${movie.poster_path ? `<img src="${escapeHtml(movie.poster_path)}" alt="${title}" width="1280" height="720" loading="eager">` : ''}
<p>${escapeHtml(overview)}</p>
<p>${genreLinks}</p>
<p>${countryLinks}</p>
${cta}
${episodeList}
${recBlock}`;

  return renderPage(
    {
      title: `${movie.title} - Xem Phim | Film Bluesia`,
      description: truncateDescription(overview || movie.title),
      canonical,
      ogType: movie.tmdb_type === 'tv' ? 'video.tv_show' : 'video.movie',
      ogImage: movie.poster_path,
      jsonLd: [
        movieJsonLd(movie, canonical),
        breadcrumbJsonLd([
          { name: 'Trang chủ', url: SITE_ORIGIN },
          { name: movie.title, url: canonical },
        ]),
      ],
    },
    body
  );
}
