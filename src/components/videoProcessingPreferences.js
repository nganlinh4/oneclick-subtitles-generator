import { getEngineDescriptor } from '../services/engines/transcriptionEngineRegistry';
import { readPreference, writePreference } from '../platform/preferences/store';

const TIMING_GENERATION_PRESET = 'timing-generation';

const validMethod = (method) => (getEngineDescriptor(method) ? method : 'new');

export const readProcessingMethod = () => validMethod(readPreference('video_processing_method'));

export const writeProcessingMethod = (method) => {
  const validated = validMethod(method);
  writePreference('video_processing_method', validated);
  return validated;
};

/**
 * The prompt preset a run actually uses. Timing generation needs user-provided subtitles, so it
 * falls back to the Settings prompt without them; the stored choice itself is left unchanged.
 */
export const effectivePromptPreset = (preset, hasUserSubtitles) => (
  preset === TIMING_GENERATION_PRESET && !hasUserSubtitles ? 'settings' : preset
);

export const isTimingGenerationPreset = (preset) => preset === TIMING_GENERATION_PRESET;

const snapshot = (value) => (value == null ? null : JSON.parse(JSON.stringify(value)));

/**
 * The immutable prompt inputs of one run. Callers pass the values the run actually uses (the
 * effective preset, toggles already combined with availability); stored prompts and user presets
 * are read here, so prompt building never falls back to WebView storage mid-run.
 */
export const createPromptContext = ({
  presetId,
  customLanguage,
  useTranscriptionRules,
  transcriptionRules = null,
  outsideContextText = '',
}) => Object.freeze({
  presetId,
  settingsPrompt: readPreference('transcription_prompt'),
  customLanguage,
  useTranscriptionRules: useTranscriptionRules === true,
  transcriptionRules: useTranscriptionRules === true ? snapshot(transcriptionRules) : null,
  userPromptPresets: snapshot(readPreference('user_prompt_presets')),
  useOutsideResultsContext: outsideContextText !== '',
  outsideContextText,
});

const languageHints = (value) => (
  Array.isArray(value)
    ? value.filter((hint) => typeof hint === 'string' && hint.trim()).slice(0, 8)
    : []
);

export const readTranscribeOptions = () => ({
  windowDurationSecs: readPreference('video_processing_transcribe_window_seconds'),
  languageHints: languageHints(readPreference('video_processing_transcribe_language_hints')),
  diarization: readPreference('video_processing_transcribe_diarization'),
});

export const writeTranscribeOptions = (options) => {
  const windowSeconds = Number.parseInt(options?.windowDurationSecs, 10);
  writePreference(
    'video_processing_transcribe_window_seconds',
    Number.isFinite(windowSeconds) ? windowSeconds : 600,
  );
  writePreference('video_processing_transcribe_language_hints', languageHints(options?.languageHints));
  writePreference('video_processing_transcribe_diarization', options?.diarization === true);
  return readTranscribeOptions();
};
