// NOTE: this file lives in src/components/settings/hooks/, one level deeper than
// SettingsModal.js (src/components/settings/), so '../../X' from the modal
// becomes '../../../X' here.
import { initGeminiButtonEffects, disableGeminiButtonEffects } from '../../../utils/geminiEffects';
import {
  DEFAULT_ANALYSIS_MODEL_ID,
  DEFAULT_GEMINI_MODEL_ID,
  normalizeMediaModelId
} from '../../../config/geminiModels';
import { upsertSingletonCredential } from '../../../platform/credentialStateController';
import { createDownloadCookiePreferenceValues } from '../../../platform/downloadCookiePreference';
import { persistDesktopSettings } from '../../../platform/settingsService';

const NATIVE_SECRET_ALIASES = Object.freeze([
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

export const submitNativeCredentialDrafts = async ({
  geniusApiKey,
  youtubeApiKey,
  youtubeClientId,
  youtubeClientSecret,
}) => {
  if (geniusApiKey?.trim()) {
    await upsertSingletonCredential('geniusAccessToken', geniusApiKey.trim());
  }
  if (youtubeApiKey?.trim()) {
    await upsertSingletonCredential('youtubeApiKey', youtubeApiKey.trim());
  }

  const hasClientId = Boolean(youtubeClientId?.trim());
  const hasClientSecret = Boolean(youtubeClientSecret?.trim());
  if (hasClientId !== hasClientSecret) {
    throw new Error('Both YouTube OAuth client fields are required');
  }
  if (hasClientId) {
    await upsertSingletonCredential('youtubeOauthClient', JSON.stringify({
      clientId: youtubeClientId.trim(),
      clientSecret: youtubeClientSecret.trim(),
    }));
  }
};

/**
 * Custom hook providing the settings persistence handler. Takes the settings
 * state + setters and returns { handleSave } which stores non-secret preferences,
 * submits write-only credential drafts to the native vault, dispatches the onSave
 * callback, applies Gemini button effects, and snapshots original settings.
 *
 * @param {Object} params - settings values, setters, and modal callbacks
 * @returns {{ handleSave: () => Promise<void> }}
 */
const useSettingsPersistence = (params) => {
  const {
    youtubeApiKey,
    geniusApiKey,
    segmentDuration,
    geminiModel,
    timeFormat,
    showWaveformLongVideos,
    segmentOffsetCorrection,
    transcriptionPrompt,
    useOAuth,
    youtubeClientId,
    youtubeClientSecret,
    useVideoAnalysis,
    videoAnalysisModel,
    videoAnalysisTimeout,
    enableGeminiEffects,
    optimizeVideos,
    optimizedResolution,
    useOptimizedPreview,
    useCookiesForDownload,
    downloadCookieSource,
    enableYoutubeSearch,
    autoImportSiteSubtitles,
    favoriteMaxSubtitleLength,
    showFavoriteMaxLength,
    thinkingBudgets,
    customGeminiModels,
    setOriginalSettings,
    setHasChanges,
    setIsSettingsLoaded,
    setGeminiApiKey,
    setYoutubeApiKey,
    setGeniusApiKey,
    setYoutubeClientId,
    setYoutubeClientSecret,
    onSave,
    handleClose,
  } = params;

  // Handle save button click
  const handleSave = async () => {
    const mediaModel = normalizeMediaModelId(geminiModel, DEFAULT_GEMINI_MODEL_ID);
    const analysisModel = normalizeMediaModelId(videoAnalysisModel, DEFAULT_ANALYSIS_MODEL_ID);

    const drafts = { geniusApiKey, youtubeApiKey, youtubeClientId, youtubeClientSecret };
    // Clear every secret-bearing React field before crossing the first async boundary.
    setGeminiApiKey?.('');
    setYoutubeApiKey?.('');
    setGeniusApiKey?.('');
    setYoutubeClientId?.('');
    setYoutubeClientSecret?.('');
    NATIVE_SECRET_ALIASES.forEach((key) => localStorage.removeItem(key));
    await submitNativeCredentialDrafts(drafts);

    const pendingPreferences = Object.freeze({
      segment_duration: segmentDuration.toString(),
      gemini_model: mediaModel,
      time_format: timeFormat,
      video_processing_max_words: favoriteMaxSubtitleLength.toString(),
      show_favorite_max_length: showFavoriteMaxLength.toString(),
      show_waveform_long_videos: showWaveformLongVideos.toString(),
      segment_offset_correction: segmentOffsetCorrection.toString(),
      transcription_prompt: transcriptionPrompt,
      use_youtube_oauth: useOAuth.toString(),
      use_video_analysis: useVideoAnalysis.toString(),
      video_analysis_model: analysisModel,
      video_analysis_timeout: videoAnalysisTimeout,
      enable_gemini_effects: enableGeminiEffects.toString(),
      optimize_videos: optimizeVideos.toString(),
      optimized_resolution: optimizedResolution,
      use_optimized_preview: useOptimizedPreview.toString(),
      ...createDownloadCookiePreferenceValues({
        enabled: useCookiesForDownload,
        selectedSource: downloadCookieSource,
      }),
      enable_youtube_search: enableYoutubeSearch.toString(),
      auto_import_site_subtitles: autoImportSiteSubtitles.toString(),
      thinking_budgets: JSON.stringify(thinkingBudgets),
      custom_gemini_models: JSON.stringify(customGeminiModels),
    });

    // Commit the complete filtered preference snapshot to SQLite first. Browser state and all
    // success presentation remain untouched if the durable write fails.
    await persistDesktopSettings(localStorage, pendingPreferences);
    Object.entries(pendingPreferences).forEach(([key, value]) => {
      localStorage.setItem(key, value);
    });

    // Apply Gemini effects immediately in the same window
    if (enableGeminiEffects) {
      initGeminiButtonEffects();
    } else {
      disableGeminiButtonEffects();
    }

    // Trigger listeners (same-document) to apply effects immediately
    window.dispatchEvent(new Event('storage'));

    // Notify parent component about API keys, segment duration, model, time format, video optimization settings, and cookie setting
    // Note: optimizeVideos parameter removed since it's always enabled now
    await onSave(
      '',
      '',
      '',
      segmentDuration,
      mediaModel,
      timeFormat,
      undefined,
      optimizedResolution,
      useOptimizedPreview,
      useCookiesForDownload,
      enableYoutubeSearch,
      showWaveformLongVideos
    );

    // Update original settings to match current settings
    setOriginalSettings({
      geminiApiKey: '',
      youtubeApiKey: '',
      geniusApiKey: '',
      segmentDuration,
      geminiModel: mediaModel,
      timeFormat,
      showWaveformLongVideos,
      segmentOffsetCorrection,
      transcriptionPrompt,
      useOAuth,
      youtubeClientId: '',
      youtubeClientSecret: '',
      useVideoAnalysis,
      videoAnalysisModel: analysisModel,
      videoAnalysisTimeout,
      enableGeminiEffects,

      optimizeVideos,
      optimizedResolution,
      useOptimizedPreview,
      useCookiesForDownload,
      downloadCookieSource,
      enableYoutubeSearch,
      autoImportSiteSubtitles,
      favoriteMaxSubtitleLength,
      showFavoriteMaxLength,
      thinkingBudgets,
      customGeminiModels
    });

    // Reset changes flag and mark settings as loaded
    setHasChanges(false);
    setIsSettingsLoaded(true);

    handleClose();
  };

  return { handleSave };
};

export default useSettingsPersistence;
