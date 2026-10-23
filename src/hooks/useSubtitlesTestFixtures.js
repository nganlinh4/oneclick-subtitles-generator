// Shared mocks, media and auto-run context for the useSubtitles ownership test files. It imports
// no product module, so vi.mock factories can load it without a cycle through the mocked modules.
import { vi } from 'vitest';

export const mocks = {
  processGeminiSegment: vi.fn(),
  processAsrSegment: vi.fn(),
  ensureManagedEngineReady: vi.fn(),
  saveSubtitlesToCache: vi.fn(),
  commitDurableSubtitleCheckpoint: vi.fn(),
  captureDurableSubtitleSegmentRevision: vi.fn(),
  commitDurableSubtitleSegmentCheckpoint: vi.fn(),
  publishStreamingComplete: vi.fn(),
  checkpointBeforeUpdate: vi.fn(),
  loadExactProjectSubtitles: vi.fn(),
  loadCachedSubtitlesIfAvailable: vi.fn(),
  assertCurrent: vi.fn(),
  assertDurable: vi.fn(),
  refreshActiveMedia: vi.fn(),
  resolveActiveMedia: vi.fn(),
  activeCacheId: 'cache-1',
  cacheCandidate: { cacheHit: false, subtitles: null },
  emptySpeechPolicy: 'provenSilence',
};

export const geminiServiceMock = () => ({
  callGeminiApi: vi.fn(),
  setProcessingForceStopped: vi.fn(),
});

export const videoProcessorMock = () => ({ getVideoDuration: vi.fn(async () => 12) });

export const geminiAdapterMock = () => ({
  processGeminiSegment: mocks.processGeminiSegment,
});

export const asrAdapterMock = () => ({
  processAsrSegment: mocks.processAsrSegment,
});

export const managedEngineServiceMock = () => ({
  ensureManagedEngineReady: mocks.ensureManagedEngineReady,
});

export const subtitleCacheMock = () => ({
  saveSubtitlesToCache: mocks.saveSubtitlesToCache,
  commitDurableSubtitleCheckpoint: mocks.commitDurableSubtitleCheckpoint,
  captureDurableSubtitleSegmentRevision: mocks.captureDurableSubtitleSegmentRevision,
  commitDurableSubtitleSegmentCheckpoint: mocks.commitDurableSubtitleSegmentCheckpoint,
  isSuccessfulSubtitleCacheSaveReceipt: vi.fn((result) => (
    result?.success === true
    && typeof result.cacheId === 'string'
    && typeof result.projectId === 'string'
    && Number.isSafeInteger(result.subtitleCount)
  )),
  isDurableSubtitleCheckpointReceipt: vi.fn((result, context) => (
    ['durable-subtitle-checkpoint', 'durable-subtitle-segment-checkpoint'].includes(result?.kind)
    && result.runId === context?.runId
    && result.cacheId === context?.cacheId
    && result.projectId === context?.projectId
  )),
  requireSuccessfulSubtitleCacheSave: vi.fn((result) => {
    if (result?.success !== true) throw result?.error ?? new Error('save failed');
  }),
});

export const subtitlesCachingMock = () => ({
  resolveCacheIdForGeneration: vi.fn(async () => 'cache-1'),
  loadCachedSubtitlesIfAvailable: mocks.loadCachedSubtitlesIfAvailable,
});

export const nativeSubtitleHydrationMock = () => ({ useNativeSubtitleHydration: vi.fn() });

export const quotaCountdownMock = () => ({
  useQuotaCountdown: () => ({ startQuotaCountdown: vi.fn() }),
});

export const subtitlesRetryGenerationMock = () => ({
  useSubtitlesRetryGeneration: () => ({ retryGeneration: vi.fn() }),
});

export const subtitlesSegmentRetryMock = () => ({
  useSubtitlesSegmentRetry: () => ({ retrySegment: vi.fn() }),
});

export const eventBusMock = () => ({
  EVENTS: { SEGMENT_STATUS_UPDATE: 'segment-status-update' },
  publishStreamingComplete: mocks.publishStreamingComplete,
  subscribe: () => () => undefined,
});

export const geminiSubtitleErrorsMock = () => ({
  reportKnownGeminiSubtitleError: () => false,
});

export const activeNativeMediaMock = () => ({
  refreshActiveNativeMedia: mocks.refreshActiveMedia,
  resolveActiveNativeMedia: mocks.resolveActiveMedia,
});

export const subtitleProjectStoreMock = () => ({
  resolveProjectForCache: vi.fn(async () => ({
    projectId: 'project-1',
    snapshot: { metadata: { id: 'project-1' }, stateVersion: 7 },
  })),
  loadExactProjectSubtitles: mocks.loadExactProjectSubtitles,
});

export const transcriptionRulesStoreMock = () => ({
  getCurrentCacheId: vi.fn(() => mocks.activeCacheId),
});

export const userSubtitlesStoreMock = () => ({
  getCurrentCacheId: vi.fn(() => mocks.activeCacheId),
});

export const lifecycleOrchestratorMock = () => ({
  checkpointBeforeUpdate: mocks.checkpointBeforeUpdate,
  autoSaveAfterStreaming: vi.fn(),
});

export const promptManagementMock = () => ({
  getEmptySpeechPolicy: vi.fn(() => mocks.emptySpeechPolicy),
});

export const autoGenerationOwnershipMock = () => ({
  isAutoGenerationContext: vi.fn((value) => value?.kind === 'auto-generation-context'),
  assertAutoGenerationContextCurrent: mocks.assertCurrent,
  assertAutoGenerationContextDurable: mocks.assertDurable,
  getAutoGenerationCacheCandidate: vi.fn(() => mocks.cacheCandidate),
  createAutoGenerationCompletion: vi.fn(({
    context,
    terminal,
    checkpoint,
  }) => Object.freeze({
    kind: 'auto-generation-completion',
    runId: context.runId,
    terminal,
    subtitleCount: checkpoint.subtitleCount,
    projectId: checkpoint.projectId,
    cacheId: checkpoint.cacheId,
  })),
});

export const media = Object.freeze({
  __nativeMedia: true,
  assetId: 'asset-1',
  name: 'source.mp4',
  type: 'video/mp4',
  size: 4096,
});

export const createContext = () => ({
  kind: 'auto-generation-context',
  runId: 'run-1',
  media,
  cacheId: 'cache-1',
  projectId: 'project-1',
  sourceIdentity: 'asset:asset-1',
  signal: new AbortController().signal,
  current: true,
});

export const optionsFor = (context) => ({
  method: 'old',
  model: 'gemini-3.1-flash-lite',
  fps: 1,
  mediaResolution: 'low',
  generationScope: 'full-media',
  autoRunContext: context,
  signal: context.signal,
  promptContext: { presetId: 'general', settingsPrompt: '' },
});

export const resetUseSubtitlesMocks = () => {
  vi.clearAllMocks();
  mocks.emptySpeechPolicy = 'provenSilence';
  mocks.activeCacheId = 'cache-1';
  mocks.cacheCandidate = { cacheHit: false, subtitles: null };
  mocks.assertCurrent.mockImplementation((context) => {
    if (context.current !== true) throw new Error('ownership lost');
    return context;
  });
  mocks.assertDurable.mockImplementation(async (context) => {
    if (context.current !== true) throw new Error('ownership lost');
    return context;
  });
  mocks.checkpointBeforeUpdate.mockResolvedValue(undefined);
  mocks.loadExactProjectSubtitles.mockResolvedValue([]);
  const capability = Object.freeze({
    projectId: 'project-1',
    stateVersion: 7,
    cacheId: 'cache-1',
    assetId: 'asset-1',
    media,
  });
  mocks.resolveActiveMedia.mockResolvedValue(capability);
  mocks.refreshActiveMedia.mockResolvedValue(capability);
  mocks.loadCachedSubtitlesIfAvailable.mockResolvedValue({
    cacheHit: false,
    cachedSubtitles: null,
  });
  mocks.commitDurableSubtitleCheckpoint.mockImplementation(async ({
    context,
    subtitles,
    validateOwnership,
  }) => {
    await validateOwnership(context);
    const saved = await mocks.saveSubtitlesToCache(context.cacheId, subtitles, {
      expectedProjectId: context.projectId,
    });
    if (saved?.success !== true) throw saved?.error ?? new Error('save failed');
    await validateOwnership(context);
    return {
      kind: 'durable-subtitle-checkpoint',
      runId: context.runId,
      cacheId: saved.cacheId,
      projectId: saved.projectId,
      subtitleCount: saved.subtitleCount,
    };
  });
  mocks.captureDurableSubtitleSegmentRevision.mockResolvedValue(Object.freeze({
    kind: 'subtitle-segment-revision',
  }));
  mocks.commitDurableSubtitleSegmentCheckpoint.mockImplementation(async ({
    context,
    replacement,
    validateOwnership,
  }) => {
    await validateOwnership(context);
    return {
      kind: 'durable-subtitle-segment-checkpoint',
      runId: context.runId,
      cacheId: context.cacheId,
      projectId: context.projectId,
      subtitleCount: replacement.length,
      subtitles: replacement,
      stateVersion: 8,
    };
  });
  localStorage.clear();
};
