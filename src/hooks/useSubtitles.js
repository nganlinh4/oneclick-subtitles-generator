import { useState, useCallback, useEffect, useRef } from 'react';
import { callGeminiApi, setProcessingForceStopped } from '../services/geminiService';
import { getVideoDuration } from '../utils/videoProcessor';
import { EVENTS, subscribe } from '../events/bus';
import { processGeminiSegment } from '../services/engines/GeminiAdapter';
import { useSubtitlesSegmentRetry } from './useSubtitlesSegmentRetry';
import { useQuotaCountdown } from './useQuotaCountdown';
import { useSubtitlesRetryGeneration } from './useSubtitlesRetryGeneration';
import { LOCAL_METHOD_IDS } from '../services/engines/transcriptionEngineRegistry';
import {
    createFullMediaStreamingHandler,
} from './subtitleStreamingHandlers';
import { fetchBrowserResource } from '../platform/browserFetch';
import { useNativeSubtitleHydration } from './useNativeSubtitleHydration';
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
    isAutoGenerationContext
} from '../utils/autoGenerationOwnership';
import { bindGeminiTranscriptionDeliveries } from '../services/gemini/transcriptionDelivery';
import { loadExactProjectSubtitles } from '../platform/subtitleProjectStore';
import * as userSubtitlesStore from '../utils/userSubtitlesStore';
import { createSubtitleRunId } from './subtitleRunId';
import { createGenerationPresentation } from './subtitleGenerationOwnership';
import { getLocalSubtitleRunner, runLocalSubtitleGeneration } from './runLocalSubtitleGeneration';
import { prepareGeminiGeneration } from './prepareGeminiGeneration';
import { commitGeminiGeneration, presentGeminiGenerationFailure } from './geminiGenerationOutcome';

// Required-effective async boundary: the lifecycle orchestrator must stay out of the entry chunk.
const loadLifecycleOrchestrator = () => import('../services/lifecycleOrchestrator');

const LOCAL_METHODS = new Set(LOCAL_METHOD_IDS);

export const useSubtitles = (t) => {
    const [subtitlesData, setSubtitlesDataState] = useState(null);
    const subtitlesRevisionRef = useRef(0);
    const setSubtitlesData = useCallback((value) => {
        subtitlesRevisionRef.current += 1;
        setSubtitlesDataState(value);
    }, []);
    // A status publication is an event as well as the latest durable value. Keeping an explicit
    // identity lets presentation surfaces consume it once without clearing workflow state, and it
    // still distinguishes two legitimate later publications with identical message/type payloads.
    const [statusPublication, setStatusPublication] = useState(() => ({
        eventId: 0,
        value: { message: '', type: '' },
    }));
    const status = statusPublication.value;
    const statusEventId = statusPublication.eventId;
    const setStatus = useCallback((nextStatus) => {
        setStatusPublication((current) => ({
            eventId: current.eventId + 1,
            value: typeof nextStatus === 'function'
                ? nextStatus(current.value)
                : nextStatus,
        }));
    }, []);
    const [isGenerating, setIsGenerating] = useState(false);
    const [retryingSegments, setRetryingSegments] = useState([]);
    const currentSourceFileRef = useRef(null);
    const generationPresentationOwnerRef = useRef(null);

    const currentRetryFromCacheRef = useRef(null);

    useNativeSubtitleHydration({ setSubtitlesData, revisionRef: subtitlesRevisionRef, t });

    useEffect(() => {
        let subscribe = null;
        try {
            subscribe = userSubtitlesStore?.subscribeCurrentCacheId;
        } catch {
            subscribe = null;
        }
        if (!isDesktopRuntime() || typeof subscribe !== 'function') return undefined;
        const unsubscribe = subscribe((cacheId, previousCacheId) => {
            if (previousCacheId && cacheId !== previousCacheId) {
                generationPresentationOwnerRef.current = null;
            }
        });
        return () => unsubscribe?.();
    }, []);

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
    }, [setStatus, t]);

    // Function to update segment status and dispatch event
    const updateSegmentsStatus = useCallback((segments) => {
        // Dispatch custom event with segment status (centralized constant)
        const event = new CustomEvent(EVENTS.SEGMENT_STATUS_UPDATE, { detail: segments });
        window.dispatchEvent(event);
    }, []);

    const generateSubtitles = useCallback(async (input, inputType, apiKeysSet, options = {}) => {
        const runId = createSubtitleRunId();
        const { userProvidedSubtitles, segment, fps, mediaResolution, model } = options; // inlineExtraction supported via options.inlineExtraction
        const autoRunContext = isAutoGenerationContext(options.autoRunContext)
            ? options.autoRunContext
            : null;
        const presentation = createGenerationPresentation({
            runId,
            autoRunContext,
            ownerRef: generationPresentationOwnerRef,
            setStatus,
            setSubtitlesData,
        });
        const {
            ownsPresentation,
            releasePresentation,
            setGenerationStatus,
            setGenerationSubtitlesData,
        } = presentation;
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
        const getNativeMediaCapability = () => nativeMediaCapability;
        const speechOnly = getEmptySpeechPolicy(
            input?.type?.startsWith('audio/') ? 'audio' : 'video',
            userProvidedSubtitles,
            options.promptContext
        ) === 'provenSilence';
        if (!LOCAL_METHODS.has(options.method) && !apiKeysSet.gemini) {
            setGenerationStatus({ message: t('errors.apiKeyRequired'), type: 'error' });
            releasePresentation();
            return false;
        }

        // Reset the force stop flag when starting a new generation
        setProcessingForceStopped(false);

        setIsGenerating(true);
        setGenerationStatus({ message: t('output.processingVideo'), type: 'loading' });

        const localRunner = getLocalSubtitleRunner(options.method);
        if (localRunner) {
            return await runLocalSubtitleGeneration({
                localRunner,
                input,
                inputType,
                options,
                runId,
                autoRunContext,
                presentation,
                refreshNativeMedia,
                getNativeMediaCapability,
                setIsGenerating,
                t,
            });
        }

        let fullMediaStreamingHandler = null;
        try {
            const prepared = await prepareGeminiGeneration({
                input,
                inputType,
                options,
                segment,
                runId,
                autoRunContext,
                presentation,
                refreshNativeMedia,
                getNativeMediaCapability,
                loadLifecycleOrchestrator,
                t,
            });
            if (prepared.cachedResult !== undefined) return prepared.cachedResult;
            const {
                deliveryContext,
                presentationRollbackRows,
                validateDeliveryOwnership,
                withGeminiProjectAdmission,
            } = prepared;

            // Generate new subtitles
            let subtitles;

            // Check if this is segment processing
            if (segment) {
                // Inline extraction streams identically to the Files API (forceInline below).
                // The generation-start checkpoint acknowledged the latest manual edits. Read that exact
                // native project revision back as the merge base; a React setter callback is not a
                // transactional read and can stall or observe another project's presentation.
                await validateDeliveryOwnership(deliveryContext);
                const loadedSubtitles = await loadExactProjectSubtitles(
                    deliveryContext.cacheId,
                    deliveryContext.projectId
                );
                // A project with media but no subtitle track is the normal first-generation state.
                // The native store represents that absence as null; the merge identity for an
                // absent track is an empty timeline, not a corrupt project.
                const currentSubtitles = loadedSubtitles === null ? [] : loadedSubtitles;
                if (!Array.isArray(currentSubtitles)) {
                    throw new Error('The native subtitle project returned an invalid track.');
                }
                await validateDeliveryOwnership(deliveryContext);

                // Remember the current source file for future retries (Files API offsets)
                currentSourceFileRef.current = input;


                if (autoRunContext) await assertAutoGenerationContextDurable(autoRunContext);
                const nonOverlappingSubtitles = currentSubtitles.filter(sub => (
                    sub.end <= segment.start || sub.start >= segment.end
                ));
                fullMediaStreamingHandler = createFullMediaStreamingHandler(
                    (streamingRows) => setGenerationSubtitlesData(
                        [...nonOverlappingSubtitles, ...streamingRows].sort((a, b) => a.start - b.start)
                    ),
                    setGenerationStatus,
                    t,
                    {
                        rollbackRows: currentSubtitles,
                        rollbackPublisher: setGenerationSubtitlesData,
                    },
                );
                const segmentSubtitles = await processGeminiSegment(
                    input,
                    segment,
                    await withGeminiProjectAdmission({
                        fps,
                        audioOnly: options.audioOnly === true,
                        mediaResolution,
                        model,
                        engine: options.engine,
                        languageHints: options.languageHints,
                        diarization: options.diarization,
                        windowDurationSecs: options.windowDurationSecs,
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
                        onStreamingUpdate: fullMediaStreamingHandler,
                        t
                    }
                );

                // Build the replacement from the checkpointed pre-run snapshot without publishing
                // uncommitted provider rows. The exact-project save below owns the visible commit.
                if (segmentSubtitles && segmentSubtitles.length > 0) {
                    subtitles = bindGeminiTranscriptionDeliveries(
                        [...nonOverlappingSubtitles, ...segmentSubtitles]
                            .sort((a, b) => a.start - b.start),
                        segmentSubtitles
                    );
                } else {
                    subtitles = currentSubtitles;
                }

            }
            // Check if this is a long media file (video or audio) that needs special processing
            else if (input.type && (input.type.startsWith('video/') || input.type.startsWith('audio/'))) {
                try {
                    const duration = await getVideoDuration(input);

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
                                audioOnly: options.audioOnly === true,
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
                        fullMediaStreamingHandler = createFullMediaStreamingHandler(
                            setGenerationSubtitlesData,
                            setGenerationStatus,
                            t,
                            { rollbackRows: presentationRollbackRows },
                        );
                        // Remember source file for retries
                        currentSourceFileRef.current = input;
                        if (autoRunContext) await assertAutoGenerationContextDurable(autoRunContext);
                        subtitles = await processGeminiSegment(
                            input,
                            fullSegment,
                            await withGeminiProjectAdmission({
                                fps,
                                audioOnly: options.audioOnly === true,
                                mediaResolution,
                                model,
                                engine: options.engine,
                                languageHints: options.languageHints,
                                diarization: options.diarization,
                                windowDurationSecs: options.windowDurationSecs,
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
                                onStreamingUpdate: fullMediaStreamingHandler,
                                t
                            }
                        );
                    }
                } catch (error) {
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

                    } catch {
                        // The loaded browser blob is optional; the normal provider path remains.
                    }

                    if (ytFile) {
                        // Stream full video unconditionally
                        const { getVideoDuration } = await import('../utils/videoProcessing');
                        const { processGeminiSegment } = await import('../services/engines/GeminiAdapter');
                        const duration = await getVideoDuration(ytFile);
                        const fullSegment = { start: 0, end: duration || 0 };
                        fullMediaStreamingHandler = createFullMediaStreamingHandler(
                            setGenerationSubtitlesData,
                            setGenerationStatus,
                            t
                        );
                        if (autoRunContext) await assertAutoGenerationContextDurable(autoRunContext);
                        subtitles = await processGeminiSegment(
                            ytFile,
                            fullSegment,
                            await withGeminiProjectAdmission({
                                fps,
                                audioOnly: options.audioOnly === true,
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
                                onStreamingUpdate: fullMediaStreamingHandler,
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

            return await commitGeminiGeneration({
                subtitles,
                segment,
                requestedSegment: options.requestedSegment,
                cacheId: prepared.cacheId,
                runId,
                speechOnly,
                autoRunContext,
                deliveryContext,
                validateDeliveryOwnership,
                fullMediaStreamingHandler,
                presentation,
                t,
            });
        } catch (error) {
            return presentGeminiGenerationFailure(error, {
                canPresent: presentation.canPresent,
                fullMediaStreamingHandler,
                setGenerationStatus,
                startQuotaCountdown,
                t,
            });
        } finally {
            fullMediaStreamingHandler?.cancel?.();
            if (ownsPresentation()) {
                releasePresentation();
                setIsGenerating(false);
            }
        }
    }, [t, startQuotaCountdown, setStatus, setSubtitlesData]);

    const { retryGeneration } = useSubtitlesRetryGeneration({
        t,
        setStatus,
        setIsGenerating,
        setSubtitlesData,
        currentSourceFileRef
    });

    // Segment retry: the (deprecated) per-segment callback + the
    // RETRY_SEGMENT_FROM_CACHE listener (Files-API offsets vs clipped fallback,
    // progressive merge, 503/429 retry policy). Shared state/refs are threaded in.
    const { retrySegment } = useSubtitlesSegmentRetry({
        t,
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
        statusEventId,
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
