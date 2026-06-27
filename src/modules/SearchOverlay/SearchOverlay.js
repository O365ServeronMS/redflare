/**
 * SearchOverlay — full-screen search panel
 * Opens via custom 'open-search' event on document.
 * Closes via ✕ button or Escape key.
 */

import { searchMovies } from '../../api/ophim.js';
import { renderPosterCard } from '../PosterCard/PosterCard.js';

const RECENT_SEARCHES_KEY = 'bluesia-recent-searches';
const MAX_RECENT = 8; // Increased slightly for pills layout
const DEBOUNCE_MS = 400;

// ---------------------------------------------------------------------------
// Recent searches helpers
// ---------------------------------------------------------------------------

function getRecentSearches() {
  try {
    const raw = localStorage.getItem(RECENT_SEARCHES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveRecentSearch(keyword) {
  if (!keyword || !keyword.trim()) return;
  const trimmed = keyword.trim();
  let recent = getRecentSearches().filter((s) => s !== trimmed);
  recent.unshift(trimmed);
  if (recent.length > MAX_RECENT) recent = recent.slice(0, MAX_RECENT);
  localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(recent));
}

function removeRecentSearch(keyword) {
  const recent = getRecentSearches().filter((s) => s !== keyword);
  localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(recent));
}

function clearAllRecentSearches() {
  localStorage.removeItem(RECENT_SEARCHES_KEY);
}

// ---------------------------------------------------------------------------
// Skeleton helpers
// ---------------------------------------------------------------------------

function createSkeletonCards(count = 8) {
  const frag = document.createDocumentFragment();
  for (let i = 0; i < count; i++) {
    const card = document.createElement('div');
    card.className = 'movie-card movie-card--skeleton';

    const posterWrap = document.createElement('div');
    posterWrap.className = 'movie-card__poster skeleton-shimmer';
    card.appendChild(posterWrap);

    const titleBar = document.createElement('div');
    titleBar.className = 'movie-card__title skeleton-shimmer';
    card.appendChild(titleBar);

    frag.appendChild(card);
  }
  return frag;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function renderSearchOverlay(container) {
  // ---- Root overlay ----
  const overlay = document.createElement('div');
  overlay.className = 'search-overlay';

  // ---- Header row (close + input) ----
  const header = document.createElement('div');
  header.className = 'search-overlay__header';

  const searchWrapper = document.createElement('div');
  searchWrapper.className = 'search-overlay__input-wrapper';
  
  const searchIcon = document.createElement('div');
  searchIcon.className = 'search-overlay__input-icon';
  searchIcon.innerHTML = `<svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>`;

  const input = document.createElement('input');
  input.className = 'search-overlay__input';
  input.type = 'text';
  input.placeholder = 'Phim, đạo diễn, diễn viên...';
  input.autocomplete = 'off';

  searchWrapper.appendChild(searchIcon);
  searchWrapper.appendChild(input);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'search-overlay__close';
  closeBtn.setAttribute('aria-label', 'Đóng tìm kiếm');
  closeBtn.innerHTML = `<svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;

  header.appendChild(searchWrapper);
  header.appendChild(closeBtn);

  // ---- Content area (recent searches / results / empty) ----
  const content = document.createElement('div');
  content.className = 'search-overlay__content';

  // Recent-searches panel
  const recentSection = document.createElement('div');
  recentSection.className = 'search-overlay__recent';

  // Results grid
  const resultsGrid = document.createElement('div');
  resultsGrid.className = 'search-overlay__results';

  // Empty state
  const emptyState = document.createElement('div');
  emptyState.className = 'search-overlay__empty';
  emptyState.innerHTML = `
    <svg class="search-overlay__empty-icon" viewBox="0 0 24 24" width="64" height="64" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"></rect>
      <line x1="7" y1="2" x2="7" y2="22"></line>
      <line x1="17" y1="2" x2="17" y2="22"></line>
      <line x1="2" y1="12" x2="22" y2="12"></line>
      <line x1="2" y1="7" x2="7" y2="7"></line>
      <line x1="2" y1="17" x2="7" y2="17"></line>
      <line x1="17" y1="17" x2="22" y2="17"></line>
      <line x1="17" y1="7" x2="22" y2="7"></line>
    </svg>
    <p>Không tìm thấy kết quả nào</p>
  `;

  content.appendChild(recentSection);
  content.appendChild(resultsGrid);
  content.appendChild(emptyState);

  overlay.appendChild(header);
  overlay.appendChild(content);
  container.appendChild(overlay);

  // ---- Internal state ----
  let debounceTimer = null;
  let abortController = null;

  // ---- Helpers ----

  function open() {
    overlay.classList.add('search-overlay--open');
    input.focus();
    showRecent();
  }

  function close() {
    overlay.classList.remove('search-overlay--open');
    input.value = '';
    clearResults();
    if (debounceTimer) clearTimeout(debounceTimer);
    if (abortController) abortController.abort();
  }

  function clearResults() {
    resultsGrid.innerHTML = '';
    emptyState.style.display = 'none';
    recentSection.style.display = 'none';
  }

  function showRecent() {
    clearResults();
    const recent = getRecentSearches();
    if (recent.length === 0) {
      recentSection.style.display = 'none';
      return;
    }

    recentSection.innerHTML = '';
    recentSection.style.display = '';

    const headingWrap = document.createElement('div');
    headingWrap.className = 'search-overlay__recent-header';

    const heading = document.createElement('h3');
    heading.className = 'search-overlay__recent-title';
    heading.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg> Tìm kiếm gần đây`;
    
    const clearAllBtn = document.createElement('button');
    clearAllBtn.className = 'search-overlay__recent-clear';
    clearAllBtn.textContent = 'Xoá lịch sử';
    clearAllBtn.addEventListener('click', () => {
      clearAllRecentSearches();
      showRecent();
    });

    headingWrap.appendChild(heading);
    headingWrap.appendChild(clearAllBtn);
    recentSection.appendChild(headingWrap);

    const list = document.createElement('ul');
    list.className = 'search-overlay__recent-list';

    recent.forEach((term) => {
      const li = document.createElement('li');
      li.className = 'search-overlay__recent-item';

      const btn = document.createElement('button');
      btn.className = 'search-overlay__recent-btn';
      btn.textContent = term;
      btn.addEventListener('click', () => {
        input.value = term;
        performSearch(term);
      });

      const removeBtn = document.createElement('button');
      removeBtn.className = 'search-overlay__recent-remove';
      removeBtn.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
      removeBtn.setAttribute('aria-label', 'Xoá từ khoá');
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeRecentSearch(term);
        showRecent();
      });

      li.appendChild(btn);
      li.appendChild(removeBtn);
      list.appendChild(li);
    });

    recentSection.appendChild(list);
  }

  function showSkeletons() {
    clearResults();
    resultsGrid.appendChild(createSkeletonCards(10));
  }

  async function performSearch(keyword) {
    if (!keyword || !keyword.trim()) {
      showRecent();
      return;
    }

    // Cancel any in-flight request
    if (abortController) abortController.abort();
    abortController = new AbortController();

    showSkeletons();

    try {
      const { items } = await searchMovies(keyword.trim());

      // Guard against stale results (user may have typed something else)
      if (input.value.trim() !== keyword.trim()) return;

      resultsGrid.innerHTML = '';
      recentSection.style.display = 'none';

      if (!items || items.length === 0) {
        emptyState.style.display = 'flex';
        return;
      }

      emptyState.style.display = 'none';
      items.forEach((movie, index) => {
        const cardWrapper = document.createElement('div');
        cardWrapper.className = 'search-overlay__result-item fade-up';
        cardWrapper.style.animationDelay = `${Math.min(index * 0.05, 0.5)}s`;
        renderPosterCard(cardWrapper, movie);
        resultsGrid.appendChild(cardWrapper);
      });

      saveRecentSearch(keyword.trim());
    } catch (err) {
      if (err.name === 'AbortError') return;
      resultsGrid.innerHTML = '';
      emptyState.innerHTML = '<p>Đã xảy ra lỗi khi tìm kiếm. Vui lòng thử lại.</p>';
      emptyState.style.display = 'flex';
    }
  }

  // ---- Event handlers ----

  function handleOpenSearch() {
    open();
  }

  function handleKeydown(e) {
    if (e.key === 'Escape' && overlay.classList.contains('search-overlay--open')) {
      close();
    }
  }

  function handleInput() {
    if (debounceTimer) clearTimeout(debounceTimer);
    const keyword = input.value;

    if (keyword.trim().length < 2) {
      showRecent();
      return;
    }

    debounceTimer = setTimeout(() => {
      performSearch(keyword);
    }, DEBOUNCE_MS);
  }

  function handleRouteChange() {
    if (overlay.classList.contains('search-overlay--open')) {
      close();
    }
  }

  // ---- Bind events ----
  document.addEventListener('open-search', handleOpenSearch);
  document.addEventListener('keydown', handleKeydown);
  window.addEventListener('route-changed', handleRouteChange);
  closeBtn.addEventListener('click', close);
  input.addEventListener('input', handleInput);

  // ---- Cleanup ----
  return function cleanup() {
    document.removeEventListener('open-search', handleOpenSearch);
    document.removeEventListener('keydown', handleKeydown);
    window.removeEventListener('route-changed', handleRouteChange);
    closeBtn.removeEventListener('click', close);
    input.removeEventListener('input', handleInput);
    if (debounceTimer) clearTimeout(debounceTimer);
    if (abortController) abortController.abort();
    overlay.remove();
  };
}
