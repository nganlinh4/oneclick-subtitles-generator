import { downloadNativeVideo } from '../../platform/nativeUrlDownloadAdapter';
import { getDownloadCookieSource } from '../../platform/downloadCookiePreference';
import { runMediaPipeline } from '../../platform/mediaPipelineService';
import {
  createNativeMediaDescriptor,
  isNativeMediaDescriptor,
} from '../../platform/mediaService';
import { generateUrlBasedCacheId } from '../../services/subtitleCache';
import { ensureProjectOwnsNativeMedia } from '../../platform/nativeMediaOwnership';
import { resolveProjectForCache } from '../../platform/subtitleProjectStore';
import { setCurrentCacheId as setRulesCacheId } from '../../utils/transcriptionRulesStore';
import { setCurrentCacheId as setSubtitlesCacheId } from '../../utils/userSubtitlesStore';
import {
  assertAutoGenerationRequestActive,
  AutoGenerationOwnershipError,
  isAutoGenerationRequest,
  sourceIdentityForUrl,
} from '../../utils/autoGenerationOwnership';

const downloadPresentationOwners = new WeakMap();

export const ensureVideoCompatibility = async (videoFile) => {
  if (!isNativeMediaDescriptor(videoFile)) {
    throw new Error('Select the media again before preparing it for playback.');
  }
  const result = await runMediaPipeline({
    operation: 'preparePlayback',
    assetId: videoFile.assetId,
  });
  if (result?.kind !== 'media') {
    throw new Error('The native media pipeline returned no playable video.');
  }
  return createNativeMediaDescriptor(result.media);
};

/**
 * Legacy entry point retained for callers that have not adopted direct native clipping yet.
 * It intentionally rejects instead of reviving the removed split server.
 */
export const prepareVideoForSegments = async (
  videoFile,
  setStatus,
  _setVideoSegments,
  _setSegmentsStatus,
  t = (_key, defaultValue) => defaultValue
) => {
  try {
    if (!isNativeMediaDescriptor(videoFile)) {
      throw new Error('Select the media again before preparing video segments.');
    }
    setStatus({
      message: t('output.preparingVideo', 'Preparing video for segment processing...'),
      type: 'loading',
    });
    throw new Error('Video splitting is deprecated. Please enable "Use Simplified Processing" in settings for better performance.');
  } catch (error) {
    setStatus({
      message: t('errors.videoPreparationFailed', 'Video preparation failed: {{message}}', {
        message: error.message,
      }),
      type: 'error',
    });
    throw error;
  }
};

/** Download a selected site URL into the native media library and activate it. */
export const downloadAndPrepareYouTubeVideo = async (
  selectedVideo,
  setIsDownloading,
  setDownloadProgress,
  setStatus,
  setCurrentDownloadId,
  handleTabChange,
  setUploadedFile,
  setIsSrtOnlyMode,
  t = (_key, defaultValue) => defaultValue,
  nativeDownloadOptions = {}
) => {
  if (!selectedVideo?.url) {
    setStatus({ message: t('errors.invalidInput', 'Invalid input'), type: 'error' });
    return undefined;
  }

  const presentationToken = Object.freeze({});
  downloadPresentationOwners.set(setIsDownloading, presentationToken);
  const ownsPresentation = () => (
    downloadPresentationOwners.get(setIsDownloading) === presentationToken
  );
  const present = (callback) => {
    if (!ownsPresentation()) return false;
    callback();
    return true;
  };

  present(() => setIsDownloading(true));
  present(() => setDownloadProgress(0));
  present(() => setStatus({
    message: t('output.downloadingVideo', 'Downloading video...'),
    type: 'loading',
  }));

  const autoRequest = nativeDownloadOptions.autoRequest;
  const guardedAutoRequest = isAutoGenerationRequest(autoRequest) ? autoRequest : null;
  try {
    const expectedSourceIdentity = sourceIdentityForUrl(selectedVideo.url);
    const assertDownloadOwnership = () => {
      if (!guardedAutoRequest) return;
      assertAutoGenerationRequestActive(guardedAutoRequest);
      const activeUrl = localStorage.getItem('current_video_url');
      if (typeof activeUrl !== 'string' || `url:${activeUrl}` !== expectedSourceIdentity) {
        throw new AutoGenerationOwnershipError();
      }
    };
    assertDownloadOwnership();
    const nativeMedia = await downloadNativeVideo({
      url: selectedVideo.url,
      cookieSource: getDownloadCookieSource(),
      ...(guardedAutoRequest ? { signal: guardedAutoRequest.signal } : {}),
      ...(guardedAutoRequest ? { validateOwnership: assertDownloadOwnership } : {}),
      onStarted: (jobId) => present(() => setCurrentDownloadId(jobId)),
      onProgress: (progress) => present(() => setDownloadProgress(progress)),
      preferredSubtitleLanguages: nativeDownloadOptions.preferredSubtitleLanguages,
      onSubtitle: (subtitle) => {
        assertDownloadOwnership();
        present(() => nativeDownloadOptions.onSubtitle?.(subtitle));
        assertDownloadOwnership();
      },
    });

    if (nativeMedia === null) {
      present(() => setDownloadProgress(0));
      present(() => setStatus({
        message: t('download.downloadOnly.cancelled', 'Download cancelled'),
        type: 'warning',
      }));
      return undefined;
    }

    assertDownloadOwnership();
    const projectCacheId = await generateUrlBasedCacheId(selectedVideo.url);
    if (typeof projectCacheId !== 'string' || projectCacheId.length === 0) {
      throw new Error('The downloaded media could not be bound to a subtitle project.');
    }
    // Project identity must switch before React publishes the new media. This
    // prevents analysis/editor effects from reading or clearing the previous
    // video's rules during the render that follows setUploadedFile().
    setRulesCacheId(projectCacheId);
    setSubtitlesCacheId(projectCacheId);
    const project = await resolveProjectForCache(projectCacheId, { create: true });
    if (!project?.projectId) {
      throw new Error('The downloaded media could not be bound to a durable subtitle project.');
    }
    assertDownloadOwnership();

    const previousFileUrl = localStorage.getItem('current_file_url');
    if (previousFileUrl?.startsWith('blob:')) {
      try {
        URL.revokeObjectURL(previousFileUrl);
      } catch {
        // A stale browser blob is already unusable and needs no further cleanup.
      }
    }
    localStorage.removeItem('split_result');
    localStorage.setItem('current_video_url', selectedVideo.url);
    localStorage.setItem('current_file_url', nativeMedia.playbackUrl);
    localStorage.setItem('current_file_cache_id', nativeMedia.assetId);
    localStorage.setItem('current_file_name', nativeMedia.name);
    // Remember which project owns this media so a later run can reopen it. The candidate claim has
    // already committed the same asset, so this verifies and records without a second revision.
    await ensureProjectOwnsNativeMedia({ media: nativeMedia, cacheId: projectCacheId });
    assertDownloadOwnership();

    if (!ownsPresentation()) throw new AutoGenerationOwnershipError();
    handleTabChange('file-upload', false);
    localStorage.setItem('current_video_url', selectedVideo.url);
    present(() => setUploadedFile(nativeMedia));
    present(() => setIsSrtOnlyMode?.(false));
    present(() => setDownloadProgress(100));
    present(() => setStatus({
      message: nativeMedia.type.startsWith('audio/')
        ? t('output.audioReady', 'Audio is ready for processing!')
        : t('output.videoReady', 'Video is ready for processing!'),
      // An automatic run has only prepared media here. Its first green
      // terminal belongs to the subtitle owner after an exact-project durable
      // checkpoint, not to the downloader.
      type: guardedAutoRequest ? 'loading' : 'success',
    }));
    return nativeMedia;
  } catch (error) {
    if (guardedAutoRequest && (
      guardedAutoRequest.signal.aborted
      || error instanceof AutoGenerationOwnershipError
      || error?.name === 'AbortError'
    )) {
      throw error;
    }
    if (!ownsPresentation()) return undefined;
    setDownloadProgress(0);
    const detail = error?.code === 'downloaderExecutionFailed'
      ? t(
        'errors.videoDownloadExecutionFailed',
        'The downloader retried but the source still failed. Check your connection, or enable browser cookies if the video requires sign-in.'
      )
      : error.message;
    setStatus({
      message: `${t('errors.videoDownloadFailed', 'Video download failed')}: ${detail}`,
      type: 'error',
    });
    return undefined;
  } finally {
    if (ownsPresentation()) {
      downloadPresentationOwners.delete(setIsDownloading);
      setCurrentDownloadId(null);
      setIsDownloading(false);
    }
  }
};
