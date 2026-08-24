import { v7 as uuidv7 } from 'uuid';

import { downloadAndPrepareYouTubeVideo } from '../components/app/VideoProcessingHandlers';
import { createDownloadHandlers } from '../components/app/handlers/downloadHandlers';
import { isNativeMediaDescriptor } from './mediaService';
import { createNativeUrlDownloadAdapter } from './nativeUrlDownloadAdapter';
import { activateResolvedMediaProject } from './mediaProjectActivation';
import { getCachedSubtitles } from '../services/subtitleCache';
import {
  activateSubtitleProjectBinding,
  rollbackSubtitleProjectBinding,
} from './subtitleProjectBinding';
import { setCurrentCacheId as setRulesCacheId } from '../utils/transcriptionRulesStore';
import { setCurrentCacheId as setSubtitlesCacheId } from '../utils/userSubtitlesStore';

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

const flush = () => new Promise((resolve) => { setTimeout(resolve, 0); });

const mediaCandidate = (assetId) => ({
  asset: {
    id: assetId,
    displayName: 'download.mp4',
    extension: 'mp4',
    sizeBytes: 4096,
    kind: 'video',
  },
  contentIdentity: {
    algorithm: 'blake3-256',
    digest: 'c'.repeat(64),
    sizeBytes: 4096,
  },
});

const candidateProject = (projectId = uuidv7(), stateVersion = 7) => ({
  projectId,
  snapshot: {
    metadata: { id: projectId, name: 'Downloaded media' },
    stateVersion,
    media: [],
    tracks: [],
  },
});

const createHarness = (overrides = {}) => {
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
  const discardCandidate = vi.fn().mockResolvedValue(true);
  const projectId = uuidv7();
  const resolveCandidateProject = vi.fn().mockResolvedValue(candidateProject(projectId));
  const recoverDownloader = vi.fn().mockResolvedValue({ updated: false, throttled: false });
  const waitForRetry = vi.fn().mockResolvedValue(undefined);
  const adapter = createNativeUrlDownloadAdapter({
    inspect,
    start,
    cancel,
    openAsset,
    claimCandidate: describeMedia,
    discardCandidate,
    resolveCandidateProject,
    recoverDownloader,
    waitForRetry,
    activateProject: activateResolvedMediaProject,
    ...overrides,
  });
  return {
    ...overrides,
    adapter,
    assetId,
    cancel,
    describeMedia,
    discardCandidate,
    descriptor,
    getHandlers: () => handlers,
    inspect,
    inventoryId,
    jobId,
    openAsset,
    recoverDownloader,
    waitForRetry,
    resolveCandidateProject,
    start,
  };
};

it('coalesces matching preview and processing requests and broadcasts monotonic progress', async () => {
  const harness = createHarness();
  const firstStarted = vi.fn();
  const secondStarted = vi.fn();
  const firstProgress = vi.fn();
  const secondProgress = vi.fn();
  const request = { url: 'https://www.youtube.com/watch?v=abc', cookieSource: 'chrome' };

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
  await vi.waitFor(() => {
    expect(firstProgress.mock.calls.map(([value]) => value)).toEqual([40, 40]);
    expect(secondProgress.mock.calls.map(([value]) => value)).toEqual([40, 40]);
  });

  harness.getHandlers().onCompleted({ media: { asset: { id: harness.assetId } } });
  await expect(first).resolves.toBe(harness.descriptor);
  await expect(second).resolves.toBe(harness.descriptor);
  expect(harness.describeMedia).toHaveBeenCalledWith(
    { asset: { id: harness.assetId } },
    expect.objectContaining({ expectedStateVersion: 7 }),
    { validateOwnership: expect.any(Function) }
  );
  expect(harness.openAsset).not.toHaveBeenCalled();
});

it('claims the serialized Rust candidate once and never discards the winning asset', async () => {
  const harness = createHarness();
  const candidate = mediaCandidate(harness.assetId);
  const pending = harness.adapter.downloadVideo({
    url: 'https://example.com/candidate-winner',
    cookieSource: 'none',
  });
  await vi.waitFor(() => expect(harness.start).toHaveBeenCalledTimes(1));
  harness.getHandlers().onCompleted({ media: candidate, subtitle: null });

  await expect(pending).resolves.toBe(harness.descriptor);
  expect(harness.describeMedia).toHaveBeenCalledExactlyOnceWith(candidate, {
    expectedStateVersion: 7,
    projectId: expect.any(String),
  }, { validateOwnership: expect.any(Function) });
  expect(harness.discardCandidate).not.toHaveBeenCalled();
});

it('the production adapter refuses to acquire media without a caller-owned activation transaction', async () => {
  const harness = createHarness({ activateProject: null });

  await expect(harness.adapter.downloadVideo({
    url: 'https://example.com/unowned',
    cookieSource: 'none',
  })).rejects.toMatchObject({ code: 'invalidDownloadRequest' });

  expect(harness.inspect).not.toHaveBeenCalled();
  expect(harness.start).not.toHaveBeenCalled();
  expect(harness.describeMedia).not.toHaveBeenCalled();
});

it('a staged candidate whose owner was superseded never activates or opens native media', async () => {
  const cacheId = 'site_example_test_staged';
  const project = { ...candidateProject(), cacheId };
  const harness = createHarness({
    activateProject: null,
    resolveCandidateProject: vi.fn(async () => project),
  });
  let current = true;
  const ownershipError = Object.assign(new Error('newer media won'), {
    code: 'autoGenerationOwnershipLost',
  });
  const admitActivation = vi.fn();
  const publishActivation = vi.fn();
  const rollbackActivation = vi.fn();
  const pending = harness.adapter.downloadVideo({
    url: 'https://example.com/staged',
    cookieSource: 'none',
    validateOwnership: () => {
      if (!current) throw ownershipError;
    },
    admitActivation,
    publishActivation,
    rollbackActivation,
  });
  await vi.waitFor(() => expect(harness.start).toHaveBeenCalledOnce());

  current = false;
  harness.getHandlers().onCompleted({ media: mediaCandidate(harness.assetId), subtitle: null });

  await expect(pending).rejects.toMatchObject({ code: 'autoGenerationOwnershipLost' });
  await vi.waitFor(() => {
    expect(harness.discardCandidate).toHaveBeenCalledExactlyOnceWith(harness.assetId);
  });
  expect(admitActivation).not.toHaveBeenCalled();
  expect(harness.describeMedia).not.toHaveBeenCalled();
  expect(publishActivation).not.toHaveBeenCalled();
  expect(rollbackActivation).not.toHaveBeenCalled();
});

it('withdraws project/store admission and restores native state when ownership is lost in claim', async () => {
  const cacheId = 'site_example_test_mid_claim';
  const project = { ...candidateProject(), cacheId };
  let finishClaim;
  const claim = vi.fn(() => new Promise((resolve) => { finishClaim = resolve; }));
  const harness = createHarness({
    activateProject: null,
    claimCandidate: claim,
    resolveCandidateProject: vi.fn(async () => project),
  });
  let current = true;
  const ownershipError = Object.assign(new Error('newer media won'), {
    code: 'autoGenerationOwnershipLost',
  });
  const binding = Object.freeze({
    kind: 'subtitle-project-binding',
    cacheId,
    projectId: project.projectId,
    stateVersion: project.snapshot.stateVersion,
  });
  const admitActivation = vi.fn(async () => binding);
  const publishActivation = vi.fn();
  const rollbackActivation = vi.fn();
  rollbackSubtitleProjectBinding.mockClear();
  const pending = harness.adapter.downloadVideo({
    url: 'https://example.com/mid-claim',
    cookieSource: 'none',
    validateOwnership: () => {
      if (!current) throw ownershipError;
    },
    admitActivation,
    publishActivation,
    rollbackActivation,
  });
  await vi.waitFor(() => expect(harness.start).toHaveBeenCalledOnce());
  harness.getHandlers().onCompleted({ media: mediaCandidate(harness.assetId), subtitle: null });
  await vi.waitFor(() => expect(claim).toHaveBeenCalledOnce());

  current = false;
  finishClaim(harness.descriptor);

  await expect(pending).rejects.toMatchObject({ code: 'autoGenerationOwnershipLost' });
  await vi.waitFor(() => expect(rollbackActivation).toHaveBeenCalledOnce());
  expect(rollbackSubtitleProjectBinding).toHaveBeenCalledExactlyOnceWith(binding);
  expect(publishActivation).not.toHaveBeenCalled();
});

it('discards a losing candidate exactly once when project claim fails', async () => {
  const harness = createHarness();
  const candidate = mediaCandidate(harness.assetId);
  harness.describeMedia.mockRejectedValueOnce(new Error('project version lost'));
  const pending = harness.adapter.downloadVideo({
    url: 'https://example.com/candidate-loser',
    cookieSource: 'none',
  });
  await vi.waitFor(() => expect(harness.start).toHaveBeenCalledTimes(1));
  harness.getHandlers().onCompleted({ media: candidate, subtitle: null });

  await expect(pending).rejects.toMatchObject({ code: 'mediaOpenFailed' });
  expect(harness.discardCandidate).toHaveBeenCalledExactlyOnceWith(harness.assetId);
});

it('refuses a failed candidate cleanup instead of reporting the media transaction as closed', async () => {
  const harness = createHarness();
  harness.describeMedia.mockRejectedValueOnce(new Error('project version lost'));
  harness.discardCandidate.mockResolvedValueOnce(false);
  const pending = harness.adapter.downloadVideo({
    url: 'https://example.com/candidate-cleanup-refused',
    cookieSource: 'none',
  });
  await vi.waitFor(() => expect(harness.start).toHaveBeenCalledTimes(1));
  harness.getHandlers().onCompleted({
    media: mediaCandidate(harness.assetId),
    subtitle: null,
  });

  await expect(pending).rejects.toMatchObject({ code: 'mediaCandidateDiscardFailed' });
  expect(harness.discardCandidate).toHaveBeenCalledExactlyOnceWith(harness.assetId);
});

it('surfaces a failed native activation rollback after withdrawing project admission', async () => {
  rollbackSubtitleProjectBinding.mockClear();
  const cacheId = 'site_example_test_rollback_failure';
  const project = { ...candidateProject(), cacheId };
  const harness = createHarness({
    activateProject: null,
    resolveCandidateProject: vi.fn(async () => project),
  });
  const binding = Object.freeze({
    kind: 'subtitle-project-binding',
    cacheId,
    projectId: project.projectId,
    stateVersion: project.snapshot.stateVersion,
  });
  const rollbackActivation = vi.fn(async () => {
    throw new Error('native session restore failed');
  });
  const pending = harness.adapter.downloadVideo({
    url: 'https://example.com/rollback-failure',
    cookieSource: 'none',
    validateOwnership: vi.fn(),
    admitActivation: vi.fn(async () => binding),
    publishActivation: vi.fn(async () => {
      throw new Error('publication failed');
    }),
    rollbackActivation,
  });
  await vi.waitFor(() => expect(harness.start).toHaveBeenCalledTimes(1));
  harness.getHandlers().onCompleted({
    media: mediaCandidate(harness.assetId),
    subtitle: null,
  });

  await expect(pending).rejects.toMatchObject({ code: 'mediaActivationRollbackFailed' });
  expect(rollbackSubtitleProjectBinding).toHaveBeenCalledExactlyOnceWith(binding);
  expect(rollbackActivation).toHaveBeenCalledOnce();
  expect(harness.discardCandidate).toHaveBeenCalledExactlyOnceWith(harness.assetId);
});

const publicationSpy = () => {
  const release = vi.fn(() => true);
  const activateProject = vi.fn(async (resolved) => Object.freeze({
    claimOptions: Object.freeze({
      expectedStateVersion: resolved.snapshot.stateVersion,
      projectId: resolved.projectId,
    }),
    release,
  }));
  return { activateProject, release };
};

it('publishes the exact resolved project before claiming a downloaded candidate', async () => {
  const { activateProject, release } = publicationSpy();
  const harness = createHarness({ activateProject });
  const candidate = mediaCandidate(harness.assetId);
  const pending = harness.adapter.downloadVideo({
    url: 'https://example.com/candidate-publication',
    cookieSource: 'none',
  });
  await vi.waitFor(() => expect(harness.start).toHaveBeenCalledTimes(1));
  harness.getHandlers().onCompleted({ media: candidate, subtitle: null });

  await expect(pending).resolves.toBe(harness.descriptor);
  expect(harness.resolveCandidateProject).toHaveBeenCalledExactlyOnceWith(
    'https://example.com/candidate-publication'
  );
  expect(activateProject).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ projectId: expect.any(String) }),
    { validateOwnership: expect.any(Function) }
  );
  expect(harness.describeMedia).toHaveBeenCalledExactlyOnceWith(candidate, {
    expectedStateVersion: 7,
    projectId: expect.any(String),
  }, { validateOwnership: expect.any(Function) });
  expect(release).not.toHaveBeenCalled();
});

it('releases the published project when the candidate claim fails', async () => {
  const { activateProject, release } = publicationSpy();
  const harness = createHarness({ activateProject });
  harness.describeMedia.mockRejectedValueOnce(new Error('project version lost'));
  const pending = harness.adapter.downloadVideo({
    url: 'https://example.com/candidate-publication-loser',
    cookieSource: 'none',
  });
  await vi.waitFor(() => expect(harness.start).toHaveBeenCalledTimes(1));
  harness.getHandlers().onCompleted({ media: mediaCandidate(harness.assetId), subtitle: null });

  await expect(pending).rejects.toMatchObject({ code: 'mediaOpenFailed' });
  expect(release).toHaveBeenCalledOnce();
  expect(harness.discardCandidate).toHaveBeenCalledExactlyOnceWith(harness.assetId);
});

it('discards a candidate exactly once when ownership is lost inside the publication', async () => {
  const ownershipError = Object.assign(new Error('source switched'), {
    code: 'autoGenerationOwnershipLost',
  });
  let current = true;
  const activateProject = vi.fn(async (_resolved, { validateOwnership }) => {
    current = false;
    await validateOwnership();
    throw new Error('The publication must not survive a lost owner');
  });
  const harness = createHarness({ activateProject });
  const pending = harness.adapter.downloadVideo({
    url: 'https://example.com/candidate-publication-owner-lost',
    cookieSource: 'none',
    validateOwnership: () => {
      if (!current) throw ownershipError;
    },
  });
  await vi.waitFor(() => expect(harness.start).toHaveBeenCalledTimes(1));
  harness.getHandlers().onCompleted({ media: mediaCandidate(harness.assetId), subtitle: null });

  await expect(pending).rejects.toMatchObject({ code: 'autoGenerationOwnershipLost' });
  await vi.waitFor(() => {
    expect(harness.discardCandidate).toHaveBeenCalledExactlyOnceWith(harness.assetId);
  });
  expect(harness.describeMedia).not.toHaveBeenCalled();
});

it('publishes the cached project again before reopening a completed asset', async () => {
  const { activateProject, release } = publicationSpy();
  const harness = createHarness({ activateProject });
  const request = { url: 'https://example.com/cached-publication', cookieSource: 'none' };
  const first = harness.adapter.downloadVideo(request);
  await flush();
  harness.getHandlers().onCompleted({ media: { asset: { id: harness.assetId } } });
  await first;
  await flush();

  activateProject.mockClear();
  harness.resolveCandidateProject.mockClear();
  await expect(harness.adapter.downloadVideo(request)).resolves.toBe(harness.descriptor);

  expect(harness.start).toHaveBeenCalledTimes(1);
  expect(harness.resolveCandidateProject).toHaveBeenCalledExactlyOnceWith(request.url);
  expect(activateProject).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ projectId: expect.any(String) }),
    { validateOwnership: expect.any(Function) }
  );
  expect(harness.openAsset).toHaveBeenCalledExactlyOnceWith(harness.assetId);
  expect(release).not.toHaveBeenCalled();
});

it('keeps the cached capability when publishing its project fails', async () => {
  const { activateProject, release } = publicationSpy();
  const harness = createHarness({ activateProject });
  const request = { url: 'https://example.com/cached-publication-unavailable', cookieSource: 'none' };
  const first = harness.adapter.downloadVideo(request);
  await flush();
  harness.getHandlers().onCompleted({ media: { asset: { id: harness.assetId } } });
  await first;
  await flush();

  activateProject.mockRejectedValueOnce(new Error('the project store is unavailable'));
  await expect(harness.adapter.downloadVideo(request)).rejects.toMatchObject({
    code: 'mediaCandidateProjectFailed',
  });
  expect(harness.start).toHaveBeenCalledTimes(1);
  expect(harness.openAsset).not.toHaveBeenCalled();
  expect(release).not.toHaveBeenCalled();

  // The download was never invalidated, so the next request still reopens it without downloading.
  await expect(harness.adapter.downloadVideo(request)).resolves.toBe(harness.descriptor);
  expect(harness.start).toHaveBeenCalledTimes(1);
  expect(harness.openAsset).toHaveBeenCalledExactlyOnceWith(harness.assetId);
});

it('releases the published project when a cached reopen genuinely fails', async () => {
  const { activateProject, release } = publicationSpy();
  const harness = createHarness({ activateProject });
  const request = { url: 'https://example.com/cached-publication-failure', cookieSource: 'none' };
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
  expect(release).toHaveBeenCalledOnce();
  expect(harness.openAsset).toHaveBeenCalledTimes(1);
});

it('discards a completed candidate when its final owner is stale before activation', async () => {
  const harness = createHarness();
  const candidate = mediaCandidate(harness.assetId);
  let current = true;
  const ownershipError = Object.assign(new Error('source switched'), {
    code: 'autoGenerationOwnershipLost',
  });
  const pending = harness.adapter.downloadVideo({
    url: 'https://example.com/candidate-owner-lost',
    cookieSource: 'none',
    validateOwnership: () => {
      if (!current) throw ownershipError;
    },
  });
  await vi.waitFor(() => expect(harness.start).toHaveBeenCalledTimes(1));
  current = false;
  harness.getHandlers().onCompleted({ media: candidate, subtitle: null });

  await expect(pending).rejects.toMatchObject({ code: 'autoGenerationOwnershipLost' });
  await vi.waitFor(() => {
    expect(harness.discardCandidate).toHaveBeenCalledExactlyOnceWith(harness.assetId);
  });
  expect(harness.describeMedia).not.toHaveBeenCalled();
});

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
  expect(setStatus).toHaveBeenCalledWith(expect.objectContaining({ type: 'info' }));
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
  const source = require('fs').readFileSync(__filename.replace('.test.js', '.js'), 'utf8');
  expect(source).not.toMatch(/\bfetch\s*\(/);
  expect(source).not.toMatch(/localhost:303\d/);
  expect(source).not.toMatch(/localStorage\s*\./);
  expect(source).not.toMatch(/\b(filePath|serverPath|videoPath|outputPath)\b/);
});
