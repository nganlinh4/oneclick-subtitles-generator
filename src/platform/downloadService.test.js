import fs from 'fs';
import path from 'path';
import { v4 as uuidv4, v7 as uuidv7 } from 'uuid';

import { DownloadServiceError, normalizeDownloadEvent } from './downloadService';
import {
  completedEvent,
  createService,
  inspection,
  inventory,
  job,
  summary,
} from './downloadServiceTestFixtures';

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class MockTauriChannel {},
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}));

it('contains no fixed legacy port, fetch, base64 transport, browser persistence, or raw args', () => {
  // Every module the service was split across, so the guard keeps covering the moved code.
  for (const module of [
    'downloadService', 'downloadServiceContract', 'downloadRequestNormalizers',
    'downloadResponseNormalizers', 'nativeDataSnapshot',
  ]) {
    const source = fs.readFileSync(path.join(__dirname, `${module}.js`), 'utf8');
    expect(source, module).not.toMatch(/\bfetch\s*\(/);
    expect(source, module).not.toMatch(/localStorage\s*\./);
    expect(source, module).not.toContain('3031');
    expect(source, module).not.toMatch(/\bbase64\b/i);
    expect(source, module).not.toMatch(/rawArgs|additionalArgs|commandLine/i);
  }
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

it('collapses command codes that cannot escape the current download commands', async () => {
  const artifactFailure = createService({
    invokeCommand: vi.fn().mockRejectedValue({ code: 'artifactStorage' }),
  });
  await expect(artifactFailure.getStatus()).rejects.toMatchObject({
    code: 'downloadCommandFailed',
  });
});

