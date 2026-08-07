import { Hono } from 'hono';
import type { Env } from '../types/env';
import { MovieRepository } from '../repositories/movieRepository';
import { EpisodeRepository } from '../repositories/episodeRepository';
import { renderDetailPage } from '../render/detailPage';
import { isValidSlug } from '../middleware/validate';

export const detailRoute = new Hono<{ Bindings: Env }>();

// GET /phim/:slug -- 3-query budget target (Phase 3 will add the
// recommendation join; Phase 1 is 2 queries: movie + episodes).
detailRoute.get('/phim/:slug', async (c) => {
  const slug = c.req.param('slug');
  if (!isValidSlug(slug)) return c.text('Not found', 404);

  const movie = await new MovieRepository(c.env.DB).getBySlug(slug);
  if (!movie) return c.text('Not found', 404);

  const episodes = await new EpisodeRepository(c.env.DB).getBySlug(slug);
  return c.html(renderDetailPage(movie, episodes));
});
