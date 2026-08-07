/**
 * PosterCard — individual movie poster card
 */
import { thumbUrl, posterUrl, upstreamFallback } from '../../api/ophim.js';
import { navigate } from '../../router.js';
import { applyImagePolicy, toTmdbW185 } from '../../lib/image.js';

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

// TMDB rating is what we display site-wide; getImdbScore is retained above for
// the catalog ranking algorithm (OPhim's imdb data is too sparse to show).
function getTmdbScore(movie) {
  const score = Number(movie.vote_average);
  if (!Number.isFinite(score) || score <= 0) return '';
  return score.toFixed(1);
}

/**
 * Render a single movie card into the given container.
 * @param {HTMLElement} container
 * @param {Object} movie - Movie item from API
 * @param {number|null} rank - If not null, display rank+1 as a large overlay number
 * @param {boolean} [priority] - Mark this card's poster as an LCP candidate (above the fold)
 */
export function renderPosterCard(container, movie, rank = null, priority = false) {
  const card = document.createElement('div');
  card.className = 'movie-card';
  card.addEventListener('click', () => navigate(`/phim/${movie.slug}`));

  // ── Poster image ──
  const img = document.createElement('img');
  img.className = 'movie-card__poster';
  const thumb = thumbUrl(movie.thumb_url);
  img.src = toTmdbW185(thumb);
  img.alt = movie.name;
  applyImagePolicy(img, { priority });

  // Fallback on error: retry the upstream origin if the R2 copy is not there
  // yet, then fall back to the wide artwork.
  img.addEventListener('error', () => {
    const upstream = upstreamFallback(img.src);
    if (upstream) {
      img.src = upstream;
      return;
    }
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
  }

  const tmdbScore = getTmdbScore(movie);
  if (tmdbScore) {
    if (movie.year) {
      const separator = document.createElement('span');
      separator.className = 'movie-card__meta-separator';
      separator.textContent = '·';
      overlayMeta.appendChild(separator);
    }

    const tmdb = document.createElement('span');
    tmdb.className = 'movie-card__tmdb';
    tmdb.textContent = 'TMDB';
    overlayMeta.appendChild(tmdb);

    const score = document.createElement('span');
    score.className = 'movie-card__tmdb-score';
    score.textContent = tmdbScore;
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
