/**
 * Utility functions for aligned narration
 */

/**
 * Create a deep hash of an object for comparison
 * @param {any} obj - Object to hash
 * @returns {string} - Hash string
 */
export const createHash = (obj) => {
  if (!obj) return 'null';

  // For arrays, hash each element and join
  if (Array.isArray(obj)) {
    return obj.map(item => createHash(item)).join('|');
  }

  // For objects, sort keys and hash each key-value pair
  if (typeof obj === 'object') {
    return Object.keys(obj)
      .sort()
      .map(key => {
        // Only include specific properties we care about for comparison
        // Focus on timing-related properties to prevent unnecessary regeneration
        if (['id', 'subtitle_id', 'start', 'end', 'filename', 'audioData', 'success'].includes(key)) {
          // For timing values, round to 2 decimal places to avoid tiny changes triggering regeneration
          if (key === 'start' || key === 'end') {
            const value = obj[key];
            if (typeof value === 'number') {
              return `${key}:${Math.round(value * 100) / 100}`;
            }
          }
          return `${key}:${createHash(obj[key])}`;
        }
        return '';
      })
      .filter(Boolean)
      .join('|');
  }

  // For primitives, convert to string
  return String(obj);
};

/**
 * Enhance narration results with subtitle timing information
 * @param {Array} generationResults - Array of narration results
 * @param {Object} subtitleMap - Map of subtitles by ID
 * @returns {Array} - Enhanced narration results with timing information
 */
export const enhanceNarrationWithTiming = (generationResults, subtitleMap) => {
  if (!generationResults || !subtitleMap) {
    console.warn('Missing generationResults or subtitleMap in enhanceNarrationWithTiming');
    return generationResults;
  }




  // These counts were used for debugging but are not currently used
  // const f5ttsCount = generationResults.filter(r => r.filename && !r.audioData).length;
  // const geminiCount = generationResults.filter(r => r.audioData).length;
  // const unknownCount = generationResults.filter(r => !r.filename && !r.audioData).length;


  // Check if any narration has been retried recently
  const hasRecentRetry = generationResults.some(result =>
    result.retriedAt && result.retriedAt > Date.now() - 60000 // Consider retries in the last minute as "recent"
  );

  // If any narration has been retried recently, force regeneration
  if (hasRecentRetry) {
    // The flag is applied to every mapped narration below.
  }

  return generationResults.map(result => {
    // Get the correct subtitle ID from the result
    const subtitleId = result.subtitle_id;

    // Log the lookup attempt for debugging
    const narrationType = result.filename ? 'F5-TTS' : (result.audioData ? 'Gemini' : 'Unknown');
    const isGrouped = result.original_ids && result.original_ids.length > 1;

    // Get the subtitle from the map using the exact ID from the result
    let subtitle = subtitleMap[subtitleId];

    // If this is a grouped subtitle and we couldn't find it directly in the map,
    // we might need to calculate its timing from the original subtitles
    if (!subtitle && isGrouped && result.original_ids) {
      console.log(`Handling grouped subtitle ${subtitleId} with ${result.original_ids.length} original IDs`);

      // Get all the original subtitles that are part of this group
      const originalSubtitles = result.original_ids
        .map(id => subtitleMap[id])
        .filter(Boolean);

      if (originalSubtitles.length > 0) {
        // Calculate start and end times from the original subtitles
        const start = Math.min(...originalSubtitles.map(sub => sub.start));
        const end = Math.max(...originalSubtitles.map(sub => sub.end));

        // Create a synthetic subtitle with the calculated timing
        subtitle = {
          id: subtitleId,
          start,
          end,
          text: result.text
        };

        console.log(`Created synthetic timing for grouped subtitle ${subtitleId}: start=${start}, end=${end}`);
      }
    }

    // Check if this specific narration has been retried
    const wasRetried = result.retriedAt && result.retriedAt > Date.now() - 60000; // Within the last minute

    // If we found a matching subtitle or created synthetic timing, use it
    if (subtitle && typeof subtitle.start === 'number' && typeof subtitle.end === 'number') {
      // For grouped subtitles, make sure to include the original_ids in the result
      return {
        ...result,
        start: subtitle.start,
        end: subtitle.end,
        // Preserve original_ids if they exist
        original_ids: result.original_ids || [subtitleId],
        // Add forceRegenerate flag if this narration was retried or any narration was retried recently
        forceRegenerate: wasRetried || hasRecentRetry
      };
    } else {
      console.warn(`No timing found for ${isGrouped ? 'grouped ' : ''}subtitle ${subtitleId}. Using defaults.${wasRetried ? ' (RETRIED)' : ''} (${narrationType} narration)`);

      // Otherwise, keep existing timing or use defaults
      return {
        ...result,
        start: result.start || 0,
        end: result.end || (result.start ? result.start + 5 : 5),
        // Preserve original_ids if they exist
        original_ids: result.original_ids || [subtitleId],
        // Add forceRegenerate flag if this narration was retried or any narration was retried recently
        forceRegenerate: wasRetried || hasRecentRetry
      };
    }
  });
};

/**
 * Create a map of subtitles by ID
 * @param {Array} subtitles - Array of subtitles
 * @returns {Object} - Map of subtitles by ID
 */
export const createSubtitleMap = (subtitles) => {
  if (!subtitles || !Array.isArray(subtitles)) {
    console.warn('No subtitles provided to createSubtitleMap or not an array');
    return {};
  }



  const map = {};
  subtitles.forEach((subtitle, index) => {
    if (subtitle && subtitle.id) {
      // Store the subtitle in the map using its ID as the key
      map[subtitle.id] = subtitle;

      // Log the first few and last few for debugging
      if (index < 3 || index >= subtitles.length - 3) {
        // Verbose per-subtitle logging is intentionally disabled.
      }
    } else {
      console.warn(`Subtitle at index ${index} has no ID or is invalid:`, subtitle);
    }
  });


  return map;
};

/**
 * Get all available subtitles from various sources
 * @returns {Array} - Combined array of subtitles
 */
export const getAllSubtitles = () => {
  const allSubtitles = [];
  const sources = {};

  // Try to get subtitles from window.subtitles (main source)
  if (window.subtitles && Array.isArray(window.subtitles)) {

    sources.subtitles = window.subtitles;
  }

  // Also check window.subtitlesData (alternative source)
  if (window.subtitlesData && Array.isArray(window.subtitlesData)) {

    sources.subtitlesData = window.subtitlesData;
  }

  // Also check window.originalSubtitles (for original language)
  if (window.originalSubtitles && Array.isArray(window.originalSubtitles)) {

    sources.originalSubtitles = window.originalSubtitles;
  }

  // Also check window.translatedSubtitles (for translated language)
  if (window.translatedSubtitles && Array.isArray(window.translatedSubtitles)) {

    sources.translatedSubtitles = window.translatedSubtitles;
  }

  // Determine which source to use based on which has the most subtitles
  // This helps ensure we're using the most complete set of subtitles
  let bestSource = null;
  let maxLength = 0;

  for (const [sourceName, subtitles] of Object.entries(sources)) {
    if (subtitles.length > maxLength) {
      maxLength = subtitles.length;
      bestSource = sourceName;
    }
  }

  if (bestSource) {

    allSubtitles.push(...sources[bestSource]);
  } else {
    console.warn('No subtitle sources found');
  }

  // Validate that all subtitles have proper timing information
  const validSubtitles = allSubtitles.filter(subtitle => {
    const isValid = subtitle &&
                   subtitle.id &&
                   typeof subtitle.start === 'number' &&
                   typeof subtitle.end === 'number';

    if (!isValid) {
      console.warn('Found invalid subtitle:', subtitle);
    }

    return isValid;
  });



  return validSubtitles;
};
