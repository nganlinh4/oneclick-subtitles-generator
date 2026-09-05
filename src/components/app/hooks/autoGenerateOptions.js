import {
  DEFAULT_TRANSCRIPTION_MODEL_ID,
  normalizeMediaModelId,
} from '../../../config/geminiModels';

const readStorage = (storage, key) => {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
};

const boundedNumber = (value, fallback, min, max) => {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.min(max, Math.max(min, parsed))
    : fallback;
};

/**
 * Build the same Gemini processing contract as the options modal, without
 * automating that modal's DOM. Values are read from the user's persisted
 * choices and normalized at the action boundary so corrupt storage cannot
 * create an invalid native request.
 */
export const buildAutoGenerateOptions = ({
  storage = globalThis.localStorage,
  videoFile,
  duration,
  isVercelMode = false,
  transcriptionRules = null,
  userProvidedSubtitles = '',
  autoRunContext = null,
}) => {
  if (!videoFile) throw new Error('Auto-generation has no prepared media.');
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('Auto-generation could not determine the media duration.');
  }

  const fps = boundedNumber(readStorage(storage, 'video_processing_fps'), 0.25, 0.25, 5);
  const rawResolution = readStorage(storage, 'video_processing_media_resolution');
  const mediaResolution = rawResolution === 'medium' ? 'medium' : 'low';
  const model = normalizeMediaModelId(
    readStorage(storage, 'video_processing_model'),
    DEFAULT_TRANSCRIPTION_MODEL_ID,
  );
  const maxDurationMinutes = boundedNumber(
    readStorage(storage, 'video_processing_max_duration'),
    10,
    1,
    20,
  );
  const segmentProcessingDelay = boundedNumber(
    readStorage(storage, 'segment_processing_delay'),
    0,
    0,
    60,
  );
  const maxWordsPerSubtitle = Math.round(boundedNumber(
    readStorage(storage, 'video_processing_max_words'),
    12,
    1,
    30,
  ));
  const method = isVercelMode ? 'new' : 'old';
  const useProvided = typeof userProvidedSubtitles === 'string'
    && userProvidedSubtitles.trim().length > 0;
  const storedPreset = readStorage(storage, 'video_processing_prompt_preset') || 'settings';
  const promptPreset = useProvided ? 'timing-generation' : storedPreset;
  const useTranscriptionRules = readStorage(
    storage,
    'video_processing_use_transcription_rules'
  ) === 'true';
  let userPromptPresets = [];
  try {
    const parsed = JSON.parse(readStorage(storage, 'user_prompt_presets') || '[]');
    if (Array.isArray(parsed)) userPromptPresets = parsed;
  } catch {
    userPromptPresets = [];
  }
  const promptContext = Object.freeze({
    presetId: promptPreset,
    settingsPrompt: readStorage(storage, 'transcription_prompt') || '',
    customLanguage: readStorage(storage, 'video_processing_custom_language') || '',
    useTranscriptionRules,
    transcriptionRules: useTranscriptionRules && transcriptionRules
      ? JSON.parse(JSON.stringify(transcriptionRules))
      : null,
    userPromptPresets: JSON.parse(JSON.stringify(userPromptPresets)),
    useOutsideResultsContext: false,
    outsideContextText: '',
  });
  const isAudio = typeof videoFile.type === 'string' && videoFile.type.startsWith('audio/');
  const oneRequest = isVercelMode && isAudio;

  return {
    segment: { start: 0, end: duration },
    generationScope: 'full-media',
    audioOnly: readStorage(storage, 'video_processing_audio_only') === 'true',
    fps,
    mediaResolution,
    model,
    maxDurationPerRequest: oneRequest ? 999_999_999 : maxDurationMinutes * 60,
    segmentProcessingDelay,
    autoSplitSubtitles: useProvided
      ? false
      : readStorage(storage, 'show_favorite_max_length') !== 'false',
    maxWordsPerSubtitle,
    inlineExtraction: method === 'old',
    method,
    promptPreset,
    customLanguage: promptContext.customLanguage,
    useTranscriptionRules,
    promptContext,
    userProvidedSubtitles: useProvided ? userProvidedSubtitles : undefined,
    useUserProvidedSubtitles: useProvided,
    useOutsideResultsContext: false,
    outsideContextText: '',
    autoRunContext,
    videoFile,
  };
};
