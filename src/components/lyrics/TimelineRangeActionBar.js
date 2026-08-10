import { createPortal } from 'react-dom';
import { OverlayFollower } from './timelineOverlays';

// Range action-bar overlay placed vertically above the timeline canvas.
// Pure component: all state/refs/callbacks are threaded in via props. The
// move-drag handlers register window/document listeners and remove them on
// pointerup/pointercancel so there is no leak across drags.
const TimelineRangeActionBar = ({
    actionBarRange,
    retryingOfflineKeys,
    timelineRef,
    getTimeRange,
    moveDragOffsetPx,
    setMoveDragOffsetPx,
    moveDragOffsetPxRef,
    rangePreviewDeltaRef,
    isRangeMoveDraggingRef,
    isClickingInsideRef,
    setActionBarRange,
    setHiddenActionBarRange,
    selectedSegment,
    onBeginMoveRange,
    onPreviewMoveRange,
    onCommitMoveRange,
    onMoveRange,
    onSegmentSelect,
    onClearRange,
    panOffset,
    zoom,
    lyrics,
    t
}) => {
    if (!actionBarRange || retryingOfflineKeys.length !== 0) return null;

    const canvas = timelineRef.current;
    const { start: visStart, end: visEnd } = getTimeRange();
    const width = canvas?.clientWidth || 1;
    const toPx = (time) => ((time - visStart) / Math.max(0.0001, (visEnd - visStart))) * width;
    const leftPx = Math.max(0, Math.min(width, toPx(actionBarRange.start)));
    const rightPx = Math.max(0, Math.min(width, toPx(actionBarRange.end)));
    const barLeft = Math.min(leftPx, rightPx) + moveDragOffsetPx;
    const barWidth = Math.max(24, Math.abs(rightPx - leftPx));
    const timePerPx = (visEnd - visStart) / Math.max(1, width);

    // Unified Pointer Events handler (robust on mobile): keeps capture during drag
    const handleMovePointerDown = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX;
        const startOffset = moveDragOffsetPx;
        const startRange = actionBarRange;
        isRangeMoveDraggingRef.current = true;
        if (onBeginMoveRange && startRange) onBeginMoveRange(startRange.start, startRange.end);

        // Try to capture the pointer so move/up keep firing even if finger leaves the button
        try {
            const pid = (e.pointerId != null) ? e.pointerId : (e.nativeEvent && e.nativeEvent.pointerId);
            if (e.currentTarget && e.currentTarget.setPointerCapture && pid != null) {
                e.currentTarget.setPointerCapture(pid);
            }
        } catch {
            // Pointer capture is optional; window listeners still complete the drag.
        }

        const onMove = (pe) => {
            const px = startOffset + (pe.clientX - startX);
            setMoveDragOffsetPx(px);
            moveDragOffsetPxRef.current = px;
            const deltaSeconds = px * timePerPx;
            rangePreviewDeltaRef.current = deltaSeconds;
            onPreviewMoveRange && onPreviewMoveRange(deltaSeconds);
            pe.preventDefault();
        };

        const cleanup = () => {
            window.removeEventListener('pointermove', onMove, true);
            window.removeEventListener('pointerup', onUp, true);
            window.removeEventListener('pointercancel', onUp, true);
        };

        const onUp = () => {
            cleanup();
            const deltaSeconds = (moveDragOffsetPxRef.current || 0) * timePerPx;
            if (onCommitMoveRange) onCommitMoveRange();
            else if (onMoveRange && Math.abs(deltaSeconds) > 0.001)
                onMoveRange(actionBarRange.start, actionBarRange.end, deltaSeconds);
            setMoveDragOffsetPx(0);
            moveDragOffsetPxRef.current = 0;
            rangePreviewDeltaRef.current = 0;
            setActionBarRange(null);
            setHiddenActionBarRange(null);
            isRangeMoveDraggingRef.current = false;
        };

        window.addEventListener('pointermove', onMove, { capture: true, passive: false });
        window.addEventListener('pointerup', onUp, { capture: true });
        window.addEventListener('pointercancel', onUp, { capture: true });
    };

    if (!canvas) return null;
    const computeStyle = (bounds) => ({ top: `${(bounds.top || 0) - 36}px`, left: `${(bounds.left || 0) + Math.max(0, Math.min((canvas?.clientWidth || width) - barWidth, barLeft))}px` });

    const overlay = (
        <OverlayFollower canvasRef={timelineRef} computeStyle={computeStyle} deps={[actionBarRange, moveDragOffsetPx, panOffset, zoom, lyrics]}>
            <div
                className="range-action-bar"
                style={{
                    position: 'absolute',
                    top: '0px',
                    left: '0px',
                    width: `${barWidth}px`,
                    transform: 'translateX(0)',
                    display: 'flex',
                    gap: 8,
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: '4px 6px',
                    borderRadius: 12,
                    zIndex: 999,
                    color: 'var(--md-on-surface)',
                    pointerEvents: 'auto',
                    touchAction: 'none'
                }}
                onMouseLeave={() => {
                    // Don't hide if we're clicking inside the range or currently dragging the move handle
                    if (isClickingInsideRef.current || isRangeMoveDraggingRef.current) {
                        return;
                    }

                    // Hide the action bar when mouse leaves, but keep the range stored
                    // If this is for a selectedSegment, we want to be able to show it again
                    if (selectedSegment &&
                        actionBarRange.start === selectedSegment.start &&
                        actionBarRange.end === selectedSegment.end) {
                        // For selectedSegment, just hide the bar but keep tracking
                        setHiddenActionBarRange(actionBarRange);
                    } else {
                        // For manually selected ranges
                        setHiddenActionBarRange(actionBarRange);
                    }
                    setActionBarRange(null);
                }}
                onPointerLeave={() => {
                    // Same logic as onMouseLeave, but for pointer devices (covers touch pointers too)
                    if (isClickingInsideRef.current || isRangeMoveDraggingRef.current) {
                        return;
                    }
                    if (selectedSegment &&
                        actionBarRange.start === selectedSegment.start &&
                        actionBarRange.end === selectedSegment.end) {
                        setHiddenActionBarRange(actionBarRange);
                    } else {
                        setHiddenActionBarRange(actionBarRange);
                    }
                    setActionBarRange(null);
                }}
            >
                <button
                    className="btn-base btn-primary btn-small"
                    style={{ fontStretch: 'condensed' }}
                    onClick={(e) => {
                        e.stopPropagation();
                        sessionStorage.setItem('processing_modal_open_reason', 'action-bar-regenerate');
                        onSegmentSelect && onSegmentSelect(actionBarRange);
                        setActionBarRange(null);
                        setHiddenActionBarRange(null);
                    }}
                >
                    {t('timeline.generateReplace', 'Regenerate subtitles')}
                </button>
                <button
                    className="btn-base btn-primary btn-small"
                    title={t('timeline.clearInRangeWithShortcut', 'Clear subtitles in range (Del/Backspace)')}
                    onClick={(e) => {
                        e.stopPropagation();
                        onClearRange && onClearRange(actionBarRange.start, actionBarRange.end);
                        setActionBarRange(null);
                        setHiddenActionBarRange(null);
                    }}
                    style={{ width: 36, height: 36, minWidth: 36, padding: 0, borderRadius: '50%' }}
                >
                    <span className="material-symbols-rounded" style={{ fontSize: '18px', color: 'var(--md-on-primary)' }}>delete</span>
                </button>
                <button
                    className="btn-base btn-primary btn-small"
                    title={t('timeline.moveRange', 'Drag to move subtitles in range')}
                    onPointerDown={handleMovePointerDown}
                    style={{ width: 36, height: 36, minWidth: 36, padding: 0, borderRadius: '50%', cursor: 'grab', touchAction: 'none' }}
                >
                    <span className="material-symbols-rounded" style={{ fontSize: '18px', color: 'var(--md-on-primary)' }}>drag_indicator</span>
                </button>
            </div>
        </OverlayFollower>
    );

    return createPortal(overlay, document.body);
};

export default TimelineRangeActionBar;
