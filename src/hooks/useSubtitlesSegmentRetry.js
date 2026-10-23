import { useCallback, useEffect, useRef } from 'react';
import {
    EVENTS,
    publishStreamingComplete,
    subscribe,
} from '../events/bus';
import { getVideoProcessingFps, getMediaResolution } from '../services/configService';
import { DEFAULT_TRANSCRIPTION_MODEL_ID, normalizeMediaModelId } from '../config/geminiModels';
import { isDesktopRuntime } from '../platform/desktopRuntime';
import { captureDurableSubtitleSegmentRevision } from '../services/subtitleCache';
import {
    SubtitleOperationOwnershipError,
    acquireSubtitleProjectOperationLease,
    abortableSubtitleOperationDelay,
    assertSubtitleOperationCurrent,
    assertSubtitleOperationDurable,
    captureSubtitleOperationContext,
    finishSubtitleOperationContext,
    isSubtitleOperationCancellation,
    isSubtitleOperationCurrent,
    releaseSubtitleProjectOperationLease,
} from '../utils/subtitleOperationOwnership';
import { retryPendingGeminiTranscriptionDeliveries } from '../services/gemini/transcriptionDelivery';
import { loadProject } from '../platform/projectService';
import { createSubtitleRunId as createRunId } from './subtitleRunId';
import {
    assertResolvedSourceMatches,
    resolveCachedRetrySource,
    stoppedError,
} from './segmentRetrySource';
import {
    applyOwnedSubtitles,
    commitOwnedSegmentReplacement,
    createOwnedStreamingSession,
    isTransientProviderError,
    normalizeSegmentRows,
    publishOwnedEvent,
    segmentRetryCompletionStatus,
} from './segmentRetryOwnership';

const RETRY_DELAYS = [5, 10, 15, 20, 25];
const INLINE_LARGE_SEGMENT_THRESHOLD_BYTES = 20 * 1024 * 1024;
const FIXED_RETRY_FAILURE = 'segmentRetryFailed';
const loadLifecycleOrchestrator = () => import('../services/lifecycleOrchestrator');

const runOwnedGeminiAttempt = async ({
    context,
    controller,
    sourceFile,
    options,
    t,
    mountedRef,
    setStatus,
    canPresent,
}) => {
    const { processGeminiSegment } = await import('../services/engines/GeminiAdapter');
    const { mergeStreamingSubtitlesProgressively } = await import(
        '../utils/subtitle/subtitleMerger'
    );
    const stream = createOwnedStreamingSession({
        context,
        controller,
        mountedRef,
        setStatus,
        canPresent,
        mergeStreamingSubtitles: mergeStreamingSubtitlesProgressively,
        t,
    });
    await assertSubtitleOperationDurable(context);
    const priorDeliveryRecovery = await retryPendingGeminiTranscriptionDeliveries({
        cacheId: context.cacheId,
        projectId: context.projectId,
        validateOwnership: assertSubtitleOperationDurable,
    });
    if (!priorDeliveryRecovery.acknowledged) {
        throw new Error('A saved Gemini transcription is still awaiting native recovery.');
    }
    const project = await loadProject(context.projectId);
    await assertSubtitleOperationDurable(context);
    if (project?.metadata?.id !== context.projectId
        || !Number.isSafeInteger(project.stateVersion)
        || project.stateVersion < 0) {
        throw new SubtitleOperationOwnershipError();
    }
    let result;
    let processError = null;
    try {
        result = await processGeminiSegment(
            sourceFile,
            context.segment,
            {
                ...options,
                runId: context.runId,
                signal: context.signal,
                projectId: context.projectId,
                expectedProjectStateVersion: project.stateVersion,
            },
            {
                onStatus: stream.onStatus,
                onStreamingUpdate: stream.onStreamingUpdate,
                t,
            }
        );
    } catch (error) {
        processError = error;
    }
    await stream.settle(processError);
    await assertSubtitleOperationDurable(context);
    return normalizeSegmentRows(result, context.segment);
};

export const useSubtitlesSegmentRetry = ({
    t,
    setSubtitlesData,
    setStatus,
    setIsGenerating,
    setRetryingSegments,
    currentSourceFileRef,
    currentRetryFromCacheRef,
}) => {
    const mountedRef = useRef(false);
    const activeRef = useRef(new Map());
    const presentationRunsRef = useRef(new Map());
    const segmentPresentationRef = useRef(new Map());

    const canPresent = useCallback((record, context, { allowAborted = false } = {}) => (
        mountedRef.current
        && record?.presentationToken
        && presentationRunsRef.current.get(record.runId) === record.presentationToken
        && isSubtitleOperationCurrent(context, { allowAborted })
    ), []);

    const registerPresentation = useCallback((record, context, segmentIndex = null) => {
        if (!mountedRef.current) throw stoppedError();
        assertSubtitleOperationCurrent(context);
        const token = Object.freeze({});
        record.presentationToken = token;
        presentationRunsRef.current.set(record.runId, token);
        if (segmentIndex !== null) {
            segmentPresentationRef.current.set(segmentIndex, token);
            setRetryingSegments((current) => (
                current.includes(segmentIndex) ? current : [...current, segmentIndex]
            ));
        }
        setIsGenerating(true);
    }, [setIsGenerating, setRetryingSegments]);

    const finishRun = useCallback(({ controller, context, record, segmentIndex = null }) => {
        activeRef.current.delete(controller);
        if (context) finishSubtitleOperationContext(context);
        if (record?.presentationToken
            && presentationRunsRef.current.get(record.runId) === record.presentationToken) {
            presentationRunsRef.current.delete(record.runId);
        }
        if (mountedRef.current && segmentIndex !== null
            && segmentPresentationRef.current.get(segmentIndex) === record?.presentationToken) {
            segmentPresentationRef.current.delete(segmentIndex);
            setRetryingSegments((current) => current.filter((index) => index !== segmentIndex));
        }
        if (mountedRef.current
            && presentationRunsRef.current.size === 0
            && activeRef.current.size === 0) {
            setIsGenerating(false);
        }
    }, [setIsGenerating, setRetryingSegments]);

    const retrySegment = useCallback(async (segmentIndex, segments, options = {}) => {
        const selectedSegment = Array.isArray(segments) ? segments[segmentIndex] : null;
        const start = selectedSegment?.start ?? selectedSegment?.startTime;
        const end = selectedSegment?.end ?? selectedSegment?.endTime;
        if (!Number.isFinite(start) || start < 0 || !Number.isFinite(end) || end <= start) {
            return false;
        }
        const segment = Object.freeze({ start, end });
        const capturedSource = currentSourceFileRef.current;
        const controller = new AbortController();
        const record = { kind: 'direct', runId: createRunId(), start, end };
        activeRef.current.set(controller, record);
        let context = null;
        let lease = null;
        let revision = null;
        let committed = false;
        try {
            context = await captureSubtitleOperationContext({
                runId: record.runId,
                segment,
                controller,
            });
            record.context = context;
            lease = await acquireSubtitleProjectOperationLease(context);
            record.lease = lease;
            await assertSubtitleOperationDurable(context);
            registerPresentation(record, context, segmentIndex);
            const modelId = options.modelId ?? options.model;
            const { checkpointBeforeUpdate } = await loadLifecycleOrchestrator();
            await checkpointBeforeUpdate({
                source: 'segment-processing-start',
                segment,
                runId: context.runId,
                signal: context.signal,
            });
            await assertSubtitleOperationDurable(context);
            revision = await captureDurableSubtitleSegmentRevision({
                context,
                validateOwnership: assertSubtitleOperationDurable,
            });
            const source = await resolveCachedRetrySource(
                capturedSource,
                selectedSegment?.url || '',
                {
                    signal: context.signal,
                    validateOwnership: () => assertSubtitleOperationDurable(context),
                    expectedAssetId: context.assetId,
                }
            );
            await assertSubtitleOperationDurable(context);
            if (!mountedRef.current) throw stoppedError();
            assertResolvedSourceMatches(context, source.sourceFile);

            if (canPresent(record, context)) {
                await publishOwnedEvent(context, mountedRef, EVENTS.SEGMENT_STATUS_UPDATE, [{
                    ...selectedSegment,
                    index: segmentIndex,
                    status: 'retrying',
                    shortMessage: t('output.retrying', 'Retrying'),
                }]);
                setStatus({ message: t('output.processingVideo', 'Processing video...'), type: 'loading' });
            }

            const replacement = await runOwnedGeminiAttempt({
                context,
                controller,
                sourceFile: source.sourceFile,
                options: {
                    fps: options.fps ?? getVideoProcessingFps(),
                    audioOnly: options.audioOnly === true,
                    mediaResolution: options.mediaResolution ?? getMediaResolution(),
                    model: normalizeMediaModelId(
                        modelId ?? localStorage.getItem('gemini_model'),
                        DEFAULT_TRANSCRIPTION_MODEL_ID
                    ),
                    userProvidedSubtitles: options.userProvidedSubtitles,
                    maxDurationPerRequest: options.maxDurationPerRequest,
                    autoSplitSubtitles: options.autoSplitSubtitles,
                    maxWordsPerSubtitle: options.maxWordsPerSubtitle,
                    forceInline: options.inlineExtraction === true,
                },
                t,
                mountedRef,
                setStatus,
                canPresent: () => canPresent(record, context),
            });
            const { committedRows, deliveryCommit } = await commitOwnedSegmentReplacement({
                context,
                revision,
                replacement,
                onCommitted: () => { committed = true; },
            });
            if (canPresent(record, context)) {
                const applied = await applyOwnedSubtitles({
                    context,
                    mountedRef,
                    setSubtitlesData,
                    subtitles: committedRows,
                });
                if (applied && canPresent(record, context)) {
                    publishStreamingComplete({
                        subtitles: committedRows,
                        segment,
                        runId: context.runId,
                    });
                    await publishOwnedEvent(context, mountedRef, EVENTS.SEGMENT_STATUS_UPDATE, [{
                        ...selectedSegment,
                        index: segmentIndex,
                        status: 'success',
                        shortMessage: t('output.success', 'Success'),
                    }]);
                    if (canPresent(record, context)) {
                        setStatus(segmentRetryCompletionStatus(deliveryCommit, t));
                    }
                }
            }
            return true;
        } catch (error) {
            if (committed) return true;
            if (context && canPresent(record, context, { allowAborted: true })
                && !isSubtitleOperationCancellation(error, context?.signal)) {
                try {
                    await publishOwnedEvent(context, mountedRef, EVENTS.SEGMENT_STATUS_UPDATE, [{
                        index: segmentIndex,
                        status: 'error',
                        message: FIXED_RETRY_FAILURE,
                        shortMessage: t('output.failed', 'Failed'),
                    }]);
                    if (canPresent(record, context, { allowAborted: true })) setStatus({
                        message: t('errors.segmentRetryFailed', 'Failed to retry segment {{segmentNumber}}', {
                            segmentNumber: segmentIndex + 1,
                        }),
                        type: 'error',
                    });
                } catch {
                    // Ownership was lost while reporting the failure; discard it.
                }
            }
            return false;
        } finally {
            if (lease) releaseSubtitleProjectOperationLease(lease);
            finishRun({ controller, context, record, segmentIndex });
        }
    }, [canPresent, currentSourceFileRef, finishRun, registerPresentation, setStatus, setSubtitlesData, t]);

    useEffect(() => {
        mountedRef.current = true;
        const activeOperations = activeRef.current;
        const presentationRuns = presentationRunsRef.current;
        const segmentPresentations = segmentPresentationRef.current;

        const cachedHandler = async (event) => {
            const detail = event?.detail;
            const { start, end, url } = detail || {};
            if (!Number.isFinite(start) || start < 0 || !Number.isFinite(end)
                || end <= start || typeof url !== 'string' || !url) return;

            const segment = Object.freeze({ start, end });
            const capturedSource = currentSourceFileRef.current;
            const controller = new AbortController();
            const record = {
                kind: 'cached',
                runId: createRunId(),
                start,
                end,
                failurePublished: false,
            };
            activeRef.current.set(controller, record);
            let context = null;
            let lease = null;
            let revision = null;
            let committed = false;
            try {
                // Freeze request controls before preparation/backoff. A settings edit
                // must not change the media modality or model halfway through a retry.
                const requestOptions = Object.freeze({
                    fps: getVideoProcessingFps(),
                    audioOnly: localStorage.getItem('video_processing_audio_only') === 'true',
                    mediaResolution: getMediaResolution(),
                    model: normalizeMediaModelId(
                        localStorage.getItem('gemini_model'),
                        DEFAULT_TRANSCRIPTION_MODEL_ID
                    ),
                });
                context = await captureSubtitleOperationContext({
                    runId: record.runId,
                    segment,
                    controller,
                });
                record.context = context;
                lease = await acquireSubtitleProjectOperationLease(context);
                record.lease = lease;
                await assertSubtitleOperationDurable(context);
                registerPresentation(record, context);
                currentRetryFromCacheRef.current = {
                    start,
                    end,
                    runId: context.runId,
                    presentationToken: record.presentationToken,
                };
                if (canPresent(record, context)) {
                    setStatus({ message: t('output.processingVideo', 'Processing video...'), type: 'loading' });
                }

                const { checkpointBeforeUpdate } = await loadLifecycleOrchestrator();
                await checkpointBeforeUpdate({
                    source: 'segment-processing-start',
                    segment,
                    runId: context.runId,
                    signal: context.signal,
                });
                await assertSubtitleOperationDurable(context);
                revision = await captureDurableSubtitleSegmentRevision({
                    context,
                    validateOwnership: assertSubtitleOperationDurable,
                });

                let resolved = await resolveCachedRetrySource(capturedSource, url, {
                    signal: context.signal,
                    validateOwnership: () => assertSubtitleOperationDurable(context),
                    expectedAssetId: context.assetId,
                });
                await assertSubtitleOperationDurable(context);
                if (!mountedRef.current) throw stoppedError();
                assertResolvedSourceMatches(context, resolved.sourceFile);
                let sourceFile = resolved.sourceFile;
                let usePrimaryFilesApi = resolved.usesOriginalMedia;
                let clipFallbackTried = false;
                let attempt = 0;
                let replacement;

                while (true) {
                    const isLargeClip = !usePrimaryFilesApi
                        && sourceFile?.size > INLINE_LARGE_SEGMENT_THRESHOLD_BYTES;
                    try {
                        replacement = await runOwnedGeminiAttempt({
                            context,
                            controller,
                            sourceFile,
                            options: {
                                ...requestOptions,
                                userProvidedSubtitles: null,
                                forceInline: usePrimaryFilesApi ? false : !isLargeClip,
                                noOffsets: usePrimaryFilesApi ? false : isLargeClip,
                            },
                            t,
                            mountedRef,
                            setStatus,
                            canPresent: () => canPresent(record, context),
                        });
                        break;
                    } catch (error) {
                        if (isSubtitleOperationCancellation(error, context.signal)) throw error;
                        if (isTransientProviderError(error) && attempt < RETRY_DELAYS.length) {
                            const delay = RETRY_DELAYS[attempt];
                            attempt += 1;
                            await assertSubtitleOperationDurable(context);
                            if (canPresent(record, context)) {
                                setStatus({
                                    message: t('output.retryingInSeconds', 'Retrying in {{n}}s...', { n: delay }),
                                    type: 'loading',
                                });
                            }
                            await abortableSubtitleOperationDelay(delay * 1000, context.signal);
                            continue;
                        }
                        if (usePrimaryFilesApi && !clipFallbackTried && !isDesktopRuntime()) {
                            resolved = await resolveCachedRetrySource(null, url, {
                                nativeRuntime: () => false,
                                signal: context.signal,
                                validateOwnership: () => assertSubtitleOperationDurable(context),
                            });
                            await assertSubtitleOperationDurable(context);
                            if (!mountedRef.current) throw stoppedError();
                            sourceFile = resolved.sourceFile;
                            usePrimaryFilesApi = false;
                            clipFallbackTried = true;
                            await assertSubtitleOperationDurable(context);
                            if (canPresent(record, context)) {
                                setStatus({
                                    message: t('output.fallingBack', 'Falling back to clipped-file path...'),
                                    type: 'loading',
                                });
                            }
                            continue;
                        }
                        throw error;
                    }
                }

                const { committedRows, deliveryCommit } = await commitOwnedSegmentReplacement({
                    context,
                    revision,
                    replacement,
                    onCommitted: () => { committed = true; },
                });
                if (canPresent(record, context)) {
                    const applied = await applyOwnedSubtitles({
                        context,
                        mountedRef,
                        setSubtitlesData,
                        subtitles: committedRows,
                    });
                    if (applied && canPresent(record, context)) {
                        publishStreamingComplete({
                            subtitles: committedRows,
                            segment,
                            runId: context.runId,
                        });
                        await publishOwnedEvent(context, mountedRef, EVENTS.RETRY_SEGMENT_FROM_CACHE_COMPLETE, {
                            start,
                            end,
                            success: true,
                            runId: context.runId,
                        });
                        if (canPresent(record, context)) {
                            setStatus(segmentRetryCompletionStatus(deliveryCommit, t));
                        }
                    }
                }
            } catch (error) {
                if (!committed && context && !record.failurePublished
                    && canPresent(record, context, { allowAborted: true })) {
                    try {
                        await publishOwnedEvent(context, mountedRef, EVENTS.RETRY_SEGMENT_FROM_CACHE_COMPLETE, {
                            start,
                            end,
                            success: false,
                            error: FIXED_RETRY_FAILURE,
                            runId: context.runId,
                        }, { allowAborted: true });
                        record.failurePublished = true;
                        if (!isSubtitleOperationCancellation(error, context.signal)
                            && canPresent(record, context, { allowAborted: true })) {
                            setStatus({
                                message: t('errors.segmentRetryFailed', 'Failed to retry segment.'),
                                type: 'error',
                            });
                        }
                    } catch {
                        // Ownership was lost while reporting the failure; discard it.
                    }
                }
            } finally {
                if (mountedRef.current
                    && currentRetryFromCacheRef.current?.runId === context?.runId
                    && currentRetryFromCacheRef.current?.presentationToken
                        === record.presentationToken) {
                    currentRetryFromCacheRef.current = null;
                }
                if (lease) releaseSubtitleProjectOperationLease(lease);
                finishRun({ controller, context, record });
            }
        };

        const unsubscribeRetry = subscribe(EVENTS.RETRY_SEGMENT_FROM_CACHE, cachedHandler);
        const unsubscribeCompletion = subscribe(EVENTS.RETRY_SEGMENT_FROM_CACHE_COMPLETE, (event) => {
            const detail = event?.detail;
            if (detail?.success !== false) return;
            for (const record of activeRef.current.values()) {
                if (record.kind === 'cached'
                    && record.runId === detail.runId
                    && record.start === detail.start && record.end === detail.end) {
                    record.failurePublished = true;
                }
            }
        });
        const unsubscribeAbort = subscribe(EVENTS.GEMINI_REQUESTS_ABORTED, () => {
            for (const controller of activeOperations.keys()) controller.abort();
        });

        return () => {
            mountedRef.current = false;
            unsubscribeRetry();
            unsubscribeCompletion();
            unsubscribeAbort();
            for (const [controller, record] of activeOperations) {
                controller.abort();
                if (record.lease) releaseSubtitleProjectOperationLease(record.lease);
                if (record.context) finishSubtitleOperationContext(record.context);
            }
            activeOperations.clear();
            presentationRuns.clear();
            segmentPresentations.clear();
        };
    }, [canPresent, currentRetryFromCacheRef, currentSourceFileRef, finishRun, registerPresentation, setStatus, setSubtitlesData, t]);

    return { retrySegment };
};
