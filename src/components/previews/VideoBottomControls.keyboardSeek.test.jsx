import { createRef } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import VideoBottomControls from './VideoBottomControls';

vi.mock('../common/LiquidGlass', () => ({
  default: ({ children, ...props }) => <button type="button" {...props}>{children}</button>,
}));
vi.mock('../common/PlayPauseMorphType4', () => ({ default: () => <span>play</span> }));
vi.mock('../common/WavyProgressIndicator', () => ({ default: () => <canvas role="progressbar" /> }));
vi.mock('./controls/VolumeControlPill', () => ({ default: () => <div /> }));
vi.mock('./controls/PlaybackSpeedMenu', () => ({ default: () => <div /> }));

const mount = ({ currentTime = 0.4, duration = 19, frameRate = 30 } = {}) => {
  const video = document.createElement('video');
  video.currentTime = currentTime;
  let paused = true;
  Object.defineProperty(video, 'paused', {
    configurable: true,
    get: () => paused,
  });
  video.play = vi.fn(() => {
    paused = false;
    return Promise.resolve();
  });
  video.pause = vi.fn(() => { paused = true; });
  const videoRef = createRef();
  videoRef.current = video;
  const seekTo = vi.fn(time => { video.currentTime = time; });
  const setControlsVisible = vi.fn();
  const view = render(
    <VideoBottomControls
      showCustomControls
      isFullscreen={false}
      controlsVisible
      isVideoHovered
      isPlaying={false}
      videoRef={videoRef}
      frameRate={frameRate}
      currentTime={currentTime}
      videoDuration={duration}
      isDragging={false}
      dragTime={currentTime}
      handleTimelineMouseDown={vi.fn()}
      handleTimelineTouchStart={vi.fn()}
      seekTo={seekTo}
      volume={1}
      setVolume={vi.fn()}
      isMuted={false}
      setIsMuted={vi.fn()}
      isVolumeSliderVisible={false}
      setIsVolumeSliderVisible={vi.fn()}
      isVolumeDragging={false}
      setIsVolumeDragging={vi.fn()}
      playbackSpeed={1}
      setPlaybackSpeed={vi.fn()}
      isSpeedMenuVisible={false}
      setIsSpeedMenuVisible={vi.fn()}
      isCompactMode={false}
      handleFullscreenExit={vi.fn()}
      setIsFullscreen={vi.fn()}
      setControlsVisible={setControlsVisible}
      setIsVideoHovered={vi.fn()}
      hideControlsTimeoutRef={{ current: null }}
      videoSource="upload"
      fileType="video/mp4"
    />,
  );
  return {
    slider: screen.getByRole('slider', { name: 'Seek video' }),
    video,
    seekTo,
    setControlsVisible,
    ...view,
  };
};

describe('Main preview public keyboard seek', () => {
  it('keeps the visible progress surface unchanged while exposing slider semantics', () => {
    const { slider, setControlsVisible } = mount();
    expect(slider).toHaveAttribute('data-osg-control', 'seek');
    expect(slider).toHaveAttribute('aria-valuemin', '0');
    expect(slider).toHaveAttribute('aria-valuemax', '19');
    expect(slider).toHaveAttribute('aria-valuenow', '0.4');
    fireEvent.mouseDown(slider, { button: 0, clientX: 20 });
    expect(document.activeElement).toBe(slider);
    expect(setControlsVisible).toHaveBeenCalledWith(true);
  });

  it('toggles playback from the media element and never schedules a repair timer', () => {
    const timer = vi.spyOn(globalThis, 'setTimeout');
    const { video } = mount();
    const button = screen.getByRole('button', { name: 'Play' });

    fireEvent.click(button);
    expect(video.play).toHaveBeenCalledOnce();
    // The React prop is intentionally still false; the media element remains the immediate truth.
    fireEvent.click(button);
    expect(video.pause).toHaveBeenCalledOnce();
    expect(timer).not.toHaveBeenCalled();
  });

  it('snaps Arrow keys to one exact 30-fps frame and owns the event', () => {
    const { slider, seekTo, video } = mount({ currentTime: 0.401 });
    const right = new KeyboardEvent('keydown', {
      key: 'ArrowRight', bubbles: true, cancelable: true,
    });
    slider.dispatchEvent(right);
    expect(right.defaultPrevented).toBe(true);
    expect(seekTo).toHaveBeenLastCalledWith(13 / 30, { reason: 'focused-frame-step' });
    expect(video.currentTime).toBe(13 / 30);

    fireEvent.keyDown(slider, { key: 'ArrowLeft' });
    expect(video.currentTime).toBe(12 / 30);
  });

  it.each([24, 25, 50, 60, 120])(
    'steps on the project-authored %i-fps export grid',
    (frameRate) => {
      const { slider, seekTo, video } = mount({ currentTime: 1, frameRate });
      fireEvent.keyDown(slider, { key: 'ArrowRight' });
      expect(seekTo).toHaveBeenLastCalledWith(
        (frameRate + 1) / frameRate,
        { reason: 'focused-frame-step' },
      );
      expect(video.currentTime).toBe((frameRate + 1) / frameRate);
    },
  );

  it('never crosses either playable boundary', () => {
    const atStart = mount({ currentTime: 0 });
    fireEvent.keyDown(atStart.slider, { key: 'ArrowLeft' });
    expect(atStart.video.currentTime).toBe(0);
    atStart.unmount();

    const atEnd = mount({ currentTime: 1, duration: 1 });
    fireEvent.keyDown(atEnd.slider, { key: 'ArrowRight' });
    expect(atEnd.video.currentTime).toBe(1);
  });
});
