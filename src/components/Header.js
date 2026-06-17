/**
 * Header component — fixed navigation bar
 */
import { navigate, getCurrentRoute } from '../router.js';

const NAV_LINKS = [
  { label: 'Trang Chủ', hash: '#/' },
  { label: 'Phim Lẻ', hash: '#/danh-sach/phim-le' },
  { label: 'Phim Bộ', hash: '#/danh-sach/phim-bo' },
  { label: 'Hoạt Hình', hash: '#/danh-sach/hoat-hinh' },
  { label: 'TV Shows', hash: '#/danh-sach/tv-shows' },
];

/**
 * Render the site header into the given container.
 * @param {HTMLElement} container
 * @returns {Function} cleanup — removes the scroll listener
 */
export function renderHeader(container) {
  const header = document.createElement('header');
  header.className = 'header';

  // ── Logo ──
  const logo = document.createElement('a');
  logo.className = 'header__logo';
  logo.href = '#/';
  logo.innerHTML = '<img src="/logo-dark.png" alt="Film Bluesia" style="height: 36px; display: block;" />';
  logo.addEventListener('click', (e) => {
    e.preventDefault();
    navigate('#/');
  });
  header.appendChild(logo);

  // ── Desktop nav ──
  const nav = document.createElement('nav');
  nav.className = 'header__nav';

  const currentHash = window.location.hash || '#/';

  NAV_LINKS.forEach(({ label, hash }) => {
    const link = document.createElement('a');
    link.className = 'header__nav-link';
    link.href = hash;
    link.textContent = label;

    if (currentHash === hash) {
      link.classList.add('header__nav-link--active');
    }

    link.addEventListener('click', (e) => {
      e.preventDefault();
      navigate(hash);
    });

    nav.appendChild(link);
  });

  header.appendChild(nav);

  // ── Right-side actions ──
  const actions = document.createElement('div');
  actions.className = 'header__actions';

  // Search button
  const searchBtn = document.createElement('button');
  searchBtn.className = 'header__search-btn';
  searchBtn.setAttribute('aria-label', 'Tìm kiếm');
  searchBtn.textContent = '🔍';
  searchBtn.addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('open-search'));
  });
  actions.appendChild(searchBtn);

  // Hamburger (mobile)
  const hamburger = document.createElement('button');
  hamburger.className = 'header__hamburger';
  hamburger.setAttribute('aria-label', 'Menu');
  hamburger.textContent = '☰';
  actions.appendChild(hamburger);

  header.appendChild(actions);

  // ── Mobile menu ──
  const mobileMenu = document.createElement('div');
  mobileMenu.className = 'header__mobile-menu';

  NAV_LINKS.forEach(({ label, hash }) => {
    const link = document.createElement('a');
    link.className = 'header__mobile-link';
    link.href = hash;
    link.textContent = label;

    if (currentHash === hash) {
      link.classList.add('header__mobile-link--active');
    }

    link.addEventListener('click', (e) => {
      e.preventDefault();
      mobileMenu.classList.remove('header__mobile-menu--open');
      navigate(hash);
    });

    mobileMenu.appendChild(link);
  });

  header.appendChild(mobileMenu);

  // Hamburger toggle
  hamburger.addEventListener('click', () => {
    mobileMenu.classList.toggle('header__mobile-menu--open');
  });

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

  // ── Update active link on hash change ──
  function onHashChange() {
    const hash = window.location.hash || '#/';

    nav.querySelectorAll('.header__nav-link').forEach((a) => {
      a.classList.toggle('header__nav-link--active', a.getAttribute('href') === hash);
    });

    mobileMenu.querySelectorAll('.header__mobile-link').forEach((a) => {
      a.classList.toggle('header__mobile-link--active', a.getAttribute('href') === hash);
    });

    // Close mobile menu on navigation
    mobileMenu.classList.remove('header__mobile-menu--open');
  }

  window.addEventListener('hashchange', onHashChange);

  container.appendChild(header);

  // Cleanup
  return function cleanup() {
    window.removeEventListener('scroll', onScroll);
    window.removeEventListener('hashchange', onHashChange);
  };
}
