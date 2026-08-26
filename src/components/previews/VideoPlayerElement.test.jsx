import { createRef } from 'react';
import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import VideoPlayerElement from './VideoPlayerElement';

const mount = ({ doubleTap = true, initiallyPaused = true } = {}) => {
  const videoRef = createRef();
  const lastTouchTimeRef = { current: doubleTap ? Date.now() : 0 };
  const seekBy = vi.fn();
  const handleSeek = vi.fn();
  const result = render(
    <VideoPlayerElement
      videoRef={videoRef}
      lastTouchTimeRef={lastTouchTimeRef}
      handleSeek={handleSeek}
      seekBy={seekBy}
      useOptimizedPreview={false}
      optimizedVideoUrl={null}
      videoUrl="http://127.0.0.1/video.mp4"
      t={(_key, fallback) => fallback}
    />,
  );
  let paused = initiallyPaused;
  Object.defineProperty(videoRef.current, 'paused', {
    configurable: true,
    get: () => paused,
  });
  videoRef.current.play = vi.fn(() => {
    paused = false;
    videoRef.current.dispatchEvent(new Event('play'));
    return Promise.resolve();
  });
  videoRef.current.pause = vi.fn(() => {
    paused = true;
    videoRef.current.dispatchEvent(new Event('pause'));
  });
  videoRef.current.getBoundingClientRect = () => ({ left: 0, width: 200 });
  return { ...result, handleSeek, seekBy, video: videoRef.current };
};

describe('main preview double-tap seek', () => {
  it('never declaratively mutates the media source before the source owner can snapshot transport', () => {
    const { video } = mount();
    expect(video).not.toHaveAttribute('src');
    expect(video.querySelector('source')).toBeNull();
  });

  it.each([
    [30, -5, 'backward'],
    [170, 5, 'forward'],
  ])('routes a tap at x=%s through the coordinator', (clientX, delta, direction) => {
    const { handleSeek, seekBy, video } = mount();
    fireEvent.touchEnd(video, { changedTouches: [{ clientX }] });
    expect(seekBy).toHaveBeenCalledOnce();
    expect(seekBy).toHaveBeenCalledWith(delta, { reason: 'video-double-tap' });
    expect(handleSeek).toHaveBeenCalledWith(direction);
  });

  it('toggles from the media element truth without a delayed state-repair timer', () => {
    const timer = vi.spyOn(globalThis, 'setTimeout');
    const { video } = mount({ doubleTap: false, initiallyPaused: true });

    fireEvent.click(video);
    expect(video.play).toHaveBeenCalledOnce();
    fireEvent.click(video);
    expect(video.pause).toHaveBeenCalledOnce();
    expect(timer).not.toHaveBeenCalled();
  });

  it('uses the same native playback truth for a single touch', () => {
    const { video } = mount({ doubleTap: false, initiallyPaused: false });
    fireEvent.touchEnd(video, { changedTouches: [{ clientX: 100 }] });
    expect(video.pause).toHaveBeenCalledOnce();
    expect(video.play).not.toHaveBeenCalled();
  });
});
