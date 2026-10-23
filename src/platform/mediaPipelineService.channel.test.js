// Channel protocol: early-event buffering, owned cancellation, job-kind binding and proxy snapshots.
import {
  MediaPipelineServiceError,
  createNativeMediaPipelineService,
} from './mediaPipelineService';

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
