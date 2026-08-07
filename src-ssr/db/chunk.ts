// D1's bound-parameter cap is undocumented on the limits page and cost the
// previous migration real debugging time (CLAUDE.md: "D1's undocumented
// 100-bound-param-per-query cap silently rejecting large batch inserts").
// This time it's a constant every batch write goes through, not a fact
// someone has to remember.
export const D1_MAX_PARAMS = 100;

/** Split `rows` into chunks that each fit within D1_MAX_PARAMS when a
 * statement binds `paramsPerRow` params per row. Never returns a chunk
 * whose row count would produce more than D1_MAX_PARAMS total bindings. */
export function chunkByParams<T>(rows: readonly T[], paramsPerRow: number): T[][] {
  if (paramsPerRow <= 0) throw new Error('paramsPerRow must be > 0');
  const perChunk = Math.max(1, Math.floor(D1_MAX_PARAMS / paramsPerRow));
  const chunks: T[][] = [];
  for (let i = 0; i < rows.length; i += perChunk) {
    chunks.push(rows.slice(i, i + perChunk));
  }
  return chunks;
}
