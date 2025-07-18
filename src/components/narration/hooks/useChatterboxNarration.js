import { useState, useCallback } from 'react';
import { generateChatterboxSpeech, checkChatterboxAvailability, isChatterboxServiceInitialized } from '../../../services/chatterboxService';
import { SERVER_URL } from '../../../config';

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
  referenceAudio,
  useGroupedSubtitles,
  setUseGroupedSubtitles,
  groupedSubtitles,
  setGroupedSubtitles,
  isGroupingSubtitles,
  setIsGroupingSubtitles,
  groupingIntensity,
  t,
  setRetryingSubtitleId
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
   * Convert reference audio to File object for API
   */
  const getReferenceAudioFile = useCallback(async () => {
    if (!referenceAudio) return null;

    try {
      if (referenceAudio.url) {
        // Convert URL to File
        const response = await fetch(referenceAudio.url);
        const blob = await response.blob();
        return new File([blob], referenceAudio.filename || 'reference.wav', { type: 'audio/wav' });
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
  const generateSingleNarration = useCallback(async (subtitle, index, total, voiceFile = null) => {
    try {
      setGenerationStatus(t('narration.chatterboxGeneratingProgress', 'Generating {{progress}} of {{total}} narrations with Chatterbox...', {
        progress: index + 1,
        total
      }));

      const audioBlob = await generateChatterboxSpeech(
        subtitle.text,
        exaggeration,
        cfgWeight,
        voiceFile
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
  }, [exaggeration, cfgWeight, t, setGenerationStatus]);

  /**
   * Handle Chatterbox narration generation
   */
  const handleChatterboxNarration = useCallback(async () => {
    try {
      setIsGenerating(true);
      setError('');
      setLocalError('');
      setGenerationResults([]);

      // Check if Chatterbox service is initialized, if not, check availability first
      if (!isChatterboxServiceInitialized()) {
        setGenerationStatus(t('narration.chatterboxInitializing', 'Checking Chatterbox service availability...'));

        const availability = await checkChatterboxAvailability(1, 1000); // Single attempt with 1 second timeout
        if (!availability.available) {
          throw new Error(availability.message || t('narration.chatterboxUnavailableMessage', 'Chatterbox API is not available. Please start the Chatterbox service.'));
        }
      }

      const selectedSubtitles = getSelectedSubtitles();

      if (!selectedSubtitles || selectedSubtitles.length === 0) {
        throw new Error(t('narration.noSubtitlesError', 'No subtitles available for narration'));
      }

      // Get reference audio file if available
      const voiceFile = await getReferenceAudioFile();

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
        const result = await generateSingleNarration(subtitle, i, selectedSubtitles.length, voiceFile);
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
          const currentVideoUrl = localStorage.getItem('current_youtube_url');
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
      
      const selectedSubtitles = getSelectedSubtitles();
      const subtitle = selectedSubtitles.find(s => (s.id || selectedSubtitles.indexOf(s)) === subtitleId);
      
      if (!subtitle) {
        throw new Error('Subtitle not found for retry');
      }

      const voiceFile = await getReferenceAudioFile();
      const result = await generateSingleNarration(subtitle, 0, 1, voiceFile);

      // Update the specific result in the array
      setGenerationResults(prevResults => 
        prevResults.map(r => 
          r.subtitle_id === subtitleId ? result : r
        )
      );

    } catch (error) {
      console.error('Error retrying Chatterbox narration:', error);
      setError(t('narration.retryError', 'Error retrying narration: {{error}}', {
        error: error.message
      }));
    } finally {
      setRetryingSubtitleId(null);
    }
  }, [setRetryingSubtitleId, getSelectedSubtitles, getReferenceAudioFile, generateSingleNarration, setGenerationResults, setError, t]);

  /**
   * Retry all failed Chatterbox narrations
   */
  const retryFailedChatterboxNarrations = useCallback(async () => {
    try {
      setIsGenerating(true);
      
      const failedResults = generationResults.filter(r => r.success === false);
      
      if (failedResults.length === 0) {
        return;
      }

      const voiceFile = await getReferenceAudioFile();
      const selectedSubtitles = getSelectedSubtitles();

      for (const failedResult of failedResults) {
        const subtitle = selectedSubtitles.find(s => (s.id || selectedSubtitles.indexOf(s)) === failedResult.subtitle_id);
        
        if (subtitle) {
          const result = await generateSingleNarration(subtitle, 0, 1, voiceFile);
          
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

  return {
    handleChatterboxNarration,
    cancelChatterboxGeneration,
    retryChatterboxNarration,
    retryFailedChatterboxNarrations
  };
};

export default useChatterboxNarration;
