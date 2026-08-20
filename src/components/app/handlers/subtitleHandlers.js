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
            return;
          }
        } catch (error) {
          setStatus({
            message: t("errors.invalidJsonFormat", "Invalid JSON format"),
            type: "error",
          });
          return;
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
        return;
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
      if (hasAnyVideoSource && typeof persistUploadedSubtitles === 'function') {
        await persistUploadedSubtitles(parsedSubtitles);
      }

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
        return;
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
    } catch (error) {
      console.error("Error parsing SRT file:", error);
      setStatus({
        message: t(
          "errors.srtParsingFailed",
          "Failed to parse SRT file: {{message}}",
          { message: error.message }
        ),
        type: "error",
      });
    }
  };

  return {
    validateInput,
    handleSrtUpload,
  };
};
