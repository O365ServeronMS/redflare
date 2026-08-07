// Every dynamic value that reaches HTML goes through this -- there is no
// framework doing it implicitly here (render/ is template literals, not
// JSX). The one place this matters most is echoing a search query back
// into the page (ADR-0002 "Security"): unescaped there is stored XSS that
// then gets cached and served to every visitor of that URL.
export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
