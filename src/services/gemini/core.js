import {
  DEFAULT_ANALYSIS_MODEL_ID,
  DEFAULT_TRANSCRIPTION_MODEL_ID,
  normalizeMediaModelId,
} from '../../config/geminiModels';
import { runNativeGeminiMediaAnalysis } from '../../platform/nativeGeminiMediaAnalysis';
import {
  inspectMediaPipelineAsset,
  runMediaPipeline,
} from '../../platform/mediaPipelineService';
import { isNativeMediaDescriptor } from '../../platform/mediaService';
import { runNativeGeminiTranscription } from '../../platform/nativeGeminiTranscription';
import { ensureNativeMediaToolsReady } from '../../platform/nativeDownloadPreflight';
import { createSubtitleSchema } from '../../utils/schemaUtils';
import { parseGeminiResponse } from '../../utils/subtitle';
import { getThinkingBudget } from '../../utils/thinkingBudgetUtils';
import { getEmptySpeechPolicy, getTranscriptionPrompt } from './promptManagement';
import { bindNativeGeminiTranscriptionDelivery } from './transcriptionDelivery';
import {
  createRequestController,
  removeRequestController,
} from './requestManagement';
import {
  assertAutoGenerationContextCurrent,
  assertAutoGenerationContextDurable,
  isAutoGenerationContext,
} from '../../utils/autoGenerationOwnership';

const nativeMediaRequired = () => new Error(
  'Select the media again before starting native Gemini transcription.'
);

const normalizeNativeSegmentRange = (segmentInfo) => {
  if (segmentInfo === null || segmentInfo === undefined) return null;
  if (typeof segmentInfo !== 'object' || Array.isArray(segmentInfo)) {
    throw new Error('Native Gemini segment range is invalid.');
  }
  if (Object.keys(segmentInfo).length === 0) return null;

  const start = segmentInfo.start ?? segmentInfo.startTime;
  const explicitEnd = segmentInfo.end ?? segmentInfo.endTime;
  const end = explicitEnd ?? (
    Number.isFinite(start) && Number.isFinite(segmentInfo.duration)
      ? start + segmentInfo.duration
      : null
  );
  if (!Number.isFinite(start) || start < 0 || !Number.isFinite(end) || end <= start) {
    throw new Error('Native Gemini segment range is invalid.');
  }
  return Object.freeze({ start, end });
};

const normalizeMediaResolution = (value) => {
  if (typeof value !== 'string') return value;
  const prefix = 'MEDIA_RESOLUTION_';
  return value.startsWith(prefix) ? value.slice(prefix.length).toLowerCase() : value;
};

const FULL_RANGE_TOLERANCE_SECONDS = 0.25;

const assertSingleNativeRange = (range, maximumSeconds) => {
  const maximum = Number(maximumSeconds);
  if (range !== null && Number.isFinite(maximum) && maximum > 0
      && range.end - range.start > maximum + Number.EPSILON) {
    throw new Error(
      'Native Gemini received an unsplit range larger than maxDurationPerRequest.'
    );
  }
};

const coversWholeAsset = async (assetId, range) => {
  if (range.start !== 0) return false;
  const inspection = await inspectMediaPipelineAsset(assetId);
  if (!Number.isSafeInteger(inspection.durationUs) || inspection.durationUs <= 0) return false;
  const durationSeconds = inspection.durationUs / 1_000_000;
  return range.end >= durationSeconds - FULL_RANGE_TOLERANCE_SECONDS;
};

const asLegacyGeminiResponse = (result) => ({
  candidates: [{ content: { parts: [{ text: result.text }] } }],
  usageMetadata: result.usage,
});

/**
 * Desktop-only transcription facade. Media bytes and credentials never enter the WebView.
 */
export const callGeminiApi = async (input, _inputType, options = {}) => {
  if (!isNativeMediaDescriptor(input)) throw nativeMediaRequired();

  const model = normalizeMediaModelId(
    options.modelId || localStorage.getItem('gemini_model'),
    DEFAULT_TRANSCRIPTION_MODEL_ID
  );
  const autoRunContext = isAutoGenerationContext(options.autoRunContext)
    ? options.autoRunContext
    : null;
  if (autoRunContext) await assertAutoGenerationContextDurable(autoRunContext);
  if (autoRunContext && (
    autoRunContext.assetId === null
    || input.assetId !== autoRunContext.assetId
  )) {
    throw new Error('Automatic generation received a different native media asset.');
  }
  const { requestId, signal, abort } = createRequestController(options.signal);
  try {
    const segmentRange = normalizeNativeSegmentRange(options.segmentInfo);
    assertSingleNativeRange(segmentRange, options.maxDurationPerRequest);
    let mediaAssetId = input.assetId;
    let mediaKind = input.type?.startsWith('audio/') ? 'audio' : 'video';
    // Validate the task before installing tools or extracting media. A visual-only preset
    // must never silently become speech transcription when the user selects audio-only.
    const prompt = getTranscriptionPrompt(
      options.audioOnly === true ? 'audio' : mediaKind,
      options.userProvidedSubtitles,
      {
        segmentInfo: segmentRange ? {
          start: 0, end: segmentRange.end - segmentRange.start,
          duration: segmentRange.end - segmentRange.start, isSegment: true,
        } : {},
        promptContext: options.promptContext,
      }
    );
    if (options.audioOnly === true) {
      await ensureNativeMediaToolsReady({ signal });
      if (autoRunContext) await assertAutoGenerationContextDurable(autoRunContext);
      const audio = await runMediaPipeline({
        operation: 'extractAudio',
        assetId: input.assetId,
        format: 'flac',
        ...(segmentRange ? { range: segmentRange } : {}),
      }, { signal });
      if (audio.media.asset.kind !== 'audio') {
        throw new Error('Audio-only preparation did not produce an audio asset.');
      }
      mediaAssetId = audio.media.asset.id;
      mediaKind = 'audio';
    } else if (segmentRange !== null && !(await coversWholeAsset(input.assetId, segmentRange))) {
      // A bounded Gemini request must materialize an exact native clip. A clean install may not
      // have the reviewed media toolchain yet; install and activate it here instead of turning the
      // customer's public split setting into an opaque mediaPipeline failure. Concurrent windows
      // share one preflight promise, so four ranges never start four downloads.
      await ensureNativeMediaToolsReady({ signal });
      if (autoRunContext) await assertAutoGenerationContextDurable(autoRunContext);
      const clip = await runMediaPipeline({
        operation: 'analysisClip',
        assetId: input.assetId,
        range: segmentRange,
      }, { signal });
      mediaAssetId = clip.media.asset.id;
      mediaKind = clip.media.asset.kind;
    }

    const emptySpeechPolicy = getEmptySpeechPolicy(
      mediaKind,
      options.userProvidedSubtitles,
      options.promptContext
    );
    let accumulatedText = '';
    const handleNativeChunk = typeof options.onChunk === 'function'
      ? (text) => {
          try {
            if (autoRunContext) assertAutoGenerationContextCurrent(autoRunContext);
            accumulatedText += text;
            options.onChunk(Object.freeze({ accumulatedText }));
            if (autoRunContext) assertAutoGenerationContextCurrent(autoRunContext);
          } catch (error) {
            abort(error);
          }
        }
      : undefined;
    if (autoRunContext) await assertAutoGenerationContextDurable(autoRunContext);
    const result = await runNativeGeminiTranscription({
      assetId: mediaAssetId,
      videoFps: mediaKind === 'video' ? (options.videoFps ?? options.videoMetadata?.fps) : undefined,
      model,
      prompt: `${prompt}\n\nTimestamp contract: all timestamps are relative to the supplied media, beginning at 00:00. Do not add any original-video or project timeline offset.`,
      ...(emptySpeechPolicy ? { emptySpeechPolicy } : {}),
      responseJsonSchema: createSubtitleSchema(Boolean(options.userProvidedSubtitles?.trim())),
      thinkingLevel: getThinkingBudget(model),
      mediaResolution: mediaKind === 'video' ? normalizeMediaResolution(options.mediaResolution) : undefined,
      ...(options.projectId !== undefined ? { projectId: options.projectId } : {}),
      ...(options.expectedProjectStateVersion !== undefined
        ? { expectedProjectStateVersion: options.expectedProjectStateVersion }
        : {}),
      signal,
      ...(handleNativeChunk ? { onChunk: handleNativeChunk } : {}),
    });
    if (autoRunContext) await assertAutoGenerationContextDurable(autoRunContext);
    if (autoRunContext) assertAutoGenerationContextCurrent(autoRunContext);
    const subtitles = parseGeminiResponse(asLegacyGeminiResponse(result));
    return bindNativeGeminiTranscriptionDelivery(subtitles, result);
  } finally {
    removeRequestController(requestId);
  }
};

/** Compatibility name retained for existing processing flows; there is no Files API path. */
export const callGeminiApiWithFilesApi = (input, options = {}) => (
  callGeminiApi(input, 'file-upload', options)
);

/** Compatibility name retained for analysis callers that still use the former Files API shape. */
export const callGeminiApiWithFilesApiForAnalysis = async (
  input,
  options = {},
  signal = undefined
) => {
  if (!isNativeMediaDescriptor(input)) throw nativeMediaRequired();
  const model = normalizeMediaModelId(
    options.modelId || localStorage.getItem('video_analysis_model'),
    DEFAULT_ANALYSIS_MODEL_ID
  );
  const result = await runNativeGeminiMediaAnalysis({
    assetId: input.assetId,
    model,
    prompt: options.analysisPrompt || getTranscriptionPrompt('video'),
    responseJsonSchema: options.responseJsonSchema,
    thinkingLevel: getThinkingBudget(model),
    mediaResolution: normalizeMediaResolution(options.mediaResolution),
    signal,
  });
  return [{ text: result.text }];
};

const streamThroughNativeTranscription = async (
  input,
  options,
  onChunk,
  onComplete,
  onError,
  onProgress
) => {
  try {
    onProgress?.({ native: true });
    const subtitles = await callGeminiApi(input, 'file-upload', {
      ...options,
      ...(typeof onChunk === 'function' ? { onChunk } : {}),
    });
    onComplete?.(subtitles);
    return subtitles;
  } catch (error) {
    onError?.(error);
    throw error;
  }
};

export const streamGeminiApiWithFilesApi = streamThroughNativeTranscription;
export const streamGeminiApiInline = streamThroughNativeTranscription;
