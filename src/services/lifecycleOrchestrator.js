import { CHECKPOINT_SOURCE } from '../events/constants';
import { flushDurableLyricsHistory } from '../platform/durableLyricsCheckpoint';

// Centralizes the durable save checkpoint taken before generated subtitles replace the editor's.

const CHECKPOINT_SOURCES = new Set([
  CHECKPOINT_SOURCE.AUTO_GENERATION_START,
  CHECKPOINT_SOURCE.GENERATION_START,
  CHECKPOINT_SOURCE.SEGMENT_PROCESSING_START,
  CHECKPOINT_SOURCE.TRANSLATION_START,
  CHECKPOINT_SOURCE.VIDEO_PROCESSING_COMPLETE,
]);
const MAX_CHECKPOINT_TIMEOUT_MS = 60_000;
export const CHECKPOINT_TIMEOUT_MS = 15_000;

export class CheckpointBeforeUpdateError extends Error {
  constructor(code) {
    const message = code === 'checkpointSaveTimedOut'
      ? 'The subtitle checkpoint did not complete in time'
      : 'The subtitle checkpoint could not be saved';
    super(message);
    this.name = 'CheckpointBeforeUpdateError';
    this.code = code;
  }
}

/**
 * Flush the durable editor-history owner before an update replaces the subtitles.
 * @param {{ source: 'auto-generation-start'|'generation-start'|'segment-processing-start'|'translation-start'|'video-processing-complete', segment?: {start:number,end:number}, signal?: AbortSignal }} payload
 * @param {number} [timeoutMs=CHECKPOINT_TIMEOUT_MS]
 * @returns {Promise<void>}
 */
export const checkpointBeforeUpdate = (payload, timeoutMs = CHECKPOINT_TIMEOUT_MS) => {
  if (!payload || !CHECKPOINT_SOURCES.has(payload.source)) {
    throw new TypeError('A valid subtitle checkpoint source is required');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1
      || timeoutMs > MAX_CHECKPOINT_TIMEOUT_MS) {
    throw new TypeError('A valid subtitle checkpoint timeout is required');
  }
  const signal = payload.signal;
  if (signal !== undefined && (
    !signal
    || typeof signal.aborted !== 'boolean'
    || typeof signal.addEventListener !== 'function'
  )) {
    throw new TypeError('A valid subtitle checkpoint AbortSignal is required');
  }

  const aborted = () => {
    const error = new Error('The subtitle checkpoint was cancelled');
    error.name = 'AbortError';
    error.code = 'autoGenerationAborted';
    return error;
  };
  if (signal?.aborted) return Promise.reject(aborted());

  // Subtitle edits are already mirrored by the durable editor-history owner. Flush that owner
  // directly instead of asking whichever React component happens to be mounted to save a second,
  // potentially stale copy of `lyrics`.
  return new Promise((resolve, reject) => {
    let done = false;
    let timeout = null;
    const finish = (callback) => {
      if (done) return;
      done = true;
      if (timeout !== null) clearTimeout(timeout);
      signal?.removeEventListener?.('abort', handleAbort);
      callback();
    };
    const handleAbort = () => finish(() => reject(aborted()));
    timeout = setTimeout(() => {
      finish(() => reject(new CheckpointBeforeUpdateError('checkpointSaveTimedOut')));
    }, timeoutMs);
    signal?.addEventListener?.('abort', handleAbort, { once: true });
    Promise.resolve()
      .then(() => flushDurableLyricsHistory())
      .then(
        () => finish(resolve),
        () => finish(() => reject(new CheckpointBeforeUpdateError('checkpointSaveFailed')))
      );
  });
};
