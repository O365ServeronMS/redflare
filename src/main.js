/**
 * Film Bluesia — Main Entry Point
 * Orchestrates routing, page rendering, and global event handling.
 */

import './styles/global.css';
import './styles/components.css';

import { initRouter, navigate } from './router.js';
import {
  getHomeData,
  getNewMovies,
  getMoviesByType,
  getMoviesByGenre,
  getMoviesByCountry,
  searchMovies,
  normalizeListItem
} from './api/ophim.js';

import { renderHeader } from './modules/Header/Header.js';
import { renderHeroSlider } from './modules/HeroSlider/HeroSlider.js';
import { renderCarousel } from './modules/Carousel/Carousel.js';
import { renderFooter } from './modules/Footer/Footer.js';
import { renderMovieDetail } from './components/MovieDetail.js';
import { renderGrid } from './modules/Grid/Grid.js';
import { renderSearchOverlay } from './modules/SearchOverlay/SearchOverlay.js';
import { createSkeletonCards, createSkeletonHero } from './modules/Skeleton/Skeleton.js';

function showRuntimeError(message) {
  const errorEl = document.createElement('div');
  errorEl.style.cssText = [
    'position:fixed',
    'left:0',
    'right:0',
    'top:64px',
    'z-index:9999',
    'padding:16px 20px',
    'background:#220',
    'color:#ff5a5a',
    'font:14px/1.4 monospace',
    'white-space:pre-wrap',
  ].join(';');
  errorEl.textContent = message;
  document.body.appendChild(errorEl);
}

function getRuntimeErrorMessage(event) {
  return `${event.message} - ${event.filename}:${event.lineno}`;
}

function getPromiseErrorMessage(event) {
  return `Promise: ${event.reason?.stack || event.reason}`;
}

window.addEventListener('error', (event) => {
  const message = getRuntimeErrorMessage(event);
  if (import.meta.env.DEV) {
    showRuntimeError(message);
    return;
  }
  console.error(message);
});

window.addEventListener('unhandledrejection', (event) => {
  const message = getPromiseErrorMessage(event);
  if (import.meta.env.DEV) {
    showRuntimeError(message);
    return;
  }
  console.error(message);
});

// ─── App Root ──────────────────────────────────────────
const app = document.getElementById('app');

// ─── Persistent UI (Header, Search, Footer are managed per-page) ───
let headerCleanup = null;
let searchCleanup = null;


function mountGlobalUI() {
  // Header
  if (!document.querySelector('.header')) {
    const headerEl = document.createElement('div');
    headerEl.id = 'header-root';
    app.prepend(headerEl);
    headerCleanup = renderHeader(headerEl);
  }

  // Search overlay
  if (!document.querySelector('.search-overlay')) {
    const searchEl = document.createElement('div');
    searchEl.id = 'search-root';
    app.appendChild(searchEl);
    searchCleanup = renderSearchOverlay(searchEl);
  }
}

// ─── Page Container ─────────────────────────────────────
function getPageContainer() {
  let page = document.getElementById('page-content');
  if (page) {
    page.innerHTML = '';
  } else {
    page = document.createElement('main');
    page.id = 'page-content';
    // Insert after header, before search overlay
    const searchRoot = document.getElementById('search-root');
    if (searchRoot) {
      app.insertBefore(page, searchRoot);
    } else {
      app.appendChild(page);
    }
  }
  return page;
}

// ─── Home Page ──────────────────────────────────────────
async function renderHomePage() {
  const page = getPageContainer();

  // Show loading skeleton
  const skeleton = document.createElement('div');
  skeleton.appendChild(createSkeletonHero());
  const skeletonRow = document.createElement('div');
  skeletonRow.className = 'carousel';
  skeletonRow.style.padding = '0 4%';
  skeletonRow.appendChild(createSkeletonCards(6));
  skeleton.appendChild(skeletonRow);
  page.appendChild(skeleton);

  try {
    // Fetch home-data from catalog-api (VPS) — built, ranked, and image-signed there
    const data = await getHomeData();

    const newMovies = { items: (data.newMovies?.items || []) };
    // We normalize the items so they match what the UI expects
    const phimLe = { items: (data.phimLe?.items || []).map(normalizeListItem) };
    const phimBo = { items: (data.phimBo?.items || []).map(normalizeListItem) };
    const hoatHinh = { items: (data.hoatHinh?.items || []).map(normalizeListItem) };
    const trending = { items: (data.trending?.items || []).map(normalizeListItem) };
    const heroMovies = { items: (data.heroMovies || []).map(normalizeListItem) };

    // Clear skeleton
    page.innerHTML = '';


    const heroCleanup = renderHeroSlider(page, heroMovies.items);

    // Carousels
    renderCarousel(page, {
      title: 'Phim Mới Cập Nhật',
      items: newMovies.items,
      seeAllLink: '/danh-sach/phim-moi-cap-nhat',
      showRank: true,
    });

    if (trending.items.length) {
      renderCarousel(page, {
        title: 'Phim Trending',
        items: trending.items,
        seeAllLink: '/danh-sach/phim-moi-cap-nhat',
      });
    }

    renderCarousel(page, {
      title: 'Phim Lẻ',
      items: phimLe.items,
      seeAllLink: '/danh-sach/phim-le',
    });

    renderCarousel(page, {
      title: 'Phim Bộ',
      items: phimBo.items,
      seeAllLink: '/danh-sach/phim-bo',
    });

    renderCarousel(page, {
      title: 'Hoạt Hình',
      items: hoatHinh.items,
      seeAllLink: '/danh-sach/hoat-hinh',
    });

    // Footer
    renderFooter(page);

    return () => {
      if (heroCleanup) heroCleanup();
    };
  } catch (err) {
    page.innerHTML = '';
    const errEl = document.createElement('div');
    errEl.className = 'container';
    errEl.style.paddingTop = '120px';
    errEl.style.textAlign = 'center';
    errEl.innerHTML = `
      <h2 style="margin-bottom:16px">Không thể tải dữ liệu</h2>
      <p style="color:#888;margin-bottom:24px">${err.message}</p>
      <button class="hero__btn hero__btn--primary" onclick="location.reload()">Thử lại</button>
    `;
    page.appendChild(errEl);
  }
}

// ─── Movie Detail Page ──────────────────────────────────
function renderDetailPage({ params }) {
  const page = getPageContainer();
  const detailWrap = document.createElement('div');
  page.appendChild(detailWrap);
  renderMovieDetail(detailWrap, params.slug);
  renderFooter(page);
}

// ─── Category / List Page ───────────────────────────────
async function renderListPage({ params, query }) {
  const page = getPageContainer();
  const type = params.type;
  const currentPage = query.page ? parseInt(query.page, 10) : 1;

  const typeNames = {
    'phim-le': 'Phim Lẻ',
    'phim-bo': 'Phim Bộ',
    'hoat-hinh': 'Hoạt Hình',
    'tv-shows': 'TV Shows',
    'phim-moi-cap-nhat': 'Phim Mới Cập Nhật',
  };

  if (type === 'phim-moi-cap-nhat') {
    await renderGrid(page, {
      type: 'danh-sach',
      fetchFn: (p) => getNewMovies(p),
      title: typeNames[type] || type,
      currentPage,
    });
  } else {
    await renderGrid(page, {
      type: 'danh-sach',
      fetchFn: (p) => getMoviesByType(type, p),
      title: typeNames[type] || type,
      currentPage,
    });
  }

  renderFooter(page);
}

// ─── Genre Page ─────────────────────────────────────────
async function renderGenrePage({ params, query }) {
  const page = getPageContainer();
  const currentPage = query.page ? parseInt(query.page, 10) : 1;
  await renderGrid(page, {
    type: 'the-loai',
    fetchFn: (p) => getMoviesByGenre(params.slug, p),
    title: params.slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    currentPage,
  });
  renderFooter(page);
}

// ─── Country Page ───────────────────────────────────────
async function renderCountryPage({ params, query }) {
  const page = getPageContainer();
  const currentPage = query.page ? parseInt(query.page, 10) : 1;
  await renderGrid(page, {
    type: 'quoc-gia',
    fetchFn: (p) => getMoviesByCountry(params.slug, p),
    title: params.slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    currentPage,
  });
  renderFooter(page);
}

// ─── Search Page (fallback for direct URL) ──────────────
function renderSearchPage({ query }) {
  // Trigger the search overlay open
  document.dispatchEvent(new CustomEvent('open-search', { detail: query.q || '' }));
}

// ─── Initialize ─────────────────────────────────────────
mountGlobalUI();

initRouter([
  { path: '/', handler: renderHomePage },
  { path: '/phim/:slug', handler: renderDetailPage },
  { path: '/danh-sach/:type', handler: renderListPage },
  { path: '/the-loai/:slug', handler: renderGenrePage },
  { path: '/quoc-gia/:slug', handler: renderCountryPage },
  { path: '/tim-kiem', handler: renderSearchPage },
]);
