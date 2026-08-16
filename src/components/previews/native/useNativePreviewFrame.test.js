import { act, renderHook } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { invokeDesktop, invokeDesktopRaw } from '../../../platform/desktopRuntime';
import { GLYPH_ATLAS_VERSION } from '../../../platform/glyphAtlas';
import { createGlyphAtlasStager } from '../../../platform/glyphAtlasStaging';
import { NATIVE_PREVIEW_SCENE_VERSION } from '../../../platform/nativePreviewFrames';
import useNativePreviewFrame, { NATIVE_PREVIEW_FRAME_EXPIRED } from './useNativePreviewFrame';

/**
 * The native boundary is mocked exactly where `nativePreviewFrames.test.js` mocks it — at
 * `invokeDesktop` — so the REAL transport runs underneath this hook: real coalescing, real
 * supersession, real cancellation, real URL validation. What is instrumented on top is only
 * `close()` and `forget()`, because "released exactly once" is a claim about how many times the hook
 * calls them and cannot be observed from inside a surface that is idempotent by design.
 */
const surfaces = vi.hoisted(() => []);

vi.mock('../../../platform/desktopRuntime', async (importOriginal) => ({
  ...(await importOriginal()),
  invokeDesktop: vi.fn(),
  invokeDesktopRaw: vi.fn(),
}));

vi.mock('../../../platform/nativePreviewFrames', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createNativePreviewSurface: (options) => {
      const surface = actual.createNativePreviewSurface(options);
      const instrumented = {
        ...surface,
        close: vi.fn(surface.close),
        forget: vi.fn(surface.forget),
      };
      surfaces.push(instrumented);
      return instrumented;
    },
  };
});

const ATLAS_ID = '018f3a2b-1c4d-7e8f-9a0b-1c2d3e4f0001';
const SEQUENCE_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const SERVER_TOKEN = 'a'.repeat(64);
const FRAME_TOKEN = 'b'.repeat(64);
const PROJECT_A = '019ffbea-40eb-7c3c-b2f3-214ca260a7cc';
const PROJECT_B = '019ffbea-40eb-7c3c-b2f3-214ca260a7dd';
const MEDIA_A = '019ffbea-26d5-7800-8e3b-69de8bff2d7d';
/** Private content, so no assertion below can be satisfied by echoing the user's own text. */
const PRIVATE_TEXT = 'Bí mật';

const frameUrl = (index) => (
  `http://127.0.0.1:49152/frame/${SEQUENCE_ID}/${index}?token=${SERVER_TOKEN}&frame_token=${FRAME_TOKEN}`
);

const atlasDescriptor = () => ({
  version: GLYPH_ATLAS_VERSION,
  contentHash: 'a1b2c3d4',
  face: {
    requestedFamily: 'Editor Sans',
    weight: 400,
    style: 'normal',
    fontSizePx: 48,
    substituted: false,
    // The shaping evidence. Staging forwards it so Rust can re-derive the substitution verdict
    // rather than take the flag on trust, which means a fixture without it is not a real descriptor.
    cssFont: 'normal 400 48px "Editor Sans"',
    probes: [
      { probeFamily: 'serif', aloneWidthPx: 100, chainedWidthPx: 80, participated: true },
      { probeFamily: 'sans-serif', aloneWidthPx: 90, chainedWidthPx: 80, participated: true },
      { probeFamily: 'monospace', aloneWidthPx: 80, chainedWidthPx: 80, participated: false },
    ],
  },
  metrics: {
    ascentPx: 36, descentPx: 9, lineHeightPx: 48, baselinePx: 36,
    runAdvanceWidthPx: 120, shapingResidualPx: 0, baseDirection: 'ltr', letterSpacingPx: 0,
  },
  atlas: { widthPx: 8, heightPx: 8, paddingPx: 2, glyphCount: 1, pixelFormat: 'rgba8', bytesPerRow: 32 },
  layout: {
    textTransform: 'none',
    letterSpacingPx: 0,
    maxWidthPx: null,
    wordWrap: true,
    textAlign: 'center',
    lineCount: 1,
    widthPx: 6,
    heightPx: 48,
    cellAdvanceLayout: 'reproduces',
    refusal: { shapingCrossesClusters: false, directionNeedsBidi: false },
    lines: [{
      glyphs: [0], penXPx: [0], advanceWidthPx: 6, measuredWidthPx: 6,
      shapingResidualPx: 0, baselineYPx: 36, justificationPx: 0, endsParagraph: true,
    }],
  },
  glyphs: [{
    cluster: 'A', direction: 'ltr', advanceWidthPx: 6,
    xPx: 0, yPx: 0, widthPx: 8, heightPx: 8, originXPx: 0, originYPx: 6, substituted: false,
  }],
  pixels: new Uint8ClampedArray(8 * 8 * 4),
});

let atlas;

const seconds = (value) => ({ numerator: value, denominator: 1 });

const scene = Object.freeze({
  schemaVersion: NATIVE_PREVIEW_SCENE_VERSION,
  widthPx: 1920,
  heightPx: 1080,
  timeline: { fpsNumerator: 30, fpsDenominator: 1, frameCount: 300, start: seconds(0) },
  face: { family: 'Editor Sans', source: 'system:windows|Editor Sans|400|normal', weight: 400 },
  cues: [{ text: PRIVATE_TEXT, start: seconds(0), end: seconds(2) }],
});

const frameResponse = (request) => ({
  frameUrl: frameUrl(request.frameIndex),
  frameIndex: request.frameIndex,
  sequenceId: SEQUENCE_ID,
  mimeType: 'image/png',
  widthPx: request.scene.widthPx,
  heightPx: request.scene.heightPx,
});

const acceptFrames = () => {
  invokeDesktop.mockImplementation(async (_command, args) => frameResponse(args.request));
};

/** A compositor that has not answered yet, so coalescing and staleness are observable. */
const heldFrames = () => {
  const pending = [];
  invokeDesktop.mockImplementation((_command, args) => new Promise((resolve, reject) => {
    pending.push({ request: args.request, resolve, reject });
  }));
  return pending;
};

const flush = () => act(async () => {
  await new Promise((resolve) => { setTimeout(resolve, 0); });
});

const props = (overrides = {}) => ({
  active: true,
  projectId: PROJECT_A,
  mediaId: MEDIA_A,
  scene,
  atlas,
  frameIndex: 0,
  ...overrides,
});

/** Counts renders so "no write after release" is a measured claim rather than an absence of noise. */
const mountHook = (initialProps) => {
  const counter = { renders: 0 };
  const rendered = renderHook((hookProps) => {
    counter.renders += 1;
    return useNativePreviewFrame(hookProps);
  }, { initialProps });
  return { ...rendered, counter };
};

beforeAll(async () => {
  invokeDesktopRaw.mockResolvedValue({ atlasId: ATLAS_ID, contentHash: 'a1b2c3d4' });
  atlas = await createGlyphAtlasStager().stage(atlasDescriptor());
});

beforeEach(() => {
  invokeDesktop.mockReset();
  surfaces.length = 0;
  acceptFrames();
});

describe('requesting the frame for the current instant', () => {
  it('asks for the frame index it was given and shows what comes back', async () => {
    const { result } = mountHook(props({ frameIndex: 42 }));
    await flush();

    expect(invokeDesktop).toHaveBeenCalledTimes(1);
    expect(invokeDesktop.mock.calls[0][1].request.frameIndex).toBe(42);
    expect(result.current.status).toBe('ready');
    expect(result.current.frame.url).toBe(frameUrl(42));
    expect(result.current.frame.frameIndex).toBe(42);
  });

  it('asks again when the playhead moves, and never for a frame it was not asked for', async () => {
    const { result, rerender } = mountHook(props({ frameIndex: 10 }));
    await flush();
    rerender(props({ frameIndex: 11 }));
    await flush();

    expect(invokeDesktop.mock.calls.map(([, args]) => args.request.frameIndex)).toEqual([10, 11]);
    expect(result.current.frame.url).toBe(frameUrl(11));
  });

  it('does not request while the surface is not the one being judged', async () => {
    const { result } = mountHook(props({ active: false, frameIndex: 5 }));
    await flush();

    expect(invokeDesktop).not.toHaveBeenCalled();
    expect(result.current.status).toBe('idle');
    expect(result.current.frame).toBeNull();
  });

  it('stays idle without a project and a media to bind the request to', async () => {
    const { result } = mountHook(props({ projectId: null }));
    await flush();

    expect(surfaces).toHaveLength(0);
    expect(invokeDesktop).not.toHaveBeenCalled();
    expect(result.current.status).toBe('idle');
  });
});

describe('scrubbing', () => {
  it('coalesces, settles the superseded request, and paints only the newest frame', async () => {
    const pending = heldFrames();
    const { result, rerender } = mountHook(props({ frameIndex: 1 }));
    await flush();

    // Two renders may run at once and exactly one request waits behind them; every scrub position
    // after that supersedes the waiter rather than queueing another native render.
    for (const frameIndex of [2, 3, 4, 5]) {
      rerender(props({ frameIndex }));
      await flush();
    }
    expect(pending.map(({ request }) => request.frameIndex)).toEqual([1, 2]);

    // Finishing the two in flight lets the surviving waiter — the newest scrub position — dispatch.
    await act(async () => {
      pending[0].resolve(frameResponse(pending[0].request));
      pending[1].resolve(frameResponse(pending[1].request));
    });
    await flush();
    expect(pending.map(({ request }) => request.frameIndex)).toEqual([1, 2, 5]);

    // The superseded positions settled rather than hanging, and none of them reached the screen:
    // the surface still shows nothing, because frame 5 is the only frame anybody asked to see.
    expect(result.current.frame).toBeNull();
    expect(result.current.status).toBe('pending');

    await act(async () => {
      pending[2].resolve(frameResponse(pending[2].request));
    });
    await flush();
    expect(result.current.frame.frameIndex).toBe(5);
  });

  it('keeps the frame already on screen while the next one renders, so a scrub never blanks', async () => {
    const { result, rerender } = mountHook(props({ frameIndex: 1 }));
    await flush();
    const shown = result.current.frame;

    const pending = heldFrames();
    rerender(props({ frameIndex: 2 }));
    expect(result.current.status).toBe('pending');
    expect(result.current.frame).toBe(shown);

    await act(async () => {
      pending[0].resolve(frameResponse(pending[0].request));
    });
    await flush();
    expect(result.current.frame.frameIndex).toBe(2);
  });
});

describe('release', () => {
  it('closes the surface exactly once on unmount and writes nothing afterwards', async () => {
    const pending = heldFrames();
    const { unmount, counter } = mountHook(props({ frameIndex: 3 }));
    await flush();

    expect(surfaces).toHaveLength(1);
    unmount();
    expect(surfaces[0].close).toHaveBeenCalledTimes(1);

    const rendersAtRelease = counter.renders;
    await act(async () => {
      pending[0].resolve(frameResponse(pending[0].request));
    });
    await flush();

    expect(surfaces[0].close).toHaveBeenCalledTimes(1);
    expect(counter.renders).toBe(rendersAtRelease);
  });

  it('closes exactly once per surface on a project switch and drops the previous project frame', async () => {
    const pending = heldFrames();
    const { result, rerender } = mountHook(props({ frameIndex: 4 }));
    await flush();

    rerender(props({ projectId: PROJECT_B, frameIndex: 4 }));
    await flush();

    expect(surfaces).toHaveLength(2);
    expect(surfaces[0].close).toHaveBeenCalledTimes(1);
    expect(surfaces[1].close).not.toHaveBeenCalled();

    // The first project's render finishes late. It belongs to a generation that no longer exists,
    // so it must not repaint the editor that is now showing another project.
    await act(async () => {
      pending[0].resolve(frameResponse(pending[0].request));
    });
    await flush();
    expect(result.current.frame).toBeNull();

    await act(async () => {
      pending[1].resolve(frameResponse(pending[1].request));
    });
    await flush();
    expect(result.current.frame.url).toBe(frameUrl(4));
  });

  it('closes exactly once per surface when the media changes under the same project', async () => {
    heldFrames();
    const { rerender } = mountHook(props());
    await flush();
    rerender(props({ mediaId: '019ffbea-26d5-7800-8e3b-69de8bff2dee' }));
    await flush();

    expect(surfaces).toHaveLength(2);
    expect(surfaces[0].close).toHaveBeenCalledTimes(1);
  });

  it('opens a new generation when the caller releases the surface', async () => {
    const { result } = mountHook(props());
    await flush();
    await act(async () => {
      result.current.releaseSurface();
    });
    await flush();

    expect(surfaces).toHaveLength(2);
    expect(surfaces[0].close).toHaveBeenCalledTimes(1);
  });
});

describe('refusals are explained rather than shown as an empty frame', () => {
  it('reports a typed code and keeps the native message, path and text out of it', async () => {
    invokeDesktop.mockRejectedValue({
      code: 'previewSceneRefused',
      message: `C:\\Users\\owner\\AppData\\osg\\preview.png rejected ${PRIVATE_TEXT}`,
    });
    const { result } = mountHook(props());
    await flush();

    expect(result.current.status).toBe('error');
    expect(result.current.frame).toBeNull();
    expect(result.current.error).toEqual({ code: 'nativePreviewRejected', nativeCode: 'previewSceneRefused' });
    const reported = JSON.stringify(result.current.error);
    expect(reported).not.toContain(PRIVATE_TEXT);
    expect(reported).not.toContain('AppData');
  });

  it('reports a scene the transport refuses before any native call', async () => {
    const { result } = mountHook(props({ frameIndex: 9_999 }));
    await flush();

    expect(invokeDesktop).not.toHaveBeenCalled();
    expect(result.current.status).toBe('error');
    expect(result.current.error.code).toBe('nativePreviewInvalidRequest');
  });

  it('releases the surface once when the device is lost and does not reopen it against the same device', async () => {
    invokeDesktop.mockRejectedValue({ code: 'deviceLost' });
    const { result, rerender } = mountHook(props({ frameIndex: 1 }));
    await flush();

    expect(result.current.error).toEqual({ code: 'nativePreviewRejected', nativeCode: 'deviceLost' });
    expect(surfaces).toHaveLength(1);
    expect(surfaces[0].close).toHaveBeenCalledTimes(1);

    // Scrubbing on a lost device must not become a release/reopen loop.
    const attempts = invokeDesktop.mock.calls.length;
    rerender(props({ frameIndex: 2 }));
    await flush();
    expect(surfaces).toHaveLength(1);
    expect(invokeDesktop).toHaveBeenCalledTimes(attempts);
  });

  it('reopens after a device loss when the binding changes, without being asked to retry', async () => {
    invokeDesktop.mockRejectedValue({ code: 'deviceLost' });
    const { rerender } = mountHook(props());
    await flush();
    expect(surfaces).toHaveLength(1);

    acceptFrames();
    rerender(props({ projectId: PROJECT_B }));
    await flush();

    expect(surfaces).toHaveLength(2);
    expect(surfaces[0].close).toHaveBeenCalledTimes(1);
  });
});

describe('a frame URL the native registry no longer serves', () => {
  it('forgets it and asks once more, then reports rather than polling', async () => {
    const { result } = mountHook(props({ frameIndex: 6 }));
    await flush();
    const { cacheKey } = result.current.frame;

    await act(async () => {
      result.current.onFrameLoadError();
    });
    await flush();

    expect(surfaces[0].forget).toHaveBeenCalledWith(cacheKey);
    expect(invokeDesktop).toHaveBeenCalledTimes(2);
    expect(result.current.frame.url).toBe(frameUrl(6));

    await act(async () => {
      result.current.onFrameLoadError();
    });
    await flush();

    expect(invokeDesktop).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe('error');
    expect(result.current.error).toEqual({ code: NATIVE_PREVIEW_FRAME_EXPIRED, nativeCode: null });
  });
});
