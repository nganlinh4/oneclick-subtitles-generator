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
import { createSubtitleSchema } from '../../utils/schemaUtils';
import { parseGeminiResponse } from '../../utils/subtitle';
import { getThinkingBudget } from '../../utils/thinkingBudgetUtils';
import { getTranscriptionPrompt } from './promptManagement';
import {
  createRequestController,
  removeRequestController,
} from './requestManagement';

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

const coversWholeAsset = async (assetId, range) => {
  if (range.start > FULL_RANGE_TOLERANCE_SECONDS) return false;
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
  const { requestId, signal } = createRequestController();
  try {
    const segmentRange = normalizeNativeSegmentRange(options.segmentInfo);
    let mediaAssetId = input.assetId;
    let mediaKind = input.type?.startsWith('audio/') ? 'audio' : 'video';
    if (segmentRange !== null && !(await coversWholeAsset(input.assetId, segmentRange))) {
      const clip = await runMediaPipeline({
        operation: 'analysisClip',
        assetId: input.assetId,
        range: segmentRange,
      }, { signal });
      mediaAssetId = clip.media.asset.id;
      mediaKind = clip.media.asset.kind;
    }

    const prompt = getTranscriptionPrompt(
      mediaKind,
      options.userProvidedSubtitles,
      { segmentInfo: {} }
    );
    const result = await runNativeGeminiTranscription({
      assetId: mediaAssetId,
      model,
      prompt,
      responseJsonSchema: createSubtitleSchema(Boolean(options.userProvidedSubtitles?.trim())),
      thinkingLevel: getThinkingBudget(model),
      mediaResolution: normalizeMediaResolution(options.mediaResolution),
      signal,
    });
    return parseGeminiResponse(asLegacyGeminiResponse(result));
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
    const subtitles = await callGeminiApi(input, 'file-upload', options);
    onChunk?.(JSON.stringify(subtitles));
    onComplete?.(JSON.stringify(subtitles));
    return subtitles;
  } catch (error) {
    onError?.(error);
    throw error;
  }
};

export const streamGeminiApiWithFilesApi = streamThroughNativeTranscription;
export const streamGeminiApiInline = streamThroughNativeTranscription;
