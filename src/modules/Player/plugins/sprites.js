/**
 * Player plugin — seek-preview thumbnails (VIP source).
 * Reads {base}/sprites/preview.vtt (WebVTT map: each cue's text is
 * "preview.jpg#xywh=x,y,w,h") and shows the matching crop above the ArtPlayer
 * progress bar while hovering.
 *
 * Self-contained module — styles are inline, safe to detach by removing its
 * attach call.
 */

function parseTime(t) {
  const parts = t.trim().split(':').map(parseFloat);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}

function parseSpriteVtt(text, vttUrl) {
  const cues = [];
  const lines = text.replace(/\r/g, '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes('-->')) continue;
    const [startRaw, endRaw] = lines[i].split('-->');
    const target = (lines[i + 1] || '').trim();
    const m = target.match(/^(.*)#xywh=(\d+),(\d+),(\d+),(\d+)$/);
    if (!m) continue;
    cues.push({
      start: parseTime(startRaw),
      end: parseTime(endRaw),
      url: new URL(m[1], vttUrl).href,
      x: +m[2],
      y: +m[3],
      w: +m[4],
      h: +m[5],
    });
  }
  return cues;
}

export async function attachSprites(art, spritesUrl) {
  if (!spritesUrl) return;

  const res = await fetch(spritesUrl);
  if (!res.ok) return;
  const cues = parseSpriteVtt(await res.text(), spritesUrl);
  if (cues.length === 0 || art.destroyed) return;

  const $progress = art.template.$player.querySelector('.art-control-progress');
  if (!$progress) return;

  const box = document.createElement('div');
  box.style.cssText = [
    'position:absolute',
    'bottom:18px',
    'display:none',
    'pointer-events:none',
    'border:2px solid rgba(255,255,255,0.85)',
    'border-radius:4px',
    'box-shadow:0 4px 16px rgba(0,0,0,0.55)',
    'background-color:#000',
    'z-index:50',
  ].join(';');
  $progress.style.position = 'relative';
  $progress.appendChild(box);

  const hide = () => {
    box.style.display = 'none';
  };

  $progress.addEventListener('mousemove', (e) => {
    const duration = art.duration;
    if (!duration) return hide();

    const rect = $progress.getBoundingClientRect();
    const pct = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
    const time = pct * duration;
    const cue = cues.find((c) => time >= c.start && time < c.end);
    if (!cue) return hide();

    box.style.width = `${cue.w}px`;
    box.style.height = `${cue.h}px`;
    box.style.backgroundImage = `url(${cue.url})`;
    box.style.backgroundPosition = `-${cue.x}px -${cue.y}px`;
    const left = Math.min(
      Math.max(e.clientX - rect.left - cue.w / 2, 0),
      rect.width - cue.w
    );
    box.style.left = `${left}px`;
    box.style.display = 'block';
  });

  $progress.addEventListener('mouseleave', hide);
  art.on('destroy', hide);
}
