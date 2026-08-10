/**
 * Hook for handling aligned narration generation
 */
import { useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  // isAlignedNarrationAvailable is imported but not used
  // isAlignedNarrationAvailable,
  generateAlignedNarration as generateAlignedNarrationService,
  resetAlignedAudioElement
} from '../../../../services/alignedNarrationService';
import {
  // createHash is imported but not used
  // createHash,
  enhanceNarrationWithTiming,
  createSubtitleMap,
  getAllSubtitles
} from './alignedNarrationUtils';
import { hydrateNarrationResultsForAlignment } from '../../../../utils/narrationAlignmentUtils';

/**
 * Hook for handling aligned narration generation
 * @param {Object} params - Parameters
 * @param {Object} params.videoRef - Reference to the video element
 * @param {Array} params.generationResults - Array of narration results
 * @param {boolean} params.useAlignedMode - Whether to use aligned narration mode
 * @param {Object} params.state - State from useAlignedNarrationState
 * @returns {Object} - Generation handlers
 */
const useAlignedNarrationGeneration = ({
  videoRef,
  generationResults,
  useAlignedMode,
  state
}) => {
  const { t } = useTranslation();
  const {
    isGeneratingAligned,
    setIsGeneratingAligned,
    // alignedStatus is destructured but not used directly
    // alignedStatus,
    setAlignedStatus,
    isAlignedAvailable,
    setIsAlignedAvailable,
    // lastGenerationResultsHashRef is destructured but not used directly
    // lastGenerationResultsHashRef,
    playAlignedNarration,
    // cleanupAlignedNarration is destructured but not used directly
    // cleanupAlignedNarration
  } = state;

  // Force regeneration of aligned narration
  const regenerateAlignedNarration = useCallback(async () => {
    // Prevent multiple simultaneous generation attempts
    if (isGeneratingAligned) {

      return;
    }

    // Check if we have narration results to work with
    if (!generationResults || generationResults.length === 0) {
      console.error('Cannot generate aligned narration: no narration results available');

      // Get localized error message
      const localizedMessage = t('errors.noNarrationResults', 'No narration results to generate aligned audio');

      // Set the status to error
      setAlignedStatus({
        status: 'error',
        message: localizedMessage
      });

      // Dispatch events to clear the overlay
      window.dispatchEvent(new CustomEvent('aligned-narration-status', {
        detail: {
          status: 'error',
          message: localizedMessage,
          isStillGenerating: false
        }
      }));

      // Also dispatch the generating-state event to ensure the overlay is removed
      window.dispatchEvent(new CustomEvent('aligned-narration-generating-state', {
        detail: {
          isGenerating: false
        }
      }));

      return;
    }

    try {
      // Update state
      setIsGeneratingAligned(true);
      setIsAlignedAvailable(false);
      setAlignedStatus({
        status: 'preparing',
        message: 'Preparing aligned narration...'
      });

      // Force reset any existing audio element to ensure we use the new one

      resetAlignedAudioElement();

      // Get all subtitles from the video for timing information
      const allSubtitles = getAllSubtitles();

      // Create a map of subtitles by ID for quick lookup
      const subtitleMap = createSubtitleMap(allSubtitles);

      // Filter generation results to only include successful ones with audio files
      // This ensures we only process narrations that actually exist
      const availableResults = hydrateNarrationResultsForAlignment(generationResults).filter(result =>
        result.success && (result.nativeArtifactId || result.filename || result.audioData)
      );

      console.log(`Aligned narration: Processing ${availableResults.length} available narrations out of ${generationResults.length} total results`);
      console.log('Available narration results:', availableResults.map(r => ({
        subtitle_id: r.subtitle_id,
        filename: r.filename,
        hasAudioData: !!r.audioData,
        original_ids: r.original_ids,
        isGrouped: r.original_ids && r.original_ids.length > 1
      })));

      // Add timing information to each available narration result
      const enhancedResults = enhanceNarrationWithTiming(availableResults, subtitleMap);



      // Generate the aligned narration with the enhanced results
      await generateAlignedNarrationService(enhancedResults, setAlignedStatus);

      // Update state
      setIsAlignedAvailable(true);

      // Dispatch an event to notify other components that the aligned narration generation is complete
      // Include isStillGenerating flag to indicate if the notification is still showing
      window.dispatchEvent(new CustomEvent('aligned-narration-status', {
        detail: {
          status: 'complete',
          message: 'Aligned narration generation complete',
          isStillGenerating: isGeneratingAligned // Pass the current generation state
        }
      }));

      // If the video is playing, start playing the aligned narration
      if (videoRef?.current && !videoRef.current.paused) {
        playAlignedNarration(videoRef.current.currentTime, true);
      }
    } catch (error) {
      console.error('Error generating aligned narration:', error);
      setAlignedStatus({
        status: 'error',
        message: `Error: ${error.message}`
      });

      // Dispatch an event to notify other components that there was an error during aligned narration generation
      window.dispatchEvent(new CustomEvent('aligned-narration-status', {
        detail: {
          status: 'error',
          message: `Error: ${error.message}`,
          isStillGenerating: isGeneratingAligned // Pass the current generation state
        }
      }));
    } finally {
      // Update the isGeneratingAligned state
      setIsGeneratingAligned(false);

      // Dispatch an event to notify other components that the generation state has changed
      window.dispatchEvent(new CustomEvent('aligned-narration-generating-state', {
        detail: {
          isGenerating: false
        }
      }));
    }
  }, [
    isGeneratingAligned,
    generationResults,
    setIsGeneratingAligned,
    setIsAlignedAvailable,
    setAlignedStatus,
    videoRef,
    playAlignedNarration,
    t
  ]);

  // Generate aligned narration when needed - DISABLED for automatic generation
  // Only manual generation via the "Refresh Narration" button is allowed
  useEffect(() => {
    // This effect is intentionally disabled to prevent automatic generation
    // Aligned narration will only be generated when the user clicks the "Refresh Narration" button

    // Log this only in development mode to avoid console spam
    if (process.env.NODE_ENV === 'development') {
      // Automatic-generation logging is intentionally disabled with the feature.
    }

    // No automatic generation code here - the regenerateAlignedNarration function is still available
    // for the "Refresh Narration" button to use
  }, [
    useAlignedMode,
    generationResults,
    isAlignedAvailable,
    videoRef,
    setIsGeneratingAligned,
    setAlignedStatus,
    setIsAlignedAvailable,
    playAlignedNarration
  ]);

  return {
    regenerateAlignedNarration
  };
};

export default useAlignedNarrationGeneration;
