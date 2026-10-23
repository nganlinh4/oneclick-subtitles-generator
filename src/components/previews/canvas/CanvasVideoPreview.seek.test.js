// Canvas preview: seek generations, black transitional surfaces and source switches.
import { act, render, waitFor } from '@testing-library/react';
import {
  afterEach, describe, expect, it, vi,
} from 'vitest';

import { defaultCustomization } from '../../subtitleCustomization/defaultCustomization';
import CanvasVideoPreview from './CanvasVideoPreview';
import {
  canvasPreviewMocks,
  resetCanvasPreviewMocks,
  installReadyManagedFont,
  spoofWindowsChrome,
} from './canvasVideoPreviewTestFixtures';

const {
  captureVideoFrame,
  createCanvasSubtitleRenderer,
  drawFrame,
} = canvasPreviewMocks;

vi.mock('../../../platform/systemFontProbe', async () => {
  const { canvasPreviewMocks } = await import('./canvasVideoPreviewTestFixtures');
  return { systemFontProbe: () => canvasPreviewMocks.exactSystemProbe };
});

vi.mock('../native/nativePreviewScene', async (importOriginal) => {
  const { canvasPreviewMocks } = await import('./canvasVideoPreviewTestFixtures');
  return {
    ...(await importOriginal()),
    bakePreviewAtlas: canvasPreviewMocks.bakePreviewAtlas,
    previewFace: canvasPreviewMocks.previewFace,
  };
});

vi.mock('../native/useNativePreviewSource', () => ({
  useVideoSourceDimensions: () => ({ widthPx: 640, heightPx: 360 }),
}));

vi.mock('./canvasSubtitleRenderer', async () => {
  const { canvasPreviewMocks } = await import('./canvasVideoPreviewTestFixtures');
  return {
    createAtlasCanvas: canvasPreviewMocks.createAtlasCanvas,
    createCanvasSubtitleRenderer: canvasPreviewMocks.createCanvasSubtitleRenderer,
  };
});

afterEach(resetCanvasPreviewMocks);

describe('canvas preview seeks and source switches', () => {
  it('discards a during-seek frame and snapshots the settled paused source', async () => {
    spoofWindowsChrome();
    installReadyManagedFont();
    let currentTime = 0.5;
    let readyState = 1;
    let nativeSeeking = false;
    let callbackSequence = 0;
    const callbacks = new Map();
    const video = document.createElement('video');
    Object.defineProperties(video, {
      currentTime: { configurable: true, get: () => currentTime },
      readyState: { configurable: true, get: () => readyState },
      seeking: { configurable: true, get: () => nativeSeeking },
      paused: { configurable: true, value: true },
      requestVideoFrameCallback: {
        configurable: true,
        value: vi.fn((callback) => {
          callbackSequence += 1;
          callbacks.set(callbackSequence, callback);
          return callbackSequence;
        }),
      },
      cancelVideoFrameCallback: { configurable: true, value: vi.fn() },
    });
    const fireFrame = async (handle, mediaTime) => {
      const callback = callbacks.get(handle);
      expect(callback).toBeTypeOf('function');
      callbacks.delete(handle);
      await act(async () => callback(performance.now(), { mediaTime, presentedFrames: handle }));
    };
    const baseProps = {
      videoRef: { current: video },
      sourceKey: 'deferred-paused-seek',
      playing: false,
      seeking: false,
      currentTime,
      frameRate: 30,
      customization: defaultCustomization,
      subtitles: [],
      resolution: '1080p',
    };
    const { container, rerender } = render(<CanvasVideoPreview {...baseProps} />);
    const canvas = container.querySelector('canvas');

    await waitFor(() => expect(video.requestVideoFrameCallback).toHaveBeenCalledTimes(1));
    readyState = 4;
    await fireFrame(1, 0.5);
    await waitFor(() => expect(canvas.dataset.osgFrameRevision).toBe('1'));

    nativeSeeking = true;
    currentTime = 2.8;
    act(() => video.dispatchEvent(new Event('seeking')));
    const capturesBeforeIntermediateFrame = captureVideoFrame.mock.calls.length;
    await fireFrame(3, 2.5);
    expect(canvas.dataset.osgFrameRevision).toBe('1');
    expect(captureVideoFrame).toHaveBeenCalledTimes(capturesBeforeIntermediateFrame + 1);

    nativeSeeking = false;
    act(() => video.dispatchEvent(new Event('seeked')));
    await waitFor(() => expect(canvas.dataset.osgFrameRevision).toBe('2'));
    expect(captureVideoFrame).toHaveBeenCalledTimes(capturesBeforeIntermediateFrame + 2);
    expect(canvas.dataset.osgSourceMediaTime).toBe('');
    expect(canvas.dataset.osgTransportTime).toBe('2.8');
    expect(canvas.dataset.osgSourceClockProvenance).toBe('settled-transport');
    expect(canvas.dataset.osgSceneTime).toBe('2.8');

    const settledRevision = canvas.dataset.osgFrameRevision;
    await fireFrame(5, 2.5);
    expect(canvas.dataset.osgFrameRevision).toBe(settledRevision);
    expect(canvas.dataset.osgSourceMediaTime).toBe('');
    expect(canvas.dataset.osgTransportTime).toBe('2.8');
    expect(canvas.dataset.osgSourceClockProvenance).toBe('settled-transport');

    const revisionBeforeReactCatchesUp = canvas.dataset.osgFrameRevision;
    rerender(<CanvasVideoPreview {...baseProps} currentTime={currentTime} seeking={false} />);
    expect(canvas.dataset.osgFrameRevision).toBe(revisionBeforeReactCatchesUp);
    expect(canvas.dataset.osgSceneTime).toBe('2.8');
  });

  it('defers a PLAYING seek to the next presented frame instead of snapshotting the element', async () => {
    // drawImage at the settled boundary of a playing seek can legally hand back the transitioning
    // decoder surface as solid black — the one-frame flash the continuity witness caught. The
    // presentation loop delivers a real decoded frame immediately, so a playing seeked must not
    // snapshot; the held pre-seek composition covers the gap.
    spoofWindowsChrome();
    installReadyManagedFont();
    let currentTime = 2.0;
    let readyState = 4;
    let nativeSeeking = false;
    let callbackSequence = 0;
    const callbacks = new Map();
    const video = document.createElement('video');
    Object.defineProperties(video, {
      currentTime: { configurable: true, get: () => currentTime },
      readyState: { configurable: true, get: () => readyState },
      seeking: { configurable: true, get: () => nativeSeeking },
      paused: { configurable: true, value: false },
      requestVideoFrameCallback: {
        configurable: true,
        value: vi.fn((callback) => {
          callbackSequence += 1;
          callbacks.set(callbackSequence, callback);
          return callbackSequence;
        }),
      },
      cancelVideoFrameCallback: { configurable: true, value: vi.fn() },
    });
    const fireLatestFrame = async (mediaTime) => {
      const handle = [...callbacks.keys()].at(-1);
      const callback = callbacks.get(handle);
      callbacks.delete(handle);
      await act(async () => callback(performance.now(), { mediaTime, presentedFrames: handle }));
    };
    const { container } = render(<CanvasVideoPreview
      videoRef={{ current: video }}
      sourceKey="playing-seek-defers"
      playing
      currentTime={currentTime}
      frameRate={30}
      customization={defaultCustomization}
      subtitles={[]}
      resolution="1080p"
    />);
    const canvas = container.querySelector('canvas');
    await waitFor(() => expect(video.requestVideoFrameCallback).toHaveBeenCalled());
    await fireLatestFrame(2.0);
    await waitFor(() => expect(canvas.dataset.osgFrameRevision).toBe('1'));

    nativeSeeking = true;
    currentTime = 0.9;
    act(() => video.dispatchEvent(new Event('seeking')));
    const capturesBeforeSeeked = captureVideoFrame.mock.calls.length;
    nativeSeeking = false;
    act(() => video.dispatchEvent(new Event('seeked')));
    // No settled snapshot for a playing element: the capture count is unchanged and the held
    // composition remains the published one.
    expect(captureVideoFrame).toHaveBeenCalledTimes(capturesBeforeSeeked);
    expect(canvas.dataset.osgFrameRevision).toBe('1');

    await fireLatestFrame(0.9);
    await waitFor(() => expect(canvas.dataset.osgFrameRevision).toBe('2'));
    expect(canvas.dataset.osgSourceClockProvenance).toBe('rvfc');
    expect(Number(canvas.dataset.osgSourceMediaTime)).toBeCloseTo(0.9, 12);
  });

  it('rejects a black transitioning surface from the first post-seek presentation', async () => {
    // Even a presentation callback delivered just after `seeking` clears can capture the decoder
    // surface as solid black. The first capture of a seek generation runs one bounded readback;
    // a black result is dropped so the NEXT presented frame publishes instead.
    spoofWindowsChrome();
    installReadyManagedFont();
    const looksBlack = vi.fn(() => false);
    createCanvasSubtitleRenderer.mockImplementation(() => ({
      captureVideoFrame,
      captureLooksBlack: looksBlack,
      draw: drawFrame,
    }));
    let currentTime = 2.0;
    let nativeSeeking = false;
    let callbackSequence = 0;
    const callbacks = new Map();
    const video = document.createElement('video');
    Object.defineProperties(video, {
      currentTime: { configurable: true, get: () => currentTime },
      readyState: { configurable: true, value: 4 },
      seeking: { configurable: true, get: () => nativeSeeking },
      paused: { configurable: true, value: false },
      requestVideoFrameCallback: {
        configurable: true,
        value: vi.fn((callback) => {
          callbackSequence += 1;
          callbacks.set(callbackSequence, callback);
          return callbackSequence;
        }),
      },
      cancelVideoFrameCallback: { configurable: true, value: vi.fn() },
    });
    const fireLatestFrame = async (mediaTime) => {
      const handle = [...callbacks.keys()].at(-1);
      const callback = callbacks.get(handle);
      callbacks.delete(handle);
      await act(async () => callback(performance.now(), { mediaTime, presentedFrames: handle }));
    };
    const { container } = render(<CanvasVideoPreview
      videoRef={{ current: video }}
      sourceKey="black-surface-rejected"
      playing
      currentTime={currentTime}
      frameRate={30}
      customization={defaultCustomization}
      subtitles={[]}
      resolution="1080p"
    />);
    const canvas = container.querySelector('canvas');
    await waitFor(() => expect(video.requestVideoFrameCallback).toHaveBeenCalled());
    await fireLatestFrame(2.0);
    await waitFor(() => expect(canvas.dataset.osgFrameRevision).toBe('1'));

    nativeSeeking = true;
    currentTime = 0.9;
    act(() => video.dispatchEvent(new Event('seeking')));
    nativeSeeking = false;
    act(() => video.dispatchEvent(new Event('seeked')));

    // First post-seek presentation captures black: dropped, the held frame stays published.
    looksBlack.mockReturnValueOnce(true);
    await fireLatestFrame(0.9);
    expect(canvas.dataset.osgFrameRevision).toBe('1');

    // The next presentation carries real pixels and publishes.
    await fireLatestFrame(0.933);
    await waitFor(() => expect(canvas.dataset.osgFrameRevision).toBe('2'));
    expect(Number(canvas.dataset.osgSourceMediaTime)).toBeCloseTo(0.933, 12);
  });

  it('publishes genuinely black first pixels after back-to-back load events on a paused source', async () => {
    // An A->B source switch delivers `loadeddata` and `canplay` in one task burst over a paused
    // element whose first frame is legally black. The second settled boundary invalidates the
    // first's black-skip retry; its stale pending handle must not block the new generation from
    // arming its own retry, or the canvas stays blank until the customer seeks or plays.
    spoofWindowsChrome();
    installReadyManagedFont();
    const looksBlack = vi.fn(() => true);
    createCanvasSubtitleRenderer.mockImplementation(() => ({
      captureVideoFrame,
      captureLooksBlack: looksBlack,
      draw: drawFrame,
    }));
    const suppressedAnimationFrames = new Map();
    let suppressedAnimationSequence = 0;
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback) => {
      suppressedAnimationSequence += 1;
      suppressedAnimationFrames.set(suppressedAnimationSequence, callback);
      return suppressedAnimationSequence;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn(handle => suppressedAnimationFrames.delete(handle)));
    let readyState = 1;
    let callbackSequence = 0;
    const callbacks = new Map();
    const video = document.createElement('video');
    Object.defineProperties(video, {
      currentTime: { configurable: true, value: 0 },
      readyState: { configurable: true, get: () => readyState },
      seeking: { configurable: true, value: false },
      paused: { configurable: true, value: true },
      requestVideoFrameCallback: {
        configurable: true,
        value: vi.fn((callback) => {
          callbackSequence += 1;
          callbacks.set(callbackSequence, callback);
          return callbackSequence;
        }),
      },
      cancelVideoFrameCallback: {
        configurable: true,
        value: vi.fn(handle => { callbacks.delete(handle); }),
      },
    });
    const { container } = render(<CanvasVideoPreview
      videoRef={{ current: video }}
      sourceKey="paused-black-switch"
      playing={false}
      currentTime={0}
      frameRate={30}
      customization={defaultCustomization}
      subtitles={[]}
      resolution="1080p"
    />);
    const canvas = container.querySelector('canvas');

    readyState = 4;
    await act(async () => {
      video.dispatchEvent(new Event('loadeddata'));
      video.dispatchEvent(new Event('canplay'));
    });

    // Drain armed animation frames; each bounded retry may arm the next one.
    for (let round = 0; round < 6 && suppressedAnimationFrames.size > 0; round += 1) {
      const pending = [...suppressedAnimationFrames.entries()];
      for (const [handle] of pending) suppressedAnimationFrames.delete(handle);
      await act(async () => {
        for (const [, callback] of pending) callback(performance.now());
      });
    }

    // After two bounded rejections the black picture is accepted as this source's real content.
    expect(looksBlack).toHaveBeenCalled();
    expect(canvas.dataset.osgFrameRevision).toBe('1');
  });

  it('publishes only generation-current presented frames and keeps metadata time atomic with pixels', async () => {
    spoofWindowsChrome();
    installReadyManagedFont();
    // The bounded capture retry arms real animation frames; jsdom fires those on its own timer,
    // which would nondeterministically insert captures and shift this test's exact presentation
    // handle choreography. Collect them unfired so only explicit fireFrame calls advance state.
    const suppressedAnimationFrames = new Map();
    let suppressedAnimationSequence = 0;
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback) => {
      suppressedAnimationSequence += 1;
      suppressedAnimationFrames.set(suppressedAnimationSequence, callback);
      return suppressedAnimationSequence;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn(handle => suppressedAnimationFrames.delete(handle)));
    let currentTime = 0.5;
    let readyState = 1;
    let nativeSeeking = false;
    let callbackSequence = 0;
    const callbacks = new Map();
    const cancelled = [];
    const video = document.createElement('video');
    Object.defineProperties(video, {
      currentTime: { configurable: true, get: () => currentTime, set: value => { currentTime = value; } },
      readyState: { configurable: true, get: () => readyState },
      seeking: { configurable: true, get: () => nativeSeeking },
      paused: { configurable: true, value: true },
      requestVideoFrameCallback: {
        configurable: true,
        value: vi.fn((callback) => {
          callbackSequence += 1;
          callbacks.set(callbackSequence, callback);
          return callbackSequence;
        }),
      },
      cancelVideoFrameCallback: {
        configurable: true,
        value: vi.fn(handle => cancelled.push(handle)),
      },
    });
    const fireFrame = async (handle, mediaTime) => {
      const callback = callbacks.get(handle);
      expect(callback).toBeTypeOf('function');
      callbacks.delete(handle);
      await act(async () => callback(performance.now(), { mediaTime, presentedFrames: handle }));
    };
    const baseProps = {
      videoRef: { current: video },
      sourceKey: 'presented-source-a',
      playing: false,
      seeking: false,
      currentTime,
      frameRate: 30,
      customization: {
        ...defaultCustomization,
        fadeInDuration: 0,
        fadeOutDuration: 0,
      },
      subtitles: [
        { start: 0, end: 1, text: 'First presented cue' },
        // A 15 fps source can legitimately present its 2.5 s frame for a 2.8 s output-timeline
        // instant. The pixels remain source-time-owned, while subtitle selection must follow the
        // exact output scene clock just like native export does.
        { start: 2.7, end: 4, text: 'Second presented cue' },
      ],
      resolution: '1080p',
    };
    const { container, rerender } = render(<CanvasVideoPreview {...baseProps} />);
    const canvas = container.querySelector('canvas');

    // Merely arming rVFC is not a visual publication.
    await waitFor(() => expect(video.requestVideoFrameCallback).toHaveBeenCalledTimes(1));
    expect(canvas.dataset.osgFrameRevision).toBeUndefined();
    readyState = 4;
    await fireFrame(1, 0.5);
    await waitFor(() => expect(canvas.dataset.osgFrameRevision).toBe('1'));
    expect(canvas.dataset.osgSourceMediaTime).toBe('0.5');
    expect(canvas.dataset.osgSceneTime).toBe('0.5');
    expect(canvas.dataset.osgCueIndex).toBe('0');

    // React transport state and `seeked` are not decoded-frame boundaries. A canceled callback
    // delivered after a rapid seek also cannot clear or publish over the replacement callback.
    nativeSeeking = true;
    currentTime = 2.8;
    act(() => video.dispatchEvent(new Event('seeking')));
    rerender(<CanvasVideoPreview {...baseProps} currentTime={currentTime} seeking />);
    expect(cancelled).toContain(2);
    expect(canvas.dataset.osgFrameRevision).toBe('1');
    await fireFrame(2, 0.5);
    expect(canvas.dataset.osgFrameRevision).toBe('1');

    // Edge can complete a paused seek after its only replacement frame was already presented. In
    // that ordering handle 3 never fires at all; `seeked` must snapshot the settled frame, revoke
    // handle 3, and publish without waiting forever for a presentation that already happened.
    nativeSeeking = false;
    rerender(<CanvasVideoPreview {...baseProps} currentTime={currentTime} seeking={false} />);
    act(() => video.dispatchEvent(new Event('seeked')));
    await waitFor(() => expect(canvas.dataset.osgFrameRevision).toBe('2'));
    expect(cancelled).toContain(3);
    expect(canvas.dataset.osgSourceMediaTime).toBe('');
    expect(canvas.dataset.osgTransportTime).toBe('2.8');
    expect(canvas.dataset.osgSourceClockProvenance).toBe('settled-transport');
    expect(canvas.dataset.osgSceneTime).toBe('2.8');
    expect(canvas.dataset.osgCueIndex).toBe('1');

    const revisionBeforePausedPaint = Number(canvas.dataset.osgFrameRevision);
    rerender(<CanvasVideoPreview
      {...baseProps}
      currentTime={currentTime}
      customization={{ ...defaultCustomization, textColor: '#00ff00' }}
    />);
    await waitFor(() => {
      expect(Number(canvas.dataset.osgFrameRevision)).toBeGreaterThan(revisionBeforePausedPaint);
    });
    expect(canvas.dataset.osgSourceMediaTime).toBe('');
    expect(canvas.dataset.osgTransportTime).toBe('2.8');
    expect(canvas.dataset.osgSourceClockProvenance).toBe('settled-transport');

    const revisionBeforePlayingPaint = Number(canvas.dataset.osgFrameRevision);
    currentTime = 2.9;
    rerender(<CanvasVideoPreview
      {...baseProps}
      playing
      currentTime={currentTime}
      customization={{ ...defaultCustomization, textColor: '#ff0000' }}
    />);
    // A style edit repaints the last frozen source frame immediately; it does not have to wait for
    // another decoded source frame and cannot accidentally copy newer live-video pixels.
    await waitFor(() => {
      expect(Number(canvas.dataset.osgFrameRevision)).toBeGreaterThan(revisionBeforePlayingPaint);
    });
    expect(canvas.dataset.osgSourceMediaTime).toBe('');
    expect(canvas.dataset.osgTransportTime).toBe('2.8');
    expect(canvas.dataset.osgSourceClockProvenance).toBe('settled-transport');
    const revisionAfterPlayingPaint = Number(canvas.dataset.osgFrameRevision);
    await fireFrame(4, 2.9);
    await waitFor(() => {
      expect(Number(canvas.dataset.osgFrameRevision)).toBeGreaterThan(revisionAfterPlayingPaint);
    });
    expect(canvas.dataset.osgSourceMediaTime).toBe('2.9');
    expect(canvas.dataset.osgTransportTime).toBe('2.9');
    expect(canvas.dataset.osgSourceClockProvenance).toBe('rvfc');

    // An in-place optimized->original fallback can reload the element without changing sourceKey.
    // Its load boundary must revoke the prior frame before any paused style repaint.
    const revisionBeforeInPlaceLoad = Number(canvas.dataset.osgFrameRevision);
    act(() => video.dispatchEvent(new Event('loadstart')));
    rerender(<CanvasVideoPreview
      {...baseProps}
      currentTime={currentTime}
      customization={{ ...defaultCustomization, textColor: '#abcdef' }}
    />);
    expect(Number(canvas.dataset.osgFrameRevision)).toBe(revisionBeforeInPlaceLoad);
    await fireFrame(5, 2.9);
    expect(Number(canvas.dataset.osgFrameRevision)).toBe(revisionBeforeInPlaceLoad);
    await fireFrame(6, 3);
    await waitFor(() => {
      expect(Number(canvas.dataset.osgFrameRevision)).toBeGreaterThan(revisionBeforeInPlaceLoad);
    });
    expect(canvas.dataset.osgSourceMediaTime).toBe('3');

    // Switching source invalidates the old callback even if cancellation races with dispatch.
    const revisionBeforeSourceSwitch = Number(canvas.dataset.osgFrameRevision);
    rerender(<CanvasVideoPreview
      {...baseProps}
      sourceKey="presented-source-b"
      currentTime={currentTime}
      active={false}
    />);
    await fireFrame(7, 3.1);
    expect(Number(canvas.dataset.osgFrameRevision)).toBe(revisionBeforeSourceSwitch);
    await fireFrame(8, 3.1);
    expect(Number(canvas.dataset.osgFrameRevision)).toBe(revisionBeforeSourceSwitch);
    rerender(<CanvasVideoPreview
      {...baseProps}
      sourceKey="presented-source-b"
      currentTime={currentTime}
      active
    />);
    await waitFor(() => {
      expect(Number(canvas.dataset.osgFrameRevision)).toBeGreaterThan(revisionBeforeSourceSwitch);
    });
    expect(canvas.dataset.osgSourceMediaTime).toBe('3.1');
  });
});
