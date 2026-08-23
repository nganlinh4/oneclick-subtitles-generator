import { useEffect, useRef, useState } from 'react';

import {
  releaseNativeRenderPlayback,
  waitForNativeRender,
} from '../../platform/renderService';
import {
  claimRecoveredNativeJob,
  discardRecoveredNativeJob,
  ensureNativeJobRecoveryReady,
  forgetNativeJobId,
  listRecoveredNativeJobs,
  rememberNativeJobId,
  startNativeJobRecovery,
} from '../../platform/jobRecoveryCoordinator';

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export const mergeNativeRenderResult = (item, response) => {
  if (!isRecord(item) || !isRecord(response?.job)) return item;
  if (response.job.state === 'succeeded' && isRecord(response.result)) {
    return {
      ...item,
      status: 'completed',
      progress: 100,
      completedAt: item.completedAt || Date.now(),
      nativeJobId: response.job.id,
      outputPath: response.result.playback.playbackUrl,
      outputPlaybackId: response.result.playback.id,
      outputAssetId: response.result.asset.id,
      outputArtifactId: response.result.artifactId,
      outputSizeBytes: response.result.asset.sizeBytes,
    };
  }
  if (['queued', 'running', 'cancelling'].includes(response.job.state)) {
    return {
      ...item,
      status: response.job.state === 'cancelling' ? 'cancelling' : 'processing',
      progress: Math.round(response.job.progress.basisPoints / 100),
      nativeJobId: response.job.id,
    };
  }
  if (response.job.state === 'cancelled') {
    return {
      ...item,
      status: 'cancelled',
      progress: 0,
      nativeJobId: response.job.id,
      error: null,
    };
  }
  return item;
};

export const createRecoveredRenderQueueItem = (response, now = Date.now) => {
  if (response?.job?.state !== 'succeeded' || !isRecord(response.result)) return null;
  const timestamp = now();
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) return null;
  return mergeNativeRenderResult({
    id: `recovered_${response.job.id}`,
    settings: {
      resolution: `${response.result.height}p`,
      frameRate: response.result.fps,
    },
    status: 'processing',
    progress: 0,
    timestamp,
    startedAt: null,
    completedAt: null,
    outputPath: null,
    error: null,
  }, response);
};

export const useRenderQueue = ({
  setIsRendering,
  setRenderProgress,
  setRenderStatus,
  setRenderedVideoUrl,
  setError,
  currentRenderId,
  setCurrentRenderId,
  setAbortController,
  t,
  startRenderRef,
}) => {
  const [renderQueue, setRenderQueueState] = useState([]);
  const [currentQueueItem, setCurrentQueueItem] = useState(null);
  const renderQueueRef = useRef(renderQueue);
  const renderLeaseRef = useRef(null);
  const nextRenderGenerationRef = useRef(0);
  const reconnectRef = useRef(null);
  const applyRecoveredRenderRef = useRef(null);
  const rememberedRenderIdRef = useRef(null);
  const ownedPlaybackIdsRef = useRef(new Set());
  const releasedPlaybackIdsRef = useRef(new Set());
  renderQueueRef.current = renderQueue;

  const setRenderQueue = (updater) => {
    const next = typeof updater === 'function' ? updater(renderQueueRef.current) : updater;
    renderQueueRef.current = next;
    setRenderQueueState(next);
  };

  const claimRenderLease = (queueItemId) => {
    if (renderLeaseRef.current !== null) return null;
    nextRenderGenerationRef.current += 1;
    const owner = Object.freeze({
      queueItemId,
      generation: nextRenderGenerationRef.current,
    });
    renderLeaseRef.current = owner;
    return owner;
  };

  const ownsRenderLease = (owner) => (
    owner !== null
    && renderLeaseRef.current?.queueItemId === owner.queueItemId
    && renderLeaseRef.current?.generation === owner.generation
  );

  const releaseRenderLease = (owner) => {
    if (!ownsRenderLease(owner)) return false;
    renderLeaseRef.current = null;
    return true;
  };

  const ownPlayback = (playbackId) => {
    if (typeof playbackId !== 'string' || playbackId.length === 0) return;
    if (!releasedPlaybackIdsRef.current.has(playbackId)) {
      ownedPlaybackIdsRef.current.add(playbackId);
    }
  };

  const releasePlaybackOnce = (playbackId) => {
    if (typeof playbackId !== 'string' || playbackId.length === 0) return;
    if (releasedPlaybackIdsRef.current.has(playbackId)) return;
    releasedPlaybackIdsRef.current.add(playbackId);
    ownedPlaybackIdsRef.current.delete(playbackId);
    releaseNativeRenderPlayback(playbackId).catch(() => undefined);
  };

  const updateQueueItem = (queueItem, response) => {
    const updated = mergeNativeRenderResult(queueItem, response);
    if (response.job.state === 'succeeded' && response.result !== null) {
      ownPlayback(response.result.playback.id);
    }
    setRenderQueue((previous) => previous.map((item) => (
      item.id === queueItem.id ? mergeNativeRenderResult(item, response) : item
    )));
    if (response.job.state === 'succeeded' && response.result !== null) {
      setRenderedVideoUrl(response.result.playback.playbackUrl);
      setRenderStatus(t('videoRendering.complete', 'Render complete!'));
      setRenderProgress(100);
    }
    return updated;
  };

  const startNextPendingRender = async () => {
    const nextItem = renderQueueRef.current.find((item) => item.status === 'pending');
    if (!nextItem || typeof startRenderRef.current !== 'function') return false;
    try {
      await ensureNativeJobRecoveryReady();
    } catch (error) {
      setError(error.message);
      setRenderStatus(t(
        'videoRendering.recoveryUnavailable',
        'Previous render recovery is temporarily unavailable',
      ));
      return false;
    }
    const owner = claimRenderLease(nextItem.id);
    if (owner === null) return false;
    const startedAt = Date.now();
    const startedItem = {
      ...nextItem,
      status: 'processing',
      startedAt,
      renderGeneration: owner.generation,
    };
    setRenderQueue((previous) => previous.map((item) => (
      item.id === nextItem.id ? startedItem : item
    )));
    setCurrentQueueItem(startedItem);
    setIsRendering(true);
    try {
      await startRenderRef.current(startedItem, owner);
    } catch {
      if (ownsRenderLease(owner)) {
        setRenderQueue((previous) => previous.map((item) => (
          item.id === nextItem.id && item.renderGeneration === owner.generation
            ? {
                ...item,
                status: 'failed',
                progress: 0,
                error: t('videoRendering.failed', 'Render failed'),
              }
            : item
        )));
      }
    } finally {
      if (releaseRenderLease(owner)) {
        setIsRendering(false);
        setCurrentRenderId(null);
        setAbortController(null);
        setCurrentQueueItem(null);
        queueMicrotask(() => { void startNextPendingRender(); });
      }
    }
    return true;
  };

  const applyRecoveredRender = (queueItem, response) => {
    setRenderProgress(Math.round(response.job.progress.basisPoints / 100));
    if (queueItem !== null) updateQueueItem(queueItem, response);
    if (response.job.state === 'succeeded' && response.result !== null) {
      if (queueItem === null) {
        const recovered = createRecoveredRenderQueueItem(response);
        if (recovered !== null) {
          ownPlayback(response.result.playback.id);
          setRenderQueue((previous) => {
            const existing = previous.findIndex((item) => item.nativeJobId === response.job.id);
            if (existing < 0) return [recovered, ...previous];
            return previous.map((item, index) => (
              index === existing ? mergeNativeRenderResult(item, response) : item
            ));
          });
        }
      }
      setRenderedVideoUrl(response.result.playback.playbackUrl);
      setRenderStatus(t('videoRendering.complete', 'Render complete!'));
      setRenderProgress(100);
      return true;
    }
    return false;
  };
  applyRecoveredRenderRef.current = applyRecoveredRender;

  const reconnectToNativeRender = async (renderId, queueItem = null) => {
    const owner = claimRenderLease(queueItem?.id || `recovered_${renderId}`);
    if (owner === null) return false;
    const controller = new AbortController();
    setAbortController(controller);
    setCurrentRenderId(renderId);
    setCurrentQueueItem(queueItem === null ? null : {
      ...queueItem,
      renderGeneration: owner.generation,
    });
    setIsRendering(true);
    setRenderStatus(t('videoRendering.reconnecting', 'Reconnecting to render...'));
    try {
      const response = await waitForNativeRender(renderId, {
        signal: controller.signal,
        onUpdate: (update) => {
          if (ownsRenderLease(owner)) applyRecoveredRender(queueItem, update);
        },
      });
      if (!ownsRenderLease(owner)) return false;
      if (!applyRecoveredRender(queueItem, response) && queueItem !== null) {
        setRenderQueue((previous) => previous.map((item) => (
          item.id === queueItem.id
            ? {
                ...item,
                status: 'failed',
                progress: 0,
                error: t(
                  'videoRendering.renderFailedBrowserClosed',
                  'Render failed while browser was closed'
                ),
              }
            : item
        )));
      }
    } catch (error) {
      if (!ownsRenderLease(owner)) return false;
      const cancelled = error?.name === 'AbortError' || error?.code === 'renderCancelled';
      if (queueItem !== null) {
        setRenderQueue((previous) => previous.map((item) => (
          item.id === queueItem.id
            ? {
                ...item,
                status: cancelled ? 'cancelled' : 'failed',
                progress: 0,
                error: cancelled
                  ? null
                  : t(
                      'videoRendering.renderFailedBrowserClosed',
                      'Render failed while browser was closed'
                    ),
              }
            : item
        )));
      }
      setError(error.message);
      setRenderStatus(cancelled
        ? t('videoRendering.cancelled', 'Render cancelled')
        : t('videoRendering.failed', 'Render failed'));
    } finally {
      if (releaseRenderLease(owner)) {
        forgetNativeJobId(renderId);
        setIsRendering(false);
        setCurrentRenderId(null);
        setAbortController(null);
        setCurrentQueueItem(null);
        queueMicrotask(() => { void startNextPendingRender(); });
      }
    }
    return true;
  };
  reconnectRef.current = reconnectToNativeRender;

  const removeFromQueue = (id) => {
    const playbackId = renderQueueRef.current.find((item) => item.id === id)?.outputPlaybackId;
    releasePlaybackOnce(playbackId);
    setRenderQueue((previous) => previous.filter((item) => item.id !== id));
  };

  const clearQueue = () => {
    renderQueueRef.current
      .filter((item) => item.status !== 'processing' && item.outputPlaybackId)
      .forEach((item) => releasePlaybackOnce(item.outputPlaybackId));
    setRenderQueue((previous) => previous.filter((item) => item.status === 'processing'));
  };

  useEffect(() => {
    renderQueue.forEach((item) => ownPlayback(item.outputPlaybackId));
  }, [renderQueue]);

  useEffect(() => {
    let disposed = false;
    const ownedPlaybackIds = ownedPlaybackIdsRef.current;
    startNativeJobRecovery().then(() => {
      const candidates = listRecoveredNativeJobs('renderVideo');
      if (disposed) return;
      const [selected, ...stale] = candidates;
      stale.forEach(({ job }) => discardRecoveredNativeJob(job.id));
      if (selected === undefined) return;
      const recovered = claimRecoveredNativeJob(selected.job.id);
      if (recovered === null) return;
      const { job, value } = recovered;
      if (job.state === 'succeeded' && value.result !== null) {
        applyRecoveredRenderRef.current(null, value);
        return;
      }
      if (['queued', 'running', 'cancelling'].includes(job.state)) {
        rememberNativeJobId(job.id);
        reconnectRef.current(job.id, null);
      }
    }).catch(() => undefined);
    return () => {
      disposed = true;
      renderQueueRef.current.forEach((item) => ownPlayback(item.outputPlaybackId));
      [...ownedPlaybackIds].forEach(releasePlaybackOnce);
    };
  }, []);

  useEffect(() => {
    const previous = rememberedRenderIdRef.current;
    if (previous !== null && previous !== currentRenderId) forgetNativeJobId(previous);
    if (currentRenderId !== null && previous !== currentRenderId) {
      rememberNativeJobId(currentRenderId);
    }
    rememberedRenderIdRef.current = currentRenderId;
  }, [currentRenderId]);

  return {
    renderQueue,
    setRenderQueue,
    currentQueueItem,
    setCurrentQueueItem,
    checkRenderStatus: reconnectToNativeRender,
    reconnectToRender: reconnectToNativeRender,
    startNextPendingRender,
    ownsRenderLease,
    ownQueuePlayback: ownPlayback,
    removeFromQueue,
    clearQueue,
  };
};

export default useRenderQueue;
