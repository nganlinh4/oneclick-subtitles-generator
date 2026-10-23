// Completed-asset replay: cached reopen, replayed callbacks and subscriber aborts during replay.


import { createHarness, flush } from './nativeUrlDownloadAdapterTestFixtures';

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

it('refreshes a completed asset capability without downloading again', async () => {
  const harness = createHarness();
  const request = { url: 'https://example.com/video', cookieSource: 'none' };
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

it('preserves the completed cache when a subscriber aborts as native open returns', async () => {
  const harness = createHarness();
  const request = { url: 'https://example.com/cached-open-abort', cookieSource: 'none' };
  const first = harness.adapter.downloadVideo(request);
  await flush();
  harness.getHandlers().onCompleted({ media: { asset: { id: harness.assetId } } });
  await first;
  await flush();

  const controller = new AbortController();
  harness.openAsset.mockImplementationOnce(async () => {
    controller.abort();
    return harness.descriptor;
  });
  await expect(harness.adapter.downloadVideo({
    ...request,
    signal: controller.signal,
  })).rejects.toMatchObject({ name: 'AbortError' });

  harness.openAsset.mockResolvedValueOnce(harness.descriptor);
  await expect(harness.adapter.downloadVideo(request)).resolves.toBe(harness.descriptor);
  expect(harness.openAsset).toHaveBeenCalledTimes(2);
  expect(harness.inspect).toHaveBeenCalledTimes(1);
  expect(harness.start).toHaveBeenCalledTimes(1);
});

it('evicts a completed capability only when native open genuinely fails', async () => {
  const harness = createHarness();
  const request = { url: 'https://example.com/cached-open-failure', cookieSource: 'none' };
  const first = harness.adapter.downloadVideo(request);
  await flush();
  harness.getHandlers().onCompleted({ media: { asset: { id: harness.assetId } } });
  await first;
  await flush();

  harness.openAsset.mockRejectedValueOnce(new Error('asset expired'));
  const redownloaded = harness.adapter.downloadVideo(request);
  await vi.waitFor(() => expect(harness.start).toHaveBeenCalledTimes(2));
  harness.getHandlers().onCompleted({ media: { asset: { id: harness.assetId } } });

  await expect(redownloaded).resolves.toBe(harness.descriptor);
  expect(harness.openAsset).toHaveBeenCalledTimes(1);
  expect(harness.inspect).toHaveBeenCalledTimes(2);
});

it('stops cached replay after a progress callback aborts without evicting shared media', async () => {
  const harness = createHarness();
  const subtitle = { filename: 'captions.srt', language: 'en', content: 'cached' };
  const request = {
    url: 'https://example.com/cached-progress-abort',
    cookieSource: 'none',
    preferredSubtitleLanguages: ['en'],
  };
  const first = harness.adapter.downloadVideo(request);
  await flush();
  harness.getHandlers().onCompleted({
    media: { asset: { id: harness.assetId } },
    subtitle,
  });
  await first;
  await flush();

  const controller = new AbortController();
  const onSubtitle = vi.fn();
  await expect(harness.adapter.downloadVideo({
    ...request,
    signal: controller.signal,
    onProgress: () => controller.abort(),
    onSubtitle,
  })).rejects.toMatchObject({ name: 'AbortError' });
  expect(onSubtitle).not.toHaveBeenCalled();

  await expect(harness.adapter.downloadVideo(request)).resolves.toBe(harness.descriptor);
  expect(harness.inspect).toHaveBeenCalledTimes(1);
  expect(harness.start).toHaveBeenCalledTimes(1);
});

it('rejects after a cached subtitle callback aborts instead of returning stale media', async () => {
  const harness = createHarness();
  const subtitle = { filename: 'captions.srt', language: 'en', content: 'cached subtitle' };
  const request = {
    url: 'https://example.com/cached-subtitle-abort',
    cookieSource: 'none',
    preferredSubtitleLanguages: ['en'],
  };
  const first = harness.adapter.downloadVideo(request);
  await flush();
  harness.getHandlers().onCompleted({
    media: { asset: { id: harness.assetId } },
    subtitle,
  });
  await first;
  await flush();

  const controller = new AbortController();
  await expect(harness.adapter.downloadVideo({
    ...request,
    signal: controller.signal,
    onSubtitle: () => controller.abort(),
  })).rejects.toMatchObject({ name: 'AbortError' });

  await expect(harness.adapter.downloadVideo(request)).resolves.toBe(harness.descriptor);
  expect(harness.inspect).toHaveBeenCalledTimes(1);
  expect(harness.start).toHaveBeenCalledTimes(1);
});

it('keeps completed media when ownership is lost inside a cached callback', async () => {
  const harness = createHarness();
  const request = { url: 'https://example.com/cached-owner-callback', cookieSource: 'none' };
  const first = harness.adapter.downloadVideo(request);
  await flush();
  harness.getHandlers().onCompleted({ media: { asset: { id: harness.assetId } } });
  await first;
  await flush();

  let current = true;
  const validateOwnership = () => {
    if (!current) {
      const error = new Error('source switched');
      error.code = 'autoGenerationOwnershipLost';
      throw error;
    }
  };
  await expect(harness.adapter.downloadVideo({
    ...request,
    validateOwnership,
    onProgress: () => { current = false; },
  })).rejects.toMatchObject({ code: 'autoGenerationOwnershipLost' });

  await expect(harness.adapter.downloadVideo(request)).resolves.toBe(harness.descriptor);
  expect(harness.inspect).toHaveBeenCalledTimes(1);
  expect(harness.start).toHaveBeenCalledTimes(1);
});

it('aborts only a joining subscriber that stops synchronously in replayed onStarted', async () => {
  const harness = createHarness();
  const request = { url: 'https://example.com/replayed-start-abort', cookieSource: 'none' };
  const manual = harness.adapter.downloadVideo(request);
  await vi.waitFor(() => expect(harness.start).toHaveBeenCalledTimes(1));

  const controller = new AbortController();
  const onProgress = vi.fn();
  const automatic = harness.adapter.downloadVideo({
    ...request,
    signal: controller.signal,
    onStarted: () => controller.abort(),
    onProgress,
  });
  await expect(automatic).rejects.toMatchObject({ name: 'AbortError' });
  expect(onProgress).not.toHaveBeenCalled();
  expect(harness.cancel).not.toHaveBeenCalled();

  harness.getHandlers().onCompleted({ media: { asset: { id: harness.assetId } } });
  await expect(manual).resolves.toBe(harness.descriptor);
  expect(harness.cancel).not.toHaveBeenCalled();
});

it('stops active replay after a joining subscriber aborts in replayed progress', async () => {
  const harness = createHarness();
  const request = { url: 'https://example.com/replayed-progress-abort', cookieSource: 'none' };
  const manual = harness.adapter.downloadVideo(request);
  await vi.waitFor(() => expect(harness.start).toHaveBeenCalledTimes(1));
  harness.getHandlers().onProgress({
    job: { progress: { basisPoints: 5_000 } },
    progress: { fraction: 0.5 },
  });

  const controller = new AbortController();
  const onSubtitle = vi.fn();
  const automatic = harness.adapter.downloadVideo({
    ...request,
    signal: controller.signal,
    onProgress: () => controller.abort(),
    onSubtitle,
  });
  await expect(automatic).rejects.toMatchObject({ name: 'AbortError' });
  expect(onSubtitle).not.toHaveBeenCalled();
  expect(harness.cancel).not.toHaveBeenCalled();

  harness.getHandlers().onCompleted({ media: { asset: { id: harness.assetId } } });
  await expect(manual).resolves.toBe(harness.descriptor);
  expect(harness.cancel).not.toHaveBeenCalled();
});

it('stops a subscriber that joins and aborts inside replayed subtitle content', async () => {
  const harness = createHarness();
  const request = {
    url: 'https://example.com/replayed-subtitle-abort',
    cookieSource: 'none',
    preferredSubtitleLanguages: ['en'],
  };
  const controller = new AbortController();
  let joining;
  const manual = harness.adapter.downloadVideo({
    ...request,
    onSubtitle: () => {
      joining = harness.adapter.downloadVideo({
        ...request,
        signal: controller.signal,
        onSubtitle: () => controller.abort(),
      });
    },
  });
  await vi.waitFor(() => expect(harness.start).toHaveBeenCalledTimes(1));
  const subtitle = { filename: 'captions.srt', language: 'en', content: 'replayed' };
  harness.getHandlers().onCompleted({
    media: { asset: { id: harness.assetId } },
    subtitle,
  });

  await vi.waitFor(() => expect(joining).toBeDefined());
  await expect(joining).rejects.toMatchObject({ name: 'AbortError' });
  await expect(manual).resolves.toBe(harness.descriptor);
  expect(harness.cancel).not.toHaveBeenCalled();
});

it('keeps a manual co-subscriber alive when auto aborts inside a live subtitle callback', async () => {
  const harness = createHarness();
  const request = {
    url: 'https://example.com/live-subtitle-abort',
    cookieSource: 'none',
    preferredSubtitleLanguages: ['en'],
  };
  const controller = new AbortController();
  const automatic = harness.adapter.downloadVideo({
    ...request,
    signal: controller.signal,
    onSubtitle: () => controller.abort(),
  });
  const manualSubtitle = vi.fn();
  const manual = harness.adapter.downloadVideo({ ...request, onSubtitle: manualSubtitle });
  await vi.waitFor(() => expect(harness.start).toHaveBeenCalledTimes(1));
  const subtitle = { filename: 'captions.srt', language: 'en', content: 'manual survives' };
  harness.getHandlers().onCompleted({
    media: { asset: { id: harness.assetId } },
    subtitle,
  });

  await expect(automatic).rejects.toMatchObject({ name: 'AbortError' });
  await expect(manual).resolves.toBe(harness.descriptor);
  expect(manualSubtitle).toHaveBeenCalledExactlyOnceWith(subtitle);
  expect(harness.cancel).not.toHaveBeenCalled();
});

