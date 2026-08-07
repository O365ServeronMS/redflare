import { Hono } from 'hono';
import type { Env } from '../types/env';
import { MovieRepository } from '../repositories/movieRepository';
import { EpisodeRepository } from '../repositories/episodeRepository';
import { RecommendationRepository } from '../repositories/recommendationRepository';
import { renderDetailPage } from '../render/detailPage';
import { isValidSlug } from '../middleware/validate';
import { applyPageCache, apply404Cache, buildEtag } from '../cache/control';
import { canonicalRedirectPath } from '../lib/canonicalQuery';

export const detailRoute = new Hono<{ Bindings: Env }>();

const RECOMMENDATION_LIMIT = 12;

// GET /phim/:slug -- 3-query budget (plan §3.1): movie, episodes,
// recommendations-JOIN-movie. No loop over getBySlug for each
// recommendation target.
detailRoute.get('/phim/:slug', async (c) => {
  const slug = c.req.param('slug');
  if (!isValidSlug(slug)) {
    apply404Cache(c);
    return c.text('Not found', 404);
  }

  // No query params expected on this route at all -- anything present is
  // either tracking-param noise or an attempt to mint distinct cache
  // entries for the same page (ADR-0002 "Security").
  const redirect = canonicalRedirectPath(`/phim/${slug}`, new URL(c.req.url).searchParams, []);
  if (redirect) return c.redirect(redirect, 301);

  const movie = await new MovieRepository(c.env.DB).getBySlug(slug);
  if (!movie) {
    apply404Cache(c);
    return c.text('Not found', 404);
  }

  const etag = buildEtag(movie.slug, movie.last_synced);
  if (c.req.header('if-none-match') === etag) {
    applyPageCache(c, [`movie:${slug}`, 'tier:detail']);
    c.header('ETag', etag);
    return c.body(null, 304);
  }

  const [episodes, recommendations] = await Promise.all([
    new EpisodeRepository(c.env.DB).getBySlug(slug),
    new RecommendationRepository(c.env.DB).getResolvedForSlug(slug, RECOMMENDATION_LIMIT),
  ]);

  applyPageCache(c, [`movie:${slug}`, 'tier:detail']);
  c.header('ETag', etag);
  return c.html(renderDetailPage({ movie, episodes, recommendations }));
});
