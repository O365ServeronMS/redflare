/**
 * Carousel — horizontal scrollable row of movie cards
 */
import { renderPosterCard } from '../PosterCard/PosterCard.js';

/**
 * Render a movie carousel section.
 * @param {HTMLElement} container
 * @param {Object} options
 * @param {string} options.title - Section heading
 * @param {Array} options.items - Movie items to display
 * @param {string} [options.seeAllLink] - Hash link for the "Xem tất cả" action
 * @param {boolean} [options.showRank] - Whether to show ranking numbers on cards
 */
export function renderCarousel(container, { title, items, seeAllLink, showRank }) {
  const section = document.createElement('section');
  section.className = 'carousel';

  // ── Header row ──
  const headerRow = document.createElement('div');
  headerRow.className = 'carousel__header';

  const heading = document.createElement('h2');
  heading.className = 'carousel__title';
  heading.textContent = title;
  headerRow.appendChild(heading);

  if (seeAllLink) {
    const seeAll = document.createElement('a');
    seeAll.className = 'carousel__see-all';
    seeAll.href = seeAllLink;
    seeAll.textContent = 'Xem tất cả ›';
    headerRow.appendChild(seeAll);
  }

  section.appendChild(headerRow);

  // ── Track wrapper (with arrows) ──
  const wrapper = document.createElement('div');
  wrapper.className = 'carousel__track-wrapper';

  // Left arrow
  const leftArrow = document.createElement('button');
  leftArrow.className = 'carousel__arrow carousel__arrow--left';
  leftArrow.setAttribute('aria-label', 'Cuộn trái');
  leftArrow.textContent = '‹';
  wrapper.appendChild(leftArrow);

  // Track
  const track = document.createElement('div');
  track.className = 'carousel__track';

  items.forEach((movie, index) => {
    const rank = showRank ? index : null;
    renderPosterCard(track, movie, rank);
  });

  wrapper.appendChild(track);

  // Right arrow
  const rightArrow = document.createElement('button');
  rightArrow.className = 'carousel__arrow carousel__arrow--right';
  rightArrow.setAttribute('aria-label', 'Cuộn phải');
  rightArrow.textContent = '›';
  wrapper.appendChild(rightArrow);

  // ── Premium eased slide (one page of cards per click) ──
  let rafId = null;

  function pageDelta() {
    const firstCard = track.querySelector('.movie-card');
    if (!firstCard) return track.clientWidth * 0.8;
    const gap = parseFloat(getComputedStyle(track).gap) || 8;
    const step = firstCard.getBoundingClientRect().width + gap;
    const perPage = Math.max(1, Math.floor(track.clientWidth / step));
    return perPage * step;
  }

  function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  function slide(direction) {
    const maxScroll = track.scrollWidth - track.clientWidth;
    const start = track.scrollLeft;
    const target = Math.max(0, Math.min(maxScroll, start + pageDelta() * direction));
    const distance = target - start;
    if (Math.abs(distance) < 1) return;

    if (rafId) cancelAnimationFrame(rafId);
    // Drive the scroll ourselves so the easing is consistent across browsers.
    track.style.scrollSnapType = 'none';
    track.style.scrollBehavior = 'auto';
    const startTime = performance.now();
    const duration = 550;

    function step(now) {
      const t = Math.min(1, (now - startTime) / duration);
      track.scrollLeft = start + distance * easeInOutCubic(t);
      if (t < 1) {
        rafId = requestAnimationFrame(step);
      } else {
        rafId = null;
        track.style.scrollSnapType = '';
        track.style.scrollBehavior = '';
        updateArrowVisibility();
      }
    }
    rafId = requestAnimationFrame(step);
  }

  leftArrow.addEventListener('click', () => slide(-1));
  rightArrow.addEventListener('click', () => slide(1));

  // ── Arrow visibility based on scroll position ──
  function updateArrowVisibility() {
    const { scrollLeft, scrollWidth, clientWidth } = track;
    leftArrow.classList.toggle('carousel__arrow--hidden', scrollLeft <= 0);
    rightArrow.classList.toggle(
      'carousel__arrow--hidden',
      scrollLeft + clientWidth >= scrollWidth - 1
    );
  }

  track.addEventListener('scroll', updateArrowVisibility, { passive: true });

  // Initial check (defer so layout is ready)
  requestAnimationFrame(updateArrowVisibility);

  section.appendChild(wrapper);
  container.appendChild(section);
}
