import { useEffect, useRef } from 'react';

const progressAt = (time, start, end) => end > start
  ? Math.min(1, Math.max(0, (time - start) / (end - start))) : 0;

// One owner per active row. Playhead prop updates may paint, but never spawn another loop.
export default function ContinuousProgressIndicator({ lyric, isCurrentLyric, currentTime }) {
  const elementRef = useRef(null);
  const timeRef = useRef(currentTime);
  const syncRef = useRef(null);
  timeRef.current = currentTime;

  useEffect(() => {
    if (!isCurrentLyric) return undefined;
    let frame = null;
    let video = null;
    let disposed = false;
    const events = ['play', 'playing', 'pause', 'ended', 'seeked', 'timeupdate'];
    const cancel = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
    };
    const paint = () => {
      const element = elementRef.current;
      if (!element) return;
      const time = video && Number.isFinite(video.currentTime) ? video.currentTime : timeRef.current;
      const transform = `scaleX(${progressAt(time, lyric.start, lyric.end)})`;
      if (element.style.transform !== transform) element.style.transform = transform;
    };
    const tick = () => { frame = null; sync(); };
    const sync = () => {
      if (disposed) return;
      const currentVideo = video?.isConnected ? video : document.querySelector('.video-preview video.video-player');
      if (currentVideo !== video) {
        events.forEach(event => video?.removeEventListener(event, sync));
        video = currentVideo;
        events.forEach(event => video?.addEventListener(event, sync));
      }
      paint();
      if (video && !video.paused && !video.ended) {
        if (frame === null) frame = requestAnimationFrame(tick);
      } else cancel();
    };
    syncRef.current = sync;
    sync();
    return () => {
      disposed = true;
      cancel();
      events.forEach(event => video?.removeEventListener(event, sync));
      syncRef.current = null;
    };
  }, [isCurrentLyric, lyric.start, lyric.end]);

  useEffect(() => { syncRef.current?.(); }, [currentTime]);
  if (!isCurrentLyric) return null;
  return <div ref={elementRef} className="progress-indicator" style={{ width: '100%' }} />;
}
