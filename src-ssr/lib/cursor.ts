// Opaque pagination cursor over (last_synced, slug) -- keyset, not OFFSET.
// Plan §3.1: "Truy vấn 3 là JOIN... không phải vòng lặp"; the pagination
// equivalent of that rule is this file -- OFFSET N on a list page makes D1
// scan and bill N rows just to skip them (D1 rows-read quota), which gets
// worse the deeper a crawler goes. A keyset cursor costs the same single
// index seek on page 1 and page 1000.
export interface Cursor {
  lastSynced: number;
  slug: string;
}

export function encodeCursor(c: Cursor): string {
  return btoa(`${c.lastSynced}:${c.slug}`);
}

export function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const [lastSynced, ...slugParts] = atob(raw).split(':');
    const slug = slugParts.join(':');
    const n = Number(lastSynced);
    if (!Number.isFinite(n) || !slug) return null;
    return { lastSynced: n, slug };
  } catch {
    return null;
  }
}
