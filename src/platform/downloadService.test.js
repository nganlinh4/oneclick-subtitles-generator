import fs from 'fs';
import path from 'path';
import { v4 as uuidv4, v7 as uuidv7 } from 'uuid';

import {
  DownloadServiceError,
  createNativeDownloadService,
  normalizeDownloadEvent,
} from './downloadService';

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class MockTauriChannel {},
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}));

class TestChannel {
  onmessage = () => {};

  emit(value) {
    this.onmessage(value);
  }
}

const job = (overrides = {}) => ({
  id: uuidv7(),
  kind: 'downloadMedia',
  state: 'running',
  progress: { basisPoints: 0 },
  sequence: 1,
  ...overrides,
});

const inventory = (overrides = {}) => ({
  title: 'Example video',
  durationSeconds: 125,
  formats: {
    video: [{
      formatId: '137',
      container: 'mp4',
      width: 1920,
      height: 1080,
      fpsMilli: 30_000,
      codec: 'avc1.640028',
      includesAudio: false,
      sizeBytes: 5_000_000,
      bitrateKbps: 4_500,
    }],
    audio: [{
      formatId: '140',
      container: 'm4a',
      codec: 'mp4a.40.2',
      sizeBytes: 500_000,
      bitrateKbps: 128,
    }],
    qualities: [{ height: 1080, hasCombined: false, hasVideoOnly: true }],
  },
  subtitles: [{ language: 'en', source: 'manual', formats: ['srt', 'vtt'] }],
  ...overrides,
});

const inspection = (overrides = {}) => ({
  capability: { id: uuidv7(), expiresAtMs: Date.now() + 60_000 },
  inventory: inventory(),
  ...overrides,
});

const summary = (overrides = {}) => ({
  title: 'Example video',
  durationSeconds: 125,
  mediaFilename: 'Example video.mp4',
  mediaBytes: 5_000_000,
  subtitleFilename: null,
  subtitleBytes: null,
  subtitleLanguage: null,
  ...overrides,
});

const completedEvent = (id, overrides = {}) => {
  return {
    event: 'completed',
    job: job({
      id,
      state: 'succeeded',
      progress: { basisPoints: 10_000 },
      sequence: 2,
    }),
    media: {
      asset: {
        id: uuidv7(),
        displayName: 'Example video.mp4',
        extension: 'mp4',
        sizeBytes: 5_000_000,
        kind: 'video',
      },
      contentIdentity: {
        algorithm: 'blake3-256',
        digest: 'a'.repeat(64),
        sizeBytes: 5_000_000,
      },
    },
    summary: summary(),
    subtitle: null,
    ...overrides,
  };
};

const createService = (overrides = {}) => createNativeDownloadService({
  invokeCommand: vi.fn(),
  ChannelConstructor: TestChannel,
  isNativeRuntime: () => true,
  ...overrides,
});

it('contains no fixed legacy port, fetch, base64 transport, browser persistence, or raw args', () => {
  const source = fs.readFileSync(path.join(__dirname, 'downloadService.js'), 'utf8');
  expect(source).not.toMatch(/\bfetch\s*\(/);
  expect(source).not.toMatch(/localStorage\s*\./);
  expect(source).not.toContain('3031');
  expect(source).not.toMatch(/\bbase64\b/i);
  expect(source).not.toMatch(/rawArgs|additionalArgs|commandLine/i);
});

it('reports native unavailability honestly and invokes exact status/inspect shapes', async () => {
  const inspected = inspection();
  const invokeCommand = vi.fn(async (command) => {
    if (command === 'download_status') {
      return {
        available: false,
        inspectAvailable: true,
        version: '2026.08.01',
        reason: 'mediaToolsUnavailable',
        maxConcurrentDownloads: 4,
        inventoryTtlSeconds: 900,
      };
    }
    return inspected;
  });
  const service = createService({ invokeCommand });

  await expect(service.getStatus()).resolves.toMatchObject({
    available: false,
    inspectAvailable: true,
    reason: 'mediaToolsUnavailable',
  });
  await expect(service.inspectUrl({
    url: 'https://www.youtube.com/watch?v=example',
    cookieSource: 'none',
  })).resolves.toEqual(inspected);
  expect(invokeCommand).toHaveBeenNthCalledWith(1, 'download_status', {});
  expect(invokeCommand).toHaveBeenNthCalledWith(2, 'download_inspect', {
    request: {
      url: 'https://www.youtube.com/watch?v=example',
      cookieSource: 'none',
    },
  });
});

it('accepts an honest missing JavaScript runtime status without enabling inspection', async () => {
  const service = createService({
    invokeCommand: vi.fn().mockResolvedValue({
      available: false,
      inspectAvailable: false,
      version: null,
      reason: 'javascriptRuntimeUnavailable',
      maxConcurrentDownloads: 4,
      inventoryTtlSeconds: 900,
    }),
  });

  await expect(service.getStatus()).resolves.toEqual({
    available: false,
    inspectAvailable: false,
    version: null,
    reason: 'javascriptRuntimeUnavailable',
    maxConcurrentDownloads: 4,
    inventoryTtlSeconds: 900,
  });
});

it('rejects an unavailable status that omits its native reason', async () => {
  const service = createService({
    invokeCommand: vi.fn().mockResolvedValue({
      available: false,
      inspectAvailable: false,
      version: null,
      reason: null,
      maxConcurrentDownloads: 4,
      inventoryTtlSeconds: 900,
    }),
  });

  await expect(service.getStatus()).rejects.toMatchObject({
    code: 'invalidDownloadResponse',
  });
});

it('rejects hostile request authority before IPC and accepts only opaque inventory capabilities', async () => {
  const invokeCommand = vi.fn();
  const service = createService({ invokeCommand });
  const invalid = [
    { url: 'https://youtube.com/watch?v=x', cookieSource: 'none', rawArgs: ['--exec', 'x'] },
    { url: `https://youtube.com/${'x'.repeat(8_193)}`, cookieSource: 'none' },
    { url: 'https://youtube.com/watch?v=x\n--exec', cookieSource: 'none' },
    { url: 'https://youtube.com/watch?v=x', cookieSource: 'arbitrary-browser' },
  ];
  invalid.forEach((request) => {
    expect(() => service.inspectUrl(request)).toThrow(DownloadServiceError);
  });
  expect(invokeCommand).not.toHaveBeenCalled();

  await expect(service.startDownload({
    inventoryId: uuidv4(),
    media: { kind: 'video', quality: { mode: 'best' } },
    subtitle: null,
  })).rejects.toMatchObject({ code: 'invalidDownloadRequest' });
  await expect(service.startDownload({
    inventoryId: uuidv7(),
    media: { kind: 'video', quality: { mode: 'best' }, outputPath: 'C:\\private' },
    subtitle: null,
  })).rejects.toMatchObject({ code: 'invalidDownloadRequest' });
  expect(invokeCommand).not.toHaveBeenCalled();
});

it('bounds and strictly decodes inventory responses without reflecting path-shaped fields', async () => {
  const invokeCommand = vi.fn()
    .mockResolvedValueOnce(inspection({ privatePath: 'C:\\Users\\private' }))
    .mockResolvedValueOnce(inspection({
      inventory: inventory({
        formats: {
          video: Array.from({ length: 4_097 }, (_, index) => ({
            ...inventory().formats.video[0],
            formatId: `v${index}`,
          })),
          audio: [],
          qualities: [],
        },
      }),
    }));
  const service = createService({ invokeCommand });
  const request = { url: 'https://youtu.be/example', cookieSource: 'none' };

  await expect(service.inspectUrl(request)).rejects.toMatchObject({
    code: 'invalidDownloadResponse',
  });
  await expect(service.inspectUrl(request)).rejects.toMatchObject({
    code: 'invalidDownloadResponse',
  });
});

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

it('rejects unknown command codes, hostile code accessors, and impossible event states', async () => {
  const unknown = createService({
    invokeCommand: vi.fn().mockRejectedValue({ code: 'attackerChosenCode', message: 'private' }),
  });
  await expect(unknown.getStatus()).rejects.toMatchObject({ code: 'downloadCommandFailed' });

  const accessor = {};
  Object.defineProperty(accessor, 'code', {
    get() { throw new Error('C:\\private\\getter'); },
  });
  const hostile = createService({ invokeCommand: vi.fn().mockRejectedValue(accessor) });
  await expect(hostile.getStatus()).rejects.toMatchObject({
    name: 'DownloadServiceError',
    code: 'downloadCommandFailed',
  });

  expect(() => normalizeDownloadEvent({
    event: 'progress',
    job: job({ state: 'succeeded', progress: { basisPoints: 10_000 }, sequence: 2 }),
    progress: {
      phase: 'downloadFinished', downloadedBytes: 1, totalBytes: 1,
      bytesPerSecond: null, etaSeconds: null, fraction: 1,
    },
  })).toThrow(DownloadServiceError);
});

it('rejects raw diagnostics, path-bearing media envelopes, partial subtitles, and unsafe bytes', () => {
  const id = uuidv7();
  expect(() => normalizeDownloadEvent({
    event: 'failed',
    job: null,
    error: { code: 'downloadFailed', message: 'failed', path: 'C:\\private' },
  })).toThrow(DownloadServiceError);

  const pathBearing = completedEvent(id);
  pathBearing.media.asset.path = 'C:\\private\\video.mp4';
  expect(() => normalizeDownloadEvent(pathBearing)).toThrow(DownloadServiceError);

  const partialSubtitle = completedEvent(id, {
    summary: summary({ subtitleFilename: 'track.srt' }),
  });
  expect(() => normalizeDownloadEvent(partialSubtitle)).toThrow(DownloadServiceError);

  const unsafeBytes = completedEvent(id);
  unsafeBytes.media.asset.sizeBytes = Number.MAX_SAFE_INTEGER + 1;
  expect(() => normalizeDownloadEvent(unsafeBytes)).toThrow(DownloadServiceError);
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

it('reads invocation codes once and rejects accessor-backed native responses', async () => {
  let codeReads = 0;
  const commandFailure = {};
  Object.defineProperty(commandFailure, 'code', {
    get() {
      codeReads += 1;
      return codeReads === 1 ? 'internal' : 'attackerChosenCode';
    },
  });
  const failed = createService({
    invokeCommand: vi.fn().mockRejectedValue(commandFailure),
  });
  await expect(failed.getStatus()).rejects.toMatchObject({ code: 'internal' });
  expect(codeReads).toBe(1);

  const status = {
    inspectAvailable: false,
    version: null,
    reason: 'downloaderUnavailable',
    maxConcurrentDownloads: 4,
    inventoryTtlSeconds: 900,
  };
  let availableReads = 0;
  Object.defineProperty(status, 'available', {
    enumerable: true,
    get() {
      availableReads += 1;
      return availableReads < 3 ? false : 'secret-from-getter';
    },
  });
  const hostileResponse = createService({
    invokeCommand: vi.fn().mockResolvedValue(status),
  });
  await expect(hostileResponse.getStatus()).rejects.toMatchObject({
    code: 'invalidDownloadResponse',
  });
  expect(availableReads).toBe(0);
});

it('rejects accessor-backed download requests before IPC', async () => {
  const request = { cookieSource: 'none' };
  Object.defineProperty(request, 'url', {
    enumerable: true,
    get() { return 'https://example.com/video'; },
  });
  const invokeCommand = vi.fn();
  const service = createService({ invokeCommand });

  expect(() => service.inspectUrl(request)).toThrow(expect.objectContaining({
    code: 'invalidDownloadRequest',
  }));
  expect(invokeCommand).not.toHaveBeenCalled();
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

it('collapses command codes that cannot escape the current download commands', async () => {
  const artifactFailure = createService({
    invokeCommand: vi.fn().mockRejectedValue({ code: 'artifactStorage' }),
  });
  await expect(artifactFailure.getStatus()).rejects.toMatchObject({
    code: 'downloadCommandFailed',
  });
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
