import { parseSrtContent } from "../../../utils/srtParser";
import { hasValidDownloadedVideo } from "../../../utils/videoUtils";

// Gated debug logging (enable in the browser console: localStorage.debug_logs = 'true')
const DEBUG_LOGS = (typeof window !== 'undefined') && (localStorage.getItem('debug_logs') === 'true');
const dbg = (...args) => { if (DEBUG_LOGS) console.log(...args); };

/**
 * Create subtitle-related handlers (input validation + SRT/JSON upload).
 * Closes over the app state setters passed in.
 */
export const createSubtitleHandlers = ({
  activeTab,
  selectedVideo,
  uploadedFile,
  isSrtOnlyMode,
  setStatus,
  setSubtitlesData,
  setIsDownloading,
  setDownloadProgress,
  setIsSrtOnlyMode,
  persistUploadedSubtitles,
  clearUploadedSubtitles,
  t,
}) => {
  /**
   * Validate input before generating subtitles
   */
  const validateInput = () => {
    // If we're in SRT-only mode, always return true
    if (isSrtOnlyMode) {
      return true;
    }

    // Otherwise, check for video/audio sources
    if (activeTab === "unified-url") {
      return selectedVideo !== null;
    } else if (activeTab === "youtube-url") {
      return selectedVideo !== null;
    } else if (activeTab === "youtube-search") {
      return selectedVideo !== null;
    } else if (activeTab === "file-upload") {
      return uploadedFile !== null;
    }
    return false;
  };

  /**
   * Handle SRT/JSON file upload
   */
  const handleSrtUpload = async (fileContent, fileName) => {
    try {
      let parsedSubtitles = [];

      // Check if it's a JSON file
      if (fileName && fileName.toLowerCase().endsWith(".json")) {
        try {
          const jsonData = JSON.parse(fileContent);
          if (Array.isArray(jsonData)) {
            parsedSubtitles = jsonData;
          } else {
            setStatus({
              message: t(
                "errors.invalidJsonFile",
                "JSON file must contain an array of subtitles"
              ),
              type: "error",
            });
            return Object.freeze({ status: 'refused' });
          }
        } catch (error) {
          setStatus({
            message: t("errors.invalidJsonFormat", "Invalid JSON format"),
            type: "error",
          });
          return Object.freeze({ status: 'refused' });
        }
      } else {
        // Parse as SRT content
        parsedSubtitles = parseSrtContent(fileContent);
      }

      if (parsedSubtitles.length === 0) {
        setStatus({
          message: t(
            "errors.invalidSrtFormat",
            "Invalid SRT format or empty file"
          ),
          type: "error",
        });
        return Object.freeze({ status: 'refused' });
      }

      // Check if we have any video sources (including pasted URLs)
      const hasUploadedFile =
        activeTab === "file-upload" && uploadedFile !== null;
      const hasDownloadedVideo = hasValidDownloadedVideo(uploadedFile);
      const hasYoutubeVideo =
        activeTab.includes("youtube") && selectedVideo !== null;
      const hasUnifiedVideo =
        activeTab === "unified-url" && selectedVideo !== null;

      // Determine if we should go into SRT-only mode
      // SRT-only mode: no video source at all (no uploaded file, no downloaded video, no pasted URL)
      const hasAnyVideoSource =
        hasUploadedFile ||
        hasDownloadedVideo ||
        hasYoutubeVideo ||
        hasUnifiedVideo;

      // The editor treats incoming rows as its saved baseline. On desktop that is truthful only
      // after the exact active project has acknowledged them; otherwise Save is disabled while the
      // imported file exists solely in React memory and disappears on the next launch.
      const persistence = typeof persistUploadedSubtitles === 'function'
        ? await persistUploadedSubtitles(parsedSubtitles)
        : Object.freeze({ status: 'deferred' });

      if (!hasAnyVideoSource) {
        setIsSrtOnlyMode(true);
        setSubtitlesData(parsedSubtitles);
        setStatus({
          message: t(
            "output.srtOnlyMode",
            "Working with SRT only. No video source available."
          ),
          type: "info",
        });
        return Object.freeze({ status: 'accepted', persistence });
      } else {
        // If we have any video source, make sure we're not in SRT-only mode
        setIsSrtOnlyMode(false);

        // Always reset downloading state when uploading an SRT file
        setIsDownloading(false);
        setDownloadProgress(0);
      }

      // For YouTube tabs, we don't need to download the video immediately when uploading an SRT file
      // Just set the subtitles data and show a success message
      if (activeTab.includes("youtube") && selectedVideo) {
        // Make sure we're not in downloading state
        setIsDownloading(false);
        setDownloadProgress(0);

        // Set the subtitles data directly
        setSubtitlesData(parsedSubtitles);
        const fileType =
          fileName && fileName.toLowerCase().endsWith(".json") ? "JSON" : "SRT";
        setStatus({
          message: t(
            "output.subtitleUploadSuccess",
            `${fileType} file uploaded successfully!`
          ),
          type: "success",
        });
      } else if (activeTab === "file-upload" && uploadedFile) {
        // For file upload tab, set the subtitles data directly
        setSubtitlesData(parsedSubtitles);
        const fileType =
          fileName && fileName.toLowerCase().endsWith(".json") ? "JSON" : "SRT";
        setStatus({
          message: t(
            "output.subtitleUploadSuccess",
            `${fileType} file uploaded successfully!`
          ),
          type: "success",
        });

        // With simplified processing, we don't need to prepare video segments when uploading SRT files
        // The subtitles are already available and ready to use
        dbg(
          "SRT file uploaded successfully, no video segment preparation needed"
        );
      } else if (hasUnifiedVideo) {
        // For unified URL input, set the subtitles data directly
        // We'll download the video when the user clicks "Generate Subtitles"

        // Make sure we're not in downloading state
        setIsDownloading(false);
        setDownloadProgress(0);

        setSubtitlesData(parsedSubtitles);
        setStatus({
          message: t(
            "output.srtUploadSuccess",
            "SRT file uploaded successfully!"
          ),
          type: "success",
        });
      } else if (hasDownloadedVideo) {
        // For downloaded video, set the subtitles data directly
        setSubtitlesData(parsedSubtitles);
        setStatus({
          message: t(
            "output.srtUploadSuccess",
            "SRT file uploaded successfully!"
          ),
          type: "success",
        });
      } else {
        // For any other case (like unified-url tab with no URL), just set the subtitles
        setSubtitlesData(parsedSubtitles);
        setStatus({
          message: t(
            "output.srtUploadSuccess",
            "SRT file uploaded successfully!"
          ),
          type: "success",
        });
      }
      return Object.freeze({ status: 'accepted', persistence });
    } catch (error) {
      const persistenceFailure = error?.code === 'projectScopeMismatch'
        || error?.code === 'subtitleCacheSaveFailed';
      console.error('Subtitle import failed:', error?.code || 'subtitleImportFailed');
      setStatus({
        message: persistenceFailure
          ? t('subtitlesInput.saveFailed', 'The subtitles could not be saved. Please try again.')
          : t(
            "errors.srtParsingFailed",
            "Failed to parse SRT file: {{message}}",
            { message: error.message }
          ),
        type: "error",
      });
      return Object.freeze({ status: 'refused', error });
    }
  };

  const handleSrtClear = async () => {
    const hasAnyVideoSource = uploadedFile !== null || selectedVideo !== null;
    try {
      const persistence = typeof clearUploadedSubtitles === 'function'
        ? await clearUploadedSubtitles()
        : Object.freeze({ status: 'deferred' });
      setSubtitlesData(null);
      if (!hasAnyVideoSource) setIsSrtOnlyMode(false);
      return Object.freeze({ status: 'cleared', persistence });
    } catch (error) {
      setStatus({
        message: t(
          'subtitlesInput.saveFailed',
          'The subtitles could not be saved. Please try again.'
        ),
        type: 'error',
      });
      return Object.freeze({ status: 'refused', error });
    }
  };

  return {
    validateInput,
    handleSrtUpload,
    handleSrtClear,
  };
};
