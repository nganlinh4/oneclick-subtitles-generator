/**
 * Utility functions for timeline calculations
 */

import { createTimelineDomain } from './timelineDomain';


/**
 * Calculate visible time range based on current parameters
 * @param {Array} lyrics - Array of lyric objects
 * @param {number} duration - Total duration of the video
 * @param {number} panOffset - Current pan offset
 * @param {number} zoom - Current zoom level
 * @param {number} currentTime - Current playback time
 * @returns {Object} - Object with start, end, and total properties
 */
export const getVisibleTimeRange = (lyrics, duration, panOffset, zoom, _currentZoom) => {
  const timelineEnd = createTimelineDomain(lyrics, duration).viewEnd;

  // Use zoom directly without minimum restriction
  const effectiveZoom = zoom;

  // Calculate visible duration based on zoom
  const visibleDuration = timelineEnd / effectiveZoom;

  const start = panOffset;
  const end = Math.min(timelineEnd, start + visibleDuration);

  return { start, end, total: timelineEnd, effectiveZoom };
};

/**
 * Calculate visible time range with a temporary pan offset
 * @param {Array} lyrics - Array of lyric objects
 * @param {number} duration - Total duration of the video
 * @param {number} tempPanOffset - Temporary pan offset
 * @param {number} currentZoom - Current zoom level
 * @returns {Object} - Object with start, end, and total properties
 */
export const calculateVisibleTimeRange = (lyrics, duration, tempPanOffset, currentZoom) => {
  const timelineEnd = createTimelineDomain(lyrics, duration).viewEnd;

  // Use zoom directly without minimum restriction
  const effectiveZoom = currentZoom;

  // Calculate visible duration based on zoom
  const visibleDuration = timelineEnd / effectiveZoom;

  const start = tempPanOffset;
  const end = Math.min(timelineEnd, start + visibleDuration);

  return { start, end, total: timelineEnd };
};

/**
 * Convert time to x coordinate on the canvas
 * @param {number} time - Time in seconds
 * @param {number} visibleStart - Start of visible time range
 * @param {number} visibleDuration - Duration of visible time range
 * @param {number} displayWidth - Width of the canvas in pixels
 * @returns {number} - X coordinate on the canvas
 */
export const timeToX = (time, visibleStart, visibleDuration, displayWidth) => {
  return ((time - visibleStart) / visibleDuration) * displayWidth;
};
