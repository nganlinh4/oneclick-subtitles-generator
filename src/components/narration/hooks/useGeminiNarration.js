import React, { useEffect, useState } from 'react';
import { SERVER_URL } from '../../../config';
import {
  generateGeminiNarrations,
  cancelGeminiNarrations,
  getGeminiLanguageCode
} from '../../../services/gemini/geminiNarrationService';
import { groupSubtitlesForNarration } from '../../../services/gemini/subtitleGroupingService';
import { retryFailedGeminiNarrations as retryFailedGeminiNarrationsUtil } from '../utils/geminiRetryUtils';

// Cleanup function for grouped subtitles
const cleanupOldSubtitleDirectories = async (groupedSubtitles) => {
  try {
    const response = await fetch(`${SERVER_URL}/api/narration/cleanup-old-directories`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ groupedSubtitles })
    });

    if (!response.ok) {
      console.error('Failed to cleanup old subtitle directories');
    }
  } catch (error) {
    console.error('Error calling cleanup API:', error);
  }
};

/**
 * Custom hook for Gemini narration generation
 * @param {Object} params - Parameters
 * @param {Function} params.setIsGenerating - Function to set generating state
 * @param {Function} params.setGenerationStatus - Function to set generation status
 * @param {Function} params.setError - Function to set error message
 * @param {Function} params.setGenerationResults - Function to set generation results
 * @param {Array} params.generationResults - Current generation results
 * @param {string} params.subtitleSource - Selected subtitle source
 * @param {Array} params.originalSubtitles - Original subtitles
 * @param {Array} params.translatedSubtitles - Translated subtitles
 * @param {Array} params.subtitles - Fallback subtitles
 * @param {Object} params.originalLanguage - Original language
 * @param {Object} params.translatedLanguage - Translated language
 * @param {string} params.selectedVoice - Selected voice
 * @param {number} params.concurrentClients - Number of concurrent WebSocket clients
 * @param {boolean} params.useGroupedSubtitles - Whether to use grouped subtitles for narration
 * @param {Array} params.groupedSubtitles - Grouped subtitles
 * @param {Function} params.setGroupedSubtitles - Function to set grouped subtitles
 * @param {boolean} params.isGroupingSubtitles - Whether subtitles are currently being grouped
 * @param {Function} params.setIsGroupingSubtitles - Function to set whether subtitles are being grouped
 * @param {Function} params.t - Translation function
 * @param {Function} params.setRetryingSubtitleId - Function to set the ID of the subtitle being retried
 * @returns {Object} - Gemini narration handlers
 */
const useGeminiNarration = ({
  setIsGenerating,
  setGenerationStatus,
  setError,
  setGenerationResults,
  generationResults,
  subtitleSource,
  originalSubtitles,
  translatedSubtitles,
  subtitles,
  originalLanguage,
  translatedLanguage,
  selectedVoice,
  concurrentClients,
  useGroupedSubtitles,
  setUseGroupedSubtitles,
  groupedSubtitles,
  setGroupedSubtitles,
  isGroupingSubtitles,
  setIsGroupingSubtitles,
  groupingIntensity = 'moderate',
  t,
  setRetryingSubtitleId
}) => {
  // Track error state locally
  const [localError, setLocalError] = useState('');
  // Listen for the gemini-narration events (started and cancelled)
  useEffect(() => {
    const handleNarrationStarted = (event) => {
      console.log("Received gemini-narration-started event", event.detail);
      setIsGenerating(true);
      setGenerationStatus(t('narration.preparingGeminiGeneration', 'Preparing to generate narration with Gemini...'));
    };

    const handleNarrationCancelled = () => {
      console.log("Received gemini-narration-cancelled event");
      setIsGenerating(false);
      setGenerationStatus(t('narration.geminiGenerationCancelled', 'Gemini narration generation cancelled'));

      // Mark any pending narrations as cancelled
      setGenerationResults(prev => {
        return prev.map(item => {
          if (item.pending) {
            return {
              ...item,
              pending: false,
              success: false,
              error: t('narration.generationCancelled', 'Generation was cancelled')
            };
          }
          return item;
        });
      });
    };

    // Add event listeners
    window.addEventListener('gemini-narration-started', handleNarrationStarted);
    window.addEventListener('gemini-narration-cancelled', handleNarrationCancelled);

    // Clean up
    return () => {
      window.removeEventListener('gemini-narration-started', handleNarrationStarted);
      window.removeEventListener('gemini-narration-cancelled', handleNarrationCancelled);
    };
  }, [t, setIsGenerating, setGenerationStatus, setGenerationResults]);
  // Handle Gemini narration generation
  const handleGeminiNarration = async () => {
    // Clear all caches and files for fresh generation
    const { clearNarrationCachesAndFiles } = await import('../utils/cacheManager');
    await clearNarrationCachesAndFiles(setGenerationResults);

    if (!subtitleSource) {
      setError(t('narration.noSourceSelectedError', 'Please select a subtitle source (Original or Translated)'));
      return;
    }

    // Validate that language has been detected for the selected source (Gemini-specific requirement)
    const selectedLanguage = subtitleSource === 'original' ? originalLanguage : translatedLanguage;
    if (!selectedLanguage || !selectedLanguage.languageCode) {
      const sourceName = subtitleSource === 'original'
        ? t('narration.originalSubtitles', 'Original Subtitles')
        : t('narration.translatedSubtitles', 'Translated Subtitles');
      setError(t('narration.languageNotDetectedError', 'Please select language for {{source}} subtitles in the "Subtitle Source" section', { source: sourceName }));
      return;
    }

    // Get the appropriate subtitles based on the selected source
    const selectedSubtitles = subtitleSource === 'translated' && translatedSubtitles && translatedSubtitles.length > 0
      ? translatedSubtitles
      : originalSubtitles || subtitles;

    if (!selectedSubtitles || selectedSubtitles.length === 0) {
      // If translated subtitles are selected but not available, show a specific error
      if (subtitleSource === 'translated' && (!translatedSubtitles || translatedSubtitles.length === 0)) {
        setError(t('narration.noTranslatedSubtitlesError', 'No translated subtitles available. Please translate the subtitles first or select original subtitles.'));
      } else {
        setError(t('narration.noSubtitlesError', 'No subtitles available for narration'));
      }
      return;
    }

    // Get the language code for the selected subtitles
    const detectedLanguageCode = subtitleSource === 'original'
      ? (originalLanguage?.languageCode || 'en')
      : (translatedLanguage?.languageCode || 'en');

    // Convert to Gemini-compatible language code
    const language = getGeminiLanguageCode(detectedLanguageCode);



    // We'll set isGenerating to true here, but it will also be set by the event listener
    // This ensures the UI updates immediately
    setIsGenerating(true);
    setGenerationStatus(t('narration.preparingGeminiGeneration', 'Preparing to generate narration with Gemini...'));
    setError('');

    try {
      // Determine which subtitles to use based on whether we're using grouped subtitles
      let subtitlesToUse = selectedSubtitles;

      if (useGroupedSubtitles && groupedSubtitles && groupedSubtitles.length > 0) {
        // Use the grouped subtitles if available
        subtitlesToUse = groupedSubtitles;

        console.log(`Using ${subtitlesToUse.length} grouped subtitles instead of ${selectedSubtitles.length} original subtitles`);
      }

      // Prepare subtitles with IDs for tracking
      const subtitlesWithIds = subtitlesToUse.map((subtitle, index) => ({
        ...subtitle,
        id: subtitle.id || index + 1
      }));

      // Initialize generationResults with placeholder objects for all subtitles
      const initialResults = subtitlesWithIds.map(subtitle => ({
        subtitle_id: subtitle.id,
        text: subtitle.text,
        success: false,
        pending: true, // Flag to indicate this subtitle is pending generation
        audioData: null,
        filename: null,
        // If this is a grouped subtitle, include the original IDs
        original_ids: subtitle.original_ids || [subtitle.id],
        // Add start and end times for proper audio alignment
        start: subtitle.start,
        end: subtitle.end
      }));
      setGenerationResults(initialResults);

      // Update state immediately if we're generating grouped subtitles
      if (useGroupedSubtitles && groupedSubtitles && groupedSubtitles.length > 0) {
        // Store the initial results as grouped narrations in window object
        window.groupedNarrations = [...initialResults];
        window.useGroupedSubtitles = true;
        // Update the React state to reflect that we're now using grouped subtitles
        setUseGroupedSubtitles(true);
        console.log(`Updated state to use grouped subtitles immediately at generation start`);
      }

      // Generate narration with Gemini
      setGenerationStatus(t('narration.preparingGeneration', 'Preparing to generate narration...'));

      // Update the client pool size based on the concurrentClients setting
      localStorage.setItem('gemini_concurrent_clients', concurrentClients.toString());

      const response = await generateGeminiNarrations(
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
            const updatedResults = prev.map(item =>
              item.subtitle_id === result.subtitle_id ? {
                ...result,
                pending: false,
                success: result.success !== false && (result.audioData || result.filename || result.success)
              } : item
            );

            // Update window.groupedNarrations incrementally if we're generating grouped subtitles
            if (useGroupedSubtitles && groupedSubtitles && groupedSubtitles.length > 0) {
              window.groupedNarrations = [...updatedResults];
            }

            return updatedResults;
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
          console.log("Generation complete, total results:", results.length);

          // Update the generation results, marking any pending items as failed
          setGenerationResults(prev => {
            const updatedResults = prev.map(item => {
              // If this item is in the results, use that result
              const resultItem = results.find(r => r.subtitle_id === item.subtitle_id);
              if (resultItem) {
                return {
                  ...resultItem,
                  pending: false,
                  success: resultItem.success !== false && (resultItem.audioData || resultItem.filename || resultItem.success)
                };
              }

              // If this item is still pending, mark it as failed
              if (item.pending) {
                return {
                  ...item,
                  pending: false,
                  success: false,
                  error: t('narration.generationInterrupted', 'Generation was interrupted')
                };
              }

              // Otherwise, keep the item as is
              return item;
            });

            // Store the results in the window object
            if (useGroupedSubtitles && groupedSubtitles && groupedSubtitles.length > 0) {
              // Store as grouped narrations
              window.groupedNarrations = [...updatedResults];
              // Also store the flag to indicate we're using grouped subtitles
              window.useGroupedSubtitles = true;
              // Update the React state to reflect that we're now using grouped subtitles
              setUseGroupedSubtitles(true);

              // Clean up old subtitle directories for grouped narrations
              console.log('Gemini: Detected grouped subtitles, cleaning up old directories');
              cleanupOldSubtitleDirectories(groupedSubtitles);
            } else {
              // Store as original narrations
              if (subtitleSource === 'original') {
                window.originalNarrations = [...updatedResults];
              } else {
                window.translatedNarrations = [...updatedResults];
              }
              // Set the flag to false
              window.useGroupedSubtitles = false;
            }

            return updatedResults;
          });

          if (results.length < subtitlesWithIds.length) {
            // Generation was incomplete
            setGenerationStatus(
              t(
                'narration.geminiGenerationIncomplete',
                'Gemini narration generation incomplete. Generated {{generated}} of {{total}} narrations.',
                {
                  generated: results.length,
                  total: subtitlesWithIds.length
                }
              )
            );
            setError(
              t(
                'narration.geminiConnectionError',
                'Connection to Gemini was interrupted. You can retry the failed narrations individually.'
              )
            );
          } else {
            setGenerationStatus(t('narration.geminiGenerationComplete', 'Gemini narration generation complete'));
          }

          // Ensure isGenerating is set to false when complete
          setIsGenerating(false);
        },
        null, // Use default model
        0, // No sleep time
        selectedVoice, // Use the selected voice
        t('narration.preparingGeminiGeneration', 'Preparing to generate narration with Gemini...') // Translated initial progress message
      );

      // Handle the pending response from our concurrent implementation
      if (response && response.pending) {
        console.log("Narration generation started in background mode");
        // Keep isGenerating true since the generation is happening in the background
        // The callbacks will handle setting isGenerating to false when complete
      } else if (response && response.incomplete) {
        setError(
          t(
            'narration.geminiConnectionError',
            'Connection to Gemini was interrupted. You can retry the failed narrations individually.'
          )
        );
        setIsGenerating(false);
      }
    } catch (error) {
      console.error('Error generating Gemini narration:', error);
      setError(t('narration.geminiGenerationError', 'Error generating narration with Gemini'));
      setIsGenerating(false);
    }
    // Note: We don't set isGenerating to false in the finally block anymore
    // because our concurrent implementation will set it to false when all narrations are complete
    // through the callbacks
  };

  // Cancel Gemini narration generation
  const cancelGeminiGeneration = () => {
    console.log("Cancelling Gemini narration generation");

    // Call the cancel function from the service
    cancelGeminiNarrations();

    // Update UI
    setGenerationStatus(t('narration.geminiGenerationCancelling', 'Cancelling Gemini narration generation...'));

    // Mark any pending narrations as cancelled
    setGenerationResults(prev => {
      return prev.map(item => {
        if (item.pending) {
          return {
            ...item,
            pending: false,
            success: false,
            error: t('narration.generationCancelled', 'Generation was cancelled')
          };
        }
        return item;
      });
    });

    // Explicitly set isGenerating to false to ensure the Cancel button disappears
    // This is important because the completion callback might not be called if the WebSocket is closed
    setTimeout(() => {
      setIsGenerating(false);
      setGenerationStatus(t('narration.geminiGenerationCancelled', 'Gemini narration generation cancelled'));

      // Dispatch a custom event to notify other components
      const event = new CustomEvent('gemini-narration-cancelled', {
        detail: {
          timestamp: Date.now()
        }
      });
      window.dispatchEvent(event);
    }, 500); // Short delay to allow the UI to update
  };

  // Retry Gemini narration generation for a specific subtitle
  const retryGeminiNarration = async (subtitleId) => {
    if (!subtitleSource) {
      setError(t('narration.noSourceSelectedError', 'Please select a subtitle source (Original or Translated)'));
      return;
    }

    // Validate that language has been detected for the selected source (Gemini-specific requirement)
    const selectedLanguage = subtitleSource === 'original' ? originalLanguage : translatedLanguage;
    if (!selectedLanguage || !selectedLanguage.languageCode) {
      const sourceName = subtitleSource === 'original'
        ? t('narration.originalSubtitles', 'Original Subtitles')
        : t('narration.translatedSubtitles', 'Translated Subtitles');
      setError(t('narration.languageNotDetectedError', 'Please select language for {{source}} subtitles in the "Subtitle Source" section', { source: sourceName }));
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

    // Find the subtitle with the given ID
    const subtitleToRetry = selectedSubtitles.find((subtitle, idx) =>
      (subtitle.id ?? subtitle.subtitle_id ?? (idx + 1)) === subtitleId
    );

    if (!subtitleToRetry) {
      console.error(`Subtitle with ID ${subtitleId} not found`);
      return;
    }

    // Set retrying state using the function passed from the parent component
    setRetryingSubtitleId(subtitleId);

    // Make the main button show Cancel during the retry and ensure status banner style is correct
    setIsGenerating(true);

    // Clear any previous errors
    setError('');

    // Get the language code for the selected subtitles
    const detectedLanguageCode = subtitleSource === 'original'
      ? (originalLanguage?.languageCode || 'en')
      : (translatedLanguage?.languageCode || 'en');

    // Convert to Gemini-compatible language code
    const language = getGeminiLanguageCode(detectedLanguageCode);

    // Set status for this specific retry
    setGenerationStatus(t('narration.retryingGeminiGeneration', 'Retrying narration generation for subtitle {{id}}...', { id: subtitleId }));

    try {
      // Prepare subtitle with ID for tracking
      const subtitleWithId = {
        ...subtitleToRetry,
        // Force the ID to the displayed item's subtitleId so UI mapping matches the returned result
        id: subtitleId
      };

      // Generate narration with Gemini for this single subtitle (leverage concurrent implementation)
      const { generateGeminiNarrations } = await import('../../../services/gemini/geminiNarrationService');

      // Create a promise to resolve when the narration is complete
      let resolvePromise;
      const completionPromise = new Promise(resolve => { resolvePromise = resolve; });

      let result = null;

      // Generate narration for the single subtitle using the concurrent implementation
      generateGeminiNarrations(
        [subtitleWithId],
        language,
        (message) => {
          console.log('Single retry progress update:', message);
        },
        (singleResult) => {
          console.log(`Single retry result received for subtitle ${singleResult.subtitle_id}`);
          result = singleResult;
        },
        (error) => {
          console.error('Error in single retry Gemini narration generation:', error);
          resolvePromise({ success: false, error: error.message, subtitle_id: subtitleWithId.id });
        },
        (results) => {
          console.log('Single retry complete, results:', results);
          if (results && results.length > 0) {
            resolvePromise(results[0]);
          } else {
            resolvePromise({ success: false, error: t('narration.noResultReturned', 'No result returned'), subtitle_id: subtitleWithId.id });
          }
        },
        null,
        0,
        selectedVoice,
        t('narration.preparingGeminiGeneration', 'Preparing to generate narration with Gemini...')
      );

      // Wait for the narration to complete
      result = await completionPromise;

      // If the result has audio data, save it to the server to get a filename
      if (result && result.success && result.audioData) {
        try {
          const response = await fetch(`${SERVER_URL}/api/narration/save-gemini-audio`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              audioData: result.audioData,
              subtitle_id: result.subtitle_id,
              sampleRate: result.sampleRate || 24000,
              mimeType: result.mimeType || 'audio/pcm'
            })
          });

          if (response.ok) {
            const data = await response.json();
            if (data.success) {
              result.filename = data.filename;
            } else {
              console.error(`Error saving retried audio to server: ${data.error}`);
              setError(t('narration.saveError', 'Error saving audio to server: {{error}}', { error: data.error }));
            }
          } else {
            console.error(`Server returned ${response.status}: ${response.statusText}`);
            setError(t('narration.serverError', 'Server error: {{status}} {{statusText}}', { status: response.status, statusText: response.statusText }));
          }
        } catch (error) {
          console.error(`Error saving retried audio to server for subtitle ${result.subtitle_id}:`, error);
          setError(t('narration.saveError', 'Error saving audio to server: {{error}}', { error: error.message }));
        }
      }

      // Ensure pending flag is cleared and success is inferred if missing
      const normalizedResult = {
        ...result,
        pending: false,
        success: (result && typeof result.success === 'boolean') ? result.success : (!!result?.audioData || !!result?.filename)
      };

      // Update the results array by replacing the old result with the new one
      setGenerationResults(prevResults => {
        const matchId = Number(normalizedResult?.subtitle_id ?? subtitleId);

        // Replace if exists; otherwise insert
        let found = false;
        const updatedResults = (prevResults || []).map(prevResult => {
          const prevId = Number(prevResult.subtitle_id);
          if (prevId === matchId) {
            found = true;
            return { ...prevResult, ...normalizedResult, pending: false };
          }
          return prevResult;
        });

        if (!found) {
          updatedResults.push({ ...normalizedResult, subtitle_id: matchId, pending: false });
        }

        // Keep a stable order by subtitle_id
        updatedResults.sort((a, b) => Number(a.subtitle_id) - Number(b.subtitle_id));

        // Update the global narration references to ensure video player uses the latest version
        if (subtitleSource === 'original') {
          window.originalNarrations = [...updatedResults];
          if (window.subtitlesData && window.narrations) {
            const globalIndex = window.narrations.findIndex(n => Number(n.subtitle_id) === matchId);
            if (globalIndex !== -1) {
              window.narrations[globalIndex] = { ...window.narrations[globalIndex], ...normalizedResult, pending: false };
            }
          }
          try {
            const essentialData = updatedResults.map(r => ({
              subtitle_id: r.subtitle_id,
              filename: r.filename,
              success: r.success,
              text: r.text
            }));
            localStorage.setItem('originalNarrations', JSON.stringify(essentialData));
          } catch (e) {
            console.error('Error storing updated originalNarrations in localStorage:', e);
          }
        } else {
          window.translatedNarrations = [...updatedResults];
          if (window.subtitlesData && window.narrations) {
            const globalIndex = window.narrations.findIndex(n => Number(n.subtitle_id) === matchId);
            if (globalIndex !== -1) {
              window.narrations[globalIndex] = { ...window.narrations[globalIndex], ...normalizedResult, pending: false };
            }
          }
          try {
            const essentialData = updatedResults.map(r => ({
              subtitle_id: r.subtitle_id,
              filename: r.filename,
              success: r.success,
              text: r.text
            }));
            localStorage.setItem('translatedNarrations', JSON.stringify(essentialData));
          } catch (e) {
            console.error('Error storing updated translatedNarrations in localStorage:', e);
          }
        }

        // Add marker to help identify retried narrations
        normalizedResult.retriedAt = Date.now();

        // Dispatch a custom event to notify other components about the updated narration
        const event = new CustomEvent('narration-retried', {
          detail: {
            source: subtitleSource,
            narration: normalizedResult,
            narrations: updatedResults,
            timestamp: Date.now()
          }
        });
        window.dispatchEvent(event);

        // Also dispatch a subtitle-timing-changed event to ensure aligned narration is regenerated
        window.dispatchEvent(new CustomEvent('subtitle-timing-changed', {
          detail: {
            action: 'narration-retry',
            timestamp: Date.now(),
            subtitleId: matchId
          }
        }));

        return updatedResults;
      });

      setGenerationStatus(t('narration.retryComplete', 'Retry complete for subtitle {{id}}', { id: subtitleId }));
      // End generating state for individual retry so the main button returns to normal
      setIsGenerating(false);

      // Clear the status message after a short delay
      setTimeout(() => setGenerationStatus(''), 3000);
    } catch (error) {
      console.error(`Error retrying Gemini narration for subtitle ${subtitleId}:`, error);
      setError(t('narration.retryError', 'Error retrying narration for subtitle {{id}}', { id: subtitleId }));
      setIsGenerating(false);
    } finally {
      // Clear retrying state regardless of success or failure
      setRetryingSubtitleId(null);
    }
  };

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
        'gemini-2.5-flash-lite',
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

  // Wrapper function for retrying failed Gemini narrations
  const retryFailedGeminiNarrations = async () => {
    return retryFailedGeminiNarrationsUtil({
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
    });
  };

  // Function to generate all pending Gemini narrations
  const generateAllPendingGeminiNarrations = async () => {
    try {
      setIsGenerating(true);

      // Validate that a subtitle source is selected
      if (!subtitleSource) {
        setError(t('narration.noSourceSelectedError', 'Please select a subtitle source (Original or Translated)'));
        return;
      }

      // Validate that language has been detected for the selected source
      const selectedLanguage = subtitleSource === 'original' ? originalLanguage : translatedLanguage;
      if (!selectedLanguage || !selectedLanguage.languageCode) {
        const sourceName = subtitleSource === 'original'
          ? t('narration.originalSubtitles', 'Original Subtitles')
          : t('narration.translatedSubtitles', 'Translated Subtitles');
        setError(t('narration.languageNotDetectedError', 'Please select language for {{source}} subtitles in the "Subtitle Source" section', { source: sourceName }));
        return;
      }

      // Get all planned subtitles (same logic as NarrationResults component)
      const trueSubtitles = (() => {
        // Prefer grouped subtitles when enabled
        if (useGroupedSubtitles && groupedSubtitles && groupedSubtitles.length > 0) {
          return groupedSubtitles;
        }
        // Otherwise use selected source
        if (subtitleSource === 'translated' && translatedSubtitles && translatedSubtitles.length > 0) {
          return translatedSubtitles;
        }
        return originalSubtitles || subtitles || [];
      })();

      if (trueSubtitles.length === 0) {
        setError(t('narration.noPendingNarrations', 'No pending narrations to generate'));
        return;
      }

      // Find subtitles that don't have results yet (pending)
      const completedIds = new Set();
      if (generationResults && generationResults.length > 0) {
        generationResults.forEach(result => {
          if (result.success) {
            completedIds.add(result.subtitle_id);
          }
        });
      }

      // Get pending subtitle IDs
      const pendingSubtitleIds = trueSubtitles
        .map(subtitle => subtitle.id ?? subtitle.subtitle_id ?? trueSubtitles.indexOf(subtitle))
        .filter(id => !completedIds.has(id));

      if (pendingSubtitleIds.length === 0) {
        setError(t('narration.noPendingNarrations', 'No pending narrations to generate'));
        return;
      }

      console.log(`Generating ${pendingSubtitleIds.length} pending Gemini narrations`);

      // Get the language code for the selected subtitles
      const detectedLanguageCode = selectedLanguage.languageCode;

      // Convert to Gemini-compatible language code
      const language = getGeminiLanguageCode(detectedLanguageCode);

      // Set generating state
      setError('');
      setGenerationStatus(t('narration.generatingPending', 'Generating {{count}} pending narrations...', { count: pendingSubtitleIds.length }));

      // Get pending subtitles data
      const pendingSubtitles = pendingSubtitleIds.map(id => {
        const subtitle = trueSubtitles.find(s => (s.id ?? s.subtitle_id ?? trueSubtitles.indexOf(s)) === id);
        return {
          id: subtitle.id ?? subtitle.subtitle_id ?? id,
          text: subtitle.text,
          start: subtitle.start,
          end: subtitle.end,
          original_ids: subtitle.original_ids || [subtitle.id ?? subtitle.subtitle_id ?? id]
        };
      });

      try {
        // Update the client pool size based on the concurrentClients setting
        localStorage.setItem('gemini_concurrent_clients', concurrentClients.toString());

        const response = await generateGeminiNarrations(
          pendingSubtitles,
          language,
          (message) => {
            console.log("Pending generation progress update:", message);
            setGenerationStatus(message);
          },
          (result, progress, total) => {
            console.log(`Pending result received for subtitle ${result.subtitle_id}, progress: ${progress}/${total}`);

            // Update the existing result in the array
            setGenerationResults(prev => {
              const updatedResults = prev.map(item =>
                item.subtitle_id === result.subtitle_id ? {
                  ...result,
                  pending: false,
                  success: result.success !== false && (result.audioData || result.filename || result.success)
                } : item
              );

              // Update window.groupedNarrations incrementally if we're generating grouped subtitles
              if (useGroupedSubtitles && groupedSubtitles && groupedSubtitles.length > 0) {
                window.groupedNarrations = [...updatedResults];
              }

              return updatedResults;
            });

            // Update the status
            setGenerationStatus(
              t(
                'narration.geminiGeneratingProgress',
                'Generated {{progress}} of {{total}} pending narrations with Gemini...',
                {
                  progress,
                  total
                }
              )
            );
          },
          (error) => {
            console.error('Error in pending Gemini narration generation:', error);
            setError(`${t('narration.geminiGenerationError', 'Error generating pending narrations with Gemini')}: ${error.message || error}`);
            setIsGenerating(false);
          },
          (results) => {
            console.log("Pending generation complete, total results:", results.length);

            // Update the generation results, marking any still pending items as failed
            setGenerationResults(prev => {
              const updatedResults = prev.map(item => {
                // If this item is in the results, use that result
                const resultItem = results.find(r => r.subtitle_id === item.subtitle_id);
                if (resultItem) {
                  return {
                    ...resultItem,
                    pending: false,
                    success: resultItem.success !== false && (resultItem.audioData || resultItem.filename || resultItem.success)
                  };
                }

                // If this item was pending and not in results, mark it as failed
                if (item.pending) {
                  return {
                    ...item,
                    pending: false,
                    success: false,
                    error: t('narration.generationInterrupted', 'Generation was interrupted')
                  };
                }

                // Otherwise, keep the item as is
                return item;
              });

              // Store the results in the window object
              if (useGroupedSubtitles && groupedSubtitles && groupedSubtitles.length > 0) {
                // Store as grouped narrations
                window.groupedNarrations = [...updatedResults];
                window.useGroupedSubtitles = true;
                setUseGroupedSubtitles(true);

                // Clean up old subtitle directories for grouped narrations
                console.log('Gemini: Detected grouped subtitles, cleaning up old directories');
                cleanupOldSubtitleDirectories(groupedSubtitles);
              } else {
                // Store as original narrations
                if (subtitleSource === 'original') {
                  window.originalNarrations = [...updatedResults];
                } else {
                  window.translatedNarrations = [...updatedResults];
                }
                window.useGroupedSubtitles = false;
              }

              return updatedResults;
            });

            if (results.length < pendingSubtitleIds.length) {
              // Generation was incomplete
              setGenerationStatus(
                t(
                  'narration.geminiGenerationIncomplete',
                  'Gemini pending narration generation incomplete. Generated {{generated}} of {{total}} narrations.',
                  {
                    generated: results.length,
                    total: pendingSubtitleIds.length
                  }
                )
              );
              setError(
                t(
                  'narration.geminiConnectionError',
                  'Connection to Gemini was interrupted. You can retry the failed narrations individually.'
                )
              );
            } else {
              setGenerationStatus(t('narration.geminiGenerationComplete', 'Gemini pending narration generation complete'));
            }

            // Ensure isGenerating is set to false when complete
            setIsGenerating(false);
          },
          null, // Use default model
          0, // No sleep time
          selectedVoice, // Use the selected voice
          t('narration.generatingPending', 'Generating pending narrations...') // Translated initial progress message
        );

        // Handle the pending response from our concurrent implementation
        if (response && response.pending) {
          console.log("Pending narration generation started in background mode");
          // Keep isGenerating true since the generation is happening in the background
          // The callbacks will handle setting isGenerating to false when complete
        } else if (response && response.incomplete) {
          setError(
            t(
              'narration.geminiConnectionError',
              'Connection to Gemini was interrupted. You can retry the failed narrations individually.'
            )
          );
          setIsGenerating(false);
        }
      } catch (error) {
        console.error('Error generating pending Gemini narrations:', error);
        setError(t('narration.geminiGenerationError', 'Error generating pending narrations with Gemini'));
        setIsGenerating(false);
      }
    } catch (error) {
      console.error('Error generating pending Gemini narrations:', error);
      setError(t('narration.generateAllPendingError', 'Error generating pending narrations: {{error}}', {
        error: error.message
      }));
      setIsGenerating(false);
    }
  };

  return {
    handleGeminiNarration,
    cancelGeminiGeneration,
    retryGeminiNarration,
    retryFailedGeminiNarrations,
    generateAllPendingGeminiNarrations,
    groupSubtitles
  };
};

export default useGeminiNarration;
