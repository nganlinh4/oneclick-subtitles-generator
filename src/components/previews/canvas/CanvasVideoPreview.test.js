import { act, render, waitFor } from '@testing-library/react';
import {
  afterEach, describe, expect, it, vi,
} from 'vitest';

import {
  FONT_READINESS_EVENT,
} from '../../../services/fontCapability';
import { MANAGED_FONT_PACKAGE } from '../../../services/fontIdentity';
import { defaultCustomization } from '../../subtitleCustomization/defaultCustomization';
import CanvasVideoPreview, {
  canvasCompositionSize,
  canvasPreviewFailure,
  previewSceneTime,
} from './CanvasVideoPreview';

const {
  bakePreviewAtlas,
  captureVideoFrame,
  createAtlasCanvas,
  createCanvasSubtitleRenderer,
  drawFrame,
  exactSystemProbe,
  previewFace,
} = vi.hoisted(() => {
  const mocks = {
    bakePreviewAtlas: vi.fn(() => ({ layout: { lines: [] } })),
    captureVideoFrame: vi.fn(video => video),
    drawFrame: vi.fn(() => ({
      drewVideo: true,
      overlayRebuilt: true,
      viewport: {
        left: 0, top: 0, width: 1_920, height: 1_080,
      },
    })),
    previewFace: vi.fn(({ capability }) => (
      capability.managedPackInstalled
        ? { family: 'Google Sans Flex', source: 'managed-ready', weight: 400 }
        : null
    )),
    exactSystemProbe: vi.fn(() => true),
    createAtlasCanvas: vi.fn(() => ({ width: 1, height: 1 })),
  };
  return {
    ...mocks,
    createCanvasSubtitleRenderer: vi.fn(() => ({
      captureVideoFrame: mocks.captureVideoFrame,
      draw: mocks.drawFrame,
    })),
  };
});

vi.mock('../../../platform/systemFontProbe', () => ({
  systemFontProbe: () => exactSystemProbe,
}));

vi.mock('../native/nativePreviewScene', async (importOriginal) => ({
  ...(await importOriginal()),
  bakePreviewAtlas,
  previewFace,
}));

vi.mock('../native/useNativePreviewSource', () => ({
  useVideoSourceDimensions: () => ({ widthPx: 640, heightPx: 360 }),
}));

vi.mock('./canvasSubtitleRenderer', () => ({
  createAtlasCanvas,
  createCanvasSubtitleRenderer,
}));

afterEach(() => {
  vi.unstubAllGlobals();
  delete window.__OSG_FONT_READINESS__;
  vi.restoreAllMocks();
  bakePreviewAtlas.mockClear();
  captureVideoFrame.mockReset();
  captureVideoFrame.mockImplementation(video => video);
  createCanvasSubtitleRenderer.mockReset();
  createCanvasSubtitleRenderer.mockImplementation(() => ({ captureVideoFrame, draw: drawFrame }));
  drawFrame.mockClear();
  previewFace.mockClear();
  createAtlasCanvas.mockReset();
  createAtlasCanvas.mockImplementation(() => ({ width: 1, height: 1 }));
});

describe('canvas preview geometry boundary', () => {
  it('classifies only recoverable browser resource failures as retryable', () => {
    expect(canvasPreviewFailure(Object.assign(new Error(), {
      code: 'glyphAtlasFaceLoading',
    }))).toEqual({ code: 'glyphAtlasFaceLoading', retryable: true });
    expect(canvasPreviewFailure(Object.assign(new Error(), {
      code: 'glyphAtlasFaceUnavailable',
    }))).toEqual({ code: 'glyphAtlasFaceUnavailable', retryable: false });
    expect(canvasPreviewFailure(Object.assign(new Error(), {
      code: 'glyphAtlasFaceSubstituted',
    }))).toEqual({ code: 'glyphAtlasFaceSubstituted', retryable: false });
  });

  it('adapts the native widthPx/heightPx contract into finite canvas dimensions', () => {
    expect(canvasCompositionSize({
      resolution: '1080p',
      sourceWidthPx: 640,
      sourceHeightPx: 360,
      crop: { width: 100, height: 100 },
    })).toEqual({ width: 1920, height: 1080 });
  });

  it('does not manufacture a canvas size when native geometry refuses the input', () => {
    expect(canvasCompositionSize({
      resolution: '1080p',
      sourceWidthPx: 0,
      sourceHeightPx: 360,
      crop: { width: 100, height: 100 },
    })).toBeNull();
  });

  it('uses the exact trimmed output grid without advancing before a frame boundary', () => {
    expect(previewSceneTime(0.05, 30, 0.01)).toBeCloseTo(0.01 + 1 / 30, 12);
    expect(previewSceneTime(1 / 30 - 0.000_001, 30, 0)).toBe(0);
    expect(previewSceneTime(1 / 30, 30, 0)).toBeCloseTo(1 / 30, 15);
  });

  it('ticks the output scene at 30 fps over frozen 15 fps source frames', async () => {
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Windows NT 10.0 Chrome');
    window.__OSG_FONT_READINESS__ = {
      schema: 1,
      state: 'ready',
      family: MANAGED_FONT_PACKAGE.family,
      epoch: 1,
      reason: null,
      retryable: false,
      version: MANAGED_FONT_PACKAGE.version,
    };
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

  it('publishes the settled first frame when a paused element loads after rVFC was armed', async () => {
    // The only presentation of a paused element can predate the armed callback (and an occluded
    // surface may never composite another), so `loadeddata` on a settled paused element must use
    // the settled-snapshot publication instead of waiting forever: a customer opening Render on a
    // paused project saw a permanently idle preview.
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Windows NT 10.0 Chrome');
    window.__OSG_FONT_READINESS__ = {
      schema: 1,
      state: 'ready',
      family: MANAGED_FONT_PACKAGE.family,
      epoch: 1,
      reason: null,
      retryable: false,
      version: MANAGED_FONT_PACKAGE.version,
    };
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
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Windows NT 10.0 Chrome');
    window.__OSG_FONT_READINESS__ = {
      schema: 1,
      state: 'ready',
      family: MANAGED_FONT_PACKAGE.family,
      epoch: 1,
      reason: null,
      retryable: false,
      version: MANAGED_FONT_PACKAGE.version,
    };
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

  it('re-resolves the preview face when native font readiness advances', async () => {
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Windows NT 10.0 jsdom');
    window.__OSG_FONT_READINESS__ = {
      schema: 1,
      state: 'repairing',
      family: MANAGED_FONT_PACKAGE.family,
      epoch: 1,
      reason: null,
      retryable: false,
      version: null,
    };
    render(
      <CanvasVideoPreview
        videoRef={{ current: null }}
        sourceKey="font-readiness-transition"
        customization={defaultCustomization}
        subtitles={[]}
        resolution="1080p"
      />,
    );
    expect(previewFace).toHaveBeenLastCalledWith(expect.objectContaining({
      capability: expect.objectContaining({ epoch: 1, managedPackInstalled: false }),
      isSystemFaceInstalled: exactSystemProbe,
    }));

    act(() => {
      window.dispatchEvent(new CustomEvent(FONT_READINESS_EVENT, {
        detail: {
          schema: 1,
          state: 'ready',
          family: MANAGED_FONT_PACKAGE.family,
          epoch: 2,
          reason: null,
          retryable: false,
          version: MANAGED_FONT_PACKAGE.version,
        },
      }));
    });
    await waitFor(() => expect(previewFace).toHaveBeenLastCalledWith(expect.objectContaining({
      capability: expect.objectContaining({ epoch: 2, managedPackInstalled: true }),
      isSystemFaceInstalled: exactSystemProbe,
    })));
  });

  it('publishes managed font preparation as a typed prerequisite and wakes when readiness advances', async () => {
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Windows NT 10.0 Chrome');
    window.__OSG_FONT_READINESS__ = {
      schema: 1,
      state: 'repairing',
      family: MANAGED_FONT_PACKAGE.family,
      epoch: 1,
      reason: null,
      retryable: false,
      version: null,
    };
    const onStateChange = vi.fn();
    render(
      <CanvasVideoPreview
        videoRef={{ current: { currentTime: 0.5, seeking: false } }}
        sourceKey="managed-font-prerequisite"
        customization={defaultCustomization}
        subtitles={[{ start: 0, end: 1, text: 'Wait for verified bytes' }]}
        resolution="1080p"
        onStateChange={onStateChange}
      />,
    );

    await waitFor(() => expect(onStateChange).toHaveBeenCalledWith({
      status: 'font-blocked', code: null,
    }));
    expect(bakePreviewAtlas).not.toHaveBeenCalled();

    act(() => {
      window.dispatchEvent(new CustomEvent(FONT_READINESS_EVENT, {
        detail: {
          schema: 1,
          state: 'ready',
          family: MANAGED_FONT_PACKAGE.family,
          epoch: 2,
          reason: null,
          retryable: false,
          version: MANAGED_FONT_PACKAGE.version,
        },
      }));
    });
    await waitFor(() => expect(bakePreviewAtlas).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onStateChange).toHaveBeenCalledWith({ status: 'ready', code: null }));
  });

  it('repaints but retains one atlas across paint, position, timing and cue-index changes', async () => {
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Windows NT 10.0 Chrome');
    window.__OSG_FONT_READINESS__ = {
      schema: 1,
      state: 'ready',
      family: MANAGED_FONT_PACKAGE.family,
      epoch: 1,
      reason: null,
      retryable: false,
      version: MANAGED_FONT_PACKAGE.version,
    };
    const videoRef = { current: { currentTime: 0.5, seeking: false } };
    const props = {
      videoRef,
      sourceKey: 'atlas-partition',
      customization: defaultCustomization,
      subtitles: [{ start: 0, end: 1, text: 'Same shaped text' }],
      resolution: '1080p',
    };
    const { container, rerender } = render(<CanvasVideoPreview {...props} />);
    await waitFor(() => expect(bakePreviewAtlas).toHaveBeenCalledTimes(1));

    const drawsBeforePaint = drawFrame.mock.calls.length;
    rerender(<CanvasVideoPreview
      {...props}
      customization={{ ...defaultCustomization, textColor: '#00ff00' }}
    />);
    await waitFor(() => expect(drawFrame.mock.calls.length).toBeGreaterThan(drawsBeforePaint));

    const drawsBeforeTiming = drawFrame.mock.calls.length;
    rerender(<CanvasVideoPreview
      {...props}
      customization={{ ...defaultCustomization, position: 'top', fadeInDuration: 0.1 }}
      subtitles={[
        { start: 0, end: 0.1, text: 'Different inactive text' },
        { start: 0.2, end: 1.25, text: 'Same shaped text' },
      ]}
    />);
    await waitFor(() => {
      expect(drawFrame.mock.calls.length).toBeGreaterThan(drawsBeforeTiming);
      expect(container.querySelector('canvas')?.dataset.osgCueIndex).toBe('1');
    });
    expect(bakePreviewAtlas).toHaveBeenCalledTimes(1);

    const changedCrop = {
      x: 1,
      y: 1,
      width: 100,
      height: 100,
      aspectRatio: null,
      canvasBgMode: 'solid',
      canvasBgColor: '#102030',
      canvasBgBlur: 24,
      flipX: true,
      flipY: false,
    };
    const drawsBeforeCrop = drawFrame.mock.calls.length;
    rerender(<CanvasVideoPreview {...props} crop={changedCrop} />);
    await waitFor(() => expect(drawFrame.mock.calls.length).toBeGreaterThan(drawsBeforeCrop));
    expect(drawFrame.mock.calls.at(-1)[0].crop).toEqual(changedCrop);
    expect(bakePreviewAtlas).toHaveBeenCalledTimes(1);

    const drawsBeforeTrim = drawFrame.mock.calls.length;
    rerender(<CanvasVideoPreview {...props} trimStart={0.75} />);
    await waitFor(() => expect(drawFrame.mock.calls.length).toBeGreaterThan(drawsBeforeTrim));
    expect(bakePreviewAtlas).toHaveBeenCalledTimes(1);

    rerender(<CanvasVideoPreview
      {...props}
      customization={{ ...defaultCustomization, fontSize: defaultCustomization.fontSize + 1 }}
    />);
    await waitFor(() => expect(bakePreviewAtlas).toHaveBeenCalledTimes(2));
  });

  it('keeps a speculative next-cue bake refusal silent until that cue is active', async () => {
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Windows NT 10.0 Chrome');
    window.__OSG_FONT_READINESS__ = {
      schema: 1,
      state: 'ready',
      family: MANAGED_FONT_PACKAGE.family,
      epoch: 1,
      reason: null,
      retryable: false,
      version: MANAGED_FONT_PACKAGE.version,
    };
    const originalBake = bakePreviewAtlas.getMockImplementation();
    bakePreviewAtlas.mockImplementation((bake) => {
      if (bake.request.text === 'The next cue cannot bake') {
        throw Object.assign(new Error('next cue refused'), { code: 'nextCueRejected' });
      }
      return { layout: { lines: [] } };
    });
    const states = [];
    const video = { currentTime: 0.5, seeking: false };
    const props = {
      videoRef: { current: video },
      sourceKey: 'prefetch-refusal-ownership',
      customization: defaultCustomization,
      subtitles: [
        { start: 0, end: 1, text: 'The visible cue is valid' },
        { start: 2, end: 3, text: 'The next cue cannot bake' },
      ],
      resolution: '1080p',
      currentTime: 0.5,
      onStateChange: state => states.push(state),
    };

    try {
      const { rerender } = render(<CanvasVideoPreview {...props} />);
      await waitFor(() => expect(bakePreviewAtlas).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(states.at(-1)).toEqual({ status: 'ready', code: null }));
      expect(states).not.toContainEqual({ status: 'error', code: 'nextCueRejected' });

      video.currentTime = 2.5;
      rerender(<CanvasVideoPreview {...props} currentTime={2.5} />);
      await waitFor(() => expect(states.at(-1)).toEqual({
        status: 'error',
        code: 'nextCueRejected',
        retryable: false,
      }));
    } finally {
      bakePreviewAtlas.mockImplementation(originalBake);
    }
  });

  it('retries only a transient canvas allocation failure when the surface requests it', async () => {
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Windows NT 10.0 Chrome');
    window.__OSG_FONT_READINESS__ = {
      schema: 1,
      state: 'ready',
      family: MANAGED_FONT_PACKAGE.family,
      epoch: 1,
      reason: null,
      retryable: false,
      version: MANAGED_FONT_PACKAGE.version,
    };
    createAtlasCanvas.mockImplementationOnce(() => {
      throw new Error('canvasPreviewUnavailable');
    });
    const onStateChange = vi.fn();
    const videoRef = { current: { currentTime: 0.5, seeking: false } };
    const props = {
      videoRef,
      sourceKey: 'retryable-canvas',
      customization: defaultCustomization,
      subtitles: [{ start: 0, end: 1, text: 'Retry me once' }],
      resolution: '1080p',
      onStateChange,
      retryToken: 0,
    };
    const { rerender } = render(<CanvasVideoPreview {...props} />);

    await waitFor(() => expect(onStateChange).toHaveBeenCalledWith({
      status: 'error', code: 'canvasPreviewUnavailable', retryable: true,
    }));
    expect(bakePreviewAtlas).toHaveBeenCalledTimes(1);

    rerender(<CanvasVideoPreview {...props} retryToken={1} />);
    await waitFor(() => expect(bakePreviewAtlas).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(onStateChange).toHaveBeenCalledWith({ status: 'ready', code: null }));
  });

  it('automatically retries a face-loading race when FontFaceSet activates the verified face', async () => {
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Windows NT 10.0 Chrome');
    window.__OSG_FONT_READINESS__ = {
      schema: 1,
      state: 'ready',
      family: MANAGED_FONT_PACKAGE.family,
      epoch: 1,
      reason: null,
      retryable: false,
      version: MANAGED_FONT_PACKAGE.version,
    };
    const priorFonts = Object.getOwnPropertyDescriptor(document, 'fonts');
    const fontEvents = new EventTarget();
    Object.defineProperty(document, 'fonts', { configurable: true, value: fontEvents });
    const unavailable = Object.assign(new Error('glyphAtlasFaceLoading'), {
      code: 'glyphAtlasFaceLoading',
    });
    bakePreviewAtlas.mockImplementationOnce(() => { throw unavailable; });
    const onStateChange = vi.fn();

    try {
      render(
        <CanvasVideoPreview
          videoRef={{ current: { currentTime: 0.5, seeking: false } }}
          sourceKey="font-face-loading-race"
          customization={defaultCustomization}
          subtitles={[{ start: 0, end: 1, text: 'Loaded after mount' }]}
          resolution="1080p"
          onStateChange={onStateChange}
        />,
      );
      await waitFor(() => expect(onStateChange).toHaveBeenCalledWith({
        status: 'error', code: 'glyphAtlasFaceLoading', retryable: true,
      }));

      act(() => fontEvents.dispatchEvent(new Event('loadingdone')));
      await waitFor(() => expect(bakePreviewAtlas).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(onStateChange).toHaveBeenCalledWith({ status: 'ready', code: null }));
    } finally {
      if (priorFonts === undefined) delete document.fonts;
      else Object.defineProperty(document, 'fonts', priorFonts);
    }
  });

  it('wakes a paused preview when the video publishes its first decoded frame', async () => {
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Windows NT 10.0 Chrome');
    window.__OSG_FONT_READINESS__ = {
      schema: 1,
      state: 'ready',
      family: MANAGED_FONT_PACKAGE.family,
      epoch: 1,
      reason: null,
      retryable: false,
      version: MANAGED_FONT_PACKAGE.version,
    };
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
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Windows NT 10.0 Chrome');
    window.__OSG_FONT_READINESS__ = {
      schema: 1,
      state: 'ready',
      family: MANAGED_FONT_PACKAGE.family,
      epoch: 1,
      reason: null,
      retryable: false,
      version: MANAGED_FONT_PACKAGE.version,
    };
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
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Windows NT 10.0 Chrome');
    window.__OSG_FONT_READINESS__ = {
      schema: 1,
      state: 'ready',
      family: MANAGED_FONT_PACKAGE.family,
      epoch: 1,
      reason: null,
      retryable: false,
      version: MANAGED_FONT_PACKAGE.version,
    };
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
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Windows NT 10.0 Chrome');
    window.__OSG_FONT_READINESS__ = {
      schema: 1,
      state: 'ready',
      family: MANAGED_FONT_PACKAGE.family,
      epoch: 1,
      reason: null,
      retryable: false,
      version: MANAGED_FONT_PACKAGE.version,
    };
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
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Windows NT 10.0 Chrome');
    window.__OSG_FONT_READINESS__ = {
      schema: 1,
      state: 'ready',
      family: MANAGED_FONT_PACKAGE.family,
      epoch: 1,
      reason: null,
      retryable: false,
      version: MANAGED_FONT_PACKAGE.version,
    };
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

  it('discards a during-seek frame and snapshots the settled paused source', async () => {
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Windows NT 10.0 Chrome');
    window.__OSG_FONT_READINESS__ = {
      schema: 1,
      state: 'ready',
      family: MANAGED_FONT_PACKAGE.family,
      epoch: 1,
      reason: null,
      retryable: false,
      version: MANAGED_FONT_PACKAGE.version,
    };
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
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Windows NT 10.0 Chrome');
    window.__OSG_FONT_READINESS__ = {
      schema: 1,
      state: 'ready',
      family: MANAGED_FONT_PACKAGE.family,
      epoch: 1,
      reason: null,
      retryable: false,
      version: MANAGED_FONT_PACKAGE.version,
    };
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
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Windows NT 10.0 Chrome');
    window.__OSG_FONT_READINESS__ = {
      schema: 1,
      state: 'ready',
      family: MANAGED_FONT_PACKAGE.family,
      epoch: 1,
      reason: null,
      retryable: false,
      version: MANAGED_FONT_PACKAGE.version,
    };
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

  it('publishes only generation-current presented frames and keeps metadata time atomic with pixels', async () => {
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Windows NT 10.0 Chrome');
    window.__OSG_FONT_READINESS__ = {
      schema: 1,
      state: 'ready',
      family: MANAGED_FONT_PACKAGE.family,
      epoch: 1,
      reason: null,
      retryable: false,
      version: MANAGED_FONT_PACKAGE.version,
    };
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
