// Reject, don't sanitize (ADR-0002 "Security") -- a slug that doesn't match
// is a 404, not a best-effort cleanup.
const SLUG_RE = /^[a-z0-9-]{1,120}$/;

export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}
