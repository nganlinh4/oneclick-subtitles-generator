// Per-device UI conveniences: remembered tabs, panels and toggles of this window.
import { bool, int, json, text } from './codecs';

export const UI_KEYS = Object.freeze({
  userPreferredTab: text('', { maxLength: 64 }),
  lastActiveTab: text('', { maxLength: 64 }),
  lyrics_auto_scroll: bool(true),
  has_visited_site: bool(false),
  onboarding_controls_dismissed: bool(false),
  settings_last_active_tab: text('api-keys', { maxLength: 64, allowEmpty: false }),
  settings_open_count: int(0, { min: 0 }),
  about_background_type: text('default', { maxLength: 32, allowEmpty: false }),
  about_background_history: json(() => [], Array.isArray),
  cached_lyrics_artist: text(''),
  cached_lyrics_song: text(''),
  // 0 (and anything unparseable) means the 31-word maximum.
  translation_post_split_max_words: int(31, { min: 0, max: 31 }),
  bg_music_panel_height: int(600),
  // Site subtitle languages to import with a download; unset follows the UI language.
  preferred_subtitle_langs: json(() => null, (value) => value === null || Array.isArray(value)),
  // Document processing (consolidate / summarize) of the lyrics editor.
  consolidation_split_duration: int(0, { min: 0 }),
  custom_prompt_consolidate: text(''),
  custom_prompt_summarize: text(''),
  // The last translation's target language(s): a plain language or a JSON list for
  // multi-language runs.
  translation_target_language: text(''),
  // Recent URL and search histories, serialized; their reader bounds the size, sanitizes each
  // entry and repairs damaged values.
  youtube_url_history: text('', { maxLength: Infinity }),
  youtube_search_history: text('', { maxLength: Infinity }),
  douyin_url_history: text('', { maxLength: Infinity }),
  all_sites_url_history: text('', { maxLength: Infinity }),
  user_subtitle_presets: json(() => [], Array.isArray),
  subtitle_settings_panel_open: bool(false),
  bg_music_collapsed: bool(false),
  toast_history_v1: json(() => [], Array.isArray),
  // Render queue numbering: the last number issued and the number given to each job timestamp.
  videoRenderCounter: int(0, { min: 0 }),
  videoTimestampMap: json(() => ({}), (value) => (
    value !== null && typeof value === 'object' && !Array.isArray(value)
  )),
});
