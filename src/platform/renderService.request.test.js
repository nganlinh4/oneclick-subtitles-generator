// Native render request contract: source-asset authority and the exact request boundary.
import { v7 as uuidv7 } from 'uuid';

import { defaultCustomization } from '../components/subtitleCustomization/defaultCustomization';
import { presetOrder, presets } from '../components/subtitleCustomization/presetDefinitions';
import { createNativeRenderSourceResolver } from './renderRequest';
import { normalizeRenderEvent, normalizeRenderResultResponse } from './renderResponse';
import {
  NativeRenderError,
  buildNativeRenderRequest,
  createNativeRenderService,
} from './renderService';
import {
  TestChannel,
  editorCustomizationCatalogs,
  job,
  request,
  requestWith,
  result,
  sourceAsset,
} from './renderServiceTestFixtures';

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class MockTauriChannel {},
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}));

describe('native render source authority', () => {
  it('uses the active native capability when the browser-era prop carries no durable identity', async () => {
    const selected = sourceAsset();
    const media = Object.freeze({ opaque: 'native playback descriptor' });
    const resolveActiveMedia = vi.fn(async () => Object.freeze({ media }));
    const resolver = createNativeRenderSourceResolver({
      resolveActiveMedia,
      canonicalize: vi.fn(() => selected),
      isDesktop: () => true,
    });

    await expect(resolver({ url: 'blob:legacy-react-value' })).resolves.toEqual(selected);
    expect(resolveActiveMedia).toHaveBeenCalledWith({ candidate: null });
  });

  it('refuses a complete caller identity that disagrees with the selected native asset', async () => {
    const selected = sourceAsset();
    const resolver = createNativeRenderSourceResolver({
      resolveActiveMedia: vi.fn(async () => ({ media: {} })),
      canonicalize: vi.fn(() => selected),
      isDesktop: () => true,
    });

    await expect(resolver({ ...selected, id: uuidv7() })).rejects.toMatchObject({
      code: 'invalidRenderRequest',
      validationPath: 'source.identity',
    });
  });
});

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
      'sourceAssetId', 'projectId', 'sceneRevision', 'selectedSubtitles', 'selectedNarration',
      'narrationArtifactId', 'lyrics', 'settings', 'customization', 'crop',
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
    ['backgroundPaddingX', -0.01],
    ['backgroundPaddingY', 1_000.01],
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
        backgroundPaddingX: 1_000,
        backgroundPaddingY: 0,
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
            reason: 'runtimePayloadUnavailable',
            maxConcurrentRenders: 1,
          };
        }
        if (command === 'render_start') {
          throw {
            code: 'renderRuntimeUnavailable',
            message: 'The native render pipeline is unavailable on this platform.',
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
      // No longer "install the renderer in Settings": nothing installable decides this any more.
      message: 'This build cannot render video on this computer',
    });
  });

  test('reads the runtime status as exactly the three fields it is about', async () => {
    const service = createNativeRenderService({
      invokeCommand: vi.fn(async () => ({
        available: true,
        reason: null,
        maxConcurrentRenders: 1,
      })),
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });
    await expect(service.status()).resolves.toEqual({
      available: true,
      reason: null,
      maxConcurrentRenders: 1,
    });

    // The renderer version this module once pinned against a frozen constant is gone from both
    // sides. A response that still carries it is a shape this build does not answer to, so it is
    // a protocol error rather than a field quietly ignored.
    const staleShape = createNativeRenderService({
      invokeCommand: vi.fn(async () => ({
        available: true,
        rendererVersion: '0.0.0-not-a-renderer-any-more',
        reason: null,
        maxConcurrentRenders: 1,
      })),
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });
    await expect(staleShape.status()).rejects.toMatchObject({ code: 'invalidRenderResponse' });
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
