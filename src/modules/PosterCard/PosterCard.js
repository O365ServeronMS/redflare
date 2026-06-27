/**
 * PosterCard — individual movie poster card
 */
import { thumbUrl, posterUrl } from '../../api/ophim.js';
import { navigate } from '../../router.js';

function getImdbScore(movie) {
  const rawScore =
    movie.imdb?.vote_average ??
    movie.imdb?.rating ??
    movie.imdb?.score ??
    movie.imdb;

  if (rawScore === null || rawScore === undefined || rawScore === '') {
    return '';
  }

  const score = Number(rawScore);
  if (!Number.isFinite(score) || score <= 0) {
    return '';
  }

  return score.toFixed(1);
}

/**
 * Render a single movie card into the given container.
 * @param {HTMLElement} container
 * @param {Object} movie - Movie item from API
 * @param {number|null} rank - If not null, display rank+1 as a large overlay number
 */
export function renderPosterCard(container, movie, rank = null) {
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

  // ── Status/Quality Badge ──
  let badgeText = '';
  let epCurrent = movie.episode_current || '';
  
  // Format episode string to be shorter for mobile
  if (epCurrent.includes('Hoàn tất') || epCurrent.includes('hoàn tất')) {
    const match = epCurrent.match(/\((.*?)\)/);
    if (match) {
      epCurrent = `Full ${match[1]}`; // e.g., "Full 36/36"
    } else {
      epCurrent = 'Full';
    }
  }
  
  if (movie.type === 'single') {
    if (epCurrent.toLowerCase().includes('trailer') || movie.status === 'trailer') {
      badgeText = 'Trailer';
    } else {
      badgeText = movie.quality || 'HD';
    }
  } else {
    // For series, hoathinh, etc.
    badgeText = epCurrent;
  }

  if (badgeText) {
    const badge = document.createElement('div');
    badge.className = 'movie-card__quality';
    badge.textContent = badgeText;
    card.appendChild(badge);
  }

  // ── Hover overlay ──
  const overlay = document.createElement('div');
  overlay.className = 'movie-card__overlay';

  const overlayName = document.createElement('span');
  overlayName.className = 'movie-card__title';
  overlayName.textContent = movie.name;
  overlay.appendChild(overlayName);

  const overlayMeta = document.createElement('div');
  overlayMeta.className = 'movie-card__meta';

  if (movie.year) {
    const overlayYear = document.createElement('span');
    overlayYear.className = 'movie-card__year';
    overlayYear.textContent = movie.year;
    overlayMeta.appendChild(overlayYear);

    const separator = document.createElement('span');
    separator.className = 'movie-card__meta-separator';
    separator.textContent = '·';
    overlayMeta.appendChild(separator);
  }

  const imdb = document.createElement('span');
  imdb.className = 'movie-card__imdb';
  imdb.textContent = 'IMDb';
  overlayMeta.appendChild(imdb);

  const imdbScore = getImdbScore(movie);
  if (imdbScore) {
    const score = document.createElement('span');
    score.className = 'movie-card__imdb-score';
    score.textContent = imdbScore;
    overlayMeta.appendChild(score);
  }

  overlay.appendChild(overlayMeta);

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
