/**
 * Player plugin — skip intro (VIP source).
 * Reads meta.json next to the stream and shows a "Bỏ qua giới thiệu" button
 * while playback is inside the intro range; clicking seeks past it.
 *
 * meta.json schema (authored by the crawl tooling on SharePoint):
 *   movie:  { "intro": { "start": 0, "end": 90 } }
 *   tvshow: { "default":  { "intro": { "start": 0, "end": 90 } },
 *             "episodes": { "s01/e01": { "intro": { "start": 5, "end": 95 } } } }
 *
 * Self-contained module — safe to detach by removing its attach call.
 */

export async function attachSkipIntro(art, { metaUrl, epKey } = {}) {
  if (!metaUrl) return;

  const res = await fetch(metaUrl);
  if (!res.ok) return;
  const meta = await res.json();

  const cfg = epKey ? meta.episodes?.[epKey] || meta.default : meta;
  const intro = cfg?.intro;
  if (!intro || !(intro.end > (intro.start || 0)) || art.destroyed) return;

  const start = intro.start || 0;

  const btn = document.createElement('button');
  btn.textContent = 'Bỏ qua giới thiệu';
  btn.style.cssText = [
    'position:absolute',
    'right:24px',
    'bottom:72px',
    'display:none',
    'padding:10px 18px',
    'background:rgba(20,20,20,0.85)',
    'color:#fff',
    'border:1px solid rgba(255,255,255,0.6)',
    'border-radius:4px',
    'font-size:14px',
    'font-weight:600',
    'cursor:pointer',
    'z-index:60',
    'pointer-events:auto',
  ].join(';');
  btn.addEventListener('click', () => {
    art.seek = intro.end;
    btn.style.display = 'none';
  });

  art.layers.add({
    name: 'skip-intro',
    html: btn,
  });

  art.on('video:timeupdate', () => {
    const t = art.currentTime;
    btn.style.display = t >= start && t < intro.end ? 'block' : 'none';
  });
}
