/**
 * MovieCard — individual movie poster card
 */
import { thumbUrl, posterUrl } from '../api/ophim.js';
import { navigate } from '../router.js';

/**
 * Render a single movie card into the given container.
 * @param {HTMLElement} container
 * @param {Object} movie - Movie item from API
 * @param {number|null} rank - If not null, display rank+1 as a large overlay number
 */
export function renderMovieCard(container, movie, rank = null) {
  const card = document.createElement('div');
  card.className = 'movie-card';
  card.addEventListener('click', () => navigate(`/phim/${movie.slug}`));

  // ── Poster image ──
  const img = document.createElement('img');
  img.className = 'movie-card__poster';
  img.src = thumbUrl(movie.thumb_url);
  img.alt = movie.name;
  img.loading = 'lazy';

  // Fallback on error
  img.addEventListener('error', () => {
    const fallback = posterUrl(movie.poster_url);
    if (img.src !== fallback) {
      img.src = fallback;
    }
  });

  card.appendChild(img);

  // ── Hover overlay ──
  const overlay = document.createElement('div');
  overlay.className = 'movie-card__overlay';

  const overlayName = document.createElement('span');
  overlayName.className = 'movie-card__overlay-name';
  overlayName.textContent = movie.name;
  overlay.appendChild(overlayName);

  if (movie.year) {
    const overlayYear = document.createElement('span');
    overlayYear.className = 'movie-card__overlay-year';
    overlayYear.textContent = movie.year;
    overlay.appendChild(overlayYear);
  }

  card.appendChild(overlay);

  // ── Rank number overlay ──
  if (rank !== null) {
    const rankEl = document.createElement('div');
    rankEl.className = 'movie-card__rank';
    rankEl.textContent = rank + 1;
    card.appendChild(rankEl);
  }

  container.appendChild(card);
}
