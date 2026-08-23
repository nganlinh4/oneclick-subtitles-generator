import { mergeSegmentSubtitles } from '../utils/subtitle/subtitleMerger';
import { publishProcessingRanges, publishStreamingUpdate, publishStreamingComplete } from '../events/bus';
import { processAsrSegment } from '../services/engines/AsrAdapter';
import { acknowledgeJobResult } from '../platform/jobResultDeliveryService';

/**
 * Generic local-ASR generation branch (faster-whisper, qwen3-asr, …), generalized from
 * runParakeetGeneration. Owns the full path for a catalog ASR engine: checkpoint, delegate to the
 * generic adapter with progressive merging, read final subtitles back, dispatch streaming-complete,
 * auto-save. All side effects are threaded in via params.
 *
 * @param {{ engine:{id:string,name?:string} }} params
 * @returns {Promise<boolean>} true on success, false on invalid segment selection
 */
export const runAsrGeneration = async ({
  engine,
  input,
  options,
  runId,
  debugLog,
  setStatus,
  setIsGenerating,
  setSubtitlesData,
  persistSubtitles,
  t,
}) => {
  const seg = options.segment;
  const engineName = (engine && (engine.name || engine.labelDefault || engine.id)) || 'ASR';
  const deliveryReceipts = [];

  try {
    if (!seg || typeof seg.start !== 'number' || typeof seg.end !== 'number') {
      setStatus({ message: t('errors.invalidSegmentSelection', 'Invalid segment selection'), type: 'error' });
      return false;
    }

    debugLog(`[Run ${runId}] ASR(${engine.id}): checkpoint before segment processing`, { seg });
    {
      const { checkpointBeforeUpdate } = await import('../services/lifecycleOrchestrator');
      await checkpointBeforeUpdate({
        source: 'segment-processing-start',
        segment: seg,
        runId,
        ...(options.signal ? { signal: options.signal } : {}),
      });
    }

    await processAsrSegment(
      engine,
      input,
      seg,
      {
        maxDurationPerRequest: options.maxDurationPerRequest,
        asrStrategy: options.asrStrategy,
        asrMaxChars: options.asrMaxChars,
        asrMaxWords: options.asrMaxWords,
        asrLanguage: options.asrLanguage,
        signal: options.signal,
      },
      {
        onStatus: setStatus,
        onRanges: (ranges) => publishProcessingRanges({ ranges }),
        onStreamingUpdate: (subs, part) => publishStreamingUpdate({ subtitles: subs, segment: part, runId }),
        onMergeSegment: async (part, newSegmentSubs) => {
          await new Promise((resolve) => {
            setSubtitlesData((current) => {
              const merged = mergeSegmentSubtitles(current || [], newSegmentSubs, part);
              resolve();
              return merged;
            });
          });
        },
        onDeliveryReceipt: (receipt) => { deliveryReceipts.push(receipt); },
        t,
      }
    );

    // Read the final subtitles back from state for the streaming-complete payload + auto-save.
    let finalSubs = [];
    await new Promise((resolve) => {
      setSubtitlesData((current) => { finalSubs = current || []; resolve(); return current; });
    });

    const filteredForSeg = (finalSubs || [])
      .filter((s) => (s.start < seg.end && s.end > seg.start))
      .map((s) => ({ ...s, start: Math.max(s.start, seg.start), end: Math.min(s.end, seg.end) }));

    // Streaming rows are presentation only until the exact project accepts the complete result.
    // Do not announce completion and do not rely on a delayed DOM event: either this awaited write
    // succeeds, or the generation fails while the already-durable pre-run checkpoint remains safe.
    if (typeof persistSubtitles !== 'function') {
      throw new TypeError('Local ASR requires a durable subtitle publisher');
    }
    await persistSubtitles(finalSubs);

    // The channel event is transport, not consumption. Only the awaited project checkpoint above
    // transfers ownership; an acknowledgement transport failure deliberately leaves SQLite's
    // payload pending for startup recovery instead of turning a durable edit into a false failure.
    await Promise.allSettled(deliveryReceipts.map(({ jobId, deliveryId }) => (
      acknowledgeJobResult(jobId, deliveryId)
    )));

    try {
      publishStreamingComplete({ subtitles: filteredForSeg, segment: seg, runId });
    } catch {
      // Completion listeners are advisory; ASR output remains authoritative.
    }

    setStatus({ message: t('output.asrTranscriptionComplete', '{{engine}} transcription complete', { engine: engineName }), type: 'success' });
    return true;
  } finally {
    setIsGenerating(false);
  }
};
