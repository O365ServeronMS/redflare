/**
 * Grid - paginated grid of movie cards.
 * Used for danh-sach, the-loai, and quoc-gia listing pages.
 */

import { renderPosterCard } from '../PosterCard/PosterCard.js';
import { navigate } from '../../router.js';

function createSkeletonGrid(count = 10) {
  const grid = document.createElement('div');
  grid.className = 'category-grid__grid';

  for (let i = 0; i < count; i++) {
    const card = document.createElement('div');
    card.className = 'movie-card movie-card--skeleton';

    const poster = document.createElement('div');
    poster.className = 'movie-card__poster skeleton-shimmer';
    card.appendChild(poster);

    const titleBar = document.createElement('div');
    titleBar.className = 'movie-card__title skeleton-shimmer';
    card.appendChild(titleBar);

    grid.appendChild(card);
  }

  return grid;
}

export async function renderGrid(container, { type, fetchFn, title, currentPage = 1 }) {
  const wrapper = document.createElement('section');
  wrapper.className = 'category-grid';

  const header = document.createElement('div');
  header.className = 'category-grid__header';

  const heading = document.createElement('h1');
  heading.className = 'category-grid__title';
  heading.textContent = title;
  header.appendChild(heading);

  wrapper.appendChild(header);

  const grid = document.createElement('div');
  grid.className = 'category-grid__grid';

  const paginationContainer = document.createElement('div');
  paginationContainer.className = 'category-grid__pagination pagination';
  paginationContainer.style.display = 'none';

  const errorEl = document.createElement('div');
  errorEl.className = 'category-grid__error';
  errorEl.style.display = 'none';

  const skeleton = createSkeletonGrid(10);
  wrapper.appendChild(skeleton);

  wrapper.appendChild(grid);
  wrapper.appendChild(paginationContainer);
  wrapper.appendChild(errorEl);
  container.appendChild(wrapper);

  function renderPagination(current, total) {
    paginationContainer.innerHTML = '';
    if (total <= 1) return;

    paginationContainer.style.display = 'flex';

    const createBtn = (text, targetPage, isActive = false) => {
      const btn = document.createElement('button');
      btn.className = `pagination__btn ${isActive ? 'pagination__btn--active' : ''}`;
      btn.textContent = text;
      if (isActive) btn.disabled = true;
      btn.addEventListener('click', () => {
        const path = window.location.pathname;
        navigate(`${path}?page=${targetPage}`);
      });
      return btn;
    };

    if (current > 1) {
      paginationContainer.appendChild(createBtn('‹', current - 1));
    }

    const maxPagesToShow = 5;
    let startPage = Math.max(1, current - 2);
    let endPage = Math.min(total, current + 2);

    if (current <= 2) {
      endPage = Math.min(total, maxPagesToShow);
    }
    if (current >= total - 1) {
      startPage = Math.max(1, total - maxPagesToShow + 1);
    }

    if (startPage > 1) {
      paginationContainer.appendChild(createBtn('1', 1));
      if (startPage > 2) {
        const dots = document.createElement('span');
        dots.className = 'pagination__dots';
        dots.textContent = '...';
        paginationContainer.appendChild(dots);
      }
    }

    for (let i = startPage; i <= endPage; i++) {
      paginationContainer.appendChild(createBtn(i.toString(), i, i === current));
    }

    if (endPage < total) {
      if (endPage < total - 1) {
        const dots = document.createElement('span');
        dots.className = 'pagination__dots';
        dots.textContent = '...';
        paginationContainer.appendChild(dots);
      }
      paginationContainer.appendChild(createBtn(total.toString(), total));
    }

    if (current < total) {
      paginationContainer.appendChild(createBtn('›', current + 1));
    }
  }

  try {
    const { items, pagination } = await fetchFn(currentPage);

    if (skeleton.parentNode) skeleton.remove();

    let totalPages = 1;
    if (pagination.totalItems && pagination.totalItemsPerPage) {
      totalPages = Math.ceil(pagination.totalItems / pagination.totalItemsPerPage);
    } else {
      totalPages = pagination.totalPages || pagination.totalPage || 1;
    }

    if (!items || items.length === 0) {
      errorEl.textContent = 'Không có phim nào trong trang này.';
      errorEl.style.display = '';
    } else {
      items.forEach((movie, index) => {
        renderPosterCard(grid, movie);
        const card = grid.lastElementChild;
        if (card) {
          card.classList.add('fade-up');
          card.style.animationDelay = `${Math.min(index * 0.03, 0.3)}s`;
        }
      });
      renderPagination(currentPage, totalPages);
    }
  } catch (err) {
    if (skeleton.parentNode) skeleton.remove();
    errorEl.textContent = 'Đã xảy ra lỗi khi tải dữ liệu. Vui lòng thử lại.';
    errorEl.style.display = '';
  }
}
