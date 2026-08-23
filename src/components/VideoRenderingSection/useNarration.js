import { useState } from 'react';

import {
  buildStrictNativeNarrationPlan,
  createNativeNarrationPlanKey,
  NarrationAlignmentInputError,
} from '../../utils/narrationAlignmentUtils';

const firstArray = (...candidates) => (
  candidates.find((candidate) => Array.isArray(candidate) && candidate.length > 0) || []
);

/**
 * Select one narration result set and the exact cue plan it was generated from.
 *
 * The source choice is explicit. It must never be inferred from whichever global collection happens
 * to be non-empty, because an original track left in memory is not evidence that it belongs to the
 * translated or grouped subtitles currently selected for export.
 */
export const resolveCurrentNarrationInputs = ({
  narrationResults,
  subtitlesData,
  translatedSubtitles,
  selectedSubtitles,
}) => {
  if (window.useGroupedSubtitles === true) {
    return Object.freeze({
      results: firstArray(window.groupedNarrations),
      cues: firstArray(window.groupedSubtitles),
      source: 'grouped',
    });
  }
  if (selectedSubtitles === 'translated') {
    return Object.freeze({
      results: firstArray(window.translatedNarrations),
      cues: firstArray(translatedSubtitles, window.translatedSubtitles),
      source: 'translated',
    });
  }
  return Object.freeze({
    results: firstArray(window.originalNarrations, narrationResults),
    cues: firstArray(subtitlesData, window.originalSubtitles, window.subtitlesData),
    source: 'original',
  });
};

const unavailable = () => new NarrationAlignmentInputError(
  'narrationArtifactUnavailable',
  'Generated narration is selected, but no aligned native narration exists for the current subtitles.',
);

/** Generated narration is an all-or-nothing render input, never an optional best-effort layer. */
export const requireGeneratedNarrationArtifact = (selection, artifactId) => {
  if (selection === 'generated' && !artifactId) throw unavailable();
  return selection === 'generated' ? artifactId : null;
};

export const useNarration = ({
  selectedNarration,
  narrationResults,
  subtitlesData,
  translatedSubtitles,
  selectedSubtitles,
}) => {
  const [isRefreshingNarration, setIsRefreshingNarration] = useState(false);

  const currentInputs = () => resolveCurrentNarrationInputs({
    narrationResults,
    subtitlesData,
    translatedSubtitles,
    selectedSubtitles,
  });
  const currentPlan = () => {
    const { results, cues } = currentInputs();
    return buildStrictNativeNarrationPlan(results, cues);
  };

  const currentNarrationResults = currentInputs().results;

  const isAlignedNarrationAvailable = () => {
    try {
      const cache = window.alignedNarrationCache;
      const plan = currentPlan();
      return Boolean(
        cache?.url
        && cache.nativeArtifactId
        && cache.alignmentKey === createNativeNarrationPlanKey(plan),
      );
    } catch {
      return false;
    }
  };

  const hasNarrationSegments = () => {
    try {
      currentPlan();
      return true;
    } catch {
      return false;
    }
  };

  const ensureCurrentAlignment = async (narrationSelection = selectedNarration) => {
    if (narrationSelection !== 'generated') return Object.freeze({ artifactId: null, url: null });
    const { results, cues } = currentInputs();
    const plan = buildStrictNativeNarrationPlan(results, cues);
    const service = await import('../../services/alignedNarrationService.js');

    let artifactId = service.getAlignedNarrationArtifactIdForPlan(plan);
    let url = service.getAlignedNarrationUrlForPlan(plan);
    if (!artifactId || !url) {
      await service.generateAlignedNarration(results, cues);
      artifactId = service.getAlignedNarrationArtifactIdForPlan(plan);
      url = service.getAlignedNarrationUrlForPlan(plan);
    }
    if (!artifactId || !url) throw unavailable();
    return Object.freeze({ artifactId, url });
  };

  const getNarrationAudioUrl = async (narrationSelection = selectedNarration) => (
    (await ensureCurrentAlignment(narrationSelection)).url
  );

  const getNarrationArtifactId = async (narrationSelection = selectedNarration) => (
    requireGeneratedNarrationArtifact(
      narrationSelection,
      (await ensureCurrentAlignment(narrationSelection)).artifactId,
    )
  );

  const handleRefreshNarration = async () => {
    if (isRefreshingNarration) return;
    try {
      setIsRefreshingNarration(true);
      const { results, cues } = currentInputs();
      const plan = buildStrictNativeNarrationPlan(results, cues);
      const service = await import('../../services/alignedNarrationService.js');
      service.resetAlignedNarration();
      await service.generateAlignedNarration(results, cues);
      const url = service.getAlignedNarrationUrlForPlan(plan);
      if (!url) throw unavailable();
      window.dispatchEvent(new CustomEvent('aligned-narration-ready', {
        detail: { url, timestamp: Date.now() },
      }));
    } catch (error) {
      window.dispatchEvent(new CustomEvent('aligned-narration-status', {
        detail: {
          status: 'error',
          message: error.message || 'Failed to refresh narration',
          isStillGenerating: false,
        },
      }));
    } finally {
      setIsRefreshingNarration(false);
    }
  };

  return {
    isRefreshingNarration,
    currentNarrationResults,
    isAlignedNarrationAvailable,
    hasNarrationSegments,
    getNarrationAudioUrl,
    getNarrationArtifactId,
    handleRefreshNarration,
  };
};

export default useNarration;
