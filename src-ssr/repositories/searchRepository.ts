import { normalizeVietnamese } from '../lib/vietnamese';
import type { MovieRow } from '../types/movie';

// The UI caps search at 2 pages (48 results) -- past that a searcher is
// better served refining the query than paging further. Capping the fetch
// itself, not just the display, means `search()` needs no COUNT(*): the
// single LIMIT MAX_RESULTS read tells us both the page contents and
// whether a second page exists (results.length > SEARCH_LIMIT).
export const SEARCH_LIMIT = 24;
export const SEARCH_MAX_PAGES = 2;
const MAX_RESULTS = SEARCH_LIMIT * SEARCH_MAX_PAGES;

// bm25 weights, in fts_movie column order (title, original_title, alias).
// The alias column is slug-derived and therefore noisy -- it repeats the
// title's own words and adds episode/part suffixes -- so it must never
// outrank a real title match; it exists to make a title findable at all,
// not to rank it. original_title sits between the two: a genuine field,
// but a Vietnamese user searching Vietnamese text wants `title` first.
const BM25 = 'bm25(fts_movie, 10.0, 2.0, 3.0)';

const SELECT_TOP = `SELECT m.* FROM fts_movie f JOIN movie m ON m.slug = f.slug
   WHERE fts_movie MATCH ? ORDER BY ${BM25} LIMIT ?`;

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
   * first one that matches anything, capped at MAX_RESULTS total (the
   * caller slices this into pages -- see SEARCH_MAX_PAGES above). Tier
   * selection is a pure function of the query text and the index, so a
   * fixed-size top-N fetch cannot straddle two different strategies the
   * way a separate COUNT-then-OFFSET-page pair could (an offset landing
   * past a tier's row count used to silently fall through to the next
   * tier mid-pagination). */
  async search(query: string): Promise<MovieRow[]> {
    for (const match of buildTieredQueries(query)) {
      const res = await this.db.prepare(SELECT_TOP).bind(match, MAX_RESULTS).all<MovieRow>();
      const rows = res.results ?? [];
      if (rows.length === 0) continue;
      return rerankExactMatches(query, rows);
    }
    return [];
  }
}

/** bm25 folds diacritics along with everything else, so it cannot tell
 * "Vợ Tôi" from "Vô Tội" apart -- measured on production, "vợ tôi"
 * returned "Người vô tội"/"Suy Đoán Vô Tội" ranked above every real "Vợ
 * Tôi …" title. This re-ranks the (already tier-selected, already
 * bm25-ordered) rows by how faithfully each title matches what the user
 * actually typed, diacritics included. Stable within a score band: ties
 * keep bm25's relative order rather than being re-sorted again. */
function rerankExactMatches(query: string, rows: MovieRow[]): MovieRow[] {
  const raw = query.trim().toLowerCase();
  const folded = normalizeVietnamese(raw);
  if (!raw) return rows;
  return rows
    .map((row, index) => ({ row, index, score: matchScore(row, raw, folded) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.row);
}

// 3: the title itself contains the query verbatim, diacritics and all --
//    as exact a match as this catalog's data can express.
// 2: only true once diacritics are stripped from both sides -- still a
//    real title match, just not one the user's own spelling pinned down.
// 1: the query only shows up in the slug-derived alias (see
//    migrations/0015_search_alias.sql) -- found the right row, but not by
//    matching anything a person would call the title.
// 0: matched some other way (a different tier's OR-of-terms, etc).
function matchScore(row: MovieRow, raw: string, folded: string): number {
  if (row.title.toLowerCase().includes(raw)) return 3;
  if (normalizeVietnamese(row.title).includes(folded)) return 2;
  if (row.slug.replace(/-/g, ' ').includes(folded)) return 1;
  return 0;
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
