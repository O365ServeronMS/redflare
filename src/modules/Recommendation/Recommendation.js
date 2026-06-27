/**
 * Recommendation — "Bạn cũng có thể thích" related-titles block.
 *
 * Module map (one name across every layer — see MODULES.md):
 *   UI            src/modules/Recommendation/Recommendation.js   (this file)
 *   API client    getRelatedMovies()  in src/api/ophim.js
 *   Backend       GET /api/related/:type/:id  (catalog-api server.js)
 *   Cache         catalog:c1:related:* + idx:* (Valkey, on the VPS)
 *
 * Fire-and-forget: resolves TMDB recommendations (via the VPS catalog-api) for the
 * current title and renders them as a carousel. Must NOT block the detail render.
 * Currently reuses the Carousel module's styling — no dedicated CSS yet.
 */

import { getRelatedMovies } from '../../api/ophim.js';
import { renderCarousel } from '../Carousel/Carousel.js';

export async function renderRecommendation(container, movie) {
  const tmdbId = movie.tmdb?.id;
  if (!tmdbId) return;

  const items = await getRelatedMovies(tmdbId, movie.tmdb?.type).catch(() => []);
  if (!items.length) return;

  renderCarousel(container, {
    title: 'Bạn cũng có thể thích',
    items,
  });
}
