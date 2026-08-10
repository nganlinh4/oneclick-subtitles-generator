import { useCallback, useEffect, useRef } from 'react';

import {
  GEMINI_SPEECH_MODELS,
} from '../../../platform/speechService';
import {
  getActiveGeminiCredentialId,
  initializeCredentialState,
} from '../../../platform/credentialStateController';
import { isDesktopRuntime } from '../../../platform/desktopRuntime';
import {
  cancelNativeNarrationJob,
  restorePersistedNativeNarration,
  runNativeNarrationJob,
} from '../../../platform/nativeNarrationFlow';
import {
  getNativeNarrationArtifactId,
  hydrateNativeNarrationResults,
} from '../../../platform/nativeNarrationCapabilities';
import { deriveSubtitleId, idsEqual } from '../../../utils/subtitle/idUtils';
import { hydrateNarrationResultsForAlignment } from '../../../utils/narrationAlignmentUtils';
import { getCurrentMediaId } from './referenceAudioCache';

const cacheKeyByMethod = Object.freeze({
  f5tts: 'f5tts_narrations_cache',
  chatterbox: 'chatterbox_narrations_cache',
  'edge-tts': 'edge_tts_narrations_cache',
  gtts: 'gtts_narrations_cache',
  gemini: 'gemini_narration_cache',
});

const MAX_CACHE_BYTES = 4 * 1024 * 1024;

const persistNativeResults = (method, results, referenceAudio = null) => {
  const key = cacheKeyByMethod[method];
  const mediaId = getCurrentMediaId();
  if (!key || !mediaId || !Array.isArray(results) || results.length === 0) return;
  const narrations = hydrateNativeNarrationResults(results).map((result) => ({
    subtitle_id: result.subtitle_id,
    filename: result.filename,
    nativeArtifactId: getNativeNarrationArtifactId(result),
    nativeFormat: result.nativeFormat,
    durationMicros: result.durationMicros,
    success: result.success,
    pending: result.pending,
    text: result.text,
    method: result.method || method,
    outputIndex: result.outputIndex,
    original_ids: result.original_ids,
    start: result.start,
    end: result.end,
  }));
  const referenceId = getNativeNarrationArtifactId(referenceAudio);
  const entry = {
    mediaId,
    timestamp: Date.now(),
    narrations,
    ...(referenceId ? {
      referenceAudio: {
        nativeArtifactId: referenceId,
        filename: referenceAudio.filename,
        format: referenceAudio.format,
        durationMicros: referenceAudio.durationMicros,
        text: referenceAudio.text || '',
        language: referenceAudio.language,
      },
    } : {}),
  };
  try {
    const serialized = JSON.stringify(entry);
    if (serialized.length <= MAX_CACHE_BYTES) localStorage.setItem(key, serialized);
  } catch {
    // Durable native artifacts remain authoritative if browser metadata persistence fails.
  }
};

const sameSubtitlePlan = (left, right) => (
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

const nativeMethodSettings = async (method, state) => {
  switch (method) {
    case 'f5tts':
      return {
        referenceText: state.referenceText || null,
        modelId: state.selectedNarrationModel || 'f5tts-v1-base',
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
      const credentialId = getActiveGeminiCredentialId();
      if (!credentialId) throw new Error('Gemini credential unavailable');
      const language = state.subtitleSource === 'translated'
        ? state.translatedLanguage?.languageCode
        : state.originalLanguage?.languageCode;
      return {
        credentialId,
        model: GEMINI_SPEECH_MODELS[0],
        voice: state.selectedVoice,
        language: language || 'en-US',
      };
    }
    default:
      throw new Error('Native narration method unavailable');
  }
};

const prepareSubtitles = (subtitles) => subtitles.map((subtitle, index) => ({
  ...subtitle,
  id: deriveSubtitleId(subtitle, index),
  original_ids: subtitle.original_ids || [deriveSubtitleId(subtitle, index)],
}));

const pendingResult = (subtitle, index, method) => ({
  subtitle_id: subtitle.id,
  text: subtitle.text || '',
  success: false,
  pending: true,
  audioData: null,
  filename: null,
  outputIndex: index + 1,
  original_ids: subtitle.original_ids,
  start: subtitle.start,
  end: subtitle.end,
  method,
});

const mergeResults = (current, replacements) => {
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

const finalizeRequestedResults = (current, replacements, subtitles, fallbackCode) => {
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

const useNativeNarrationController = (state) => {
  const native = isDesktopRuntime();
  const stateRef = useRef(state);
  stateRef.current = state;

  const selectedSubtitles = useCallback(() => {
    const current = stateRef.current;
    if (current.useGroupedSubtitles
        && Array.isArray(current.groupedSubtitles)
        && current.groupedSubtitles.length > 0) {
      return current.groupedSubtitles;
    }
    if (current.subtitleSource === 'translated'
        && Array.isArray(current.translatedSubtitles)
        && current.translatedSubtitles.length > 0) {
      return current.translatedSubtitles;
    }
    return current.originalSubtitles || current.subtitles || [];
  }, []);

  const run = useCallback(async (method, requestedSubtitles, { replace = true } = {}) => {
    const current = stateRef.current;
    if (!native) {
      current.setError(current.t(
        'narration.serviceUnavailableMessage',
        'Narration requires the desktop runtime',
      ));
      return false;
    }
    if (!current.subtitleSource) {
      current.setError(current.t(
        'narration.noSourceSelectedError',
        'Please select a subtitle source (Original or Translated)',
      ));
      return false;
    }
    const subtitles = prepareSubtitles(requestedSubtitles || selectedSubtitles());
    if (subtitles.length === 0) {
      current.setError(current.t('narration.noSubtitlesError', 'No subtitles available for narration'));
      return false;
    }
    const needsReference = method === 'f5tts' || method === 'chatterbox';
    if (needsReference && !getNativeNarrationArtifactId(current.referenceAudio)) {
      current.setError(current.t(
        'narration.noReferenceAudioError',
        'Please upload or record reference audio first',
      ));
      return false;
    }

    current.setIsGenerating(true);
    current.setError('');
    current.setGenerationStatus(current.t(
      'narration.preparingGeneration',
      'Preparing to generate narration...',
    ));
    const pending = subtitles.map((subtitle, index) => pendingResult(subtitle, index, method));
    if (replace) {
      current.setGenerationResults(pending);
    } else {
      current.setGenerationResults((previous) => mergeResults(previous, pending));
    }

    try {
      const settings = await nativeMethodSettings(method, current);
      const request = {
        method,
        subtitles,
        settings,
        reference: needsReference
          ? { nativeArtifactId: getNativeNarrationArtifactId(current.referenceAudio) }
          : null,
      };
      const updateResult = (result, progress, total) => {
        current.setGenerationResults((previous) => mergeResults(previous, [result]));
        current.setGenerationStatus(current.t(
          'narration.generatingProgressWithId',
          'Generated {{progress}} of {{total}} narrations (ID: {{id}})...',
          { progress, total, id: result.subtitle_id },
        ));
      };
      const outcome = await runNativeNarrationJob(request, {
        onProgress: ({ current: progress, total }) => {
          current.setGenerationStatus(current.t(
            'narration.generatingNarration',
            'Generating narration {{current}} of {{total}}...',
            { current: progress, total },
          ));
        },
        onResult: updateResult,
      });
      const finalized = hydrateNarrationResultsForAlignment(outcome.results);
      current.setGenerationResults((previous) => {
        const next = finalizeRequestedResults(
          previous,
          finalized,
          subtitles,
          outcome.status === 'cancelled' ? 'cancelled' : 'synthesisFailed',
        );
        persistNativeResults(method, next, current.referenceAudio);
        return next;
      });
      current.setGenerationStatus(outcome.status === 'cancelled'
        ? current.t('narration.generationCancelled', 'Narration generation cancelled by user')
        : current.t('narration.generationComplete', 'Narration generation complete'));
      if (current.useGroupedSubtitles && current.groupedSubtitles?.length > 0) {
        current.setUseGroupedSubtitles(true);
      }
      return true;
    } catch (error) {
      const partial = hydrateNarrationResultsForAlignment(error?.results || []);
      current.setGenerationResults((previous) => {
        const next = finalizeRequestedResults(
          previous,
          partial,
          subtitles,
          error?.code || 'synthesisFailed',
        );
        persistNativeResults(method, next, current.referenceAudio);
        return next;
      });
      current.setError(current.t(
        'narration.generationError',
        'Error generating narration',
      ));
      return false;
    } finally {
      current.setIsGenerating(false);
    }
  }, [native, selectedSubtitles]);

  const retry = useCallback(async (method, subtitleId) => {
    const current = stateRef.current;
    const subtitle = selectedSubtitles().find((item, index) => (
      idsEqual(deriveSubtitleId(item, index), subtitleId)
    ));
    if (!subtitle) return false;
    current.setRetryingSubtitleId(subtitleId);
    try {
      if (typeof window.resetAlignedNarration === 'function') window.resetAlignedNarration();
      return await run(method, [subtitle], { replace: false });
    } finally {
      current.setRetryingSubtitleId(null);
    }
  }, [run, selectedSubtitles]);

  const retryFailed = useCallback(async (method) => {
    const current = stateRef.current;
    const failedIds = new Set((current.generationResults || [])
      .filter((result) => !result.success && !result.pending)
      .map((result) => String(result.subtitle_id)));
    const failed = selectedSubtitles().filter((subtitle, index) => (
      failedIds.has(String(deriveSubtitleId(subtitle, index)))
    ));
    return failed.length > 0 ? run(method, failed, { replace: false }) : false;
  }, [run, selectedSubtitles]);

  const generatePending = useCallback(async (method) => {
    const current = stateRef.current;
    const completed = new Set((current.generationResults || [])
      .filter((result) => result.success)
      .map((result) => String(result.subtitle_id)));
    const pending = selectedSubtitles().filter((subtitle, index) => (
      !completed.has(String(deriveSubtitleId(subtitle, index)))
    ));
    return pending.length > 0 ? run(method, pending, { replace: false }) : false;
  }, [run, selectedSubtitles]);

  const cancel = useCallback(async (method) => {
    if (!native) return false;
    return cancelNativeNarrationJob(method).catch(() => false);
  }, [native]);

  useEffect(() => {
    if (!native) return undefined;
    let disposed = false;
    const current = stateRef.current;
    const selected = prepareSubtitles(selectedSubtitles());
    Promise.resolve(restorePersistedNativeNarration({
      method: current.narrationMethod,
      subtitles: selected,
    })).then((restored) => {
      const latest = stateRef.current;
      if (disposed
          || !restored
          || (latest.generationResults || []).length > 0
          || !sameSubtitlePlan(restored.subtitles, selected)) return;
      latest.setGenerationResults(hydrateNativeNarrationResults(restored.results));
      latest.setGenerationStatus(latest.t(
        'narration.loadedFromCache',
        'Loaded narrations from previous session',
      ));
    }).catch(() => undefined);
    return () => { disposed = true; };
  }, [native, selectedSubtitles]);

  useEffect(() => {
    if (!native) return undefined;
    const handleEdit = (event) => {
      const replacement = event?.detail?.result;
      const previousId = event?.detail?.previousArtifactId;
      if (!replacement || !previousId) return;
      stateRef.current.setGenerationResults((results) => {
        const next = results.map((result) => (
          getNativeNarrationArtifactId(result) === previousId ? replacement : result
        ));
        persistNativeResults(
          replacement.method || stateRef.current.narrationMethod,
          next,
          stateRef.current.referenceAudio,
        );
        return next;
      });
    };
    window.addEventListener('native-narration-artifact-edited', handleEdit);
    return () => window.removeEventListener('native-narration-artifact-edited', handleEdit);
  }, [native]);

  return {
    handleGenerateNarration: () => run('f5tts'),
    cancelGeneration: () => cancel('f5tts'),
    retryF5TTSNarration: (id) => retry('f5tts', id),
    retryFailedNarrations: () => retryFailed('f5tts'),
    generateAllPendingF5TTSNarrations: () => generatePending('f5tts'),
    handleChatterboxNarration: () => run('chatterbox'),
    cancelChatterboxGeneration: () => cancel('chatterbox'),
    retryChatterboxNarration: (id) => retry('chatterbox', id),
    retryFailedChatterboxNarrations: () => retryFailed('chatterbox'),
    generateAllPendingChatterboxNarrations: () => generatePending('chatterbox'),
    handleEdgeTTSNarration: () => run('edge-tts'),
    cancelEdgeTTSGeneration: () => cancel('edge-tts'),
    retryEdgeTTSNarration: (id) => retry('edge-tts', id),
    retryFailedEdgeTTSNarrations: () => retryFailed('edge-tts'),
    generateAllPendingEdgeTTSNarrations: () => generatePending('edge-tts'),
    handleGTTSNarration: () => run('gtts'),
    cancelGTTSGeneration: () => cancel('gtts'),
    retryGTTSNarration: (id) => retry('gtts', id),
    retryFailedGTTSNarrations: () => retryFailed('gtts'),
    generateAllPendingGTTSNarrations: () => generatePending('gtts'),
    handleGeminiNarration: () => run('gemini'),
    cancelGeminiGeneration: () => cancel('gemini'),
    retryGeminiNarration: (id) => retry('gemini', id),
    retryFailedGeminiNarrations: () => retryFailed('gemini'),
    generateAllPendingGeminiNarrations: () => generatePending('gemini'),
  };
};

export default useNativeNarrationController;
