import { useCallback, useEffect } from 'react';
import { EVENTS, subscribe } from '../events/bus';
import { getVideoProcessingFps, getMediaResolution } from '../services/configService';
import { DEFAULT_TRANSCRIPTION_MODEL_ID, normalizeMediaModelId } from '../config/geminiModels';
import { isDesktopRuntime } from '../platform/desktopRuntime';
import {
    getSelectedMedia,
    isNativeMediaDescriptor,
    isNativeMediaPlaybackUrl,
} from '../platform/mediaService';
import { fetchBrowserResource } from '../platform/browserFetch';

// Retry policy (match Files API): 503/429 detection + progressive delays
const RETRY_DELAYS = [5, 10, 15, 20, 25]; // seconds
const INLINE_LARGE_SEGMENT_THRESHOLD_BYTES = 20 * 1024 * 1024; // 20MB (align with Google recommendation)

const is503Error = (error) => !!(error && error.message && (
    error.message.includes('503') ||
    error.message.includes('overloaded') ||
    error.message.includes('UNAVAILABLE')
));
const is429Error = (error) => !!(error && error.message && (
    error.message.includes('429') ||
    error.message.includes('RESOURCE_EXHAUSTED') ||
    error.message.includes('quota') ||
    error.message.includes('rate limit')
));

export const resolveCachedRetrySource = async (currentSource, url, {
    nativeRuntime = isDesktopRuntime,
    selectedMedia = getSelectedMedia,
    fetchMedia = globalThis.fetch,
} = {}) => {
    const desktop = nativeRuntime();
    if (desktop && isNativeMediaDescriptor(currentSource)) {
        return Object.freeze({ sourceFile: currentSource, usesOriginalMedia: true });
    }
    if (desktop) {
        const media = await selectedMedia();
        if (!isNativeMediaDescriptor(media)) {
            throw new Error('Select the media again before retrying this segment.');
        }
        return Object.freeze({ sourceFile: media, usesOriginalMedia: true });
    }
    if (currentSource) {
        return Object.freeze({ sourceFile: currentSource, usesOriginalMedia: true });
    }
    if (isNativeMediaPlaybackUrl(url)) {
        throw new Error('Native cached media cannot be fetched by the browser.');
    }
    const response = await fetchBrowserResource(url, undefined, { fetchImpl: fetchMedia });
    if (!response.ok) throw new Error(`Failed to fetch cached clip: ${response.statusText}`);
    const blob = await response.blob();
    const filename = url.split('?')[0].split('/').pop() || 'segment.mp4';
    return Object.freeze({
        sourceFile: new File([blob], filename, { type: blob.type || 'video/mp4' }),
        usesOriginalMedia: false,
    });
};

/**
 * Segment retry orchestration for useSubtitles.
 *
 * Provides:
 *  - retrySegment: the (deprecated) per-segment retry callback
 *  - a listener for EVENTS.RETRY_SEGMENT_FROM_CACHE that re-runs a single segment,
 *    preferring Files-API offsets (original source file) and falling back to a
 *    clipped cached file when needed.
 *
 * Shared state/refs are threaded via params so behavior matches the original
 * inline implementation byte-for-byte.
 */
export const useSubtitlesSegmentRetry = ({
    t,
    debugLog,
    subtitlesData,
    setSubtitlesData,
    setStatus,
    setIsGenerating,
    setRetryingSegments,
    currentSourceFileRef,
    currentRetryFromCacheRef
}) => {
    // Function to retry a specific segment
    const retrySegment = useCallback(async (segmentIndex, segments, options = {}) => {
        // Extract options
        const { modelId } = options;

        if (modelId) {
            debugLog(`[RetrySegment] Using custom model for segment ${segmentIndex + 1}: ${modelId}`);
        } else {
            debugLog(`[RetrySegment] Using default model for segment ${segmentIndex + 1}`);
        }

        // Mark this segment as retrying temporarily
        setRetryingSegments(prev => [...prev, segmentIndex]);

        try {
            // Segment retry is deprecated - show error message instead
            setStatus({
                message: t('errors.segmentRetryDeprecated', 'Segment retry is deprecated. Please use the new workflow: upload your video and select segments on the timeline for processing.'),
                type: 'error'
            });

            // Remove this segment from the retrying list since we're not actually retrying
            setRetryingSegments(prev => prev.filter(idx => idx !== segmentIndex));

            return false;
        } catch (error) {
            console.error('Error retrying segment:', error);

            // Update the segment status to show the error
            const errorStatus = {
                index: segmentIndex,
                status: 'error',
                message: error.message || t('output.processingFailed', 'Processing failed'),
                shortMessage: t('output.failed', 'Failed')
            };
            const errorEvent = new CustomEvent(EVENTS.SEGMENT_STATUS_UPDATE, { detail: [errorStatus] });
            window.dispatchEvent(errorEvent);

            // Show error message
            setStatus({
                message: `${t('errors.segmentRetryFailed', 'Failed to retry segment {{segmentNumber}}', { segmentNumber: segmentIndex + 1 })}: ${error.message}`,
                type: 'error'
            });
            return false;
        } finally {
            // Remove this segment from the retrying list
            setRetryingSegments(prev => prev.filter(idx => idx !== segmentIndex));
        }
    }, [subtitlesData, t]); // eslint-disable-line react-hooks/exhaustive-deps

    // Retry a specific segment using a previously cached cut (from Timeline)
    useEffect(() => {
        const runId = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : Math.random().toString(36).slice(2, 10);
        const handler = async (e) => {
            const detail = e && e.detail;
            if (!detail) return;
            const { start, end, url } = detail;
            if (typeof start !== 'number' || typeof end !== 'number' || !url) return;

            // Track active retry segment for proper cleanup on abort
            currentRetryFromCacheRef.current = { start, end };

            setIsGenerating(true);
            setStatus({ message: t('output.processingVideo', 'Processing video...'), type: 'loading' });

            // Prefer using Files API with the original source file (no local clips)
            let sourceFile;
            let usePrimaryFilesApi;
            try {
                const resolvedSource = await resolveCachedRetrySource(
                    currentSourceFileRef.current,
                    url
                );
                sourceFile = resolvedSource.sourceFile;
                usePrimaryFilesApi = resolvedSource.usesOriginalMedia;
            } catch (fetchErr) {
                console.error('[useSubtitles] Failed to obtain source for retry:', fetchErr);
                setIsGenerating(false);
                setStatus({ message: fetchErr.message || 'Retry failed', type: 'error' });
                window.dispatchEvent(new CustomEvent('retry-segment-from-cache-complete', {
                    detail: { start, end, success: false, error: fetchErr?.message }
                }));
                currentRetryFromCacheRef.current = null;
                return;
            }

            const segment = { start, end };
            const fps = getVideoProcessingFps();
            const mediaResolution = getMediaResolution();
            const model = normalizeMediaModelId(
                localStorage.getItem('gemini_model'),
                DEFAULT_TRANSCRIPTION_MODEL_ID
            );

            const { processGeminiSegment } = await import('../services/engines/GeminiAdapter');
            const { mergeStreamingSubtitlesProgressively } = await import('../utils/subtitle/subtitleMerger');

            // Progressive merge throttling
            let appliedAnyUpdate = false;
            let lastMergeTime = 0;
            let pendingUpdate = null;
            let updateTimer = null;
            const THROTTLE_MS = 500;

            const onStreamingUpdate = (streamingSubtitles, isStreaming) => {
                if (!streamingSubtitles || streamingSubtitles.length === 0) return;
                appliedAnyUpdate = true;

                const applyMerge = (subs) => {
                    setSubtitlesData(current => {
                        const existing = current || [];
                        return mergeStreamingSubtitlesProgressively(existing, subs, segment);
                    });
                };

                const now = Date.now();
                if (now - lastMergeTime >= THROTTLE_MS) {
                    lastMergeTime = now;
                    applyMerge(streamingSubtitles);
                } else {
                    pendingUpdate = streamingSubtitles;
                    if (!updateTimer) {
                        updateTimer = setTimeout(() => {
                            lastMergeTime = Date.now();
                            if (pendingUpdate) applyMerge(pendingUpdate);
                            pendingUpdate = null;
                            updateTimer = null;
                        }, Math.max(0, THROTTLE_MS - (now - lastMergeTime)));
                    }
                }

                if (isStreaming) {
                    setStatus({ message: t('output.streamingProgress', 'Streaming...'), type: 'loading' });
                }
            };

            // For fallback (clipped file), determine if it is large
            const isLargeClip = !usePrimaryFilesApi && sourceFile && sourceFile.size > INLINE_LARGE_SEGMENT_THRESHOLD_BYTES;

            // Track if we already tried falling back to clipped-file path on Files API errors
            let clipFallbackTried = false;

            const attemptStreaming = async (attempt = 0) => {
                try {
                    // Primary path: Files API with offsets when original source is known; otherwise fallback rules
                    const finalSubtitles = await processGeminiSegment(
                        sourceFile,
                        segment,
                        {
                            fps,
                            mediaResolution,
                            model,
                            userProvidedSubtitles: null,
                            // If using original source, enforce Files API with offsets; else decide based on size
                            forceInline: usePrimaryFilesApi ? false : !isLargeClip,
                            noOffsets: usePrimaryFilesApi ? false : isLargeClip,
                            runId
                        },
                        { onStatus: setStatus, onStreamingUpdate, t }
                    );

                    // Ensure final result is applied even if no progressive updates arrived
                    if (!appliedAnyUpdate && Array.isArray(finalSubtitles) && finalSubtitles.length > 0) {
                        const segDuration = (segment.end - segment.start);
                        const maxEndRaw = Math.max(...finalSubtitles.map(s => s.end || 0));
                        const looksRelative = maxEndRaw <= (segDuration + 1);
                        const adjustedFinal = looksRelative
                          ? finalSubtitles.map(s => ({
                              ...s,
                              start: (s.start || 0) + segment.start,
                              end: (s.end || 0) + segment.start
                            }))
                          : finalSubtitles;

                        setSubtitlesData(current => {
                            const existingSubtitles = current || [];
                            const nonOverlappingSubtitles = existingSubtitles.filter(sub => {
                                return sub.end <= segment.start || sub.start >= segment.end;
                            });
                            return [...nonOverlappingSubtitles, ...adjustedFinal].sort((a, b) => a.start - b.start);
                        });
                    }

                    setIsGenerating(false);
                    setStatus({ message: t('output.generationSuccess', 'Subtitles updated successfully!'), type: 'success' });
                    window.dispatchEvent(new CustomEvent(EVENTS.RETRY_SEGMENT_FROM_CACHE_COMPLETE, {
                        detail: { start, end, success: true }
                    }));
                    currentRetryFromCacheRef.current = null;
                } catch (err) {
                    const shouldRetry = (is503Error(err) || is429Error(err)) && attempt < RETRY_DELAYS.length;
                    if (shouldRetry) {
                        const delaySec = RETRY_DELAYS[attempt];
                        setStatus({ message: t('output.retryingInSeconds', 'Retrying in {{n}}s...', { n: delaySec }), type: 'loading' });
                        await new Promise(r => setTimeout(r, 1000 * delaySec));
                        return attemptStreaming(attempt + 1);
                    }

                    // Files API specific fallback: if primary Files API path failed (e.g., quota/size), fallback once to clipped file path
                    if (usePrimaryFilesApi && !clipFallbackTried && !isDesktopRuntime()) {
                        try {
                            const cached = await resolveCachedRetrySource(null, url, {
                                nativeRuntime: () => false,
                            });
                            sourceFile = cached.sourceFile;
                            clipFallbackTried = true;
                            usePrimaryFilesApi = false;
                            setStatus({ message: t('output.fallingBack', 'Falling back to clipped-file path...'), type: 'loading' });
                            return attemptStreaming(attempt);
                        } catch (fallbackErr) {
                            console.warn('[useSubtitles] Fallback fetch failed:', fallbackErr);
                        }
                    }

                    console.error('[useSubtitles] Retry from cache failed:', err);
                    setIsGenerating(false);
                    setStatus({ message: err.message || 'Retry failed', type: 'error' });
                    window.dispatchEvent(new CustomEvent(EVENTS.RETRY_SEGMENT_FROM_CACHE_COMPLETE, {
                        detail: { start, end, success: false, error: err?.message }
                    }));
                    currentRetryFromCacheRef.current = null;
                }
            };

            attemptStreaming();
        };
        const unsubscribe = subscribe(EVENTS.RETRY_SEGMENT_FROM_CACHE, handler);
        return () => unsubscribe();
    }, [t]); // eslint-disable-line react-hooks/exhaustive-deps

    return { retrySegment };
};

export default useSubtitlesSegmentRetry;
