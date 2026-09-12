import { useState } from 'react';
import { act, renderHook } from '@testing-library/react';

import {
  restorePersistedNativeNarration,
  runNativeNarrationJob,
} from '../../../platform/nativeNarrationFlow';
import {
  commitNativeNarrationEdit,
  commitNativeNarrationEdits,
} from '../../../platform/nativeNarrationEditCommit';
import useNativeNarrationController from './useNativeNarrationController';

const checkpointMocks = vi.hoisted(() => ({
  flushDurableLyricsHistory: vi.fn(),
}));

const speechMocks = vi.hoisted(() => ({
  getSpeechLifecycleSnapshot: vi.fn(),
}));
const projectMocks = vi.hoisted(() => ({
  getActiveProjectSnapshot: vi.fn(),
}));
const narrationStoreMocks = vi.hoisted(() => ({
  saveProjectNarration: vi.fn(),
}));

vi.mock('../../../platform/desktopRuntime', () => ({ isDesktopRuntime: () => true }));
vi.mock('../../../platform/durableLyricsCheckpoint', () => ({
  flushDurableLyricsHistory: checkpointMocks.flushDurableLyricsHistory,
}));
vi.mock('../../../platform/nativeNarrationFlow', () => ({
  cancelNativeNarrationJob: vi.fn(),
  restorePersistedNativeNarration: vi.fn(async () => null),
  runNativeNarrationJob: vi.fn(),
}));
vi.mock('../../../platform/projectService', () => ({
  getActiveProjectSnapshot: projectMocks.getActiveProjectSnapshot,
}));
vi.mock('../../../platform/projectNarrationStore', () => ({
  saveProjectNarration: narrationStoreMocks.saveProjectNarration,
}));
vi.mock('../../../platform/credentialStateController', () => ({
  getActiveGeminiCredentialId: () => 'opaque-credential-id',
  initializeCredentialState: vi.fn(async () => undefined),
}));
vi.mock('../../../platform/speechService', () => ({
  GEMINI_SPEECH_MODELS: ['gemini-3.1-flash-live-preview'],
  getSpeechLifecycleSnapshot: speechMocks.getSpeechLifecycleSnapshot,
}));
const ARTIFACT_ID = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a2';
const REFERENCE_ID = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a3';
const PROJECT_ID = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a4';

beforeEach(() => {
  vi.clearAllMocks();
  speechMocks.getSpeechLifecycleSnapshot.mockReturnValue({
    epoch: 7,
    enabled: true,
    warm: true,
  });
  checkpointMocks.flushDurableLyricsHistory.mockResolvedValue(undefined);
  narrationStoreMocks.saveProjectNarration.mockResolvedValue({
    projectId: PROJECT_ID,
    projectStateVersion: 7,
    source: 'original',
    results: [],
  });
  projectMocks.getActiveProjectSnapshot.mockReturnValue({
    metadata: { id: PROJECT_ID, name: 'Narration test' },
    stateVersion: 7,
    media: [],
    tracks: [],
  });
});

const useHarness = (overrides = {}) => {
  const { initialGenerationResults = [], ...stateOverrides } = overrides;
  const [generationResults, setGenerationResults] = useState(initialGenerationResults);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationStatus, setGenerationStatus] = useState('');
  const [error, setError] = useState('');
  const [retryingSubtitleId, setRetryingSubtitleId] = useState(null);
  const controller = useNativeNarrationController({
    subtitles: [{ id: 1, text: 'hello', start: 0, end: 1 }],
    originalSubtitles: [{ id: 1, text: 'hello', start: 0, end: 1 }],
    translatedSubtitles: [],
    subtitleSource: 'original',
    originalLanguage: { languageCode: 'en' },
    translatedLanguage: null,
    useGroupedSubtitles: false,
    groupedSubtitles: null,
    setUseGroupedSubtitles: vi.fn(),
    referenceAudio: {
      nativeArtifactId: REFERENCE_ID,
      filename: `osg-speech-artifact:${REFERENCE_ID}`,
    },
    referenceText: 'reference words',
    selectedNarrationModel: 'f5tts-v1-base',
    advancedSettings: {
      speechRate: 1.1,
      nfeStep: 32,
      swayCoef: -1,
      cfgStrength: 2,
      useRandomSeed: true,
      removeSilence: true,
    },
    chatterboxLanguage: 'en',
    exaggeration: 0.7,
    cfgWeight: 0.3,
    edgeTTSVoice: 'en-US-AriaNeural',
    edgeTTSRate: '+0%',
    edgeTTSVolume: '+0%',
    edgeTTSPitch: '+0Hz',
    gttsLanguage: 'en',
    gttsTld: 'com',
    gttsSlow: false,
    selectedVoice: 'Aoede',
    concurrentClients: 5,
    generationResults,
    setGenerationResults,
    generationResultSource: 'original',
    setGenerationResultSource: vi.fn(),
    isGenerating,
    setIsGenerating,
    generationStatus,
    setGenerationStatus,
    error,
    setError,
    retryingSubtitleId,
    setRetryingSubtitleId,
    narrationMethod: 'gtts',
    t: (_key, fallback) => fallback,
    ...stateOverrides,
  });
  return { controller, generationResults, isGenerating, error };
};

const originalEditedResult = {
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
  method: 'gtts',
};
const editedResult = {
  ...originalEditedResult,
  nativeArtifactId: REFERENCE_ID,
  durationMicros: 800_000,
  filename: `osg-speech-artifact:${REFERENCE_ID}`,
};

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
      credentialId: 'opaque-credential-id',
      model: 'gemini-3.1-flash-live-preview',
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

test('rejects generation immediately when Tools has stopped the owned lifecycle', async () => {
  speechMocks.getSpeechLifecycleSnapshot.mockReturnValue({
    epoch: 8,
    enabled: false,
    warm: false,
  });
  const { result } = renderHook(() => useHarness());

  await act(async () => result.current.controller.handleGTTSNarration());

  expect(runNativeNarrationJob).not.toHaveBeenCalled();
  expect(result.current.error).toContain('not ready');
  expect(result.current.isGenerating).toBe(false);
});

test('does not publish or persist a completed result after Stop and restart changes the epoch', async () => {
  let lifecycle = { epoch: 7, enabled: true, warm: true };
  speechMocks.getSpeechLifecycleSnapshot.mockImplementation(() => lifecycle);
  let resolveJob;
  let callbacks;
  runNativeNarrationJob.mockImplementation((_request, handlers) => {
    callbacks = handlers;
    return new Promise((resolve) => { resolveJob = resolve; });
  });
  const { result } = renderHook(() => useHarness());

  let generation;
  await act(async () => {
    generation = result.current.controller.handleGTTSNarration();
    await vi.waitFor(() => expect(resolveJob).toBeTypeOf('function'));
  });
  lifecycle = { epoch: 8, enabled: false, warm: false };
  lifecycle = { epoch: 8, enabled: true, warm: true };
  const completed = {
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
    method: 'gtts',
  };
  callbacks.onProgress({ current: 1, total: 1 });
  callbacks.onResult(completed, 1, 1);
  resolveJob({ status: 'completed', results: [completed] });

  await act(async () => {
    await expect(generation).resolves.toBe(false);
  });

  expect(result.current.generationResults).toEqual([
    expect.objectContaining({ success: false, pending: false, errorCode: 'speechRuntimeStopped' }),
  ]);
  expect(result.current.generationResults[0]).not.toHaveProperty('nativeArtifactId');
  expect(narrationStoreMocks.saveProjectNarration).not.toHaveBeenCalled();
  expect(result.current.error).toContain('not ready');
});

test('does not publish or persist a completed result after the same project advances a revision', async () => {
  let project = {
    metadata: { id: PROJECT_ID, name: 'Narration test' },
    stateVersion: 7,
    media: [],
    tracks: [],
  };
  projectMocks.getActiveProjectSnapshot.mockImplementation(() => project);
  let resolveJob;
  let callbacks;
  runNativeNarrationJob.mockImplementation((_request, handlers) => {
    callbacks = handlers;
    return new Promise((resolve) => { resolveJob = resolve; });
  });
  const { result } = renderHook(() => useHarness());

  let generation;
  await act(async () => {
    generation = result.current.controller.handleGTTSNarration();
    await vi.waitFor(() => expect(resolveJob).toBeTypeOf('function'));
  });
  expect(runNativeNarrationJob).toHaveBeenCalledWith(
    expect.objectContaining({
      projectId: PROJECT_ID,
      expectedProjectStateVersion: 7,
    }),
    expect.any(Object),
  );
  project = { ...project, stateVersion: 8 };
  const completed = {
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
    method: 'gtts',
  };
  callbacks.onProgress({ current: 1, total: 1 });
  callbacks.onResult(completed, 1, 1);
  resolveJob({ status: 'completed', results: [completed] });

  await act(async () => {
    await expect(generation).resolves.toBe(false);
  });

  expect(result.current.generationResults).toEqual([
    expect.objectContaining({ success: false, pending: false, errorCode: 'activeProjectChanged' }),
  ]);
  expect(result.current.generationResults[0]).not.toHaveProperty('nativeArtifactId');
  expect(narrationStoreMocks.saveProjectNarration).not.toHaveBeenCalled();
  expect(result.current.error).toContain('active subtitle project changed');
});

test('does not claim success when the native narration record cannot be committed', async () => {
  runNativeNarrationJob.mockResolvedValue({
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
      outputIndex: 0,
      start: 0,
      end: 1,
      method: 'gtts',
    }],
  });
  narrationStoreMocks.saveProjectNarration.mockRejectedValue(new Error('sqlite unavailable'));
  const { result } = renderHook(() => useHarness());

  await act(async () => {
    await expect(result.current.controller.handleGTTSNarration()).resolves.toBe(false);
  });

  expect(narrationStoreMocks.saveProjectNarration).toHaveBeenCalledTimes(1);
  expect(result.current.generationResults).toEqual([
    expect.objectContaining({
      subtitle_id: 1,
      success: false,
      pending: false,
      errorCode: 'narrationPersistenceFailed',
    }),
  ]);
  expect(result.current.generationResults[0]).not.toHaveProperty('nativeArtifactId');
  expect(result.current.error).toContain('could not be saved to this project');
});

test('does not publish partial narration when its native checkpoint is rejected', async () => {
  runNativeNarrationJob.mockRejectedValue(Object.assign(new Error('provider stopped'), {
    code: 'synthesisFailed',
    results: [originalEditedResult],
  }));
  narrationStoreMocks.saveProjectNarration.mockRejectedValue(new Error('sqlite unavailable'));
  const { result } = renderHook(() => useHarness());

  await act(async () => {
    await expect(result.current.controller.handleGTTSNarration()).resolves.toBe(false);
  });

  expect(narrationStoreMocks.saveProjectNarration).toHaveBeenCalledTimes(1);
  expect(result.current.generationResults).toEqual([
    expect.objectContaining({
      subtitle_id: 1,
      success: false,
      pending: false,
      errorCode: 'narrationPersistenceFailed',
    }),
  ]);
  expect(result.current.generationResults[0]).not.toHaveProperty('nativeArtifactId');
  expect(result.current.error).toContain('could not be saved to this project');
});

test('terminates partial results when project ownership changes during their checkpoint', async () => {
  let finishSave;
  let project = {
    metadata: { id: PROJECT_ID, name: 'Narration test' },
    stateVersion: 7,
    media: [],
    tracks: [],
  };
  projectMocks.getActiveProjectSnapshot.mockImplementation(() => project);
  runNativeNarrationJob.mockRejectedValue(Object.assign(new Error('provider stopped'), {
    code: 'synthesisFailed',
    results: [originalEditedResult],
  }));
  narrationStoreMocks.saveProjectNarration.mockImplementation(() => new Promise((resolve) => {
    finishSave = resolve;
  }));
  const { result } = renderHook(() => useHarness());

  let generation;
  await act(async () => {
    generation = result.current.controller.handleGTTSNarration();
    await vi.waitFor(() => expect(finishSave).toBeTypeOf('function'));
  });
  project = { ...project, stateVersion: 8 };
  await act(async () => {
    finishSave({ projectId: PROJECT_ID, projectStateVersion: 7, results: [] });
    await expect(generation).resolves.toBe(false);
  });

  expect(result.current.generationResults).toEqual([
    expect.objectContaining({
      subtitle_id: 1,
      success: false,
      pending: false,
      errorCode: 'activeProjectChanged',
    }),
  ]);
  expect(result.current.generationResults[0]).not.toHaveProperty('nativeArtifactId');
  expect(result.current.error).toContain('active subtitle project changed');
});

test('reports a current-project narration restore failure instead of presenting an empty cache', async () => {
  restorePersistedNativeNarration.mockRejectedValueOnce(new Error('sqlite unavailable'));
  const { result } = renderHook(() => useHarness());

  await vi.waitFor(() => {
    expect(result.current.error).toContain('Saved narration could not be loaded');
  });
  expect(result.current.generationResults).toEqual([]);
});

test('does not publish a stale narration restore failure into the next project', async () => {
  let rejectRestore;
  restorePersistedNativeNarration.mockImplementationOnce(() => new Promise((_resolve, reject) => {
    rejectRestore = reject;
  }));
  const { result } = renderHook(() => useHarness());
  await vi.waitFor(() => expect(rejectRestore).toBeTypeOf('function'));
  projectMocks.getActiveProjectSnapshot.mockReturnValue({
    metadata: { id: '018f4c22-f0f1-7c09-a4d5-120d7b6f84ff', name: 'Next project' },
    stateVersion: 0,
    media: [],
    tracks: [],
  });

  await act(async () => {
    rejectRestore(new Error('old project failed'));
    await Promise.resolve();
  });

  expect(result.current.error).toBe('');
});

test('reports customer narration progress without exposing internal subtitle identifiers', async () => {
  const t = vi.fn((_key, fallback) => fallback);
  const completed = {
    ...originalEditedResult,
    subtitle_id: 'internal-cue-018f4c22',
  };
  runNativeNarrationJob.mockImplementation(async (_request, handlers) => {
    handlers.onResult(completed, 1, 1);
    return { status: 'completed', results: [completed] };
  });
  const { result } = renderHook(() => useHarness({ t }));

  await act(async () => result.current.controller.handleGTTSNarration());

  expect(t).toHaveBeenCalledWith(
    'narration.generatingProgress',
    'Generated {{progress}} of {{total}} narrations...',
    { progress: 1, total: 1 },
  );
  expect(t).not.toHaveBeenCalledWith(
    'narration.generatingProgressWithId',
    expect.anything(),
    expect.anything(),
  );
});
