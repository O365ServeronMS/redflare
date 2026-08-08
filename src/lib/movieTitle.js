function getSeasonNumber(movie) {
  if (movie?.tmdb?.type !== 'tv') return null;

  const season = Number(movie.tmdb.season);
  return Number.isInteger(season) && season > 0 ? season : null;
}

export function getSeasonLabel(movie) {
  const season = getSeasonNumber(movie);
  return season ? `Phần ${season}` : '';
}

export function getDisplayMovieTitle(movie) {
  const title = String(movie?.name || '').trim();
  const seasonLabel = getSeasonLabel(movie);

  if (!title || !seasonLabel || /\b(?:phần|season)\s*\d+\b/i.test(title)) {
    return title;
  }

  return `${title} (${seasonLabel})`;
}
