// Retry and cancellation: transient-failure retries, backoff, public cancel races and ownership.
import { v7 as uuidv7 } from 'uuid';

import { createNativeUrlDownloadAdapter } from './nativeUrlDownloadAdapter';
import { activateResolvedMediaProject } from './mediaProjectActivation';

import {
  candidateProject,
  createHarness,
  deferred,
  flush,
  mediaCandidate,
} from './nativeUrlDownloadAdapterTestFixtures';

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

it('re-inspects and retries one transient downloader process failure', async () => {
  const inventoryIds = [uuidv7(), uuidv7()];
  const jobIds = [uuidv7(), uuidv7()];
  const assetId = uuidv7();
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
  const recoverDownloader = vi.fn().mockResolvedValue({
    checked: true,
    updated: true,
    throttled: false,
  });
  const waitForRetry = vi.fn().mockResolvedValue(undefined);
  const descriptor = Object.freeze({ assetId, playbackUrl: 'http://127.0.0.1/retried' });
  const onStarted = vi.fn();
  const onProgress = vi.fn();
  const adapter = createNativeUrlDownloadAdapter({
    activateProject: activateResolvedMediaProject,
    inspect,
    start,
    cancel: vi.fn(),
    openAsset: vi.fn(),
    claimCandidate: vi.fn(() => descriptor),
    discardCandidate: vi.fn().mockResolvedValue(true),
    resolveCandidateProject: vi.fn().mockResolvedValue(candidateProject(uuidv7(), 1)),
    recoverDownloader,
    waitForRetry,
  });

  const result = adapter.downloadVideo({
    url: 'https://example.com/transient',
    cookieSource: 'none',
    onStarted,
    onProgress,
  });
  await flush();
  handlers[0].onProgress({
    job: { progress: { basisPoints: 9_900 } },
    progress: { fraction: 0.99 },
  });
  handlers[0].onFailed({ error: { code: 'downloaderExecutionFailed' } });
  await flush();

  expect(recoverDownloader).toHaveBeenCalledTimes(1);
  expect(waitForRetry).toHaveBeenCalledExactlyOnceWith(2_000);
  expect(inspect).toHaveBeenCalledTimes(2);
  expect(start).toHaveBeenCalledTimes(2);
  expect(start.mock.calls.map(([request]) => request.inventoryId)).toEqual(inventoryIds);
  expect(onStarted.mock.calls.map(([jobId]) => jobId)).toEqual(jobIds);
  expect(onProgress.mock.calls.map(([progress]) => progress)).toEqual([99, 0]);

  handlers[1].onCompleted({ media: { asset: { id: assetId } } });
  await expect(result).resolves.toBe(descriptor);
});

it('bounds repeated execution recovery and never retries permanent failures', async () => {
  const execution = createHarness();
  execution.recoverDownloader.mockResolvedValue({
    checked: true,
    updated: true,
    throttled: false,
  });
  const executionResult = execution.adapter.downloadVideo({
    url: 'https://example.com/execution-failure',
    cookieSource: 'none',
  });
  await flush();
  execution.getHandlers().onFailed({ error: { code: 'downloaderExecutionFailed' } });
  await flush();
  execution.getHandlers().onFailed({ error: { code: 'downloaderExecutionFailed' } });
  await flush();
  execution.getHandlers().onFailed({ error: { code: 'downloaderExecutionFailed' } });
  await expect(executionResult).rejects.toMatchObject({
    code: 'downloaderExecutionFailed',
  });
  expect(execution.inspect).toHaveBeenCalledTimes(3);
  expect(execution.start).toHaveBeenCalledTimes(3);
  expect(execution.recoverDownloader).toHaveBeenCalledTimes(2);
  expect(execution.waitForRetry.mock.calls).toEqual([[2_000], [8_000]]);

  const unchanged = createHarness();
  unchanged.recoverDownloader.mockResolvedValue({
    checked: true,
    updated: false,
    throttled: true,
  });
  const unchangedResult = unchanged.adapter.downloadVideo({
    url: 'https://example.com/unchanged-downloader',
    cookieSource: 'none',
  });
  await flush();
  unchanged.getHandlers().onFailed({ error: { code: 'downloaderExecutionFailed' } });
  await flush();
  unchanged.getHandlers().onFailed({ error: { code: 'downloaderExecutionFailed' } });
  await flush();
  unchanged.getHandlers().onFailed({ error: { code: 'downloaderExecutionFailed' } });
  await expect(unchangedResult).rejects.toMatchObject({ code: 'downloaderExecutionFailed' });
  expect(unchanged.recoverDownloader).toHaveBeenCalledTimes(2);
  expect(unchanged.inspect).toHaveBeenCalledTimes(3);
  expect(unchanged.start).toHaveBeenCalledTimes(3);

  const permanent = createHarness();
  const permanentResult = permanent.adapter.downloadVideo({
    url: 'https://example.com/permanent-failure',
    cookieSource: 'none',
  });
  await flush();
  permanent.getHandlers().onFailed({ error: { code: 'invalidDownloadRequest' } });
  await expect(permanentResult).rejects.toMatchObject({ code: 'invalidDownloadRequest' });
  expect(permanent.inspect).toHaveBeenCalledTimes(1);
  expect(permanent.start).toHaveBeenCalledTimes(1);
});

it('detaches a public cancellation before an immediate same-URL retry can subscribe', async () => {
  const harness = createHarness();
  const request = { url: 'https://example.com/cancel-then-retry', cookieSource: 'none' };

  const first = harness.adapter.downloadVideo(request);
  await vi.waitFor(() => expect(harness.start).toHaveBeenCalledTimes(1));
  const firstHandlers = harness.getHandlers();

  await expect(harness.adapter.cancelVideo(harness.jobId)).resolves.toBe(true);
  await expect(first).resolves.toBeNull();
  expect(harness.cancel).toHaveBeenCalledExactlyOnceWith(harness.jobId);

  // Retry at the first instant the public cancellation resolves. The prior implementation reset
  // the button here while leaving the adapter operation reusable, so this subscribed to the
  // cancelling job instead of registering a fresh one.
  const retried = harness.adapter.downloadVideo(request);
  await vi.waitFor(() => expect(harness.start).toHaveBeenCalledTimes(2));
  const retryHandlers = harness.getHandlers();
  expect(retryHandlers).not.toBe(firstHandlers);
  retryHandlers.onCompleted({ media: mediaCandidate(harness.assetId), subtitle: null });

  await expect(retried).resolves.toBe(harness.descriptor);
  expect(harness.cancel).toHaveBeenCalledTimes(1);
});

it('serializes a delayed completion behind a winning public cancellation', async () => {
  const cancellation = deferred();
  const cancel = vi.fn(() => cancellation.promise);
  const harness = createHarness({ cancel });
  const pending = harness.adapter.downloadVideo({
    url: 'https://example.com/cancel-completion-fence',
    cookieSource: 'none',
  });
  await vi.waitFor(() => expect(harness.start).toHaveBeenCalledTimes(1));

  const firstCancel = harness.adapter.cancelVideo(harness.jobId);
  const duplicateCancel = harness.adapter.cancelVideo(harness.jobId);
  harness.getHandlers().onCompleted({
    media: mediaCandidate(harness.assetId),
    subtitle: null,
  });
  await flush();
  expect(harness.describeMedia).not.toHaveBeenCalled();
  expect(cancel).toHaveBeenCalledExactlyOnceWith(harness.jobId);

  cancellation.resolve({ id: harness.jobId, state: 'cancelling' });
  await expect(Promise.all([firstCancel, duplicateCancel])).resolves.toEqual([true, true]);
  await expect(pending).resolves.toBeNull();
  await vi.waitFor(() => {
    expect(harness.discardCandidate).toHaveBeenCalledExactlyOnceWith(harness.assetId);
  });
  expect(harness.describeMedia).not.toHaveBeenCalled();
});

it('reports cancellation lost and publishes completion when Rust already committed success', async () => {
  const cancellation = deferred();
  const cancel = vi.fn(() => cancellation.promise);
  const harness = createHarness({ cancel });
  const pending = harness.adapter.downloadVideo({
    url: 'https://example.com/completion-wins-cancel-race',
    cookieSource: 'none',
  });
  await vi.waitFor(() => expect(harness.start).toHaveBeenCalledTimes(1));

  const cancelResult = harness.adapter.cancelVideo(harness.jobId);
  harness.getHandlers().onCompleted({
    media: mediaCandidate(harness.assetId),
    subtitle: null,
  });
  await flush();
  expect(harness.describeMedia).not.toHaveBeenCalled();

  cancellation.resolve({ id: harness.jobId, state: 'succeeded' });
  await expect(cancelResult).resolves.toBe(false);
  await expect(pending).resolves.toBe(harness.descriptor);
  expect(harness.describeMedia).toHaveBeenCalledTimes(1);
  expect(harness.discardCandidate).not.toHaveBeenCalled();
});

it('never restores cancellation-lost A over a newer same-key B operation', async () => {
  const cancellation = deferred();
  const jobIds = [uuidv7(), uuidv7()];
  const assetIds = [uuidv7(), uuidv7()];
  const descriptors = assetIds.map((assetId, index) => Object.freeze({
    assetId,
    playbackUrl: `http://127.0.0.1/source-${index + 1}`,
  }));
  const handlers = [];
  const start = vi.fn(async (_request, nextHandlers) => {
    const index = handlers.length;
    handlers.push(nextHandlers);
    return { id: jobIds[index] };
  });
  const cancel = vi.fn(() => cancellation.promise);
  const adapter = createNativeUrlDownloadAdapter({
    inspect: vi.fn(async () => ({ capability: { id: uuidv7() }, inventory: {} })),
    start,
    cancel,
    claimCandidate: vi.fn(async (candidate) => (
      descriptors[assetIds.indexOf(candidate.asset.id)]
    )),
    discardCandidate: vi.fn().mockResolvedValue(true),
    resolveCandidateProject: vi.fn(async () => candidateProject(uuidv7(), 1)),
    activateProject: vi.fn(async () => ({ claimOptions: {}, release() {} })),
  });
  const request = { url: 'https://example.com/cancellation-lost-newer-owner', cookieSource: 'none' };

  const first = adapter.downloadVideo(request);
  await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
  const cancelResult = adapter.cancelVideo(jobIds[0]);

  // A is detached while native cancellation is unresolved, so a new caller owns distinct B.
  const second = adapter.downloadVideo(request);
  await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(2));
  expect(jobIds[1]).not.toBe(jobIds[0]);

  cancellation.resolve({ id: jobIds[0], state: 'succeeded' });
  await expect(cancelResult).resolves.toBe(false);

  // Cancellation-lost A must not overwrite B's active slot. A third caller therefore joins B.
  const third = adapter.downloadVideo(request);
  await flush();
  expect(start).toHaveBeenCalledTimes(2);
  expect(cancel).toHaveBeenCalledExactlyOnceWith(jobIds[0]);

  handlers[0].onCompleted({ media: mediaCandidate(assetIds[0]), subtitle: null });
  handlers[1].onCompleted({ media: mediaCandidate(assetIds[1]), subtitle: null });
  await expect(first).resolves.toBe(descriptors[0]);
  await expect(second).resolves.toBe(descriptors[1]);
  await expect(third).resolves.toBe(descriptors[1]);
});

it('cancels the logical operation at the failure-to-backoff boundary without retrying dead A', async () => {
  const harness = createHarness();
  const pending = harness.adapter.downloadVideo({
    url: 'https://example.com/cancel-at-retry-boundary',
    cookieSource: 'none',
  });
  await vi.waitFor(() => expect(harness.start).toHaveBeenCalledTimes(1));

  // The failure event enters the serialized queue first; Cancel enters immediately behind it,
  // before runOperation has a chance to admit another inspection/start attempt.
  harness.getHandlers().onFailed({ error: { code: 'downloaderRateLimited' } });
  const cancelled = harness.adapter.cancelVideo(harness.jobId);

  await expect(cancelled).resolves.toBe(true);
  await expect(pending).resolves.toBeNull();
  await flush();
  expect(harness.cancel).not.toHaveBeenCalled();
  expect(harness.inspect).toHaveBeenCalledTimes(1);
  expect(harness.start).toHaveBeenCalledTimes(1);
});

it('cancels the logical operation during retry delay and never wakes into another attempt', async () => {
  const retryDelay = deferred();
  const waitForRetry = vi.fn(() => retryDelay.promise);
  const harness = createHarness({ waitForRetry });
  const pending = harness.adapter.downloadVideo({
    url: 'https://example.com/cancel-during-retry-delay',
    cookieSource: 'none',
  });
  await vi.waitFor(() => expect(harness.start).toHaveBeenCalledTimes(1));
  harness.getHandlers().onFailed({ error: { code: 'downloaderRateLimited' } });
  await vi.waitFor(() => expect(waitForRetry).toHaveBeenCalledExactlyOnceWith(2_000));

  const cancelled = harness.adapter.cancelVideo(harness.jobId);
  await expect(cancelled).resolves.toBe(true);
  await expect(pending).resolves.toBeNull();
  expect(harness.cancel).not.toHaveBeenCalled();

  retryDelay.resolve();
  await flush();
  await flush();
  expect(harness.inspect).toHaveBeenCalledTimes(1);
  expect(harness.start).toHaveBeenCalledTimes(1);
});

it('refuses to claim cancellation for a job the URL adapter does not own', async () => {
  const harness = createHarness();

  await expect(harness.adapter.cancelVideo(uuidv7())).resolves.toBe(false);

  expect(harness.cancel).not.toHaveBeenCalled();
});

it('keeps a running operation owned when the native cancel command is rejected', async () => {
  const cancellationError = new Error('native cancellation channel unavailable');
  const harness = createHarness({ cancel: vi.fn().mockRejectedValueOnce(cancellationError) });
  const request = { url: 'https://example.com/cancel-command-rejected', cookieSource: 'none' };
  const first = harness.adapter.downloadVideo(request);
  await vi.waitFor(() => expect(harness.start).toHaveBeenCalledTimes(1));

  await expect(harness.adapter.cancelVideo(harness.jobId)).rejects.toBe(cancellationError);
  const coalesced = harness.adapter.downloadVideo(request);
  await flush();
  expect(harness.start).toHaveBeenCalledTimes(1);

  harness.getHandlers().onCompleted({ media: mediaCandidate(harness.assetId), subtitle: null });
  await expect(first).resolves.toBe(harness.descriptor);
  await expect(coalesced).resolves.toBe(harness.descriptor);
});

it('paces and re-inspects a transient rate limit without misdiagnosing the downloader', async () => {
  const harness = createHarness();
  const result = harness.adapter.downloadVideo({
    url: 'https://www.youtube.com/watch?v=rate-limited',
    cookieSource: 'none',
  });
  await flush();
  harness.getHandlers().onFailed({ error: { code: 'downloaderRateLimited' } });
  await flush();

  expect(harness.waitForRetry).toHaveBeenCalledExactlyOnceWith(2_000);
  expect(harness.recoverDownloader).not.toHaveBeenCalled();
  expect(harness.inspect).toHaveBeenCalledTimes(2);
  expect(harness.start).toHaveBeenCalledTimes(2);

  harness.getHandlers().onCompleted({ media: { asset: { id: harness.assetId } } });
  await expect(result).resolves.toBe(harness.descriptor);
});

