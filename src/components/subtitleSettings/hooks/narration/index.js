import { useState } from 'react';
import useNarrationState from './useNarrationState';
import useNarrationEffects from './useNarrationEffects';
import useAlignedNarration from './useAlignedNarration';
import useAlignedNarrationState from './useAlignedNarrationState';
import useAlignedNarrationGeneration from './useAlignedNarrationGeneration';
import useAlignedNarrationPlayback from './useAlignedNarrationPlayback';
import useAlignedNarrationEvents from './useAlignedNarrationEvents';
import * as alignedNarrationUtils from './alignedNarrationUtils';

/**
 * Custom hook for managing narration playback
 *
 * @param {Object} videoRef - Reference to the video element
 * @param {Array} originalNarrations - Original narration audio files
 * @param {Array} translatedNarrations - Translated narration audio files
 * @returns {Object} - Narration state and handlers
 */
const useNarration = (videoRef, originalNarrations = [], translatedNarrations = []) => {
  // Get basic narration state
  const narrationState = useNarrationState(originalNarrations, translatedNarrations);

  // Always use aligned narration mode
  const [useAlignedMode] = useState(true);

  // Handle narration effects (only for video volume)
  useNarrationEffects(
    videoRef,
    narrationState.videoVolume,
    narrationState.narrationVolume,
    null, // No audioRefs needed
    narrationState.hasOriginalNarrations,
    narrationState.hasTranslatedNarrations,
    null, // No currentNarration needed
    narrationState.setNarrationSource
  );

  // Always use original narrations since we removed the source selector
  const activeNarrations = narrationState.internalOriginalNarrations;

  // Handle aligned narration
  const alignedNarration = useAlignedNarration(
    videoRef,
    activeNarrations,
    narrationState.narrationVolume,
    useAlignedMode
  );

  return {
    ...narrationState,
    // No individual narration playback anymore
    currentNarration: null, // Always null since we only use aligned narration
    setCurrentNarration: () => {}, // Empty function since we don't use it anymore
    // Add aligned narration state and handlers
    useAlignedMode: true, // Always true
    ...alignedNarration
  };
};

// Export all hooks
export {
  useAlignedNarration,
  useAlignedNarrationState,
  useAlignedNarrationGeneration,
  useAlignedNarrationPlayback,
  useAlignedNarrationEvents,
  alignedNarrationUtils
};

export default useNarration;
