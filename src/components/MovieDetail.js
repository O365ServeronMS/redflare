/**
 * MovieDetail — full movie detail page
 * Fetches and renders all movie metadata, episodes, and player integration.
 */

import { getMovieDetail, posterUrl, thumbUrl } from '../api/ophim.js';
import { navigate } from '../router.js';
import { renderPlayer } from './Player.js';

function getEpisodeRank(ep) {
  const name = String(ep?.name || '').trim().toLowerCase();
  const slug = String(ep?.slug || '').trim().toLowerCase();
  const filename = String(ep?.filename || '').trim().toLowerCase();
  const haystack = `${name} ${slug} ${filename}`;

  if (/\bfull\b|full|tap-full|tập full/.test(haystack)) return 0;
  if (/(^|\D)1($|\D)|tap-1|tập 1|episode 1|ep 1/.test(haystack)) return 1;
  return 2;
}

function isSingleMovie(movie) {
  const type = String(movie?.type || '').toLowerCase();
  return type === 'single' || type === 'phim-le';
}

function findPreferredEpisodeButton(movie, episodeButtons) {
  if (episodeButtons.length === 0) return null;

  const targetRank = isSingleMovie(movie) ? 0 : 1;
  return (
    episodeButtons.find(({ ep }) => getEpisodeRank(ep) === targetRank)?.button ||
    episodeButtons[0].button
  );
}

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
  pill.className = 'detail__tag';
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

  // Portrait thumb (appended before content to sit under it in z-stack)
  if (movie.thumb_url) {
    const thumb = document.createElement('img');
    thumb.className = 'detail__thumb';
    thumb.src = thumbUrl(movie.thumb_url);
    thumb.alt = movie.name || '';
    thumb.loading = 'lazy';
    banner.appendChild(thumb);
    banner.classList.add('hero--has-thumb');
  }

  // Content
  const content = document.createElement('div');
  content.className = 'hero__content hero__content--active';

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
  let preferredEpisodeButton = null;

  playBtn.addEventListener('click', () => {
    if (preferredEpisodeButton) {
      preferredEpisodeButton.click();
      return;
    }

    episodeSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
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

    const descBody = document.createElement('div');
    descBody.className = 'detail__description-body';
    descBody.innerHTML = movie.content;
    descWrap.appendChild(descBody);

    const readMoreBtn = document.createElement('button');
    readMoreBtn.className = 'detail__read-more';
    readMoreBtn.textContent = 'Xem thêm ▾';
    
    // Check if content is long enough to need expansion
    // We defer this until after it's in the DOM to check height
    requestAnimationFrame(() => {
      if (descBody.scrollHeight > descBody.clientHeight) {
        descWrap.appendChild(readMoreBtn);
      }
    });

    readMoreBtn.addEventListener('click', () => {
      const isExpanded = descBody.classList.toggle('detail__description-body--expanded');
      readMoreBtn.textContent = isExpanded ? 'Rút gọn ▴' : 'Xem thêm ▾';
    });

    info.appendChild(descWrap);
  }

  // ---- Metadata Group (Cast, Director) ----
  const metadataGroup = document.createElement('div');
  metadataGroup.className = 'detail__metadata-group';

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

    metadataGroup.appendChild(castRow);
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

    metadataGroup.appendChild(dirRow);
  }

  if (metadataGroup.hasChildNodes()) {
    info.appendChild(metadataGroup);
  }
  // Info is appended later after episodes

  // ==== Episode Section ====
  const hasEpisodes =
    Array.isArray(movie.episodes) &&
    movie.episodes.some(
      (srv) => Array.isArray(srv.server_data) && srv.server_data.length > 0
    );

  if (hasEpisodes) {
    // Player mount point (filled when user clicks an episode)
    const playerMount = document.createElement('div');
    playerMount.className = 'detail__player-mount';
    episodeSection.appendChild(playerMount);

    // Episode Header (Title + Server Select inline)
    const epHeader = document.createElement('div');
    epHeader.className = 'episodes__header';

    const epHeading = document.createElement('h2');
    epHeading.className = 'detail__section-label';
    epHeading.textContent = 'Danh sách tập';
    epHeader.appendChild(epHeading);

    // Server select dropdown
    const serverSelect = document.createElement('select');
    serverSelect.className = 'episodes__server-select';

    // Episode grids per server
    const gridsContainer = document.createElement('div');
    gridsContainer.className = 'episodes';

    const episodeButtons = [];

    const selectEpisode = (epBtn, ep, server, sIdx) => {
      episodeSection
        .querySelectorAll('.episodes__ep-btn--active')
        .forEach((b) => {
          b.classList.remove('episodes__ep-btn--active');
          b.setAttribute('aria-pressed', 'false');
        });
      epBtn.classList.add('episodes__ep-btn--active');
      epBtn.setAttribute('aria-pressed', 'true');

      if (serverSelect.value !== String(sIdx)) {
        serverSelect.value = String(sIdx);
        gridsContainer.querySelectorAll('.episodes__grid').forEach((g) => {
          g.style.display = g.dataset.serverIndex === String(sIdx) ? '' : 'none';
        });
      }

      playerMount.innerHTML = '';
      renderPlayer(playerMount, {
        embedUrl: ep.link_embed || '',
        m3u8Url: ep.link_m3u8 || '',
        serverName: server.server_name || `Server ${sIdx + 1}`,
        episodeName: ep.name || 'Full',
        backdropUrl: posterUrl(movie.poster_url)
      });

      playerMount.scrollIntoView({ behavior: 'smooth', block: 'center' });
    };

    movie.episodes.forEach((server, sIdx) => {
      if (!Array.isArray(server.server_data) || server.server_data.length === 0) return;

      // Add option to dropdown
      const option = document.createElement('option');
      option.value = sIdx;
      option.textContent = server.server_name || `Server ${sIdx + 1}`;
      serverSelect.appendChild(option);

      // Episode grid for this server
      const grid = document.createElement('div');
      grid.className = 'episodes__grid';
      grid.dataset.serverIndex = sIdx;
      if (sIdx !== 0) grid.style.display = 'none';

      server.server_data.forEach((ep) => {
        const epBtn = document.createElement('button');
        epBtn.className = 'episodes__ep-btn';
        epBtn.textContent = ep.name || 'Full';
        epBtn.setAttribute('aria-pressed', 'false');
        epBtn.addEventListener('click', () => {
          selectEpisode(epBtn, ep, server, sIdx);
        });

        episodeButtons.push({ button: epBtn, ep });
        grid.appendChild(epBtn);
      });

      gridsContainer.appendChild(grid);
    });

    if (serverSelect.options.length > 0) {
      epHeader.appendChild(serverSelect);
    }
    episodeSection.appendChild(epHeader);

    // Dropdown switching
    serverSelect.addEventListener('change', (e) => {
      const idx = e.target.value;
      gridsContainer.querySelectorAll('.episodes__grid').forEach((g) => {
        g.style.display = g.dataset.serverIndex === idx ? '' : 'none';
      });
    });

    // Put episodes inside body so they share the same container boundaries
    const episodesWrap = document.createElement('div');
    episodesWrap.className = 'episodes__list';
    episodesWrap.appendChild(gridsContainer);
    
    // Put episodeSection first, then info (if episodes exist)
    episodeSection.appendChild(episodesWrap);
    body.appendChild(episodeSection);

    preferredEpisodeButton = findPreferredEpisodeButton(movie, episodeButtons);
  }

  // Append info below episodes
  body.appendChild(info);
  detail.appendChild(body);

  container.appendChild(detail);
}
