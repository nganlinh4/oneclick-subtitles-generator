import { v7 as uuidv7 } from 'uuid';

import { createNativeUrlDownloadAdapter } from './nativeUrlDownloadAdapter';

vi.mock('./downloadService', () => ({
  cancelDownload: vi.fn(),
  inspectDownloadUrl: vi.fn(),
  startDownload: vi.fn(),
}));
vi.mock('./mediaService', () => ({ openMediaAsset: vi.fn() }));

const flush = () => new Promise((resolve) => { setTimeout(resolve, 0); });

const createHarness = () => {
  const inventoryId = uuidv7();
  const jobId = uuidv7();
  const assetId = uuidv7();
  const descriptor = Object.freeze({ assetId, playbackUrl: 'http://127.0.0.1/media' });
  let handlers;
  const inspect = vi.fn().mockResolvedValue({ capability: { id: inventoryId } });
  const start = vi.fn().mockImplementation(async (_request, nextHandlers) => {
    handlers = nextHandlers;
    return { id: jobId };
  });
  const cancel = vi.fn().mockResolvedValue({ id: jobId });
  const openAsset = vi.fn().mockResolvedValue(descriptor);
  const adapter = createNativeUrlDownloadAdapter({ inspect, start, cancel, openAsset });
  return {
    adapter,
    assetId,
    cancel,
    descriptor,
    getHandlers: () => handlers,
    inspect,
    inventoryId,
    jobId,
    openAsset,
    start,
  };
};

it('coalesces matching preview and processing requests and broadcasts monotonic progress', async () => {
  const harness = createHarness();
  const firstStarted = vi.fn();
  const secondStarted = vi.fn();
  const firstProgress = vi.fn();
  const secondProgress = vi.fn();
  const request = { url: 'https://www.youtube.com/watch?v=abc', useCookies: true };

  const first = harness.adapter.downloadVideo({
    ...request,
    onStarted: firstStarted,
    onProgress: firstProgress,
  });
  const second = harness.adapter.downloadVideo({
    ...request,
    onStarted: secondStarted,
    onProgress: secondProgress,
  });
  await flush();

  expect(harness.inspect).toHaveBeenCalledTimes(1);
  expect(harness.inspect).toHaveBeenCalledWith({ url: request.url, cookieSource: 'chrome' });
  expect(harness.start).toHaveBeenCalledTimes(1);
  expect(firstStarted).toHaveBeenCalledWith(harness.jobId);
  expect(secondStarted).toHaveBeenCalledWith(harness.jobId);

  harness.getHandlers().onProgress({
    job: { progress: { basisPoints: 4_000 } },
    progress: { fraction: 0.4 },
  });
  harness.getHandlers().onProgress({
    job: { progress: { basisPoints: 3_000 } },
    progress: { fraction: null },
  });
  expect(firstProgress.mock.calls.map(([value]) => value)).toEqual([40, 40]);
  expect(secondProgress.mock.calls.map(([value]) => value)).toEqual([40, 40]);

  harness.getHandlers().onCompleted({ media: { asset: { id: harness.assetId } } });
  await expect(first).resolves.toBe(harness.descriptor);
  await expect(second).resolves.toBe(harness.descriptor);
  expect(harness.openAsset).toHaveBeenCalledWith(harness.assetId);
});

it('refreshes a completed asset capability without downloading again', async () => {
  const harness = createHarness();
  const request = { url: 'https://example.com/video', useCookies: false };
  const first = harness.adapter.downloadVideo(request);
  await flush();
  harness.getHandlers().onCompleted({ media: { asset: { id: harness.assetId } } });
  await first;

  const refreshed = Object.freeze({ ...harness.descriptor, playbackUrl: 'http://127.0.0.1/new' });
  harness.openAsset.mockResolvedValueOnce(refreshed);
  await expect(harness.adapter.downloadVideo(request)).resolves.toBe(refreshed);
  expect(harness.inspect).toHaveBeenCalledTimes(1);
  expect(harness.start).toHaveBeenCalledTimes(1);
});

it('selects the preferred native subtitle track and replays bounded content to subscribers', async () => {
  const harness = createHarness();
  harness.inspect.mockResolvedValue({
    capability: { id: harness.inventoryId },
    inventory: {
      subtitles: [
        { language: 'en', source: 'automatic', formats: ['vtt'] },
        { language: 'ko', source: 'manual', formats: ['srt'] },
      ],
    },
  });
  const onSubtitle = vi.fn();
  const request = {
    url: 'https://example.com/subtitled-video',
    preferredSubtitleLanguages: ['ko-KR', 'en'],
    onSubtitle,
  };
  const first = harness.adapter.downloadVideo(request);
  await flush();
  expect(harness.start.mock.calls[0][0].subtitle).toEqual({
    language: 'ko',
    source: 'manual',
  });
  const subtitle = {
    filename: 'captions.ko.srt',
    language: 'ko',
    content: '1\n00:00:00,000 --> 00:00:01,000\nHello',
  };
  harness.getHandlers().onCompleted({
    media: { asset: { id: harness.assetId } },
    subtitle,
  });
  await expect(first).resolves.toBe(harness.descriptor);
  expect(onSubtitle).toHaveBeenCalledWith(subtitle);

  const replayed = vi.fn();
  await expect(harness.adapter.downloadVideo({ ...request, onSubtitle: replayed }))
    .resolves.toBe(harness.descriptor);
  expect(replayed).toHaveBeenCalledWith(subtitle);
  expect(harness.start).toHaveBeenCalledTimes(1);
});

it('cancels a protocol-corrupt native job and returns a fixed error', async () => {
  const harness = createHarness();
  const result = harness.adapter.downloadVideo({ url: 'https://example.com/video' });
  await flush();
  harness.getHandlers().onProtocolError();

  await expect(result).rejects.toMatchObject({
    name: 'NativeUrlDownloadError',
    code: 'invalidDownloadResponse',
    message: 'The native media download could not be completed',
  });
  expect(harness.cancel).toHaveBeenCalledWith(harness.jobId);
});

it('resolves cancellation as no media and does not cache an asset', async () => {
  const harness = createHarness();
  const request = { url: 'https://example.com/video' };
  const result = harness.adapter.downloadVideo(request);
  await flush();
  harness.getHandlers().onCancelled();

  await expect(result).resolves.toBeNull();
  expect(harness.openAsset).not.toHaveBeenCalled();
  expect(harness.cancel).not.toHaveBeenCalled();
});

it('contains no fetch, localhost service port, path field, or browser persistence', () => {
  const source = require('fs').readFileSync(__filename.replace('.test.js', '.js'), 'utf8');
  expect(source).not.toMatch(/\bfetch\s*\(/);
  expect(source).not.toMatch(/localhost:303\d/);
  expect(source).not.toMatch(/localStorage\s*\./);
  expect(source).not.toMatch(/\b(filePath|serverPath|videoPath|outputPath)\b/);
});
