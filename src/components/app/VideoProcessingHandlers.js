import { downloadNativeVideo } from '../../platform/nativeUrlDownloadAdapter';
import { runMediaPipeline } from '../../platform/mediaPipelineService';
import {
  createNativeMediaDescriptor,
  isNativeMediaDescriptor,
} from '../../platform/mediaService';

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

  setIsDownloading(true);
  setDownloadProgress(0);
  setStatus({
    message: t('output.downloadingVideo', 'Downloading video...'),
    type: 'loading',
  });

  try {
    const nativeMedia = await downloadNativeVideo({
      url: selectedVideo.url,
      useCookies: localStorage.getItem('use_cookies_for_download') === 'true',
      onStarted: setCurrentDownloadId,
      onProgress: setDownloadProgress,
      preferredSubtitleLanguages: nativeDownloadOptions.preferredSubtitleLanguages,
      onSubtitle: nativeDownloadOptions.onSubtitle,
    });

    if (nativeMedia === null) {
      setDownloadProgress(0);
      setStatus({
        message: t('download.downloadOnly.cancelled', 'Download cancelled'),
        type: 'warning',
      });
      return undefined;
    }

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

    handleTabChange('file-upload', false);
    localStorage.setItem('current_video_url', selectedVideo.url);
    setUploadedFile(nativeMedia);
    setIsSrtOnlyMode?.(false);
    setDownloadProgress(100);
    setStatus({
      message: nativeMedia.type.startsWith('audio/')
        ? t('output.audioReady', 'Audio is ready for processing!')
        : t('output.videoReady', 'Video is ready for processing!'),
      type: 'success',
    });
    return nativeMedia;
  } catch (error) {
    setDownloadProgress(0);
    setStatus({
      message: `${t('errors.videoDownloadFailed', 'Video download failed')}: ${error.message}`,
      type: 'error',
    });
    return undefined;
  } finally {
    setCurrentDownloadId(null);
    setIsDownloading(false);
  }
};
