/**
 * Player plugin — load a local subtitle file (VIP source).
 * Adds a "Tải phụ đề" button to the ArtPlayer control bar; the chosen
 * .srt/.vtt file is converted to WebVTT in the browser (nothing is uploaded)
 * and shown immediately. A "Phụ đề của bạn" entry appears in the settings
 * menu to toggle it off/on again.
 *
 * Self-contained module — safe to detach by removing its attach call.
 */

// Decode as UTF-8 first; if the result is full of replacement characters,
// retry as windows-1258 (legacy Vietnamese encoding).
function decodeSubtitle(buffer) {
  const utf8 = new TextDecoder('utf-8').decode(buffer);
  const badness = (utf8.match(/�/g) || []).length;
  if (badness === 0) return utf8;
  try {
    return new TextDecoder('windows-1258').decode(buffer);
  } catch {
    return utf8;
  }
}

function toVtt(text) {
  text = text.replace(/^﻿/, '').replace(/\r/g, '');
  if (!/^WEBVTT/.test(text)) {
    text = text.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
    text = 'WEBVTT\n\n' + text.trim() + '\n';
  }
  // Strip decoration tags — ArtPlayer escapes HTML in cue text, so leaving
  // them in shows literal tags on screen.
  return text.replace(/<\/?[a-zA-Z][^>]*>/g, '').replace(/\{\\[^}]*\}/g, '');
}

const ICON =
  '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M20 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zM4 12h4v2H4v-2zm10 6H4v-2h10v2zm6 0h-4v-2h4v2zm0-4H10v-2h10v2z"/></svg>';

export async function attachLocalSubtitle(art) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.srt,.vtt';
  input.style.display = 'none';
  document.body.appendChild(input);

  let blobUrl = null;

  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;

    try {
      const vtt = toVtt(decodeSubtitle(await file.arrayBuffer()));
      if (blobUrl) URL.revokeObjectURL(blobUrl);
      blobUrl = URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }));

      art.subtitle.show = true;
      art.subtitle.switch(blobUrl, { type: 'vtt' });
      art.notice.show = `Đã tải phụ đề: ${file.name}`;

      // (Re)create the settings entry for the loaded file
      try {
        art.setting.remove('local-subtitle');
      } catch {
        /* not added yet */
      }
      art.setting.add({
        name: 'local-subtitle',
        html: 'Phụ đề của bạn',
        tooltip: file.name,
        selector: [
          { html: 'Tắt', off: true },
          { html: file.name, default: true },
        ],
        onSelect(item) {
          if (item.off) {
            art.subtitle.show = false;
            return 'Tắt';
          }
          art.subtitle.show = true;
          art.subtitle.switch(blobUrl, { type: 'vtt' });
          return item.html;
        },
      });
    } catch (err) {
      console.warn('local subtitle failed:', err);
      art.notice.show = 'Không đọc được file phụ đề.';
    }
  });

  art.controls.add({
    name: 'load-subtitle',
    position: 'right',
    index: 5,
    html: ICON,
    tooltip: 'Tải phụ đề (.srt/.vtt)',
    click() {
      input.click();
    },
  });

  art.on('destroy', () => {
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    input.remove();
  });
}
