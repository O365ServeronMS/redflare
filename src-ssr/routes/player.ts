import { Hono } from 'hono';
import type { Env } from '../types/env';
import { MovieRepository } from '../repositories/movieRepository';
import { EpisodeRepository } from '../repositories/episodeRepository';
import { renderPlayerPage } from '../render/playerPage';
import { isValidSlug } from '../middleware/validate';

export const playerRoute = new Hono<{ Bindings: Env }>();

async function loadPlayerData(env: Env, slug: string) {
  const movie = await new MovieRepository(env.DB).getBySlug(slug);
  if (!movie || !movie.has_stream) return null;
  const episodes = await new EpisodeRepository(env.DB).getBySlug(slug);
  return { movie, episodes };
}

// /xem/:slug -- defaults to the first episode.
playerRoute.get('/xem/:slug', async (c) => {
  const slug = c.req.param('slug');
  if (!isValidSlug(slug)) return c.text('Not found', 404);
  const data = await loadPlayerData(c.env, slug);
  const first = data?.episodes[0];
  if (!data || !first) return c.text('Not found', 404);
  return c.html(renderPlayerPage(data.movie, first, data.episodes));
});

// /xem/:slug/:epSlug -- a specific episode (first server match; server
// selection via query param is a later refinement, not needed for Phase 3).
playerRoute.get('/xem/:slug/:epSlug', async (c) => {
  const slug = c.req.param('slug');
  const epSlug = c.req.param('epSlug');
  if (!isValidSlug(slug) || !isValidSlug(epSlug)) return c.text('Not found', 404);
  const data = await loadPlayerData(c.env, slug);
  const episode = data?.episodes.find((e) => e.epSlug === epSlug);
  if (!data || !episode) return c.text('Not found', 404);
  return c.html(renderPlayerPage(data.movie, episode, data.episodes));
});
