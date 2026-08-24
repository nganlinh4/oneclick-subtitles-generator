import LiquidGlass from '../common/LiquidGlass';
import { createTimelineDomain } from './utils/timelineDomain';

// Liquid Glass zoom controls in the top right corner. Pure presentational
// component: zoom/pan state, callbacks and the zoom-drag refs are threaded in
// via props. The mouse/touch drag handlers register document listeners and
// remove them on up/cancel so there is no leak across drags.
const TimelineZoomControls = ({
    setZoom,
    zoom,
    duration,
    lyrics,
    currentTime,
    panOffset,
    setPanOffset,
    disableAutoScroll,
    lastManualPanTime,
    zoomDragActiveRef,
    zoomDragLastXRef,
    zoomDragRafRef,
    currentZoomRef,
    lastComputedPanRef,
    t
}) => {
    if (!setZoom) return null;

    return (
        <LiquidGlass
            width={80}
            height={32}
            position="absolute"
            top="8px"
            right="8px"
            borderRadius="16px"
            className="content-center theme-primary size-small"
            cursor="ew-resize"
            zIndex={10}
            effectIntensity={0.8}
            effectRadius={0.4}
            effectWidth={0.25}
            effectHeight={0.15}
            animateOnHover={true}
            hoverScale={1.05}
            updateOnMouseMove={true}
            aria-label={t('timeline.dragToZoom', 'Drag to zoom')}
            style={{
                transition: 'transform 0.2s ease, box-shadow 0.2s ease'
            }}
        >
            <div
                style={{
                    width: '100%',
                    height: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'ew-resize'
                }}
                onMouseDown={(e) => {
                    const startX = e.clientX;
                    const startZoom = zoom;
                    // Hard-disable auto-scroll during zoom drag to avoid any conflicts
                    disableAutoScroll.current = true;


                    // Mark this as a manual interaction to prevent auto-scroll interference
                    lastManualPanTime.current = performance.now();

                    // Start RAF-based zoom drag to keep playhead strictly centered
                    zoomDragActiveRef.current = true;
                    zoomDragLastXRef.current = startX;

                    const step = () => {
                        if (!zoomDragActiveRef.current) return;
                        const x = zoomDragLastXRef.current;
                        const deltaX = x - startX;
                        const newZoom = Math.max(1, Math.min(200, startZoom + (deltaX * 0.05)));

                        const timelineDomain = createTimelineDomain(lyrics, duration);
                        if (timelineDomain.contentEnd > 0 && setPanOffset) {
                            const timelineEnd = timelineDomain.viewEnd;
                            const newVisibleDuration = timelineEnd / newZoom;
                            const halfVisibleDuration = newVisibleDuration / 2;

                            const videoElement = document.querySelector('video');
                            const liveTime = (videoElement && !isNaN(videoElement.currentTime))
                                ? videoElement.currentTime
                                : currentTime;

                            const newPanOffset = Math.max(0, Math.min(
                                liveTime - halfVisibleDuration,
                                timelineEnd - newVisibleDuration
                            ));
                            currentZoomRef.current = newZoom;
                            lastComputedPanRef.current = newPanOffset;

                            // Apply zoom first, then pan to avoid parent reactions overriding pan
                            setZoom(newZoom);
                            setPanOffset(newPanOffset);

                        }
                        lastManualPanTime.current = performance.now();
                        zoomDragRafRef.current = requestAnimationFrame(step);
                    };

                    const handleMouseMove = (moveEvent) => {
                        zoomDragLastXRef.current = moveEvent.clientX;
                        lastManualPanTime.current = performance.now();
                    };

                    const handleMouseUp = () => {
                        document.removeEventListener('mousemove', handleMouseMove);
                        document.removeEventListener('mouseup', handleMouseUp);
                        // Stop RAF loop
                        zoomDragActiveRef.current = false;
                        if (zoomDragRafRef.current) cancelAnimationFrame(zoomDragRafRef.current);
                        // Finalize to the dragged result view (do NOT recenter to playhead)
                        const x = zoomDragLastXRef.current;
                        const deltaX = x - startX;
                        const newZoom = Math.max(1, Math.min(200, startZoom + (deltaX * 0.05)));
                        if (createTimelineDomain(lyrics, duration).contentEnd > 0 && setPanOffset) {
                            // Prefer the latest pan computed during drag
                            const finalPan = (lastComputedPanRef.current ?? panOffset);

                            currentZoomRef.current = newZoom;
                            // Apply zoom first, then pan
                            setZoom(newZoom);
                            setPanOffset(finalPan);
                            disableAutoScroll.current = false;
                        } else {
                            // Ensure auto-scroll is re-enabled even if early-return path
                            disableAutoScroll.current = false;

                        }
                        lastManualPanTime.current = performance.now();
                    };

                    document.addEventListener('mousemove', handleMouseMove);
                    document.addEventListener('mouseup', handleMouseUp);
                    // Kick off the RAF loop
                    zoomDragRafRef.current = requestAnimationFrame(step);
                    e.preventDefault();
                    e.stopPropagation();
                }}
                onTouchStart={(e) => {
                    const touch = e.touches && e.touches[0];
                    if (!touch) return;
                    const startX = touch.clientX;
                    const startZoom = zoom;
                    lastManualPanTime.current = performance.now();
                    // Hard-disable auto-scroll during zoom drag (touch)
                    disableAutoScroll.current = true;


                    // Start RAF-based zoom drag for touch to keep playhead centered
                    zoomDragActiveRef.current = true;
                    zoomDragLastXRef.current = startX;

                    const step = () => {
                        if (!zoomDragActiveRef.current) return;
                        const x = zoomDragLastXRef.current;
                        const deltaX = x - startX;
                        const newZoom = Math.max(1, Math.min(200, startZoom + (deltaX * 0.05)));

                        const timelineDomain = createTimelineDomain(lyrics, duration);
                        if (timelineDomain.contentEnd > 0 && setPanOffset) {
                            const timelineEnd = timelineDomain.viewEnd;
                            const newVisibleDuration = timelineEnd / newZoom;
                            const halfVisibleDuration = newVisibleDuration / 2;

                            const videoElement = document.querySelector('video');
                            const liveTime = (videoElement && !isNaN(videoElement.currentTime))
                                ? videoElement.currentTime
                                : currentTime;

                            const newPanOffset = Math.max(0, Math.min(
                                liveTime - halfVisibleDuration,
                                timelineEnd - newVisibleDuration
                            ));
                            currentZoomRef.current = newZoom;
                            lastComputedPanRef.current = newPanOffset;

                            setZoom(newZoom);
                            setPanOffset(newPanOffset);
                            requestAnimationFrame(() => { if (zoomDragActiveRef.current) setPanOffset(newPanOffset); });
                        }
                        lastManualPanTime.current = performance.now();
                        zoomDragRafRef.current = requestAnimationFrame(step);
                    };

                    const handleTouchMove = (te) => {
                        const t = (te.touches && te.touches[0]) || (te.changedTouches && te.changedTouches[0]);
                        if (!t) return;
                        zoomDragLastXRef.current = t.clientX;
                        lastManualPanTime.current = performance.now();
                        te.preventDefault();
                        te.stopPropagation();
                    };

                    const handleTouchEnd = () => {
                        document.removeEventListener('touchmove', handleTouchMove);
                        document.removeEventListener('touchend', handleTouchEnd);
                        document.removeEventListener('touchcancel', handleTouchEnd);
                        // Stop RAF loop
                        zoomDragActiveRef.current = false;
                        if (zoomDragRafRef.current) cancelAnimationFrame(zoomDragRafRef.current);
                        // Finalize to the dragged result view (do NOT recenter to playhead)
                        const x = zoomDragLastXRef.current;
                        const deltaX = x - startX;
                        const newZoom = Math.max(1, Math.min(200, startZoom + (deltaX * 0.05)));
                        if (createTimelineDomain(lyrics, duration).contentEnd > 0 && setPanOffset) {
                            const finalPan = (lastComputedPanRef.current ?? panOffset);

                            currentZoomRef.current = newZoom;
                            setZoom(newZoom);
                            setPanOffset(finalPan);
                            disableAutoScroll.current = false;
                        } else {
                            disableAutoScroll.current = false;

                        }
                        lastManualPanTime.current = performance.now();
                    };

                    document.addEventListener('touchmove', handleTouchMove, { passive: false });
                    document.addEventListener('touchend', handleTouchEnd);
                    document.addEventListener('touchcancel', handleTouchEnd);
                    // Kick off the RAF loop
                    zoomDragRafRef.current = requestAnimationFrame(step);
                    e.preventDefault();
                    e.stopPropagation();
                }}
            >
                <span style={{
                    fontSize: '12px',
                    fontWeight: '600',
                    color: 'var(--md-on-surface)',
                    fontFamily: 'JetBrains Mono, monospace',
                    userSelect: 'none',
                    pointerEvents: 'none'
                }}>
                    {Math.round(zoom * 100)}%
                </span>
            </div>
        </LiquidGlass>
    );
};

export default TimelineZoomControls;
