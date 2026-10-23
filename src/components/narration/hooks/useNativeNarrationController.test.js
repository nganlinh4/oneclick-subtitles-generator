import { act, renderHook } from '@testing-library/react';

import { runNativeNarrationJob } from '../../../platform/nativeNarrationFlow';
import {
  commitNativeNarrationEdit,
  commitNativeNarrationEdits,
} from '../../../platform/nativeNarrationEditCommit';
import {
  ARTIFACT_ID,
  PROJECT_ID,
  REFERENCE_ID,
  credentialMocks,
  editedResult,
  narrationStoreMocks,
  originalEditedResult,
  resetNarrationControllerMocks,
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

test('publishes a narration edit only after the exact project record is durable', async () => {
  let finishSave;
  narrationStoreMocks.saveProjectNarration.mockImplementation(() => (
    new Promise((resolve) => { finishSave = resolve; })
  ));
  const { result } = renderHook(() => useHarness({
    initialGenerationResults: [originalEditedResult],
  }));

  let editCommit;
  await act(async () => {
    editCommit = commitNativeNarrationEdit(originalEditedResult, editedResult);
    await vi.waitFor(() => expect(finishSave).toBeTypeOf('function'));
  });
  expect(result.current.generationResults).toEqual([originalEditedResult]);
  expect(narrationStoreMocks.saveProjectNarration).toHaveBeenCalledWith({
    projectId: PROJECT_ID,
    expectedProjectStateVersion: 7,
    source: 'original',
    results: [editedResult],
    method: 'gtts',
  });

  await act(async () => {
    finishSave({ projectId: PROJECT_ID, projectStateVersion: 7 });
    await expect(editCommit).resolves.toBe(editedResult);
  });
  expect(result.current.generationResults).toEqual([editedResult]);
});

test('keeps the prior narration visible when an edit cannot be saved', async () => {
  narrationStoreMocks.saveProjectNarration.mockRejectedValue(new Error('sqlite unavailable'));
  const { result } = renderHook(() => useHarness({
    initialGenerationResults: [originalEditedResult],
  }));

  await act(async () => {
    await expect(commitNativeNarrationEdit(originalEditedResult, editedResult))
      .rejects.toThrow('sqlite unavailable');
  });

  expect(result.current.generationResults).toEqual([originalEditedResult]);
});

test('commits a multi-clip edit with one project write and one UI publication', async () => {
  const secondId = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a5';
  const secondEditedId = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a6';
  const second = {
    ...originalEditedResult,
    subtitle_id: 2,
    nativeArtifactId: secondId,
    filename: `osg-speech-artifact:${secondId}`,
  };
  const secondEdited = {
    ...second,
    nativeArtifactId: secondEditedId,
    filename: `osg-speech-artifact:${secondEditedId}`,
  };
  const { result } = renderHook(() => useHarness({
    initialGenerationResults: [originalEditedResult, second],
  }));

  await act(async () => {
    await expect(commitNativeNarrationEdits([
      { previous: originalEditedResult, replacement: editedResult },
      { previous: second, replacement: secondEdited },
    ])).resolves.toEqual([editedResult, secondEdited]);
  });

  expect(narrationStoreMocks.saveProjectNarration).toHaveBeenCalledTimes(1);
  expect(narrationStoreMocks.saveProjectNarration).toHaveBeenCalledWith(expect.objectContaining({
    results: [editedResult, secondEdited],
  }));
  expect(result.current.generationResults).toEqual([editedResult, secondEdited]);
});

test('routes all five narration engines through the native job contract', async () => {
  runNativeNarrationJob.mockImplementation(async (request) => ({
    status: 'completed',
    results: [{
      subtitle_id: 1,
      text: 'hello',
      success: true,
      pending: false,
      nativeArtifactId: ARTIFACT_ID,
      nativeFormat: 'wav',
      durationMicros: 1_000_000,
      filename: `osg-speech-artifact:${ARTIFACT_ID}`,
      original_ids: [1],
      outputIndex: 1,
      start: 0,
      end: 1,
      method: request.method,
    }],
  }));
  const { result } = renderHook(() => useHarness());

  const handlers = [
    'handleGenerateNarration',
    'handleChatterboxNarration',
    'handleEdgeTTSNarration',
    'handleGTTSNarration',
    'handleGeminiNarration',
  ];
  for (const handler of handlers) {
    await act(async () => result.current.controller[handler]());
  }

  expect(runNativeNarrationJob.mock.calls.map(([request]) => request.method)).toEqual([
    'f5tts',
    'chatterbox',
    'edge-tts',
    'gtts',
    'gemini',
  ]);
  expect(runNativeNarrationJob.mock.calls.map(([request]) => request.lifecycleEpoch))
    .toEqual([7, 7, 7, 7, 7]);
  expect(runNativeNarrationJob.mock.calls.map(([request]) => request.projectId))
    .toEqual([PROJECT_ID, PROJECT_ID, PROJECT_ID, PROJECT_ID, PROJECT_ID]);
  expect(runNativeNarrationJob.mock.calls.map(([request]) => request.expectedProjectStateVersion))
    .toEqual([7, 7, 7, 7, 7]);
  expect(runNativeNarrationJob.mock.calls[0][0]).toMatchObject({
    reference: { nativeArtifactId: REFERENCE_ID },
    settings: { modelId: 'f5tts-v1-base', language: 'en' },
  });
  expect(runNativeNarrationJob.mock.calls[4][0]).toMatchObject({
    reference: null,
    settings: {
      credentialIds: ['018f4c22-f0f1-7c09-a4d5-120d7b6f84aa'],
      model: 'gemini-3.1-flash-tts-preview',
      maxConcurrency: 5,
    },
  });
  expect(result.current.generationResults).toEqual([
    expect.objectContaining({
      nativeArtifactId: ARTIFACT_ID,
      filename: `osg-speech-artifact:${ARTIFACT_ID}`,
    }),
  ]);
  expect(narrationStoreMocks.saveProjectNarration).toHaveBeenCalledTimes(5);
  expect(narrationStoreMocks.saveProjectNarration).toHaveBeenLastCalledWith({
    projectId: PROJECT_ID,
    expectedProjectStateVersion: 7,
    source: 'original',
    results: [expect.objectContaining({ nativeArtifactId: ARTIFACT_ID })],
    method: 'gemini',
  });
  expect(result.current.isGenerating).toBe(false);
  expect(result.current.error).toBe('');
});

test('admits a distinct Gemini credential for every requested concurrent client', async () => {
  const credentialIds = [
    '018f4c22-f0f1-7c09-a4d5-120d7b6f84aa',
    '018f4c22-f0f1-7c09-a4d5-120d7b6f84ab',
    '018f4c22-f0f1-7c09-a4d5-120d7b6f84ac',
  ];
  credentialMocks.acquireGeminiCredential
    .mockResolvedValueOnce(credentialIds[0])
    .mockResolvedValueOnce(credentialIds[1])
    .mockResolvedValueOnce(credentialIds[2]);
  runNativeNarrationJob.mockResolvedValue({ status: 'completed', results: [] });
  const { result } = renderHook(() => useHarness({ concurrentClients: 3 }));

  await act(async () => result.current.controller.handleGeminiNarration());

  expect(credentialMocks.acquireGeminiCredential).toHaveBeenCalledTimes(3);
  expect(runNativeNarrationJob).toHaveBeenCalledWith(
    expect.objectContaining({ settings: expect.objectContaining({ credentialIds, maxConcurrency: 3 }) }),
    expect.any(Object),
  );
});

test('regenerating one cue preserves its ordinal and every sibling narration result', async () => {
  const secondArtifactId = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a5';
  const thirdArtifactId = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a6';
  const subtitles = [
    { id: 1, text: 'one', start: 0, end: 1 },
    { id: 2, text: 'two', start: 1, end: 2 },
    { id: 3, text: 'three', start: 2, end: 3 },
  ];
  const existing = subtitles.map((subtitle, index) => ({
    ...originalEditedResult,
    subtitle_id: subtitle.id,
    text: subtitle.text,
    nativeArtifactId: [ARTIFACT_ID, secondArtifactId, thirdArtifactId][index],
    filename: `osg-speech-artifact:${[ARTIFACT_ID, secondArtifactId, thirdArtifactId][index]}`,
    original_ids: [subtitle.id],
    outputIndex: index + 1,
    start: subtitle.start,
    end: subtitle.end,
  }));
  runNativeNarrationJob.mockImplementation(async (request) => ({
    status: 'completed',
    results: [{
      ...existing[1],
      outputIndex: request.subtitles[0].outputIndex,
    }],
  }));
  const { result } = renderHook(() => useHarness({
    subtitles,
    originalSubtitles: subtitles,
    initialGenerationResults: existing,
  }));

  await act(async () => result.current.controller.retryGTTSNarration(2));

  expect(runNativeNarrationJob).toHaveBeenCalledWith(
    expect.objectContaining({
      subtitles: [expect.objectContaining({ id: 2, outputIndex: 2 })],
    }),
    expect.any(Object),
  );
  expect(narrationStoreMocks.saveProjectNarration).toHaveBeenCalledWith(expect.objectContaining({
    results: [
      expect.objectContaining({ subtitle_id: 1, outputIndex: 1 }),
      expect.objectContaining({ subtitle_id: 2, outputIndex: 2 }),
      expect.objectContaining({ subtitle_id: 3, outputIndex: 3 }),
    ],
  }));
  expect(result.current.generationResults.map(({ subtitle_id, outputIndex }) => ({
    subtitle_id,
    outputIndex,
  }))).toEqual([
    { subtitle_id: 1, outputIndex: 1 },
    { subtitle_id: 2, outputIndex: 2 },
    { subtitle_id: 3, outputIndex: 3 },
  ]);
});

test('refuses an unavailable translated source instead of narrating original rows under its label', async () => {
  const { result } = renderHook(() => useHarness({
    subtitleSource: 'translated',
    translatedSubtitles: [],
  }));

  await act(async () => result.current.controller.handleGTTSNarration());

  expect(runNativeNarrationJob).not.toHaveBeenCalled();
  expect(narrationStoreMocks.saveProjectNarration).not.toHaveBeenCalled();
  expect(result.current.error).toContain('No subtitles available');
});

test('persists translated narration only from the exact translated cue plan', async () => {
  runNativeNarrationJob.mockResolvedValue({
    status: 'completed',
    results: [{
      ...originalEditedResult,
      text: 'bonjour',
    }],
  });
  const setGenerationResultSource = vi.fn();
  const { result } = renderHook(() => useHarness({
    subtitleSource: 'translated',
    translatedSubtitles: [{ id: 1, text: 'bonjour', start: 0, end: 1 }],
    setGenerationResultSource,
  }));

  await act(async () => result.current.controller.handleGTTSNarration());

  expect(runNativeNarrationJob).toHaveBeenCalledWith(
    expect.objectContaining({
      subtitles: [expect.objectContaining({ text: 'bonjour' })],
    }),
    expect.any(Object),
  );
  expect(setGenerationResultSource).toHaveBeenCalledWith('translated');
  expect(narrationStoreMocks.saveProjectNarration).toHaveBeenCalledWith(expect.objectContaining({
    source: 'translated',
    results: [expect.objectContaining({ text: 'bonjour' })],
  }));
});
