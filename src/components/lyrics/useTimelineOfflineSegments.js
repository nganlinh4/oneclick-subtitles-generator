import { useState, useEffect, useCallback } from 'react';
import { EVENTS, subscribe } from '../../events/bus';
import { clearCache } from '../../platform/cacheService';

// Hook owning offline-segments loading/management state plus the clear/retry
// handlers and the retry-completion event listeners (with cleanup).
// State that the parent also reads (offlineSegments, retryingOfflineKeys,
// hoveredOfflineRange, clearInfoVisible) is returned so it can render and
// gate hover logic; setHoveredOfflineRange is threaded back for canvas hover.
export const useTimelineOfflineSegments = ({ onSegmentSelect }) => {
    // Offline segments lingering after processing (for quick retry from cached cuts)
    const [offlineSegments, setOfflineSegments] = useState([]); // [{ start, end, url, name }]
    const [hoveredOfflineRange, setHoveredOfflineRange] = useState(null);
    // Track which offline ranges are currently retrying (keys: "start-end")
    const [retryingOfflineKeys, setRetryingOfflineKeys] = useState([]);

    // Subtle, non-intrusive inline notice (no toast)
    const [clearInfoVisible, setClearInfoVisible] = useState(false);

    // Load offline segments for current video; on a fresh session, do not restore stale state
    useEffect(() => {
        const SESSION_FLAG = 'session_offline_loaded_v1';
        const isFreshSession = !sessionStorage.getItem(SESSION_FLAG);

        const loadOrResetOffline = () => {
            try {
                const videoKey = localStorage.getItem('current_file_cache_id')
                    || localStorage.getItem('current_file_url')
                    || localStorage.getItem('current_video_url');

                // On a brand-new session, clear cached offline segments for current video to avoid stuck UI
                if (isFreshSession && videoKey) {
                    try {
                        const raw0 = localStorage.getItem('offline_segments_cache');
                        const cache0 = raw0 ? JSON.parse(raw0) : {};
                        if (cache0[videoKey]) {
                            delete cache0[videoKey];
                            localStorage.setItem('offline_segments_cache', JSON.stringify(cache0));
                        }
                    } catch {
                        // Corrupt legacy cache entries are discarded below.
                    }
                    setOfflineSegments([]);
                    sessionStorage.setItem(SESSION_FLAG, '1');
                    return; // don't load any list on first session restore
                }

                // Normal path: load existing offline segments for this video (if any)
                const raw = localStorage.getItem('offline_segments_cache');
                const cache = raw ? JSON.parse(raw) : {};
                const list = (videoKey && Array.isArray(cache[videoKey])) ? cache[videoKey] : [];
                setOfflineSegments(list);
            } catch {
                // Corrupt legacy cache entries behave as an empty cache.
            }
        };

        loadOrResetOffline();

        // Update when a new offline segment is cached
        const onCached = (e) => {
            const { start, end, url, name } = (e && e.detail) || {};
            if (typeof start !== 'number' || typeof end !== 'number' || !url) return;
            setOfflineSegments(prev => {
                const exists = prev.some(r => Math.abs(r.start - start) < 1e-6 && Math.abs(r.end - end) < 1e-6);
                if (exists) return prev;
                return [...prev, { start, end, url, name }];
            });
        };
        window.addEventListener('offline-segment-cached', onCached);

        return () => window.removeEventListener('offline-segment-cached', onCached);
    }, []);

    // Clear all offline segments and their native cache entries (fire-and-forget).
    const handleClearOfflineSegments = useCallback(() => {
        try {
            const urls = (offlineSegments || []).map(r => r.url).filter(Boolean);
            if (urls.length > 0) {
                try {
                    clearCache('videoTemp').catch((error) => {
                        console.warn('[Timeline] Failed to clear native video cache (non-blocking):', error);
                    });
                } catch (e) {
                    console.warn('[Timeline] Failed to initiate delete-videos (non-blocking):', e);
                }
            }

            // Clear local cache for current video immediately so UI never gets stuck
            try {
                const videoKey = localStorage.getItem('current_file_cache_id')
                    || localStorage.getItem('current_file_url')
                    || localStorage.getItem('current_video_url');
                if (videoKey) {
                    const raw = localStorage.getItem('offline_segments_cache');
                    const cache = raw ? JSON.parse(raw) : {};
                    if (cache[videoKey]) {
                        delete cache[videoKey];
                        localStorage.setItem('offline_segments_cache', JSON.stringify(cache));
                    }
                }
            } catch {
                // Local cache cleanup is best-effort; UI state remains authoritative.
            }

            // Update UI state regardless of backend outcome
            setOfflineSegments([]);
            setHoveredOfflineRange(null); // Clear hover state immediately
            try {
                window.dispatchEvent(new CustomEvent('offline-segments-cleared'));
            } catch {
                // Event dispatch is best-effort during document teardown.
            }

            // Show a subtle inline confirmation instead of a toast
            setClearInfoVisible(true);
            setTimeout(() => setClearInfoVisible(false), 4000);
        } catch (e) {
            console.error('[Timeline] Error clearing offline segments (UI proceeded):', e);
            // Even on unexpected errors, keep UI consistent
            setOfflineSegments([]);
            setHoveredOfflineRange(null); // Clear hover state immediately
        }
    }, [offlineSegments]);

    // Retry an offline range: open processing modal with locked settings
    const handleRetryOfflineRange = useCallback((range) => {
        if (!range) return;
        try {
            // Mark open reason as retry so the modal locks specific controls
            sessionStorage.setItem('processing_modal_open_reason', 'retry-offline');
            if (range.url) {
                sessionStorage.setItem('processing_modal_cached_url', range.url);
            }

            // Mark this specific offline range as "retrying" so the timeline animates only this segment
            const key = `${range.start}-${range.end}`;
            setRetryingOfflineKeys(prev => (prev && prev.includes(key)) ? prev : [...(prev || []), key]);

            // Open the processing options modal for this range
            if (onSegmentSelect) {
                onSegmentSelect({ start: range.start, end: range.end });
            } else if (range.url) {
                // Fallback to original behavior if modal cannot be opened
                window.dispatchEvent(new CustomEvent('retry-segment-from-cache', {
                    detail: { start: range.start, end: range.end, url: range.url }
                }));
            }
        } catch (e) {
            console.error('[Timeline] Failed to initiate retry from cache:', e);
        }
    }, [onSegmentSelect]);

    // Clear loading state when retry completes (success or failure)
    useEffect(() => {
        const onStreamingComplete = (e) => {
            const seg = e && e.detail && e.detail.segment;
            if (seg && typeof seg.start === 'number' && typeof seg.end === 'number') {
                const key = `${seg.start}-${seg.end}`;
                setRetryingOfflineKeys(prev => prev.filter(k => k !== key));
            }
        };
        const onRetryComplete = (e) => {
            const d = e && e.detail;
            if (d && typeof d.start === 'number' && typeof d.end === 'number') {
                const key = `${d.start}-${d.end}`;
                setRetryingOfflineKeys(prev => prev.filter(k => k !== key));
            }
        };
        const unsubA = subscribe(EVENTS.STREAMING_COMPLETE, onStreamingComplete);
        const unsubB = subscribe(EVENTS.RETRY_SEGMENT_FROM_CACHE_COMPLETE, onRetryComplete);
        return () => { unsubA(); unsubB(); };
    }, []);

    // Clear any segment-specific retry animations if user force-stops all requests
    useEffect(() => {
        const onAborted = () => {
            setRetryingOfflineKeys([]);
        };
        const un = subscribe(EVENTS.GEMINI_REQUESTS_ABORTED, onAborted);
        return () => un();
    }, []);

    // Stop retry animation if the processing modal is closed without confirming (cancelled)
    useEffect(() => {
        const onRetryModalClosed = (e) => {
            const d = e && e.detail;
            if (d && typeof d.start === 'number' && typeof d.end === 'number' && (d.confirmed === false)) {
                const key = `${d.start}-${d.end}`;
                setRetryingOfflineKeys(prev => prev.filter(k => k !== key));
            }
        };
        window.addEventListener('retry-offline-modal-closed', onRetryModalClosed);
        return () => {
            window.removeEventListener('retry-offline-modal-closed', onRetryModalClosed);
        };
    }, []);

    return {
        offlineSegments,
        retryingOfflineKeys,
        hoveredOfflineRange,
        setHoveredOfflineRange,
        clearInfoVisible,
        handlers: {
            handleClearOfflineSegments,
            handleRetryOfflineRange
        }
    };
};
