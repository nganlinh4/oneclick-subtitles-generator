/**
 * Utility functions for parallel video processing
 */


/**
 * Split a segment into multiple sub-segments for parallel processing
 * @param {Object} segment - The original segment { start: number, end: number } in seconds
 * @param {number} maxDurationPerRequest - Maximum duration per request in seconds
 * @returns {Array} Array of sub-segments for parallel processing
 */
export const splitSegmentForParallelProcessing = (segment, maxDurationPerRequest) => {
  if (!segment || !maxDurationPerRequest) {
    throw new Error('Invalid input: segment and maxDurationPerRequest are required');
  }

  const { start, end } = segment;
  const totalDuration = end - start;

  // If the segment is within the max duration, no need to split
  if (totalDuration <= maxDurationPerRequest) {
    return [{
      ...segment,
      index: 0,
      isParallel: false
    }];
  }

  // Calculate the number of sub-segments needed
  const numSegments = Math.ceil(totalDuration / maxDurationPerRequest);

  // Calculate the optimal duration per segment (evenly distribute)
  const optimalDuration = totalDuration / numSegments;

  const subSegments = [];
  for (let i = 0; i < numSegments; i++) {
    const segmentStart = start + (i * optimalDuration);
    const segmentEnd = i === numSegments - 1
      ? end // Ensure last segment goes exactly to the end
      : start + ((i + 1) * optimalDuration);

    subSegments.push({
      start: segmentStart,
      end: segmentEnd,
      index: i,
      totalSegments: numSegments,
      isParallel: true,
      originalSegment: segment
    });
  }


  return subSegments;
};

/**
 * Merge subtitles from multiple parallel segments
 * @param {Array} segmentResults - Array of { segment: Object, subtitles: Array }
 * @returns {Array} Merged and sorted subtitles
 */
export const mergeParallelSubtitles = (segmentResults) => {
  if (!segmentResults || !Array.isArray(segmentResults)) {
    return [];
  }

  // Collect all subtitles from all segments
  const allSubtitles = [];

  segmentResults.forEach(result => {
    if (result.subtitles && Array.isArray(result.subtitles)) {
      // Ensure each subtitle is within its segment bounds
      const segment = result.segment;
      result.subtitles.forEach(subtitle => {
        // Validate and clip subtitle timing to segment bounds
        const clippedSubtitle = {
          ...subtitle,
          start: Math.max(subtitle.start, segment.start),
          end: Math.min(subtitle.end, segment.end),
          segmentIndex: segment.index // Track which segment this came from
        };

        // Only add if the subtitle has valid duration after clipping
        if (clippedSubtitle.start < clippedSubtitle.end) {
          allSubtitles.push(clippedSubtitle);
        }
      });
    }
  });

  // Sort subtitles by start time
  allSubtitles.sort((a, b) => a.start - b.start);

  // Remove duplicates and overlaps
  const mergedSubtitles = [];
  let lastSubtitle = null;

  allSubtitles.forEach(subtitle => {
    if (!lastSubtitle) {
      mergedSubtitles.push(subtitle);
      lastSubtitle = subtitle;
    } else {
      // Check for overlap or duplicate
      const isOverlapping = subtitle.start < lastSubtitle.end;
      const isDuplicate = Math.abs(subtitle.start - lastSubtitle.start) < 0.1 &&
                         subtitle.text === lastSubtitle.text;

      if (isDuplicate) {
        // Skip duplicate
        return;
      } else if (isOverlapping) {
        // Handle overlap by adjusting timing
        // If subtitles are from different segments, prefer boundary adjustment
        if (lastSubtitle.segmentIndex !== subtitle.segmentIndex) {
          // Adjust the end of the previous subtitle to the start of the current one
          lastSubtitle.end = Math.min(lastSubtitle.end, subtitle.start);
        }
        mergedSubtitles.push(subtitle);
        lastSubtitle = subtitle;
      } else {
        // No overlap, add normally
        mergedSubtitles.push(subtitle);
        lastSubtitle = subtitle;
      }
    }
  });

  // Clean up segment tracking info
  const finalSubtitles = mergedSubtitles.map(({ segmentIndex: _segmentIndex, ...subtitle }) => subtitle);

  return finalSubtitles;
};
