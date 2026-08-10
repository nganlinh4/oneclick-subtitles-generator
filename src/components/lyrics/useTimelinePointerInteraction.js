import { useCallback, useEffect } from 'react';

import { handleTimelineClick as handleClick } from './utils/TimelineInteractions';
import { isEventFromEditable } from './useTimelineKeyboardShortcuts';

// Pointer/seek/select interaction for the timeline canvas.
//
// Encapsulates pixel<->time conversion, range-hover detection, the
// mouse/touch down handlers that drive click-to-seek and drag-to-select,
// the context-menu opener, and the keyboard/effect wiring that keeps the
// action bar in sync with the current selection. State and refs owned by the
// host component are threaded in via params; the hook returns the canvas
// event handlers and a couple of shared helpers the host still needs.
export const useTimelinePointerInteraction = ({
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
}) => {
    // Convert pixel position to time
    const pixelToTime = (pixelX) => {
        const canvas = timelineRef.current;
        const effectiveDuration = duration || 60;
        if (!canvas) return 0;

        const rect = canvas.getBoundingClientRect();
        const relativeX = pixelX - rect.left;
        const timeRange = getTimeRange();
        const timePerPixel = (timeRange.end - timeRange.start) / canvas.clientWidth;

        return Math.max(0, Math.min(effectiveDuration, timeRange.start + (relativeX * timePerPixel)));
    };

    // Handle right-click on selected segment
    const handleContextMenu = (e) => {
        e.preventDefault();
        e.stopPropagation();

        // Check if we have a selected segment and the click is within its bounds
        if (selectedSegment && onSegmentSelect) {
            const clickTime = pixelToTime(e.clientX);

            // Check if the click is within the selected segment range
            if (clickTime >= selectedSegment.start && clickTime <= selectedSegment.end) {

                sessionStorage.setItem('processing_modal_open_reason', 'context-menu');
                // Trigger the segment selection callback to open the modal
                onSegmentSelect(selectedSegment);
            }
        }
    };

    // Enable Delete/Backspace keys to trigger clear-in-range when action bar is visible
    useEffect(() => {
        if (!actionBarRange) return;
        const onKeyDown = (e) => {
            if (isEventFromEditable(e)) return;
            if (e.key === 'Delete' || e.key === 'Backspace') {
                e.preventDefault();
                if (onClearRange) {
                    onClearRange(actionBarRange.start, actionBarRange.end);
                    setActionBarRange(null);
                    setHiddenActionBarRange(null);
                }
            }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [actionBarRange, onClearRange, setActionBarRange, setHiddenActionBarRange]);

    const hasSubtitlesInRange = useCallback((start, end) => {
        if (!lyrics || lyrics.length === 0) return false;
        // Only consider subtitles fully contained within the range
        return lyrics.some(l => l.start >= start && l.end <= end);
    }, [lyrics]);

    // Handle mouse move to detect hovering over the hidden range or selectedSegment
    const handleMouseMoveForRange = useCallback((e) => {
        // During a move-drag of the action bar, ignore canvas hover logic entirely
        if (isRangeMoveDraggingRef.current) return;
        // Check both hiddenActionBarRange and selectedSegment
        if (!hiddenActionBarRange && !actionBarRange && !selectedSegment && (!offlineSegments || offlineSegments.length === 0)) return;

        const canvas = timelineRef.current;
        const effectiveDuration = duration || 60;
        if (!canvas) return;

        const rect = canvas.getBoundingClientRect();
        const relativeX = e.clientX - rect.left;
        const timeRange = getTimeRange();
        const timePerPixel = (timeRange.end - timeRange.start) / canvas.clientWidth;
        const hoverTime = Math.max(0, Math.min(effectiveDuration, timeRange.start + (relativeX * timePerPixel)));

        // Track hovered offline cached range (for refresh UI)
        if (offlineSegments && offlineSegments.length > 0) {
            const hovered = offlineSegments.find(r => hoverTime >= r.start && hoverTime <= r.end);
            setHoveredOfflineRange(hovered || null);
        } else {
            if (hoveredOfflineRange) setHoveredOfflineRange(null);
        }

        // Check if hovering within the hidden action bar range
        const range = hiddenActionBarRange || actionBarRange;
        if (range && hoverTime >= range.start && hoverTime <= range.end) {
            // Show the action bar if it was hidden (only when no offline cuts exist)
            if (hiddenActionBarRange && !actionBarRange && offlineSegments.length === 0) {
                setActionBarRange(hiddenActionBarRange);
            }
        }

        // Check if hovering within the persistent selectedSegment (from subtitle generation)
        if (selectedSegment && !actionBarRange &&
            hoverTime >= selectedSegment.start && hoverTime <= selectedSegment.end) {
            // Check if there are subtitles in this segment
            if (hasSubtitlesInRange(selectedSegment.start, selectedSegment.end) && offlineSegments.length === 0) {
                // Show action bar for the selected segment
                setActionBarRange(selectedSegment);
                setHiddenActionBarRange(selectedSegment);
            }
        }
    }, [hiddenActionBarRange, actionBarRange, selectedSegment, duration, getTimeRange, hasSubtitlesInRange, offlineSegments, hoveredOfflineRange, setHoveredOfflineRange, isRangeMoveDraggingRef, timelineRef, setActionBarRange, setHiddenActionBarRange]);

    // Add mouse move listener for hover detection
    useEffect(() => {
        if (hiddenActionBarRange || actionBarRange || selectedSegment || (offlineSegments && offlineSegments.length > 0)) {
            const canvas = timelineRef.current;
            if (canvas) {
                canvas.addEventListener('mousemove', handleMouseMoveForRange);
                return () => {
                    canvas.removeEventListener('mousemove', handleMouseMoveForRange);
                };
            }
        }
    }, [handleMouseMoveForRange, hiddenActionBarRange, actionBarRange, selectedSegment, offlineSegments, timelineRef]);

    // When selectedSegment changes (e.g., after subtitle generation), ensure the UI selection reflects it.
    // If a user-created actionBarRange is present, clear it and set hiddenActionBarRange to the programmatic selection
    // so the blue selection highlight updates immediately.
    useEffect(() => {
        if (!selectedSegment) return;

        const segKey = (typeof selectedSegment.start === 'number' && typeof selectedSegment.end === 'number')
            ? `${selectedSegment.start}-${selectedSegment.end}` : null;
        const actionKey = actionBarRange ? `${actionBarRange.start}-${actionBarRange.end}` : null;
        const hiddenKey = hiddenActionBarRange ? `${hiddenActionBarRange.start}-${hiddenActionBarRange.end}` : null;

        // If an interactive action bar is currently visible for a different range, hide it
        if (actionKey && segKey !== actionKey) {
            setActionBarRange(null);
        }

        // If hiddenActionBarRange is missing or different, set it to the new selectedSegment so the blue band updates
        if (!hiddenKey || segKey !== hiddenKey) {
            // If the selected segment actually contains subtitles, keep it as hidden action bar so hover will show action bar.
            // Otherwise still set hiddenActionBarRange so the visual highlight appears immediately.
            setHiddenActionBarRange(selectedSegment);
        }
    }, [selectedSegment, actionBarRange, hiddenActionBarRange, setActionBarRange, setHiddenActionBarRange]);

    // Common logic for handling pointer down (mouse or touch)
    const handlePointerDown = (clientX, _clientY, isTouch = false) => {
        const startTime = pixelToTime(clientX);
        const startX = clientX;
        let hasMoved = false;
        let dragThreshold = isTouch ? 10 : 5; // pixels - higher threshold for touch to avoid accidental drags

        let warned = false;



        // Initialize drag state for segment selection (if enabled) - disabled when offline segments linger
        if (onSegmentSelect && offlineSegments.length === 0) {
            setDragStartTime(startTime);
            setDragCurrentTime(startTime);
            dragStartRef.current = startTime;
            dragCurrentRef.current = startTime;
            // Reset any previous action bar until selection decision
            setActionBarRange(null);
            setHiddenActionBarRange(null);
            setMoveDragOffsetPx(0);
        }



        const handlePointerMove = (moveClientX) => {
            const deltaX = Math.abs(moveClientX - startX);

            // If offline cuts exist, only warn when user starts dragging; allow single-click seeking
            if (offlineSegments.length > 0) {
                if (deltaX > dragThreshold && !warned) {
                    setWarnOfflineDragVisible(true);
                    try { setTimeout(() => setWarnOfflineDragVisible(false), 3500); } catch {
                        // Warning dismissal is best-effort during document teardown.
                    }
                    warned = true;
                }
                return;
            }

            // Check if we've moved enough to consider this a drag
            if (deltaX > dragThreshold) {
                hasMoved = true;

                // Only handle drag if segment selection is enabled
                if (onSegmentSelect) {
                    if (!isDraggingRef.current) {
                        setIsDraggingSegment(true);
                        isDraggingRef.current = true;
                    }

                    const currentTime = pixelToTime(moveClientX);

                    // Only update if the time has changed significantly (avoid excessive updates)
                    if (Math.abs(currentTime - (dragCurrentRef.current || 0)) > 0.1) {
                        setDragCurrentTime(currentTime);
                        dragCurrentRef.current = currentTime;
                    }
                }
            }
        };

        const handlePointerUp = (upClientX) => {
            if (hasMoved && onSegmentSelect && isDraggingRef.current) {
                // This was a drag - handle segment selection


                // Mark that dragging has been done in this session
                setHasDraggedInSession(true);

                if (dragStartRef.current !== null && dragCurrentRef.current !== null) {
                    const start = Math.min(dragStartRef.current, dragCurrentRef.current);
                    const end = Math.max(dragStartRef.current, dragCurrentRef.current);

                    // Only create segment if there's a meaningful duration (at least 1 second)
                    if (end - start >= 1) {

                        if (offlineSegments.length > 0) {
                            // When offline cuts exist, do not trigger the range action bar or open the modal
                        } else if (hasSubtitlesInRange(start, end)) {
                            // Show action bar instead of opening modal
                            setActionBarRange({ start, end });
                            setHiddenActionBarRange({ start, end });
                        } else {
                            sessionStorage.setItem('processing_modal_open_reason', 'drag-selection');
                            onSegmentSelect({ start, end });
                        }
                    }
                }
            } else if (!hasMoved) {
                // This was a tap/click - handle timeline seeking
                const clickTime = pixelToTime(upClientX);


                // Check if tap/click is inside any active range
                const activeRange = actionBarRange || hiddenActionBarRange || selectedSegment;
                const isInsideRange = activeRange &&
                    clickTime >= activeRange.start &&
                    clickTime <= activeRange.end;

                if (isInsideRange) {
                    // Tap/click inside range - set flag to prevent hiding
                    isClickingInsideRef.current = true;

                    // Ensure action bar is shown (only when no offline cuts exist)
                    if (!actionBarRange && activeRange) {
                        if (hasSubtitlesInRange(activeRange.start, activeRange.end) && offlineSegments.length === 0) {
                            setActionBarRange(activeRange);
                            setHiddenActionBarRange(activeRange);
                        }
                    }

                    // Reset flag after a short delay
                    setTimeout(() => {
                        isClickingInsideRef.current = false;
                    }, 100);
                } else {

                    // Tap/click outside - clear everything
                    setActionBarRange(null);
                    setHiddenActionBarRange(null);
                }

                // Always handle tap/click as seek (only for non-touch events)
                if (!isTouch) {
                    handleClick(
                        { clientX: upClientX },
                        timelineRef.current,
                        duration,
                        onTimelineClick,
                        getTimeRange(),
                        lastManualPanTime
                    );
                } else {
                    // For touch events, manually seek to the position
                    if (onTimelineClick) {
                        onTimelineClick(clickTime);
                    }
                }
            }

            // Clean up drag state
            if (onSegmentSelect) {
                setIsDraggingSegment(false);
                setDragStartTime(null);
                setDragCurrentTime(null);
                dragStartRef.current = null;
                dragCurrentRef.current = null;
                isDraggingRef.current = false;
            }
        };

        return { handlePointerMove, handlePointerUp };
    };

    // Handle mouse down - supports both click and drag
    const handleMouseDown = (e) => {
        e.preventDefault();
        e.stopPropagation();

        const { handlePointerMove, handlePointerUp } = handlePointerDown(e.clientX, e.clientY, false);

        const handleMouseMove = (moveEvent) => {
            handlePointerMove(moveEvent.clientX);
        };

        const handleMouseUp = (upEvent) => {
            handlePointerUp(upEvent.clientX);
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        };

        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
    };

    // Handle touch start - supports both tap and drag for mobile devices
    const handleTouchStart = (e) => {
        // Don't prevent default to allow scrolling if needed
        e.stopPropagation();

        const touch = e.touches[0];
        const { handlePointerMove, handlePointerUp } = handlePointerDown(touch.clientX, touch.clientY, true);

        const handleTouchMove = (moveEvent) => {
            // Prevent scrolling when dragging on timeline
            moveEvent.preventDefault();
            const moveTouch = moveEvent.touches[0];
            handlePointerMove(moveTouch.clientX);
        };

        const handleTouchEnd = (endEvent) => {
            // Use the last known touch position or the touch end position
            const endTouch = endEvent.changedTouches[0];
            handlePointerUp(endTouch.clientX);
            document.removeEventListener('touchmove', handleTouchMove);
            document.removeEventListener('touchend', handleTouchEnd);
            document.removeEventListener('touchcancel', handleTouchEnd);
        };

        document.addEventListener('touchmove', handleTouchMove, { passive: false });
        document.addEventListener('touchend', handleTouchEnd);
        document.addEventListener('touchcancel', handleTouchEnd);
    };

    return { handleMouseDown, handleTouchStart, handleContextMenu };
};
