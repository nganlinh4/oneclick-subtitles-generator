import { useEffect } from 'react';

/**
 * Hook to handle narration side effects
 *
 * @param {Object} videoRef - Reference to the video element
 * @param {number} videoVolume - Volume level for video
 * @param {number} narrationVolume - Volume level for narration
 * @param {Object} audioRefs - References to audio elements
 * @param {boolean} hasOriginalNarrations - Whether original narrations are available
 * @param {boolean} hasTranslatedNarrations - Whether translated narrations are available
 * @param {Object} currentNarration - Current narration being played
 * @param {Function} setNarrationSource - Setter for narration source
 */
const useNarrationEffects = (
  videoRef,
  videoVolume,
  narrationVolume,
  audioRefs,
  hasOriginalNarrations,
  hasTranslatedNarrations,
  currentNarration,
  _setNarrationSource
) => {
  // We no longer need to set narration source based on availability
  // since we always use 'original' as the source
  useEffect(() => {
    // Stop any currently playing narration if no narrations are available
    if (!hasOriginalNarrations && !hasTranslatedNarrations) {
      // Also stop any currently playing narration
      if (currentNarration && audioRefs && audioRefs.current && audioRefs.current[currentNarration.subtitle_id]) {
        audioRefs.current[currentNarration.subtitle_id].pause();
      }
    }
  }, [
    hasOriginalNarrations,
    hasTranslatedNarrations,
    currentNarration,
    audioRefs
  ]);

  // Update video volume when it changes
  useEffect(() => {
    if (videoRef && videoRef.current) {
      videoRef.current.volume = videoVolume;
    }
  }, [videoVolume, videoRef]);

  // Update all audio volumes when narration volume changes
  useEffect(() => {
    if (audioRefs && audioRefs.current) {
      Object.values(audioRefs.current).forEach(audio => {
        audio.volume = narrationVolume;
      });
    }
  }, [narrationVolume, audioRefs]);
};

export default useNarrationEffects;
