import { useEffect } from 'react';
import { showErrorToast, showInfoToast } from '../../../utils/toastUtils';
import { acknowledgeJobResult } from '../../../platform/jobResultDeliveryService';
import { nativeNarrationAdapter } from '../../../platform/nativeNarrationAdapter';
import { getActiveProjectSnapshot } from '../../../platform/projectService';

const referenceTextTails = new Map();

/**
 * Build a setReferenceText wrapper that serializes edits into the project-owned native record.
 *
 * @param {Object} params
 * @param {Object} params.referenceAudio - Current reference audio object (or null)
 * @param {Function} params.setReferenceText - State setter for reference text
 * @returns {Function} setReferenceTextWithCache(newText)
 */
export const createSetReferenceTextWithCache = ({
  referenceAudio,
  setReferenceAudio,
  setReferenceText,
}) => (newText) => {
  setReferenceText(newText);
  if (!referenceAudio?.projectId || !referenceAudio?.nativeArtifactId
      || !Number.isSafeInteger(referenceAudio.referenceVersion)) return Promise.resolve();
  const text = typeof newText === 'string' ? newText : '';
  setReferenceAudio?.((previous) => previous?.nativeArtifactId === referenceAudio.nativeArtifactId
    ? { ...previous, text }
    : previous);
  const previousTail = referenceTextTails.get(referenceAudio.projectId) ?? Promise.resolve();
  const operation = previousTail.catch(() => undefined).then(async () => {
    const active = getActiveProjectSnapshot();
    if (active?.metadata?.id !== referenceAudio.projectId) return;
    let stored = await nativeNarrationAdapter.getReference(referenceAudio.projectId);
    if (!stored || stored.nativeArtifactId !== referenceAudio.nativeArtifactId) {
      if (stored) await nativeNarrationAdapter.releasePlayback(stored).catch(() => undefined);
      return;
    }
    await nativeNarrationAdapter.releasePlayback(stored).catch(() => undefined);
    if (stored.pendingDelivery) {
      await acknowledgeJobResult(
        stored.pendingDelivery.jobId,
        stored.pendingDelivery.deliveryId,
      );
      const latest = getActiveProjectSnapshot();
      if (latest?.metadata?.id !== referenceAudio.projectId) return;
      stored = {
        ...stored,
        ...(await nativeNarrationAdapter.commitReference({
          projectId: referenceAudio.projectId,
          expectedProjectStateVersion: latest.stateVersion,
          expectedReferenceVersion: stored.referenceVersion,
          artifactId: stored.nativeArtifactId,
          transcript: stored.text,
          language: stored.language,
          deliveryJobId: null,
          deliveryId: null,
        })),
        pendingDelivery: null,
      };
    }
    const latest = getActiveProjectSnapshot();
    if (latest?.metadata?.id !== referenceAudio.projectId) return;
    const committed = await nativeNarrationAdapter.commitReference({
      projectId: referenceAudio.projectId,
      expectedProjectStateVersion: latest.stateVersion,
      expectedReferenceVersion: stored.referenceVersion,
      artifactId: stored.nativeArtifactId,
      transcript: text,
      language: stored.language,
      deliveryJobId: null,
      deliveryId: null,
    });
    setReferenceAudio?.((current) => current?.nativeArtifactId === stored.nativeArtifactId
      && current.text === text
      ? {
        ...current,
        referenceVersion: committed.referenceVersion,
        projectStateVersion: latest.stateVersion,
        pendingDelivery: null,
      }
      : current);
  });
  referenceTextTails.set(referenceAudio.projectId, operation);
  const cleanup = () => {
    if (referenceTextTails.get(referenceAudio.projectId) === operation) {
      referenceTextTails.delete(referenceAudio.projectId);
    }
  };
  void operation.then(cleanup, (error) => {
    cleanup();
    showErrorToast(error?.message || 'The reference transcript could not be saved');
  });
  return operation;
};

/**
 * Local side-effects for the unified narration orchestrator: method-switch reset and toast
 * dispatch for errors / generation status. Extracted to keep useUnifiedNarration lean.
 *
 * @param {Object} params - Parameters
 * @param {string} params.narrationMethod - Active narration method
 * @param {Function} params.setGenerationStatus - Setter for generation status message
 * @param {Function} params.setError - Setter for error message
 * @param {Object} params.sectionRef - Ref to the section element
 * @param {string} params.error - Current error message
 * @param {boolean} params.isGenerating - Whether generation is in progress
 * @param {string|number|null} params.retryingSubtitleId - Subtitle id currently retrying
 * @param {string} params.generationStatus - Generation status message
 * @returns {void}
 */
const useNarrationEffects = ({
  narrationMethod,
  setGenerationStatus,
  setError,
  sectionRef,
  error,
  isGenerating,
  retryingSubtitleId,
  generationStatus
}) => {
  // Reset UI state when switching narration methods, but preserve results for aligned narration
  useEffect(() => {
    // Clear status and error messages, but don't clear generation results
    // This ensures aligned narration can still access the results
    setGenerationStatus('');
    setError('');

    // Remove any generating classes
    if (sectionRef.current) {
      sectionRef.current.classList.remove('f5tts-generating', 'gemini-generating');
    }
  }, [narrationMethod, setGenerationStatus, setError, sectionRef]);

  // Dispatch toast notifications for errors
  useEffect(() => {
    if (error) {
      showErrorToast(error);
    }
  }, [error]);

  // Dispatch toast notifications for generation status
  useEffect(() => {
    if ((isGenerating || retryingSubtitleId) && generationStatus) {
      // The message is already localized, so its wording cannot be used as a state machine.
      // Keep one bounded progress notification alive while work is active; each update replaces it.
      showInfoToast(generationStatus, 12000, 'narration-generation-progress');
    }
  }, [generationStatus, isGenerating, retryingSubtitleId]);
};

export default useNarrationEffects;
