// run(): terminal results, AbortSignal bridging and run-owned cancellation.
import { createNativeMediaPipelineService } from './mediaPipelineService';

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class TestTauriChannel {},
}));
import {
  JOB_ID,
  MockChannel,
  SOURCE_ID,
  job,
  mediaResult,
} from './mediaPipelineServiceTestFixtures';

describe('mediaPipelineService', () => {
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

});
