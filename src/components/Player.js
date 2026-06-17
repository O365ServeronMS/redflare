/**
 * Player — embedded video player section
 * Supports iframe embed (primary) and native/HLS.js <video> fallback for m3u8 URLs.
 */
import Hls from 'hls.js';

export function renderPlayer(container, { embedUrl, m3u8Url, serverName, episodeName }) {
  const section = document.createElement('section');
  section.className = 'player';

  // ---- Back / close button ----
  const backBtn = document.createElement('button');
  backBtn.className = 'player__back';
  backBtn.textContent = '← Quay lại';
  
  // Cleanup HLS instance on close
  let hlsInstance = null;
  backBtn.addEventListener('click', () => {
    if (hlsInstance) {
      hlsInstance.destroy();
    }
    section.remove();
  });
  section.appendChild(backBtn);

  // ---- Player container (16:9 aspect ratio) ----
  const playerContainer = document.createElement('div');
  playerContainer.className = 'player__container';
  // Use inline style to enforce 16:9 aspect ratio
  playerContainer.style.position = 'relative';
  playerContainer.style.paddingTop = '56.25%'; // 16:9
  playerContainer.style.background = '#000';

  if (embedUrl) {
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
    playerContainer.appendChild(iframe);
  } else if (m3u8Url) {
    const video = document.createElement('video');
    video.className = 'player__video';
    video.controls = true;
    video.autoplay = true;
    video.style.position = 'absolute';
    video.style.top = '0';
    video.style.left = '0';
    video.style.width = '100%';
    video.style.height = '100%';
    
    playerContainer.appendChild(video);

    // Initialize HLS.js if supported, else fallback to native (Safari)
    if (Hls.isSupported()) {
      hlsInstance = new Hls({
        capLevelToPlayerSize: true,
        maxBufferLength: 30
      });
      hlsInstance.loadSource(m3u8Url);
      hlsInstance.attachMedia(video);
      hlsInstance.on(Hls.Events.MANIFEST_PARSED, function () {
        video.play().catch(e => console.warn('Autoplay prevented:', e));
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Native support (Safari)
      video.src = m3u8Url;
      video.addEventListener('loadedmetadata', function () {
        video.play().catch(e => console.warn('Autoplay prevented:', e));
      });
    }
  } else {
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

  section.appendChild(playerContainer);

  // ---- Server / episode info ----
  const infoText = document.createElement('p');
  infoText.className = 'player__info';
  infoText.textContent = `Server: ${serverName} — ${episodeName}`;
  section.appendChild(infoText);

  container.appendChild(section);
}
