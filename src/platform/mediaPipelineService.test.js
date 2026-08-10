import {
  MediaPipelineServiceError,
  createNativeMediaPipelineService,
  normalizeMediaPipelineEvent,
  normalizeMediaPipelineRequest,
} from './mediaPipelineService';

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class TestTauriChannel {},
}));

const SOURCE_ID = '018f1234-5678-7abc-8def-1234567890ab';
const OUTPUT_ID = '018f1234-5679-7abc-8def-1234567890ab';
const JOB_ID = '018f1234-5680-7abc-8def-1234567890ab';
const PLAYBACK_ID = '123e4567-e89b-42d3-a456-426614174000';

const job = (state = 'running', basisPoints = 100) => ({
  id: JOB_ID,
  kind: 'renderVideo',
  state,
  progress: { basisPoints },
  sequence: state === 'running' ? 1 : 2,
});

const inspection = (assetId = OUTPUT_ID) => ({
  assetId,
  durationUs: 2_000_000,
  hasVideo: true,
  hasAudio: true,
  videoCodec: 'h264',
  audioCodec: 'aac',
  width: 1280,
  height: 720,
  frameRate: 30,
  compatibilityAction: 'direct',
  issues: [],
});

const mediaResult = () => ({
  kind: 'media',
  media: {
    asset: {
      id: OUTPUT_ID,
      displayName: 'analysis-clip.mp4',
      extension: 'mp4',
      sizeBytes: 1234,
      kind: 'video',
    },
    playback: {
      id: PLAYBACK_ID,
      playbackUrl: `http://127.0.0.1:32123/asset/${PLAYBACK_ID}?token=${'a'.repeat(64)}`,
      mimeType: 'video/mp4',
      byteLength: 1234,
    },
  },
  inspection: inspection(),
});

class MockChannel {
  static latest = null;

  constructor() {
    MockChannel.latest = this;
    this.onmessage = null;
  }

  emit(value) {
    this.onmessage(value);
  }
}

describe('mediaPipelineService', () => {
  test('normalizes seconds into bounded integer microseconds without accepting paths', () => {
    expect(normalizeMediaPipelineRequest({
      operation: 'analysisClip',
      assetId: SOURCE_ID,
      range: { start: 1.25, end: 3.75 },
    })).toEqual({
      operation: 'analysisClip',
      assetId: SOURCE_ID,
      startUs: 1_250_000,
      endUs: 3_750_000,
    });

    expect(() => normalizeMediaPipelineRequest({
      operation: 'analysisClip',
      assetId: SOURCE_ID,
      range: { start: 1, end: 2 },
      outputPath: 'C:\\private\\clip.mp4',
    })).toThrow(MediaPipelineServiceError);
    expect(() => normalizeMediaPipelineRequest({
      operation: 'analysisClip',
      assetId: SOURCE_ID,
      range: { start: 2, end: 1 },
    })).toThrow(MediaPipelineServiceError);
  });

  test('requires analysis clips to return a fresh opaque asset', () => {
    const event = {
      event: 'completed',
      operation: 'analysisClip',
      job: job('succeeded', 10_000),
      result: mediaResult(),
    };
    expect(normalizeMediaPipelineEvent(event, {
      operation: 'analysisClip', assetId: SOURCE_ID,
    }).result.media.asset.id).toBe(OUTPUT_ID);

    event.result.media.asset.id = SOURCE_ID;
    event.result.inspection.assetId = SOURCE_ID;
    expect(() => normalizeMediaPipelineEvent(event, {
      operation: 'analysisClip', assetId: SOURCE_ID,
    })).toThrow(MediaPipelineServiceError);
  });

  test('requires extracted audio to be a fresh audio asset', () => {
    const event = {
      event: 'completed',
      operation: 'extractAudio',
      job: job('succeeded', 10_000),
      result: mediaResult(),
    };
    event.result.media.asset.kind = 'audio';
    event.result.media.asset.displayName = 'analysis-clip.mp3';
    event.result.media.asset.extension = 'mp3';
    event.result.media.playback.mimeType = 'audio/mpeg';
    expect(normalizeMediaPipelineEvent(event, {
      operation: 'extractAudio', assetId: SOURCE_ID,
    }).result.media.asset.id).toBe(OUTPUT_ID);

    event.result.media.asset.id = SOURCE_ID;
    event.result.inspection.assetId = SOURCE_ID;
    expect(() => normalizeMediaPipelineEvent(event, {
      operation: 'extractAudio', assetId: SOURCE_ID,
    })).toThrow(MediaPipelineServiceError);
  });

  test('rejects playback identity, port, MIME, and display-name injection', () => {
    const event = {
      event: 'completed',
      operation: 'analysisClip',
      job: job('succeeded', 10_000),
      result: mediaResult(),
    };
    event.result.media.playback.playbackUrl = event.result.media.playback.playbackUrl
      .replace(':32123/', ':99999/');
    expect(() => normalizeMediaPipelineEvent(event, {
      operation: 'analysisClip', assetId: SOURCE_ID,
    })).toThrow(MediaPipelineServiceError);

    event.result = mediaResult();
    event.result.media.playback.mimeType = 'video/mp4; charset=utf-8';
    expect(() => normalizeMediaPipelineEvent(event, {
      operation: 'analysisClip', assetId: SOURCE_ID,
    })).toThrow(MediaPipelineServiceError);

    event.result = mediaResult();
    event.result.media.asset.displayName = 'analysis-clip.mp4\nspoof';
    expect(() => normalizeMediaPipelineEvent(event, {
      operation: 'analysisClip', assetId: SOURCE_ID,
    })).toThrow(MediaPipelineServiceError);
  });

  test('validates bounded waveform pyramids', () => {
    const event = normalizeMediaPipelineEvent({
      event: 'completed',
      operation: 'generateWaveform',
      job: { ...job('succeeded', 10_000), kind: 'generateWaveform' },
      result: {
        kind: 'waveform',
        assetId: SOURCE_ID,
        waveform: {
          durationUs: 1_000_000,
          sourceSampleRateHz: 400,
          levels: [{
            pointsPerSecond: 100,
            points: [{ minimum: -1, maximum: 1, rootMeanSquare: 0.5 }],
          }],
        },
      },
    }, { operation: 'generateWaveform', assetId: SOURCE_ID });
    expect(event.result.waveform.levels[0].points).toHaveLength(1);
  });

  test('buffers early channel events, dispatches once, and cancels through the owned command', async () => {
    const completed = vi.fn();
    const calls = [];
    const invokeCommand = vi.fn(async (command, args) => {
      calls.push(command);
      if (command === 'media_pipeline_start') {
        args.onEvent.emit({
          event: 'progress',
          operation: 'analysisClip',
          job: job(),
          phase: 'processing',
          fraction: 0.25,
        });
        return job();
      }
      if (command === 'media_pipeline_cancel') {
        return { ...job('cancelling'), sequence: 2 };
      }
      throw new Error('unexpected command');
    });
    const service = createNativeMediaPipelineService({
      invokeCommand,
      ChannelConstructor: MockChannel,
      isNativeRuntime: () => true,
    });
    const initial = await service.start({
      operation: 'analysisClip',
      assetId: SOURCE_ID,
      range: { start: 0, end: 2 },
    }, { onCompleted: completed });
    expect(initial.id).toBe(JOB_ID);

    MockChannel.latest.emit({
      event: 'completed',
      operation: 'analysisClip',
      job: job('succeeded', 10_000),
      result: mediaResult(),
    });
    expect(completed).toHaveBeenCalledTimes(1);
    await service.cancel(JOB_ID);
    expect(calls).toEqual(['media_pipeline_start', 'media_pipeline_cancel']);
  });

  test('runs an operation to its validated terminal result even when completion arrives early', async () => {
    const progress = vi.fn();
    const service = createNativeMediaPipelineService({
      invokeCommand: vi.fn(async (command, args) => {
        if (command !== 'media_pipeline_start') throw new Error('unexpected command');
        args.onEvent.emit({
          event: 'progress',
          operation: 'analysisClip',
          job: job(),
          phase: 'processing',
          fraction: 0.5,
        });
        args.onEvent.emit({
          event: 'completed',
          operation: 'analysisClip',
          job: job('succeeded', 10_000),
          result: mediaResult(),
        });
        return job();
      }),
      ChannelConstructor: MockChannel,
      isNativeRuntime: () => true,
    });

    await expect(service.run({
      operation: 'analysisClip',
      assetId: SOURCE_ID,
      range: { start: 0, end: 2 },
    }, { onProgress: progress })).resolves.toEqual(mediaResult());
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ fraction: 0.5 }));
  });

  test('bridges AbortSignal cancellation to the native job and rejects as AbortError', async () => {
    let channel;
    const invokeCommand = vi.fn(async (command, args) => {
      if (command === 'media_pipeline_start') {
        channel = args.onEvent;
        return job();
      }
      if (command === 'media_pipeline_cancel') {
        channel.emit({
          event: 'cancelled',
          operation: 'analysisClip',
          job: job('cancelled', 100),
        });
        return job('cancelled', 100);
      }
      throw new Error('unexpected command');
    });
    const service = createNativeMediaPipelineService({
      invokeCommand,
      ChannelConstructor: MockChannel,
      isNativeRuntime: () => true,
    });
    const controller = new AbortController();
    const operation = service.run({
      operation: 'analysisClip',
      assetId: SOURCE_ID,
      range: { start: 0, end: 2 },
    }, { signal: controller.signal });

    controller.abort();

    await expect(operation).rejects.toMatchObject({ name: 'AbortError' });
    expect(invokeCommand).toHaveBeenCalledWith('media_pipeline_cancel', { jobId: JOB_ID });
  });

  test('rejects native terminal failures with only the stable code and generic message', async () => {
    const service = createNativeMediaPipelineService({
      invokeCommand: vi.fn(async (_command, args) => {
        args.onEvent.emit({
          event: 'failed',
          operation: 'analysisClip',
          job: job('failed', 100),
          error: { code: 'mediaToolFailure', message: 'C:\\private\\source.mp4 failed' },
        });
        return job();
      }),
      ChannelConstructor: MockChannel,
      isNativeRuntime: () => true,
    });

    await expect(service.run({
      operation: 'analysisClip',
      assetId: SOURCE_ID,
      range: { start: 0, end: 2 },
    })).rejects.toMatchObject({
      name: 'MediaPipelineServiceError',
      code: 'mediaToolFailure',
      message: 'The native media operation could not be completed',
    });
  });

  test('does not start native work for an already-aborted signal', async () => {
    const invokeCommand = vi.fn();
    const service = createNativeMediaPipelineService({
      invokeCommand,
      ChannelConstructor: MockChannel,
      isNativeRuntime: () => true,
    });
    const controller = new AbortController();
    controller.abort();

    await expect(service.run({
      operation: 'analysisClip',
      assetId: SOURCE_ID,
      range: { start: 0, end: 2 },
    }, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(invokeCommand).not.toHaveBeenCalled();
  });

  test('fails closed outside Tauri', async () => {
    const service = createNativeMediaPipelineService({
      isNativeRuntime: () => false,
    });
    await expect(service.inspect(SOURCE_ID)).rejects.toMatchObject({
      code: 'desktopRuntimeUnavailable',
    });
  });
});
