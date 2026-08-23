import { useEffect } from 'react';
import { enhanceF5TTSNarrations } from '../../../utils/narrationEnhancer';
import { loadProjectSubtitleGrouping } from '../../../platform/projectSubtitleGroupingStore';

/**
 * Custom hook for managing window state objects for narration
 * @param {Object} params - Parameters
 * @param {Array} params.generationResults - Current generation results
 * @param {string} params.subtitleSource - Selected subtitle source
 * @param {string} params.narrationMethod - Selected narration method
 * @param {Array} params.originalSubtitles - Original subtitles
 * @param {Array} params.translatedSubtitles - Translated subtitles
 * @param {Array} params.subtitles - Fallback subtitles
 * @param {boolean} params.useGroupedSubtitles - Whether to use grouped subtitles
 * @param {Array} params.groupedSubtitles - Grouped subtitles
 * @param {Function} params.setGroupedSubtitles - Function to set grouped subtitles
 * @param {Function} params.setUseGroupedSubtitles - Function to set use grouped subtitles state
 * @param {string} params.groupingIntensity - Grouping intensity level
 */
const useWindowStateManager = ({
  generationResults,
  subtitleSource,
  narrationMethod,
  originalSubtitles,
  translatedSubtitles,
  subtitles,
  useGroupedSubtitles,
  groupedSubtitles,
  setGroupedSubtitles,
  setUseGroupedSubtitles,
  groupingIntensity
}) => {
  // Update global window objects when generation results change
  useEffect(() => {
    // Ensure the global window objects have the latest narration results
    // This is critical for the aligned narration feature to work
    if (generationResults && generationResults.length > 0) {
      if (subtitleSource === 'original') {
        // If this is F5-TTS narration (not Gemini), enhance with timing information
        if (narrationMethod === 'f5tts') {
          // Get subtitles for enhancing narrations with timing information
          const subtitlesForEnhancement = originalSubtitles || subtitles || [];

          // Enhance F5-TTS narrations with timing information from subtitles
          const enhancedNarrations = enhanceF5TTSNarrations(generationResults, subtitlesForEnhancement);
          window.originalNarrations = [...enhancedNarrations];
        } else {
          // For Gemini narrations, just use as is (they already have timing info)
          window.originalNarrations = [...generationResults];
        }
      } else if (subtitleSource === 'translated') {
        // For translated narrations, similar enhancement if needed
        if (narrationMethod === 'f5tts') {
          // Get subtitles for enhancing narrations with timing information
          const subtitlesForEnhancement = translatedSubtitles || [];

          // Enhance F5-TTS narrations with timing information from subtitles
          const enhancedNarrations = enhanceF5TTSNarrations(generationResults, subtitlesForEnhancement);
          window.translatedNarrations = [...enhancedNarrations];
        } else {
          // For Gemini narrations, just use as is
          window.translatedNarrations = [...generationResults];
        }
      }
    }
  }, [generationResults, subtitleSource, narrationMethod, originalSubtitles, translatedSubtitles, subtitles]);

  // Hydrate only an exact project/source-owned grouping. The durable store also consumes a pending
  // native delivery left behind by a crash after commit but before acknowledgement.
  useEffect(() => {
    const sourceType = subtitleSource === 'translated' ? 'translated' : 'original';
    const sourceSubtitles = sourceType === 'translated'
      ? translatedSubtitles
      : originalSubtitles || subtitles;
    if (!Array.isArray(sourceSubtitles) || sourceSubtitles.length === 0) {
      setGroupedSubtitles(null);
      setUseGroupedSubtitles(false);
      window.groupedSubtitles = null;
      window.useGroupedSubtitles = false;
      return undefined;
    }
    let disposed = false;
    void loadProjectSubtitleGrouping({
      sourceType,
      subtitles: sourceSubtitles,
      intensity: groupingIntensity,
    }).then((loaded) => {
      if (disposed) return;
      if (loaded === null) {
        setGroupedSubtitles(null);
        setUseGroupedSubtitles(false);
        window.groupedSubtitles = null;
        window.useGroupedSubtitles = false;
        return;
      }
      setGroupedSubtitles(loaded.groupedSubtitles);
      setUseGroupedSubtitles(true);
      window.groupedSubtitles = loaded.groupedSubtitles;
      window.useGroupedSubtitles = true;
    }).catch((error) => {
      if (!disposed) {
        setGroupedSubtitles(null);
        setUseGroupedSubtitles(false);
        window.groupedSubtitles = null;
        window.useGroupedSubtitles = false;
        console.error('Could not hydrate project subtitle grouping:', error);
      }
    });
    return () => { disposed = true; };
  }, [
    groupingIntensity,
    originalSubtitles,
    setGroupedSubtitles,
    setUseGroupedSubtitles,
    subtitleSource,
    subtitles,
    translatedSubtitles,
    useGroupedSubtitles,
  ]);

  // Save subtitle source to localStorage when it changes
  useEffect(() => {
    if (subtitleSource) {
      try {
        localStorage.setItem('subtitle_source', subtitleSource);
      } catch (error) {
        console.error('Error saving subtitle source to localStorage:', error);
      }
    }
  }, [subtitleSource]);

  // Effect to update window variables for subtitle grouping
  useEffect(() => {
    // Make grouped subtitles available to the narration service
    window.useGroupedSubtitles = useGroupedSubtitles;
    window.groupedSubtitles = groupedSubtitles;

  }, [useGroupedSubtitles, groupedSubtitles]);

  // Clear grouped subtitles when the original timeline is fully cleared
  // This ensures the Narration planned list disappears when user deletes all subtitles via the timeline action
  useEffect(() => {
    const onTimingChanged = (event) => {
      try {
        const detail = event?.detail || {};
        const updated = detail.updatedLyrics;
        // Only react when timeline reports a clear-range that results in zero subtitles
        if (detail.action === 'clear-range' && Array.isArray(updated) && updated.length === 0) {
          // Only clear grouping when the narration source is the original subtitles
          if (subtitleSource === 'original') {
            // Reset state
            setGroupedSubtitles(null);
            setUseGroupedSubtitles(false);
            // Reset globals used by some result components
            window.groupedSubtitles = null;
            window.useGroupedSubtitles = false;
            // Also clear global originals that some components use as fallback
            window.originalSubtitles = [];
            window.subtitlesData = [];
          }
        }
      } catch (e) {
        // Non-fatal; ignore
      }
    };

    window.addEventListener('subtitle-timing-changed', onTimingChanged);
    return () => window.removeEventListener('subtitle-timing-changed', onTimingChanged);
  }, [subtitleSource, setGroupedSubtitles, setUseGroupedSubtitles]);

  // Listen for translation reset to clear grouped subtitles cache
  useEffect(() => {
    const handleTranslationReset = () => {

      // Clear the grouped subtitles state if we're using translated subtitles
      if (subtitleSource === 'translated') {
        setGroupedSubtitles(null);
        setUseGroupedSubtitles(false);
      }
    };

    const handleTranslationUpdated = (_event) => {
      // Clear the grouped subtitles state if we're using translated subtitles
      if (subtitleSource === 'translated') {
        setGroupedSubtitles(null);
        // Don't disable grouping, just clear the current grouped subtitles
        // so they can be regenerated with the updated translations
      }
    };

    window.addEventListener('translation-reset', handleTranslationReset);
    window.addEventListener('translation-updated', handleTranslationUpdated);

    return () => {
      window.removeEventListener('translation-reset', handleTranslationReset);
      window.removeEventListener('translation-updated', handleTranslationUpdated);
    };
  }, [subtitleSource, setGroupedSubtitles, setUseGroupedSubtitles]);

  // Reset UI state when switching narration methods, but preserve results for aligned narration
  useEffect(() => {
    // IMPORTANT: We intentionally do NOT clear generationResults here
    // This is to ensure that the aligned narration feature can still access
    // the narration results when the user clicks the "Refresh Narration" button
    // in the video player. If we cleared the results, the aligned narration
    // would fail with "no narration results available" error.

    // Ensure the global window objects have the latest narration results
    // This is critical for the aligned narration feature to work
    if (generationResults && generationResults.length > 0) {
      if (subtitleSource === 'original') {
        window.originalNarrations = [...generationResults];
      } else if (subtitleSource === 'translated') {
        window.translatedNarrations = [...generationResults];
      }
    }
  }, [narrationMethod, generationResults, subtitleSource]);
};

export default useWindowStateManager;
