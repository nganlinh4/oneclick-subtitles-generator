import { v7 as uuidv7 } from 'uuid';

import { downloadAndPrepareYouTubeVideo } from '../components/app/VideoProcessingHandlers';
import { createDownloadHandlers } from '../components/app/handlers/downloadHandlers';
import { createNativeUrlDownloadAdapter } from './nativeUrlDownloadAdapter';

vi.mock('./downloadService', () => ({
  cancelDownload: vi.fn(),
  inspectDownloadUrl: vi.fn(),
  startDownload: vi.fn(),
}));
vi.mock('./mediaService', () => ({
  createNativeMediaDescriptor: vi.fn(),
  openMediaAsset: vi.fn(),
}));
vi.mock('../components/app/VideoProcessingHandlers', () => ({
  downloadAndPrepareYouTubeVideo: vi.fn(),
}));

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
  const describeMedia = vi.fn().mockReturnValue(descriptor);
  const adapter = createNativeUrlDownloadAdapter({
    inspect,
    start,
    cancel,
    openAsset,
    describeMedia,
  });
  return {
    adapter,
    assetId,
    cancel,
    describeMedia,
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
  expect(harness.describeMedia).toHaveBeenCalledWith({ asset: { id: harness.assetId } });
  expect(harness.openAsset).not.toHaveBeenCalled();
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

it('starts distinct operations for the reviewed media phases on the same URL', async () => {
  const inventoryIds = [uuidv7(), uuidv7()];
  const jobIds = [uuidv7(), uuidv7()];
  const assetIds = [uuidv7(), uuidv7()];
  const handlers = [];
  const inspect = vi.fn().mockImplementation(async () => ({
    capability: { id: inventoryIds[inspect.mock.calls.length - 1] },
    inventory: { subtitles: [] },
  }));
  const start = vi.fn().mockImplementation(async (_request, nextHandlers) => {
    const index = handlers.length;
    handlers.push(nextHandlers);
    return { id: jobIds[index] };
  });
  const openAsset = vi.fn();
  const adapter = createNativeUrlDownloadAdapter({
    inspect,
    start,
    cancel: vi.fn(),
    openAsset,
    describeMedia: (media) => Object.freeze({ assetId: media.asset.id }),
  });
  const url = 'https://example.com/reviewed-media';
  const started = [vi.fn(), vi.fn()];

  const initial = adapter.downloadVideo({
    url,
    preferredSubtitleLanguages: ['en'],
    onStarted: started[0],
  });
  await flush();
  handlers[0].onCompleted({ media: { asset: { id: assetIds[0] } } });
  await expect(initial).resolves.toEqual({ assetId: assetIds[0] });

  const reactivation = adapter.downloadVideo({
    url,
    preferredSubtitleLanguages: [],
    onStarted: started[1],
  });
  await flush();
  handlers[1].onCompleted({ media: { asset: { id: assetIds[1] } } });
  await expect(reactivation).resolves.toEqual({ assetId: assetIds[1] });

  expect(inspect).toHaveBeenCalledTimes(2);
  expect(start).toHaveBeenCalledTimes(2);
  expect(started[0]).toHaveBeenCalledWith(jobIds[0]);
  expect(started[1]).toHaveBeenCalledWith(jobIds[1]);
  expect(new Set(jobIds).size).toBe(2);
  expect(new Set(assetIds).size).toBe(2);
  expect(openAsset).not.toHaveBeenCalled();
});

it('forwards the reviewed same-URL phase preferences through production handlers', async () => {
  const reviewedUrl = 'https://example.com/reviewed-media';
  const selectedVideo = Object.freeze({ url: reviewedUrl });
  const noop = vi.fn();
  downloadAndPrepareYouTubeVideo.mockReset();
  downloadAndPrepareYouTubeVideo.mockResolvedValue(undefined);
  const { startBackgroundVideoProcessing } = createDownloadHandlers({
    selectedVideo,
    setStatus: noop,
    setSubtitlesData: noop,
    setIsDownloading: noop,
    setDownloadProgress: noop,
    setCurrentDownloadId: noop,
    setIsSrtOnlyMode: noop,
    setActiveTab: noop,
    setUploadedFile: noop,
    setIsUploading: noop,
    setUploadedFileData: noop,
    pendingAutoSubtitleRef: { current: null },
    handleSrtUpload: noop,
    handleTabChange: noop,
    t: (_key, fallback) => fallback,
  });

  localStorage.setItem('auto_import_site_subtitles', 'true');
  localStorage.setItem('preferred_subtitle_langs', '["en"]');
  await startBackgroundVideoProcessing(selectedVideo, 'youtube');
  localStorage.setItem('auto_import_site_subtitles', 'false');
  localStorage.setItem('preferred_subtitle_langs', '["en"]');
  await startBackgroundVideoProcessing(selectedVideo, 'youtube');

  expect(downloadAndPrepareYouTubeVideo).toHaveBeenCalledTimes(2);
  expect(downloadAndPrepareYouTubeVideo.mock.calls[0][0]).toBe(selectedVideo);
  expect(downloadAndPrepareYouTubeVideo.mock.calls[1][0]).toBe(selectedVideo);
  expect(downloadAndPrepareYouTubeVideo.mock.calls[0][0].url).toBe(reviewedUrl);
  expect(downloadAndPrepareYouTubeVideo.mock.calls[1][0].url).toBe(reviewedUrl);
  expect(downloadAndPrepareYouTubeVideo.mock.calls[0][9].preferredSubtitleLanguages)
    .toEqual(['en']);
  expect(downloadAndPrepareYouTubeVideo.mock.calls[1][9].preferredSubtitleLanguages)
    .toEqual([]);
});

it('fails closed when the completed playback capability cannot be described', async () => {
  const harness = createHarness();
  harness.describeMedia.mockImplementationOnce(() => {
    throw new Error('hostile media metadata');
  });
  const result = harness.adapter.downloadVideo({ url: 'https://example.com/video' });
  await flush();
  harness.getHandlers().onCompleted({ media: { asset: { id: harness.assetId } } });

  await expect(result).rejects.toMatchObject({
    name: 'NativeUrlDownloadError',
    code: 'mediaOpenFailed',
    message: 'The native media download could not be completed',
  });
  expect(harness.openAsset).not.toHaveBeenCalled();
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
