import { Hono, type Context } from 'hono';
import { MovieRepository } from '../repositories/movieRepository';
import { EpisodeRepository } from '../repositories/episodeRepository';
import { RecommendationRepository } from '../repositories/recommendationRepository';
import { TaxonomyRepository } from '../repositories/taxonomyRepository';
import { SearchRepository } from '../repositories/searchRepository';
import { CatalogStatsRepository } from '../repositories/catalogStatsRepository';
import { toLegacyItems, toLegacyDetail, toLegacyEpisodes } from './legacyItem';
import { buildHomeData } from './homeData';
import { clampPage, buildPagination } from './pagination';
import { isValidSlug } from '../middleware/validate';
import { LIST_TYPE_LABELS } from '../lib/listTypes';
import { applyPageCache, applyNoStore } from '../cache/control';

export const apiRoute = new Hono<{ Bindings: Env }>();

const PAGE_SIZE = 24;
const SEARCH_LIMIT = 24;
const RECOMMENDATION_LIMIT = 10;
const MAX_KEYWORD_LENGTH = 100; // ADR-0002 "Security": reject, don't sanitize

// GET /api/home-data (docs/contract-legacy-api.md §1)
apiRoute.get('/api/home-data', async (c) => {
  const data = await buildHomeData(c.env.DB);
  applyPageCache(c);
  return c.json(data);
});

// GET /api/movie/:slug (docs/contract-legacy-api.md §4)
apiRoute.get('/api/movie/:slug', async (c) => {
  const slug = c.req.param('slug');
  if (!isValidSlug(slug)) return c.text('Not found', 404);

  const movie = await new MovieRepository(c.env.DB).getBySlug(slug);
  if (!movie) return c.text('Not found', 404);

  const episodes = await new EpisodeRepository(c.env.DB).getBySlug(slug);

  applyPageCache(c);
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
  const catalogStats = new CatalogStatsRepository(c.env.DB);

  // §2a: phim-moi-cap-nhat -- FLAT shape, {items, pagination} at the top
  // level, not wrapped in `data`. getNewMovies() in ophim.js reads exactly
  // this and nothing else.
  if (type === 'phim-moi-cap-nhat') {
    const [rows, totalItems] = await Promise.all([
      movieRepo.getRecentMoviesOffset(page, PAGE_SIZE),
      catalogStats.getTierCount('catalog', () => movieRepo.countCatalog()),
    ]);
    applyPageCache(c);
    return c.json({ items: toLegacyItems(rows), pagination: buildPagination(totalItems, PAGE_SIZE, page) });
  }

  // §2b: everything else -- "v1" shape, wrapped in `data`.
  const entry = type ? LIST_TYPE_LABELS[type] : undefined;
  if (!entry) return c.text('Not found', 404);

  const [rows, totalItems] = await Promise.all([
    movieRepo.getPageByTypeOffset(entry.value, page, PAGE_SIZE),
    catalogStats.getTypeCount(entry.value, () => movieRepo.countByType(entry.value)),
  ]);

  applyPageCache(c);
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
  const catalogStats = new CatalogStatsRepository(c.env.DB);
  const genre = await taxonomy.getGenre(slug);
  if (!genre) return c.text('Not found', 404);

  const [rows, totalItems] = await Promise.all([
    taxonomy.getMoviesByGenreOffset(slug, page, PAGE_SIZE),
    catalogStats.getGenreCount(slug, () => taxonomy.countByGenre(slug)),
  ]);

  applyPageCache(c);
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
  const catalogStats = new CatalogStatsRepository(c.env.DB);
  const country = await taxonomy.getCountry(slug);
  if (!country) return c.text('Not found', 404);

  const [rows, totalItems] = await Promise.all([
    taxonomy.getMoviesByCountryOffset(slug, page, PAGE_SIZE),
    catalogStats.getCountryCount(slug, () => taxonomy.countByCountry(slug)),
  ]);

  applyPageCache(c);
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

// POST /api/search (docs/contract-legacy-api.md §5). The response is
// private and uncacheable since it's keyed by free-text user input.
apiRoute.post('/api/search', async (c) => {
  let form: FormData;
  try {
    form = await c.req.raw.formData();
  } catch {
    applyNoStore(c);
    return c.text('forbidden', 403);
  }

  const keywordValue = form.get('keyword');
  const pageValue = form.get('page');
  const keyword = typeof keywordValue === 'string' ? keywordValue.trim() : '';
  const page = clampPage(typeof pageValue === 'string' ? pageValue : undefined);
  if (!keyword || keyword.length > MAX_KEYWORD_LENGTH) {
    applyNoStore(c);
    return c.json({ data: { items: [], params: { pagination: buildPagination(0, SEARCH_LIMIT, 1) } } });
  }

  const rows = page === 1 ? await new SearchRepository(c.env.DB).search(keyword, SEARCH_LIMIT) : [];

  applyNoStore(c);
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
    applyPageCache(c);
    return c.json({ items: [] });
  }

  const movie = await new MovieRepository(c.env.DB).getRecommendationSourceByTmdbRef(mediaType, tmdbId);
  const rows = movie
    ? await new RecommendationRepository(c.env.DB).getResolvedForSlug(movie.slug, RECOMMENDATION_LIMIT)
    : [];

  applyPageCache(c);
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
