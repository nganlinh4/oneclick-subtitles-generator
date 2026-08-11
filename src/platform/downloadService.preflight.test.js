import { v7 as uuidv7 } from 'uuid';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  ensureInspection: vi.fn(),
  ensureDownload: vi.fn(),
  recoverDownloader: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class MockChannel {},
  invoke: mocks.invoke,
  isTauri: vi.fn(() => true),
}));

vi.mock('./nativeDownloadPreflight', () => ({
  ensureNativeDownloadInspectionReady: mocks.ensureInspection,
  ensureNativeDownloadReady: mocks.ensureDownload,
  recoverNativeDownloaderAfterFailure: mocks.recoverDownloader,
}));

import {
  inspectDownloadUrl,
  startDownload,
} from './downloadService';

const readiness = (overrides = {}) => ({
  available: true,
  inspectAvailable: true,
  version: '2026.07.04',
  reason: null,
  maxConcurrentDownloads: 4,
  inventoryTtlSeconds: 900,
  ...overrides,
});

const inspection = () => ({
  capability: { id: uuidv7(), expiresAtMs: Date.now() + 60_000 },
  inventory: {
    title: 'Example',
    durationSeconds: 10,
    formats: {
      video: [{
        formatId: '18',
        container: 'mp4',
        width: 640,
        height: 360,
        fpsMilli: 30_000,
        codec: 'avc1',
        includesAudio: true,
        sizeBytes: 1_000,
        bitrateKbps: 800,
      }],
      audio: [],
      qualities: [{ height: 360, hasCombined: true, hasVideoOnly: false }],
    },
    subtitles: [],
  },
});

beforeEach(() => {
  window.isTauri = true;
  mocks.invoke.mockReset();
  mocks.ensureInspection.mockReset().mockResolvedValue({ ready: true });
  mocks.ensureDownload.mockReset().mockResolvedValue({ ready: true });
  mocks.recoverDownloader.mockReset().mockResolvedValue({ updated: false, throttled: false });
});

afterEach(() => {
  delete window.isTauri;
});

it('validates an inspection before IPC and runs preflight before URL authority crosses IPC', async () => {
  await expect(inspectDownloadUrl({
    url: 'https://example.com/watch\n--exec',
    cookieSource: 'none',
  })).rejects.toMatchObject({ code: 'invalidDownloadRequest' });
  expect(mocks.invoke).not.toHaveBeenCalled();
  expect(mocks.ensureInspection).not.toHaveBeenCalled();

  const inspected = inspection();
  mocks.invoke.mockResolvedValueOnce(readiness()).mockResolvedValueOnce(inspected);
  const options = { onProgress: vi.fn() };
  await expect(inspectDownloadUrl({
    url: 'https://example.com/watch',
    cookieSource: 'none',
  }, options)).resolves.toEqual(inspected);

  expect(mocks.invoke).toHaveBeenNthCalledWith(1, 'download_status', {});
  expect(mocks.ensureInspection).toHaveBeenCalledWith(readiness(), options);
  expect(mocks.invoke).toHaveBeenNthCalledWith(2, 'download_inspect', {
    request: { url: 'https://example.com/watch', cookieSource: 'none' },
  });
  expect(mocks.ensureInspection.mock.invocationCallOrder[0])
    .toBeLessThan(mocks.invoke.mock.invocationCallOrder[1]);
});

it('does not start a download when the typed readiness preflight rejects', async () => {
  const blocked = Object.assign(new Error('busy'), { code: 'nativeToolInUse' });
  mocks.invoke.mockResolvedValueOnce(readiness({ available: false }));
  mocks.ensureDownload.mockRejectedValue(blocked);

  await expect(startDownload({
    inventoryId: uuidv7(),
    media: { kind: 'video', quality: { mode: 'best' } },
    subtitle: null,
  })).rejects.toBe(blocked);
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  expect(mocks.invoke).toHaveBeenCalledWith('download_status', {});
});

it('starts the bounded yt-dlp recovery check only for a native execution failure', async () => {
  mocks.invoke
    .mockResolvedValueOnce(readiness())
    .mockRejectedValueOnce({ code: 'downloaderExecutionFailed', message: 'private stderr' });

  await expect(inspectDownloadUrl({
    url: 'https://youtube.com/watch?v=example',
    cookieSource: 'none',
  })).rejects.toMatchObject({ code: 'downloaderExecutionFailed' });
  await vi.waitFor(() => expect(mocks.recoverDownloader).toHaveBeenCalledOnce());

  mocks.invoke
    .mockResolvedValueOnce(readiness())
    .mockRejectedValueOnce({ code: 'invalidInput', message: 'bad URL' });
  await expect(inspectDownloadUrl({
    url: 'https://youtube.com/watch?v=another',
    cookieSource: 'none',
  })).rejects.toMatchObject({ code: 'invalidInput' });
  expect(mocks.recoverDownloader).toHaveBeenCalledOnce();
});
