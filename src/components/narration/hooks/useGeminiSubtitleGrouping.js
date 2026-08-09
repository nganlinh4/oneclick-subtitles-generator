import React, { useEffect, useState } from 'react';
import { groupSubtitlesForNarration } from '../../../services/gemini/subtitleGroupingService';
import { DEFAULT_FAST_TEXT_MODEL_ID } from '../../../config/geminiModels';

/**
 * Custom hook for Gemini subtitle grouping behavior.
 * Owns the grouping action, its supporting effects, and local error state.
 * @param {Object} params - Parameters
 * @param {Function} params.setError - Function to set error message
 * @param {Function} params.setGenerationStatus - Function to set generation status
 * @param {string} params.subtitleSource - Selected subtitle source
 * @param {Array} params.originalSubtitles - Original subtitles
 * @param {Array} params.translatedSubtitles - Translated subtitles
 * @param {Array} params.subtitles - Fallback subtitles
 * @param {Object} params.originalLanguage - Original language
 * @param {Object} params.translatedLanguage - Translated language
 * @param {boolean} params.useGroupedSubtitles - Whether to use grouped subtitles for narration
 * @param {Function} params.setUseGroupedSubtitles - Function to set whether grouped subtitles are used
 * @param {Array} params.groupedSubtitles - Grouped subtitles
 * @param {Function} params.setGroupedSubtitles - Function to set grouped subtitles
 * @param {Function} params.setIsGroupingSubtitles - Function to set whether subtitles are being grouped
 * @param {string} params.groupingIntensity - Grouping intensity
 * @param {Function} params.t - Translation function
 * @returns {Object} - { groupSubtitles }
 */
const useGeminiSubtitleGrouping = ({
  setError,
  setGenerationStatus,
  subtitleSource,
  originalSubtitles,
  translatedSubtitles,
  subtitles,
  originalLanguage,
  translatedLanguage,
  useGroupedSubtitles,
  setUseGroupedSubtitles,
  groupedSubtitles,
  setGroupedSubtitles,
  setIsGroupingSubtitles,
  groupingIntensity = 'moderate',
  t
}) => {
  // Track error state locally
  const [localError, setLocalError] = useState('');

  // Function to group subtitles
  const groupSubtitles = async () => {
    if (!subtitleSource) {
      updateError(t('narration.noSourceSelectedError', 'Please select a subtitle source (Original or Translated)'));
      return false;
    }

    // Get the appropriate subtitles based on the selected source
    const selectedSubtitles = subtitleSource === 'translated' && translatedSubtitles && translatedSubtitles.length > 0
      ? translatedSubtitles
      : originalSubtitles || subtitles;

    if (!selectedSubtitles || selectedSubtitles.length === 0) {
      // If translated subtitles are selected but not available, show a specific error
      if (subtitleSource === 'translated' && (!translatedSubtitles || translatedSubtitles.length === 0)) {
        updateError(t('narration.noTranslatedSubtitlesError', 'No translated subtitles available. Please translate the subtitles first or select original subtitles.'));
      } else {
        updateError(t('narration.noSubtitlesError', 'No subtitles available for narration'));
      }
      return false;
    }

    // Set loading state
    setIsGroupingSubtitles(true);
    updateError('');

    try {
      // Get the language code for the selected subtitles
      const detectedLanguageCode = subtitleSource === 'original'
        ? (originalLanguage?.languageCode || 'en')
        : (translatedLanguage?.languageCode || 'en');

      // Group the subtitles with the selected intensity
      const groupingResult = await groupSubtitlesForNarration(
        selectedSubtitles,
        detectedLanguageCode,
        DEFAULT_FAST_TEXT_MODEL_ID,
        groupingIntensity
      );

      if (groupingResult.success && groupingResult.groupedSubtitles && groupingResult.groupedSubtitles.length > 0) {
        // Store the grouped subtitles for future use
        setGroupedSubtitles(groupingResult.groupedSubtitles);

        // Store the grouped subtitles in the window object
        window.groupedSubtitles = groupingResult.groupedSubtitles;

        // Update the window flag to indicate we're using grouped subtitles
        window.useGroupedSubtitles = true;

        // Set the useGroupedSubtitles state to true
        setUseGroupedSubtitles(true);

        // Show success message
        setGenerationStatus(
          t(
            'narration.subtitlesGrouped',
            'Grouped {{original}} subtitles into {{grouped}} fuller sentences for better narration.',
            {
              original: selectedSubtitles.length,
              grouped: groupingResult.groupedSubtitles.length
            }
          )
        );

        // Clear the status message after a few seconds
        setTimeout(() => {
          setGenerationStatus('');
        }, 5000);

        return true;
      } else {
        // If grouping failed or returned empty results, show error
        console.error('Error grouping subtitles:', groupingResult.error || 'No grouped subtitles returned');
        updateError(
          t(
            'narration.subtitleGroupingError',
            'Error grouping subtitles: {{error}}',
            { error: groupingResult.error || t('narration.failedToGroupSubtitles', 'Failed to group subtitles') }
          )
        );
        return false;
      }
    } catch (error) {
      console.error('Error in subtitle grouping:', error);
      updateError(t('narration.subtitleGroupingError', 'Error grouping subtitles: {{error}}', { error: error.message }));
      return false;
    } finally {
      setIsGroupingSubtitles(false);
    }
  };

  // Create a ref to track initial render
  const isInitialGroupingRender = React.useRef(true);

  // Effect to handle subtitle grouping when useGroupedSubtitles changes
  useEffect(() => {
    // Skip the effect during initial render
    if (isInitialGroupingRender.current) {
      isInitialGroupingRender.current = false;
      return;
    }

    const handleGroupingChange = async () => {
      // Update the window flag to indicate whether we're using grouped subtitles
      window.useGroupedSubtitles = useGroupedSubtitles;

      // Only attempt to group if we don't already have grouped subtitles
      if (useGroupedSubtitles && !groupedSubtitles && subtitleSource) {
        // If grouping is enabled but we don't have grouped subtitles yet, group them
        // Set loading state immediately
        setIsGroupingSubtitles(true);
        const success = await groupSubtitles();

        // If grouping failed, don't dispatch the event
        if (!success) {
          // Reset the useGroupedSubtitles state without triggering this effect again
          setTimeout(() => {
            setUseGroupedSubtitles(false);
          }, 0);
          return;
        }
      } else if (!useGroupedSubtitles) {
        // If grouping is disabled, make sure loading state is off
        setIsGroupingSubtitles(false);
      }

      // Dispatch an event to notify that subtitle grouping has changed
      // This will trigger regeneration of aligned audio
      window.dispatchEvent(new CustomEvent('subtitle-timing-changed', {
        detail: {
          action: 'subtitle-grouping-changed',
          useGroupedSubtitles,
          timestamp: Date.now()
        }
      }));
    };

    handleGroupingChange();
  }, [useGroupedSubtitles, subtitleSource, groupedSubtitles]);

  // Update local error when we call setError
  const updateError = (message) => {
    setLocalError(message);
    setError(message);
  };

  // Effect to clear error when user toggles the switch off
  useEffect(() => {
    if (!useGroupedSubtitles) {
      // Clear any errors related to subtitle grouping
      if (localError && localError.includes('grouping')) {
        updateError('');
      }
    }
  }, [useGroupedSubtitles, localError]);

  // Effect to clear grouped subtitles when subtitle source or grouping intensity changes
  useEffect(() => {
    // Store the current state to avoid race conditions
    let wasUsingGroupedSubtitles = useGroupedSubtitles;

    // If subtitle source or grouping intensity changes, clear the grouped subtitles
    setGroupedSubtitles(null);

    // If we were using grouped subtitles, turn off the switch
    if (wasUsingGroupedSubtitles) {
      setUseGroupedSubtitles(false);
    }
  }, [subtitleSource, groupingIntensity]);

  return {
    groupSubtitles
  };
};

export default useGeminiSubtitleGrouping;
