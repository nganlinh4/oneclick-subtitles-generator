// Cancellation: owned-job cancel after protocol faults, lost or conflicting starts, terminal cancel responses.
import { v4 as uuidv4, v7 as uuidv7 } from 'uuid';

import { DownloadServiceError } from './downloadService';
import { completedEvent, createService, job } from './downloadServiceTestFixtures';

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class MockTauriChannel {},
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}));

it('cancels the exact native job after malformed channel data before or after registration', async () => {
  const request = {
    inventoryId: uuidv7(),
    media: { kind: 'audio', quality: { mode: 'best' }, format: 'mp3' },
    subtitle: null,
  };

  for (const timing of ['before', 'after']) {
    const initial = job();
    let channel;
    const onProtocolError = vi.fn();
    const invokeCommand = vi.fn(async (command, args) => {
      if (command === 'download_start') {
        channel = args.onEvent;
        if (timing === 'before') channel.emit({ event: 'progress' });
        return initial;
      }
      if (command === 'download_cancel') {
        return job({ id: initial.id, state: 'cancelling', sequence: 2 });
      }
      throw new Error('unexpected command');
    });
    const service = createService({ invokeCommand });
    const started = service.startDownload(request, { onProtocolError });

    if (timing === 'before') {
      await expect(started).rejects.toMatchObject({ code: 'invalidDownloadResponse' });
    } else {
      await expect(started).resolves.toMatchObject({ id: initial.id });
      channel.emit({ event: 'progress' });
    }

    await vi.waitFor(() => expect(invokeCommand).toHaveBeenCalledWith(
      'download_cancel',
      { jobId: initial.id }
    ));
    expect(onProtocolError).toHaveBeenCalledTimes(1);
  }
});

it('cancels only UUIDv7 download jobs and verifies the returned identity', async () => {
  const id = uuidv7();
  const cancelling = job({ id, state: 'cancelling', sequence: 2 });
  const invokeCommand = vi.fn().mockResolvedValue(cancelling);
  const service = createService({ invokeCommand });

  await expect(service.cancelDownload(id)).resolves.toEqual(cancelling);
  expect(invokeCommand).toHaveBeenCalledWith('download_cancel', { jobId: id });
  await expect(service.cancelDownload(uuidv4())).rejects.toMatchObject({
    code: 'invalidDownloadRequest',
  });
});

it('uses a terminal cancel response as the one terminal authority without waiting for an event', async () => {
  const initial = job();
  let channel;
  const onEvent = vi.fn();
  const onCancelled = vi.fn(() => Promise.reject(new Error('ignored callback rejection')));
  const onCompleted = vi.fn();
  const invokeCommand = vi.fn(async (command, args) => {
    if (command === 'download_start') {
      channel = args.onEvent;
      return initial;
    }
    return job({ id: initial.id, state: 'cancelled', sequence: 2 });
  });
  const service = createService({ invokeCommand });
  await service.startDownload({
    inventoryId: uuidv7(),
    media: { kind: 'video', quality: { mode: 'best' } },
    subtitle: null,
  }, { onEvent, onCancelled, onCompleted });

  const firstCancel = service.cancelDownload(initial.id);
  const duplicateCancel = service.cancelDownload(initial.id);
  await expect(firstCancel).resolves.toMatchObject({ state: 'cancelled' });
  await expect(duplicateCancel).resolves.toMatchObject({ state: 'cancelled' });
  expect(onCancelled).toHaveBeenCalledTimes(1);
  expect(onEvent).toHaveBeenCalledTimes(1);
  channel.emit({
    event: 'cancelled',
    job: job({ id: initial.id, state: 'cancelled', sequence: 2 }),
  });
  expect(onCancelled).toHaveBeenCalledTimes(1);
  expect(onCompleted).not.toHaveBeenCalled();
  expect(invokeCommand.mock.calls.filter(([command]) => command === 'download_cancel'))
    .toHaveLength(1);
});

it('turns a payload-less successful cancel response into one fixed protocol terminal', async () => {
  const initial = job();
  let channel;
  const onCompleted = vi.fn();
  const onProtocolError = vi.fn();
  const service = createService({
    invokeCommand: vi.fn(async (command, args) => {
      if (command === 'download_start') {
        channel = args.onEvent;
        return initial;
      }
      return job({ id: initial.id, state: 'succeeded', progress: { basisPoints: 10_000 }, sequence: 2 });
    }),
  });
  await service.startDownload({
    inventoryId: uuidv7(),
    media: { kind: 'video', quality: { mode: 'best' } },
    subtitle: null,
  }, { onCompleted, onProtocolError });

  await service.cancelDownload(initial.id);
  expect(onProtocolError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    code: 'invalidDownloadResponse',
  }));
  channel.emit(completedEvent(initial.id));
  expect(onCompleted).not.toHaveBeenCalled();
  expect(onProtocolError).toHaveBeenCalledTimes(1);
});

it('cancels an early owned job when the start response is lost or conflicts', async () => {
  const request = {
    inventoryId: uuidv7(),
    media: { kind: 'video', quality: { mode: 'best' } },
    subtitle: null,
  };
  const owned = job();

  for (const outcome of ['reject', 'conflict']) {
    const response = job();
    const cancelled = [];
    const invokeCommand = vi.fn(async (command, args) => {
      if (command === 'download_start') {
        args.onEvent.emit({
          event: 'progress',
          job: job({ id: owned.id, progress: { basisPoints: 100 }, sequence: 1 }),
          progress: {
            phase: 'downloading', downloadedBytes: 1, totalBytes: 10,
            bytesPerSecond: 1, etaSeconds: 9, fraction: 0.1,
          },
        });
        if (outcome === 'reject') throw { code: 'internal' };
        return response;
      }
      if (command === 'download_cancel') {
        cancelled.push(args.jobId);
        return job({ id: args.jobId, state: 'cancelling', sequence: 2 });
      }
      throw new Error('unexpected command');
    });
    const service = createService({ invokeCommand });

    await expect(service.startDownload(request)).rejects.toBeInstanceOf(DownloadServiceError);
    expect(cancelled).toEqual([owned.id]);
    expect(cancelled).not.toContain(response.id);
  }
});

it('cancels a queued start response and quarantines natural terminal duplicates', async () => {
  const request = {
    inventoryId: uuidv7(),
    media: { kind: 'video', quality: { mode: 'best' } },
    subtitle: null,
  };
  const queued = job({ state: 'queued', progress: { basisPoints: 0 }, sequence: 0 });
  const queuedCancels = [];
  const queuedService = createService({
    invokeCommand: vi.fn(async (command, args) => {
      if (command === 'download_start') return queued;
      queuedCancels.push(args.jobId);
      return job({ id: args.jobId, state: 'cancelling', sequence: 1 });
    }),
  });
  await expect(queuedService.startDownload(request)).rejects.toMatchObject({
    code: 'invalidDownloadResponse',
  });
  expect(queuedCancels).toEqual([queued.id]);

  const initial = job();
  let channel;
  const onCompleted = vi.fn();
  const onProtocolError = vi.fn();
  const invokeCommand = vi.fn(async (command, args) => {
    if (command === 'download_start') {
      channel = args.onEvent;
      return initial;
    }
    throw new Error('a natural terminal duplicate must not cancel');
  });
  const service = createService({ invokeCommand });
  await service.startDownload(request, { onCompleted, onProtocolError });
  channel.emit(completedEvent(initial.id));
  channel.emit(completedEvent(initial.id));
  expect(onCompleted).toHaveBeenCalledTimes(1);
  expect(onProtocolError).not.toHaveBeenCalled();
  expect(invokeCommand).toHaveBeenCalledTimes(1);
});

