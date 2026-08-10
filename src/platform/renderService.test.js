import { v4 as uuidv4, v7 as uuidv7 } from 'uuid';

import { defaultCustomization } from '../components/subtitleCustomization/defaultCustomization';

import {
  NativeRenderError,
  buildNativeRenderRequest,
  createNativeRenderService,
  normalizeRenderEvent,
  normalizeRenderResultResponse,
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
});

describe('native render lifecycle', () => {
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
    const starting = service.start(request(), { onProgress, onCompleted });
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
      result: result(),
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
});
