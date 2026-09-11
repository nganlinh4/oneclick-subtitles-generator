import { downloadAndPrepareYouTubeVideo } from "../VideoProcessingHandlers";
import { isNativeMediaDescriptor } from "../../../platform/mediaService";
import {
  generateUrlBasedCacheId,
  getCachedSubtitles,
} from "../../../services/subtitleCache";
import {
  getCurrentCacheId as getRulesCacheId,
} from "../../../utils/transcriptionRulesStore";
import {
  getCurrentCacheId as getSubtitlesCacheId,
} from "../../../utils/userSubtitlesStore";
import { resolveProjectForCache } from "../../../platform/subtitleProjectStore";
import { activateSubtitleProjectBinding } from "../../../platform/subtitleProjectBinding";
import { parseSrtContent } from "../../../utils/srtParser";
import {
  assertAutoGenerationRequestActive,
  AutoGenerationOwnershipError,
  createPreparedAutoMedia,
  isAutoGenerationCancellation,
  isAutoGenerationRequest,
  sourceIdentityForAsset,
  sourceIdentityForUrl,
} from "../../../utils/autoGenerationOwnership";
import { isDesktopRuntime } from "../../../platform/desktopRuntime";
import { readNativeMediaSession } from "../../../platform/nativeMediaOwnership";
import { registerBrowserMediaBlob } from "../../../platform/browserMediaBlobRegistry";
import { showErrorToast, showWarningToast } from "../../../utils/toastUtils";

// Gated debug logging (enable in the browser console: localStorage.debug_logs = 'true')
const DEBUG_LOGS = (typeof window !== 'undefined') && (localStorage.getItem('debug_logs') === 'true');
const dbg = (...args) => { if (DEBUG_LOGS) console.log(...args); };
const pendingSubtitleEntries = new WeakMap();
const activePreparationTokens = new WeakMap();

const entriesForPendingRef = (pendingRef) => {
  let entries = pendingSubtitleEntries.get(pendingRef);
  if (!entries) {
    entries = new Map();
    pendingSubtitleEntries.set(pendingRef, entries);
  }
  return entries;
};

const activateProjectCache = async (cacheId) => {
  if (typeof cacheId !== "string" || cacheId.length === 0) {
    throw new Error("The prepared media could not be bound to a subtitle project.");
  }
  return activateSubtitleProjectBinding(cacheId);
};

/**
 * Create download-related handlers.
 * Closes over the app state setters passed in.
 *
 * Cross-handler deps passed in as params to keep dependency direction one-way:
 *  - handleSrtUpload (from subtitleHandlers) for applying pending auto subtitles
 *  - pendingAutoSubtitleRef shared with handleGenerateSubtitles in AppHandlers
 */
export const createDownloadHandlers = ({
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
  t,
}) => {
  /**
   * Start background video processing (download/upload)
   */
  const startBackgroundVideoProcessing = async (input, inputType, autoRequest = null) => {
    const preparationToken = Object.freeze({});
    activePreparationTokens.set(pendingAutoSubtitleRef, preparationToken);
    const ownsPreparation = () => (
      activePreparationTokens.get(pendingAutoSubtitleRef) === preparationToken
    );
    let ownedPendingToken = null;
    let ownedPendingEntries = null;
    try {
      let processedFile;
      let projectCacheId = null;
      let projectId = null;
      let preparedSubtitleCandidate = null;
      const guardedAutoRequest = isAutoGenerationRequest(autoRequest) ? autoRequest : null;
      const inputIsNativeMedia = inputType !== "youtube" && isNativeMediaDescriptor(input);
      let expectedAssetId = inputIsNativeMedia ? input.assetId : null;
      let sourceIdentity = inputType === "youtube"
        ? sourceIdentityForUrl(input?.url)
        : (inputIsNativeMedia ? sourceIdentityForAsset(input.assetId) : null);
      const pendingToken = Object.freeze({
        runId: guardedAutoRequest?.runId ?? null,
        sourceIdentity,
      });
      const pendingEntries = entriesForPendingRef(pendingAutoSubtitleRef);
      ownedPendingToken = pendingToken;
      ownedPendingEntries = pendingEntries;
      const clearOwnedPendingSubtitle = () => {
        pendingEntries.delete(pendingToken);
        if (pendingAutoSubtitleRef.current?.token === pendingToken) {
          pendingAutoSubtitleRef.current = null;
        }
      };
      const ownershipFailure = () => {
        if (guardedAutoRequest) return new AutoGenerationOwnershipError();
        const error = new Error('The active subtitle project changed during media preparation.');
        error.code = 'projectScopeMismatch';
        return error;
      };
      const assertPreparationOwnership = (expectedProjectId = null) => {
        if (!ownsPreparation()) throw ownershipFailure();
        if (guardedAutoRequest) {
          assertAutoGenerationRequestActive(guardedAutoRequest);
          if (isDesktopRuntime()) {
            // Before a URL download publishes its candidate there is deliberately no active B
            // media identity yet. The preparation token and abort signal own that interval; the
            // URL input must never forge ownership by overwriting A's compatibility keys. Once B
            // is claimed, its exact native asset/session becomes mandatory at every boundary.
            if (expectedAssetId !== null) {
              const session = readNativeMediaSession();
              if (session === null
                  || session.assetId !== expectedAssetId
                  || (projectCacheId !== null && session.cacheId !== projectCacheId)
                  || (expectedProjectId !== null && session.projectId !== expectedProjectId)) {
                throw new AutoGenerationOwnershipError();
              }
            }
          } else if (sourceIdentity?.startsWith('url:')) {
            const currentUrl = localStorage.getItem('current_video_url');
            if (`url:${currentUrl ?? ''}` !== sourceIdentity) {
              throw new AutoGenerationOwnershipError();
            }
          } else if (sourceIdentity?.startsWith('asset:')) {
            const currentAssetId = localStorage.getItem('current_file_cache_id');
            if (`asset:${currentAssetId ?? ''}` !== sourceIdentity) {
              throw new AutoGenerationOwnershipError();
            }
          }
          if (!isDesktopRuntime()
              && expectedAssetId !== null
              && localStorage.getItem('current_file_cache_id') !== expectedAssetId) {
            throw new AutoGenerationOwnershipError();
          }
        }
        if (expectedProjectId !== null
            && (projectId !== expectedProjectId
              || !projectCacheId
              || getRulesCacheId() !== projectCacheId
              || getSubtitlesCacheId() !== projectCacheId)) {
          throw ownershipFailure();
        }
      };
      const assertPreparationProjectOwnership = async (expectedProjectId) => {
        assertPreparationOwnership(expectedProjectId);
        const resolved = await resolveProjectForCache(projectCacheId, { create: false });
        assertPreparationOwnership(expectedProjectId);
        if (resolved?.projectId !== expectedProjectId) throw ownershipFailure();
      };
      const adoptNativeProjectAuthority = async (media) => {
        const session = readNativeMediaSession();
        if (session === null
            || session.assetId !== media?.assetId
            || typeof session.cacheId !== 'string'
            || typeof session.projectId !== 'string') throw ownershipFailure();
        expectedAssetId = session.assetId;
        projectCacheId = session.cacheId;
        projectId = session.projectId;
        await assertPreparationProjectOwnership(projectId);
      };
      assertPreparationOwnership();

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
            autoRequest: guardedAutoRequest,
            onSubtitle: (subtitle) => {
              assertPreparationOwnership(projectId);
              const pending = Object.freeze({
                token: pendingToken,
                runId: guardedAutoRequest?.runId ?? null,
                sourceIdentity,
                content: subtitle.content,
                fileName: subtitle.filename || 'site-subtitle.srt',
              });
              pendingEntries.set(pendingToken, pending);
              pendingAutoSubtitleRef.current = pending;
              assertPreparationOwnership();
            },
          }
        );
        expectedAssetId = isNativeMediaDescriptor(processedFile)
          ? processedFile.assetId
          : null;
        assertPreparationOwnership();

        // Bind the URL alias before analysis or editing can observe project-scoped
        // rules/subtitles. Native downloads return descriptors rather than Files,
        // so this must not be hidden behind an instanceof File check.
        if (processedFile) {
          try {
            const nativeAuthority = isDesktopRuntime()
              && isNativeMediaDescriptor(processedFile);
            const currentVideoUrl = nativeAuthority
              ? input.url
              : localStorage.getItem("current_video_url");
            if (currentVideoUrl) {
              let urlBasedCacheId;
              if (nativeAuthority) {
                // Native download activation already committed this exact media/project pair.
                // Rebinding it here created a second publisher and a race with newer selections.
                await adoptNativeProjectAuthority(processedFile);
                urlBasedCacheId = projectCacheId;
              } else {
                urlBasedCacheId = await generateUrlBasedCacheId(currentVideoUrl);
                const binding = await activateProjectCache(urlBasedCacheId);
                projectCacheId = urlBasedCacheId;
                projectId = binding.projectId;
                if (!projectId) throw new Error('The prepared media has no durable subtitle project.');
                assertPreparationOwnership(projectId);
              }

              dbg(
                "[AppHandlers] Checking for cached subtitles for downloaded video (URL-based):",
                urlBasedCacheId
              );

              let cachedSubtitles;
              try {
                cachedSubtitles = await getCachedSubtitles(
                  urlBasedCacheId,
                  currentVideoUrl,
                  { expectedProjectId: projectId }
                );
              } catch (error) {
                await assertPreparationProjectOwnership(projectId);
                throw error;
              }
              await assertPreparationProjectOwnership(projectId);

              if (
                cachedSubtitles &&
                cachedSubtitles.length > 0
              ) {
                dbg(
                  "[AppHandlers] Found cached subtitles for downloaded video, loading immediately:",
                  cachedSubtitles.length,
                  "subtitles"
                );
                if (guardedAutoRequest) {
                  preparedSubtitleCandidate = cachedSubtitles;
                } else {
                  setSubtitlesData(cachedSubtitles);
                  setStatus({
                    message: t(
                      "output.subtitlesLoadedFromCache",
                      "Subtitles loaded from cache! Select a segment to generate more."
                    ),
                    type: "success",
                  });
                }
              } else {
                dbg(
                  "[AppHandlers] No cached subtitles found for this downloaded video"
                );
                // The processing modal already owns the selected range and next action. Clear the
                // transient download/upload state instead of covering that modal with a redundant
                // "ready for segment selection" toast.
                setStatus({});
              }

              if (processedFile instanceof File) {
                // Browser builds still use a file hash for Files API upload reuse.
                const { generateFileCacheId } = await import(
                  "../../../utils/cacheUtils"
                );
                const fileCacheId = await generateFileCacheId(processedFile);
                localStorage.setItem("current_file_cache_id", fileCacheId);
                dbg(
                  "[AppHandlers] Generated file cache ID for Files API caching:",
                  fileCacheId
                );
              }
            } else {
              console.warn(
                "[AppHandlers] No current video URL found for downloaded video"
              );
              setStatus({});
            }
          } catch (error) {
            if (isAutoGenerationCancellation(error, guardedAutoRequest?.signal)
                || error instanceof AutoGenerationOwnershipError) throw error;
            if (error?.code === 'projectScopeMismatch'
                || error?.code === 'subtitleProjectBindingFailed') throw error;
            console.error(
              "[AppHandlers] Error checking cached subtitles for downloaded video:",
              error?.code || 'subtitleCacheReadFailed'
            );
            showWarningToast(t(
              "output.subtitlesCacheLoadFailed",
              "Media is ready, but saved subtitles could not be loaded."
            ));
          }
        }
      } else {
        // File upload case - prepare the video for the new workflow
        processedFile = input; // uploadedFile
        const nativeMedia = inputIsNativeMedia;

        // Clear any stale YouTube URL reference so Files API uses file-based caching for uploads
        try { localStorage.removeItem("current_video_url"); } catch {
          // Compatibility storage cleanup is best effort.
        }

        if (nativeMedia) {
          // Native media is already owned by the desktop runtime. Preserve its
          // opaque playback capability instead of treating the descriptor as a
          // browser File/Blob.
          localStorage.setItem("current_file_url", processedFile.playbackUrl);
        } else {
          // Check if we already have a blob URL for this browser file.
          let blobUrl = localStorage.getItem("current_file_url");
          if (!blobUrl || !blobUrl.startsWith("blob:")) {
            blobUrl = URL.createObjectURL(processedFile);
            localStorage.setItem("current_file_url", blobUrl);
            registerBrowserMediaBlob(blobUrl, processedFile);
          }
        }
        localStorage.setItem("current_file_name", processedFile.name);

        // IMPORTANT: Check for cached subtitles immediately for file uploads
        // This ensures the timeline shows cached subtitles right when output container appears
        try {
          let cacheId = processedFile.assetId;
          if (!nativeMedia) {
            const { generateFileCacheId } = await import(
              "../../../utils/cacheUtils"
            );
            cacheId = await generateFileCacheId(processedFile);
          }
          let binding = null;
          if (nativeMedia && isDesktopRuntime()) {
            // FileUploadInput has already committed the native selection and its project. Consume
            // that capability instead of opening another activation transaction for the same file.
            await adoptNativeProjectAuthority(processedFile);
            cacheId = projectCacheId;
          } else {
            binding = await activateProjectCache(cacheId);
          }
          if (sourceIdentity === null) sourceIdentity = sourceIdentityForAsset(cacheId);
          projectCacheId = cacheId;
          projectId = binding?.projectId ?? projectId;
          if (!projectId) throw new Error('The prepared media has no durable subtitle project.');
          assertPreparationOwnership(projectId);
          if (!nativeMedia) localStorage.setItem("current_file_cache_id", cacheId);

          // Publish only after the durable project identity is active.
          setUploadedFile(processedFile);

          dbg(
            "[AppHandlers] Checking for cached subtitles for uploaded file:",
            cacheId
          );

          let cachedSubtitles;
          try {
            cachedSubtitles = await getCachedSubtitles(
              cacheId,
              null,
              { expectedProjectId: projectId }
            );
          } catch (error) {
            await assertPreparationProjectOwnership(projectId);
            throw error;
          }
          await assertPreparationProjectOwnership(projectId);

          if (
            cachedSubtitles &&
            cachedSubtitles.length > 0
          ) {
            dbg(
              "[AppHandlers] Found cached subtitles, loading immediately:",
              cachedSubtitles.length,
              "subtitles"
            );
            if (guardedAutoRequest) {
              preparedSubtitleCandidate = cachedSubtitles;
            } else {
              setSubtitlesData(cachedSubtitles);
              setStatus({
                message: t(
                  "output.subtitlesLoadedFromCache",
                  "Subtitles loaded from cache! Select a segment to generate more."
                ),
                type: "success",
              });
            }
          } else {
            dbg(
              "[AppHandlers] No cached subtitles found for this file"
            );
            setStatus({});
          }
        } catch (error) {
          if (isAutoGenerationCancellation(error, guardedAutoRequest?.signal)
              || error instanceof AutoGenerationOwnershipError) throw error;
          if (error?.code === 'projectScopeMismatch'
              || error?.code === 'subtitleProjectBindingFailed') throw error;
          console.error(
            "[AppHandlers] Error checking cached subtitles:",
            error?.code || 'subtitleCacheReadFailed'
          );
          showWarningToast(t(
            "output.subtitlesCacheLoadFailed",
            "Media is ready, but saved subtitles could not be loaded."
          ));
        }
      }

      if (!processedFile) {
        setIsUploading(false);
        setIsDownloading(false);
        return null;
      }

      assertPreparationOwnership(projectId);
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
        const pendingSubtitle = pendingEntries.get(pendingToken) ?? null;
        if (pendingSubtitle) {
          if (pendingSubtitle.runId !== (guardedAutoRequest?.runId ?? null)
              || pendingSubtitle.sourceIdentity !== sourceIdentity) {
            throw new AutoGenerationOwnershipError();
          }
          const { content, fileName } = pendingSubtitle;
          clearOwnedPendingSubtitle();
          assertPreparationOwnership(projectId);
          if (guardedAutoRequest) {
            // Keep site subtitles private until the auto owner renews them into
            // the exact project and receives a durable checkpoint receipt.
            const parsed = parseSrtContent(content);
            if (parsed.length > 0) preparedSubtitleCandidate = parsed;
          } else {
            await handleSrtUpload(content, fileName || 'site-subtitle.srt');
            assertPreparationOwnership(projectId);
            // Special notice for auto-downloaded subtitle (not green, with glow/particles)
            setStatus({
              message: t('output.autoSubtitleNotice', 'Below are subtitles provided while the video is downloading. If you don’t like them, press Ctrl+A to select all and delete/regenerate'),
              type: 'warning',
              duration: 15000
            });
            assertPreparationOwnership(projectId);
          }
        }
      } catch (e) {
        if (isAutoGenerationCancellation(e, guardedAutoRequest?.signal)
            || e instanceof AutoGenerationOwnershipError) throw e;
        console.warn('[AppHandlers] Failed to apply pending auto subtitle:', e);
      }

      if (guardedAutoRequest) {
        if (!projectCacheId || !projectId || !sourceIdentity) {
          throw new Error('Automatic media preparation did not produce a durable project context.');
        }
        await assertPreparationProjectOwnership(projectId);
        return createPreparedAutoMedia({
          request: guardedAutoRequest,
          media: processedFile,
          cacheId: projectCacheId,
          projectId,
          sourceIdentity,
          cachedSubtitles: preparedSubtitleCandidate,
        });
      }
      return processedFile;
    } catch (error) {
      ownedPendingEntries?.delete(ownedPendingToken);
      if (pendingAutoSubtitleRef.current?.token === ownedPendingToken) {
        pendingAutoSubtitleRef.current = null;
      }
      if (isAutoGenerationCancellation(error, autoRequest?.signal)
          || error instanceof AutoGenerationOwnershipError) {
        throw error;
      }
      if (error?.code === 'projectScopeMismatch') {
        if (ownsPreparation()) {
          setIsUploading(false);
          setIsDownloading(false);
          setStatus({});
        }
        return null;
      }
      console.error("Error in background processing:", error);
      setIsUploading(false);
      setIsDownloading(false);
      setStatus({});
      showErrorToast(`${t("errors.processingFailed", "Processing failed")}: ${error.message}`);
      return null;
    }
  };

  return {
    startBackgroundVideoProcessing,
  };
};
