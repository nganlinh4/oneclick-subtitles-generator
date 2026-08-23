import { downloadNativeVideo } from '../../platform/nativeUrlDownloadAdapter';
import { getDownloadCookieSource } from '../../platform/downloadCookiePreference';
import { runMediaPipeline } from '../../platform/mediaPipelineService';
import {
  clearMedia,
  createNativeMediaDescriptor,
  getSelectedMedia,
  isNativeMediaDescriptor,
  openMediaAsset,
} from '../../platform/mediaService';
import { generateUrlBasedCacheId } from '../../services/subtitleCache';
import {
  ensureProjectOwnsNativeMedia,
  forgetNativeMediaSession,
  readNativeMediaSession,
  writeNativeMediaSession,
} from '../../platform/nativeMediaOwnership';
import {
  activateSubtitleProjectBinding,
  rollbackSubtitleProjectBinding,
} from '../../platform/subtitleProjectBinding';
import {
  assertAutoGenerationRequestActive,
  AutoGenerationOwnershipError,
  isAutoGenerationRequest,
  sourceIdentityForUrl,
} from '../../utils/autoGenerationOwnership';
import { forgetBrowserMediaBlob } from '../../platform/browserMediaBlobRegistry';

let activeDownloadPresentation = null;

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
  activeDownloadPresentation = presentationToken;
  const ownsPresentation = () => activeDownloadPresentation === presentationToken;
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
      if (!ownsPresentation()) throw new AutoGenerationOwnershipError();
      if (guardedAutoRequest) assertAutoGenerationRequestActive(guardedAutoRequest);
    };
    assertDownloadOwnership();
    const projectCacheId = await generateUrlBasedCacheId(selectedVideo.url);
    if (typeof projectCacheId !== 'string' || projectCacheId.length === 0) {
      throw new Error('The downloaded media could not be bound to a subtitle project.');
    }

    let previousMedia = null;
    let previousSession = null;
    let previousCompatibility = null;
    const nativeMedia = await downloadNativeVideo({
      url: selectedVideo.url,
      cookieSource: getDownloadCookieSource(),
      ...(guardedAutoRequest ? { signal: guardedAutoRequest.signal } : {}),
      validateOwnership: assertDownloadOwnership,
      admitActivation: async ({ assetId, resolvedProject, url }, { validateOwnership }) => {
        await validateOwnership();
        if (sourceIdentityForUrl(url) !== expectedSourceIdentity
            || resolvedProject?.cacheId !== projectCacheId
            || typeof assetId !== 'string') {
          throw new AutoGenerationOwnershipError();
        }
        previousMedia = await getSelectedMedia();
        await validateOwnership();
        previousSession = readNativeMediaSession();
        previousCompatibility = Object.freeze({
          fileName: localStorage.getItem('current_file_name'),
          fileUrl: localStorage.getItem('current_file_url'),
          splitResult: localStorage.getItem('split_result'),
          videoUrl: localStorage.getItem('current_video_url'),
        });
        let binding = null;
        try {
          binding = await activateSubtitleProjectBinding(projectCacheId, {
            expectedProjectId: resolvedProject.projectId,
            create: false,
          });
          await validateOwnership();
          return binding;
        } catch (error) {
          if (binding !== null) rollbackSubtitleProjectBinding(binding);
          throw error;
        }
      },
      publishActivation: async (media, binding, { validateOwnership }) => {
        await validateOwnership();
        const ownership = await ensureProjectOwnsNativeMedia({
          media,
          cacheId: projectCacheId,
          expectedProjectId: binding.projectId,
        });
        await validateOwnership();
        if (ownership.projectId !== binding.projectId) {
          throw new AutoGenerationOwnershipError();
        }

        localStorage.removeItem('split_result');
        localStorage.setItem('current_video_url', selectedVideo.url);
        localStorage.setItem('current_file_url', media.playbackUrl);
        localStorage.setItem('current_file_name', media.name);
        handleTabChange('file-upload', false);
        setUploadedFile(media);
        setIsSrtOnlyMode?.(false);
        setDownloadProgress(100);
        setStatus({
          message: media.type.startsWith('audio/')
            ? t('output.audioReady', 'Audio is ready for processing!')
            : t('output.videoReady', 'Video is ready for processing!'),
          type: guardedAutoRequest ? 'loading' : 'success',
        });
      },
      rollbackActivation: async () => {
        if (previousMedia === null) {
          await clearMedia().catch(() => undefined);
        } else {
          await openMediaAsset(previousMedia.assetId).catch(() => undefined);
        }
        if (previousSession === null) forgetNativeMediaSession();
        else writeNativeMediaSession(previousSession);
        if (previousCompatibility !== null) {
          for (const [key, value] of [
            ['current_file_name', previousCompatibility.fileName],
            ['current_file_url', previousCompatibility.fileUrl],
            ['split_result', previousCompatibility.splitResult],
            ['current_video_url', previousCompatibility.videoUrl],
          ]) {
            if (value === null) localStorage.removeItem(key);
            else localStorage.setItem(key, value);
          }
        }
      },
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

    // downloadNativeVideo resolves only after its post-publication ownership check. Until that
    // boundary it can still roll back to previousCompatibility, so the old browser source must
    // remain live even after publishActivation itself succeeds.
    const replacedFileUrl = previousCompatibility?.fileUrl;
    if (replacedFileUrl?.startsWith('blob:')) {
      try {
        URL.revokeObjectURL(replacedFileUrl);
      } catch {
        // A stale browser blob is already unusable and needs no further cleanup.
      }
      forgetBrowserMediaBlob(replacedFileUrl);
    }
    assertDownloadOwnership();
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
      activeDownloadPresentation = null;
      setCurrentDownloadId(null);
      setIsDownloading(false);
    }
  }
};
