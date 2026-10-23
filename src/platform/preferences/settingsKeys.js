// Preferences owned by native SQLite: the values the Settings modal saves.
import { DEFAULT_ANALYSIS_MODEL_ID, DEFAULT_GEMINI_MODEL_ID } from '../../config/geminiModels';
import { bool, int, json, num, oneOf, text } from './codecs';
import { mediaModel } from './modelCodec';

const isPlainObject = (value) => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

export const SETTINGS_KEYS = Object.freeze({
  segment_duration: int(5, { min: 1, max: 60 }),
  gemini_model: mediaModel(() => DEFAULT_GEMINI_MODEL_ID),
  time_format: oneOf(['hms', 'seconds'], 'hms'),
  video_processing_max_words: int(12, { min: 1, max: 30 }),
  show_favorite_max_length: bool(true),
  show_waveform_long_videos: bool(false),
  segment_offset_correction: num(-3),
  // Empty means "use the built-in prompt"; the default text lives with the prompt module.
  transcription_prompt: text(''),
  use_youtube_oauth: bool(false),
  use_video_analysis: bool(true),
  video_analysis_model: mediaModel(() => DEFAULT_ANALYSIS_MODEL_ID),
  video_analysis_timeout: oneOf(['none', '10', '20', 'infinite'], '10'),
  enable_gemini_effects: bool(true),
  optimize_videos: bool(false),
  optimized_resolution: text('360p', { maxLength: 16, allowEmpty: false }),
  use_optimized_preview: bool(false),
  use_cookies_for_download: bool(false),
  download_cookie_source: text('chrome', { maxLength: 32, allowEmpty: false }),
  enable_youtube_search: bool(false),
  auto_import_site_subtitles: bool(true),
  thinking_budgets: json(() => ({}), isPlainObject),
  custom_gemini_models: json(() => [], Array.isArray),
  // Committed by nativeUiPreferences/themePreference, which also resolve their effective values
  // (an unset theme or language follows the system); declared here so subscribers are notified.
  app_font: oneOf(['google-sans', 'system-ui', 'noto-sans'], 'google-sans'),
  app_ui_scale: oneOf(['80', '90', '100', '110', '120'], '100'),
  preferred_language: oneOf(['en', 'ko', 'vi'], 'en'),
  theme: oneOf(['dark', 'light'], 'dark'),
});
