import { useEffect, useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

// Import utility modules
import { getVisibleTimeRange, calculateVisibleTimeRange } from './utils/TimelineCalculations';
import { drawTimeline } from './utils/TimelineDrawing';
import { centerTimelineOnTime as centerTimeOnTime } from './utils/TimelineInteractions';

// Import volume visualizer
import VolumeVisualizer from './VolumeVisualizer';

import { ClearOfflineSegmentsButton } from './timelineOverlays';

// Extracted timeline pieces
import { useTimelineOfflineSegments } from './useTimelineOfflineSegments';
import { useTimelineStreamingState } from './useTimelineStreamingState';
import { useNarrationTimelineData } from './useNarrationTimelineData';
import { useNarrationLaneState } from './useNarrationLaneState';
import NarrationLaneControls from './NarrationLaneControls';
import { useTimelineRenderEffects } from './useTimelineRenderEffects';
import { useTimelineKeyboardShortcuts } from './useTimelineKeyboardShortcuts';
import { useTimelinePointerInteraction } from './useTimelinePointerInteraction';
import TimelineRetryOverlay from './TimelineRetryOverlay';
import TimelineRangeActionBar from './TimelineRangeActionBar';
import TimelineZoomControls from './TimelineZoomControls';
import TimelineDragHint from './TimelineDragHint';


const TimelineVisualization = ({
    lyrics,
    currentTime,
    duration,
    onTimelineClick,
    zoom,
    setZoom,
    panOffset,
    setPanOffset,
    centerOnTime, // Prop to center the view on a specific time
    timeFormat = 'seconds', // Prop to control time display format
    videoSource, // Video source URL for audio analysis
    showWaveformLongVideos = false, // Whether to show waveform for videos longer than 30 minutes
    onSegmentSelect, // Callback for when a segment is selected via drag
    selectedSegment = null, // Currently selected segment { start, end }
    isProcessingSegment = false, // New prop to indicate if processing is active
    onClearRange = null, // Clear subtitles inside selected range
    onMoveRange = null, // Move subtitles inside selected range by delta (legacy, optional)
    onBeginMoveRange = null, // Start live move preview
    onPreviewMoveRange = null, // Update live move preview with delta seconds
    onCommitMoveRange = null, // Commit the live move on mouse up
    onCancelMoveRange: _onCancelMoveRange = null, // Cancel live move preview
    onSelectedRangeChange = null, // Callback to notify parent of selected range changes
    onApplyTimings = null // Bulk-apply retimed subtitles (narration-lane smart arrange / drag)
}) => {
    const { t } = useTranslation();

    // Narration-lane segments. `narrationSegments` (memoized) drives the controls + smart-arrange
    // handlers; `getSegmentsFor` rebuilds them from the exact lyrics being drawn so the lane can
    // never desync from the subtitle band after a retime.
    const { segments: narrationSegments, getSegmentsFor } = useNarrationTimelineData(lyrics);
    const [laneCursor, setLaneCursor] = useState(null);

    const durationRef = useRef(0);

    // Segment selection state
    const [isDraggingSegment, setIsDraggingSegment] = useState(false);
    const [dragStartTime, setDragStartTime] = useState(null);
    const [dragCurrentTime, setDragCurrentTime] = useState(null);
    const dragStartRef = useRef(null);
    const dragCurrentRef = useRef(null);
    const isDraggingRef = useRef(false);

    // Track if dragging has been done in this session
    const [hasDraggedInSession, setHasDraggedInSession] = useState(false);

    // Streaming/animation state + its event-bus and new-segment-tracking effects
    const {
        animationTime,
        setAnimationTime,
        processingAnimationRef,
        newSegments,
        setNewSegments,
        isStreamingActive,
        newSegmentAnimationRef,
        segmentProcessingStartTimes,
        processingRanges
    } = useTimelineStreamingState({ lyrics });

    // Get current video duration from the video element
    useEffect(() => {
        const videoElement = document.querySelector('video');
        if (videoElement) {
            const updateDuration = () => {
                if (videoElement.duration && !isNaN(videoElement.duration)) {
                    durationRef.current = videoElement.duration;

                    // No longer enforce minimum zoom level
                    // Allow users to zoom out to 100% for any video duration
                }
            };

            // Update duration when metadata is loaded
            videoElement.addEventListener('loadedmetadata', updateDuration);

            // Check if duration is already available
            if (videoElement.duration && !isNaN(videoElement.duration)) {
                updateDuration();
            }

            return () => {
                videoElement.removeEventListener('loadedmetadata', updateDuration);
            };
        }
    }, [zoom, setZoom]);

    // Update durationRef when video metadata is loaded
    useEffect(() => {
        const videoElement = document.querySelector('video');
        if (videoElement && videoElement.duration && !isNaN(videoElement.duration)) {
            durationRef.current = videoElement.duration;
        }
    }, []);



    const timelineRef = useRef(null);
    const lastTimeRef = useRef(0);
    const animationFrameRef = useRef(null);
    // Initialize currentZoomRef with the correct zoom level
    const currentZoomRef = useRef(zoom);

    // Update currentZoomRef immediately when zoom prop changes
    useEffect(() => {
        // Use zoom directly without minimum restriction
        currentZoomRef.current = zoom;
    }, [zoom, duration]);
    const autoScrollRef = useRef(null);
    const isScrollingRef = useRef(false);
    const canvasWidthRef = useRef(0);

    // Track the last time the user manually interacted with the timeline
    const lastManualPanTime = useRef(0);

    // Flag to completely disable auto-scrolling
    const disableAutoScroll = useRef(false);

    // Debug counter to track state updates
    const debugCounter = useRef(0);
    // Refs to manage smooth zoom-drag with strict playhead-centering
    const zoomDragRafRef = useRef(null);
    const zoomDragActiveRef = useRef(false);
    const zoomDragLastXRef = useRef(0);

    // Track the last computed pan during zoom drag so we can commit it on release
    const lastComputedPanRef = useRef(panOffset);


    // Calculate visible time range - simplified without zoom centering logic
    const getTimeRange = useCallback(() => {
        const { start, end, total: timelineEnd, effectiveZoom } = getVisibleTimeRange(lyrics, duration, panOffset, zoom, currentZoomRef.current);

        // Update currentZoomRef to match effective zoom
        currentZoomRef.current = effectiveZoom;

        return { start, end, total: timelineEnd };
    }, [lyrics, duration, panOffset, zoom]);

    // Function to center the timeline view on a specific time
    const centerTimelineOnTime = useCallback((time) => {
        centerTimeOnTime(
            time,
            lyrics,
            duration,
            currentZoomRef.current,
            setPanOffset,
            lastManualPanTime
        );
    }, [lyrics, duration, setPanOffset]);

    // Watch for centerOnTime prop changes
    useEffect(() => {
        if (centerOnTime !== undefined && centerOnTime !== null) {

            centerTimelineOnTime(centerOnTime);
        }
    }, [centerOnTime, centerTimelineOnTime]);

    // Helper function to calculate visible time range with a temporary pan offset
    // This avoids creating a dependency on the state panOffset during active panning
    const getVisibleRangeWithTempOffset = useCallback((tempPanOffset) => {
        return calculateVisibleTimeRange(lyrics, duration, tempPanOffset, currentZoomRef.current);
    }, [lyrics, duration]);

    // Store the last selected range to show action bar when it includes existing subtitles
    const [actionBarRange, setActionBarRange] = useState(null); // { start, end }
    const [moveDragOffsetPx, setMoveDragOffsetPx] = useState(0);
    const rangePreviewDeltaRef = useRef(0); // seconds delta during move drag
    const [hiddenActionBarRange, setHiddenActionBarRange] = useState(null); // Store range when action bar is hidden

    const isRangeMoveDraggingRef = useRef(false);
    const moveDragOffsetPxRef = useRef(0);

    // Offline segments lingering after processing (loading/clear/retry managed by hook)
    const {
        offlineSegments,
        retryingOfflineKeys,
        hoveredOfflineRange,
        setHoveredOfflineRange,
        clearInfoVisible,
        handlers: { handleClearOfflineSegments, handleRetryOfflineRange }
    } = useTimelineOfflineSegments({ onSegmentSelect, t });

    // Subtle warning when user tries to drag while offline segments exist (no toast)
    const [warnOfflineDragVisible, setWarnOfflineDragVisible] = useState(false);


    // Handle processing animation (streaming or retry) — placed after retryingOfflineKeys to avoid TDZ
    useEffect(() => {
        const anyProcessing = isProcessingSegment || (retryingOfflineKeys && retryingOfflineKeys.length > 0) || isStreamingActive;
        if (anyProcessing) {
            const startTime = performance.now();
            const animate = () => {
                const elapsed = performance.now() - startTime;
                setAnimationTime(elapsed);
                processingAnimationRef.current = requestAnimationFrame(animate);
            };
            processingAnimationRef.current = requestAnimationFrame(animate);
            return () => {
                if (processingAnimationRef.current) {
                    cancelAnimationFrame(processingAnimationRef.current);
                }
            };
        } else {
            // Reset animation when processing stops
            setAnimationTime(0);
            if (processingAnimationRef.current) {
                cancelAnimationFrame(processingAnimationRef.current);
            }
        }
    }, [isProcessingSegment, retryingOfflineKeys, isStreamingActive, processingAnimationRef, setAnimationTime]);


    const isClickingInsideRef = useRef(false); // Track if we're clicking inside the range

    // Notify parent component when selected range changes
    useEffect(() => {
        if (onSelectedRangeChange) {
            // Report the active range (either actionBarRange or hiddenActionBarRange)
            const activeRange = actionBarRange || hiddenActionBarRange || selectedSegment;
            onSelectedRangeChange(activeRange);
        }
    }, [actionBarRange, hiddenActionBarRange, selectedSegment, onSelectedRangeChange]);

    // Narration-lane staging state (global speed, per-clip placement, per-line weight) + lane drag.
    const {
        globalSpeed, setGlobalSpeed,
        placementStarts, setPlacementStarts,
        perLineWeight, setPerLineWeight,
        drag: narrationDrag,
    } = useNarrationLaneState({
        timelineRef,
        getTimeRange,
        duration,
        lyrics,
        getSegmentsFor,
        reserveBottom: videoSource ? 30 : 0,
        setLaneCursor,
    });

    // Draw the timeline visualization with optimizations
    const renderTimeline = useCallback((tempPanOffset = null) => {
        const canvas = timelineRef.current;
        if (!canvas) return;

        // Use a default duration if none is provided (for debugging)
        const effectiveDuration = duration || 60; // Default to 60 seconds for testing

        canvasWidthRef.current = canvas.clientWidth;

        // Use the provided temporary pan offset during active panning, or the state value
        const effectivePanOffset = tempPanOffset !== null ? tempPanOffset : panOffset;

        // Get visible time range with the effective pan offset
        const visibleTimeRange = tempPanOffset !== null
            ? getVisibleRangeWithTempOffset(effectivePanOffset)
            : getTimeRange();

        // Prepare segment data for drawing
        // Show selection for both actionBarRange and hiddenActionBarRange
        const activeRange = actionBarRange || hiddenActionBarRange;
        const effectiveSelected = activeRange
            ? { start: activeRange.start + (rangePreviewDeltaRef.current || 0), end: activeRange.end + (rangePreviewDeltaRef.current || 0) }
            : selectedSegment;
        // Reuse streaming parallel highlighting style by feeding offline segments
        // Build retry key set
        const retryKeySet = new Set(retryingOfflineKeys || []);
        const { start: visStart, end: visEnd } = visibleTimeRange;

        // Only consider offline ranges that are visible to reduce draw cost
        const offlineVisible = (offlineSegments || []).filter(r => (r.end > visStart && r.start < visEnd));

        // Determine if any animation should run (global clock)
        const isAnimating = !!isProcessingSegment || retryKeySet.size > 0;

        // Include only the retried offline ranges during animation; otherwise include all visible offline ranges as static
        const offlineRangesForDraw = offlineVisible.map((r, idx) => {
            const key = `${r.start}-${r.end}`;
            const animate = retryKeySet.has(key);
            if (isAnimating && !animate) return null; // skip static ranges during animation frames to avoid lag
            return { start: r.start, end: r.end, index: (processingRanges?.length || 0) + idx, animate };
        }).filter(Boolean);

        // If a retry is active, show only the retried offline cut(s) as processing; otherwise use normal processingRanges
        const combinedProcessingRanges = (retryKeySet.size > 0)
            ? offlineRangesForDraw
            : (Array.isArray(processingRanges) ? [...processingRanges, ...offlineRangesForDraw] : offlineRangesForDraw);

        // Selected band animates only if: (a) a normal processing run is on, or (b) it exactly matches the retried range
        const selectedIsProcessing = (retryKeySet.size > 0)
            ? (effectiveSelected && retryKeySet.has(`${effectiveSelected.start}-${effectiveSelected.end}`))
            : !!isProcessingSegment;

        const segmentData = {
            selectedSegment: effectiveSelected,
            isDraggingSegment,
            dragStartTime,
            dragCurrentTime,
            isProcessing: isAnimating, // used by processingRanges; selected animation gated separately
            selectedIsProcessing,
            animationTime,
            newSegments: newSegments, // Pass new segments for animation
            processingRanges: combinedProcessingRanges
        };

        // Subtitle band = real lyrics; narration lane = staged placement + global speed.
        const narrationForDraw = getSegmentsFor(lyrics, placementStarts, globalSpeed, perLineWeight);

        // Draw the timeline
        drawTimeline(
            canvas,
            effectiveDuration,
            lyrics,
            currentTime,
            {
                ...visibleTimeRange,
                // Keep a slight top padding (time markers), do not cover segments
                topPadding: 25

            },
            effectivePanOffset,
            tempPanOffset !== null, // isActivePanning
            timeFormat,
            segmentData,
            segmentProcessingStartTimes,
            narrationForDraw,
            videoSource ? 30 : 0 // reserve the waveform overlay's bottom strip
        );


    }, [lyrics, placementStarts, globalSpeed, perLineWeight, currentTime, duration, getTimeRange, panOffset, getVisibleRangeWithTempOffset, timeFormat, selectedSegment, isDraggingSegment, dragStartTime, dragCurrentTime, isProcessingSegment, animationTime, newSegments, actionBarRange, hiddenActionBarRange, offlineSegments, retryingOfflineKeys, segmentProcessingStartTimes, getSegmentsFor, videoSource, processingRanges]);

    // Render-coordination side effects (new-segment animation, resize, zoom,
    // timeline updates, playhead auto-scroll, unmount cleanup)
    useTimelineRenderEffects({
        renderTimeline,
        timelineRef,
        animationFrameRef,
        newSegments,
        setNewSegments,
        newSegmentAnimationRef,
        zoom,
        currentZoomRef,
        duration,
        panOffset,
        setPanOffset,
        currentTime,
        lyrics,
        selectedSegment,
        onSegmentSelect,
        videoSource,
        isDraggingSegment,
        dragStartTime,
        dragCurrentTime,
        lastTimeRef,
        lastManualPanTime,
        disableAutoScroll,
        getTimeRange,
        isScrollingRef,
        debugCounter,
        autoScrollRef
    });

    // Repaint when the narration lane changes — its segments arrive asynchronously (after the
    // duration refetch that follows a retime), so they land after the lyrics-driven redraw.
    useEffect(() => {
        renderTimeline();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [narrationSegments]);

    // Keyboard shortcuts (Alt+S auto-scroll toggle, Ctrl+A select-all range)
    useTimelineKeyboardShortcuts({
        timelineRef,
        renderTimeline,
        onSegmentSelect,
        duration,
        lyrics,
        offlineSegments,
        disableAutoScroll,
        setHasDraggedInSession,
        setIsDraggingSegment,
        setDragStartTime,
        setDragCurrentTime,
        dragStartRef,
        dragCurrentRef,
        isDraggingRef,
        setActionBarRange,
        setHiddenActionBarRange
    });

    // Pointer/seek/select interaction (pixel<->time, hover, mouse/touch handlers)
    const { handleMouseDown, handleTouchStart, handleContextMenu } = useTimelinePointerInteraction({
        timelineRef,
        duration,
        lyrics,
        getTimeRange,
        onTimelineClick,
        onSegmentSelect,
        onClearRange,
        selectedSegment,
        offlineSegments,
        actionBarRange,
        hiddenActionBarRange,
        hoveredOfflineRange,
        setActionBarRange,
        setHiddenActionBarRange,
        setHoveredOfflineRange,
        setWarnOfflineDragVisible,
        setMoveDragOffsetPx,
        setIsDraggingSegment,
        setDragStartTime,
        setDragCurrentTime,
        setHasDraggedInSession,
        dragStartRef,
        dragCurrentRef,
        isDraggingRef,
        isRangeMoveDraggingRef,
        isClickingInsideRef,
        lastManualPanTime
    });

    return (
        <div className="timeline-container" style={{ position: 'relative' }}>
            <NarrationLaneControls
                narrationSegments={narrationSegments}
                lyrics={lyrics}
                onApplyTimings={onApplyTimings}
                globalSpeed={globalSpeed}
                setGlobalSpeed={setGlobalSpeed}
                placementStarts={placementStarts}
                setPlacementStarts={setPlacementStarts}
                perLineWeight={perLineWeight}
                setPerLineWeight={setPerLineWeight}
            />
            <ClearOfflineSegmentsButton
                offlineSegments={offlineSegments}
                retryingOfflineKeys={retryingOfflineKeys}
                clearInfoVisible={clearInfoVisible}
                handleClearOfflineSegments={handleClearOfflineSegments}
                t={t}
                timelineRef={timelineRef}
            />

            {/* Subtle warning when user tries to drag while offline segments exist */}
            {warnOfflineDragVisible && (
                <div style={{ position: 'absolute', top: 6, left: 8, zIndex: 5 }}>
                    <span role="status" aria-live="polite" style={{ whiteSpace: 'nowrap', fontSize: 12, padding: '2px 8px', borderRadius: 10, color: 'var(--md-on-surface-variant)', backgroundColor: 'var(--md-surface-variant)', border: '1px solid var(--md-outline-variant)' }}>
                        {t('timeline.clearOfflineFirst', 'Please clear offline segments to exit this mode first')}
                    </span>
                </div>
            )}

            {/* Hover refresh icon (portal) at colorful bits' vertical center */}
            {/* Retry button is rendered via a dedicated body-level layer, independent of canvas animation */}
            <TimelineRetryOverlay
                timelineRef={timelineRef}
                hoveredOfflineRange={hoveredOfflineRange}
                retryingOfflineKeys={retryingOfflineKeys}
                handleRetryOfflineRange={handleRetryOfflineRange}
                getTimeRange={getTimeRange}
                panOffset={panOffset}
                zoom={zoom}
                lyrics={lyrics}
            />

            {/* Range action header placed vertically above the timeline canvas */}
            <TimelineRangeActionBar
                actionBarRange={actionBarRange}
                retryingOfflineKeys={retryingOfflineKeys}
                timelineRef={timelineRef}
                getTimeRange={getTimeRange}
                moveDragOffsetPx={moveDragOffsetPx}
                setMoveDragOffsetPx={setMoveDragOffsetPx}
                moveDragOffsetPxRef={moveDragOffsetPxRef}
                rangePreviewDeltaRef={rangePreviewDeltaRef}
                isRangeMoveDraggingRef={isRangeMoveDraggingRef}
                isClickingInsideRef={isClickingInsideRef}
                setActionBarRange={setActionBarRange}
                setHiddenActionBarRange={setHiddenActionBarRange}
                selectedSegment={selectedSegment}
                onBeginMoveRange={onBeginMoveRange}
                onPreviewMoveRange={onPreviewMoveRange}
                onCommitMoveRange={onCommitMoveRange}
                onMoveRange={onMoveRange}
                onSegmentSelect={onSegmentSelect}
                onClearRange={onClearRange}
                panOffset={panOffset}
                zoom={zoom}
                lyrics={lyrics}
                t={t}
            />

            <canvas
                ref={timelineRef}
                // Narration-lane drag gets first dibs on mouse-down (over a lane block); otherwise
                // the existing seek/range-select handler runs.
                onMouseDown={(e) => { if (!narrationDrag.onMouseDown(e)) handleMouseDown(e); }}
                onMouseMove={narrationDrag.onHoverMove}
                onTouchStart={handleTouchStart}
                onContextMenu={handleContextMenu}
                className="subtitle-timeline"
                style={{
                    cursor: laneCursor
                        ? laneCursor
                        : isDraggingSegment
                            ? 'ew-resize'
                            : (onSegmentSelect && offlineSegments.length === 0)
                                ? 'crosshair'
                                : 'pointer',
                    touchAction: (onSegmentSelect && offlineSegments.length === 0) ? 'none' : 'auto' // Disable touch gestures only when selection is enabled
                }}
            />

            {/* Drag hint animation */}
            <TimelineDragHint
                onSegmentSelect={onSegmentSelect}
                hasDraggedInSession={hasDraggedInSession}
                t={t}
            />

            {/* Liquid Glass zoom controls in top right corner */}
            <TimelineZoomControls
                setZoom={setZoom}
                zoom={zoom}
                duration={duration}
                lyrics={lyrics}
                currentTime={currentTime}
                panOffset={panOffset}
                setPanOffset={setPanOffset}
                disableAutoScroll={disableAutoScroll}
                lastManualPanTime={lastManualPanTime}
                zoomDragActiveRef={zoomDragActiveRef}
                zoomDragLastXRef={zoomDragLastXRef}
                zoomDragRafRef={zoomDragRafRef}
                currentZoomRef={currentZoomRef}
                lastComputedPanRef={lastComputedPanRef}
                t={t}
            />

            {(() => {
                const hasKnownDuration = typeof duration === 'number' && duration > 0;
                const effDuration = hasKnownDuration ? duration : (durationRef.current || 0);
                // Mount visualizer when:
                // - duration is known and <= 30min; or
                // - duration is known and > 30min but user enabled; or
                // - duration unknown, but user enabled (so they opted in intentionally)
                const shouldMount = videoSource && (
                    (hasKnownDuration && (effDuration <= 1800 || showWaveformLongVideos)) ||
                    (!hasKnownDuration && showWaveformLongVideos)
                );
                return shouldMount;
            })() && (
                    <VolumeVisualizer
                        audioSource={videoSource}
                        duration={(typeof duration === 'number' && duration > 0 ? duration : (durationRef.current || 0))}
                        visibleTimeRange={getTimeRange()}
                        height={30}
                    />
                )}
            {!videoSource && (
                <div className="srt-only-timeline-message">
                    <span>{t('timeline.srtOnlyMode', 'SRT Only Mode - Timeline visualization based on subtitle timing')}</span>
                </div>
            )}

        </div>
    );
};

export default TimelineVisualization;
