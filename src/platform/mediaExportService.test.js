import { v7 as uuidv7 } from 'uuid';

import {
  MediaExportError,
  createMediaExportService,
  exportMediaAsset,
  normalizeMediaExportEvent,
} from './mediaExportService';

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

const job = (overrides = {}) => ({
  id: uuidv7(),
  kind: 'exportMedia',
  state: 'running',
  progress: { basisPoints: 0 },
  sequence: 1,
  ...overrides,
});

describe('media export protocol', () => {
  test('accepts only path-free exact event shapes', () => {
    const initial = job();
    expect(normalizeMediaExportEvent({
      event: 'completed',
      job: {
        ...initial,
        state: 'succeeded',
        progress: { basisPoints: 10000 },
        sequence: 2,
      },
      bytesWritten: 42,
    }).bytesWritten).toBe(42);

    expect(() => normalizeMediaExportEvent({
      event: 'completed',
      job: {
        ...initial,
        state: 'succeeded',
        progress: { basisPoints: 10000 },
        sequence: 2,
      },
      bytesWritten: 42,
      path: 'C:\\private\\export.mp4',
    })).toThrow(MediaExportError);
    expect(() => normalizeMediaExportEvent({
      event: 'progress',
      job: { ...initial, kind: 'downloadMedia' },
    })).toThrow(MediaExportError);

    expect(normalizeMediaExportEvent({
      event: 'failed',
      job: null,
      error: { code: 'secretFilesystemFailure', message: 'C:\\private\\export.mp4' },
    }).error).toEqual({
      code: 'mediaExportFailed',
      message: 'The native media export could not be completed',
    });

    let codeReads = 0;
    const error = new Proxy({ code: 'mediaSourceChanged', message: 'ignored' }, {
      get(target, property, receiver) {
        if (property === 'code') {
          codeReads += 1;
          return 'attackerChosenCode';
        }
        return Reflect.get(target, property, receiver);
      },
    });
    expect(normalizeMediaExportEvent({ event: 'failed', job: null, error }).error).toEqual({
      code: 'mediaSourceChanged',
      message: 'The stored media changed while it was being exported',
    });
    expect(codeReads).toBe(0);
  });

  test('dialog cancellation creates no synthetic job or terminal event', async () => {
    const invokeCommand = vi.fn().mockResolvedValue(null);
    const onEvent = vi.fn();
    const service = createMediaExportService({
      invokeCommand,
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });
    const assetId = uuidv7();

    await expect(service.start(assetId, { onEvent })).resolves.toBeNull();
    expect(onEvent).not.toHaveBeenCalled();
    expect(invokeCommand).toHaveBeenCalledWith('media_export_start', {
      request: { assetId },
      onEvent: expect.any(TestChannel),
    });
    expect(JSON.stringify(invokeCommand.mock.calls)).not.toMatch(/path|destination|source/i);
  });

  test('buffers early progress and enforces a monotonic terminal lifecycle', async () => {
    let resolveInvoke;
    const invokeCommand = vi.fn(() => new Promise((resolve) => { resolveInvoke = resolve; }));
    const onProgress = vi.fn();
    const onCompleted = vi.fn();
    const service = createMediaExportService({
      invokeCommand,
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });
    const initial = job();
    const starting = service.start(initial.id, { onProgress, onCompleted });
    TestChannel.latest.emit({
      event: 'progress',
      job: { ...initial, progress: { basisPoints: 2500 }, sequence: 2 },
    });
    resolveInvoke(initial);
    await expect(starting).resolves.toEqual(expect.objectContaining({ id: initial.id }));
    expect(onProgress).toHaveBeenCalledTimes(1);

    TestChannel.latest.emit({
      event: 'completed',
      job: {
        ...initial,
        state: 'succeeded',
        progress: { basisPoints: 10000 },
        sequence: 3,
      },
      bytesWritten: 123,
    });
    expect(onCompleted).toHaveBeenCalledTimes(1);
  });

  test('a mismatched event fails closed and cancels the actual job', async () => {
    const initial = job();
    const invokeCommand = vi.fn(async (command) => {
      if (command === 'media_export_start') return initial;
      return { ...initial, state: 'cancelling', sequence: 2 };
    });
    const onProtocolError = vi.fn();
    const service = createMediaExportService({
      invokeCommand,
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });
    await service.start(initial.id, { onProtocolError });

    TestChannel.latest.emit({
      event: 'progress',
      job: { ...initial, id: uuidv7(), sequence: 2 },
    });
    await Promise.resolve();

    expect(onProtocolError).toHaveBeenCalledTimes(1);
    expect(invokeCommand).toHaveBeenCalledWith('job_cancel', { id: initial.id });
  });

  test('generic cancellation response must still be the same export job', async () => {
    const initial = job();
    const invokeCommand = vi.fn().mockResolvedValue({
      ...initial,
      state: 'cancelling',
      sequence: 2,
    });
    const service = createMediaExportService({
      invokeCommand,
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });

    await expect(service.cancel(initial.id)).resolves.toEqual(expect.objectContaining({
      id: initial.id,
      state: 'cancelling',
    }));
    expect(invokeCommand).toHaveBeenCalledWith('job_cancel', { id: initial.id });
  });

  test('a null-job failure cannot settle a subsequently returned running job', async () => {
    let resolveStart;
    const initial = job();
    const invokeCommand = vi.fn((command) => {
      if (command === 'media_export_start') {
        return new Promise((resolve) => { resolveStart = resolve; });
      }
      if (command === 'job_cancel') {
        return Promise.resolve({ ...initial, state: 'cancelling', sequence: 2 });
      }
      throw new Error('unexpected command');
    });
    const onCompleted = vi.fn();
    const service = createMediaExportService({
      invokeCommand,
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });
    const starting = service.start(initial.id, { onCompleted });
    TestChannel.latest.emit({
      event: 'failed',
      job: null,
      error: { code: 'mediaExportFailed', message: 'ignored native message' },
    });
    resolveStart(initial);

    await expect(starting).rejects.toMatchObject({ code: 'invalidMediaExportResponse' });
    expect(invokeCommand).toHaveBeenCalledWith('job_cancel', { id: initial.id });
    TestChannel.latest.emit({
      event: 'completed',
      job: {
        ...initial,
        state: 'succeeded',
        progress: { basisPoints: 10_000 },
        sequence: 3,
      },
      bytesWritten: 123,
    });
    expect(onCompleted).not.toHaveBeenCalled();
  });

  test('collapses hostile invocation metadata and rejects ineffective cancellation', async () => {
    const hostile = {};
    Object.defineProperty(hostile, 'code', {
      get() {
        throw new Error('secret-bearing getter');
      },
    });
    const failing = createMediaExportService({
      invokeCommand: vi.fn().mockRejectedValue(hostile),
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });
    await expect(failing.start(uuidv7(), {})).rejects.toMatchObject({
      code: 'mediaExportFailed',
      message: 'The native media export could not be completed',
    });

    const initial = job();
    const ineffective = createMediaExportService({
      invokeCommand: vi.fn().mockResolvedValue(initial),
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });
    await expect(ineffective.cancel(initial.id)).rejects.toMatchObject({
      code: 'invalidMediaExportResponse',
    });
  });

  test('reads invocation codes once and quarantines an early protocol terminal', async () => {
    let reads = 0;
    const changing = {};
    Object.defineProperty(changing, 'code', {
      get() {
        reads += 1;
        return reads === 1 ? 'internal' : 'attackerChosenCode';
      },
    });
    const failing = createMediaExportService({
      invokeCommand: vi.fn().mockRejectedValue(changing),
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });
    await expect(failing.start(uuidv7(), {})).rejects.toMatchObject({ code: 'internal' });
    expect(reads).toBe(1);

    const protocolFailure = new MediaExportError(
      'invalidMediaExportResponse',
      'The desktop host returned invalid media export data',
    );
    const onStarted = vi.fn();
    const service = {
      start: vi.fn(async (_assetId, handlers) => {
        handlers.onProtocolError(protocolFailure);
        throw new Error('start response was lost');
      }),
    };
    await expect(exportMediaAsset(uuidv7(), { onStarted }, service)).rejects.toBe(
      protocolFailure,
    );
    expect(onStarted).not.toHaveBeenCalled();

    const completed = {
      event: 'completed',
      job: job({
        state: 'succeeded',
        progress: { basisPoints: 10_000 },
        sequence: 2,
      }),
      bytesWritten: 123,
    };
    const completedService = {
      start: vi.fn(async (_assetId, handlers) => {
        handlers.onCompleted(completed);
        throw new Error('start response was lost');
      }),
    };
    await expect(exportMediaAsset(uuidv7(), { onStarted }, completedService)).resolves.toEqual({
      status: 'completed',
      ...completed,
    });
  });

  test('the real channel adapter preserves an early completion when start IPC is lost', async () => {
    let rejectStart;
    const initial = job({
      state: 'succeeded',
      progress: { basisPoints: 10_000 },
      sequence: 2,
    });
    const invokeCommand = vi.fn((command) => {
      if (command === 'media_export_start') {
        return new Promise((_resolve, reject) => { rejectStart = reject; });
      }
      throw new Error('unexpected command');
    });
    const service = createMediaExportService({
      invokeCommand,
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });
    const onStarted = vi.fn();
    const exporting = exportMediaAsset(initial.id, { onStarted }, service);
    TestChannel.latest.emit({ event: 'completed', job: initial, bytesWritten: 123 });
    rejectStart({ code: 'internal', message: 'transport response lost' });

    await expect(exporting).resolves.toEqual({
      status: 'completed',
      event: 'completed',
      job: initial,
      bytesWritten: 123,
    });
    expect(onStarted).not.toHaveBeenCalled();
  });

  test('cancels a returned job ID when the start snapshot is malformed', async () => {
    const initial = job();
    const invokeCommand = vi.fn(async (command) => {
      if (command === 'media_export_start') return { ...initial, kind: 'renderVideo' };
      if (command === 'job_cancel') {
        return { ...initial, state: 'cancelling', sequence: 2 };
      }
      throw new Error('unexpected command');
    });
    const service = createMediaExportService({
      invokeCommand,
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });

    await expect(service.start(initial.id, {})).rejects.toMatchObject({
      code: 'invalidMediaExportResponse',
    });
    expect(invokeCommand).toHaveBeenCalledWith('job_cancel', { id: initial.id });
  });

  test('rejects invalid IDs before invoking the host', async () => {
    const invokeCommand = vi.fn();
    const service = createMediaExportService({
      invokeCommand,
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });
    await expect(service.start('not-an-id')).rejects.toMatchObject({
      code: 'invalidMediaExportRequest',
    });
    expect(invokeCommand).not.toHaveBeenCalled();
  });
});
