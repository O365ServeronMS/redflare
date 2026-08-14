import { Hono } from 'hono';
import { MovieRepository } from '../repositories/movieRepository';
import { TaxonomyRepository } from '../repositories/taxonomyRepository';
import { renderSitemapIndex, renderUrlset, renderRobotsTxt } from '../render/sitemap';
import { SITE_ORIGIN } from '../lib/site';
import { LIST_TYPE_LABELS } from '../lib/listTypes';
import { applyPageCache } from '../cache/control';

export const sitemapRoute = new Hono<{ Bindings: Env }>();

// Plan §6: 50,000 URLs/shard, matching the sitemaps.org protocol limit --
// far more than this catalog needs today, but the shard math means growth
// past that doesn't require a design change later.
const SITEMAP_SHARD_SIZE = 50_000;

sitemapRoute.get('/sitemap.xml', async (c) => {
  const total = await new MovieRepository(c.env.DB).countByTier('catalog');
  const shardCount = Math.max(1, Math.ceil(total / SITEMAP_SHARD_SIZE));
  const shardUrls = Array.from({ length: shardCount }, (_, i) => `${SITE_ORIGIN}/sitemap-movies-${i}.xml`);
  shardUrls.push(`${SITE_ORIGIN}/sitemap-static.xml`);

  applyPageCache(c);
  return c.body(renderSitemapIndex(shardUrls), 200, { 'content-type': 'application/xml; charset=UTF-8' });
});

sitemapRoute.get('/sitemap-movies-:n.xml', async (c) => {
  const n = Number(c.req.param('n'));
  if (!Number.isInteger(n) || n < 0) return c.text('Not found', 404);

  const rows = await new MovieRepository(c.env.DB).getSitemapPage(n * SITEMAP_SHARD_SIZE, SITEMAP_SHARD_SIZE);
  const urls = rows.map((r) => ({ loc: `${SITE_ORIGIN}/phim/${r.slug}`, lastmod: r.last_synced }));

  applyPageCache(c);
  return c.body(renderUrlset(urls), 200, { 'content-type': 'application/xml; charset=UTF-8' });
});

sitemapRoute.get('/sitemap-static.xml', async (c) => {
  const taxonomy = new TaxonomyRepository(c.env.DB);
  const [genres, countries] = await Promise.all([taxonomy.listGenres(), taxonomy.listCountries()]);

  const urls = [
    ...Object.keys(LIST_TYPE_LABELS).map((type) => ({ loc: `${SITE_ORIGIN}/danh-sach/${type}` })),
    ...genres.map((g) => ({ loc: `${SITE_ORIGIN}/the-loai/${g.slug}` })),
    ...countries.map((cn) => ({ loc: `${SITE_ORIGIN}/quoc-gia/${cn.slug}` })),
  ];

  applyPageCache(c);
  return c.body(renderUrlset(urls), 200, { 'content-type': 'application/xml; charset=UTF-8' });
});

sitemapRoute.get('/robots.txt', (c) => {
  applyPageCache(c);
  return c.text(renderRobotsTxt());
});
