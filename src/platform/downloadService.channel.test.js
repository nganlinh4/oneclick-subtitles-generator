// Channel protocol: job binding, event ordering, sequence ledger and handler isolation.
import { v7 as uuidv7 } from 'uuid';

import { normalizeDownloadEvent } from './downloadService';
import { TestChannel, completedEvent, createService, job } from './downloadServiceTestFixtures';

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class MockTauriChannel {},
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}));

it('binds a progress Channel to one durable job and preserves early events in order', async () => {
  const initial = job();
  let resolveStart;
  let nativeChannel;
  const onEvent = vi.fn();
  const invokeCommand = vi.fn((command, args) => {
    nativeChannel = args.onEvent;
    nativeChannel.emit({
      event: 'progress',
      job: job({ id: initial.id, progress: { basisPoints: 2_500 }, sequence: 2 }),
      progress: {
        phase: 'downloading',
        downloadedBytes: 25,
        totalBytes: 100,
        bytesPerSecond: 10,
        etaSeconds: 8,
        fraction: 0.25,
      },
    });
    return new Promise((resolve) => { resolveStart = resolve; });
  });
  const service = createService({ invokeCommand });
  const started = service.startDownload({
    inventoryId: uuidv7(),
    media: { kind: 'video', quality: { mode: 'atMost', height: 1080 } },
    subtitle: { language: 'en', source: 'manual' },
  }, { onEvent });

  expect(onEvent).not.toHaveBeenCalled();
  resolveStart(initial);
  await expect(started).resolves.toEqual(initial);
  expect(onEvent).toHaveBeenNthCalledWith(1, expect.objectContaining({ event: 'progress' }));
  expect(invokeCommand).toHaveBeenCalledWith('download_start', {
    request: {
      inventoryId: expect.any(String),
      media: { kind: 'video', quality: { mode: 'atMost', height: 1080 } },
      subtitle: { language: 'en', source: 'manual' },
    },
    onEvent: expect.any(TestChannel),
  });

  nativeChannel.emit(completedEvent(initial.id, {
    job: job({
      id: initial.id,
      state: 'succeeded',
      progress: { basisPoints: 10_000 },
      sequence: 3,
    }),
  }));
  expect(onEvent).toHaveBeenNthCalledWith(2, expect.objectContaining({ event: 'completed' }));
});

it('fails closed on cross-job and post-terminal events while allowing a native failure envelope', async () => {
  const initial = job();
  let channel;
  const onEvent = vi.fn();
  const onProtocolError = vi.fn();
  const service = createService({
    invokeCommand: vi.fn(async (command, args) => {
      if (command === 'download_start') {
        channel = args.onEvent;
        return initial;
      }
      if (command === 'download_cancel') {
        return job({ id: initial.id, state: 'cancelling', sequence: 2 });
      }
      throw new Error('unexpected command');
    }),
  });
  await service.startDownload({
    inventoryId: uuidv7(),
    media: { kind: 'audio', quality: { mode: 'best' }, format: 'mp3' },
    subtitle: null,
  }, { onEvent, onProtocolError });

  channel.emit({
    event: 'progress',
    job: job(),
    progress: {
      phase: 'downloading', downloadedBytes: null, totalBytes: null,
      bytesPerSecond: null, etaSeconds: null, fraction: null,
    },
  });
  expect(onProtocolError).toHaveBeenCalledTimes(1);
  channel.emit(completedEvent(initial.id));
  channel.emit(completedEvent(initial.id));
  expect(onEvent).not.toHaveBeenCalled();
  expect(onProtocolError).toHaveBeenCalledTimes(1);

  expect(normalizeDownloadEvent({
    event: 'failed',
    job: null,
    error: { code: 'attackerChosenCode', message: 'untrusted native detail' },
  })).toEqual({
    event: 'failed',
    job: null,
    error: {
      code: 'downloadCommandFailed',
      message: 'The native media download could not be completed',
    },
  });
});

it('treats a null-job failure paired with a running start response as a protocol violation', async () => {
  const initial = job();
  const onFailed = vi.fn();
  const onProtocolError = vi.fn();
  const invokeCommand = vi.fn(async (command, args) => {
    if (command === 'download_start') {
      args.onEvent.emit({
        event: 'failed',
        job: null,
        error: { code: 'internal', message: 'failed before registration' },
      });
      return initial;
    }
    if (command === 'download_cancel') {
      return job({ id: initial.id, state: 'cancelling', sequence: 2 });
    }
    throw new Error('unexpected command');
  });
  const service = createService({ invokeCommand });

  await expect(service.startDownload({
    inventoryId: uuidv7(),
    media: { kind: 'audio', quality: { mode: 'best' }, format: 'mp3' },
    subtitle: null,
  }, { onFailed, onProtocolError })).rejects.toMatchObject({
    code: 'invalidDownloadResponse',
  });
  expect(onFailed).not.toHaveBeenCalled();
  expect(onProtocolError).toHaveBeenCalledTimes(1);
  expect(invokeCommand).toHaveBeenCalledWith('download_cancel', { jobId: initial.id });
});

it('rejects regressing job sequence with exactly one cancellation', async () => {
  const initial = job();
  let channel;
  const cancelCalls = [];
  const onProgress = vi.fn();
  const onProtocolError = vi.fn();
  const invokeCommand = vi.fn(async (command, args) => {
    if (command === 'download_start') {
      channel = args.onEvent;
      return initial;
    }
    cancelCalls.push(args.jobId);
    return job({ id: args.jobId, state: 'cancelling', sequence: 4 });
  });
  const service = createService({ invokeCommand });
  await service.startDownload({
    inventoryId: uuidv7(),
    media: { kind: 'video', quality: { mode: 'best' } },
    subtitle: null,
  }, { onProgress, onProtocolError });
  channel.emit({
    event: 'progress',
    job: job({ id: initial.id, progress: { basisPoints: 3_000 }, sequence: 3 }),
    progress: {
      phase: 'downloading', downloadedBytes: 30, totalBytes: 100,
      bytesPerSecond: 10, etaSeconds: 7, fraction: 0.3,
    },
  });
  channel.emit({
    event: 'progress',
    job: job({ id: initial.id, progress: { basisPoints: 2_000 }, sequence: 2 }),
    progress: {
      phase: 'downloading', downloadedBytes: 20, totalBytes: 100,
      bytesPerSecond: 10, etaSeconds: 8, fraction: 0.2,
    },
  });
  await vi.waitFor(() => expect(cancelCalls).toEqual([initial.id]));
  expect(onProgress).toHaveBeenCalledTimes(1);
  expect(onProtocolError).toHaveBeenCalledTimes(1);
});

it('accepts unchanged native job snapshots and stage-local progress resets', async () => {
  const initial = job();
  let channel;
  const onProgress = vi.fn();
  const onProtocolError = vi.fn();
  const invokeCommand = vi.fn(async (command, args) => {
    if (command === 'download_start') {
      channel = args.onEvent;
      return initial;
    }
    throw new Error('valid duplicate snapshots must not cancel');
  });
  const service = createService({ invokeCommand });
  await service.startDownload({
    inventoryId: uuidv7(),
    media: { kind: 'video', quality: { mode: 'best' } },
    subtitle: null,
  }, { onProgress, onProtocolError });

  const emit = (sequence, basisPoints, fraction) => channel.emit({
    event: 'progress',
    job: job({ id: initial.id, progress: { basisPoints }, sequence }),
    progress: {
      phase: 'downloading', downloadedBytes: null, totalBytes: null,
      bytesPerSecond: null, etaSeconds: null, fraction,
    },
  });
  emit(1, 0, 0.99);
  emit(1, 0, 0.01);
  emit(2, 100, 0.005);
  emit(3, 101, 0.006);

  expect(onProgress).toHaveBeenCalledTimes(4);
  expect(onProtocolError).not.toHaveBeenCalled();
  expect(invokeCommand).toHaveBeenCalledTimes(1);
});

it('rejects a conflicting same-sequence native job snapshot exactly once', async () => {
  const initial = job();
  let channel;
  const cancellations = [];
  const onProgress = vi.fn();
  const onProtocolError = vi.fn();
  const service = createService({
    invokeCommand: vi.fn(async (command, args) => {
      if (command === 'download_start') {
        channel = args.onEvent;
        return initial;
      }
      cancellations.push(args.jobId);
      return job({ id: args.jobId, state: 'cancelling', sequence: 2 });
    }),
  });
  await service.startDownload({
    inventoryId: uuidv7(),
    media: { kind: 'video', quality: { mode: 'best' } },
    subtitle: null,
  }, { onProgress, onProtocolError });
  channel.emit({
    event: 'progress',
    job: job({ id: initial.id, state: 'cancelling', sequence: initial.sequence }),
    progress: {
      phase: 'downloading', downloadedBytes: null, totalBytes: null,
      bytesPerSecond: null, etaSeconds: null, fraction: null,
    },
  });

  await vi.waitFor(() => expect(cancellations).toEqual([initial.id]));
  expect(onProgress).not.toHaveBeenCalled();
  expect(onProtocolError).toHaveBeenCalledTimes(1);
});

it('isolates hostile handler thenables without an orphan rejection', async () => {
  const initial = job();
  let channel;
  let legacyCatchCalls = 0;
  const service = createService({
    invokeCommand: vi.fn(async (command, args) => {
      if (command === 'download_start') {
        channel = args.onEvent;
        return initial;
      }
      throw new Error('unexpected command');
    }),
  });
  await service.startDownload({
    inventoryId: uuidv7(),
    media: { kind: 'video', quality: { mode: 'best' } },
    subtitle: null,
  }, {
    onProgress: () => ({
      catch: () => {
        legacyCatchCalls += 1;
        return Promise.reject(new Error('orphaned handler rejection'));
      },
    }),
  });
  channel.emit({
    event: 'progress',
    job: job({ id: initial.id }),
    progress: {
      phase: 'downloading', downloadedBytes: null, totalBytes: null,
      bytesPerSecond: null, etaSeconds: null, fraction: null,
    },
  });
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  expect(legacyCatchCalls).toBe(0);
});

it('freezes the pending queue after overflow and cancels its one owned job once', async () => {
  const initial = job();
  let postFailureReads = 0;
  const cancellations = [];
  const service = createService({
    invokeCommand: vi.fn(async (command, args) => {
      if (command === 'download_start') {
        for (let index = 0; index <= 4_096; index += 1) {
          args.onEvent.emit({
            event: 'progress',
            job: job({ id: initial.id, sequence: index + 1 }),
            progress: {
              phase: 'downloading', downloadedBytes: null, totalBytes: null,
              bytesPerSecond: null, etaSeconds: null, fraction: null,
            },
          });
        }
        const ignored = { event: 'progress' };
        Object.defineProperty(ignored, 'job', {
          enumerable: true,
          get() {
            postFailureReads += 1;
            return job({ id: initial.id });
          },
        });
        args.onEvent.emit(ignored);
        return initial;
      }
      cancellations.push(args.jobId);
      return job({ id: args.jobId, state: 'cancelling', sequence: 2 });
    }),
  });

  await expect(service.startDownload({
    inventoryId: uuidv7(),
    media: { kind: 'video', quality: { mode: 'best' } },
    subtitle: null,
  })).rejects.toMatchObject({ code: 'invalidDownloadResponse' });
  expect(cancellations).toEqual([initial.id]);
  expect(postFailureReads).toBe(0);
});

it('takes one proxy snapshot for returned jobs and channel envelopes', async () => {
  const initial = job();
  let channel;
  let returnedOwnKeys = 0;
  let eventOwnKeys = 0;
  let eventJobOwnKeys = 0;
  const returned = new Proxy(initial, {
    ownKeys(target) {
      returnedOwnKeys += 1;
      return Reflect.ownKeys(target);
    },
  });
  const service = createService({
    invokeCommand: vi.fn(async (_command, args) => {
      channel = args.onEvent;
      return returned;
    }),
  });
  const onProgress = vi.fn();
  await service.startDownload({
    inventoryId: uuidv7(),
    media: { kind: 'video', quality: { mode: 'best' } },
    subtitle: null,
  }, { onProgress });

  const progressJob = new Proxy(job({ id: initial.id }), {
    ownKeys(target) {
      eventJobOwnKeys += 1;
      return Reflect.ownKeys(target);
    },
  });
  const event = new Proxy({
    event: 'progress',
    job: progressJob,
    progress: {
      phase: 'downloading', downloadedBytes: null, totalBytes: null,
      bytesPerSecond: null, etaSeconds: null, fraction: null,
    },
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
