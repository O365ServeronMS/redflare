import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeMovie } from '../src-ssr/services/sync/normalize.ts';
import { RateLimiter } from '../src-ssr/services/sync/throttle.ts';
import { TmdbClient } from '../src-ssr/services/sync/tmdbClient.ts';

function kkSeason(season, thumbUrl = `https://phimimg.com/season-${season}.jpg`) {
  return {
    status: true,
    movie: {
      tmdb: { id: '94997', type: 'tv', season },
      imdb: null,
      modified: { time: '2026-08-10T00:00:00Z' },
      slug: `series-season-${season}`,
      name: 'Series',
      origin_name: 'Series',
      content: '',
      type: 'series',
      status: 'ongoing',
      thumb_url: thumbUrl,
      poster_url: `https://phimimg.com/season-${season}-backdrop.jpg`,
      trailer_url: null,
      time: '',
      episode_current: '',
      quality: 'HD',
      lang: 'Vietsub',
      year: 2026,
      category: [],
      country: [],
    },
    episodes: [],
  };
}

const seriesDetail = {
  name: 'Series',
  backdrop_path: '/series-backdrop.jpg',
  poster_path: '/series-poster.jpg',
};

test('uses the source-specific poster for each TV season', () => {
  const seasonOne = normalizeMovie(kkSeason(1), seriesDetail, { poster_path: '/season-1.jpg' }, []);
  const seasonTwo = normalizeMovie(kkSeason(2), seriesDetail, { poster_path: '/season-2.jpg' }, []);

  assert.equal(seasonOne.thumbPath, 'https://phimimg.com/season-1.jpg');
  assert.equal(seasonTwo.thumbPath, 'https://phimimg.com/season-2.jpg');
  assert.notEqual(seasonOne.thumbPath, seasonTwo.thumbPath);
  assert.equal(seasonOne.posterPath, 'https://image.tmdb.org/t/p/w1280/series-backdrop.jpg');
});

test('uses a TMDB season poster when the source has none', () => {
  const movie = normalizeMovie(kkSeason(2, ''), seriesDetail, { poster_path: '/season-2.jpg' }, []);
  assert.equal(movie.thumbPath, 'https://image.tmdb.org/t/p/w500/season-2.jpg');
});

test('falls back to the season-specific KKPhim poster before the shared series poster', () => {
  const movie = normalizeMovie(kkSeason(2), seriesDetail, null, []);
  assert.equal(movie.thumbPath, 'https://phimimg.com/season-2.jpg');
});

test('requests the TMDB season details endpoint', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  let requestedUrl = '';
  globalThis.fetch = async (url) => {
    requestedUrl = String(url);
    return new Response(JSON.stringify({ poster_path: '/season-2.jpg' }), { status: 200 });
  };

  const client = new TmdbClient('test-token', new RateLimiter(100_000));
  const result = await client.getSeasonDetail(94997, 2);

  assert.equal(requestedUrl, 'https://api.themoviedb.org/3/tv/94997/season/2?language=vi-VN');
  assert.deepEqual(result, { poster_path: '/season-2.jpg' });
});
