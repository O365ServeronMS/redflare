import { Hono } from 'hono';
import type { Env } from '../types/env';
import { MovieRepository } from '../repositories/movieRepository';
import { renderHomePage } from '../render/homePage';
import { applyPageCache } from '../cache/control';

export const homeRoute = new Hono<{ Bindings: Env }>();
const RECENT_LIMIT = 24;

homeRoute.get('/', async (c) => {
  const recent = await new MovieRepository(c.env.DB).getRecentMovies(RECENT_LIMIT);
  applyPageCache(c, ['tier:home']);
  return c.html(renderHomePage(recent));
});
