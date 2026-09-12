import { useEffect, useLayoutEffect, useRef } from 'react';
import { clearUnusedChunks } from '../../utils/optimizedVideoStreaming';

// Canvas animation owns its clock. React commits change drawing inputs, not subscriptions or
// per-frame component state. Resize, playback and streamed cues draw the latest committed data.
export const useTimelineRenderEffects = ({
    renderTimeline, timelineRef, newSegments, setNewSegments, isProcessing, animationTimeRef,
    zoom, currentZoomRef, duration, panOffset, setPanOffset, currentTime, videoSource,
    lastManualPanTime, disableAutoScroll, getTimeRange, isScrollingRef,
}) => {
    const drawRef = useRef(renderTimeline);
    const processingStart = useRef(null);

    useLayoutEffect(() => {
        processingStart.current = isProcessing ? performance.now() : null;
        animationTimeRef.current = 0;
    }, [isProcessing, animationTimeRef]);

    useLayoutEffect(() => {
        drawRef.current = renderTimeline;
        currentZoomRef.current = zoom;
        renderTimeline();
    }, [renderTimeline, currentZoomRef, zoom]);

    useEffect(() => {
        if (!isProcessing && newSegments.size === 0) return undefined;
        let frame = null;
        let disposed = false;
        const animate = () => {
            if (disposed) return;
            frame = null;
            const now = performance.now();
            animationTimeRef.current = processingStart.current === null ? 0 : now - processingStart.current;
            drawRef.current();
            const active = [...newSegments.values()].some(value => now - value.startTime < 800);
            if (!active && newSegments.size > 0) {
                setNewSegments(previous => new Map(
                    [...previous].filter(([, value]) => now - value.startTime < 800),
                ));
            }
            if (isProcessing || active) frame = requestAnimationFrame(animate);
        };
        frame = requestAnimationFrame(animate);
        return () => {
            disposed = true;
            if (frame !== null) cancelAnimationFrame(frame);
        };
    }, [isProcessing, newSegments, setNewSegments, animationTimeRef]);

    useEffect(() => {
        const draw = () => drawRef.current();
        window.addEventListener('waveformLongVideosChanged', draw);
        return () => window.removeEventListener('waveformLongVideosChanged', draw);
    }, []);

    useEffect(() => {
        const canvas = timelineRef.current;
        const container = canvas?.parentElement;
        if (!container) return undefined;
        let frame = null;
        const resize = () => {
            if (frame !== null) return;
            frame = requestAnimationFrame(() => {
                frame = null;
                const width = `${container.getBoundingClientRect().width}px`;
                if (canvas.style.width !== width) canvas.style.width = width;
                if (canvas.style.height !== '50px') canvas.style.height = '50px';
                drawRef.current();
            });
        };
        const observer = new ResizeObserver(resize);
        observer.observe(container);
        window.addEventListener('resize', resize);
        resize();
        return () => {
            observer.disconnect();
            window.removeEventListener('resize', resize);
            if (frame !== null) cancelAnimationFrame(frame);
        };
    }, [timelineRef]);

    useEffect(() => {
        if (duration > 1800 && videoSource) clearUnusedChunks(videoSource, currentTime, duration);
    }, [videoSource, duration, currentTime]);

    useEffect(() => {
        if (!duration || performance.now() - lastManualPanTime.current < 5000 || disableAutoScroll.current) {
            return undefined;
        }
        const { start, end, total } = getTimeRange();
        if (isScrollingRef.current || (currentTime >= start && currentTime <= end)
            || Math.abs(currentTime - start) <= 5 || Math.abs(currentTime - end) <= 5) return undefined;
        const visibleDuration = total / currentZoomRef.current;
        const offset = Math.max(0, Math.min(currentTime - visibleDuration / 2, total - visibleDuration));
        if (Math.abs(offset - panOffset) < 1) return undefined;
        isScrollingRef.current = true;
        setPanOffset(offset);
        const timer = setTimeout(() => { isScrollingRef.current = false; }, 50);
        return () => { clearTimeout(timer); isScrollingRef.current = false; };
    }, [currentTime, duration, getTimeRange, panOffset, setPanOffset, lastManualPanTime,
        disableAutoScroll, isScrollingRef, currentZoomRef]);
};
