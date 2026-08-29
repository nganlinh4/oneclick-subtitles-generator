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
  setStatus,
  setIsGenerating,
  setSubtitlesData,
  loadSubtitles,
  captureGeneratedSegment,
  persistGeneratedSegment,
  t,
}) => {
  const seg = options.segment;
  const engineName = (engine && (engine.name || engine.labelDefault || engine.id)) || 'ASR';
  const deliveryReceipts = [];
  let durableBaseline = null;
  let workingSubtitles = null;

  try {
    if (!seg || typeof seg.start !== 'number' || typeof seg.end !== 'number') {
      setStatus({ message: t('errors.invalidSegmentSelection', 'Invalid segment selection'), type: 'error' });
      return false;
    }

    if (!options.autoRunContext) {
      const { checkpointBeforeUpdate } = await import('../services/lifecycleOrchestrator');
      await checkpointBeforeUpdate({
        source: 'generation-start',
        runId,
        ...(options.signal ? { signal: options.signal } : {}),
      });
    }
    if (typeof captureGeneratedSegment !== 'function') {
      throw new TypeError('Local ASR requires a durable subtitle revision');
    }
    await captureGeneratedSegment();
    if (typeof loadSubtitles !== 'function') {
      throw new TypeError('Local ASR requires an authoritative subtitle loader');
    }
    const loaded = await loadSubtitles();
    durableBaseline = loaded === null ? [] : loaded;
    if (!Array.isArray(durableBaseline)) {
      throw new TypeError('The native subtitle project returned an invalid track');
    }
    workingSubtitles = durableBaseline;
    setSubtitlesData(workingSubtitles);

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
          workingSubtitles = mergeSegmentSubtitles(workingSubtitles, newSegmentSubs, part);
          setSubtitlesData(workingSubtitles);
        },
        onDeliveryReceipt: (receipt) => { deliveryReceipts.push(receipt); },
        t,
      }
    );

    const finalSubs = workingSubtitles;

    const filteredForSeg = (finalSubs || [])
      .filter((s) => (s.start < seg.end && s.end > seg.start))
      .map((s) => ({ ...s, start: Math.max(s.start, seg.start), end: Math.min(s.end, seg.end) }));

    // Streaming rows are presentation only until the exact project accepts the complete result.
    // Do not announce completion and do not rely on a delayed DOM event: either this awaited write
    // succeeds, or the generation fails while the already-durable pre-run checkpoint remains safe.
    if (typeof persistGeneratedSegment !== 'function') {
      throw new TypeError('Local ASR requires a durable subtitle publisher');
    }
    const durableCommit = await persistGeneratedSegment(filteredForSeg);
    const authoritativeRows = Array.isArray(durableCommit?.subtitles)
      ? durableCommit.subtitles
      : finalSubs;
    setSubtitlesData(authoritativeRows);

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
  } catch (error) {
    // A later editor commit can legitimately supersede the pre-run baseline while native windows
    // are running. Never repaint that stale snapshot on failure: reload the exact durable owner and
    // publish only what it currently contains. If ownership itself was lost, publish nothing.
    if (durableBaseline !== null) {
      try {
        const current = await loadSubtitles();
        if (current === null || Array.isArray(current)) setSubtitlesData(current ?? []);
      } catch {
        // The ownership/read error that ended the run remains authoritative.
      }
    }
    throw error;
  } finally {
    setIsGenerating(false);
  }
};
