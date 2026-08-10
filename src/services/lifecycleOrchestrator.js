import { EVENTS } from '../events/constants';
import { publishSaveAfterStreaming, publishSaveBeforeUpdate, subscribe } from '../events/bus';

// Small lifecycle orchestrator to centralize save checkpoints and streaming completion

const CHECKPOINT_SOURCES = new Set(['segment-processing-start', 'video-processing-complete']);
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
 * @param {{ source: 'segment-processing-start'|'video-processing-complete', segment?: {start:number,end:number} }} payload
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
      callback();
    };

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
    try {
      publishSaveBeforeUpdate({ ...payload, checkpointId });
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
