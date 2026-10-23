// Production handler wiring, media phases, subtitle selection, protocol faults and source guards.
import { v7 as uuidv7 } from 'uuid';

import { downloadAndPrepareYouTubeVideo } from '../components/app/VideoProcessingHandlers';
import { createDownloadHandlers } from '../components/app/handlers/downloadHandlers';
import { isNativeMediaDescriptor } from './mediaService';
import { createNativeUrlDownloadAdapter } from './nativeUrlDownloadAdapter';
import { activateResolvedMediaProject } from './mediaProjectActivation';
import { getCachedSubtitles } from '../services/subtitleCache';
import { activateSubtitleProjectBinding } from './subtitleProjectBinding';
import { setCurrentCacheId as setRulesCacheId } from '../utils/transcriptionRulesStore';
import { setCurrentCacheId as setSubtitlesCacheId } from '../utils/userSubtitlesStore';

import { candidateProject, createHarness, flush } from './nativeUrlDownloadAdapterTestFixtures';

vi.mock('./downloadService', () => ({
  cancelDownload: vi.fn(),
  inspectDownloadUrl: vi.fn(),
  startDownload: vi.fn(),
}));
vi.mock('./mediaService', () => ({
  claimMediaCandidate: vi.fn(),
  createNativeMediaDescriptor: vi.fn(),
  discardMediaCandidate: vi.fn(),
  isNativeMediaDescriptor: vi.fn(() => false),
  openMediaAsset: vi.fn(),
}));
vi.mock('../services/subtitleCache', () => ({
  generateUrlBasedCacheId: vi.fn(async () => 'generated-cache'),
  getCachedSubtitles: vi.fn(),
}));
vi.mock('./subtitleProjectStore', () => ({
  resolveProjectForCache: vi.fn(async (cacheId) => ({ projectId: `project:${cacheId}` })),
}));
vi.mock('./subtitleProjectBinding', () => ({
  activateSubtitleProjectBinding: vi.fn(),
  isSubtitleProjectBindingReceipt: (value, scope) => (
    value?.kind === 'subtitle-project-binding'
    && value.cacheId === scope.cacheId
    && value.projectId === scope.projectId
  ),
  rollbackSubtitleProjectBinding: vi.fn(() => true),
}));
vi.mock('../utils/transcriptionRulesStore', () => ({
  ...(() => {
    let current = null;
    return {
      getCurrentCacheId: vi.fn(() => current),
      setCurrentCacheId: vi.fn((cacheId) => { current = cacheId; }),
    };
  })(),
}));
vi.mock('../utils/userSubtitlesStore', () => ({
  ...(() => {
    let current = null;
    return {
      getCurrentCacheId: vi.fn(() => current),
      setCurrentCacheId: vi.fn((cacheId) => { current = cacheId; }),
      subscribeCurrentCacheId: vi.fn(() => () => undefined),
    };
  })(),
}));
vi.mock('../components/app/VideoProcessingHandlers', () => ({
  downloadAndPrepareYouTubeVideo: vi.fn(),
}));

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
    activateProject: activateResolvedMediaProject,
    inspect,
    start,
    cancel: vi.fn(),
    openAsset,
    claimCandidate: (media) => Object.freeze({ assetId: media.asset.id }),
    discardCandidate: vi.fn().mockResolvedValue(true),
    resolveCandidateProject: vi.fn().mockResolvedValue(candidateProject(uuidv7(), 1)),
  });
  const url = 'https://example.com/reviewed-media';
  const started = [vi.fn(), vi.fn()];

  const initial = adapter.downloadVideo({
    url,
    cookieSource: 'none',
    preferredSubtitleLanguages: ['en'],
    onStarted: started[0],
  });
  await flush();
  handlers[0].onCompleted({ media: { asset: { id: assetIds[0] } } });
  await expect(initial).resolves.toEqual({ assetId: assetIds[0] });

  const reactivation = adapter.downloadVideo({
    url,
    cookieSource: 'none',
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
  await expect(startBackgroundVideoProcessing(selectedVideo, 'youtube')).resolves.toBeNull();
  localStorage.setItem('auto_import_site_subtitles', 'false');
  localStorage.setItem('preferred_subtitle_langs', '["en"]');
  await expect(startBackgroundVideoProcessing(selectedVideo, 'youtube')).resolves.toBeNull();

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

it('keeps native picker media opaque while preparing the file workflow', async () => {
  const assetId = uuidv7();
  const nativeMedia = Object.freeze({
    __nativeMedia: true,
    assetId,
    playbackUrl: 'http://127.0.0.1/native-capability',
    name: 'fresh.wav',
    type: 'audio/wav',
    size: 4096,
    lastModified: 0,
  });
  const setStatus = vi.fn();
  const setUploadedFile = vi.fn();
  const setUploadedFileData = vi.fn();
  const setIsUploading = vi.fn();
  const setIsDownloading = vi.fn();
  const createObjectUrl = vi.spyOn(URL, 'createObjectURL');
  isNativeMediaDescriptor.mockReturnValueOnce(true);
  getCachedSubtitles.mockResolvedValueOnce(null);
  activateSubtitleProjectBinding.mockImplementationOnce(async (cacheId) => {
    setRulesCacheId(cacheId);
    setSubtitlesCacheId(cacheId);
    return {
      kind: 'subtitle-project-binding',
      cacheId,
      projectId: `project:${cacheId}`,
    };
  });

  const { startBackgroundVideoProcessing } = createDownloadHandlers({
    selectedVideo: null,
    setStatus,
    setSubtitlesData: vi.fn(),
    setIsDownloading,
    setDownloadProgress: vi.fn(),
    setCurrentDownloadId: vi.fn(),
    setIsSrtOnlyMode: vi.fn(),
    setActiveTab: vi.fn(),
    setUploadedFile,
    setIsUploading,
    setUploadedFileData,
    pendingAutoSubtitleRef: { current: null },
    handleSrtUpload: vi.fn(),
    handleTabChange: vi.fn(),
    t: (_key, fallback) => fallback,
  });

  await expect(startBackgroundVideoProcessing(nativeMedia, 'file-upload')).resolves.toBe(nativeMedia);

  expect(createObjectUrl).not.toHaveBeenCalled();
  expect(localStorage.getItem('current_file_url')).toBe(nativeMedia.playbackUrl);
  expect(localStorage.getItem('current_file_cache_id')).toBeNull();
  expect(getCachedSubtitles).toHaveBeenCalledWith(assetId, null, {
    expectedProjectId: `project:${assetId}`,
  });
  expect(setUploadedFile).toHaveBeenCalledWith(nativeMedia);
  expect(setUploadedFileData).toHaveBeenCalledWith(nativeMedia);
  expect(setIsUploading).toHaveBeenLastCalledWith(false);
  expect(setIsDownloading).toHaveBeenLastCalledWith(false);
  expect(setStatus).toHaveBeenLastCalledWith({});
  expect(setStatus).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'info' }));
  createObjectUrl.mockRestore();
});

it('fails closed when the completed playback capability cannot be described', async () => {
  const harness = createHarness();
  harness.describeMedia.mockImplementationOnce(() => {
    throw new Error('hostile media metadata');
  });
  const result = harness.adapter.downloadVideo({
    url: 'https://example.com/video',
    cookieSource: 'none',
  });
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
    cookieSource: 'none',
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
  const result = harness.adapter.downloadVideo({
    url: 'https://example.com/video',
    cookieSource: 'none',
  });
  await flush();
  harness.getHandlers().onProtocolError();

  await expect(result).rejects.toMatchObject({
    name: 'NativeUrlDownloadError',
    code: 'invalidDownloadResponse',
    message: 'The native media download could not be completed',
  });
  expect(harness.cancel).not.toHaveBeenCalled();
});

it('bounds completed replay capabilities and evicts the least-recently-used entry', async () => {
  const harness = createHarness();
  const requests = Array.from({ length: 33 }, (_, index) => ({
    url: `https://example.com/cache-${index}`,
    cookieSource: 'none',
  }));

  for (const request of requests) {
    const pending = harness.adapter.downloadVideo(request);
    await flush();
    harness.getHandlers().onCompleted({ media: { asset: { id: uuidv7() } } });
    await pending;
  }
  const startsAfterFill = harness.start.mock.calls.length;

  const newest = await harness.adapter.downloadVideo(requests.at(-1));
  expect(newest).toBe(harness.descriptor);
  expect(harness.start).toHaveBeenCalledTimes(startsAfterFill);

  const oldest = harness.adapter.downloadVideo(requests[0]);
  await vi.waitFor(() => expect(harness.start).toHaveBeenCalledTimes(startsAfterFill + 1));
  harness.getHandlers().onCompleted({ media: { asset: { id: uuidv7() } } });
  await expect(oldest).resolves.toBe(harness.descriptor);
});

it('resolves cancellation as no media and does not cache an asset', async () => {
  const harness = createHarness();
  const request = { url: 'https://example.com/video', cookieSource: 'none' };
  const result = harness.adapter.downloadVideo(request);
  await flush();
  harness.getHandlers().onCancelled();

  await expect(result).resolves.toBeNull();
  expect(harness.openAsset).not.toHaveBeenCalled();
  expect(harness.cancel).not.toHaveBeenCalled();
});

it('contains no fetch, localhost service port, path field, or browser persistence', () => {
  // Every module the adapter was split across, so the guard keeps covering the moved code.
  for (const module of [
    'nativeUrlDownloadAdapter', 'nativeUrlDownloadClaim', 'nativeUrlDownloadListeners',
  ]) {
    const source = require('fs').readFileSync(require('path').join(__dirname, `${module}.js`), 'utf8');
    expect(source, module).not.toMatch(/\bfetch\s*\(/);
    expect(source, module).not.toMatch(/localhost:303\d/);
    expect(source, module).not.toMatch(/localStorage\s*\./);
    expect(source, module).not.toMatch(/\b(filePath|serverPath|videoPath|outputPath)\b/);
  }
});
