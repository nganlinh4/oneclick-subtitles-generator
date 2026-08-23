import { useEffect } from 'react';

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

            // Ctrl+A to select entire video range
            if (e.ctrlKey && e.key === 'a' && onSegmentSelect && duration) {
                e.preventDefault(); // Prevent default browser select all



                // Set drag state to simulate range selection from 0 to duration
                const startTime = 0;
                const endTime = duration;

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



                // Show selection for 500ms, then open modal
                setTimeout(() => {
                    // Clean up drag state
                    setIsDraggingSegment(false);
                    setDragStartTime(null);
                    setDragCurrentTime(null);
                    dragStartRef.current = null;
                    dragCurrentRef.current = null;
                    isDraggingRef.current = false;

                    // Helper function to check if there are subtitles in the range
                    const checkForSubtitles = (start, end) => {
                        if (!lyrics || lyrics.length === 0) return false;
                        // Only consider subtitles fully contained within the range
                        return lyrics.some(l => l.start >= start && l.end <= end);
                    };

                    // Check if there are subtitles in the range
                    if (checkForSubtitles(startTime, endTime)) {
                        // Show action bar instead of opening modal
                        setActionBarRange({ start: startTime, end: endTime });
                        setHiddenActionBarRange({ start: startTime, end: endTime });
                    } else {
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
