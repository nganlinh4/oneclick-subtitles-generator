import { useState, useCallback } from 'react';
import { generateChatterboxSpeech, checkChatterboxAvailability, isChatterboxServiceInitialized } from '../../../services/chatterboxService';
import { SERVER_URL } from '../../../config';

// Import cleanup function
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
 * Custom hook for Chatterbox narration generation
 * @param {Object} params - Hook parameters
 * @param {Function} params.setIsGenerating - Function to set generation state
 * @param {Function} params.setGenerationStatus - Function to set generation status
 * @param {Function} params.setError - Function to set error message
 * @param {Function} params.setGenerationResults - Function to set generation results
 * @param {Array} params.generationResults - Current generation results
 * @param {string} params.subtitleSource - Selected subtitle source
 * @param {Array} params.originalSubtitles - Original subtitles
 * @param {Array} params.translatedSubtitles - Translated subtitles
 * @param {Array} params.subtitles - Current subtitles
 * @param {string} params.originalLanguage - Original language
 * @param {string} params.translatedLanguage - Translated language
 * @param {number} params.exaggeration - Exaggeration value
 * @param {number} params.cfgWeight - CFG weight value
 * @param {Object} params.referenceAudio - Reference audio object
 * @param {boolean} params.useGroupedSubtitles - Whether to use grouped subtitles
 * @param {Function} params.setUseGroupedSubtitles - Function to set grouped subtitles usage
 * @param {Array} params.groupedSubtitles - Grouped subtitles
 * @param {Function} params.setGroupedSubtitles - Function to set grouped subtitles
 * @param {boolean} params.isGroupingSubtitles - Whether subtitles are being grouped
 * @param {Function} params.setIsGroupingSubtitles - Function to set grouping state
 * @param {string} params.groupingIntensity - Grouping intensity
 * @param {Function} params.t - Translation function
 * @param {Function} params.setRetryingSubtitleId - Function to set retrying subtitle ID
 * @returns {Object} - Chatterbox narration handlers
 */
const useChatterboxNarration = ({
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
  exaggeration,
  cfgWeight,
  chatterboxLanguage,
  referenceAudio,
  useGroupedSubtitles,
  setUseGroupedSubtitles,
  groupedSubtitles,
  setGroupedSubtitles,
  isGroupingSubtitles,
  setIsGroupingSubtitles,
  groupingIntensity,
  t,
  setRetryingSubtitleId,
  plannedSubtitles
}) => {
  // Track error state locally
  const [localError, setLocalError] = useState('');

  /**
   * Get the selected subtitles based on current settings
   */
  const getSelectedSubtitles = useCallback(() => {
    if (useGroupedSubtitles && groupedSubtitles) {
      return groupedSubtitles;
    }

    if (subtitleSource === 'translated' && translatedSubtitles) {
      return translatedSubtitles;
    }

    return originalSubtitles || subtitles || [];
  }, [useGroupedSubtitles, groupedSubtitles, subtitleSource, translatedSubtitles, originalSubtitles, subtitles]);

  /**
   * Get reference audio file path for API (more efficient than file upload)
   */
  const getReferenceAudioPath = useCallback(() => {
    if (!referenceAudio) {
      return null;
    }

    // Use the filepath if available (this is the server-side path)
    if (referenceAudio.filepath) {
      return referenceAudio.filepath;
    }

    return null;
  }, [referenceAudio]);

  /**
   * Convert reference audio to File object for API (fallback method)
   */
  const getReferenceAudioFile = useCallback(async () => {
    if (!referenceAudio) {
      return null;
    }

    try {
      if (referenceAudio.url) {
        // Convert URL to File
        const response = await fetch(referenceAudio.url);
        const blob = await response.blob();
        const file = new File([blob], referenceAudio.filename || 'reference.wav', { type: 'audio/wav' });
        return file;
      }

      if (referenceAudio.file) {
        return referenceAudio.file;
      }
    } catch (error) {
      console.error('Error converting reference audio to file:', error);
    }

    return null;
  }, [referenceAudio]);
  /**
   * Try to load reference audio from previous Chatterbox run cache (localStorage)
   */
  const getCachedReferenceAudioFile = useCallback(async () => {
    try {
      const cached = localStorage.getItem('chatterbox_narrations_cache');
      if (!cached) return null;
      const parsed = JSON.parse(cached);
      const filename = parsed?.referenceAudio?.filename;
      if (!filename) return null;

      const fileUrl = `${SERVER_URL}/api/narration/reference-audio/${filename}`;
      const response = await fetch(fileUrl);
      if (!response.ok) return null;
      const blob = await response.blob();
      return new File([blob], filename, { type: 'audio/wav' });
    } catch (e) {
      console.error('Error loading cached reference audio file:', e);
      return null;
    }
  }, []);

  /**
   * Get a usable reference audio File, preferring in-memory/state first then cache fallback
   */
  const getReferenceAudioFileWithCache = useCallback(async () => {
    const direct = await getReferenceAudioFile();
    if (direct) return direct;
    return await getCachedReferenceAudioFile();
  }, [getReferenceAudioFile, getCachedReferenceAudioFile]);


  /**
   * Convert audio blob to base64 and save to server
   * @param {Blob} audioBlob - Audio blob from Chatterbox API
   * @param {number} subtitleId - Subtitle ID
   * @returns {Promise<string>} - Filename of saved audio
   */
  const saveAudioBlobToServer = useCallback(async (audioBlob, subtitleId) => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();

      reader.onload = async () => {
        try {
          // Get base64 data URL and extract the base64 part
          const dataUrl = reader.result;
          const base64String = dataUrl.split(',')[1]; // Remove "data:audio/wav;base64," prefix

          // Send to server
          const response = await fetch(`${SERVER_URL}/api/narration/save-chatterbox-audio`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              audioData: base64String,
              subtitle_id: subtitleId,
              sampleRate: 24000, // Chatterbox default sample rate
              mimeType: 'audio/wav'
            })
          });

          if (!response.ok) {
            throw new Error(`Server responded with ${response.status}: ${await response.text()}`);
          }

          const data = await response.json();

          if (data.success) {
            resolve(data.filename);
          } else {
            throw new Error(data.error || 'Unknown error saving audio to server');
          }
        } catch (error) {
          reject(error);
        }
      };

      reader.onerror = () => {
        reject(new Error('Failed to read audio blob'));
      };

      reader.readAsDataURL(audioBlob);
    });
  }, []);

  /**
   * Generate narration for a single subtitle
   */
  const generateSingleNarration = useCallback(async (subtitle, index, total, voiceFile = null, voiceFilePath = null) => {
    try {
      setGenerationStatus(t('narration.chatterboxGeneratingProgress', 'Generating {{progress}} of {{total}} narrations with Chatterbox...', {
        progress: index + 1,
        total
      }));

      const sendAdvanced = /^en/i.test(chatterboxLanguage || '');
      const exArg = sendAdvanced ? exaggeration : undefined;
      const cfgArg = sendAdvanced ? cfgWeight : undefined;
      const audioBlob = await generateChatterboxSpeech(
        subtitle.text,
        chatterboxLanguage,
        exArg,
        cfgArg,
        voiceFile,
        voiceFilePath
      );

      // Save audio blob to server and get filename
      const filename = await saveAudioBlobToServer(audioBlob, subtitle.id || index);

      return {
        subtitle_id: subtitle.id || index,
        text: subtitle.text,
        start_time: subtitle.start,
        end_time: subtitle.end,
        filename: filename,
        success: true,
        method: 'chatterbox'
      };
    } catch (error) {
      console.error(`Error generating narration for subtitle ${index}:`, error);

      return {
        subtitle_id: subtitle.id || index,
        text: subtitle.text,
        start_time: subtitle.start,
        end_time: subtitle.end,
        success: false,
        error: error.message,
        method: 'chatterbox'
      };
    }
  }, [exaggeration, cfgWeight, chatterboxLanguage, t, setGenerationStatus]);

  /**
   * Handle Chatterbox narration generation
   */
  const handleChatterboxNarration = useCallback(async () => {
    try {
      // Clear all caches and files for fresh generation
      const { clearNarrationCachesAndFiles } = await import('../utils/cacheManager');
      await clearNarrationCachesAndFiles(setGenerationResults);

      setIsGenerating(true);
      setError('');
      setLocalError('');
      setGenerationResults([]);

      // Check if Chatterbox service is initialized, if not, show warming up message
      if (!isChatterboxServiceInitialized()) {
        setGenerationStatus(t('narration.chatterboxWarmingUp', 'Warming up narration server for first-time use...'));

        // Try to wake up and connect - the wake-up endpoint will handle model loading
        const availability = await checkChatterboxAvailability(3, 2000, true); // 3 attempts with 2 second timeout each, with wake-up
        if (!availability.available) {
          throw new Error(availability.message || t('narration.chatterboxUnavailableMessage', 'Chatterbox API is not available. Please start the Chatterbox service using "npm run dev:cuda".'));
        }
      }

      const selectedSubtitles = getSelectedSubtitles();

      if (!selectedSubtitles || selectedSubtitles.length === 0) {
        throw new Error(t('narration.noSubtitlesError', 'No subtitles available for narration'));
      }

      // Get reference audio - now required for all Chatterbox generation
      const voiceFilePath = getReferenceAudioPath();
      const voiceFile = voiceFilePath ? null : await getReferenceAudioFile();

      // Validate that reference audio is provided
      if (!voiceFile && !voiceFilePath) {
        throw new Error(t('narration.chatterboxNoReferenceAudio', 'Reference audio is required for Chatterbox TTS generation. Please upload a reference audio file.'));
      }

      setGenerationStatus(t('narration.chatterboxStarting', 'Starting Chatterbox narration generation...'));

      // Update state immediately if we're generating grouped subtitles
      if (useGroupedSubtitles && groupedSubtitles && groupedSubtitles.length > 0) {
        // Initialize empty grouped narrations in window object
        window.groupedNarrations = [];
        window.useGroupedSubtitles = true;
        // Update the React state to reflect that we're now using grouped subtitles
        setUseGroupedSubtitles(true);
        console.log(`Updated state to use grouped subtitles immediately at Chatterbox generation start`);
      }

      const results = [];

      // Generate narrations sequentially to avoid overwhelming the API
      for (let i = 0; i < selectedSubtitles.length; i++) {
        const subtitle = selectedSubtitles[i];
        const result = await generateSingleNarration(subtitle, i, selectedSubtitles.length, voiceFile, voiceFilePath);
        results.push(result);

        // Update results incrementally
        setGenerationResults([...results]);

        // Update window.groupedNarrations incrementally if we're generating grouped subtitles
        if (useGroupedSubtitles && groupedSubtitles && groupedSubtitles.length > 0) {
          window.groupedNarrations = [...results];
        }
      }

      const successCount = results.filter(r => r.success === true).length;
      const errorCount = results.filter(r => r.success === false).length;

      // Cache narrations and reference audio to localStorage
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
          // Create cache entry with narrations and reference audio
          const cacheEntry = {
            mediaId,
            timestamp: Date.now(),
            narrations: results.map(result => ({
              subtitle_id: result.subtitle_id,
              filename: result.filename,
              success: result.success,
              text: result.text,
              method: 'chatterbox'
            })),
            referenceAudio: referenceAudio ? {
              filename: referenceAudio.filename,
              text: referenceAudio.text || '',
              url: referenceAudio.url
            } : null
          };

          // Save to localStorage
          localStorage.setItem('chatterbox_narrations_cache', JSON.stringify(cacheEntry));
          console.log('Cached Chatterbox narrations and reference audio');
        }
      } catch (error) {
        console.error('Error caching Chatterbox narrations:', error);
      }

      // Update state if we generated narrations for grouped subtitles
      if (useGroupedSubtitles && groupedSubtitles && groupedSubtitles.length > 0) {
        // Store as grouped narrations in window object
        window.groupedNarrations = [...results];
        window.useGroupedSubtitles = true;
        // Update the React state to reflect that we're now using grouped subtitles
        setUseGroupedSubtitles(true);
        console.log(`Stored ${results.length} Chatterbox grouped narrations and updated state`);

        // Clean up old subtitle directories for grouped narrations
        console.log('Chatterbox: Detected grouped subtitles, cleaning up old directories');
        cleanupOldSubtitleDirectories(groupedSubtitles);
      } else {
        // Store as original/translated narrations
        if (subtitleSource === 'original') {
          window.originalNarrations = [...results];
        } else {
          window.translatedNarrations = [...results];
        }
        window.useGroupedSubtitles = false;
      }

      if (errorCount === 0) {
        setGenerationStatus(t('narration.chatterboxGenerationComplete', 'Chatterbox narration generation complete'));
      } else {
        setGenerationStatus(t('narration.chatterboxGenerationPartial', 'Chatterbox generation completed with {{success}} successes and {{errors}} errors', {
          success: successCount,
          errors: errorCount
        }));
      }

    } catch (error) {
      console.error('Error in Chatterbox narration generation:', error);
      setError(t('narration.chatterboxGenerationError', 'Error generating narration with Chatterbox: {{error}}', {
        error: error.message
      }));
      setLocalError(error.message);
    } finally {
      setIsGenerating(false);
    }
  }, [
    setIsGenerating,
    setError,
    setGenerationResults,
    getSelectedSubtitles,
    getReferenceAudioFile,
    generateSingleNarration,
    setGenerationStatus,
    t
  ]);

  /**
   * Cancel Chatterbox generation
   */
  const cancelChatterboxGeneration = useCallback(() => {
    setIsGenerating(false);
    setGenerationStatus('');
    setError('');
    setLocalError('');
  }, [setIsGenerating, setGenerationStatus, setError]);

  /**
   * Retry a single Chatterbox narration
   */
  const retryChatterboxNarration = useCallback(async (subtitleId) => {
    try {
      setRetryingSubtitleId(subtitleId);
      // Mark retry mode globally so backend/clients can skip destructive cleanup
      window.__narrationRetryMode = 'single';

      // Ensure Chatterbox API/model is available (warm-up similar to main generation)
      let quick = await checkChatterboxAvailability(1, 800, false);
      if (!quick.available) {
        setGenerationStatus(t('narration.chatterboxWarmingUp', 'Warming up narration server for first-time use...'));
        const availability = await checkChatterboxAvailability(3, 2000, true);
        if (!availability.available) {
          throw new Error(availability.message || t('narration.chatterboxUnavailableMessage', 'Chatterbox API is not available. Please start the Chatterbox service using "npm run dev:cuda".'));
        }
      }

      const selectedSubtitles = getSelectedSubtitles();
      const subtitle = selectedSubtitles.find((s, idx) => (s.id ?? s.subtitle_id ?? (idx + 1)) === subtitleId);

      if (!subtitle) {
        throw new Error('Subtitle not found for retry');
      }

      const voiceFilePath = getReferenceAudioPath();
      const voiceFile = voiceFilePath ? null : await getReferenceAudioFileWithCache();
      const result = await generateSingleNarration(subtitle, 0, 1, voiceFile, voiceFilePath);

      // Update the specific result in the array (append if missing)
      setGenerationResults(prevResults => {
        let found = false;
        const updated = prevResults.map(r => {
          if (r.subtitle_id === subtitleId) {
            found = true;
            return result;
          }
          return r;
        });
        return found ? updated : [...updated, result];
      });

    } catch (error) {
      console.error('Error retrying Chatterbox narration:', error);
      setError(t('narration.retryError', 'Error retrying narration: {{error}}', {
        error: error.message
      }));
    } finally {
      // Clear retry marker and UI state
      delete window.__narrationRetryMode;
      setRetryingSubtitleId(null);
    }
  }, [setRetryingSubtitleId, getSelectedSubtitles, getReferenceAudioFile, generateSingleNarration, setGenerationResults, setError, t]);

  /**
   * Retry all failed Chatterbox narrations
   */
  const retryFailedChatterboxNarrations = useCallback(async () => {
    try {
      setIsGenerating(true);

      // Ensure Chatterbox API/model is available before batch retry
      let quick = await checkChatterboxAvailability(1, 800, false);
      if (!quick.available) {
        setGenerationStatus(t('narration.chatterboxWarmingUp', 'Warming up narration server for first-time use...'));
        const availability = await checkChatterboxAvailability(3, 2000, true);
        if (!availability.available) {
          throw new Error(availability.message || t('narration.chatterboxUnavailableMessage', 'Chatterbox API is not available. Please start the Chatterbox service using "npm run dev:cuda".'));
        }
      }

      const failedResults = generationResults.filter(r => r.success === false && !r.pending);

      if (failedResults.length === 0) {
        return;
      }

      const voiceFile = await getReferenceAudioFile();
      const selectedSubtitles = getSelectedSubtitles();

      for (const failedResult of failedResults) {
        const subtitle = selectedSubtitles.find(s => (s.id || selectedSubtitles.indexOf(s)) === failedResult.subtitle_id);

        if (subtitle) {
          const voiceFilePath = getReferenceAudioPath();
          const vf = voiceFilePath ? null : voiceFile || await getReferenceAudioFileWithCache();
          const result = await generateSingleNarration(subtitle, 0, 1, vf, voiceFilePath);

          // Update the specific result
          setGenerationResults(prevResults =>
            prevResults.map(r =>
              r.subtitle_id === failedResult.subtitle_id ? result : r
            )
          );
        }
      }

    } catch (error) {
      console.error('Error retrying failed Chatterbox narrations:', error);
      setError(t('narration.retryAllError', 'Error retrying failed narrations: {{error}}', {
        error: error.message
      }));
    } finally {
      setIsGenerating(false);
    }
  }, [setIsGenerating, generationResults, getReferenceAudioFile, getSelectedSubtitles, generateSingleNarration, setGenerationResults, setError, t]);

  /**
   * Generate all pending Chatterbox narrations
   */
  const generateAllPendingChatterboxNarrations = useCallback(async () => {
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

      // Generate each pending narration sequentially using the retry function
      for (const subtitleId of pendingSubtitleIds) {
        await retryChatterboxNarration(subtitleId);

        // Add a small delay between generations to avoid overwhelming the server
        await new Promise(resolve => setTimeout(resolve, 500));
      }

    } catch (error) {
      console.error('Error generating pending Chatterbox narrations:', error);
      setError(t('narration.generateAllPendingError', 'Error generating pending narrations: {{error}}', {
        error: error.message
      }));
    } finally {
      setIsGenerating(false);
    }
  }, [setIsGenerating, generationResults, plannedSubtitles, retryChatterboxNarration, setError, t]);

  return {
    handleChatterboxNarration,
    cancelChatterboxGeneration,
    retryChatterboxNarration,
    retryFailedChatterboxNarrations,
    generateAllPendingChatterboxNarrations
  };
};

export default useChatterboxNarration;
