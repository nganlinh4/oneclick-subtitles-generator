// The declared preference keys, their codecs and persistence targets, plus the retired keys that
// are purged at startup. Keys keep the names and stored formats earlier builds used.
import { ASR_OPTION_CODECS, PROCESSING_KEYS } from './processingKeys';
import { GENERATION_KEYS } from './generationKeys';
import { NARRATION_KEYS } from './narrationKeys';
import { SETTINGS_KEYS } from './settingsKeys';
import { UI_KEYS } from './uiKeys';

// The codec stays the prototype so lazy members (a catalog-derived default) are not evaluated here.
const declare = (persistence, codecs) => Object.entries(codecs).map(([key, codec]) => [
  key,
  Object.freeze(Object.assign(Object.create(codec), { key, persistence })),
]);

const asrOptionKeys = Object.entries(ASR_OPTION_CODECS).flatMap(([option, codec]) => [
  [`parakeet_${option}`, codec],
]);

export const PREFERENCES = new Map([
  ...declare('native', SETTINGS_KEYS),
  ...declare('device', PROCESSING_KEYS),
  ...declare('device', UI_KEYS),
  ...declare('device', NARRATION_KEYS),
  ...declare('device', GENERATION_KEYS),
  ...declare('device', Object.fromEntries(asrOptionKeys)),
]);

// Key families whose middle part is open-ended (an engine id). Each resolves to one codec.
const ASR_OPTION_PATTERN = new RegExp(
  `^asr_[A-Za-z0-9._-]{1,96}_(${Object.keys(ASR_OPTION_CODECS).join('|')})$`,
);

/** The declaration of `key`, including members of a declared key family, or undefined. */
export const findPreference = (key) => {
  const declared = PREFERENCES.get(key);
  if (declared || typeof key !== 'string') return declared;
  const option = ASR_OPTION_PATTERN.exec(key)?.[1];
  if (!option) return undefined;
  const [[, definition]] = declare('device', { [key]: ASR_OPTION_CODECS[option] });
  PREFERENCES.set(key, definition);
  return definition;
};

// Secrets live only in the native vault. Older builds kept these aliases in WebView storage.
export const LEGACY_SECRET_STORAGE_KEYS = Object.freeze([
  'gemini_api_key',
  'gemini_api_keys',
  'gemini_token',
  'gemini_blacklisted_keys',
  'genius_token',
  'youtube_api_key',
  'youtube_client_id',
  'youtube_client_secret',
  'youtube_oauth_token',
]);

export const RETIRED_STORAGE_KEYS = Object.freeze([
  ...LEGACY_SECRET_STORAGE_KEYS,
  // Browser-era copies of the active media. The playback URL carried the media server's token.
  'current_file_url',
  'current_video_url',
  'current_file_cache_id',
  'current_file_name',
  'split_result',
  'latest_segment_subtitles',
  // Retired processing and analysis UI state.
  'video_processing_in_progress',
  'video_processing_inline_extraction',
  'video_processing_outside_context_text',
  'show_video_analysis',
  'video_analysis_timestamp',
  'video_analysis_result',
  'settings_version',
  'subtitle_settings_panel_transparent',
  'bracketStyle',
  'original_subtitles_map',
  'current_processing_source',
  'user_provided_subtitles',
  'media_resolution',
  'skip_video_analysis',
  'video_start_offset',
  'video_end_offset',
]);
