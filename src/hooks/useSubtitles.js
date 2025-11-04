import { useState, useCallback, useEffect, useRef } from 'react';
import { callGeminiApi, setProcessingForceStopped } from '../services/geminiService';
import { preloadYouTubeVideo } from '../utils/videoPreloader';
import { generateFileCacheId } from '../utils/cacheUtils';
import { getVideoDuration, processMediaFile } from '../utils/videoProcessor';
import { extractSegmentAsWavBase64 } from '../utils/audioUtils';
import { mergeSegmentSubtitles } from '../utils/subtitle/subtitleMerger';
import { API_BASE_URL } from '../config';
import { EVENTS, publishProcessingRanges, publishSaveBeforeUpdate, publishStreamingUpdate, publishStreamingComplete, publishSaveAfterStreaming, subscribe } from '../events/bus';
import { processParakeetSegment } from '../services/engines/ParakeetAdapter';
import { processGeminiSegment } from '../services/engines/GeminiAdapter';
import { getGeminiModel, getVideoProcessingFps, getMediaResolution } from '../services/configService';

import { setCurrentCacheId as setRulesCacheId } from '../utils/transcriptionRulesStore';
import { setCurrentCacheId as setSubtitlesCacheId } from '../utils/userSubtitlesStore';
import { generateUrlBasedCacheId, getCachedSubtitles as checkCachedSubtitles, saveSubtitlesToCache } from '../services/subtitleCache';

// Cache utilities moved to services/subtitleCache

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
    const quotaCountdownRef = useRef(null);

    const clearQuotaCountdown = useCallback(() => {
        if (quotaCountdownRef.current) {
            clearInterval(quotaCountdownRef.current);
            quotaCountdownRef.current = null;
        }
    }, []);

    const startQuotaCountdown = useCallback((initialSeconds, isFreeTier) => {
        clearQuotaCountdown();
        let remaining = Math.max(0, Number(initialSeconds) || 0);

        const tick = () => {
            const msg = isFreeTier
                ? t('errors.geminiQuotaExceededWithRetry', 'Gemini free-tier quota exceeded. Please wait about {{seconds}}s and try again, or use a different API key/add billing.', { seconds: remaining })
                : t('errors.geminiQuotaExceededWithRetry', 'Gemini quota exceeded. Please wait about {{seconds}}s and try again, or use a different API key/add billing.', { seconds: remaining });
            setStatus({ message: msg, type: 'error' });

            if (remaining <= 0) {
                clearQuotaCountdown();
                return;
            }
            remaining -= 1;
        };

        // Immediate render, then interval updates
        tick();
        quotaCountdownRef.current = setInterval(tick, 1000);
    }, [clearQuotaCountdown, t]);

    // Clear countdown when we start generating again or on unmount
    useEffect(() => {
        if (isGenerating) {
            clearQuotaCountdown();
        }
        return () => clearQuotaCountdown();
    }, [isGenerating, clearQuotaCountdown]);


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
        if (options.method !== 'nvidia-parakeet' && !apiKeysSet.gemini) {
            setStatus({ message: t('errors.apiKeyRequired'), type: 'error' });
            return false;
        }

        // Reset the force stop flag when starting a new generation
        setProcessingForceStopped(false);

        setIsGenerating(true);
        setStatus({ message: t('output.processingVideo'), type: 'loading' });

        // Handle Parakeet processing
        if (options.method === 'nvidia-parakeet') {
            const seg = options.segment;
            if (!seg || typeof seg.start !== 'number' || typeof seg.end !== 'number') {
                setStatus({ message: 'Invalid segment selection', type: 'error' });
                setIsGenerating(false);
                return false;
            }

            // Before processing, checkpoint current edits to align with Gemini segment flow
            debugLog(`[Run ${runId}] Parakeet: checkpoint before segment processing`, { seg });
            {
                const { checkpointBeforeUpdate } = await import('../services/lifecycleOrchestrator');
                await checkpointBeforeUpdate({ source: 'segment-processing-start', segment: seg }, 2000);
            }

            // Delegate to Parakeet adapter (chunking + API); merge through callback
            await processParakeetSegment(
                input,
                seg,
                {
                    maxDurationPerRequest: options.maxDurationPerRequest,
                    parakeetStrategy: options.parakeetStrategy,
                    parakeetMaxChars: options.parakeetMaxChars,
                    parakeetMaxWords: options.parakeetMaxWords
                },
                {
                    onStatus: setStatus,
                    onRanges: (ranges) => publishProcessingRanges({ ranges }),
                    onStreamingUpdate: (subs, part) => publishStreamingUpdate({ subtitles: subs, segment: part, runId }),
                    onMergeSegment: async (part, newSegmentSubs) => {
                        await new Promise((resolve) => {
                            setSubtitlesData(current => {
                                const existing = current || [];
                                const merged = mergeSegmentSubtitles(existing, newSegmentSubs, part);
                                resolve();
                                return merged;
                            });
                        });
                    }
                }
            );

            // Read final subtitles from state
            let finalSubs = [];
            await new Promise((resolve) => {
                setSubtitlesData(current => {
                    finalSubs = current || [];
                    resolve();
                    return current; // no-op
                });
            });

            // Filter final subtitles to the processed segment range for event payload
            const filteredForSeg = (finalSubs || []).filter(s => (s.start < seg.end && s.end > seg.start)).map(s => ({
                ...s,
                start: Math.max(s.start, seg.start),
                end: Math.min(s.end, seg.end)
            }));

            // Dispatch streaming-complete to signal UI that processing has concluded
            try {
                publishStreamingComplete({ subtitles: filteredForSeg, segment: seg, runId });
            } catch {}

            // Trigger auto-save after streaming completion (same as Gemini path)
            try {
                const { autoSaveAfterStreaming } = await import('../services/lifecycleOrchestrator');
                debugLog(`[Run ${runId}] Parakeet: streaming complete, triggering auto-save`);
                autoSaveAfterStreaming({ subtitles: finalSubs, segment: seg, delayMs: 500 });
            } catch {}

            setStatus({ message: 'Parakeet transcription complete', type: 'success' });
            setIsGenerating(false);
            return true;
        }

        try {
            let cacheId = null;

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

            if (inputType === 'youtube' || currentVideoUrl) {
                // Use unified URL-based caching for all video URLs
                const urlToUse = inputType === 'youtube' ? input : currentVideoUrl;
                cacheId = await generateUrlBasedCacheId(urlToUse);

                // Preload YouTube videos
                if (urlToUse && (urlToUse.includes('youtube.com') || urlToUse.includes('youtu.be'))) {
                    preloadYouTubeVideo(urlToUse);
                }

                // Set cache ID for both stores
                setRulesCacheId(cacheId);
                setSubtitlesCacheId(cacheId);

            } else if (inputType === 'file-upload') {
                // For actual file uploads (not downloaded videos), use file-based cache ID
                cacheId = await generateFileCacheId(input);

                // Store the cache ID in localStorage for later use (e.g., saving edited subtitles)
                localStorage.setItem('current_file_cache_id', cacheId);

                // Set cache ID for both stores
                setRulesCacheId(cacheId);
                setSubtitlesCacheId(cacheId);


                // Check if this is a video file and get its duration
                if (input.type.startsWith('video/')) {
                    try {
                        const duration = await getVideoDuration(input);
                        // eslint-disable-next-line no-unused-vars
                        const durationMinutes = Math.floor(duration / 60);

                        // If video is longer than 30 minutes, show warning and use special processing
                        if (durationMinutes > 30) {
                            setStatus({
                                message: t('output.longVideoWarning', 'You are uploading a {{duration}} minute video. Uploading progress can be long depends on network speed.', { duration: durationMinutes }),
                                type: 'loading'
                            });
                        }
                    } catch (error) {
                        console.warn('Error getting video duration:', error);
                    }
                }
            }

            // IMPORTANT: Check cache FIRST and load cached subtitles immediately
            // This ensures the timeline shows cached subtitles right when output container appears
            debugLog('[Subtitle Generation] Cache check debug:', {
                cacheId,
                segment: !!segment,
                willCheckCache: !!(cacheId && !segment)
            });

            if (cacheId && !segment) {
                debugLog('[Subtitle Generation] Checking for cached subtitles with cache ID:', cacheId);
                const cachedSubtitles = await checkCachedSubtitles(cacheId, currentVideoUrl);
                debugLog('[Subtitle Generation] Cache check result:', {
                    found: !!cachedSubtitles,
                    count: cachedSubtitles ? cachedSubtitles.length : 0
                });

                if (cachedSubtitles) {
                    debugLog('[Subtitle Generation] Loading cached subtitles immediately for timeline display');
                    setSubtitlesData(cachedSubtitles);
                    setStatus({
                        message: t('output.subtitlesLoadedFromCache', 'Subtitles loaded from cache!'),
                        type: 'success',
                        translationKey: 'output.subtitlesLoadedFromCache'
                    });
                    setIsGenerating(false);
                    return true;
                }
                // If no cached subtitles found, clear the timeline for fresh generation
                debugLog('[Subtitle Generation] No cached subtitles found, clearing timeline for fresh generation');
                setSubtitlesData(null);
            } else if (segment) {
                debugLog('[Subtitle Generation] Skipping cache check for segment processing - generating fresh subtitles');
                // For segment processing, keep existing subtitles (don't clear)
            } else {
                // No cache ID available, clear timeline for fresh generation
                debugLog('[Subtitle Generation] No cache ID available, clearing timeline for fresh generation');
                setSubtitlesData(null);
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
                        autoSplitSubtitles: options.autoSplitSubtitles,
                        maxWordsPerSubtitle: options.maxWordsPerSubtitle,
                        forceInline: options.inlineExtraction === true,
                        runId
                    },
                    {
                        onStatus: setStatus,
                        onStreamingUpdate: (() => {
                        // Create a throttled version of the streaming update handler
                        let lastMergeTime = 0;
                        let pendingUpdate = null;
                        let updateTimer = null;
                        const MERGE_THROTTLE_MS = 500; // Throttle merges to once every 500ms
                        const CAPTURE_THROTTLE_MS = 2000; // Capture undo state less frequently
                        let lastCaptureTime = 0;

                        return (streamingSubtitles, isStreaming, chunkInfo) => {
                            // Real-time subtitle updates during streaming
                            if (streamingSubtitles && streamingSubtitles.length > 0) {
                                // console.log(`[Subtitle Generation] Streaming update: ${streamingSubtitles.length} subtitles`);

                                const now = Date.now();
                                const timeSinceMerge = now - lastMergeTime;
                                const timeSinceCapture = now - lastCaptureTime;

                                // Store the pending update
                                pendingUpdate = { streamingSubtitles, isStreaming, chunkInfo };

                                // Clear any existing timer
                                if (updateTimer) {
                                    clearTimeout(updateTimer);
                                }

                                // Throttle the merge operations
                                if (timeSinceMerge >= MERGE_THROTTLE_MS) {
                                    // Enough time has passed, perform the merge immediately
                                    lastMergeTime = now;

                                    // Only capture state for undo/redo occasionally, not on every merge
                                    if (timeSinceCapture >= CAPTURE_THROTTLE_MS) {
                                        lastCaptureTime = now;
                                        window.dispatchEvent(new CustomEvent(EVENTS.CAPTURE_BEFORE_MERGE, {
                                            detail: {
                                                type: 'progressive-merge',
                                                source: 'streaming-update',
                                                segment: segment
                                            }
                                        }));
                                    }

                                    // CRITICAL FIX: Merge streaming subtitles with existing timeline
                                    // Get current subtitles and filter out those in the segment range
                                    setSubtitlesData(current => {
                                        const existingSubtitles = current || [];

                                        // Filter out existing subtitles that overlap with this segment
                                        const nonOverlappingSubtitles = existingSubtitles.filter(sub => {
                                            // Keep subtitles that are completely outside the segment boundaries
                                            return sub.end <= segment.start || sub.start >= segment.end;
                                        });

                                        // Merge: existing non-overlapping + new streaming subtitles
                                        const mergedStreamingSubtitles = [...nonOverlappingSubtitles, ...streamingSubtitles]
                                            .sort((a, b) => a.start - b.start);

                                        return mergedStreamingSubtitles;
                                    });

                                    // Update status to show streaming progress
                                    if (isStreaming) {
                                        setStatus({
                                            message: `Streaming... ${streamingSubtitles.length} subtitles generated for segment`,
                                            type: 'loading'
                                        });
                                    }
                                } else {
                                    // Schedule the update for later
                                    const delay = MERGE_THROTTLE_MS - timeSinceMerge;
                                    updateTimer = setTimeout(() => {
                                        if (pendingUpdate) {
                                            const { streamingSubtitles: pending, isStreaming: pendingStreaming } = pendingUpdate;
                                            lastMergeTime = Date.now();

                                            // Check if we should capture state
                                            if (Date.now() - lastCaptureTime >= CAPTURE_THROTTLE_MS) {
                                                lastCaptureTime = Date.now();
                                                window.dispatchEvent(new CustomEvent(EVENTS.CAPTURE_BEFORE_MERGE, {
                                                    detail: {
                                                        type: 'progressive-merge',
                                                        source: 'streaming-update',
                                                        segment: segment
                                                    }
                                                }));
                                            }

                                            // CRITICAL FIX: Merge streaming subtitles with existing timeline
                                            setSubtitlesData(current => {
                                                const existingSubtitles = current || [];

                                                // Filter out existing subtitles that overlap with this segment
                                                const nonOverlappingSubtitles = existingSubtitles.filter(sub => {
                                                    // Keep subtitles that are completely outside the segment boundaries
                                                    return sub.end <= segment.start || sub.start >= segment.end;
                                                });

                                                // Merge: existing non-overlapping + new streaming subtitles
                                                const mergedStreamingSubtitles = [...nonOverlappingSubtitles, ...pending]
                                                    .sort((a, b) => a.start - b.start);

                                                return mergedStreamingSubtitles;
                                            });

                                            // Update status to show streaming progress
                                            if (pendingStreaming) {
                                                setStatus({
                                                    message: `Streaming... ${pending.length} subtitles generated for segment`,
                                                    type: 'loading'
                                                });
                                            }

                                            pendingUpdate = null;
                                        }
                                    }, delay);
                                }
                            }
                        };
                    })(),
                        t
                    }
                );

                console.log('[Subtitle Generation] Streaming complete:', {
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

                            console.log('[DEBUG] Before merge - current subtitles:', {
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

                            console.log('[Subtitle Generation] Merging single segment result:', {
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

                console.log('[Subtitle Generation] Using final streaming result:', {
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
                                onStreamingUpdate: (() => {
                                    // Throttled updates: replace entire subtitle list progressively
                                    let lastUpdate = 0;
                                    let timer = null;
                                    const THROTTLE_MS = 400;
                                    return (streamingSubtitles, isStreaming) => {
                                        if (!streamingSubtitles) return;
                                        const now = Date.now();
                                        const doUpdate = () => {
                                            lastUpdate = Date.now();
                                            setSubtitlesData(streamingSubtitles);
                                            if (isStreaming) {
                                                setStatus({ message: `Streaming... ${streamingSubtitles.length} subtitles`, type: 'loading' });
                                            }
                                        };
                                        if (now - lastUpdate >= THROTTLE_MS) {
                                            doUpdate();
                                        } else {
                                            clearTimeout(timer);
                                            timer = setTimeout(doUpdate, THROTTLE_MS - (now - lastUpdate));
                                        }
                                    };
                                })(),
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
                console.log('[Subtitle Generation] Skipping cache save for segment processing - not overwriting full file cache');
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
                // Specific handling for Gemini quota/rate limit (429 RESOURCE_EXHAUSTED)
                if (error?.message && (
                    error.message.includes('429') ||
                    /RESOURCE_EXHAUSTED/i.test(error.message) ||
                    /quota/i.test(error.message)
                )) {
                    const retryMatch = error.message.match(/Please retry in\s*([\d\.]+)s/i);
                    const seconds = retryMatch ? Math.ceil(parseFloat(retryMatch[1])) : null;
                    const isFreeTier = /free_tier/i.test(error.message) || /generate_content_free_tier_requests/i.test(error.message);
                    if (seconds !== null) {
                        startQuotaCountdown(seconds, isFreeTier);
                    } else {
                        const msg = isFreeTier
                            ? t('errors.geminiQuotaExceeded', 'Gemini free-tier quota exceeded. Please try again later or use a different API key/add billing.')
                            : t('errors.geminiQuotaExceeded', 'Gemini quota exceeded. Please try again later or use a different API key/add billing.');
                        setStatus({ message: msg, type: 'error' });
                    }
                }
                // Check for specific Gemini API overload/503 errors
                else if (error.message && (
                    (error.message.includes('503') && error.message.includes('Service Unavailable')) ||
                    error.message.includes('The model is overloaded')
                )) {
                    const is503Error = error.message.includes('503');
                    const errorMessage = is503Error
                        ? t('errors.geminiServiceUnavailable', 'Gemini is currently overloaded, please wait and try again later (error code 503)')
                        : t('errors.geminiOverloaded', 'Strong model tends to get overloaded, please consider using other model and try again, or try lower the segment duration. Or create a new Google Cloud Project and get an API Key.');
                    setStatus({ message: errorMessage, type: 'error' });
                } else if (error.message && error.message.toLowerCase().includes('token') && error.message.toLowerCase().includes('exceeds the maximum')) {
                    const tokenMatch = error.message.match(/input token count\s*\((\d+)\)\s*exceeds the maximum number of tokens allowed\s*\((\d+)\)/i);
                    if (tokenMatch) {
                        const required = tokenMatch[1];
                        const limit = tokenMatch[2];
                        setStatus({ message: t('errors.tokenLimitExceededCounts', 'The video segment is too large for Gemini to process (required {{required}} tokens, limit {{limit}} tokens). Please reduce FPS/quality or shorten each request and try again.', { required, limit }), type: 'error' });
                    } else {
                        setStatus({ message: t('errors.tokenLimitExceeded'), type: 'error' });
                    }
                } else if (error.message && error.message.includes('File size') && error.message.includes('exceeds the recommended maximum')) {
                    const sizeMatch = error.message.match(/(\d+)MB\) exceeds the recommended maximum of (\d+)MB/);
                    if (sizeMatch && sizeMatch.length >= 3) {
                        const size = sizeMatch[1];
                        const maxSize = sizeMatch[2];
                        setStatus({
                            message: t('errors.fileSizeTooLarge', 'File size ({{size}}MB) exceeds the recommended maximum of {{maxSize}}MB. Please use a smaller file or lower quality video.', { size, maxSize }),
                            type: 'error'
                        });
                    } else {
                        setStatus({ message: error.message, type: 'error' });
                    }
                } else {
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
                // Fallback handling
                if (error?.message && (
                    error.message.includes('429') ||
                    /RESOURCE_EXHAUSTED/i.test(error.message) ||
                    /quota/i.test(error.message)
                )) {
                    const retryMatch = error.message.match(/Please retry in\s*([\d\.]+)s/i);
                    const seconds = retryMatch ? Math.ceil(parseFloat(retryMatch[1])) : null;
                    const isFreeTier = /free_tier/i.test(error.message) || /generate_content_free_tier_requests/i.test(error.message);
                    if (seconds !== null) {
                        startQuotaCountdown(seconds, isFreeTier);
                    } else {
                        const msg = isFreeTier
                            ? t('errors.geminiQuotaExceeded', 'Gemini free-tier quota exceeded. Please try again later or use a different API key/add billing.')
                            : t('errors.geminiQuotaExceeded', 'Gemini quota exceeded. Please try again later or use a different API key/add billing.');
                        setStatus({ message: msg, type: 'error' });
                    }
                } else if (error.message && (
                    (error.message.includes('503') && error.message.includes('Service Unavailable')) ||
                    error.message.includes('The model is overloaded')
                )) {
                    const is503Error = error.message.includes('503');
                    const errorMessage = is503Error
                        ? t('errors.geminiServiceUnavailable', 'Gemini is currently overloaded, please wait and try again later (error code 503)')
                        : t('errors.geminiOverloaded', 'Strong model tends to get overloaded, please consider using other model and try again, or try lower the segment duration. Or create a new Google Cloud Project and get an API Key.');
                    setStatus({ message: errorMessage, type: 'error' });
                } else if (error.message && error.message.toLowerCase().includes('token') && error.message.toLowerCase().includes('exceeds the maximum')) {
                    const tokenMatch = error.message.match(/input token count\s*\((\d+)\)\s*exceeds the maximum number of tokens allowed\s*\((\d+)\)/i);
                    if (tokenMatch) {
                        const required = tokenMatch[1];
                        const limit = tokenMatch[2];
                        setStatus({ message: t('errors.tokenLimitExceededCounts', 'The video segment is too large for Gemini to process (required {{required}} tokens, limit {{limit}} tokens). Please reduce FPS/quality or shorten each request and try again.', { required, limit }), type: 'error' });
                    } else {
                        setStatus({ message: t('errors.tokenLimitExceeded'), type: 'error' });
                    }
                } else if (error.message && error.message.includes('File size') && error.message.includes('exceeds the recommended maximum')) {
                    const sizeMatch = error.message.match(/(\d+)MB\) exceeds the recommended maximum of (\d+)MB/);
                    if (sizeMatch && sizeMatch.length >= 3) {
                        const size = sizeMatch[1];
                        const maxSize = sizeMatch[2];
                        setStatus({
                            message: t('errors.fileSizeTooLarge', 'File size ({{size}}MB) exceeds the recommended maximum of {{maxSize}}MB. Please use a smaller file or lower quality video.', { size, maxSize }),
                            type: 'error'
                        });
                    } else {
                        setStatus({ message: error.message, type: 'error' });
                    }
                } else {
                    setStatus({ message: `Error: ${error.message}`, type: 'error' });
                }
            }
            return false;
        } finally {
            setIsGenerating(false);
        }
    }, [t]);

    const retryGeneration = useCallback(async (input, inputType, apiKeysSet, options = {}) => {
        const runId = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : Math.random().toString(36).slice(2, 10);
        // Extract options
        const { userProvidedSubtitles } = options;
        if (!apiKeysSet.gemini) {
            setStatus({ message: t('errors.apiKeyRequired'), type: 'error' });
            return false;
        }

        // Reset the force stop flag when retrying generation
        setProcessingForceStopped(false);

        setIsGenerating(true);
        setStatus({ message: 'Retrying request to Gemini. This may take a few minutes...', type: 'loading' });

        try {
            let subtitles;

            // Check if this is a long media file (video or audio) that needs special processing
            if (input.type && (input.type.startsWith('video/') || input.type.startsWith('audio/'))) {
                try {
                    const duration = await getVideoDuration(input);
                    // eslint-disable-next-line no-unused-vars
                    const durationMinutes = Math.floor(duration / 60);

                    // Determine if this is a video or audio file
                    const isAudio = input.type.startsWith('audio/');
                    // eslint-disable-next-line no-unused-vars
                    const mediaType = isAudio ? 'audio' : 'video';

                    // Debug log to see the media duration


                    // Use the new smart processing function that chooses between simplified and legacy
                    subtitles = await processMediaFile(input, setStatus, t, { userProvidedSubtitles });
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
                    } catch (e) {
                        console.warn('Inline YouTube: failed to access current blob URL, falling back:', e);
                        // Remember source file for retries
                        currentSourceFileRef.current = ytFile;

                    }

                    if (ytFile) {
                        // Stream full video unconditionally
                        const { getVideoDuration } = await import('../utils/videoProcessing');
                        const { processGeminiSegment } = await import('../services/engines/GeminiAdapter');
                        const duration = await getVideoDuration(ytFile);
                        const fullSegment = { start: 0, end: duration || 0 };
                        // Derive streaming options for YouTube retry
                        const fps = options.fps ?? getVideoProcessingFps();
                        const mediaResolution = options.mediaResolution ?? getMediaResolution();
                        const model = options.model ?? (localStorage.getItem('gemini_model') || 'gemini-2.0-flash');

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
                            { onStatus: setStatus, onStreamingUpdate: (streamingSubtitles) => setSubtitlesData(streamingSubtitles), t }
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

            setSubtitlesData(subtitles);

            // Cache the new results using unified approach
            const currentVideoUrl = localStorage.getItem('current_video_url');
            let cacheId = null;

            if (inputType === 'youtube' || currentVideoUrl) {
                // Use unified URL-based caching
                const urlToUse = inputType === 'youtube' ? input : currentVideoUrl;
                cacheId = await generateUrlBasedCacheId(urlToUse);

                if (cacheId && subtitles && subtitles.length > 0) {
                    await saveSubtitlesToCache(cacheId, subtitles);
                }

                // Set cache ID for both stores
                setRulesCacheId(cacheId);
                setSubtitlesCacheId(cacheId);

            } else if (inputType === 'file-upload') {
                // For actual file uploads, use file-based cache ID
                cacheId = await generateFileCacheId(input);
                localStorage.setItem('current_file_cache_id', cacheId);

                if (cacheId && subtitles && subtitles.length > 0) {
                    await saveSubtitlesToCache(cacheId, subtitles);
                }

                // Set cache ID for both stores
                setRulesCacheId(cacheId);
                setSubtitlesCacheId(cacheId);

            }

            // Check if using a strong model (Gemini 2.5 Pro or Gemini 2.0 Flash Thinking)
            const currentModel = localStorage.getItem('gemini_model') || 'gemini-2.0-flash';
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
            console.error('Error regenerating subtitles:', error);

            // Check for specific Gemini API errors
            if (error.message && (
                (error.message.includes('503') && error.message.includes('Service Unavailable')) ||
                error.message.includes('The model is overloaded')
            )) {
                // Use specific 503 error message if it's a 503 error
                const is503Error = error.message.includes('503');
                const errorMessage = is503Error
                    ? t('errors.geminiServiceUnavailable', 'Gemini is currently overloaded, please wait and try again later (error code 503)')
                    : t('errors.geminiOverloaded', 'Strong model tends to get overloaded, please consider using other model and try again, or try lower the segment duration. Or create a new Google Cloud Project and get an API Key.');
                setStatus({ message: errorMessage, type: 'error' });
            } else if (error.message && error.message.toLowerCase().includes('token') && error.message.toLowerCase().includes('exceeds the maximum')) {
                const tokenMatch = error.message.match(/input token count\s*\((\d+)\)\s*exceeds the maximum number of tokens allowed\s*\((\d+)\)/i);
                if (tokenMatch) {
                    const required = tokenMatch[1];
                    const limit = tokenMatch[2];
                    setStatus({ message: t('errors.tokenLimitExceededCounts', 'The video segment is too large for Gemini to process (required {{required}} tokens, limit {{limit}} tokens). Please reduce FPS/quality or shorten each request and try again.', { required, limit }), type: 'error' });
                } else {
                    setStatus({ message: t('errors.tokenLimitExceeded'), type: 'error' });
                }
            } else if (error.message && error.message.includes('File size') && error.message.includes('exceeds the recommended maximum')) {
                // Extract file size and max size from error message
                const sizeMatch = error.message.match(/(\d+)MB\) exceeds the recommended maximum of (\d+)MB/);
                if (sizeMatch && sizeMatch.length >= 3) {
                    const size = sizeMatch[1];
                    const maxSize = sizeMatch[2];
                    setStatus({
                        message: t('errors.fileSizeTooLarge', 'File size ({{size}}MB) exceeds the recommended maximum of {{maxSize}}MB. Please use a smaller file or lower quality video.', { size, maxSize }),
                        type: 'error'
                    });
                } else {
                    setStatus({ message: error.message, type: 'error' });
                }
            } else {
                setStatus({ message: `Error: ${error.message}`, type: 'error' });
            }
            return false;
        } finally {
            setIsGenerating(false);
        }
    }, [t]);

    // State to track which segments are currently being retried is defined at the top of the hook

    // Function to retry a specific segment
    const retrySegment = useCallback(async (segmentIndex, segments, options = {}) => {
        // Extract options
        const { modelId } = options;

        if (modelId) {
            console.log(`[RetrySegment] Using custom model for segment ${segmentIndex + 1}: ${modelId}`);
        } else {
            console.log(`[RetrySegment] Using default model for segment ${segmentIndex + 1}`);
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
    }, [subtitlesData, t]);



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
            let sourceFile = currentSourceFileRef.current;
            if (!sourceFile) {
                // Fallback: fetch cached clip file only if no source file available
                try {
                    const resp = await fetch(url);
                    if (!resp.ok) throw new Error(`Failed to fetch cached clip: ${resp.statusText}`);
                    const blob = await resp.blob();
                    const filename = url.split('?')[0].split('/').pop() || 'segment.mp4';
                    sourceFile = new File([blob], filename, { type: blob.type || 'video/mp4' });
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
            }

            const segment = { start, end };
            const fps = getVideoProcessingFps();
            const mediaResolution = getMediaResolution();
            const model = localStorage.getItem('gemini_model') || 'gemini-2.0-flash';

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

            // Retry policy (match Files API): 503/429 with progressive delays
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
            const RETRY_DELAYS = [5, 10, 15, 20, 25]; // seconds
            const INLINE_LARGE_SEGMENT_THRESHOLD_BYTES = 20 * 1024 * 1024; // 20MB (align with Google recommendation)

            // Prefer primary Files API with offsets if we have the original source file
            let usePrimaryFilesApi = !!currentSourceFileRef.current;

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
                    if (usePrimaryFilesApi && !clipFallbackTried) {
                        try {
                            const resp = await fetch(url);
                            if (!resp.ok) throw new Error(`Failed to fetch cached clip for fallback: ${resp.statusText}`);
                            const blob = await resp.blob();
                            const filename = url.split('?')[0].split('/').pop() || 'segment.mp4';
                            sourceFile = new File([blob], filename, { type: blob.type || 'video/mp4' });
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
    }, [t]);

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
export { generateUrlBasedCacheId };