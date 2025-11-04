import { EVENTS } from '../events/constants';
import { publishSaveAfterStreaming, publishSaveBeforeUpdate, subscribe } from '../events/bus';

// Small lifecycle orchestrator to centralize save checkpoints and streaming completion

/**
 * Wait for a save-complete event after publishing save-before-update, with a timeout fallback.
 * @param {{ source: 'segment-processing-start'|'video-processing-complete', segment?: {start:number,end:number} }} payload
 * @param {number} [timeoutMs=1500]
 * @returns {Promise<void>}
 */
export const checkpointBeforeUpdate = async (payload, timeoutMs = 1500) => {
  return new Promise((resolve) => {
    let done = false;
    let unsubscribe = null;
    const onComplete = () => {
      if (!done) {
        done = true;
        if (unsubscribe) unsubscribe();
        resolve();
      }
    };

    try {
      unsubscribe = subscribe(EVENTS.SAVE_COMPLETE, () => onComplete());
    } catch {
      // non-browser environments: resolve after timeout
    }

    // Publish the intent to save current state before updating
  publishSaveBeforeUpdate(payload);

    // Fallback resolve after timeout to avoid hanging
    setTimeout(onComplete, timeoutMs);
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
