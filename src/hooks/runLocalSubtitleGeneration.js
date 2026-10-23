// Local (non-Gemini) ASR generation: every local engine runs through runAsrGeneration with its
// registry descriptor (route + capabilities), after its durable project owner is resolved.
import {
    captureDurableSubtitleSegmentRevision,
    commitDurableSubtitleSegmentCheckpoint,
    isDurableSubtitleCheckpointReceipt,
} from '../services/subtitleCache';
import { DESCRIPTORS } from '../services/engines/transcriptionEngineRegistry';
import { isDesktopRuntime } from '../platform/desktopRuntime';
import {
    loadExactProjectSubtitles,
    resolveProjectForCache,
} from '../platform/subtitleProjectStore';
import {
    assertAutoGenerationContextCurrent,
    assertAutoGenerationContextDurable,
} from '../utils/autoGenerationOwnership';
import { resolveCacheIdForGeneration } from './useSubtitlesCaching';
import { runAsrGeneration } from './runAsrGeneration';
import { createActiveProjectValidator } from './subtitleGenerationOwnership';

// Keyed by the registry, so adding an engine is one registry row — no scattered method checks.
const METHOD_RUNNERS = Object.fromEntries(
    DESCRIPTORS.filter((d) => d.type === 'asr').map((d) => [d.id, (ctx) => runAsrGeneration({ ...ctx, engine: d })])
);

export const getLocalSubtitleRunner = (method) => METHOD_RUNNERS[method];

export const runLocalSubtitleGeneration = async ({
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
}) => {
    const {
        canPresent,
        releasePresentation,
        setGenerationStatus,
        setGenerationSubtitlesData,
    } = presentation;
    const requestedSegment = options.segment;
    if (!requestedSegment
        || typeof requestedSegment.start !== 'number'
        || typeof requestedSegment.end !== 'number') {
        setGenerationStatus({
            message: t('errors.invalidSegmentSelection', 'Invalid segment selection'),
            type: 'error',
        });
        setIsGenerating(false);
        releasePresentation();
        return false;
    }
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
        });
        if (autoRunContext) {
            assertAutoGenerationContextCurrent(autoRunContext);
            if (cacheId !== autoRunContext.cacheId) {
                throw new Error('Automatic generation resolved a different subtitle project.');
            }
        }
    } catch (error) {
        setIsGenerating(false);
        releasePresentation();
        throw error;
    }
    let localRunnerStarted = false;
    try {
        await refreshNativeMedia();
        const resolvedLocalProject = await resolveProjectForCache(cacheId, { create: true });
        const localProjectId = getNativeMediaCapability()?.projectId
            ?? resolvedLocalProject?.projectId
            ?? null;
        if (!localProjectId
            || resolvedLocalProject?.projectId !== localProjectId
            || (autoRunContext && localProjectId !== autoRunContext.projectId)) {
            throw new Error('The active subtitle project changed before local transcription.');
        }
        const localContext = Object.freeze({
            runId,
            cacheId,
            projectId: localProjectId,
            segment: Object.freeze({
                start: options.segment.start,
                end: options.segment.end,
            }),
            ...(options.signal ? { signal: options.signal } : {}),
        });
        const validateLocalOwnership = autoRunContext
            ? async (context) => {
                await assertAutoGenerationContextDurable(autoRunContext);
                if (context.cacheId !== autoRunContext.cacheId
                    || context.projectId !== autoRunContext.projectId) {
                    throw new Error('Automatic generation changed subtitle projects.');
                }
                return context;
            }
            : createActiveProjectValidator({
                canPresent,
                refreshNativeMedia,
                getNativeProjectId: () => getNativeMediaCapability()?.projectId,
                message: 'The active subtitle project changed during local transcription.',
            });
        let localRevision = null;
        const captureGeneratedSegment = async () => {
            localRevision = await captureDurableSubtitleSegmentRevision({
                context: localContext,
                validateOwnership: validateLocalOwnership,
            });
            return localRevision;
        };
        const persistGeneratedSegment = async (replacement) => {
            if (localRevision === null) {
                throw new Error('Local subtitles have no captured durable revision.');
            }
            const receipt = await commitDurableSubtitleSegmentCheckpoint({
                context: localContext,
                revision: localRevision,
                replacement,
                validateOwnership: validateLocalOwnership,
            });
            if (!isDurableSubtitleCheckpointReceipt(receipt, localContext)
                || !Array.isArray(receipt.subtitles)) {
                throw new Error('Local subtitles were not durably saved.');
            }
            await refreshNativeMedia();
            return receipt;
        };
        const loadAuthoritativeSubtitles = async () => {
            await validateLocalOwnership(localContext);
            return loadExactProjectSubtitles(cacheId, localProjectId);
        };
        localRunnerStarted = true;
        return await localRunner({
            input,
            options,
            runId,
            setStatus: setGenerationStatus,
            setIsGenerating,
            setSubtitlesData: setGenerationSubtitlesData,
            loadSubtitles: loadAuthoritativeSubtitles,
            captureGeneratedSegment,
            persistGeneratedSegment,
            t
        });
    } finally {
        if (!localRunnerStarted) setIsGenerating(false);
        releasePresentation();
    }
};
