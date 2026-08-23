import { useRef, useEffect, useLayoutEffect } from 'react';

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
