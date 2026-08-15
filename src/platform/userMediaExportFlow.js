import { cancelDownload, inspectDownloadUrl, startDownload } from './downloadService';
import { exportMediaAsset } from './mediaExportService';
import { discardMediaCandidate } from './mediaService';

const downloadPercent = (event) => {
  const percent = Math.round(event.job.progress.basisPoints / 100);
  return Math.max(0, Math.min(100, percent));
};

const safeCall = (callback, value) => {
  if (typeof callback !== 'function') return;
  try {
    Promise.resolve(callback(value)).catch(() => undefined);
  } catch {
    // Presentation callbacks cannot break the native operation.
  }
};

const awaitCallback = async (callback, value) => {
  if (typeof callback !== 'function') return;
  try {
    await Promise.resolve(callback(value));
  } catch {
    throw downloadFailure('downloadCallbackFailed');
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
  cancel = cancelDownload,
  discardCandidate = discardMediaCandidate,
  exportAsset = exportMediaAsset,
} = {}) => {
  const inspection = await inspect({ url, cookieSource });
  let settled = false;
  let resolveTerminal;
  const terminal = new Promise((resolve) => {
    resolveTerminal = resolve;
  });
  const settle = (outcome) => {
    if (settled) return;
    settled = true;
    resolveTerminal(outcome);
  };
  let initial = null;
  try {
    initial = await start({
      inventoryId: inspection.capability.id,
      media,
      subtitle: null,
    }, {
      onProgress: (event) => safeCall(onDownloadProgress, downloadPercent(event)),
      onCompleted: (event) => settle({ status: 'completed', event }),
      onCancelled: (event) => settle({ status: 'cancelled', event }),
      onFailed: (event) => settle({
        status: 'failed',
        error: downloadFailure(event.error.code),
      }),
      onProtocolError: (error) => settle({ status: 'failed', error }),
    });
  } catch (error) {
    settle({ status: 'failed', error });
  }
  let startCallbackError = null;
  if (initial !== null) {
    try {
      await awaitCallback(onJobStarted, initial);
    } catch (error) {
      startCallbackError = error;
      await cancel(initial.id).catch(() => undefined);
    }
  }
  const downloaded = await terminal;
  if (downloaded.status === 'cancelled') return Object.freeze(downloaded);
  if (downloaded.status === 'failed') throw downloaded.error;
  const candidateAssetId = downloaded.event.media.asset.id;
  if (startCallbackError !== null) {
    await discardCandidate(candidateAssetId);
    throw startCallbackError;
  }

  let exportStart = Promise.resolve();
  let exportError = null;
  let exportResult;
  try {
    exportResult = await exportAsset(candidateAssetId, {
      onStarted: (job) => {
        exportStart = awaitCallback(onJobStarted, job);
        exportStart.catch(() => undefined);
        return exportStart;
      },
      onProgress: (event) => safeCall(
        onExportProgress,
        Math.round(event.job.progress.basisPoints / 100)
      ),
    });
  } catch (error) {
    exportError = error;
  }
  try {
    await exportStart;
  } catch (error) {
    exportError = error;
  }
  await discardCandidate(candidateAssetId);
  if (exportError !== null) throw exportError;
  return exportResult;
};
