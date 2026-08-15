import { v4 as uuidv4, v7 as uuidv7 } from 'uuid';

import { defaultCustomization } from '../components/subtitleCustomization/defaultCustomization';
import {
  presetOrder,
  presets,
} from '../components/subtitleCustomization/presetDefinitions';
import {
  animationEasing,
  animationTypes,
  borderStyleOptions,
  positionOptions,
  textAlignOptions,
  textTransformOptions,
} from '../components/subtitleCustomization/fontOptions';

import {
  NativeRenderError,
  buildNativeRenderRequest,
  createNativeRenderService,
  normalizeRenderEvent,
  normalizeRenderResultResponse,
  runNativeRender,
  waitForNativeRender,
} from './renderService';

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class MockTauriChannel {},
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}));

class TestChannel {
  static latest = null;

  onmessage = () => {};

  constructor() {
    TestChannel.latest = this;
  }

  emit(event) {
    this.onmessage(event);
  }
}

const createTrackedAbortSignal = ({
  initiallyAborted = false,
  abortDuringAdd = false,
  throwOnAdd = false,
  throwOnRemove = false,
  throwingGetter = null,
} = {}) => {
  let aborted = initiallyAborted;
  let abortListener = null;
  const counts = {
    abortedGets: 0,
    addGets: 0,
    removeGets: 0,
    addCalls: 0,
    removeCalls: 0,
  };
  const signal = {};
  Object.defineProperties(signal, {
    aborted: {
      enumerable: true,
      get() {
        counts.abortedGets += 1;
        if (throwingGetter === 'aborted') throw new Error('hostile aborted getter');
        return aborted;
      },
    },
    addEventListener: {
      enumerable: true,
      get() {
        counts.addGets += 1;
        if (throwingGetter === 'addEventListener') throw new Error('hostile add getter');
        return (_event, listener) => {
          counts.addCalls += 1;
          abortListener = listener;
          if (abortDuringAdd) {
            aborted = true;
            listener();
          }
          if (throwOnAdd) throw new Error('hostile add');
        };
      },
    },
    removeEventListener: {
      enumerable: true,
      get() {
        counts.removeGets += 1;
        if (throwingGetter === 'removeEventListener') throw new Error('hostile remove getter');
        return (_event, listener) => {
          counts.removeCalls += 1;
          if (throwOnRemove) throw new Error('hostile remove');
          if (abortListener === listener) abortListener = null;
        };
      },
    },
  });
  return {
    signal,
    counts,
    abort() {
      if (aborted) return;
      aborted = true;
      abortListener?.();
    },
  };
};

const sourceAsset = () => ({
  id: uuidv7(),
  displayName: 'source.mp4',
  extension: 'mp4',
  sizeBytes: 1_024,
  kind: 'video',
});

const request = () => buildNativeRenderRequest({
  sourceAsset: sourceAsset(),
  projectId: uuidv7(),
  narrationArtifactId: uuidv7(),
  lyrics: [{ id: 7, start: 0, end: 2.5, text: 'Hello' }],
  settings: {
    resolution: '1080p',
    frameRate: 30,
    originalAudioVolume: 100,
    narrationVolume: 80,
    trimStart: 0,
    trimEnd: 2.5,
  },
  customization: { ...defaultCustomization },
  crop: {
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    aspectRatio: null,
    canvasBgMode: 'solid',
    canvasBgColor: '#000000',
    canvasBgBlur: 24,
    flipX: false,
    flipY: false,
  },
});

const requestWith = ({
  lyrics = [{ id: 7, start: 0, end: 2.5, text: 'Hello' }],
  customization = { ...defaultCustomization },
  crop = {
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    aspectRatio: null,
    canvasBgMode: 'solid',
    canvasBgColor: '#000000',
    canvasBgBlur: 24,
    flipX: false,
    flipY: false,
  },
} = {}) => buildNativeRenderRequest({
  sourceAsset: sourceAsset(),
  projectId: uuidv7(),
  narrationArtifactId: uuidv7(),
  lyrics,
  settings: {
    resolution: '1080p',
    frameRate: 30,
    originalAudioVolume: 100,
    narrationVolume: 80,
    trimStart: 0,
    trimEnd: 2.5,
  },
  customization,
  crop,
});

const editorCustomizationCatalogs = Object.freeze([
  ['animationEasing', animationEasing],
  ['animationType', animationTypes],
  ['borderStyle', borderStyleOptions],
  ['position', positionOptions],
  ['textAlign', textAlignOptions],
  ['textTransform', textTransformOptions],
]);

const job = (overrides = {}) => ({
  id: uuidv7(),
  kind: 'renderVideo',
  state: 'running',
  progress: { basisPoints: 0 },
  sequence: 1,
  ...overrides,
});

const result = (overrides = {}) => {
  const playbackId = uuidv4();
  const asset = {
    id: uuidv7(),
    displayName: 'rendered-video.mp4',
    extension: 'mp4',
    sizeBytes: 4_096,
    kind: 'video',
  };
  return {
    artifactId: uuidv7(),
    asset,
    sourceAssetId: uuidv7(),
    projectId: uuidv7(),
    width: 1920,
    height: 1080,
    fps: 30,
    durationInFrames: 75,
    playback: {
      id: playbackId,
      playbackUrl: `http://127.0.0.1:49152/asset/${playbackId}?token=${'a'.repeat(64)}`,
      mimeType: 'video/mp4',
      byteLength: asset.sizeBytes,
    },
    ...overrides,
  };
};

describe('native render contract', () => {
  test.each(editorCustomizationCatalogs)(
    'accepts every editor %s catalog value',
    (field, options) => {
      for (const { value } of options) {
        expect(() => requestWith({
          customization: { ...defaultCustomization, [field]: value },
        })).not.toThrow();
      }
    },
  );

  test('accepts every shipped preset through the exact native request boundary', () => {
    expect(presetOrder).toHaveLength(30);
    for (const preset of presetOrder) {
      const nativeRequest = requestWith({ customization: presets[preset] });
      expect(nativeRequest.customization.preset).toBe(preset);
      expect(nativeRequest.customization.backgroundColor).toMatch(/^#[0-9a-f]{3,8}$/i);
    }
    expect(requestWith({
      customization: { ...defaultCustomization, preset: 'custom_1750000000000' },
    }).customization.preset).toBe('custom_1750000000000');
  });

  test('matches the native preset identity byte boundary exactly', () => {
    for (const preset of ['x'.repeat(128), `${'한'.repeat(42)}ab`]) {
      expect(requestWith({
        customization: { ...defaultCustomization, preset },
      }).customization.preset).toBe(preset);
    }
    for (const preset of ['', 'x'.repeat(129), '한'.repeat(43), 'bad\u0000preset']) {
      expect(() => requestWith({
        customization: { ...defaultCustomization, preset },
      })).toThrow(NativeRenderError);
    }
  });

  test('builds only opaque IDs and bounded visual/timing data', () => {
    const value = request();

    expect(value.lyrics[0]).toEqual({
      id: 'cue-0-7',
      startUs: 0,
      endUs: 2_500_000,
      text: 'Hello',
    });
    expect(value.settings.trimEndUs).toBe(2_500_000);
    expect(JSON.stringify(value)).not.toMatch(/(?:path|base64|localhost|playbackUrl|audioUrl)/i);
    expect(Object.keys(value)).toEqual([
      'sourceAssetId', 'projectId', 'narrationArtifactId', 'lyrics', 'settings',
      'customization', 'crop',
    ]);
  });

  test('rejects missing visual fields and unsafe timing', () => {
    expect(() => buildNativeRenderRequest({
      ...request(),
      sourceAsset: sourceAsset(),
      projectId: uuidv7(),
      lyrics: [{ start: 2, end: 1, text: 'bad' }],
      settings: {
        resolution: '1080p', frameRate: 30, originalAudioVolume: 100,
        narrationVolume: 100, trimStart: 0, trimEnd: 3,
      },
      customization: { ...defaultCustomization },
      crop: { x: 0, y: 0, width: 100, height: 100 },
    })).toThrow(NativeRenderError);

    const incomplete = { ...defaultCustomization };
    delete incomplete.fontFamily;
    expect(() => buildNativeRenderRequest({
      sourceAsset: sourceAsset(),
      projectId: uuidv7(),
      lyrics: [{ start: 0, end: 1, text: 'bad' }],
      settings: {
        resolution: '1080p', frameRate: 30, originalAudioVolume: 100,
        narrationVolume: 100, trimStart: 0, trimEnd: 1,
      },
      customization: incomplete,
      crop: { x: 0, y: 0, width: 100, height: 100 },
    })).toThrow(NativeRenderError);

    [-1, 0.5, 1].forEach((trimEnd) => {
      expect(() => buildNativeRenderRequest({
        sourceAsset: sourceAsset(),
        projectId: uuidv7(),
        lyrics: [{ start: 0, end: 1, text: 'valid cue' }],
        settings: {
          resolution: '1080p', frameRate: 30, originalAudioVolume: 100,
          narrationVolume: 100, trimStart: 1, trimEnd,
        },
        customization: { ...defaultCustomization },
        crop: { x: 0, y: 0, width: 100, height: 100 },
      })).toThrow(NativeRenderError);
    });
  });

  test('rejects media metadata Rust cannot persist or return canonically', () => {
    expect(() => buildNativeRenderRequest({
      sourceAsset: { ...sourceAsset(), extension: 'exe' },
      projectId: uuidv7(),
      lyrics: [{ start: 0, end: 1, text: 'valid cue' }],
      settings: {
        resolution: '1080p', frameRate: 30, originalAudioVolume: 100,
        narrationVolume: 100, trimStart: 0, trimEnd: 1,
      },
      customization: { ...defaultCustomization },
      crop: { x: 0, y: 0, width: 100, height: 100 },
    })).toThrow(NativeRenderError);
    expect(() => buildNativeRenderRequest({
      sourceAsset: { ...sourceAsset(), displayName: ' clip\u0000.mp4' },
      projectId: uuidv7(),
      lyrics: [{ start: 0, end: 1, text: 'valid cue' }],
      settings: {
        resolution: '1080p', frameRate: 30, originalAudioVolume: 100,
        narrationVolume: 100, trimStart: 0, trimEnd: 1,
      },
      customization: { ...defaultCustomization },
      crop: { x: 0, y: 0, width: 100, height: 100 },
    })).toThrow(NativeRenderError);

    const completedJob = job({
      state: 'succeeded',
      progress: { basisPoints: 10_000 },
      sequence: 2,
    });
    const nativeResult = result();
    expect(() => normalizeRenderResultResponse({
      job: completedJob,
      result: {
        ...nativeResult,
        asset: { ...nativeResult.asset, extension: 'MP4' },
      },
    })).toThrow(NativeRenderError);
  });

  test.each([
    ['fontSize', 0],
    ['lineHeight', 10.01],
    ['letterSpacing', -100.01],
    ['backgroundOpacity', 100.01],
    ['borderRadius', -0.01],
    ['borderWidth', 100.01],
    ['textShadowBlur', -0.01],
    ['textShadowOffsetX', 2_000.01],
    ['textShadowOffsetY', -2_000.01],
    ['glowIntensity', 1_000.01],
    ['strokeWidth', -0.01],
    ['pulseSpeed', 100.01],
    ['shakeIntensity', 1_000.01],
    ['customPositionX', -1_000.01],
    ['customPositionY', 1_000.01],
    ['marginBottom', 10_000.01],
    ['marginTop', -10_000.01],
    ['marginLeft', 10_000.01],
    ['marginRight', -10_000.01],
    ['maxWidth', 0.99],
    ['fadeInDuration', 60.01],
    ['fadeOutDuration', -0.01],
  ])('rejects customization.%s outside the Rust render bound', (field, value) => {
    expect(() => requestWith({
      customization: { ...defaultCustomization, [field]: value },
    })).toThrow(NativeRenderError);
  });

  test.each([
    ['fontWeight', 99],
    ['fontWeight', 550],
    ['fontWeight', 1_000],
    ['shadowLayers', 17],
    ['maxLines', 0],
    ['maxLines', 33],
  ])('rejects invalid integer customization.%s=%s', (field, value) => {
    expect(() => requestWith({
      customization: { ...defaultCustomization, [field]: value },
    })).toThrow(NativeRenderError);
  });

  test.each([
    ['textColor', 'red'],
    ['backgroundColor', '#12'],
    ['borderColor', '#gggggg'],
    ['textShadowColor', '#123456789'],
    ['glowColor', '#12345'],
    ['gradientColorStart', '#fffffg'],
    ['gradientColorEnd', 'transparent'],
    ['gradientColorMid', '#1234567890'],
    ['strokeColor', 'rgb(0,0,0)'],
  ])('rejects non-canonical customization color %s', (field, value) => {
    expect(() => requestWith({
      customization: { ...defaultCustomization, [field]: value },
    })).toThrow(NativeRenderError);
  });

  test('rejects invalid gradient direction and control-bearing bounded strings', () => {
    ['-1deg', '361deg', '1.5deg', ' 45deg', '45DEG'].forEach((gradientDirection) => {
      expect(() => requestWith({
        customization: { ...defaultCustomization, gradientDirection },
      })).toThrow(NativeRenderError);
    });
    expect(() => requestWith({
      customization: { ...defaultCustomization, fontFamily: 'Inter\u0000fallback' },
    })).toThrow(NativeRenderError);
    expect(() => requestWith({
      customization: { ...defaultCustomization, preset: 'default\u0085hidden' },
    })).toThrow(NativeRenderError);
    expect(() => requestWith({
      customization: { ...defaultCustomization, preset: `bad${String.fromCharCode(0xD800)}` },
    })).toThrow(NativeRenderError);
  });

  test('accepts the exact customization, crop, and color boundaries', () => {
    expect(() => requestWith({
      customization: {
        ...defaultCustomization,
        fontSize: 1_000,
        fontWeight: 900,
        lineHeight: 0.1,
        letterSpacing: -100,
        backgroundOpacity: 100,
        borderWidth: 100,
        textShadowOffsetX: -2_000,
        textShadowOffsetY: 2_000,
        shadowLayers: 16,
        maxLines: 32,
        fadeInDuration: 60,
        fadeOutDuration: 60,
        gradientDirection: '360deg',
        textAlign: 'justify',
        textColor: '#fff',
        backgroundColor: '#ffff',
        borderColor: '#ffffff',
        strokeColor: '#ffffffff',
      },
      crop: {
        x: -1_000,
        y: 1_000,
        width: 0.01,
        height: 1_000,
        aspectRatio: 100,
        canvasBgMode: 'blur',
        canvasBgColor: '#ffff',
        canvasBgBlur: 1_000,
        flipX: true,
        flipY: false,
      },
    })).not.toThrow();
  });

  test.each([
    [{ aspectRatio: 0 }, 'aspect ratio'],
    [{ aspectRatio: 100.01 }, 'aspect ratio'],
    [{ aspectRatio: '1.777' }, 'aspect ratio type'],
    [{ canvasBgColor: 'black' }, 'canvas color'],
    [{ canvasBgBlur: -1 }, 'canvas blur'],
    [{ flipX: 'false' }, 'flip X type'],
    [{ flipY: 1 }, 'flip Y type'],
  ])('rejects invalid crop %s', (override) => {
    expect(() => requestWith({
      crop: {
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        aspectRatio: null,
        canvasBgMode: 'solid',
        canvasBgColor: '#000000',
        canvasBgBlur: 24,
        flipX: false,
        flipY: false,
        ...override,
      },
    })).toThrow(NativeRenderError);
  });

  test('rejects control-bearing, malformed-Unicode, and aggregate-oversized lyrics', () => {
    expect(() => requestWith({
      lyrics: [{ id: 'bad\u0000id', start: 0, end: 1, text: 'hello' }],
    })).toThrow(NativeRenderError);
    expect(() => requestWith({
      lyrics: [{ id: 'ok', start: 0, end: 1, text: 'bad\u0001text' }],
    })).toThrow(NativeRenderError);
    expect(() => requestWith({
      lyrics: [{ id: 'ok', start: 0, end: 1, text: `bad${String.fromCharCode(0xD800)}` }],
    })).toThrow(NativeRenderError);

    const oversized = Array.from({ length: 513 }, (_, index) => ({
      id: index,
      start: 0,
      end: 1,
      text: 'x'.repeat(16 * 1024),
    }));
    expect(() => requestWith({ lyrics: oversized })).toThrow(NativeRenderError);
  });

  test('keeps newline, carriage return, tab, and valid Unicode lyrics intact', () => {
    const value = requestWith({
      lyrics: [{ id: '한글-😀', start: 0, end: 1, text: '한글\nline\r\t😀' }],
    });
    expect(value.lyrics[0].text).toBe('한글\nline\r\t😀');
  });

  test('rejects path-bearing or mismatched result/event shapes', () => {
    const completedJob = job({
      state: 'succeeded',
      progress: { basisPoints: 10_000 },
      sequence: 2,
    });
    expect(normalizeRenderResultResponse({
      job: completedJob,
      result: result(),
    }).result.asset.extension).toBe('mp4');
    expect(() => normalizeRenderResultResponse({
      job: completedJob,
      result: { ...result(), outputPath: 'C:\\private\\render.mp4' },
    })).toThrow(NativeRenderError);
    expect(() => normalizeRenderEvent({
      event: 'progress',
      job: { ...completedJob, state: 'running' },
      phase: 'remoteUpload',
      fractionMillionths: 1,
      renderedFrames: 0,
      encodedFrames: 0,
      durationInFrames: 1,
    })).toThrow(NativeRenderError);
  });

  test('snapshots hostile native response records exactly once', () => {
    let codeReads = 0;
    const error = new Proxy({ code: 'internal', message: 'ignored' }, {
      get(target, property, receiver) {
        if (property === 'code') {
          codeReads += 1;
          return 'attackerChosenCode';
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const failed = normalizeRenderEvent({
      event: 'failed',
      job: job({ state: 'failed', sequence: 2 }),
      error,
    });
    expect(failed.error).toEqual({
      code: 'internal',
      message: 'The native video render could not be completed',
    });
    expect(codeReads).toBe(0);

    const completedJob = job({
      state: 'succeeded',
      progress: { basisPoints: 10_000 },
      sequence: 2,
    });
    const nativeResult = result();
    let assetReads = 0;
    const proxiedResult = new Proxy(nativeResult, {
      get(target, property, receiver) {
        if (property === 'asset') assetReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    expect(normalizeRenderResultResponse({
      job: completedJob,
      result: proxiedResult,
    }).result.asset).toEqual(nativeResult.asset);
    expect(assetReads).toBe(0);
  });

  test('preserves safe prerequisite guidance from rejected native starts', async () => {
    const service = createNativeRenderService({
      invokeCommand: vi.fn(async (command) => {
        if (command === 'render_runtime_status') {
          return {
            available: false,
            remotionVersion: '4.0.507',
            reason: 'runtimePayloadUnavailable',
            maxConcurrentRenders: 1,
          };
        }
        if (command === 'render_start') {
          throw {
            code: 'renderRuntimeUnavailable',
            message: 'The verified native Remotion runtime is not installed for this platform.',
          };
        }
        throw new Error('unexpected command');
      }),
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });

    await expect(service.status()).resolves.toMatchObject({
      available: false,
      reason: 'runtimePayloadUnavailable',
    });
    await expect(service.start(request(), {})).rejects.toMatchObject({
      code: 'renderRuntimeUnavailable',
      message: 'Install the Remotion video renderer in Settings before rendering',
    });
  });

  test('collapses hostile and unknown native failures to fixed local metadata', async () => {
    const hostile = {};
    Object.defineProperty(hostile, 'code', {
      get() {
        throw new Error('secret-bearing getter');
      },
    });
    const service = createNativeRenderService({
      invokeCommand: vi.fn().mockRejectedValue(hostile),
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });

    await expect(service.start(request(), {})).rejects.toMatchObject({
      code: 'nativeRenderFailed',
      message: 'The native video render could not be completed',
    });
    expect(normalizeRenderEvent({
      event: 'failed',
      job: null,
      error: { code: 'secretFilesystemFailure', message: 'C:\\private\\render.mp4' },
    }).error).toEqual({
      code: 'nativeRenderFailed',
      message: 'The native video render could not be completed',
    });

    let reads = 0;
    const changing = {};
    Object.defineProperty(changing, 'code', {
      get() {
        reads += 1;
        return reads === 1 ? 'internal' : 'attackerChosenCode';
      },
    });
    const changingService = createNativeRenderService({
      invokeCommand: vi.fn().mockRejectedValue(changing),
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });
    await expect(changingService.start(request(), {})).rejects.toMatchObject({ code: 'internal' });
    expect(reads).toBe(1);
  });
});

describe('native render lifecycle', () => {
  test('a throwing signal cleanup cannot block completed playback delivery', async () => {
    const tracked = createTrackedAbortSignal({ throwOnRemove: true });
    const initial = job();
    const renderRequest = request();
    const completedResult = result({
      sourceAssetId: renderRequest.sourceAssetId,
      projectId: renderRequest.projectId,
    });
    const invokeCommand = vi.fn(async (command) => {
      if (command === 'render_start') return initial;
      throw new Error(`unexpected command: ${command}`);
    });
    const service = createNativeRenderService({
      invokeCommand,
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });
    const running = runNativeRender(renderRequest, { signal: tracked.signal }, service);
    await vi.waitFor(() => expect(invokeCommand).toHaveBeenCalledWith(
      'render_start',
      expect.any(Object),
    ));
    TestChannel.latest.emit({
      event: 'completed',
      job: {
        ...initial,
        state: 'succeeded',
        progress: { basisPoints: 10_000 },
        sequence: 2,
      },
      result: completedResult,
    });

    await expect(running).resolves.toMatchObject({ result: completedResult });
    expect(invokeCommand.mock.calls.map(([command]) => command)).toEqual(['render_start']);
    expect(tracked.counts).toEqual({
      abortedGets: 2,
      addGets: 1,
      removeGets: 1,
      addCalls: 1,
      removeCalls: 1,
    });
  });

  test('reentrant signal cleanup cannot revoke the playback transferred by completion', async () => {
    const initial = job();
    const renderRequest = request();
    const completedEvent = {
      event: 'completed',
      job: {
        ...initial,
        state: 'succeeded',
        progress: { basisPoints: 10_000 },
        sequence: 2,
      },
      result: result({
        sourceAssetId: renderRequest.sourceAssetId,
        projectId: renderRequest.projectId,
      }),
    };
    let reentered = false;
    const signal = {
      aborted: false,
      addEventListener() {},
      removeEventListener() {
        if (reentered) return;
        reentered = true;
        TestChannel.latest.emit(completedEvent);
      },
    };
    const invokeCommand = vi.fn(async (command) => {
      if (command === 'render_start') return initial;
      if (command === 'render_playback_release') return true;
      throw new Error(`unexpected command: ${command}`);
    });
    let settleDelivery;
    const delivered = new Promise((resolve) => { settleDelivery = resolve; });
    const onCompleted = vi.fn((event) => settleDelivery(event));
    const service = createNativeRenderService({
      invokeCommand,
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });
    await service.start(renderRequest, { onCompleted }, { signal });
    TestChannel.latest.emit(completedEvent);

    await expect(delivered).resolves.toMatchObject({ result: completedEvent.result });
    expect(onCompleted).toHaveBeenCalledTimes(1);
    expect(invokeCommand.mock.calls.map(([command]) => command)).toEqual(['render_start']);
  });

  test('reentrant signal cleanup releases only a distinct untransferred playback once', async () => {
    const initial = job();
    const renderRequest = request();
    const completedJob = {
      ...initial,
      state: 'succeeded',
      progress: { basisPoints: 10_000 },
      sequence: 2,
    };
    const accepted = result({
      sourceAssetId: renderRequest.sourceAssetId,
      projectId: renderRequest.projectId,
    });
    const untransferred = result({
      sourceAssetId: renderRequest.sourceAssetId,
      projectId: renderRequest.projectId,
    });
    let reentered = false;
    const signal = {
      aborted: false,
      addEventListener() {},
      removeEventListener() {
        if (reentered) return;
        reentered = true;
        const duplicate = { event: 'completed', job: completedJob, result: untransferred };
        TestChannel.latest.emit(duplicate);
        TestChannel.latest.emit(duplicate);
      },
    };
    const invokeCommand = vi.fn(async (command) => {
      if (command === 'render_start') return initial;
      if (command === 'render_playback_release') return true;
      throw new Error(`unexpected command: ${command}`);
    });
    const onCompleted = vi.fn();
    const service = createNativeRenderService({
      invokeCommand,
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });
    await service.start(renderRequest, { onCompleted }, { signal });
    TestChannel.latest.emit({ event: 'completed', job: completedJob, result: accepted });
    await Promise.resolve();

    expect(onCompleted).toHaveBeenCalledTimes(1);
    expect(invokeCommand.mock.calls.filter(
      ([command]) => command === 'render_playback_release'
    )).toEqual([['render_playback_release', { playbackId: untransferred.playback.id }]]);
    expect(invokeCommand).not.toHaveBeenCalledWith('render_playback_release', {
      playbackId: accepted.playback.id,
    });
  });

  test('throwing signal cleanup cannot suppress failed terminal delivery', async () => {
    const tracked = createTrackedAbortSignal({ throwOnRemove: true });
    const initial = job();
    const onFailed = vi.fn();
    const service = createNativeRenderService({
      invokeCommand: vi.fn(async (command) => {
        if (command === 'render_start') return initial;
        throw new Error(`unexpected command: ${command}`);
      }),
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });
    await service.start(request(), { onFailed }, { signal: tracked.signal });
    TestChannel.latest.emit({
      event: 'failed',
      job: { ...initial, state: 'failed', sequence: 2 },
      error: { code: 'internal', message: 'redacted by adapter' },
    });

    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(tracked.counts.removeCalls).toBe(1);
    tracked.abort();
  });

  test('throwing signal cleanup cannot suppress protocol failure or duplicate cancellation', async () => {
    const tracked = createTrackedAbortSignal({ throwOnRemove: true });
    const initial = job();
    const invokeCommand = vi.fn(async (command) => {
      if (command === 'render_start') return initial;
      if (command === 'job_cancel') {
        return { ...initial, state: 'cancelling', sequence: 2 };
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const onProtocolError = vi.fn();
    const service = createNativeRenderService({
      invokeCommand,
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });
    await service.start(request(), { onProtocolError }, { signal: tracked.signal });
    TestChannel.latest.emit({ event: 'invalid' });
    await vi.waitFor(() => expect(invokeCommand).toHaveBeenCalledWith('job_cancel', {
      id: initial.id,
    }));

    expect(onProtocolError).toHaveBeenCalledTimes(1);
    expect(tracked.counts.removeCalls).toBe(1);
    tracked.abort();
    await Promise.resolve();
    expect(invokeCommand.mock.calls.filter(([command]) => command === 'job_cancel')).toHaveLength(1);
  });

  test('a throwing signal cleanup still delivers cancellation after admission', async () => {
    const tracked = createTrackedAbortSignal({ throwOnRemove: true });
    const initial = job();
    const invokeCommand = vi.fn(async (command) => {
      if (command === 'render_start') return initial;
      if (command === 'job_cancel') {
        return { ...initial, state: 'cancelling', sequence: 2 };
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const onCancelled = vi.fn();
    const service = createNativeRenderService({
      invokeCommand,
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });
    await service.start(request(), { onCancelled }, { signal: tracked.signal });
    tracked.abort();
    await vi.waitFor(() => expect(invokeCommand).toHaveBeenCalledWith('job_cancel', {
      id: initial.id,
    }));
    TestChannel.latest.emit({
      event: 'cancelled',
      job: { ...initial, state: 'cancelled', sequence: 3 },
    });

    expect(onCancelled).toHaveBeenCalledTimes(1);
    expect(tracked.counts.removeCalls).toBe(1);
  });

  test('contains listener-registration and cleanup failures before native admission', async () => {
    const tracked = createTrackedAbortSignal({ throwOnAdd: true, throwOnRemove: true });
    const invokeCommand = vi.fn();
    const service = createNativeRenderService({
      invokeCommand,
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });

    await expect(runNativeRender(request(), { signal: tracked.signal }, service)).rejects
      .toMatchObject({ code: 'invalidRenderRequest' });
    expect(invokeCommand).not.toHaveBeenCalled();
    expect(tracked.counts).toEqual({
      abortedGets: 1,
      addGets: 1,
      removeGets: 1,
      addCalls: 1,
      removeCalls: 1,
    });
  });

  test.each(['aborted', 'addEventListener', 'removeEventListener'])(
    'reads a hostile %s getter at most once and never starts native work',
    async (throwingGetter) => {
      const tracked = createTrackedAbortSignal({ throwingGetter });
      const invokeCommand = vi.fn();
      const service = createNativeRenderService({
        invokeCommand,
        ChannelConstructor: TestChannel,
        isNativeRuntime: () => true,
      });

      await expect(runNativeRender(request(), { signal: tracked.signal }, service)).rejects
        .toMatchObject({ code: 'invalidRenderRequest' });
      expect(invokeCommand).not.toHaveBeenCalled();
      expect(tracked.counts.abortedGets).toBeLessThanOrEqual(1);
      expect(tracked.counts.addGets).toBeLessThanOrEqual(1);
      expect(tracked.counts.removeGets).toBeLessThanOrEqual(1);
    },
  );

  test('an abort fired during registration wins before native admission', async () => {
    const tracked = createTrackedAbortSignal({ abortDuringAdd: true });
    const invokeCommand = vi.fn();
    const service = createNativeRenderService({
      invokeCommand,
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });

    await expect(runNativeRender(request(), { signal: tracked.signal }, service)).rejects
      .toMatchObject({ name: 'AbortError', code: 'renderCancelled' });
    expect(invokeCommand).not.toHaveBeenCalled();
    expect(tracked.counts).toEqual({
      abortedGets: 2,
      addGets: 1,
      removeGets: 1,
      addCalls: 1,
      removeCalls: 1,
    });
  });

  test('buffers an initial same-sequence phase and then accepts a terminal result', async () => {
    let resolveStart;
    const initial = job();
    const invokeCommand = vi.fn((command) => {
      if (command === 'render_start') {
        return new Promise((resolve) => { resolveStart = resolve; });
      }
      throw new Error('unexpected command');
    });
    const onProgress = vi.fn();
    const onCompleted = vi.fn();
    const service = createNativeRenderService({
      invokeCommand,
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });
    const renderRequest = request();
    const starting = service.start(renderRequest, { onProgress, onCompleted });
    TestChannel.latest.emit({
      event: 'progress',
      job: initial,
      phase: 'staging',
      fractionMillionths: 0,
      renderedFrames: 0,
      encodedFrames: 0,
      durationInFrames: 75,
    });
    resolveStart(initial);
    await expect(starting).resolves.toEqual(initial);
    expect(onProgress).toHaveBeenCalledTimes(1);

    TestChannel.latest.emit({
      event: 'completed',
      job: {
        ...initial,
        state: 'succeeded',
        progress: { basisPoints: 10_000 },
        sequence: 2,
      },
      result: result({
        sourceAssetId: renderRequest.sourceAssetId,
        projectId: renderRequest.projectId,
      }),
    });
    expect(onCompleted).toHaveBeenCalledTimes(1);
  });

  test('a mismatched channel job fails closed and cancels only the started job', async () => {
    const initial = job();
    const invokeCommand = vi.fn(async (command) => {
      if (command === 'render_start') return initial;
      if (command === 'job_cancel') {
        return { ...initial, state: 'cancelling', sequence: 2 };
      }
      throw new Error('unexpected command');
    });
    const onProtocolError = vi.fn();
    const service = createNativeRenderService({
      invokeCommand,
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });
    await service.start(request(), { onProtocolError });
    TestChannel.latest.emit({
      event: 'progress',
      job: { ...initial, id: uuidv7(), sequence: 2 },
      phase: 'staging',
      fractionMillionths: 1,
      renderedFrames: 0,
      encodedFrames: 0,
      durationInFrames: 75,
    });
    await Promise.resolve();

    expect(onProtocolError).toHaveBeenCalledTimes(1);
    expect(invokeCommand).toHaveBeenCalledWith('job_cancel', { id: initial.id });
  });

  test('rejects regressing render phase, frame, and duration progress', async () => {
    const initial = job();
    const invokeCommand = vi.fn(async (command) => {
      if (command === 'render_start') return initial;
      if (command === 'job_cancel') {
        return { ...initial, state: 'cancelling', sequence: 4 };
      }
      throw new Error('unexpected command');
    });
    const onProtocolError = vi.fn();
    const service = createNativeRenderService({
      invokeCommand,
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });
    await service.start(request(), { onProtocolError });
    TestChannel.latest.emit({
      event: 'progress',
      job: { ...initial, progress: { basisPoints: 4_000 }, sequence: 2 },
      phase: 'encoding',
      fractionMillionths: 400_000,
      renderedFrames: 20,
      encodedFrames: 10,
      durationInFrames: 75,
    });
    TestChannel.latest.emit({
      event: 'progress',
      job: { ...initial, progress: { basisPoints: 4_001 }, sequence: 3 },
      phase: 'renderingFrames',
      fractionMillionths: 400_001,
      renderedFrames: 19,
      encodedFrames: 9,
      durationInFrames: 76,
    });
    await Promise.resolve();

    expect(onProtocolError).toHaveBeenCalledTimes(1);
    expect(invokeCommand).toHaveBeenCalledWith('job_cancel', { id: initial.id });
  });

  test('an early malformed event cancels the job returned after registration', async () => {
    let resolveStart;
    const initial = job();
    const invokeCommand = vi.fn((command) => {
      if (command === 'render_start') {
        return new Promise((resolve) => { resolveStart = resolve; });
      }
      if (command === 'job_cancel') {
        return Promise.resolve({ ...initial, state: 'cancelling', sequence: 2 });
      }
      throw new Error('unexpected command');
    });
    const onCompleted = vi.fn();
    const service = createNativeRenderService({
      invokeCommand,
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });
    const starting = service.start(request(), { onCompleted });
    TestChannel.latest.emit({ event: 'not-a-render-event' });
    resolveStart(initial);

    await expect(starting).rejects.toMatchObject({ code: 'invalidRenderResponse' });
    expect(invokeCommand).toHaveBeenCalledWith('job_cancel', { id: initial.id });
    TestChannel.latest.emit({
      event: 'completed',
      job: {
        ...initial,
        state: 'succeeded',
        progress: { basisPoints: 10_000 },
        sequence: 3,
      },
      result: result(),
    });
    expect(onCompleted).not.toHaveBeenCalled();
  });

  test('cancel rejects a same-ID response that remains active without cancellation', async () => {
    const initial = job();
    const service = createNativeRenderService({
      invokeCommand: vi.fn().mockResolvedValue(initial),
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });

    await expect(service.cancel(initial.id)).rejects.toMatchObject({
      code: 'invalidRenderResponse',
    });
  });

  test('run suppresses start notification after an early protocol terminal', async () => {
    let resolveStart;
    const initial = job();
    const invokeCommand = vi.fn((command) => {
      if (command === 'render_start') {
        return new Promise((resolve) => { resolveStart = resolve; });
      }
      if (command === 'job_cancel') {
        return Promise.resolve({ ...initial, state: 'cancelling', sequence: 2 });
      }
      throw new Error('unexpected command');
    });
    const onStarted = vi.fn();
    const service = createNativeRenderService({
      invokeCommand,
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });
    const running = runNativeRender(request(), { onStarted }, service);
    TestChannel.latest.emit({ event: 'not-a-render-event' });
    resolveStart(initial);

    await expect(running).rejects.toMatchObject({ code: 'invalidRenderResponse' });
    expect(onStarted).not.toHaveBeenCalled();
  });

  test('run trusts an exact early completion when the start response is lost', async () => {
    const completed = {
      event: 'completed',
      job: job({
        state: 'succeeded',
        progress: { basisPoints: 10_000 },
        sequence: 2,
      }),
      result: result(),
    };
    const onStarted = vi.fn();
    const service = {
      start: vi.fn(async (_request, handlers) => {
        handlers.onCompleted(completed);
        throw new Error('start response was lost');
      }),
      getResult: vi.fn(),
    };

    await expect(runNativeRender(request(), { onStarted }, service)).resolves.toBe(completed);
    expect(onStarted).not.toHaveBeenCalled();
  });

  test('the real channel adapter preserves an early completion when start IPC is lost', async () => {
    let rejectStart;
    const renderRequest = request();
    const completedJob = job({
      state: 'succeeded',
      progress: { basisPoints: 10_000 },
      sequence: 2,
    });
    const completedResult = result({
      sourceAssetId: renderRequest.sourceAssetId,
      projectId: renderRequest.projectId,
    });
    const invokeCommand = vi.fn((command) => {
      if (command === 'render_start') {
        return new Promise((_resolve, reject) => { rejectStart = reject; });
      }
      throw new Error('unexpected command');
    });
    const service = createNativeRenderService({
      invokeCommand,
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });
    const onStarted = vi.fn();
    const running = runNativeRender(renderRequest, { onStarted }, service);
    TestChannel.latest.emit({
      event: 'completed',
      job: completedJob,
      result: completedResult,
    });
    rejectStart({ code: 'internal', message: 'transport response lost' });

    await expect(running).resolves.toMatchObject({
      event: 'completed',
      job: completedJob,
      result: completedResult,
    });
    expect(onStarted).not.toHaveBeenCalled();
  });

  test('cancels a returned job ID when the start snapshot is malformed', async () => {
    const initial = job();
    const invokeCommand = vi.fn(async (command) => {
      if (command === 'render_start') return { ...initial, kind: 'downloadMedia' };
      if (command === 'job_cancel') {
        return { ...initial, state: 'cancelling', sequence: 2 };
      }
      throw new Error('unexpected command');
    });
    const service = createNativeRenderService({
      invokeCommand,
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });

    await expect(service.start(request(), {})).rejects.toMatchObject({
      code: 'invalidRenderResponse',
    });
    expect(invokeCommand).toHaveBeenCalledWith('job_cancel', { id: initial.id });
  });

  test('releases a mismatched completed playback and cancels its exact job', async () => {
    const renderRequest = request();
    const initial = job();
    const leaked = result({
      sourceAssetId: uuidv7(),
      projectId: renderRequest.projectId,
    });
    const invokeCommand = vi.fn(async (command) => {
      if (command === 'render_start') return initial;
      if (command === 'job_cancel') {
        return { ...initial, state: 'cancelling', sequence: 3 };
      }
      if (command === 'render_playback_release') return true;
      throw new Error('unexpected command');
    });
    const onProtocolError = vi.fn();
    const onCompleted = vi.fn();
    const service = createNativeRenderService({
      invokeCommand,
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });
    await service.start(renderRequest, { onProtocolError, onCompleted });
    TestChannel.latest.emit({
      event: 'completed',
      job: {
        ...initial,
        state: 'succeeded',
        progress: { basisPoints: 10_000 },
        sequence: 2,
      },
      result: leaked,
    });
    await Promise.resolve();

    expect(onCompleted).not.toHaveBeenCalled();
    expect(onProtocolError).toHaveBeenCalledTimes(1);
    expect(invokeCommand).toHaveBeenCalledWith('render_playback_release', {
      playbackId: leaked.playback.id,
    });
    expect(invokeCommand).toHaveBeenCalledWith('job_cancel', { id: initial.id });
  });

  test('quarantines a single stale completed playback before protocol failure', async () => {
    const renderRequest = request();
    const initial = job();
    const staleResult = result({
      sourceAssetId: renderRequest.sourceAssetId,
      projectId: renderRequest.projectId,
    });
    const invokeCommand = vi.fn(async (command) => {
      if (command === 'render_start') return initial;
      if (command === 'job_cancel') {
        return { ...initial, state: 'cancelling', sequence: 2 };
      }
      if (command === 'render_playback_release') return true;
      throw new Error(`unexpected command: ${command}`);
    });
    const onCompleted = vi.fn();
    const onProtocolError = vi.fn();
    const service = createNativeRenderService({
      invokeCommand,
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });
    await service.start(renderRequest, { onCompleted, onProtocolError });
    TestChannel.latest.emit({
      event: 'completed',
      job: {
        ...initial,
        state: 'succeeded',
        progress: { basisPoints: 10_000 },
      },
      result: staleResult,
    });
    await Promise.resolve();

    expect(onCompleted).not.toHaveBeenCalled();
    expect(onProtocolError).toHaveBeenCalledTimes(1);
    expect(onProtocolError.mock.calls[0][0]).toMatchObject({ code: 'invalidRenderResponse' });
    expect(invokeCommand.mock.calls.filter(([command]) => command === 'job_cancel')).toEqual([
      ['job_cancel', { id: initial.id }],
    ]);
    expect(invokeCommand.mock.calls.filter(
      ([command]) => command === 'render_playback_release'
    )).toEqual([['render_playback_release', { playbackId: staleResult.playback.id }]]);
  });

  test('stale completion quarantine is exact-once when playback release fails', async () => {
    const renderRequest = request();
    const initial = job();
    const staleResult = result({
      sourceAssetId: renderRequest.sourceAssetId,
      projectId: renderRequest.projectId,
    });
    const invokeCommand = vi.fn(async (command) => {
      if (command === 'render_start') return initial;
      if (command === 'job_cancel') {
        return { ...initial, state: 'cancelling', sequence: 2 };
      }
      if (command === 'render_playback_release') {
        throw new Error('cleanup transport failed');
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const onProtocolError = vi.fn();
    const service = createNativeRenderService({
      invokeCommand,
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });
    await service.start(renderRequest, { onProtocolError });
    const staleEvent = {
      event: 'completed',
      job: {
        ...initial,
        state: 'succeeded',
        progress: { basisPoints: 10_000 },
      },
      result: staleResult,
    };
    TestChannel.latest.emit(staleEvent);
    TestChannel.latest.emit(staleEvent);
    await Promise.resolve();

    expect(onProtocolError).toHaveBeenCalledTimes(1);
    expect(onProtocolError.mock.calls[0][0]).toMatchObject({
      code: 'invalidRenderResponse',
      message: 'The desktop host returned invalid native render data',
    });
    expect(invokeCommand.mock.calls.filter(([command]) => command === 'job_cancel')).toEqual([
      ['job_cancel', { id: initial.id }],
    ]);
    expect(invokeCommand.mock.calls.filter(
      ([command]) => command === 'render_playback_release'
    )).toEqual([['render_playback_release', { playbackId: staleResult.playback.id }]]);
  });

  test('stale completion quarantine never releases an already transferred playback', async () => {
    const renderRequest = request();
    const first = job();
    const second = job();
    const transferred = result({
      sourceAssetId: renderRequest.sourceAssetId,
      projectId: renderRequest.projectId,
    });
    let startCalls = 0;
    const invokeCommand = vi.fn(async (command) => {
      if (command === 'render_start') {
        startCalls += 1;
        return startCalls === 1 ? first : second;
      }
      if (command === 'job_cancel') {
        return { ...second, state: 'cancelling', sequence: 2 };
      }
      if (command === 'render_playback_release') return true;
      throw new Error(`unexpected command: ${command}`);
    });
    const onCompleted = vi.fn();
    const service = createNativeRenderService({
      invokeCommand,
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });
    await service.start(renderRequest, { onCompleted });
    TestChannel.latest.emit({
      event: 'completed',
      job: {
        ...first,
        state: 'succeeded',
        progress: { basisPoints: 10_000 },
        sequence: 2,
      },
      result: transferred,
    });
    expect(onCompleted).toHaveBeenCalledTimes(1);

    const onProtocolError = vi.fn();
    await service.start(renderRequest, { onProtocolError });
    TestChannel.latest.emit({
      event: 'completed',
      job: {
        ...second,
        state: 'succeeded',
        progress: { basisPoints: 10_000 },
      },
      result: transferred,
    });
    await Promise.resolve();

    expect(onProtocolError).toHaveBeenCalledTimes(1);
    expect(invokeCommand.mock.calls.filter(([command]) => command === 'job_cancel')).toEqual([
      ['job_cancel', { id: second.id }],
    ]);
    expect(invokeCommand.mock.calls.filter(
      ([command]) => command === 'render_playback_release'
    )).toHaveLength(0);
  });

  test('invalid foreign-job completion is neither accepted nor released', async () => {
    const renderRequest = request();
    const initial = job();
    const foreignJob = job({
      state: 'succeeded',
      progress: { basisPoints: 10_000 },
      sequence: 2,
    });
    const foreignResult = result({
      sourceAssetId: renderRequest.sourceAssetId,
      projectId: renderRequest.projectId,
    });
    const invokeCommand = vi.fn(async (command) => {
      if (command === 'render_start') return initial;
      if (command === 'job_cancel') {
        return { ...initial, state: 'cancelling', sequence: 2 };
      }
      if (command === 'render_playback_release') return true;
      throw new Error(`unexpected command: ${command}`);
    });
    const onCompleted = vi.fn();
    const onProtocolError = vi.fn();
    const service = createNativeRenderService({
      invokeCommand,
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });
    await service.start(renderRequest, { onCompleted, onProtocolError });
    TestChannel.latest.emit({ event: 'completed', job: foreignJob, result: foreignResult });
    await Promise.resolve();

    expect(onCompleted).not.toHaveBeenCalled();
    expect(onProtocolError).toHaveBeenCalledTimes(1);
    expect(invokeCommand.mock.calls.filter(([command]) => command === 'job_cancel')).toEqual([
      ['job_cancel', { id: initial.id }],
    ]);
    expect(invokeCommand.mock.calls.filter(
      ([command]) => command === 'render_playback_release'
    )).toHaveLength(0);
  });

  test('releases an owned playback from a malformed completed envelope exactly once', async () => {
    const renderRequest = request();
    const initial = job();
    const completed = result({
      sourceAssetId: renderRequest.sourceAssetId,
      projectId: renderRequest.projectId,
    });
    const invokeCommand = vi.fn(async (command) => {
      if (command === 'render_start') return initial;
      if (command === 'job_cancel') {
        return { ...initial, state: 'cancelling', sequence: 3 };
      }
      if (command === 'render_playback_release') return true;
      throw new Error('unexpected command');
    });
    const onProtocolError = vi.fn();
    const service = createNativeRenderService({
      invokeCommand,
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });
    await service.start(renderRequest, { onProtocolError });
    const malformed = {
      event: 'completed',
      job: {
        ...initial,
        state: 'succeeded',
        progress: { basisPoints: 10_000 },
        sequence: 2,
      },
      result: completed,
      unexpectedPath: 'C:\\private\\render.mp4',
    };
    TestChannel.latest.emit(malformed);
    TestChannel.latest.emit(malformed);
    await Promise.resolve();

    expect(onProtocolError).toHaveBeenCalledTimes(1);
    expect(invokeCommand.mock.calls.filter(
      ([command]) => command === 'render_playback_release'
    )).toEqual([['render_playback_release', { playbackId: completed.playback.id }]]);
    expect(invokeCommand.mock.calls.filter(([command]) => command === 'job_cancel')).toEqual([
      ['job_cancel', { id: initial.id }],
    ]);
  });

  test('quarantines duplicate completion capabilities without revoking the transferred result', async () => {
    const renderRequest = request();
    const initial = job();
    const accepted = result({
      sourceAssetId: renderRequest.sourceAssetId,
      projectId: renderRequest.projectId,
    });
    const duplicate = result({
      sourceAssetId: renderRequest.sourceAssetId,
      projectId: renderRequest.projectId,
    });
    const invokeCommand = vi.fn(async (command) => {
      if (command === 'render_start') return initial;
      if (command === 'render_playback_release') return true;
      throw new Error(`unexpected command: ${command}`);
    });
    const onCompleted = vi.fn();
    const onProtocolError = vi.fn();
    const service = createNativeRenderService({
      invokeCommand,
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });
    await service.start(renderRequest, { onCompleted, onProtocolError });
    const completedJob = {
      ...initial,
      state: 'succeeded',
      progress: { basisPoints: 10_000 },
      sequence: 2,
    };
    TestChannel.latest.emit({ event: 'completed', job: completedJob, result: accepted });
    TestChannel.latest.emit({
      event: 'completed',
      job: { ...completedJob, id: 'invalid-job-id' },
      result: accepted,
      unexpectedPath: 'C:\\private\\accepted.mp4',
    });
    TestChannel.latest.emit({
      event: 'completed',
      job: { ...completedJob, id: 'invalid-job-id' },
      result: duplicate,
    });
    TestChannel.latest.emit({
      event: 'completed',
      job: { ...completedJob, id: 'invalid-job-id' },
      result: duplicate,
    });
    await Promise.resolve();

    expect(onCompleted).toHaveBeenCalledTimes(1);
    expect(onProtocolError).not.toHaveBeenCalled();
    expect(invokeCommand.mock.calls.filter(
      ([command]) => command === 'render_playback_release'
    )).toEqual([['render_playback_release', { playbackId: duplicate.playback.id }]]);
  });

  test('salvages a buffered invalid-job playback once even when release fails', async () => {
    let resolveStart;
    const renderRequest = request();
    const initial = job();
    const untransferred = result({
      sourceAssetId: renderRequest.sourceAssetId,
      projectId: renderRequest.projectId,
    });
    const invokeCommand = vi.fn((command) => {
      if (command === 'render_start') {
        return new Promise((resolve) => { resolveStart = resolve; });
      }
      if (command === 'job_cancel') {
        return Promise.resolve({ ...initial, state: 'cancelling', sequence: 2 });
      }
      if (command === 'render_playback_release') {
        return Promise.reject(new Error('cleanup transport failed'));
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const onProtocolError = vi.fn();
    const service = createNativeRenderService({
      invokeCommand,
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });
    const starting = service.start(renderRequest, { onProtocolError });
    const malformed = {
      event: 'completed',
      job: {
        ...initial,
        id: 'invalid-job-id',
        state: 'succeeded',
        progress: { basisPoints: 10_000 },
        sequence: 2,
      },
      result: untransferred,
    };
    TestChannel.latest.emit(malformed);
    TestChannel.latest.emit(malformed);
    resolveStart(initial);

    await expect(starting).rejects.toMatchObject({ code: 'invalidRenderResponse' });
    await Promise.resolve();
    expect(onProtocolError).toHaveBeenCalledTimes(1);
    expect(invokeCommand.mock.calls.filter(
      ([command]) => command === 'render_playback_release'
    )).toEqual([['render_playback_release', { playbackId: untransferred.playback.id }]]);
    expect(invokeCommand.mock.calls.filter(([command]) => command === 'job_cancel')).toEqual([
      ['job_cancel', { id: initial.id }],
    ]);
  });

  test('salvages playback without executing a malformed job accessor', async () => {
    const renderRequest = request();
    const initial = job();
    const untransferred = result({
      sourceAssetId: renderRequest.sourceAssetId,
      projectId: renderRequest.projectId,
    });
    const invokeCommand = vi.fn(async (command) => {
      if (command === 'render_start') return initial;
      if (command === 'job_cancel') {
        return { ...initial, state: 'cancelling', sequence: 2 };
      }
      if (command === 'render_playback_release') return true;
      throw new Error(`unexpected command: ${command}`);
    });
    const onProtocolError = vi.fn();
    const service = createNativeRenderService({
      invokeCommand,
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });
    await service.start(renderRequest, { onProtocolError });
    let jobReads = 0;
    const malformed = {};
    Object.defineProperties(malformed, {
      event: { enumerable: true, value: 'completed' },
      job: {
        enumerable: true,
        get() {
          jobReads += 1;
          throw new Error('hostile job getter');
        },
      },
      result: { enumerable: true, value: untransferred },
    });
    TestChannel.latest.emit(malformed);
    await vi.waitFor(() => expect(invokeCommand).toHaveBeenCalledWith('job_cancel', {
      id: initial.id,
    }));

    expect(jobReads).toBe(0);
    expect(onProtocolError).toHaveBeenCalledTimes(1);
    expect(invokeCommand).toHaveBeenCalledWith('render_playback_release', {
      playbackId: untransferred.playback.id,
    });
  });

  test('releases a buffered completion when the returned start snapshot is malformed', async () => {
    let resolveStart;
    const renderRequest = request();
    const initial = job();
    const completed = result({
      sourceAssetId: renderRequest.sourceAssetId,
      projectId: renderRequest.projectId,
    });
    const invokeCommand = vi.fn((command) => {
      if (command === 'render_start') {
        return new Promise((resolve) => { resolveStart = resolve; });
      }
      if (command === 'job_cancel') {
        return Promise.resolve({ ...initial, state: 'cancelling', sequence: 3 });
      }
      if (command === 'render_playback_release') return Promise.resolve(true);
      throw new Error(`unexpected command: ${command}`);
    });
    const service = createNativeRenderService({
      invokeCommand,
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });
    const starting = service.start(renderRequest, {});
    TestChannel.latest.emit({
      event: 'completed',
      job: {
        ...initial,
        state: 'succeeded',
        progress: { basisPoints: 10_000 },
        sequence: 2,
      },
      result: completed,
    });
    resolveStart({ ...initial, kind: 'downloadMedia' });

    await expect(starting).rejects.toMatchObject({ code: 'invalidRenderResponse' });
    expect(invokeCommand).toHaveBeenCalledWith('job_cancel', { id: initial.id });
    expect(invokeCommand).toHaveBeenCalledWith('render_playback_release', {
      playbackId: completed.playback.id,
    });
  });

  test('releases buffered completion capabilities abandoned by an earlier protocol failure', async () => {
    let resolveStart;
    const renderRequest = request();
    const initial = job({ progress: { basisPoints: 5_000 }, sequence: 2 });
    const completed = result({
      sourceAssetId: renderRequest.sourceAssetId,
      projectId: renderRequest.projectId,
    });
    const invokeCommand = vi.fn((command) => {
      if (command === 'render_start') {
        return new Promise((resolve) => { resolveStart = resolve; });
      }
      if (command === 'job_cancel') {
        return Promise.resolve({ ...initial, state: 'cancelling', sequence: 3 });
      }
      if (command === 'render_playback_release') return Promise.resolve(true);
      throw new Error(`unexpected command: ${command}`);
    });
    const service = createNativeRenderService({
      invokeCommand,
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });
    const starting = service.start(renderRequest, {});
    TestChannel.latest.emit({
      event: 'progress',
      job: { ...initial, progress: { basisPoints: 1_000 }, sequence: 1 },
      phase: 'staging',
      fractionMillionths: 100_000,
      renderedFrames: 0,
      encodedFrames: 0,
      durationInFrames: 75,
    });
    TestChannel.latest.emit({
      event: 'completed',
      job: {
        ...initial,
        state: 'succeeded',
        progress: { basisPoints: 10_000 },
        sequence: 3,
      },
      result: completed,
    });
    resolveStart(initial);

    await expect(starting).rejects.toMatchObject({ code: 'invalidRenderResponse' });
    expect(invokeCommand).toHaveBeenCalledWith('job_cancel', { id: initial.id });
    expect(invokeCommand.mock.calls.filter(
      ([command]) => command === 'render_playback_release'
    )).toEqual([['render_playback_release', { playbackId: completed.playback.id }]]);
  });

  test('releases an exact-job playback capability from a malformed result response', async () => {
    const requestedJob = job({
      state: 'succeeded',
      progress: { basisPoints: 10_000 },
      sequence: 2,
    });
    const completed = result();
    const invokeCommand = vi.fn(async (command) => {
      if (command === 'render_result') {
        return { job: requestedJob, result: completed, unexpectedPath: 'C:\\private\\render.mp4' };
      }
      if (command === 'render_playback_release') return true;
      throw new Error(`unexpected command: ${command}`);
    });
    const service = createNativeRenderService({
      invokeCommand,
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });

    await expect(service.getResult(requestedJob.id)).rejects.toMatchObject({
      code: 'invalidRenderResponse',
    });
    expect(invokeCommand.mock.calls.filter(
      ([command]) => command === 'render_playback_release'
    )).toEqual([['render_playback_release', { playbackId: completed.playback.id }]]);
  });

  test('releases valid result capabilities with invalid or mismatched job envelopes', async () => {
    const requestedJob = job({
      state: 'succeeded',
      progress: { basisPoints: 10_000 },
      sequence: 2,
    });
    for (const responseJob of [
      { ...requestedJob, id: 'invalid-job-id' },
      { ...requestedJob, id: uuidv7() },
    ]) {
      const completed = result();
      const invokeCommand = vi.fn(async (command) => {
        if (command === 'render_result') return { job: responseJob, result: completed };
        if (command === 'render_playback_release') return true;
        throw new Error(`unexpected command: ${command}`);
      });
      const service = createNativeRenderService({
        invokeCommand,
        ChannelConstructor: TestChannel,
        isNativeRuntime: () => true,
      });

      await expect(service.getResult(requestedJob.id)).rejects.toMatchObject({
        code: 'invalidRenderResponse',
      });
      expect(invokeCommand.mock.calls.filter(
        ([command]) => command === 'render_playback_release'
      )).toEqual([['render_playback_release', { playbackId: completed.playback.id }]]);
    }
  });

  test('salvages result playback without executing a hostile job accessor', async () => {
    const requestedJob = job({
      state: 'succeeded',
      progress: { basisPoints: 10_000 },
      sequence: 2,
    });
    const completed = result();
    let jobReads = 0;
    const malformed = {};
    Object.defineProperties(malformed, {
      job: {
        enumerable: true,
        get() {
          jobReads += 1;
          throw new Error('hostile result job getter');
        },
      },
      result: { enumerable: true, value: completed },
    });
    const invokeCommand = vi.fn(async (command) => {
      if (command === 'render_result') return malformed;
      if (command === 'render_playback_release') return true;
      throw new Error(`unexpected command: ${command}`);
    });
    const service = createNativeRenderService({
      invokeCommand,
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });

    await expect(service.getResult(requestedJob.id)).rejects.toMatchObject({
      code: 'invalidRenderResponse',
    });
    expect(jobReads).toBe(0);
    expect(invokeCommand).toHaveBeenCalledWith('render_playback_release', {
      playbackId: completed.playback.id,
    });
  });

  test('a result cleanup failure preserves the original protocol rejection', async () => {
    const requestedJob = job({
      state: 'succeeded',
      progress: { basisPoints: 10_000 },
      sequence: 2,
    });
    const completed = result();
    const invokeCommand = vi.fn(async (command) => {
      if (command === 'render_result') {
        return { job: { ...requestedJob, id: 'invalid-job-id' }, result: completed };
      }
      if (command === 'render_playback_release') {
        throw new Error('C:\\private\\cleanup-secret');
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const service = createNativeRenderService({
      invokeCommand,
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });

    await expect(service.getResult(requestedJob.id)).rejects.toMatchObject({
      code: 'invalidRenderResponse',
      message: 'The desktop host returned invalid native render data',
    });
    await expect(service.getResult(requestedJob.id)).rejects.toMatchObject({
      code: 'invalidRenderResponse',
      message: 'The desktop host returned invalid native render data',
    });
    expect(invokeCommand.mock.calls.map(([command]) => command)).toEqual([
      'render_result',
      'render_playback_release',
      'render_result',
    ]);
  });

  test('never revokes a result playback that was already transferred to its caller', async () => {
    const requestedJob = job({
      state: 'succeeded',
      progress: { basisPoints: 10_000 },
      sequence: 2,
    });
    const completed = result();
    let resultCalls = 0;
    const invokeCommand = vi.fn(async (command) => {
      if (command === 'render_result') {
        resultCalls += 1;
        return resultCalls === 1
          ? { job: requestedJob, result: completed }
          : { job: { ...requestedJob, id: 'invalid-job-id' }, result: completed };
      }
      if (command === 'render_playback_release') return true;
      throw new Error(`unexpected command: ${command}`);
    });
    const service = createNativeRenderService({
      invokeCommand,
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });

    await expect(service.getResult(requestedJob.id)).resolves.toMatchObject({ result: completed });
    await expect(service.getResult(requestedJob.id)).rejects.toMatchObject({
      code: 'invalidRenderResponse',
    });
    expect(invokeCommand.mock.calls.filter(
      ([command]) => command === 'render_playback_release'
    )).toHaveLength(0);
  });

  test('rejects and releases a recovered result owned by another render request', async () => {
    const renderRequest = request();
    const succeeded = job({
      state: 'succeeded',
      progress: { basisPoints: 10_000 },
      sequence: 2,
    });
    const foreign = result({
      sourceAssetId: uuidv7(),
      projectId: renderRequest.projectId,
    });
    const service = {
      start: vi.fn(async (_request, handlers) => {
        handlers.onFailed({
          event: 'failed',
          job: succeeded,
          error: { code: 'mediaServer', message: 'ignored' },
        });
        return job();
      }),
      getResult: vi.fn(async () => ({ job: succeeded, result: foreign })),
      releasePlayback: vi.fn(async () => true),
    };

    await expect(runNativeRender(renderRequest, {}, service)).rejects.toMatchObject({
      code: 'invalidRenderResponse',
    });
    expect(service.releasePlayback).toHaveBeenCalledWith(foreign.playback.id);
  });

  test('aborting recovered-result acquisition releases the capability even when cleanup fails', async () => {
    let resolveResult;
    const controller = new AbortController();
    const renderRequest = request();
    const succeeded = job({
      state: 'succeeded',
      progress: { basisPoints: 10_000 },
      sequence: 2,
    });
    const recovered = result({
      sourceAssetId: renderRequest.sourceAssetId,
      projectId: renderRequest.projectId,
    });
    const service = {
      start: vi.fn(async (_request, handlers) => {
        handlers.onFailed({
          event: 'failed',
          job: succeeded,
          error: { code: 'mediaServer', message: 'ignored' },
        });
        return job();
      }),
      getResult: vi.fn(() => new Promise((resolve) => { resolveResult = resolve; })),
      releasePlayback: vi.fn(async () => { throw new Error('already closed'); }),
    };
    const running = runNativeRender(renderRequest, { signal: controller.signal }, service);
    await vi.waitFor(() => expect(service.getResult).toHaveBeenCalledTimes(1));
    controller.abort();
    resolveResult({ job: succeeded, result: recovered });

    await expect(running).rejects.toMatchObject({
      name: 'AbortError',
      code: 'renderCancelled',
    });
    expect(service.releasePlayback).toHaveBeenCalledTimes(1);
    expect(service.releasePlayback).toHaveBeenCalledWith(recovered.playback.id);
  });

  test('an abort observed before succeeded-job recovery never registers a result', async () => {
    const controller = new AbortController();
    const succeeded = job({
      state: 'succeeded',
      progress: { basisPoints: 10_000 },
      sequence: 2,
    });
    const service = {
      start: vi.fn(async (_request, handlers) => {
        controller.abort();
        handlers.onFailed({
          event: 'failed',
          job: succeeded,
          error: { code: 'mediaServer', message: 'ignored' },
        });
        return job();
      }),
      getResult: vi.fn(),
      releasePlayback: vi.fn(),
    };

    await expect(runNativeRender(request(), { signal: controller.signal }, service)).rejects
      .toMatchObject({ name: 'AbortError', code: 'renderCancelled' });
    expect(service.getResult).not.toHaveBeenCalled();
    expect(service.releasePlayback).not.toHaveBeenCalled();
  });

  test('redacts status and playback-release invocation failures', async () => {
    const secret = { code: 'attackerChosen', message: 'C:\\private\\secret' };
    const service = createNativeRenderService({
      invokeCommand: vi.fn().mockRejectedValue(secret),
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });

    await expect(service.status()).rejects.toMatchObject({
      code: 'nativeRenderFailed',
      message: 'The native video render could not be completed',
    });
    await expect(service.releasePlayback(uuidv4())).rejects.toMatchObject({
      code: 'nativeRenderFailed',
      message: 'The native video render could not be completed',
    });
  });

  test('does not publish a polled result after its owner aborts', async () => {
    let resolveResult;
    const controller = new AbortController();
    const onUpdate = vi.fn();
    const service = {
      getResult: vi.fn(() => new Promise((resolve) => { resolveResult = resolve; })),
      releasePlayback: vi.fn(async () => true),
    };
    const pending = waitForNativeRender(uuidv7(), {
      signal: controller.signal,
      onUpdate,
    }, service);
    controller.abort();
    const unreported = result();
    resolveResult({
      job: job({
        state: 'succeeded',
        progress: { basisPoints: 10_000 },
        sequence: 2,
      }),
      result: unreported,
    });

    await expect(pending).rejects.toMatchObject({
      name: 'AbortError',
      code: 'renderCancelled',
    });
    expect(onUpdate).not.toHaveBeenCalled();
    expect(service.releasePlayback).toHaveBeenCalledWith(unreported.playback.id);
  });

  test('a polled result survives a throwing signal cleanup with bounded getter reads', async () => {
    const tracked = createTrackedAbortSignal({ throwOnRemove: true });
    const response = {
      job: job({
        state: 'succeeded',
        progress: { basisPoints: 10_000 },
        sequence: 2,
      }),
      result: result(),
    };
    const service = {
      getResult: vi.fn(async () => response),
      releasePlayback: vi.fn(),
    };

    await expect(waitForNativeRender(response.job.id, {
      signal: tracked.signal,
      onUpdate: vi.fn(),
    }, service)).resolves.toBe(response);
    expect(tracked.counts).toEqual({
      abortedGets: 2,
      addGets: 1,
      removeGets: 1,
      addCalls: 1,
      removeCalls: 1,
    });
  });
});
