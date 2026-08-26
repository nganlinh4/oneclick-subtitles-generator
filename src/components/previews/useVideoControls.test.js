import { fireEvent, render } from '@testing-library/react';
import { useRef } from 'react';
import { vi } from 'vitest';

import useVideoControls from './useVideoControls';

const Harness = ({ onDirectionalSeek, seekBy = vi.fn(), children = null }) => {
  const videoRef = useRef(null);
  const videoContainerRef = useRef(null);
  const hideControlsTimeoutRef = useRef(null);
  useVideoControls({
    videoRef,
    videoContainerRef,
    hideControlsTimeoutRef,
    videoUrl: 'http://127.0.0.1/video',
    videoDuration: 20,
    isDragging: false,
    isLoaded: true,
    isFullscreen: false,
    handleFullscreenExit: vi.fn(),
    setCurrentTime: vi.fn(),
    setDuration: vi.fn(),
    setVideoDuration: vi.fn(),
    setVolume: vi.fn(),
    setIsMuted: vi.fn(),
    setShowCustomControls: vi.fn(),
    setControlsVisible: vi.fn(),
    onDirectionalSeek,
    seekBy,
  });
  return (
    <>
      <div ref={videoContainerRef}><video ref={videoRef} data-testid="video" /></div>
      {children}
    </>
  );
};

const playableVideo = (result) => {
  const video = result.getByTestId('video');
  Object.defineProperty(video, 'duration', { configurable: true, value: 20 });
  video.currentTime = 10;
  return video;
};

it('routes each global directional shortcut through the seek coordinator once', () => {
  const onDirectionalSeek = vi.fn();
  const seekBy = vi.fn();
  const result = render(<Harness onDirectionalSeek={onDirectionalSeek} seekBy={seekBy} />);
  const video = playableVideo(result);

  expect(fireEvent.keyDown(document.body, { code: 'ArrowRight', key: 'ArrowRight' })).toBe(false);
  expect(seekBy).toHaveBeenLastCalledWith(5, { reason: 'global-arrow' });
  expect(video.currentTime).toBe(10);
  expect(onDirectionalSeek).toHaveBeenLastCalledWith('forward');

  fireEvent.keyDown(document.body, { code: 'ArrowRight', key: 'ArrowRight' });
  fireEvent.keyDown(document.body, { code: 'ArrowLeft', key: 'ArrowLeft' });
  expect(seekBy).toHaveBeenLastCalledWith(-5, { reason: 'global-arrow' });
  expect(onDirectionalSeek).toHaveBeenLastCalledWith('backward');
  expect(onDirectionalSeek).toHaveBeenCalledTimes(3);
  expect(seekBy).toHaveBeenCalledTimes(3);
});

it('never seeks the background while any modal owns the keyboard', () => {
  const onDirectionalSeek = vi.fn();
  const result = render(
    <Harness onDirectionalSeek={onDirectionalSeek}>
      <div className="settings-modal-overlay"><div data-testid="settings-surface" /></div>
    </Harness>,
  );
  const video = playableVideo(result);

  expect(fireEvent.keyDown(result.getByTestId('settings-surface'), {
    code: 'ArrowRight', key: 'ArrowRight',
  })).toBe(true);
  expect(video.currentTime).toBe(10);
  expect(onDirectionalSeek).not.toHaveBeenCalled();
});

it.each([
  ['range input', <input aria-label="timeline" type="range" />],
  ['button', <button type="button">Choose</button>],
  ['combobox role', <div role="combobox" tabIndex={0}>Choice</div>],
])('leaves arrow keys with the focused %s', (_label, control) => {
  const onDirectionalSeek = vi.fn();
  const result = render(<Harness onDirectionalSeek={onDirectionalSeek}>{control}</Harness>);
  const video = playableVideo(result);
  const owner = result.getByRole(control.props.role ?? (control.type === 'button' ? 'button' : 'slider'));
  owner.focus();

  expect(fireEvent.keyDown(owner, { code: 'ArrowRight', key: 'ArrowRight' })).toBe(true);
  expect(video.currentTime).toBe(10);
  expect(onDirectionalSeek).not.toHaveBeenCalled();
});

it('leaves modified arrow commands untouched', () => {
  const onDirectionalSeek = vi.fn();
  const result = render(<Harness onDirectionalSeek={onDirectionalSeek} />);
  const video = playableVideo(result);

  expect(fireEvent.keyDown(document.body, {
    code: 'ArrowRight', key: 'ArrowRight', ctrlKey: true,
  })).toBe(true);
  expect(video.currentTime).toBe(10);
  expect(onDirectionalSeek).not.toHaveBeenCalled();
});
