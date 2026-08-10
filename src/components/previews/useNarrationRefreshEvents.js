import { useEffect } from 'react';
import { dbg } from './videoPreviewDebug';

/**
 * Owns the aligned-narration event wiring for the video preview:
 *   - listens for `aligned-narration-status` and
 *     `aligned-narration-generating-state` window events to clear the
 *     "refreshing narration" overlay when regeneration finishes/errors;
 *   - cleans up aligned-narration audio resources on unmount.
 *
 * The overlay state (isRefreshingNarration / setIsRefreshingNarration) stays in
 * the parent and is passed in.
 */
const useNarrationRefreshEvents = ({ isRefreshingNarration, setIsRefreshingNarration }) => {
  // Listen for aligned narration generation events
  useEffect(() => {
    // Function to handle aligned narration status updates
    const handleAlignedNarrationStatus = (event) => {
      if (event.detail) {
        const { status, message, isStillGenerating } = event.detail;

        // If the status is 'complete' and isStillGenerating is false, the narration regeneration is fully done
        if (status === 'complete' && !isStillGenerating) {

          setIsRefreshingNarration(false);
        }

        // If the status is 'error' and isStillGenerating is false, there was an error during regeneration
        if (status === 'error' && !isStillGenerating) {
          console.error('Error during aligned narration regeneration:', message);
          setIsRefreshingNarration(false);
        }

        // If isStillGenerating is true, keep the overlay visible
        if (isStillGenerating) {
          // No state transition is needed while generation remains active.
        }
      }
    };

    // Function to handle aligned narration generation state changes
    const handleAlignedNarrationGeneratingState = (event) => {
      if (event.detail) {
        const { isGenerating } = event.detail;

        // If isGenerating is false, the narration generation is complete
        if (!isGenerating && !isRefreshingNarration) {
          return; // No need to update if we're not refreshing
        }

        if (!isGenerating) {

          setIsRefreshingNarration(false);
        }
      }
    };

    // Add event listeners
    window.addEventListener('aligned-narration-status', handleAlignedNarrationStatus);
    window.addEventListener('aligned-narration-generating-state', handleAlignedNarrationGeneratingState);

    // Clean up event listeners
    return () => {
      window.removeEventListener('aligned-narration-status', handleAlignedNarrationStatus);
      window.removeEventListener('aligned-narration-generating-state', handleAlignedNarrationGeneratingState);
    };
  }, [isRefreshingNarration, setIsRefreshingNarration]);

  // The duplicate event listener for aligned-narration-status has been removed
  // We're now only using the more comprehensive listener above that includes isStillGenerating

  // Clean up aligned narration resources when component unmounts
  useEffect(() => {
    return () => {
      // Clean up aligned narration audio
      if (typeof window.resetAlignedNarration === 'function') {
        window.resetAlignedNarration();
      }

      // Also clean up any other audio elements that might be playing
      if (window.alignedAudioElement) {
        try {
          dbg('Cleaning up alignedAudioElement on component unmount');
          window.alignedAudioElement.pause();
          window.alignedAudioElement.src = '';
          window.alignedAudioElement.load();
          window.alignedAudioElement = null;
        } catch (e) {
          console.warn('Error cleaning up window.alignedAudioElement on unmount:', e);
        }
      }
    };
  }, []);
};

export default useNarrationRefreshEvents;
