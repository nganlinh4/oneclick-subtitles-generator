// Centralized event name constants and payload typedefs

/**
 * @typedef {Object} Segment
 * @property {number} start
 * @property {number} end
 */

/**
 * @typedef {Object} Subtitle
 * @property {number} start
 * @property {number} end
 * @property {string} text
 * @property {string|number} [id]
 */

/**
 * @typedef {Object} StreamingUpdatePayload
 * @property {Subtitle[]} subtitles
 * @property {Segment} segment
 * @property {string} [runId]
 */

/**
 * @typedef {Object} StreamingCompletePayload
 * @property {Subtitle[]} subtitles
 * @property {Segment} segment
 * @property {string} [runId]
 */

/**
 * @typedef {Object} SaveBeforeUpdatePayload
 * @property {('segment-processing-start'|'video-processing-complete')} source
 * @property {Segment} [segment]
 * @property {string} [runId]
 */

/**
 * @typedef {Object} SaveAfterStreamingPayload
 * @property {('streaming-complete')} source
 * @property {Subtitle[]} subtitles
 * @property {Segment} segment
 * @property {string} [runId]
 */

/**
 * @typedef {Object} ProcessingRangesPayload
 * @property {{start:number,end:number}[]} ranges
 */

export const EVENTS = {
  STREAMING_UPDATE: 'streaming-update',
  STREAMING_COMPLETE: 'streaming-complete',
  SAVE_BEFORE_UPDATE: 'save-before-update',
  SAVE_COMPLETE: 'save-complete',
  SAVE_AFTER_STREAMING: 'save-after-streaming',
  PROCESSING_RANGES: 'processing-ranges',
  GEMINI_REQUESTS_ABORTED: 'gemini-requests-aborted',
  RETRY_SEGMENT_FROM_CACHE: 'retry-segment-from-cache',
  RETRY_SEGMENT_FROM_CACHE_COMPLETE: 'retry-segment-from-cache-complete',
  CAPTURE_BEFORE_MERGE: 'capture-before-merge',
  PARALLEL_PROCESSING_PROGRESS: 'parallel-processing-progress',
  SEGMENT_STATUS_UPDATE: 'segmentStatusUpdate'
};
