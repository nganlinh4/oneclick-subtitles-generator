import { EVENTS } from './constants';

// Simple EventBus wrappers over CustomEvent to centralize names and payloads

/**
 * @template T
 * @param {string} eventName
 * @param {T} detail
 */
export const publish = (eventName, detail) => {
  try {
    window.dispatchEvent(new CustomEvent(eventName, { detail }));
  } catch (e) {
    // no-op in non-browser
  }
};

/**
 * @param {(ev: CustomEvent)=>void} handler
 * @returns {() => void} unsubscribe
 */
export const subscribe = (eventName, handler) => {
  const wrapped = /** @param {Event} e */ (e) => handler(/** @type {CustomEvent} */(e));
  window.addEventListener(eventName, wrapped);
  return () => window.removeEventListener(eventName, wrapped);
};

// Convenience publishers with typed payloads

/**
 * @param {import('./constants').StreamingUpdatePayload} payload
 */
export const publishStreamingUpdate = (payload) => publish(EVENTS.STREAMING_UPDATE, payload);

/**
 * @param {import('./constants').StreamingCompletePayload} payload
 */
export const publishStreamingComplete = (payload) => publish(EVENTS.STREAMING_COMPLETE, payload);

/**
 * @param {import('./constants').SaveBeforeUpdatePayload} payload
 */
export const publishSaveBeforeUpdate = (payload) => publish(EVENTS.SAVE_BEFORE_UPDATE, payload);

/**
 * @param {import('./constants').SaveAfterStreamingPayload} payload
 */
export const publishSaveAfterStreaming = (payload) => publish(EVENTS.SAVE_AFTER_STREAMING, payload);

/**
 * @param {import('./constants').ProcessingRangesPayload} payload
 */
export const publishProcessingRanges = (payload) => publish(EVENTS.PROCESSING_RANGES, payload);

export { EVENTS };
