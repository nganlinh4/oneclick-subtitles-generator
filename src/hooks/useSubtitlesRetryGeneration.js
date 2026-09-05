import { useCallback, useRef } from 'react';
import { callGeminiApi, setProcessingForceStopped } from '../services/geminiService';
import { getVideoDuration, processMediaFile } from '../utils/videoProcessor';
import { getVideoProcessingFps, getMediaResolution } from '../services/configService';
import { fetchBrowserResource } from '../platform/browserFetch';
import { resolveCacheIdForGeneration } from './useSubtitlesCaching';
import {
  DEFAULT_TRANSCRIPTION_MODEL_ID,
  normalizeMediaModelId
} from '../config/geminiModels';
import { subtitleCompletionStatus } from './subtitleCompletionStatus';
import { getEmptySpeechPolicy } from '../services/gemini/promptManagement';
import { isDesktopRuntime } from '../platform/desktopRuntime';
import { getBrowserMediaBlob } from '../platform/browserMediaBlobRegistry';
import { processGeminiSegment } from '../services/engines/GeminiAdapter';
import { createFullMediaStreamingHandler } from './subtitleStreamingHandlers';
import { CHECKPOINT_SOURCE } from '../events/constants';
import {
    acknowledgeGeminiTranscriptionDeliveries,
    retryPendingGeminiTranscriptionDeliveries,
} from '../services/gemini/transcriptionDelivery';
import {
    isSuccessfulSubtitleCacheSaveReceipt,
    requireSuccessfulSubtitleCacheSave,
    saveSubtitlesToCache,
} from '../services/subtitleCache';
import {
    loadExactProjectSubtitles,
    resolveProjectForCache,
} from '../platform/subtitleProjectStore';
import { loadProject } from '../platform/projectService';
import { getCurrentCacheId as getRulesCacheId } from '../utils/transcriptionRulesStore';
import { getCurrentCacheId as getSubtitlesCacheId } from '../utils/userSubtitlesStore';
import {
    refreshActiveNativeMedia,
    resolveActiveNativeMedia,
} from '../platform/activeNativeMedia';
import { isNativeMediaDescriptor } from '../platform/mediaService';

/**
 * retryGeneration extracted from useSubtitles.
 *
 * Re-runs a full generation (non-segment) with the same media-type branching:
 * long media via processMediaFile, YouTube inline-extraction streaming, or the
 * default Gemini API call. Behavior is byte-for-byte identical to the original
 * inline implementation; shared state setters/refs are threaded via params.
 */
export const useSubtitlesRetryGeneration = ({
    t,
    setStatus,
    setIsGenerating,
    setSubtitlesData,
    currentSourceFileRef
}) => {
    const generationEpochRef = useRef(0);
    const retryGeneration = useCallback(async (input, inputType, apiKeysSet, options = {}) => {
        const generationEpoch = generationEpochRef.current + 1;
        generationEpochRef.current = generationEpoch;
        const ownsGeneration = () => generationEpochRef.current === generationEpoch;
        const runId = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : Math.random().toString(36).slice(2, 10);
        // Extract options
        const { userProvidedSubtitles } = options;
        const speechOnly = getEmptySpeechPolicy(
            input?.type?.startsWith('audio/') ? 'audio' : 'video',
            userProvidedSubtitles
        ) === 'provenSilence';
        if (!apiKeysSet.gemini) {
            setStatus({ message: t('errors.apiKeyRequired'), type: 'error' });
            return false;
        }

        // Reset the force stop flag when retrying generation
        setProcessingForceStopped(false);

        setIsGenerating(true);
        setStatus({ message: 'Retrying request to Gemini. This may take a few minutes...', type: 'loading' });

        let streamingHandler = null;
        try {
            let nativeMediaCapability = isDesktopRuntime()
                ? await resolveActiveNativeMedia({
                    candidate: isNativeMediaDescriptor(input) ? input : null,
                })
                : null;
            const refreshNativeMedia = async () => {
                if (nativeMediaCapability !== null) {
                    nativeMediaCapability = await refreshActiveNativeMedia(nativeMediaCapability);
                }
            };
            const cacheId = await resolveCacheIdForGeneration({
                input,
                inputType,
                currentVideoUrl: !isDesktopRuntime() && inputType === 'youtube'
                    ? (typeof input === 'string' ? input : input?.url ?? null)
                    : null,
                t,
                setStatus,
            });
            if (typeof cacheId !== 'string' || cacheId.length === 0) {
                throw new Error('The subtitle project could not be resolved.');
            }
            const project = await resolveProjectForCache(cacheId, { create: true });
            if (!project?.projectId
                || (nativeMediaCapability
                    && (project.projectId !== nativeMediaCapability.projectId
                        || cacheId !== nativeMediaCapability.cacheId))) {
                throw new Error('The subtitle project could not be resolved.');
            }
            const deliveryContext = Object.freeze({
                runId,
                cacheId,
                projectId: project.projectId,
            });
            const validateOwnership = async (context) => {
                await refreshNativeMedia();
                if (!ownsGeneration()
                    || getRulesCacheId() !== context.cacheId
                    || getSubtitlesCacheId() !== context.cacheId) {
                    throw new Error('The active subtitle project changed during Gemini retry.');
                }
                await loadExactProjectSubtitles(context.cacheId, context.projectId);
                await refreshNativeMedia();
                if (!ownsGeneration()
                    || getRulesCacheId() !== context.cacheId
                    || getSubtitlesCacheId() !== context.cacheId) {
                    throw new Error('The active subtitle project changed during Gemini retry.');
                }
                return context;
            };
            const withProjectAdmission = async (providerOptions) => {
                await validateOwnership(deliveryContext);
                const snapshot = await loadProject(deliveryContext.projectId);
                await validateOwnership(deliveryContext);
                if (snapshot?.metadata?.id !== deliveryContext.projectId
                    || !Number.isSafeInteger(snapshot.stateVersion)) {
                    throw new Error('The subtitle project could not authorize Gemini retry.');
                }
                return {
                    ...providerOptions,
                    projectId: deliveryContext.projectId,
                    expectedProjectStateVersion: snapshot.stateVersion,
                };
            };
            const { checkpointBeforeUpdate } = await import('../services/lifecycleOrchestrator');
            await checkpointBeforeUpdate({
                source: CHECKPOINT_SOURCE.GENERATION_START,
                runId,
                ...(options.signal ? { signal: options.signal } : {}),
            });
            await validateOwnership(deliveryContext);
            const loadedRows = await loadExactProjectSubtitles(
                deliveryContext.cacheId,
                deliveryContext.projectId,
            );
            await validateOwnership(deliveryContext);
            const rollbackRows = loadedRows === null ? [] : loadedRows;
            if (!Array.isArray(rollbackRows)) {
                throw new Error('The native subtitle project returned an invalid track.');
            }
            streamingHandler = createFullMediaStreamingHandler(
                setSubtitlesData,
                setStatus,
                t,
                { rollbackRows },
            );
            const priorDeliveryRecovery = await retryPendingGeminiTranscriptionDeliveries({
                cacheId: deliveryContext.cacheId,
                projectId: deliveryContext.projectId,
                validateOwnership,
            });
            if (!priorDeliveryRecovery.acknowledged) {
                throw new Error('A saved Gemini transcription is still awaiting native recovery.');
            }
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


                    if (isDesktopRuntime()) {
                        const fullSegment = { start: 0, end: duration };
                        const fps = options.fps ?? getVideoProcessingFps();
                        const mediaResolution = options.mediaResolution ?? getMediaResolution();
                        const model = normalizeMediaModelId(
                            options.modelId ?? options.model ?? localStorage.getItem('gemini_model'),
                            DEFAULT_TRANSCRIPTION_MODEL_ID
                        );
                        currentSourceFileRef.current = input;
                        subtitles = await processGeminiSegment(
                            input,
                            fullSegment,
                            await withProjectAdmission({
                                fps,
                                audioOnly: options.audioOnly === true,
                                mediaResolution,
                                model,
                                userProvidedSubtitles,
                                maxDurationPerRequest: options.maxDurationPerRequest,
                                autoSplitSubtitles: options.autoSplitSubtitles,
                                maxWordsPerSubtitle: options.maxWordsPerSubtitle,
                                forceInline: options.inlineExtraction === true,
                                runId
                            }),
                            {
                                onStatus: setStatus,
                                onStreamingUpdate: streamingHandler,
                                t
                            }
                        );
                    } else {
                        // Preserve the browser workflow for the legacy hosted build.
                        subtitles = await processMediaFile(input, setStatus, t, { userProvidedSubtitles });
                    }
                } catch (error) {
                    if (isDesktopRuntime()) throw error;
                    // Fallback to normal processing (respect inlineExtraction for non-YouTube)
                    const forceInline = options.inlineExtraction === true && inputType !== 'youtube';
                    subtitles = await callGeminiApi(input, inputType, await withProjectAdmission({
                        userProvidedSubtitles,
                        ...(forceInline ? { forceInline: true } : {}),
                        runId,
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
                    } catch {
                        // The loaded browser blob is optional; the normal provider path remains.
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
                        const model = normalizeMediaModelId(
                            options.model ?? localStorage.getItem('gemini_model'),
                            DEFAULT_TRANSCRIPTION_MODEL_ID
                        );

                        subtitles = await processGeminiSegment(
                            ytFile,
                            fullSegment,
                            await withProjectAdmission({
                                fps,
                                audioOnly: options.audioOnly === true,
                                mediaResolution,
                                model,
                                userProvidedSubtitles,
                                maxDurationPerRequest: options.maxDurationPerRequest,
                                autoSplitSubtitles: options.autoSplitSubtitles,
                                maxWordsPerSubtitle: options.maxWordsPerSubtitle,
                                forceInline: true,
                                runId
                            }),
                            { onStatus: setStatus, onStreamingUpdate: streamingHandler, t }
                        );
                    } else {
                        // Fallback: proceed without forcing inline (no re-download)
                        subtitles = await callGeminiApi(input, inputType, await withProjectAdmission({
                            userProvidedSubtitles,
                            runId,
                        }));
                    }
                } else {
                    // Default YouTube path
                    subtitles = await callGeminiApi(input, inputType, await withProjectAdmission({
                        userProvidedSubtitles,
                        runId,
                    }));
                }
            }

            const hasSubtitles = Array.isArray(subtitles) && subtitles.length > 0;
            const explicitNoSpeech = Array.isArray(subtitles)
                && subtitles.length === 0
                && speechOnly;
            if (!hasSubtitles && !explicitNoSpeech) {
                throw new Error('Gemini retry returned no valid subtitles.');
            }
            await validateOwnership(deliveryContext);
            const receipt = await saveSubtitlesToCache(cacheId, subtitles, {
                expectedProjectId: deliveryContext.projectId,
            });
            requireSuccessfulSubtitleCacheSave(receipt);
            if (!isSuccessfulSubtitleCacheSaveReceipt(receipt)
                || receipt.subtitleCount !== subtitles.length) {
                throw new Error('The Gemini retry checkpoint could not be verified.');
            }
            await validateOwnership(deliveryContext);
            const deliveryCommit = await acknowledgeGeminiTranscriptionDeliveries({
                rows: subtitles,
                receipt,
                context: deliveryContext,
                validateOwnership,
            });
            await validateOwnership(deliveryContext);
            streamingHandler?.cancel();
            setSubtitlesData(subtitles);
            setStatus(deliveryCommit.acknowledged
                ? subtitleCompletionStatus(subtitles, t, { speechOnly })
                : {
                    message: t(
                        'output.subtitlesDeliveryPending',
                        'Subtitles were saved. Native result cleanup will retry automatically.'
                    ),
                    type: 'warning',
                });
            return true;
        } catch (error) {
            streamingHandler?.rollback?.();

            // Check for specific Gemini API errors
            if (error?.code === 'subtitleCacheSaveFailed') {
                setStatus({
                    message: t(
                        'output.subtitlesCacheSaveFailed',
                        'Subtitles were generated, but they could not be saved.'
                    ),
                    type: 'error'
                });
            } else if (error.message && (
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
    }, [t, currentSourceFileRef, setIsGenerating, setStatus, setSubtitlesData]);

    return { retryGeneration };
};
