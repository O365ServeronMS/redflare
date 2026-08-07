import { renderHead, type HeadMeta } from './seo';

/** No CSS/JS pipeline exists yet (wrangler.toml has no [assets] block --
 * see the 2026-08-07 cutover commit). This shell is intentionally bare;
 * styling returns once there's a real static-asset story instead of
 * reviving the old SPA's dist/. */
export function renderPage(meta: HeadMeta, bodyHtml: string): string {
  return `<!doctype html>
<html lang="vi">
<head>
${renderHead(meta)}
</head>
<body>
${bodyHtml}
</body>
</html>`;
}
