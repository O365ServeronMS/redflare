/**
 * Player plugin — subtitles (VIP source).
 * Tracks come from two places, merged with folder subs taking priority:
 *   1. Folder subs uploaded alongside the stream ({base}/subs/{lang}.vtt),
 *      known from the index flags.
 *   2. subtitle-api (SubDL/OpenSubtitles → .vtt) via {subsApiUrl}.
 * Adds a "Phụ đề" selector to the ArtPlayer settings menu; Vietnamese is the
 * default track when available.
 *
 * Self-contained module — safe to detach by removing its attach call.
 */

import { STREAM_BASE } from '../../../api/stream.js';

const LABELS = { vi: 'Tiếng Việt', en: 'English' };

async function collectTracks({ subs, base, subsApiUrl }) {
  const tracks = (subs || []).map((lang) => ({
    lang,
    label: LABELS[lang] || lang,
    url: `${base}/subs/${lang}.vtt`,
  }));

  if (subsApiUrl) {
    try {
      const res = await fetch(subsApiUrl);
      if (res.ok) {
        const data = await res.json();
        (data.items || []).forEach((item) => {
          if (tracks.some((t) => t.lang === item.lang)) return;
          tracks.push({
            lang: item.lang,
            label: item.label || LABELS[item.lang] || item.lang,
            url: `${STREAM_BASE}${item.url}`,
          });
        });
      }
    } catch (err) {
      console.warn('subtitle-api unavailable:', err);
    }
  }

  return tracks;
}

export async function attachSubtitles(art, opts) {
  if (!opts) return;
  const tracks = await collectTracks(opts);
  if (tracks.length === 0 || art.destroyed) return;

  const defaultTrack = tracks.find((t) => t.lang === 'vi') || tracks[0];
  art.subtitle.switch(defaultTrack.url, { type: 'vtt' });

  art.setting.add({
    name: 'vip-subtitle',
    html: 'Phụ đề',
    tooltip: defaultTrack.label,
    selector: [
      { html: 'Tắt', off: true },
      ...tracks.map((t) => ({
        html: t.label,
        url: t.url,
        default: t === defaultTrack,
      })),
    ],
    onSelect(item) {
      if (item.off) {
        art.subtitle.show = false;
        return 'Tắt';
      }
      art.subtitle.show = true;
      art.subtitle.switch(item.url, { type: 'vtt' });
      return item.html;
    },
  });
}
