import { resetGeminiButtonState } from "../../../utils/geminiEffects";
import { downloadAndPrepareYouTubeVideo } from "../VideoProcessingHandlers";

// Gated debug logging (enable in the browser console: localStorage.debug_logs = 'true')
const DEBUG_LOGS = (typeof window !== 'undefined') && (localStorage.getItem('debug_logs') === 'true');
const dbg = (...args) => { if (DEBUG_LOGS) console.log(...args); };

/**
 * Create processing-related handlers (segment select, process with options, retry).
 * Closes over the app state setters passed in.
 *
 * handleTabChange (from settingsHandlers) is passed in for system-initiated tab changes.
 */
export const createProcessingHandlers = ({
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
}) => {
  /**
   * Handle segment selection from timeline
   */
  const handleSegmentSelect = (segment) => {
    setSelectedSegment(segment);
    setShowProcessingModal(true);
  };

  /**
   * Handle processing with selected options
   */
  const handleProcessWithOptions = async (options) => {
    try {
      setShowProcessingModal(false);

      // Set processing state to true when starting
      setIsProcessingSegment(true);
      dbg(
        "[ProcessWithOptions] Started processing segment, animation should begin"
      );
      dbg(
        "[ProcessWithOptions] Received segmentProcessingDelay:",
        options.segmentProcessingDelay
      );

      let fileToProcess = uploadedFileData;
      if (!fileToProcess) {
        if (options.videoFile) {
          setUploadedFileData(options.videoFile);
          fileToProcess = options.videoFile;
        } else {
          throw new Error("No uploaded file data available");
        }
      }

      // Parakeet processing will be handled by generateSubtitles with method: 'nvidia-parakeet'

      // Prepare options for subtitle generation
      const subtitleOptions = {
        segment: options.segment,
        fps: options.fps,
        mediaResolution: options.mediaResolution,
        model: options.model,
        maxDurationPerRequest: options.maxDurationPerRequest,
        segmentProcessingDelay: options.segmentProcessingDelay,
        autoSplitSubtitles: options.autoSplitSubtitles,
        maxWordsPerSubtitle: options.maxWordsPerSubtitle,
        inlineExtraction: options.inlineExtraction === true,
        method: options.method,
        // Local ASR engine options (segmentation + optional forced language) — must be forwarded here
        // or runAsrGeneration/AsrAdapter fall back to defaults and the language picker silently no-ops.
        asrStrategy: options.asrStrategy,
        asrMaxChars: options.asrMaxChars,
        asrMaxWords: options.asrMaxWords,
        asrLanguage: options.asrLanguage,
      };

      dbg("[ProcessWithOptions] Passing to generateSubtitles - segmentProcessingDelay:", subtitleOptions.segmentProcessingDelay);

      // Add custom prompt if provided
      if (options.customPrompt) {
        // Store the custom prompt temporarily for this processing session
        sessionStorage.setItem("current_session_prompt", options.customPrompt);
        dbg(
          "[ProcessWithOptions] Using custom prompt for this session:",
          options.promptPreset
        );
      }

      // Add user-provided subtitles ONLY when the timing-generation preset is selected
      if (options.promptPreset === 'timing-generation' && useUserProvidedSubtitles && userProvidedSubtitles) {
        subtitleOptions.userProvidedSubtitles = userProvidedSubtitles;
      }

      // Before starting, if parallel requested, inform UI of processing ranges
      try {
        try {
          if (options.maxDurationPerRequest && options.segment) {
            const { splitSegmentForParallelProcessing } = await import('../../../utils/parallelProcessingUtils');
            const subSegments = splitSegmentForParallelProcessing(options.segment, options.maxDurationPerRequest);
            if (subSegments && subSegments.length > 1) {
              window.dispatchEvent(new CustomEvent('processing-ranges', {
                detail: { ranges: subSegments }
              }));
            }
          }
        } catch (e) {
          console.warn('[ProcessWithOptions] Could not compute processing ranges:', e);
        }

        await generateSubtitles(
          fileToProcess,
          "file-upload",
          apiKeysSet,
          subtitleOptions
        );
      } finally {
        // Clear the session prompt after processing
        sessionStorage.removeItem("current_session_prompt");
        dbg(
          "[ProcessWithOptions] Cleared session prompt after processing"
        );

        // Clear processing state when done
        setIsProcessingSegment(false);
        // Clear processing ranges overlay
        try {
          window.dispatchEvent(new CustomEvent('processing-ranges', { detail: { ranges: [] } }));
        } catch {}
        dbg(
          "[ProcessWithOptions] Processing complete, animation should stop"
        );
      }
    } catch (error) {
      console.error("Error processing with options:", error);
      setStatus({
        message: `${t("errors.processingFailed", "Processing failed")}: ${
          error.message
        }`,
        type: "error",
      });

      // Also clear processing state on error
      setIsProcessingSegment(false);
    }
  };

  /**
   * Handle retrying subtitle generation - FORCE RETRY that ignores validation
   */
  const handleRetryGeneration = async () => {
    dbg("FORCE RETRY: handleRetryGeneration called");

    // Prevent multiple simultaneous retries
    if (isRetrying) {
      dbg("FORCE RETRY: Already retrying, ignoring duplicate call");
      return;
    }

    // Only check for API key - this is the minimum requirement
    if (!apiKeysSet.gemini) {
      dbg("No Gemini API key available");
      setStatus({
        message: t("errors.apiKeyRequired", "Gemini API key is required"),
        type: "error",
      });
      return;
    }

    dbg("FORCE RETRY: Setting retrying state to true");
    // Set retrying state to true immediately
    setIsRetrying(true);

    // Clear the segments-status before starting the retry process
    setSegmentsStatus([]);

    dbg("FORCE RETRY: Determining input source...");
    let input, inputType;

    // Try to get input from current state or localStorage
    // Priority: 1. Current selected video/file, 2. localStorage cached data

    if (uploadedFile) {
      dbg("FORCE RETRY: Using uploaded file");
      input = uploadedFile;
      inputType = "file-upload";
    } else if (selectedVideo) {
      dbg("FORCE RETRY: Using selected video");
      input = selectedVideo;
      inputType =
        activeTab.includes("youtube") || activeTab === "unified-url"
          ? "youtube"
          : "file-upload";
    } else {
      // Try to get from localStorage
      const cachedVideoUrl = localStorage.getItem("current_video_url");
      const cachedFileUrl = localStorage.getItem("current_file_url");

      if (cachedVideoUrl) {
        dbg("FORCE RETRY: Using cached video URL");
        // Create a video object from cached URL
        input = { url: cachedVideoUrl };
        inputType = "youtube";
      } else if (cachedFileUrl) {
        dbg("FORCE RETRY: Using cached file URL");
        // For cached files, we'll need to use the retryGeneration function directly
        input = null; // Will be handled by retryGeneration
        inputType = "file-upload";
      } else {
        dbg(
          "FORCE RETRY: No input source found, but proceeding anyway..."
        );
        // If we have subtitles data, we can still retry with the last known configuration
        input = null;
        inputType = "retry";
      }
    }

    dbg("FORCE RETRY: Input determined:", { input, inputType });

    // For YouTube or Unified URL tabs, download the video first and switch to upload tab
    if (
      (inputType === "youtube" || activeTab === "unified-url") &&
      input &&
      input.url
    ) {
      try {
        // Set downloading state to true to disable the generate button
        setIsDownloading(true);
        setDownloadProgress(0);

        // Set status to downloading
        setStatus({
          message: t("output.downloadingVideo", "Downloading video..."),
          type: "loading",
        });

        // Create a wrapper for system-initiated tab changes
        const systemTabChange = (tab) => handleTabChange(tab, false);

        // Download and prepare the YouTube video
        const downloadedFile = await downloadAndPrepareYouTubeVideo(
          selectedVideo,
          setIsDownloading,
          setDownloadProgress,
          setStatus,
          setCurrentDownloadId,
          systemTabChange,
          setUploadedFile,
          setIsSrtOnlyMode,
          t
        );

        // Now process with the downloaded file
        input = downloadedFile;
        inputType = "file-upload";

        // Prepare options for subtitle generation
        const subtitleOptions = {};

        // Add user-provided subtitles if available and enabled
        if (useUserProvidedSubtitles && userProvidedSubtitles) {
          subtitleOptions.userProvidedSubtitles = userProvidedSubtitles;
        }

        // Check if we have a valid input file
        if (!input) {
          console.error("No valid input file available after download");
          setStatus({
            message: t(
              "errors.noValidInput",
              "No valid input file available. Please try again or use a different video."
            ),
            type: "error",
          });
          // Reset retrying state
          setIsRetrying(false);
          return;
        }

        // FORCE RETRY: Always retry generating subtitles, ignore existing data
        dbg(
          "FORCE RETRY: Forcing subtitle regeneration for downloaded video..."
        );
        await retryGeneration(input, inputType, apiKeysSet, subtitleOptions);
      } catch (error) {
        console.error("Error downloading video:", error);
        // Reset downloading state
        setIsDownloading(false);
        setDownloadProgress(0);
        // Reset retrying state
        setIsRetrying(false);
        setStatus({
          message: `${t(
            "errors.videoDownloadFailed",
            "Video download failed"
          )}: ${error.message}`,
          type: "error",
        });
        return;
      }
    } else if (activeTab === "file-upload" && uploadedFile) {
      input = uploadedFile;
      inputType = "file-upload";

      try {
        // Prepare options for subtitle generation
        const subtitleOptions = {};

        // Add user-provided subtitles if available and enabled
        if (useUserProvidedSubtitles && userProvidedSubtitles) {
          subtitleOptions.userProvidedSubtitles = userProvidedSubtitles;
        }

        // Check if we have a valid input file
        if (!input) {
          console.error("No valid input file available");
          setStatus({
            message: t(
              "errors.noValidInput",
              "No valid input file available. Please try again or upload a different file."
            ),
            type: "error",
          });
          return;
        }

        // FORCE RETRY: Always retry generating subtitles, ignore existing data
        dbg("FORCE RETRY: Forcing subtitle regeneration...");
        await retryGeneration(input, inputType, apiKeysSet, subtitleOptions);
      } finally {
        // Reset retrying state regardless of success or failure
        setIsRetrying(false);
        // Reset button animation state when generation is complete
        resetGeminiButtonState();
      }
    } else {
      // Direct retry without re-downloading - use retryGeneration function
      dbg("FORCE RETRY: Using direct retry method");

      try {
        // First, delete any existing subtitle files to force regeneration
        dbg("FORCE RETRY: Deleting existing subtitle files...");
        try {
          const response = await fetch("/api/delete-subtitles", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              // Send any identifiers that might help locate the files
              videoUrl:
                selectedVideo?.url || localStorage.getItem("current_video_url"),
              fileName:
                uploadedFile?.name || localStorage.getItem("current_file_name"),
              cacheId: localStorage.getItem("current_file_cache_id"),
            }),
          });

          if (response.ok) {
            dbg("FORCE RETRY: Subtitle files deleted successfully");
          } else {
            dbg(
              "FORCE RETRY: Could not delete subtitle files, but continuing..."
            );
          }
        } catch (deleteError) {
          dbg(
            "FORCE RETRY: Error deleting files, but continuing...",
            deleteError
          );
        }

        // Clear any cached subtitles data and preview section
        dbg("FORCE RETRY: Clearing all subtitle data and preview...");
        setSubtitlesData(null);
        localStorage.removeItem("subtitles_data");
        localStorage.removeItem("latest_segment_subtitles");

        // Clear any window-stored subtitle data that might be cached
        if (window.subtitlesData) {
          window.subtitlesData = null;
        }

        // Clear status to remove any success messages
        setStatus({
          message: t("output.retrying", "Retrying subtitle generation..."),
          type: "loading",
        });

        // Prepare options for subtitle generation
        const subtitleOptions = {};

        // Add user-provided subtitles if available and enabled
        if (useUserProvidedSubtitles && userProvidedSubtitles) {
          subtitleOptions.userProvidedSubtitles = userProvidedSubtitles;
        }

        dbg("FORCE RETRY: Calling retryGeneration with:", {
          input,
          inputType,
          subtitleOptions,
        });

        // Call retryGeneration directly - it will handle finding the right input
        await retryGeneration(input, inputType, apiKeysSet, subtitleOptions);

        dbg("FORCE RETRY: retryGeneration completed");
      } catch (error) {
        console.error("FORCE RETRY: Error during direct retry:", error);
        setStatus({
          message: `${t("errors.retryFailed", "Retry failed")}: ${
            error.message
          }`,
          type: "error",
        });
      } finally {
        // Reset retrying state regardless of success or failure
        setIsRetrying(false);
        // Reset button animation state when generation is complete
        resetGeminiButtonState();
      }
    }
  };

  return {
    handleSegmentSelect,
    handleProcessWithOptions,
    handleRetryGeneration,
  };
};
