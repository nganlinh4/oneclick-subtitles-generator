import { bindGeminiTranscriptionDeliveries } from '../gemini/transcriptionDelivery';

const MAX_ACTIVE_GEMINI_WINDOWS = 4;

const aborted = (signal) => {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error('Gemini transcription was cancelled.');
  error.name = 'AbortError';
  return error;
};

const waitForLaunchSlot = (milliseconds, signal) => {
  if (signal.aborted) return Promise.reject(aborted(signal));
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(aborted(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
};

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
 * @param {File|{assetId:string,name:string,type:string}} file
 * @param {{start:number,end:number}} segment
 * @param {GeminiOptions} options
 * @param {GeminiHooks} hooks
 * @returns {Promise<Array>} final subtitles for the segment
 */
export const processGeminiSegment = async (file, segment, options, hooks = {}) => {
  const { onStatus, onStreamingUpdate, t } = hooks;
  const [processing, parallel] = await Promise.all([
    import('../../utils/videoProcessing/processingUtils'),
    import('../../utils/parallelProcessingUtils'),
  ]);
  const { processSegmentWithStreaming } = processing;
  const { mergeParallelSubtitles, splitSegmentForParallelProcessing } = parallel;

  const maximum = Number(options?.maxDurationPerRequest);
  const windows = Number.isFinite(maximum) && maximum > 0
    ? splitSegmentForParallelProcessing(segment, maximum)
    : [{ ...segment, index: 0, totalSegments: 1, isParallel: false }];

  if (windows.length === 1) {
    return processSegmentWithStreaming(
      file,
      segment,
      options,
      (status) => onStatus?.(status),
      (subtitles, isStreaming, chunkInfo) => {
        onStreamingUpdate?.(subtitles, isStreaming, chunkInfo);
      },
      t
    );
  }

  // Native Gemini accepts exactly one bounded media asset per job. The old Files-API coordinator
  // disappeared during the native migration, leaving maxDurationPerRequest as a UI-only promise.
  // Coordinate one clipping-aware native job per window here, above each window's independent JSON
  // stream parser, then merge presentation rows and delivery capabilities only at the boundary.
  const ownerSignal = options?.signal;
  const batchController = new AbortController();
  const abortBatch = () => batchController.abort(ownerSignal?.reason);
  if (ownerSignal?.aborted) abortBatch();
  else ownerSignal?.addEventListener?.('abort', abortBatch, { once: true });

  const segmentRows = windows.map(() => []);
  const results = windows.map(() => null);
  let completed = 0;
  const mergedRows = () => mergeParallelSubtitles(windows.map((window, index) => ({
    segment: window,
    subtitles: segmentRows[index],
  })));
  const launchDelayMs = Math.max(0, Number(options?.segmentProcessingDelay) || 0) * 1_000;
  const launchEpoch = Date.now();

  const processWindow = async (window, index) => {
    const scheduledAt = launchEpoch + index * launchDelayMs;
    await waitForLaunchSlot(Math.max(0, scheduledAt - Date.now()), batchController.signal);
    const result = await processSegmentWithStreaming(
      file,
      window,
      {
        ...options,
        // This exact child is already bounded. Leaving the parent maximum attached would let a
        // lower layer silently split it a second time if the implementation changes later.
        maxDurationPerRequest: undefined,
        signal: batchController.signal,
      },
      (status) => onStatus?.(status),
      (subtitles, isStreaming) => {
        if (!Array.isArray(subtitles)) return;
        segmentRows[index] = subtitles;
        onStreamingUpdate?.(mergedRows(), isStreaming || completed < windows.length, {
          segmentIndex: index,
          totalSegments: windows.length,
          actualSegment: window,
        });
      },
      t
    );
    segmentRows[index] = result;
    results[index] = result;
    completed += 1;
    onStreamingUpdate?.(mergedRows(), completed < windows.length, {
      segmentIndex: index,
      totalSegments: windows.length,
      actualSegment: window,
      segmentComplete: true,
    });
  };

  try {
    // Clip creation performs real native decode/encode work. A worker pool prevents an hours-long
    // source from starting dozens of native encoders and provider uploads simultaneously.
    let nextWindow = 0;
    const worker = async () => {
      while (nextWindow < windows.length) {
        const index = nextWindow;
        nextWindow += 1;
        await processWindow(windows[index], index);
      }
    };
    const workerCount = Math.min(MAX_ACTIVE_GEMINI_WINDOWS, windows.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  } catch (error) {
    batchController.abort(error);
    throw error;
  } finally {
    ownerSignal?.removeEventListener?.('abort', abortBatch);
  }

  const finalSubtitles = mergedRows();
  return bindGeminiTranscriptionDeliveries(finalSubtitles, ...results);
};
