/** Cached pagination totals (migrations/0013_query_optimization.sql), read
 * on the /api/list|genre|country hot path instead of running a COUNT(*)
 * against `movie`/`genre_movie`/`country_movie` on every cache miss
 * (docs/state-free-plan-migration.md Phase 7 measured `movie.tier` COUNTs
 * as a full table scan -- no index covers it -- and genre/country COUNTs
 * as costing rows read proportional to category size even with an index).
 * Self-healing: a miss (e.g. right after this table was introduced, or a
 * kind/key never seen before) falls back to the real COUNT query and
 * writes the result back, so correctness never depends on refresh() having
 * run first. */
export class CatalogStatsRepository {
  constructor(private readonly db: D1Database) {}

  async getTierCount(tier: string, fallback: () => Promise<number>): Promise<number> {
    return this.getOrHeal('tier', tier, fallback);
  }

  async getTypeCount(type: string, fallback: () => Promise<number>): Promise<number> {
    return this.getOrHeal('type', type, fallback);
  }

  async getGenreCount(slug: string, fallback: () => Promise<number>): Promise<number> {
    return this.getOrHeal('genre', slug, fallback);
  }

  async getCountryCount(slug: string, fallback: () => Promise<number>): Promise<number> {
    return this.getOrHeal('country', slug, fallback);
  }

  private async getOrHeal(kind: string, key: string, fallback: () => Promise<number>): Promise<number> {
    const row = await this.db
      .prepare('SELECT count FROM catalog_stats WHERE kind = ? AND key = ?')
      .bind(kind, key)
      .first<{ count: number }>();
    if (row) return row.count;
    const counted = await fallback();
    await this.db
      .prepare(
        'INSERT INTO catalog_stats (kind, key, count) VALUES (?, ?, ?) ON CONFLICT(kind, key) DO UPDATE SET count = excluded.count'
      )
      .bind(kind, key, counted)
      .run();
    return counted;
  }

  /** Full recompute of every tracked count in one pass, replacing
   * catalog_stats wholesale. Matches the exact semantics of the COUNT
   * queries it replaces: 'type' is now tier-filtered (movie.type = ? AND
   * tier = 'catalog') to match MovieRepository.getPageByTypeOffset/
   * countByType, which exclude stub rows from /api/list's rail and
   * pagination total (a stub has no stream, nothing to watch); 'tier' is
   * movie.tier = 'catalog'; 'genre'/'country' mirror
   * TaxonomyRepository.countByGenre/countByCountry (still tier-agnostic --
   * out of scope for this fix). Called only when the underlying counts
   * could actually have changed (IncrementalSyncWorkflow after a tick that
   * wrote rows, RecommendationResolveWorkflow after a tick that created a
   * stub) -- never on a fixed schedule, since steady-state ticks write
   * nothing. */
  async refresh(): Promise<void> {
    const [tierRow, typeRes, genreRes, countryRes] = await Promise.all([
      this.db.prepare("SELECT COUNT(*) AS n FROM movie WHERE tier = 'catalog'").first<{ n: number }>(),
      this.db.prepare("SELECT type, COUNT(*) AS n FROM movie WHERE tier = 'catalog' GROUP BY type").all<{ type: string; n: number }>(),
      this.db.prepare('SELECT genre_slug, COUNT(*) AS n FROM genre_movie GROUP BY genre_slug').all<{ genre_slug: string; n: number }>(),
      this.db.prepare('SELECT country_slug, COUNT(*) AS n FROM country_movie GROUP BY country_slug').all<{ country_slug: string; n: number }>(),
    ]);

    const rows: { kind: string; key: string; count: number }[] = [
      { kind: 'tier', key: 'catalog', count: tierRow?.n ?? 0 },
      ...(typeRes.results ?? []).map((r) => ({ kind: 'type', key: r.type, count: r.n })),
      ...(genreRes.results ?? []).map((r) => ({ kind: 'genre', key: r.genre_slug, count: r.n })),
      ...(countryRes.results ?? []).map((r) => ({ kind: 'country', key: r.country_slug, count: r.n })),
    ];

    await this.db.batch([
      this.db.prepare("DELETE FROM catalog_stats WHERE kind IN ('tier', 'type', 'genre', 'country')"),
      ...rows.map((r) =>
        this.db.prepare('INSERT INTO catalog_stats (kind, key, count) VALUES (?, ?, ?)').bind(r.kind, r.key, r.count)
      ),
    ]);
  }
}
