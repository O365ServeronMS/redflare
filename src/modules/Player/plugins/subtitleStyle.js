/**
 * Player plugin — subtitle style (VIP source).
 * Normalizes ArtPlayer subtitle rendering to match hard-sub legibility:
 * font size scales with the player height (recomputed on resize/fullscreen),
 * bold text with a dark outline. Adds a "Cỡ chữ phụ đề" selector
 * (Nhỏ/Vừa/To) to the settings menu, persisted in localStorage.
 *
 * Self-contained module — safe to detach by removing its attach call.
 */

const STORAGE_KEY = 'redflare:sub-size';

// Font size as a fraction of the player height.
const SIZES = [
  { name: 'nho', html: 'Nhỏ', factor: 0.035 },
  { name: 'vua', html: 'Vừa', factor: 0.048 },
  { name: 'to', html: 'To', factor: 0.062 },
];
const DEFAULT_SIZE = 'vua';

function savedSize() {
  try {
    const name = localStorage.getItem(STORAGE_KEY);
    if (SIZES.some((s) => s.name === name)) return name;
  } catch {
    /* storage unavailable */
  }
  return DEFAULT_SIZE;
}

export async function attachSubtitleStyle(art) {
  let current = SIZES.find((s) => s.name === savedSize());

  const apply = () => {
    const px = Math.max(18, Math.round(art.height * current.factor));
    art.subtitle.style({
      fontSize: `${px}px`,
      fontWeight: '600',
      lineHeight: '1.4',
      color: '#fff',
      textShadow:
        '-1px -1px 1px #000, 1px -1px 1px #000, -1px 1px 1px #000, 1px 1px 1px #000, 0 2px 6px rgba(0,0,0,.8)',
    });
  };

  apply();
  art.on('resize', apply);

  art.setting.add({
    name: 'subtitle-size',
    html: 'Cỡ chữ phụ đề',
    tooltip: current.html,
    selector: SIZES.map((s) => ({
      html: s.html,
      name: s.name,
      default: s === current,
    })),
    onSelect(item) {
      current = SIZES.find((s) => s.name === item.name) || current;
      try {
        localStorage.setItem(STORAGE_KEY, current.name);
      } catch {
        /* storage unavailable */
      }
      apply();
      return item.html;
    },
  });
}
