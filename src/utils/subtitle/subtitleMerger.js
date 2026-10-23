/**
 * Subtitle merging utilities for segment-based processing
 * Handles merging new segment results with existing subtitles
 */

/**
 * Preserve the parts of a subtitle track outside a replaced half-open range.
 * Rows crossing either boundary are copied and clamped; rows that do not
 * overlap are retained by reference.
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
