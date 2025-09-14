/**
 * Utility functions for timeline interactions
 */

// calculateMinZoom is no longer needed since we removed zoom restrictions

/**
 * Center the timeline view on a specific time
 * @param {number} time - Time to center on
 * @param {Array} lyrics - Array of lyric objects
 * @param {number} duration - Total duration of the video
 * @param {number} currentZoom - Current zoom level
 * @param {Function} setPanOffset - Function to set the pan offset
 * @param {Object} lastManualPanTime - Ref to track last manual interaction time
 */
export const centerTimelineOnTime = (
  time,
  lyrics,
  duration,
  currentZoom,
  setPanOffset,
  lastManualPanTime
) => {
  if (!duration) return;

  // Get the current timeline end
  const maxLyricTime = lyrics.length > 0
    ? Math.max(...lyrics.map(lyric => lyric.end))
    : duration;
  const timelineEnd = Math.max(maxLyricTime, duration) * 1.05;

  // Use zoom directly without restrictions
  const effectiveZoom = currentZoom;

  // Calculate visible duration based on zoom
  const totalVisibleDuration = timelineEnd / effectiveZoom;
  const halfVisibleDuration = totalVisibleDuration / 2;

  // Center the view on the specified time
  const newPanOffset = Math.max(0, Math.min(time - halfVisibleDuration, timelineEnd - totalVisibleDuration));

  // Update the pan offset
  setPanOffset(newPanOffset);

  // Record this as a manual interaction to prevent auto-scrolling
  if (lastManualPanTime) {
    lastManualPanTime.current = performance.now();
  }

};

/**
 * Handle timeline click
 * @param {Event} e - Click event
 * @param {Object} timelineRef - Reference to the canvas element
 * @param {number} duration - Total duration of the video
 * @param {Function} onTimelineClick - Function to call when timeline is clicked
 * @param {Object} visibleTimeRange - Visible time range object
 * @param {Object} lastManualPanTime - Ref to track last manual interaction time
 */
export const handleTimelineClick = (
  e,
  timelineRef,
  duration,
  onTimelineClick,
  visibleTimeRange,
  lastManualPanTime
) => {
  // Check if we can handle the click
  if (!timelineRef || !duration || !onTimelineClick) {
    return;
  }

  const rect = timelineRef.getBoundingClientRect();
  const clickX = e.clientX - rect.left;
  const { start: visibleStart, end: visibleEnd } = visibleTimeRange;
  const visibleDuration = visibleEnd - visibleStart;

  // Calculate the new time based on click position
  const newTime = visibleStart + (clickX / rect.width) * visibleDuration;

  if (newTime >= 0 && newTime <= duration) {
    // Record this as a manual interaction to prevent auto-scrolling
    if (lastManualPanTime) {
      lastManualPanTime.current = performance.now();
    }

    // Just seek to the new time without changing the view position
    // This eliminates the shaking effect by avoiding multiple view transitions
    onTimelineClick(Math.min(duration, newTime));

    // The view will be centered automatically when the currentTime prop updates
    // This creates a single, smooth transition instead of multiple jerky ones
  }
};

/**
 * Animate zoom to a target level
 * @param {number} targetZoom - Target zoom level
 * @param {Object} animationFrameRef - Reference to the animation frame
 * @param {Array} lyrics - Array of lyric objects
 * @param {number} duration - Total duration of the video
 * @param {Object} currentZoomRef - Reference to the current zoom level
 * @param {Function} drawTimeline - Function to draw the timeline
 * @param {number} currentTime - Current playback time to center zoom on
 * @param {Function} setPanOffset - Function to set the pan offset
 */
export const animateZoom = (
  targetZoom,
  animationFrameRef,
  lyrics,
  duration,
  currentZoomRef,
  drawTimeline,
  currentTime,
  setPanOffset
) => {
  if (animationFrameRef.current) {
    cancelAnimationFrame(animationFrameRef.current);
  }

  if (!duration || !setPanOffset || typeof currentTime !== 'number') {
    // Fallback to simple zoom without centering
    currentZoomRef.current = targetZoom;
    drawTimeline();
    return;
  }



  // Calculate timeline end
  const maxLyricTime = lyrics.length > 0
    ? Math.max(...lyrics.map(lyric => lyric.end))
    : duration;
  const timelineEnd = Math.max(maxLyricTime, duration) * 1.05;

  // Calculate new visible duration based on target zoom
  const newVisibleDuration = timelineEnd / targetZoom;
  const halfVisibleDuration = newVisibleDuration / 2;

  // Center the view on the current playhead position
  const newPanOffset = Math.max(0, Math.min(
    currentTime - halfVisibleDuration,
    timelineEnd - newVisibleDuration
  ));



  // Update zoom first
  currentZoomRef.current = targetZoom;
  
  // Use requestAnimationFrame to ensure pan offset is set after zoom
  requestAnimationFrame(() => {
    setPanOffset(newPanOffset);
    
    // Redraw timeline after both zoom and pan are updated
    requestAnimationFrame(() => {
      drawTimeline();
    });
  });
};
