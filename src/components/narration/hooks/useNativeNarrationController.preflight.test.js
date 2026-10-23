import { act, renderHook } from '@testing-library/react';

import {
  cancelNativeNarrationJob,
  runNativeNarrationJob,
} from '../../../platform/nativeNarrationFlow';
import {
  PROJECT_ID,
  checkpointMocks,
  engineMocks,
  projectMocks,
  resetNarrationControllerMocks,
  speechMocks,
  useHarness,
} from './useNativeNarrationControllerTestHarness';

vi.mock('../../../platform/desktopRuntime', () => ({ isDesktopRuntime: () => true }));
vi.mock('../../../platform/managedEngineService', () => ({ ensureManagedEngineReady: vi.fn() }));
vi.mock('../../../platform/durableLyricsCheckpoint', () => ({ flushDurableLyricsHistory: vi.fn() }));
vi.mock('../../../platform/nativeNarrationFlow', () => ({
  cancelNativeNarrationJob: vi.fn(),
  restorePersistedNativeNarration: vi.fn(async () => null),
  runNativeNarrationJob: vi.fn(),
}));
vi.mock('../../../platform/projectService', () => ({ getActiveProjectSnapshot: vi.fn() }));
vi.mock('../../../platform/projectNarrationStore', () => ({ saveProjectNarration: vi.fn() }));
vi.mock('../../../platform/credentialStateController', () => ({
  acquireGeminiCredential: vi.fn(),
  initializeCredentialState: vi.fn(async () => undefined),
}));
vi.mock('../../../platform/speechService', () => ({
  GEMINI_SPEECH_MODELS: ['gemini-3.1-flash-tts-preview'],
  getSpeechLifecycleSnapshot: vi.fn(),
}));

beforeEach(resetNarrationControllerMocks);

test('refuses generation before native start when there is no active durable project', async () => {
  projectMocks.getActiveProjectSnapshot.mockReturnValue(null);
  const { result } = renderHook(() => useHarness());

  await act(async () => result.current.controller.handleGTTSNarration());

  expect(runNativeNarrationJob).not.toHaveBeenCalled();
  expect(result.current.error).toContain('active subtitle project changed');
  expect(result.current.isGenerating).toBe(false);
});

test('refuses generation when pending subtitle edits cannot reach the durable checkpoint', async () => {
  checkpointMocks.flushDurableLyricsHistory.mockRejectedValue(new Error('sqlite write failed'));
  const { result } = renderHook(() => useHarness());

  await act(async () => result.current.controller.handleGTTSNarration());

  expect(runNativeNarrationJob).not.toHaveBeenCalled();
  expect(result.current.error).toContain('checkpoint could not be saved');
  expect(result.current.isGenerating).toBe(false);
});

test('captures the project revision produced by the subtitle checkpoint, not the stale pre-flush one', async () => {
  let project = {
    metadata: { id: PROJECT_ID, name: 'Narration test' },
    stateVersion: 7,
    media: [],
    tracks: [],
  };
  projectMocks.getActiveProjectSnapshot.mockImplementation(() => project);
  checkpointMocks.flushDurableLyricsHistory.mockImplementation(async () => {
    project = { ...project, stateVersion: 8 };
  });
  runNativeNarrationJob.mockResolvedValue({ status: 'completed', results: [] });
  const { result } = renderHook(() => useHarness());

  await act(async () => result.current.controller.handleGTTSNarration());

  expect(runNativeNarrationJob).toHaveBeenCalledWith(
    expect.objectContaining({
      projectId: PROJECT_ID,
      expectedProjectStateVersion: 8,
    }),
    expect.any(Object),
  );
});

test.each([
  [{ languageCode: 'ko' }, 'supports English and Chinese'],
  [{ languageCode: 'ja' }, 'supports English and Chinese'],
  [{ languageCode: 'en', secondaryLanguages: ['ko'], isMultiLanguage: true }, 'supports English and Chinese'],
  [{ languageCode: 'unknown' }, 'Detect or select'],
  [null, 'Detect or select'],
])('blocks unsupported or unknown F5 language descriptors at the generation boundary', async (
  originalLanguage,
  message,
) => {
  const { result } = renderHook(() => useHarness({ originalLanguage }));

  await act(async () => result.current.controller.handleGenerateNarration());

  expect(runNativeNarrationJob).not.toHaveBeenCalled();
  expect(result.current.error).toContain(message);
  expect(result.current.isGenerating).toBe(false);
});

test.each([
  ['handleGenerateNarration', 'f5tts'],
  ['handleChatterboxNarration', 'chatterbox'],
])('requires a native reference artifact at the %s generation boundary', async (handler) => {
  const { result } = renderHook(() => useHarness({
    referenceAudio: { url: 'blob:legacy-reference' },
  }));

  await act(async () => result.current.controller[handler]());

  expect(runNativeNarrationJob).not.toHaveBeenCalled();
  expect(result.current.error).toContain('reference audio');
});

test.each(['en', 'en-US', 'zh', 'zh-CN'])(
  'allows the managed F5 model for supported %s subtitles',
  async (languageCode) => {
    runNativeNarrationJob.mockResolvedValue({ status: 'completed', results: [] });
    const { result } = renderHook(() => useHarness({
      originalLanguage: { languageCode },
    }));

    await act(async () => result.current.controller.handleGenerateNarration());

    expect(runNativeNarrationJob).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'f5tts' }),
      expect.any(Object),
    );
  }
);

test('reports an actionable retry when on-demand preparation cannot warm the engine', async () => {
  speechMocks.getSpeechLifecycleSnapshot.mockReturnValue({
    epoch: 8,
    enabled: false,
    warm: false,
  });
  engineMocks.ensureManagedEngineReady.mockResolvedValueOnce({
    status: { epoch: 8, enabled: false, warm: false },
  });
  const { result } = renderHook(() => useHarness());

  await act(async () => result.current.controller.handleGTTSNarration());

  expect(runNativeNarrationJob).not.toHaveBeenCalled();
  expect(result.current.error).toContain('could not start');
  expect(result.current.isGenerating).toBe(false);
});

test('starts a cold installed engine on demand before generating', async () => {
  let lifecycle = { epoch: 8, enabled: false, warm: false };
  speechMocks.getSpeechLifecycleSnapshot.mockImplementation(() => lifecycle);
  engineMocks.ensureManagedEngineReady.mockImplementationOnce(async () => {
    lifecycle = { epoch: 9, enabled: true, warm: true };
    return { status: lifecycle, voices: [] };
  });
  runNativeNarrationJob.mockResolvedValue({ status: 'completed', results: [] });
  const { result } = renderHook(() => useHarness());

  await act(async () => result.current.controller.handleGTTSNarration());

  expect(engineMocks.ensureManagedEngineReady).toHaveBeenCalledWith('gtts', expect.objectContaining({
    signal: expect.any(AbortSignal),
    onProgress: expect.any(Function),
  }));
  expect(runNativeNarrationJob).toHaveBeenCalledWith(
    expect.objectContaining({ lifecycleEpoch: 9, method: 'gtts' }),
    expect.any(Object),
  );
});

test('cancels dependency preparation without locking or erroring the narration UI', async () => {
  engineMocks.ensureManagedEngineReady.mockImplementationOnce((_engine, { signal }) => (
    new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(
      new Error('cancelled'),
      { code: 'managedEnginePreparationCancelled' },
    )), { once: true }))
  ));
  const { result } = renderHook(() => useHarness());

  let generation;
  await act(async () => {
    generation = result.current.controller.handleGTTSNarration();
    await vi.waitFor(() => expect(engineMocks.ensureManagedEngineReady).toHaveBeenCalledTimes(1));
  });
  expect(result.current.isGenerating).toBe(true);
  await act(async () => {
    await expect(result.current.controller.cancelGTTSGeneration()).resolves.toBe(true);
    await expect(generation).resolves.toBe(true);
  });

  expect(cancelNativeNarrationJob).toHaveBeenCalledWith('gtts');
  expect(result.current.isGenerating).toBe(false);
  expect(result.current.error).toBe('');
  expect(result.current.generationStatus).toContain('cancelled');
});
