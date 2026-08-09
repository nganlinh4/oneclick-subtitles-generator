import { useState, useCallback, useEffect, useRef } from 'react';
import { callGeminiApi, setProcessingForceStopped } from '../services/geminiService';
import { generateFileCacheId } from '../utils/cacheUtils';
import { getVideoDuration } from '../utils/videoProcessor';
import { EVENTS, publishSaveBeforeUpdate, subscribe } from '../events/bus';
import { processGeminiSegment } from '../services/engines/GeminiAdapter';
import { getGeminiModel } from '../services/configService';

import { saveSubtitlesToCache } from '../services/subtitleCache';
import { reportKnownGeminiSubtitleError } from '../utils/geminiSubtitleErrors';
import {
    resolveCacheIdForGeneration,
    loadCachedSubtitlesIfAvailable
} from './useSubtitlesCaching';
import { useSubtitlesSegmentRetry } from './useSubtitlesSegmentRetry';
import { useQuotaCountdown } from './useQuotaCountdown';
import { useSubtitlesRetryGeneration } from './useSubtitlesRetryGeneration';
import { runAsrGeneration } from './runAsrGeneration';
import { DESCRIPTORS, LOCAL_METHOD_IDS } from '../services/engines/transcriptionEngineRegistry';
import { createSegmentStreamingHandler, createFullMediaStreamingHandler } from './subtitleStreamingHandlers';

// Cache utilities moved to services/subtitleCache

// Local (non-Gemini) transcription methods -> the generic ASR runner, keyed by the registry. EVERY local
// ASR engine (Parakeet + catalog) runs through runAsrGeneration with its descriptor (route + capabilities),
// so adding an engine is one registry row — no scattered method checks.
const METHOD_RUNNERS = Object.fromEntries(
    DESCRIPTORS.filter((d) => d.type === 'asr').map((d) => [d.id, (ctx) => runAsrGeneration({ ...ctx, engine: d })])
);
const LOCAL_METHODS = new Set(LOCAL_METHOD_IDS);

export const useSubtitles = (t) => {
    // Debug logger gated by localStorage.debug_logs
    const debugLog = (...args) => {
        try { if (localStorage.getItem('debug_logs') === 'true') console.log(...args); } catch {}
    };
    const [subtitlesData, setSubtitlesData] = useState(null);
    const [status, setStatus] = useState({ message: '', type: '' });
    const [isGenerating, setIsGenerating] = useState(false);
    const [retryingSegments, setRetryingSegments] = useState([]);
    const currentSourceFileRef = useRef(null);

    const currentRetryFromCacheRef = useRef(null);

    // Countdown updater for quota exceeded with retry seconds
    const startQuotaCountdown = useQuotaCountdown({ t, setStatus, isGenerating });


        // Listen for abort events
    useEffect(() => {
        const handleAbort = () => {
            // If a retry-from-cache is in progress, notify completion for that specific segment
            const active = currentRetryFromCacheRef.current;
            if (active && typeof active.start === 'number' && typeof active.end === 'number') {
                window.dispatchEvent(new CustomEvent(EVENTS.RETRY_SEGMENT_FROM_CACHE_COMPLETE, {
                    detail: { start: active.start, end: active.end, success: false, error: 'aborted' }
                }));
                currentRetryFromCacheRef.current = null;
            }

            // Reset generating state
            setIsGenerating(false);
            // Reset retrying segments
            setRetryingSegments([]);
            // Update status
            setStatus({ message: t('output.requestsAborted', 'All Gemini requests have been aborted'), type: 'info' });
        };

        // Subscribe via EventBus helper
        const unsubscribe = subscribe(EVENTS.GEMINI_REQUESTS_ABORTED, () => handleAbort());
        return () => unsubscribe();
    }, [t]);

    // Function to update segment status and dispatch event
    const updateSegmentsStatus = useCallback((segments) => {
        // Dispatch custom event with segment status (centralized constant)
        const event = new CustomEvent(EVENTS.SEGMENT_STATUS_UPDATE, { detail: segments });
        window.dispatchEvent(event);
    }, []);

    // checkCachedSubtitles and saveSubtitlesToCache imported from services/subtitleCache

    const generateSubtitles = useCallback(async (input, inputType, apiKeysSet, options = {}) => {
    // Extract options
    const runId = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : Math.random().toString(36).slice(2, 10);

        const { userProvidedSubtitles, segment, fps, mediaResolution, model } = options; // inlineExtraction supported via options.inlineExtraction
        if (!LOCAL_METHODS.has(options.method) && !apiKeysSet.gemini) {
            setStatus({ message: t('errors.apiKeyRequired'), type: 'error' });
            return false;
        }

        // Reset the force stop flag when starting a new generation
        setProcessingForceStopped(false);

        setIsGenerating(true);
        setStatus({ message: t('output.processingVideo'), type: 'loading' });

        // Local ASR engines (Parakeet + the catalog engines) run via their registered runner.
        const localRunner = METHOD_RUNNERS[options.method];
        if (localRunner) {
            return await localRunner({
                input,
                options,
                runId,
                debugLog,
                setStatus,
                setIsGenerating,
                setSubtitlesData,
                t
            });
        }

        try {
            // Check if this is a URL-based input (either direct URL or downloaded video)
            const currentVideoUrl = localStorage.getItem('current_video_url');
            const currentFileCacheId = localStorage.getItem('current_file_cache_id');

            debugLog('[Subtitle Generation] Cache ID generation debug:', {
                inputType,
                currentVideoUrl,
                currentFileCacheId,
                inputIsFile: input instanceof File,
                inputName: input instanceof File ? input.name : 'not a file'
            });

            // URL-based vs file-based cache key resolution (see useSubtitlesCaching)
            const cacheId = await resolveCacheIdForGeneration({
                input,
                inputType,
                currentVideoUrl,
                t,
                setStatus,
                debugLog
            });

            // IMPORTANT: Check cache FIRST and load cached subtitles immediately
            // This ensures the timeline shows cached subtitles right when output container appears
            debugLog('[Subtitle Generation] Cache check debug:', {
                cacheId,
                segment: !!segment,
                willCheckCache: !!(cacheId && !segment)
            });

            const { cacheHit } = await loadCachedSubtitlesIfAvailable({
                cacheId,
                segment,
                currentVideoUrl,
                t,
                setSubtitlesData,
                setStatus,
                debugLog
            });
            if (cacheHit) {
                setIsGenerating(false);
                return true;
            }

            // Generate new subtitles
            let subtitles;

            // Check if this is segment processing
            if (segment) {
                debugLog('[Subtitle Generation] Processing specific segment with streaming:', segment);

                // Inline extraction path now streams identically to Files API.
                // Fall through to the streaming branch below with forceInline flag.
                if (options.inlineExtraction === true) {
                    debugLog('[Subtitle Generation] INLINE extraction enabled — using streaming (no offsets)');
                    // No-op here; the streaming branch below will handle save and processing.
                }


                // CRITICAL: Ensure cache ID is properly set BEFORE triggering save
                if (inputType === 'file-upload') {
                    // Check if this is a downloaded video (has current_video_url) or a true file upload
                    const currentVideoUrl = localStorage.getItem('current_video_url');

                    if (currentVideoUrl) {
                        // This is a downloaded video - use URL-based cache ID for subtitle caching
                        debugLog('[Subtitle Generation] Downloaded video detected, using URL-based cache ID for subtitles');
                        // The URL-based cache ID is already set in the main cache ID generation above
                    } else {
                        // This is a true file upload - use file-based cache ID
                        let cacheId = localStorage.getItem('current_file_cache_id');
                        if (!cacheId) {
                            // Generate and store cache ID if not already set
                            cacheId = await generateFileCacheId(input);
                            localStorage.setItem('current_file_cache_id', cacheId);
                            debugLog('[Subtitle Generation] Generated file cache ID for uploaded file:', cacheId);
                        } else {
                            debugLog('[Subtitle Generation] Using existing file cache ID for uploaded file:', cacheId);
                        }
                    }
                }

                // FIRST: Trigger save to preserve any manual edits before processing starts
                // Use a Promise to wait for the save to actually complete
                await new Promise((resolve) => {
                    const handleSaveComplete = (event) => {
                        if (event.detail?.source === 'segment-processing-start') {
                            window.removeEventListener(EVENTS.SAVE_COMPLETE, handleSaveComplete);
                            resolve();
                        }
                    };

                    window.addEventListener(EVENTS.SAVE_COMPLETE, handleSaveComplete);

                    // Trigger the save
                    publishSaveBeforeUpdate({ source: 'segment-processing-start', segment });

                    // Fallback timeout in case save doesn't complete
                    setTimeout(() => {
                        window.removeEventListener(EVENTS.SAVE_COMPLETE, handleSaveComplete);
                        resolve();
                    }, 2000);
                });

                // Process the specific segment with streaming via Gemini adapter

                // IMPORTANT: Use the current React state directly instead of loading from cache
                // The save operation above should have already persisted any manual edits
                // Loading from cache can introduce stale data if the save hasn't fully propagated
                let currentSubtitles = [];

                // Get the current subtitles from React state
                // This ensures we're using the most up-to-date data that's currently displayed
                await new Promise((resolve) => {
                    setSubtitlesData(current => {
                        currentSubtitles = current || [];
                        debugLog('[Subtitle Generation] Using current React state for merging:', currentSubtitles.length, 'subtitles');
                        resolve();
                        return current; // Don't modify the state
                    });
                });

                // Log the subtitles we're about to merge with
                debugLog('[Subtitle Generation] Current subtitles sample:',
                    currentSubtitles.slice(0, 3).map(s => `${s.start}-${s.end}: ${s.text.substring(0, 20)}...`)
                );

                debugLog('[Subtitle Generation] Before streaming (using saved state):', {
                    existingCount: currentSubtitles.length,
                    segmentRange: `${segment.start}s - ${segment.end}s`,
                    existingSubtitles: currentSubtitles.map(s => `${s.start}-${s.end}: ${s.text.substring(0, 20)}...`)
                });
                // Remember the current source file for future retries (Files API offsets)
                currentSourceFileRef.current = input;


                const segmentSubtitles = await processGeminiSegment(
                    input,
                    segment,
                    {
                        fps,
                        mediaResolution,
                        model,
                        userProvidedSubtitles,
                        maxDurationPerRequest: options.maxDurationPerRequest,
                        segmentProcessingDelay: options.segmentProcessingDelay,
                        autoSplitSubtitles: options.autoSplitSubtitles,
                        maxWordsPerSubtitle: options.maxWordsPerSubtitle,
                        forceInline: options.inlineExtraction === true,
                        runId,
                        t
                    },
                    {
                        onStatus: setStatus,
                        onStreamingUpdate: createSegmentStreamingHandler(segment, setSubtitlesData),
                        t
                    }
                );

                debugLog('[Subtitle Generation] Streaming complete:', {
                    newSegmentCount: segmentSubtitles.length,
                    segmentRange: `${segment.start}s - ${segment.end}s`
                });

                // CRITICAL FIX: For single segment processing, we need to MERGE with existing subtitles
                // NOT replace the entire timeline
                if (segmentSubtitles && segmentSubtitles.length > 0) {
                    // Get current subtitles from React state (not the stale closure variable)
                    // Use a callback to get the most up-to-date state value
                    await new Promise((resolve) => {
                        setSubtitlesData(current => {
                            const currentSubtitles = current || [];

                            debugLog('[DEBUG] Before merge - current subtitles:', {
                                count: currentSubtitles.length,
                                beforeSegment: currentSubtitles.filter(s => s.end <= segment.start).length,
                                inSegment: currentSubtitles.filter(s => s.start < segment.end && s.end > segment.start).length,
                                afterSegment: currentSubtitles.filter(s => s.start >= segment.end).length,
                                segment: `${segment.start}s-${segment.end}s`
                            });

                            // Filter out existing subtitles that overlap with this segment
                            const nonOverlappingSubtitles = currentSubtitles.filter(sub => {
                                // Keep subtitles that are completely outside the segment boundaries
                                return sub.end <= segment.start || sub.start >= segment.end;
                            });

                            // Merge: existing non-overlapping + new segment subtitles
                            const mergedSubtitles = [...nonOverlappingSubtitles, ...segmentSubtitles]
                                .sort((a, b) => a.start - b.start);

                            debugLog('[Subtitle Generation] Merging single segment result:', {
                                existingCount: currentSubtitles.length,
                                nonOverlappingCount: nonOverlappingSubtitles.length,
                                segmentCount: segmentSubtitles.length,
                                finalCount: mergedSubtitles.length,
                                segmentRange: `${segment.start}s-${segment.end}s`,
                                removedCount: currentSubtitles.length - nonOverlappingSubtitles.length
                            });

                            // Store for use outside the callback
                            subtitles = mergedSubtitles;
                            resolve();

                            // Return the merged result to update state
                            return mergedSubtitles;
                        });
                    });
                } else {
                    // No new subtitles from segment - get current state
                    await new Promise((resolve) => {
                        setSubtitlesData(current => {
                            subtitles = current;
                            resolve();
                            return current; // Don't modify state
                        });
                    });
                }

                debugLog('[Subtitle Generation] Using final streaming result:', {
                    totalCount: subtitles?.length || 0,
                    finalSubtitles: subtitles?.map(s => `${s.start}-${s.end}: ${s.text.substring(0, 20)}...`) || []
                });
            }
            // Check if this is a long media file (video or audio) that needs special processing
            else if (input.type && (input.type.startsWith('video/') || input.type.startsWith('audio/'))) {
                try {
                    const duration = await getVideoDuration(input);
                    // eslint-disable-next-line no-unused-vars
                    const durationMinutes = Math.floor(duration / 60);

                    // Determine if this is a video or audio file
                    const isAudio = input.type.startsWith('audio/');
                    // eslint-disable-next-line no-unused-vars
                    const mediaType = isAudio ? 'audio' : 'video';

                    // Debug log to see the media duration


                    // Check if we have segment-based processing options
                    if (segment && fps && mediaResolution && model) {
                        // Use segment-based processing (Files API by default)
                        const { processGeminiSegment } = await import('../services/engines/GeminiAdapter');
                        // Remember source file for retries
                        currentSourceFileRef.current = input;
                        subtitles = await processGeminiSegment(
                            input,
                            segment,
                            {
                                fps,
                                mediaResolution,
                                model,
                                userProvidedSubtitles,
                                maxDurationPerRequest: options.maxDurationPerRequest,
                                autoSplitSubtitles: options.autoSplitSubtitles,
                                maxWordsPerSubtitle: options.maxWordsPerSubtitle
                            },
                            { onStatus: setStatus, t }
                        );
                    } else {
                        // Stream full video/audio unconditionally (feature parity with segment streaming)
                        const fullSegment = { start: 0, end: duration };
                        const { processGeminiSegment } = await import('../services/engines/GeminiAdapter');
                        // Remember source file for retries
                        currentSourceFileRef.current = input;
                        subtitles = await processGeminiSegment(
                            input,
                            fullSegment,
                            {
                                fps,
                                mediaResolution,
                                model,
                                userProvidedSubtitles,
                                maxDurationPerRequest: options.maxDurationPerRequest,
                                autoSplitSubtitles: options.autoSplitSubtitles,
                                maxWordsPerSubtitle: options.maxWordsPerSubtitle,
                                forceInline: options.inlineExtraction === true,
                                runId
                            },
                            {
                                onStatus: setStatus,
                                onStreamingUpdate: createFullMediaStreamingHandler(setSubtitlesData, setStatus),
                                t
                            }
                        );
                    }
                } catch (error) {
                    console.error('Error checking media duration:', error);
                    // Fallback to normal processing (respect inlineExtraction for non-YouTube)
                    const forceInline = options.inlineExtraction === true && inputType !== 'youtube';
                    subtitles = await callGeminiApi(input, inputType, { userProvidedSubtitles, ...(forceInline ? { forceInline: true } : {}), runId });
                }
            } else {
                // YouTube flow: video is already downloaded and loaded in the app
                if (options.inlineExtraction === true) {
                    // Try to obtain the already-loaded blob without re-downloading
                    const blobUrl = localStorage.getItem('current_video_url');
                    let ytFile = null;
                    try {
                        if (blobUrl && blobUrl.startsWith('blob:')) {
                            if (typeof window !== 'undefined' && window.__videoBlobMap && window.__videoBlobMap[blobUrl]) {
                                const blob = window.__videoBlobMap[blobUrl];
                                ytFile = new File([blob], 'youtube.mp4', { type: blob.type || 'video/mp4' });
                            } else {
                                // Fetching a blob: URL stays in-memory, not a network download
                                const blob = await fetch(blobUrl).then(r => r.blob());
                                ytFile = new File([blob], 'youtube.mp4', { type: blob.type || 'video/mp4' });
                            }
                        }
                        // Remember source file for retries
                        currentSourceFileRef.current = ytFile;

                    } catch (e) {
                        console.warn('Inline YouTube: failed to access current blob URL, falling back:', e);
                    }

                    if (ytFile) {
                        // Stream full video unconditionally
                        const { getVideoDuration } = await import('../utils/videoProcessing');
                        const { processGeminiSegment } = await import('../services/engines/GeminiAdapter');
                        const duration = await getVideoDuration(ytFile);
                        const fullSegment = { start: 0, end: duration || 0 };
                        subtitles = await processGeminiSegment(
                            ytFile,
                            fullSegment,
                            {
                                fps,
                                mediaResolution,
                                model,
                                userProvidedSubtitles,
                                maxDurationPerRequest: options.maxDurationPerRequest,
                                autoSplitSubtitles: options.autoSplitSubtitles,
                                maxWordsPerSubtitle: options.maxWordsPerSubtitle,
                                forceInline: true,
                                runId
                            },
                            {
                                onStatus: setStatus,
                                onStreamingUpdate: (streamingSubtitles) => setSubtitlesData(streamingSubtitles),
                                t
                            }
                        );
                    } else {
                        // Fallback: proceed without forcing inline (no re-download)
                        subtitles = await callGeminiApi(input, inputType, { userProvidedSubtitles, runId });
                    }
                } else {
                    // Default YouTube path
                    subtitles = await callGeminiApi(input, inputType, { userProvidedSubtitles, runId });
                }
            }

            // For segment processing, the final result is already set during streaming
            // For non-segment processing, trigger save before updating with new results
            if (segment) {
                // For segment processing, the final result is already set via progressive merging
                // No need to call setSubtitlesData again since subtitles = subtitlesData (current state)

                // Auto-save after streaming completion to preserve the new results
                const { autoSaveAfterStreaming } = await import('../services/lifecycleOrchestrator');
                autoSaveAfterStreaming({ subtitles, segment, delayMs: 500 });
            } else {
                // For non-segment processing, trigger save before updating with new results
                if (subtitles && subtitles.length > 0) {
                    // First, checkpoint save of current state to preserve any manual edits
                    const { checkpointBeforeUpdate } = await import('../services/lifecycleOrchestrator');
                    await checkpointBeforeUpdate({ source: 'video-processing-complete' });
                    setSubtitlesData(subtitles);
                } else {
                    // If no subtitles, just update normally
                    setSubtitlesData(subtitles);
                }
            }

            // Cache the results - but don't cache segment results with the full file cache ID
            if (cacheId && subtitles && subtitles.length > 0 && !segment) {
                await saveSubtitlesToCache(cacheId, subtitles);
            } else if (segment) {
                debugLog('[Subtitle Generation] Skipping cache save for segment processing - not overwriting full file cache');
            }

            // Check if using a strong model (Gemini 2.5 Pro or Gemini 2.0 Flash Thinking)
            const currentModel = getGeminiModel();
            const strongModels = ['gemini-2.5-pro', 'gemini-2.0-flash-thinking-exp-01-21'];
            const isUsingStrongModel = strongModels.includes(currentModel);

            // Show different success message based on model
            if (isUsingStrongModel && (!subtitles || subtitles.length === 0)) {
                setStatus({ message: t('output.strongModelSuccess'), type: 'warning' });
            } else {
                setStatus({ message: t('output.generationSuccess'), type: 'success' });
            }
            return true;
        } catch (error) {
            console.error('Error generating subtitles:', error);
            try {
                if (!reportKnownGeminiSubtitleError(error, { t, setStatus, startQuotaCountdown })) {
                    // Not a recognised error type - parse a structured error payload from Gemini.
                    const errorData = JSON.parse(error.message);
                    if (errorData.type === 'unrecognized_format') {
                        setStatus({
                            message: `${errorData.message}\n\nRaw text from Gemini:\n${errorData.rawText}`,
                            type: 'error'
                        });
                    } else {
                        setStatus({ message: `Error: ${error.message}`, type: 'error' });
                    }
                }
            } catch {
                // The structured-error JSON.parse above threw (non-JSON message); fall back to a
                // recognised-error check then a generic message.
                if (!reportKnownGeminiSubtitleError(error, { t, setStatus, startQuotaCountdown })) {
                    setStatus({ message: `Error: ${error.message}`, type: 'error' });
                }
            }
            return false;
        } finally {
            setIsGenerating(false);
        }
    }, [t]);

    const { retryGeneration } = useSubtitlesRetryGeneration({
        t,
        setStatus,
        setIsGenerating,
        setSubtitlesData,
        currentSourceFileRef
    });

    // State to track which segments are currently being retried is defined at the top of the hook

    // Segment retry: the (deprecated) per-segment callback + the
    // RETRY_SEGMENT_FROM_CACHE listener (Files-API offsets vs clipped fallback,
    // progressive merge, 503/429 retry policy). Shared state/refs are threaded in.
    const { retrySegment } = useSubtitlesSegmentRetry({
        t,
        debugLog,
        subtitlesData,
        setSubtitlesData,
        setStatus,
        setIsGenerating,
        setRetryingSegments,
        currentSourceFileRef,
        currentRetryFromCacheRef
    });

    return {
        subtitlesData,
        setSubtitlesData,
        status,
        setStatus,
        isGenerating,
        generateSubtitles,
        retryGeneration,
        updateSegmentsStatus,
        retrySegment,
        retryingSegments
    };
};

export default useSubtitles;