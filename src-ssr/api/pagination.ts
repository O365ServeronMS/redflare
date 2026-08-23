// docs/contract-legacy-api.md §2c: Grid.js prefers totalItems/totalItemsPerPage
// over totalPages when both are present, so always send all three.
export interface LegacyPagination {
  totalItems: number;
  totalItemsPerPage: number;
  currentPage: number;
  totalPages: number;
}

// Clamps ?page= to [1, MAX_PAGE] -- the bound that makes OFFSET pagination
// safe against the D1 rows-read quota (docs/plan-restore-spa-frontend.md
// §Phase F2: worst case MAX_PAGE x PAGE_SIZE rows scanned per request).
export const MAX_PAGE = 200;

export function clampPage(raw: string | undefined, maxPage: number = MAX_PAGE): number {
  const n = Number.parseInt(raw ?? '1', 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, maxPage);
}

export function buildPagination(totalItems: number, itemsPerPage: number, currentPage: number): LegacyPagination {
  return {
    totalItems,
    totalItemsPerPage: itemsPerPage,
    currentPage,
    totalPages: Math.max(1, Math.ceil(totalItems / itemsPerPage)),
  };
}
