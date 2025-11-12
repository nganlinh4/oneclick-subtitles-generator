import React, { useCallback, useState, useEffect } from 'react';
import { SERVER_URL } from '../../../config';

/**
 * Custom hook for gTTS narration generation
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
 * @param {string} params.selectedLanguage - Selected gTTS language
 * @param {string} params.tld - Top-level domain for accent
 * @param {boolean} params.slow - Whether to speak slowly
 * @param {Function} params.t - Translation function
 * @param {Function} params.setRetryingSubtitleId - Function to set retrying subtitle ID
 * @returns {Object} - gTTS narration handlers
 */
const useGTTSNarration = ({
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
  selectedLanguage,
  setSelectedLanguage,
  tld,
  setTld,
  slow,
  setSlow,
  t,
  setRetryingSubtitleId,
  useGroupedSubtitles,
  groupedSubtitles,
  setUseGroupedSubtitles,
  plannedSubtitles
}) => {
  const [abortController, setAbortController] = useState(null);

  /**
   * Get the appropriate subtitles based on source and grouping
   */
  const getSubtitlesForGeneration = useCallback(() => {
    // If using grouped subtitles, return them instead of individual subtitles
    if (useGroupedSubtitles && groupedSubtitles && groupedSubtitles.length > 0) {
      console.log(`gTTS: Using ${groupedSubtitles.length} grouped subtitles`);
      return groupedSubtitles;
    }

    // Otherwise, return individual subtitles based on source
    if (subtitleSource === 'original' && originalSubtitles?.length > 0) {
      return originalSubtitles;
    } else if (subtitleSource === 'translated' && translatedSubtitles?.length > 0) {
      return translatedSubtitles;
    } else if (subtitles?.length > 0) {
      return subtitles;
    }
    return [];
  }, [subtitleSource, originalSubtitles, translatedSubtitles, subtitles, useGroupedSubtitles, groupedSubtitles]);

  /**
   * Handle gTTS narration generation
   */
  const handleGTTSNarration = useCallback(async () => {
    // Clear all caches and files for fresh generation
    const { clearNarrationCachesAndFiles } = await import('../utils/cacheManager');
    await clearNarrationCachesAndFiles(setGenerationResults);

    const subtitlesToProcess = getSubtitlesForGeneration();

    if (!subtitlesToProcess || subtitlesToProcess.length === 0) {
      setError(t('narration.noSubtitlesError', 'No subtitles available for narration generation.'));
      return;
    }

    if (!selectedLanguage) {
      setError(t('narration.noLanguageSelectedError', 'Please select a language for gTTS.'));
      return;
    }

    try {
      setIsGenerating(true);
      setError('');
      setGenerationResults([]);
      
      const controller = new AbortController();
      setAbortController(controller);

      const settings = {
        lang: selectedLanguage,
        tld: tld || 'com',
        slow: slow || false
      };

      const requestBody = {
        subtitles: subtitlesToProcess,
        settings: settings
      };

      setGenerationStatus(t('narration.gttsStarting', 'Starting gTTS generation...'));

      const response = await fetch(`${SERVER_URL}/api/narration/gtts/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const results = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split('\n');

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              
              if (data.status === 'started') {
                setGenerationStatus(t('narration.gttsGeneratingProgress', 'Generating {{current}} of {{total}} narrations with gTTS...', {
                  current: 1,
                  total: data.total
                }));
              } else if (data.status === 'progress') {
                setGenerationStatus(t('narration.gttsGeneratingProgress', 'Generating {{current}} of {{total}} narrations with gTTS...', {
                  current: data.current,
                  total: data.total
                }));

                if (data.result) {
                  // Ensure pending flag is properly set based on success status
                  const processedResult = {
                    ...data.result,
                    pending: false // Completed results are no longer pending
                  };
                  results.push(processedResult);
                  setGenerationResults([...results]);
                }
              } else if (data.status === 'error') {
                if (data.result) {
                  // Ensure pending flag is properly set for error results
                  const processedResult = {
                    ...data.result,
                    pending: false // Error results are no longer pending
                  };
                  results.push(processedResult);
                  setGenerationResults([...results]);
                }
              } else if (data.status === 'completed') {
                const finalResults = data.results || results;
                setGenerationResults(finalResults);
                setGenerationStatus(t('narration.gttsGenerationComplete', 'gTTS narration generation completed successfully!'));

                // Cache narrations to localStorage
                try {
                  // Get current media ID
                  const getCurrentMediaId = () => {
                    const currentVideoUrl = localStorage.getItem('current_video_url');
                    const currentFileUrl = localStorage.getItem('current_file_url');

                    if (currentVideoUrl) {
                      // Extract video ID from YouTube URLs
                      const match = currentVideoUrl.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
                      return match ? match[1] : null;
                    } else if (currentFileUrl) {
                      return localStorage.getItem('current_file_cache_id');
                    }
                    return null;
                  };

                  const mediaId = getCurrentMediaId();
                  if (mediaId) {
                    // Create cache entry with narrations
                    const cacheEntry = {
                      mediaId,
                      timestamp: Date.now(),
                      narrations: finalResults.map(result => ({
                        subtitle_id: result.subtitle_id,
                        filename: result.filename,
                        success: result.success,
                        text: result.text,
                        method: 'gtts'
                      })),
                      settings: {
                        lang: selectedLanguage,
                        tld: tld || 'com',
                        slow: slow || false
                      }
                    };

                    // Save to localStorage
                    localStorage.setItem('gtts_narrations_cache', JSON.stringify(cacheEntry));
                    console.log('Cached gTTS narrations');
                  }
                } catch (error) {
                  console.error('Error caching gTTS narrations:', error);
                }

                // Handle grouped narrations storage and cleanup
                if (useGroupedSubtitles && groupedSubtitles && groupedSubtitles.length > 0) {
                  // Store as grouped narrations in window object
                  window.groupedNarrations = [...finalResults];
                  window.useGroupedSubtitles = true;
                  // Update the React state to reflect that we're now using grouped subtitles
                  setUseGroupedSubtitles(true);
                  console.log(`Stored ${finalResults.length} gTTS grouped narrations and updated state`);
                } else {
                  // Store as original/translated narrations
                  if (subtitleSource === 'original') {
                    window.originalNarrations = [...finalResults];
                  } else {
                    window.translatedNarrations = [...finalResults];
                  }
                  window.useGroupedSubtitles = false;
                }
              }
            } catch (parseError) {
              console.warn('Failed to parse SSE data:', parseError);
            }
          }
        }
      }

    } catch (error) {
      if (error.name === 'AbortError') {
        setGenerationStatus(t('narration.gttsGenerationCancelled', 'gTTS generation cancelled'));
      } else {
        console.error('gTTS generation error:', error);
        setError(t('narration.gttsGenerationError', 'Error generating gTTS narration: {{error}}', { error: error.message }));
      }
    } finally {
      setIsGenerating(false);
      setAbortController(null);
    }
  }, [
    getSubtitlesForGeneration,
    selectedLanguage,
    tld,
    slow,
    setIsGenerating,
    setError,
    setGenerationResults,
    setGenerationStatus,
    t
  ]);

  /**
   * Cancel gTTS generation
   */
  const cancelGTTSGeneration = useCallback(() => {
    if (abortController) {
      abortController.abort();
      setAbortController(null);
    }
    setIsGenerating(false);
    setGenerationStatus(t('narration.gttsGenerationCancelled', 'gTTS generation cancelled'));
  }, [abortController, setIsGenerating, setGenerationStatus, t]);

  /**
   * Retry gTTS narration for a specific subtitle
   */
  const retryGTTSNarration = useCallback(async (subtitleId) => {
    const subtitlesToProcess = getSubtitlesForGeneration();
    const subtitle = subtitlesToProcess.find((sub, idx) => (sub.id ?? sub.subtitle_id ?? (idx + 1)) === subtitleId);
    
    if (!subtitle) {
      setError(t('narration.subtitleNotFoundError', 'Subtitle not found for retry.'));
      return;
    }

    if (!selectedLanguage) {
      setError(t('narration.noLanguageSelectedError', 'Please select a language for gTTS.'));
      return;
    }

    try {
      setRetryingSubtitleId(subtitleId);
      
      const settings = {
        lang: selectedLanguage,
        tld: tld || 'com',
        slow: slow || false
      };

      const requestBody = {
        subtitles: [subtitle],
        settings: settings
      };

      const response = await fetch(`${SERVER_URL}/api/narration/gtts/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split('\n');

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              
              if (data.status === 'completed' && data.results?.length > 0) {
                const newResult = {
                  ...data.results[0],
                  pending: false // Completed retry results are no longer pending
                };

                // Update the specific result in the generation results (append if missing)
                setGenerationResults(prev => {
                  let found = false;
                  const updated = prev.map(result => {
                    if (result.subtitle_id === subtitleId) {
                      found = true;
                      return newResult;
                    }
                    return result;
                  });
                  return found ? updated : [...updated, newResult];
                });
              }
            } catch (parseError) {
              console.warn('Failed to parse SSE data:', parseError);
            }
          }
        }
      }

    } catch (error) {
      console.error('gTTS retry error:', error);
      setError(t('narration.gttsRetryError', 'Error retrying gTTS narration: {{error}}', { error: error.message }));
    } finally {
      setRetryingSubtitleId(null);
    }
  }, [
    getSubtitlesForGeneration,
    selectedLanguage,
    tld,
    slow,
    setError,
    setGenerationResults,
    setRetryingSubtitleId,
    t
  ]);

  /**
   * Retry all failed gTTS narrations
   */
  const retryFailedGTTSNarrations = useCallback(async () => {
    const failedResults = generationResults.filter(result => !result.success && !result.pending);
    
    if (failedResults.length === 0) {
      return;
    }

    const subtitlesToProcess = getSubtitlesForGeneration();
    const failedSubtitles = failedResults.map(result =>
      subtitlesToProcess.find(sub => (sub.id ?? subtitlesToProcess.indexOf(sub)) === result.subtitle_id)
    ).filter(Boolean);

    if (failedSubtitles.length === 0) {
      setError(t('narration.noFailedSubtitlesError', 'No failed subtitles found for retry.'));
      return;
    }

    try {
      setIsGenerating(true);
      setError('');

      const settings = {
        lang: selectedLanguage,
        tld: tld || 'com',
        slow: slow || false
      };

      const requestBody = {
        subtitles: failedSubtitles,
        settings: settings
      };

      setGenerationStatus(t('narration.gttsRetryingFailed', 'Retrying failed gTTS narrations...'));

      const response = await fetch(`${SERVER_URL}/api/narration/gtts/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split('\n');

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              
              if (data.status === 'progress' && data.result) {
                // Update the specific result in the generation results
                const processedResult = {
                  ...data.result,
                  pending: false // Completed retry results are no longer pending
                };
                setGenerationResults(prev =>
                  prev.map(result =>
                    result.subtitle_id === processedResult.subtitle_id ? processedResult : result
                  )
                );
              } else if (data.status === 'completed') {
                setGenerationStatus(t('narration.gttsRetryComplete', 'gTTS retry completed!'));
              }
            } catch (parseError) {
              console.warn('Failed to parse SSE data:', parseError);
            }
          }
        }
      }

    } catch (error) {
      console.error('gTTS retry failed error:', error);
      setError(t('narration.gttsRetryFailedError', 'Error retrying failed gTTS narrations: {{error}}', { error: error.message }));
    } finally {
      setIsGenerating(false);
    }
  }, [
    generationResults,
    getSubtitlesForGeneration,
    selectedLanguage,
    tld,
    slow,
    setIsGenerating,
    setError,
    setGenerationResults,
    setGenerationStatus,
    t
  ]);

  // Listen for cached narrations loaded event
  useEffect(() => {
    const handleCachedNarrationsLoaded = (event) => {
      if (event.detail && event.detail.narrations) {
        console.log('gTTS: Received cached narrations from cache hook');
        setGenerationResults(event.detail.narrations);
        setGenerationStatus(t('narration.loadedFromCache', 'Loaded gTTS narrations from previous session'));

        // Restore settings if available
        if (event.detail.settings) {
          const settings = event.detail.settings;
          if (settings.lang && setSelectedLanguage) setSelectedLanguage(settings.lang);
          if (settings.tld && setTld) setTld(settings.tld);
          if (typeof settings.slow === 'boolean' && setSlow) setSlow(settings.slow);
        }
      }
    };

    window.addEventListener('gtts-narrations-loaded-from-cache', handleCachedNarrationsLoaded);

    return () => {
      window.removeEventListener('gtts-narrations-loaded-from-cache', handleCachedNarrationsLoaded);
    };
  }, [setGenerationResults, setGenerationStatus, t, setSelectedLanguage, setTld, setSlow]);

  /**
   * Generate all pending gTTS narrations
   */
  const generateAllPendingGTTSNarrations = useCallback(async () => {
    try {
      setIsGenerating(true);

      // Get all planned subtitles (passed from parent component)
      const trueSubtitles = plannedSubtitles || [];

      if (trueSubtitles.length === 0) {
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
        return;
      }

      setError('');
      setGenerationStatus(t('narration.generatingPendingNarrations', 'Generating {{count}} pending narrations...', { count: pendingSubtitleIds.length }));

      // Generate each pending narration sequentially using the retry function
      for (const subtitleId of pendingSubtitleIds) {
        await retryGTTSNarration(subtitleId);

        // Add a small delay between generations to avoid overwhelming the server
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      // Update status
      setGenerationStatus(t('narration.generatingPendingNarrationsComplete', 'Completed generating all pending narrations'));
    } catch (error) {
      console.error('Error generating pending gTTS narrations:', error);
      setError(t('narration.generateAllPendingError', 'Error generating pending narrations: {{error}}', {
        error: error.message
      }));
    } finally {
      setIsGenerating(false);
    }
  }, [
    setIsGenerating,
    generationResults,
    plannedSubtitles,
    retryGTTSNarration,
    setError,
    setGenerationStatus,
    t
  ]);

  return {
    handleGTTSNarration,
    cancelGTTSGeneration,
    retryGTTSNarration,
    retryFailedGTTSNarrations,
    generateAllPendingGTTSNarrations
  };
};

export default useGTTSNarration;
