import { useState } from 'react';
import { act, renderHook } from '@testing-library/react';

import { runNativeNarrationJob } from '../../../platform/nativeNarrationFlow';
import useNativeNarrationController from './useNativeNarrationController';

vi.mock('../../../platform/desktopRuntime', () => ({ isDesktopRuntime: () => true }));
vi.mock('../../../platform/nativeNarrationFlow', () => ({
  cancelNativeNarrationJob: vi.fn(),
  restorePersistedNativeNarration: vi.fn(async () => null),
  runNativeNarrationJob: vi.fn(),
}));
vi.mock('../../../platform/credentialStateController', () => ({
  getActiveGeminiCredentialId: () => 'opaque-credential-id',
  initializeCredentialState: vi.fn(async () => undefined),
}));
vi.mock('../../../platform/speechService', () => ({
  GEMINI_SPEECH_MODELS: ['gemini-3.1-flash-live-preview'],
}));

const ARTIFACT_ID = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a2';
const REFERENCE_ID = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a3';

const useHarness = () => {
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
  expect(runNativeNarrationJob.mock.calls[0][0]).toMatchObject({
    reference: { nativeArtifactId: REFERENCE_ID },
    settings: { modelId: 'f5tts-v1-base' },
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
  expect(result.current.isGenerating).toBe(false);
  expect(result.current.error).toBe('');
});
