import { escapeHtml } from './escape';
import type { MovieRow } from '../types/movie';

/** One movie card. Was copy-pasted across homePage/listPage/searchPage/
 * detailPage with small drifting differences; consolidated here so the
 * grid looks identical everywhere and CSS has one stable hook. */
export function movieCard(m: MovieRow): string {
  const title = escapeHtml(m.title);
  const img = m.thumb_path ?? m.poster_path ?? '';
  const badge = m.has_stream ? escapeHtml(m.episode_current || 'Xem Ngay') : 'Trailer';
  const year = m.release_year ? String(m.release_year) : '';

  return `<li class="card">
  <a class="card__link" href="/phim/${escapeHtml(m.slug)}">
    <div class="card__thumb">
      ${
        img
          ? `<img src="${escapeHtml(img)}" alt="${title}" width="342" height="513" loading="lazy" decoding="async">`
          : '<div class="card__placeholder" aria-hidden="true"></div>'
      }
      <span class="card__badge">${badge}</span>
    </div>
    <span class="card__title">${title}</span>
    ${year ? `<span class="card__meta">${year}</span>` : ''}
  </a>
</li>`;
}

export function movieGrid(items: readonly MovieRow[]): string {
  return `<ul class="grid">${items.map(movieCard).join('')}</ul>`;
}
