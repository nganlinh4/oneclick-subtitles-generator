import { inspectDownloadUrl, startDownload } from './downloadService';
import { exportMediaAsset } from './mediaExportService';

const downloadPercent = (event) => {
  const fraction = event.progress.fraction;
  const percent = fraction === null
    ? Math.round(event.job.progress.basisPoints / 100)
    : Math.round(fraction * 100);
  return Math.max(0, Math.min(100, percent));
};

const safeCall = (callback, value) => {
  if (typeof callback !== 'function') return;
  try {
    callback(value);
  } catch {
    // Presentation callbacks cannot break the native operation.
  }
};

const downloadFailure = (code) => {
  const error = new Error('The native media download could not be completed');
  error.name = 'UserMediaExportError';
  error.code = typeof code === 'string' ? code : 'nativeDownloadFailed';
  return error;
};

export const downloadUrlToUserDestination = async ({
  url,
  cookieSource,
  media,
  onJobStarted,
  onDownloadProgress,
  onExportProgress,
}, {
  inspect = inspectDownloadUrl,
  start = startDownload,
  exportAsset = exportMediaAsset,
} = {}) => {
  const inspection = await inspect({ url, cookieSource });
  let settle;
  const terminal = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });
  const initial = await start({
    inventoryId: inspection.capability.id,
    media,
    subtitle: null,
  }, {
    onProgress: (event) => safeCall(onDownloadProgress, downloadPercent(event)),
    onCompleted: (event) => settle.resolve({ status: 'completed', event }),
    onCancelled: (event) => settle.resolve({ status: 'cancelled', event }),
    onFailed: (event) => settle.reject(downloadFailure(event.error.code)),
    onProtocolError: (error) => settle.reject(error),
  });
  safeCall(onJobStarted, initial);
  const downloaded = await terminal;
  if (downloaded.status === 'cancelled') return Object.freeze(downloaded);

  return exportAsset(downloaded.event.media.asset.id, {
    onStarted: onJobStarted,
    onProgress: (event) => safeCall(
      onExportProgress,
      Math.round(event.job.progress.basisPoints / 100)
    ),
  });
};
