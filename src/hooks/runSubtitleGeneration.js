// One subtitle generation run behind useSubtitles.generateSubtitles: run-owned presentation,
// active native media, then the local-engine or Gemini path and its commit/failure outcome.
import { setProcessingForceStopped } from '../services/geminiService';
import { LOCAL_METHOD_IDS } from '../services/engines/transcriptionEngineRegistry';
import { getEmptySpeechPolicy } from '../services/gemini/promptManagement';
import {
    refreshActiveNativeMedia,
    resolveActiveNativeMedia,
} from '../platform/activeNativeMedia';
import { isNativeMediaDescriptor } from '../platform/mediaService';
import {
    assertAutoGenerationContextCurrent,
    isAutoGenerationContext
} from '../utils/autoGenerationOwnership';
import { createSubtitleRunId } from './subtitleRunId';
import { createGenerationPresentation } from './subtitleGenerationOwnership';
import { getLocalSubtitleRunner, runLocalSubtitleGeneration } from './runLocalSubtitleGeneration';
import { prepareGeminiGeneration } from './prepareGeminiGeneration';
import { commitGeminiGeneration, presentGeminiGenerationFailure } from './geminiGenerationOutcome';
import { runGeminiTranscription } from './runGeminiTranscription';

const LOCAL_METHODS = new Set(LOCAL_METHOD_IDS);

// Resolves the active native media once and keeps it refreshable for later ownership checks.
const bindActiveNativeMedia = async (input, autoRunContext) => {
    let nativeMediaCapability = await resolveActiveNativeMedia({
        candidate: isNativeMediaDescriptor(input) ? input : null,
    });
    if (autoRunContext
        && (nativeMediaCapability.cacheId !== autoRunContext.cacheId
            || nativeMediaCapability.projectId !== autoRunContext.projectId)) {
        throw new Error('Automatic generation resolved different active native media.');
    }
    return {
        refreshNativeMedia: async () => {
            nativeMediaCapability = await refreshActiveNativeMedia(nativeMediaCapability);
            return nativeMediaCapability;
        },
        getNativeMediaCapability: () => nativeMediaCapability,
    };
};

/**
 * @param {object} deps hook-owned state and services
 * @param {Function} deps.t
 * @param {Function} deps.setStatus
 * @param {Function} deps.setSubtitlesData
 * @param {Function} deps.setIsGenerating
 * @param {Function} deps.startQuotaCountdown
 * @param {{ current: * }} deps.generationPresentationOwnerRef
 * @param {{ current: * }} deps.currentSourceFileRef
 * @param {Function} deps.loadLifecycleOrchestrator
 * @returns {Promise<boolean>} whether the run produced and committed subtitles
 */
export const runSubtitleGeneration = async (deps, input, inputType, apiKeysSet, options = {}) => {
    const { t, setIsGenerating } = deps;
    const runId = createSubtitleRunId();
    const autoRunContext = isAutoGenerationContext(options.autoRunContext)
        ? options.autoRunContext
        : null;
    const presentation = createGenerationPresentation({
        runId,
        autoRunContext,
        ownerRef: deps.generationPresentationOwnerRef,
        setStatus: deps.setStatus,
        setSubtitlesData: deps.setSubtitlesData,
    });
    const { ownsPresentation, releasePresentation, setGenerationStatus } = presentation;
    if (autoRunContext) {
        assertAutoGenerationContextCurrent(autoRunContext);
        if (input !== autoRunContext.media) {
            throw new Error('Automatic generation media ownership was lost.');
        }
    }
    const { refreshNativeMedia, getNativeMediaCapability } = await bindActiveNativeMedia(
        input,
        autoRunContext
    );
    const speechOnly = getEmptySpeechPolicy(
        input?.type?.startsWith('audio/') ? 'audio' : 'video',
        options.userProvidedSubtitles,
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

    const streaming = { handler: null };
    try {
        const prepared = await prepareGeminiGeneration({
            input,
            options,
            segment: options.segment,
            runId,
            autoRunContext,
            presentation,
            refreshNativeMedia,
            getNativeMediaCapability,
            loadLifecycleOrchestrator: deps.loadLifecycleOrchestrator,
            t,
        });
        if (prepared.cachedResult !== undefined) return prepared.cachedResult;

        const subtitles = await runGeminiTranscription({
            input,
            inputType,
            options,
            runId,
            autoRunContext,
            prepared,
            presentation,
            currentSourceFileRef: deps.currentSourceFileRef,
            streaming,
            t,
        });

        return await commitGeminiGeneration({
            subtitles,
            segment: options.segment,
            requestedSegment: options.requestedSegment,
            cacheId: prepared.cacheId,
            runId,
            speechOnly,
            autoRunContext,
            deliveryContext: prepared.deliveryContext,
            validateDeliveryOwnership: prepared.validateDeliveryOwnership,
            fullMediaStreamingHandler: streaming.handler,
            presentation,
            t,
        });
    } catch (error) {
        return presentGeminiGenerationFailure(error, {
            canPresent: presentation.canPresent,
            fullMediaStreamingHandler: streaming.handler,
            setGenerationStatus,
            startQuotaCountdown: deps.startQuotaCountdown,
            t,
        });
    } finally {
        streaming.handler?.cancel?.();
        if (ownsPresentation()) {
            releasePresentation();
            setIsGenerating(false);
        }
    }
};
