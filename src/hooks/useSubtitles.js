import { useState, useCallback, useEffect, useRef } from 'react';
import { callGeminiApi, setProcessingForceStopped } from '../services/geminiService';
import { getVideoDuration } from '../utils/videoProcessor';
import { EVENTS, publishStreamingComplete, subscribe } from '../events/bus';
import { processGeminiSegment } from '../services/engines/GeminiAdapter';

import {
    commitDurableSubtitleCheckpoint,
    isDurableSubtitleCheckpointReceipt,
    isSuccessfulSubtitleCacheSaveReceipt,
    requireSuccessfulSubtitleCacheSave,
    saveSubtitlesToCache
} from '../services/subtitleCache';
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
import { fetchBrowserResource } from '../platform/browserFetch';
import { useNativeSubtitleHydration } from './useNativeSubtitleHydration';
import { subtitleCompletionStatus } from './subtitleCompletionStatus';
import { getEmptySpeechPolicy } from '../services/gemini/promptManagement';
import { isDesktopRuntime } from '../platform/desktopRuntime';
import { getBrowserMediaBlob } from '../platform/browserMediaBlobRegistry';
import {
    refreshActiveNativeMedia,
    resolveActiveNativeMedia,
} from '../platform/activeNativeMedia';
import { isNativeMediaDescriptor } from '../platform/mediaService';
import {
    assertAutoGenerationContextCurrent,
    assertAutoGenerationContextDurable,
    createAutoGenerationCompletion,
    getAutoGenerationCacheCandidate,
    isAutoGenerationContext
} from '../utils/autoGenerationOwnership';
import {
    acknowledgeGeminiTranscriptionDeliveries,
    bindGeminiTranscriptionDeliveries,
    retryPendingGeminiTranscriptionDeliveries,
} from '../services/gemini/transcriptionDelivery';
import {
    loadExactProjectSubtitles,
    resolveProjectForCache,
} from '../platform/subtitleProjectStore';
import { loadProject } from '../platform/projectService';
import { getCurrentCacheId as getRulesCacheId } from '../utils/transcriptionRulesStore';
import { getCurrentCacheId as getSubtitlesCacheId } from '../utils/userSubtitlesStore';

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
        try {
            if (localStorage.getItem('debug_logs') === 'true') console.log(...args);
        } catch {
            // Debug logging must never affect subtitle generation.
        }
    };
    const [subtitlesData, setSubtitlesDataState] = useState(null);
    const subtitlesRevisionRef = useRef(0);
    const setSubtitlesData = useCallback((value) => {
        subtitlesRevisionRef.current += 1;
        setSubtitlesDataState(value);
    }, []);
    const [status, setStatus] = useState({ message: '', type: '' });
    const [isGenerating, setIsGenerating] = useState(false);
    const [retryingSegments, setRetryingSegments] = useState([]);
    const currentSourceFileRef = useRef(null);
    const generationPresentationOwnerRef = useRef(null);

    const currentRetryFromCacheRef = useRef(null);

    useNativeSubtitleHydration({ setSubtitlesData, revisionRef: subtitlesRevisionRef });

    // Countdown updater for quota exceeded with retry seconds
    const startQuotaCountdown = useQuotaCountdown({ t, setStatus, isGenerating });


        // Listen for abort events
    useEffect(() => {
        const handleAbort = () => {
            // If a retry-from-cache is in progress, notify completion for that specific segment
            const active = currentRetryFromCacheRef.current;
            if (active && typeof active.start === 'number' && typeof active.end === 'number') {
                window.dispatchEvent(new CustomEvent(EVENTS.RETRY_SEGMENT_FROM_CACHE_COMPLETE, {
                    detail: {
                        start: active.start,
                        end: active.end,
                        runId: active.runId,
                        success: false,
                        error: 'aborted'
                    }
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
        const autoRunContext = isAutoGenerationContext(options.autoRunContext)
            ? options.autoRunContext
            : null;
        const presentationToken = Object.freeze({ runId });
        generationPresentationOwnerRef.current = presentationToken;
        const ownsPresentation = () => (
            generationPresentationOwnerRef.current === presentationToken
        );
        const canPresent = () => {
            if (!ownsPresentation()) return false;
            if (!autoRunContext) return true;
            try {
                assertAutoGenerationContextCurrent(autoRunContext);
                return true;
            } catch {
                return false;
            }
        };
        const setGenerationStatus = (value) => {
            if (canPresent()) setStatus(value);
        };
        if (autoRunContext) {
            assertAutoGenerationContextCurrent(autoRunContext);
            if (input !== autoRunContext.media) {
                throw new Error('Automatic generation media ownership was lost.');
            }
        }
        let nativeMediaCapability = null;
        if (isDesktopRuntime()) {
            nativeMediaCapability = await resolveActiveNativeMedia({
                candidate: isNativeMediaDescriptor(input) ? input : null,
            });
            if (autoRunContext
                && (nativeMediaCapability.cacheId !== autoRunContext.cacheId
                    || nativeMediaCapability.projectId !== autoRunContext.projectId)) {
                throw new Error('Automatic generation resolved different active native media.');
            }
        }
        const refreshNativeMedia = async () => {
            if (nativeMediaCapability !== null) {
                nativeMediaCapability = await refreshActiveNativeMedia(nativeMediaCapability);
            }
            return nativeMediaCapability;
        };
        const setGenerationSubtitlesData = (value) => {
            if (!canPresent()) return undefined;
            if (typeof value === 'function') {
                return setSubtitlesData((current) => {
                    if (!canPresent()) return current;
                    return value(current);
                });
            }
            return setSubtitlesData(value);
        };
        const speechOnly = getEmptySpeechPolicy(
            input?.type?.startsWith('audio/') ? 'audio' : 'video',
            userProvidedSubtitles,
            options.promptContext
        ) === 'provenSilence';
        if (!LOCAL_METHODS.has(options.method) && !apiKeysSet.gemini) {
            setGenerationStatus({ message: t('errors.apiKeyRequired'), type: 'error' });
            if (ownsPresentation()) generationPresentationOwnerRef.current = null;
            return false;
        }

        // Reset the force stop flag when starting a new generation
        setProcessingForceStopped(false);

        setIsGenerating(true);
        setGenerationStatus({ message: t('output.processingVideo'), type: 'loading' });

        // Local ASR engines (Parakeet + the catalog engines) run via their registered runner.
        const localRunner = METHOD_RUNNERS[options.method];
        if (localRunner) {
            // Local ASR used to bypass project resolution, paint streaming rows, and schedule a
            // best-effort event save 500 ms later. Resolve its durable owner before inference.
            const currentVideoUrl = !isDesktopRuntime() && inputType === 'youtube'
                ? (typeof input === 'string' ? input : input?.url ?? null)
                : null;
            let cacheId;
            try {
                cacheId = await resolveCacheIdForGeneration({
                    input,
                    inputType,
                    currentVideoUrl,
                    t,
                    setStatus: setGenerationStatus,
                    debugLog
                });
                if (autoRunContext) {
                    assertAutoGenerationContextCurrent(autoRunContext);
                    if (cacheId !== autoRunContext.cacheId) {
                        throw new Error('Automatic generation resolved a different subtitle project.');
                    }
                }
            } catch (error) {
                setIsGenerating(false);
                if (ownsPresentation()) generationPresentationOwnerRef.current = null;
                throw error;
            }
            const persistSubtitles = async (rows) => {
                if (!cacheId) throw new Error('The subtitle project could not be resolved.');
                if (autoRunContext) {
                    const receipt = await commitDurableSubtitleCheckpoint({
                        context: autoRunContext,
                        subtitles: rows,
                        validateOwnership: assertAutoGenerationContextDurable
                    });
                    if (!isDurableSubtitleCheckpointReceipt(receipt, autoRunContext)) {
                        throw new Error('Automatic subtitles were not durably saved.');
                    }
                    return receipt;
                }
                const receipt = await saveSubtitlesToCache(cacheId, rows, {
                    expectedProjectId: nativeMediaCapability?.projectId ?? null,
                });
                requireSuccessfulSubtitleCacheSave(receipt);
                await refreshNativeMedia();
                return receipt;
            };
            const localResult = await localRunner({
                input,
                options,
                runId,
                debugLog,
                setStatus: setGenerationStatus,
                setIsGenerating,
                setSubtitlesData: setGenerationSubtitlesData,
                persistSubtitles,
                t
            });
            if (ownsPresentation()) generationPresentationOwnerRef.current = null;
            return localResult;
        }

        try {
            // Check if this is a URL-based input (either direct URL or downloaded video)
            const currentVideoUrl = !isDesktopRuntime() && inputType === 'youtube'
                ? (typeof input === 'string' ? input : input?.url ?? null)
                : null;

            debugLog('[Subtitle Generation] Cache ID generation debug:', {
                inputType,
                currentVideoUrl,
                inputIsFile: input instanceof File,
                inputName: input instanceof File ? input.name : 'not a file'
            });

            // URL-based vs file-based cache key resolution (see useSubtitlesCaching)
            const cacheId = await resolveCacheIdForGeneration({
                input,
                inputType,
                currentVideoUrl,
                t,
                setStatus: setGenerationStatus,
                debugLog
            });
            if (autoRunContext) {
                assertAutoGenerationContextCurrent(autoRunContext);
                if (cacheId !== autoRunContext.cacheId) {
                    throw new Error('Automatic generation resolved a different subtitle project.');
                }
            }
            if (typeof cacheId !== 'string' || cacheId.length === 0) {
                throw new Error('The subtitle project could not be resolved.');
            }
            const resolvedProject = await resolveProjectForCache(cacheId, { create: true });
            if (!resolvedProject?.projectId
                || (autoRunContext && resolvedProject.projectId !== autoRunContext.projectId)
                || (nativeMediaCapability
                    && (resolvedProject.projectId !== nativeMediaCapability.projectId
                        || cacheId !== nativeMediaCapability.cacheId))) {
                throw new Error('The subtitle project changed before Gemini transcription.');
            }
            const deliveryContext = autoRunContext ?? Object.freeze({
                runId,
                cacheId,
                projectId: resolvedProject.projectId,
            });
            const validateDeliveryOwnership = autoRunContext
                ? assertAutoGenerationContextDurable
                : async (context) => {
                    await refreshNativeMedia();
                    if (!canPresent()
                        || getRulesCacheId() !== context.cacheId
                        || getSubtitlesCacheId() !== context.cacheId) {
                        throw new Error('The active subtitle project changed during Gemini transcription.');
                    }
                    await loadExactProjectSubtitles(context.cacheId, context.projectId);
                    await refreshNativeMedia();
                    if (!canPresent()
                        || getRulesCacheId() !== context.cacheId
                        || getSubtitlesCacheId() !== context.cacheId) {
                        throw new Error('The active subtitle project changed during Gemini transcription.');
                    }
                    return context;
                };
            const withGeminiProjectAdmission = async (providerOptions) => {
                await validateDeliveryOwnership(deliveryContext);
                const snapshot = await loadProject(deliveryContext.projectId);
                await validateDeliveryOwnership(deliveryContext);
                if (snapshot?.metadata?.id !== deliveryContext.projectId
                    || !Number.isSafeInteger(snapshot.stateVersion)
                    || snapshot.stateVersion < 0) {
                    throw new Error('The subtitle project could not authorize Gemini transcription.');
                }
                return {
                    ...providerOptions,
                    projectId: deliveryContext.projectId,
                    expectedProjectStateVersion: snapshot.stateVersion,
                };
            };
            const priorDeliveryRecovery = await retryPendingGeminiTranscriptionDeliveries({
                cacheId: deliveryContext.cacheId,
                projectId: deliveryContext.projectId,
                validateOwnership: validateDeliveryOwnership,
            });

            // IMPORTANT: Check cache FIRST and load cached subtitles immediately
            // This ensures the timeline shows cached subtitles right when output container appears
            debugLog('[Subtitle Generation] Cache check debug:', {
                cacheId,
                segment: !!segment,
                willCheckCache: !!(cacheId && !segment)
            });

            let cacheHit = false;
            let cachedSubtitles = null;
            if (autoRunContext && !segment) {
                await assertAutoGenerationContextDurable(autoRunContext);
                const candidate = getAutoGenerationCacheCandidate(autoRunContext);
                cacheHit = candidate.cacheHit;
                cachedSubtitles = candidate.subtitles;
                if (!cacheHit) setGenerationSubtitlesData(null);
            } else {
                ({ cacheHit, cachedSubtitles } = await loadCachedSubtitlesIfAvailable({
                    cacheId,
                    segment,
                    currentVideoUrl,
                    t,
                    setSubtitlesData: setGenerationSubtitlesData,
                    setStatus: setGenerationStatus,
                    debugLog
                }));
            }
            if (cacheHit) {
                if (autoRunContext) {
                    const saved = await commitDurableSubtitleCheckpoint({
                        context: autoRunContext,
                        subtitles: cachedSubtitles,
                        validateOwnership: assertAutoGenerationContextDurable
                    });
                    if (!isDurableSubtitleCheckpointReceipt(saved, autoRunContext)) {
                        throw new Error('Cached automatic subtitles were not durably saved.');
                    }
                    const completion = createAutoGenerationCompletion({
                        context: autoRunContext,
                        terminal: 'subtitles',
                        checkpoint: saved,
                    });
                    setGenerationSubtitlesData(cachedSubtitles);
                    setGenerationStatus({
                        message: t('output.subtitlesLoadedFromCache', 'Subtitles loaded from cache!'),
                        type: 'success',
                        translationKey: 'output.subtitlesLoadedFromCache'
                    });
                    return completion;
                }
                setGenerationStatus({
                    message: t('output.subtitlesLoadedFromCache', 'Subtitles loaded from cache!'),
                    type: 'success',
                    translationKey: 'output.subtitlesLoadedFromCache'
                });
                return true;
            }
            if (!priorDeliveryRecovery.acknowledged) {
                throw new Error('A saved Gemini transcription is still awaiting native recovery.');
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


                // FIRST: persist manual edits. Failure or timeout must abort before streaming can
                // replace the segment the user was editing.
                const { checkpointBeforeUpdate } = await import('../services/lifecycleOrchestrator');
                await checkpointBeforeUpdate({
                    source: 'segment-processing-start',
                    segment,
                    runId,
                    ...(options.signal ? { signal: options.signal } : {}),
                });

                // Process the specific segment with streaming via Gemini adapter

                // IMPORTANT: Use the current React state directly instead of loading from cache
                // The save operation above should have already persisted any manual edits
                // Loading from cache can introduce stale data if the save hasn't fully propagated
                let currentSubtitles = [];

                // Get the current subtitles from React state
                // This ensures we're using the most up-to-date data that's currently displayed
                await new Promise((resolve) => {
                    setGenerationSubtitlesData(current => {
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


                if (autoRunContext) await assertAutoGenerationContextDurable(autoRunContext);
                const segmentSubtitles = await processGeminiSegment(
                    input,
                    segment,
                    await withGeminiProjectAdmission({
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
                        promptContext: options.promptContext,
                        autoRunContext,
                        signal: options.signal,
                        t
                    }),
                    {
                        onStatus: setGenerationStatus,
                        onStreamingUpdate: createSegmentStreamingHandler(segment, setGenerationSubtitlesData),
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
                        setGenerationSubtitlesData(current => {
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
                            const mergedSubtitles = bindGeminiTranscriptionDeliveries(
                                [...nonOverlappingSubtitles, ...segmentSubtitles]
                                    .sort((a, b) => a.start - b.start),
                                segmentSubtitles
                            );

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
                        setGenerationSubtitlesData(current => {
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
                        if (autoRunContext) await assertAutoGenerationContextDurable(autoRunContext);
                        subtitles = await processGeminiSegment(
                            input,
                            segment,
                            await withGeminiProjectAdmission({
                                fps,
                                mediaResolution,
                                model,
                                userProvidedSubtitles,
                                maxDurationPerRequest: options.maxDurationPerRequest,
                                autoSplitSubtitles: options.autoSplitSubtitles,
                                maxWordsPerSubtitle: options.maxWordsPerSubtitle,
                                promptContext: options.promptContext,
                                autoRunContext,
                                signal: options.signal
                            }),
                            { onStatus: setGenerationStatus, t }
                        );
                    } else {
                        // Stream full video/audio unconditionally (feature parity with segment streaming)
                        const fullSegment = { start: 0, end: duration };
                        const { processGeminiSegment } = await import('../services/engines/GeminiAdapter');
                        // Remember source file for retries
                        currentSourceFileRef.current = input;
                        if (autoRunContext) await assertAutoGenerationContextDurable(autoRunContext);
                        subtitles = await processGeminiSegment(
                            input,
                            fullSegment,
                            await withGeminiProjectAdmission({
                                fps,
                                mediaResolution,
                                model,
                                userProvidedSubtitles,
                                maxDurationPerRequest: options.maxDurationPerRequest,
                                autoSplitSubtitles: options.autoSplitSubtitles,
                                maxWordsPerSubtitle: options.maxWordsPerSubtitle,
                                forceInline: options.inlineExtraction === true,
                                runId,
                                promptContext: options.promptContext,
                                autoRunContext,
                                signal: options.signal
                            }),
                            {
                                onStatus: setGenerationStatus,
                                onStreamingUpdate: createFullMediaStreamingHandler(
                                    setGenerationSubtitlesData,
                                    setGenerationStatus
                                ),
                                t
                            }
                        );
                    }
                } catch (error) {
                    console.error('Error checking media duration:', error);
                    if (isDesktopRuntime()) throw error;
                    // Fallback to normal processing (respect inlineExtraction for non-YouTube)
                    const forceInline = options.inlineExtraction === true && inputType !== 'youtube';
                    if (autoRunContext) await assertAutoGenerationContextDurable(autoRunContext);
                    subtitles = await callGeminiApi(input, inputType, await withGeminiProjectAdmission({
                        userProvidedSubtitles,
                        ...(forceInline ? { forceInline: true } : {}),
                        runId,
                        promptContext: options.promptContext,
                        autoRunContext,
                        signal: options.signal
                    }));
                }
            } else {
                // YouTube flow: video is already downloaded and loaded in the app
                if (options.inlineExtraction === true) {
                    // Try to obtain the already-loaded blob without re-downloading
                    const blobUrl = !isDesktopRuntime()
                        ? (typeof input === 'string' ? input : input?.url ?? null)
                        : null;
                    let ytFile = null;
                    try {
                        if (blobUrl && blobUrl.startsWith('blob:')) {
                            const registeredBlob = getBrowserMediaBlob(blobUrl);
                            if (registeredBlob) {
                                const blob = registeredBlob;
                                ytFile = new File([blob], 'youtube.mp4', { type: blob.type || 'video/mp4' });
                            } else {
                                // Fetching a blob: URL stays in-memory, not a network download
                                const blob = await fetchBrowserResource(blobUrl).then(r => r.blob());
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
                        if (autoRunContext) await assertAutoGenerationContextDurable(autoRunContext);
                        subtitles = await processGeminiSegment(
                            ytFile,
                            fullSegment,
                            await withGeminiProjectAdmission({
                                fps,
                                mediaResolution,
                                model,
                                userProvidedSubtitles,
                                maxDurationPerRequest: options.maxDurationPerRequest,
                                autoSplitSubtitles: options.autoSplitSubtitles,
                                maxWordsPerSubtitle: options.maxWordsPerSubtitle,
                                forceInline: true,
                                runId,
                                promptContext: options.promptContext,
                                autoRunContext,
                                signal: options.signal
                            }),
                            {
                                onStatus: setGenerationStatus,
                                onStreamingUpdate: (streamingSubtitles) => (
                                    setGenerationSubtitlesData(streamingSubtitles)
                                ),
                                t
                            }
                        );
                    } else {
                        // Fallback: proceed without forcing inline (no re-download)
                        if (autoRunContext) await assertAutoGenerationContextDurable(autoRunContext);
                        subtitles = await callGeminiApi(input, inputType, await withGeminiProjectAdmission({
                            userProvidedSubtitles,
                            runId,
                            promptContext: options.promptContext,
                            autoRunContext,
                            signal: options.signal
                        }));
                    }
                } else {
                    // Default YouTube path
                    if (autoRunContext) await assertAutoGenerationContextDurable(autoRunContext);
                    subtitles = await callGeminiApi(input, inputType, await withGeminiProjectAdmission({
                        userProvidedSubtitles,
                        runId,
                        promptContext: options.promptContext,
                        autoRunContext,
                        signal: options.signal
                    }));
                }
            }

            if (autoRunContext) await assertAutoGenerationContextDurable(autoRunContext);
            const hasSubtitles = Array.isArray(subtitles) && subtitles.length > 0;
            const explicitNoSpeech = Array.isArray(subtitles)
                && subtitles.length === 0
                && speechOnly;
            if (!hasSubtitles && !explicitNoSpeech) {
                setGenerationStatus(subtitleCompletionStatus(subtitles, t, { speechOnly }));
                return false;
            }

            await validateDeliveryOwnership(deliveryContext);
            let durableSave = null;

            if (segment) {
                if (!cacheId) throw new Error('The subtitle project could not be resolved.');
                if (autoRunContext) {
                    durableSave = await commitDurableSubtitleCheckpoint({
                        context: autoRunContext,
                        subtitles,
                        validateOwnership: assertAutoGenerationContextDurable
                    });
                } else {
                    durableSave = await saveSubtitlesToCache(cacheId, subtitles, {
                        expectedProjectId: deliveryContext.projectId,
                    });
                    requireSuccessfulSubtitleCacheSave(durableSave);
                }
            } else {
                // For non-segment processing, trigger save before updating with new results
                if (hasSubtitles || explicitNoSpeech) {
                    // First, checkpoint save of current state to preserve any manual edits
                    const { checkpointBeforeUpdate } = await import('../services/lifecycleOrchestrator');
                    await checkpointBeforeUpdate({
                        source: 'video-processing-complete',
                        runId,
                        ...(options.signal ? { signal: options.signal } : {}),
                    });
                    if (autoRunContext) await assertAutoGenerationContextDurable(autoRunContext);
                    if (autoRunContext) {
                        durableSave = await commitDurableSubtitleCheckpoint({
                            context: autoRunContext,
                            subtitles,
                            validateOwnership: assertAutoGenerationContextDurable
                        });
                    }
                }
            }

            // Cache full-media results. Segment results were committed immediately above so
            // generic streaming could not announce success ahead of durability.
            if (cacheId && Array.isArray(subtitles) && !segment) {
                if (autoRunContext) {
                    if (!durableSave) {
                        durableSave = await commitDurableSubtitleCheckpoint({
                            context: autoRunContext,
                            subtitles,
                            validateOwnership: assertAutoGenerationContextDurable
                        });
                    }
                } else {
                    durableSave = await saveSubtitlesToCache(cacheId, subtitles, {
                        expectedProjectId: deliveryContext.projectId,
                    });
                    requireSuccessfulSubtitleCacheSave(durableSave);
                }
            }

            let completion = null;
            if (autoRunContext) {
                if (!isDurableSubtitleCheckpointReceipt(durableSave, autoRunContext)) {
                    throw new Error('Automatic subtitles were not durably saved.');
                }
                completion = createAutoGenerationCompletion({
                    context: autoRunContext,
                    terminal: hasSubtitles ? 'subtitles' : 'no-speech',
                    checkpoint: durableSave,
                });
            } else if (!isSuccessfulSubtitleCacheSaveReceipt(durableSave)) {
                throw new Error('Subtitles were not durably saved.');
            }

            await validateDeliveryOwnership(deliveryContext);
            const deliveryCommit = await acknowledgeGeminiTranscriptionDeliveries({
                rows: subtitles,
                receipt: durableSave,
                context: deliveryContext,
                validateOwnership: validateDeliveryOwnership,
            });
            await validateDeliveryOwnership(deliveryContext);
            setGenerationSubtitlesData(subtitles);

            // This owner is the first layer allowed to publish terminal UI. Both the status and
            // streaming-complete lifecycle happen only after a privately branded native receipt.
            setGenerationStatus(deliveryCommit.acknowledged
                ? subtitleCompletionStatus(subtitles, t, { speechOnly })
                : {
                    message: t(
                        'output.subtitlesDeliveryPending',
                        'Subtitles were saved. Native result cleanup will retry automatically.'
                    ),
                    type: 'warning',
                });
            if (hasSubtitles && canPresent()) {
                publishStreamingComplete({
                    subtitles,
                    segment: segment ?? options.requestedSegment,
                    runId,
                });
            }
            if (completion) return completion;
            return true;
        } catch (error) {
            console.error('Error generating subtitles:', error);
            if (error?.code === 'subtitleCacheSaveFailed') {
                setGenerationStatus({
                    message: t(
                        'output.subtitlesCacheSaveFailed',
                        'Subtitles were generated, but they could not be saved.'
                    ),
                    type: 'error'
                });
                return false;
            }
            try {
                if (!reportKnownGeminiSubtitleError(error, {
                    t,
                    setStatus: setGenerationStatus,
                    startQuotaCountdown
                })) {
                    // Not a recognised error type - parse a structured error payload from Gemini.
                    const errorData = JSON.parse(error.message);
                    if (errorData.type === 'unrecognized_format') {
                        setGenerationStatus({
                            message: `${errorData.message}\n\nRaw text from Gemini:\n${errorData.rawText}`,
                            type: 'error'
                        });
                    } else {
                        setGenerationStatus({ message: `Error: ${error.message}`, type: 'error' });
                    }
                }
            } catch {
                // The structured-error JSON.parse above threw (non-JSON message); fall back to a
                // recognised-error check then a generic message.
                if (!reportKnownGeminiSubtitleError(error, {
                    t,
                    setStatus: setGenerationStatus,
                    startQuotaCountdown
                })) {
                    setGenerationStatus({ message: `Error: ${error.message}`, type: 'error' });
                }
            }
            return false;
        } finally {
            if (ownsPresentation()) {
                generationPresentationOwnerRef.current = null;
                setIsGenerating(false);
            }
        }
    }, [t, startQuotaCountdown, setSubtitlesData]);

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
