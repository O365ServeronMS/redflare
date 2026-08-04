/**
 * Player - embedded video player section.
 * All devices prefer direct m3u8 playback (ArtPlayer + hls.js) for a uniform
 * UI and in-place error recovery; the OPhim embed iframe is the fallback when
 * a server has no link_m3u8 (or ArtPlayer fails to load).
 */

import {
  setMediaSession,
  clearMediaSession,
  setMediaSessionPlaybackState,
  setMediaSessionPosition
} from '../../lib/mediaSession.js';

function canUseNativeHls(video) {
  return video.canPlayType('application/vnd.apple.mpegurl') !== '';
}

function createIframe(embedUrl) {
  const iframe = document.createElement('iframe');
  iframe.className = 'player__iframe';
  iframe.src = embedUrl;
  iframe.loading = 'lazy';
  iframe.setAttribute('allow', 'autoplay; fullscreen; encrypted-media');
  iframe.setAttribute('allowfullscreen', '');
  iframe.setAttribute('frameborder', '0');
  iframe.setAttribute('scrolling', 'no');
  iframe.style.position = 'absolute';
  iframe.style.top = '0';
  iframe.style.left = '0';
  iframe.style.width = '100%';
  iframe.style.height = '100%';
  return iframe;
}

function showFallback(playerContainer) {
  playerContainer.innerHTML = '';
  const fallback = document.createElement('p');
  fallback.className = 'player__fallback';
  fallback.textContent = 'Không có nguồn phát khả dụng.';
  fallback.style.position = 'absolute';
  fallback.style.top = '50%';
  fallback.style.left = '50%';
  fallback.style.transform = 'translate(-50%, -50%)';
  fallback.style.color = '#fff';
  playerContainer.appendChild(fallback);
}

async function mountArtPlayer(playerContainer, { m3u8Url, backdropUrl, movieName, episodeName, posterUrl }) {
  const { default: Artplayer } = await import('artplayer');

  const mount = document.createElement('div');
  mount.className = 'player__art';
  mount.style.position = 'absolute';
  mount.style.top = '0';
  mount.style.left = '0';
  mount.style.width = '100%';
  mount.style.height = '100%';
  playerContainer.appendChild(mount);

  const art = new Artplayer({
    container: mount,
    url: m3u8Url,
    type: 'm3u8',
    customType: {
      m3u8: async (video, url, art) => {
        // Prefer hls.js over native HLS: with native playback a missing
        // segment fires a video error and ArtPlayer's auto-reconnect restarts
        // from 0 (the "plays one segment then loops" bug). hls.js lets us
        // recover in place via the ERROR handler below.
        const { default: Hls } = await import('hls.js/light');
        if (!Hls.isSupported()) {
          if (canUseNativeHls(video)) {
            video.src = url;
            return;
          }
          art.notice.show = 'Trình duyệt không hỗ trợ phát HLS.';
          return;
        }
        const hls = new Hls({
          capLevelToPlayerSize: true,
          maxBufferLength: 120,
          maxBufferSize: 150 * 1000 * 1000,
          manifestLoadingTimeOut: 60000,
          levelLoadingTimeOut: 60000,
          fragLoadingTimeOut: 60000,
        });

        // Fatal-error recovery: without this hls.js gives up silently after a
        // bad segment (missing .ts, decode error) and the player misbehaves.
        let mediaRetries = 0;
        let networkRetries = 0;
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (!data.fatal) return;
          console.warn('hls fatal error:', data.type, data.details);
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRetries < 2) {
            mediaRetries += 1;
            art.notice.show = 'Đang khôi phục luồng phát…';
            hls.recoverMediaError();
            return;
          }
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR && networkRetries < 3) {
            networkRetries += 1;
            art.notice.show = 'Nguồn phát gặp lỗi, đang thử lại…';
            setTimeout(() => hls.startLoad(video.currentTime), 1000 * networkRetries);
            return;
          }
          hls.stopLoad();
          art.notice.show =
            'Nguồn phát lỗi ở đoạn này — thử lại sau hoặc chọn server khác.';
        });

        hls.loadSource(url);
        hls.attachMedia(video);
        art.on('destroy', () => hls.destroy());
      },
    },
    poster: backdropUrl || '',
    theme: '#d4af37',
    autoplay: true,
    playsInline: true,
    setting: true,
    playbackRate: true,
    fullscreen: true,
    fullscreenWeb: true,
    pip: true,
    hotkey: true,
    autoOrientation: true,
  });

  // Native-HLS fallback (no MSE, e.g. iPhone Safari): a video error makes
  // ArtPlayer auto-reconnect from 0 — restore the last playback position.
  let lastPos = 0;
  art.on('video:timeupdate', () => {
    if (art.video.currentTime > 1) lastPos = art.video.currentTime;
  });
  art.on('video:error', () => {
    const pos = lastPos;
    if (pos > 1) art.once('video:loadedmetadata', () => { art.currentTime = pos; });
  });

  // Lock screen / control center now-playing info (iOS otherwise falls
  // back to document.title + favicon).
  setMediaSession({ movieName, episodeName, posterUrl });
  art.on('video:play', () => setMediaSessionPlaybackState('playing'));
  art.on('video:pause', () => setMediaSessionPlaybackState('paused'));
  let lastPositionUpdate = 0;
  art.on('video:timeupdate', () => {
    const now = Date.now();
    if (now - lastPositionUpdate < 2000) return;
    lastPositionUpdate = now;
    setMediaSessionPosition({
      duration: art.video.duration,
      position: art.video.currentTime,
      playbackRate: art.video.playbackRate || 1
    });
  });

  return art;
}

// The detail page replaces the player by wiping its mount (innerHTML = '');
// an orphaned ArtPlayer/hls.js instance would keep downloading segments in the
// background, so destroy the previous one whenever a new player is rendered.
let currentArt = null;

function destroyCurrentArt() {
  if (currentArt) {
    currentArt.destroy(false);
    currentArt = null;
  }
  clearMediaSession();
}

export function renderPlayer(container, { embedUrl, m3u8Url, serverName, episodeName, backdropUrl, movieName, posterUrl }) {
  destroyCurrentArt();

  const section = document.createElement('section');
  section.className = 'player';

  const header = document.createElement('div');
  header.className = 'player__header';

  const backBtn = document.createElement('button');
  backBtn.className = 'player__back';
  backBtn.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg><span>Quay lại</span>`;

  backBtn.addEventListener('click', () => {
    destroyCurrentArt();
    section.remove();
  });
  header.appendChild(backBtn);

  const infoText = document.createElement('h3');
  infoText.className = 'player__title';
  infoText.innerHTML = `Đang phát: <span>${episodeName} (${serverName})</span>`;
  header.appendChild(infoText);

  section.appendChild(header);

  const playerContainer = document.createElement('div');
  playerContainer.className = 'player__container';

  const splash = document.createElement('div');
  splash.className = 'player__splash';
  splash.style.backgroundImage = `url(${backdropUrl || ''})`;

  const playIcon = document.createElement('button');
  playIcon.className = 'player__play-btn';
  playIcon.setAttribute('aria-label', 'Phát video');
  playIcon.innerHTML = `<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>`;

  splash.appendChild(playIcon);
  playerContainer.appendChild(splash);

  const startPlayback = async () => {
    playerContainer.innerHTML = '';

    if (m3u8Url) {
      try {
        currentArt = await mountArtPlayer(playerContainer, { m3u8Url, backdropUrl, movieName, episodeName, posterUrl });
        return;
      } catch (err) {
        // ArtPlayer failed to load (e.g. chunk fetch error) — fall back to
        // the embed player below rather than dying.
        console.warn('ArtPlayer could not be loaded:', err);
        playerContainer.innerHTML = '';
      }
    }

    if (embedUrl) {
      playerContainer.appendChild(createIframe(embedUrl));
      return;
    }

    showFallback(playerContainer);
  };

  splash.addEventListener('click', () => {
    startPlayback();
  }, { once: true });

  section.appendChild(playerContainer);
  container.appendChild(section);
}
