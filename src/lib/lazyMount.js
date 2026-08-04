/**
 * Defer rendering a below-the-fold section (and any network request it
 * triggers) until its placeholder scrolls near the viewport. Used for
 * home-page rows and page sections that don't need to be part of first paint.
 */
export function mountWhenVisible(placeholder, renderFn, { rootMargin = '600px' } = {}) {
  let done = false;
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting && !done) {
        done = true;
        observer.disconnect();
        renderFn();
      }
    }
  }, { rootMargin });

  observer.observe(placeholder);
  return () => observer.disconnect();
}
