import { useEffect } from 'react';
import { enhanceF5TTSNarrations } from '../../../utils/narrationEnhancer';

// Constants for localStorage keys
const GROUPED_SUBTITLES_CACHE_KEY = 'grouped_subtitles_cache';
const CURRENT_VIDEO_ID_KEY = 'current_video_url';
const CURRENT_FILE_ID_KEY = 'current_file_cache_id';
const USER_DISABLED_GROUPING_KEY = 'user_disabled_grouping';

/**
 * Get current media ID for caching
 * @returns {string|null} - Media ID or null if not available
 */
const getCurrentMediaId = () => {
  // Try YouTube URL first
  const youtubeUrl = localStorage.getItem(CURRENT_VIDEO_ID_KEY);
  if (youtubeUrl) {
    return `youtube:${youtubeUrl}`;
  }

  // Try file cache ID
  const fileId = localStorage.getItem(CURRENT_FILE_ID_KEY);
  if (fileId) {
    return `file:${fileId}`;
  }

  return null;
};

/**
 * Generate a hash of subtitles for cache validation
 * @param {Array} subtitles - Subtitles array
 * @returns {string} - Hash string
 */
const generateSubtitleHash = (subtitles) => {
  if (!subtitles || subtitles.length === 0) return '';

  // Create a simple hash based on subtitle count and first/last subtitle text
  const firstText = subtitles[0]?.text || '';
  const lastText = subtitles[subtitles.length - 1]?.text || '';
  const count = subtitles.length;

  return `${count}-${firstText.slice(0, 20)}-${lastText.slice(0, 20)}`;
};

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
 * @param {Function} params.setIsGroupingSubtitles - Function to set grouping state
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
  setIsGroupingSubtitles,
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

  // Save grouped subtitles to cache when they change
  useEffect(() => {
    if (groupedSubtitles && groupedSubtitles.length > 0) {
      try {
        // Get current media ID
        const mediaId = getCurrentMediaId();
        if (!mediaId) return;

        // Get the source subtitles for hash generation
        const sourceSubtitles = subtitleSource === 'translated' && translatedSubtitles && translatedSubtitles.length > 0
          ? translatedSubtitles
          : originalSubtitles || subtitles;

        if (!sourceSubtitles || sourceSubtitles.length === 0) return;

        // Generate a hash of the source subtitles
        const subtitleHash = generateSubtitleHash(sourceSubtitles);

        // Create cache entry
        const cacheEntry = {
          mediaId,
          subtitleHash,
          subtitleSource,
          groupingIntensity,
          timestamp: Date.now(),
          groupedSubtitles: groupedSubtitles
        };

        // Save to localStorage
        localStorage.setItem(GROUPED_SUBTITLES_CACHE_KEY, JSON.stringify(cacheEntry));
        console.log('Saved grouped subtitles to cache:', groupedSubtitles.length, 'groups');

      } catch (error) {
        console.error('Error saving grouped subtitles to cache:', error);
      }
    }
  }, [groupedSubtitles, subtitleSource, originalSubtitles, translatedSubtitles, subtitles, groupingIntensity]);

  // Load grouped subtitles from cache on component mount
  useEffect(() => {
    // Only try to load from cache if we don't have grouped subtitles yet and we have source subtitles
    if (groupedSubtitles && groupedSubtitles.length > 0) return;

    // Don't load cache if we're dealing with translated subtitles but they're null (translation was reset)
    if (subtitleSource === 'translated' && (!translatedSubtitles || translatedSubtitles.length === 0)) {
      return;
    }

    // Check if user has explicitly disabled grouping for this session
    try {
      const userDisabledGrouping = localStorage.getItem(USER_DISABLED_GROUPING_KEY);
      if (userDisabledGrouping === 'true') {
        console.log('User has explicitly disabled grouping, not loading from cache');
        return;
      }
    } catch (error) {
      console.error('Error checking user disabled grouping flag:', error);
    }

    // Get the source subtitles
    const sourceSubtitles = subtitleSource === 'translated' && translatedSubtitles && translatedSubtitles.length > 0
      ? translatedSubtitles
      : originalSubtitles || subtitles;

    if (!sourceSubtitles || sourceSubtitles.length === 0) return;

    try {
      // Get current media ID
      const mediaId = getCurrentMediaId();
      if (!mediaId) return;

      // Get cache entry
      const cacheEntryJson = localStorage.getItem(GROUPED_SUBTITLES_CACHE_KEY);
      if (!cacheEntryJson) return;

      const cacheEntry = JSON.parse(cacheEntryJson);

      // Check if cache entry is for the current media and subtitle source
      if (cacheEntry.mediaId !== mediaId || cacheEntry.subtitleSource !== subtitleSource) return;

      // Generate hash of current subtitles and compare with cached hash
      const currentSubtitleHash = generateSubtitleHash(sourceSubtitles);
      if (cacheEntry.subtitleHash !== currentSubtitleHash) return;

      // Check if we have grouped subtitles in cache
      if (!cacheEntry.groupedSubtitles || !cacheEntry.groupedSubtitles.length) return;

      console.log('Loading grouped subtitles from cache:', cacheEntry.groupedSubtitles.length, 'groups');

      // Load the grouped subtitles
      setGroupedSubtitles(cacheEntry.groupedSubtitles);

      // Enable the grouping switch
      setUseGroupedSubtitles(true);

      // Update window objects
      window.groupedSubtitles = cacheEntry.groupedSubtitles;
      window.useGroupedSubtitles = true;

      console.log('Successfully loaded grouped subtitles from cache and enabled grouping switch');

    } catch (error) {
      console.error('Error loading grouped subtitles from cache:', error);
    }
  }, [subtitleSource, originalSubtitles, translatedSubtitles, subtitles, groupedSubtitles, setGroupedSubtitles, setUseGroupedSubtitles, useGroupedSubtitles]);

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

    // Make the setter functions available to the SubtitleSourceSelection component
    window.setGroupedSubtitles = setGroupedSubtitles;
    window.setIsGroupingSubtitles = setIsGroupingSubtitles;

    return () => {
      // Clean up when component unmounts
      delete window.setGroupedSubtitles;
      delete window.setIsGroupingSubtitles;
    };
  }, [useGroupedSubtitles, groupedSubtitles, setGroupedSubtitles, setIsGroupingSubtitles]);

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
            // Drop any cached grouping so UI doesn't restore stale groups
            try { localStorage.removeItem('grouped_subtitles_cache'); } catch {}
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

      // Clear the grouped subtitles cache from localStorage
      try {
        localStorage.removeItem(GROUPED_SUBTITLES_CACHE_KEY);
      } catch (error) {
        console.error('Error clearing grouped subtitles cache:', error);
      }

      // Clear the grouped subtitles state if we're using translated subtitles
      if (subtitleSource === 'translated') {
        setGroupedSubtitles(null);
        setUseGroupedSubtitles(false);
      }
    };

    const handleTranslationUpdated = (event) => {
      console.log('Translation updated detected, clearing grouped subtitles cache for retry');

      // Clear the grouped subtitles cache since translations have changed
      try {
        localStorage.removeItem(GROUPED_SUBTITLES_CACHE_KEY);
      } catch (error) {
        console.error('Error clearing grouped subtitles cache after translation update:', error);
      }

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
