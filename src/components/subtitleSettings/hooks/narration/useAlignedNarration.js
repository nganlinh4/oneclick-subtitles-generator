import { useEffect } from 'react';

// Import modular hooks
import useAlignedNarrationState from './useAlignedNarrationState';
import useAlignedNarrationGeneration from './useAlignedNarrationGeneration';
import useAlignedNarrationPlayback from './useAlignedNarrationPlayback';
import useAlignedNarrationEvents from './useAlignedNarrationEvents';

/**
 * Hook to manage aligned narration playback
 *
 * @param {Object} videoRef - Reference to the video element
 * @param {Array} generationResults - Array of narration results
 * @param {number} narrationVolume - Volume level for narration
 * @param {boolean} useAlignedMode - Whether to use aligned narration mode
 * @returns {Object} - Aligned narration state and handlers
 */
const useAlignedNarration = (
  videoRef,
  generationResults,
  narrationVolume,
  useAlignedMode,
  currentCues,
) => {
  // Use the state management hook
  const state = useAlignedNarrationState();

  // Use the generation hook
  const { regenerateAlignedNarration } = useAlignedNarrationGeneration({
    videoRef,
    generationResults,
    currentCues,
    useAlignedMode,
    state
  });

  // Use the playback hook
  useAlignedNarrationPlayback({
    videoRef,
    useAlignedMode,
    state
  });

  // Use the events hook
  useAlignedNarrationEvents({
    videoRef,
    generationResults,
    useAlignedMode,
    state,
    regenerateAlignedNarration
  });

  // Update volume when it changes
  useEffect(() => {
    state.setAlignedNarrationVolume(narrationVolume);
  }, [narrationVolume, state]);

  // Clean up resources when component unmounts
  useEffect(() => {
    return () => {
      // Clear any existing timeout
      if (state.regenerationTimeoutRef.current) {
        clearTimeout(state.regenerationTimeoutRef.current);
      }

      // When unmounting, we want to preserve both the audio element and the cache for reuse
      state.cleanupAlignedNarration(true, true);
    };
  }, [state]);

  return {
    isGeneratingAligned: state.isGeneratingAligned,
    alignedStatus: state.alignedStatus,
    isAlignedAvailable: state.isAlignedAvailable,
    regenerateAlignedNarration
  };
};

export default useAlignedNarration;
