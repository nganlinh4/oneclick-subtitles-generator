/**
 * Utility functions for drawing the timeline visualization
 */

import { timeToX } from './TimelineCalculations';
// Legacy segment optimization is no longer needed with simplified processing
// import { optimizeSegments, clearUnusedSegments } from '../../../utils/colorfulSegmentsOptimizer';
import { drawTimeMarkers, drawLyricSegments, drawNarrationSegments, drawPlayhead } from './timelineDrawingHelpers';
import { computeTimelineBands } from './timelineBands';

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
 * @param {Map} segmentProcessingStartTimes - Map of segment processing start times (for delayed segment processing)
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
    segmentData = null,
    segmentProcessingStartTimes = null,
    narrationSegments = null, // optional narration-lane segments
    reserveBottom = 0 // px reserved at the bottom (e.g. for the waveform overlay)
) => {
    if (!canvas) return;

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

    // Split the content area into a subtitle band (+ a narration band beneath it when present).
    // Shared with the narration-lane hit-testing via computeTimelineBands.
    const hasNarration = Array.isArray(narrationSegments) && narrationSegments.length > 0;
    const { subtitleBand, narrationBand } = computeTimelineBands(displayHeight, reserveBottom, hasNarration);

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
        segmentData ? segmentData.newSegments : null,
        segmentProcessingStartTimes,
        subtitleBand
    );

    // Draw the narration lane beneath the subtitles
    if (narrationBand) {
        drawNarrationSegments(
            ctx,
            narrationSegments,
            visibleStart,
            visibleEnd,
            visibleDuration,
            displayWidth,
            narrationBand,
            isDark
        );
    }

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
