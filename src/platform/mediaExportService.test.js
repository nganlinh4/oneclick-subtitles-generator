import { v7 as uuidv7 } from 'uuid';

import {
  MediaExportError,
  createMediaExportService,
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
