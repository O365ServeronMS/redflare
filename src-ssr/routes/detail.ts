import { Hono } from 'hono';
import type { Env } from '../types/env';
import { MovieRepository } from '../repositories/movieRepository';
import { EpisodeRepository } from '../repositories/episodeRepository';
import { RecommendationRepository } from '../repositories/recommendationRepository';
import { renderDetailPage } from '../render/detailPage';
import { isValidSlug } from '../middleware/validate';

export const detailRoute = new Hono<{ Bindings: Env }>();

const RECOMMENDATION_LIMIT = 12;

// GET /phim/:slug -- 3-query budget (plan §3.1): movie, episodes,
// recommendations-JOIN-movie. No loop over getBySlug for each
// recommendation target.
detailRoute.get('/phim/:slug', async (c) => {
  const slug = c.req.param('slug');
  if (!isValidSlug(slug)) return c.text('Not found', 404);

  const movie = await new MovieRepository(c.env.DB).getBySlug(slug);
  if (!movie) return c.text('Not found', 404);

  const [episodes, recommendations] = await Promise.all([
    new EpisodeRepository(c.env.DB).getBySlug(slug),
    new RecommendationRepository(c.env.DB).getResolvedForSlug(slug, RECOMMENDATION_LIMIT),
  ]);

  return c.html(renderDetailPage({ movie, episodes, recommendations }));
});
