import { useEffect } from 'react';
import { enhanceF5TTSNarrations } from '../../../utils/narrationEnhancer';

/**
 * Custom hook for managing narration cache operations
 * @param {Object} params - Parameters
 * @param {Array} params.generationResults - Current generation results
 * @param {Function} params.setGenerationResults - Function to set generation results
 * @param {Function} params.setGenerationStatus - Function to set generation status
 * @param {string} params.subtitleSource - Selected subtitle source
 * @param {Array} params.originalSubtitles - Original subtitles
 * @param {Array} params.translatedSubtitles - Translated subtitles
 * @param {Array} params.subtitles - Fallback subtitles
 * @param {Function} params.t - Translation function
 */
const useNarrationCache = ({
  generationResults,
  setGenerationResults,
  setGenerationStatus,
  subtitleSource,
  originalSubtitles,
  translatedSubtitles,
  subtitles,
  t,
  setReferenceAudio,
  setReferenceText
}) => {
  // Listen for narrations loaded from cache event
  useEffect(() => {
    const handleNarrationsLoadedFromCache = (event) => {
      if (event.detail && event.detail.narrations) {
        // Only update if we don't already have results
        if (!generationResults || generationResults.length === 0) {
          // Get the narrations from the event
          const cachedNarrations = event.detail.narrations;

          // Immediately update the generation results
          setGenerationResults(cachedNarrations);

          // Show a status message
          setGenerationStatus(t('narration.loadedFromCache', 'Loaded narrations from previous session'));

          // Check if these are grouped narrations by looking for original_ids property
          const isGroupedNarrations = cachedNarrations.some(narration =>
            narration.original_ids && narration.original_ids.length > 1
          );

          // Update global narration references based on whether they are grouped
          if (isGroupedNarrations) {
            window.groupedNarrations = [...cachedNarrations];
            window.useGroupedSubtitles = true;
            console.log(`Loaded ${cachedNarrations.length} grouped narrations from cache`);
          } else {
            if (subtitleSource === 'original') {
              window.originalNarrations = [...cachedNarrations];
            } else {
              window.translatedNarrations = [...cachedNarrations];
            }
            window.useGroupedSubtitles = false;
          }

          // Dispatch a custom event to notify other components
          const updateEvent = new CustomEvent('narrations-updated', {
            detail: {
              source: subtitleSource,
              narrations: cachedNarrations,
              fromCache: true,
              isGrouped: isGroupedNarrations
            }
          });
          window.dispatchEvent(updateEvent);

          // Force a re-render after a short delay to ensure the UI updates
          setTimeout(() => {
            setGenerationStatus(t('narration.loadedFromCacheComplete', 'Successfully loaded narrations from previous session'));
          }, 200);
        }
      }
    };

    // Handle F5-TTS narrations loaded from cache
    const handleF5TTSNarrationsLoadedFromCache = (event) => {
      if (event.detail && event.detail.narrations) {
        // Only update if we don't already have results
        if (!generationResults || generationResults.length === 0) {
          // Get the narrations from the event (reference audio is handled globally)
          const cachedNarrations = event.detail.narrations;

          // Get subtitles for enhancing narrations with timing information
          const subtitlesForEnhancement = originalSubtitles || subtitles || [];

          // Enhance F5-TTS narrations with timing information from subtitles
          const enhancedNarrations = enhanceF5TTSNarrations(cachedNarrations, subtitlesForEnhancement);

          // Log the enhanced narrations for debugging
          console.log('Enhanced F5-TTS narrations from cache:', enhancedNarrations);

          // Immediately update the generation results
          setGenerationResults(enhancedNarrations);

          // Show a status message
          setGenerationStatus(t('narration.loadedFromCache', 'Loaded narrations from previous session'));

          // Check if these are grouped narrations by looking for original_ids property
          const isGroupedNarrations = enhancedNarrations.some(narration =>
            narration.original_ids && narration.original_ids.length > 1
          );

          // Update global narration references based on whether they are grouped
          if (isGroupedNarrations) {
            window.groupedNarrations = [...enhancedNarrations];
            window.useGroupedSubtitles = true;
          } else {
            if (subtitleSource === 'original') {
              window.originalNarrations = [...enhancedNarrations];
            } else {
              window.translatedNarrations = [...enhancedNarrations];
            }
            window.useGroupedSubtitles = false;
          }

          // Dispatch a custom event to notify other components
          const updateEvent = new CustomEvent('narrations-updated', {
            detail: {
              source: subtitleSource,
              narrations: enhancedNarrations,
              fromCache: true,
              isGrouped: isGroupedNarrations
            }
          });
          window.dispatchEvent(updateEvent);

          // Force a re-render after a short delay to ensure the UI updates
          setTimeout(() => {
            setGenerationStatus(t('narration.loadedFromCacheComplete', 'Successfully loaded narrations from previous session'));
          }, 200);
        }
      }
    };

    // Handle Edge TTS narrations loaded from cache
    const handleEdgeTTSNarrationsLoadedFromCache = (event) => {
      if (event.detail && event.detail.narrations) {
        // Only update if we don't already have results
        if (!generationResults || generationResults.length === 0) {
          // Get the narrations from the event
          const cachedNarrations = event.detail.narrations;

          // Immediately update the generation results
          setGenerationResults(cachedNarrations);

          // Show a status message
          setGenerationStatus(t('narration.loadedFromCache', 'Loaded Edge TTS narrations from previous session'));

          // Check if these are grouped narrations by looking for original_ids property
          const isGroupedNarrations = cachedNarrations.some(narration =>
            narration.original_ids && narration.original_ids.length > 1
          );

          // Update global narration references based on whether they are grouped
          if (isGroupedNarrations) {
            window.groupedNarrations = [...cachedNarrations];
            window.useGroupedSubtitles = true;
            console.log(`Loaded ${cachedNarrations.length} grouped Edge TTS narrations from cache`);
          } else {
            if (subtitleSource === 'original') {
              window.originalNarrations = [...cachedNarrations];
            } else {
              window.translatedNarrations = [...cachedNarrations];
            }
            window.useGroupedSubtitles = false;
          }

          // Dispatch a custom event to notify other components
          const updateEvent = new CustomEvent('narrations-updated', {
            detail: {
              source: subtitleSource,
              narrations: cachedNarrations,
              fromCache: true,
              isGrouped: isGroupedNarrations
            }
          });
          window.dispatchEvent(updateEvent);

          // Force a re-render after a short delay to ensure the UI updates
          setTimeout(() => {
            setGenerationStatus(t('narration.loadedFromCacheComplete', 'Successfully loaded Edge TTS narrations from previous session'));
          }, 200);
        }
      }
    };

    // Handle gTTS narrations loaded from cache
    const handleGTTSNarrationsLoadedFromCache = (event) => {
      if (event.detail && event.detail.narrations) {
        // Only update if we don't already have results
        if (!generationResults || generationResults.length === 0) {
          // Get the narrations from the event
          const cachedNarrations = event.detail.narrations;

          // Immediately update the generation results
          setGenerationResults(cachedNarrations);

          // Show a status message
          setGenerationStatus(t('narration.loadedFromCache', 'Loaded gTTS narrations from previous session'));

          // Check if these are grouped narrations by looking for original_ids property
          const isGroupedNarrations = cachedNarrations.some(narration =>
            narration.original_ids && narration.original_ids.length > 1
          );

          // Update global narration references based on whether they are grouped
          if (isGroupedNarrations) {
            window.groupedNarrations = [...cachedNarrations];
            window.useGroupedSubtitles = true;
          } else {
            if (subtitleSource === 'original') {
              window.originalNarrations = [...cachedNarrations];
            } else {
              window.translatedNarrations = [...cachedNarrations];
            }
            window.useGroupedSubtitles = false;
          }

          // Dispatch a custom event to notify other components
          const updateEvent = new CustomEvent('narrations-updated', {
            detail: {
              source: subtitleSource,
              narrations: cachedNarrations,
              fromCache: true,
              isGrouped: isGroupedNarrations
            }
          });
          window.dispatchEvent(updateEvent);

          // Force a re-render after a short delay to ensure the UI updates
          setTimeout(() => {
            setGenerationStatus(t('narration.loadedFromCacheComplete', 'Successfully loaded gTTS narrations from previous session'));
          }, 200);
        }
      }
    };

    // Handle Chatterbox narrations loaded from cache
    const handleChatterboxNarrationsLoadedFromCache = (event) => {
      if (event.detail && event.detail.narrations) {
        // Only update if we don't already have results
        if (!generationResults || generationResults.length === 0) {
          // Get the narrations from the event (reference audio is handled globally)
          const cachedNarrations = event.detail.narrations;

          // Immediately update the generation results
          setGenerationResults(cachedNarrations);

          // Show a status message
          setGenerationStatus(t('narration.loadedFromCache', 'Loaded narrations from previous session'));

          // Check if these are grouped narrations by looking for original_ids property
          const isGroupedNarrations = cachedNarrations.some(narration =>
            narration.original_ids && narration.original_ids.length > 1
          );

          // Update global narration references based on whether they are grouped
          if (isGroupedNarrations) {
            window.groupedNarrations = [...cachedNarrations];
            window.useGroupedSubtitles = true;
            console.log(`Loaded ${cachedNarrations.length} grouped Chatterbox narrations from cache`);
          } else {
            if (subtitleSource === 'original') {
              window.originalNarrations = [...cachedNarrations];
            } else {
              window.translatedNarrations = [...cachedNarrations];
            }
            window.useGroupedSubtitles = false;
          }

          // Dispatch a custom event to notify other components
          const updateEvent = new CustomEvent('narrations-updated', {
            detail: {
              source: subtitleSource,
              narrations: cachedNarrations,
              fromCache: true,
              isGrouped: isGroupedNarrations
            }
          });
          window.dispatchEvent(updateEvent);

          // Force a re-render after a short delay to ensure the UI updates
          setTimeout(() => {
            setGenerationStatus(t('narration.loadedFromCacheComplete', 'Successfully loaded narrations from previous session'));
          }, 200);
        }
      }
    };

    // Add event listeners
    window.addEventListener('narrations-loaded-from-cache', handleNarrationsLoadedFromCache);
    window.addEventListener('f5tts-narrations-loaded-from-cache', handleF5TTSNarrationsLoadedFromCache);
    window.addEventListener('edge-tts-narrations-loaded-from-cache', handleEdgeTTSNarrationsLoadedFromCache);
    window.addEventListener('gtts-narrations-loaded-from-cache', handleGTTSNarrationsLoadedFromCache);
    window.addEventListener('chatterbox-narrations-loaded-from-cache', handleChatterboxNarrationsLoadedFromCache);

    // Clean up
    return () => {
      window.removeEventListener('narrations-loaded-from-cache', handleNarrationsLoadedFromCache);
      window.removeEventListener('f5tts-narrations-loaded-from-cache', handleF5TTSNarrationsLoadedFromCache);
      window.removeEventListener('edge-tts-narrations-loaded-from-cache', handleEdgeTTSNarrationsLoadedFromCache);
      window.removeEventListener('gtts-narrations-loaded-from-cache', handleGTTSNarrationsLoadedFromCache);
      window.removeEventListener('chatterbox-narrations-loaded-from-cache', handleChatterboxNarrationsLoadedFromCache);
    };
  }, [generationResults, setGenerationResults, setGenerationStatus, subtitleSource, originalSubtitles, subtitles, t, setReferenceAudio, setReferenceText]);

  // Global reference audio cache loading - runs once on mount regardless of narration method
  useEffect(() => {
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
      if (!mediaId) return;

      // Check for reference audio in any cache (prioritize the most recent)
      let referenceAudioToRestore = null;
      let cacheSource = '';

      // Check Chatterbox cache
      const cachedChatterboxData = localStorage.getItem('chatterbox_narrations_cache');
      if (cachedChatterboxData) {
        const cacheEntry = JSON.parse(cachedChatterboxData);
        if (cacheEntry.mediaId === mediaId && cacheEntry.referenceAudio) {
          referenceAudioToRestore = cacheEntry.referenceAudio;
          cacheSource = 'Chatterbox';
        }
      }

      // Check F5-TTS cache (may override if more recent)
      const cachedF5TTSData = localStorage.getItem('f5tts_narrations_cache');
      if (cachedF5TTSData) {
        const cacheEntry = JSON.parse(cachedF5TTSData);
        if (cacheEntry.mediaId === mediaId && cacheEntry.referenceAudio) {
          // Use F5-TTS cache if it's more recent or if no Chatterbox cache exists
          if (!referenceAudioToRestore || (cacheEntry.timestamp > JSON.parse(cachedChatterboxData).timestamp)) {
            referenceAudioToRestore = cacheEntry.referenceAudio;
            cacheSource = 'F5-TTS';
          }
        }
      }

      // Check standalone reference audio cache (may override if more recent)
      const cachedReferenceAudioData = localStorage.getItem('reference_audio_cache');
      if (cachedReferenceAudioData) {
        const cacheEntry = JSON.parse(cachedReferenceAudioData);
        if (cacheEntry.mediaId === mediaId && cacheEntry.referenceAudio) {
          // Use standalone cache if it's the most recent
          if (!referenceAudioToRestore || (cacheEntry.timestamp > (
            cacheSource === 'F5-TTS' ? JSON.parse(cachedF5TTSData).timestamp :
            cacheSource === 'Chatterbox' ? JSON.parse(cachedChatterboxData).timestamp : 0
          ))) {
            referenceAudioToRestore = cacheEntry.referenceAudio;
            cacheSource = 'standalone';
          }
        }
      }

      // Restore the most recent reference audio globally
      if (referenceAudioToRestore && setReferenceAudio && setReferenceText) {
        // Mark the reference audio as restored from cache to avoid showing toast
        const referenceAudioWithCacheFlag = {
          ...referenceAudioToRestore,
          fromCache: true
        };
        setReferenceAudio(referenceAudioWithCacheFlag);
        setReferenceText(referenceAudioToRestore.text || '');
        console.log(`Globally restored reference audio from ${cacheSource} cache`);
      }
    } catch (error) {
      console.error('Error loading global reference audio from cache:', error);
    }
  }, []); // Run only once on mount

  // Check for cached narrations on mount (separate from reference audio)
  useEffect(() => {
    // Only check cache if we don't have any generation results yet
    if (generationResults && generationResults.length > 0) return;

    const checkCache = async () => {
      try {
        // Get current media ID using unified approach
        const getCurrentMediaId = async () => {
          const currentVideoUrl = localStorage.getItem('current_video_url');
          const currentFileUrl = localStorage.getItem('current_file_url');

          if (currentVideoUrl) {
            // Use unified URL-based caching for all video types
            const { generateUrlBasedCacheId } = await import('../../../services/subtitleCache');
            return await generateUrlBasedCacheId(currentVideoUrl);
          } else if (currentFileUrl) {
            return localStorage.getItem('current_file_cache_id');
          }
          return null;
        };

        const mediaId = await getCurrentMediaId();
        if (!mediaId) return;

      // Check for cached Chatterbox narrations
      const cachedChatterboxData = localStorage.getItem('chatterbox_narrations_cache');
      if (cachedChatterboxData) {
        const cacheEntry = JSON.parse(cachedChatterboxData);

        // Check if cache is for current media
        if (cacheEntry.mediaId === mediaId && cacheEntry.narrations && cacheEntry.narrations.length > 0) {
          console.log('Found cached Chatterbox narrations, dispatching load event');

          // Dispatch event to load cached narrations (reference audio already loaded globally)
          window.dispatchEvent(new CustomEvent('chatterbox-narrations-loaded-from-cache', {
            detail: {
              narrations: cacheEntry.narrations
              // Reference audio is handled globally, don't pass it here
            }
          }));
          return; // Exit early if we found Chatterbox cache
        }
      }

      // Check for cached Edge TTS narrations
      const cachedEdgeTTSData = localStorage.getItem('edge_tts_narrations_cache');
      if (cachedEdgeTTSData) {
        const cacheEntry = JSON.parse(cachedEdgeTTSData);

        // Check if cache is for current media
        if (cacheEntry.mediaId === mediaId && cacheEntry.narrations && cacheEntry.narrations.length > 0) {
          console.log('Found cached Edge TTS narrations, dispatching load event');

          // Dispatch event to load cached narrations
          window.dispatchEvent(new CustomEvent('edge-tts-narrations-loaded-from-cache', {
            detail: {
              narrations: cacheEntry.narrations,
              settings: cacheEntry.settings
            }
          }));
          return; // Exit early if we found Edge TTS cache
        }
      }

      // Check for cached gTTS narrations
      const cachedGTTSData = localStorage.getItem('gtts_narrations_cache');
      if (cachedGTTSData) {
        const cacheEntry = JSON.parse(cachedGTTSData);

        // Check if cache is for current media
        if (cacheEntry.mediaId === mediaId && cacheEntry.narrations && cacheEntry.narrations.length > 0) {
          console.log('Found cached gTTS narrations, dispatching load event');

          // Dispatch event to load cached narrations
          window.dispatchEvent(new CustomEvent('gtts-narrations-loaded-from-cache', {
            detail: {
              narrations: cacheEntry.narrations,
              settings: cacheEntry.settings
            }
          }));
          return; // Exit early if we found gTTS cache
        }
      }

      // Check for cached F5-TTS narrations
      const cachedF5TTSData = localStorage.getItem('f5tts_narrations_cache');
      if (cachedF5TTSData) {
        const cacheEntry = JSON.parse(cachedF5TTSData);

        // Check if cache is for current media
        if (cacheEntry.mediaId === mediaId && cacheEntry.narrations && cacheEntry.narrations.length > 0) {
          console.log('Found cached F5-TTS narrations, dispatching load event');

          // Dispatch event to load cached narrations (reference audio already loaded globally)
          window.dispatchEvent(new CustomEvent('f5tts-narrations-loaded-from-cache', {
            detail: {
              narrations: cacheEntry.narrations
              // Reference audio is handled globally, don't pass it here
            }
          }));
        }
      }
      } catch (error) {
        console.error('Error loading narrations from cache:', error);
      }
    };

    // Call the async function
    checkCache();
  }, [generationResults]);
};

export default useNarrationCache;
