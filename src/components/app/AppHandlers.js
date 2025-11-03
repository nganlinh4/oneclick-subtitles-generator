import { useRef } from "react";
import { parseSrtContent } from "../../utils/srtParser";
import { resetGeminiButtonState } from "../../utils/geminiEffects";
import {
  cancelYoutubeVideoDownload,
  extractYoutubeVideoId,
} from "../../utils/videoDownloader";
import {
  cancelDouyinVideoDownload,
  extractDouyinVideoId,
} from "../../utils/douyinDownloader";
import { cancelGenericVideoDownload } from "../../utils/allSitesDownloader";
import { downloadAndPrepareYouTubeVideo } from "./VideoProcessingHandlers";
import { hasValidTokens } from "../../services/youtubeApiService";
import { hasValidDownloadedVideo } from "../../utils/videoUtils";

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
    setStatus,
    subtitlesData,
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
    setVideoSegments,
    // Video processing workflow
    setIsUploading,
    setSelectedSegment,
    setShowProcessingModal,
    uploadedFileData,
    setUploadedFileData,
    setIsProcessingSegment,
    t = (key, defaultValue) => defaultValue, // Provide a default implementation if t is not available
  } = appState;
  // Holds auto-downloaded subtitle content until video download completes
  const pendingAutoSubtitleRef = useRef(null);


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
        console.log(
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


    // Kick off auto subtitle fetch in parallel (do not await)
    try {
      if ((activeTab.includes("youtube") || activeTab === "unified-url") && selectedVideo?.url && (typeof localStorage === 'undefined' || localStorage.getItem('auto_import_site_subtitles') !== 'false')) {
        const videoUrl = selectedVideo.url;
        const storedPrefs = typeof localStorage !== 'undefined' ? localStorage.getItem('preferred_subtitle_langs') : null;
        const navLang = (typeof navigator !== 'undefined' && navigator.language) ? navigator.language : 'en-US';
        const defaultPrefs = [navLang, navLang.split('-')[0], 'en-US', 'en'];
        const preferredLangs = storedPrefs ? JSON.parse(storedPrefs) : defaultPrefs;
        const useCookies = typeof localStorage !== 'undefined' && localStorage.getItem('use_cookies_for_download') === 'true';

        (async () => {
          try {
            const resp = await fetch('http://localhost:3031/api/download-best-subtitle', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ url: videoUrl, preferredLangs, useCookies })
            });
            if (resp.ok && resp.status !== 204) {
              const data = await resp.json();
              if (data?.success && data?.content) {
                // Defer applying subtitles until after video download completes
                pendingAutoSubtitleRef.current = { content: data.content, fileName: data.fileName || 'site-subtitle.srt' };
              }
            } else if (resp.status !== 204) {
              const errText = await resp.text().catch(() => '');
              console.warn('[AppHandlers] Auto subtitle fetch failed:', resp.status, errText);
            }
          } catch (e) {
            console.warn('[AppHandlers] Auto subtitle fetch error:', e);
          }
        })();
      }
    } catch {}

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

      // Extract video ID and set it as current download
      let videoId;
      if (selectedVideo.source === "douyin") {
        videoId = extractDouyinVideoId(selectedVideo.url);
      } else if (
        selectedVideo.source === "all-sites" ||
        selectedVideo.source === "all-sites-url"
      ) {
        videoId = selectedVideo.id;
      } else {
        videoId = extractYoutubeVideoId(selectedVideo.url);
      }
      setCurrentDownloadId(videoId);

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

        processedFile = await downloadAndPrepareYouTubeVideo(
          input, // selectedVideo
          setIsDownloading,
          setDownloadProgress,
          setStatus,
          setCurrentDownloadId,
          systemTabChange,
          setUploadedFile,
          setIsSrtOnlyMode,
          t
        );

        // IMPORTANT: Check for cached subtitles immediately for downloaded videos
        // Use URL-based caching to find existing cached subtitles (like fvkz_wJ3z-4.json)
        if (processedFile && processedFile instanceof File) {
          try {
            // For downloaded videos, use URL-based cache ID to find existing cached subtitles
            const currentVideoUrl = localStorage.getItem("current_video_url");
            if (currentVideoUrl) {
              const { generateUrlBasedCacheId } = await import(
                "../../hooks/useSubtitles"
              );
              const urlBasedCacheId = await generateUrlBasedCacheId(
                currentVideoUrl
              );

              console.log(
                "[AppHandlers] Checking for cached subtitles for downloaded video (URL-based):",
                urlBasedCacheId
              );

              // Check if cached subtitles exist using URL-based cache ID
              const response = await fetch(
                `http://localhost:3031/api/subtitle-exists/${urlBasedCacheId}`
              );
              const result = await response.json();

              if (
                result.exists &&
                result.subtitles &&
                result.subtitles.length > 0
              ) {
                console.log(
                  "[AppHandlers] Found cached subtitles for downloaded video, loading immediately:",
                  result.subtitles.length,
                  "subtitles"
                );
                setSubtitlesData(result.subtitles);
                setStatus({
                  message: t(
                    "output.subtitlesLoadedFromCache",
                    "Subtitles loaded from cache! Select a segment to generate more."
                  ),
                  type: "success",
                });
              } else {
                console.log(
                  "[AppHandlers] No cached subtitles found for this downloaded video"
                );
                setStatus({
                  message: t(
                    "output.videoReady",
                    "Video ready for segment selection..."
                  ),
                  type: "loading",
                });
              }

              // Also generate file-based cache ID for Files API caching (file upload reuse)
              const { generateFileCacheId } = await import(
                "../../utils/cacheUtils"
              );
              const fileCacheId = await generateFileCacheId(processedFile);
              localStorage.setItem("current_file_cache_id", fileCacheId);
              console.log(
                "[AppHandlers] Generated file cache ID for Files API caching:",
                fileCacheId
              );
            } else {
              console.warn(
                "[AppHandlers] No current video URL found for downloaded video"
              );
              setStatus({
                message: t(
                  "output.videoReady",
                  "Video ready for segment selection..."
                ),
                type: "loading",
              });
            }
          } catch (error) {
            console.error(
              "[AppHandlers] Error checking cached subtitles for downloaded video:",
              error
            );
            setStatus({
              message: t(
                "output.videoReady",
                "Video ready for segment selection..."
              ),
              type: "loading",
            });
          }
        }
      } else {
        // File upload case - prepare the video for the new workflow
        processedFile = input; // uploadedFile

        // Clear any stale YouTube URL reference so Files API uses file-based caching for uploads
        try { localStorage.removeItem("current_video_url"); } catch {}

        // Check if we already have a blob URL for this file
        let blobUrl = localStorage.getItem("current_file_url");
        if (!blobUrl || !blobUrl.startsWith("blob:")) {
          // Create a new blob URL for the video and store it
          blobUrl = URL.createObjectURL(processedFile);
          localStorage.setItem("current_file_url", blobUrl);
          try {
            if (!window.__videoBlobMap) window.__videoBlobMap = {};
            window.__videoBlobMap[blobUrl] = processedFile;
          } catch {}
        }
        localStorage.setItem("current_file_name", processedFile.name);

        // Set the uploaded file in the app state so VideoPreview can use it
        setUploadedFile(processedFile);

        // IMPORTANT: Check for cached subtitles immediately for file uploads
        // This ensures the timeline shows cached subtitles right when output container appears
        try {
          const { generateFileCacheId } = await import(
            "../../utils/cacheUtils"
          );
          const cacheId = await generateFileCacheId(processedFile);
          localStorage.setItem("current_file_cache_id", cacheId);

          console.log(
            "[AppHandlers] Checking for cached subtitles for uploaded file:",
            cacheId
          );

          // Check if cached subtitles exist
          const response = await fetch(
            `http://localhost:3031/api/subtitle-exists/${cacheId}`
          );
          const result = await response.json();

          if (
            result.exists &&
            result.subtitles &&
            result.subtitles.length > 0
          ) {
            console.log(
              "[AppHandlers] Found cached subtitles, loading immediately:",
              result.subtitles.length,
              "subtitles"
            );
            setSubtitlesData(result.subtitles);
            setStatus({
              message: t(
                "output.subtitlesLoadedFromCache",
                "Subtitles loaded from cache! Select a segment to generate more."
              ),
              type: "success",
            });
          } else {
            console.log(
              "[AppHandlers] No cached subtitles found for this file"
            );
            setStatus({
              message: t(
                "output.videoReady",
                "Video ready for segment selection..."
              ),
              type: "loading",
            });
          }
        } catch (error) {
          console.error(
            "[AppHandlers] Error checking cached subtitles:",
            error
          );
          setStatus({
            message: t(
              "output.videoReady",
              "Video ready for segment selection..."
            ),
            type: "loading",
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
      console.log("[AppHandlers] Video processing complete, ready for segment selection");
      // Apply any pending auto-downloaded subtitles now that video download is complete
      try {
        if (pendingAutoSubtitleRef.current) {
          const { content, fileName } = pendingAutoSubtitleRef.current;
          pendingAutoSubtitleRef.current = null;
          await handleSrtUpload(content, fileName || 'site-subtitle.srt');
          // Special notice for auto-downloaded subtitle (not green, with glow/particles)
          setStatus({
            message: t('output.autoSubtitleNotice', 'Below are subtitles provided while the video is downloading. If you don’t like them, press Ctrl+A to select all and delete/regenerate'),
            type: 'auto-subtitle'
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
      console.log(
        "[ProcessWithOptions] Started processing segment, animation should begin"
      );

      if (!uploadedFileData) {
        throw new Error("No uploaded file data available");
      }

      // Branch: Nvidia Parakeet (local ASR)
      if (options?.method === 'nvidia-parakeet') {
        try {
          const seg = options.segment;
          if (!seg || typeof seg.start !== 'number' || typeof seg.end !== 'number') {
            throw new Error('Invalid segment selection');
          }

          // Determine sequential sub-segments based on maxDurationPerRequest (seconds)
          const windowSec = Math.max(1, Math.floor(options.maxDurationPerRequest || 0));
          let subSegments = [seg];
          try {
            if (windowSec && (seg.end - seg.start) > windowSec) {
              const { splitSegmentForParallelProcessing } = await import('../../utils/parallelProcessingUtils');
              subSegments = splitSegmentForParallelProcessing(seg, windowSec);
            }
          } catch (e) {
            // Fallback: simple slicer
            const total = seg.end - seg.start;
            const n = Math.ceil(total / windowSec);
            subSegments = Array.from({ length: n }).map((_, i) => ({
              start: seg.start + i * (total / n),
              end: i === n - 1 ? seg.end : seg.start + (i + 1) * (total / n)
            }));
          }

          // Show processing ranges overlay
          try {
            if (subSegments && subSegments.length > 1) {
              window.dispatchEvent(new CustomEvent('processing-ranges', { detail: { ranges: subSegments } }));
            }
          } catch {}

          const { extractSegmentAsWavBase64 } = await import('../../utils/audioUtils');
          const { mergeSegmentSubtitles } = await import('../../utils/subtitle/subtitleMerger');
          const { API_BASE_URL } = await import('../../config');

          // Process each sub-segment sequentially
          for (let i = 0; i < subSegments.length; i++) {
            const part = subSegments[i];
            setStatus({ message: `Transcribing with Parakeet ASR (${i + 1}/${subSegments.length})...`, type: 'loading' });

            // Extract WAV base64 for just this sub-segment
            const wavBase64 = await extractSegmentAsWavBase64(uploadedFileData, part.start, part.end);

            const resp = await fetch(`${API_BASE_URL}/parakeet/transcribe`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                audio_base64: wavBase64,
                filename: (uploadedFileData && uploadedFileData.name) || 'segment.wav',
                segment_strategy: options.parakeetStrategy || 'char',
                max_chars: options.parakeetMaxChars || 60,
                max_words: options.parakeetMaxWords || 7
              })
            });

            if (!resp.ok) {
              const errText = await resp.text().catch(() => '');
              throw new Error(`Parakeet API error: ${resp.status} ${errText}`);
            }

            const data = await resp.json();
            const segmentSubs = Array.isArray(data?.segments) ? data.segments : [];

            // Offset timestamps by sub-segment start to map back to full timeline
            const offset = part.start || 0;
            const newSegmentSubs = segmentSubs.map(s => ({
              start: (s.start || 0) + offset,
              end: (s.end || 0) + offset,
              text: s.segment || s.text || ''
            }));

            // Merge into existing subtitles, clamping edge overlaps instead of deleting
            await new Promise((resolve) => {
              setSubtitlesData(current => {
                const existing = current || [];
                const overlaps = existing.filter(s => s.start < part.end && s.end > part.start);
                const merged = mergeSegmentSubtitles(existing, newSegmentSubs, part);
                resolve();
                return merged;
              });
            });
          }

          // Clear overlay and finish
          try {
            window.dispatchEvent(new CustomEvent('processing-ranges', { detail: { ranges: [] } }));
          } catch {}

          setStatus({ message: 'Parakeet transcription complete', type: 'success' });
          setIsProcessingSegment(false);
          return; // Exit early (no Gemini flow)
        } catch (e) {
          console.error('[Parakeet] Error:', e);
          setStatus({ message: `Parakeet processing failed: ${e.message}`, type: 'error' });
          setIsProcessingSegment(false);
          try {
            window.dispatchEvent(new CustomEvent('processing-ranges', { detail: { ranges: [] } }));
          } catch {}
          return;
        }
      }

      // Prepare options for subtitle generation
      const subtitleOptions = {
        segment: options.segment,
        fps: options.fps,
        mediaResolution: options.mediaResolution,
        model: options.model,
        maxDurationPerRequest: options.maxDurationPerRequest,
        autoSplitSubtitles: options.autoSplitSubtitles,
        maxWordsPerSubtitle: options.maxWordsPerSubtitle,
        inlineExtraction: options.inlineExtraction === true,
      };

      // Add custom prompt if provided
      if (options.customPrompt) {
        // Store the custom prompt temporarily for this processing session
        sessionStorage.setItem("current_session_prompt", options.customPrompt);
        console.log(
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
            const { splitSegmentForParallelProcessing } = await import('../../utils/parallelProcessingUtils');
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
          uploadedFileData,
          "file-upload",
          apiKeysSet,
          subtitleOptions
        );
      } finally {
        // Clear the session prompt after processing
        sessionStorage.removeItem("current_session_prompt");
        console.log(
          "[ProcessWithOptions] Cleared session prompt after processing"
        );

        // Clear processing state when done
        setIsProcessingSegment(false);
        // Clear processing ranges overlay
        try {
          window.dispatchEvent(new CustomEvent('processing-ranges', { detail: { ranges: [] } }));
        } catch {}
        console.log(
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
    console.log("FORCE RETRY: handleRetryGeneration called");

    // Prevent multiple simultaneous retries
    if (isRetrying) {
      console.log("FORCE RETRY: Already retrying, ignoring duplicate call");
      return;
    }

    // Only check for API key - this is the minimum requirement
    if (!apiKeysSet.gemini) {
      console.log("No Gemini API key available");
      setStatus({
        message: t("errors.apiKeyRequired", "Gemini API key is required"),
        type: "error",
      });
      return;
    }

    console.log("FORCE RETRY: Setting retrying state to true");
    // Set retrying state to true immediately
    setIsRetrying(true);

    // Clear the segments-status before starting the retry process
    setSegmentsStatus([]);

    console.log("FORCE RETRY: Determining input source...");
    let input, inputType;

    // Try to get input from current state or localStorage
    // Priority: 1. Current selected video/file, 2. localStorage cached data

    if (uploadedFile) {
      console.log("FORCE RETRY: Using uploaded file");
      input = uploadedFile;
      inputType = "file-upload";
    } else if (selectedVideo) {
      console.log("FORCE RETRY: Using selected video");
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
        console.log("FORCE RETRY: Using cached video URL");
        // Create a video object from cached URL
        input = { url: cachedVideoUrl };
        inputType = "youtube";
      } else if (cachedFileUrl) {
        console.log("FORCE RETRY: Using cached file URL");
        // For cached files, we'll need to use the retryGeneration function directly
        input = null; // Will be handled by retryGeneration
        inputType = "file-upload";
      } else {
        console.log(
          "FORCE RETRY: No input source found, but proceeding anyway..."
        );
        // If we have subtitles data, we can still retry with the last known configuration
        input = null;
        inputType = "retry";
      }
    }

    console.log("FORCE RETRY: Input determined:", { input, inputType });

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
        console.log(
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
        console.log("FORCE RETRY: Forcing subtitle regeneration...");
        await retryGeneration(input, inputType, apiKeysSet, subtitleOptions);
      } finally {
        // Reset retrying state regardless of success or failure
        setIsRetrying(false);
        // Reset button animation state when generation is complete
        resetGeminiButtonState();
      }
    } else {
      // Direct retry without re-downloading - use retryGeneration function
      console.log("FORCE RETRY: Using direct retry method");

      try {
        // First, delete any existing subtitle files to force regeneration
        console.log("FORCE RETRY: Deleting existing subtitle files...");
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
            console.log("FORCE RETRY: Subtitle files deleted successfully");
          } else {
            console.log(
              "FORCE RETRY: Could not delete subtitle files, but continuing..."
            );
          }
        } catch (deleteError) {
          console.log(
            "FORCE RETRY: Error deleting files, but continuing...",
            deleteError
          );
        }

        // Clear any cached subtitles data and preview section
        console.log("FORCE RETRY: Clearing all subtitle data and preview...");
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

        console.log("FORCE RETRY: Calling retryGeneration with:", {
          input,
          inputType,
          subtitleOptions,
        });

        // Call retryGeneration directly - it will handle finding the right input
        await retryGeneration(input, inputType, apiKeysSet, subtitleOptions);

        console.log("FORCE RETRY: retryGeneration completed");
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
    undefined,
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
      appState.setTimeFormat(timeFormat);
    }

    // Save waveform for long videos setting
    if (showWaveformLongVideosSetting !== undefined) {
      localStorage.setItem("show_waveform_long_videos", showWaveformLongVideosSetting.toString());
      appState.setShowWaveformLongVideos(showWaveformLongVideosSetting);

      // Dispatch custom event for immediate effect
      window.dispatchEvent(
        new CustomEvent("waveformLongVideosChanged", {
          detail: { value: showWaveformLongVideosSetting },
        })
      );
    }

    // Save Gemini model
    if (geminiModel) {
      localStorage.setItem("gemini_model", geminiModel);
    }

    // Video optimization is now always enabled - no need to save this setting

    if (optimizedResolutionSetting) {
      localStorage.setItem("optimized_resolution", optimizedResolutionSetting);
      appState.setOptimizedResolution(optimizedResolutionSetting);
    }

    if (useOptimizedPreviewSetting !== undefined) {
      localStorage.setItem(
        "use_optimized_preview",
        useOptimizedPreviewSetting.toString()
      );
      appState.setUseOptimizedPreview(useOptimizedPreviewSetting);
      console.log(
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
      appState.setUseCookiesForDownload(useCookiesForDownloadSetting);
    }

    if (enableYoutubeSearchSetting !== undefined) {
      localStorage.setItem(
        "enable_youtube_search",
        enableYoutubeSearchSetting.toString()
      );
      appState.setEnableYoutubeSearch(enableYoutubeSearchSetting);
    }

    // Update state based on the selected authentication method
    const useOAuth = localStorage.getItem("use_youtube_oauth") === "true";
    const hasOAuthTokens = hasValidTokens();

    appState.setApiKeysSet({
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
