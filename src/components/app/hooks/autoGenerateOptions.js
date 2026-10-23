import { readPreference } from '../../../platform/preferences/store';
import { createPromptContext, effectivePromptPreset } from '../../videoProcessingPreferences';

/**
 * Build the same Gemini processing contract as the options modal, without
 * automating that modal's DOM. Values are the user's stored choices, which the
 * preference store has already bounded, so corrupt storage cannot create an
 * invalid native request.
 */
export const buildAutoGenerateOptions = ({
  videoFile,
  duration,
  transcriptionRules = null,
  userProvidedSubtitles = '',
  autoRunContext = null,
}) => {
  if (!videoFile) throw new Error('Auto-generation has no prepared media.');
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('Auto-generation could not determine the media duration.');
  }

  const fps = readPreference('video_processing_fps');
  const mediaResolution = readPreference('video_processing_media_resolution');
  const model = readPreference('video_processing_model');
  const maxDurationMinutes = readPreference('video_processing_max_duration');
  const segmentProcessingDelay = readPreference('segment_processing_delay');
  const maxWordsPerSubtitle = readPreference('video_processing_max_words');
  const useProvided = typeof userProvidedSubtitles === 'string'
    && userProvidedSubtitles.trim().length > 0;
  const promptPreset = useProvided
    ? 'timing-generation'
    : effectivePromptPreset(readPreference('video_processing_prompt_preset'), false);
  const useTranscriptionRules = readPreference('video_processing_use_transcription_rules');
  const promptContext = createPromptContext({
    presetId: promptPreset,
    customLanguage: readPreference('video_processing_custom_language'),
    useTranscriptionRules,
    transcriptionRules,
  });

  return {
    segment: { start: 0, end: duration },
    generationScope: 'full-media',
    audioOnly: readPreference('video_processing_audio_only'),
    fps,
    mediaResolution,
    model,
    maxDurationPerRequest: maxDurationMinutes * 60,
    segmentProcessingDelay,
    autoSplitSubtitles: useProvided ? false : readPreference('show_favorite_max_length'),
    maxWordsPerSubtitle,
    inlineExtraction: true,
    method: 'old',
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
