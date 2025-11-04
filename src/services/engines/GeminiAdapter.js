// GeminiAdapter: thin adapter over processSegmentWithStreaming

/**
 * @typedef {{
 *  fps?: number,
 *  mediaResolution?: string,
 *  model?: string,
 *  userProvidedSubtitles?: string,
 *  maxDurationPerRequest?: number,
 *  autoSplitSubtitles?: boolean,
 *  maxWordsPerSubtitle?: number,
 *  forceInline?: boolean,
 *  noOffsets?: boolean
 * }} GeminiOptions
 */

/**
 * @typedef {{
 *  onStatus?: (s:{message:string,type:'loading'|'success'|'warning'|'error'|'info'})=>void,
 *  onStreamingUpdate?: (subs:Array<{start:number,end:number,text:string}>, isStreaming:boolean)=>void,
 *  t?: Function
 * }} GeminiHooks
 */

/**
 * Process a specific segment using Gemini streaming pipeline.
 * Delegates to processSegmentWithStreaming and forwards updates.
 *
 * @param {File} file
 * @param {{start:number,end:number}} segment
 * @param {GeminiOptions} options
 * @param {GeminiHooks} hooks
 * @returns {Promise<Array>} final subtitles for the segment
 */
export const processGeminiSegment = async (file, segment, options, hooks = {}) => {
  const { onStatus, onStreamingUpdate, t } = hooks;
  const { processSegmentWithStreaming } = await import('../../utils/videoProcessing/processingUtils');

  const finalSubtitles = await processSegmentWithStreaming(
    file,
    segment,
    options,
    (s) => onStatus && onStatus(s),
    (subs, isStreaming, chunkInfo) => {
      onStreamingUpdate && onStreamingUpdate(subs, isStreaming, chunkInfo);
    },
    t
  );

  return finalSubtitles;
};
