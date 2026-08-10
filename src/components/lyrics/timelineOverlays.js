import { useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';

// Helper overlay component that follows the timeline canvas without leaking rAF
export const OverlayFollower = ({ canvasRef, deps = [], computeStyle, children }) => {
    const containerRef = useRef(null);
    const computeStyleRef = useRef(computeStyle);
    const scheduleRef = useRef(() => { });
    const lastScheduleInputsRef = useRef(null);

    // Always keep latest computeStyle without tearing down listeners
    useEffect(() => { computeStyleRef.current = computeStyle; }, [computeStyle]);

    // Do initial measure before paint to avoid 0,0 flash; keep listeners stable
    useLayoutEffect(() => {
        const canvas = canvasRef.current;
        const el = containerRef.current;
        if (!canvas || !el) return;
        let rafId = 0;
        const update = () => {
            const bounds = canvas.getBoundingClientRect();
            const style = computeStyleRef.current(bounds);
            if (style && el) Object.assign(el.style, style);
            // Only interactable/visible when there is actual child content (e.g., a button)
            const hasChild = !!(el && el.firstElementChild);
            el.style.visibility = hasChild ? 'visible' : 'hidden';
            el.style.pointerEvents = hasChild ? 'auto' : 'none';
        };
        const schedule = () => {
            if (rafId) cancelAnimationFrame(rafId);
            rafId = requestAnimationFrame(update);
        };
        scheduleRef.current = schedule;

        // Initial sync update to avoid flicker
        try { update(); } catch {
            // Initial measurement is best-effort while the canvas is mounting.
        }

        const ro = new ResizeObserver(schedule);
        ro.observe(canvas);
        window.addEventListener('scroll', schedule, true);
        window.addEventListener('resize', schedule);

        return () => {
            ro.disconnect();
            window.removeEventListener('scroll', schedule, true);
            window.removeEventListener('resize', schedule);
            if (rafId) cancelAnimationFrame(rafId);
            scheduleRef.current = () => { };
        };
    }, [canvasRef]);

    // When deps change (zoom/pan/lyrics/time), just schedule an update; don't teardown
    useEffect(() => {
        const inputs = [computeStyle, ...deps];
        const previous = lastScheduleInputsRef.current;
        const changed = !previous
            || previous.length !== inputs.length
            || inputs.some((input, index) => !Object.is(input, previous[index]));
        if (changed) {
            lastScheduleInputsRef.current = inputs;
            scheduleRef.current();
        }
    });

    return (
        <div style={{ position: 'fixed', inset: 0, pointerEvents: 'none' }}>
            <div ref={containerRef} style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'auto', zIndex: 1000, visibility: 'hidden' }}>
                {children}
            </div>
        </div>
    );
};

// Separate component to prevent re-mounting of the overlay
export const ClearOfflineSegmentsButton = ({ offlineSegments, retryingOfflineKeys, clearInfoVisible, handleClearOfflineSegments, t, timelineRef }) => {
    const clearOfflineComputeStyle = useCallback((bounds) => ({ top: `${(bounds.top || 0) - 36}px`, left: `${(bounds.left || 0) + 8}px` }), []);

    if (offlineSegments.length === 0 || retryingOfflineKeys.length > 0) return null;

    const canvas = timelineRef.current;
    if (!canvas) return null;

    const overlay = (
        <OverlayFollower canvasRef={timelineRef} computeStyle={clearOfflineComputeStyle} deps={[]}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button
                    className="btn-base btn-tonal btn-small"
                    onClick={(e) => { e.stopPropagation(); handleClearOfflineSegments(); }}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 24, minHeight: 24, padding: '0 8px', borderRadius: 12, backgroundColor: 'var(--md-surface-variant)', color: 'var(--md-on-surface-variant)', border: '1px solid var(--md-outline-variant)' }}
                >
                    <span className="material-symbols-rounded" style={{ fontSize: '18px', color: 'currentColor' }}>delete_sweep</span>
                    {t('timeline.clearOfflineSegments', 'Clear offline segments')}
                </button>
                {clearInfoVisible && (
                    <span role="status" aria-live="polite" style={{ whiteSpace: 'nowrap', fontSize: 12, padding: '2px 8px', borderRadius: 10, color: 'var(--md-on-surface-variant)', backgroundColor: 'var(--md-surface-variant)', border: '1px solid var(--md-outline-variant)' }}>
                        {t('timeline.offlineClearNotice', 'Cleared offline segments from UI. Files will be removed in background and may persist briefly due to OS locks.')}
                    </span>
                )}
            </div>
        </OverlayFollower>
    );

    return createPortal(overlay, document.body);
};
