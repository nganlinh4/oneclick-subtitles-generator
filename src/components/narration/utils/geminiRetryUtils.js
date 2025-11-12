/**
 * Utility functions for retrying failed Gemini narrations
 */

/**
 * Retry all failed Gemini narrations
 * @param {Object} params - Parameters for retry operation
 * @param {Array} params.generationResults - Current generation results
 * @param {Function} params.setError - Function to set error message
 * @param {Function} params.setGenerationStatus - Function to set generation status
 * @param {Function} params.setGenerationResults - Function to set generation results
 * @param {Function} params.setIsGenerating - Function to set generating state
 * @param {string} params.subtitleSource - Selected subtitle source
 * @param {Array} params.originalSubtitles - Original subtitles
 * @param {Array} params.translatedSubtitles - Translated subtitles
 * @param {Array} params.subtitles - Fallback subtitles
 * @param {Object} params.originalLanguage - Original language
 * @param {Object} params.translatedLanguage - Translated language
 * @param {string} params.selectedVoice - Selected voice
 * @param {number} params.concurrentClients - Number of concurrent clients
 * @param {boolean} params.useGroupedSubtitles - Whether to use grouped subtitles
 * @param {Array} params.groupedSubtitles - Grouped subtitles
 * @param {Function} params.t - Translation function
 * @returns {Promise<void>}
 */
export const retryFailedGeminiNarrations = async ({
  generationResults,
  setError,
  setGenerationStatus,
  setGenerationResults,
  setIsGenerating,
  subtitleSource,
  originalSubtitles,
  translatedSubtitles,
  subtitles,
  originalLanguage,
  translatedLanguage,
  selectedVoice,
  concurrentClients,
  useGroupedSubtitles,
  groupedSubtitles,
  t
}) => {
  // Find all failed narrations (exclude pending items)
  const failedNarrations = generationResults.filter(result => !result.success && !result.pending);

  if (failedNarrations.length === 0) {
    setError(t('narration.noFailedNarrationsError', 'No failed narrations to retry'));
    return;
  }

  // Determine which subtitles to use based on whether we're using grouped subtitles
  let selectedSubtitles;

  if (useGroupedSubtitles && groupedSubtitles && groupedSubtitles.length > 0) {
    // Use the grouped subtitles if available
    selectedSubtitles = groupedSubtitles;
  } else {
    // Otherwise use the original or translated subtitles
    selectedSubtitles = subtitleSource === 'translated' && translatedSubtitles && translatedSubtitles.length > 0
      ? translatedSubtitles
      : originalSubtitles || subtitles;
  }

  if (!selectedSubtitles || selectedSubtitles.length === 0) {
    setError(t('narration.noSubtitlesError', 'No subtitles available for narration'));
    return;
  }

  // Filter the subtitles to only include those that failed
  const subtitlesToRetry = selectedSubtitles.filter(subtitle => {
    const subtitleId = subtitle.id || subtitle.index;
    return failedNarrations.some(failedNarration =>
      failedNarration.subtitle_id === subtitleId
    );
  });

  if (subtitlesToRetry.length === 0) {
    setError(t('narration.noFailedNarrationsError', 'Could not match failed narrations with subtitles'));
    return;
  }

  // Clear any previous errors
  setError('');

  // Set status for retrying failed narrations
  setGenerationStatus(t('narration.retryingFailedNarrations', 'Retrying {{count}} failed narrations...', { count: subtitlesToRetry.length }));

  // Create a new array of generation results, keeping successful ones and marking failed ones as pending
  const updatedResults = generationResults.map(result => {
    if (!result.success) {
      return {
        ...result,
        pending: true,
        error: null
      };
    }
    return result;
  });

  // Update the generation results
  setGenerationResults(updatedResults);

  // Use a modified version of the handleGeminiNarration function to process all failed narrations at once
  try {
    // Set isGenerating to true to show the Cancel button
    setIsGenerating(true);
    setGenerationStatus(t('narration.preparingGeminiGeneration', 'Preparing to generate narration with Gemini...'));

    // Get the language code for the selected subtitles
    const detectedLanguageCode = subtitleSource === 'original'
      ? (originalLanguage?.languageCode || 'en')
      : (translatedLanguage?.languageCode || 'en');

    // Import the necessary functions
    const {
      generateGeminiNarrations,
      getGeminiLanguageCode
    } = await import('../../../services/gemini/geminiNarrationService');

    // Convert to Gemini-compatible language code
    const language = getGeminiLanguageCode(detectedLanguageCode);

    // Prepare subtitles with IDs for tracking
    const subtitlesWithIds = subtitlesToRetry.map((subtitle, index) => ({
      ...subtitle,
      id: subtitle.id || index + 1
    }));

    // Generate narration with Gemini
    await generateGeminiNarrations(
      subtitlesWithIds,
      language,
      (message) => {
        console.log("Progress update:", message);
        setGenerationStatus(message);

        // We'll only set isGenerating to false in the onComplete callback
        // This ensures the Cancel button stays visible until all narrations are complete
      },
      (result, progress, total) => {
        console.log(`Result received for subtitle ${result.subtitle_id}, progress: ${progress}/${total}`);

        // Update the existing result in the array
        setGenerationResults(prev => {
          return prev.map(item =>
            item.subtitle_id === result.subtitle_id ? {
              ...result,
              pending: false,
              success: result.success !== false && (result.audioData || result.filename || result.success)
            } : item
          );
        });

        // Update the status
        setGenerationStatus(
          t(
            'narration.geminiGeneratingProgress',
            'Generated {{progress}} of {{total}} narrations with Gemini...',
            {
              progress,
              total
            }
          )
        );
      },
      (error) => {
        console.error('Error in Gemini narration generation:', error);
        setError(`${t('narration.geminiGenerationError', 'Error generating narration with Gemini')}: ${error.message || error}`);
        setIsGenerating(false);
      },
      (results) => {
        console.log("Retry generation complete, total results:", results.length);

        // Update the generation results, marking any pending items as failed
        setGenerationResults(prev => {
          return prev.map(item => {
            // If this item is in the results, use that result
            const resultItem = results.find(r => r.subtitle_id === item.subtitle_id);
            if (resultItem) {
              return {
                ...resultItem,
                pending: false,
                success: resultItem.success !== false && (resultItem.audioData || resultItem.filename || resultItem.success)
              };
            }

            // If this item is still pending and was in the retry list, mark it as failed
            if (item.pending && failedNarrations.some(f => f.subtitle_id === item.subtitle_id)) {
              return {
                ...item,
                pending: false,
                success: false,
                error: 'Generation was interrupted'
              };
            }

            // Otherwise, keep the item as is
            return item;
          });
        });

        setGenerationStatus(t('narration.retryingFailedNarrationsComplete', 'Completed retrying all failed narrations'));
        setIsGenerating(false);
      },
      null, // Use default model
      0, // No sleep time
      selectedVoice, // Use the selected voice
      concurrentClients, // Use the configured concurrent clients
      t('narration.preparingGeminiGeneration', 'Preparing to generate narration with Gemini...') // Translated initial progress message
    );
  } catch (error) {
    console.error('Error retrying failed narrations:', error);
    setError(t('narration.retryError', 'Error retrying failed narrations'));
    setIsGenerating(false);
  }
};

/**
 * Generate all pending Gemini narrations
 * @param {Object} params - Parameters for generation operation
 * @param {Array} params.generationResults - Current generation results
 * @param {Function} params.setError - Function to set error message
 * @param {Function} params.setGenerationStatus - Function to set generation status
 * @param {Function} params.setGenerationResults - Function to set generation results
 * @param {Function} params.setIsGenerating - Function to set generating state
 * @param {string} params.subtitleSource - Selected subtitle source
 * @param {Array} params.originalSubtitles - Original subtitles
 * @param {Array} params.translatedSubtitles - Translated subtitles
 * @param {Array} params.subtitles - Fallback subtitles
 * @param {Object} params.originalLanguage - Original language
 * @param {Object} params.translatedLanguage - Translated language
 * @param {string} params.selectedVoice - Selected voice
 * @param {number} params.concurrentClients - Number of concurrent clients
 * @param {boolean} params.useGroupedSubtitles - Whether to use grouped subtitles
 * @param {Array} params.groupedSubtitles - Grouped subtitles
 * @param {Function} params.t - Translation function
 * @returns {Promise<void>}
 */
export const generateAllPendingGeminiNarrations = async ({
  generationResults,
  setError,
  setGenerationStatus,
  setGenerationResults,
  setIsGenerating,
  subtitleSource,
  originalSubtitles,
  translatedSubtitles,
  subtitles,
  originalLanguage,
  translatedLanguage,
  selectedVoice,
  concurrentClients,
  useGroupedSubtitles,
  groupedSubtitles,
  t
}) => {
  // Find all pending narrations
  const pendingNarrations = generationResults.filter(result => !result.success && result.pending);

  if (pendingNarrations.length === 0) {
    setError(t('narration.noPendingNarrationsError', 'No pending narrations to generate'));
    return;
  }

  // Determine which subtitles to use based on whether we're using grouped subtitles
  let selectedSubtitles;

  if (useGroupedSubtitles && groupedSubtitles && groupedSubtitles.length > 0) {
    // Use the grouped subtitles if available
    selectedSubtitles = groupedSubtitles;
  } else {
    // Otherwise use the original or translated subtitles
    selectedSubtitles = subtitleSource === 'translated' && translatedSubtitles && translatedSubtitles.length > 0
      ? translatedSubtitles
      : originalSubtitles || subtitles;
  }

  if (!selectedSubtitles || selectedSubtitles.length === 0) {
    setError(t('narration.noSubtitlesError', 'No subtitles available for narration'));
    return;
  }

  // Filter the subtitles to only include those that are pending
  const subtitlesToGenerate = selectedSubtitles.filter(subtitle => {
    const subtitleId = subtitle.id || subtitle.index;
    return pendingNarrations.some(pendingNarration =>
      pendingNarration.subtitle_id === subtitleId
    );
  });

  if (subtitlesToGenerate.length === 0) {
    setError(t('narration.noPendingNarrationsError', 'Could not match pending narrations with subtitles'));
    return;
  }

  // Clear any previous errors
  setError('');

  // Set status for generating pending narrations
  setGenerationStatus(t('narration.generatingPendingNarrations', 'Generating {{count}} pending narrations...', { count: subtitlesToGenerate.length }));

  // Use a modified version of the handleGeminiNarration function to process all pending narrations at once
  try {
    // Set isGenerating to true to show the Cancel button
    setIsGenerating(true);
    setGenerationStatus(t('narration.preparingGeminiGeneration', 'Preparing to generate narration with Gemini...'));

    // Get the language code for the selected subtitles
    const detectedLanguageCode = subtitleSource === 'original'
      ? (originalLanguage?.languageCode || 'en')
      : (translatedLanguage?.languageCode || 'en');

    // Import the necessary functions
    const {
      generateGeminiNarrations,
      getGeminiLanguageCode
    } = await import('../../../services/gemini/geminiNarrationService');

    // Convert to Gemini-compatible language code
    const language = getGeminiLanguageCode(detectedLanguageCode);

    // Prepare subtitles with IDs for tracking
    const subtitlesWithIds = subtitlesToGenerate.map((subtitle, index) => ({
      ...subtitle,
      id: subtitle.id || index + 1
    }));

    // Generate narration with Gemini
    await generateGeminiNarrations(
      subtitlesWithIds,
      language,
      (message) => {
        console.log("Progress update:", message);
        setGenerationStatus(message);

        // We'll only set isGenerating to false in the onComplete callback
        // This ensures the Cancel button stays visible until all narrations are complete
      },
      (result, progress, total) => {
        console.log(`Result received for subtitle ${result.subtitle_id}, progress: ${progress}/${total}`);

        // Update the existing result in the array
        setGenerationResults(prev => {
          return prev.map(item =>
            item.subtitle_id === result.subtitle_id ? {
              ...result,
              pending: false,
              success: result.success !== false && (result.audioData || result.filename || result.success)
            } : item
          );
        });

        // Update the status
        setGenerationStatus(
          t(
            'narration.geminiGeneratingProgress',
            'Generated {{progress}} of {{total}} narrations with Gemini...',
            {
              progress,
              total
            }
          )
        );
      },
      (error) => {
        console.error('Error in Gemini narration generation:', error);
        setError(`${t('narration.geminiGenerationError', 'Error generating narration with Gemini')}: ${error.message || error}`);
        setIsGenerating(false);
      },
      (results) => {
        console.log("Pending generation complete, total results:", results.length);

        // Update the generation results, marking any pending items as failed
        setGenerationResults(prev => {
          return prev.map(item => {
            // If this item is in the results, use that result
            const resultItem = results.find(r => r.subtitle_id === item.subtitle_id);
            if (resultItem) {
              return {
                ...resultItem,
                pending: false,
                success: resultItem.success !== false && (resultItem.audioData || resultItem.filename || resultItem.success)
              };
            }

            // If this item is still pending and was in the generate list, mark it as failed
            if (item.pending && pendingNarrations.some(p => p.subtitle_id === item.subtitle_id)) {
              return {
                ...item,
                pending: false,
                success: false,
                error: 'Generation was interrupted'
              };
            }

            // Otherwise, keep the item as is
            return item;
          });
        });

        setGenerationStatus(t('narration.generatingPendingNarrationsComplete', 'Completed generating all pending narrations'));
        setIsGenerating(false);
      },
      null, // Use default model
      0, // No sleep time
      selectedVoice, // Use the selected voice
      concurrentClients, // Use the configured concurrent clients
      t('narration.preparingGeminiGeneration', 'Preparing to generate narration with Gemini...') // Translated initial progress message
    );
  } catch (error) {
    console.error('Error generating pending narrations:', error);
    setError(t('narration.generationError', 'Error generating pending narrations'));
    setIsGenerating(false);
  }
};
