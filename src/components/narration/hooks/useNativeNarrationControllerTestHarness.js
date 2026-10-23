// Shared harness for the useNativeNarrationController test files. Each test file registers the
// module mocks (see NARRATION_CONTROLLER_MOCKS below); this module wires their defaults.
import { useState } from 'react';
import { vi } from 'vitest';

import { cancelNativeNarrationJob } from '../../../platform/nativeNarrationFlow';
import { flushDurableLyricsHistory } from '../../../platform/durableLyricsCheckpoint';
import { getSpeechLifecycleSnapshot } from '../../../platform/speechService';
import { ensureManagedEngineReady } from '../../../platform/managedEngineService';
import { getActiveProjectSnapshot } from '../../../platform/projectService';
import { saveProjectNarration } from '../../../platform/projectNarrationStore';
import { acquireGeminiCredential } from '../../../platform/credentialStateController';
import useNativeNarrationController from './useNativeNarrationController';

export const checkpointMocks = { flushDurableLyricsHistory: vi.mocked(flushDurableLyricsHistory) };
export const speechMocks = { getSpeechLifecycleSnapshot: vi.mocked(getSpeechLifecycleSnapshot) };
export const engineMocks = { ensureManagedEngineReady: vi.mocked(ensureManagedEngineReady) };
export const projectMocks = { getActiveProjectSnapshot: vi.mocked(getActiveProjectSnapshot) };
export const narrationStoreMocks = { saveProjectNarration: vi.mocked(saveProjectNarration) };
export const credentialMocks = { acquireGeminiCredential: vi.mocked(acquireGeminiCredential) };

export const ARTIFACT_ID = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a2';
export const REFERENCE_ID = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a3';
export const PROJECT_ID = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a4';

export const resetNarrationControllerMocks = () => {
  vi.clearAllMocks();
  credentialMocks.acquireGeminiCredential
    .mockResolvedValue('018f4c22-f0f1-7c09-a4d5-120d7b6f84aa');
  vi.mocked(cancelNativeNarrationJob).mockResolvedValue(false);
  speechMocks.getSpeechLifecycleSnapshot.mockReturnValue({
    epoch: 7,
    enabled: true,
    warm: true,
  });
  engineMocks.ensureManagedEngineReady.mockResolvedValue({
    status: { epoch: 7, enabled: true, warm: true },
    voices: [],
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
};

export const useHarness = (overrides = {}) => {
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
  return { controller, generationResults, isGenerating, generationStatus, error };
};

export const originalEditedResult = {
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
export const editedResult = {
  ...originalEditedResult,
  nativeArtifactId: REFERENCE_ID,
  durationMicros: 800_000,
  filename: `osg-speech-artifact:${REFERENCE_ID}`,
};
