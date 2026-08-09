import { extractSegmentAsWavBase64 } from '../../utils/audioUtils';
import { API_BASE_URL } from '../../config';

/**
 * Generic local-ASR-engine adapter for EVERY local engine (Parakeet + the catalog engines). Same
 * IO/chunking contract, parameterized by the engine descriptor: it POSTs to /api/<route>/transcribe
 * where route is 'parakeet' or 'asr/<id>'. Merging and global state changes stay with the caller via
 * callbacks. A forced language (when the engine supports it) is sent as `language`.
 *
 * @param {{id:string,name?:string,labelDefault?:string,route?:string}|string} engine
 */
export const processAsrSegment = async (engine, inputFile, segment, options = {}, hooks = {}) => {
  const { onStatus, onRanges, onStreamingUpdate, onMergeSegment, t } = hooks;
  const engineId = typeof engine === 'string' ? engine : engine.id;
  const engineName = (typeof engine === 'object' && (engine.name || engine.labelDefault)) || engineId;
  const route = (typeof engine === 'object' && engine.route) || `asr/${engineId}`;
  const language = options.asrLanguage && options.asrLanguage !== 'auto' ? options.asrLanguage : undefined;

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

  if (onRanges && subSegments.length > 1) { try { onRanges(subSegments); } catch {} }

  for (let i = 0; i < subSegments.length; i++) {
    const part = subSegments[i];
    onStatus && onStatus({
      message: t
        ? t('processing.transcribingWithEngine', 'Transcribing with {{engine}} ({{current}}/{{total}})...', { engine: engineName, current: i + 1, total: subSegments.length })
        : `Transcribing with ${engineName} (${i + 1}/${subSegments.length})...`,
      type: 'loading',
    });

    const wavBase64 = await extractSegmentAsWavBase64(inputFile, part.start, part.end);

    const resp = await fetch(`${API_BASE_URL}/${route}/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        audio_base64: wavBase64,
        filename: (inputFile && inputFile.name) || 'segment.wav',
        segment_strategy: options.asrStrategy || 'sentence',
        max_chars: options.asrMaxChars || 60,
        max_words: options.asrMaxWords || 7,
        ...(language ? { language } : {}),
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(t
        ? t('errors.asrApiError', '{{engine}} API error: {{status}} {{errorText}}', { engine: engineName, status: resp.status, errorText: errText })
        : `${engineName} API error: ${resp.status} ${errText}`);
    }

    const data = await resp.json();
    const segmentSubs = Array.isArray(data?.segments) ? data.segments : [];

    // Offset the segment-local times back onto the global timeline.
    const offset = part.start || 0;
    const newSegmentSubs = segmentSubs.map((s) => ({
      start: (s.start || 0) + offset,
      end: (s.end || 0) + offset,
      text: s.segment || s.text || '',
    }));

    if (onStreamingUpdate) { try { onStreamingUpdate(newSegmentSubs, part); } catch {} }
    if (onMergeSegment) { await onMergeSegment(part, newSegmentSubs); }
  }

  if (onRanges) { try { onRanges([]); } catch {} }
  return true;
};
