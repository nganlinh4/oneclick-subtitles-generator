import { useCallback, useRef } from 'react';
import { callGeminiApi, setProcessingForceStopped } from '../services/geminiService';
import { getVideoDuration } from '../utils/videoProcessor';
import { readPreference } from '../platform/preferences/store';
import { resolveCacheIdForGeneration } from './useSubtitlesCaching';
import {
  DEFAULT_TRANSCRIPTION_MODEL_ID,
  normalizeMediaModelId
} from '../config/geminiModels';
import { subtitleCompletionStatus } from './subtitleCompletionStatus';
import { reportKnownGeminiSubtitleError } from '../utils/geminiSubtitleErrors';
import { getEmptySpeechPolicy } from '../services/gemini/promptManagement';
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
import { isSubtitleOperationCancellation } from '../utils/subtitleOperationCancellation';
import { createSubtitleRunId } from './subtitleRunId';

/**
 * retryGeneration extracted from useSubtitles.
 *
 * Re-runs a full generation (non-segment): local media streams through the native Gemini segment
 * runner; a site URL without native media uses the default Gemini call. Shared state setters/refs
 * are threaded via params.
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
        const runId = createSubtitleRunId();
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
            let nativeMediaCapability = await resolveActiveNativeMedia({
                candidate: isNativeMediaDescriptor(input) ? input : null,
            });
            const refreshNativeMedia = async () => {
                nativeMediaCapability = await refreshActiveNativeMedia(nativeMediaCapability);
            };
            const cacheId = await resolveCacheIdForGeneration({ input });
            if (typeof cacheId !== 'string' || cacheId.length === 0) {
                throw new Error('The subtitle project could not be resolved.');
            }
            const project = await resolveProjectForCache(cacheId, { create: true });
            if (!project?.projectId
                || project.projectId !== nativeMediaCapability.projectId
                || cacheId !== nativeMediaCapability.cacheId) {
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

            if (input.type && (input.type.startsWith('video/') || input.type.startsWith('audio/'))) {
                const duration = await getVideoDuration(input);
                const fullSegment = { start: 0, end: duration };
                const fps = options.fps ?? readPreference('video_processing_fps');
                const mediaResolution = options.mediaResolution ?? readPreference('video_processing_media_resolution');
                const model = normalizeMediaModelId(
                    options.modelId ?? options.model ?? readPreference('gemini_model'),
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
                subtitles = await callGeminiApi(input, inputType, await withProjectAdmission({
                    userProvidedSubtitles,
                    runId,
                }));
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
            if (isSubtitleOperationCancellation(error)) return false;

            // Check for specific Gemini API errors
            if (error?.code === 'subtitleCacheSaveFailed') {
                setStatus({
                    message: t(
                        'output.subtitlesCacheSaveFailed',
                        'Subtitles were generated, but they could not be saved.'
                    ),
                    type: 'error'
                });
            } else if (!reportKnownGeminiSubtitleError(error, { t, setStatus })) {
                setStatus({ message: `Error: ${error.message}`, type: 'error' });
            }
            return false;
        } finally {
            setIsGenerating(false);
        }
    }, [t, currentSourceFileRef, setIsGenerating, setStatus, setSubtitlesData]);

    return { retryGeneration };
};
