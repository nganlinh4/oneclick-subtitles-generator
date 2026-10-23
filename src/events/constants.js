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
 * @typedef {Object} ProcessingRangesPayload
 * @property {{start:number,end:number}[]} ranges
 */

export const EVENTS = {
  STREAMING_UPDATE: 'streaming-update',
  STREAMING_COMPLETE: 'streaming-complete',
  PROCESSING_RANGES: 'processing-ranges',
  GEMINI_REQUESTS_ABORTED: 'gemini-requests-aborted',
  VIDEO_ANALYSIS_SETTLED: 'video-analysis-settled'
};

export const CHECKPOINT_SOURCE = Object.freeze({
  AUTO_GENERATION_START: 'auto-generation-start',
  GENERATION_START: 'generation-start',
  SEGMENT_PROCESSING_START: 'segment-processing-start',
  TRANSLATION_START: 'translation-start',
  VIDEO_PROCESSING_COMPLETE: 'video-processing-complete',
});
