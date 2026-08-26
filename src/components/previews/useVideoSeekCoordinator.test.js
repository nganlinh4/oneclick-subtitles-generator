import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import useVideoSeekCoordinator, { clampMediaSeekTime } from './useVideoSeekCoordinator';

const controlledVideo = ({ currentTime = 0, duration = 10 } = {}) => {
  const video = document.createElement('video');
  let time = currentTime;
  let seeking = false;
  const latestListener = new Map();
  const addEventListener = video.addEventListener.bind(video);
  video.addEventListener = (name, listener, options) => {
    latestListener.set(name, listener);
    addEventListener(name, listener, options);
  };
  Object.defineProperties(video, {
    currentTime: {
      configurable: true,
      get: () => time,
      set: value => { time = value; },
    },
    duration: { configurable: true, get: () => duration },
    seeking: { configurable: true, get: () => seeking },
  });
  return {
    video,
    setDuration: value => { duration = value; },
    setNativeSeeking: value => { seeking = value; },
    setTime: value => { time = value; },
    listenerFor: name => latestListener.get(name),
  };
};

const mount = ({ sourceKey = 'source-a', initialTime = 0 } = {}) => {
  const media = controlledVideo({ currentTime: initialTime });
  const setCurrentTime = vi.fn();
  const onSeek = vi.fn();
  const videoRef = { current: media.video };
  const view = renderHook(
    ({ source }) => useVideoSeekCoordinator({
      videoRef,
      sourceKey: source,
      setCurrentTime,
      onSeek,
    }),
    { initialProps: { source: sourceKey } },
  );
  return { ...media, ...view, onSeek, setCurrentTime };
};

const dispatchAndFlush = async (video, eventName) => {
  await act(async () => {
    video.dispatchEvent(new Event(eventName));
    await Promise.resolve();
  });
};

describe('main-editor media seek coordinator', () => {
  it('clamps only finite seek targets to the playable interval', () => {
    expect(clampMediaSeekTime(-3, 10)).toBe(0);
    expect(clampMediaSeekTime(12, 10)).toBe(10);
    expect(clampMediaSeekTime(4, Number.NaN)).toBe(4);
    expect(clampMediaSeekTime(Number.NaN, 10)).toBeNull();
  });

  it('lets only the newest rapid seek generation complete', async () => {
    const view = mount();
    let firstGeneration;
    let secondGeneration;
    act(() => {
      firstGeneration = view.result.current.seekTo(2, { reason: 'first' });
      secondGeneration = view.result.current.seekTo(7, { reason: 'second' });
    });
    expect(secondGeneration).toBeGreaterThan(firstGeneration);
    expect(view.result.current.isSeeking).toBe(true);

    // A delayed completion for the superseded target must not release the newest generation.
    view.setTime(2);
    await dispatchAndFlush(view.video, 'seeked');
    expect(view.result.current.isSeeking).toBe(true);
    expect(view.onSeek).not.toHaveBeenCalled();

    view.setTime(7);
    await dispatchAndFlush(view.video, 'seeked');
    expect(view.result.current.isSeeking).toBe(false);
    expect(view.onSeek).toHaveBeenCalledOnce();
    expect(view.onSeek).toHaveBeenCalledWith(7);
  });

  it('accumulates seekBy from the newest pending target and clamps the result', async () => {
    const view = mount({ initialTime: 4 });
    act(() => {
      view.result.current.seekTo(8);
      view.result.current.seekBy(5);
    });
    expect(view.video.currentTime).toBe(10);
    expect(view.result.current.isSeeking).toBe(true);

    await dispatchAndFlush(view.video, 'seeked');
    expect(view.result.current.isSeeking).toBe(false);
    expect(view.onSeek).toHaveBeenLastCalledWith(10);
  });

  it('publishes an identical target as the newest completed command without waiting for an event', async () => {
    const view = mount({ initialTime: 3 });
    let generation;
    await act(async () => {
      generation = view.result.current.seekTo(3);
      await Promise.resolve();
    });
    expect(generation).toEqual(expect.any(Number));
    expect(view.result.current.isSeeking).toBe(false);
    expect(view.onSeek).toHaveBeenCalledExactlyOnceWith(3);
    expect(view.setCurrentTime).toHaveBeenLastCalledWith(3);
  });

  it('never rounds a distinct command into the completion epsilon', () => {
    const view = mount({ initialTime: 1 });
    const distinctTarget = 1 + (1 / 480);
    let generation;
    act(() => { generation = view.result.current.seekTo(distinctTarget); });

    expect(generation).toEqual(expect.any(Number));
    expect(view.video.currentTime).toBe(distinctTarget);
    expect(view.result.current.isSeeking).toBe(true);
  });

  it('does not discard a lyric request less than 0.2 seconds from the playhead', () => {
    const view = mount({ initialTime: 1 });
    let generation;
    act(() => {
      generation = view.result.current.seekTo(1.1, { reason: 'lyric-request' });
    });
    expect(generation).toEqual(expect.any(Number));
    expect(view.video.currentTime).toBe(1.1);
    expect(view.result.current.isSeeking).toBe(true);
  });

  it('runs only the completion callback belonging to the generation that settles', async () => {
    const view = mount();
    const staleCompletion = vi.fn();
    const winningCompletion = vi.fn();
    act(() => {
      view.result.current.seekTo(2, { onComplete: staleCompletion, reason: 'source-restore' });
      view.result.current.seekTo(6, { onComplete: winningCompletion, reason: 'user-seek' });
    });

    view.setTime(2);
    await dispatchAndFlush(view.video, 'seeked');
    expect(staleCompletion).not.toHaveBeenCalled();
    expect(winningCompletion).not.toHaveBeenCalled();

    view.setTime(6);
    await dispatchAndFlush(view.video, 'seeked');
    expect(staleCompletion).not.toHaveBeenCalled();
    expect(winningCompletion).toHaveBeenCalledOnce();
  });

  it('gives a newer same-target command its own generation and completion owner', async () => {
    const view = mount();
    const staleCompletion = vi.fn();
    const winningCompletion = vi.fn();
    let firstGeneration;
    let secondGeneration;
    act(() => {
      firstGeneration = view.result.current.seekTo(4, {
        onComplete: staleCompletion,
        reason: 'user-seek',
      });
      view.setNativeSeeking(true);
      secondGeneration = view.result.current.seekTo(4, {
        onComplete: winningCompletion,
        reason: 'source-restore',
      });
    });

    expect(secondGeneration).toBeGreaterThan(firstGeneration);
    view.setNativeSeeking(false);
    await dispatchAndFlush(view.video, 'seeked');
    expect(staleCompletion).not.toHaveBeenCalled();
    expect(winningCompletion).toHaveBeenCalledExactlyOnceWith(4);
    expect(view.onSeek).toHaveBeenCalledExactlyOnceWith(4);
  });

  it('revokes a queued same-target completion when another seek wins first', async () => {
    const view = mount({ initialTime: 3 });
    const staleCompletion = vi.fn();
    await act(async () => {
      view.result.current.seekTo(3, { onComplete: staleCompletion, reason: 'source-restore' });
      view.result.current.seekTo(5, { reason: 'user-seek' });
      await Promise.resolve();
    });
    expect(staleCompletion).not.toHaveBeenCalled();
    expect(view.result.current.isSeeking).toBe(true);
  });

  it('cancels an in-flight generation on source replacement and ignores its late event', async () => {
    const view = mount();
    act(() => { view.result.current.seekTo(6); });
    expect(view.result.current.isSeeking).toBe(true);

    view.rerender({ source: 'source-b' });
    expect(view.result.current.isSeeking).toBe(false);
    view.setTime(6);
    await dispatchAndFlush(view.video, 'seeked');
    expect(view.onSeek).not.toHaveBeenCalled();
  });

  it('ignores old-source listeners after layout invalidation and preserves the new generation', async () => {
    const view = mount();
    const staleSeeking = view.listenerFor('seeking');
    const staleSeeked = view.listenerFor('seeked');
    const staleError = view.listenerFor('error');

    view.rerender({ source: 'source-b' });
    act(() => { staleSeeking(); });
    expect(view.result.current.isSeeking).toBe(false);

    act(() => { view.result.current.seekTo(5, { reason: 'source-b-command' }); });
    expect(view.result.current.isSeeking).toBe(true);
    act(() => { staleError(); });
    expect(view.result.current.isSeeking).toBe(true);

    await act(async () => {
      staleSeeked();
      await Promise.resolve();
    });
    expect(view.result.current.isSeeking).toBe(true);
    expect(view.onSeek).not.toHaveBeenCalled();

    await dispatchAndFlush(view.video, 'seeked');
    expect(view.result.current.isSeeking).toBe(false);
    expect(view.onSeek).toHaveBeenCalledExactlyOnceWith(5);
  });

  it.each(['error', 'emptied', 'loadstart', 'abort'])(
    'cancels without a timeout when the transport emits %s',
    eventName => {
    const view = mount();
    act(() => { view.result.current.seekTo(5); });
    expect(view.result.current.isSeeking).toBe(true);
    act(() => { view.video.dispatchEvent(new Event(eventName)); });
    expect(view.result.current.isSeeking).toBe(false);
    },
  );

  it('is the ordinary playback timeupdate publisher but ignores updates during a seek', () => {
    const view = mount();
    view.setTime(1.25);
    act(() => { view.video.dispatchEvent(new Event('timeupdate')); });
    expect(view.setCurrentTime).toHaveBeenLastCalledWith(1.25);

    act(() => { view.result.current.seekTo(4); });
    view.setTime(3);
    act(() => { view.video.dispatchEvent(new Event('timeupdate')); });
    expect(view.setCurrentTime).not.toHaveBeenLastCalledWith(3);
  });

  it('attaches when the conditional video element appears after the coordinator mounted', () => {
    const videoRef = { current: null };
    const setCurrentTime = vi.fn();
    const view = renderHook(
      ({ sourceKey }) => useVideoSeekCoordinator({
        videoRef,
        sourceKey,
        setCurrentTime,
      }),
      { initialProps: { sourceKey: null } },
    );
    const media = controlledVideo({ currentTime: 2.25 });
    videoRef.current = media.video;
    view.rerender({ sourceKey: 'source-a' });

    act(() => { media.video.dispatchEvent(new Event('timeupdate')); });
    expect(setCurrentTime).toHaveBeenLastCalledWith(2.25);
  });
});
