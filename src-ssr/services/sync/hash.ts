import type { NormalizedMovie } from '../../types/movie';

// FNV-1a, 32-bit. Not cryptographic -- this is a change-detection fingerprint
// to skip no-op D1 writes (ADR-0002 Finding 2), not a security boundary.
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Hashes exactly the fields that would change what gets written to D1 --
 * excludes nothing that matters, includes nothing volatile (no fetch
 * timestamps). Field order is fixed so the same logical content always
 * hashes the same way. */
export function hashMovie(m: NormalizedMovie): string {
  const parts = [
    m.title,
    m.originalTitle,
    m.overview,
    m.posterPath,
    m.thumbPath ?? '',
    m.posterHost,
    String(m.releaseYear ?? ''),
    m.runtime,
    String(m.voteAverage ?? ''),
    String(m.voteCount ?? ''),
    m.status,
    m.episodeCurrent,
    m.quality,
    m.lang,
    m.type,
    m.genres.map((g) => g.slug).join(','),
    m.countries.map((c) => c.slug).join(','),
    m.hasStream ? '1' : '0',
    String(m.streamCount),
    m.youtubeTrailerKey ?? '',
    m.tier,
    m.episodes.map((e) => `${e.server}:${e.epSlug}:${e.linkM3u8 ?? ''}:${e.linkEmbed ?? ''}`).join('|'),
    m.recommendationTargets.map((t) => `${t.tmdbType}:${t.tmdbId}`).join(','),
    m.actors.join(','),
    // popularity is deliberately NOT hashed (plan-restore-spa-frontend.md
    // F3) -- it's a TMDB float that drifts daily independent of anything
    // else about the title. Hashing it would force a rewrite of the whole
    // catalog on every sync tick and blow the D1 write quota (ADR-0002
    // Finding 2); it "rides along" on whatever change actually triggers a
    // rewrite instead.
  ];
  return fnv1a(parts.join(''));
}
