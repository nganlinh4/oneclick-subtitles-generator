import { useState } from 'react';
import { hydrateNarrationResultsForAlignment } from '../../utils/narrationAlignmentUtils';

// Gated debug logging (enable in the browser console: localStorage.debug_logs = 'true')
const DEBUG_LOGS = (typeof window !== 'undefined') && (localStorage.getItem('debug_logs') === 'true');
const dbg = (...args) => { if (DEBUG_LOGS) console.log(...args); };

/**
 * Narration helpers for the video rendering section: availability checks, the
 * aligned-audio URL resolver used during render, and the refresh/align action.
 *
 * @param {object} ctx
 * @param {string} ctx.selectedNarration current narration selection ('none' | 'generated')
 * @param {Array} ctx.narrationResults narration results passed from the parent props
 */
export const useNarration = ({ selectedNarration, narrationResults }) => {
  const [isRefreshingNarration, setIsRefreshingNarration] = useState(false);

  // Get current narration results from window (reactive to updates)
  const currentNarrationResults = window.originalNarrations || window.translatedNarrations || [];

  // Check if aligned narration is available (same logic as refresh narration button)
  const isAlignedNarrationAvailable = () => {
    return window.isAlignedNarrationAvailable === true && window.alignedNarrationCache?.url;
  };

  // Check if individual narration segments are available (not the aligned audio)
  const hasNarrationSegments = () => {
    // Check current narration results
    if (currentNarrationResults && currentNarrationResults.length > 0) {
      // Check if any narration has success=true (meaning individual segments exist)
      const hasSuccessfulNarrations = currentNarrationResults.some(result => result.success === true);
      if (hasSuccessfulNarrations) return true;
    }

    // Check window objects (where narrations are actually stored)
    const originalNarrations = window.originalNarrations || [];
    const translatedNarrations = window.translatedNarrations || [];
    const groupedNarrations = window.groupedNarrations || [];

    // Check if any narration segments have success=true
    const hasOriginalSegments = originalNarrations.some(result => result.success === true);
    const hasTranslatedSegments = translatedNarrations.some(result => result.success === true);
    const hasGroupedSegments = groupedNarrations.some(result => result.success === true);

    return hasOriginalSegments || hasTranslatedSegments || hasGroupedSegments;
  };

  // Get narration audio URL if available - same as refresh narration button
  const getNarrationAudioUrl = async (narrationSelection = selectedNarration) => {
    const {
      generateAlignedNarration,
      getAlignedNarrationUrl,
    } = await import('../../services/alignedNarrationService.js');
    const currentUrl = getAlignedNarrationUrl();
    if (currentUrl) return currentUrl;
    if (narrationSelection !== 'generated' || !narrationResults?.length) return null;
    const generated = await generateAlignedNarration(narrationResults);
    return generated ? getAlignedNarrationUrl() : null;
  };

  const getNarrationArtifactId = async (narrationSelection = selectedNarration) => {
    if (narrationSelection !== 'generated') return null;
    const { getAlignedNarrationArtifactId } = await import('../../services/alignedNarrationService.js');
    const currentArtifactId = getAlignedNarrationArtifactId();
    if (currentArtifactId) return currentArtifactId;
    await getNarrationAudioUrl(narrationSelection);
    return getAlignedNarrationArtifactId();
  };

  // Refresh narration function - same logic as the main video player
  const handleRefreshNarration = async () => {
    if (isRefreshingNarration) return;

    try {
      setIsRefreshingNarration(true);

      // Get narrations from window object
      const isUsingGroupedSubtitles = window.useGroupedSubtitles || false;
      const groupedNarrations = window.groupedNarrations || [];
      const originalNarrations = window.originalNarrations || [];

      // Use grouped narrations if available and enabled, otherwise use original narrations
      const narrations = (isUsingGroupedSubtitles && groupedNarrations.length > 0)
        ? groupedNarrations
        : originalNarrations;

      dbg(`Using ${isUsingGroupedSubtitles ? 'grouped' : 'original'} narrations for alignment. Found ${narrations.length} narrations.`);

      // Check if we have any narration results
      if (!narrations || narrations.length === 0) {
        console.error('No narration results available in window objects');

        // Try to reconstruct narration results from the file system
        const allSubtitles = window.subtitlesData || window.originalSubtitles || [];

        if (allSubtitles.length === 0) {
          throw new Error('No narration results or subtitles available for alignment');
        }

        // Create synthetic narration objects based on subtitles
        const syntheticNarrations = allSubtitles.map(subtitle => ({
          subtitle_id: subtitle.id,
          filename: `subtitle_${subtitle.id}/1.wav`,
          success: true,
          start: subtitle.start,
          end: subtitle.end,
          text: subtitle.text
        }));

        // Use these synthetic narrations
        narrations.length = 0;
        narrations.push(...syntheticNarrations);

        // Also update the window object for future use
        window.originalNarrations = [...syntheticNarrations];
      }

      // Force reset the aligned narration cache
      if (typeof window.resetAlignedNarration === 'function') {
        window.resetAlignedNarration();
      }

      // Clean up any existing audio elements
      if (window.alignedAudioElement) {
        try {
          window.alignedAudioElement.pause();
          window.alignedAudioElement.src = '';
          window.alignedAudioElement.load();
          window.alignedAudioElement = null;
        } catch (e) {
          console.warn('Error cleaning up window.alignedAudioElement:', e);
        }
      }

      // Get all subtitles from the window object
      const allSubtitles = isUsingGroupedSubtitles && window.groupedSubtitles ?
        window.groupedSubtitles :
        (window.subtitlesData || window.originalSubtitles || []);

      // Create a map for faster lookup
      const subtitleMap = {};
      allSubtitles.forEach(sub => {
        if (sub.id !== undefined) {
          subtitleMap[sub.id] = sub;
        }
      });

      // Prepare the data for the aligned narration with correct timing
      const narrationData = hydrateNarrationResultsForAlignment(narrations)
        .filter(result => result.success && (result.nativeArtifactId || result.filename))
        .map(result => {
          const subtitle = subtitleMap[result.subtitle_id];
          if (subtitle && typeof subtitle.start === 'number' && typeof subtitle.end === 'number') {
            return {
              filename: result.filename,
              nativeArtifactId: result.nativeArtifactId,
              subtitle_id: result.subtitle_id,
              start: subtitle.start,
              end: subtitle.end,
              text: subtitle.text || result.text || ''
            };
          }
          return {
            filename: result.filename,
            nativeArtifactId: result.nativeArtifactId,
            subtitle_id: result.subtitle_id,
            start: 0,
            end: 5,
            text: result.text || ''
          };
        });

      // Sort by start time to ensure correct order
      narrationData.sort((a, b) => a.start - b.start);

      if (narrationData.length === 0) {
        throw new Error('No valid narration files found. Please generate narrations first.');
      }

      const {
        generateAlignedNarration,
        getAlignedNarrationUrl,
      } = await import('../../services/alignedNarrationService.js');
      const generated = await generateAlignedNarration(narrationData);
      const url = getAlignedNarrationUrl();
      if (!generated || !url) {
        throw new Error('No valid narration files found. Please generate narrations first.');
      }
      window.isAlignedNarrationAvailable = true;
      window.dispatchEvent(new CustomEvent('aligned-narration-ready', {
        detail: {
          url,
          timestamp: Date.now()
        }
      }));

    } catch (error) {
      console.error('Error during aligned narration regeneration:', error);

      // Dispatch aligned-narration-status event for auto-dismissing toast
      window.dispatchEvent(new CustomEvent('aligned-narration-status', {
        detail: {
          status: 'error',
          message: error.message || 'Failed to refresh narration',
          isStillGenerating: false
        }
      }));
    } finally {
      setIsRefreshingNarration(false);
    }
  };

  return {
    isRefreshingNarration,
    currentNarrationResults,
    isAlignedNarrationAvailable,
    hasNarrationSegments,
    getNarrationAudioUrl,
    getNarrationArtifactId,
    handleRefreshNarration,
  };
};

export default useNarration;
