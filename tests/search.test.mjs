import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { afterEach, test } from 'node:test';
import { Miniflare } from 'miniflare';
import { SearchRepository, buildTieredQueries, parseTerms } from '../src-ssr/repositories/searchRepository.ts';

// Every case here is a query that was reproduced failing against
// production before migrations/0015_search_alias.sql + the tiered query
// strategy landed.
const instances = [];
afterEach(async () => Promise.all(instances.splice(0).map((mf) => mf.dispose())));

async function setup() {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok"); } };',
    d1Databases: { DB: crypto.randomUUID() },
  });
  instances.push(mf);
  const db = await mf.getD1Database('DB');
  for (const name of ['0005_ssr_schema.sql', '0007_fts_search.sql', '0009_actor_popularity.sql', '0014_upstream_modified.sql', '0015_search_alias.sql']) {
    const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
    const statements = sql
      .replaceAll(/--.*$/gm, '')
      .split(';')
      .map((statement) => statement.trim())
      .filter(Boolean)
      .map((statement) => db.prepare(statement));
    await db.batch(statements);
  }
  return { db, search: new SearchRepository(db) };
}

/** Mirrors what services/sync/syncMovie.ts writes: the movie row carries
 * the TMDB-merged display title, the FTS row is built from it. */
async function seed(db, search, slug, title, originalTitle = '') {
  await db.prepare(`INSERT INTO movie (
    slug, tmdb_id, tmdb_type, tmdb_season, title, original_title, overview,
    poster_path, thumb_path, poster_host, release_year, runtime, vote_average,
    vote_count, status, episode_current, quality, lang, type, genres_json,
    countries_json, has_stream, stream_count, youtube_trailer_key, tier,
    source_hash, last_synced, actor_json, popularity, upstream_modified
  ) VALUES (?, NULL, NULL, NULL, ?, ?, '', '', '', 'tmdb', 2026, '', 0, 0, '', '', '', '', 'single', '[]', '[]', 1, 1, NULL, 'catalog', ?, 100, '[]', NULL, 100)`)
    .bind(slug, title, originalTitle, slug)
    .run();
  await search.indexMovie(slug, title, originalTitle);
}

test('finds a title by the Vietnamese alias that only survives in its slug', async () => {
  const { db, search } = await setup();
  // Production row: KKPhim name "Sát Thủ Nội Trợ (Vợ Tôi Là Sát Thủ)",
  // but normalize.ts keeps only TMDB's "Sát Thủ Nội Trợ".
  await seed(db, search, 'sat-thu-noi-tro-vo-toi-la-sat-thu', 'Sát Thủ Nội Trợ', 'A Bona Fide Killer');
  await seed(db, search, 'sat-thu-anna', 'Sát Thủ Anna', 'Anna');

  for (const query of ['Vợ tôi là sát thủ', 'vo toi la sat thu']) {
    const { items } = await search.search(query, 24);
    assert.equal(items[0]?.slug, 'sat-thu-noi-tro-vo-toi-la-sat-thu', `query: ${query}`);
  }

  // The paths that already worked must keep working.
  for (const query of ['sat thu noi tro', 'A Bona Fide Killer']) {
    const { items } = await search.search(query, 24);
    assert.equal(items[0]?.slug, 'sat-thu-noi-tro-vo-toi-la-sat-thu', `query: ${query}`);
  }
});

test('finds a Vietnamese name when TMDB replaced the title with a foreign one', async () => {
  const { db, search } = await setup();
  // Production row: display title is "Clevatess", so the Vietnamese name
  // exists only in the slug -- "vua ma thu" used to return zero rows.
  await seed(db, search, 'vua-ma-thu-dua-tre-dinh-menh-va-anh-hung-bat-tu-phan-2', 'Clevatess', 'Clevatess');

  const { items } = await search.search('vua ma thu', 24);
  assert.equal(items[0]?.slug, 'vua-ma-thu-dua-tre-dinh-menh-va-anh-hung-bat-tu-phan-2');

  // Searching the foreign title still works -- alias must not displace it.
  const byTitle = await search.search('clevatess', 24);
  assert.equal(byTitle.items[0]?.slug, 'vua-ma-thu-dua-tre-dinh-menh-va-anh-hung-bat-tu-phan-2');
});

test('a query with extra terms still finds the title (OR fallback, not all-or-nothing AND)', async () => {
  const { db, search } = await setup();
  await seed(db, search, 'sat-thu-noi-tro-vo-toi-la-sat-thu', 'Sát Thủ Nội Trợ', 'A Bona Fide Killer');

  // Adding more *correct* words used to make the search strictly worse:
  // tier 2 requires every term, and "vợ"/"tôi" aren't in the title.
  const { items } = await search.search('sát thủ nội trợ vợ tôi', 24);
  assert.equal(items[0]?.slug, 'sat-thu-noi-tro-vo-toi-la-sat-thu');

  // Same shape, with a stray token the catalog has never seen.
  const withNoise = await search.search('vo toi la sat thu hd', 24);
  assert.equal(withNoise.items[0]?.slug, 'sat-thu-noi-tro-vo-toi-la-sat-thu');
});

test('phrase tier drops non-adjacent term collisions from a multi-word query', async () => {
  const { db, search } = await setup();
  await seed(db, search, 'toi-von-vo-danh', 'Tôi Vốn Vô Danh');
  await seed(db, search, 'vong-tron-toi-loi', 'Vòng Tròn Tội Lỗi');
  await seed(db, search, 'vo-gian-toi', 'Vô Gian Tội');
  await seed(db, search, 'nguoi-vo-toi', 'Người vô tội');
  await seed(db, search, 'vo-toi-18-tuoi', 'Vợ Tôi 18 Tuổi');
  await seed(db, search, 'bo-vo-toi-la-mafia', 'Bố Vợ Tôi Là Mafia');

  const ranked = (await search.search('vợ tôi', 24)).items.map((m) => m.slug);

  // These were the actual top hits on production for this query: the terms
  // appear, but never adjacent. The phrase tier excludes them outright.
  for (const noise of ['toi-von-vo-danh', 'vong-tron-toi-loi', 'vo-gian-toi']) {
    assert.ok(!ranked.includes(noise), `expected ${noise} to be excluded, got ${ranked.join(', ')}`);
  }
  for (const wanted of ['vo-toi-18-tuoi', 'bo-vo-toi-la-mafia']) {
    assert.ok(ranked.includes(wanted), `expected ${wanted} in results, got ${ranked.join(', ')}`);
  }
  // Documented limit, not a bug: diacritics are folded at index time, so
  // "Người vô tội" carries the adjacent pair "vo toi" too and no
  // adjacency rule can separate it from "Vợ Tôi". Ranking it out would
  // need a second, diacritics-preserving column -- deliberately not built.
  assert.ok(ranked.includes('nguoi-vo-toi'));
});

test('paginates over the full result set instead of capping at one page', async () => {
  const { db, search } = await setup();
  for (let i = 1; i <= 30; i++) {
    await seed(db, search, `sat-thu-${i}`, `Sát Thủ ${i}`);
  }

  const first = await search.search('sat thu', 24, 0);
  assert.equal(first.total, 30);
  assert.equal(first.items.length, 24);

  const second = await search.search('sat thu', 24, 24);
  assert.equal(second.total, 30);
  assert.equal(second.items.length, 6);

  // No row may appear on both pages.
  const overlap = new Set(first.items.map((m) => m.slug));
  assert.ok(second.items.every((m) => !overlap.has(m.slug)));
});

test('FTS5 operators in user input are inert, not injected', async () => {
  const { db, search } = await setup();
  await seed(db, search, 'sat-thu-anna', 'Sát Thủ Anna');
  await seed(db, search, 'nguoi-vo-toi', 'Người vô tội');

  // Each of these would be a syntax error or a semantic injection if the
  // raw text reached FTS5. They must simply resolve to their word tokens.
  for (const query of ['sat NEAR/2 thu', 'sat OR thu', '"sat thu"', 'sat* thu^', 'sat AND (thu)', '((((']) {
    await assert.doesNotReject(() => search.search(query, 24), `query: ${query}`);
  }

  assert.deepEqual(parseTerms('sat AND (thu)'), ['sat', 'and', 'thu']);
  assert.deepEqual(parseTerms('   '), []);
  assert.deepEqual(buildTieredQueries(''), []);
  assert.deepEqual(buildTieredQueries('sat'), ['sat*']);
  assert.deepEqual(buildTieredQueries('sat thu'), ['"sat thu"', 'sat* thu*', 'sat* OR thu*']);
});
