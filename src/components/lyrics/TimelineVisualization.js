import { useEffect, useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

// Import utility modules
import { getVisibleTimeRange, calculateVisibleTimeRange } from './utils/TimelineCalculations';
import { drawTimeline } from './utils/TimelineDrawing';
import { centerTimelineOnTime as centerTimeOnTime } from './utils/TimelineInteractions';

// Import volume visualizer
import VolumeVisualizer from './VolumeVisualizer';

// Extracted timeline pieces
import { useTimelineStreamingState } from './useTimelineStreamingState';
import { useNarrationTimelineData } from './useNarrationTimelineData';
import { useNarrationLaneState } from './useNarrationLaneState';
import NarrationLaneControls from './NarrationLaneControls';
import { useTimelineRenderEffects } from './useTimelineRenderEffects';
import { useTimelineKeyboardShortcuts } from './useTimelineKeyboardShortcuts';
import { useTimelinePointerInteraction } from './useTimelinePointerInteraction';
import { clampTimelineRange, createTimelineDomain } from './utils/timelineDomain';
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
    const timelineDomain = useMemo(
        () => createTimelineDomain(lyrics, duration),
        [duration, lyrics],
    );
    const boundedSelectedSegment = useMemo(
        () => clampTimelineRange(selectedSegment, timelineDomain),
        [selectedSegment, timelineDomain],
    );

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
        newSegments,
        setNewSegments,
        isStreamingActive,
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
    const animationTimeRef = useRef(0);
    // Initialize currentZoomRef with the correct zoom level
    const currentZoomRef = useRef(zoom);

    // Update currentZoomRef immediately when zoom prop changes
    useEffect(() => {
        // Use zoom directly without minimum restriction
        currentZoomRef.current = zoom;
    }, [zoom, duration]);
    const isScrollingRef = useRef(false);
    const canvasWidthRef = useRef(0);

    // Track the last time the user manually interacted with the timeline
    const lastManualPanTime = useRef(0);

    // Flag to completely disable auto-scrolling
    const disableAutoScroll = useRef(false);

    // Refs to manage smooth zoom-drag with strict playhead-centering
    const zoomDragRafRef = useRef(null);
    const zoomDragActiveRef = useRef(false);
    const zoomDragLastXRef = useRef(0);

    // Track the last computed pan during zoom drag so we can commit it on release
    const lastComputedPanRef = useRef(panOffset);


    // Calculate visible time range - simplified without zoom centering logic
    const visibleTimeRange = useMemo(() => {
        const { start, end, total: timelineEnd, effectiveZoom } = getVisibleTimeRange(lyrics, duration, panOffset, zoom, currentZoomRef.current);

        // Update currentZoomRef to match effective zoom
        currentZoomRef.current = effectiveZoom;

        return { start, end, total: timelineEnd };
    }, [lyrics, duration, panOffset, zoom]);
    const getTimeRange = useCallback(() => visibleTimeRange, [visibleTimeRange]);

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


    const isClickingInsideRef = useRef(false); // Track if we're clicking inside the range

    // Notify parent component when selected range changes
    useEffect(() => {
        if (onSelectedRangeChange) {
            // Report the active range (either actionBarRange or hiddenActionBarRange)
            const activeRange = actionBarRange || hiddenActionBarRange || boundedSelectedSegment;
            onSelectedRangeChange(activeRange);
        }
    }, [actionBarRange, hiddenActionBarRange, boundedSelectedSegment, onSelectedRangeChange]);

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

    const narrationForDraw = useMemo(() => {
        // Async duration changes invalidate placements even when lyrics and getter are unchanged.
        void narrationSegments;
        return getSegmentsFor(lyrics, placementStarts, globalSpeed, perLineWeight);
    }, [narrationSegments, getSegmentsFor, lyrics, placementStarts, globalSpeed, perLineWeight]);

    // Draw the timeline visualization with optimizations
    const renderTimeline = useCallback((tempPanOffset = null) => {
        const canvas = timelineRef.current;
        if (!canvas) return;

        const effectiveDuration = timelineDomain.seekableEnd;

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
            : boundedSelectedSegment;
        const segmentData = {
            selectedSegment: effectiveSelected,
            isDraggingSegment,
            dragStartTime,
            dragCurrentTime,
            isProcessing: !!isProcessingSegment,
            selectedIsProcessing: !!isProcessingSegment,
            animationTime: animationTimeRef.current,
            newSegments: newSegments, // Pass new segments for animation
            processingRanges: Array.isArray(processingRanges) ? processingRanges : []
        };

        // Subtitle band = real lyrics; narration lane = staged placement + global speed.

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


    }, [lyrics, narrationForDraw, currentTime, timelineDomain, getTimeRange, panOffset, getVisibleRangeWithTempOffset, timeFormat, boundedSelectedSegment, isDraggingSegment, dragStartTime, dragCurrentTime, isProcessingSegment, newSegments, actionBarRange, hiddenActionBarRange, segmentProcessingStartTimes, videoSource, processingRanges]);

    // Render-coordination side effects (new-segment animation, resize, zoom,
    // timeline updates, playhead auto-scroll, unmount cleanup)
    useTimelineRenderEffects({
        renderTimeline,
        timelineRef,
        animationTimeRef,
        isProcessing: isProcessingSegment || isStreamingActive,
        newSegments,
        setNewSegments,
        zoom,
        currentZoomRef,
        duration,
        panOffset,
        setPanOffset,
        currentTime,
        videoSource,
        lastManualPanTime,
        disableAutoScroll,
        getTimeRange,
        isScrollingRef,
    });

    // Keyboard shortcuts (Alt+S auto-scroll toggle, Ctrl+A select-all range)
    useTimelineKeyboardShortcuts({
        timelineRef,
        renderTimeline,
        onSegmentSelect,
        duration,
        lyrics,
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
        selectedSegment: boundedSelectedSegment,
        actionBarRange,
        hiddenActionBarRange,
        setActionBarRange,
        setHiddenActionBarRange,
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
            {/* Range action header placed vertically above the timeline canvas */}
            <TimelineRangeActionBar
                actionBarRange={actionBarRange}
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
                selectedSegment={boundedSelectedSegment}
                timelineDomain={timelineDomain}
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
                            : onSegmentSelect
                                ? 'crosshair'
                                : 'pointer',
                    touchAction: onSegmentSelect ? 'none' : 'auto'
                }}
            />

            {/* Drag hint animation */}
            <TimelineDragHint
                onSegmentSelect={onSegmentSelect}
                hasDraggedInSession={hasDraggedInSession}
                hasLyrics={Array.isArray(lyrics) && lyrics.length > 0}
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
                        visibleTimeRange={visibleTimeRange}
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
