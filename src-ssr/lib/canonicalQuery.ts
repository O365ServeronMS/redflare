// Cache-poisoning surface is query-param cardinality, not the path
// (ADR-0002 "Security"): an unbounded ?utm_source=... would otherwise mint
// a fresh cache entry per value. Any request carrying a param outside the
// allow-list gets redirected to the canonical URL instead of served/cached
// as-is. Returns null when the URL is already canonical.
export function canonicalRedirectPath(
  pathname: string,
  search: URLSearchParams,
  allowed: readonly string[]
): string | null {
  const keys = [...search.keys()];
  const hasExtra = keys.some((k) => !allowed.includes(k));
  if (!hasExtra) return null;

  const kept = new URLSearchParams();
  for (const key of allowed) {
    const value = search.get(key);
    if (value !== null) kept.set(key, value);
  }
  const qs = kept.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}
