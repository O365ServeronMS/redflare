/**
 * Media Session API — lock screen / control center now-playing info.
 * Without this iOS falls back to document.title + favicon on the lock
 * screen. Title is kept short ("Tên phim - Tập") since that's the only
 * line iOS reliably shows.
 */

export function setMediaSession({ movieName, episodeName, posterUrl }) {
  if (!('mediaSession' in navigator)) return;

  const title = episodeName && episodeName !== 'Full'
    ? `${movieName} - ${episodeName}`
    : movieName;

  navigator.mediaSession.metadata = new MediaMetadata({
    title,
    artist: 'Film Bluesia',
    artwork: posterUrl
      ? [{ src: posterUrl, sizes: '500x750', type: 'image/webp' }]
      : []
  });
}

export function clearMediaSession() {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = null;
}

export function setMediaSessionPlaybackState(state) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.playbackState = state;
}

export function setMediaSessionPosition({ duration, position, playbackRate }) {
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
  if (!Number.isFinite(duration) || duration <= 0) return;
  try {
    navigator.mediaSession.setPositionState({ duration, position, playbackRate });
  } catch {
    // setPositionState throws if position > duration mid-seek; safe to ignore
  }
}
