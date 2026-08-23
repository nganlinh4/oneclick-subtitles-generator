import { useState } from 'react';
import { act, renderHook } from '@testing-library/react';

import { runNativeNarrationJob } from '../../../platform/nativeNarrationFlow';
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
  const [generationResults, setGenerationResults] = useState([]);
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
    generationResults,
    setGenerationResults,
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
    ...overrides,
  });
  return { controller, generationResults, isGenerating, error };
};

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
  expect(result.current.error).toContain('Error generating narration');
});
