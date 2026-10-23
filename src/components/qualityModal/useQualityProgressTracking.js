import { useRef } from 'react';

import { getDownloadCookieSource } from '../../platform/downloadCookiePreference';
import {
  cancelNativeVideoDownload,
  downloadNativeVideo,
} from '../../platform/nativeUrlDownloadAdapter';
import { createQualityRedownloadActivation } from './qualityRedownloadActivation';

/**
 * Quality re-download for rendering. The download runs through the shared native URL download
 * adapter at the requested quality and is claimed through the same activation transaction as a URL
 * download, so the new asset becomes the active media of the same project before `onConfirm`.
 */
const useQualityProgressTracking = ({
  setIsRedownloading,
  setDownloadProgress,
  onConfirm,
  handleClose,
  onMediaReplaced,
}) => {
  const jobIdRef = useRef(null);
  const abortRef = useRef(null);

  // A registered job is cancelled through the adapter, which serializes it against completion: a
  // claim that already began stays authoritative. Before registration the request is withdrawn.
  const handleCancelRedownload = async () => {
    const jobId = jobIdRef.current;
    if (jobId !== null) await cancelNativeVideoDownload(jobId).catch(() => undefined);
    else abortRef.current?.abort();
    setIsRedownloading(false);
  };

  const startQualityDownloadWithId = async (quality, url, videoId) => {
    const controller = new AbortController();
    abortRef.current = controller;
    jobIdRef.current = null;
    let nativeMedia;
    try {
      const activation = await createQualityRedownloadActivation({ url, onMediaReplaced });
      nativeMedia = await downloadNativeVideo({
        url,
        cookieSource: getDownloadCookieSource(),
        quality,
        signal: controller.signal,
        ...activation,
        onStarted: (jobId) => { jobIdRef.current = jobId; },
        onProgress: (percent) => setDownloadProgress(percent),
      });
    } catch (error) {
      if (controller.signal.aborted) return { success: false, cancelled: true };
      throw error;
    } finally {
      jobIdRef.current = null;
      if (abortRef.current === controller) abortRef.current = null;
    }
    if (nativeMedia === null) return { success: false, cancelled: true };

    setDownloadProgress(100);
    setIsRedownloading(false);
    await onConfirm('redownload', { quality, url, videoId, nativeMedia });
    handleClose();
    return { success: true, nativeMedia };
  };

  return {
    handleCancelRedownload,
    startQualityDownloadWithId,
  };
};

export default useQualityProgressTracking;
