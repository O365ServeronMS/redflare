import { Hono, type Context } from 'hono';
import type { Env } from '../types/env';
import { MovieRepository } from '../repositories/movieRepository';
import { EpisodeRepository } from '../repositories/episodeRepository';
import { RecommendationRepository } from '../repositories/recommendationRepository';
import { TaxonomyRepository } from '../repositories/taxonomyRepository';
import { SearchRepository } from '../repositories/searchRepository';
import { toLegacyItems, toLegacyDetail, toLegacyEpisodes } from './legacyItem';
import { buildHomeData } from './homeData';
import { clampPage, buildPagination } from './pagination';
import { isValidSlug } from '../middleware/validate';
import { LIST_TYPE_LABELS } from '../lib/listTypes';
import { applyPageCache, applyNoStore } from '../cache/control';

export const apiRoute = new Hono<{ Bindings: Env }>();

const PAGE_SIZE = 24;
const SEARCH_LIMIT = 24;
const RECOMMENDATION_LIMIT = 12;
const MAX_KEYWORD_LENGTH = 100; // ADR-0002 "Security": reject, don't sanitize

// /api/* is JSON, not a cacheable-forever page -- same policy the SSR pages
// used (max-age=60, no s-maxage), just applied to a JSON body instead of
// HTML. See cache/control.ts for why s-maxage is never used here.
function applyApiCache(c: Context, tags: string[]) {
  applyPageCache(c, ['api', ...tags]);
}

// GET /api/home-data (docs/contract-legacy-api.md §1)
apiRoute.get('/api/home-data', async (c) => {
  const data = await buildHomeData(c.env.DB);
  applyApiCache(c, ['home']);
  return c.json(data);
});

// GET /api/movie/:slug (docs/contract-legacy-api.md §4)
apiRoute.get('/api/movie/:slug', async (c) => {
  const slug = c.req.param('slug');
  if (!isValidSlug(slug)) return c.text('Not found', 404);

  const movie = await new MovieRepository(c.env.DB).getBySlug(slug);
  if (!movie) return c.text('Not found', 404);

  const episodes = await new EpisodeRepository(c.env.DB).getBySlug(slug);

  applyApiCache(c, [`movie:${slug}`]);
  return c.json({
    movie: toLegacyDetail(movie),
    episodes: toLegacyEpisodes(episodes),
  });
});

// GET /api/list?type=&page= (docs/contract-legacy-api.md §2)
apiRoute.get('/api/list', async (c) => {
  const type = c.req.query('type');
  const page = clampPage(c.req.query('page'));
  const movieRepo = new MovieRepository(c.env.DB);

  // §2a: phim-moi-cap-nhat -- FLAT shape, {items, pagination} at the top
  // level, not wrapped in `data`. getNewMovies() in ophim.js reads exactly
  // this and nothing else.
  if (type === 'phim-moi-cap-nhat') {
    const [rows, totalItems] = await Promise.all([
      movieRepo.getRecentMoviesOffset(page, PAGE_SIZE),
      movieRepo.countCatalog(),
    ]);
    applyApiCache(c, ['type:phim-moi-cap-nhat']);
    return c.json({ items: toLegacyItems(rows), pagination: buildPagination(totalItems, PAGE_SIZE, page) });
  }

  // §2b: everything else -- "v1" shape, wrapped in `data`.
  const entry = type ? LIST_TYPE_LABELS[type] : undefined;
  if (!entry) return c.text('Not found', 404);

  const [rows, totalItems] = await Promise.all([
    movieRepo.getPageByTypeOffset(entry.value, page, PAGE_SIZE),
    movieRepo.countByType(entry.value),
  ]);

  applyApiCache(c, [`type:${type}`]);
  return c.json({
    data: {
      items: toLegacyItems(rows),
      params: { pagination: buildPagination(totalItems, PAGE_SIZE, page) },
      titlePage: entry.label,
      breadCrumb: [],
      seoOnPage: {},
    },
  });
});

// GET /api/genre?slug=&page= (docs/contract-legacy-api.md §3)
apiRoute.get('/api/genre', async (c) => {
  const slug = c.req.query('slug') ?? '';
  const page = clampPage(c.req.query('page'));
  if (!isValidSlug(slug)) return c.text('Not found', 404);

  const taxonomy = new TaxonomyRepository(c.env.DB);
  const genre = await taxonomy.getGenre(slug);
  if (!genre) return c.text('Not found', 404);

  const [rows, totalItems] = await Promise.all([
    taxonomy.getMoviesByGenreOffset(slug, page, PAGE_SIZE),
    taxonomy.countByGenre(slug),
  ]);

  applyApiCache(c, [`genre:${slug}`]);
  return c.json({
    data: {
      items: toLegacyItems(rows),
      params: { pagination: buildPagination(totalItems, PAGE_SIZE, page) },
      titlePage: genre.name,
      breadCrumb: [],
      seoOnPage: {},
    },
  });
});

// GET /api/country?slug=&page= (docs/contract-legacy-api.md §3)
apiRoute.get('/api/country', async (c) => {
  const slug = c.req.query('slug') ?? '';
  const page = clampPage(c.req.query('page'));
  if (!isValidSlug(slug)) return c.text('Not found', 404);

  const taxonomy = new TaxonomyRepository(c.env.DB);
  const country = await taxonomy.getCountry(slug);
  if (!country) return c.text('Not found', 404);

  const [rows, totalItems] = await Promise.all([
    taxonomy.getMoviesByCountryOffset(slug, page, PAGE_SIZE),
    taxonomy.countByCountry(slug),
  ]);

  applyApiCache(c, [`country:${slug}`]);
  return c.json({
    data: {
      items: toLegacyItems(rows),
      params: { pagination: buildPagination(totalItems, PAGE_SIZE, page) },
      titlePage: country.name,
      breadCrumb: [],
      seoOnPage: {},
    },
  });
});

// GET /api/search?keyword=&page= (docs/contract-legacy-api.md §5) -- no
// pagination beyond page 1 (FTS5 rank order has no cheap OFFSET; the
// overlay never requests page 2 anyway). Cache-Tag is generic ("search"),
// not per-keyword -- keyword cardinality is unbounded, tagging per-query
// would recreate the cache-poisoning problem the rest of the API avoids.
apiRoute.get('/api/search', async (c) => {
  const keyword = (c.req.query('keyword') ?? '').trim();
  const page = clampPage(c.req.query('page'));
  if (!keyword || keyword.length > MAX_KEYWORD_LENGTH) {
    applyApiCache(c, ['search']);
    return c.json({ data: { items: [], params: { pagination: buildPagination(0, SEARCH_LIMIT, 1) } } });
  }

  const rows = page === 1 ? await new SearchRepository(c.env.DB).search(keyword, SEARCH_LIMIT) : [];

  applyApiCache(c, ['search']);
  return c.json({
    data: {
      items: toLegacyItems(rows),
      params: { pagination: buildPagination(rows.length, SEARCH_LIMIT, 1) },
    },
  });
});

// GET /api/recommendation/:mediaType/:tmdbId (+ alias /api/related/...)
// docs/contract-legacy-api.md §6 -- not found is {items: []}, never 404;
// the client doesn't special-case an error response for this route.
async function handleRecommendation(c: Context<{ Bindings: Env }>) {
  const mediaTypeParam = c.req.param('mediaType');
  const tmdbId = Number(c.req.param('tmdbId'));
  const mediaType = mediaTypeParam === 'tv' ? 'tv' : 'movie';

  if (!Number.isFinite(tmdbId) || tmdbId <= 0) {
    applyApiCache(c, ['recommendation']);
    return c.json({ items: [] });
  }

  const movie = await new MovieRepository(c.env.DB).getByTmdbRef(mediaType, tmdbId);
  const rows = movie
    ? await new RecommendationRepository(c.env.DB).getResolvedForSlug(movie.slug, RECOMMENDATION_LIMIT)
    : [];

  applyApiCache(c, [`recommendation:${mediaType}:${tmdbId}`]);
  return c.json({ items: toLegacyItems(rows) });
}

apiRoute.get('/api/recommendation/:mediaType/:tmdbId', handleRecommendation);
apiRoute.get('/api/related/:mediaType/:tmdbId', handleRecommendation);

// Never intended for a browser to hit, but keeps /api/* from ever falling
// through to the notFound handler with cacheable headers if someone
// requests an unknown /api/ path.
apiRoute.notFound((c) => {
  applyNoStore(c);
  return c.text('Not found', 404);
});
