import { escapeHtml } from './escape';
import { renderPage } from './layout';
import { SITE_ORIGIN } from './seo';
import type { EpisodeRecord, MovieRow } from '../types/movie';

// hls.js from a CDN, not bundled -- there is no static-asset pipeline yet
// (wrangler.toml has no [assets] block since the 2026-08-07 cutover). This
// is the one page in the whole SSR app that runs any client JS at all
// (plan §3.3: "đây là trang duy nhất được hydrate"); every other route is
// pure server-rendered HTML with zero script tags.
const HLS_JS_CDN = 'https://cdn.jsdelivr.net/npm/hls.js@1.6.16/dist/hls.min.js';

/** noindex -- duplicate content of the detail page for crawl purposes
 * (plan §3.3). `nonce` (middleware/securityHeaders.ts) lets the CSP allow
 * this one inline bootstrap script without 'unsafe-inline' anywhere; the
 * jsdelivr <script src> tag is allowed by host instead, since a CSP nonce
 * only needs to cover script content the policy can't otherwise name. */
export function renderPlayerPage(
  movie: MovieRow,
  episode: EpisodeRecord,
  allEpisodes: EpisodeRecord[],
  nonce: string
): string {
  const canonical = `${SITE_ORIGIN}/xem/${movie.slug}/${episode.epSlug}`;
  const title = escapeHtml(`${movie.title} - ${episode.epName}`);
  const m3u8 = episode.linkM3u8 ? escapeHtml(episode.linkM3u8) : '';

  const episodeLinks = allEpisodes
    .map(
      (e) =>
        `<li><a href="/xem/${escapeHtml(movie.slug)}/${escapeHtml(e.epSlug)}">${escapeHtml(e.server)} — ${escapeHtml(e.epName)}</a></li>`
    )
    .join('');

  const body = `<h1>${title}</h1>
<video id="player" controls width="1280" height="720" playsinline></video>
<ul>${episodeLinks}</ul>
<a href="/phim/${escapeHtml(movie.slug)}">← Về trang phim</a>
<script src="${HLS_JS_CDN}"></script>
<script nonce="${escapeHtml(nonce)}">
(function () {
  var src = ${JSON.stringify(m3u8)};
  var video = document.getElementById('player');
  if (!src || !video) return;
  if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = src;
  } else if (window.Hls && window.Hls.isSupported()) {
    var hls = new window.Hls();
    hls.loadSource(src);
    hls.attachMedia(video);
  }
})();
</script>`;

  return renderPage(
    { title, description: title, canonical, noindex: true },
    body
  );
}
