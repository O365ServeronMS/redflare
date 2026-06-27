/**
 * Heroslider - auto-rotating top 8 weekly-trending movies with crossfade.
 * Code name: "Heroslider". Visible label: "Phim Hot Trong Tuần".
 */
import { posterUrl, thumbUrl } from '../../api/ophim.js';
import { navigate } from '../../router.js';

const ROTATE_INTERVAL = 8000;
const MAX_SLIDES = 8;
const SLIDER_TITLE = 'Phim Hot Trong Tuần';

// Desktop (>768px) gets the landscape /d poster_url; mobile gets the portrait
// /m thumb_url. The variant is baked into the signed URL, so we pick the field
// by viewport rather than rewriting the path.
const DESKTOP_MQ = window.matchMedia('(min-width: 769px)');

function getBackdropUrl(movie) {
  return DESKTOP_MQ.matches
    ? posterUrl(movie.poster_url || movie.thumb_url)
    : thumbUrl(movie.thumb_url || movie.poster_url);
}

function getPosterUrl(movie) {
  return posterUrl(movie.poster_url || movie.thumb_url);
}

function getScore(movie) {
  const rawScore =
    movie.imdb?.vote_average ??
    movie.imdb?.rating ??
    movie.imdb?.score ??
    movie.imdb;

  const score = Number(rawScore);
  if (!Number.isFinite(score) || score <= 0) return '';
  return score.toFixed(1);
}

function chevronIcon(direction) {
  const path = direction === 'left' ? 'M15 18l-6-6 6-6' : 'M9 6l6 6-6 6';

  return `
    <svg viewBox="0 0 24 24" width="28" height="28" fill="none" aria-hidden="true">
      <path d="${path}" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"></path>
    </svg>
  `;
}

/**
 * Render the hero banner into the given container.
 * @param {HTMLElement} container
 * @param {Array} movies - Array of movie items from API.
 * @returns {Function} cleanup - clears the auto-rotation interval.
 */
export function renderHeroSlider(container, movies) {
  const slides = movies.slice(0, MAX_SLIDES);
  if (slides.length === 0) return () => {};

  let currentIndex = 0;
  let intervalId = null;

  const hero = document.createElement('section');
  hero.className = 'hero';
  hero.setAttribute('aria-label', SLIDER_TITLE);

  const contentElements = [];
  const railButtons = [];

  slides.forEach((movie, index) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'hero__backdrop';
    if (index === 0) backdrop.classList.add('hero__backdrop--active');
    backdrop.style.backgroundImage = `url(${getBackdropUrl(movie)})`;
    hero.appendChild(backdrop);

    const overlay = document.createElement('div');
    overlay.className = 'hero__overlay';
    if (index === 0) overlay.classList.add('hero__overlay--active');
    hero.appendChild(overlay);

    const content = document.createElement('div');
    content.className = 'hero__content';
    if (index === 0) content.classList.add('hero__content--active');

    const title = document.createElement('h1');
    title.className = 'hero__title';
    title.textContent = movie.name;
    content.appendChild(title);

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

    const score = getScore(movie);
    if (score) {
      const rating = document.createElement('span');
      rating.className = 'hero__rating';
      rating.innerHTML = `<span>IMDb</span> ${score}`;
      meta.appendChild(rating);
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

    const desc = document.createElement('p');
    desc.className = 'hero__description';
    const descText = [movie.name, movie.origin_name].filter(Boolean).join(' - ');
    desc.textContent = descText.length > 150 ? `${descText.slice(0, 147)}...` : descText;
    content.appendChild(desc);

    const btnGroup = document.createElement('div');
    btnGroup.className = 'hero__buttons';

    const watchBtn = document.createElement('button');
    watchBtn.className = 'hero__btn hero__btn--primary';
    watchBtn.innerHTML = `
      <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true">
        <path d="M6 4l15 8-15 8z"></path>
      </svg>
      <span>Xem Phim</span>
    `;
    watchBtn.addEventListener('click', () => navigate(`/phim/${movie.slug}`));
    btnGroup.appendChild(watchBtn);

    const detailBtn = document.createElement('button');
    detailBtn.className = 'hero__btn hero__btn--secondary';
    detailBtn.innerHTML = `
      <svg viewBox="0 0 24 24" width="24" height="24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"></circle>
        <path d="M12 16v-4" stroke="currentColor" stroke-width="2" stroke-linecap="round"></path>
        <path d="M12 8h.01" stroke="currentColor" stroke-width="3" stroke-linecap="round"></path>
      </svg>
      <span>Chi tiết</span>
    `;
    detailBtn.addEventListener('click', () => navigate(`/phim/${movie.slug}`));
    btnGroup.appendChild(detailBtn);

    content.appendChild(btnGroup);
    hero.appendChild(content);
    contentElements.push({ backdrop, overlay, content });
  });

  const rail = document.createElement('div');
  rail.className = 'hero__rail';

  const railHeader = document.createElement('div');
  railHeader.className = 'hero__rail-header';
  railHeader.innerHTML = `
    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
      <path d="M12 2c.6 3-1.4 4.6-3 6.1S6 11.6 6 14a6 6 0 0012 0c0-2-1-4-2.6-5.6C13.9 7 13.5 4.6 12 2zm0 17a3 3 0 01-3-3c0-1.3.7-2.4 1.7-3 .1 1 .8 1.7 1.6 2 1-.4 1.5-1.3 1.6-2.5.8.9 1.1 1.9 1.1 3.5a3 3 0 01-3 3z"></path>
    </svg>
    <span>${SLIDER_TITLE}</span>
  `;
  rail.appendChild(railHeader);

  slides.forEach((movie, index) => {
    const item = document.createElement('button');
    item.className = 'hero__rail-item';
    if (index === 0) item.classList.add('hero__rail-item--active');
    item.setAttribute('aria-label', `Chọn phim thứ ${index + 1}: ${movie.name}`);
    const score = getScore(movie);
    item.innerHTML = `
      <span class="hero__rail-rank">${index + 1}</span>
      <span class="hero__rail-poster">
        <img src="${getPosterUrl(movie)}" alt="${movie.name}">
      </span>
      <span class="hero__rail-copy">
        <span class="hero__rail-title">${movie.name}</span>
        ${score ? `<span class="hero__rail-score"><span>IMDb</span> ${score}</span>` : ''}
      </span>
    `;
    item.addEventListener('click', () => {
      goToSlide(index);
      resetAutoRotate();
    });
    rail.appendChild(item);
    railButtons.push(item);
  });

  hero.appendChild(rail);

  const prevBtn = document.createElement('button');
  prevBtn.className = 'hero__arrow hero__arrow--prev';
  prevBtn.innerHTML = chevronIcon('left');
  prevBtn.setAttribute('aria-label', 'Phim trước');
  prevBtn.addEventListener('click', () => {
    goToSlide((currentIndex - 1 + slides.length) % slides.length);
    resetAutoRotate();
  });

  const nextBtn = document.createElement('button');
  nextBtn.className = 'hero__arrow hero__arrow--next';
  nextBtn.innerHTML = chevronIcon('right');
  nextBtn.setAttribute('aria-label', 'Phim tiếp theo');
  nextBtn.addEventListener('click', () => {
    nextSlide();
    resetAutoRotate();
  });

  hero.appendChild(prevBtn);
  hero.appendChild(nextBtn);

  function goToSlide(index) {
    if (index === currentIndex) return;

    const cur = contentElements[currentIndex];
    cur.backdrop.classList.remove('hero__backdrop--active');
    cur.overlay.classList.remove('hero__overlay--active');
    cur.content.classList.remove('hero__content--active');
    railButtons[currentIndex].classList.remove('hero__rail-item--active');

    currentIndex = index;

    const next = contentElements[currentIndex];
    next.backdrop.classList.add('hero__backdrop--active');
    next.overlay.classList.add('hero__overlay--active');
    next.content.classList.add('hero__content--active');
    railButtons[currentIndex].classList.add('hero__rail-item--active');
    // Scroll only within the rail, never the page
    const btn = railButtons[currentIndex];
    const railEl = btn.closest('.hero__rail') || btn.parentElement;
    if (railEl) {
      const btnTop = btn.offsetTop - railEl.offsetTop;
      const btnBot = btnTop + btn.offsetHeight;
      if (btnTop < railEl.scrollTop) railEl.scrollTop = btnTop;
      else if (btnBot > railEl.scrollTop + railEl.clientHeight) railEl.scrollTop = btnBot - railEl.clientHeight;
    }
  }

  function nextSlide() {
    goToSlide((currentIndex + 1) % slides.length);
  }

  function resetAutoRotate() {
    clearInterval(intervalId);
    intervalId = setInterval(nextSlide, ROTATE_INTERVAL);
  }

  // Swap each backdrop to the correct variant when crossing the breakpoint.
  function applyBackdrops() {
    contentElements.forEach((el, i) => {
      el.backdrop.style.backgroundImage = `url(${getBackdropUrl(slides[i])})`;
    });
  }
  DESKTOP_MQ.addEventListener('change', applyBackdrops);

  intervalId = setInterval(nextSlide, ROTATE_INTERVAL);
  container.appendChild(hero);

  return function cleanup() {
    clearInterval(intervalId);
    DESKTOP_MQ.removeEventListener('change', applyBackdrops);
  };
}
