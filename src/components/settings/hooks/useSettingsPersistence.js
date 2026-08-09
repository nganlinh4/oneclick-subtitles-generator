// NOTE: this file lives in src/components/settings/hooks/, one level deeper than
// SettingsModal.js (src/components/settings/), so '../../X' from the modal
// becomes '../../../X' here.
import { getAllKeys, saveAllKeys } from '../../../services/gemini/keyManager';
import { initGeminiButtonEffects, disableGeminiButtonEffects } from '../../../utils/geminiEffects';
import {
  DEFAULT_ANALYSIS_MODEL_ID,
  DEFAULT_GEMINI_MODEL_ID,
  normalizeMediaModelId
} from '../../../config/geminiModels';

/**
 * Custom hook providing the settings persistence handler. Takes the settings
 * state + setters and returns { handleSave } which writes everything to
 * localStorage, syncs to the server, dispatches the onSave callback, applies
 * Gemini button effects, and snapshots original settings.
 *
 * @param {Object} params - settings values, setters, and modal callbacks
 * @returns {{ handleSave: () => Promise<void> }}
 */
const useSettingsPersistence = (params) => {
  const {
    geminiApiKey,
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
    enableYoutubeSearch,
    autoImportSiteSubtitles,
    favoriteMaxSubtitleLength,
    showFavoriteMaxLength,
    thinkingBudgets,
    customGeminiModels,
    setOriginalSettings,
    setHasChanges,
    setIsSettingsLoaded,
    onSave,
    handleClose,
  } = params;

  // Handle save button click
  const handleSave = async () => {
    const mediaModel = normalizeMediaModelId(geminiModel, DEFAULT_GEMINI_MODEL_ID);
    const analysisModel = normalizeMediaModelId(videoAnalysisModel, DEFAULT_ANALYSIS_MODEL_ID);
    // Save settings to localStorage
    localStorage.setItem('segment_duration', segmentDuration.toString());
    localStorage.setItem('gemini_model', mediaModel);
    localStorage.setItem('genius_token', geniusApiKey);
    localStorage.setItem('time_format', timeFormat);
    localStorage.setItem('video_processing_max_words', favoriteMaxSubtitleLength.toString());
    localStorage.setItem('show_favorite_max_length', showFavoriteMaxLength.toString());

    localStorage.setItem('show_waveform_long_videos', showWaveformLongVideos.toString());
    localStorage.setItem('segment_offset_correction', segmentOffsetCorrection.toString());
    localStorage.setItem('transcription_prompt', transcriptionPrompt);
    localStorage.setItem('use_youtube_oauth', useOAuth.toString());
    localStorage.setItem('use_video_analysis', useVideoAnalysis.toString());
    localStorage.setItem('video_analysis_model', analysisModel);
    localStorage.setItem('video_analysis_timeout', videoAnalysisTimeout);
    localStorage.setItem('enable_gemini_effects', enableGeminiEffects.toString());

    // Apply Gemini effects immediately in the same window
    if (enableGeminiEffects) {
      initGeminiButtonEffects();
    } else {
      disableGeminiButtonEffects();
    }

    // Trigger listeners (same-document) to apply effects immediately
    window.dispatchEvent(new Event('storage'));

    // Save the user's video optimization preference
    localStorage.setItem('optimize_videos', optimizeVideos.toString());
    localStorage.setItem('optimized_resolution', optimizedResolution);
    localStorage.setItem('use_optimized_preview', useOptimizedPreview.toString());
    localStorage.setItem('use_cookies_for_download', useCookiesForDownload.toString());
    localStorage.setItem('enable_youtube_search', enableYoutubeSearch.toString());
    localStorage.setItem('auto_import_site_subtitles', autoImportSiteSubtitles.toString());
    localStorage.setItem('thinking_budgets', JSON.stringify(thinkingBudgets));
    localStorage.setItem('custom_gemini_models', JSON.stringify(customGeminiModels));
    // Save the Gemini API key to the key manager
    // The key manager will handle updating the legacy key for backward compatibility
    const allKeys = getAllKeys();
    if (geminiApiKey && !allKeys.includes(geminiApiKey)) {
      const updatedKeys = [...allKeys, geminiApiKey];
      saveAllKeys(updatedKeys);
    }

    localStorage.setItem('youtube_api_key', youtubeApiKey);

    // Save localStorage data to server (only if backend is available)
    if (localStorage.getItem('backend_available') === 'true') {
      try {
        // Collect all localStorage data
        const localStorageData = {};
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          localStorageData[key] = localStorage.getItem(key);
        }

        // Add specific keys for the server
        localStorageData.gemini_token = geminiApiKey;
        localStorageData.genius_token = geniusApiKey;

        // Send to server - using unified port configuration
        const response = await fetch('http://127.0.0.1:3031/api/save-local-storage', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(localStorageData),
        });

        if (!response.ok) {
          throw new Error('Failed to save settings to server');
        }


      } catch (error) {
        console.error('Error saving settings to server:', error);
      }
    }

    // Notify parent component about API keys, segment duration, model, time format, video optimization settings, and cookie setting
    // Note: optimizeVideos parameter removed since it's always enabled now
    onSave(geminiApiKey, youtubeApiKey, geniusApiKey, segmentDuration, mediaModel, timeFormat, undefined, optimizedResolution, useOptimizedPreview, useCookiesForDownload, enableYoutubeSearch, showWaveformLongVideos);

    // Update original settings to match current settings
    setOriginalSettings({
      geminiApiKey,
      youtubeApiKey,
      geniusApiKey,
      segmentDuration,
      geminiModel: mediaModel,
      timeFormat,
      showWaveformLongVideos,
      segmentOffsetCorrection,
      transcriptionPrompt,
      useOAuth,
      youtubeClientId,
      youtubeClientSecret,
      useVideoAnalysis,
      videoAnalysisModel: analysisModel,
      videoAnalysisTimeout,
      enableGeminiEffects,

      optimizeVideos,
      optimizedResolution,
      useOptimizedPreview,
      useCookiesForDownload,
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
