/**
 * Header component — fixed navigation bar
 */
import { navigate, getCurrentRoute } from '../router.js';

const NAV_LINKS = [
  { label: 'Trang Chủ', path: '/' },
  { label: 'Phim Lẻ', path: '/danh-sach/phim-le' },
  { label: 'Phim Bộ', path: '/danh-sach/phim-bo' },
  { label: 'Hoạt Hình', path: '/danh-sach/hoat-hinh' },
  { label: 'TV Shows', path: '/danh-sach/tv-shows' },
];

/**
 * Render the site header into the given container.
 * @param {HTMLElement} container
 * @returns {Function} cleanup — removes the scroll listener
 */
export function renderHeader(container) {
  const header = document.createElement('header');
  header.className = 'header';

  // ── Back Button ──
  const backBtn = document.createElement('button');
  backBtn.className = 'header__back-btn';
  backBtn.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="15 18 9 12 15 6"></polyline>
    </svg>
    <span class="header__back-text">Quay lại</span>
  `;
  backBtn.setAttribute('aria-label', 'Quay lại');
  backBtn.addEventListener('click', () => {
    if (window.history.length > 2) {
      window.history.back();
    } else {
      navigate('/');
    }
  });
  header.appendChild(backBtn);

  // ── Logo ──
  const logo = document.createElement('a');
  logo.className = 'header__logo';
  logo.href = '/';
  logo.innerHTML = `
    <picture>
      <source srcset="/logo-dark.webp" type="image/webp">
      <img src="/logo-dark.png" alt="Film Bluesia" style="height: 36px; display: block;" />
    </picture>
  `;
  logo.addEventListener('click', (e) => {
    e.preventDefault();
    navigate('/');
  });
  header.appendChild(logo);

  // ── Desktop nav ──
  const nav = document.createElement('nav');
  nav.className = 'header__nav';

  const desktopLinks = [];
  const mobileLinks = [];

  const createNavLinks = (containerEl, isMobile) => {
    NAV_LINKS.forEach(({ label, path }) => {
      const link = document.createElement('a');
      link.className = isMobile ? 'header__mobile-link' : 'header__nav-link';
      link.href = path;
      link.textContent = label;
      link.dataset.path = path;

      link.addEventListener('click', (e) => {
        e.preventDefault();
        if (isMobile) {
          mobileMenu.classList.remove('header__mobile-menu--open');
          if (typeof hamburger !== 'undefined') {
            hamburger.classList.remove('header__mobile-toggle--active');
          }
        }
        navigate(path);
      });

      if (isMobile) {
        mobileLinks.push(link);
      } else {
        desktopLinks.push(link);
      }

      containerEl.appendChild(link);
    });
  };

  createNavLinks(nav, false);
  header.appendChild(nav);

  // ── Right-side actions ──
  const actions = document.createElement('div');
  actions.className = 'header__actions';

  // Search button
  const searchBtn = document.createElement('button');
  searchBtn.className = 'header__search-btn';
  searchBtn.setAttribute('aria-label', 'Tìm kiếm');
  searchBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>`;
  searchBtn.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('open-search'));
  });
  actions.appendChild(searchBtn);

  // Hamburger (mobile)
  const hamburger = document.createElement('button');
  hamburger.className = 'header__mobile-toggle';
  hamburger.setAttribute('aria-label', 'Menu');
  hamburger.innerHTML = `
    <span class="hamburger-line"></span>
    <span class="hamburger-line"></span>
    <span class="hamburger-line"></span>
  `;
  actions.appendChild(hamburger);

  header.appendChild(actions);

  // ── Mobile menu ──
  const mobileMenu = document.createElement('div');
  mobileMenu.className = 'header__mobile-menu';
  createNavLinks(mobileMenu, true);
  header.appendChild(mobileMenu);

  hamburger.addEventListener('click', () => {
    mobileMenu.classList.toggle('header__mobile-menu--open');
    hamburger.classList.toggle('header__mobile-toggle--active');
  });

  // ── Active State Management ──
  const updateActiveLinks = () => {
    const { path } = getCurrentRoute();
    
    // Manage back button visibility
    if (path === '/' || path === '') {
      backBtn.classList.remove('header__back-btn--visible');
    } else {
      backBtn.classList.add('header__back-btn--visible');
    }

    desktopLinks.forEach(link => {
      if (link.dataset.path === path) {
        link.classList.add('header__nav-link--active');
      } else {
        link.classList.remove('header__nav-link--active');
      }
    });

    mobileLinks.forEach(link => {
      if (link.dataset.path === path) {
        link.classList.add('header__mobile-link--active');
      } else {
        link.classList.remove('header__mobile-link--active');
      }
    });
  };

  // Initial update
  updateActiveLinks();

  // Listen to custom route event to update highlighting
  window.addEventListener('route-changed', updateActiveLinks);

  // ── Scroll behaviour ──
  function onScroll() {
    if (window.scrollY > 80) {
      header.classList.add('header--scrolled');
    } else {
      header.classList.remove('header--scrolled');
    }
  }

  window.addEventListener('scroll', onScroll, { passive: true });

  // Apply initial state
  onScroll();

  container.appendChild(header);

  // Cleanup
  return function cleanup() {
    window.removeEventListener('scroll', onScroll);
    window.removeEventListener('route-changed', updateActiveLinks);
  };
}
