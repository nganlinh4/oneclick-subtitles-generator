import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

// Far smaller than one authored 30-fps frame, but large enough for media-element timestamp
// quantisation. This is a completion tolerance, not a visual-time rounding rule.
const SEEK_COMPLETION_EPSILON_SECONDS = 1 / 240;
const PLAYHEAD_UPDATE_INTERVAL_MS = 100;

const finiteTime = (value) => (Number.isFinite(value) ? value : null);

export const clampMediaSeekTime = (requestedTime, duration) => {
  const requested = finiteTime(requestedTime);
  if (requested === null) return null;
  const upper = Number.isFinite(duration) && duration >= 0 ? duration : Number.POSITIVE_INFINITY;
  return Math.min(upper, Math.max(0, requested));
};

const atTarget = (currentTime, targetTime) => (
  Number.isFinite(currentTime)
  && Number.isFinite(targetTime)
  && Math.abs(currentTime - targetTime) <= SEEK_COMPLETION_EPSILON_SECONDS
);

/**
 * The main editor's single media-seek authority.
 *
 * Every requested seek receives a monotonically increasing generation and the active source key.
 * `timeupdate` can publish ordinary playback only while no generation is pending. `seeked` settles
 * only the newest generation and only when the media element actually reached its target. A newer
 * request, source replacement, `emptied`, or `error` therefore cannot be unlocked by an older event.
 * There is deliberately no timer-based unlock: transport completion is a media event, not elapsed
 * wall-clock time.
 */
const useVideoSeekCoordinator = ({
  videoRef,
  sourceKey,
  setCurrentTime,
  onSeek = null,
}) => {
  const [isSeeking, setIsSeeking] = useState(false);
  const generationRef = useRef(0);
  const pendingRef = useRef(null);
  const sourceKeyRef = useRef(sourceKey);
  const setCurrentTimeRef = useRef(setCurrentTime);
  const onSeekRef = useRef(onSeek);
  const lastTimeUpdateRef = useRef(Number.NEGATIVE_INFINITY);

  setCurrentTimeRef.current = setCurrentTime;
  onSeekRef.current = onSeek;

  const cancelPending = useCallback(() => {
    generationRef.current += 1;
    pendingRef.current = null;
    setIsSeeking(false);
  }, []);

  // A source key is part of seek identity. Invalidate before the new source can report lifecycle
  // events; its own restore request will receive a fresh generation after `loadeddata`.
  useLayoutEffect(() => {
    sourceKeyRef.current = sourceKey;
    cancelPending();
    lastTimeUpdateRef.current = Number.NEGATIVE_INFINITY;
  }, [cancelPending, sourceKey]);

  const seekTo = useCallback((requestedTime, {
    onComplete = null,
    reason = 'programmatic',
  } = {}) => {
    const video = videoRef.current;
    if (video === null || video === undefined) return null;

    const target = clampMediaSeekTime(requestedTime, video.duration);
    if (target === null) return null;

    if (!video.seeking && Object.is(video.currentTime, target)) {
      // Assigning an identical time is browser-dependent: some engines emit no lifecycle events,
      // while others perform a redundant decode. Treat it as a completed no-op in both cases, but
      // still give the command a generation: its reason/completion owner must supersede an older
      // request to the same timestamp.
      const noOpGeneration = generationRef.current + 1;
      generationRef.current = noOpGeneration;
      pendingRef.current = null;
      setIsSeeking(false);
      setCurrentTimeRef.current?.(video.currentTime);
      const noOpSourceKey = sourceKeyRef.current;
      queueMicrotask(() => {
        if (
          generationRef.current !== noOpGeneration
          || pendingRef.current !== null
          || videoRef.current !== video
          || !Object.is(sourceKeyRef.current, noOpSourceKey)
          || video.seeking
          || !atTarget(video.currentTime, target)
        ) {
          return;
        }
        onSeekRef.current?.(video.currentTime);
        if (typeof onComplete === 'function') onComplete(video.currentTime);
      });
      return noOpGeneration;
    }

    const generation = generationRef.current + 1;
    generationRef.current = generation;
    pendingRef.current = {
      generation,
      onComplete: typeof onComplete === 'function' ? onComplete : null,
      reason,
      sourceKey: sourceKeyRef.current,
      target,
    };
    setIsSeeking(true);

    try {
      video.currentTime = target;
    } catch {
      // An unloaded/failed element can reject the assignment. Cancel this exact generation without
      // allowing a later event from it to alter the current source.
      if (pendingRef.current?.generation === generation) cancelPending();
      return null;
    }

    // Keep the visible playhead responsive. Canvas receives `isSeeking` separately and will retain
    // its last complete frame until the decoded replacement is presented.
    setCurrentTimeRef.current?.(target);
    return generation;
  }, [cancelPending, videoRef]);

  const seekBy = useCallback((deltaSeconds, options) => {
    if (!Number.isFinite(deltaSeconds)) return null;
    const video = videoRef.current;
    if (video === null || video === undefined) return null;
    const pending = pendingRef.current;
    const base = pending !== null && Object.is(pending.sourceKey, sourceKeyRef.current)
      ? pending.target
      : video.currentTime;
    return seekTo(base + deltaSeconds, options);
  }, [seekTo, videoRef]);

  useEffect(() => {
    const video = videoRef.current;
    if (video === null || video === undefined) return undefined;
    const boundSourceKey = sourceKey;
    const isCurrentBinding = () => (
      videoRef.current === video && Object.is(sourceKeyRef.current, boundSourceKey)
    );

    const handleTimeUpdate = () => {
      if (!isCurrentBinding()) return;
      if (video.seeking || pendingRef.current !== null) return;
      const now = performance.now();
      if (now - lastTimeUpdateRef.current < PLAYHEAD_UPDATE_INTERVAL_MS) return;
      const time = finiteTime(video.currentTime);
      if (time === null) return;
      lastTimeUpdateRef.current = now;
      setCurrentTimeRef.current?.(time);
    };

    const handleSeeking = () => {
      if (!isCurrentBinding()) return;
      const active = pendingRef.current;
      if (active === null || !Object.is(active.sourceKey, sourceKeyRef.current)) {
        const target = clampMediaSeekTime(video.currentTime, video.duration);
        if (target === null) return;
        const generation = generationRef.current + 1;
        generationRef.current = generation;
        pendingRef.current = {
          generation,
          onComplete: null,
          reason: 'native',
          sourceKey: sourceKeyRef.current,
          target,
        };
      }
      setIsSeeking(true);
    };

    const handleSeeked = () => {
      if (!isCurrentBinding()) return;
      const observed = pendingRef.current;
      if (observed === null) return;
      const observedGeneration = observed.generation;
      const observedSourceKey = observed.sourceKey;

      // Media events from rapid assignments may be delivered in one turn. Complete in a microtask
      // and revalidate the generation so a newer seek issued by another handler always wins.
      queueMicrotask(() => {
        const active = pendingRef.current;
        if (
          active === null
          || !isCurrentBinding()
          || active.generation !== observedGeneration
          || !Object.is(active.sourceKey, observedSourceKey)
          || !Object.is(active.sourceKey, sourceKeyRef.current)
          || video.seeking
          || !atTarget(video.currentTime, active.target)
        ) {
          return;
        }

        const completedTime = video.currentTime;
        pendingRef.current = null;
        lastTimeUpdateRef.current = performance.now();
        setCurrentTimeRef.current?.(completedTime);
        setIsSeeking(false);
        onSeekRef.current?.(completedTime);
        active.onComplete?.(completedTime);
      });
    };

    const handleTransportInvalidated = () => {
      if (isCurrentBinding()) cancelPending();
    };

    video.addEventListener('timeupdate', handleTimeUpdate);
    video.addEventListener('seeking', handleSeeking);
    video.addEventListener('seeked', handleSeeked);
    video.addEventListener('emptied', handleTransportInvalidated);
    video.addEventListener('loadstart', handleTransportInvalidated);
    video.addEventListener('abort', handleTransportInvalidated);
    video.addEventListener('error', handleTransportInvalidated);
    return () => {
      video.removeEventListener('timeupdate', handleTimeUpdate);
      video.removeEventListener('seeking', handleSeeking);
      video.removeEventListener('seeked', handleSeeked);
      video.removeEventListener('emptied', handleTransportInvalidated);
      video.removeEventListener('loadstart', handleTransportInvalidated);
      video.removeEventListener('abort', handleTransportInvalidated);
      video.removeEventListener('error', handleTransportInvalidated);
    };
  }, [cancelPending, sourceKey, videoRef]);

  return {
    isSeeking,
    seekBy,
    seekTo,
  };
};

export default useVideoSeekCoordinator;
