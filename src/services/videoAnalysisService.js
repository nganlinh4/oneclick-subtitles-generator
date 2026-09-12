/**
 * Service for analyzing videos with Gemini before splitting
 */

import i18n from '../i18n/i18n';
import { DEFAULT_ANALYSIS_MODEL_ID, normalizeMediaModelId } from '../config/geminiModels';
import { resolveActiveNativeMediaAssetId } from '../platform/activeNativeMedia';
import { isDesktopRuntime } from '../platform/desktopRuntime';
import { runNativeGeminiMediaAnalysis } from '../platform/nativeGeminiMediaAnalysis';
import { inspectMediaPipelineAsset } from '../platform/mediaPipelineService';
import { createVideoAnalysisSchema } from '../utils/videoAnalysisSchema';

// Translation function shorthand
const t = (key, fallback) => i18n.t(key, fallback);

// Store the active abort controller for video analysis
let activeAnalysisController = null;

// Maximum number of terminology items to keep to prevent localStorage overflow
const MAX_TERMINOLOGY_ITEMS = 50;
const MAX_ANALYSIS_LIST_ITEMS = 200;
const MAX_ANALYSIS_STRING_LENGTH = 8_192;
const VALID_PRESET_IDS = new Set([
  'general',
  'focus-lyrics',
  'extract-text',
  'describe-video',
  'diarize-speakers',
  'chaptering',
  'translate-directly',
]);
const RULE_KEYS = new Set([
  'atmosphere',
  'terminology',
  'speakerIdentification',
  'formattingConventions',
  'spellingAndGrammar',
  'relationships',
  'additionalNotes',
]);

const invalidAnalysis = () => {
  const error = new Error('The provider returned invalid video analysis data');
  error.name = 'VideoAnalysisError';
  error.code = 'invalidVideoAnalysisResult';
  return error;
};

/**
 * Abort any active video analysis request
 */
export const abortVideoAnalysis = () => {
  if (activeAnalysisController) {

    activeAnalysisController.abort();
    activeAnalysisController = null;
    return true;
  }
  return false;
};

/**
 * Validate and bound the exact provider result before it can become project state.
 * @param {Object} analysisResult - The raw analysis result from Gemini
 * @returns {Object} - The sanitized analysis result
 */
const sanitizeAnalysisResult = (analysisResult) => {
  const isRecord = (value) => (
    value !== null && typeof value === 'object' && !Array.isArray(value)
  );
  const validText = (value) => (
    typeof value === 'string'
    && value.trim().length > 0
    && value.length <= MAX_ANALYSIS_STRING_LENGTH
  );
  const validStringList = (value) => (
    Array.isArray(value)
    && value.length <= MAX_ANALYSIS_LIST_ITEMS
    && value.every(validText)
  );
  const validObjectList = (value, keys) => (
    Array.isArray(value)
    && value.length <= MAX_ANALYSIS_LIST_ITEMS
    && value.every((entry) => (
      isRecord(entry)
      && Object.keys(entry).length === keys.length
      && keys.every((key) => validText(entry[key]))
    ))
  );

  if (!isRecord(analysisResult)
      || Object.keys(analysisResult).length !== 2
      || !isRecord(analysisResult.recommendedPreset)
      || Object.keys(analysisResult.recommendedPreset).length !== 2
      || !VALID_PRESET_IDS.has(analysisResult.recommendedPreset.id)
      || !validText(analysisResult.recommendedPreset.reason)
      || !isRecord(analysisResult.transcriptionRules)
      || Object.keys(analysisResult.transcriptionRules).some((key) => !RULE_KEYS.has(key))) {
    throw invalidAnalysis();
  }

  const rules = analysisResult.transcriptionRules;
  if ((rules.atmosphere !== undefined && !validText(rules.atmosphere))
      || (rules.terminology !== undefined
        && (!Array.isArray(rules.terminology)
          || rules.terminology.length > MAX_TERMINOLOGY_ITEMS
          || !validObjectList(rules.terminology, ['term', 'definition'])))
      || (rules.speakerIdentification !== undefined
        && !validObjectList(rules.speakerIdentification, ['speakerId', 'description']))
      || (rules.formattingConventions !== undefined
        && !validStringList(rules.formattingConventions))
      || (rules.spellingAndGrammar !== undefined
        && !validStringList(rules.spellingAndGrammar))
      || (rules.relationships !== undefined && !validStringList(rules.relationships))
      || (rules.additionalNotes !== undefined && !validStringList(rules.additionalNotes))) {
    throw invalidAnalysis();
  }

  return JSON.parse(JSON.stringify(analysisResult));
};

/**
 * Analyzes a video with Gemini to determine the best prompt preset and generate transcription rules
 * @param {File} videoFile - The video file to analyze
 * @param {Function} onStatusUpdate - Callback for status updates
 * @returns {Promise<Object>} - Analysis results
 */
export const analyzeVideoWithGemini = async (
  videoFile,
  onStatusUpdate,
  {
    signal: externalSignal,
    validateOwnership = null,
    projectId,
    expectedProjectStateVersion,
  } = {}
) => {
  // Create a new AbortController and store it
  const analysisController = new AbortController();
  activeAnalysisController = analysisController;
  const signal = analysisController.signal;
  const abortFromOwner = () => analysisController.abort();
  if (externalSignal?.aborted) analysisController.abort();
  else externalSignal?.addEventListener?.('abort', abortFromOwner, { once: true });
  try {
    const nativeRuntime = isDesktopRuntime();
    if (!nativeRuntime) throw new Error('Video analysis requires the desktop runtime');
    if (typeof projectId !== 'string'
        || !Number.isSafeInteger(expectedProjectStateVersion)
        || expectedProjectStateVersion < 0) {
      const error = new Error('Video analysis requires an exact native project revision');
      error.code = 'videoAnalysisProjectAuthorityMissing';
      throw error;
    }

    // Get the selected model from localStorage or use the default
    const MODEL = normalizeMediaModelId(
        localStorage.getItem('video_analysis_model'),
        DEFAULT_ANALYSIS_MODEL_ID
    );

    // Get video duration
    onStatusUpdate({ message: t('input.preparingVideoAnalysis', 'Preparing video for analysis...'), type: 'loading' });
    let videoDuration = 0;
    let nativeAssetId = null;
    nativeAssetId = resolveActiveNativeMediaAssetId(videoFile);
    if (nativeAssetId === null) {
      const error = new Error('The selected media is unavailable to the desktop runtime');
      error.code = 'nativeMediaUnavailable';
      throw error;
    }
    const inspection = await inspectMediaPipelineAsset(nativeAssetId);
    if (inspection.durationUs === null) {
      throw new Error('The selected media duration is unavailable');
    }
    videoDuration = inspection.durationUs / 1_000_000;

    // Determine how comprehensive the rule set should be based on video length
    const isLongVideo = videoDuration > 600; // More than 10 minutes
    const isVeryLongVideo = videoDuration > 1800; // More than 30 minutes

    // Create the analysis prompt
    const analysisPrompt = `You are an expert video and audio content analyzer. This video is ${Math.round(videoDuration)} seconds long (${Math.round(videoDuration/60)} minutes). Analyze this video and provide:

1. The most suitable transcription preset for this content from the following options:
   - general: General purpose transcription
   - focus-lyrics: Focus on lyrics (for music videos, songs)
   - extract-text: Extract visible text (for presentations, tutorials with text)
   - describe-video: Describe video content (for visual content description)
   - diarize-speakers: Identify different speakers (for multi-person conversations)
   - chaptering: Create chapters based on content (for long-form content)
	Guidance: When in doubt, default to 'general'. Choose 'diarize-speakers' only if there is clear, sustained multi-speaker conversation that will materially benefit from diarization.

2. A detailed rule set for consistent transcription. ${isLongVideo ? 'Since this is a longer video, provide as many detailed rules as possible to ensure consistency across the entire transcription.' : ''} ${isVeryLongVideo ? 'This is a very long video, so an extremely comprehensive rule set is essential - aim for at least 5-10 items in each applicable category.' : ''} Include (only if applicable):
   - Atmosphere: Description of the setting or context
   - Terminology: List of specialized terms and proper nouns with definitions (${isLongVideo ? 'provide as many as you can identify' : 'provide key terms'})
   - Speaker Identification: Descriptions of different speakers (${isLongVideo ? 'be very detailed about voice characteristics, speaking patterns, and any identifying features' : 'basic identification'})
   - Formatting and Style Conventions: How to format specific content (${isLongVideo ? 'be comprehensive and specific' : 'basic guidelines'})
   - Spelling, Grammar, and Punctuation: Special rules for this content (${isLongVideo ? 'include all exceptions and special cases' : 'key rules only'})
   - Relationships and Social Hierarchy: Information about relationships between people
   - Any other aspects that would help ensure consistent, high-quality transcription

Provide your analysis in a structured format that can be used to guide the transcription process.`;

    onStatusUpdate({ message: t('input.analyzingVideo', 'Analyzing video content...'), type: 'loading' });

    // Prepare options for Files API call with very low FPS and resolution for analysis
    const analysisOptions = {
      modelId: MODEL,
      videoMetadata: {
        fps: 0.01  // Ultra low FPS (1 frame every 100 seconds) for maximum token efficiency
      },
      mediaResolution: 'MEDIA_RESOLUTION_LOW',  // Use low resolution to reduce token count
      // We'll need a custom analysis prompt instead of transcription prompt
      analysisMode: true,
      analysisPrompt: analysisPrompt
    };

    if (validateOwnership) await validateOwnership();
    const nativeResult = await runNativeGeminiMediaAnalysis({
      assetId: nativeAssetId,
      model: MODEL,
      prompt: analysisOptions.analysisPrompt,
      responseJsonSchema: createVideoAnalysisSchema(),
      thinkingLevel: 'minimal',
      mediaResolution: 'low',
      projectId,
      expectedProjectStateVersion,
      signal,
    });
    if (validateOwnership) await validateOwnership();
    if (typeof nativeResult?.text !== 'string'
        || typeof nativeResult?.acknowledge !== 'function'
        || typeof nativeResult?.job?.id !== 'string'
        || typeof nativeResult?.deliveryId !== 'string') {
      throw invalidAnalysis();
    }
    let analysisResult;
    try {
      analysisResult = JSON.parse(nativeResult.text);
    } catch {
      throw invalidAnalysis();
    }
    const sanitizedResult = sanitizeAnalysisResult(analysisResult);

    return Object.freeze({
      analysisResult: sanitizedResult,
      delivery: Object.freeze({
        jobId: nativeResult.job.id,
        deliveryId: nativeResult.deliveryId,
        acknowledge: nativeResult.acknowledge,
      }),
    });
  } catch (error) {
    console.error('Error analyzing video:', error);

    // Clear the active controller
    if (activeAnalysisController === analysisController) activeAnalysisController = null;

    // Check if this is an abort error
    if (error.name === 'AbortError') {
      const aborted = new Error('Video analysis was cancelled');
      aborted.name = 'AbortError';
      aborted.code = 'videoAnalysisAborted';
      throw aborted;
    }

    throw error;
  } finally {
    // Clear the active controller in case of success
    externalSignal?.removeEventListener?.('abort', abortFromOwner);
    if (activeAnalysisController === analysisController) activeAnalysisController = null;
  }
};
