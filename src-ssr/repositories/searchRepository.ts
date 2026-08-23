import { normalizeVietnamese } from '../lib/vietnamese';
import type { MovieRow } from '../types/movie';

export interface SearchPage {
  items: MovieRow[];
  total: number;
}

// bm25 weights, in fts_movie column order (title, original_title, alias).
// The alias column is slug-derived and therefore noisy -- it repeats the
// title's own words and adds episode/part suffixes -- so it must never
// outrank a real title match; it exists to make a title findable at all,
// not to rank it. original_title sits between the two: a genuine field,
// but a Vietnamese user searching Vietnamese text wants `title` first.
const BM25 = 'bm25(fts_movie, 10.0, 2.0, 3.0)';

const SELECT_PAGE = `SELECT m.* FROM fts_movie f JOIN movie m ON m.slug = f.slug
   WHERE fts_movie MATCH ? ORDER BY ${BM25} LIMIT ? OFFSET ?`;

const SELECT_COUNT = `SELECT COUNT(*) AS n FROM fts_movie f JOIN movie m ON m.slug = f.slug
   WHERE fts_movie MATCH ?`;

export class SearchRepository {
  constructor(private readonly db: D1Database) {}

  /** Only called when the movie's hash changed (same gating as
   * episode/recommendation/taxonomy writes) -- delete + insert, not an
   * UPDATE, because FTS5 has no natural unique key to upsert against.
   * `alias` is derived from the slug here rather than passed in, so the
   * sync pipeline (services/sync/syncMovie.ts) needs no change to keep the
   * alias column in step with migrations/0015_search_alias.sql's backfill. */
  async indexMovie(slug: string, title: string, originalTitle: string): Promise<void> {
    await this.db.batch([
      this.db.prepare('DELETE FROM fts_movie WHERE slug = ?').bind(slug),
      this.db
        .prepare('INSERT INTO fts_movie (title, original_title, alias, slug) VALUES (?, ?, ?, ?)')
        .bind(normalizeVietnamese(title), normalizeVietnamese(originalTitle), slugToSearchText(slug), slug),
    ]);
  }

  /** `fts_movie MATCH ?` -- the table's real name, NOT the `f` alias.
   * Verified directly against production D1 (2026-08-07): `f MATCH ?`
   * fails with "no such column: f" on this SQLite build: aliasing an FTS5
   * table doesn't carry over the special MATCH-target column the way
   * some FTS5 docs/examples imply.
   *
   * Runs buildTieredQueries' strategies in order and answers from the
   * first one that matches anything. Tier selection is a pure function of
   * the query text and the index, so paging through a result set stays on
   * one tier and cannot interleave two different strategies. */
  async search(query: string, limit: number, offset = 0): Promise<SearchPage> {
    for (const match of buildTieredQueries(query)) {
      const counted = await this.db.prepare(SELECT_COUNT).bind(match).first<{ n: number }>();
      const total = counted?.n ?? 0;
      if (total === 0) continue;
      const res = await this.db.prepare(SELECT_PAGE).bind(match, limit, offset).all<MovieRow>();
      return { items: res.results ?? [], total };
    }
    return { items: [], total: 0 };
  }
}

/** The slug is already normalized text (see migrations/0015_search_alias.sql)
 * -- hyphens are the only thing standing between it and a token stream. */
function slugToSearchText(slug: string): string {
  return slug.replace(/-/g, ' ');
}

/** Splits user input into FTS5-safe terms. Everything that isn't
 * alphanumeric is dropped before any query is built, so user input can
 * never inject FTS5 query operators (AND/OR/NOT/NEAR, parens, quotes,
 * `*`, `^`). */
export function parseTerms(raw: string): string[] {
  return normalizeVietnamese(raw)
    .replace(/[^a-z0-9\s]/gi, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8); // cap term count -- unbounded AND/OR-chains cost more to plan for no real benefit
}

/** Ordered search strategies, most precise first. Each is a complete FTS5
 * query; the caller uses the first that matches anything.
 *
 *  1. PHRASE -- terms adjacent and in order. Without this, diacritic
 *     folding makes "vợ tôi" and "vô tội" the same token pair, and bm25
 *     alone ranks the wrong one first (measured on production: "vo toi"
 *     returned "Tôi Vốn Vô Danh"/"Vô Gian Tội" above every real "Vợ Tôi …"
 *     title; the phrase query returns "Vợ Tôi 18 Tuổi"/"Bố Vợ Tôi Là
 *     Mafia"). Skipped for a single term, where it would mean "whole word
 *     only" and would shadow the prefix tier mid-typing.
 *  2. AND-prefix -- every term must appear, last one may be partial. This
 *     is the as-you-type tier.
 *  3. OR-prefix -- any term, ranked by bm25 (which already favours
 *     documents matching more of them). Without this a strictly *better*
 *     query returns strictly worse results: "sát thủ nội trợ vợ tôi"
 *     matches 4 of 6 words of the intended title and used to return zero
 *     rows, because tier 2 requires all six.
 */
export function buildTieredQueries(raw: string): string[] {
  const terms = parseTerms(raw);
  if (terms.length === 0) return [];
  if (terms.length === 1) return [`${terms[0]}*`];
  return [
    `"${terms.join(' ')}"`,
    terms.map((t) => `${t}*`).join(' '),
    terms.map((t) => `${t}*`).join(' OR '),
  ];
}
