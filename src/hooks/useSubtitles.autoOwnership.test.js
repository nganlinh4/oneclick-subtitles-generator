import { act, renderHook } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  processGeminiSegment: vi.fn(),
  saveSubtitlesToCache: vi.fn(),
  commitDurableSubtitleCheckpoint: vi.fn(),
  publishStreamingComplete: vi.fn(),
  checkpointBeforeUpdate: vi.fn(),
  loadCachedSubtitlesIfAvailable: vi.fn(),
  assertCurrent: vi.fn(),
  assertDurable: vi.fn(),
  refreshActiveMedia: vi.fn(),
  resolveActiveMedia: vi.fn(),
  cacheCandidate: { cacheHit: false, subtitles: null },
  emptySpeechPolicy: 'provenSilence',
}));

vi.mock('../services/geminiService', () => ({
  callGeminiApi: vi.fn(),
  setProcessingForceStopped: vi.fn(),
}));
vi.mock('../utils/videoProcessor', () => ({ getVideoDuration: vi.fn(async () => 12) }));
vi.mock('../services/engines/GeminiAdapter', () => ({
  processGeminiSegment: mocks.processGeminiSegment,
}));
vi.mock('../services/subtitleCache', () => ({
  saveSubtitlesToCache: mocks.saveSubtitlesToCache,
  commitDurableSubtitleCheckpoint: mocks.commitDurableSubtitleCheckpoint,
  isSuccessfulSubtitleCacheSaveReceipt: vi.fn((result) => (
    result?.success === true
    && typeof result.cacheId === 'string'
    && typeof result.projectId === 'string'
    && Number.isSafeInteger(result.subtitleCount)
  )),
  isDurableSubtitleCheckpointReceipt: vi.fn((result, context) => (
    result?.kind === 'durable-subtitle-checkpoint'
    && result.runId === context?.runId
    && result.cacheId === context?.cacheId
    && result.projectId === context?.projectId
  )),
  requireSuccessfulSubtitleCacheSave: vi.fn((result) => {
    if (result?.success !== true) throw result?.error ?? new Error('save failed');
  }),
}));
vi.mock('./useSubtitlesCaching', () => ({
  resolveCacheIdForGeneration: vi.fn(async () => 'cache-1'),
  loadCachedSubtitlesIfAvailable: mocks.loadCachedSubtitlesIfAvailable,
}));
vi.mock('./useNativeSubtitleHydration', () => ({ useNativeSubtitleHydration: vi.fn() }));
vi.mock('./useQuotaCountdown', () => ({
  useQuotaCountdown: () => ({ startQuotaCountdown: vi.fn() }),
}));
vi.mock('./useSubtitlesRetryGeneration', () => ({
  useSubtitlesRetryGeneration: () => ({ retryGeneration: vi.fn() }),
}));
vi.mock('./useSubtitlesSegmentRetry', () => ({
  useSubtitlesSegmentRetry: () => ({ retrySegment: vi.fn() }),
}));
vi.mock('../events/bus', () => ({
  EVENTS: { SEGMENT_STATUS_UPDATE: 'segment-status-update' },
  publishStreamingComplete: mocks.publishStreamingComplete,
  subscribe: () => () => undefined,
}));
vi.mock('../utils/geminiSubtitleErrors', () => ({
  reportKnownGeminiSubtitleError: () => false,
}));
vi.mock('../platform/desktopRuntime', async (importOriginal) => ({
  ...(await importOriginal()),
  isDesktopRuntime: () => true,
}));
vi.mock('../platform/activeNativeMedia', () => ({
  refreshActiveNativeMedia: mocks.refreshActiveMedia,
  resolveActiveNativeMedia: mocks.resolveActiveMedia,
}));
vi.mock('../platform/subtitleProjectStore', () => ({
  resolveProjectForCache: vi.fn(async () => ({
    projectId: 'project-1',
    snapshot: { metadata: { id: 'project-1' }, stateVersion: 7 },
  })),
  loadExactProjectSubtitles: vi.fn(async () => []),
}));
vi.mock('../platform/projectService', async (importOriginal) => ({
  ...(await importOriginal()),
  loadProject: vi.fn(async () => ({
    metadata: { id: 'project-1' },
    stateVersion: 7,
  })),
}));
vi.mock('../utils/transcriptionRulesStore', () => ({
  getCurrentCacheId: vi.fn(() => 'cache-1'),
}));
vi.mock('../utils/userSubtitlesStore', () => ({
  getCurrentCacheId: vi.fn(() => 'cache-1'),
}));
vi.mock('../services/lifecycleOrchestrator', () => ({
  checkpointBeforeUpdate: mocks.checkpointBeforeUpdate,
  autoSaveAfterStreaming: vi.fn(),
}));
vi.mock('../services/gemini/promptManagement', () => ({
  getEmptySpeechPolicy: vi.fn(() => mocks.emptySpeechPolicy),
}));
vi.mock('../utils/autoGenerationOwnership', () => ({
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
}));

import useSubtitles from './useSubtitles';
import { bindNativeGeminiTranscriptionDelivery } from '../services/gemini/transcriptionDelivery';

const media = Object.freeze({
  __nativeMedia: true,
  assetId: 'asset-1',
  name: 'source.mp4',
  type: 'video/mp4',
  size: 4096,
});

const createContext = () => ({
  kind: 'auto-generation-context',
  runId: 'run-1',
  media,
  cacheId: 'cache-1',
  projectId: 'project-1',
  sourceIdentity: 'asset:asset-1',
  signal: new AbortController().signal,
  current: true,
});

const optionsFor = (context) => ({
  method: 'old',
  model: 'gemini-3.1-flash-lite',
  fps: 1,
  mediaResolution: 'low',
  generationScope: 'full-media',
  autoRunContext: context,
  signal: context.signal,
  promptContext: { presetId: 'general', settingsPrompt: '' },
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.emptySpeechPolicy = 'provenSilence';
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
  localStorage.clear();
});

test('does not return success until the same-run subtitle checkpoint is durable', async () => {
  const rows = [{ id: 1, start: 0, end: 1, text: 'Hello' }];
  mocks.processGeminiSegment.mockResolvedValue(rows);
  let releaseSave;
  mocks.saveSubtitlesToCache.mockReturnValue(new Promise((resolve) => { releaseSave = resolve; }));
  const context = createContext();
  const { result } = renderHook(() => useSubtitles((_key, fallback) => fallback ?? _key));
  let terminal;
  let settled = false;

  await act(async () => {
    terminal = result.current.generateSubtitles(
      media,
      'file-upload',
      { gemini: true },
      optionsFor(context)
    );
    terminal.finally(() => { settled = true; });
    await vi.waitFor(() => expect(mocks.saveSubtitlesToCache).toHaveBeenCalled());
  });
  expect(settled).toBe(false);
  expect(mocks.publishStreamingComplete).not.toHaveBeenCalled();
  expect(mocks.processGeminiSegment).toHaveBeenCalledAfter(mocks.assertDurable);
  expect(mocks.processGeminiSegment.mock.calls[0][2]).toEqual(expect.objectContaining({
    projectId: 'project-1',
    expectedProjectStateVersion: 7,
  }));

  await act(async () => {
    releaseSave({
      success: true,
      cacheId: 'cache-1',
      projectId: 'project-1',
      subtitleCount: 1,
    });
    await terminal;
  });
  await expect(terminal).resolves.toEqual({
    kind: 'auto-generation-completion',
    runId: 'run-1',
    terminal: 'subtitles',
    subtitleCount: 1,
    projectId: 'project-1',
    cacheId: 'cache-1',
  });
  const saveOrder = mocks.saveSubtitlesToCache.mock.invocationCallOrder[0];
  expect(Math.max(...mocks.assertDurable.mock.invocationCallOrder)).toBeGreaterThan(saveOrder);
  expect(mocks.commitDurableSubtitleCheckpoint).toHaveBeenCalledTimes(1);
  expect(mocks.saveSubtitlesToCache).toHaveBeenCalledTimes(1);
  expect(mocks.saveSubtitlesToCache).toHaveBeenCalledWith('cache-1', rows, {
    expectedProjectId: 'project-1',
  });
  expect(mocks.publishStreamingComplete).toHaveBeenCalledTimes(1);
});

test('a rejected automatic checkpoint publishes no success or completion terminal', async () => {
  const rows = [{ id: 1, start: 0, end: 1, text: 'Unsaved' }];
  mocks.processGeminiSegment.mockResolvedValue(rows);
  mocks.saveSubtitlesToCache.mockResolvedValue({
    success: false,
    error: Object.assign(new Error('save failed'), { code: 'subtitleCacheSaveFailed' }),
  });
  const context = createContext();
  const { result } = renderHook(() => useSubtitles((_key, fallback) => fallback ?? _key));

  let terminal;
  await act(async () => {
    terminal = await result.current.generateSubtitles(
      media,
      'file-upload',
      { gemini: true },
      optionsFor(context)
    );
  });

  expect(terminal).toBe(false);
  expect(result.current.status.type).not.toBe('success');
  expect(mocks.publishStreamingComplete).not.toHaveBeenCalled();
});

test('a cached automatic result stays nonterminal until its renewed durable receipt', async () => {
  const rows = [{ id: 1, start: 0, end: 1, text: 'Cached' }];
  mocks.cacheCandidate = {
    cacheHit: true,
    cachedSubtitles: rows,
    subtitles: rows,
  };
  let releaseSave;
  mocks.saveSubtitlesToCache.mockReturnValue(new Promise((resolve) => { releaseSave = resolve; }));
  const context = createContext();
  const { result } = renderHook(() => useSubtitles((_key, fallback) => fallback ?? _key));
  let terminal;

  await act(async () => {
    terminal = result.current.generateSubtitles(
      media,
      'file-upload',
      { gemini: true },
      optionsFor(context)
    );
    await vi.waitFor(() => expect(mocks.saveSubtitlesToCache).toHaveBeenCalled());
  });
  expect(result.current.status.type).not.toBe('success');
  expect(mocks.publishStreamingComplete).not.toHaveBeenCalled();

  await act(async () => {
    releaseSave({
      success: true,
      cacheId: 'cache-1',
      projectId: 'project-1',
      subtitleCount: 1,
    });
    await terminal;
  });
  await expect(terminal).resolves.toMatchObject({ terminal: 'subtitles', subtitleCount: 1 });
  expect(result.current.status).toMatchObject({ type: 'success' });
  expect(result.current.subtitlesData).toEqual(rows);
  expect(mocks.publishStreamingComplete).not.toHaveBeenCalled();
  expect(mocks.loadCachedSubtitlesIfAvailable).not.toHaveBeenCalled();
});

test('a rejected cached checkpoint never publishes its private preparation candidate', async () => {
  const rows = [{ id: 1, start: 0, end: 1, text: 'Never publish' }];
  mocks.cacheCandidate = { cacheHit: true, subtitles: rows };
  mocks.commitDurableSubtitleCheckpoint.mockRejectedValueOnce(Object.assign(
    new Error('save failed'),
    { code: 'subtitleCacheSaveFailed' },
  ));
  const context = createContext();
  const { result } = renderHook(() => useSubtitles((_key, fallback) => fallback ?? _key));

  let terminal;
  await act(async () => {
    terminal = await result.current.generateSubtitles(
      media,
      'file-upload',
      { gemini: true },
      optionsFor(context)
    );
  });

  expect(terminal).toBe(false);
  expect(result.current.subtitlesData).toBeNull();
  expect(result.current.status.type).not.toBe('success');
  expect(mocks.publishStreamingComplete).not.toHaveBeenCalled();
  expect(mocks.processGeminiSegment).not.toHaveBeenCalled();
});

test('uses one exact-project save for non-auto full-media generation', async () => {
  const rows = [{ id: 1, start: 0, end: 1, text: 'Manual' }];
  mocks.processGeminiSegment.mockResolvedValue(rows);
  mocks.saveSubtitlesToCache.mockResolvedValue({
    success: true,
    cacheId: 'cache-1',
    projectId: 'project-1',
    subtitleCount: 1,
  });
  const { result } = renderHook(() => useSubtitles((_key, fallback) => fallback ?? _key));

  let terminal;
  await act(async () => {
    terminal = await result.current.generateSubtitles(
      media,
      'file-upload',
      { gemini: true },
      {
        method: 'old',
        model: 'gemini-3.1-flash-lite',
        fps: 1,
        mediaResolution: 'low',
        generationScope: 'full-media',
      }
    );
  });

  expect(terminal).toBe(true);
  expect(mocks.commitDurableSubtitleCheckpoint).not.toHaveBeenCalled();
  expect(mocks.saveSubtitlesToCache).toHaveBeenCalledExactlyOnceWith('cache-1', rows, {
    expectedProjectId: 'project-1',
  });
});

test('accepts empty output only as an explicit speech-only no-speech terminal', async () => {
  mocks.processGeminiSegment.mockResolvedValue([]);
  mocks.saveSubtitlesToCache.mockResolvedValue({
    success: true,
    cacheId: 'cache-1',
    projectId: 'project-1',
    subtitleCount: 0,
  });
  const context = createContext();
  const { result } = renderHook(() => useSubtitles((_key, fallback) => fallback ?? _key));

  let terminal;
  await act(async () => {
    terminal = await result.current.generateSubtitles(
      media,
      'file-upload',
      { gemini: true },
      optionsFor(context)
    );
  });

  expect(terminal).toMatchObject({ terminal: 'no-speech', subtitleCount: 0 });
  expect(mocks.saveSubtitlesToCache).toHaveBeenCalledWith('cache-1', [], {
    expectedProjectId: 'project-1',
  });
});

test('rejects an empty all-purpose result and never creates a false durable success', async () => {
  mocks.emptySpeechPolicy = undefined;
  mocks.processGeminiSegment.mockResolvedValue([]);
  const context = createContext();
  const { result } = renderHook(() => useSubtitles((_key, fallback) => fallback ?? _key));

  let terminal;
  await act(async () => {
    terminal = await result.current.generateSubtitles(
      media,
      'file-upload',
      { gemini: true },
      optionsFor(context)
    );
  });

  expect(terminal).toBe(false);
  expect(mocks.saveSubtitlesToCache).not.toHaveBeenCalled();
});

test('discards a project switch after Gemini and before the durable checkpoint', async () => {
  mocks.processGeminiSegment.mockImplementation(async () => {
    context.current = false;
    return [{ id: 1, start: 0, end: 1, text: 'Stale' }];
  });
  const context = createContext();
  const { result } = renderHook(() => useSubtitles((_key, fallback) => fallback ?? _key));

  let terminal;
  await act(async () => {
    terminal = await result.current.generateSubtitles(
      media,
      'file-upload',
      { gemini: true },
      optionsFor(context)
    );
  });

  expect(terminal).toBe(false);
  expect(mocks.saveSubtitlesToCache).not.toHaveBeenCalled();
});

test('acknowledges the exact provider delivery only after the merged project checkpoint', async () => {
  const order = [];
  const acknowledge = vi.fn(async () => order.push('ack'));
  const rows = bindNativeGeminiTranscriptionDelivery(
    [{ id: 1, start: 0, end: 1, text: 'Durable' }],
    { job: { id: 'job-1' }, deliveryId: 'delivery-1', acknowledge }
  );
  mocks.processGeminiSegment.mockResolvedValue(rows);
  mocks.saveSubtitlesToCache.mockImplementationOnce(async () => {
    order.push('save');
    return {
      success: true,
      cacheId: 'cache-1',
      projectId: 'project-1',
      subtitleCount: 1,
    };
  });
  const context = createContext();
  const { result } = renderHook(() => useSubtitles((_key, fallback) => fallback ?? _key));

  await act(async () => {
    await expect(result.current.generateSubtitles(
      media,
      'file-upload',
      { gemini: true },
      optionsFor(context)
    )).resolves.toMatchObject({ terminal: 'subtitles' });
  });

  expect(order).toEqual(['save', 'ack']);
  expect(acknowledge).toHaveBeenCalledTimes(1);
});

test('a project switch after provider completion retains the delivery and never acknowledges it', async () => {
  const acknowledge = vi.fn();
  const context = createContext();
  mocks.processGeminiSegment.mockImplementationOnce(async () => {
    context.current = false;
    return bindNativeGeminiTranscriptionDelivery(
      [{ id: 1, start: 0, end: 1, text: 'Stale' }],
      { job: { id: 'job-stale' }, deliveryId: 'delivery-stale', acknowledge }
    );
  });
  const { result } = renderHook(() => useSubtitles((_key, fallback) => fallback ?? _key));

  await act(async () => {
    await expect(result.current.generateSubtitles(
      media,
      'file-upload',
      { gemini: true },
      optionsFor(context)
    )).resolves.toBe(false);
  });

  expect(mocks.saveSubtitlesToCache).not.toHaveBeenCalled();
  expect(acknowledge).not.toHaveBeenCalled();
});
