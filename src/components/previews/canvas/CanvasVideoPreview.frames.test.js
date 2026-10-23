// Canvas preview: rVFC/output-grid clocks, paused-frame publication and bounded capture retry.
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

describe('canvas preview decoded-frame publication', () => {
  it('ticks the output scene at 30 fps over frozen 15 fps source frames', async () => {
    spoofWindowsChrome();
    installReadyManagedFont();
    let currentTime = 0;
    let readyState = 1;
    let callbackSequence = 0;
    let captureSequence = 0;
    const videoCallbacks = new Map();
    const animationCallbacks = new Map();
    let animationSequence = 0;
    captureVideoFrame.mockImplementation(() => ({ frozen: ++captureSequence }));
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback) => {
      animationSequence += 1;
      animationCallbacks.set(animationSequence, callback);
      return animationSequence;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn(handle => animationCallbacks.delete(handle)));
    const video = document.createElement('video');
    Object.defineProperties(video, {
      currentTime: { configurable: true, get: () => currentTime },
      readyState: { configurable: true, get: () => readyState },
      seeking: { configurable: true, value: false },
      paused: { configurable: true, value: false },
      requestVideoFrameCallback: {
        configurable: true,
        value: vi.fn((callback) => {
          callbackSequence += 1;
          videoCallbacks.set(callbackSequence, callback);
          return callbackSequence;
        }),
      },
      cancelVideoFrameCallback: { configurable: true, value: vi.fn() },
    });
    const fireVideoFrame = async (handle, mediaTime) => {
      const callback = videoCallbacks.get(handle);
      videoCallbacks.delete(handle);
      await act(async () => callback(performance.now(), { mediaTime, presentedFrames: handle }));
    };
    const fireAnimationFrame = async () => {
      const handle = [...animationCallbacks.keys()].at(-1);
      const callback = animationCallbacks.get(handle);
      animationCallbacks.delete(handle);
      await act(async () => callback(performance.now()));
    };

    const { container } = render(<CanvasVideoPreview
      videoRef={{ current: video }}
      sourceKey="two-clock-playback"
      playing
      currentTime={0}
      frameRate={30}
      customization={defaultCustomization}
      subtitles={[]}
      resolution="1080p"
    />);
    const canvas = container.querySelector('canvas');
    await waitFor(() => expect(video.requestVideoFrameCallback).toHaveBeenCalledTimes(1));
    readyState = 4;
    await fireVideoFrame(1, 0);
    await waitFor(() => expect(canvas.dataset.osgFrameRevision).toBe('1'));
    const firstFrozenSource = drawFrame.mock.calls.at(-1)[0].video;
    expect(canvas.dataset.osgSourceMediaTime).toBe('0');
    expect(canvas.dataset.osgSceneTime).toBe('0');

    currentTime = 1 / 30;
    await fireAnimationFrame();
    await waitFor(() => expect(canvas.dataset.osgFrameRevision).toBe('2'));
    expect(drawFrame.mock.calls.at(-1)[0].video).toBe(firstFrozenSource);
    expect(canvas.dataset.osgSourceMediaTime).toBe('0');
    expect(Number(canvas.dataset.osgSceneTime)).toBeCloseTo(1 / 30, 12);

    currentTime = 2 / 30;
    await fireVideoFrame(2, 1 / 15);
    await waitFor(() => expect(canvas.dataset.osgFrameRevision).toBe('3'));
    expect(drawFrame.mock.calls.at(-1)[0].video).not.toBe(firstFrozenSource);
    expect(Number(canvas.dataset.osgSourceMediaTime)).toBeCloseTo(1 / 15, 12);
    expect(Number(canvas.dataset.osgSceneTime)).toBeCloseTo(2 / 30, 12);
  });

  it('re-arms the rVFC chain and surfaces the failure when a frame publish throws', async () => {
    // captureCandidate already guards the decoder read, but publishCandidate (and the draw() it
    // triggers) was not exception-guarded. An unconditional `schedule()` after unguarded work means
    // any throw there permanently disarmed the self-perpetuating rVFC chain: the canvas would freeze
    // while the transport clock and seek bar kept advancing underneath it. This proves the chain
    // re-arms after a throw (a) and that the failure reaches published state instead of vanishing (b).
    spoofWindowsChrome();
    installReadyManagedFont();
    // Only the rVFC chain may publish here. jsdom's requestAnimationFrame is a real ~16 ms timer, so
    // under load the bounded capture retry could otherwise publish between `readyState = 4` and
    // the first fired frame and make this test timing-dependent.
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0);
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    let readyState = 1;
    let callbackSequence = 0;
    const videoCallbacks = new Map();
    const video = document.createElement('video');
    Object.defineProperties(video, {
      currentTime: { configurable: true, value: 0.5 },
      readyState: { configurable: true, get: () => readyState },
      seeking: { configurable: true, value: false },
      paused: { configurable: true, value: false },
      requestVideoFrameCallback: {
        configurable: true,
        value: vi.fn((callback) => {
          callbackSequence += 1;
          videoCallbacks.set(callbackSequence, callback);
          return callbackSequence;
        }),
      },
      cancelVideoFrameCallback: {
        configurable: true,
        value: vi.fn(handle => videoCallbacks.delete(handle)),
      },
    });
    const fireVideoFrame = async (handle, mediaTime) => {
      const callback = videoCallbacks.get(handle);
      videoCallbacks.delete(handle);
      await act(async () => callback(performance.now(), { mediaTime, presentedFrames: handle }));
    };

    // The renderer's draw call throws exactly once, simulating a canvas/atlas failure mid-publish.
    drawFrame.mockImplementationOnce(() => {
      throw new Error('renderer draw exploded mid-frame');
    });

    const states = [];
    const { container } = render(<CanvasVideoPreview
      videoRef={{ current: video }}
      sourceKey="rvfc-throws-once"
      playing
      currentTime={0.5}
      frameRate={30}
      customization={defaultCustomization}
      subtitles={[]}
      resolution="1080p"
      onStateChange={state => states.push(state)}
    />);
    const canvas = container.querySelector('canvas');
    await waitFor(() => expect(video.requestVideoFrameCallback).toHaveBeenCalledTimes(1));
    readyState = 4;

    // Without the try/finally fix, this throw escapes the rVFC callback entirely: `schedule()`
    // never runs again, `requestVideoFrameCallback` is never called a second time, and the test
    // fails either on the re-arm assertion below or on an unhandled rejection from this very call.
    await fireVideoFrame(1, 0.5);
    expect(canvas.dataset.osgFrameRevision ?? '0').toBe('0');

    // (b) the failure is visible in the published state, not swallowed.
    await waitFor(() => expect(states).toContainEqual({
      status: 'error', code: 'canvasPreviewRejected', retryable: true,
    }));

    // (a) the chain re-armed itself and a subsequent frame still publishes normally.
    await waitFor(() => expect(video.requestVideoFrameCallback).toHaveBeenCalledTimes(2));
    await fireVideoFrame(2, 0.533);
    await waitFor(() => expect(canvas.dataset.osgFrameRevision).toBe('1'));
    expect(states.at(-1)).toEqual({ status: 'empty', code: null });
  });

  it('publishes the settled first frame when a paused element loads after rVFC was armed', async () => {
    // The only presentation of a paused element can predate the armed callback (and an occluded
    // surface may never composite another), so `loadeddata` on a settled paused element must use
    // the settled-snapshot publication instead of waiting forever: a customer opening Render on a
    // paused project saw a permanently idle preview.
    spoofWindowsChrome();
    installReadyManagedFont();
    let readyState = 1;
    let callbackSequence = 0;
    const videoCallbacks = new Map();
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
          videoCallbacks.set(callbackSequence, callback);
          return callbackSequence;
        }),
      },
      cancelVideoFrameCallback: {
        configurable: true,
        value: vi.fn(handle => videoCallbacks.delete(handle)),
      },
    });
    const states = [];
    const { container } = render(<CanvasVideoPreview
      videoRef={{ current: video }}
      sourceKey="paused-load-settles"
      currentTime={0}
      frameRate={30}
      customization={defaultCustomization}
      subtitles={[]}
      resolution="1080p"
      onStateChange={state => states.push(state)}
    />);
    const canvas = container.querySelector('canvas');
    await waitFor(() => expect(video.requestVideoFrameCallback).toHaveBeenCalled());
    expect(canvas.dataset.osgFrameRevision ?? '0').toBe('0');

    readyState = 4;
    await act(async () => video.dispatchEvent(new Event('loadeddata')));
    await waitFor(() => expect(canvas.dataset.osgFrameRevision).toBe('1'));
    expect(states.at(-1)).toEqual({ status: 'empty', code: null });
  });

  it('arms the bounded capture retry when a scene draw runs before any frame was captured', async () => {
    // The deeper net for the same wedge: a repaint with no presentation clock and no prior frame
    // used to return bare, freezing the published state at whatever it was. While the paused
    // element is settled it must instead arm the bounded snapshot retry.
    spoofWindowsChrome();
    installReadyManagedFont();
    const animationCallbacks = new Map();
    let animationSequence = 0;
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback) => {
      animationSequence += 1;
      animationCallbacks.set(animationSequence, callback);
      return animationSequence;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn(handle => animationCallbacks.delete(handle)));
    let readyState = 1;
    const video = document.createElement('video');
    Object.defineProperties(video, {
      currentTime: { configurable: true, value: 0 },
      readyState: { configurable: true, get: () => readyState },
      seeking: { configurable: true, value: false },
      paused: { configurable: true, value: true },
      requestVideoFrameCallback: { configurable: true, value: vi.fn(() => 1) },
      cancelVideoFrameCallback: { configurable: true, value: vi.fn() },
    });
    const { container } = render(<CanvasVideoPreview
      videoRef={{ current: video }}
      sourceKey="silent-settle-retry"
      currentTime={0}
      frameRate={30}
      customization={defaultCustomization}
      subtitles={[]}
      resolution="1080p"
    />);
    const canvas = container.querySelector('canvas');
    await waitFor(() => expect(video.requestVideoFrameCallback).toHaveBeenCalled());

    // The element settles without any media event or presentation callback reaching the preview.
    readyState = 4;
    animationCallbacks.clear();
    await act(async () => window.dispatchEvent(new Event('resize')));
    await waitFor(() => expect(animationCallbacks.size).toBeGreaterThan(0));

    const handle = [...animationCallbacks.keys()].at(-1);
    const retry = animationCallbacks.get(handle);
    animationCallbacks.delete(handle);
    await act(async () => retry(performance.now()));
    await waitFor(() => expect(canvas.dataset.osgFrameRevision).toBe('1'));
  });

  it('wakes a paused preview when the video publishes its first decoded frame', async () => {
    spoofWindowsChrome();
    installReadyManagedFont();
    const video = document.createElement('video');
    let readyState = 1;
    Object.defineProperties(video, {
      currentTime: { configurable: true, value: 0.5, writable: true },
      readyState: { configurable: true, get: () => readyState },
      seeking: { configurable: true, value: false },
    });
    const readyResult = {
      drewVideo: true,
      overlayRebuilt: true,
      viewport: { left: 0, top: 0, width: 1_920, height: 1_080 },
    };
    drawFrame.mockImplementation(({ video: source }) => (
      source.readyState >= 2
        ? readyResult
        : { ...readyResult, drewVideo: false, overlayRebuilt: false }
    ));
    const onStateChange = vi.fn();
    render(
      <CanvasVideoPreview
        videoRef={{ current: video }}
        sourceKey="paused-first-decoded-frame"
        customization={defaultCustomization}
        subtitles={[{ start: 0, end: 1, text: 'Wake on loaded data' }]}
        resolution="1080p"
        onStateChange={onStateChange}
      />,
    );

    await waitFor(() => expect(onStateChange).toHaveBeenCalledWith({
      status: 'source-loading', code: null,
    }));
    const drawsBeforeData = drawFrame.mock.calls.length;
    readyState = 2;
    act(() => video.dispatchEvent(new Event('loadeddata')));
    await waitFor(() => expect(drawFrame.mock.calls.length).toBeGreaterThan(drawsBeforeData));
    await waitFor(() => expect(onStateChange).toHaveBeenCalledWith({ status: 'ready', code: null }));
  });

  it('publishes an already-presented paused frame without waiting for a future callback', async () => {
    spoofWindowsChrome();
    installReadyManagedFont();
    let callbackSequence = 0;
    const callbacks = new Map();
    const video = document.createElement('video');
    Object.defineProperties(video, {
      currentTime: { configurable: true, value: 1.25, writable: true },
      readyState: { configurable: true, value: 4 },
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
      cancelVideoFrameCallback: { configurable: true, value: vi.fn() },
    });

    const { container } = render(<CanvasVideoPreview
      videoRef={{ current: video }}
      sourceKey="already-presented-paused-source"
      playing={false}
      currentTime={1.25}
      frameRate={30}
      customization={defaultCustomization}
      subtitles={[]}
      resolution="1080p"
    />);
    const canvas = container.querySelector('canvas');

    await waitFor(() => expect(canvas.dataset.osgFrameRevision).toBe('1'));
    expect(captureVideoFrame).toHaveBeenCalledWith(video, null);
    expect(canvas.dataset.osgSourceMediaTime).toBe('');
    expect(canvas.dataset.osgTransportTime).toBe('1.25');
    expect(canvas.dataset.osgSourceClockProvenance).toBe('settled-transport');
    expect(Number(canvas.dataset.osgSceneTime)).toBeCloseTo(1.2333333333333334, 12);
    expect(video.requestVideoFrameCallback).toHaveBeenCalledTimes(1);
    expect(callbacks.size).toBe(1);
  });

  it('does not claim outgoing pixels while no playback source is committed', async () => {
    spoofWindowsChrome();
    installReadyManagedFont();
    const video = document.createElement('video');
    Object.defineProperties(video, {
      currentTime: { configurable: true, value: 4, writable: true },
      readyState: { configurable: true, value: 4 },
      seeking: { configurable: true, value: false },
      paused: { configurable: true, value: true },
      requestVideoFrameCallback: { configurable: true, value: vi.fn(() => 1) },
      cancelVideoFrameCallback: { configurable: true, value: vi.fn() },
    });
    const props = {
      videoRef: { current: video },
      sourceKey: null,
      playing: false,
      currentTime: 4,
      frameRate: 30,
      customization: defaultCustomization,
      subtitles: [],
      resolution: '1080p',
    };
    const { container, rerender } = render(<CanvasVideoPreview {...props} />);
    const canvas = container.querySelector('canvas');

    await act(async () => Promise.resolve());
    expect(captureVideoFrame).not.toHaveBeenCalled();
    expect(video.requestVideoFrameCallback).not.toHaveBeenCalled();
    expect(canvas.dataset.osgFrameRevision).toBeUndefined();

    rerender(<CanvasVideoPreview {...props} sourceKey="committed-source-b" />);
    await waitFor(() => expect(canvas.dataset.osgFrameRevision).toBe('1'));
    expect(captureVideoFrame).toHaveBeenCalledWith(video, null);
  });

  it('recaptures an already-presented paused frame after a renderer retry', async () => {
    spoofWindowsChrome();
    installReadyManagedFont();
    createCanvasSubtitleRenderer.mockImplementationOnce(() => {
      throw new Error('canvasPreviewUnavailable');
    });
    const video = document.createElement('video');
    Object.defineProperties(video, {
      currentTime: { configurable: true, value: 1.25, writable: true },
      readyState: { configurable: true, value: 4 },
      seeking: { configurable: true, value: false },
      paused: { configurable: true, value: true },
      requestVideoFrameCallback: { configurable: true, value: vi.fn(() => 1) },
      cancelVideoFrameCallback: { configurable: true, value: vi.fn() },
    });
    const onStateChange = vi.fn();
    const props = {
      videoRef: { current: video },
      sourceKey: 'renderer-retry-paused-source',
      playing: false,
      currentTime: 1.25,
      frameRate: 30,
      customization: defaultCustomization,
      subtitles: [],
      resolution: '1080p',
      onStateChange,
      retryToken: 0,
    };
    const { container, rerender } = render(<CanvasVideoPreview {...props} />);
    const canvas = container.querySelector('canvas');

    await waitFor(() => expect(onStateChange).toHaveBeenCalledWith({
      status: 'error', code: 'canvasPreviewUnavailable', retryable: true,
    }));
    expect(canvas.dataset.osgFrameRevision).toBeUndefined();

    rerender(<CanvasVideoPreview {...props} retryToken={1} />);
    await waitFor(() => expect(canvas.dataset.osgFrameRevision).toBe('1'));
    expect(canvas.dataset.osgSourceMediaTime).toBe('');
    expect(canvas.dataset.osgTransportTime).toBe('1.25');
    expect(canvas.dataset.osgSourceClockProvenance).toBe('settled-transport');
    expect(onStateChange).toHaveBeenCalledWith({ status: 'empty', code: null });
  });

  it('retries a transient frozen-frame capture without disarming paused observation', async () => {
    spoofWindowsChrome();
    installReadyManagedFont();
    let animationHandle = 0;
    const animationCallbacks = new Map();
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback) => {
      animationHandle += 1;
      animationCallbacks.set(animationHandle, callback);
      return animationHandle;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn(handle => animationCallbacks.delete(handle)));
    captureVideoFrame
      .mockImplementationOnce(() => { throw new DOMException('decoder transition', 'InvalidStateError'); })
      .mockImplementation(video => video);
    const video = document.createElement('video');
    Object.defineProperties(video, {
      currentTime: { configurable: true, value: 1.25, writable: true },
      readyState: { configurable: true, value: 4 },
      seeking: { configurable: true, value: false },
      paused: { configurable: true, value: true },
      requestVideoFrameCallback: { configurable: true, value: vi.fn(() => 1) },
      cancelVideoFrameCallback: { configurable: true, value: vi.fn() },
    });
    const onStateChange = vi.fn();
    const { container } = render(<CanvasVideoPreview
      videoRef={{ current: video }}
      sourceKey="transient-capture-source"
      playing={false}
      currentTime={1.25}
      frameRate={30}
      customization={defaultCustomization}
      subtitles={[]}
      resolution="1080p"
      onStateChange={onStateChange}
    />);
    const canvas = container.querySelector('canvas');

    expect(canvas.dataset.osgFrameRevision).toBeUndefined();
    expect(animationCallbacks.size).toBe(1);
    const retry = animationCallbacks.values().next().value;
    animationCallbacks.clear();
    await act(async () => retry(performance.now()));

    await waitFor(() => expect(canvas.dataset.osgFrameRevision).toBe('1'));
    expect(captureVideoFrame).toHaveBeenCalledTimes(2);
    expect(onStateChange).toHaveBeenCalledWith({ status: 'empty', code: null });
    expect(onStateChange).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }));
  });
});
