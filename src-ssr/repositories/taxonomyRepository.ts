import { chunkByParams } from '../db/chunk';
import type { TaxonomyRef } from '../types/movie';

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
