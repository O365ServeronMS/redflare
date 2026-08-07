// /danh-sach/:type URL slug -> movie.type value stored in D1 -- same
// mapping the old SPA used (CLAUDE.md "Field ownership" table, Footer.js
// nav links), kept identical so existing inbound links/SEO don't break.
export const LIST_TYPE_LABELS: Record<string, { value: string; label: string }> = {
  'phim-le': { value: 'single', label: 'Phim Lẻ' },
  'phim-bo': { value: 'series', label: 'Phim Bộ' },
  'hoat-hinh': { value: 'hoathinh', label: 'Hoạt Hình' },
  'tv-shows': { value: 'tvshows', label: 'TV Shows' },
};
