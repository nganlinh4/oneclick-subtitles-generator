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
  kind: 'processMedia',
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

  test('cancels the exact native job after malformed channel data before or after registration', async () => {
    for (const timing of ['before', 'after']) {
      const onProtocolError = vi.fn();
      let channel;
      const invokeCommand = vi.fn(async (command, args) => {
        if (command === 'media_pipeline_start') {
          channel = args.onEvent;
          if (timing === 'before') channel.emit({ event: 'progress' });
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
      const started = service.start({
        operation: 'analysisClip',
        assetId: SOURCE_ID,
        range: { start: 0, end: 2 },
      }, { onProtocolError });

      if (timing === 'before') {
        await expect(started).rejects.toMatchObject({ code: 'invalidMediaPipelineResponse' });
      } else {
        await expect(started).resolves.toMatchObject({ id: JOB_ID });
        channel.emit({ event: 'progress' });
      }

      await vi.waitFor(() => expect(invokeCommand).toHaveBeenCalledWith(
        'media_pipeline_cancel',
        { jobId: JOB_ID }
      ));
      expect(onProtocolError).toHaveBeenCalledTimes(1);
    }
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

  test('contains hostile signal registration and cleanup failures', async () => {
    const removeAfterFailedAdd = vi.fn();
    const invokeCommand = vi.fn();
    const rejected = createNativeMediaPipelineService({
      invokeCommand,
      ChannelConstructor: MockChannel,
      isNativeRuntime: () => true,
    });
    await expect(rejected.run({
      operation: 'analysisClip',
      assetId: SOURCE_ID,
      range: { start: 0, end: 2 },
    }, {
      signal: {
        aborted: false,
        addEventListener() { throw new Error('C:\\private\\signal'); },
        removeEventListener: removeAfterFailedAdd,
      },
    })).rejects.toMatchObject({
      code: 'invalidMediaPipelineRequest',
      message: 'The native media operation request is invalid',
    });
    expect(invokeCommand).not.toHaveBeenCalled();
    expect(removeAfterFailedAdd).toHaveBeenCalledTimes(1);

    const completed = createNativeMediaPipelineService({
      invokeCommand: vi.fn(async (_command, args) => {
        args.onEvent.emit({
          event: 'completed', operation: 'analysisClip',
          job: job('succeeded', 10_000), result: mediaResult(),
        });
        return job();
      }),
      ChannelConstructor: MockChannel,
      isNativeRuntime: () => true,
    });
    await expect(completed.run({
      operation: 'analysisClip',
      assetId: SOURCE_ID,
      range: { start: 0, end: 2 },
    }, {
      signal: {
        aborted: false,
        addEventListener: vi.fn(),
        removeEventListener() { throw new Error('C:\\private\\cleanup'); },
      },
    })).resolves.toEqual(mediaResult());
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

  test('cancels the early owned job when start rejects or returns another identity', async () => {
    const ownedId = JOB_ID;
    const conflictingId = '018f1234-5681-7abc-8def-1234567890ab';
    const request = {
      operation: 'analysisClip', assetId: SOURCE_ID, range: { start: 0, end: 2 },
    };

    for (const outcome of ['reject', 'conflict']) {
      const cancelled = [];
      const invokeCommand = vi.fn(async (command, args) => {
        if (command === 'media_pipeline_start') {
          args.onEvent.emit({
            event: 'progress', operation: 'analysisClip', job: job(),
            phase: 'processing', fraction: 0.1,
          });
          if (outcome === 'reject') throw { code: 'internal' };
          return { ...job(), id: conflictingId };
        }
        cancelled.push(args.jobId);
        return { ...job('cancelling'), id: args.jobId, sequence: 2 };
      });
      const service = createNativeMediaPipelineService({
        invokeCommand, ChannelConstructor: MockChannel, isNativeRuntime: () => true,
      });
      await expect(service.start(request)).rejects.toBeInstanceOf(MediaPipelineServiceError);
      expect(cancelled).toEqual([ownedId]);
      expect(cancelled).not.toContain(conflictingId);
    }
  });

  test('binds operation job kind, quarantines terminal duplicates, and rejects regressions', async () => {
    const wrongKind = createNativeMediaPipelineService({
      invokeCommand: vi.fn().mockResolvedValue(job()),
      ChannelConstructor: MockChannel,
      isNativeRuntime: () => true,
    });
    await expect(wrongKind.start({
      operation: 'generateWaveform',
      assetId: SOURCE_ID,
      range: null,
      pointsPerSecond: 100,
      maxPoints: 1_000,
    })).rejects.toMatchObject({ code: 'invalidMediaPipelineResponse' });

    let channel;
    const cancellations = [];
    const onCompleted = vi.fn();
    const onProgress = vi.fn();
    const onProtocolError = vi.fn();
    const invokeCommand = vi.fn(async (command, args) => {
      if (command === 'media_pipeline_start') {
        channel = args.onEvent;
        return job();
      }
      cancellations.push(args.jobId);
      return { ...job('cancelling'), sequence: 4 };
    });
    const service = createNativeMediaPipelineService({
      invokeCommand, ChannelConstructor: MockChannel, isNativeRuntime: () => true,
    });
    await service.start({
      operation: 'analysisClip', assetId: SOURCE_ID, range: { start: 0, end: 2 },
    }, { onCompleted, onProgress, onProtocolError });
    channel.emit({
      event: 'progress', operation: 'analysisClip',
      job: { ...job(), progress: { basisPoints: 3_000 }, sequence: 3 },
      phase: 'processing', fraction: 0.3,
    });
    channel.emit({
      event: 'progress', operation: 'analysisClip',
      job: { ...job(), progress: { basisPoints: 4_000 }, sequence: 4 },
      phase: 'probing', fraction: 0.4,
    });
    await vi.waitFor(() => expect(cancellations).toEqual([JOB_ID]));
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onProtocolError).toHaveBeenCalledTimes(1);

    const terminalService = createNativeMediaPipelineService({
      invokeCommand: vi.fn(async (command, args) => {
        if (command === 'media_pipeline_start') {
          channel = args.onEvent;
          return job();
        }
        throw new Error('natural terminal duplicates must not cancel');
      }),
      ChannelConstructor: MockChannel,
      isNativeRuntime: () => true,
    });
    const terminalProtocol = vi.fn();
    await terminalService.start({
      operation: 'analysisClip', assetId: SOURCE_ID, range: { start: 0, end: 2 },
    }, { onCompleted, onProtocolError: terminalProtocol });
    const completed = {
      event: 'completed', operation: 'analysisClip',
      job: job('succeeded', 10_000), result: mediaResult(),
    };
    channel.emit(completed);
    channel.emit(completed);
    expect(terminalProtocol).not.toHaveBeenCalled();
  });

  test('accepts same-sequence snapshots across native progress phases but rejects conflicts', async () => {
    let channel;
    const cancellations = [];
    const onProgress = vi.fn();
    const onProtocolError = vi.fn();
    const service = createNativeMediaPipelineService({
      invokeCommand: vi.fn(async (command, args) => {
        if (command === 'media_pipeline_start') {
          channel = args.onEvent;
          return job();
        }
        cancellations.push(args.jobId);
        return { ...job('cancelling'), sequence: 2 };
      }),
      ChannelConstructor: MockChannel,
      isNativeRuntime: () => true,
    });
    await service.start({
      operation: 'analysisClip', assetId: SOURCE_ID, range: { start: 0, end: 2 },
    }, { onProgress, onProtocolError });

    channel.emit({
      event: 'progress', operation: 'analysisClip', job: job(),
      phase: 'processing', fraction: 0.95,
    });
    channel.emit({
      event: 'progress', operation: 'analysisClip', job: job(),
      phase: 'publishing', fraction: 0.05,
    });
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProtocolError).not.toHaveBeenCalled();

    channel.emit({
      event: 'progress', operation: 'analysisClip',
      job: { ...job('cancelling'), sequence: 1 },
      phase: 'publishing', fraction: 0.06,
    });
    await vi.waitFor(() => expect(cancellations).toEqual([JOB_ID]));
    expect(onProtocolError).toHaveBeenCalledTimes(1);
  });

  test('run owns one protocol cancellation and settles from a terminal cancel response', async () => {
    let channel;
    const commands = [];
    const invokeCommand = vi.fn(async (command, args) => {
      commands.push(command);
      if (command === 'media_pipeline_start') {
        channel = args.onEvent;
        return job();
      }
      return job('succeeded', 10_000);
    });
    const service = createNativeMediaPipelineService({
      invokeCommand, ChannelConstructor: MockChannel, isNativeRuntime: () => true,
    });
    const controller = new AbortController();
    const operation = service.run({
      operation: 'analysisClip', assetId: SOURCE_ID, range: { start: 0, end: 2 },
    }, { signal: controller.signal });
    await vi.waitFor(() => expect(channel).toBeDefined());
    controller.abort();
    await expect(Promise.race([
      operation,
      new Promise((_, reject) => setTimeout(() => reject(new Error('run hung')), 250)),
    ])).rejects.toMatchObject({ name: 'AbortError' });
    expect(commands.filter((command) => command === 'media_pipeline_cancel')).toHaveLength(1);

    const protocolCommands = [];
    const protocolService = createNativeMediaPipelineService({
      invokeCommand: vi.fn(async (command, args) => {
        protocolCommands.push(command);
        if (command === 'media_pipeline_start') {
          channel = args.onEvent;
          return job();
        }
        return { ...job('cancelling'), sequence: 2 };
      }),
      ChannelConstructor: MockChannel,
      isNativeRuntime: () => true,
    });
    const protocolRun = protocolService.run({
      operation: 'analysisClip', assetId: SOURCE_ID, range: { start: 0, end: 2 },
    });
    await vi.waitFor(() => expect(channel).toBeDefined());
    channel.emit({ event: 'progress' });
    await expect(protocolRun).rejects.toMatchObject({
      code: 'invalidMediaPipelineResponse',
    });
    expect(protocolCommands.filter((command) => command === 'media_pipeline_cancel'))
      .toHaveLength(1);
  });

  test('settles run from an external terminal cancel response and quarantines its later event', async () => {
    let channel;
    const onProgress = vi.fn();
    const service = createNativeMediaPipelineService({
      invokeCommand: vi.fn(async (command, args) => {
        if (command === 'media_pipeline_start') {
          channel = args.onEvent;
          return job();
        }
        return job('cancelled', 100);
      }),
      ChannelConstructor: MockChannel,
      isNativeRuntime: () => true,
    });
    const operation = service.run({
      operation: 'analysisClip', assetId: SOURCE_ID, range: { start: 0, end: 2 },
    }, { onProgress });
    await vi.waitFor(() => expect(channel).toBeDefined());
    await expect(service.cancel(JOB_ID)).resolves.toMatchObject({ state: 'cancelled' });
    await expect(Promise.race([
      operation,
      new Promise((_, reject) => setTimeout(() => reject(new Error('run hung')), 250)),
    ])).rejects.toMatchObject({ name: 'AbortError' });
    channel.emit({
      event: 'cancelled', operation: 'analysisClip', job: job('cancelled', 100),
    });
    expect(onProgress).not.toHaveBeenCalled();
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

  test('isolates hostile handler thenables without an orphan rejection', async () => {
    let channel;
    let legacyCatchCalls = 0;
    const service = createNativeMediaPipelineService({
      invokeCommand: vi.fn(async (command, args) => {
        if (command === 'media_pipeline_start') {
          channel = args.onEvent;
          return job();
        }
        throw new Error('unexpected command');
      }),
      ChannelConstructor: MockChannel,
      isNativeRuntime: () => true,
    });
    await service.start({
      operation: 'analysisClip', assetId: SOURCE_ID, range: { start: 0, end: 2 },
    }, {
      onProgress: () => ({
        catch: () => {
          legacyCatchCalls += 1;
          return Promise.reject(new Error('orphaned handler rejection'));
        },
      }),
    });
    channel.emit({
      event: 'progress', operation: 'analysisClip', job: job(),
      phase: 'probing', fraction: null,
    });
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(legacyCatchCalls).toBe(0);
  });

  test('takes one proxy snapshot for returned jobs and channel envelopes', async () => {
    let channel;
    let returnedOwnKeys = 0;
    let eventOwnKeys = 0;
    let eventJobOwnKeys = 0;
    const returned = new Proxy(job(), {
      ownKeys(target) {
        returnedOwnKeys += 1;
        return Reflect.ownKeys(target);
      },
    });
    const service = createNativeMediaPipelineService({
      invokeCommand: vi.fn(async (_command, args) => {
        channel = args.onEvent;
        return returned;
      }),
      ChannelConstructor: MockChannel,
      isNativeRuntime: () => true,
    });
    const onProgress = vi.fn();
    await service.start({
      operation: 'analysisClip', assetId: SOURCE_ID, range: { start: 0, end: 2 },
    }, { onProgress });

    const progressJob = new Proxy(job(), {
      ownKeys(target) {
        eventJobOwnKeys += 1;
        return Reflect.ownKeys(target);
      },
    });
    const event = new Proxy({
      event: 'progress', operation: 'analysisClip', job: progressJob,
      phase: 'probing', fraction: null,
    }, {
      ownKeys(target) {
        eventOwnKeys += 1;
        return Reflect.ownKeys(target);
      },
    });
    channel.emit(event);

    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(returnedOwnKeys).toBe(1);
    expect(eventOwnKeys).toBe(1);
    expect(eventJobOwnKeys).toBe(1);
  });
});
