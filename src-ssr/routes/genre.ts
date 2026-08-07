import { Hono } from 'hono';
import type { Env } from '../types/env';
import { TaxonomyRepository } from '../repositories/taxonomyRepository';
import { renderListPage } from '../render/listPage';
import { SITE_ORIGIN } from '../render/seo';
import { decodeCursor } from '../lib/cursor';
import { isValidSlug } from '../middleware/validate';

export const genreRoute = new Hono<{ Bindings: Env }>();
const PAGE_SIZE = 24;

genreRoute.get('/the-loai/:slug', async (c) => {
  const slug = c.req.param('slug');
  if (!isValidSlug(slug)) return c.text('Not found', 404);

  const taxonomy = new TaxonomyRepository(c.env.DB);
  const genre = await taxonomy.getGenre(slug);
  if (!genre) return c.text('Not found', 404);

  const cursor = decodeCursor(c.req.query('cursor'));
  const { items, nextCursor } = await taxonomy.getMoviesByGenre(slug, cursor, PAGE_SIZE);

  return c.html(
    renderListPage({
      h1: `Thể loại: ${genre.name}`,
      description: `Phim thể loại ${genre.name} mới cập nhật trên Film Bluesia.`,
      canonicalPath: `/the-loai/${slug}`,
      breadcrumb: [
        { name: 'Trang chủ', url: SITE_ORIGIN },
        { name: genre.name, url: `${SITE_ORIGIN}/the-loai/${slug}` },
      ],
      items,
      nextCursor,
    })
  );
});
