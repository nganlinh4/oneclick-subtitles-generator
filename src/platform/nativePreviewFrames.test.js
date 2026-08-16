import { invokeDesktop, invokeDesktopRaw } from './desktopRuntime';
import { GLYPH_ATLAS_VERSION } from './glyphAtlas';
import { createGlyphAtlasStager } from './glyphAtlasStaging';
import {
  NATIVE_PREVIEW_ERROR_CODES,
  NATIVE_PREVIEW_FRAME_COMMAND,
  NATIVE_PREVIEW_LIMITS,
  NATIVE_PREVIEW_OUTCOMES,
  NATIVE_PREVIEW_SCENE_VERSION,
  NativePreviewFrameError,
  createNativePreviewSurface,
  prepareNativePreviewRequest,
} from './nativePreviewFrames';

/**
 * The atlas handle under test is minted by the real stager, so this suite proves the transport
 * against the same brand the renderer will actually receive rather than a hand-written stand-in.
 * The atlas *contents* are irrelevant here — this module never reads a pixel — so the descriptor is
 * the smallest one `glyphAtlasStaging` accepts.
 *
 * `importOriginal` keeps `DESKTOP_RUNTIME_UNAVAILABLE` and the error class real, so the
 * runtime-unavailable mapping is asserted against the bridge's own constant, not a copy of it.
 */

vi.mock('./desktopRuntime', async (importOriginal) => ({
  ...(await importOriginal()),
  invokeDesktop: vi.fn(),
  invokeDesktopRaw: vi.fn(),
}));

/** Private content used to prove no error path, and no log, ever echoes the user's subtitle text. */
const PRIVATE_TEXT = 'Bí mật';
const PRIVATE_PATH = 'C:\\Users\\owner\\AppData\\Roaming\\osg\\preview.png';

const ATLAS_ID = '018f3a2b-1c4d-7e8f-9a0b-1c2d3e4f0001';
const SEQUENCE_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const SERVER_TOKEN = 'a'.repeat(64);
const FRAME_TOKEN = 'b'.repeat(64);

const frameUrl = (index, sequenceId = SEQUENCE_ID) => (
  `http://127.0.0.1:49152/frame/${sequenceId}/${index}?token=${SERVER_TOKEN}&frame_token=${FRAME_TOKEN}`
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
    runAdvanceWidthPx: 120, shapingResidualPx: 0, baseDirection: 'ltr',
    letterSpacingPx: 0,
  },
  atlas: { widthPx: 8, heightPx: 8, paddingPx: 2, glyphCount: 1, pixelFormat: 'rgba8', bytesPerRow: 32 },
  // The authoritative layout. Staging validates it as strictly as the glyph table, so a fixture
  // without one is not a descriptor the boundary will accept.
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
      glyphs: [0],
      penXPx: [0],
      advanceWidthPx: 6,
      measuredWidthPx: 6,
      shapingResidualPx: 0,
      baselineYPx: 36,
      justificationPx: 0,
      endsParagraph: true,
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

const scene = (overrides = {}) => ({
  schemaVersion: NATIVE_PREVIEW_SCENE_VERSION,
  widthPx: 1920,
  heightPx: 1080,
  timeline: {
    fpsNumerator: 30_000,
    fpsDenominator: 1_001,
    frameCount: 300,
    start: seconds(0),
  },
  face: { family: 'Editor Sans', source: 'sha256:0f1e2d3c', weight: 400 },
  cues: [
    { text: 'Preview', start: seconds(0), end: seconds(2) },
    { text: PRIVATE_TEXT, start: seconds(2), end: seconds(4) },
  ],
  ...overrides,
});

const frameRequest = (frameIndex, overrides = {}) => ({
  scene: scene(overrides),
  atlas,
  frameIndex,
});

const frameResponse = (request, overrides = {}) => ({
  frameUrl: frameUrl(request.frameIndex),
  frameIndex: request.frameIndex,
  sequenceId: SEQUENCE_ID,
  mimeType: 'image/png',
  widthPx: request.scene.widthPx,
  heightPx: request.scene.heightPx,
  ...overrides,
});

/** Stands in for the native command: renders instantly and echoes the frame it was asked for. */
const acceptFrames = (overrides = {}) => {
  invokeDesktop.mockImplementation(async (_command, args) => frameResponse(args.request, overrides));
};

/** Stands in for a compositor that has not answered yet, so coalescing is observable. */
const heldFrames = () => {
  const pending = [];
  invokeDesktop.mockImplementation((_command, args) => new Promise((resolve, reject) => {
    pending.push({ request: args.request, resolve, reject });
  }));
  return pending;
};

/** Lets every already-queued microtask run, which is when a settled request reaches its caller. */
const flush = () => new Promise((resolve) => { setTimeout(resolve, 0); });

const observedCodes = new Set();

const rejectionOf = async (promise) => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(NativePreviewFrameError);
    observedCodes.add(error.code);
    return error;
  }
  throw new Error('expected the preview frame request to be refused');
};

beforeAll(async () => {
  invokeDesktopRaw.mockResolvedValue({ atlasId: ATLAS_ID, contentHash: 'a1b2c3d4' });
  atlas = await createGlyphAtlasStager().stage(atlasDescriptor());
});

beforeEach(() => {
  invokeDesktop.mockReset();
  acceptFrames();
});

describe('requesting one native preview frame', () => {
  it('returns an element-loadable URL and never fetches it', async () => {
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;
    try {
      const surface = createNativePreviewSurface();

      const outcome = await surface.requestFrame(frameRequest(7));

      expect(invokeDesktop).toHaveBeenCalledTimes(1);
      const [command, args] = invokeDesktop.mock.calls[0];
      expect(command).toBe(NATIVE_PREVIEW_FRAME_COMMAND);
      expect(Object.keys(args)).toEqual(['request']);
      expect(outcome).toEqual({
        status: 'ready',
        url: frameUrl(7),
        frameIndex: 7,
        widthPx: 1920,
        heightPx: 1080,
        mimeType: 'image/png',
        cacheKey: prepareNativePreviewRequest(frameRequest(7)).cacheKey,
      });
      expect(Object.isFrozen(outcome)).toBe(true);
      expect(NATIVE_PREVIEW_OUTCOMES).toContain(outcome.status);
      // The CSP forbids reaching 127.0.0.1 any way but an element load. Nothing here may fetch.
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('sends the atlas by opaque id and a canonical scene, and nothing else', async () => {
    await createNativePreviewSurface().requestFrame(frameRequest(0));

    const { request } = invokeDesktop.mock.calls[0][1];
    expect(Object.keys(request).sort()).toEqual([
      'atlasContentHash', 'atlasId', 'frameIndex', 'scene', 'sceneRevision',
    ]);
    expect(request.atlasId).toBe(ATLAS_ID);
    expect(request.atlasContentHash).toBe('a1b2c3d4');
    expect(Object.keys(request.scene)).toEqual([
      'schemaVersion', 'widthPx', 'heightPx', 'timeline', 'face', 'cues',
    ]);
    // No atlas bytes cross this boundary: the atlas was staged once, by id, over the other command.
    expect(JSON.stringify(request)).not.toContain('pixels');
  });

  it('reuses a cached frame instead of rendering it twice, and seeks back to it', async () => {
    const surface = createNativePreviewSurface();

    const first = await surface.requestFrame(frameRequest(4));
    await surface.requestFrame(frameRequest(5));
    const seekedBack = await surface.requestFrame(frameRequest(4));

    expect(seekedBack).toBe(first);
    expect(invokeDesktop).toHaveBeenCalledTimes(2);
    expect(surface.stats()).toEqual({ cachedFrames: 2, inFlight: 0, waiting: false, closed: false });
  });

  it('renders again for a changed scene at the same frame index', async () => {
    const surface = createNativePreviewSurface();

    const first = await surface.requestFrame(frameRequest(0));
    const restyled = await surface.requestFrame(frameRequest(0, { widthPx: 1280, heightPx: 720 }));

    expect(restyled.cacheKey).not.toBe(first.cacheKey);
    expect(invokeDesktop).toHaveBeenCalledTimes(2);
  });

  it('drops a cached URL the caller could not load, so the next request re-renders', async () => {
    const surface = createNativePreviewSurface();
    const outcome = await surface.requestFrame(frameRequest(2));

    expect(surface.forget(outcome.cacheKey)).toBe(true);
    expect(surface.forget(outcome.cacheKey)).toBe(false);
    expect(surface.peek(outcome.cacheKey)).toBeUndefined();

    await surface.requestFrame(frameRequest(2));

    expect(invokeDesktop).toHaveBeenCalledTimes(2);
  });
});

describe('coalescing a scrub', () => {
  it('renders at most the in-flight cap and settles every superseded request', async () => {
    const pending = heldFrames();
    const surface = createNativePreviewSurface();

    const requests = Array.from({ length: 10 }, (_unused, index) => surface.requestFrame(frameRequest(index)));

    // Nine mousemoves cost two renders, not nine: two in flight and one newest request waiting.
    expect(invokeDesktop).toHaveBeenCalledTimes(NATIVE_PREVIEW_LIMITS.maxInFlight);
    expect(surface.stats()).toMatchObject({ inFlight: NATIVE_PREVIEW_LIMITS.maxInFlight, waiting: true });

    const superseded = await Promise.all(requests.slice(2, 9));
    expect(superseded.map((outcome) => outcome.status)).toEqual(Array(7).fill('superseded'));
    expect(superseded.map((outcome) => outcome.frameIndex)).toEqual([2, 3, 4, 5, 6, 7, 8]);
    // A superseded request settles rather than hanging on a render that will never happen.
    expect(superseded.every((outcome) => outcome.url === null)).toBe(true);

    pending[0].resolve(frameResponse(pending[0].request));
    await flush();

    // Only when a render finishes does the waiting request take its place.
    expect(invokeDesktop).toHaveBeenCalledTimes(3);
    expect(pending[2].request.frameIndex).toBe(9);
    pending[1].resolve(frameResponse(pending[1].request));
    pending[2].resolve(frameResponse(pending[2].request));

    await expect(requests[0]).resolves.toMatchObject({ status: 'ready', frameIndex: 0 });
    await expect(requests[9]).resolves.toMatchObject({ status: 'ready', frameIndex: 9 });
  });

  it('shares one render between callers asking for the same frame', async () => {
    const pending = heldFrames();
    const surface = createNativePreviewSurface();

    const first = surface.requestFrame(frameRequest(3));
    const second = surface.requestFrame(frameRequest(3));

    expect(invokeDesktop).toHaveBeenCalledTimes(1);
    pending[0].resolve(frameResponse(pending[0].request));

    expect(await second).toBe(await first);
  });

  it('keeps the waiting request when a newer one asks for the same frame again', async () => {
    const pending = heldFrames();
    const surface = createNativePreviewSurface({ maxInFlight: 1 });

    const rendering = surface.requestFrame(frameRequest(0));
    const waiting = surface.requestFrame(frameRequest(1));
    const sameAgain = surface.requestFrame(frameRequest(1));

    // The newest request is the one already waiting, so nothing is superseded and nothing is lost.
    expect(surface.stats()).toMatchObject({ inFlight: 1, waiting: true });
    pending[0].resolve(frameResponse(pending[0].request));
    await flush();
    pending[1].resolve(frameResponse(pending[1].request));

    await expect(rendering).resolves.toMatchObject({ status: 'ready', frameIndex: 0 });
    expect(await sameAgain).toBe(await waiting);
    expect(await waiting).toMatchObject({ status: 'ready', frameIndex: 1 });
    expect(invokeDesktop).toHaveBeenCalledTimes(2);
  });
});

describe('teardown', () => {
  it('cancels what is outstanding and never writes to the surface afterwards', async () => {
    const pending = heldFrames();
    const surface = createNativePreviewSurface({ maxInFlight: 1 });
    const { cacheKey } = prepareNativePreviewRequest(frameRequest(0));

    let settlements = 0;
    const rendering = surface.requestFrame(frameRequest(0));
    const waiting = surface.requestFrame(frameRequest(1));
    rendering.then(() => { settlements += 1; }, () => { settlements += 1; });

    surface.close();

    await expect(rendering).resolves.toEqual({ status: 'cancelled', url: null, frameIndex: 0 });
    await expect(waiting).resolves.toEqual({ status: 'cancelled', url: null, frameIndex: 1 });
    expect(surface.stats()).toEqual({ cachedFrames: 0, inFlight: 0, waiting: false, closed: true });

    // The render the native side was already doing lands after the surface is gone.
    pending[0].resolve(frameResponse(pending[0].request));
    await flush();

    expect(surface.peek(cacheKey)).toBeUndefined();
    expect(surface.stats().cachedFrames).toBe(0);
    expect(settlements).toBe(1);
    expect(invokeDesktop).toHaveBeenCalledTimes(1);
  });

  it('drops a native refusal that arrives after teardown instead of rejecting a dead caller', async () => {
    const pending = heldFrames();
    const surface = createNativePreviewSurface();
    const rendering = surface.requestFrame(frameRequest(0));

    surface.close();
    pending[0].reject(Object.assign(new Error(PRIVATE_PATH), { code: 'compositorLost' }));
    await flush();

    await expect(rendering).resolves.toMatchObject({ status: 'cancelled' });
  });

  it('refuses a request made after teardown, and closes idempotently', async () => {
    const surface = createNativePreviewSurface();
    surface.close();
    surface.close();

    const error = await rejectionOf(surface.requestFrame(frameRequest(0)));

    expect(error.code).toBe('nativePreviewSurfaceClosed');
    expect(invokeDesktop).not.toHaveBeenCalled();
  });
});

describe('bounds', () => {
  it('refuses a surface configured outside its own caps', () => {
    for (const options of [
      { maxInFlight: 0 },
      { maxInFlight: NATIVE_PREVIEW_LIMITS.maxInFlight + 1 },
      { maxCachedFrames: 0 },
      { maxCachedFrames: NATIVE_PREVIEW_LIMITS.maxCachedFrames + 1 },
      { maxCachedFrames: 8.5 },
    ]) {
      expect(() => createNativePreviewSurface(options)).toThrow(TypeError);
    }
  });

  it('evicts the least recently used frame once the cache bound is reached', async () => {
    const surface = createNativePreviewSurface({ maxCachedFrames: 2 });
    const evicted = await surface.requestFrame(frameRequest(0));
    const kept = await surface.requestFrame(frameRequest(1));
    await surface.requestFrame(frameRequest(1));
    await surface.requestFrame(frameRequest(2));

    expect(surface.stats().cachedFrames).toBe(2);
    expect(surface.peek(evicted.cacheKey)).toBeUndefined();
    expect(surface.peek(kept.cacheKey)).toBe(kept);

    const rerendered = await surface.requestFrame(frameRequest(0));

    expect(rerendered).not.toBe(evicted);
    expect(rerendered.cacheKey).toBe(evicted.cacheKey);
    expect(invokeDesktop).toHaveBeenCalledTimes(4);
  });

  it('measures a scene against the transport budget and refuses it before any native call', async () => {
    const text = 'x'.repeat(NATIVE_PREVIEW_LIMITS.maxCueTextBytes);
    const cues = Array.from({ length: 1_100 }, (_unused, index) => ({
      text,
      start: seconds(index),
      end: seconds(index + 1),
    }));

    // Measured, not estimated, and pinned as exact equalities so any change to the canonical scene
    // encoding has to be re-measured deliberately rather than drifting.
    const withinBudget = prepareNativePreviewRequest(frameRequest(0));
    expect(withinBudget.measurement.sceneBytes).toBe(440);
    expect(withinBudget.measurement.budgetBytes).toBe(NATIVE_PREVIEW_LIMITS.maxSceneBytes);

    const error = await rejectionOf(createNativePreviewSurface().requestFrame(frameRequest(0, { cues })));

    expect(error.code).toBe('nativePreviewSceneTooLarge');
    expect(error.measurement).toEqual({ sceneBytes: 4_609_227, budgetBytes: 4_194_304 });
    expect(invokeDesktop).not.toHaveBeenCalled();
  });

  it('refuses a frame index that is not inside the timeline', async () => {
    const surface = createNativePreviewSurface();

    for (const frameIndex of [-1, 300, 1.5, '0', Number.NaN]) {
      const error = await rejectionOf(surface.requestFrame(frameRequest(frameIndex)));
      expect(error.code).toBe('nativePreviewInvalidRequest');
    }
    expect(invokeDesktop).not.toHaveBeenCalled();
  });

  it('refuses every scene field the compositor could not render', async () => {
    const surface = createNativePreviewSurface();
    const cue = { text: 'x', start: seconds(0), end: seconds(1) };
    const cases = [
      ['schemaVersion', { schemaVersion: NATIVE_PREVIEW_SCENE_VERSION + 1 }],
      ['widthPx odd', { widthPx: 1921 }],
      ['widthPx small', { widthPx: NATIVE_PREVIEW_LIMITS.minDimensionPx - 2 }],
      ['heightPx large', { heightPx: NATIVE_PREVIEW_LIMITS.maxDimensionPx + 2 }],
      ['fpsNumerator', { timeline: { ...scene().timeline, fpsNumerator: NATIVE_PREVIEW_LIMITS.maxFpsNumerator + 1 } }],
      ['fpsDenominator', { timeline: { ...scene().timeline, fpsDenominator: NATIVE_PREVIEW_LIMITS.maxFpsDenominator + 1 } }],
      ['frameCount', { timeline: { ...scene().timeline, frameCount: NATIVE_PREVIEW_LIMITS.maxFrameCount + 1 } }],
      ['negative start', { timeline: { ...scene().timeline, start: { numerator: -1, denominator: 1 } } }],
      ['zero denominator', { timeline: { ...scene().timeline, start: { numerator: 0, denominator: 0 } } }],
      ['face weight', { face: { family: 'Editor Sans', source: 'sha256:0f1e2d3c', weight: 450 } }],
      ['face family', { face: { family: '', source: 'sha256:0f1e2d3c', weight: 400 } }],
      ['face source control character', { face: { family: 'Editor Sans', source: 'sha256\u0000', weight: 400 } }],
      ['face bytes', { face: { family: 'ê'.repeat(NATIVE_PREVIEW_LIMITS.maxFaceBytes), source: 'x', weight: 400 } }],
      ['cue count', { cues: new Array(NATIVE_PREVIEW_LIMITS.maxCues + 1).fill(cue) }],
      ['cue text bytes', { cues: [{ ...cue, text: 'x'.repeat(NATIVE_PREVIEW_LIMITS.maxCueTextBytes + 1) }] }],
      ['empty cue text', { cues: [{ ...cue, text: '' }] }],
      ['cue ends before it starts', { cues: [{ ...cue, start: seconds(2), end: seconds(1) }] }],
      ['cue ends when it starts', { cues: [{ ...cue, start: seconds(1), end: seconds(1) }] }],
      ['unordered cues', { cues: [{ ...cue, start: seconds(5), end: seconds(6) }, cue] }],
      ['unknown scene field', { extra: true }],
    ];

    for (const [label, overrides] of cases) {
      const error = await rejectionOf(surface.requestFrame(frameRequest(0, overrides)));
      expect(error.code, label).toBe('nativePreviewInvalidScene');
    }
    expect(invokeDesktop).not.toHaveBeenCalled();
  });

  it('refuses a request whose shape or atlas handle this module did not mint', async () => {
    const surface = createNativePreviewSurface();

    for (const request of [
      { scene: scene(), atlas, frameIndex: 0, extra: true },
      { scene: scene(), frameIndex: 0 },
      null,
    ]) {
      expect((await rejectionOf(surface.requestFrame(request))).code).toBe('nativePreviewInvalidRequest');
    }
    for (const forged of [{ ...atlas }, { atlasId: ATLAS_ID, contentHash: 'a1b2c3d4' }, null]) {
      const error = await rejectionOf(surface.requestFrame({ scene: scene(), atlas: forged, frameIndex: 0 }));
      expect(error.code).toBe('nativePreviewInvalidAtlas');
    }
    expect(invokeDesktop).not.toHaveBeenCalled();
  });
});

describe('refusals', () => {
  it('surfaces a native refusal as a typed error rather than a blank frame', async () => {
    invokeDesktop.mockRejectedValue(Object.assign(
      new Error(`${PRIVATE_PATH} refused "${PRIVATE_TEXT}"`),
      { code: 'atlasCellAdvanceUnsupported', command: NATIVE_PREVIEW_FRAME_COMMAND, cause: { argv: ['--secret'] } }
    ));

    const error = await rejectionOf(createNativePreviewSurface().requestFrame(frameRequest(0)));

    expect(error.code).toBe('nativePreviewRejected');
    expect(error.message).toBe('The desktop renderer did not produce the requested preview frame');
    // The native code is the only field carried across, and only because the desktop bridge has
    // already reduced it to a bounded identifier. It is what lets the UI explain the refusal.
    expect(error.nativeCode).toBe('atlasCellAdvanceUnsupported');
    expect(invokeDesktop).toHaveBeenCalledTimes(1);
  });

  it('reports an absent desktop runtime as its own condition', async () => {
    invokeDesktop.mockRejectedValue(Object.assign(new Error('nope'), { code: 'desktopRuntimeUnavailable' }));

    const error = await rejectionOf(createNativePreviewSurface().requestFrame(frameRequest(0)));

    expect(error.code).toBe('nativePreviewUnavailable');
    expect(error.nativeCode).toBeUndefined();
  });

  it('refuses a response that does not identify the frame that was asked for', async () => {
    const cases = [
      ['wrong index', { frameIndex: 1 }],
      ['wrong url index', { frameUrl: frameUrl(1) }],
      ['unknown sequence', { sequenceId: '3f2504e0-4f89-41d3-9a0c-0305e82c3302' }],
      ['non v4 sequence', { frameUrl: frameUrl(0, '018f3a2b-1c4d-7e8f-9a0b-1c2d3e4f0001'), sequenceId: '018f3a2b-1c4d-7e8f-9a0b-1c2d3e4f0001' }],
      ['wrong size', { widthPx: 1280 }],
      ['unsupported mime type', { mimeType: 'image/svg+xml' }],
      ['not a loopback frame', { frameUrl: 'https://cdn.example.com/frame/0.png' }],
      ['localhost alias', { frameUrl: frameUrl(0).replace('127.0.0.1', 'localhost') }],
      ['host suffix', { frameUrl: frameUrl(0).replace('127.0.0.1', '127.0.0.1.evil.example') }],
      ['missing credentials', { frameUrl: `http://127.0.0.1:49152/frame/${SEQUENCE_ID}/0` }],
      ['padded index', { frameUrl: frameUrl('00') }],
      ['extra field', { extra: true }],
    ];

    for (const [label, overrides] of cases) {
      acceptFrames(overrides);
      const error = await rejectionOf(createNativePreviewSurface().requestFrame(frameRequest(0)));
      expect(error.code, label).toBe('nativePreviewRejected');
      expect(error.nativeCode, label).toBeUndefined();
    }
  });

  it('does not retry a refusal, and lets the caller ask again deliberately', async () => {
    invokeDesktop.mockRejectedValue({ code: 'sceneRejected' });
    const surface = createNativePreviewSurface();

    await rejectionOf(surface.requestFrame(frameRequest(0)));
    await flush();

    expect(invokeDesktop).toHaveBeenCalledTimes(1);
    expect(surface.stats()).toEqual({ cachedFrames: 0, inFlight: 0, waiting: false, closed: false });

    await rejectionOf(surface.requestFrame(frameRequest(0)));

    expect(invokeDesktop).toHaveBeenCalledTimes(2);
  });

  it('leaks no path, no subtitle text and nothing to the console', async () => {
    const consoleSpies = ['debug', 'error', 'info', 'log', 'warn']
      .map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
    try {
      invokeDesktop.mockRejectedValue(Object.assign(
        new Error(`${PRIVATE_PATH} refused "${PRIVATE_TEXT}"`),
        { code: 'fontUnavailable', cause: { argv: ['--secret'], text: PRIVATE_TEXT } }
      ));
      const surface = createNativePreviewSurface();

      const errors = [
        await rejectionOf(surface.requestFrame(frameRequest(0))),
        await rejectionOf(surface.requestFrame(frameRequest(0, { face: { family: PRIVATE_TEXT, source: '', weight: 400 } }))),
        await rejectionOf(surface.requestFrame(frameRequest(0, { cues: [{ text: PRIVATE_TEXT, start: seconds(2), end: seconds(1) }] }))),
      ];

      for (const error of errors) {
        const exposed = `${error.message}${error.stack}${JSON.stringify(error, Object.keys(error))}`;
        expect(exposed).not.toContain(PRIVATE_TEXT);
        expect(exposed).not.toContain('C:\\');
        expect(exposed).not.toContain('argv');
        expect(error.cause).toBeUndefined();
      }
      for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of consoleSpies) spy.mockRestore();
    }
  });

  it('declares every refusal code this module can raise', () => {
    expect([...observedCodes].sort()).toEqual([...NATIVE_PREVIEW_ERROR_CODES].sort());
  });
});
