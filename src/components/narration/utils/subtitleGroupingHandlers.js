import { DEFAULT_FAST_TEXT_MODEL_ID } from '../../../config/geminiModels';

/**
 * Handle the subtitle grouping toggle.
 *
 * Manages the `user_disabled_grouping` localStorage flag, groups subtitles via the
 * grouping service when enabled (lazily imported), and updates window-level grouped
 * subtitle state plus the parent's `setUseGroupedSubtitles` setter.
 *
 * @param {boolean} checked - New toggle state
 * @param {Object} params - Values needed to perform the grouping
 * @param {Array} params.groupedSubtitles - Existing grouped subtitles (if any)
 * @param {string} params.subtitleSource - Current subtitle source
 * @param {boolean} params.hasTranslatedSubtitles - Whether translated subtitles exist
 * @param {Array} params.translatedSubtitles - Translated subtitles
 * @param {Array} params.originalSubtitles - Original subtitles
 * @param {Object} params.translatedLanguage - Translated language info
 * @param {Object} params.originalLanguage - Original language info
 * @param {string} params.groupingIntensity - Grouping intensity level
 * @param {Function} params.setUseGroupedSubtitles - Setter for the grouping toggle
 * @returns {Promise<void>}
 */
export const handleGroupingToggle = async (checked, {
  groupedSubtitles,
  subtitleSource,
  hasTranslatedSubtitles,
  translatedSubtitles,
  originalSubtitles,
  translatedLanguage,
  originalLanguage,
  groupingIntensity,
  setUseGroupedSubtitles
}) => {
  if (checked) {
    // Clear the user disabled flag since they're turning it back on
    try {
      localStorage.removeItem('user_disabled_grouping');
    } catch (error) {
      console.error('Error clearing user disabled grouping flag:', error);
    }

    // If turning on, check if we already have grouped subtitles
    if (groupedSubtitles && groupedSubtitles.length > 0) {
      // We already have grouped subtitles, just enable the toggle
      setUseGroupedSubtitles(true);
      return;
    }

    // No existing grouped subtitles, we need to group them
    try {
      // Set grouping state to true to show loading indicator
      if (typeof window.setIsGroupingSubtitles === 'function') {
        window.setIsGroupingSubtitles(true);
      }

      // We don't need to update the local isGroupingSubtitles prop
      // as it's handled by the parent component through window.setIsGroupingSubtitles

      // Import the subtitle grouping service
      const { groupSubtitlesForNarration } = await import('../../../services/gemini/subtitleGroupingService');

      // Get the appropriate subtitles based on the selected source
      const subtitlesToGroup = subtitleSource === 'translated' && hasTranslatedSubtitles
        ? translatedSubtitles
        : originalSubtitles;

      // Get the language code for the selected subtitles
      const languageCode = subtitleSource === 'translated' && translatedLanguage
        ? translatedLanguage.languageCode
        : originalLanguage?.languageCode || 'en';

      // Group the subtitles
      const result = await groupSubtitlesForNarration(
        subtitlesToGroup,
        languageCode,
        DEFAULT_FAST_TEXT_MODEL_ID,
        groupingIntensity
      );

      // Update the grouped subtitles
      if (result && result.success && result.groupedSubtitles) {
        // Update the grouped subtitles state in the parent component
        window.groupedSubtitles = result.groupedSubtitles;
        // If the parent component provided a function to update grouped subtitles, call it
        if (typeof window.setGroupedSubtitles === 'function') {
          window.setGroupedSubtitles(result.groupedSubtitles);
        }
        setUseGroupedSubtitles(true);
      } else {
        // If grouping failed, don't enable the toggle
        setUseGroupedSubtitles(false);
      }
    } catch (error) {
      console.error('Error grouping subtitles:', error);
      setUseGroupedSubtitles(false);
    } finally {
      // Reset grouping state after a short delay to ensure the UI updates properly
      setTimeout(() => {
        if (typeof window.setIsGroupingSubtitles === 'function') {
          window.setIsGroupingSubtitles(false);
        }
      }, 500);
    }
  } else {
    // If turning off, clear the grouping data and update the state
    setUseGroupedSubtitles(false);

    // Clear the grouped subtitles data
    window.groupedSubtitles = null;
    if (typeof window.setGroupedSubtitles === 'function') {
      window.setGroupedSubtitles(null);
    }

    // Set flag to prevent auto-loading from cache
    try {
      localStorage.setItem('user_disabled_grouping', 'true');
    } catch (error) {
      console.error('Error setting user disabled grouping flag:', error);
    }
  }
};
