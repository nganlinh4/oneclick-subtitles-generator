// useSubtitles ownership: auto-run checkpoints, cache reads and full-media durable saves.
import { act, renderHook } from '@testing-library/react';
import useSubtitles from './useSubtitles';
import {
  createContext,
  media,
  mocks,
  optionsFor,
  resetUseSubtitlesMocks,
} from './useSubtitlesTestFixtures';

vi.mock('../services/geminiService', async () => (
  (await import('./useSubtitlesTestFixtures')).geminiServiceMock()
));
vi.mock('../utils/videoProcessor', async () => (
  (await import('./useSubtitlesTestFixtures')).videoProcessorMock()
));
vi.mock('../services/engines/GeminiAdapter', async () => (
  (await import('./useSubtitlesTestFixtures')).geminiAdapterMock()
));
vi.mock('../services/engines/AsrAdapter', async () => (
  (await import('./useSubtitlesTestFixtures')).asrAdapterMock()
));
vi.mock('../platform/managedEngineService', async () => (
  (await import('./useSubtitlesTestFixtures')).managedEngineServiceMock()
));
vi.mock('../services/subtitleCache', async () => (
  (await import('./useSubtitlesTestFixtures')).subtitleCacheMock()
));
vi.mock('./useSubtitlesCaching', async () => (
  (await import('./useSubtitlesTestFixtures')).subtitlesCachingMock()
));
vi.mock('./useNativeSubtitleHydration', async () => (
  (await import('./useSubtitlesTestFixtures')).nativeSubtitleHydrationMock()
));
vi.mock('./useQuotaCountdown', async () => (
  (await import('./useSubtitlesTestFixtures')).quotaCountdownMock()
));
vi.mock('./useSubtitlesRetryGeneration', async () => (
  (await import('./useSubtitlesTestFixtures')).subtitlesRetryGenerationMock()
));
vi.mock('./useSubtitlesSegmentRetry', async () => (
  (await import('./useSubtitlesTestFixtures')).subtitlesSegmentRetryMock()
));
vi.mock('../events/bus', async () => (
  (await import('./useSubtitlesTestFixtures')).eventBusMock()
));
vi.mock('../utils/geminiSubtitleErrors', async () => (
  (await import('./useSubtitlesTestFixtures')).geminiSubtitleErrorsMock()
));
vi.mock('../platform/desktopRuntime', async (importOriginal) => ({
  ...(await importOriginal()),
  isDesktopRuntime: () => true,
}));
vi.mock('../platform/activeNativeMedia', async () => (
  (await import('./useSubtitlesTestFixtures')).activeNativeMediaMock()
));
vi.mock('../platform/subtitleProjectStore', async () => (
  (await import('./useSubtitlesTestFixtures')).subtitleProjectStoreMock()
));
vi.mock('../platform/projectService', async (importOriginal) => ({
  ...(await importOriginal()),
  loadProject: vi.fn(async () => ({
    metadata: { id: 'project-1' },
    stateVersion: 7,
  })),
}));
vi.mock('../utils/transcriptionRulesStore', async () => (
  (await import('./useSubtitlesTestFixtures')).transcriptionRulesStoreMock()
));
vi.mock('../utils/userSubtitlesStore', async () => (
  (await import('./useSubtitlesTestFixtures')).userSubtitlesStoreMock()
));
vi.mock('../services/lifecycleOrchestrator', async () => (
  (await import('./useSubtitlesTestFixtures')).lifecycleOrchestratorMock()
));
vi.mock('../services/gemini/promptManagement', async () => (
  (await import('./useSubtitlesTestFixtures')).promptManagementMock()
));
vi.mock('../utils/autoGenerationOwnership', async () => (
  (await import('./useSubtitlesTestFixtures')).autoGenerationOwnershipMock()
));

beforeEach(resetUseSubtitlesMocks);

test('local ASR captures one range revision before inference and commits only that aggregate', async () => {
  const rows = [{ start: 0.25, end: 1.25, text: 'native window' }];
  mocks.processAsrSegment.mockImplementation(async (_engine, _input, segment, _options, hooks) => {
    await hooks.onMergeSegment(segment, rows);
  });
  const context = createContext();
  const { result } = renderHook(() => useSubtitles((_key, fallback) => fallback ?? _key));

  let terminal;
  await act(async () => {
    terminal = await result.current.generateSubtitles(
      media,
      'file-upload',
      { gemini: true },
      {
        ...optionsFor(context),
        method: 'nvidia-parakeet',
        segment: { start: 0, end: 4 },
        maxDurationPerRequest: 1,
      },
    );
  });

  expect(terminal).toBe(true);
  expect(mocks.ensureManagedEngineReady).toHaveBeenCalledWith(
    'nvidia-parakeet',
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(mocks.captureDurableSubtitleSegmentRevision).toHaveBeenCalledTimes(1);
  expect(mocks.captureDurableSubtitleSegmentRevision)
    .toHaveBeenCalledBefore(mocks.processAsrSegment);
  expect(mocks.commitDurableSubtitleSegmentCheckpoint).toHaveBeenCalledWith(
    expect.objectContaining({ replacement: rows }),
  );
  expect(mocks.commitDurableSubtitleSegmentCheckpoint)
    .toHaveBeenCalledAfter(mocks.processAsrSegment);
  expect(mocks.saveSubtitlesToCache).not.toHaveBeenCalled();
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

test('an in-flight cache read cannot publish project A rows after project B activates', async () => {
  const projectBRows = [{ id: 9, start: 0, end: 1, text: 'Project B' }];
  let releaseCacheRead;
  mocks.loadCachedSubtitlesIfAvailable.mockReturnValue(new Promise((resolve) => {
    releaseCacheRead = resolve;
  }));
  const { result } = renderHook(() => useSubtitles((_key, fallback) => fallback ?? _key));
  let terminal;

  await act(async () => {
    terminal = result.current.generateSubtitles(
      media,
      'file-upload',
      { gemini: true },
      {
        method: 'old',
        model: 'gemini-3.1-flash-lite',
        fps: 1,
        mediaResolution: 'low',
        generationScope: 'full-media',
      },
    );
    await vi.waitFor(() => expect(mocks.loadCachedSubtitlesIfAvailable).toHaveBeenCalled());
  });

  act(() => {
    mocks.activeCacheId = 'cache-2';
    result.current.setSubtitlesData(projectBRows);
  });
  await act(async () => {
    releaseCacheRead({
      cacheHit: true,
      cachedSubtitles: [{ id: 1, start: 0, end: 1, text: 'Stale project A' }],
    });
    await terminal;
  });

  await expect(terminal).resolves.toBe(false);
  expect(result.current.subtitlesData).toEqual(projectBRows);
  expect(mocks.processGeminiSegment).not.toHaveBeenCalled();
  expect(mocks.saveSubtitlesToCache).not.toHaveBeenCalled();
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

test('flushes an all-deleted editor track before checking the generation cache', async () => {
  const downloadedRows = [{ id: 1, start: 0, end: 2, text: 'downloaded subtitle' }];
  const generatedRows = [{ id: 2, start: 0, end: 2, text: 'fresh generation' }];
  let deletionDurable = false;
  mocks.checkpointBeforeUpdate.mockImplementation(async () => { deletionDurable = true; });
  mocks.loadCachedSubtitlesIfAvailable.mockImplementation(async () => (
    deletionDurable
      ? { cacheHit: false, cachedSubtitles: null }
      : { cacheHit: true, cachedSubtitles: downloadedRows }
  ));
  mocks.loadExactProjectSubtitles.mockResolvedValue([]);
  mocks.processGeminiSegment.mockResolvedValue(generatedRows);
  mocks.saveSubtitlesToCache.mockResolvedValue({
    success: true,
    cacheId: 'cache-1',
    projectId: 'project-1',
    subtitleCount: 1,
  });
  const { result } = renderHook(() => useSubtitles((_key, fallback) => fallback ?? _key));

  await act(async () => {
    await expect(result.current.generateSubtitles(
      media,
      'file-upload',
      { gemini: true },
      {
        method: 'old', model: 'gemini-3.1-flash-lite', fps: 1, mediaResolution: 'low',
      },
    )).resolves.toBe(true);
  });

  expect(mocks.checkpointBeforeUpdate).toHaveBeenCalledWith(expect.objectContaining({
    source: 'generation-start',
  }));
  expect(mocks.checkpointBeforeUpdate).toHaveBeenCalledBefore(
    mocks.loadCachedSubtitlesIfAvailable,
  );
  expect(mocks.processGeminiSegment).toHaveBeenCalledTimes(1);
  expect(result.current.subtitlesData).toEqual(generatedRows);
  expect(result.current.subtitlesData).not.toEqual(downloadedRows);
});

test('publishes native Gemini rows while they stream and rolls them back if the run fails', async () => {
  const baseline = [{ id: 1, start: 0, end: 2, text: 'durable baseline' }];
  const partial = [{ id: 2, start: 0, end: 1, text: 'streamed partial' }];
  mocks.loadExactProjectSubtitles.mockResolvedValue(baseline);
  let rejectProvider;
  mocks.processGeminiSegment.mockImplementation(async (_media, _segment, _options, hooks) => {
    hooks.onStreamingUpdate(partial, true);
    await new Promise((_resolve, reject) => { rejectProvider = reject; });
  });
  const { result } = renderHook(() => useSubtitles((_key, fallback) => fallback ?? _key));
  act(() => result.current.setSubtitlesData(baseline));
  let terminal;

  await act(async () => {
    terminal = result.current.generateSubtitles(
      media,
      'file-upload',
      { gemini: true },
      {
        method: 'old', model: 'gemini-3.1-flash-lite', fps: 1, mediaResolution: 'low',
      },
    );
  });
  await vi.waitFor(() => expect(result.current.subtitlesData).toEqual(partial));
  await act(async () => {
    rejectProvider(new Error('provider stopped'));
    await terminal;
  });

  await expect(terminal).resolves.toBe(false);
  expect(result.current.subtitlesData).toEqual(baseline);
  expect(mocks.saveSubtitlesToCache).not.toHaveBeenCalled();
});
