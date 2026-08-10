/**
 * Utility functions for timeline calculations
 */

/**
 * Calculate minimum zoom level - now always returns 1 to allow full zoom out
 * @param {number} totalDuration - Total duration of the timeline in seconds
 * @returns {number} - Minimum zoom level (always 1)
 */
export const calculateMinZoom = (_totalDuration) => {
  return 1; // Always allow 100% zoom (showing entire timeline)
};

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
  const maxLyricTime = lyrics.length > 0
    ? Math.max(...lyrics.map(lyric => lyric.end))
    : duration;
  const timelineEnd = Math.max(maxLyricTime, duration) * 1.05;

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
  const maxLyricTime = lyrics.length > 0
    ? Math.max(...lyrics.map(lyric => lyric.end))
    : duration;
  const timelineEnd = Math.max(maxLyricTime, duration) * 1.05;

  // Use zoom directly without minimum restriction
  const effectiveZoom = currentZoom;

  // Calculate visible duration based on zoom
  const visibleDuration = timelineEnd / effectiveZoom;

  const start = tempPanOffset;
  const end = Math.min(timelineEnd, start + visibleDuration);

  return { start, end, total: timelineEnd };
};

/**
 * Calculate the playhead position on screen
 * @param {Object} timelineRef - Reference to the canvas element
 * @param {number} currentTime - Current playback time
 * @param {Object} visibleTimeRange - Visible time range object
 * @param {number} duration - Total duration of the video
 * @returns {number|null} - Pixel position of the playhead or null if not visible
 */
export const calculatePlayheadPosition = (timelineRef, currentTime, visibleTimeRange, duration) => {
  if (!timelineRef || !duration) return null;

  const canvas = timelineRef;
  const displayWidth = canvas.clientWidth;

  const { start: visibleStart, end: visibleEnd } = visibleTimeRange;
  const visibleDuration = visibleEnd - visibleStart;

  // Calculate the pixel position
  if (currentTime >= visibleStart && currentTime <= visibleEnd) {
    return ((currentTime - visibleStart) / visibleDuration) * displayWidth;
  }

  return null;
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
