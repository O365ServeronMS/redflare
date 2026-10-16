/**
 * Minimal History API-based SPA router
 * Routes: / , /phim/:slug , /danh-sach/:type , /the-loai/:slug , /quoc-gia/:slug , /tim-kiem
 */

let routes = [];
let notFoundHandler = null;
let currentCleanup = null;

/**
 * Register routes. Each route has a pattern and handler.
 * Pattern uses :param syntax for dynamic segments.
 * @param {Array<{path: string, handler: function}>} routeDefs
 * @param {function} notFound - handler for paths no route matches
 */
export function initRouter(routeDefs, notFound) {
  notFoundHandler = notFound;
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
      path,
      regex: new RegExp(`^${regexStr}\\/?$`),
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
      // If the link is an internal clean path
      if (href && href.startsWith('/')) {
        e.preventDefault();
        navigate(href);
      }
    }
  });

  handleRoute();
}

/**
 * Navigate to a route programmatically
 * @param {string} path - e.g. '/phim/toy-story-5'
 */
export function navigate(path) {
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
  
  // Dispatch event so persistent UI components (like Header) can update
  window.dispatchEvent(new CustomEvent('route-changed', { detail: path }));

  for (const route of routes) {
    // Exact match for root or static paths
    if (route.path === path || route.path === path.replace(/\/$/, '')) {
      window.scrollTo(0, 0);
      runHandler(route.handler, { params: {}, query });
      return;
    }

    // Prefix match for dynamic paths like /phim/:slug
    if (route.path.includes(':')) {
      const prefix = route.path.split('/:')[0] + '/'; // e.g. "/phim/"
      if (path.startsWith(prefix)) {
        const slug = path.slice(prefix.length).replace(/\/$/, ''); // extract "hoang-tu-quy"
        if (slug) {
          const params = {};
          params[route.paramNames[0]] = decodeURIComponent(slug);
          
          window.scrollTo(0, 0);
          runHandler(route.handler, { params, query });
          return;
        }
      }
    }
  }

  runHandler(notFoundHandler, { params: {}, query });
}

function runHandler(handler, routeContext) {
  const cleanup = handler(routeContext);

  if (cleanup && typeof cleanup.then === 'function') {
    cleanup
      .then((resolvedCleanup) => {
        if (typeof resolvedCleanup === 'function') currentCleanup = resolvedCleanup;
      })
      .catch((err) => {
        setTimeout(() => {
          throw err;
        });
      });
    return;
  }

  if (typeof cleanup === 'function') currentCleanup = cleanup;
}
