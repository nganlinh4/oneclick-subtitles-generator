// Pure helpers for useNativeNarrationController: method maps, project authority, persistence,
// per-engine settings, subtitle plans and result merging.
import { GEMINI_SPEECH_MODELS } from '../../../platform/speechService';
import {
  acquireGeminiCredential,
  initializeCredentialState,
} from '../../../platform/credentialStateController';
import { getActiveProjectSnapshot } from '../../../platform/projectService';
import { saveProjectNarration } from '../../../platform/projectNarrationStore';
import { hydrateNativeNarrationResults } from '../../../platform/nativeNarrationCapabilities';
import { deriveSubtitleId, idsEqual } from '../../../utils/subtitle/idUtils';

export const backendByMethod = Object.freeze({
  f5tts: 'f5Tts',
  chatterbox: 'chatterbox',
  'edge-tts': 'edgeTts',
  gtts: 'gtts',
  gemini: 'geminiTts',
});
export const engineByMethod = Object.freeze({
  f5tts: 'f5tts',
  chatterbox: 'chatterbox',
  'edge-tts': 'edge-tts',
  gtts: 'gtts',
  gemini: 'gemini-tts',
});

export const speechRuntimeStopped = () => Object.assign(
  new Error('The selected speech runtime was stopped or replaced'),
  { code: 'speechRuntimeStopped' },
);

export const activeProjectChanged = () => Object.assign(
  new Error('The active subtitle project changed'),
  { code: 'activeProjectChanged' },
);

export const narrationPersistenceFailed = () => Object.assign(
  new Error('The narration record could not be saved'),
  { code: 'narrationPersistenceFailed' },
);

export const captureProjectAuthority = () => {
  const snapshot = getActiveProjectSnapshot();
  const projectId = snapshot?.metadata?.id;
  const expectedProjectStateVersion = snapshot?.stateVersion;
  if (typeof projectId !== 'string'
      || !Number.isSafeInteger(expectedProjectStateVersion)
      || expectedProjectStateVersion < 0) return null;
  return Object.freeze({ projectId, expectedProjectStateVersion });
};

export const ownsProjectAuthority = (authority) => {
  const snapshot = getActiveProjectSnapshot();
  return snapshot?.metadata?.id === authority?.projectId
    && snapshot?.stateVersion === authority?.expectedProjectStateVersion;
};

export const persistNativeResults = (
  method,
  results,
  authority = null,
  source = 'original',
) => {
  if (!ownsProjectAuthority(authority) || !Array.isArray(results)) return Promise.resolve(null);
  return saveProjectNarration({
    projectId: authority.projectId,
    expectedProjectStateVersion: authority.expectedProjectStateVersion,
    source,
    results: hydrateNativeNarrationResults(results),
    method,
  });
};

export const resultSource = (state) => (
  ['original', 'translated', 'grouped'].includes(state.generationResultSource)
    ? state.generationResultSource
    : 'original'
);

export const sameSubtitlePlan = (left, right) => (
  Array.isArray(left)
  && Array.isArray(right)
  && left.length === right.length
  && left.every((subtitle, index) => {
    const other = right[index];
    return other
      && String(subtitle.id ?? subtitle.subtitle_id) === String(other.id ?? other.subtitle_id)
      && subtitle.text === other.text;
  })
);

const finite = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const nativeMethodSettings = async (method, state) => {
  switch (method) {
    case 'f5tts':
      return {
        referenceText: state.referenceText || null,
        modelId: state.selectedNarrationModel || 'f5tts-v1-base',
        language: (state.subtitleSource === 'translated'
          ? state.translatedLanguage?.languageCode
          : state.originalLanguage?.languageCode)?.toLowerCase().split('-')[0],
        speechRate: finite(state.advancedSettings?.speechRate, 1.1),
        nfeStep: Math.round(finite(state.advancedSettings?.nfeStep, 32)),
        swayCoef: finite(state.advancedSettings?.swayCoef, -1),
        cfgStrength: finite(state.advancedSettings?.cfgStrength, 2),
        seed: state.advancedSettings?.useRandomSeed
          ? null
          : Math.round(finite(state.advancedSettings?.seed, 0)),
        useRandomSeed: state.advancedSettings?.useRandomSeed === true,
        removeSilence: state.advancedSettings?.removeSilence !== false,
      };
    case 'chatterbox':
      return {
        language: state.chatterboxLanguage || 'en',
        exaggeration: finite(state.exaggeration, 1),
        cfgWeight: finite(state.cfgWeight, 0.5),
      };
    case 'edge-tts':
      return {
        voice: state.edgeTTSVoice,
        rate: state.edgeTTSRate,
        volume: state.edgeTTSVolume,
        pitch: state.edgeTTSPitch,
      };
    case 'gtts':
      return {
        language: state.gttsLanguage,
        tld: state.gttsTld || 'com',
        slow: state.gttsSlow === true,
      };
    case 'gemini': {
      await initializeCredentialState();
      const maxConcurrency = Math.max(1, Math.min(10, Math.round(finite(state.concurrentClients, 5))));
      const credentialIds = [];
      for (let index = 0; index < maxConcurrency; index += 1) {
        const credentialId = await acquireGeminiCredential();
        if (!credentialId || credentialIds.includes(credentialId)) break;
        credentialIds.push(credentialId);
      }
      if (credentialIds.length === 0) throw new Error('Gemini credential unavailable');
      const language = state.subtitleSource === 'translated'
        ? state.translatedLanguage?.languageCode
        : state.originalLanguage?.languageCode;
      return {
        credentialIds,
        model: GEMINI_SPEECH_MODELS[0],
        voice: state.selectedVoice,
        language: language || 'en-US',
        maxConcurrency,
      };
    }
    default:
      throw new Error('Native narration method unavailable');
  }
};

export const prepareSubtitles = (subtitles, completePlan = subtitles) => {
  const completeIds = completePlan.map((subtitle, index) => deriveSubtitleId(subtitle, index));
  return subtitles.map((subtitle, index) => {
    const id = deriveSubtitleId(subtitle, index);
    const completeIndex = completeIds.findIndex((candidate) => idsEqual(candidate, id));
    if (completeIndex < 0) {
      throw new TypeError('A narration request is not part of the selected subtitle plan');
    }
    return {
      ...subtitle,
      id,
      outputIndex: completeIndex + 1,
      original_ids: subtitle.original_ids || [id],
    };
  });
};

export const pendingResult = (subtitle, index, method) => ({
  subtitle_id: subtitle.id,
  text: subtitle.text || '',
  success: false,
  pending: true,
  audioData: null,
  filename: null,
  outputIndex: subtitle.outputIndex ?? index + 1,
  original_ids: subtitle.original_ids,
  start: subtitle.start,
  end: subtitle.end,
  method,
});

export const mergeResults = (current, replacements) => {
  const remaining = [...replacements];
  const merged = current.map((item) => {
    const index = remaining.findIndex((candidate) => idsEqual(
      candidate.subtitle_id,
      item.subtitle_id,
    ));
    if (index < 0) return item;
    return remaining.splice(index, 1)[0];
  });
  return [...merged, ...remaining];
};

export const finalizeRequestedResults = (current, replacements, subtitles, fallbackCode) => {
  const requestedIds = new Set(subtitles.map((subtitle) => String(subtitle.id)));
  return mergeResults(current, replacements).map((result) => (
    requestedIds.has(String(result.subtitle_id)) && result.pending
      ? {
        ...result,
        pending: false,
        success: false,
        errorCode: fallbackCode,
        retryable: fallbackCode !== 'cancelled',
      }
      : result
  ));
};
