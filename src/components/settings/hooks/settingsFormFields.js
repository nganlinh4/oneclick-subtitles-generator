// The Settings form: which native preference each field edits, how a form is loaded from the
// preference store, and the values a save commits.
import { DEFAULT_TRANSCRIPTION_PROMPT } from '../../../services/gemini/promptManagement';
import {
  getDefaultThinkingBudgets,
  normalizeCustomGeminiModels,
} from '../../../config/geminiModels';
import { validateThinkingBudget } from '../../../utils/thinkingBudgetUtils';
import {
  DOWNLOAD_COOKIE_SOURCE_SETTING_KEY,
  normalizeDownloadCookieBrowser,
  readDownloadCookiePreference,
} from '../../../platform/downloadCookiePreference';
import { readPreference } from '../../../platform/preferences/store';

export const PREFERENCE_FIELDS = Object.freeze({
  segmentDuration: 'segment_duration',
  geminiModel: 'gemini_model',
  timeFormat: 'time_format',
  showWaveformLongVideos: 'show_waveform_long_videos',
  segmentOffsetCorrection: 'segment_offset_correction',
  transcriptionPrompt: 'transcription_prompt',
  useOAuth: 'use_youtube_oauth',
  useVideoAnalysis: 'use_video_analysis',
  videoAnalysisModel: 'video_analysis_model',
  videoAnalysisTimeout: 'video_analysis_timeout',
  enableGeminiEffects: 'enable_gemini_effects',
  optimizeVideos: 'optimize_videos',
  optimizedResolution: 'optimized_resolution',
  useOptimizedPreview: 'use_optimized_preview',
  useCookiesForDownload: 'use_cookies_for_download',
  downloadCookieSource: DOWNLOAD_COOKIE_SOURCE_SETTING_KEY,
  enableYoutubeSearch: 'enable_youtube_search',
  autoImportSiteSubtitles: 'auto_import_site_subtitles',
  favoriteMaxSubtitleLength: 'video_processing_max_words',
  showFavoriteMaxLength: 'show_favorite_max_length',
  thinkingBudgets: 'thinking_budgets',
  customGeminiModels: 'custom_gemini_models',
});

// Write-only buffers for native credentials. Existing secrets are never read back into the form.
export const CREDENTIAL_DRAFT_FIELDS = Object.freeze([
  'youtubeApiKey',
  'geniusApiKey',
  'youtubeClientId',
  'youtubeClientSecret',
]);

const emptyCredentialDrafts = () => Object.fromEntries(
  CREDENTIAL_DRAFT_FIELDS.map((field) => [field, ''])
);

const validThinkingBudgets = (stored) => Object.fromEntries(
  Object.entries(getDefaultThinkingBudgets()).map(([modelId, fallback]) => [
    modelId,
    validateThinkingBudget(modelId, stored?.[modelId]) ? stored[modelId] : fallback,
  ])
);

/** The form as the stored preferences describe it, with empty credential drafts. */
export const loadSettingsForm = () => ({
  ...emptyCredentialDrafts(),
  ...Object.fromEntries(
    Object.entries(PREFERENCE_FIELDS).map(([field, key]) => [field, readPreference(key)])
  ),
  transcriptionPrompt: readPreference('transcription_prompt') || DEFAULT_TRANSCRIPTION_PROMPT,
  // Video analysis is always enabled.
  useVideoAnalysis: true,
  downloadCookieSource: readDownloadCookiePreference().selectedSource,
  thinkingBudgets: validThinkingBudgets(readPreference('thinking_budgets')),
  customGeminiModels: normalizeCustomGeminiModels(readPreference('custom_gemini_models')),
});

/** The native preference values a save of `form` commits. */
export const settingsFormPreferences = (form) => ({
  ...Object.fromEntries(
    Object.entries(PREFERENCE_FIELDS).map(([field, key]) => [key, form[field]])
  ),
  use_cookies_for_download: form.useCookiesForDownload === true,
  [DOWNLOAD_COOKIE_SOURCE_SETTING_KEY]: normalizeDownloadCookieBrowser(form.downloadCookieSource),
});

export const isSameSettingsForm = (left, right) => Object.keys(left).every((field) => (
  JSON.stringify(left[field]) === JSON.stringify(right[field])
));
