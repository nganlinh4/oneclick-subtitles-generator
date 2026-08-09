import { cancelYoutubeVideoDownload } from "../../../utils/videoDownloader";
import { cancelDouyinVideoDownload } from "../../../utils/douyinDownloader";
import { cancelGenericVideoDownload } from "../../../utils/allSitesDownloader";
import { hasValidTokens } from "../../../services/youtubeApiService";
import { DEFAULT_GEMINI_MODEL_ID, normalizeMediaModelId } from "../../../config/geminiModels";

// Gated debug logging (enable in the browser console: localStorage.debug_logs = 'true')
const DEBUG_LOGS = (typeof window !== 'undefined') && (localStorage.getItem('debug_logs') === 'true');
const dbg = (...args) => { if (DEBUG_LOGS) console.log(...args); };

/**
 * Create settings/navigation handlers (save API keys, tab change, cancel download).
 * Closes over the app state setters passed in.
 */
export const createSettingsHandlers = ({
  activeTab,
  selectedVideo,
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
      // Check the source of the download
      if (activeTab === "unified-url" && selectedVideo?.source === "douyin") {
        // Cancel Douyin download
        cancelDouyinVideoDownload(currentDownloadId);
      } else if (
        activeTab === "unified-url" &&
        selectedVideo?.source === "all-sites"
      ) {
        // Cancel generic URL download
        cancelGenericVideoDownload(currentDownloadId);
      } else {
        // Default to YouTube download
        cancelYoutubeVideoDownload(currentDownloadId);
      }

      // Reset states
      setIsDownloading(false);
      setDownloadProgress(0);
      setCurrentDownloadId(null);
      setStatus({
        message: t("download.downloadOnly.cancelled", "Download cancelled"),
        type: "warning",
      });
    }
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
  const saveApiKeys = (
    geminiKey,
    youtubeKey,
    geniusKey,
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
    // Save to localStorage
    if (geminiKey) {
      localStorage.setItem("gemini_api_key", geminiKey);
    } else {
      localStorage.removeItem("gemini_api_key");
    }

    if (youtubeKey) {
      localStorage.setItem("youtube_api_key", youtubeKey);
    } else {
      localStorage.removeItem("youtube_api_key");
    }

    if (geniusKey) {
      localStorage.setItem("genius_token", geniusKey);
    } else {
      localStorage.removeItem("genius_token");
    }

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
    const hasOAuthTokens = hasValidTokens();

    setApiKeysSet({
      gemini: !!geminiKey,
      youtube: useOAuth ? hasOAuthTokens : !!youtubeKey,
      genius: !!geniusKey,
    });

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
