/**
 * Hero banner — auto-rotating featured movies with crossfade
 */
import { posterUrl } from '../api/ophim.js';
import { navigate } from '../router.js';

const ROTATE_INTERVAL = 8000;
const MAX_SLIDES = 5;

/**
 * Render the hero banner into the given container.
 * @param {HTMLElement} container
 * @param {Array} movies - Array of movie items from API
 * @returns {Function} cleanup — clears the auto-rotation interval
 */
export function renderHero(container, movies) {
  const slides = movies.slice(0, MAX_SLIDES);
  if (slides.length === 0) return () => {};

  let currentIndex = 0;
  let intervalId = null;

  const hero = document.createElement('section');
  hero.className = 'hero';

  // ── Backdrop layers (one per slide, stacked) ──
  const backdropElements = [];
  const contentElements = [];

  slides.forEach((movie, i) => {
    // Backdrop
    const backdrop = document.createElement('div');
    backdrop.className = 'hero__backdrop';
    if (i === 0) backdrop.classList.add('hero__backdrop--active');
    backdrop.style.backgroundImage = `url(${posterUrl(movie.poster_url)})`;
    hero.appendChild(backdrop);
    backdropElements.push(backdrop);

    // Overlay
    const overlay = document.createElement('div');
    overlay.className = 'hero__overlay';
    if (i === 0) overlay.classList.add('hero__overlay--active');
    hero.appendChild(overlay);

    // Content
    const content = document.createElement('div');
    content.className = 'hero__content';
    if (i === 0) content.classList.add('hero__content--active');

    // Title
    const title = document.createElement('h1');
    title.className = 'hero__title';
    title.textContent = movie.name;
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

    // Description (truncated combination of name + origin_name)
    const desc = document.createElement('p');
    desc.className = 'hero__description';
    const descText = [movie.name, movie.origin_name].filter(Boolean).join(' — ');
    desc.textContent = descText.length > 150 ? descText.slice(0, 147) + '...' : descText;
    content.appendChild(desc);

    // Action buttons
    const btnGroup = document.createElement('div');
    btnGroup.className = 'hero__buttons';

    const watchBtn = document.createElement('button');
    watchBtn.className = 'hero__btn hero__btn--primary';
    watchBtn.innerHTML = `<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M6 4l15 8-15 8z"></path></svg><span>Xem Phim</span>`;
    watchBtn.addEventListener('click', () => navigate(`/phim/${movie.slug}`));
    btnGroup.appendChild(watchBtn);

    const detailBtn = document.createElement('button');
    detailBtn.className = 'hero__btn hero__btn--secondary';
    detailBtn.innerHTML = `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg><span>Chi Tiết</span>`;
    detailBtn.addEventListener('click', () => navigate(`/phim/${movie.slug}`));
    btnGroup.appendChild(detailBtn);

    content.appendChild(btnGroup);
    hero.appendChild(content);
    contentElements.push({ backdrop, overlay, content });
  });

  // ── Dot indicators ──
  const dots = document.createElement('div');
  dots.className = 'hero__dots';

  slides.forEach((_, i) => {
    const dot = document.createElement('button');
    dot.className = 'hero__dot';
    if (i === 0) dot.classList.add('hero__dot--active');
    dot.setAttribute('aria-label', `Slide ${i + 1}`);
    dot.addEventListener('click', () => {
      goToSlide(i);
      resetAutoRotate();
    });
    dots.appendChild(dot);
  });

  hero.appendChild(dots);

  // ── Navigation Arrows ──
  const prevBtn = document.createElement('button');
  prevBtn.className = 'hero__arrow hero__arrow--prev';
  prevBtn.innerHTML = '&#10094;'; // Left-pointing angle quotation mark
  prevBtn.setAttribute('aria-label', 'Phim trước');
  prevBtn.addEventListener('click', () => {
    goToSlide((currentIndex - 1 + slides.length) % slides.length);
    resetAutoRotate();
  });

  const nextBtn = document.createElement('button');
  nextBtn.className = 'hero__arrow hero__arrow--next';
  nextBtn.innerHTML = '&#10095;'; // Right-pointing angle quotation mark
  nextBtn.setAttribute('aria-label', 'Phim tiếp theo');
  nextBtn.addEventListener('click', () => {
    nextSlide();
    resetAutoRotate();
  });

  hero.appendChild(prevBtn);
  hero.appendChild(nextBtn);

  // ── Slide transition logic ──
  function goToSlide(index) {
    // Deactivate current
    const cur = contentElements[currentIndex];
    cur.backdrop.classList.remove('hero__backdrop--active');
    cur.overlay.classList.remove('hero__overlay--active');
    cur.content.classList.remove('hero__content--active');
    dots.children[currentIndex].classList.remove('hero__dot--active');

    // Activate new
    currentIndex = index;
    const next = contentElements[currentIndex];
    next.backdrop.classList.add('hero__backdrop--active');
    next.overlay.classList.add('hero__overlay--active');
    next.content.classList.add('hero__content--active');
    dots.children[currentIndex].classList.add('hero__dot--active');
  }

  function nextSlide() {
    goToSlide((currentIndex + 1) % slides.length);
  }

  function resetAutoRotate() {
    clearInterval(intervalId);
    intervalId = setInterval(nextSlide, ROTATE_INTERVAL);
  }

  // Start auto-rotation
  intervalId = setInterval(nextSlide, ROTATE_INTERVAL);

  container.appendChild(hero);

  // Cleanup
  return function cleanup() {
    clearInterval(intervalId);
  };
}
