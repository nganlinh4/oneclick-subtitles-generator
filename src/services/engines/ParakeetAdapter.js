import { extractSegmentAsWavBase64 } from '../../utils/audioUtils';
import { API_BASE_URL } from '../../config';

/**
 * Process a segment with the local Parakeet ASR service.
 * The adapter focuses on IO and chunking; merging and global state changes are left to the caller via callbacks.
 *
 * @param {File} inputFile
 * @param {{start:number,end:number}} segment
 * @param {{ maxDurationPerRequest?: number, parakeetStrategy?: 'sentence'|'word'|'char', parakeetMaxChars?: number, parakeetMaxWords?: number }} options
 * @param {{
 *  onStatus?: (status:{message:string,type:'loading'|'success'|'error'|'info'})=>void,
 *  onRanges?: (ranges:{start:number,end:number}[])=>void,
 *  onStreamingUpdate?: (subtitles:Array<{start:number,end:number,text:string}>, part:{start:number,end:number})=>void,
 *  onMergeSegment?: (part:{start:number,end:number}, newSegmentSubs:Array<{start:number,end:number,text:string}>)=>Promise<void>|void,
 *  t?: (key:string, defaultValue?:string, options?:object)=>string
 * }} hooks
 */
export const processParakeetSegment = async (inputFile, segment, options = {}, hooks = {}) => {
   const { onStatus, onRanges, onStreamingUpdate, onMergeSegment, t } = hooks;

  // Determine sequential sub-segments
  const windowSec = Math.max(1, Math.floor(options.maxDurationPerRequest || 0));
  let subSegments = [segment];

  try {
    if (windowSec && (segment.end - segment.start) > windowSec) {
      const { splitSegmentForParallelProcessing } = await import('../../utils/parallelProcessingUtils');
      subSegments = splitSegmentForParallelProcessing(segment, windowSec);
    }
  } catch (e) {
    // Fallback slicer
    const total = segment.end - segment.start;
    const n = Math.max(1, Math.ceil(total / Math.max(1, windowSec)));
    subSegments = Array.from({ length: n }).map((_, i) => ({
      start: segment.start + i * (total / n),
      end: i === n - 1 ? segment.end : segment.start + (i + 1) * (total / n)
    }));
  }

  // Notify ranges for UI overlays
  if (onRanges && subSegments.length > 1) {
    try { onRanges(subSegments); } catch {}
  }

  for (let i = 0; i < subSegments.length; i++) {
    const part = subSegments[i];
    onStatus && onStatus({ message: t ? t('processing.transcribingWithParakeet', 'Transcribing with Parakeet ASR ({{current}}/{{total}})...', { current: i + 1, total: subSegments.length }) : `Transcribing with Parakeet ASR (${i + 1}/${subSegments.length})...`, type: 'loading' });

    // Extract audio
    const wavBase64 = await extractSegmentAsWavBase64(inputFile, part.start, part.end);

    // Call Parakeet API
    const resp = await fetch(`${API_BASE_URL}/parakeet/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        audio_base64: wavBase64,
        filename: (inputFile && inputFile.name) || 'segment.wav',
        segment_strategy: options.parakeetStrategy || 'char',
        max_chars: options.parakeetMaxChars || 60,
        max_words: options.parakeetMaxWords || 7
      })
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(t ? t('errors.parakeetApiError', 'Parakeet API error: {{status}} {{errorText}}', { status: resp.status, errorText: errText }) : `Parakeet API error: ${resp.status} ${errText}`);
    }

    const data = await resp.json();
    const segmentSubs = Array.isArray(data?.segments) ? data.segments : [];

    // Offset subtitles back to global timeline
    const offset = part.start || 0;
    const newSegmentSubs = segmentSubs.map(s => ({
      start: (s.start || 0) + offset,
      end: (s.end || 0) + offset,
      text: s.segment || s.text || ''
    }));

    // Notify streaming update
    if (onStreamingUpdate) {
      try { onStreamingUpdate(newSegmentSubs, part); } catch {}
    }

    // Let caller merge into state
    if (onMergeSegment) {
      await onMergeSegment(part, newSegmentSubs);
    }
  }

  // Clear ranges overlay
  if (onRanges) {
    try { onRanges([]); } catch {}
  }

  return true;
};
