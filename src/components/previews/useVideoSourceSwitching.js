import {
  useEffect, useLayoutEffect, useRef, useState,
} from 'react';
import { isLoopbackServiceUrl } from '../../platform/browserOnlyService';
import { isNativeMediaPlaybackUrl } from '../../platform/mediaService';
import { fetchBrowserResource } from '../../platform/browserFetch';
import {
  forgetBrowserMediaBlob,
  registerBrowserMediaBlob,
} from '../../platform/browserMediaBlobRegistry';
import { dbg } from './videoPreviewDebug';

// Smaller than one 30-fps frame. The seek coordinator is the primary authority for completion;
// this second check prevents a wrongly wired/mock completion from resuming the replacement source.
const SOURCE_RESTORE_EPSILON_SECONDS = 1 / 240;

const atRestoreTime = (observed, expected) => (
  Number.isFinite(observed)
  && Number.isFinite(expected)
  && Math.abs(observed - expected) <= SOURCE_RESTORE_EPSILON_SECONDS
);

/**
 * The preview video element's sole source writer.
 *
 * React deliberately renders the element without `src` or `<source>` children. That is necessary:
 * a declarative source is committed before passive effects run, so an effect trying to preserve the
 * old playhead would only ever observe the already-reset replacement. This hook snapshots the old
 * transport first, then assigns exactly one source in the layout phase, before Canvas passive
 * observers can mistake outgoing decoded pixels for the requested replacement. Playback restores
 * only after the seek coordinator confirms that the replacement reached the snapshot time.
 *
 * Optimized-source failure is part of the same transaction. The original source inherits the first
 * snapshot rather than the failed rendition's zeroed transport, and the actual committed source is
 * published so Canvas and the seek coordinator cannot remain keyed to the failed URL.
 */
const useVideoSourceSwitching = ({
  videoRef,
  lastBlobUrlRef,
  videoUrl,
  optimizedVideoUrl,
  useOptimizedPreview,
  onVideoUrlReady,
  onPlaybackSourceChange,
  setIsPlaying,
  seekTo,
}) => {
  const [playerUrl, setPlayerUrl] = useState('');
  const switchGenerationRef = useRef(0);
  const ownershipRef = useRef({
    actualUrl: '',
    element: null,
    fallbackUrl: null,
    logicalUrl: '',
    requestedUrl: '',
  });

  useLayoutEffect(() => {
    const videoElement = videoRef.current;
    const requestedUrl = useOptimizedPreview && optimizedVideoUrl
      ? optimizedVideoUrl
      : videoUrl;
    const fallbackUrl = useOptimizedPreview
      && optimizedVideoUrl
      && videoUrl
      && !Object.is(optimizedVideoUrl, videoUrl)
      ? videoUrl
      : null;

    if (!videoElement || !requestedUrl) {
      setPlayerUrl('');
      return undefined;
    }

    const owned = ownershipRef.current;
    if (
      owned.element === videoElement
      && Object.is(owned.logicalUrl, videoUrl)
      && Object.is(owned.requestedUrl, requestedUrl)
      && Object.is(owned.fallbackUrl, fallbackUrl)
    ) {
      // A fallback is sticky for this exact request. Ordinary rerenders must not retry the failed
      // optimized URL and interrupt a healthy original-source replacement.
      onPlaybackSourceChange?.({
        actualUrl: owned.actualUrl,
        requestedUrl,
      });
      return undefined;
    }

    // If the desired source is already the one this owner committed (for example, the customer
    // disables optimized preview after its automatic fallback), update request identity without a
    // redundant reload.
    if (
      owned.element === videoElement
      && Object.is(owned.logicalUrl, videoUrl)
      && Object.is(owned.actualUrl, requestedUrl)
    ) {
      ownershipRef.current = {
        actualUrl: requestedUrl,
        element: videoElement,
        fallbackUrl,
        logicalUrl: videoUrl,
        requestedUrl,
      };
      setPlayerUrl(requestedUrl);
      onPlaybackSourceChange?.({ actualUrl: requestedUrl, requestedUrl });
      return undefined;
    }

    // Only alternate renditions of one logical asset share transport. Carrying media A's playhead
    // and play state into media B makes an ordinary project switch start B halfway through and can
    // immediately play it without customer intent.
    const outgoingWasPlaying = !videoElement.paused;
    const preservesTransport = owned.element === videoElement
      && Boolean(owned.logicalUrl)
      && Object.is(owned.logicalUrl, videoUrl);
    const restore = preservesTransport
      ? {
        time: Number.isFinite(videoElement.currentTime) ? videoElement.currentTime : 0,
        wasPlaying: outgoingWasPlaying,
      }
      : { time: 0, wasPlaying: false };
    let disposed = false;
    let removeAttemptListeners = () => undefined;

    if (outgoingWasPlaying) videoElement.pause();
    setIsPlaying(false);

    const beginAttempt = (actualUrl, recoverToOriginal) => {
      removeAttemptListeners();
      const attemptGeneration = switchGenerationRef.current + 1;
      switchGenerationRef.current = attemptGeneration;

      ownershipRef.current = {
        actualUrl,
        element: videoElement,
        fallbackUrl,
        logicalUrl: videoUrl,
        requestedUrl,
      };
      setPlayerUrl(actualUrl);
      onPlaybackSourceChange?.({ actualUrl, requestedUrl });

      const isCurrentAttempt = () => (
        !disposed
        && switchGenerationRef.current === attemptGeneration
        && videoRef.current === videoElement
        && ownershipRef.current.element === videoElement
        && Object.is(ownershipRef.current.logicalUrl, videoUrl)
        && Object.is(ownershipRef.current.actualUrl, actualUrl)
        && Object.is(ownershipRef.current.requestedUrl, requestedUrl)
      );

      const finishPaused = () => {
        if (!isCurrentAttempt()) return;
        removeAttemptListeners();
        setIsPlaying(false);
      };

      const restorePlayState = (completedTime = restore.time) => {
        if (!isCurrentAttempt() || !atRestoreTime(completedTime, restore.time)) return;
        if (!restore.wasPlaying) {
          finishPaused();
          return;
        }

        let playResult;
        try {
          playResult = videoElement.play();
        } catch (error) {
          if (!isCurrentAttempt()) return;
          console.warn('[VideoPreview] Could not auto-resume playback:', error);
          finishPaused();
          return;
        }

        Promise.resolve(playResult).then(() => {
          if (!isCurrentAttempt()) return;
          // A customer pause can race the play promise. The element, not the resolved promise,
          // owns the final transport truth.
          if (videoElement.paused) {
            finishPaused();
            return;
          }
          removeAttemptListeners();
          dbg('[VideoPreview] Successfully resumed playback after source switch');
          setIsPlaying(true);
        }).catch((error) => {
          if (!isCurrentAttempt()) return;
          console.warn('[VideoPreview] Could not auto-resume playback:', error);
          finishPaused();
        });
      };

      const handleLoadedData = () => {
        if (!isCurrentAttempt()) return;
        videoElement.removeEventListener('loadeddata', handleLoadedData);

        if (restore.time <= SOURCE_RESTORE_EPSILON_SECONDS) {
          restorePlayState(restore.time);
          return;
        }

        // Restoring a positive playhead without a duration that contains it would resume at an
        // unrelated frame. Keep the source paused instead; a later customer seek remains safe.
        if (!Number.isFinite(videoElement.duration) || restore.time > videoElement.duration) {
          finishPaused();
          return;
        }

        seekTo(restore.time, {
          onComplete: restorePlayState,
          reason: 'source-restore',
        });
      };

      const handleLoadError = (event) => {
        if (!isCurrentAttempt()) return;
        removeAttemptListeners();
        setIsPlaying(false);

        if (recoverToOriginal && fallbackUrl) {
          // This error is recovered inside the source owner. Do not let the generic source-error
          // listener show a transient failure for an optimized rendition the customer never sees.
          event.stopImmediatePropagation?.();
          dbg('[VideoPreview] Optimized source failed; restoring the original source');
          beginAttempt(fallbackUrl, false);
          return;
        }

        // Invalidate any queued seek completion or pending play promise from this failed attempt.
        switchGenerationRef.current += 1;
        console.error('[VideoPreview] Error loading video source');
      };

      removeAttemptListeners = () => {
        videoElement.removeEventListener('loadeddata', handleLoadedData);
        videoElement.removeEventListener('error', handleLoadError);
      };
      videoElement.addEventListener('loadeddata', handleLoadedData);
      videoElement.addEventListener('error', handleLoadError);

      dbg('[VideoPreview] Committing video source after transport snapshot:', {
        actualUrl: actualUrl.substring(0, 80),
        requestedUrl: requestedUrl.substring(0, 80),
        restoreTime: restore.time,
        wasPlaying: restore.wasPlaying,
      });
      videoElement.src = actualUrl;
      videoElement.load();
    };

    beginAttempt(requestedUrl, fallbackUrl !== null);

    return () => {
      disposed = true;
      removeAttemptListeners();
      switchGenerationRef.current += 1;
    };
  }, [
    onPlaybackSourceChange,
    optimizedVideoUrl,
    seekTo,
    setIsPlaying,
    useOptimizedPreview,
    videoRef,
    videoUrl,
  ]);

  // Notify downstream consumers only about the source the owner actually committed. The async
  // mirror is generation-safe, so a slow Blob conversion cannot publish an optimized URL after the
  // owner has already fallen back to the original.
  useEffect(() => {
    if (!playerUrl) return undefined;
    let cancelled = false;

    onVideoUrlReady?.(playerUrl);

    (async () => {
      try {
        if (playerUrl.startsWith('blob:')) {
          localStorage.setItem('current_file_url', playerUrl);
          if (!cancelled) onVideoUrlReady?.(playerUrl);
          return;
        }

        if (isNativeMediaPlaybackUrl(playerUrl)) {
          localStorage.setItem('current_file_url', playerUrl);
          if (!cancelled) onVideoUrlReady?.(playerUrl);
          return;
        }

        const isExternalUrl = (playerUrl.startsWith('http://') || playerUrl.startsWith('https://'))
          && !isLoopbackServiceUrl(playerUrl);
        if (isExternalUrl) {
          dbg('[VideoPreview] Skipping blob conversion for external URL to avoid CORS');
          localStorage.setItem('current_file_url', playerUrl);
          if (!cancelled) onVideoUrlReady?.(playerUrl);
          return;
        }

        const response = await fetchBrowserResource(playerUrl, { cache: 'no-cache', mode: 'cors' });
        if (!response.ok) throw new Error(`Failed to fetch video for blob: ${response.status}`);
        const blob = await response.blob();
        if (cancelled) return;

        const objectUrl = URL.createObjectURL(blob);
        if (cancelled) {
          URL.revokeObjectURL(objectUrl);
          return;
        }
        localStorage.setItem('current_file_url', objectUrl);
        registerBrowserMediaBlob(objectUrl, blob);
        if (lastBlobUrlRef.current?.startsWith('blob:')) {
          try { URL.revokeObjectURL(lastBlobUrlRef.current); } catch { /* already revoked */ }
          forgetBrowserMediaBlob(lastBlobUrlRef.current);
        }
        lastBlobUrlRef.current = objectUrl;
        onVideoUrlReady?.(objectUrl);
        window.dispatchEvent(new CustomEvent('currentFileUrlChanged', { detail: { url: objectUrl } }));
      } catch (error) {
        if (!cancelled) {
          dbg('[VideoPreview] Failed to convert to blob, using direct URL:', error.message);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [lastBlobUrlRef, onVideoUrlReady, playerUrl]);
};

export default useVideoSourceSwitching;
