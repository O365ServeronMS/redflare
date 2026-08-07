import { chunkByParams } from '../db/chunk';
import type { Cursor } from '../lib/cursor';
import type { Page } from './movieRepository';
import type { MovieRow, TaxonomyRef } from '../types/movie';

export class TaxonomyRepository {
  constructor(private readonly db: D1Database) {}

  /** Upserts genre/country display names and rewrites this movie's
   * membership rows. Cheap and idempotent; called every time a movie's hash
   * changes (genres/countries rarely change independent of everything
   * else, so no separate hash-gating here). */
  async syncMovieTaxonomy(
    slug: string,
    genres: readonly TaxonomyRef[],
    countries: readonly TaxonomyRef[]
  ): Promise<void> {
    const statements: D1PreparedStatement[] = [
      this.db.prepare('DELETE FROM genre_movie WHERE slug = ?').bind(slug),
      this.db.prepare('DELETE FROM country_movie WHERE slug = ?').bind(slug),
    ];
    for (const g of genres) {
      statements.push(
        this.db
          .prepare('INSERT INTO genre (slug, name) VALUES (?, ?) ON CONFLICT(slug) DO UPDATE SET name = excluded.name')
          .bind(g.slug, g.name),
        this.db
          .prepare('INSERT INTO genre_movie (genre_slug, slug) VALUES (?, ?) ON CONFLICT DO NOTHING')
          .bind(g.slug, slug)
      );
    }
    for (const c of countries) {
      statements.push(
        this.db
          .prepare('INSERT INTO country (slug, name) VALUES (?, ?) ON CONFLICT(slug) DO UPDATE SET name = excluded.name')
          .bind(c.slug, c.name),
        this.db
          .prepare('INSERT INTO country_movie (country_slug, slug) VALUES (?, ?) ON CONFLICT DO NOTHING')
          .bind(c.slug, slug)
      );
    }
    // Small, bounded statement count per movie (2 x taxonomy count + 2
    // deletes) -- no need to route through chunkByParams here, each
    // statement binds at most 2 params.
    await this.db.batch(statements);
  }

  async getGenre(slug: string): Promise<TaxonomyRef | null> {
    return this.db.prepare('SELECT slug, name FROM genre WHERE slug = ?').bind(slug).first<TaxonomyRef>();
  }

  async getCountry(slug: string): Promise<TaxonomyRef | null> {
    return this.db.prepare('SELECT slug, name FROM country WHERE slug = ?').bind(slug).first<TaxonomyRef>();
  }

  /** Same keyset reasoning as MovieRepository.getPageByType -- join to
   * movie for last_synced ordering, no OFFSET. */
  async getMoviesByGenre(genreSlug: string, cursor: Cursor | null, limit: number): Promise<Page<MovieRow>> {
    return this.pagedJoin('genre_movie', 'genre_slug', genreSlug, cursor, limit);
  }

  async getMoviesByCountry(countrySlug: string, cursor: Cursor | null, limit: number): Promise<Page<MovieRow>> {
    return this.pagedJoin('country_movie', 'country_slug', countrySlug, cursor, limit);
  }

  private async pagedJoin(
    joinTable: string,
    joinCol: string,
    value: string,
    cursor: Cursor | null,
    limit: number
  ): Promise<Page<MovieRow>> {
    const sql = cursor
      ? `SELECT m.* FROM ${joinTable} j JOIN movie m ON m.slug = j.slug
         WHERE j.${joinCol} = ? AND (m.last_synced < ? OR (m.last_synced = ? AND m.slug > ?))
         ORDER BY m.last_synced DESC, m.slug ASC LIMIT ?`
      : `SELECT m.* FROM ${joinTable} j JOIN movie m ON m.slug = j.slug
         WHERE j.${joinCol} = ? ORDER BY m.last_synced DESC, m.slug ASC LIMIT ?`;
    const binds = cursor ? [value, cursor.lastSynced, cursor.lastSynced, cursor.slug, limit + 1] : [value, limit + 1];
    const res = await this.db.prepare(sql).bind(...binds).all<MovieRow>();
    const rows = res.results ?? [];
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    const nextCursor = rows.length > limit && last ? { lastSynced: last.last_synced, slug: last.slug } : null;
    return { items, nextCursor };
  }

  // ---- Legacy /api/genre|country (docs/contract-legacy-api.md §3) ----
  // Same OFFSET exception as MovieRepository's *Offset methods -- clamped
  // to page <= 200 at the route layer.

  async getMoviesByGenreOffset(genreSlug: string, page: number, limit: number): Promise<MovieRow[]> {
    return this.pagedJoinOffset('genre_movie', 'genre_slug', genreSlug, page, limit);
  }

  async getMoviesByCountryOffset(countrySlug: string, page: number, limit: number): Promise<MovieRow[]> {
    return this.pagedJoinOffset('country_movie', 'country_slug', countrySlug, page, limit);
  }

  async countByGenre(genreSlug: string): Promise<number> {
    return this.countJoin('genre_movie', 'genre_slug', genreSlug);
  }

  async countByCountry(countrySlug: string): Promise<number> {
    return this.countJoin('country_movie', 'country_slug', countrySlug);
  }

  private async pagedJoinOffset(
    joinTable: string,
    joinCol: string,
    value: string,
    page: number,
    limit: number
  ): Promise<MovieRow[]> {
    const res = await this.db
      .prepare(
        `SELECT m.* FROM ${joinTable} j JOIN movie m ON m.slug = j.slug
         WHERE j.${joinCol} = ? ORDER BY m.last_synced DESC LIMIT ? OFFSET ?`
      )
      .bind(value, limit, (page - 1) * limit)
      .all<MovieRow>();
    return res.results ?? [];
  }

  private async countJoin(joinTable: string, joinCol: string, value: string): Promise<number> {
    const row = await this.db
      .prepare(`SELECT COUNT(*) as n FROM ${joinTable} WHERE ${joinCol} = ?`)
      .bind(value)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  async listGenres(): Promise<TaxonomyRef[]> {
    const res = await this.db.prepare('SELECT slug, name FROM genre ORDER BY name').all<TaxonomyRef>();
    return res.results ?? [];
  }

  async listCountries(): Promise<TaxonomyRef[]> {
    const res = await this.db.prepare('SELECT slug, name FROM country ORDER BY name').all<TaxonomyRef>();
    return res.results ?? [];
  }

  /** Batch existence check, e.g. for validating a `/the-loai/:slug` route
   * param before querying genre_movie. */
  async getGenresBySlugs(slugs: readonly string[]): Promise<Map<string, TaxonomyRef>> {
    if (slugs.length === 0) return new Map();
    const out = new Map<string, TaxonomyRef>();
    for (const chunk of chunkByParams(slugs, 1)) {
      const placeholders = chunk.map(() => '?').join(',');
      const res = await this.db
        .prepare(`SELECT slug, name FROM genre WHERE slug IN (${placeholders})`)
        .bind(...chunk)
        .all<TaxonomyRef>();
      for (const row of res.results ?? []) out.set(row.slug, row);
    }
    return out;
  }
}
