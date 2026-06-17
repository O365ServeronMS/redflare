/**
 * Minimal History API-based SPA router
 * Routes: / , /phim/:slug , /danh-sach/:type , /the-loai/:slug , /quoc-gia/:slug , /tim-kiem
 */

let routes = [];
let currentCleanup = null;

/**
 * Register routes. Each route has a pattern and handler.
 * Pattern uses :param syntax for dynamic segments.
 * @param {Array<{path: string, handler: function}>} routeDefs
 */
export function initRouter(routeDefs) {
  routes = routeDefs.map(({ path, handler }) => {
    // Convert path pattern to regex
    const paramNames = [];
    const regexStr = path
      .replace(/:([^/]+)/g, (_, name) => {
        paramNames.push(name);
        return '([^/]+)';
      })
      .replace(/\//g, '\\/');
    return {
      regex: new RegExp(`^${regexStr}$`),
      paramNames,
      handler,
    };
  });

  window.addEventListener('popstate', () => handleRoute());
  
  // Intercept local links globally
  document.addEventListener('click', (e) => {
    const link = e.target.closest('a');
    if (link) {
      const href = link.getAttribute('href');
      // If the link is an internal link (e.g. starts with / or #/)
      if (href && (href.startsWith('/') || href.startsWith('#/'))) {
        e.preventDefault();
        navigate(href);
      }
    }
  });

  handleRoute();
}

/**
 * Navigate to a route programmatically
 * @param {string} path - e.g. '/phim/toy-story-5' or '#/phim/toy-story-5'
 */
export function navigate(path) {
  // Normalize legacy hash paths
  if (path.startsWith('#/')) {
    path = path.slice(1);
  } else if (path === '#') {
    path = '/';
  }
  
  history.pushState(null, '', path);
  handleRoute();
}

/**
 * Get the current route info
 */
export function getCurrentRoute() {
  const path = window.location.pathname || '/';
  const queryStr = window.location.search;
  const query = Object.fromEntries(new URLSearchParams(queryStr || ''));
  return { path, query };
}

function handleRoute() {
  // Cleanup previous page
  if (currentCleanup && typeof currentCleanup === 'function') {
    currentCleanup();
    currentCleanup = null;
  }

  const { path, query } = getCurrentRoute();

  for (const route of routes) {
    const match = path.match(route.regex);
    if (match) {
      const params = {};
      route.paramNames.forEach((name, i) => {
        params[name] = decodeURIComponent(match[i + 1]);
      });

      // Scroll to top on navigation
      window.scrollTo(0, 0);

      // Call handler, store cleanup function if returned
      const cleanup = route.handler({ params, query });
      if (typeof cleanup === 'function') {
        currentCleanup = cleanup;
      }
      return;
    }
  }

  // 404 fallback — redirect to home
  navigate('/');
}
