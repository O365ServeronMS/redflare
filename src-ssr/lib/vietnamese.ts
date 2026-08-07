// FTS5's unicode61 tokenizer with remove_diacritics=2 strips combining-mark
// accents (the tone marks on â/ê/ơ/etc.) but NOT đ -- that's its own
// Unicode codepoint, not a base letter plus a combining stroke, so it
// survives untouched. Left alone, "dien vien" would never match "diễn
// viên" even with remove_diacritics on. Both index-time writes
// (services/sync/syncMovie.ts) and query-time parsing (repositories/searchRepository.ts)
// must go through this so they land in the same normalized space.
const COMBINING_MARKS = /[̀-ͯ]/g;

export function normalizeVietnamese(input: string): string {
  return input
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .replace(/đ/g, 'd') // đ
    .replace(/Đ/g, 'D') // Đ
    .toLowerCase();
}
