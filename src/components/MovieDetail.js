/**
 * MovieDetail — full movie detail page
 * Fetches and renders all movie metadata, episodes, and player integration.
 */

import { getMovieDetail, posterUrl, thumbUrl } from '../api/ophim.js';
import { navigate } from '../router.js';
import { renderPlayer } from './Player.js';

// ---------------------------------------------------------------------------
// Skeleton placeholder while loading
// ---------------------------------------------------------------------------

function createDetailSkeleton() {
  const skeleton = document.createElement('div');
  skeleton.className = 'detail detail--skeleton';

  const backdrop = document.createElement('div');
  backdrop.className = 'detail__backdrop-container skeleton-shimmer';
  skeleton.appendChild(backdrop);

  const body = document.createElement('div');
  body.className = 'detail__body';

  const poster = document.createElement('div');
  poster.className = 'detail__poster skeleton-shimmer';
  body.appendChild(poster);

  const info = document.createElement('div');
  info.className = 'detail__info';

  for (let i = 0; i < 5; i++) {
    const line = document.createElement('div');
    line.className = 'detail__text-line skeleton-shimmer';
    info.appendChild(line);
  }

  body.appendChild(info);
  skeleton.appendChild(body);
  return skeleton;
}

// ---------------------------------------------------------------------------
// Helper — create a pill/tag element
// ---------------------------------------------------------------------------

function createPill(text, href) {
  const pill = document.createElement('a');
  pill.className = 'detail__pill';
  pill.textContent = text;
  if (href) {
    pill.href = href;
    pill.addEventListener('click', (e) => {
      e.preventDefault();
      navigate(href);
    });
  }
  return pill;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export async function renderMovieDetail(container, slug) {
  // Show skeleton immediately
  const skeleton = createDetailSkeleton();
  container.appendChild(skeleton);

  let movie;
  try {
    movie = await getMovieDetail(slug);
  } catch (err) {
    skeleton.remove();
    const errorEl = document.createElement('div');
    errorEl.className = 'detail__error';
    errorEl.textContent = 'Không thể tải thông tin phim. Vui lòng thử lại sau.';
    container.appendChild(errorEl);
    return;
  }

  // Remove skeleton
  skeleton.remove();

  const detail = document.createElement('article');
  detail.className = 'detail';

  // ==== Backdrop ====
  const backdropContainer = document.createElement('div');
  backdropContainer.className = 'detail__backdrop-container';

  const backdropImg = document.createElement('img');
  backdropImg.className = 'detail__backdrop';
  backdropImg.loading = 'lazy';
  backdropImg.alt = movie.name || '';
  backdropImg.src = posterUrl(movie.poster_url);
  backdropContainer.appendChild(backdropImg);

  // Gradient overlay
  const gradient = document.createElement('div');
  gradient.className = 'detail__backdrop-gradient';
  backdropContainer.appendChild(gradient);

  detail.appendChild(backdropContainer);

  // ==== Body (poster + info) ====
  const body = document.createElement('div');
  body.className = 'detail__body';

  // ---- Poster ----
  const posterWrap = document.createElement('div');
  posterWrap.className = 'detail__poster';

  const posterImg = document.createElement('img');
  posterImg.className = 'detail__poster-img';
  posterImg.loading = 'lazy';
  posterImg.alt = movie.name || '';
  posterImg.src = thumbUrl(movie.thumb_url);
  posterWrap.appendChild(posterImg);
  body.appendChild(posterWrap);

  // ---- Info column ----
  const info = document.createElement('div');
  info.className = 'detail__info';

  // Title
  const title = document.createElement('h1');
  title.className = 'detail__title';
  title.textContent = movie.name || '';
  info.appendChild(title);

  // Origin name + year
  if (movie.origin_name || movie.year) {
    const sub = document.createElement('p');
    sub.className = 'detail__origin';
    const parts = [];
    if (movie.origin_name) parts.push(movie.origin_name);
    if (movie.year) parts.push(`(${movie.year})`);
    sub.textContent = parts.join(' ');
    info.appendChild(sub);
  }

  // ---- Tags: genres + countries ----
  const tags = document.createElement('div');
  tags.className = 'detail__tags';

  if (Array.isArray(movie.category)) {
    movie.category.forEach((cat) => {
      tags.appendChild(createPill(cat.name, `#/the-loai/${cat.slug}`));
    });
  }

  if (Array.isArray(movie.country)) {
    movie.country.forEach((c) => {
      tags.appendChild(createPill(c.name, `#/quoc-gia/${c.slug}`));
    });
  }

  info.appendChild(tags);

  // ---- Meta row ----
  const meta = document.createElement('div');
  meta.className = 'detail__meta';

  const metaItems = [
    movie.time,
    movie.quality,
    movie.lang,
    movie.episode_current,
    movie.year ? String(movie.year) : null,
  ].filter(Boolean);

  metaItems.forEach((text, idx) => {
    const span = document.createElement('span');
    span.className = 'detail__meta-item';
    span.textContent = text;
    meta.appendChild(span);

    if (idx < metaItems.length - 1) {
      const sep = document.createElement('span');
      sep.className = 'detail__meta-sep';
      sep.textContent = '•';
      meta.appendChild(sep);
    }
  });

  info.appendChild(meta);

  // ---- Action buttons ----
  const actions = document.createElement('div');
  actions.className = 'detail__actions';

  // Player / episode section ref (created later)
  const episodeSection = document.createElement('section');
  episodeSection.className = 'detail__episodes';
  episodeSection.id = 'episodes';

  const playBtn = document.createElement('button');
  playBtn.className = 'detail__btn detail__btn--primary';
  playBtn.innerHTML = `<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M6 4l15 8-15 8z"></path></svg><span>Xem Phim</span>`;
  playBtn.addEventListener('click', () => {
    episodeSection.scrollIntoView({ behavior: 'smooth' });
  });
  actions.appendChild(playBtn);

  if (movie.trailer_url) {
    const trailerBtn = document.createElement('button');
    trailerBtn.className = 'detail__btn detail__btn--secondary';
    trailerBtn.innerHTML = `<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M4 4h16v16H4z" fill="none"/><path d="M10 8v8l6-4z"/></svg><span>Trailer</span>`;
    trailerBtn.addEventListener('click', () => {
      window.open(movie.trailer_url, '_blank', 'noopener');
    });
    actions.appendChild(trailerBtn);
  }

  info.appendChild(actions);

  // ---- Description ----
  if (movie.content) {
    const descWrap = document.createElement('div');
    descWrap.className = 'detail__description';

    const descLabel = document.createElement('h3');
    descLabel.className = 'detail__section-label';
    descLabel.textContent = 'Nội dung phim';
    descWrap.appendChild(descLabel);

    const descBody = document.createElement('div');
    descBody.className = 'detail__description-body';
    // movie.content is HTML from the API — render it in a contained element
    descBody.innerHTML = movie.content;
    descWrap.appendChild(descBody);

    info.appendChild(descWrap);
  }

  // ---- Cast ----
  if (Array.isArray(movie.actor) && movie.actor.length > 0) {
    const castRow = document.createElement('div');
    castRow.className = 'detail__crew';

    const castLabel = document.createElement('span');
    castLabel.className = 'detail__crew-label';
    castLabel.textContent = 'Diễn viên: ';
    castRow.appendChild(castLabel);

    const castValue = document.createElement('span');
    castValue.className = 'detail__crew-value';
    castValue.textContent = movie.actor.join(', ');
    castRow.appendChild(castValue);

    info.appendChild(castRow);
  }

  // ---- Director ----
  if (Array.isArray(movie.director) && movie.director.length > 0) {
    const dirRow = document.createElement('div');
    dirRow.className = 'detail__crew';

    const dirLabel = document.createElement('span');
    dirLabel.className = 'detail__crew-label';
    dirLabel.textContent = 'Đạo diễn: ';
    dirRow.appendChild(dirLabel);

    const dirValue = document.createElement('span');
    dirValue.className = 'detail__crew-value';
    dirValue.textContent = movie.director.join(', ');
    dirRow.appendChild(dirValue);

    info.appendChild(dirRow);
  }

  body.appendChild(info);
  detail.appendChild(body);

  // ==== Episode Section ====
  const hasEpisodes =
    Array.isArray(movie.episodes) &&
    movie.episodes.some(
      (srv) => Array.isArray(srv.server_data) && srv.server_data.length > 0
    );

  if (hasEpisodes) {
    const epHeading = document.createElement('h2');
    epHeading.className = 'detail__section-title';
    epHeading.textContent = 'Danh sách tập';
    episodeSection.appendChild(epHeading);

    // Player mount point (filled when user clicks an episode)
    const playerMount = document.createElement('div');
    playerMount.className = 'detail__player-mount';
    episodeSection.appendChild(playerMount);

    // Server tabs
    const tabBar = document.createElement('div');
    tabBar.className = 'detail__server-tabs';

    // Episode grids per server
    const gridsContainer = document.createElement('div');
    gridsContainer.className = 'detail__episode-grids';

    movie.episodes.forEach((server, sIdx) => {
      if (!Array.isArray(server.server_data) || server.server_data.length === 0) return;

      // Tab button
      const tab = document.createElement('button');
      tab.className = 'detail__server-tab';
      tab.textContent = server.server_name || `Server ${sIdx + 1}`;
      tab.dataset.serverIndex = sIdx;
      if (sIdx === 0) tab.classList.add('detail__server-tab--active');
      tabBar.appendChild(tab);

      // Episode grid for this server
      const grid = document.createElement('div');
      grid.className = 'detail__episode-grid';
      grid.dataset.serverIndex = sIdx;
      if (sIdx !== 0) grid.style.display = 'none';

      server.server_data.forEach((ep) => {
        const epBtn = document.createElement('button');
        epBtn.className = 'detail__episode-btn';
        epBtn.textContent = ep.name || 'Full';
        epBtn.addEventListener('click', () => {
          // Highlight active episode
          grid
            .querySelectorAll('.detail__episode-btn--active')
            .forEach((b) => b.classList.remove('detail__episode-btn--active'));
          epBtn.classList.add('detail__episode-btn--active');

          // Mount player
          playerMount.innerHTML = '';
          renderPlayer(playerMount, {
            embedUrl: ep.link_embed || '',
            m3u8Url: ep.link_m3u8 || '',
            serverName: server.server_name || `Server ${sIdx + 1}`,
            episodeName: ep.name || 'Full',
          });

          playerMount.scrollIntoView({ behavior: 'smooth' });
        });

        grid.appendChild(epBtn);
      });

      gridsContainer.appendChild(grid);
    });

    // Tab switching
    tabBar.addEventListener('click', (e) => {
      const tab = e.target.closest('.detail__server-tab');
      if (!tab) return;
      const idx = tab.dataset.serverIndex;

      // Update active tab
      tabBar
        .querySelectorAll('.detail__server-tab')
        .forEach((t) => t.classList.remove('detail__server-tab--active'));
      tab.classList.add('detail__server-tab--active');

      // Show matching grid, hide others
      gridsContainer.querySelectorAll('.detail__episode-grid').forEach((g) => {
        g.style.display = g.dataset.serverIndex === idx ? '' : 'none';
      });
    });

    episodeSection.appendChild(tabBar);
    episodeSection.appendChild(gridsContainer);
    detail.appendChild(episodeSection);
  }

  container.appendChild(detail);
}
