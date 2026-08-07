import { normalizeVietnamese } from '../lib/vietnamese';
import type { MovieRow } from '../types/movie';

export class SearchRepository {
  constructor(private readonly db: D1Database) {}

  /** Only called when the movie's hash changed (same gating as
   * episode/recommendation/taxonomy writes) -- delete + insert, not an
   * UPDATE, because FTS5 has no natural unique key to upsert against. */
  async indexMovie(slug: string, title: string, originalTitle: string): Promise<void> {
    await this.db.batch([
      this.db.prepare('DELETE FROM fts_movie WHERE slug = ?').bind(slug),
      this.db
        .prepare('INSERT INTO fts_movie (title, original_title, slug) VALUES (?, ?, ?)')
        .bind(normalizeVietnamese(title), normalizeVietnamese(originalTitle), slug),
    ]);
  }

  /** `fts_movie MATCH ?` -- the table's real name, NOT the `f` alias.
   * Verified directly against production D1 (2026-08-07): `f MATCH ?`
   * fails with "no such column: f" on this SQLite build: aliasing an FTS5
   * table doesn't carry over the special MATCH-target column the way
   * some FTS5 docs/examples imply. `rank` is FTS5's built-in relevance
   * column, usable in ORDER BY only alongside a MATCH. */
  async search(query: string, limit: number): Promise<MovieRow[]> {
    const matchQuery = buildMatchQuery(query);
    if (!matchQuery) return [];
    const res = await this.db
      .prepare(
        `SELECT m.* FROM fts_movie f JOIN movie m ON m.slug = f.slug
         WHERE fts_movie MATCH ? ORDER BY rank LIMIT ?`
      )
      .bind(matchQuery, limit)
      .all<MovieRow>();
    return res.results ?? [];
  }
}

// Prefix-matches every word, ANDed together -- "gia toc" -> `gia* toc*`.
// FTS5 query syntax treats bare tokens as an implicit AND, and `*` as a
// prefix wildcard. Strips anything that isn't alphanumeric-ish before
// building the query so user input can't inject FTS5 query operators
// (AND/OR/NOT/NEAR, parens, quotes).
function buildMatchQuery(raw: string): string | null {
  const words = normalizeVietnamese(raw)
    .replace(/[^a-z0-9\s]/gi, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8); // cap term count -- unbounded AND-chains cost more to plan for no real benefit
  if (words.length === 0) return null;
  return words.map((w) => `${w}*`).join(' ');
}
