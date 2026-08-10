import { downloadAndPrepareYouTubeVideo } from "../VideoProcessingHandlers";

// Gated debug logging (enable in the browser console: localStorage.debug_logs = 'true')
const DEBUG_LOGS = (typeof window !== 'undefined') && (localStorage.getItem('debug_logs') === 'true');
const dbg = (...args) => { if (DEBUG_LOGS) console.log(...args); };

/**
 * Create download-related handlers.
 * Closes over the app state setters passed in.
 *
 * Cross-handler deps passed in as params to keep dependency direction one-way:
 *  - handleSrtUpload (from subtitleHandlers) for applying pending auto subtitles
 *  - handleTabChange (from settingsHandlers) for system-initiated tab changes
 *  - pendingAutoSubtitleRef shared with handleGenerateSubtitles in AppHandlers
 */
export const createDownloadHandlers = ({
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
}) => {
  /**
   * Start background video processing (download/upload)
   */
  const startBackgroundVideoProcessing = async (input, inputType) => {
    try {
      let processedFile;

      if (inputType === "youtube") {
        // Download YouTube video in background
        const systemTabChange = (tab) => {
          // Only update the current active tab for system-initiated changes
          localStorage.setItem("lastActiveTab", tab);
          setActiveTab(tab);
        };
        let preferredSubtitleLanguages = [];
        if (localStorage.getItem('auto_import_site_subtitles') !== 'false') {
          try {
            const stored = localStorage.getItem('preferred_subtitle_langs');
            const navigationLanguage = navigator.language || 'en-US';
            preferredSubtitleLanguages = stored
              ? JSON.parse(stored)
              : [navigationLanguage, navigationLanguage.split('-')[0], 'en-US', 'en'];
            if (!Array.isArray(preferredSubtitleLanguages)) preferredSubtitleLanguages = [];
            preferredSubtitleLanguages = preferredSubtitleLanguages
              .filter((language) => (
                typeof language === 'string' && /^[A-Za-z0-9._-]{1,35}$/.test(language)
              ))
              .slice(0, 32);
          } catch {
            preferredSubtitleLanguages = [];
          }
        }

        processedFile = await downloadAndPrepareYouTubeVideo(
          input, // selectedVideo
          setIsDownloading,
          setDownloadProgress,
          setStatus,
          setCurrentDownloadId,
          systemTabChange,
          setUploadedFile,
          setIsSrtOnlyMode,
          t,
          {
            preferredSubtitleLanguages,
            onSubtitle: (subtitle) => {
              pendingAutoSubtitleRef.current = {
                content: subtitle.content,
                fileName: subtitle.filename || 'site-subtitle.srt',
              };
            },
          }
        );

        // IMPORTANT: Check for cached subtitles immediately for downloaded videos
        // Use URL-based caching to find existing cached subtitles (like fvkz_wJ3z-4.json)
        if (processedFile && processedFile instanceof File) {
          try {
            // For downloaded videos, use URL-based cache ID to find existing cached subtitles
            const currentVideoUrl = localStorage.getItem("current_video_url");
            if (currentVideoUrl) {
              const { generateUrlBasedCacheId, getCachedSubtitles } = await import(
                "../../../services/subtitleCache"
              );
              const urlBasedCacheId = await generateUrlBasedCacheId(
                currentVideoUrl
              );

              dbg(
                "[AppHandlers] Checking for cached subtitles for downloaded video (URL-based):",
                urlBasedCacheId
              );

              const cachedSubtitles = await getCachedSubtitles(
                urlBasedCacheId,
                currentVideoUrl
              );

              if (
                cachedSubtitles &&
                cachedSubtitles.length > 0
              ) {
                dbg(
                  "[AppHandlers] Found cached subtitles for downloaded video, loading immediately:",
                  cachedSubtitles.length,
                  "subtitles"
                );
                setSubtitlesData(cachedSubtitles);
                setStatus({
                  message: t(
                    "output.subtitlesLoadedFromCache",
                    "Subtitles loaded from cache! Select a segment to generate more."
                  ),
                  type: "success",
                });
              } else {
                dbg(
                  "[AppHandlers] No cached subtitles found for this downloaded video"
                );
                const isAudio = processedFile?.type?.startsWith('audio/');
                setStatus({
                  message: isAudio ? t(
                    "output.audioReady",
                    "Audio ready for segment selection..."
                  ) : t(
                    "output.videoReady",
                    "Video ready for segment selection..."
                  ),
                  type: "info",
                });
              }

              // Also generate file-based cache ID for Files API caching (file upload reuse)
              const { generateFileCacheId } = await import(
                "../../../utils/cacheUtils"
              );
              const fileCacheId = await generateFileCacheId(processedFile);
              localStorage.setItem("current_file_cache_id", fileCacheId);
              dbg(
                "[AppHandlers] Generated file cache ID for Files API caching:",
                fileCacheId
              );
            } else {
              console.warn(
                "[AppHandlers] No current video URL found for downloaded video"
              );
              const isAudio = processedFile?.type?.startsWith('audio/');
              setStatus({
                message: isAudio ? t(
                  "output.audioReady",
                  "Audio ready for segment selection..."
                ) : t(
                  "output.videoReady",
                  "Video ready for segment selection..."
                ),
                type: "info",
              });
            }
          } catch (error) {
            console.error(
              "[AppHandlers] Error checking cached subtitles for downloaded video:",
              error
            );
            const isAudio = processedFile?.type?.startsWith('audio/');
            setStatus({
              message: isAudio ? t(
                "output.audioReady",
                "Audio ready for segment selection..."
              ) : t(
                "output.videoReady",
                "Video ready for segment selection..."
              ),
              type: "info",
            });
          }
        }
      } else {
        // File upload case - prepare the video for the new workflow
        processedFile = input; // uploadedFile

        // Clear any stale YouTube URL reference so Files API uses file-based caching for uploads
        try { localStorage.removeItem("current_video_url"); } catch {
          // Compatibility storage cleanup is best effort.
        }

        // Check if we already have a blob URL for this file
        let blobUrl = localStorage.getItem("current_file_url");
        if (!blobUrl || !blobUrl.startsWith("blob:")) {
          // Create a new blob URL for the video and store it
          blobUrl = URL.createObjectURL(processedFile);
          localStorage.setItem("current_file_url", blobUrl);
          try {
            if (!window.__videoBlobMap) window.__videoBlobMap = {};
            window.__videoBlobMap[blobUrl] = processedFile;
          } catch {
            // The optional browser-preview blob registry may be unavailable.
          }
        }
        localStorage.setItem("current_file_name", processedFile.name);

        // Set the uploaded file in the app state so VideoPreview can use it
        setUploadedFile(processedFile);

        // IMPORTANT: Check for cached subtitles immediately for file uploads
        // This ensures the timeline shows cached subtitles right when output container appears
        try {
          const { generateFileCacheId } = await import(
            "../../../utils/cacheUtils"
          );
          const cacheId = await generateFileCacheId(processedFile);
          localStorage.setItem("current_file_cache_id", cacheId);

          dbg(
            "[AppHandlers] Checking for cached subtitles for uploaded file:",
            cacheId
          );

          const { getCachedSubtitles } = await import(
            "../../../services/subtitleCache"
          );
          const cachedSubtitles = await getCachedSubtitles(cacheId);

          if (
            cachedSubtitles &&
            cachedSubtitles.length > 0
          ) {
            dbg(
              "[AppHandlers] Found cached subtitles, loading immediately:",
              cachedSubtitles.length,
              "subtitles"
            );
            setSubtitlesData(cachedSubtitles);
            setStatus({
              message: t(
                "output.subtitlesLoadedFromCache",
                "Subtitles loaded from cache! Select a segment to generate more."
              ),
              type: "success",
            });
          } else {
            dbg(
              "[AppHandlers] No cached subtitles found for this file"
            );
            const isAudio = processedFile?.type?.startsWith('audio/');
            setStatus({
              message: isAudio ? t(
                "output.audioReady",
                "Audio ready for segment selection..."
              ) : t(
                "output.videoReady",
                "Video ready for segment selection..."
              ),
              type: "info",
            });
          }
        } catch (error) {
          console.error(
            "[AppHandlers] Error checking cached subtitles:",
            error
          );
          const isAudio = processedFile?.type?.startsWith('audio/');
          setStatus({
            message: isAudio ? t(
              "output.audioReady",
              "Audio ready for segment selection..."
            ) : t(
              "output.videoReady",
              "Video ready for segment selection..."
            ),
            type: "info",
          });
        }
      }

      // Store the processed file for later use
      setUploadedFileData(processedFile);

      // Note: We don't clear cached file URIs here anymore to allow reuse within the same session
      // The Files API caching logic in core.js will handle reusing uploaded files efficiently

      // Update status to indicate upload is complete and waiting for segment selection
      setIsUploading(false);
      setIsDownloading(false);

      // Only set the default status if we haven't already set a cache-related status
      // We'll just set the default status since the cache-related status was already set above if needed
      // The cache logic above handles setting the appropriate status message
      dbg("[AppHandlers] Video processing complete, ready for segment selection");
      // Apply any pending auto-downloaded subtitles now that video download is complete
      try {
        if (pendingAutoSubtitleRef.current) {
          const { content, fileName } = pendingAutoSubtitleRef.current;
          pendingAutoSubtitleRef.current = null;
          await handleSrtUpload(content, fileName || 'site-subtitle.srt');
          // Special notice for auto-downloaded subtitle (not green, with glow/particles)
          setStatus({
            message: t('output.autoSubtitleNotice', 'Below are subtitles provided while the video is downloading. If you don’t like them, press Ctrl+A to select all and delete/regenerate'),
            type: 'warning',
            duration: 15000
          });
        }
      } catch (e) {
        console.warn('[AppHandlers] Failed to apply pending auto subtitle:', e);
      }


    } catch (error) {
      console.error("Error in background processing:", error);
      setIsUploading(false);
      setIsDownloading(false);
      setStatus({
        message: `${t("errors.processingFailed", "Processing failed")}: ${
          error.message
        }`,
        type: "error",
      });
    }
  };

  // Create a wrapper function for downloadAndPrepareYouTubeVideo
  const handleDownloadAndPrepareYouTubeVideo = async () => {
    if (!selectedVideo) {
      console.error("No YouTube video selected");
      return;
    }

    // Create a wrapper for system-initiated tab changes
    const systemTabChange = (tab) => handleTabChange(tab, false);

    await downloadAndPrepareYouTubeVideo(
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
  };

  return {
    startBackgroundVideoProcessing,
    handleDownloadAndPrepareYouTubeVideo,
  };
};
