/**
 * Canvas-drawing helpers for the timeline (markers, lyric segments, playhead).
 * Split out of TimelineDrawing.js; called by drawTimeline.
 */

import { getLyricColor, getRandomHeight } from './ColorUtils';
import { timeToX } from './TimelineCalculations';
import { formatTime } from '../../../utils/timeFormatter';

/**
 * Draw time markers and labels on the timeline
 */
export const drawTimeMarkers = (
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
export const drawLyricSegments = (
    ctx,
    lyrics,
    visibleStart,
    visibleEnd,
    visibleDuration,
    displayWidth,
    displayHeight,
    isDark,
    isActivePanning,
    newSegments = null,
    segmentProcessingStartTimes = null,
    band = null // optional { top, height } — when set, draw within this vertical band
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

    // Batch render all segments with same fill color
    if (visibleLyrics.length > 0) {
        // Group segments by color for batch rendering
        const colorGroups = new Map();

        // Vertical band the subtitle blocks occupy. Defaults to the area below the 25px time
        // ruler; when a narration lane is shown, drawTimeline passes a smaller top band.
        const bandTop = band ? band.top : 25;
        const bandHeight = band ? band.height : displayHeight - 25;
        const timeMarkerSpace = bandTop;
        const availableHeight = bandHeight;

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
                    let effectiveStartTime = segmentData.startTime;

                    // If we have delayed processing times, use the actual processing start time
                    if (segmentProcessingStartTimes && segmentProcessingStartTimes.has(segmentKey)) {
                        const processingInfo = segmentProcessingStartTimes.get(segmentKey);
                        effectiveStartTime = processingInfo.actualStartTime;
                    }

                    const elapsed = performance.now() - effectiveStartTime;
                    // Only show animation after the segment's actual processing start time
                    animationProgress = Math.max(0, Math.min(elapsed / 800, 1)); // 800ms animation
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
 * Draw the narration lane: each generated clip as a block from its subtitle start to
 * start + audio length, within `band`. The part inside the subtitle window is green; any
 * overrun tail past the subtitle's end is red, so timing mismatches are visible at a glance.
 */
export const drawNarrationSegments = (
    ctx,
    narrationSegments,
    visibleStart,
    visibleEnd,
    visibleDuration,
    displayWidth,
    band,
    isDark
) => {
    if (!Array.isArray(narrationSegments) || narrationSegments.length === 0 || !band) return;

    const top = band.top;
    const height = Math.max(4, band.height);
    const pad = Math.min(3, height * 0.15);
    const blockTop = top + pad;
    const blockH = height - pad * 2;

    const fitFill = isDark ? 'rgba(56, 178, 120, 0.65)' : 'rgba(34, 153, 102, 0.7)';
    const fitStroke = isDark ? 'rgba(74, 222, 150, 0.9)' : 'rgba(25, 128, 85, 0.9)';
    // Whole-block warning colour for clips that overlap a neighbour past the conflict threshold
    // (SGT's #facc15 amber).
    const conflictFill = isDark ? 'rgba(250, 204, 21, 0.55)' : 'rgba(214, 158, 10, 0.6)';
    const conflictStroke = isDark ? 'rgba(250, 204, 21, 0.95)' : 'rgba(180, 130, 8, 0.95)';

    // Faint lane background so an empty lane still reads as a track.
    ctx.fillStyle = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)';
    ctx.fillRect(0, top, displayWidth, height);

    const drawRect = (x0, x1, fill, stroke) => {
        const x = Math.max(0, x0);
        const w = Math.min(displayWidth, x1) - x;
        if (w <= 0) return;
        ctx.fillStyle = fill;
        ctx.fillRect(x, blockTop, Math.max(1, w), blockH);
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 1;
        ctx.strokeRect(x, blockTop, Math.max(1, w), blockH);
    };

    for (const seg of narrationSegments) {
        if (seg.end < visibleStart || seg.start > visibleEnd) continue;
        const startX = timeToX(seg.start, visibleStart, visibleDuration, displayWidth);
        const endX = timeToX(seg.end, visibleStart, visibleDuration, displayWidth);
        // Whole block: amber when it conflicts with a neighbour, green otherwise.
        const fill = seg.conflict ? conflictFill : fitFill;
        const stroke = seg.conflict ? conflictStroke : fitStroke;
        drawRect(startX, endX, fill, stroke);
    }
};

/**
 * Draw the playhead (current time indicator) on the timeline
 */
export const drawPlayhead = (
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
