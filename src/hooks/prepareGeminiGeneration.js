// Gemini generation preparation: resolve and admit the durable project, checkpoint manual edits,
// recover pending deliveries, and serve the cached result when one exists.
import {
    commitDurableSubtitleCheckpoint,
    isDurableSubtitleCheckpointReceipt,
} from '../services/subtitleCache';
import { CHECKPOINT_SOURCE } from '../events/constants';
import {
    assertAutoGenerationContextCurrent,
    assertAutoGenerationContextDurable,
    createAutoGenerationCompletion,
    getAutoGenerationCacheCandidate,
} from '../utils/autoGenerationOwnership';
import { retryPendingGeminiTranscriptionDeliveries } from '../services/gemini/transcriptionDelivery';
import {
    loadExactProjectSubtitles,
    resolveProjectForCache,
} from '../platform/subtitleProjectStore';
import { loadProject } from '../platform/projectService';
import {
    resolveCacheIdForGeneration,
    loadCachedSubtitlesIfAvailable
} from './useSubtitlesCaching';
import { createActiveProjectValidator } from './subtitleGenerationOwnership';

/**
 * Returns `{ cachedResult }` when the run is answered from cache, otherwise the resolved project
 * context, its ownership validator and the provider-admission wrapper. `loadLifecycleOrchestrator`
 * is passed in so the async boundary stays owned by the caller.
 */
export const prepareGeminiGeneration = async ({
    input,
    options,
    segment,
    runId,
    autoRunContext,
    presentation,
    refreshNativeMedia,
    getNativeMediaCapability,
    loadLifecycleOrchestrator,
    t,
}) => {
    const {
        bindDeliveryContext,
        canPresent,
        setGenerationStatus,
        setGenerationSubtitlesData,
    } = presentation;
    let presentationRollbackRows = null;

    const cacheId = await resolveCacheIdForGeneration({ input });
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
        || resolvedProject.projectId !== getNativeMediaCapability().projectId
        || cacheId !== getNativeMediaCapability().cacheId) {
        throw new Error('The subtitle project changed before Gemini transcription.');
    }
    const deliveryContext = bindDeliveryContext(autoRunContext ?? Object.freeze({
        runId,
        cacheId,
        projectId: resolvedProject.projectId,
    }));
    const validateDeliveryOwnership = autoRunContext
        ? assertAutoGenerationContextDurable
        : createActiveProjectValidator({
            canPresent,
            refreshNativeMedia,
            message: 'The active subtitle project changed during Gemini transcription.',
        });
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
    if (!autoRunContext) {
        const { checkpointBeforeUpdate } = await loadLifecycleOrchestrator();
        await checkpointBeforeUpdate({
            source: CHECKPOINT_SOURCE.GENERATION_START,
            runId,
            ...(options.signal ? { signal: options.signal } : {}),
        });
    }
    await validateDeliveryOwnership(deliveryContext);
    const durableRows = await loadExactProjectSubtitles(
        deliveryContext.cacheId,
        deliveryContext.projectId,
    );
    await validateDeliveryOwnership(deliveryContext);
    presentationRollbackRows = durableRows === null ? [] : durableRows;
    if (!Array.isArray(presentationRollbackRows)) {
        throw new Error('The native subtitle project returned an invalid track.');
    }
    const priorDeliveryRecovery = await retryPendingGeminiTranscriptionDeliveries({
        cacheId: deliveryContext.cacheId,
        projectId: deliveryContext.projectId,
        validateOwnership: validateDeliveryOwnership,
    });

    // IMPORTANT: Check cache FIRST and load cached subtitles immediately
    // This ensures the timeline shows cached subtitles right when output container appears
    let cacheHit = false;
    let cachedSubtitles = null;
    if (options.bypassCache !== true && options.engine !== 'gemini-3.5-transcribe') {
        if (autoRunContext && !segment) {
            await assertAutoGenerationContextDurable(autoRunContext);
            const candidate = getAutoGenerationCacheCandidate(autoRunContext);
            cacheHit = candidate.cacheHit;
            cachedSubtitles = candidate.subtitles;
            if (!cacheHit) setGenerationSubtitlesData(null);
        } else {
            await validateDeliveryOwnership(deliveryContext);
            ({ cacheHit, cachedSubtitles } = await loadCachedSubtitlesIfAvailable({
                cacheId,
                segment,
            }));
            await validateDeliveryOwnership(deliveryContext);
            if (cacheHit) {
                setGenerationSubtitlesData(cachedSubtitles);
            } else if (!segment) {
                setGenerationSubtitlesData(null);
            }
        }
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
            return { cachedResult: completion };
        }
        setGenerationStatus({
            message: t('output.subtitlesLoadedFromCache', 'Subtitles loaded from cache!'),
            type: 'success',
            translationKey: 'output.subtitlesLoadedFromCache'
        });
        return { cachedResult: true };
    }
    if (!priorDeliveryRecovery.acknowledged) {
        throw new Error('A saved Gemini transcription is still awaiting native recovery.');
    }

    return {
        cacheId,
        deliveryContext,
        validateDeliveryOwnership,
        withGeminiProjectAdmission,
        presentationRollbackRows,
    };
};
