import { useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';

// Body-level retry overlay layer (imperative, immune to canvas animation re-renders).
// Renders no DOM itself; it appends a fixed container + button to document.body and
// positions it over the hovered offline range via the shared canvas ref.
const TimelineRetryOverlay = ({
    timelineRef,
    hoveredOfflineRange,
    retryingOfflineKeys,
    handleRetryOfflineRange,
    getTimeRange,
    panOffset,
    zoom,
    lyrics
}) => {
    const { t } = useTranslation();

    const retryOverlayContainerRef = useRef(null);
    const retryOverlayWrapperRef = useRef(null);
    const retryOverlayButtonRef = useRef(null);
    const currentHoverRef = useRef(null);
    const retryingKeysRef = useRef([]);
    const retryHandlerRef = useRef(null);

    useEffect(() => { retryingKeysRef.current = retryingOfflineKeys || []; }, [retryingOfflineKeys]);
    useEffect(() => { retryHandlerRef.current = handleRetryOfflineRange; }, [handleRetryOfflineRange]);

    // Create the overlay layer once
    useEffect(() => {
        if (retryOverlayContainerRef.current) return;
        const container = document.createElement('div');
        Object.assign(container.style, { position: 'fixed', inset: '0px', pointerEvents: 'none', zIndex: '9000' });

        const wrapper = document.createElement('div');
        Object.assign(wrapper.style, { position: 'absolute', top: '0px', left: '0px', visibility: 'hidden', pointerEvents: 'none' });

        const btn = document.createElement('button');
        btn.className = 'btn-base btn-primary btn-small';
        btn.title = t('timeline.retryFromCache', 'Retry this cut (reuse cached clip)');
        Object.assign(btn.style, { width: '30px', height: '30px', minWidth: '30px', padding: '0px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'auto' });
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const hover = currentHoverRef.current; if (!hover) return;
            const key = `${hover.start}-${hover.end}`;
            if (retryingKeysRef.current.includes(key)) return;
            if (retryHandlerRef.current) retryHandlerRef.current(hover);
        });
        btn.innerHTML = '<span class="material-symbols-rounded" style="font-size: 16px; color: var(--md-on-primary);">refresh</span>';

        wrapper.appendChild(btn);
        container.appendChild(wrapper);
        document.body.appendChild(container);

        retryOverlayContainerRef.current = container;
        retryOverlayWrapperRef.current = wrapper;
        retryOverlayButtonRef.current = btn;

        return () => {
            try { btn.remove(); wrapper.remove(); container.remove(); } catch {
                // DOM teardown is best-effort if the document is already unloading.
            }
            retryOverlayContainerRef.current = null;
            retryOverlayWrapperRef.current = null;
            retryOverlayButtonRef.current = null;
        };
    }, [t]);

    // Update overlay position/visibility when hover or view changes (ignore animation ticks)
    useEffect(() => {
        currentHoverRef.current = hoveredOfflineRange;
        const wrapper = retryOverlayWrapperRef.current;
        const btn = retryOverlayButtonRef.current;
        const canvas = timelineRef.current;
        if (!wrapper || !btn || !canvas) return;

        const hover = hoveredOfflineRange;
        if (!hover) {
            wrapper.style.visibility = 'hidden';
            wrapper.style.pointerEvents = 'none';
            return;
        }

        const key = `${hover.start}-${hover.end}`;
        if ((retryingOfflineKeys || []).includes(key)) {
            wrapper.style.visibility = 'hidden';
            wrapper.style.pointerEvents = 'none';
            return;
        }

        const width = canvas.clientWidth || 1;
        const height = canvas.clientHeight || 0;
        const bounds = canvas.getBoundingClientRect();
        const { start: visStart, end: visEnd } = getTimeRange();
        const toPx = (time) => ((time - visStart) / Math.max(0.0001, (visEnd - visStart))) * width;
        const mid = (hover.start + hover.end) / 2;
        const timeMarkerSpace = 25;
        const availableHeight = Math.max(0, height - timeMarkerSpace);
        const centerY = timeMarkerSpace + (availableHeight / 2);
        const xPx = Math.max(0, Math.min(width, toPx(mid)));

        wrapper.style.left = `${bounds.left + xPx - 18}px`;
        wrapper.style.top = `${bounds.top + centerY - 18}px`;
        wrapper.style.visibility = 'visible';
        wrapper.style.pointerEvents = 'none';
        btn.style.pointerEvents = 'auto';
    }, [hoveredOfflineRange, panOffset, zoom, lyrics, getTimeRange, retryingOfflineKeys, timelineRef]);

    // Auto-hide retry overlay on any page/ancestor scroll or window resize
    useEffect(() => {
        const hideOverlay = () => {
            const wrapper = retryOverlayWrapperRef.current;
            if (wrapper) {
                wrapper.style.visibility = 'hidden';
                wrapper.style.pointerEvents = 'none';
            }
        };
        window.addEventListener('scroll', hideOverlay, true);
        window.addEventListener('resize', hideOverlay);
        return () => {
            window.removeEventListener('scroll', hideOverlay, true);
            window.removeEventListener('resize', hideOverlay);
        };
    }, []);

    return null;
};

export default TimelineRetryOverlay;
