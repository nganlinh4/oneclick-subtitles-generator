import {
  buildStrictNativeNarrationPlan,
} from '../../utils/narrationAlignmentUtils';

/**
 * Rebuild the preview track from one explicit result set and its exact current cue plan.
 *
 * The caller owns source selection because it owns the visible subtitles. This function will not
 * scan browser globals, manufacture successful rows, derive grouped timing, or substitute a five-
 * second interval when that selection is incomplete.
 */
export const narrationRefreshHandler = async ({
  videoRef,
  setIsRefreshingNarration,
  t,
  generationResults,
  currentCues,
}) => {
  const wasPlaying = Boolean(videoRef.current && !videoRef.current.paused);
  try {
    if (wasPlaying) videoRef.current.pause();
    setIsRefreshingNarration(true);

    const plan = buildStrictNativeNarrationPlan(generationResults, currentCues);
    const service = await import('../../services/alignedNarrationService.js');
    service.resetAlignedNarration();
    await service.generateAlignedNarration(generationResults, currentCues);
    const url = service.getAlignedNarrationUrlForPlan(plan);
    if (!url) {
      throw new Error(t(
        'errors.noNarrationResults',
        'No aligned native narration exists for the current subtitles.',
      ));
    }

    window.dispatchEvent(new CustomEvent('aligned-narration-ready', {
      detail: { mode: 'timeline', url, timestamp: Date.now() },
    }));
    window.dispatchEvent(new CustomEvent('aligned-narration-status', {
      detail: {
        status: 'complete',
        message: 'Aligned narration generation complete',
        isStillGenerating: false,
        available: true,
        mode: 'timeline',
        timestamp: Date.now(),
      },
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
    if (wasPlaying && videoRef.current) {
      videoRef.current.play().catch(() => undefined);
    }
  }
};
