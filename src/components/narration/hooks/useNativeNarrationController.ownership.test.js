import { act, renderHook } from '@testing-library/react';

import {
  restorePersistedNativeNarration,
  runNativeNarrationJob,
} from '../../../platform/nativeNarrationFlow';
import {
  ARTIFACT_ID,
  PROJECT_ID,
  narrationStoreMocks,
  originalEditedResult,
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
  expect(result.current.error).toContain('could not start');
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
