/**
 * Utility functions for enhancing narration results with additional metadata
 */

/**
 * Enhance F5-TTS narration results with timing information from subtitles
 * This ensures F5-TTS narrations have the same metadata as Gemini narrations
 * for proper alignment and playback in the video player.
 *
 * @param {Array} narrationResults - Array of narration results from F5-TTS
 * @param {Array} subtitles - Array of subtitles with timing information
 * @returns {Array} - Enhanced narration results with timing information
 */
export const enhanceF5TTSNarrations = (narrationResults, subtitles) => {
  if (!narrationResults || !Array.isArray(narrationResults) || narrationResults.length === 0) {
    console.warn('No narration results to enhance');
    return narrationResults;
  }

  if (!subtitles || !Array.isArray(subtitles) || subtitles.length === 0) {
    console.warn('No subtitles available for enhancing narrations');
    return narrationResults;
  }

  // Create a map of subtitles by ID for quick lookup
  const subtitleMap = {};
  subtitles.forEach(subtitle => {
    const id = subtitle.id || subtitle.index;
    if (id) {
      subtitleMap[id] = subtitle;
    }
  });

  // Enhance each narration result with timing information
  return narrationResults.map(result => {
    // Create a base enhanced result
    const enhancedResult = { ...result };

    // Add timing information if missing
    if (typeof result.start !== 'number' || typeof result.end !== 'number') {
      // Find the corresponding subtitle
      const subtitle = subtitleMap[result.subtitle_id];

      // If we found a matching subtitle with timing information, use it
      if (subtitle && typeof subtitle.start === 'number' && typeof subtitle.end === 'number') {
        enhancedResult.start = subtitle.start;
        enhancedResult.end = subtitle.end;
      } else {
        // If no matching subtitle or no timing information, use default values
        enhancedResult.start = 0;
        enhancedResult.end = 5; // Default 5 seconds duration
      }
    }

    // Ensure filename is set if the narration was successful
    if (result.success && !result.filename) {
      // If the narration has audioData but no filename, it means it's still being saved
      if (result.audioData) {
        // Keep as is, the filename will be set after saving
      }
      // Do not add default filename for narrations without audioData
    }

    return enhancedResult;
  });
};
