// Candidate claim: project admission, publication, rollback and discard of downloaded candidates.

import { rollbackSubtitleProjectBinding } from './subtitleProjectBinding';

import {
  candidateProject,
  createHarness,
  flush,
  mediaCandidate,
  publicationSpy,
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
    'https://example.com/candidate-publication',
    { create: true }
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
