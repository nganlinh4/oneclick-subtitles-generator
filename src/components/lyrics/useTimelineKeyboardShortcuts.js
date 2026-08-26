import { useEffect } from 'react';

import { cueOverlapsTimelineRange, getSelectAllRange } from './utils/timelineDomain';

// Helper: ignore shortcuts when typing in inputs/textareas/contenteditable editors.
// Exported so other keydown handlers (e.g. Delete/Backspace clear-in-range) reuse it.
export const isEventFromEditable = (e) => {
    const el = (e && e.target) || document.activeElement;
    if (!el || typeof el.closest !== 'function') return false;
    // Match native inputs and common rich editors
    return !!el.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], .monaco-editor, .cm-content, .CodeMirror');
};

// Keyboard shortcut handler: Alt+S toggles auto-scroll, Ctrl+A selects the
// entire video range. Refs/state/setters are threaded in via params; window
// keydown listener is added on mount and removed on cleanup.
export const useTimelineKeyboardShortcuts = ({
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
}) => {
    useEffect(() => {
        const handleKeyDown = (e) => {
            if (isEventFromEditable(e)) return;
            // Alt+S to toggle auto-scrolling
            if (e.altKey && e.key === 's') {
                disableAutoScroll.current = !disableAutoScroll.current;


                // Show a temporary message on the canvas
                const canvas = timelineRef.current;
                if (canvas) {
                    const ctx = canvas.getContext('2d');
                    const message = `Auto-scrolling ${disableAutoScroll.current ? 'disabled' : 'enabled'}`;

                    // Save current state
                    ctx.save();

                    // Draw message
                    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
                    ctx.fillRect(10, 10, 200, 30);
                    ctx.fillStyle = '#ffffff';
                    ctx.font = '14px Arial';
                    ctx.fillText(message, 20, 30);

                    // Restore state after a delay
                    setTimeout(() => {
                        ctx.restore();
                        renderTimeline();
                    }, 1500);
                }
            }

            // Ctrl+A selects the whole playable media range. A malformed cue may remain visible
            // for repair, but no UI selection is allowed to claim time the video cannot play.
            if (e.ctrlKey && e.key.toLowerCase() === 'a' && onSegmentSelect) {
                const selectAllRange = getSelectAllRange(lyrics, duration);
                if (!(selectAllRange.end > selectAllRange.start)) return;
                e.preventDefault(); // Prevent default browser select all



                const { start: startTime, end: endTime } = selectAllRange;

                // Mark that dragging has been done in this session
                setHasDraggedInSession(true);

                // Set drag state to show visual selection
                setIsDraggingSegment(true);
                setDragStartTime(startTime);
                setDragCurrentTime(endTime);
                dragStartRef.current = startTime;
                dragCurrentRef.current = endTime;
                isDraggingRef.current = true;

                // Force re-render to show selection
                renderTimeline();

                const rangeHasSubtitles = Array.isArray(lyrics)
                    && lyrics.some(l => cueOverlapsTimelineRange(l, startTime, endTime));
                if (rangeHasSubtitles) {
                    // The selection is live the moment it is announced. Arming the action bar only
                    // after the highlight animation left a half-second dead window in which
                    // Ctrl+A followed immediately by Delete silently deleted nothing.
                    setActionBarRange({ start: startTime, end: endTime });
                    setHiddenActionBarRange({ start: startTime, end: endTime });
                }

                // The delay is purely cosmetic: it holds the blue highlight before the drag state
                // clears (and, for an empty range, before the processing modal opens).
                setTimeout(() => {
                    // Clean up drag state
                    setIsDraggingSegment(false);
                    setDragStartTime(null);
                    setDragCurrentTime(null);
                    dragStartRef.current = null;
                    dragCurrentRef.current = null;
                    isDraggingRef.current = false;

                    if (!rangeHasSubtitles) {
                        // Open video processing modal for entire range
                        sessionStorage.setItem('processing_modal_open_reason', 'drag-selection');
                        onSegmentSelect({ start: startTime, end: endTime });
                    }
                }, 500); // 0.5 second delay to show blue highlight
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => {
            window.removeEventListener('keydown', handleKeyDown);
        };
    }, [renderTimeline, onSegmentSelect, duration, lyrics, timelineRef, disableAutoScroll, setHasDraggedInSession, setIsDraggingSegment, setDragStartTime, setDragCurrentTime, dragStartRef, dragCurrentRef, isDraggingRef, setActionBarRange, setHiddenActionBarRange]);
};
