import { Hono, type Context } from 'hono';
import { MovieRepository } from '../repositories/movieRepository';
import { EpisodeRepository } from '../repositories/episodeRepository';
import { RecommendationRepository } from '../repositories/recommendationRepository';
import { TaxonomyRepository } from '../repositories/taxonomyRepository';
import { SearchRepository, SEARCH_LIMIT, SEARCH_MAX_PAGES } from '../repositories/searchRepository';
import { CatalogStatsRepository } from '../repositories/catalogStatsRepository';
import { SyncStateRepository } from '../repositories/syncStateRepository';
import { INCREMENTAL_STALE_SECONDS, HERO_STALE_SECONDS } from '../services/sync/dispatch';
import { toLegacyItems, toLegacyDetail, toLegacyEpisodes } from './legacyItem';
import { buildHomeData } from './homeData';
import { clampPage, buildPagination } from './pagination';
import { isValidSlug } from '../middleware/validate';
import { LIST_TYPE_LABELS } from '../lib/listTypes';
import { applyPageCache, applyNoStore } from '../cache/control';

export const apiRoute = new Hono<{ Bindings: Env }>();

const PAGE_SIZE = 24;
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

// POST /api/search (docs/contract-legacy-api.md §5). Kept `no-store`: the
// response is keyed by free-text user input, so caching it buys little and
// stores what someone typed. (The original reason in this comment -- that
// each Turnstile token is single-use -- stopped applying when the Turnstile
// gate was removed in f76fa71; the no-store decision was re-affirmed on its
// own merits rather than left resting on a retired one.)
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
  // Capped at SEARCH_MAX_PAGES (2): a searcher is better served refining
  // the query than paging deep into it, and SearchRepository.search only
  // ever fetches that many pages' worth of rows in the first place.
  const page = clampPage(typeof pageValue === 'string' ? pageValue : undefined, SEARCH_MAX_PAGES);
  if (!keyword || keyword.length > MAX_KEYWORD_LENGTH) {
    applyNoStore(c);
    return c.json({ data: { items: [], params: { pagination: buildPagination(0, SEARCH_LIMIT, 1) } } });
  }

  const allResults = await new SearchRepository(c.env.DB).search(keyword);
  const items = allResults.slice((page - 1) * SEARCH_LIMIT, page * SEARCH_LIMIT);

  applyNoStore(c);
  return c.json({
    data: {
      items: toLegacyItems(items),
      params: { pagination: buildPagination(allResults.length, SEARCH_LIMIT, page) },
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

// GET /api/health/sync (docs/plan-incremental-sync-stall.md Phase 4).
// Public liveness probe for a free external monitor: 200 while both the
// incremental sync and the hero snapshot are fresh, 503 once either goes
// stale (or has never run). Two point reads of sync_state; no cursor,
// slug, or other internal state in the body. always no-store.
apiRoute.get('/api/health/sync', async (c) => {
  const syncState = new SyncStateRepository(c.env.DB);
  const [recentRaw, heroRaw] = await Promise.all([
    syncState.get('recent:last_run'),
    syncState.get('hero:last_success_at'),
  ]);

  const nowSeconds = Math.floor(Date.now() / 1000);
  const recordedAtMs = parseRecordedAtMs(recentRaw);
  const incrementalAgeSeconds = recordedAtMs === null
    ? null
    : Math.max(0, nowSeconds - Math.floor(recordedAtMs / 1000));
  const heroSuccessAt = heroRaw === null ? Number.NaN : Number(heroRaw);
  const heroAgeSeconds = Number.isFinite(heroSuccessAt)
    ? Math.max(0, nowSeconds - heroSuccessAt)
    : null;

  const ok =
    incrementalAgeSeconds !== null && incrementalAgeSeconds <= INCREMENTAL_STALE_SECONDS
    && heroAgeSeconds !== null && heroAgeSeconds <= HERO_STALE_SECONDS;

  applyNoStore(c);
  return c.json({ ok, incrementalAgeSeconds, heroAgeSeconds }, ok ? 200 : 503);
});

/** epoch ms of the last incremental-sync summary's `recordedAt`, or null
 * if the key is missing/unparseable. */
function parseRecordedAtMs(raw: string | null): number | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    const recordedAt = parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>).recordedAt
      : null;
    const ms = typeof recordedAt === 'string' ? Date.parse(recordedAt) : Number.NaN;
    return Number.isNaN(ms) ? null : ms;
  } catch {
    return null;
  }
}

// Never intended for a browser to hit, but keeps /api/* from ever falling
// through to the notFound handler with cacheable headers if someone
// requests an unknown /api/ path.
apiRoute.notFound((c) => {
  applyNoStore(c);
  return c.text('Not found', 404);
});
