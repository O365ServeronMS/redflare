import { Hono } from 'hono';
import type { Env } from '../types/env';
import { TaxonomyRepository } from '../repositories/taxonomyRepository';
import { renderListPage } from '../render/listPage';
import { SITE_ORIGIN } from '../render/seo';
import { decodeCursor } from '../lib/cursor';
import { isValidSlug } from '../middleware/validate';

export const countryRoute = new Hono<{ Bindings: Env }>();
const PAGE_SIZE = 24;

countryRoute.get('/quoc-gia/:slug', async (c) => {
  const slug = c.req.param('slug');
  if (!isValidSlug(slug)) return c.text('Not found', 404);

  const taxonomy = new TaxonomyRepository(c.env.DB);
  const country = await taxonomy.getCountry(slug);
  if (!country) return c.text('Not found', 404);

  const cursor = decodeCursor(c.req.query('cursor'));
  const { items, nextCursor } = await taxonomy.getMoviesByCountry(slug, cursor, PAGE_SIZE);

  return c.html(
    renderListPage({
      h1: `Quốc gia: ${country.name}`,
      description: `Phim quốc gia ${country.name} mới cập nhật trên Film Bluesia.`,
      canonicalPath: `/quoc-gia/${slug}`,
      breadcrumb: [
        { name: 'Trang chủ', url: SITE_ORIGIN },
        { name: country.name, url: `${SITE_ORIGIN}/quoc-gia/${slug}` },
      ],
      items,
      nextCursor,
    })
  );
});
