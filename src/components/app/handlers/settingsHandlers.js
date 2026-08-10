import { DEFAULT_GEMINI_MODEL_ID, normalizeMediaModelId } from "../../../config/geminiModels";
import { cancelDownload as cancelNativeDownload } from "../../../platform/downloadService";
import {
  getCredentialAvailability,
  getCredentialStateSnapshot,
  initializeCredentialState,
} from "../../../platform/credentialStateController";

const NATIVE_SECRET_ALIASES = [
  "gemini_api_key",
  "gemini_api_keys",
  "gemini_token",
  "gemini_blacklisted_keys",
  "genius_token",
  "youtube_api_key",
  "youtube_client_id",
  "youtube_client_secret",
  "youtube_oauth_token",
];

export const getNativeCredentialAvailability = (snapshot, useOAuth = false) => (
  getCredentialAvailability(snapshot, { useOAuth })
);

// Gated debug logging (enable in the browser console: localStorage.debug_logs = 'true')
const DEBUG_LOGS = (typeof window !== 'undefined') && (localStorage.getItem('debug_logs') === 'true');
const dbg = (...args) => { if (DEBUG_LOGS) console.log(...args); };

/**
 * Create settings/navigation handlers (save API keys, tab change, cancel download).
 * Closes over the app state setters passed in.
 */
export const createSettingsHandlers = ({
  currentDownloadId,
  setActiveTab,
  setSelectedVideo,
  setUploadedFile,
  setStatus,
  setSubtitlesData,
  setIsDownloading,
  setDownloadProgress,
  setCurrentDownloadId,
  setIsSrtOnlyMode,
  setTimeFormat,
  setShowWaveformLongVideos,
  setOptimizedResolution,
  setUseOptimizedPreview,
  setUseCookiesForDownload,
  setEnableYoutubeSearch,
  setApiKeysSet,
  t,
}) => {
  /**
   * Handle cancelling the current download
   */
  const handleCancelDownload = () => {
    if (currentDownloadId) {
      const resetCancelledState = () => {
        setIsDownloading(false);
        setDownloadProgress(0);
        setCurrentDownloadId(null);
        setStatus({
          message: t("download.downloadOnly.cancelled", "Download cancelled"),
          type: "warning",
        });
      };

      return cancelNativeDownload(currentDownloadId).then(
        resetCancelledState,
        () => undefined,
      );
    }
    return undefined;
  };

  /**
   * Handle tab change
   */
  const handleTabChange = (tab, isUserInitiated = true) => {
    // Only update user preference if this is a user-initiated change
    if (isUserInitiated) {
      localStorage.setItem("userPreferredTab", tab);
    }

    // Always update the current active tab
    localStorage.setItem("lastActiveTab", tab);
    setActiveTab(tab);

    // Only reset state for user-initiated tab changes
    // System-initiated changes (like after video download) should preserve state
    if (isUserInitiated) {
      setSelectedVideo(null);
      setUploadedFile(null);
      setStatus({}); // Reset status
      setSubtitlesData(null); // Reset subtitles data

      // Only reset SRT-only mode if we don't have subtitles data in localStorage
      const subtitlesData = localStorage.getItem("subtitles_data");
      if (!subtitlesData) {
        setIsSrtOnlyMode(false); // Reset SRT-only mode
      }

      localStorage.removeItem("current_video_url");
      localStorage.removeItem("current_file_url");
      localStorage.removeItem("current_file_cache_id"); // Also clear the file cache ID
    }
  };

  /**
   * Handle saving API keys and settings
   */
  const saveApiKeys = async (
    _geminiKey,
    _youtubeKey,
    _geniusKey,
    segmentDuration = 5,
    geminiModel,
    timeFormat,
    _legacyOptimizeVideos,
    optimizedResolutionSetting,
    useOptimizedPreviewSetting,
    useCookiesForDownloadSetting,
    enableYoutubeSearchSetting,
    showWaveformLongVideosSetting
  ) => {
    // The desktop settings callback is a compatibility-shaped API. Secret arguments are
    // intentionally ignored, and legacy aliases are removed before the first async boundary.
    NATIVE_SECRET_ALIASES.forEach((key) => localStorage.removeItem(key));

    // Save segment duration
    if (segmentDuration) {
      localStorage.setItem("segment_duration", segmentDuration.toString());
    }

    // Save time format
    if (timeFormat) {
      localStorage.setItem("time_format", timeFormat);
      setTimeFormat(timeFormat);
    }

    // Save waveform for long videos setting
    if (showWaveformLongVideosSetting !== undefined) {
      localStorage.setItem("show_waveform_long_videos", showWaveformLongVideosSetting.toString());
      setShowWaveformLongVideos(showWaveformLongVideosSetting);

      // Dispatch custom event for immediate effect
      window.dispatchEvent(
        new CustomEvent("waveformLongVideosChanged", {
          detail: { value: showWaveformLongVideosSetting },
        })
      );
    }

    // Save Gemini model
    if (geminiModel) {
      localStorage.setItem(
        "gemini_model",
        normalizeMediaModelId(geminiModel, DEFAULT_GEMINI_MODEL_ID)
      );
    }

    // Video optimization is now always enabled - no need to save this setting

    if (optimizedResolutionSetting) {
      localStorage.setItem("optimized_resolution", optimizedResolutionSetting);
      setOptimizedResolution(optimizedResolutionSetting);
    }

    if (useOptimizedPreviewSetting !== undefined) {
      localStorage.setItem(
        "use_optimized_preview",
        useOptimizedPreviewSetting.toString()
      );
      setUseOptimizedPreview(useOptimizedPreviewSetting);
      dbg(
        "[AppHandlers] Updated useOptimizedPreview setting:",
        useOptimizedPreviewSetting
      );

      // Trigger a custom event to immediately notify VideoPreview component
      // This ensures immediate synchronization without waiting for the 500ms interval
      window.dispatchEvent(
        new CustomEvent("optimizedPreviewChanged", {
          detail: { value: useOptimizedPreviewSetting },
        })
      );
    }

    if (useCookiesForDownloadSetting !== undefined) {
      localStorage.setItem(
        "use_cookies_for_download",
        useCookiesForDownloadSetting.toString()
      );
      setUseCookiesForDownload(useCookiesForDownloadSetting);
    }

    if (enableYoutubeSearchSetting !== undefined) {
      localStorage.setItem(
        "enable_youtube_search",
        enableYoutubeSearchSetting.toString()
      );
      setEnableYoutubeSearch(enableYoutubeSearchSetting);
    }

    // Update state based on the selected authentication method
    const useOAuth = localStorage.getItem("use_youtube_oauth") === "true";
    try {
      await initializeCredentialState();
      setApiKeysSet(getNativeCredentialAvailability(
        getCredentialStateSnapshot(),
        useOAuth
      ));
    } catch {
      setApiKeysSet({ gemini: false, youtube: false, genius: false });
    }

    // Show success notification
    setStatus({
      message: t("settings.savedSuccessfully", "Settings saved successfully!"),
      type: "success",
    });
  };

  return {
    handleCancelDownload,
    handleTabChange,
    saveApiKeys,
  };
};
