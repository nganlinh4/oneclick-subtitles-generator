/**
 * Subtitle merging utilities for segment-based processing
 * Handles merging new segment results with existing subtitles
 */

/**
 * Preserve the parts of a subtitle track outside a replaced half-open range.
 * Rows crossing either boundary are copied and clamped; rows that do not
 * overlap are retained by reference. Walking the track once also prevents the
 * independently-filtered progressive path from duplicating or dropping a
 * cross-segment row.
 */
const preserveOutsideRange = (subtitles, rangeStart, rangeEnd) => {
  if (rangeEnd <= rangeStart) return [...subtitles];

  const preserved = [];
  for (const subtitle of subtitles) {
    if (subtitle.end <= rangeStart || subtitle.start >= rangeEnd) {
      preserved.push(subtitle);
      continue;
    }

    if (subtitle.start < rangeStart) {
      const left = { ...subtitle, end: rangeStart };
      if (left.end > left.start) preserved.push(left);
    }

    if (subtitle.end > rangeEnd) {
      const right = { ...subtitle, start: rangeEnd };
      if (right.end > right.start) preserved.push(right);
    }
  }

  return preserved;
};

/**
 * Merge new segment subtitles with existing subtitles
 * Replaces any existing subtitles that overlap with the segment time range
 * @param {Array} existingSubtitles - Current subtitle array
 * @param {Array} newSegmentSubtitles - New subtitles from segment processing
 * @param {Object} segment - Segment info with start and end times
 * @returns {Array} - Merged subtitle array
 */
export const mergeSegmentSubtitles = (existingSubtitles, newSegmentSubtitles, segment) => {
  if (!existingSubtitles || existingSubtitles.length === 0) {
    // If no existing subtitles, just return the new ones
    return newSegmentSubtitles || [];
  }

  const { start: segmentStart, end: segmentEnd } = segment;
  const preserved = preserveOutsideRange(existingSubtitles, segmentStart, segmentEnd);

  // Combine replacement rows with the preserved portions of the old track.
  const mergedSubtitles = [
    ...preserved,
    ...(newSegmentSubtitles || [])
  ];

  // Sort by start time to ensure proper order
  mergedSubtitles.sort((a, b) => a.start - b.start);

  return mergedSubtitles;
};

/**
 * Progressive merge for streaming subtitles - clears left to right as new subtitles come in
 * Only clears up to the rightmost subtitle received so far, not the entire segment
 * @param {Array} existingSubtitles - Current subtitle array
 * @param {Array} newStreamingSubtitles - New subtitles from streaming (partial)
 * @param {Object} segment - Segment info with start and end times
 * @returns {Array} - Progressively merged subtitle array
 */
export const mergeStreamingSubtitlesProgressively = (existingSubtitles, newStreamingSubtitles, segment) => {
  if (!existingSubtitles || existingSubtitles.length === 0) {
    // If no existing subtitles, just return the new ones
    return newStreamingSubtitles || [];
  }

  if (!newStreamingSubtitles || newStreamingSubtitles.length === 0) {
    // If no new subtitles, return existing ones
    return existingSubtitles;
  }

  const { start: segmentStart, end: segmentEnd } = segment;

  const progressiveEndTime = newStreamingSubtitles.reduce(
    (latestEnd, subtitle) => Math.max(latestEnd, subtitle.end),
    segmentStart
  );
  const effectiveProgressiveEnd = Math.min(progressiveEndTime, segmentEnd);
  const preserved = preserveOutsideRange(
    existingSubtitles,
    segmentStart,
    effectiveProgressiveEnd
  );

  const mergedSubtitles = [
    ...preserved,
    ...newStreamingSubtitles,
  ];

  // Sort by start time to ensure proper order
  mergedSubtitles.sort((a, b) => a.start - b.start);

  return mergedSubtitles;
};

/**
 * Check if a subtitle overlaps with a time range
 * @param {Object} subtitle - Subtitle object with start and end times
 * @param {number} rangeStart - Start time of the range
 * @param {number} rangeEnd - End time of the range
 * @returns {boolean} - True if subtitle overlaps with the range
 */
export const subtitleOverlapsWithRange = (subtitle, rangeStart, rangeEnd) => {
  return !(subtitle.end <= rangeStart || subtitle.start >= rangeEnd);
};

/**
 * Get subtitles that fall within a specific time range
 * @param {Array} subtitles - Array of subtitle objects
 * @param {number} rangeStart - Start time of the range
 * @param {number} rangeEnd - End time of the range
 * @returns {Array} - Subtitles within the range
 */
export const getSubtitlesInRange = (subtitles, rangeStart, rangeEnd) => {
  return subtitles.filter(sub => subtitleOverlapsWithRange(sub, rangeStart, rangeEnd));
};

/**
 * Remove subtitles that fall within a specific time range
 * @param {Array} subtitles - Array of subtitle objects
 * @param {number} rangeStart - Start time of the range
 * @param {number} rangeEnd - End time of the range
 * @returns {Array} - Subtitles outside the range
 */
export const removeSubtitlesInRange = (subtitles, rangeStart, rangeEnd) => {
  return subtitles.filter(sub => !subtitleOverlapsWithRange(sub, rangeStart, rangeEnd));
};

/**
 * Validate and clean subtitle array
 * @param {Array} subtitles - Array of subtitle objects
 * @returns {Array} - Cleaned subtitle array
 */
export const validateAndCleanSubtitles = (subtitles) => {
  if (!Array.isArray(subtitles)) {
    return [];
  }

  return subtitles
    .filter(sub =>
      sub &&
      typeof sub.start === 'number' &&
      typeof sub.end === 'number' &&
      sub.start < sub.end &&
      typeof sub.text === 'string' &&
      sub.text.trim().length > 0
    )
    .sort((a, b) => a.start - b.start);
};
