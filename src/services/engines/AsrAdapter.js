import { startAsrJob } from '../../platform/asrService';
import {
  createRequestController,
  removeRequestController,
} from '../gemini/requestManagement';

const createAbortError = () => {
  const error = new Error('ASR transcription was cancelled');
  error.name = 'AbortError';
  error.code = 'asrCancelled';
  return error;
};

const createNativeJobError = (payload) => {
  const error = new Error(payload?.message || 'Native ASR transcription failed');
  error.name = 'AsrJobError';
  error.code = payload?.code || 'asrFailed';
  return error;
};

const runNativePart = (engineId, part, options, signal) => new Promise((resolve, reject) => {
  let settled = false;
  const onAbort = () => settle(reject, createAbortError());
  const settle = (callback, value) => {
    if (settled) return;
    settled = true;
    signal.removeEventListener('abort', onAbort);
    callback(value);
  };

  if (signal.aborted) {
    settle(reject, createAbortError());
    return;
  }
  signal.addEventListener('abort', onAbort, { once: true });

  const language = options.asrLanguage && options.asrLanguage !== 'auto'
    ? options.asrLanguage
    : undefined;
  const request = {
    engine: engineId,
    strategy: options.asrStrategy || 'sentence',
    maxCharacters: options.asrMaxChars ?? 60,
    maxWords: options.asrMaxWords ?? 7,
    pauseThresholdMs: 800,
    language,
    range: { start: part.start, end: part.end },
  };

  startAsrJob(request, {
    onCompleted: (event) => settle(resolve, event),
    onCancelled: () => settle(reject, createAbortError()),
    onFailed: (event) => settle(reject, createNativeJobError(event.error)),
    onProtocolError: (error) => settle(reject, error),
    onCancellationError: (error) => settle(reject, error),
  }, { signal }).catch((error) => settle(reject, error));
});

/**
 * Native local-ASR adapter for every catalog engine. Media stays in the privileged desktop session;
 * only the engine, bounded options, and timeline range cross IPC. Merging and global state changes
 * remain with the caller through callbacks.
 *
 * @param {{id:string,name?:string,labelDefault?:string,route?:string}|string} engine
 */
export const processAsrSegment = async (engine, _inputFile, segment, options = {}, hooks = {}) => {
  const { onStatus, onRanges, onStreamingUpdate, onMergeSegment, t } = hooks;
  const engineId = typeof engine === 'string' ? engine : engine.id;
  const engineName = (typeof engine === 'object' && (engine.name || engine.labelDefault)) || engineId;
  const { requestId, signal } = createRequestController();

  try {
    // Split the segment into sequential windows (same slicer as Parakeet).
    const windowSec = Math.max(1, Math.floor(options.maxDurationPerRequest || 0));
    let subSegments = [segment];
    try {
      if (windowSec && (segment.end - segment.start) > windowSec) {
        const { splitSegmentForParallelProcessing } = await import('../../utils/parallelProcessingUtils');
        subSegments = splitSegmentForParallelProcessing(segment, windowSec);
      }
    } catch (e) {
      const total = segment.end - segment.start;
      const n = Math.max(1, Math.ceil(total / Math.max(1, windowSec)));
      subSegments = Array.from({ length: n }).map((_, i) => ({
        start: segment.start + i * (total / n),
        end: i === n - 1 ? segment.end : segment.start + (i + 1) * (total / n),
      }));
    }

    if (onRanges && subSegments.length > 1) {
      try { onRanges(subSegments); } catch { /* isolate consumer callbacks */ }
    }

    for (let i = 0; i < subSegments.length; i++) {
      if (signal.aborted) throw createAbortError();
      const part = subSegments[i];
      onStatus && onStatus({
        message: t
          ? t('processing.transcribingWithEngine', 'Transcribing with {{engine}} ({{current}}/{{total}})...', { engine: engineName, current: i + 1, total: subSegments.length })
          : `Transcribing with ${engineName} (${i + 1}/${subSegments.length})...`,
        type: 'loading',
      });

      const event = await runNativePart(engineId, part, options, signal);
      const offset = event.timelineOffsetMs / 1_000;
      const newSegmentSubs = event.transcription.segments.map((item) => ({
        start: item.startMs / 1_000 + offset,
        end: item.endMs / 1_000 + offset,
        text: item.text,
      }));

      if (onStreamingUpdate) {
        try { onStreamingUpdate(newSegmentSubs, part); } catch { /* isolate consumer callbacks */ }
      }
      if (onMergeSegment) { await onMergeSegment(part, newSegmentSubs); }
    }
  } finally {
    removeRequestController(requestId);
    if (onRanges) {
      try { onRanges([]); } catch { /* isolate consumer callbacks */ }
    }
  }
  return true;
};
