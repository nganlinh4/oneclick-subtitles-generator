import { useRef } from 'react';

import {
  cancelDownload,
  inspectDownloadUrl,
  startDownload,
} from '../../platform/downloadService';
import {
  claimMediaCandidate,
  discardMediaCandidate,
} from '../../platform/mediaService';
import { activateResolvedMediaProject } from '../../platform/mediaProjectActivation';
import { getDownloadCookieSource } from '../../platform/downloadCookiePreference';
import { resolveProjectForCache } from '../../platform/subtitleProjectStore';
import { generateUrlBasedCacheId } from '../../services/subtitleCache';

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
    const cookieSource = getDownloadCookieSource();
    const inspection = await inspectDownloadUrl({ url, cookieSource });
    if (cancelPendingRef.current) return { success: false, cancelled: true };

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
    const discardedCandidates = new Set();
    const discardOnce = async (candidate) => {
      const assetId = candidate?.asset?.id;
      if (typeof assetId !== 'string' || discardedCandidates.has(assetId)) return;
      discardedCandidates.add(assetId);
      await discardMediaCandidate(assetId);
    };
    let initial = null;
    try {
      initial = await startDownload({
        inventoryId: inspection.capability.id,
        media: {
          kind: 'video',
          quality: selectNativeQuality(inspection.inventory, quality),
        },
        subtitle: null,
      }, {
        onProgress: (event) => {
          const percent = Math.round(event.job.progress.basisPoints / 100);
          setDownloadProgress(Math.max(0, Math.min(100, percent)));
        },
        onCompleted: (event) => {
          Promise.resolve().then(async () => {
            if (cancelPendingRef.current) {
              await discardOnce(event.media);
              settle({ status: 'cancelled' });
              return;
            }
            const cacheId = await generateUrlBasedCacheId(url);
            const resolved = await resolveProjectForCache(cacheId, { create: true });
            if (cancelPendingRef.current) {
              await discardOnce(event.media);
              settle({ status: 'cancelled' });
              return;
            }
            // projectService storage operations stay detached, so the exact resolved project is
            // published here — the claim below requires it to be the active project.
            const activation = await activateResolvedMediaProject(resolved);
            if (cancelPendingRef.current) {
              activation.release();
              await discardOnce(event.media);
              settle({ status: 'cancelled' });
              return;
            }
            let nativeMedia;
            try {
              nativeMedia = await claimMediaCandidate(event.media, activation.claimOptions);
            } catch (error) {
              activation.release();
              throw error;
            }
            settle({ status: 'completed', nativeMedia });
          }).catch(async (error) => {
            await discardOnce(event.media).catch(() => undefined);
            settle({ status: 'failed', error });
          });
        },
        onCancelled: () => settle({ status: 'cancelled' }),
        onFailed: (event) => {
          const error = new Error('The native media download could not be completed');
          error.code = event.error.code;
          settle({ status: 'failed', error });
        },
        onProtocolError: (error) => settle({ status: 'failed', error }),
      });
    } catch (error) {
      settle({ status: 'failed', error });
    }

    if (initial !== null) {
      jobIdRef.current = initial.id;
      if (cancelPendingRef.current) await cancelDownload(initial.id).catch(() => undefined);
    }

    let outcome;
    try {
      outcome = await terminal;
    } finally {
      jobIdRef.current = null;
    }
    if (outcome.status === 'failed') throw outcome.error;
    if (outcome.status === 'cancelled') return { success: false, cancelled: true };
    const { nativeMedia } = outcome;

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
