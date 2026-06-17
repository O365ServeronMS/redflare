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

  // ==== Hero-style Banner ====
  const banner = document.createElement('section');
  banner.className = 'hero hero--detail';

  // Backdrop
  const backdrop = document.createElement('div');
  backdrop.className = 'hero__backdrop hero__backdrop--active';
  backdrop.style.backgroundImage = `url(${posterUrl(movie.poster_url)})`;
  banner.appendChild(backdrop);

  // Overlay
  const overlay = document.createElement('div');
  overlay.className = 'hero__overlay hero__overlay--active';
  banner.appendChild(overlay);

  // Content
  const content = document.createElement('div');
  content.className = 'hero__content hero__content--active';

  // Back Button
  const backBtn = document.createElement('button');
  backBtn.className = 'detail__back-btn';
  backBtn.innerHTML = '&#10094;'; // <
  backBtn.setAttribute('aria-label', 'Quay lại');
  backBtn.addEventListener('click', () => {
    if (window.history.length > 2) {
      window.history.back();
    } else {
      navigate('/');
    }
  });
  content.appendChild(backBtn);

  // Title
  const title = document.createElement('h1');
  title.className = 'hero__title';
  title.textContent = movie.name || '';
  content.appendChild(title);

  // Meta row
  const meta = document.createElement('div');
  meta.className = 'hero__meta';

  if (movie.origin_name) {
    const originName = document.createElement('span');
    originName.className = 'hero__origin-name';
    originName.textContent = movie.origin_name;
    meta.appendChild(originName);
  }

  if (movie.year) {
    const year = document.createElement('span');
    year.className = 'hero__year';
    year.textContent = movie.year;
    meta.appendChild(year);
  }

  if (movie.quality) {
    const quality = document.createElement('span');
    quality.className = 'hero__badge hero__badge--quality';
    quality.textContent = movie.quality;
    meta.appendChild(quality);
  }

  if (movie.lang) {
    const lang = document.createElement('span');
    lang.className = 'hero__badge hero__badge--lang';
    lang.textContent = movie.lang;
    meta.appendChild(lang);
  }

  content.appendChild(meta);

  // Description
  const desc = document.createElement('p');
  desc.className = 'hero__description';
  const descText = [movie.name, movie.origin_name].filter(Boolean).join(' — ');
  desc.textContent = descText;
  content.appendChild(desc);

  // Action buttons
  const btnGroup = document.createElement('div');
  btnGroup.className = 'hero__buttons';

  // We need the episodeSection reference early
  const episodeSection = document.createElement('section');
  episodeSection.className = 'detail__episodes';
  episodeSection.id = 'episodes';

  const playBtn = document.createElement('button');
  playBtn.className = 'hero__btn hero__btn--primary';
  playBtn.innerHTML = `<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M6 4l15 8-15 8z"></path></svg><span>Xem Phim</span>`;
  playBtn.addEventListener('click', () => {
    episodeSection.scrollIntoView({ behavior: 'smooth' });
  });
  btnGroup.appendChild(playBtn);

  if (movie.trailer_url) {
    const trailerBtn = document.createElement('button');
    trailerBtn.className = 'hero__btn hero__btn--secondary';
    trailerBtn.innerHTML = `<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M4 4h16v16H4z" fill="none"/><path d="M10 8v8l6-4z"/></svg><span>Trailer</span>`;
    trailerBtn.addEventListener('click', () => {
      window.open(movie.trailer_url, '_blank', 'noopener');
    });
    btnGroup.appendChild(trailerBtn);
  }

  content.appendChild(btnGroup);
  banner.appendChild(content);
  detail.appendChild(banner);

  // ==== Body (Below the fold) ====
  const body = document.createElement('div');
  body.className = 'detail__body';

  const info = document.createElement('div');
  info.className = 'detail__info';

  // ---- Tags: genres + countries ----
  const tags = document.createElement('div');
  tags.className = 'detail__tags';

  if (Array.isArray(movie.category)) {
    movie.category.forEach((cat) => {
      tags.appendChild(createPill(cat.name, `/the-loai/${cat.slug}`));
    });
  }

  if (Array.isArray(movie.country)) {
    movie.country.forEach((c) => {
      tags.appendChild(createPill(c.name, `/quoc-gia/${c.slug}`));
    });
  }

  info.appendChild(tags);

  // ---- Description ----
  if (movie.content) {
    const descWrap = document.createElement('div');
    descWrap.className = 'detail__description-wrap';

    const descLabel = document.createElement('h3');
    descLabel.className = 'detail__section-label';
    descLabel.textContent = 'Nội dung phim';
    descWrap.appendChild(descLabel);

    const descBody = document.createElement('div');
    descBody.className = 'detail__description-body';
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
