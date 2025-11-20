/**
 * Utility functions for drawing the timeline visualization
 */

import { getLyricColor, getRandomHeight } from './ColorUtils';
import { timeToX } from './TimelineCalculations';
// Legacy segment optimization is no longer needed with simplified processing
// import { optimizeSegments, clearUnusedSegments } from '../../../utils/colorfulSegmentsOptimizer';
import { formatTime } from '../../../utils/timeFormatter';

/**
 * Draw the timeline visualization
 * @param {Object} canvas - Canvas element
 * @param {number} duration - Total duration of the video
 * @param {Array} lyrics - Array of lyric objects
 * @param {number} currentTime - Current playback time
 * @param {Object} visibleTimeRange - Visible time range object
 * @param {number} panOffset - Current pan offset
 * @param {boolean} isActivePanning - Whether the user is actively panning
 * @param {string} timeFormat - Time format to use
 * @param {Object} segmentData - Segment selection data
 */
export const drawTimeline = (
  canvas,
  duration,
  lyrics,
  currentTime,
  visibleTimeRange,
  panOffset,
  isActivePanning,
  timeFormat,
  segmentData = null
) => {
  if (!canvas) return;

  // Use a default duration if none is provided
  const effectiveDuration = duration || 60;

  const ctx = canvas.getContext('2d', { alpha: false }); // Optimize for non-transparent canvas
  const displayWidth = canvas.clientWidth;
  const displayHeight = canvas.clientHeight;

  // Set canvas dimensions with proper DPR handling
  const dpr = window.devicePixelRatio || 1;
  const scaledWidth = displayWidth * dpr;
  const scaledHeight = displayHeight * dpr;

  // Only resize canvas if dimensions have changed
  if (canvas.width !== scaledWidth || canvas.height !== scaledHeight) {
    canvas.width = scaledWidth;
    canvas.height = scaledHeight;
    ctx.scale(dpr, dpr);
  }

  // Get computed colors from the container element for theme support
  const computedStyle = getComputedStyle(canvas.parentElement);
  const bgColor = computedStyle.backgroundColor;
  const borderColor = computedStyle.borderColor;
  const textColor = computedStyle.color;
  const primaryColor = getComputedStyle(document.documentElement).getPropertyValue('--primary-color').trim();
  const isDark = computedStyle.backgroundColor.includes('rgb(30, 30, 30)');

  const { start: visibleStart, end: visibleEnd } = visibleTimeRange;
  const visibleDuration = visibleEnd - visibleStart;

  // Clear the canvas with a single operation
  ctx.fillStyle = bgColor;
  ctx.fillRect(0, 0, displayWidth, displayHeight);

  // Draw time markers and labels
  drawTimeMarkers(
    ctx,
    visibleStart,
    visibleEnd,
    visibleDuration,
    displayWidth,
    displayHeight,
    borderColor,
    textColor,
    isActivePanning,
    timeFormat
  );

  // Draw lyric segments with new segment animations
  drawLyricSegments(
    ctx,
    lyrics,
    visibleStart,
    visibleEnd,
    visibleDuration,
    displayWidth,
    displayHeight,
    isDark,
    isActivePanning,
    segmentData ? segmentData.newSegments : null
  );

  // Draw current time indicator
  drawPlayhead(
    ctx,
    currentTime,
    visibleStart,
    visibleEnd,
    visibleDuration,
    displayWidth,
    displayHeight,
    primaryColor
  );

  // Draw segment selection overlay
  if (segmentData) {
    const { selectedSegment, isDraggingSegment, dragStartTime, dragCurrentTime, isProcessing, selectedIsProcessing, animationTime, processingRanges } = segmentData;

    // Draw selected segment
    if (selectedSegment && !isDraggingSegment) {
      const startX = timeToX(selectedSegment.start, visibleStart, visibleDuration, displayWidth);
      const endX = timeToX(selectedSegment.end, visibleStart, visibleDuration, displayWidth);

      if (startX < displayWidth && endX > 0) {
        // Calculate animation values for processing state
        let opacity = 0.2;
        let borderOpacity = 0.8;

        if ((selectedIsProcessing ?? isProcessing) && animationTime !== undefined) {
          // Create a pulsing effect while processing for the selected band only when flagged
          const pulse = Math.sin(animationTime * 0.003) * 0.5 + 0.5; // 0 to 1 oscillation
          opacity = 0.15 + pulse * 0.25; // Oscillate between 0.15 and 0.4
          borderOpacity = 0.6 + pulse * 0.4; // Oscillate between 0.6 and 1.0

          // Add seamless shimmer effect
          const segmentWidth = endX - startX;
          const shimmerWidth = 100; // Width of the shimmer gradient
          const totalCycleWidth = segmentWidth + shimmerWidth;

          // Create a seamless loop by having the shimmer go beyond the segment and wrap around
          const shimmerProgress = (animationTime * 0.08) % totalCycleWidth;
          const shimmerX = shimmerProgress - shimmerWidth / 2;

          // Create two gradients for seamless looping
          const gradient = ctx.createLinearGradient(startX, 0, endX, 0);

          // Calculate normalized positions for gradient stops
          const shimmerPos = shimmerX / segmentWidth;
          const shimmerStart = Math.max(0, Math.min(1, shimmerPos - 0.1));
          const shimmerMid = Math.max(0, Math.min(1, shimmerPos));
          const shimmerEnd = Math.max(0, Math.min(1, shimmerPos + 0.1));

          // Build gradient with smooth transitions - theme aware
          if (isDark) {
            // Dark theme - use lighter blues for shimmer
            if (shimmerPos < 0.1) {
              // Shimmer entering from left
              gradient.addColorStop(0, `rgba(99, 170, 255, ${opacity + 0.15})`);
              gradient.addColorStop(shimmerEnd, `rgba(59, 130, 246, ${opacity})`);
              gradient.addColorStop(1, `rgba(59, 130, 246, ${opacity})`);
            } else if (shimmerPos > 0.9) {
              // Shimmer exiting to right
              gradient.addColorStop(0, `rgba(59, 130, 246, ${opacity})`);
              gradient.addColorStop(shimmerStart, `rgba(59, 130, 246, ${opacity})`);
              gradient.addColorStop(1, `rgba(99, 170, 255, ${opacity + 0.15})`);
            } else {
              // Shimmer in middle
              gradient.addColorStop(0, `rgba(59, 130, 246, ${opacity})`);
              gradient.addColorStop(shimmerStart, `rgba(59, 130, 246, ${opacity})`);
              gradient.addColorStop(shimmerMid, `rgba(99, 170, 255, ${opacity + 0.15})`);
              gradient.addColorStop(shimmerEnd, `rgba(59, 130, 246, ${opacity})`);
              gradient.addColorStop(1, `rgba(59, 130, 246, ${opacity})`);
            }
          } else {
            // Light theme - use stronger blues for better visibility
            const baseOpacity = opacity * 1.2; // Slightly stronger opacity for light theme
            if (shimmerPos < 0.1) {
              // Shimmer entering from left
              gradient.addColorStop(0, `rgba(59, 130, 246, ${baseOpacity + 0.2})`);
              gradient.addColorStop(shimmerEnd, `rgba(37, 99, 235, ${baseOpacity})`);
              gradient.addColorStop(1, `rgba(37, 99, 235, ${baseOpacity})`);
            } else if (shimmerPos > 0.9) {
              // Shimmer exiting to right
              gradient.addColorStop(0, `rgba(37, 99, 235, ${baseOpacity})`);
              gradient.addColorStop(shimmerStart, `rgba(37, 99, 235, ${baseOpacity})`);
              gradient.addColorStop(1, `rgba(59, 130, 246, ${baseOpacity + 0.2})`);
            } else {
              // Shimmer in middle
              gradient.addColorStop(0, `rgba(37, 99, 235, ${baseOpacity})`);
              gradient.addColorStop(shimmerStart, `rgba(37, 99, 235, ${baseOpacity})`);
              gradient.addColorStop(shimmerMid, `rgba(59, 130, 246, ${baseOpacity + 0.2})`);
              gradient.addColorStop(shimmerEnd, `rgba(37, 99, 235, ${baseOpacity})`);
              gradient.addColorStop(1, `rgba(37, 99, 235, ${baseOpacity})`);
            }
          }
          ctx.fillStyle = gradient;
        } else {
          // Static blue when not processing - theme aware
          if (isDark) {
            ctx.fillStyle = `rgba(59, 130, 246, ${opacity})`;
          } else {
            ctx.fillStyle = `rgba(37, 99, 235, ${opacity * 1.2})`; // Stronger blue for light theme
          }
        }

        // Draw segment background full height (legacy behavior user prefers)
        ctx.fillRect(Math.max(0, startX), 0, Math.min(displayWidth, endX) - Math.max(0, startX), displayHeight);

        // Draw segment borders full height
        if (isDark) {
          ctx.strokeStyle = `rgba(59, 130, 246, ${borderOpacity})`;
        } else {
          ctx.strokeStyle = `rgba(37, 99, 235, ${Math.min(1, borderOpacity * 1.2)})`; // Stronger blue for light theme
        }
        ctx.lineWidth = (selectedIsProcessing ?? isProcessing) ? 2.5 : 2;
        ctx.beginPath();
        if (startX >= 0 && startX <= displayWidth) {
          ctx.moveTo(startX, 0);
          ctx.lineTo(startX, displayHeight);
        }
        if (endX >= 0 && endX <= displayWidth) {
          ctx.moveTo(endX, 0);
          ctx.lineTo(endX, displayHeight);
        }
        ctx.stroke();
      }
    }

    // Draw processing ranges (single or multiple)
    if (Array.isArray(processingRanges) && processingRanges.length > 0) {
      // Iterate and draw each processing range
      for (const range of processingRanges) {
        const rangeStart = typeof range.start === 'number' ? range.start : 0;
        const rangeEnd = typeof range.end === 'number' ? range.end : rangeStart;
        const startX = timeToX(rangeStart, visibleStart, visibleDuration, displayWidth);
        const endX = timeToX(rangeEnd, visibleStart, visibleDuration, displayWidth);

        if (startX < displayWidth && endX > 0) {
          // Use a slightly different styling to distinguish from the main selected segment
          let opacity = 0.12;
          let borderOpacity = 0.6;

          const wantAnimate = (typeof range.animate === 'boolean') ? !!range.animate : true;
          if (isProcessing && animationTime !== undefined && wantAnimate) {
            const pulse = Math.sin(animationTime * 0.003 + (range.index || 0)) * 0.5 + 0.5;
            opacity = 0.1 + pulse * 0.2;
            borderOpacity = 0.4 + pulse * 0.4;

            const segmentWidth = endX - startX;
            const shimmerWidth = 80;
            const totalCycleWidth = segmentWidth + shimmerWidth;
            const shimmerProgress = (animationTime * 0.07) % totalCycleWidth;
            const shimmerX = shimmerProgress - shimmerWidth / 2;

            const gradient = ctx.createLinearGradient(startX, 0, endX, 0);
            const shimmerPos = shimmerX / segmentWidth;
            const shimmerStart = Math.max(0, Math.min(1, shimmerPos - 0.08));
            const shimmerMid = Math.max(0, Math.min(1, shimmerPos));
            const shimmerEnd = Math.max(0, Math.min(1, shimmerPos + 0.08));

            if (isDark) {
              gradient.addColorStop(0, `rgba(99, 170, 255, ${opacity + 0.1})`);
              gradient.addColorStop(shimmerStart, `rgba(59, 130, 246, ${opacity})`);
              gradient.addColorStop(shimmerMid, `rgba(99, 170, 255, ${opacity + 0.15})`);
              gradient.addColorStop(shimmerEnd, `rgba(59, 130, 246, ${opacity})`);
              gradient.addColorStop(1, `rgba(59, 130, 246, ${opacity})`);
            } else {
              const baseOpacity = opacity * 1.2;
              gradient.addColorStop(0, `rgba(37, 99, 235, ${baseOpacity})`);
              gradient.addColorStop(shimmerStart, `rgba(37, 99, 235, ${baseOpacity})`);
              gradient.addColorStop(shimmerMid, `rgba(59, 130, 246, ${baseOpacity + 0.18})`);
              gradient.addColorStop(shimmerEnd, `rgba(37, 99, 235, ${baseOpacity})`);
              gradient.addColorStop(1, `rgba(37, 99, 235, ${baseOpacity})`);
            }
            ctx.fillStyle = gradient;
          } else {
            // Static fill when not processing or not marked for animation
            if (isDark) {
              ctx.fillStyle = `rgba(59, 130, 246, ${opacity})`;
            } else {
              ctx.fillStyle = `rgba(37, 99, 235, ${opacity * 1.2})`;
            }
          }

          // Draw full height background
          ctx.fillRect(Math.max(0, startX), 0, Math.min(displayWidth, endX) - Math.max(0, startX), displayHeight);

          // Draw border
          if (isDark) {
            ctx.strokeStyle = `rgba(99, 170, 255, ${borderOpacity})`;
          } else {
            ctx.strokeStyle = `rgba(59, 130, 246, ${borderOpacity})`;
          }
          ctx.lineWidth = 1;
          ctx.strokeRect(
            Math.max(0, startX),
            0,
            Math.min(displayWidth, endX) - Math.max(0, startX),
            displayHeight
          );
        }
      }
    }

    // Draw drag preview (full height as requested)
    if (isDraggingSegment && dragStartTime !== null && dragCurrentTime !== null) {
      const start = Math.min(dragStartTime, dragCurrentTime);
      const end = Math.max(dragStartTime, dragCurrentTime);
      const startX = timeToX(start, visibleStart, visibleDuration, displayWidth);
      const endX = timeToX(end, visibleStart, visibleDuration, displayWidth);

      if (startX < displayWidth && endX > 0) {
        // Draw drag preview background - full height
        if (isDark) {
          ctx.fillStyle = 'rgba(59, 130, 246, 0.15)';
        } else {
          ctx.fillStyle = 'rgba(37, 99, 235, 0.18)';
        }
        ctx.fillRect(Math.max(0, startX), 0, Math.min(displayWidth, endX) - Math.max(0, startX), displayHeight);

        // Draw drag preview borders - full height
        if (isDark) {
          ctx.strokeStyle = 'rgba(59, 130, 246, 0.6)';
        } else {
          ctx.strokeStyle = 'rgba(37, 99, 235, 0.7)';
        }
        ctx.lineWidth = 1;
        ctx.setLineDash([5, 5]);
        ctx.beginPath();
        if (startX >= 0 && startX <= displayWidth) {
          ctx.moveTo(startX, 0);
          ctx.lineTo(startX, displayHeight);
        }
        if (endX >= 0 && endX <= displayWidth) {
          ctx.moveTo(endX, 0);
          ctx.lineTo(endX, displayHeight);
        }
        ctx.stroke();
        ctx.setLineDash([]); // Reset line dash
      }
    }
  }
};

/**
 * Draw time markers and labels on the timeline
 */
const drawTimeMarkers = (
  ctx,
  visibleStart,
  visibleEnd,
  visibleDuration,
  displayWidth,
  displayHeight,
  borderColor,
  textColor,
  isActivePanning,
  timeFormat
) => {
  // Only draw time markers if we're not actively panning or if the visible duration is reasonable
  if (isActivePanning && visibleDuration >= 300) return;

  // Calculate proper spacing for time markers based on visible duration
  const maxMarkers = 20; // Maximum number of time markers to display
  const timeStep = Math.max(1, Math.ceil(visibleDuration / maxMarkers));
  const firstMarker = Math.floor(visibleStart / timeStep) * timeStep;

  // Batch time markers drawing
  ctx.beginPath();
  ctx.strokeStyle = borderColor;
  ctx.lineWidth = 1;

  // Limit the number of markers to draw
  const markerCount = Math.min(maxMarkers, Math.ceil(visibleDuration / timeStep));

  for (let i = 0; i <= markerCount; i++) {
    const time = firstMarker + (i * timeStep);
    if (time > visibleEnd) break;

    const x = timeToX(time, visibleStart, visibleDuration, displayWidth);
    ctx.moveTo(x, 0);
    ctx.lineTo(x, displayHeight);
  }
  ctx.stroke();

  // Draw time labels - only if not actively panning for better performance
  if (!isActivePanning) {
    ctx.font = 'ultra-condensed 10px "Google Sans", "Open Sans", sans-serif';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillStyle = textColor;

    for (let i = 0; i <= markerCount; i++) {
      const time = firstMarker + (i * timeStep);
      if (time > visibleEnd) break;

      const x = timeToX(time, visibleStart, visibleDuration, displayWidth);
      // Position time labels with more space from the top
      ctx.fillText(formatTime(time, timeFormat), x + 3, 5);
    }
  }
};

/**
 * Draw lyric segments on the timeline
 */
const drawLyricSegments = (
  ctx,
  lyrics,
  visibleStart,
  visibleEnd,
  visibleDuration,
  displayWidth,
  displayHeight,
  isDark,
  isActivePanning,
  newSegments = null
) => {
  // Minimum segment width - always show segments with at least 1px
  const minSegmentWidth = 1;

  // Estimate the total duration based on the last lyric's end time
  const duration = lyrics.length > 0 ? Math.max(...lyrics.map(lyric => lyric.end)) * 1.05 : 0;

  // Use our optimized segments handler for long videos
  const isLongVideo = duration > 1800; // 30 minutes

  // Filter visible lyrics - remove segment limit to show all segments
  const visibleLyrics = [];
  const maxSegmentsToRender = Number.MAX_SAFE_INTEGER; // Show all segments

  // For long videos, use simple filtering (legacy optimization no longer needed)
  let optimizedLyrics = lyrics;
  if (isLongVideo) {
    // Simple filtering for visible segments
    optimizedLyrics = lyrics.filter(lyric => {
      const lyricEnd = lyric.end || lyric.start + 5; // Default 5 second duration
      return lyricEnd >= visibleStart && lyric.start <= visibleEnd;
    }).slice(0, maxSegmentsToRender); // Limit to max segments
  }

  // Binary search to find the approximate starting index
  let startIdx = 0;
  let endIdx = optimizedLyrics.length - 1;

  // Find the first lyric that might be visible
  while (startIdx <= endIdx) {
    const midIdx = Math.floor((startIdx + endIdx) / 2);
    const midLyric = optimizedLyrics[midIdx];

    if (midLyric.end < visibleStart) {
      startIdx = midIdx + 1;
    } else {
      endIdx = midIdx - 1;
    }
  }

  // Collect visible lyrics starting from the found index
  let segmentCount = 0;
  for (let i = startIdx; i < optimizedLyrics.length && segmentCount < maxSegmentsToRender; i++) {
    const lyric = optimizedLyrics[i];

    // Stop once we're past the visible area
    if (lyric.start > visibleEnd) break;

    const startX = timeToX(lyric.start, visibleStart, visibleDuration, displayWidth);
    const endX = timeToX(lyric.end, visibleStart, visibleDuration, displayWidth);

    // Calculate width with minimum 1px guarantee
    const calculatedWidth = endX - startX;
    const width = Math.max(minSegmentWidth, calculatedWidth); // Ensure at least 1px width
    
    // Always add the segment - no filtering by width
    visibleLyrics.push({
      lyric,
      startX,
      width: width
    });
    segmentCount++;
  }

  // If we hit the segment limit, add an indicator
  if (segmentCount >= maxSegmentsToRender && optimizedLyrics.length > maxSegmentsToRender) {

  }

  // Batch render all segments with same fill color
  if (visibleLyrics.length > 0) {
    // Group segments by color for batch rendering
    const colorGroups = new Map();

    // Reserve space at the top for time markers and labels (25px)
    const timeMarkerSpace = 25;
    const availableHeight = displayHeight - timeMarkerSpace;

    // For long videos, use a more efficient rendering approach
    const isVeryLongVideo = duration > 7200; // 2 hours

    // For very long videos, skip random heights and use fixed heights for better performance
    const useFixedHeights = isVeryLongVideo && isActivePanning;
    const fixedHeightPercentage = 0.6; // 60% of available height

    // Track segments that need animation
    const animatedSegments = [];
    
    for (const { lyric, startX, width } of visibleLyrics) {
      // Check if this segment is new and needs animation
      let isNewSegment = false;
      let animationProgress = 0;
      
      if (newSegments) {
        const segmentKey = `${lyric.start}-${lyric.end}`;
        const segmentData = newSegments.get(segmentKey);
        if (segmentData) {
          isNewSegment = true;
          const elapsed = performance.now() - segmentData.startTime;
          animationProgress = Math.min(elapsed / 800, 1); // 800ms animation
        }
      }
      
      // For very long videos during panning, use a simplified color scheme
      let fillStyle, strokeStyle;

      if (isVeryLongVideo && isActivePanning) {
        // Use a simplified color scheme for better performance
        fillStyle = isDark ? 'rgba(80, 200, 255, 0.6)' : 'rgba(93, 95, 239, 0.6)';
        strokeStyle = isDark ? 'rgba(100, 220, 255, 0.8)' : 'rgba(113, 115, 255, 0.8)';
      } else {
        // Use normal color scheme
        const colors = getLyricColor(lyric.text, isDark);
        fillStyle = colors.fillStyle;
        strokeStyle = colors.strokeStyle;
      }

      // Calculate height - either fixed or random
      const heightPercentage = useFixedHeights ? fixedHeightPercentage : getRandomHeight(lyric.text);
      
      // Store animated segments separately for special rendering
      if (isNewSegment) {
        animatedSegments.push({
          x: startX,
          width: width,
          height: heightPercentage,
          actualHeight: availableHeight * heightPercentage,
          y: timeMarkerSpace + (availableHeight * 0.5 - (availableHeight * heightPercentage * 0.5)),
          fillStyle,
          strokeStyle,
          animationProgress,
          lyric
        });
      } else {
        // Regular segments
        if (!colorGroups.has(fillStyle)) {
          colorGroups.set(fillStyle, {
            fill: fillStyle,
            stroke: strokeStyle,
            segments: []
          });
        }

        colorGroups.get(fillStyle).segments.push({
          x: startX,
          width: width,
          height: heightPercentage,
          // Calculate the actual pixel height based on available height (after reserving space for time markers)
          actualHeight: availableHeight * heightPercentage,
          // Position segments below the time marker space and center them in the remaining available height
          y: timeMarkerSpace + (availableHeight * 0.5 - (availableHeight * heightPercentage * 0.5))
        });
      }
    }

    // Render each color group in a batch
    colorGroups.forEach(group => {
      ctx.fillStyle = group.fill;

      // For very long videos, use a more efficient drawing approach
      if (isVeryLongVideo) {
        // Draw all fills for this color at once using a single path
        ctx.beginPath();
        for (const segment of group.segments) {
          ctx.rect(segment.x, segment.y, segment.width, segment.actualHeight);
        }
        ctx.fill();

        // Only draw strokes if not actively panning (for better performance)
        if (!isActivePanning) {
          ctx.strokeStyle = group.stroke;
          ctx.stroke();
        }
      } else {
        // Standard drawing for normal videos
        // Draw all fills for this color at once
        for (const segment of group.segments) {
          ctx.fillRect(segment.x, segment.y, segment.width, segment.actualHeight);
        }

        // Only draw strokes if not actively panning (for better performance)
        if (!isActivePanning) {
          ctx.strokeStyle = group.stroke;
          for (const segment of group.segments) {
            ctx.strokeRect(segment.x, segment.y, segment.width, segment.actualHeight);
          }
        }
      }
    });
    
    // Draw animated segments with smooth effects
    for (const segment of animatedSegments) {
      const progress = segment.animationProgress;
      
      // Simple easing function
      const easeOutQuad = 1 - (1 - progress) * (1 - progress);
      
      // Draw the segment with animation effects
      ctx.save();
      
      // Apply a subtle scale effect for the first half of animation
      let scale = 1;
      if (progress < 0.5) {
        scale = 1 + (0.15 * (1 - progress * 2)); // Start 15% larger, quickly scale to normal
      }
      const scaledWidth = segment.width * scale;
      const scaledHeight = segment.actualHeight * scale;
      const xOffset = (scaledWidth - segment.width) / 2;
      const yOffset = (scaledHeight - segment.actualHeight) / 2;
      
      // Draw a colored background flash for the first 40% of animation
      if (progress < 0.4) {
        const flashAlpha = (1 - progress / 0.4) * 0.3;
        // Use theme-appropriate flash color
        if (isDark) {
          ctx.fillStyle = `rgba(100, 200, 255, ${flashAlpha})`; // Cyan for dark theme
        } else {
          ctx.fillStyle = `rgba(59, 130, 246, ${flashAlpha * 0.7})`; // Softer blue for light theme
        }
        ctx.fillRect(
          segment.x - xOffset - 3,
          segment.y - yOffset - 3,
          scaledWidth + 6,
          scaledHeight + 6
        );
      }
      
      // Draw the segment with full opacity
      ctx.fillStyle = segment.fillStyle;
      ctx.fillRect(
        segment.x - xOffset,
        segment.y - yOffset,
        scaledWidth,
        scaledHeight
      );
      
      // Draw borders with smooth fade-out
      if (!isActivePanning) {
        // First draw the normal border (always visible)
        ctx.strokeStyle = segment.strokeStyle;
        ctx.lineWidth = 1;
        ctx.strokeRect(
          segment.x - xOffset,
          segment.y - yOffset,
          scaledWidth,
          scaledHeight
        );
        
        // Then draw an animated highlight border that smoothly fades
        if (progress < 0.8) {
          // Smooth fade from 1.0 to 0 over the animation
          const borderAlpha = Math.pow(1 - progress / 0.8, 2); // Quadratic fade for smoothness
          const borderIntensity = borderAlpha;
          
          // Use theme-appropriate border highlight color
          if (isDark) {
            ctx.strokeStyle = `rgba(150, 220, 255, ${borderAlpha * 0.6})`; // Light blue for dark theme
          } else {
            ctx.strokeStyle = `rgba(59, 130, 246, ${borderAlpha * 0.8})`; // Stronger blue for light theme
          }
          ctx.lineWidth = 2 + borderIntensity;
          ctx.strokeRect(
            segment.x - xOffset,
            segment.y - yOffset,
            scaledWidth,
            scaledHeight
          );
        }
      }
      
      ctx.restore();
    }
  }
};

/**
 * Draw the playhead (current time indicator) on the timeline
 */
const drawPlayhead = (
  ctx,
  currentTime,
  visibleStart,
  visibleEnd,
  visibleDuration,
  displayWidth,
  displayHeight,
  primaryColor
) => {
  if (currentTime >= visibleStart && currentTime <= visibleEnd) {
    const currentX = timeToX(currentTime, visibleStart, visibleDuration, displayWidth);

    // Use path for better performance
    ctx.beginPath();
    ctx.fillStyle = primaryColor;

    // Draw playhead triangle
    ctx.moveTo(currentX - 6, 0);
    ctx.lineTo(currentX + 6, 0);
    ctx.lineTo(currentX, 6);
    ctx.closePath();
    ctx.fill();

    // Draw indicator line
    ctx.fillRect(currentX - 1, 0, 3, displayHeight);
  }
};
