import { useRef } from "react";
import { resetGeminiButtonState } from "../../utils/geminiEffects";
import { createSubtitleHandlers } from "./handlers/subtitleHandlers";
import { createDownloadHandlers } from "./handlers/downloadHandlers";
import { createProcessingHandlers } from "./handlers/processingHandlers";
import { createSettingsHandlers } from "./handlers/settingsHandlers";

/**
 * Hook for application event handlers
 */
export const useAppHandlers = (appState) => {
  const {
    activeTab,
    setActiveTab,
    selectedVideo,
    setSelectedVideo,
    uploadedFile,
    setUploadedFile,
    apiKeysSet,
    setApiKeysSet,
    setStatus,
    setSubtitlesData,
    // isDownloading is used in validateInput
    setIsDownloading,
    // downloadProgress is used in UI elsewhere
    setDownloadProgress,
    currentDownloadId,
    setCurrentDownloadId,
    isSrtOnlyMode,
    setIsSrtOnlyMode,
    userProvidedSubtitles,
    useUserProvidedSubtitles,
    generateSubtitles,
    retryGeneration,
    isRetrying,
    setIsRetrying,
    setSegmentsStatus,
    // Video processing workflow
    setIsUploading,
    setSelectedSegment,
    setShowProcessingModal,
    uploadedFileData,
    setUploadedFileData,
    setIsProcessingSegment,
    // Settings setters consumed by saveApiKeys
    setTimeFormat,
    setShowWaveformLongVideos,
    setOptimizedResolution,
    setUseOptimizedPreview,
    setUseCookiesForDownload,
    setEnableYoutubeSearch,
    t = (key, defaultValue) => defaultValue, // Provide a default implementation if t is not available
  } = appState;
  // Holds auto-downloaded subtitle content until video download completes
  const pendingAutoSubtitleRef = useRef(null);

  // Subtitle handlers (input validation + SRT/JSON upload) — self-contained.
  const { validateInput, handleSrtUpload } = createSubtitleHandlers({
    activeTab,
    selectedVideo,
    uploadedFile,
    isSrtOnlyMode,
    setStatus,
    setSubtitlesData,
    setIsDownloading,
    setDownloadProgress,
    setIsSrtOnlyMode,
    t,
  });

  // Settings/navigation handlers (save API keys, tab change, cancel download).
  // handleTabChange is consumed by download/processing handlers below.
  const { handleCancelDownload, handleTabChange, saveApiKeys } =
    createSettingsHandlers({
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
    });

  // Download handlers — depend on handleSrtUpload + handleTabChange (one-way).
  const { startBackgroundVideoProcessing, handleDownloadAndPrepareYouTubeVideo } =
    createDownloadHandlers({
      selectedVideo,
      setStatus,
      setSubtitlesData,
      setIsDownloading,
      setDownloadProgress,
      setCurrentDownloadId,
      setIsSrtOnlyMode,
      setActiveTab,
      setUploadedFile,
      setIsUploading,
      setUploadedFileData,
      pendingAutoSubtitleRef,
      handleSrtUpload,
      handleTabChange,
      t,
    });

  // Processing handlers (segment select, process with options, retry).
  const { handleSegmentSelect, handleProcessWithOptions, handleRetryGeneration } =
    createProcessingHandlers({
      activeTab,
      selectedVideo,
      uploadedFile,
      apiKeysSet,
      uploadedFileData,
      userProvidedSubtitles,
      useUserProvidedSubtitles,
      generateSubtitles,
      retryGeneration,
      isRetrying,
      setStatus,
      setSubtitlesData,
      setIsDownloading,
      setDownloadProgress,
      setCurrentDownloadId,
      setIsSrtOnlyMode,
      setUploadedFile,
      setUploadedFileData,
      setIsRetrying,
      setSegmentsStatus,
      setSelectedSegment,
      setShowProcessingModal,
      setIsProcessingSegment,
      handleTabChange,
      t,
    });

  /**
   * Handle generating subtitles - New workflow with immediate output container
   */
  const handleGenerateSubtitles = async () => {
    if (!validateInput()) {
      setStatus({ message: t("errors.invalidInput"), type: "error" });
      return;
    }

    // If we're in SRT-only mode, just show a message
    if (isSrtOnlyMode) {
      setStatus({
        message: t(
          "output.srtOnlyMode",
          "Working with SRT only. No video source available."
        ),
        type: "info",
      });
      return;
    }

    // Show output container immediately with uploading status
    setStatus({
      message: t("output.uploading", "Uploading video..."),
      type: "loading",
    });


    // Clear the segments-status before starting the generation process
    setSegmentsStatus([]);

    // Start background upload and wait for segment selection
    if (
      (activeTab.includes("youtube") || activeTab === "unified-url") &&
      selectedVideo
    ) {
      // Start download in background
      setIsDownloading(true);
      setDownloadProgress(0);
      setStatus({
        message: t("output.downloadingVideo", "Downloading video..."),
        type: "loading",
      });

      // The native job ID arrives from the typed download channel.
      setCurrentDownloadId(null);

      // Start background download and upload
      startBackgroundVideoProcessing(selectedVideo, "youtube");
      return; // Exit early, processing will continue after segment selection
    } else if (activeTab === "file-upload" && uploadedFile) {
      // Start background upload for file
      setIsUploading(true);
      startBackgroundVideoProcessing(uploadedFile, "file-upload");
      return; // Exit early, processing will continue after segment selection
    }

    // Reset button animation state when generation is complete
    resetGeminiButtonState();
  };

  return {
    validateInput,
    handleSrtUpload,
    handleGenerateSubtitles,
    handleRetryGeneration,
    handleCancelDownload,
    handleTabChange,
    saveApiKeys,
    handleDownloadAndPrepareYouTubeVideo,
    // New workflow handlers
    handleSegmentSelect,
    handleProcessWithOptions,
  };
};
