import { downloadNativeVideo } from '../../platform/nativeUrlDownloadAdapter';
import { getDownloadCookieSource } from '../../platform/downloadCookiePreference';
import {
  clearMedia,
  getSelectedMedia,
  openMediaAsset,
} from '../../platform/mediaService';
import { generateUrlBasedCacheId } from '../../services/subtitleCache';
import {
  ensureProjectOwnsNativeMedia,
  forgetNativeMediaSessionDurably,
  persistNativeMediaSession,
  readNativeMediaSession,
} from '../../platform/nativeMediaOwnership';
import {
  activateSubtitleProjectBinding,
  clearSubtitleProjectBinding,
  rollbackSubtitleProjectBinding,
} from '../../platform/subtitleProjectBinding';
import { deactivateProject } from '../../platform/projectService';
import {
  assertAutoGenerationRequestActive,
  AutoGenerationOwnershipError,
  isAutoGenerationRequest,
  sourceIdentityForUrl,
} from '../../utils/autoGenerationOwnership';
import { forgetBrowserMediaBlob } from '../../platform/browserMediaBlobRegistry';

let activeDownloadPresentation = null;

const withdrawVisibleMediaForUrlIntent = async ({
  ownsPresentation,
  setIsSrtOnlyMode,
  setUploadedFile,
}) => {
  const selected = await getSelectedMedia();
  if (!ownsPresentation()) throw new AutoGenerationOwnershipError();

  // Selecting URL B is itself a media intent. Video A remains durable in its project history, but
  // it must stop being the active/visible media immediately; otherwise a failed B download lies by
  // continuing to show A. Clear every compatibility surface before the fallible network work.
  const replacedFileUrl = localStorage.getItem('current_file_url');
  setUploadedFile(null);
  setIsSrtOnlyMode?.(false);
  for (const key of [
    'current_file_name',
    'current_file_url',
    'split_result',
    'current_video_url',
  ]) localStorage.removeItem(key);
  const cleared = await forgetNativeMediaSessionDurably();
  // The native clear is conditional, and its reply may arrive after a newer URL has already
  // activated. Only its current owner may withdraw the browser project or proceed to download.
  if (cleared !== true || !ownsPresentation()) throw new AutoGenerationOwnershipError();
  clearSubtitleProjectBinding();
  deactivateProject();

  // Use the exact identities observed above. If another media intent won while the IPC round trip
  // was in flight, native clear_media refuses instead of erasing that newer selection.
  if (selected !== null) {
    await clearMedia({
      expectedAssetId: selected.assetId,
      expectedPlaybackId: selected.playbackId,
    });
  }
  if (!ownsPresentation()) throw new AutoGenerationOwnershipError();

  if (replacedFileUrl?.startsWith('blob:')) {
    try {
      URL.revokeObjectURL(replacedFileUrl);
    } catch {
      // A stale browser blob is already unusable and needs no further cleanup.
    }
    forgetBrowserMediaBlob(replacedFileUrl);
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
    await withdrawVisibleMediaForUrlIntent({
      ownsPresentation,
      setIsSrtOnlyMode,
      setUploadedFile,
    });
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
          await clearMedia();
        } else {
          const restoredMedia = await openMediaAsset(previousMedia.assetId);
          if (restoredMedia?.assetId !== previousMedia.assetId) {
            throw new Error('The previous native media selection could not be restored.');
          }
        }
        if (previousSession === null) await forgetNativeMediaSessionDurably();
        else await persistNativeMediaSession(previousSession);
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
    if (!ownsPresentation() || error instanceof AutoGenerationOwnershipError) return undefined;
    setDownloadProgress(0);
    const downloaderDetails = {
      downloaderAuthenticationRequired: t(
        'errors.videoDownloadAuthenticationRequired',
        'This video requires sign-in. Enable browser cookies for downloads and try again.'
      ),
      downloaderExecutionFailed: t(
        'errors.videoDownloadExecutionFailed',
        'The latest verified downloader retried with a fresh media inspection, but the source still failed.'
      ),
      downloaderFormatUnavailable: t(
        'errors.videoDownloadFormatUnavailable',
        'The selected media format expired or is no longer available. Try the download again.'
      ),
      downloaderNetworkFailed: t(
        'errors.videoDownloadNetworkFailed',
        'The source refused or interrupted the media transfer. Check the connection and try again.'
      ),
      downloaderPostProcessingFailed: t(
        'errors.videoDownloadPostProcessingFailed',
        'The video and audio streams downloaded, but could not be combined.'
      ),
      downloaderRateLimited: t(
        'errors.videoDownloadRateLimited',
        'The source is temporarily rate-limiting downloads. Wait a little and try again.'
      ),
      downloaderSourceUnavailable: t(
        'errors.videoDownloadSourceUnavailable',
        'This video is private, removed, region-blocked, or otherwise unavailable.'
      ),
    };
    const detail = downloaderDetails[error?.code] ?? error.message;
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
