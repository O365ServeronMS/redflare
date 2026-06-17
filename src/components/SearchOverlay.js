/**
 * SearchOverlay — full-screen search panel
 * Opens via custom 'open-search' event on document.
 * Closes via ✕ button or Escape key.
 */

import { searchMovies } from '../api/ophim.js';
import { renderMovieCard } from './MovieCard.js';

const RECENT_SEARCHES_KEY = 'bluesia-recent-searches';
const MAX_RECENT = 5;
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

  const closeBtn = document.createElement('button');
  closeBtn.className = 'search-overlay__close';
  closeBtn.setAttribute('aria-label', 'Đóng tìm kiếm');
  closeBtn.textContent = '✕';

  const input = document.createElement('input');
  input.className = 'search-overlay__input';
  input.type = 'text';
  input.placeholder = 'Tìm kiếm phim...';
  input.autocomplete = 'off';

  header.appendChild(closeBtn);
  header.appendChild(input);

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
  emptyState.textContent = 'Không tìm thấy phim nào';

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

    const heading = document.createElement('h3');
    heading.className = 'search-overlay__recent-title';
    heading.textContent = 'Tìm kiếm gần đây';
    recentSection.appendChild(heading);

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

      li.appendChild(btn);
      list.appendChild(li);
    });

    recentSection.appendChild(list);
  }

  function showSkeletons() {
    clearResults();
    resultsGrid.appendChild(createSkeletonCards(8));
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
        emptyState.style.display = '';
        return;
      }

      emptyState.style.display = 'none';
      items.forEach((movie) => {
        renderMovieCard(resultsGrid, movie);
      });

      saveRecentSearch(keyword.trim());
    } catch (err) {
      if (err.name === 'AbortError') return;
      resultsGrid.innerHTML = '';
      emptyState.textContent = 'Đã xảy ra lỗi khi tìm kiếm. Vui lòng thử lại.';
      emptyState.style.display = '';
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

  // ---- Bind events ----
  document.addEventListener('open-search', handleOpenSearch);
  document.addEventListener('keydown', handleKeydown);
  closeBtn.addEventListener('click', close);
  input.addEventListener('input', handleInput);

  // ---- Cleanup ----
  return function cleanup() {
    document.removeEventListener('open-search', handleOpenSearch);
    document.removeEventListener('keydown', handleKeydown);
    closeBtn.removeEventListener('click', close);
    input.removeEventListener('input', handleInput);
    if (debounceTimer) clearTimeout(debounceTimer);
    if (abortController) abortController.abort();
    overlay.remove();
  };
}
