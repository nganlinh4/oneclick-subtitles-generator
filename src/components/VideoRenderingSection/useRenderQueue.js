import { useEffect, useRef, useState } from 'react';

import {
  releaseNativeRenderPlayback,
  waitForNativeRender,
} from '../../platform/renderService';
import {
  claimRecoveredNativeJob,
  discardRecoveredNativeJob,
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
      status: 'processing',
      progress: Math.round(response.job.progress.basisPoints / 100),
      nativeJobId: response.job.id,
    };
  }
  return item;
};

export const useRenderQueue = ({
  isRendering,
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
  const [renderQueue, setRenderQueue] = useState([]);
  const [currentQueueItem, setCurrentQueueItem] = useState(null);
  const renderQueueRef = useRef(renderQueue);
  const isRenderingRef = useRef(isRendering);
  const reconnectRef = useRef(null);
  const applyRecoveredRenderRef = useRef(null);
  const rememberedRenderIdRef = useRef(null);
  const recoveredPlaybackIdRef = useRef(null);
  renderQueueRef.current = renderQueue;
  isRenderingRef.current = isRendering;

  const updateQueueItem = (queueItem, response) => {
    const updated = mergeNativeRenderResult(queueItem, response);
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
    if (!nextItem || isRenderingRef.current || typeof startRenderRef.current !== 'function') return;
    const startedAt = Date.now();
    setRenderQueue((previous) => previous.map((item) => (
      item.id === nextItem.id ? { ...item, status: 'processing', startedAt } : item
    )));
    setCurrentQueueItem({ ...nextItem, startedAt });
    await startRenderRef.current(nextItem);
  };

  const applyRecoveredRender = (queueItem, response) => {
    setRenderProgress(Math.round(response.job.progress.basisPoints / 100));
    if (queueItem !== null) updateQueueItem(queueItem, response);
    if (response.job.state === 'succeeded' && response.result !== null) {
      if (queueItem === null) recoveredPlaybackIdRef.current = response.result.playback.id;
      setRenderedVideoUrl(response.result.playback.playbackUrl);
      setRenderStatus(t('videoRendering.complete', 'Render complete!'));
      setRenderProgress(100);
      return true;
    }
    return false;
  };
  applyRecoveredRenderRef.current = applyRecoveredRender;

  const reconnectToNativeRender = async (renderId, queueItem = null) => {
    const controller = new AbortController();
    setAbortController(controller);
    setCurrentRenderId(renderId);
    setCurrentQueueItem(queueItem);
    setIsRendering(true);
    setRenderStatus(t('videoRendering.reconnecting', 'Reconnecting to render...'));
    try {
      const response = await waitForNativeRender(renderId, {
        signal: controller.signal,
        onUpdate: (update) => applyRecoveredRender(queueItem, update),
      });
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
      const cancelled = error?.name === 'AbortError' || error?.code === 'renderCancelled';
      if (queueItem !== null) {
        setRenderQueue((previous) => previous.map((item) => (
          item.id === queueItem.id
            ? {
                ...item,
                status: 'failed',
                progress: 0,
                error: cancelled
                  ? t('videoRendering.renderCancelled', 'Render was cancelled')
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
      forgetNativeJobId(renderId);
      setIsRendering(false);
      setCurrentRenderId(null);
      setAbortController(null);
      setCurrentQueueItem(null);
      setTimeout(() => startNextPendingRender(), 1000);
    }
  };
  reconnectRef.current = reconnectToNativeRender;

  const removeFromQueue = (id) => {
    const playbackId = renderQueueRef.current.find((item) => item.id === id)?.outputPlaybackId;
    if (playbackId) releaseNativeRenderPlayback(playbackId).catch(() => undefined);
    setRenderQueue((previous) => previous.filter((item) => item.id !== id));
  };

  const clearQueue = () => {
    renderQueueRef.current
      .filter((item) => item.status !== 'processing' && item.outputPlaybackId)
      .forEach((item) => releaseNativeRenderPlayback(item.outputPlaybackId).catch(() => undefined));
    setRenderQueue((previous) => previous.filter((item) => item.status === 'processing'));
  };

  useEffect(() => {
    let disposed = false;
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
      const playbackId = recoveredPlaybackIdRef.current;
      recoveredPlaybackIdRef.current = null;
      if (playbackId !== null) releaseNativeRenderPlayback(playbackId).catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    const previous = rememberedRenderIdRef.current;
    if (currentRenderId !== null && recoveredPlaybackIdRef.current !== null) {
      releaseNativeRenderPlayback(recoveredPlaybackIdRef.current).catch(() => undefined);
      recoveredPlaybackIdRef.current = null;
    }
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
    removeFromQueue,
    clearQueue,
  };
};

export default useRenderQueue;
