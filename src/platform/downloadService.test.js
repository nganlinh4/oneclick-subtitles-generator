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
  const playbackId = uuidv4();
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
      playback: {
        id: playbackId,
        playbackUrl: `http://127.0.0.1:49152/asset/${playbackId}?token=${'a'.repeat(64)}`,
        mimeType: 'video/mp4',
        byteLength: 5_000_000,
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

  nativeChannel.emit(completedEvent(initial.id));
  expect(onEvent).toHaveBeenNthCalledWith(2, expect.objectContaining({ event: 'completed' }));
});

it('rejects cross-job and post-terminal events while allowing a pre-registration failure', async () => {
  const initial = job();
  let channel;
  const onEvent = vi.fn();
  const onProtocolError = vi.fn();
  const service = createService({
    invokeCommand: vi.fn(async (command, args) => {
      channel = args.onEvent;
      return initial;
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
  expect(onEvent).toHaveBeenCalledTimes(1);
  expect(onProtocolError).toHaveBeenCalledTimes(2);

  expect(normalizeDownloadEvent({
    event: 'failed',
    job: null,
    error: { code: 'downloadFailed', message: 'untrusted native detail' },
  })).toEqual({
    event: 'failed',
    job: null,
    error: {
      code: 'downloadFailed',
      message: 'The native media download could not be completed',
    },
  });
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
