import { mergeSegmentSubtitles } from '../utils/subtitle/subtitleMerger';
import { publishProcessingRanges, publishStreamingUpdate, publishStreamingComplete } from '../events/bus';
import { processAsrSegment } from '../services/engines/AsrAdapter';

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
  engine, input, options, runId, debugLog, setStatus, setIsGenerating, setSubtitlesData, t,
}) => {
  const seg = options.segment;
  const engineName = (engine && (engine.name || engine.labelDefault || engine.id)) || 'ASR';

  if (!seg || typeof seg.start !== 'number' || typeof seg.end !== 'number') {
    setStatus({ message: t('errors.invalidSegmentSelection', 'Invalid segment selection'), type: 'error' });
    setIsGenerating(false);
    return false;
  }

  debugLog(`[Run ${runId}] ASR(${engine.id}): checkpoint before segment processing`, { seg });
  {
    const { checkpointBeforeUpdate } = await import('../services/lifecycleOrchestrator');
    await checkpointBeforeUpdate({ source: 'segment-processing-start', segment: seg }, 2000);
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

  try { publishStreamingComplete({ subtitles: filteredForSeg, segment: seg, runId }); } catch {}

  try {
    const { autoSaveAfterStreaming } = await import('../services/lifecycleOrchestrator');
    debugLog(`[Run ${runId}] ASR(${engine.id}): streaming complete, triggering auto-save`);
    autoSaveAfterStreaming({ subtitles: finalSubs, segment: seg, delayMs: 500 });
  } catch {}

  setStatus({ message: t('output.asrTranscriptionComplete', '{{engine}} transcription complete', { engine: engineName }), type: 'success' });
  setIsGenerating(false);
  return true;
};
