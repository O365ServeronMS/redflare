import { escapeHtml } from './escape';
import { renderPage } from './layout';
import { movieGrid } from './card';
import { breadcrumbJsonLd, movieJsonLd, SITE_ORIGIN, truncateDescription } from './seo';
import type { EpisodeRecord, MovieRow } from '../types/movie';

export interface DetailPageInput {
  movie: MovieRow;
  episodes: EpisodeRecord[];
  recommendations: MovieRow[];
}

function chips(items: { slug: string; name: string }[], base: string): string {
  if (items.length === 0) return '';
  return `<div class="chips">${items
    .map((i) => `<a class="chip" href="${base}/${escapeHtml(i.slug)}">${escapeHtml(i.name)}</a>`)
    .join('')}</div>`;
}

function factRow(label: string, value: string): string {
  return value ? `<div class="facts__row"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>` : '';
}

/** Player strategy per ADR-0002: has_stream -> "Xem Ngay" linking to the
 * one hydrated route (/xem/:slug), else an embedded trailer -- a movie with
 * no stream still gets a complete, indexable page. */
export function renderDetailPage(input: DetailPageInput): string {
  const { movie, episodes, recommendations } = input;
  const canonical = `${SITE_ORIGIN}/phim/${movie.slug}`;
  const title = escapeHtml(movie.title);
  const overview = movie.overview ?? '';
  const poster = movie.thumb_path ?? movie.poster_path ?? '';
  const backdrop = movie.poster_path ?? '';

  const genres: { slug: string; name: string }[] = JSON.parse(movie.genres_json || '[]');
  const countries: { slug: string; name: string }[] = JSON.parse(movie.countries_json || '[]');

  const cta = movie.has_stream
    ? `<a class="btn btn--primary" href="/xem/${escapeHtml(movie.slug)}">▶ Xem Ngay</a>`
    : movie.youtube_trailer_key
      ? `<a class="btn btn--primary" href="https://www.youtube.com/watch?v=${escapeHtml(movie.youtube_trailer_key)}"
           target="_blank" rel="noopener">▶ Xem Trailer</a>`
      : '';

  const episodeList =
    episodes.length > 0
      ? `<section class="section">
  <h2 class="section__title">Danh sách tập</h2>
  <ul class="episodes">${episodes
    .map(
      (e) =>
        `<li><a class="episode" href="/xem/${escapeHtml(movie.slug)}/${escapeHtml(e.epSlug)}">${escapeHtml(e.epName)}</a></li>`
    )
    .join('')}</ul>
</section>`
      : '';

  const trailerEmbed =
    !movie.has_stream && movie.youtube_trailer_key
      ? `<section class="section">
  <h2 class="section__title">Trailer</h2>
  <div class="embed"><iframe src="https://www.youtube.com/embed/${escapeHtml(movie.youtube_trailer_key)}"
    title="${title} - Trailer" loading="lazy" allowfullscreen></iframe></div>
</section>`
      : '';

  const recBlock =
    recommendations.length > 0
      ? `<section class="section">
  <h2 class="section__title">Có thể bạn cũng thích</h2>
  ${movieGrid(recommendations)}
</section>`
      : '';

  const body = `<article class="detail">
  <div class="detail__hero">
    ${backdrop ? `<img class="detail__backdrop" src="${escapeHtml(backdrop)}" alt="" aria-hidden="true" loading="lazy" decoding="async">` : ''}
    <div class="detail__head">
      ${poster ? `<img class="detail__poster" src="${escapeHtml(poster)}" alt="${title}" width="342" height="513" decoding="async">` : ''}
      <div class="detail__info">
        <h1 class="detail__title">${title}</h1>
        ${movie.original_title ? `<p class="detail__original">${escapeHtml(movie.original_title)}</p>` : ''}
        <dl class="facts">
          ${factRow('Năm', movie.release_year ? String(movie.release_year) : '')}
          ${factRow('Thời lượng', movie.runtime ?? '')}
          ${factRow('Chất lượng', movie.quality ?? '')}
          ${factRow('Ngôn ngữ', movie.lang ?? '')}
          ${factRow('Trạng thái', movie.episode_current ?? '')}
          ${factRow('Điểm TMDB', movie.vote_average ? movie.vote_average.toFixed(1) : '')}
        </dl>
        ${chips(genres, '/the-loai')}
        ${chips(countries, '/quoc-gia')}
        ${cta}
      </div>
    </div>
  </div>
  ${overview ? `<section class="section"><h2 class="section__title">Nội dung</h2><p class="detail__overview">${escapeHtml(overview)}</p></section>` : ''}
  ${trailerEmbed}
  ${episodeList}
  ${recBlock}
</article>`;

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
