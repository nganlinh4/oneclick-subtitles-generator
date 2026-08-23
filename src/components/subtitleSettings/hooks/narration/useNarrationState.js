import { useState, useEffect } from 'react';

/**
 * Hook to manage narration state
 *
 * @param {Array} originalNarrations - Original narration audio files
 * @param {Array} translatedNarrations - Translated narration audio files
 * @returns {Object} - Narration state and setters
 */
const useNarrationState = (originalNarrations = [], translatedNarrations = []) => {
  // State for narration menu
  const [showNarrationMenu, setShowNarrationMenu] = useState(false);
  // Always use 'original' as the narration source since we no longer have a source selector
  const [narrationSource, setNarrationSource] = useState('original');
  const [narrationVolume, setNarrationVolume] = useState(1.0);
  const [videoVolume, setVideoVolume] = useState(1.0);
  const [currentNarration, setCurrentNarration] = useState(null);

  // State to track narrations internally
  const [internalOriginalNarrations, setInternalOriginalNarrations] = useState(originalNarrations || []);
  const [internalTranslatedNarrations, setInternalTranslatedNarrations] = useState(translatedNarrations || []);

  // Update internal state when props change
  useEffect(() => {
    setInternalOriginalNarrations(Array.isArray(originalNarrations) ? originalNarrations : []);
    setInternalTranslatedNarrations(Array.isArray(translatedNarrations) ? translatedNarrations : []);
  }, [originalNarrations, translatedNarrations]);

  // Check if any narrations are available
  const hasOriginalNarrations = internalOriginalNarrations.length > 0;
  const hasTranslatedNarrations = internalTranslatedNarrations.length > 0;
  const hasAnyNarrations = hasOriginalNarrations || hasTranslatedNarrations;

  return {
    showNarrationMenu,
    setShowNarrationMenu,
    narrationSource,
    setNarrationSource,
    narrationVolume,
    setNarrationVolume,
    videoVolume,
    setVideoVolume,
    currentNarration,
    setCurrentNarration,
    internalOriginalNarrations,
    setInternalOriginalNarrations,
    internalTranslatedNarrations,
    setInternalTranslatedNarrations,
    hasOriginalNarrations,
    hasTranslatedNarrations,
    hasAnyNarrations
  };
};

export default useNarrationState;
