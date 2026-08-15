import { CHECKPOINT_SOURCE, EVENTS } from '../events/constants';
import { publishSaveAfterStreaming, publishSaveBeforeUpdate, subscribe } from '../events/bus';

// Small lifecycle orchestrator to centralize save checkpoints and streaming completion

const CHECKPOINT_SOURCES = new Set([
  CHECKPOINT_SOURCE.AUTO_GENERATION_START,
  CHECKPOINT_SOURCE.SEGMENT_PROCESSING_START,
  CHECKPOINT_SOURCE.TRANSLATION_START,
  CHECKPOINT_SOURCE.VIDEO_PROCESSING_COMPLETE,
]);
const MAX_CHECKPOINT_TIMEOUT_MS = 60_000;
const CHECKPOINT_SEQUENCE_MODULUS = 36 ** 6;
const CHECKPOINT_TIME_MODULUS = 36 ** 10;
export const CHECKPOINT_TIMEOUT_MS = 15_000;
let checkpointSequence = 0;

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

const nextCheckpointId = () => {
  checkpointSequence = (checkpointSequence + 1) % CHECKPOINT_SEQUENCE_MODULUS;
  const timestamp = (Date.now() % CHECKPOINT_TIME_MODULUS).toString(36).padStart(10, '0');
  const sequence = checkpointSequence.toString(36).padStart(6, '0');
  return `checkpoint-${timestamp}-${sequence}`;
};

/**
 * Wait for the matching successful save-complete event after publishing save-before-update.
 * @param {{ source: 'auto-generation-start'|'segment-processing-start'|'translation-start'|'video-processing-complete', segment?: {start:number,end:number}, signal?: AbortSignal }} payload
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

  const checkpointId = nextCheckpointId();
  return new Promise((resolve, reject) => {
    let done = false;
    let unsubscribe = null;
    let timeout = null;
    const finish = (callback) => {
      if (done) return;
      done = true;
      if (timeout !== null) clearTimeout(timeout);
      unsubscribe?.();
      signal?.removeEventListener?.('abort', handleAbort);
      callback();
    };
    const handleAbort = () => finish(() => reject(aborted()));

    try {
      unsubscribe = subscribe(EVENTS.SAVE_COMPLETE, (event) => {
        const detail = event.detail;
        if (detail?.source !== payload.source || detail?.checkpointId !== checkpointId) return;
        if (detail.success === true) {
          finish(resolve);
          return;
        }
        finish(() => reject(new CheckpointBeforeUpdateError('checkpointSaveFailed')));
      });
    } catch {
      reject(new CheckpointBeforeUpdateError('checkpointSaveFailed'));
      return;
    }

    timeout = setTimeout(() => {
      finish(() => reject(new CheckpointBeforeUpdateError('checkpointSaveTimedOut')));
    }, timeoutMs);
    signal?.addEventListener?.('abort', handleAbort, { once: true });
    try {
      const { signal: _signal, ...eventPayload } = payload;
      publishSaveBeforeUpdate({ ...eventPayload, checkpointId });
    } catch {
      finish(() => reject(new CheckpointBeforeUpdateError('checkpointSaveFailed')));
    }
  });
};

/**
 * Publish capture-before-merge event (helper if needed elsewhere)
 * @param {{ segment:{start:number,end:number}, subtitles?: any[] }} payload
 */
export const publishCaptureBeforeMerge = (payload) => {
  try {
    window.dispatchEvent(new CustomEvent(EVENTS.CAPTURE_BEFORE_MERGE, { detail: payload }));
  } catch {
    // ignore in non-browser
  }
};

/**
 * Auto-trigger save-after-streaming with a small delay so UI can settle.
 * @param {{ subtitles:any[], segment:{start:number,end:number}, delayMs?:number }} params
 */
export const autoSaveAfterStreaming = ({ subtitles, segment, delayMs = 500, runId }) => {
  if (!subtitles || !Array.isArray(subtitles) || subtitles.length === 0) return;
  setTimeout(() => {
    publishSaveAfterStreaming({ source: 'streaming-complete', subtitles, segment, runId });
  }, delayMs);
};
