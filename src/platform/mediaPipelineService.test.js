import {
  MediaPipelineServiceError,
  createNativeMediaPipelineService,
  normalizeMediaPipelineEvent,
  normalizeMediaPipelineRequest,
} from './mediaPipelineService';

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class TestTauriChannel {},
}));
import {
  MockChannel,
  OUTPUT_ID,
  SOURCE_ID,
  inspection,
  job,
  mediaResult,
} from './mediaPipelineServiceTestFixtures';

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
    const rawEvent = {
      event: 'completed',
      operation: 'generateWaveform',
      job: { ...job('succeeded', 10_000), kind: 'generateWaveform' },
      result: {
        kind: 'waveform',
        assetId: SOURCE_ID,
        cacheHit: true,
        waveform: {
          durationUs: 1_000_000,
          sourceSampleRateHz: 400,
          levels: [{
            pointsPerSecond: 100,
            points: [{ minimum: -1, maximum: 1, rootMeanSquare: 0.5 }],
          }],
        },
      },
    };
    const event = normalizeMediaPipelineEvent(rawEvent, {
      operation: 'generateWaveform', assetId: SOURCE_ID,
    });
    expect(event.result.waveform.levels[0].points).toHaveLength(1);
    expect(event.result.cacheHit).toBe(true);

    delete rawEvent.result.cacheHit;
    expect(() => normalizeMediaPipelineEvent(rawEvent, {
      operation: 'generateWaveform', assetId: SOURCE_ID,
    })).toThrow(MediaPipelineServiceError);
    rawEvent.result.cacheHit = 'yes';
    expect(() => normalizeMediaPipelineEvent(rawEvent, {
      operation: 'generateWaveform', assetId: SOURCE_ID,
    })).toThrow(MediaPipelineServiceError);
  });

  test('collapses unknown failure codes and rejects impossible progress states', () => {
    expect(normalizeMediaPipelineEvent({
      event: 'failed', operation: 'extractAudio', job: job('failed', 100),
      error: { code: 'mediaMissingAudio', message: 'private provider details must not be forwarded' },
    }, { operation: 'extractAudio', assetId: SOURCE_ID })).toMatchObject({
      error: { code: 'mediaMissingAudio', message: 'The selected media does not contain an audio stream.' },
    });
    expect(normalizeMediaPipelineEvent({
      event: 'failed',
      operation: 'analysisClip',
      job: job('failed', 100),
      error: { code: 'attackerChosenCode', message: 'C:\\private\\source.mp4' },
    }, { operation: 'analysisClip', assetId: SOURCE_ID })).toMatchObject({
      error: {
        code: 'mediaPipelineFailed',
        message: 'The native media operation could not be completed',
      },
    });

    expect(() => normalizeMediaPipelineEvent({
      event: 'progress',
      operation: 'analysisClip',
      job: job('succeeded', 10_000),
      phase: 'publishing',
      fraction: 1,
    }, { operation: 'analysisClip', assetId: SOURCE_ID })).toThrow(MediaPipelineServiceError);

    const accessor = { message: 'private' };
    Object.defineProperty(accessor, 'code', {
      enumerable: true,
      get() { throw new Error('C:\\private\\getter'); },
    });
    expect(() => normalizeMediaPipelineEvent({
      event: 'failed',
      operation: 'analysisClip',
      job: job('failed', 100),
      error: accessor,
    }, { operation: 'analysisClip', assetId: SOURCE_ID })).toThrow(MediaPipelineServiceError);
  });

  test('collapses unknown command failures and hostile code accessors', async () => {
    const unknown = createNativeMediaPipelineService({
      invokeCommand: vi.fn().mockRejectedValue({
        code: 'attackerChosenCode', message: 'C:\\private\\source.mp4',
      }),
      ChannelConstructor: MockChannel,
      isNativeRuntime: () => true,
    });
    await expect(unknown.inspect(SOURCE_ID)).rejects.toMatchObject({
      code: 'mediaPipelineFailed',
    });

    const accessor = {};
    Object.defineProperty(accessor, 'code', {
      get() { throw new Error('C:\\private\\getter'); },
    });
    const hostile = createNativeMediaPipelineService({
      invokeCommand: vi.fn().mockRejectedValue(accessor),
      ChannelConstructor: MockChannel,
      isNativeRuntime: () => true,
    });
    await expect(hostile.inspect(SOURCE_ID)).rejects.toMatchObject({
      name: 'MediaPipelineServiceError',
      code: 'mediaPipelineFailed',
    });
  });

  test('fails closed outside Tauri', async () => {
    const service = createNativeMediaPipelineService({
      isNativeRuntime: () => false,
    });
    await expect(service.inspect(SOURCE_ID)).rejects.toMatchObject({
      code: 'desktopRuntimeUnavailable',
    });
  });

  test('reads command codes once and rejects accessor-backed native responses', async () => {
    let codeReads = 0;
    const commandFailure = {};
    Object.defineProperty(commandFailure, 'code', {
      get() {
        codeReads += 1;
        return codeReads === 1 ? 'internal' : 'attackerChosenCode';
      },
    });
    const failed = createNativeMediaPipelineService({
      invokeCommand: vi.fn().mockRejectedValue(commandFailure),
      ChannelConstructor: MockChannel,
      isNativeRuntime: () => true,
    });
    await expect(failed.inspect(SOURCE_ID)).rejects.toMatchObject({ code: 'internal' });
    expect(codeReads).toBe(1);

    const response = inspection(SOURCE_ID);
    let idReads = 0;
    Object.defineProperty(response, 'assetId', {
      enumerable: true,
      get() {
        idReads += 1;
        return idReads < 3 ? SOURCE_ID : 'secret-from-getter';
      },
    });
    const hostileResponse = createNativeMediaPipelineService({
      invokeCommand: vi.fn().mockResolvedValue(response),
      ChannelConstructor: MockChannel,
      isNativeRuntime: () => true,
    });
    await expect(hostileResponse.inspect(SOURCE_ID)).rejects.toMatchObject({
      code: 'invalidMediaPipelineResponse',
    });
    expect(idReads).toBe(0);
  });

  test('preserves the current media identity conflict command code', async () => {
    const service = createNativeMediaPipelineService({
      invokeCommand: vi.fn().mockRejectedValue({ code: 'mediaIdentityConflict' }),
      ChannelConstructor: MockChannel,
      isNativeRuntime: () => true,
    });
    await expect(service.inspect(SOURCE_ID)).rejects.toMatchObject({
      code: 'mediaIdentityConflict',
    });
  });

});
