/**
 * Player - embedded video player section.
 * Desktop and Android prefer the OPhim embed player; iOS uses native HLS.
 */

function isIOSDevice() {
  const ua = navigator.userAgent || '';
  const platform = navigator.platform || '';
  return /iPad|iPhone|iPod/.test(ua) || (platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function canUseNativeHls(video) {
  return video.canPlayType('application/vnd.apple.mpegurl') !== '';
}

function createIframe(embedUrl) {
  const iframe = document.createElement('iframe');
  iframe.className = 'player__iframe';
  iframe.src = embedUrl;
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

function createVideo() {
  const video = document.createElement('video');
  video.className = 'player__video';
  video.controls = true;
  video.autoplay = true;
  video.playsInline = true;
  video.style.position = 'absolute';
  video.style.top = '0';
  video.style.left = '0';
  video.style.width = '100%';
  video.style.height = '100%';
  return video;
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

function playWhenReady(video) {
  video.addEventListener('loadedmetadata', function () {
    video.play().catch(e => console.warn('Autoplay prevented:', e));
  });
}

export function renderPlayer(container, { embedUrl, m3u8Url, serverName, episodeName, backdropUrl }) {
  const section = document.createElement('section');
  section.className = 'player';

  const header = document.createElement('div');
  header.className = 'player__header';

  const backBtn = document.createElement('button');
  backBtn.className = 'player__back';
  backBtn.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg><span>Quay lại</span>`;

  let hlsInstance = null;
  backBtn.addEventListener('click', () => {
    if (hlsInstance) {
      hlsInstance.destroy();
    }
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

    if (!isIOSDevice() && embedUrl) {
      playerContainer.appendChild(createIframe(embedUrl));
      return;
    }

    if (m3u8Url) {
      const video = createVideo();
      playerContainer.appendChild(video);

      if (canUseNativeHls(video)) {
        video.src = m3u8Url;
        playWhenReady(video);
        return;
      }

      try {
        const { default: Hls } = await import('hls.js/light');
        if (!Hls.isSupported()) {
          showFallback(playerContainer);
          return;
        }

        hlsInstance = new Hls({
          capLevelToPlayerSize: true,
          maxBufferLength: 30,
        });
        hlsInstance.loadSource(m3u8Url);
        hlsInstance.attachMedia(video);
        hlsInstance.on(Hls.Events.MANIFEST_PARSED, function () {
          video.play().catch(e => console.warn('Autoplay prevented:', e));
        });
      } catch (err) {
        console.warn('HLS player could not be loaded:', err);
        showFallback(playerContainer);
      }
      return;
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
