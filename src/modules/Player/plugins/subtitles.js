/**
 * Player plugin — subtitles (VIP source).
 * Tracks are the folder subs uploaded alongside the stream
 * ({base}/subs/{lang}.vtt), known from the index flags. Adds a "Phụ đề"
 * selector to the ArtPlayer settings menu; Vietnamese is the default track.
 * (User-provided files are handled by the localSubtitle plugin.)
 *
 * Self-contained module — safe to detach by removing its attach call.
 */

const LABELS = { vi: 'Tiếng Việt', en: 'English' };

// Only these languages appear in the player selector. To offer English again,
// add 'en' here.
const ALLOWED_LANGS = ['vi'];

export async function attachSubtitles(art, opts) {
  if (!opts) return;
  const tracks = (opts.subs || [])
    .filter((lang) => ALLOWED_LANGS.includes(lang))
    .map((lang) => ({
      lang,
      label: LABELS[lang] || lang,
      url: `${opts.base}/subs/${lang}.vtt`,
    }));
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
