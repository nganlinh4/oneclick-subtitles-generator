// Owned publication for segment retries: row normalization, streaming preview, state and commit.
import { publishStreamingUpdate } from '../events/bus';
import {
    commitDurableSubtitleSegmentCheckpoint,
    isDurableSubtitleCheckpointReceipt,
} from '../services/subtitleCache';
import {
    assertSubtitleOperationCurrent,
    assertSubtitleOperationDurable,
    isSubtitleOperationCurrent,
} from '../utils/subtitleOperationOwnership';
import {
    acknowledgeGeminiTranscriptionDeliveries,
    bindGeminiTranscriptionDeliveries,
} from '../services/gemini/transcriptionDelivery';
import { stoppedError } from './segmentRetrySource';

const is503Error = (error) => !!(error?.message && (
    error.message.includes('503')
    || error.message.includes('overloaded')
    || error.message.includes('UNAVAILABLE')
));

const is429Error = (error) => !!(error?.message && (
    error.message.includes('429')
    || error.message.includes('RESOURCE_EXHAUSTED')
    || error.message.includes('quota')
    || error.message.includes('rate limit')
));

/** Overload (503) and quota/rate (429) failures are retried with backoff. */
export const isTransientProviderError = (error) => is503Error(error) || is429Error(error);

const cloneSubtitles = (value) => (
    Array.isArray(value) ? value.map((subtitle) => ({ ...subtitle })) : []
);

export const normalizeSegmentRows = (rows, segment) => {
    if (!Array.isArray(rows) || rows.length === 0) {
        throw new Error('The segment retry returned no subtitles.');
    }
    const parsed = rows.map((row) => {
        if (!row || !Number.isFinite(row.start) || !Number.isFinite(row.end)
            || row.end <= row.start || typeof row.text !== 'string' || !row.text.trim()) {
            throw new Error('The segment retry returned malformed subtitles.');
        }
        return { ...row, text: row.text };
    });
    const normalized = parsed
        .map((row) => {
            return {
                ...row,
                start: Math.max(row.start, segment.start),
                end: Math.min(row.end, segment.end),
            };
        })
        .filter((row) => row.end > row.start);
    if (normalized.length === 0) {
        throw new Error('The segment retry returned no subtitles in the selected range.');
    }
    return bindGeminiTranscriptionDeliveries(normalized, rows);
};

export const applyOwnedSubtitles = async ({
    context,
    mountedRef,
    setSubtitlesData,
    subtitles = null,
    update = null,
    allowAborted = false,
}) => {
    await assertSubtitleOperationDurable(context, { allowAborted });
    if (!mountedRef.current) return false;
    return new Promise((resolve) => {
        let settled = false;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            context.signal.removeEventListener('abort', handleAbort);
            resolve(value);
        };
        const handleAbort = () => finish(false);
        if (!allowAborted) context.signal.addEventListener('abort', handleAbort, { once: true });
        setSubtitlesData((current) => {
            if (!mountedRef.current
                || !isSubtitleOperationCurrent(context, { allowAborted })) {
                finish(false);
                return current;
            }
            const next = typeof update === 'function'
                ? update(cloneSubtitles(current))
                : cloneSubtitles(subtitles);
            if (!Array.isArray(next)) {
                finish(false);
                return current;
            }
            finish(true);
            return next;
        });
    });
};

export const createOwnedStreamingSession = ({
    context,
    controller,
    mountedRef,
    setStatus,
    canPresent,
    mergeStreamingSubtitles,
    t,
}) => {
    let queue = Promise.resolve();
    let failure = null;
    let previewRows = [];

    const enqueue = (mutation) => {
        queue = queue.then(async () => {
            if (failure) return;
            await assertSubtitleOperationDurable(context);
            if (!mountedRef.current) throw stoppedError();
            await mutation();
        }).catch((error) => {
            if (!failure) failure = error;
            if (!context.signal.aborted) controller.abort(error);
        });
    };

    return Object.freeze({
        onStatus(status) {
            enqueue(() => {
                assertSubtitleOperationCurrent(context);
                if (status?.type !== 'success' && canPresent()) setStatus(status);
            });
        },
        onStreamingUpdate(rows, isStreaming) {
            if (!Array.isArray(rows) || rows.length === 0) return;
            let normalized;
            try {
                normalized = normalizeSegmentRows(rows, context.segment);
            } catch (error) {
                if (!failure) failure = error;
                if (!context.signal.aborted) controller.abort(error);
                return;
            }
            enqueue(() => {
                if (isStreaming && mountedRef.current && canPresent()) {
                    previewRows = mergeStreamingSubtitles(
                        previewRows,
                        normalized,
                        context.segment
                    );
                    publishStreamingUpdate({
                        subtitles: previewRows,
                        segment: context.segment,
                        runId: context.runId,
                    });
                    setStatus({
                        message: t('output.streamingProgress', 'Streaming...'),
                        type: 'loading',
                    });
                }
            });
        },
        async settle(processError = null) {
            await queue;
            if (failure) throw failure;
            if (processError) throw processError;
        },
    });
};

export const publishOwnedEvent = async (context, mountedRef, name, detail, { allowAborted = false } = {}) => {
    await assertSubtitleOperationDurable(context, { allowAborted });
    if (!mountedRef.current) throw stoppedError();
    assertSubtitleOperationCurrent(context, { allowAborted });
    window.dispatchEvent(new CustomEvent(name, { detail }));
};

/**
 * Commit a retry's replacement rows against the captured revision and acknowledge their provider
 * deliveries. `onCommitted` runs once the checkpoint is verified, before acknowledgement.
 */
export const commitOwnedSegmentReplacement = async ({
    context,
    revision,
    replacement,
    onCommitted,
}) => {
    await assertSubtitleOperationDurable(context);
    const receipt = await commitDurableSubtitleSegmentCheckpoint({
        context,
        revision,
        replacement,
        validateOwnership: assertSubtitleOperationDurable,
    });
    if (!isDurableSubtitleCheckpointReceipt(receipt, context)
        || !Array.isArray(receipt.subtitles)
        || receipt.subtitleCount !== receipt.subtitles.length) {
        throw new Error('The segment retry checkpoint could not be verified.');
    }
    const committedRows = bindGeminiTranscriptionDeliveries(
        receipt.subtitles,
        replacement
    );
    onCommitted();
    const deliveryCommit = await acknowledgeGeminiTranscriptionDeliveries({
        rows: committedRows,
        receipt,
        context,
        validateOwnership: assertSubtitleOperationDurable,
    });
    await assertSubtitleOperationDurable(context);
    return { committedRows, deliveryCommit };
};

export const segmentRetryCompletionStatus = (deliveryCommit, t) => (deliveryCommit.acknowledged ? {
    message: t('output.generationSuccess', 'Subtitles updated successfully!'),
    type: 'success',
} : {
    message: t(
        'output.subtitlesDeliveryPending',
        'Subtitles were saved. Native result cleanup will retry automatically.'
    ),
    type: 'warning',
});
