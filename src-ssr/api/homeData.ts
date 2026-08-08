import { MovieRepository } from '../repositories/movieRepository';
import { HeroSnapshotRepository } from '../repositories/heroSnapshotRepository';
import { toLegacyItems, type LegacyItem } from './legacyItem';

const NEW_MOVIES_COUNT = 24;
const RAIL_COUNT = 12;
const TRENDING_COUNT = 12;

// docs/contract-legacy-api.md §1. Shape is INTENTIONALLY asymmetric:
// heroMovies is a bare array, the four rails are {items}. main.js's
// renderHomePage reads each key exactly this way -- newMovies.items goes
// straight into renderCarousel WITHOUT the client's normalizeListItem, so
// every rail must already be a full legacy item (toLegacyItems guarantees
// that).
export interface HomeData {
  newMovies: { items: LegacyItem[] };
  phimLe: { items: LegacyItem[] };
  phimBo: { items: LegacyItem[] };
  trending: { items: LegacyItem[] };
  heroMovies: LegacyItem[];
}

/** Built per request from D1 (no runtime KKPhim/TMDB call, ADR-0002
 * Principle 3). The old architecture pre-built this into KV via an hourly
 * cron; here it's cheap enough to read from D1 on demand and let Workers
 * Caching (max-age=60) absorb the load. Five small indexed reads. */
export async function buildHomeData(db: D1Database): Promise<HomeData> {
  const repo = new MovieRepository(db);
  const heroSnapshot = new HeroSnapshotRepository(db);
  const [newMovies, phimLe, phimBo, trending, hero] = await Promise.all([
    repo.getRecentMovies(NEW_MOVIES_COUNT),
    repo.getPageByTypeOffset('single', 1, RAIL_COUNT),
    repo.getPageByTypeOffset('series', 1, RAIL_COUNT),
    repo.getTrending(TRENDING_COUNT),
    heroSnapshot.getRankedMovies(),
  ]);

  return {
    newMovies: { items: toLegacyItems(newMovies) },
    phimLe: { items: toLegacyItems(phimLe) },
    phimBo: { items: toLegacyItems(phimBo) },
    trending: { items: toLegacyItems(trending) },
    heroMovies: toLegacyItems(hero),
  };
}
