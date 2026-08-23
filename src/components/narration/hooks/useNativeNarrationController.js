import { useCallback, useEffect, useRef } from 'react';

import {
  GEMINI_SPEECH_MODELS,
  getSpeechLifecycleSnapshot,
} from '../../../platform/speechService';
import {
  getActiveGeminiCredentialId,
  initializeCredentialState,
} from '../../../platform/credentialStateController';
import { isDesktopRuntime } from '../../../platform/desktopRuntime';
import { flushDurableLyricsHistory } from '../../../platform/durableLyricsCheckpoint';
import {
  cancelNativeNarrationJob,
  restorePersistedNativeNarration,
  runNativeNarrationJob,
} from '../../../platform/nativeNarrationFlow';
import { getActiveProjectSnapshot } from '../../../platform/projectService';
import { saveProjectNarration } from '../../../platform/projectNarrationStore';
import {
  claimNativeNarrationEditCommit,
  NATIVE_NARRATION_EDIT_COMMIT_EVENT,
} from '../../../platform/nativeNarrationEditCommit';
import { requestAlignedNarrationReset } from '../../../platform/alignedNarrationSession';
import {
  getF5TtsLanguageSupport,
  getNativeNarrationArtifactId,
  hydrateNativeNarrationResults,
} from '../../../platform/nativeNarrationCapabilities';
import { deriveSubtitleId, idsEqual } from '../../../utils/subtitle/idUtils';
import { hydrateNarrationResultsForAlignment } from '../../../utils/narrationAlignmentUtils';

const backendByMethod = Object.freeze({
  f5tts: 'f5Tts',
  chatterbox: 'chatterbox',
  'edge-tts': 'edgeTts',
  gtts: 'gtts',
  gemini: 'geminiTts',
});

const speechRuntimeStopped = () => Object.assign(
  new Error('The selected speech runtime was stopped or replaced'),
  { code: 'speechRuntimeStopped' },
);

const activeProjectChanged = () => Object.assign(
  new Error('The active subtitle project changed'),
  { code: 'activeProjectChanged' },
);

const narrationPersistenceFailed = () => Object.assign(
  new Error('The narration record could not be saved'),
  { code: 'narrationPersistenceFailed' },
);

const captureProjectAuthority = () => {
  const snapshot = getActiveProjectSnapshot();
  const projectId = snapshot?.metadata?.id;
  const expectedProjectStateVersion = snapshot?.stateVersion;
  if (typeof projectId !== 'string'
      || !Number.isSafeInteger(expectedProjectStateVersion)
      || expectedProjectStateVersion < 0) return null;
  return Object.freeze({ projectId, expectedProjectStateVersion });
};

const ownsProjectAuthority = (authority) => {
  const snapshot = getActiveProjectSnapshot();
  return snapshot?.metadata?.id === authority?.projectId
    && snapshot?.stateVersion === authority?.expectedProjectStateVersion;
};

const persistNativeResults = (
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

const narrationSource = (state) => (
  state.useGroupedSubtitles && state.groupedSubtitles?.length > 0
    ? 'grouped'
    : (state.subtitleSource === 'translated' ? 'translated' : 'original')
);

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
  const editInFlightRef = useRef(false);
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
    const backend = backendByMethod[method];
    const lifecycle = backend ? getSpeechLifecycleSnapshot(backend) : null;
    if (!lifecycle?.enabled || !lifecycle.warm) {
      current.setError(current.t(
        'narration.engineUnavailableMessage',
        'This narration engine is not ready. Install or start it in Settings > Tools.'
      ));
      return false;
    }
    const ownsLifecycle = () => {
      const latest = getSpeechLifecycleSnapshot(backend);
      return latest?.epoch === lifecycle.epoch && latest.enabled && latest.warm;
    };
    const requireLifecycleOwnership = () => {
      if (!ownsLifecycle()) throw speechRuntimeStopped();
    };
    if (!current.subtitleSource) {
      current.setError(current.t(
        'narration.noSourceSelectedError',
        'Please select a subtitle source (Original or Translated)',
      ));
      return false;
    }
    let subtitles = prepareSubtitles(requestedSubtitles || selectedSubtitles());
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
    if (method === 'f5tts') {
      const language = current.subtitleSource === 'translated'
        ? current.translatedLanguage
        : current.originalLanguage;
      const languageSupport = getF5TtsLanguageSupport(language);
      if (!languageSupport.supported) {
        current.setError(languageSupport.reason === 'unknown'
          ? current.t(
            'narration.f5LanguageRequiredError',
            'Detect or select the subtitle language before using F5-TTS.'
          )
          : current.t(
            'narration.f5UnsupportedLanguageError',
            'F5-TTS supports English and Chinese subtitles only. Choose another narration engine for this language.'
          ));
        return false;
      }
    }

    try {
      await flushDurableLyricsHistory();
    } catch {
      current.setError(current.t(
        'errors.subtitleCheckpointFailed',
        'The subtitle checkpoint could not be saved.',
      ));
      return false;
    }
    subtitles = prepareSubtitles(requestedSubtitles || selectedSubtitles());
    if (subtitles.length === 0) {
      current.setError(current.t('narration.noSubtitlesError', 'No subtitles available for narration'));
      return false;
    }

    const authority = captureProjectAuthority();
    if (!authority) {
      current.setError(current.t(
        'errors.activeProjectChanged',
        'The active subtitle project changed.',
      ));
      return false;
    }
    const requireProjectOwnership = () => {
      if (!ownsProjectAuthority(authority)) throw activeProjectChanged();
    };

    current.setIsGenerating(true);
    current.setError('');
    current.setGenerationStatus(current.t(
      'narration.preparingGeneration',
      'Preparing to generate narration...',
    ));
    const pending = subtitles.map((subtitle, index) => pendingResult(subtitle, index, method));
    const stagedResults = replace
      ? pending
      : mergeResults(current.generationResults || [], pending);
    current.setGenerationResults(stagedResults);

    try {
      const settings = await nativeMethodSettings(method, current);
      requireLifecycleOwnership();
      requireProjectOwnership();
      const request = {
        method,
        projectId: authority.projectId,
        expectedProjectStateVersion: authority.expectedProjectStateVersion,
        lifecycleEpoch: lifecycle.epoch,
        subtitles,
        settings,
        reference: needsReference
          ? { nativeArtifactId: getNativeNarrationArtifactId(current.referenceAudio) }
          : null,
      };
      const updateResult = (result, progress, total) => {
        if (!ownsLifecycle() || !ownsProjectAuthority(authority)) return;
        current.setGenerationResults((previous) => mergeResults(previous, [result]));
        if (!ownsLifecycle() || !ownsProjectAuthority(authority)) return;
        current.setGenerationStatus(current.t(
          'narration.generatingProgressWithId',
          'Generated {{progress}} of {{total}} narrations (ID: {{id}})...',
          { progress, total, id: result.subtitle_id },
        ));
      };
      const outcome = await runNativeNarrationJob(request, {
        onProgress: ({ current: progress, total }) => {
          if (!ownsLifecycle() || !ownsProjectAuthority(authority)) return;
          current.setGenerationStatus(current.t(
            'narration.generatingNarration',
            'Generating narration {{current}} of {{total}}...',
            { current: progress, total },
          ));
        },
        onResult: updateResult,
      });
      requireLifecycleOwnership();
      requireProjectOwnership();
      const finalized = hydrateNarrationResultsForAlignment(outcome.results);
      const next = finalizeRequestedResults(
        stagedResults,
        finalized,
        subtitles,
        outcome.status === 'cancelled' ? 'cancelled' : 'synthesisFailed',
      );
      await persistNativeResults(method, next, authority, narrationSource(current)).catch(() => {
        throw narrationPersistenceFailed();
      });
      requireLifecycleOwnership();
      requireProjectOwnership();
      current.setGenerationResults(next);
      requireLifecycleOwnership();
      requireProjectOwnership();
      current.setGenerationStatus(outcome.status === 'cancelled'
        ? current.t('narration.generationCancelled', 'Narration generation cancelled by user')
        : current.t('narration.generationComplete', 'Narration generation complete'));
      if (current.useGroupedSubtitles && current.groupedSubtitles?.length > 0) {
        current.setUseGroupedSubtitles(true);
      }
      return true;
    } catch (error) {
      if (!ownsProjectAuthority(authority)
          || error?.code === 'activeProjectChanged'
          || error?.code === 'projectChanged'
          || error?.code === 'staleProjectVersion') {
        const latest = getActiveProjectSnapshot();
        if (latest?.metadata?.id === authority.projectId) {
          current.setGenerationResults((previous) => finalizeRequestedResults(
            previous,
            [],
            subtitles,
            'activeProjectChanged',
          ));
          current.setError(current.t(
            'errors.activeProjectChanged',
            'The active subtitle project changed.',
          ));
        }
        return false;
      }
      if (error?.code === 'speechRuntimeStopped') {
        current.setGenerationResults((previous) => finalizeRequestedResults(
          previous,
          [],
          subtitles,
          'speechRuntimeStopped',
        ));
        current.setError(current.t(
          'narration.engineUnavailableMessage',
          'This narration engine is not ready. Install or start it in Settings > Tools.'
        ));
        return false;
      }
      if (error?.code === 'narrationPersistenceFailed') {
        current.setGenerationResults((previous) => finalizeRequestedResults(
          previous,
          [],
          subtitles,
          'narrationPersistenceFailed',
        ));
        current.setError(current.t(
          'narration.generationError',
          'Error generating narration',
        ));
        return false;
      }
      const partial = hydrateNarrationResultsForAlignment(error?.results || []);
      const next = finalizeRequestedResults(
        stagedResults,
        partial,
        subtitles,
        error?.code || 'synthesisFailed',
      );
      current.setGenerationResults(next);
      await persistNativeResults(method, next, authority, narrationSource(current)).catch(() => null);
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
      requestAlignedNarrationReset();
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
    const authority = captureProjectAuthority();
    if (!authority) return undefined;
    Promise.resolve(restorePersistedNativeNarration({
      method: current.narrationMethod,
      projectId: authority.projectId,
      expectedProjectStateVersion: authority.expectedProjectStateVersion,
      subtitles: selected,
    })).then((restored) => {
      const latest = stateRef.current;
      if (disposed
          || !restored
          || !ownsProjectAuthority(authority)
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
      claimNativeNarrationEditCommit(event?.detail, async (edits) => {
        if (editInFlightRef.current) {
          const error = new Error('Another narration edit is still being saved');
          error.code = 'narrationEditBusy';
          throw error;
        }
        editInFlightRef.current = true;
        try {
          const current = stateRef.current;
          const authority = captureProjectAuthority();
          if (!authority) throw narrationPersistenceFailed();
          const results = Array.isArray(current.generationResults)
            ? current.generationResults
            : [];
          const editsByPreviousId = new Map(edits.map((edit) => [
            edit.previousArtifactId,
            edit.replacement,
          ]));
          const replacementCounts = new Map(
            edits.map((edit) => [edit.previousArtifactId, 0]),
          );
          const next = results.map((result) => {
            const artifactId = getNativeNarrationArtifactId(result);
            const replacement = editsByPreviousId.get(artifactId);
            if (!replacement) return result;
            replacementCounts.set(artifactId, replacementCounts.get(artifactId) + 1);
            return replacement;
          });
          if ([...replacementCounts.values()].some((count) => count !== 1)) {
            const error = new Error('The narration edit target changed before it could be saved');
            error.code = 'narrationEditTargetChanged';
            throw error;
          }
          const method = edits[0]?.replacement?.method || current.narrationMethod;
          if (edits.some((edit) => (edit.replacement.method || current.narrationMethod) !== method)) {
            const error = new Error('A narration edit transaction cannot mix generation methods');
            error.code = 'narrationEditMethodChanged';
            throw error;
          }
          const persisted = await persistNativeResults(
            method,
            next,
            authority,
            narrationSource(current),
          );
          if (persisted === null || !ownsProjectAuthority(authority)) {
            throw narrationPersistenceFailed();
          }
          current.setGenerationResults(next);
          return edits.map((edit) => edit.replacement);
        } finally {
          editInFlightRef.current = false;
        }
      });
    };
    window.addEventListener(NATIVE_NARRATION_EDIT_COMMIT_EVENT, handleEdit);
    return () => window.removeEventListener(NATIVE_NARRATION_EDIT_COMMIT_EVENT, handleEdit);
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
