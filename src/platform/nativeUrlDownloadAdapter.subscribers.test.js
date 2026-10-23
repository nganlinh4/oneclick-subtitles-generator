// Shared operations: subscriber coalescing, ownership revalidation, aborts and request validation.


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

it('keeps same-URL operations separate when their explicit browser sources differ', async () => {
  const harness = createHarness();
  const url = 'https://example.com/browser-specific';

  const edge = harness.adapter.downloadVideo({ url, cookieSource: 'edge' });
  await flush();
  harness.getHandlers().onCompleted({ media: { asset: { id: harness.assetId } } });
  await edge;

  const firefox = harness.adapter.downloadVideo({ url, cookieSource: 'firefox' });
  await flush();
  harness.getHandlers().onCompleted({ media: { asset: { id: harness.assetId } } });
  await firefox;

  expect(harness.inspect.mock.calls).toEqual([
    [{ url, cookieSource: 'edge' }],
    [{ url, cookieSource: 'firefox' }],
  ]);
  expect(harness.start).toHaveBeenCalledTimes(2);
});

it('rechecks run ownership after inspection and before native job registration', async () => {
  const harness = createHarness();
  let releaseInspection;
  harness.inspect.mockReturnValueOnce(new Promise((resolve) => { releaseInspection = resolve; }));
  let current = true;
  const validateOwnership = vi.fn(() => {
    if (!current) {
      const error = new Error('source switched');
      error.code = 'autoGenerationOwnershipLost';
      throw error;
    }
  });

  const result = harness.adapter.downloadVideo({
    url: 'https://example.com/owned',
    cookieSource: 'none',
    validateOwnership,
  });
  await flush();
  current = false;
  releaseInspection({ inventory: {}, capability: { id: harness.inventoryId } });

  await expect(result).rejects.toMatchObject({ code: 'autoGenerationOwnershipLost' });
  expect(validateOwnership).toHaveBeenCalledTimes(3);
  expect(harness.start).not.toHaveBeenCalled();
});

it('prunes an aborted final subscriber after inspection and starts no native job', async () => {
  const harness = createHarness();
  const controller = new AbortController();
  let releaseInspection;
  harness.inspect.mockReturnValueOnce(new Promise((resolve) => { releaseInspection = resolve; }));

  const result = harness.adapter.downloadVideo({
    url: 'https://example.com/aborted-before-start',
    cookieSource: 'none',
    signal: controller.signal,
  });
  await flush();
  expect(harness.inspect).toHaveBeenCalledTimes(1);

  controller.abort();
  await expect(result).rejects.toMatchObject({ name: 'AbortError' });
  releaseInspection({ inventory: {}, capability: { id: harness.inventoryId } });
  await flush();

  expect(harness.start).not.toHaveBeenCalled();
  expect(harness.cancel).not.toHaveBeenCalled();
});

it('allows a manual subscriber to join an inspected operation after the stale automatic owner aborts', async () => {
  const harness = createHarness();
  const controller = new AbortController();
  let releaseInspection;
  harness.inspect.mockReturnValueOnce(new Promise((resolve) => { releaseInspection = resolve; }));
  const request = { url: 'https://example.com/join-after-abort', cookieSource: 'none' };
  const automatic = harness.adapter.downloadVideo({ ...request, signal: controller.signal });
  await flush();

  controller.abort();
  await expect(automatic).rejects.toMatchObject({ name: 'AbortError' });
  const manual = harness.adapter.downloadVideo(request);
  releaseInspection({ inventory: {}, capability: { id: harness.inventoryId } });

  await vi.waitFor(() => expect(harness.start).toHaveBeenCalledTimes(1));
  expect(harness.cancel).not.toHaveBeenCalled();
  harness.getHandlers().onCompleted({ media: { asset: { id: harness.assetId } } });
  await expect(manual).resolves.toBe(harness.descriptor);
});

it('keeps an in-flight registration when a manual subscriber replaces the aborted automatic owner', async () => {
  const harness = createHarness();
  const controller = new AbortController();
  let releaseStart;
  let registeredHandlers;
  harness.start.mockImplementationOnce((_request, handlers) => {
    registeredHandlers = handlers;
    return new Promise((resolve) => {
      releaseStart = () => resolve({ id: harness.jobId });
    });
  });
  const request = { url: 'https://example.com/join-during-registration', cookieSource: 'none' };
  const automatic = harness.adapter.downloadVideo({ ...request, signal: controller.signal });
  await vi.waitFor(() => expect(harness.start).toHaveBeenCalledTimes(1));

  controller.abort();
  await expect(automatic).rejects.toMatchObject({ name: 'AbortError' });
  const manual = harness.adapter.downloadVideo(request);
  releaseStart();
  await flush();

  expect(harness.cancel).not.toHaveBeenCalled();
  registeredHandlers.onCompleted({ media: { asset: { id: harness.assetId } } });
  await expect(manual).resolves.toBe(harness.descriptor);
});

it('rejects a stale automatic subscriber locally while a coalesced manual subscriber completes', async () => {
  const harness = createHarness();
  let releaseInspection;
  harness.inspect.mockReturnValueOnce(new Promise((resolve) => { releaseInspection = resolve; }));
  let autoCurrent = true;
  const validateOwnership = vi.fn(() => {
    if (!autoCurrent) {
      const error = new Error('automatic source switched');
      error.code = 'autoGenerationOwnershipLost';
      throw error;
    }
  });
  const request = { url: 'https://example.com/shared-owned', cookieSource: 'none' };

  const automatic = harness.adapter.downloadVideo({ ...request, validateOwnership });
  const manual = harness.adapter.downloadVideo(request);
  await flush();
  autoCurrent = false;
  releaseInspection({ inventory: {}, capability: { id: harness.inventoryId } });

  await expect(automatic).rejects.toMatchObject({ code: 'autoGenerationOwnershipLost' });
  await vi.waitFor(() => expect(harness.start).toHaveBeenCalledTimes(1));
  expect(harness.cancel).not.toHaveBeenCalled();
  harness.getHandlers().onCompleted({ media: { asset: { id: harness.assetId } } });
  await expect(manual).resolves.toBe(harness.descriptor);
  expect(harness.cancel).not.toHaveBeenCalled();
});

it('prunes a stale automatic owner on a native callback while its coalesced manual subscriber completes', async () => {
  const harness = createHarness();
  let autoCurrent = true;
  const validateOwnership = vi.fn(() => {
    if (!autoCurrent) {
      const error = new Error('automatic source switched');
      error.code = 'autoGenerationOwnershipLost';
      throw error;
    }
  });
  const request = { url: 'https://example.com/shared-after-registration', cookieSource: 'none' };
  const autoProgress = vi.fn();
  const autoSubtitle = vi.fn();
  const manualProgress = vi.fn();
  const manualSubtitle = vi.fn();
  const automatic = harness.adapter.downloadVideo({
    ...request,
    validateOwnership,
    onProgress: autoProgress,
    onSubtitle: autoSubtitle,
  });
  const manual = harness.adapter.downloadVideo({
    ...request,
    onProgress: manualProgress,
    onSubtitle: manualSubtitle,
  });
  await vi.waitFor(() => expect(harness.start).toHaveBeenCalledTimes(1));

  autoCurrent = false;
  harness.getHandlers().onProgress({
    job: { progress: { basisPoints: 4_000 } },
    progress: { fraction: 0.4 },
  });
  await expect(automatic).rejects.toMatchObject({ code: 'autoGenerationOwnershipLost' });
  expect(autoProgress).not.toHaveBeenCalled();
  expect(manualProgress).toHaveBeenCalledExactlyOnceWith(40);
  expect(harness.cancel).not.toHaveBeenCalled();

  const subtitle = { filename: 'captions.srt', language: 'en', content: 'owned manual result' };
  harness.getHandlers().onCompleted({
    media: { asset: { id: harness.assetId } },
    subtitle,
  });
  await expect(manual).resolves.toBe(harness.descriptor);
  expect(autoSubtitle).not.toHaveBeenCalled();
  expect(manualSubtitle).toHaveBeenCalledExactlyOnceWith(subtitle);
  expect(harness.cancel).not.toHaveBeenCalled();
});

it('cancels once and publishes no callback when the final owner goes stale after registration', async () => {
  const harness = createHarness();
  let current = true;
  const validateOwnership = () => {
    if (!current) {
      const error = new Error('source switched');
      error.code = 'autoGenerationOwnershipLost';
      throw error;
    }
  };
  const onProgress = vi.fn();
  const onSubtitle = vi.fn();
  const result = harness.adapter.downloadVideo({
    url: 'https://example.com/stale-after-registration',
    cookieSource: 'none',
    validateOwnership,
    onProgress,
    onSubtitle,
  });
  await vi.waitFor(() => expect(harness.start).toHaveBeenCalledTimes(1));

  current = false;
  harness.getHandlers().onProgress({
    job: { progress: { basisPoints: 5_000 } },
    progress: { fraction: 0.5 },
  });

  await expect(result).rejects.toMatchObject({ code: 'autoGenerationOwnershipLost' });
  await vi.waitFor(() => expect(harness.cancel).toHaveBeenCalledExactlyOnceWith(harness.jobId));
  expect(onProgress).not.toHaveBeenCalled();
  expect(onSubtitle).not.toHaveBeenCalled();
});

it('aborting one automatic subscriber never cancels its live coalesced manual subscriber', async () => {
  const harness = createHarness();
  const controller = new AbortController();
  const request = { url: 'https://example.com/shared-abort', cookieSource: 'none' };
  const automatic = harness.adapter.downloadVideo({ ...request, signal: controller.signal });
  const manual = harness.adapter.downloadVideo(request);
  await vi.waitFor(() => expect(harness.start).toHaveBeenCalledTimes(1));

  controller.abort();

  await expect(automatic).rejects.toMatchObject({ name: 'AbortError' });
  expect(harness.cancel).not.toHaveBeenCalled();
  harness.getHandlers().onCompleted({ media: { asset: { id: harness.assetId } } });
  await expect(manual).resolves.toBe(harness.descriptor);
  expect(harness.cancel).not.toHaveBeenCalled();
});

it('cancels exactly once when the final subscriber aborts after native job registration', async () => {
  const harness = createHarness();
  const controller = new AbortController();
  const result = harness.adapter.downloadVideo({
    url: 'https://example.com/final-abort',
    cookieSource: 'none',
    signal: controller.signal,
  });
  await vi.waitFor(() => expect(harness.start).toHaveBeenCalledTimes(1));

  controller.abort();
  controller.abort();

  await expect(result).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(harness.cancel).toHaveBeenCalledExactlyOnceWith(harness.jobId));
  harness.getHandlers().onCancelled({ id: harness.jobId });
  await flush();
  expect(harness.cancel).toHaveBeenCalledTimes(1);
});

it('rejects an invalid explicit cookie source before native inspection', async () => {
  const harness = createHarness();

  await expect(harness.adapter.downloadVideo({
    url: 'https://example.com/missing-cookie-source',
  })).rejects.toMatchObject({ code: 'invalidDownloadRequest' });
  await expect(harness.adapter.downloadVideo({
    url: 'https://example.com/invalid-cookie-source',
    cookieSource: 'firefox\n--exec',
  })).rejects.toMatchObject({ code: 'invalidDownloadRequest' });
  expect(harness.inspect).not.toHaveBeenCalled();
});

it('rejects the deprecated boolean cookie input even when an explicit source is present', async () => {
  const harness = createHarness();

  await expect(harness.adapter.downloadVideo({
    url: 'https://example.com/deprecated-cookie-toggle',
    cookieSource: 'edge',
    useCookies: true,
  })).rejects.toMatchObject({ code: 'invalidDownloadRequest' });
  expect(harness.inspect).not.toHaveBeenCalled();
});

it('snapshots request descriptors without invoking accessors or proxy get traps', async () => {
  const harness = createHarness();
  let urlReads = 0;
  const accessorRequest = { cookieSource: 'none' };
  Object.defineProperty(accessorRequest, 'url', {
    enumerable: true,
    get() {
      urlReads += 1;
      return 'https://example.com/accessor';
    },
  });
  await expect(harness.adapter.downloadVideo(accessorRequest)).rejects.toMatchObject({
    code: 'invalidDownloadRequest',
  });
  expect(urlReads).toBe(0);

  let getTraps = 0;
  const proxied = new Proxy({
    url: 'https://example.com/proxy',
    cookieSource: 'none',
  }, {
    get(target, key, receiver) {
      getTraps += 1;
      return Reflect.get(target, key, receiver);
    },
  });
  const pending = harness.adapter.downloadVideo(proxied);
  await vi.waitFor(() => expect(harness.start).toHaveBeenCalledTimes(1));
  harness.getHandlers().onCancelled();
  await expect(pending).resolves.toBeNull();
  expect(getTraps).toBe(0);
});

it('bounds URL input and rolls back throwing signal registration before map insertion', async () => {
  const harness = createHarness();
  await expect(harness.adapter.downloadVideo({
    url: `https://example.com/${'x'.repeat(8_193)}`,
    cookieSource: 'none',
  })).rejects.toMatchObject({ code: 'invalidDownloadRequest' });

  const signal = {
    get aborted() { return false; },
    addEventListener() { throw new Error('registration failed'); },
    removeEventListener() { throw new Error('cleanup failed'); },
  };
  await expect(harness.adapter.downloadVideo({
    url: 'https://example.com/throwing-registration',
    cookieSource: 'none',
    signal,
  })).rejects.toMatchObject({ code: 'invalidDownloadRequest' });
  expect(harness.inspect).not.toHaveBeenCalled();

  const retry = harness.adapter.downloadVideo({
    url: 'https://example.com/throwing-registration',
    cookieSource: 'none',
  });
  await vi.waitFor(() => expect(harness.start).toHaveBeenCalledTimes(1));
  harness.getHandlers().onCancelled();
  await expect(retry).resolves.toBeNull();
});

it('captures AbortSignal methods once and handles abort during registration with no orphan', async () => {
  const harness = createHarness();
  const reads = { aborted: 0, add: 0, remove: 0 };
  let removals = 0;
  const signal = {};
  Object.defineProperties(signal, {
    aborted: {
      get() {
        reads.aborted += 1;
        return true;
      },
    },
    addEventListener: {
      get() {
        reads.add += 1;
        return (_name, listener) => listener();
      },
    },
    removeEventListener: {
      get() {
        reads.remove += 1;
        return () => { removals += 1; };
      },
    },
  });

  await expect(harness.adapter.downloadVideo({
    url: 'https://example.com/abort-during-registration',
    cookieSource: 'none',
    signal,
  })).rejects.toMatchObject({ name: 'AbortError' });
  expect(reads).toEqual({ aborted: 1, add: 1, remove: 1 });
  expect(removals).toBe(1);
  expect(harness.inspect).not.toHaveBeenCalled();
});

it('settles exactly once when AbortSignal cleanup throws', async () => {
  const harness = createHarness();
  let abortListener;
  const signal = {
    aborted: false,
    addEventListener(_name, listener) { abortListener = listener; },
    removeEventListener() { throw new Error('hostile cleanup'); },
  };
  const pending = harness.adapter.downloadVideo({
    url: 'https://example.com/throwing-remove',
    cookieSource: 'none',
    signal,
  });
  await vi.waitFor(() => expect(harness.start).toHaveBeenCalledTimes(1));
  abortListener();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(harness.cancel).toHaveBeenCalledExactlyOnceWith(harness.jobId));
});

it('awaits rejected ownership and onStarted thenables without leaking an operation', async () => {
  const ownership = createHarness();
  const ownershipError = Object.assign(new Error('source switched'), {
    code: 'autoGenerationOwnershipLost',
  });
  await expect(ownership.adapter.downloadVideo({
    url: 'https://example.com/async-owner',
    cookieSource: 'none',
    validateOwnership: () => ({
      then(_resolve, reject) { reject(ownershipError); },
    }),
  })).rejects.toMatchObject({ code: 'autoGenerationOwnershipLost' });
  expect(ownership.inspect).not.toHaveBeenCalled();

  const callback = createHarness();
  const pending = callback.adapter.downloadVideo({
    url: 'https://example.com/async-start-callback',
    cookieSource: 'none',
    onStarted: () => ({
      then(_resolve, reject) { reject(new Error('callback failed')); },
    }),
  });
  await expect(pending).rejects.toMatchObject({ code: 'downloadCallbackFailed' });
  await vi.waitFor(() => expect(callback.cancel).toHaveBeenCalledExactlyOnceWith(callback.jobId));
});

