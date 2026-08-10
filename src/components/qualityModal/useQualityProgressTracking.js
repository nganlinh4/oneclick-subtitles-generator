import { useRef } from 'react';

import {
  cancelDownload,
  inspectDownloadUrl,
  startDownload,
} from '../../platform/downloadService';
import { openMediaAsset } from '../../platform/mediaService';

export const selectNativeQuality = (inventory, quality) => {
  const height = Number.parseInt(String(quality), 10);
  const formats = Array.isArray(inventory?.formats?.video) ? inventory.formats.video : [];
  const format = formats
    .filter((candidate) => candidate.height === height)
    .sort((left, right) => {
      if (left.includesAudio !== right.includesAudio) return left.includesAudio ? -1 : 1;
      return (right.bitrateKbps ?? 0) - (left.bitrateKbps ?? 0);
    })[0];
  if (format) return { mode: 'exact', formatId: format.formatId };
  if (Number.isInteger(height) && height >= 144 && height <= 4_320) {
    return { mode: 'atMost', height };
  }
  throw new Error('The selected video quality is invalid');
};

const useQualityProgressTracking = ({
  setIsRedownloading,
  setDownloadProgress,
  onConfirm,
  handleClose,
}) => {
  const jobIdRef = useRef(null);
  const cancelPendingRef = useRef(false);

  const handleCancelRedownload = async () => {
    cancelPendingRef.current = true;
    const jobId = jobIdRef.current;
    if (jobId) await cancelDownload(jobId).catch(() => undefined);
    setIsRedownloading(false);
  };

  const startQualityDownloadWithId = async (quality, url, videoId) => {
    cancelPendingRef.current = false;
    const cookieSource = localStorage.getItem('use_cookies_for_download') === 'true'
      ? 'chrome'
      : 'none';
    const inspection = await inspectDownloadUrl({ url, cookieSource });
    if (cancelPendingRef.current) return { success: false, cancelled: true };

    let resolveTerminal;
    let rejectTerminal;
    const terminal = new Promise((resolve, reject) => {
      resolveTerminal = resolve;
      rejectTerminal = reject;
    });
    const initial = await startDownload({
      inventoryId: inspection.capability.id,
      media: {
        kind: 'video',
        quality: selectNativeQuality(inspection.inventory, quality),
      },
      subtitle: null,
    }, {
      onProgress: (event) => {
        const percent = event.progress.fraction === null
          ? Math.round(event.job.progress.basisPoints / 100)
          : Math.round(event.progress.fraction * 100);
        setDownloadProgress(Math.max(0, Math.min(100, percent)));
      },
      onCompleted: (event) => openMediaAsset(event.media.asset.id)
        .then(resolveTerminal, rejectTerminal),
      onCancelled: () => resolveTerminal(null),
      onFailed: (event) => {
        const error = new Error('The native media download could not be completed');
        error.code = event.error.code;
        rejectTerminal(error);
      },
      onProtocolError: (error) => {
        cancelPendingRef.current = true;
        if (jobIdRef.current) cancelDownload(jobIdRef.current).catch(() => undefined);
        rejectTerminal(error);
      },
    });

    jobIdRef.current = initial.id;
    if (cancelPendingRef.current) await cancelDownload(initial.id).catch(() => undefined);

    let nativeMedia;
    try {
      nativeMedia = await terminal;
    } finally {
      jobIdRef.current = null;
    }
    if (nativeMedia === null) return { success: false, cancelled: true };

    setDownloadProgress(100);
    setIsRedownloading(false);
    await onConfirm('redownload', { quality, url, videoId, nativeMedia });
    handleClose();
    return { success: true, nativeMedia };
  };

  // Retained for the modal's stable orchestration surface; native channels push progress.
  const startProgressTracking = () => undefined;

  return {
    handleCancelRedownload,
    startQualityDownloadWithId,
    startProgressTracking,
  };
};

export default useQualityProgressTracking;
