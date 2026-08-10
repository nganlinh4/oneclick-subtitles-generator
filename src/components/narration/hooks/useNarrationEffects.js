import { useEffect } from 'react';
import { showErrorToast, showInfoToast } from '../../../utils/toastUtils';
import { cacheReferenceAudio } from './referenceAudioCache';

/**
 * Build a setReferenceText wrapper that also refreshes the reference-audio localStorage cache.
 *
 * Extracted from useUnifiedNarration to keep that orchestrator under the size budget. Reuses the
 * shared cacheReferenceAudio helper instead of re-implementing media-id resolution inline.
 *
 * @param {Object} params
 * @param {Object} params.referenceAudio - Current reference audio object (or null)
 * @param {Function} params.setReferenceText - State setter for reference text
 * @returns {Function} setReferenceTextWithCache(newText)
 */
export const createSetReferenceTextWithCache = ({ referenceAudio, setReferenceText }) => (newText) => {
  setReferenceText(newText);

  // Update reference audio cache if we have reference audio
  if (referenceAudio) {
    cacheReferenceAudio({
      ...referenceAudio,
      text: newText || '',
    }, 'reference text change');
  }
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
      // Set different durations based on status message type
      let duration = 6000; // Default duration

      // 15 seconds for warming up and initializing messages
      if (generationStatus.includes('Warming up') || generationStatus.includes('initializingService') ||
          generationStatus.includes('Waking up')) {
        duration = 15000;
      }
      // 12 seconds for progress messages
      else if (generationStatus.includes('Generating') || generationStatus.includes('Generated') ||
               generationStatus.includes('chatterboxGeneratingProgress')) {
        duration = 12000;
      }

      showInfoToast(generationStatus, duration);
    }
  }, [generationStatus, isGenerating, retryingSubtitleId]);
};

export default useNarrationEffects;
