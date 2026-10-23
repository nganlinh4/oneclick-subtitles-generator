// useSubtitles segment merges, empty-output terminals and Gemini delivery acknowledgement.
import { act, renderHook } from '@testing-library/react';
import useSubtitles from './useSubtitles';
import { bindNativeGeminiTranscriptionDelivery } from '../services/gemini/transcriptionDelivery';
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

test('segment generation keeps the acknowledged timeline visible until merged rows are saved', async () => {
  const priorRows = [
    { id: 1, start: 0, end: 4, text: 'Before' },
    { id: 2, start: 5, end: 7, text: 'Replace me' },
    { id: 3, start: 9, end: 10, text: 'After' },
  ];
  const partialRows = [{ id: 4, start: 5, end: 6, text: 'Uncommitted partial' }];
  const replacementRows = [{ id: 5, start: 5, end: 8, text: 'Durable replacement' }];
  mocks.processGeminiSegment.mockImplementation(async (_media, _segment, _options, hooks) => {
    hooks.onStreamingUpdate(partialRows, true);
    return replacementRows;
  });
  let releaseSave;
  mocks.saveSubtitlesToCache.mockReturnValue(new Promise((resolve) => { releaseSave = resolve; }));
  const { result } = renderHook(() => useSubtitles((_key, fallback) => fallback ?? _key));
  mocks.loadExactProjectSubtitles.mockResolvedValue(priorRows);
  act(() => result.current.setSubtitlesData(priorRows));
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
        segment: { start: 5, end: 8 },
      },
    );
    await vi.waitFor(() => expect(mocks.saveSubtitlesToCache).toHaveBeenCalled());
  });

  expect(result.current.subtitlesData).toEqual([priorRows[0], partialRows[0], priorRows[2]]);
  const savedRows = mocks.saveSubtitlesToCache.mock.calls[0][1];
  expect(savedRows).toEqual([priorRows[0], replacementRows[0], priorRows[2]]);

  await act(async () => {
    releaseSave({
      success: true,
      cacheId: 'cache-1',
      projectId: 'project-1',
      subtitleCount: savedRows.length,
    });
    await terminal;
  });

  await expect(terminal).resolves.toBe(true);
  expect(result.current.subtitlesData).toEqual(savedRows);
});

test('a rejected segment checkpoint leaves the prior native timeline visible', async () => {
  const priorRows = [
    { id: 1, start: 0, end: 4, text: 'Keep before' },
    { id: 2, start: 5, end: 7, text: 'Keep original segment' },
  ];
  mocks.loadExactProjectSubtitles.mockResolvedValue(priorRows);
  mocks.processGeminiSegment.mockImplementation(async (_media, _segment, _options, hooks) => {
    hooks.onStreamingUpdate([{ id: 3, start: 5, end: 6, text: 'Discard partial' }], true);
    return [{ id: 4, start: 5, end: 8, text: 'Unsaved replacement' }];
  });
  mocks.saveSubtitlesToCache.mockResolvedValue({
    success: false,
    error: Object.assign(new Error('save failed'), { code: 'subtitleCacheSaveFailed' }),
  });
  const { result } = renderHook(() => useSubtitles((_key, fallback) => fallback ?? _key));
  act(() => result.current.setSubtitlesData(priorRows));

  await act(async () => {
    await expect(result.current.generateSubtitles(
      media,
      'file-upload',
      { gemini: true },
      {
        method: 'old',
        model: 'gemini-3.1-flash-lite',
        fps: 1,
        mediaResolution: 'low',
        segment: { start: 5, end: 8 },
      },
    )).resolves.toBe(false);
  });

  expect(result.current.subtitlesData).toEqual(priorRows);
  expect(result.current.status).toEqual({
    message: 'Subtitles were generated, but they could not be saved.',
    type: 'error',
  });
});

test('a project without a subtitle track uses an empty merge base for its first range', async () => {
  const firstRows = [{ id: 1, start: 5, end: 8, text: 'First generated cue' }];
  mocks.loadExactProjectSubtitles.mockResolvedValue(null);
  mocks.processGeminiSegment.mockResolvedValue(firstRows);
  mocks.saveSubtitlesToCache.mockResolvedValue({
    success: true,
    cacheId: 'cache-1',
    projectId: 'project-1',
    subtitleCount: firstRows.length,
  });
  const { result } = renderHook(() => useSubtitles((_key, fallback) => fallback ?? _key));

  await act(async () => {
    await expect(result.current.generateSubtitles(
      media,
      'file-upload',
      { gemini: true },
      {
        method: 'old',
        model: 'gemini-3.1-flash-lite',
        fps: 1,
        mediaResolution: 'low',
        segment: { start: 5, end: 8 },
      },
    )).resolves.toBe(true);
  });

  expect(mocks.processGeminiSegment).toHaveBeenCalledTimes(1);
  expect(mocks.saveSubtitlesToCache).toHaveBeenCalledWith('cache-1', firstRows, {
    expectedProjectId: 'project-1',
  });
  expect(result.current.subtitlesData).toEqual(firstRows);
});

test('segment generation refuses a malformed native merge base before provider work', async () => {
  mocks.loadExactProjectSubtitles.mockResolvedValue({ rows: [] });
  const { result } = renderHook(() => useSubtitles((_key, fallback) => fallback ?? _key));

  await act(async () => {
    await expect(result.current.generateSubtitles(
      media,
      'file-upload',
      { gemini: true },
      {
        method: 'old',
        model: 'gemini-3.1-flash-lite',
        fps: 1,
        mediaResolution: 'low',
        segment: { start: 5, end: 8 },
      },
    )).resolves.toBe(false);
  });

  expect(mocks.processGeminiSegment).not.toHaveBeenCalled();
  expect(mocks.saveSubtitlesToCache).not.toHaveBeenCalled();
  expect(result.current.status).toEqual({
    message: 'Error: The native subtitle project returned an invalid track.',
    type: 'error',
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
