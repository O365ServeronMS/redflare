import { chunkByParams } from '../db/chunk';
import type { EpisodeRecord } from '../types/movie';

const EPISODE_COLUMNS = 7;

export class EpisodeRepository {
  constructor(private readonly db: D1Database) {}

  async getBySlug(slug: string): Promise<EpisodeRecord[]> {
    const res = await this.db
      .prepare('SELECT * FROM episode WHERE slug = ? ORDER BY sort_order')
      .bind(slug)
      .all<{
        server: string;
        ep_slug: string;
        ep_name: string;
        sort_order: number;
        link_m3u8: string | null;
        link_embed: string | null;
      }>();
    return (res.results ?? []).map((r) => ({
      server: r.server,
      epSlug: r.ep_slug,
      epName: r.ep_name,
      sortOrder: r.sort_order,
      linkM3u8: r.link_m3u8,
      linkEmbed: r.link_embed,
    }));
  }

  /** Only called by syncMovie when the movie's source_hash changed --
   * source_hash covers the episode list too, so this replace is already
   * gated at the "did anything about this movie change" level (ADR-0002
   * Finding 2's "version instead of delete-then-insert" guidance). Delete +
   * insert is still cheap here because it only runs on an actual change,
   * never on every sync tick. */
  async replaceForSlug(slug: string, episodes: readonly EpisodeRecord[]): Promise<void> {
    const statements: D1PreparedStatement[] = [
      this.db.prepare('DELETE FROM episode WHERE slug = ?').bind(slug),
    ];
    if (episodes.length > 0) {
      const insertSql = `INSERT INTO episode (slug, server, ep_slug, ep_name, sort_order, link_m3u8, link_embed) VALUES ${'(' + Array(EPISODE_COLUMNS).fill('?').join(',') + ')'}`;
      for (const chunk of chunkByParams(episodes, EPISODE_COLUMNS)) {
        const stmt = this.db.prepare(insertSql);
        for (const ep of chunk) {
          statements.push(
            stmt.bind(slug, ep.server, ep.epSlug, ep.epName, ep.sortOrder, ep.linkM3u8, ep.linkEmbed)
          );
        }
      }
    }
    await this.db.batch(statements);
  }
}
