// Terminal outcome of a Gemini generation run: the durable commit that alone may publish
// success, and the failure presentation for runs that still own the editor.
import { publishStreamingComplete } from '../events/bus';
import {
    commitDurableSubtitleCheckpoint,
    isDurableSubtitleCheckpointReceipt,
    isSuccessfulSubtitleCacheSaveReceipt,
    requireSuccessfulSubtitleCacheSave,
    saveSubtitlesToCache
} from '../services/subtitleCache';
import { reportKnownGeminiSubtitleError } from '../utils/geminiSubtitleErrors';
import { isSubtitleOperationCancellation } from '../utils/subtitleOperationOwnership';
import {
    assertAutoGenerationContextDurable,
    createAutoGenerationCompletion,
} from '../utils/autoGenerationOwnership';
import { acknowledgeGeminiTranscriptionDeliveries } from '../services/gemini/transcriptionDelivery';
import { subtitleCompletionStatus } from './subtitleCompletionStatus';

/** Returns the auto-run completion, `true` for a manual run, or `false` when nothing was saved. */
export const commitGeminiGeneration = async ({
    subtitles,
    segment,
    requestedSegment,
    cacheId,
    runId,
    speechOnly,
    autoRunContext,
    deliveryContext,
    validateDeliveryOwnership,
    fullMediaStreamingHandler,
    presentation,
    t,
}) => {
    const { canPresent, setGenerationStatus, setGenerationSubtitlesData } = presentation;
    if (autoRunContext) await assertAutoGenerationContextDurable(autoRunContext);
    const hasSubtitles = Array.isArray(subtitles) && subtitles.length > 0;
    const explicitNoSpeech = Array.isArray(subtitles)
        && subtitles.length === 0
        && speechOnly;
    if (!hasSubtitles && !explicitNoSpeech) {
        fullMediaStreamingHandler?.rollback?.();
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
        if (hasSubtitles || explicitNoSpeech) {
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
    fullMediaStreamingHandler?.cancel?.();
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
            segment: segment ?? requestedSegment,
            runId,
        });
    }
    if (completion) return completion;
    return true;
};

/** Presents a failed run's error while it still owns the editor; always resolves `false`. */
export const presentGeminiGenerationFailure = (error, {
    canPresent,
    fullMediaStreamingHandler,
    setGenerationStatus,
    startQuotaCountdown,
    t,
}) => {
    if (!canPresent()) return false;
    fullMediaStreamingHandler?.rollback?.();
    // The stop event already publishes the intentional cancellation notice.
    // Preserve it while finally releases this run's presentation ownership.
    if (isSubtitleOperationCancellation(error)) return false;
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
};
