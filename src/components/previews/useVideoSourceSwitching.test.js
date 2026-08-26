import { createElement, useEffect } from 'react';
import { act, render, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import useVideoSourceSwitching from './useVideoSourceSwitching';

const ORIGINAL = 'https://example.com/original.mp4';
const OPTIMIZED = 'https://example.com/optimized.mp4';
const REPLACEMENT = 'https://example.com/replacement.mp4';

const createVideo = () => {
  const video = document.createElement('video');
  let paused = true;
  Object.defineProperties(video, {
    duration: { configurable: true, value: 20 },
    paused: { configurable: true, get: () => paused },
  });
  video.load = vi.fn();
  video.pause = vi.fn(() => { paused = true; });
  video.play = vi.fn(() => {
    paused = false;
    return Promise.resolve();
  });
  return {
    setPlaying(value) { paused = !value; },
    video,
  };
};

const PassiveSourceObserver = ({ onObserve, requestedUrl, video }) => {
  useEffect(() => {
    onObserve(video.getAttribute('src'));
  }, [onObserve, requestedUrl, video]);
  return null;
};

const SourceOwnerHarness = ({ onObserve, requestedUrl, videoFixture }) => {
  const videoRef = { current: videoFixture.video };
  useVideoSourceSwitching({
    videoRef,
    lastBlobUrlRef: { current: null },
    videoUrl: requestedUrl,
    optimizedVideoUrl: null,
    useOptimizedPreview: false,
    onVideoUrlReady: vi.fn(),
    onPlaybackSourceChange: vi.fn(),
    setIsPlaying: vi.fn(),
    seekTo: vi.fn(() => 1),
  });
  return createElement(PassiveSourceObserver, {
    onObserve,
    requestedUrl,
    video: videoFixture.video,
  });
};

const mountOwner = ({
  initialVideoUrl = ORIGINAL,
  onPlaybackSourceChange = vi.fn(),
  videoFixture = createVideo(),
} = {}) => {
  const seekTo = vi.fn(() => 1);
  const setIsPlaying = vi.fn();
  const onVideoUrlReady = vi.fn();
  const videoRef = { current: videoFixture.video };
  const lastBlobUrlRef = { current: null };
  const view = renderHook(
    (props) => useVideoSourceSwitching({
      videoRef,
      lastBlobUrlRef,
      onVideoUrlReady,
      onPlaybackSourceChange,
      setIsPlaying,
      seekTo,
      ...props,
    }),
    {
      initialProps: {
        optimizedVideoUrl: null,
        useOptimizedPreview: false,
        videoUrl: initialVideoUrl,
      },
    },
  );
  return {
    ...view,
    onPlaybackSourceChange,
    onVideoUrlReady,
    seekTo,
    setIsPlaying,
    ...videoFixture,
  };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('single-owner video source switching', () => {
  it('commits the source before descendant passive preview observers can inspect the element', () => {
    const observed = [];
    const videoFixture = createVideo();
    render(createElement(SourceOwnerHarness, {
      onObserve: value => observed.push(value),
      requestedUrl: ORIGINAL,
      videoFixture,
    }));

    expect(observed).toEqual([ORIGINAL]);
    expect(videoFixture.video.load).toHaveBeenCalledOnce();
  });

  it('owns initial source assignment and loads it without inventing a restore seek', () => {
    const view = mountOwner();

    expect(view.video.getAttribute('src')).toBe(ORIGINAL);
    expect(view.video.load).toHaveBeenCalledOnce();
    expect(view.video.pause).not.toHaveBeenCalled();
    expect(view.onPlaybackSourceChange).toHaveBeenLastCalledWith({
      actualUrl: ORIGINAL,
      requestedUrl: ORIGINAL,
    });

    act(() => { view.video.dispatchEvent(new Event('loadeddata')); });
    expect(view.seekTo).not.toHaveBeenCalled();
    expect(view.video.play).not.toHaveBeenCalled();
    expect(view.setIsPlaying).toHaveBeenLastCalledWith(false);
  });

  it('snapshots a paused source before mutation and restores its exact playhead without playing', () => {
    const view = mountOwner();
    act(() => { view.video.dispatchEvent(new Event('loadeddata')); });
    view.seekTo.mockClear();
    view.setIsPlaying.mockClear();
    view.video.currentTime = 8;

    view.rerender({
      optimizedVideoUrl: OPTIMIZED,
      useOptimizedPreview: true,
      videoUrl: ORIGINAL,
    });
    expect(view.video.getAttribute('src')).toBe(OPTIMIZED);
    expect(view.video.pause).not.toHaveBeenCalled();

    act(() => { view.video.dispatchEvent(new Event('loadeddata')); });
    expect(view.seekTo).toHaveBeenCalledWith(8, expect.objectContaining({
      onComplete: expect.any(Function),
      reason: 'source-restore',
    }));
    expect(view.video.play).not.toHaveBeenCalled();

    act(() => { view.seekTo.mock.calls[0][1].onComplete(8); });
    expect(view.video.play).not.toHaveBeenCalled();
    expect(view.setIsPlaying).toHaveBeenLastCalledWith(false);
  });

  it('resumes a playing source only after the exact restore generation completes', async () => {
    const view = mountOwner();
    act(() => { view.video.dispatchEvent(new Event('loadeddata')); });
    view.seekTo.mockClear();
    view.video.currentTime = 8;
    view.setPlaying(true);

    view.rerender({
      optimizedVideoUrl: OPTIMIZED,
      useOptimizedPreview: true,
      videoUrl: ORIGINAL,
    });
    expect(view.video.pause).toHaveBeenCalledOnce();
    expect(view.video.play).not.toHaveBeenCalled();

    act(() => { view.video.dispatchEvent(new Event('loadeddata')); });
    const completion = view.seekTo.mock.calls[0][1].onComplete;
    await act(async () => {
      completion(7.9);
      await Promise.resolve();
    });
    expect(view.video.play).not.toHaveBeenCalled();

    await act(async () => {
      completion(8);
      await Promise.resolve();
    });
    expect(view.video.play).toHaveBeenCalledOnce();
    expect(view.setIsPlaying).toHaveBeenLastCalledWith(true);
  });

  it('cannot resume from a completion captured by a superseded source', async () => {
    const view = mountOwner();
    act(() => { view.video.dispatchEvent(new Event('loadeddata')); });
    view.video.currentTime = 8;
    view.setPlaying(true);

    view.rerender({
      optimizedVideoUrl: OPTIMIZED,
      useOptimizedPreview: true,
      videoUrl: ORIGINAL,
    });
    act(() => { view.video.dispatchEvent(new Event('loadeddata')); });
    const staleCompletion = view.seekTo.mock.calls.at(-1)[1].onComplete;

    view.video.currentTime = 3;
    view.rerender({
      optimizedVideoUrl: null,
      useOptimizedPreview: false,
      videoUrl: ORIGINAL,
    });
    await act(async () => {
      staleCompletion(8);
      await Promise.resolve();
    });
    expect(view.video.play).not.toHaveBeenCalled();
  });

  it('invalidates restore completion when the replacement errors', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const view = mountOwner();
    act(() => { view.video.dispatchEvent(new Event('loadeddata')); });
    view.video.currentTime = 8;
    view.setPlaying(true);

    view.rerender({
      optimizedVideoUrl: OPTIMIZED,
      useOptimizedPreview: true,
      videoUrl: ORIGINAL,
    });
    act(() => { view.video.dispatchEvent(new Event('loadeddata')); });
    const completion = view.seekTo.mock.calls.at(-1)[1].onComplete;
    act(() => { view.video.dispatchEvent(new Event('error')); });

    await act(async () => {
      completion(8);
      await Promise.resolve();
    });
    expect(view.video.play).not.toHaveBeenCalled();
    expect(view.setIsPlaying).toHaveBeenLastCalledWith(false);
  });

  it('resets and pauses an unrelated logical media replacement instead of carrying transport', () => {
    const view = mountOwner();
    act(() => { view.video.dispatchEvent(new Event('loadeddata')); });
    view.seekTo.mockClear();
    view.video.currentTime = 8;
    view.setPlaying(true);

    view.rerender({
      optimizedVideoUrl: null,
      useOptimizedPreview: false,
      videoUrl: REPLACEMENT,
    });
    expect(view.video.pause).toHaveBeenCalledOnce();
    expect(view.video.getAttribute('src')).toBe(REPLACEMENT);

    act(() => { view.video.dispatchEvent(new Event('loadeddata')); });
    expect(view.seekTo).not.toHaveBeenCalled();
    expect(view.video.play).not.toHaveBeenCalled();
    expect(view.setIsPlaying).toHaveBeenLastCalledWith(false);
  });

  it('falls back inside the owner with the original snapshot and publishes the actual source', async () => {
    const view = mountOwner();
    act(() => { view.video.dispatchEvent(new Event('loadeddata')); });
    view.seekTo.mockClear();
    view.video.currentTime = 8;
    view.setPlaying(true);

    view.rerender({
      optimizedVideoUrl: OPTIMIZED,
      useOptimizedPreview: true,
      videoUrl: ORIGINAL,
    });
    expect(view.video.getAttribute('src')).toBe(OPTIMIZED);
    const leakedError = vi.fn();
    view.video.addEventListener('error', leakedError);

    act(() => { view.video.dispatchEvent(new Event('error')); });
    expect(leakedError).not.toHaveBeenCalled();
    expect(view.video.getAttribute('src')).toBe(ORIGINAL);
    expect(view.onPlaybackSourceChange).toHaveBeenLastCalledWith({
      actualUrl: ORIGINAL,
      requestedUrl: OPTIMIZED,
    });
    expect(view.video.play).not.toHaveBeenCalled();

    act(() => { view.video.dispatchEvent(new Event('loadeddata')); });
    expect(view.seekTo).toHaveBeenLastCalledWith(8, expect.objectContaining({
      onComplete: expect.any(Function),
      reason: 'source-restore',
    }));
    await act(async () => {
      view.seekTo.mock.calls.at(-1)[1].onComplete(8);
      await Promise.resolve();
    });
    expect(view.video.play).toHaveBeenCalledOnce();
    expect(view.setIsPlaying).toHaveBeenLastCalledWith(true);
  });
});
